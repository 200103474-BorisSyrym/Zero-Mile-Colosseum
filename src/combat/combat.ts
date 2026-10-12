import * as THREE from 'three';
import { mergeGeometries } from '../effects/lightBeams';
import { hazardTexture } from '../effects/vfxTextures';
import { classifyImpact, COLLISION_MATERIALS } from '../core/collision';
import { CONFIG } from '../core/config';
import { HANDLING as H } from '../core/handling';
import { VFX } from '../render/visualBudget';
import { warmMesh } from '../render/warmup';
import { clamp, wrapAngle } from '../core/math';
import { frand } from '../core/random';
import { ABILITIES } from '../data/abilities';
import type { AbilityId } from '../data/types';
import type { AIVehicle } from '../enemies/ai';
import type { DrivingSession } from '../game/driving';
import type { ExplodeOpts, HazardKind } from '../game/simApi';
import type { Prop } from '../world/world';

interface Body {
  pos: THREE.Vector3;
  velX: number;
  velZ: number;
  yaw: number;
  yawRate: number;
  mass: number;
  length: number;
  width: number;
}

interface Hit {
  impact: number;
  nx: number;
  nz: number;
  cx: number;
  cz: number;
  tangent: number;
}

interface Proj {
  x: number; y: number; z: number;
  vx: number; vz: number;
  life: number;
  dmg: number;
  owner: 'player' | 'enemy';
  kind: 'missile' | 'shell';
  target: AIVehicle | null;
}

export interface Hazard {
  kind: HazardKind;
  x: number;
  z: number;
  r: number;
  life: number;
  max: number;
  dps: number;
  byPlayer: boolean;
  mesh: THREE.Mesh | null;
  armed: number;
  hitPlayer: boolean;
  s: number;
}

interface Pending {
  t: number;
  x: number;
  z: number;
  r: number;
  dmg: number;
  opts: ExplodeOpts;
}

const RAM = CONFIG.RAM;
const MOTOR = new THREE.Color(1, 0.72, 0.42);

const HAZ_COLORS: Record<HazardKind, number> = {
  oil: 0x050505, fire: 0xff6a10, electric: 0x40c8ff, water: 0x2a5a8a, ghost: 0xb080ff, mine: 0xff2030, spikes: 0xffd000, boost: 0x30f0ff, emp: 0x3060ff,
};

export type RamKind = 'SIDE' | 'REAR' | 'FRONT' | 'GLANCE';

/**
 * Driving-centric combat. The car is the weapon: damage comes from rams (angle, speed, mass, weak sides,
 * exposed states), from the environment (walls, obstacles, explosions, chain reactions) and from build effects
 * that are triggered by driving actions. There is no autonomous gunfire.
 */
/** Into-speed (m/s) above which a heavy prop gives way to the player instead of stopping the car. */
const SMASH_VN = 6;

export class Combat {
  projectiles: Proj[] = [];
  hazards: Hazard[] = [];
  private pending: Pending[] = [];
  private chains = new Map<number, { count: number; time: number }>();
  private nextChain = 1;
  private projMesh: THREE.InstancedMesh;
  private dummy = new THREE.Object3D();
  private hazGeo = new THREE.PlaneGeometry(2, 2);
  private hazMats: Record<string, THREE.MeshBasicMaterial> = {};
  private hazPool: THREE.Mesh[] = [];
  readonly group = new THREE.Group();
  cooldowns: Record<string, number> = { q: 0, e: 0 };
  private harpoonLine: THREE.Line;
  private harpoon: { target: AIVehicle; t: number } | null = null;
  private timers: { t: number; fn: () => void }[] = [];
  /** last ram per car: further contact within the cooldown slides instead of ramming again */
  private ramAt = new WeakMap<AIVehicle, { t: number; v: number }>();
  /** ram victims launched by WRECKING BALL carry the player's ram damage into whatever they hit */
  private wrecking = new Map<AIVehicle, { dmg: number; until: number }>();

  constructor(private sess: DrivingSession) {
    // a missile is a thing: a dark, lit body with a nose cone; the read at speed comes from its flame, glare and smoke
    const body = new THREE.CylinderGeometry(0.075, 0.085, 0.85, 8).rotateX(Math.PI / 2);
    const nose = new THREE.ConeGeometry(0.075, 0.22, 8).rotateX(Math.PI / 2).translate(0, 0, 0.535);
    const fins = new THREE.BoxGeometry(0.32, 0.02, 0.16).translate(0, 0, -0.34);
    const fins2 = new THREE.BoxGeometry(0.02, 0.32, 0.16).translate(0, 0, -0.34);
    this.projMesh = new THREE.InstancedMesh(mergeGeometries([body, nose, fins, fins2].map((g) => { g.deleteAttribute('uv'); return g; })), new THREE.MeshStandardMaterial({ color: 0x4a4c52, roughness: 0.5, metalness: 0.6 }), 200);
    this.projMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.projMesh.count = 0;
    this.projMesh.frustumCulled = false;
    this.group.add(this.projMesh);
    // ground hazards are irregular stains and glows (oil sheen, standing water, burnt patches, energy), never discs
    const HAZ_TEX: Record<HazardKind, 'oil' | 'water' | 'scorch' | 'energy'> = { oil: 'oil', water: 'water', fire: 'scorch', spikes: 'scorch', electric: 'energy', ghost: 'energy', mine: 'energy', boost: 'energy', emp: 'energy' };
    for (const k of Object.keys(HAZ_COLORS) as HazardKind[]) {
      const add = k !== 'oil' && k !== 'water';
      this.hazMats[k] = new THREE.MeshBasicMaterial({
        map: hazardTexture(HAZ_TEX[k]),
        color: new THREE.Color(HAZ_COLORS[k]).multiplyScalar(add ? (k === 'boost' ? VFX.boostPad : VFX.hazardGlow) : 1),
        transparent: true,
        opacity: k === 'oil' ? 0.85 : k === 'water' ? 0.55 : k === 'emp' ? 0.35 : 0.5,
        blending: add ? THREE.AdditiveBlending : THREE.NormalBlending,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -3,
      });
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    this.harpoonLine = new THREE.Line(lg, new THREE.LineBasicMaterial({ color: 0xffb070 }));
    this.harpoonLine.frustumCulled = false;
    this.harpoonLine.visible = false;
    this.group.add(this.harpoonLine);
    sess.scene.add(this.group);
  }

  /** Shader warm-up: the ground hazard materials (the projectile mesh and the harpoon line live in the scene). */
  warmObjects(): THREE.Object3D[] {
    return Object.values(this.hazMats).map((m) => warmMesh(m));
  }

  reset() {
    this.projectiles = [];
    for (const h of this.hazards) this.releaseHazMesh(h);
    this.hazards = [];
    this.pending = [];
    this.timers = [];
    this.chains.clear();
    this.wrecking.clear();
    this.cooldowns = { q: 0, e: 0 };
    this.harpoon = null;
    this.harpoonLine.visible = false;
  }

  dispose() {
    this.reset();
    this.sess.scene.remove(this.group);
  }

  newChain() {
    const id = this.nextChain++;
    this.chains.set(id, { count: 0, time: this.sess.time });
    return id;
  }

  private tag(v: AIVehicle, chainId: number) {
    if (!chainId) return;
    v.chainId = chainId;
    v.chainTime = this.sess.time + CONFIG.CHAIN.TAG_TIME;
  }

  private activeChain(v: AIVehicle) {
    return v.chainId && v.chainTime > this.sess.time ? v.chainId : 0;
  }

  schedule(delay: number, fn: () => void) {
    this.timers.push({ t: delay, fn });
  }

  // ------------------------------------------------------------------ collisions

  private circles(b: Body, out: number[]) {
    const n = b.length > 6.5 ? 3 : 2;
    const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw);
    const r = b.width * 0.56;
    out.length = 0;
    for (let i = 0; i < n; i++) {
      const o = n === 2 ? (i === 0 ? 1 : -1) * b.length * 0.25 : (i - 1) * b.length * 0.33;
      out.push(b.pos.x + fx * o, b.pos.z + fz * o, r);
    }
    return out;
  }

  private ca: number[] = [];
  private cb: number[] = [];

  /** Circle-cluster contact + impulse. n points from B to A. */
  resolve(A: Body, B: Body, restitution = 0.3, apply = true, impulse = true): Hit | null {
    const dx0 = A.pos.x - B.pos.x, dz0 = A.pos.z - B.pos.z;
    const reach = (A.length + B.length) * 0.6 + 1;
    if (dx0 * dx0 + dz0 * dz0 > reach * reach) return null;
    const a = this.circles(A, this.ca), b = this.circles(B, this.cb);
    let best = 0, nx = 0, nz = 0, cx = 0, cz = 0;
    for (let i = 0; i < a.length; i += 3) {
      for (let j = 0; j < b.length; j += 3) {
        const dx = a[i] - b[j], dz = a[i + 1] - b[j + 1];
        const rr = a[i + 2] + b[j + 2];
        const d2 = dx * dx + dz * dz;
        if (d2 < rr * rr) {
          const d = Math.sqrt(d2) || 0.001;
          const pen = rr - d;
          if (pen > best) {
            best = pen;
            nx = dx / d;
            nz = dz / d;
            cx = b[j] + nx * b[j + 2];
            cz = b[j + 1] + nz * b[j + 2];
          }
        }
      }
    }
    if (best <= 0) return null;
    const wa = 1 / A.mass, wb = 1 / B.mass, tot = wa + wb;
    const rvx = A.velX - B.velX, rvz = A.velZ - B.velZ;
    const vn = rvx * nx + rvz * nz;
    const tangent = Math.abs(rvx * -nz + rvz * nx);
    if (apply) {
      A.pos.x += nx * best * (wa / tot);
      A.pos.z += nz * best * (wa / tot);
      B.pos.x -= nx * best * (wb / tot);
      B.pos.z -= nz * best * (wb / tot);
      if (vn < 0 && impulse) {
        const j = (-(1 + restitution) * vn) / tot;
        A.velX += nx * j * wa;
        A.velZ += nz * j * wa;
        B.velX -= nx * j * wb;
        B.velZ -= nz * j * wb;
        const rAx = cx - A.pos.x, rAz = cz - A.pos.z;
        const rBx = cx - B.pos.x, rBz = cz - B.pos.z;
        A.yawRate += (rAx * nz - rAz * nx) * j * wa * 0.06;
        B.yawRate -= (rBx * nz - rBz * nx) * j * wb * 0.12;
      }
    }
    return { impact: Math.max(0, -vn), nx, nz, cx, cz, tangent };
  }

  updateCollisions() {
    const s = this.sess;
    const p = s.player;
    const vs = s.vehicles;
    const pb = p as unknown as Body;
    for (const v of vs) {
      if (v.removed || (v.flying && v.hover > 2.4)) continue;
      if (Math.abs(v.s - p.s) > 15) continue;
      if (p.phase > 0) {
        const hit = this.resolve(pb, v as unknown as Body, 0, false);
        if (hit && v.phased <= 0) {
          v.phased = 0.6;
          s.res.phaseHits++;
          if (v.hostile) {
            if (s.synergy('phantom')) v.expose(2);
            for (const it of s.items) it.onPhaseThrough?.(s, v);
          }
        }
        continue;
      }
      const hit = this.resolve(pb, v as unknown as Body, 0, true, false);
      if (!hit) continue;
      v.nmTouched = true;
      this.playerHit(v, hit);
      // a heavy hit must never launch the player beyond a sane speed
      const cap = Math.max(30, p.maxSpeedNow * 1.15);
      const sp = Math.hypot(p.velX, p.velZ);
      if (sp > cap) {
        p.velX *= cap / sp;
        p.velZ *= cap / sp;
      }
    }
    for (let i = 0; i < vs.length; i++) {
      const a = vs[i];
      if (a.removed || (a.flying && a.hover > 2.4)) continue;
      for (let j = i + 1; j < vs.length; j++) {
        const b = vs[j];
        if (b.removed || (b.flying && b.hover > 2.4)) continue;
        if (Math.abs(a.s - b.s) > 14) continue;
        const hit = this.resolve(a as unknown as Body, b as unknown as Body, 0.3);
        if (!hit || hit.impact < 2) continue;
        this.aiHit(a, b, hit);
      }
    }
    for (const pr of s.world.props) {
      if (!pr.alive) continue;
      if (Math.abs(pr.s - p.s) < 8) this.propHit(pb, pr, true, null);
      for (const v of vs) {
        if (v.removed || v.flying || Math.abs(pr.s - v.s) > 8) continue;
        this.propHit(v as unknown as Body, pr, false, v);
      }
    }
  }

  /** The heart of combat: classify the ram, compute damage both ways, reward and feedback. */
  private playerHit(v: AIVehicle, hit: Hit) {
    const s = this.sess;
    const p = s.player;
    const st = p.stats;
    const dirX = -hit.nx, dirZ = -hit.nz; // player -> target
    const tFwd = Math.sin(v.yaw) * dirX + Math.cos(v.yaw) * dirZ;
    const pFwd = Math.sin(p.yaw) * dirX + Math.cos(p.yaw) * dirZ;
    if (hit.impact < RAM.MIN_IMPACT) {
      this.rub(v, hit);
      // scraping contact: build static, saws cut
      if (hit.tangent > 10 && v.hostile) {
        s.addStatic(4);
        if (p.drifting && s.hasItem('slide_saw')) {
          v.expose(1.5);
          this.damageVehicle(v, 6, 'ram', { byPlayer: true });
          s.fx.sparks(hit.cx, 0.6, hit.cz, 8, 0xffd080, 7, p.velX * 0.4, p.velZ * 0.4);
        }
      }
      return;
    }
    const last = this.ramAt.get(v);
    if (last && s.time - last.t < H.ramCooldown && hit.impact < last.v + 6) {
      this.rub(v, hit);
      return;
    }
    this.ramAt.set(v, { t: s.time, v: hit.impact });
    const glancing = hit.impact < 0.4 * Math.hypot(hit.impact, hit.tangent);
    let kind: RamKind;
    let mult: number;
    if (glancing) {
      kind = 'GLANCE';
      mult = RAM.GLANCING_MULT;
    } else if (Math.abs(tFwd) < 0.55) {
      kind = 'SIDE';
      mult = RAM.SIDE_MULT;
    } else if (tFwd > 0) {
      kind = 'REAR';
      mult = RAM.REAR_MULT;
    } else {
      kind = 'FRONT';
      mult = RAM.FRONT_MULT;
    }
    const attackerF = pFwd > 0.45 ? 1 : pFwd > -0.2 ? 0.65 : 0.4;
    const massRatio = Math.sqrt(p.mass / v.mass);
    let dmg = RAM.BASE_DAMAGE * Math.pow(hit.impact / RAM.SPEED_REF, 1.15) * clamp(massRatio, v.isBoss ? 0.85 : 0.4, 2.6) * mult * attackerF * st.ramDamage;
    // build modifiers: MASS stacks, kinetic plating, kick turn, saws, bulldozer
    dmg *= 1 + s.res.mass * 0.1;
    if (s.hasItem('kinetic_plating')) dmg *= 1 + s.res.velocity / 100;
    if (s.hasItem('kick_turn') && p.boostTimer > 0) dmg *= 1.5;
    if (p.bulldozer > 0) dmg *= 1.4;
    if (p.drifting && kind === 'SIDE' && s.hasItem('slide_saw')) {
      dmg *= 2;
      v.expose(1.5);
    }
    // weak sides, exposed states and armour: HOW you hit matters more than how often
    const weakHit = v.weak === 'any' || (v.weak === 'side' && kind === 'SIDE') || (v.weak === 'rear' && kind === 'REAR') || (v.weak === 'front' && kind === 'FRONT');
    let tagText = '';
    if (v.hostile && !v.isBoss) {
      if (v.exposed) {
        dmg *= 2;
        tagText = 'EXPOSED';
      } else if (weakHit && kind !== 'GLANCE') {
        dmg *= 2;
        tagText = 'WEAK SPOT';
      } else dmg *= v.armor;
    }
    const enemyAttacks = v.hostile && pFwd < 0.45;
    const perfect = !v.isTraffic && kind !== 'GLANCE' && attackerF >= 1 && ((kind === 'SIDE' && hit.impact >= RAM.PERFECT_IMPACT) || s.time < s.perfectWindow || (weakHit && hit.impact >= RAM.PERFECT_IMPACT + 4));
    if (perfect) dmg *= 1.3;
    const bossOpen = v.isBoss && !!(v.boss as { open?: boolean } | null)?.open;
    if (v.isBoss) {
      dmg *= (v.boss as { ramMul?: number } | null)?.ramMul ?? 1;
      // in a vulnerability window every committed hit counts, even a slow one
      if (bossOpen && kind !== 'GLANCE' && hit.impact > 5) dmg = Math.max(dmg, RAM.BASE_DAMAGE * 0.75);
    }

    // damage to the player: hits taken on your flank or nose-to-nose hurt; clean rams barely do
    let taken = RAM.PLAYER_DAMAGE_BASE * hit.impact * clamp(Math.sqrt(v.mass / p.mass), 0.4, 2.5) * (enemyAttacks ? 1 : 0.4) * (v.isTraffic ? 0.5 : 1);
    if (kind === 'FRONT' && tFwd < -0.5 && pFwd > 0.5) taken *= 1.5; // head-on: big reciprocal force
    if (kind === 'GLANCE') taken *= 0.4;
    if (bossOpen) taken *= 0.25;
    // a boss hit is a big, readable punishment — never a one-shot
    if (v.isBoss) taken = Math.min(taken, 12);
    if (p.bulldozer > 0) taken *= 0.35;
    if (s.hasItem('juggernaut_core') && s.res.mass >= s.res.massMax) taken = 0;
    if (s.synergy('unstoppable') && s.res.mass >= 5) taken *= 0.5;

    this.ramPhysics(v, hit, kind, perfect, enemyAttacks);
    const chainId = this.activeChain(v) || this.newChain();
    this.tag(v, chainId);
    v.lastPlayerHit = s.time;
    v.flash = 1;
    if (s.hasItem('wrecking_ball') && !v.isBoss && kind !== 'GLANCE') {
      v.velX *= 1.6;
      v.velZ *= 1.6;
      this.wrecking.set(v, { dmg: dmg * 0.8, until: s.time + 2 });
    }
    if (s.synergy('unstoppable') && s.res.mass >= 5) {
      // nothing knocks you around
      p.velX -= hit.nx * hit.impact * 0.3;
      p.velZ -= hit.nz * hit.impact * 0.3;
    }

    this.damageVehicle(v, dmg, 'ram', { chainId, byPlayer: true });
    if (taken > 0.5) this.damagePlayer(taken, 'collision', hit.cx, hit.cz);

    // feel: sparks, debris, sound, camera, hit-stop
    const k = clamp(hit.impact / 30, 0, 1);
    s.fx.impact(hit.cx, 0.7, hit.cz, (p.velX + v.velX) * 0.5, (p.velZ + v.velZ) * 0.5, perfect ? 1 : k, 'metal', v.model.bodyMat.color.getHex());
    s.audio.impact(hit.impact, s.relPan(hit.cx, hit.cz));
    p.bump(k * 0.6);
    if (v.hostile || k > 0.4) s.cam.addTrauma(0.08 + k * 0.4);
    const sideSign = Math.sign((hit.cx - p.pos.x) * -Math.cos(p.yaw) + (hit.cz - p.pos.z) * Math.sin(p.yaw)) || 1;
    s.cam.kick(-sideSign, k * 0.25);
    if (taken > 16 && !v.isBoss) p.crash(-sideSign);
    if (v.hostile) {
      s.addMomentum(CONFIG.MOMENTUM.RAM * (0.5 + k));
      s.addCombo(kind === 'GLANCE' ? 0.5 : 1, 'ram');
      s.addStatic(10);
      if (hit.impact > 10) s.addMass(perfect ? 2 : 1);
      s.addScore(Math.round(20 + hit.impact * 2));
      // the target tag already says HIT IT! — only call out the weak-spot lesson
      if (tagText === 'WEAK SPOT') s.popup('WEAK SPOT ×2', '#ffd060');
    }
    if (perfect) {
      s.hitStop(RAM.HITSTOP);
      s.notify('PERFECT RAM', '#ffcc33', true);
      s.addMomentum(10);
      s.addScore(200);
      s.addCombo(1, 'perfect');
      s.cam.addTrauma(0.25);
      s.fx.dust(hit.cx, 0.3, hit.cz, 6, 1.2, p.velX, p.velZ);
      s.audio.heavyImpact();
    } else if (hit.impact > RAM.HIGH_SPEED && v.hostile) {
      s.hitStop(0.035);
      // teach the one thing that matters: side hits hurt most
      if (kind === 'SIDE') s.popup('T-BONE!', '#ffffff');
    }
    if (v.hostile && hit.impact > 6) {
      for (const it of s.items) it.onRam?.(s, v, hit.impact, kind, perfect);
      if (s.synergy('burning_road')) this.igniteNear(hit.cx, hit.cz, 9);
    }
    s.onPlayerRam(v, hit.impact, kind, perfect);
  }

  /**
   * The arcade ram: the player keeps most of their speed and takes a recoil they can catch; the target takes the hit,
   * shaped by where it was hit. Side (T-bone): launched sideways and spun. Rear: shoved forward, wobbling. Front:
   * both lose speed. Corner (near either end): a big spin. Mass decides the share — a sedan gives way, a pickup is
   * an even fight, a truck wins unless you hit it right — but nothing is an instant death.
   */
  private ramPhysics(v: AIVehicle, hit: Hit, kind: RamKind, perfect: boolean, enemyAttacks: boolean) {
    const p = this.sess.player;
    const vn = hit.impact;
    const nx = hit.nx, nz = hit.nz; // from the target toward the player
    const m = v.mass / Math.max(0.3, p.mass);
    const boss = v.isBoss;
    // the player: speed lost along the contact normal, by mass ratio (head-on costs more, a glance little)
    const mk = m / (1 + m);
    let loss = vn * (H.ramLossBase + H.ramLossMass * mk * mk);
    if (kind === 'FRONT') loss *= H.ramFrontLoss;
    if (kind === 'GLANCE') loss *= 0.5;
    // the heavier the target, the closer to a plain impulse: a truck throws you back; a boss exactly as before
    // (boss fights keep their balance — the arcade bonus is for the cars you are meant to bully)
    const physical = vn * (1 + H.ramBounce) * mk;
    loss = boss ? physical : loss + (physical - loss) * clamp((m - 1.2) / 2, 0, 1) * H.ramHeavyBlend;
    // the hit turns the player too: a torque from where it landed, bigger from heavier cars and from attackers
    const rAx = hit.cx - p.pos.x, rAz = hit.cz - p.pos.z;
    const rl = Math.hypot(rAx, rAz) || 1;
    const torque = (rAx * nz - rAz * nx) / rl;
    const kick = clamp(torque * vn * H.ramYawKick * (0.5 + m / (1 + m)) * (enemyAttacks ? 1.3 : 0.7), -H.ramYawKickMax, H.ramYawKickMax);
    // (a boss hit moves you as it always did — it does not also unsettle the car: boss fights keep their balance)
    p.hitBy(nx * loss, nz * loss, boss ? kick * 0.5 : kick, !boss && (vn > 18 || (m > 1.8 && vn > 12)), !boss);
    // the target: launched away from the player
    const share = 1 / (1 + m);
    let launch = vn * (1 + H.ramBounce) * share * (boss ? 1 : H.ramLaunch * (perfect ? 1.25 : 1));
    if (kind === 'GLANCE') launch *= 0.35;
    v.velX -= nx * launch;
    v.velZ -= nz * launch;
    if (boss) return;
    // a big enough hit lifts it off the road for a moment — it really flies, and lands as it lands
    if (launch > 16 && !v.flying && !v.airborne) {
      v.airborne = true;
      v.airVy = Math.min(5, launch * 0.17);
    }
    // where it was hit: the contact point along the target's length
    const tfx = Math.sin(v.yaw), tfz = Math.cos(v.yaw);
    const along = (hit.cx - v.pos.x) * tfx + (hit.cz - v.pos.z) * tfz;
    const endHit = Math.abs(along) > v.length * 0.3;
    const sideOfHit = Math.sign((hit.cx - v.pos.x) * -tfz + (hit.cz - v.pos.z) * tfx) || 1;
    const spinDir = -Math.sign(along || 1) * sideOfHit;
    const massK = 1 / Math.sqrt(v.mass);
    if (kind === 'SIDE') {
      v.yawRate += spinDir * H.ramSideSpin * (0.6 + vn / 30) * massK * (endHit ? 1.4 : 1);
      v.spin = Math.max(v.spin, 0.9 + vn * 0.02);
      v.rollKick(sideOfHit * clamp(vn * 0.06, 0.2, 1.4));
    } else if (kind === 'REAR') {
      v.velX += tfx * vn * H.ramRearShove * share;
      v.velZ += tfz * vn * H.ramRearShove * share;
      v.yawRate += (Math.random() - 0.5) * 1.2 * massK;
      v.spin = Math.max(v.spin, 0.35);
      v.pitchKick(-clamp(vn * 0.03, 0.1, 0.6));
    } else if (kind === 'FRONT') {
      v.spin = Math.max(v.spin, 0.5);
      v.pitchKick(clamp(vn * 0.03, 0.1, 0.7));
      if (endHit) v.yawRate += spinDir * H.ramCornerSpin * 0.6 * massK;
    } else {
      v.spin = Math.max(v.spin, 0.25);
    }
    if (endHit && kind !== 'FRONT') {
      // a corner hit spins it round
      v.yawRate += spinDir * H.ramCornerSpin * (0.4 + vn / 40) * massK;
      v.spin = Math.max(v.spin, 1.1);
    }
  }

  /** Side-by-side contact: the bodies slide past each other, separate a little, throw sparks — never lock. */
  private rub(v: AIVehicle, hit: Hit) {
    const s = this.sess;
    const p = s.player;
    const nx = hit.nx, nz = hit.nz;
    const m = v.mass / Math.max(0.3, p.mass);
    const share = 1 / (1 + m);
    // separation: never less than this closing-apart speed
    const rvx = p.velX - v.velX, rvz = p.velZ - v.velZ;
    const sep = rvx * nx + rvz * nz;
    if (sep < H.rubSeparate) {
      // (capped per frame, ~15 m/s²: two cars grinding past each other are eased apart; positions are already separated)
      const d = Math.min(0.25, H.rubSeparate - sep);
      p.velX += nx * d * (1 - share);
      p.velZ += nz * d * (1 - share);
      v.velX -= nx * d * share;
      v.velZ -= nz * d * share;
    }
    // a little tangential friction: the faster car is dragged a touch, the slower one tugged along
    const tx = -nz, tz = nx;
    const rt = rvx * tx + rvz * tz;
    const f = rt * H.rubFriction;
    p.velX -= tx * f * (1 - share);
    p.velZ -= tz * f * (1 - share);
    v.velX += tx * f * share;
    v.velZ += tz * f * share;
    if (Math.abs(rt) > 6 && Math.random() < 0.5) {
      s.fx.sparks(hit.cx, 0.6, hit.cz, 2, 0xffd090, 5, (p.velX + v.velX) * 0.5, (p.velZ + v.velZ) * 0.5);
      if (Math.random() < 0.3) s.audio.curbScrape(clamp(Math.abs(rt) / 30, 0.2, 0.8), s.relPan(hit.cx, hit.cz));
      p.bump(0.08);
    }
  }

  private aiHit(a: AIVehicle, b: AIVehicle, hit: Hit) {
    const s = this.sess;
    const ca = this.activeChain(a), cb = this.activeChain(b);
    if (hit.impact > CONFIG.CHAIN.PROPAGATE_SPEED) {
      if (ca && !cb) this.tag(b, ca);
      else if (cb && !ca) this.tag(a, cb);
      const chain = ca || cb;
      let dmgA = hit.impact * 1.4 * clamp(Math.sqrt(b.mass / a.mass), 0.3, 3);
      let dmgB = hit.impact * 1.4 * clamp(Math.sqrt(a.mass / b.mass), 0.3, 3);
      // a wrecking-ball projectile carries the player's ram into whatever it hits
      const wa = this.wrecking.get(a), wb = this.wrecking.get(b);
      if (wa && wa.until > s.time) dmgB = Math.max(dmgB, wa.dmg);
      if (wb && wb.until > s.time) dmgA = Math.max(dmgA, wb.dmg);
      this.damageVehicle(a, a.isBoss ? dmgA * 0.5 : dmgA, 'collision', { chainId: chain, byPlayer: !!chain });
      this.damageVehicle(b, b.isBoss ? dmgB * 0.5 : dmgB, 'collision', { chainId: chain, byPlayer: !!chain });
      a.spin = Math.max(a.spin, 0.5);
      b.spin = Math.max(b.spin, 0.5);
      a.expose(1.5);
      b.expose(1.5);
      if (a.burnT > 0 && s.hasItem('firewall')) b.burn(3, 14);
      if (b.burnT > 0 && s.hasItem('firewall')) a.burn(3, 14);
      s.fx.impact(hit.cx, 0.7, hit.cz, (a.velX + b.velX) * 0.5, (a.velZ + b.velZ) * 0.5, clamp(hit.impact / 30, 0.15, 1), 'metal', a.model.bodyMat.color.getHex());
      if (Math.hypot(hit.cx - s.player.pos.x, hit.cz - s.player.pos.z) < 60) s.audio.impact(hit.impact * 0.6, s.relPan(hit.cx, hit.cz));
    }
  }

  private propHit(b: Body, pr: Prop, isPlayer: boolean, v: AIVehicle | null) {
    const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw);
    const dx = pr.x - b.pos.x, dz = pr.z - b.pos.z;
    const along = clamp(dx * fx + dz * fz, -b.length * 0.4, b.length * 0.4);
    const px = b.pos.x + fx * along, pz = b.pos.z + fz * along;
    const ex = pr.x - px, ez = pr.z - pz;
    const dist = Math.hypot(ex, ez);
    const rr = pr.r + b.width * 0.5;
    if (dist >= rr) return;
    const nx = ex / (dist || 1), nz = ez / (dist || 1);
    const vn = b.velX * nx + b.velZ * nz;
    const s = this.sess;
    const smash = isPlayer && pr.heavy && s.hasItem('juggernaut_core') && s.res.mass >= s.res.massMax;
    if (!pr.heavy || smash) {
      if (pr.explosive) {
        s.world.destroyProp(pr);
        const chain = v ? this.activeChain(v) : 0;
        this.queueExplosion(pr.x, pr.z, 7.5, 45, { byPlayer: isPlayer || !!chain || (v?.task.kind === 'pursue'), chainId: chain || (isPlayer ? this.newChain() : 0), hurtsPlayer: true }, 0.05);
        return;
      }
      s.world.knockProp(pr, b.velX * 1.15, b.velZ * 1.15);
      b.velX *= smash ? 0.92 : 0.97;
      b.velZ *= smash ? 0.92 : 0.97;
      if (pr.kind === 'glass') s.fx.glassBurst(pr.x, 1, pr.z, smash ? 18 : 10, b.velX * 0.3, b.velZ * 0.3);
      else s.fx.debrisBurst(pr.x, 0.4, pr.z, smash ? 9 : 4, pr.kind === 'cone' ? 0xff5a10 : pr.kind === 'crate' ? 0x6b4a2a : pr.kind === 'trash' ? 0x2d4030 : 0x888888, 4 + Math.hypot(b.velX, b.velZ) * 0.15, b.velX * 0.4, b.velZ * 0.4, pr.kind === 'cone' || pr.kind === 'plastic' ? 0 : undefined, pr.kind === 'cone' || pr.kind === 'plastic' ? 0.45 : 1);
      s.fx.dust(pr.x, 0.3, pr.z, smash ? 3 : 1, 0.6, b.velX, b.velZ);
      if (isPlayer) {
        s.audio.impact(smash ? 20 : 6);
        if (smash) s.cam.addTrauma(0.2);
        s.addCombo(0.25, 'smash');
        s.onPropSmash(pr);
      }
      return;
    }
    // heavy props never stop the player dead: at speed they give way (knocked off the road / smashed) and the hit
    // costs speed, combo and a little hull by how square it was. A slow push is still solid; pillars are structure.
    if (isPlayer && vn > SMASH_VN && pr.kind !== 'pillar') {
      this.smashProp(b, pr, nx, nz, vn, px + nx * b.width * 0.5, pz + nz * b.width * 0.5);
      return;
    }
    // heavy: static collision — and the best place to send enemies
    const pen = rr - dist;
    b.pos.x -= nx * pen;
    b.pos.z -= nz * pen;
    if (vn > 0) {
      // the player is only ever here at walking pace: stop the push, no bounce-back
      const k = isPlayer ? 1.05 : 1.3;
      b.velX -= nx * vn * k;
      b.velZ -= nz * vn * k;
      b.yawRate += (Math.random() - 0.5) * vn * 0.05;
      if (isPlayer && vn > 2) {
        // same rules as walls: a glancing touch on a block is a scrape, a square hit is a crash
        // velocity was already reflected (v -= n·vn·1.3): the part along the block is v + n·vn·0.3
        const vt = Math.hypot(b.velX + nx * vn * 0.3, b.velZ + nz * vn * 0.3);
        const { severity, angle } = classifyImpact(vn, vt);
        if (severity === 'heavy') s.player.bump(0.5);
        s.player.logContact({ t: performance.now() / 1000, material: pr.cushion ? 'ANVIL' : 'BLOCK', severity, angle, before: Math.round(Math.hypot(vt, vn) * 3.6), after: Math.round(Math.hypot(b.velX, b.velZ) * 3.6), vN: vn, vT: vt, bounce: vn * 0.3 });
        s.onImpact(pr.cushion ? 'cushion' : 'heavyProp', severity, vn, px + nx * b.width * 0.5, pz + nz * b.width * 0.5);
      } else if (vn > 6) {
        s.fx.impact(px + nx * b.width * 0.5, 0.6, pz + nz * b.width * 0.5, b.velX, b.velZ, clamp(vn / 20, 0.15, 0.8), 'concrete');
        if (v) this.wallDamage(v, vn * 1.4);
      }
    }
  }

  /**
   * The player hits a block / anvil / debris slab at speed: it is knocked tumbling out of the way and the car keeps
   * going. A square hit keeps ~62% of the speed (anvils ~68%), a clip ~90%+; combo and hull are cut, never wiped.
   */
  private smashProp(b: Body, pr: Prop, nx: number, nz: number, vn: number, cx: number, cz: number) {
    const s = this.sess;
    const p = s.player;
    const speed = Math.hypot(b.velX, b.velZ);
    const vt = Math.sqrt(Math.max(0, speed * speed - vn * vn));
    const sq = clamp(vn / Math.max(1, speed), 0, 1);
    const anvil = !!pr.cushion;
    const keep = 1 - (anvil ? 0.32 : 0.38) * sq;
    // keep going roughly where you were going: bleed half of the into-component, then scale to what survives
    let vx = b.velX - nx * vn * 0.5, vz = b.velZ - nz * vn * 0.5;
    const m = Math.hypot(vx, vz) || 1;
    vx = (vx / m) * speed * keep;
    vz = (vz / m) * speed * keep;
    b.velX = vx;
    b.velZ = vz;
    b.yawRate += -Math.sign(nx * Math.cos(b.yaw) - nz * Math.sin(b.yaw)) * sq * 0.6;
    // the block goes flying: low and tumbling, not into orbit
    s.world.knockProp(pr, b.velX / Math.max(0.01, keep) * 0.8 + nx * vn * 0.6, b.velZ / Math.max(0.01, keep) * 0.8 + nz * vn * 0.6);
    pr.vy = 2.5 + vn * 0.12;
    pr.spin = (Math.random() < 0.5 ? -1 : 1) * (4 + sq * 6);
    pr.life = 2.6;
    // feel
    s.fx.impact(cx, 0.7, cz, b.velX, b.velZ, 0.45 + sq * 0.5, 'concrete');
    s.fx.debrisBurst(cx, 0.8, cz, 6 + Math.round(sq * 10), 0x9a9aa0, 7 + sq * 6, b.velX, b.velZ, 1);
    s.audio.impact(8 + vn * 0.8, s.relPan(cx, cz));
    s.cam.addTrauma(0.1 + sq * 0.22);
    p.bump(0.25 + sq * 0.35);
    if (sq > 0.45) s.hitStop(0.035);
    // cost: combo and bank cut, a little hull (anvils barely scratch it)
    const mat = COLLISION_MATERIALS[anvil ? 'cushion' : 'heavyProp'];
    s.combo *= 1 - 0.35 * sq;
    s.comboBank *= 1 - 0.25 * sq;
    this.damagePlayer((1.5 + 4.5 * sq) * mat.damageMul, 'wall', cx, cz);
    if (sq > 0.45) {
      s.popup(anvil ? 'SMASHED THE ANVIL' : 'SMASHED THROUGH', '#ffb060');
      s.boss?.onPlayerCrash();
    }
    const { severity, angle } = classifyImpact(vn, vt);
    p.logContact({ t: performance.now() / 1000, material: anvil ? 'ANVIL' : 'BLOCK', severity, angle, before: Math.round(speed * 3.6), after: Math.round(speed * keep * 3.6), vN: vn, vT: vt, bounce: 0 });
  }

  /** AI slams a wall or heavy object: big damage and an exposed state. Lured crashes are credited to you. */
  wallDamage(v: AIVehicle, impact: number) {
    if (impact < 7) return;
    const s = this.sess;
    const chain = this.activeChain(v);
    let dmg = (impact - 5) * 2.6;
    const b = v.boss as { wallMul?: number; onWall?: (impact: number) => void } | null;
    if (b) {
      dmg *= b.wallMul ?? 0.4;
      b.onWall?.(impact);
    } else v.expose(2.2);
    const lured = v.task.kind === 'pursue' || s.time - v.lastPlayerHit < 4;
    this.damageVehicle(v, dmg, 'wall', { chainId: chain, byPlayer: !!chain || lured });
    s.fx.impact(v.pos.x, 0.6, v.pos.z, v.velX, v.velZ, clamp(impact / 25, 0.2, 0.9), 'concrete', v.model.bodyMat.color.getHex());
  }

  // ------------------------------------------------------------------ damage

  damageVehicle(v: AIVehicle, amount: number, kind: string, opts: { chainId?: number; byPlayer?: boolean } = {}) {
    if (v.dead || v.removed || amount <= 0) return;
    if (v.isBoss) {
      const b = v.boss as { damageMul?: (k: string, amount: number) => number } | null;
      amount *= b?.damageMul?.(kind, amount) ?? 1;
      if (amount <= 0) return;
    } else if (kind !== 'ram' && v.exposed) amount *= 1.5;
    if (this.sess.synergy('storm') && v.stunT > 0) amount *= 2;
    if (this.sess.hasItem('inferno_core') && v.burnT > 0) amount *= 2;
    v.hp -= amount;
    v.flash = Math.min(1, v.flash + 0.5);
    if (opts.chainId) this.tag(v, opts.chainId);
    if (opts.byPlayer) v.lastPlayerHit = this.sess.time;
    if (v.isBoss) this.sess.onBossDamaged(amount, kind);
    if (v.hp <= 0) this.killVehicle(v, { chainId: opts.chainId ?? this.activeChain(v), byPlayer: !!opts.byPlayer || this.sess.time - v.lastPlayerHit < 3, kind });
  }

  killVehicle(v: AIVehicle, info: { chainId?: number; byPlayer?: boolean; kind?: string; silent?: boolean }) {
    if (v.dead) return;
    const s = this.sess;
    v.dead = true;
    v.hp = 0;
    v.deathTimer = v.isBoss ? 4 : 2.4;
    v.spin = 2;
    const chainId = info.chainId || this.activeChain(v);
    const credited = !!info.byPlayer || !!chainId;
    const isBomber = v.kind === 'bomber';
    const r = isBomber ? 9 : 4.5 + v.mass * 0.8;
    const blastDmg = isBomber ? 50 : 16;
    s.fx.explosion(v.pos.x, v.pos.y, v.pos.z, r, isBomber ? 0xff3a10 : 0xff8a30);
    s.fx.debrisBurst(v.pos.x, v.pos.y, v.pos.z, 14, v.model.bodyMat.color.getHex(), 10);
    s.audio.explosion(isBomber ? 1.4 : 0.8, s.relPan(v.pos.x, v.pos.z));
    const dist = Math.hypot(v.pos.x - s.player.pos.x, v.pos.z - s.player.pos.z);
    s.cam.addTrauma(clamp(0.5 - dist / 80, 0, 0.5));
    // wrecks explode: this is what makes chain reactions
    this.queueExplosion(v.pos.x, v.pos.z, r, blastDmg, { chainId, byPlayer: credited, hurtsPlayer: !v.isBoss, color: 0xff6a20, fire: v.burnT > 0 && s.synergy('inferno') }, 0.06, true);
    v.velX += frand(-3, 3);
    v.velZ += frand(-3, 3);
    if (v.isBoss) {
      s.onKill(v, info.kind ?? 'ram', !!chainId);
    } else if (v.role === 'enemy') {
      if (credited) {
        if (chainId) {
          const c = this.chains.get(chainId);
          if (c) {
            c.count++;
            c.time = s.time;
            if (c.count >= 2) s.onChain(c.count);
          }
        }
        s.onKill(v, info.kind ?? 'ram', !!chainId);
      }
    } else if (credited) {
      s.addCombo(0.3, 'wreck');
    }
  }

  damagePlayer(amount: number, kind: string, sx?: number, sz?: number) {
    const s = this.sess;
    const p = s.player;
    if (s.godMode || s.arrival || amount <= 0 || p.hp <= 0) return;
    if (p.phase > 0 && kind !== 'fall' && kind !== 'drain') return;
    if (kind === 'collision' && p.invuln > 0) amount *= 0.3;
    amount *= p.stats.damageTaken * s.difficultyDamage * (s.tutorialEasy ? 0.5 : 1);
    if (s.hasItem('deadweight')) amount *= 1 - Math.min(0.4, s.res.mass * 0.04);
    p.hp -= amount;
    if (kind === 'collision') p.invuln = CONFIG.PLAYER.INVULN_AFTER_HIT;
    s.onPlayerDamaged(amount, kind, sx, sz);
    for (const it of s.items) it.onDamaged?.(s, amount, kind);
    if (p.hp <= 0) {
      p.hp = 0;
      s.playerDestroyed();
    }
  }

  // ------------------------------------------------------------------ area effects

  queueExplosion(x: number, z: number, r: number, dmg: number, opts: ExplodeOpts, delay: number, noVisual = false) {
    this.pending.push({ t: delay, x, z, r, dmg, opts: { ...opts, color: noVisual ? -1 : opts.color } });
  }

  explode(x: number, z: number, radius: number, damage: number, opts: ExplodeOpts = {}) {
    const s = this.sess;
    if (opts.color !== -1) {
      s.fx.explosion(x, 0.5, z, radius, opts.color ?? 0xff8a30);
      s.audio.explosion(radius / 8, s.relPan(x, z));
      const dist = Math.hypot(x - s.player.pos.x, z - s.player.pos.z);
      s.cam.addTrauma(clamp(0.6 - dist / (radius * 6), 0, 0.6));
    }
    if (opts.fire) for (let i = 0; i < 5; i++) this.addHazard('fire', x + frand(-radius, radius) * 0.5, z + frand(-radius, radius) * 0.5, 2.5, 4, 25, true);
    if (opts.byPlayer && s.synergy('burning_road')) this.igniteNear(x, z, radius + 3);
    const chainId = opts.chainId ?? 0;
    for (const v of s.vehicles) {
      if (v.dead || v.removed) continue;
      const dx = v.pos.x - x, dz = v.pos.z - z;
      const d = Math.hypot(dx, dz);
      if (d > radius + v.length * 0.3) continue;
      const f = 1 - clamp(d / (radius + 0.01), 0, 1) * 0.6;
      const push = 16 * f;
      v.impulse((dx / (d || 1)) * push * v.mass, (dz / (d || 1)) * push * v.mass, frand(-4, 4) * v.mass);
      if (chainId) this.tag(v, chainId);
      if (v.role === 'ally') {
        this.damageVehicle(v, damage * f * 0.3, 'explosion');
        continue;
      }
      this.damageVehicle(v, damage * f, 'explosion', { chainId, byPlayer: opts.byPlayer });
    }
    for (const pr of s.world.props) {
      if (!pr.alive) continue;
      const d = Math.hypot(pr.x - x, pr.z - z);
      if (d > radius) continue;
      if (pr.explosive) {
        s.world.destroyProp(pr);
        this.queueExplosion(pr.x, pr.z, 7.5, 45, { byPlayer: opts.byPlayer, chainId, hurtsPlayer: true }, 0.12);
      } else if (!pr.heavy) s.world.knockProp(pr, ((pr.x - x) / (d || 1)) * 14, ((pr.z - z) / (d || 1)) * 14);
    }
    const p = s.player;
    const pd = Math.hypot(p.pos.x - x, p.pos.z - z);
    const hurts = pd < radius && opts.hurtsPlayer !== false && !(opts.byPlayer && opts.hurtsPlayer === undefined);
    if (pd < radius * 1.6 && pd > 0.5) {
      // the blast reaches the car: a shove away from it, the body rocks, the nose twitches. Arcade: it shoves
      // sideways, but it never stops a car that is driving through it (a wreck you just rammed won't throw you back)
      const f = 1 - pd / (radius * (hurts ? 1 : 1.6));
      const ux = (p.pos.x - x) / pd, uz = (p.pos.z - z) / pd;
      const k = (hurts ? 8 : H.blastNudge) * Math.max(0, f);
      const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
      const along = (ux * fx + uz * fz) * k;
      const keepAlong = Math.max(along, -2.5);
      const dvx = ux * k + fx * (keepAlong - along), dvz = uz * k + fz * (keepAlong - along);
      const torque = Math.sign(ux * -fz + uz * fx) || 1;
      p.hitBy(dvx, dvz, -torque * 0.5 * f, false);
      p.bump(0.4 * f);
    }
    if (hurts) this.damagePlayer(damage * 0.35 * (1 - pd / radius), 'explosion', x, z);
  }

  emp(x: number, z: number, radius: number, damage: number) {
    const s = this.sess;
    damage *= s.player.stats.electricDamage;
    s.fx.emp(x, 0.3, z, radius, 0x5ad1ff);
    s.audio.emp();
    s.postEmp = 0.6;
    for (const v of s.vehicles) {
      if (v.dead || v.removed || !v.hostile) continue;
      if (Math.hypot(v.pos.x - x, v.pos.z - z) > radius) continue;
      v.stun(2.6);
      v.expose(2.6);
      if (v.flying) v.hover = Math.max(0.8, v.hover - 1);
      this.damageVehicle(v, damage, 'electric', { byPlayer: true });
      s.fx.bolt(x, 1.2, z, v.pos.x, v.pos.y + 1, v.pos.z);
      // the target reacts: sparks off its body, its lights die for a moment
      s.fx.electric(v.pos.x, v.pos.y + 0.8, v.pos.z, 10, 0x9fe8ff);
      s.fx.sparks(v.pos.x, v.pos.y + 0.9, v.pos.z, 8, 0xb0e8ff, 6);
    }
    this.projectiles = this.projectiles.filter((pr) => pr.owner === 'player' || Math.hypot(pr.x - x, pr.z - z) > radius);
    for (const h of this.hazards) if (h.kind === 'emp' && Math.hypot(h.x - x, h.z - z) < radius + h.r) h.life = 0;
  }

  shockwave(x: number, z: number, radius: number, force: number, damage: number) {
    const s = this.sess;
    s.fx.shock(x, 0, z, radius, 0xffe066);
    s.audio.shockwave();
    s.cam.addTrauma(0.22);
    const chain = this.newChain();
    for (const v of s.vehicles) {
      if (v.dead || v.removed || v.role === 'ally') continue;
      const dx = v.pos.x - x, dz = v.pos.z - z;
      const d = Math.hypot(dx, dz);
      if (d > radius) continue;
      const f = 1 - (d / radius) * 0.5;
      const bossK = v.isBoss ? 0.25 : 1;
      v.impulse((dx / (d || 1)) * force * f * v.mass * bossK, (dz / (d || 1)) * force * f * v.mass * bossK, frand(-6, 6) * v.mass * bossK);
      if (!v.isBoss) v.spin = Math.max(v.spin, 1);
      this.tag(v, chain);
      if (v.hostile) this.damageVehicle(v, damage * f, 'explosion', { chainId: chain, byPlayer: true });
    }
    for (const pr of s.world.props) {
      if (pr.alive && !pr.heavy && Math.hypot(pr.x - x, pr.z - z) < radius) s.world.knockProp(pr, (pr.x - x) * 2, (pr.z - z) * 2);
    }
  }

  /** Forward cone of force (drift cannon, sonic boom). */
  cannon(x: number, z: number, yaw: number, length: number, width: number, damage: number) {
    const s = this.sess;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const chain = this.newChain();
    s.fx.muzzle(x + fx * 2.4, 0.9, z + fz * 2.4, fx, fz, 0x7af0ff);
    s.fx.sparks(x + fx * 3, 1, z + fz * 3, 30, 0xb0f8ff, 18, fx * 30, fz * 30);
    for (let i = 1; i <= 8; i++) {
      const d = length * (i / 8);
      s.fx.dust(x + fx * d, 0.3, z + fz * d, 2, width * (0.2 + i * 0.05), fx * 18, fz * 18);
    }
    s.audio.shockwave();
    s.cam.addTrauma(0.2);
    for (const v of s.vehicles) {
      if (v.dead || v.removed || v.role === 'ally') continue;
      const dx = v.pos.x - x, dz = v.pos.z - z;
      const along = dx * fx + dz * fz;
      const lat = Math.abs(dx * -fz + dz * fx);
      if (along < 0 || along > length || lat > width / 2 + (along / length) * width * 0.4) continue;
      v.impulse(fx * 22 * v.mass * (v.isBoss ? 0.2 : 1), fz * 22 * v.mass * (v.isBoss ? 0.2 : 1), frand(-5, 5) * v.mass);
      this.tag(v, chain);
      if (v.hostile) {
        v.expose(1.5);
        this.damageVehicle(v, damage, 'explosion', { chainId: chain, byPlayer: true });
      }
    }
  }

  missiles(count: number, damage: number) {
    const s = this.sess;
    const p = s.player;
    const targets = s.vehicles.filter((v) => v.hostile && !v.dead && !v.removed).sort((a, b) => Math.hypot(a.pos.x - p.pos.x, a.pos.z - p.pos.z) - Math.hypot(b.pos.x - p.pos.x, b.pos.z - p.pos.z));
    for (let i = 0; i < count; i++) {
      const t = targets[i % Math.max(1, targets.length)] ?? null;
      const a = p.yaw + (i - (count - 1) / 2) * 0.5;
      this.projectiles.push({ x: p.pos.x, y: p.pos.y + 1.5, z: p.pos.z, vx: Math.sin(a) * 30 + p.velX, vz: Math.cos(a) * 30 + p.velZ, life: 3, dmg: damage, owner: 'player', kind: 'missile', target: t });
      // launch: the motor lights on the rack — a backblast of flame and smoke, staggered per missile
      s.fx.after(i * 0.06, () => {
        s.fx.muzzle(p.pos.x - Math.sin(a) * 0.4, p.pos.y + 1.5, p.pos.z - Math.cos(a) * 0.4, -Math.sin(a), -Math.cos(a), 0xffa040);
        s.fx.puff('exhaust', p.pos.x, p.pos.y + 1.4, p.pos.z, p.velX * 0.5, 0.4, p.velZ * 0.5, 1.4, 0.8);
      });
    }
    s.audio.shoot('missile');
  }

  chainLightning(x: number, z: number, targets: number, damage: number, range = 25, exclude: AIVehicle[] = []) {
    const s = this.sess;
    if (s.synergy('chain_shock')) targets += 2;
    if (s.hasItem('storm_dynamo')) targets += 2;
    if (s.synergy('storm')) targets += 3;
    damage *= s.player.stats.electricDamage;
    let cx = x, cy = 1, cz = z;
    const hitSet = new Set(exclude);
    for (let i = 0; i < targets; i++) {
      let best: AIVehicle | null = null, bd = range;
      for (const v of s.vehicles) {
        if (v.dead || v.removed || hitSet.has(v)) continue;
        if (!v.hostile && !(s.hasItem('storm_dynamo') && v.role === 'traffic')) continue;
        const d = Math.hypot(v.pos.x - cx, v.pos.z - cz);
        if (d < bd) {
          bd = d;
          best = v;
        }
      }
      if (!best) break;
      hitSet.add(best);
      s.fx.bolt(cx, cy, cz, best.pos.x, best.pos.y + 1, best.pos.z);
      if (best.hostile) {
        best.stun(s.hasItem('capacitor_bumper') ? 2 : 0.4);
        if (s.hasItem('capacitor_bumper')) best.expose(2);
        this.damageVehicle(best, damage, 'electric', { byPlayer: true });
      } else targets++; // traffic only conducts
      cx = best.pos.x;
      cy = best.pos.y + 1;
      cz = best.pos.z;
    }
    if (hitSet.size > exclude.length) s.audio.zap();
  }

  /** Enemy gunner rakes a painted lane: impacts walk down the strip. */
  laneBarrage(v: AIVehicle, sAt: number, d: number, n: number, dmg: number) {
    const s = this.sess;
    const road = s.world.road;
    s.audio.shoot('enemy');
    for (let i = 0; i < n; i++) {
      this.schedule(i * 0.08, () => {
        if (v.dead || v.removed || v.stunT > 0) return;
        const o = { x: 0, y: 0, z: 0 };
        road.toWorld(sAt - 12 + i * 5, d + frand(-0.8, 0.8), o);
        s.fx.bolt(v.pos.x, v.pos.y + 1.4, v.pos.z, o.x, o.y + 0.2, o.z, 0xff3050);
        s.fx.sparks(o.x, 0.3, o.z, 6, 0xff6060, 6);
        const p = s.player;
        if (Math.hypot(p.pos.x - o.x, p.pos.z - o.z) < 2.2) this.damagePlayer(dmg, 'weapon', o.x, o.z);
      });
    }
  }

  /** EMP van dome: no nitro or abilities inside. */
  empField(x: number, z: number, r: number, life: number) {
    this.addHazard('emp', x, z, r, life, 0, false);
    this.sess.fx.emp(x, 0.3, z, r * 0.8, 0x4060ff);
    this.sess.audio.emp();
  }

  /** Drone-called lightning strike on a marked spot. */
  strike(x: number, z: number, r: number, dmg: number) {
    const s = this.sess;
    s.fx.bolt(x, 22, z, x, 0.3, z, 0xff60e0);
    s.fx.bolt(x + 1, 18, z, x, 0.3, z, 0xffffff);
    s.fx.electric(x, 0.5, z, 24, 0xff60e0);
    s.fx.flashLight(x, 4, z, 0xff80f0, 22, 0.25, 0.01, 0.5);
    s.fx.decal('scorch', x, 0, z, r * 0.6, r * 0.7, 0x000000, 0.55, 6);
    s.fx.dust(x, 0.3, z, 6, 1.2);
    s.audio.zap();
    this.addHazard('electric', x, z, r * 0.8, 3.5, 10, false);
    const p = s.player;
    if (Math.hypot(p.pos.x - x, p.pos.z - z) < r) {
      this.damagePlayer(dmg, 'electric', x, z);
      p.systemsLock = Math.max(p.systemsLock, 0.8);
    }
    for (const v of s.vehicles) if (v.hostile && !v.dead && !v.flying && Math.hypot(v.pos.x - x, v.pos.z - z) < r) this.damageVehicle(v, dmg, 'electric');
  }

  /** Oil near a point catches fire. */
  igniteNear(x: number, z: number, r: number) {
    let n = 0;
    for (const h of this.hazards) {
      if (h.kind !== 'oil' || h.life <= 0 || Math.hypot(h.x - x, h.z - z) > r) continue;
      h.life = 0;
      this.addHazard('fire', h.x, h.z, h.r + 0.3, this.sess.synergy('burning_road') ? 8 : 4, 26, true);
      n++;
    }
    return n;
  }

  addHazard(kind: HazardKind, x: number, z: number, r: number, life: number, dps = 0, byPlayer = false) {
    if (this.hazards.length > 260) {
      const idx = this.hazards.findIndex((h) => h.life < 9000);
      const old = this.hazards.splice(idx >= 0 ? idx : 0, 1)[0];
      this.releaseHazMesh(old);
    }
    const mesh = this.hazPool.pop() ?? new THREE.Mesh(this.hazGeo);
    mesh.material = this.hazMats[kind];
    mesh.rotation.x = -Math.PI / 2;
    mesh.rotation.z = Math.random() * 6;
    const road = this.sess.world.road;
    const hs = road.project(x, z, this.sess.player.s, { s: 0, d: 0 }).s;
    const y = road.at(hs).y;
    mesh.position.set(x, y + 0.04 + Math.random() * 0.01, z);
    mesh.scale.setScalar(r * (kind === 'mine' ? 0.35 : 1.15));
    mesh.renderOrder = 3;
    mesh.visible = true;
    this.group.add(mesh);
    if (kind === 'fire' && this.sess.synergy('burning_road')) life *= 2;
    this.hazards.push({ kind, x, z, r, life, max: life, dps, byPlayer, mesh, armed: kind === 'mine' ? 0.5 : 0, hitPlayer: false, s: hs });
  }

  private releaseHazMesh(h: Hazard) {
    if (!h.mesh) return;
    this.group.remove(h.mesh);
    this.hazPool.push(h.mesh);
    h.mesh = null;
  }

  updateProjectiles(dt: number) {
    const s = this.sess;
    let n = 0;
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const pr = this.projectiles[i];
      pr.life -= dt;
      const t = pr.target;
      if (t && !t.dead && !t.removed) {
        const want = Math.atan2(t.pos.x - pr.x, t.pos.z - pr.z);
        const cur = Math.atan2(pr.vx, pr.vz);
        const na = cur + clamp(wrapAngle(want - cur), -5 * dt, 5 * dt);
        const sp = Math.min(90, Math.hypot(pr.vx, pr.vz) + 60 * dt);
        pr.vx = Math.sin(na) * sp;
        pr.vz = Math.cos(na) * sp;
      }
      // motor: a short hot jet off the tail, and smoke left hanging in the air where it flew
      const sp = Math.hypot(pr.vx, pr.vz) || 1, dx = pr.vx / sp, dz = pr.vz / sp;
      // (the motor is the brightest thing on it: a glare you can follow across the screen)
      s.fx.lampGlare(pr.x - dx * 0.5, pr.y, pr.z - dz * 0.5, MOTOR, 0.9, 1.1 + Math.random() * 0.5);
      s.fx.exhaust(pr.x - dx * 0.48, pr.y, pr.z - dz * 0.48, -dx, 0, -dz, pr.vx, pr.vz, 'boost', 0xff8a30, 1.1);
      if (Math.random() < 0.9) s.fx.puff('rocket', pr.x - dx * 1.1, pr.y, pr.z - dz * 1.1, 0, -0.2, 0);
      const nx = pr.x + pr.vx * dt, nz = pr.z + pr.vz * dt;
      let dead = pr.life <= 0;
      if (!dead) {
        for (const v of s.vehicles) {
          if (v.dead || v.removed || !v.hostile) continue;
          if (segDist(pr.x, pr.z, nx, nz, v.pos.x, v.pos.z) < Math.max(1.4, v.width * 0.7) + 0.6) {
            this.explode(nx, nz, 5.5, pr.dmg, { byPlayer: true, hurtsPlayer: false, chainId: this.newChain() });
            dead = true;
            break;
          }
        }
      }
      pr.x = nx;
      pr.z = nz;
      if (dead) {
        if (pr.life <= 0) this.explode(pr.x, pr.z, 4, pr.dmg * 0.5, { byPlayer: true, hurtsPlayer: false });
        this.projectiles[i] = this.projectiles[this.projectiles.length - 1];
        this.projectiles.pop();
        continue;
      }
      if (n < 200) {
        this.dummy.position.set(pr.x, pr.y, pr.z);
        this.dummy.rotation.set(0, Math.atan2(pr.vx, pr.vz), 0);
        this.dummy.scale.set(1, 1, 1);
        this.dummy.updateMatrix();
        this.projMesh.setMatrixAt(n, this.dummy.matrix);
        n++;
      }
    }
    this.projMesh.count = n;
    this.projMesh.instanceMatrix.needsUpdate = true;
    if (this.projMesh.instanceColor) this.projMesh.instanceColor.needsUpdate = true;
  }

  updateHazards(dt: number) {
    const s = this.sess;
    const p = s.player;
    p.tractionMul = 1;
    // IGNITER: nitro flame passing over oil
    const igT = s.mem.igniteT ?? -9;
    if (s.time - igT < 0.15) {
      const n = this.igniteNear(s.mem.igniteX, s.mem.igniteZ, 3);
      if (n) s.addNitro(4 * n);
    }
    for (let i = this.hazards.length - 1; i >= 0; i--) {
      const h = this.hazards[i];
      h.life -= dt;
      if (h.armed > 0) h.armed -= dt;
      if (h.s < p.s - 220) h.life = 0;
      if (h.life <= 0) {
        this.releaseHazMesh(h);
        this.hazards.splice(i, 1);
        continue;
      }
      if (h.mesh) {
        const fade = Math.min(1, h.life / 0.6);
        h.mesh.scale.setScalar(h.r * (h.kind === 'mine' ? 0.35 : 1.15) * (h.kind === 'fire' || h.kind === 'electric' || h.kind === 'boost' ? 0.9 + Math.sin(s.time * 12 + i) * 0.1 : 1) * (0.5 + 0.5 * fade));
      }
      const near = Math.abs(h.s - p.s) < 140;
      if (!near) continue;
      if (h.kind === 'fire' && Math.random() < 0.6 * s.fx.density) s.fx.fire(h.x + frand(-h.r, h.r) * 0.6, 0.1, h.z + frand(-h.r, h.r) * 0.6, 1, 0.8);
      if (h.kind === 'electric' && Math.random() < 0.25) s.fx.electric(h.x + frand(-h.r, h.r) * 0.6, 0.2, h.z + frand(-h.r, h.r) * 0.6, 2, s.zone.id === 'zeromile' ? 0xff40c0 : 0x60d0ff);
      if (h.kind === 'emp' && Math.random() < 0.3) s.fx.electric(h.x + frand(-h.r, h.r) * 0.7, 0.6, h.z + frand(-h.r, h.r) * 0.7, 1, 0x6080ff);
      if (h.kind === 'ghost' && Math.random() < 0.3) s.fx.trail(h.x, 0.6, h.z, 0xb080ff, 0.7, 0.3);
      if (h.kind === 'boost' && Math.random() < 0.2) s.fx.trail(h.x + frand(-1, 1), 0.2, h.z + frand(-1, 1), 0x30f0ff, 0.4, 0.4);
      const pd = Math.hypot(p.pos.x - h.x, p.pos.z - h.z);
      if (pd > h.r + 6) h.hitPlayer = false;
      if (pd < h.r + 0.8 && p.grounded && !h.byPlayer) {
        switch (h.kind) {
          case 'oil': p.tractionMul = Math.min(p.tractionMul, 0.3); break;
          case 'water':
            p.tractionMul = Math.min(p.tractionMul, 0.55);
            // a sheet of water thrown up off all four tyres
            if (p.speed > 10) for (const side of [-1, 1]) s.fx.spray(p.pos.x - Math.cos(p.yaw) * side * 0.9, p.pos.z + Math.sin(p.yaw) * side * 0.9, -p.velX * 0.3, -p.velZ * 0.3, 0.9);
            break;
          case 'fire': this.damagePlayer(h.dps * 0.5 * dt, 'fire'); break;
          case 'electric':
            this.damagePlayer(Math.max(6, h.dps) * dt, 'electric');
            p.systemsLock = Math.max(p.systemsLock, 0.25);
            break;
          case 'emp': p.systemsLock = Math.max(p.systemsLock, 0.35); break;
          case 'boost':
            if (!h.hitPlayer) {
              h.hitPlayer = true;
              s.boost(1.1);
              s.addNitro(8);
              s.addCombo(0.5, 'pad');
              s.audio.nitroStart();
            }
            break;
          case 'mine':
            if (h.armed <= 0) {
              h.life = 0;
              this.explode(h.x, h.z, 6, h.dps || 25, { hurtsPlayer: true });
            }
            break;
          case 'spikes':
            if (!h.hitPlayer) {
              h.hitPlayer = true;
              this.damagePlayer(10, 'weapon');
              p.velX *= 0.7;
              p.velZ *= 0.7;
              s.fx.sparks(p.pos.x, 0.3, p.pos.z, 20, 0xffd060, 8);
              s.notify('SPIKE STRIP', '#ffd000');
            }
            break;
        }
      }
      for (const v of s.vehicles) {
        if (v.dead || v.removed) continue;
        const d = Math.hypot(v.pos.x - h.x, v.pos.z - h.z);
        if (d > h.r + 0.8) continue;
        if (v.flying && h.kind !== 'ghost') continue;
        switch (h.kind) {
          case 'oil':
            if (v.oilT <= 0 && v.speed > 10 && !v.isBoss && v.role !== 'ally') {
              v.spin = Math.max(v.spin, 0.9);
              v.yawRate += frand(-3, 3);
              v.expose(1.8);
              if (h.byPlayer) this.tag(v, this.newChain());
            }
            v.oilT = 1.2;
            break;
          case 'water': v.oilT = Math.max(v.oilT, 0.3); break;
          case 'fire':
            if (h.byPlayer || !v.isBoss) v.burn(2, h.dps * (h.byPlayer ? p.stats.fireDamage : 0.5));
            if (h.byPlayer && s.hasItem('inferno_core')) v.expose(0.5);
            break;
          case 'electric':
            if (v.hostile) {
              if (!v.isBoss) v.stun(0.3);
              this.damageVehicle(v, (h.dps || 10) * dt, 'electric', { byPlayer: h.byPlayer });
            }
            break;
          case 'ghost':
            if (h.byPlayer && v.hostile) this.damageVehicle(v, h.dps * dt, 'ghost', { byPlayer: true });
            break;
          case 'mine':
            if (h.armed <= 0 && v.hostile) {
              h.life = 0;
              this.explode(h.x, h.z, 7, h.dps || 40, { byPlayer: h.byPlayer, hurtsPlayer: !h.byPlayer, chainId: this.newChain() });
            }
            break;
        }
      }
    }
    // INFERNO: fire zones near each other feed each other
    if (s.synergy('inferno') && Math.random() < dt * 4) {
      const fires = this.hazards.filter((h) => h.kind === 'fire' && h.byPlayer);
      for (const a of fires) for (const b of fires) if (a !== b && Math.hypot(a.x - b.x, a.z - b.z) < 7) a.life = Math.max(a.life, Math.min(a.max, b.life));
    }
    for (const v of s.vehicles) {
      if (v.burnT > 0 && !v.dead) {
        v.burnT -= dt;
        this.damageVehicle(v, v.burnDps * dt, 'fire', { byPlayer: true, chainId: this.activeChain(v) });
        if (Math.random() < 0.5 * s.fx.density) s.fx.fire(v.pos.x, v.pos.y + 1, v.pos.z, 1, 0.7);
      }
    }
  }

  update(dt: number) {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const e = this.pending[i];
      e.t -= dt;
      if (e.t <= 0) {
        this.pending.splice(i, 1);
        if (e.r > 0) this.explode(e.x, e.z, e.r, e.dmg, e.opts);
      }
    }
    for (let i = this.timers.length - 1; i >= 0; i--) {
      const t = this.timers[i];
      t.t -= dt;
      if (t.t <= 0) {
        this.timers.splice(i, 1);
        t.fn();
      }
    }
    for (const [id, c] of this.chains) if (this.sess.time - c.time > 6) this.chains.delete(id);
    for (const [v, w] of this.wrecking) if (w.until < this.sess.time || v.dead) this.wrecking.delete(v);
    this.cooldowns.q = Math.max(0, this.cooldowns.q - dt);
    this.cooldowns.e = Math.max(0, this.cooldowns.e - dt);
    if (this.harpoon) {
      const h = this.harpoon;
      h.t -= dt;
      const p = this.sess.player;
      const t = h.target;
      if (h.t <= 0 || t.dead || t.removed) {
        this.harpoon = null;
        this.harpoonLine.visible = false;
      } else {
        const dx = p.pos.x - t.pos.x, dz = p.pos.z - t.pos.z;
        const d = Math.hypot(dx, dz) || 1;
        const k = t.isBoss ? 0.15 : 1;
        t.velX += (dx / d) * 55 * dt * k + p.velX * 0.02;
        t.velZ += (dz / d) * 55 * dt * k + p.velZ * 0.02;
        if (!t.isBoss) t.spin = Math.max(t.spin, 0.3);
        const a = this.harpoonLine.geometry.attributes.position as THREE.BufferAttribute;
        a.setXYZ(0, p.pos.x, p.pos.y + 1, p.pos.z);
        a.setXYZ(1, t.pos.x, t.pos.y + 1, t.pos.z);
        a.needsUpdate = true;
      }
    }
  }

  // ------------------------------------------------------------------ abilities

  abilityCost(id: AbilityId) {
    return ABILITIES[id].cost;
  }

  useAbility(slot: 'q' | 'e', id: AbilityId): boolean {
    const s = this.sess;
    const p = s.player;
    const def = ABILITIES[id];
    if (this.cooldowns[slot] > 0) return false;
    if (p.systemsLock > 0) {
      s.notify('SYSTEMS JAMMED', '#6688ff');
      return false;
    }
    const cost = this.abilityCost(id);
    if (p.momentum < cost && !s.godMode) {
      s.notify('NEED MOMENTUM', '#ff6680');
      s.audio.warning();
      return false;
    }
    if (!s.godMode) p.momentum -= cost;
    this.cooldowns[slot] = def.cooldown * p.stats.abilityCooldown;
    const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
    switch (id) {
      case 'emp': this.emp(p.pos.x, p.pos.z, 20, 25); break;
      case 'shockwave': this.shockwave(p.pos.x, p.pos.z, 16, 34, 26); break;
      case 'harpoon': {
        let t: AIVehicle | null = null, bd = 48 * 48;
        for (const v of s.vehicles) {
          if (v.dead || v.removed || !v.hostile) continue;
          const dx = v.pos.x - p.pos.x, dz = v.pos.z - p.pos.z;
          const d2 = dx * dx + dz * dz;
          if (d2 < bd && (dx * fx + dz * fz) / Math.sqrt(d2 || 1) > 0.2) {
            bd = d2;
            t = v;
          }
        }
        if (!t) {
          s.notify('NO TARGET', '#ff6680');
          p.momentum += cost;
          this.cooldowns[slot] = 0.3;
          return false;
        }
        this.harpoon = { target: t, t: 0.7 };
        this.harpoonLine.visible = true;
        this.tag(t, this.newChain());
        t.expose(1.5);
        s.audio.shoot('missile');
        break;
      }
      case 'boost': {
        const add = Math.min(18, p.maxSpeedNow * 1.2 - p.vF);
        if (add > 0) {
          p.velX += fx * add;
          p.velZ += fz * add;
        }
        s.perfectWindow = s.time + 1;
        s.fx.pulse(p.pos.x, 0.3, p.pos.z, 4, 0x66ffa8, 0.3);
        s.audio.nitroStart();
        break;
      }
      case 'phase': s.setPhase(2.5); break;
      case 'repair': s.heal(p.maxHp * 0.25); s.fx.pulse(p.pos.x, 0.3, p.pos.z, 3.5, 0x7dff7d, 0.5); break;
      case 'afterburner':
        p.afterburner = 1.6;
        s.perfectWindow = s.time + 1.6;
        s.audio.nitroStart();
        s.cam.addTrauma(0.12);
        break;
      case 'bulldozer':
        p.bulldozer = 4;
        s.addMass(3);
        s.fx.pulse(p.pos.x, 0.3, p.pos.z, 4, 0xffb020, 0.4);
        s.fx.sparks(p.pos.x + fx * 2.2, 0.5, p.pos.z + fz * 2.2, 16, 0xffd080, 7, fx * 6, fz * 6);
        s.audio.metal(0.8);
        break;
      case 'phaseshift':
        s.setPhase(1.8);
        p.velX += fx * 6;
        p.velZ += fz * 6;
        break;
      case 'cargo': {
        const back = p.s - 6;
        s.world.spawnProp('xbarrel', back, p.d - 0.8);
        s.world.spawnProp('xbarrel', back, p.d + 0.8);
        s.world.spawnProp('crate', back - 3, p.d);
        s.fx.debrisBurst(p.pos.x - fx * 3, 1, p.pos.z - fz * 3, 6, 0x7dff4a, 4);
        s.audio.metal(0.5);
        break;
      }
    }
    s.popup(def.name, def.color);
    return true;
  }
}

function segDist(ax: number, az: number, bx: number, bz: number, px: number, pz: number) {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz || 1e-6;
  const t = clamp(((px - ax) * dx + (pz - az) * dz) / l2, 0, 1);
  return Math.hypot(ax + dx * t - px, az + dz * t - pz);
}
