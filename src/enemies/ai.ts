import * as THREE from 'three';
import { clamp, damp, wrapAngle } from '../core/math';
import { frand } from '../core/random';
import { ENEMIES, TRAFFIC_DIMS, type EnemyKind, type ModelKind, type TrafficKind } from '../data/enemies';
import type { DrivingSession } from '../game/driving';
import type { SimVehicle } from '../game/simApi';
import { EMISSIVE, glow } from '../render/visualBudget';
import { TargetTag, type TagKind } from './targetTag';
import { buildCar, variantCount, type CarModel } from '../vehicles/carModels';
import type { Road } from '../world/road';
import { lipHeight } from '../player/player';
import { laneOffset, lanesFor, type World } from '../world/world';


export type Role = 'traffic' | 'enemy' | 'boss' | 'ally' | 'rival';

/** What an AI car is trying to do right now. Encounters assign tasks; kinds add attack patterns on top. */
export type Task =
  | { kind: 'free' }
  | { kind: 'slot'; anchor: 'player' | AIVehicle; rel: number; d: number; absD?: boolean }
  | { kind: 'block'; s: number; d: number; speed: number }
  | { kind: 'flee'; minSpeed: number; maxSpeed: number }
  | { kind: 'pursue'; gap: number; delay: number }
  | { kind: 'attackTarget'; target: AIVehicle }
  | { kind: 'cross'; speed: number }
  | { kind: 'cruise'; speed: number; d: number }
  | { kind: 'retreat' };

export type WeakSide = 'side' | 'rear' | 'front' | 'any';

let NEXT_ID = 1;

/** Any AI-driven car: neutral traffic, enemies, allies, rivals and bosses share this physics body. */
export class AIVehicle implements SimVehicle {
  id = NEXT_ID++;
  pos = new THREE.Vector3();
  velX = 0;
  velZ = 0;
  yaw = 0;
  yawRate = 0;
  s = 0;
  d = 0;
  vF = 0;
  hp: number;
  maxHp: number;
  dead = false;
  deathTimer = 0;
  mass: number;
  length: number;
  width: number;
  topSpeed: number;
  accel: number;
  grip = 8;
  /** lateral acceleration budget: AIs also have to slow for corners */
  cornerGrip = 26;
  targetSpeed = 20;
  targetD = 0;
  spin = 0;
  stunT = 0;
  burnT = 0;
  burnDps = 0;
  oilT = 0;
  slowT = 0;
  flash = 0;
  chainId = 0;
  chainTime = 0;
  lastPlayerHit = -99;
  flying = false;
  hover = 0;
  /** ground cars in the air (ramps, broken bridges) */
  airborne = false;
  airVy = 0;
  /** fell into a hole: the session wrecks and removes it */
  fallen = false;
  // the body is alive too (visual): roll and pitch on springs, orientation in the air
  private bodyRoll = 0;
  private bodyRollV = 0;
  private bodyPitch = 0;
  private bodyPitchV = 0;
  private airPitch = 0;
  private airRoll = 0;
  private airRollRate = 0;
  private lastVF = 0;
  private landings = 0;
  elite = false;
  task: Task = { kind: 'free' };
  encId = -1;
  weak: WeakSide = 'any';
  armor = 1;
  exposedT = 0;
  ai = { state: 'idle', t: 0, side: 1, n: 0, lane: 0, cd: 0, lockD: 0, fuse: 0 };
  credits = 0;
  threat = 1;
  crossing = false;
  // near-miss tracking
  nmRelPrev = 0;
  nmMinGap = 99;
  nmTouched = false;
  nmActive = false;
  hitCooldown = 0;
  /**
   * Enemy speed budget — chasing is behaviour, not speed matching. An enemy cruises at its own top speed and can
   * boost to +18% (visible flames) from a tank that drains while boosting and refills while it isn't. If you are
   * genuinely faster, it loses you.
   */
  boostE = 1;
  boosting = false;
  /** seconds this chaser has been hopelessly out-run (it gives up and re-routes) */
  outrunT = 0;
  /** your current duel opponent (see game/chase.ts) */
  duel = false;
  removed = false;
  boss: unknown = null;
  phased = 0;
  isTarget = false;
  /** chaos: drives against the traffic down one lane (see game/chaos.ts) */
  wrongWay = false;
  /** what this car is to the player (shown as a worded tag with health) */
  markerKind: TagKind | null = null;
  /** a name to show instead of the marker's word */
  tagLabel: string | null = null;
  private tag: TargetTag | null = null;

  constructor(public role: Role, public kind: string, public model: CarModel, opts: { hp: number; mass: number; length: number; width: number; topSpeed: number; accel: number }) {
    this.hp = this.maxHp = opts.hp;
    this.mass = opts.mass;
    this.length = opts.length;
    this.width = opts.width;
    this.topSpeed = opts.topSpeed;
    this.accel = opts.accel;
  }

  get isBoss() {
    return this.role === 'boss';
  }
  /** Neutral cars that weapons ignore and that don't pay out kills. */
  get isTraffic() {
    return this.role === 'traffic' || this.role === 'ally' || this.role === 'rival';
  }
  get hostile() {
    return this.role === 'enemy' || this.role === 'boss';
  }
  get speed() {
    return Math.hypot(this.velX, this.velZ);
  }
  get exposed() {
    return this.exposedT > 0 || this.stunT > 0;
  }

  stun(t: number) {
    this.stunT = Math.max(this.stunT, t * (this.isBoss ? 0.4 : 1));
  }
  expose(t: number) {
    if (this.isBoss) return;
    this.exposedT = Math.max(this.exposedT, t);
  }
  burn(t: number, dps: number) {
    this.burnT = Math.max(this.burnT, t);
    this.burnDps = Math.max(this.burnDps, dps);
  }
  /** Rock the body: a sideways shove (rad/s of roll), a nose-up / nose-down jolt. */
  rollKick(a: number) {
    this.bodyRollV += a * 3;
    if (this.airborne) this.airRollRate += a * 2;
  }
  pitchKick(a: number) {
    this.bodyPitchV += a * 3;
  }

  impulse(x: number, z: number, spin = 0) {
    const k = 1 / this.mass;
    this.velX += x * k;
    this.velZ += z * k;
    this.yawRate += spin * k;
    // the body rocks with the shove (sideways component in the car's frame)
    const lat = (x * -Math.cos(this.yaw) + z * Math.sin(this.yaw)) * k;
    this.rollKick(clamp(lat * 0.05, -1.2, 1.2));
    if (Math.hypot(x, z) * k > 6 && !this.isBoss) {
      this.spin = Math.max(this.spin, 0.7);
      this.expose(1.2);
    }
  }

  setMarker(kind: TagKind | null) {
    this.markerKind = kind;
    if (kind && !this.tag) {
      this.tag = new TargetTag();
      this.model.group.add(this.tag.sprite);
    }
    if (!kind && this.tag) this.tag.sprite.visible = false;
  }

  /**
   * Per frame: what the tag says. Exposed hostiles read HIT IT!; ordinary enemies only show near the player
   * (or always on the first road) so the screen doesn't fill up with labels.
   */
  updateTag(dist: number, showAll: boolean) {
    if (!this.tag) return;
    const kind = this.duel ? 'duel' : this.markerKind;
    if (!kind || this.dead) {
      this.tag.sprite.visible = false;
      return;
    }
    const shown: TagKind = this.hostile && this.exposed ? 'exposed' : kind;
    const near = kind === 'enemy' ? dist < (showAll ? 110 : 70) : kind === 'elite' ? dist < 160 : true;
    this.tag.label = shown === kind ? this.tagLabel : null;
    this.tag.update(shown, this.hp / this.maxHp, dist, this.model.height + (this.flying ? 0.4 : 0), near);
  }

  disposeTag() {
    this.tag?.dispose();
    this.tag = null;
  }


  place(road: Road, s: number, d: number, speed: number, yawOffset = 0) {
    const o = { x: 0, y: 0, z: 0 };
    road.toWorld(s, d, o);
    this.pos.set(o.x, o.y + this.hover, o.z);
    const h = road.at(s).heading + yawOffset;
    this.yaw = h;
    this.velX = Math.sin(h) * speed;
    this.velZ = Math.cos(h) * speed;
    this.s = s;
    this.d = d;
    this.targetD = d;
    this.targetSpeed = speed;
    this.model.group.position.copy(this.pos);
    this.model.group.rotation.y = h;
  }

  /** Low-level driving toward targetSpeed / targetD, with corner-speed limits, barriers and medians. */
  drive(dt: number, world: World): { wall: number; wx: number; wz: number } {
    const road = world.road;
    const res = { wall: 0, wx: 0, wz: 0 };
    this.spin = Math.max(0, this.spin - dt);
    this.stunT = Math.max(0, this.stunT - dt);
    this.oilT = Math.max(0, this.oilT - dt);
    this.slowT = Math.max(0, this.slowT - dt);
    this.exposedT = Math.max(0, this.exposedT - dt);
    this.flash = Math.max(0, this.flash - dt * 5);
    this.hitCooldown = Math.max(0, this.hitCooldown - dt);
    this.phased = Math.max(0, this.phased - dt);

    if (this.flying) return this.fly(dt, road);
    if (this.crossing) return this.cross(dt, road);
    if (this.wrongWay) return this.oncoming(dt, road);

    let fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    let vF = this.velX * fx + this.velZ * fz;
    const control = !this.dead && this.spin <= 0 && this.stunT <= 0 && !this.airborne;

    if (control) {
      const look = clamp(Math.abs(vF) * 0.55, 7, 26);
      const tD = world.safeD(this.s + look, this.targetD);
      const p = road.at(this.s + look, tmpPt);
      const tx = p.x - Math.cos(p.heading) * tD;
      const tz = p.z + Math.sin(p.heading) * tD;
      const desired = Math.atan2(tx - this.pos.x, tz - this.pos.z);
      const err = wrapAngle(desired - this.yaw);
      const targetYR = clamp(err * 3.2, -2.4, 2.4) * clamp(Math.abs(vF) / 6, 0.2, 1);
      this.yawRate = damp(this.yawRate, targetYR, 7, dt);
    } else {
      this.yawRate = damp(this.yawRate, 0, this.dead ? 1.2 : 1.8, dt);
    }
    this.yawRate = clamp(this.yawRate, -5, 5);
    this.yaw = wrapAngle(this.yaw + this.yawRate * dt);
    fx = Math.sin(this.yaw);
    fz = Math.cos(this.yaw);
    const rx = -fz, rz = fx;
    vF = this.velX * fx + this.velZ * fz;
    let vL = this.velX * rx + this.velZ * rz;

    if (this.airborne) {
      // ballistic: keep the velocity, no throttle or grip in the air
    } else if (control) {
      let cap: number;
      if (this.role === 'enemy') {
        // boost only to catch up, and only while there is boost left
        this.boosting = this.targetSpeed > this.topSpeed + 0.5 && this.boostE > 0.04 && !this.dead;
        this.boostE = clamp(this.boostE + (this.boosting ? -0.22 : this.duel ? 0.16 : 0.1) * dt, 0, 1);
        cap = this.topSpeed * (this.boosting ? 1.18 : 1);
      } else cap = this.role === 'traffic' ? this.topSpeed : this.topSpeed * 1.3;
      // respect the corner ahead like a driver would (bosses and charging cars may overcommit)
      const cornerV = cornerSpeed(road, this.s, 20 + Math.abs(vF) * 1.1, this.cornerGrip);
      const tgt = Math.min(this.targetSpeed, cap * (this.slowT > 0 ? 0.6 : 1), this.ai.state === 'charge' ? 99 : cornerV);
      if (vF < tgt) vF = Math.min(tgt, vF + this.accel * dt);
      else vF = damp(vF, tgt, tgt < vF - 8 ? 2.6 : 1.6, dt);
    } else {
      vF = damp(vF, 0, this.dead ? 0.9 : this.stunT > 0 ? 0.9 : 0.5, dt);
    }
    const grip = this.airborne ? 0 : this.dead ? 1.2 : this.spin > 0 ? 0.7 : this.oilT > 0 ? 0.35 : this.grip;
    vL *= Math.exp(-grip * dt);
    this.velX = fx * vF + rx * vL;
    this.velZ = fz * vF + rz * vL;
    this.vF = vF;

    const prevS = this.s;
    this.pos.x += this.velX * dt;
    this.pos.z += this.velZ * dt;
    road.project(this.pos.x, this.pos.z, this.s, tmpProj);
    this.s = tmpProj.s;
    this.d = tmpProj.d;
    const rp = road.at(this.s, tmpPt);
    const hole = road.sample(this.s).gap;
    if (!this.airborne) {
      for (const lip of road.lips) {
        if (prevS < lip.s && this.s >= lip.s && vF > 6) {
          this.airborne = true;
          this.airVy = vF * lip.slope + 2;
          this.airPitch = Math.atan(lip.slope);
          // a car that hits the lip crooked or still twitching from a hit takes a roll into the air with it
          this.airRollRate = this.spin > 0 || Math.abs(this.yawRate) > 0.6 ? (Math.random() - 0.5) * 2.2 : (Math.random() - 0.5) * 0.4;
          break;
        }
      }
      if (!this.airborne && hole) {
        this.airborne = true;
        this.airVy = 0;
      }
    }
    if (this.airborne) {
      this.airVy -= 32 * dt;
      this.pos.y += this.airVy * dt;
      // the nose follows the arc, the roll it took with it keeps turning slowly
      this.airPitch = damp(this.airPitch, Math.atan2(this.airVy, Math.max(4, Math.abs(vF))) * 0.6, 2.4, dt);
      this.airRoll += this.airRollRate * dt;
      if (this.pos.y <= rp.y && !hole && this.pos.y > rp.y - 1.5) {
        const impact = -this.airVy;
        this.pos.y = rp.y;
        this.airborne = false;
        this.airVy = 0;
        this.landings++;
        // landings are not all clean: a crooked or hard one bounces, wobbles, sometimes spins it out (bounded:
        // decided by how it landed, plus a little variation per car — never random stupidity)
        const crooked = Math.abs(this.airRoll) > 0.35 || Math.abs(this.yawRate) > 1.2 || ((this.id * 7 + this.landings) % 6 === 0 && impact > 8);
        this.bodyPitchV += clamp(-this.airPitch, -0.4, 0.4) * 4;
        this.bodyRollV += clamp(this.airRoll, -0.6, 0.6) * 4;
        if (crooked && !this.isBoss) {
          this.spin = Math.max(this.spin, 0.45 + Math.min(0.5, Math.abs(this.airRoll)));
          this.yawRate += (Math.sign(this.airRoll || this.yawRate || 1)) * (1 + impact * 0.05);
          this.velX *= 0.9;
          this.velZ *= 0.9;
          if (impact > 9) {
            // a hop
            this.airborne = true;
            this.airVy = Math.min(3, impact * 0.18);
          }
        }
        if (!this.airborne) {
          this.airPitch = 0;
          this.airRoll = 0;
          this.airRollRate = 0;
        }
      } else if (this.pos.y < rp.y - 6) this.fallen = true;
    } else this.pos.y = lipHeight(road, this.s, rp.y) + this.hover;
    if (this.airborne) return res;

    // barriers
    const limit = rp.width / 2 + 0.3 - this.width / 2;
    if (Math.abs(this.d) > limit) this.pushOut(road, Math.sign(this.d) * limit, -Math.cos(rp.heading) * Math.sign(this.d), Math.sin(rp.heading) * Math.sign(this.d), res);
    // split medians
    const sm = road.sample(this.s);
    if (sm.median > 0) {
      const half = sm.median / 2 + this.width / 2;
      const rel = this.d - sm.medianD;
      if (Math.abs(rel) < half) {
        const side = rel >= 0 ? 1 : -1;
        this.pushOut(road, sm.medianD + side * half, Math.cos(rp.heading) * side, -Math.sin(rp.heading) * side, res);
      }
    }
    if (!Number.isFinite(this.pos.x) || !Number.isFinite(this.velX)) {
      this.velX = this.velZ = 0;
      this.dead = true;
      this.deathTimer = 0;
    }
    return res;
  }

  private pushOut(road: Road, dClamp: number, nx: number, nz: number, res: { wall: number; wx: number; wz: number }) {
    road.toWorld(this.s, dClamp, tmpO);
    this.pos.x = tmpO.x;
    this.pos.z = tmpO.z;
    this.d = dClamp;
    const vOut = this.velX * nx + this.velZ * nz;
    if (vOut > 0) {
      this.velX -= nx * vOut * 1.3;
      this.velZ -= nz * vOut * 1.3;
      this.velX *= 0.9;
      this.velZ *= 0.9;
      res.wall = Math.max(res.wall, vOut);
      res.wx = tmpO.x + nx;
      res.wz = tmpO.z + nz;
      if (vOut > 6) this.yawRate += Math.sign(nx * Math.cos(this.yaw) - nz * Math.sin(this.yaw)) * vOut * 0.06;
    }
  }

  /** Wrong-way truck: holds its lane against the traffic; once it's knocked about it just slides to a stop. */
  private oncoming(dt: number, road: Road) {
    const res = { wall: 0, wx: 0, wz: 0 };
    this.spin = Math.max(0, this.spin - dt);
    this.stunT = Math.max(0, this.stunT - dt);
    this.flash = Math.max(0, this.flash - dt * 5);
    this.hitCooldown = Math.max(0, this.hitCooldown - dt);
    const rp = road.at(this.s, tmpPt);
    if (!this.dead && this.spin <= 0 && this.stunT <= 0) {
      const bx = -Math.sin(rp.heading), bz = -Math.cos(rp.heading);
      const rx = -Math.cos(rp.heading), rz = Math.sin(rp.heading);
      const lat = clamp((this.targetD - this.d) * 1.2, -4, 4);
      const sp = damp(Math.max(0, this.vF), this.topSpeed, 1.5, dt);
      this.velX = bx * sp + rx * lat;
      this.velZ = bz * sp + rz * lat;
      this.vF = sp;
      this.yaw = Math.atan2(this.velX, this.velZ);
      this.yawRate = 0;
    } else {
      this.velX *= Math.exp(-1.2 * dt);
      this.velZ *= Math.exp(-1.2 * dt);
      this.yawRate = damp(this.yawRate, 0, 1.5, dt);
      this.yaw = wrapAngle(this.yaw + this.yawRate * dt);
      this.vF = this.velX * Math.sin(this.yaw) + this.velZ * Math.cos(this.yaw);
    }
    this.pos.x += this.velX * dt;
    this.pos.z += this.velZ * dt;
    road.project(this.pos.x, this.pos.z, this.s, tmpProj);
    this.s = tmpProj.s;
    this.d = tmpProj.d;
    const rq = road.at(this.s, tmpPt);
    this.airStep(dt, rq.y);
    const limit = rq.width / 2 + 0.3 - this.width / 2;
    if (Math.abs(this.d) > limit) this.pushOut(road, Math.sign(this.d) * limit, -Math.cos(rq.heading) * Math.sign(this.d), Math.sin(rq.heading) * Math.sign(this.d), res);
    return res;
  }

  /** Cross traffic: drives straight across the road and leaves. */
  private cross(dt: number, road: Road) {
    const res = { wall: 0, wx: 0, wz: 0 };
    this.spin = Math.max(0, this.spin - dt);
    if (!this.dead && this.spin <= 0 && this.stunT <= 0) {
      const t = this.task.kind === 'cross' ? this.task.speed : 14;
      const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
      const vF = this.velX * fx + this.velZ * fz;
      const nv = damp(vF, t, 2, dt);
      this.velX = fx * nv;
      this.velZ = fz * nv;
      this.vF = nv;
    } else {
      this.velX *= Math.exp(-dt);
      this.velZ *= Math.exp(-dt);
      this.yawRate = damp(this.yawRate, 0, 1.5, dt);
      this.yaw = wrapAngle(this.yaw + this.yawRate * dt);
    }
    this.pos.x += this.velX * dt;
    this.pos.z += this.velZ * dt;
    road.project(this.pos.x, this.pos.z, this.s, tmpProj);
    this.s = tmpProj.s;
    this.d = tmpProj.d;
    this.airStep(dt, road.at(this.s, tmpPt).y);
    if (Math.abs(this.d) > road.at(this.s, tmpPt).width / 2 + 25) this.removed = true;
    return res;
  }

  /** Ballistic hop for the scripted modes (cross traffic, wrong-way truck) when a hit lifts them off the road. */
  private airStep(dt: number, groundY: number) {
    if (!this.airborne) {
      this.pos.y = groundY;
      return;
    }
    this.airVy -= 32 * dt;
    this.pos.y += this.airVy * dt;
    this.airRoll += this.airRollRate * dt;
    if (this.pos.y <= groundY) {
      this.pos.y = groundY;
      this.airborne = false;
      this.bodyRollV += clamp(this.airRoll, -0.6, 0.6) * 4;
      this.airVy = 0;
      this.airRoll = 0;
      this.airRollRate = 0;
    }
  }

  private fly(dt: number, road: Road) {
    const res = { wall: 0, wx: 0, wz: 0 };
    if (this.dead) {
      this.velX *= Math.exp(-0.5 * dt);
      this.velZ *= Math.exp(-0.5 * dt);
      this.hover = Math.max(0, this.hover - dt * 6);
    }
    this.pos.x += this.velX * dt;
    this.pos.z += this.velZ * dt;
    road.project(this.pos.x, this.pos.z, this.s, tmpProj);
    this.s = tmpProj.s;
    this.d = tmpProj.d;
    const rp = road.at(this.s, tmpPt);
    const lim = rp.width / 2 + 2;
    if (Math.abs(this.d) > lim) {
      road.toWorld(this.s, Math.sign(this.d) * lim, tmpO);
      this.pos.x = tmpO.x;
      this.pos.z = tmpO.z;
    }
    this.pos.y = rp.y + this.hover + Math.sin(performance.now() * 0.003 + this.id) * 0.2;
    return res;
  }

  flyToward(dt: number, x: number, z: number, maxSpeed: number) {
    const dx = x - this.pos.x, dz = z - this.pos.z;
    const dist = Math.hypot(dx, dz) || 1;
    const desired = Math.min(maxSpeed, dist * 2.5);
    const tvx = (dx / dist) * desired, tvz = (dz / dist) * desired;
    const k = this.stunT > 0 ? 0.2 : 3.5;
    this.velX = damp(this.velX, tvx, k, dt);
    this.velZ = damp(this.velZ, tvz, k, dt);
  }

  updateVisual(dt: number) {
    const m = this.model;
    m.group.position.copy(this.pos);
    m.group.rotation.order = 'YXZ';
    m.group.rotation.y = this.yaw;
    m.group.rotation.x = this.airborne ? -this.airPitch : 0;
    m.group.rotation.z = this.airborne ? this.airRoll : 0;
    // body: rolls into corners and with hits, dives under braking, squats under power — and springs back
    const accel = (this.vF - this.lastVF) / Math.max(dt, 1e-4);
    this.lastVF = this.vF;
    const tRoll = this.airborne ? 0 : clamp(this.yawRate * this.speed * 0.004, -0.09, 0.09);
    const tPitch = this.airborne ? 0 : clamp(-accel * 0.005, -0.07, 0.07);
    this.bodyRollV += ((tRoll - this.bodyRoll) * 80 - this.bodyRollV * 9) * dt;
    this.bodyRoll = clamp(this.bodyRoll + this.bodyRollV * dt, -0.3, 0.3);
    this.bodyPitchV += ((tPitch - this.bodyPitch) * 80 - this.bodyPitchV * 9) * dt;
    this.bodyPitch = clamp(this.bodyPitch + this.bodyPitchV * dt, -0.2, 0.2);
    if (!this.dead && !this.flying) m.body.rotation.set(this.bodyPitch, 0, this.bodyRoll);
    for (const w of m.wheels) w.rotation.x += (this.vF / Math.max(0.3, m.wheelR)) * dt;
    if (m.rotors) for (const r of m.rotors) r.rotation.y += dt * 40;
    const ex = this.exposed && this.hostile ? 0.45 + 0.35 * Math.sin(performance.now() * 0.02) : 0;
    m.bodyMat.emissive.setRGB(this.flash * 1.5 + (this.burnT > 0 ? 0.35 : 0) + ex, this.flash * 1.2 + (this.burnT > 0 ? 0.1 : 0) + ex * 0.8, this.flash * 1.2 + (this.stunT > 0 ? 0.5 : 0) + ex * 0.4);
    if (this.dead) {
      m.body.rotation.z = damp(m.body.rotation.z, 0.25, 2, dt);
      m.bodyMat.color.lerp(BURNT, dt * 2);
    }
    if (this.phased > 0) {
      m.bodyMat.transparent = true;
      m.bodyMat.opacity = 0.4;
    } else if (m.bodyMat.transparent) {
      m.bodyMat.transparent = false;
      m.bodyMat.opacity = 1;
    }
  }
}

const BURNT = new THREE.Color(0x0a0806);
const tmpPt = { x: 0, y: 0, z: 0, heading: 0, width: 0 };
const tmpProj = { s: 0, d: 0 };
const tmpO = { x: 0, y: 0, z: 0 };

/** Highest speed that keeps lateral acceleration under `grip` for the tightest curvature in [s, s+dist]. */
export function cornerSpeed(road: Road, s: number, dist: number, grip: number) {
  let kmax = 0;
  for (let x = s; x < s + dist; x += 4) {
    const a = road.at(x, tmpA), b = road.at(x + 4, tmpB);
    let dh = b.heading - a.heading;
    if (dh > Math.PI) dh -= Math.PI * 2;
    if (dh < -Math.PI) dh += Math.PI * 2;
    kmax = Math.max(kmax, Math.abs(dh) / 4);
  }
  return kmax < 1e-4 ? 999 : Math.sqrt(grip / kmax);
}
const tmpA = { x: 0, y: 0, z: 0, heading: 0, width: 0 };
const tmpB = { x: 0, y: 0, z: 0, heading: 0, width: 0 };

// ------------------------------------------------------------------ factories

const TRAFFIC_COLORS = [0x5a5f6a, 0x7a2a2a, 0x2a3f6a, 0xa0a0a8, 0x2a2a2e, 0x3a5a3a, 0x6a5a3a, 0xd0d0d8];

export function makeTraffic(kind: TrafficKind, corrupted = false): AIVehicle {
  const dims = TRAFFIC_DIMS[kind];
  const color = kind === 'taxi' ? 0xe0b020 : TRAFFIC_COLORS[Math.floor(Math.random() * TRAFFIC_COLORS.length)];
  const model = buildCar(kind as ModelKind, { color: corrupted ? 0x101010 : color, accent: corrupted ? 0xff2060 : 0x000000, role: 'traffic', variant: Math.floor(Math.random() * variantCount(kind)) });
  const v = new AIVehicle('traffic', kind, model, { hp: dims.hp, mass: dims.mass, length: dims.length, width: dims.width, topSpeed: 30, accel: 8 });
  v.grip = 9;
  v.cornerGrip = 18;
  if (!corrupted) model.accentMat.color.setHex(0x222222);
  return v;
}

export function makeEnemy(kind: EnemyKind, hpMul = 1, elite = false): AIVehicle {
  const def = ENEMIES[kind];
  const model = buildCar(kind as ModelKind, { color: elite ? 0x050505 : def.color, accent: elite ? 0xffd000 : def.accent, beams: kind === 'hunter' || kind === 'interceptor', role: 'enemy', elite });
  const v = new AIVehicle('enemy', kind, model, {
    hp: def.hp * hpMul * (elite ? 1.6 : 1),
    mass: def.mass * (elite ? 1.2 : 1),
    length: def.length,
    width: def.width,
    topSpeed: def.speed * (elite ? 1.06 : 1),
    accel: def.accel,
  });
  v.credits = def.credits * (elite ? 2.5 : 1);
  v.threat = def.threat;
  v.elite = elite;
  v.weak = def.weak;
  v.armor = def.armor * (elite ? 0.85 : 1);
  v.grip = kind === 'blocker' ? 7 : 9.5;
  v.cornerGrip = elite || kind === 'hunter' ? 29 : 25;
  if (kind === 'drone') {
    v.flying = true;
    v.hover = 1.5;
  }
  v.ai.side = Math.random() < 0.5 ? -1 : 1;
  v.ai.cd = frand(0.6, 2);
  v.setMarker(elite ? 'elite' : 'enemy');
  return v;
}

/** Friendly vehicle for PROTECT encounters. */
export function makeAlly(): AIVehicle {
  const model = buildCar('van', { color: 0x1e5a3a, accent: 0x40ff90, beams: true });
  const v = new AIVehicle('ally', 'van', model, { hp: 160, mass: 2.2, length: 5.2, width: 2.15, topSpeed: 36, accel: 10 });
  v.cornerGrip = 22;
  v.setMarker('ally');
  return v;
}

// ------------------------------------------------------------------ traffic

export function updateTraffic(v: AIVehicle, dt: number, sess: DrivingSession) {
  if (v.crossing || v.wrongWay) return;
  const road = sess.world.road;
  const w = road.at(v.s, tmpPt).width;
  const n = lanesFor(w);
  if (v.ai.state === 'idle') {
    v.ai.state = 'cruise';
    v.ai.lane = Math.min(n - 1, Math.max(0, Math.round(((v.d + w / 2) / w) * n - 0.5)));
    v.ai.t = v.task.kind === 'cruise' ? v.task.speed : frand(17, 24) * (sess.zone.id === 'oldcity' ? 0.8 : 1);
  }
  v.ai.lane = Math.min(n - 1, v.ai.lane);
  let cruise = v.ai.t;
  let blocked = false;
  for (const o of sess.vehicles) {
    if (o === v || o.dead) continue;
    const ds = o.s - v.s;
    if (ds > 0 && ds < 16 && Math.abs(o.d - v.d) < 2.4) {
      cruise = Math.min(cruise, o.vF - 1);
      blocked = true;
    }
  }
  const p = sess.player;
  if (p.s - v.s > 0 && p.s - v.s < 10 && Math.abs(p.d - v.d) < 2.2) {
    cruise = Math.min(cruise, p.vF);
    blocked = true;
  }
  v.ai.cd -= dt;
  if (blocked && v.ai.cd <= 0) {
    v.ai.cd = frand(2, 4);
    const nl = v.ai.lane + (Math.random() < 0.5 ? -1 : 1);
    if (nl >= 0 && nl < n) v.ai.lane = nl;
  }
  v.targetD = sess.world.safeD(v.s + 20, laneOffset(w, v.ai.lane));
  v.targetSpeed = Math.max(0, cruise);
}

/** Allies hold a cruise speed and lane; rivals race (see updateRacer). */
export function updateAlly(v: AIVehicle, dt: number, sess: DrivingSession) {
  void dt;
  if (v.task.kind === 'cruise') {
    v.targetSpeed = v.task.speed;
    v.targetD = sess.world.safeD(v.s + 20, v.task.d);
  }
}

/** Racing AI shared by RACE rivals and APEX: follows a racing line and brakes for corners. */
export function updateRacer(v: AIVehicle, dt: number, sess: DrivingSession, skill: number) {
  const road = sess.world.road;
  v.ai.n += dt;
  v.cornerGrip = 23 + skill * 6;
  const p = sess.player;
  const ds = p.s - v.s;
  // slight rubber band so a race stays a race, never a teleport
  let target = v.topSpeed * (0.9 + skill * 0.06);
  if (ds > 30) target += Math.min(8, (ds - 30) * 0.15);
  if (ds < -80) target -= 5;
  v.targetSpeed = target;
  const w = road.at(v.s + 30, tmpPt).width;
  // take the inside of upcoming corners
  const a = road.at(v.s + 25, tmpA), b = road.at(v.s + 45, tmpB);
  let dh = b.heading - a.heading;
  if (dh > Math.PI) dh -= Math.PI * 2;
  if (dh < -Math.PI) dh += Math.PI * 2;
  const inside = clamp(-dh * 25, -1, 1) * (w / 2 - 1.8);
  v.targetD = sess.world.safeD(v.s + 30, inside);
}

// ------------------------------------------------------------------ enemies

/**
 * Enemy decision making = task (from the encounter) + kind-specific attack pattern with a telegraph.
 * Every attack is announced on the road before it happens and leaves the attacker briefly exposed.
 */
export function updateEnemy(v: AIVehicle, dt: number, sess: DrivingSession) {
  const p = sess.player;
  const road = sess.world.road;
  const ai = v.ai;
  ai.t -= dt;
  ai.cd -= dt;
  const rel = v.s - p.s; // >0: enemy ahead of player
  const dist = Math.hypot(p.pos.x - v.pos.x, p.pos.z - v.pos.z);
  const w = road.at(v.s, tmpPt).width;
  const half = w / 2 - 1.2;
  const agg = sess.difficulty.aggression * (sess.droneMark ? 1.25 : 1);
  const pv = Math.max(12, p.vF);
  const tele = (t: number) => t / agg;

  // ---- base movement from the task
  const task = v.task;
  switch (task.kind) {
    case 'slot': {
      const aS = task.anchor === 'player' ? p.s : task.anchor.s;
      const aV = task.anchor === 'player' ? pv : Math.max(10, task.anchor.vF);
      const aD = task.anchor === 'player' ? p.d : task.anchor.d;
      v.targetSpeed = aV + clamp((aS + task.rel - v.s) * 1.3, -14, 16);
      v.targetD = clamp(task.absD ? task.d : aD + task.d, -half, half);
      break;
    }
    case 'block':
      v.targetSpeed = task.speed + clamp((task.s - v.s) * 1.2, -4, 4);
      if (task.speed <= 0) v.targetSpeed = Math.max(0, v.targetSpeed);
      v.targetD = task.d;
      break;
    case 'flee': {
      const gap = rel;
      // run, but let a committed player close in: the convoy is always catchable
      // overtaken: it floors it to get back in front (you have to actually hit it, not just pass it)
      v.targetSpeed = gap > 120 ? task.minSpeed : gap < -4 ? Math.min(task.maxSpeed * 1.35, pv + 9) : clamp(pv - 4 + (gap < 15 ? 6 : 0), task.minSpeed, task.maxSpeed);
      if (ai.cd <= 0) {
        ai.cd = frand(2.5, 4.5);
        ai.lane = Math.floor(Math.random() * lanesFor(w));
      }
      v.targetD = laneOffset(w, ai.lane);
      break;
    }
    case 'pursue': {
      v.targetSpeed = pv + clamp((p.s - task.gap - v.s) * 1.2, -10, 18);
      v.targetD = clamp(sess.pastD(task.delay), -half, half);
      break;
    }
    case 'attackTarget': {
      const t = task.target;
      if (t.dead || t.removed) {
        v.task = { kind: 'free' };
        break;
      }
      v.targetSpeed = Math.max(10, t.vF) + clamp((t.s - v.s) * 1.3, -10, 14);
      v.targetD = clamp(t.d + (Math.abs(t.s - v.s) < 6 ? 0 : ai.side * 3), -half, half);
      break;
    }
    case 'retreat':
      v.targetSpeed = Math.max(0, v.vF - 12);
      v.setMarker(null);
      return;
    case 'free':
    default:
      v.targetSpeed = pv + clamp((p.s + (ai.side > 0 ? 12 : -10) - v.s) * 1.1, -12, 15);
      v.targetD = clamp(p.d + ai.side * 3.5, -half, half);
      break;
  }

  // ---- kind attack patterns (only when engaged, never while retreating)
  const engaged = dist < 38;
  switch (v.kind as EnemyKind) {
    case 'interceptor': {
      // CUT-OFF: get slightly ahead, announce, then slice across the player's line
      if (ai.state === 'idle' && engaged && rel > 2 && rel < 16 && ai.cd <= 0) {
        ai.state = 'tele';
        ai.t = tele(0.6);
        ai.lockD = clamp(p.d + p.vL * 0.4, -half, half);
        const o = { x: 0, y: 0, z: 0 };
        road.toWorld(v.s + 6, (v.d + ai.lockD) / 2, o);
        sess.tele.arrow(o.x, o.z, road.at(v.s).heading + Math.sign(v.d - ai.lockD) * 1.1, 5, 0xff5030, ai.t + 0.6);
      } else if (ai.state === 'tele') {
        if (ai.t <= 0) {
          ai.state = 'cut';
          ai.t = 0.85;
        }
      } else if (ai.state === 'cut') {
        v.targetD = ai.lockD;
        v.targetSpeed = pv + 3;
        if (ai.t <= 0) {
          ai.state = 'idle';
          ai.cd = 2.6 / agg;
          ai.side = -ai.side;
        }
      }
      break;
    }
    case 'hunter': {
      // relentless: tails you and side-slams; hits walls and traffic when you juke it
      if (task.kind === 'free') v.task = { kind: 'pursue', gap: 4, delay: 0.25 };
      if (engaged && Math.abs(rel) < 6 && ai.cd <= 0 && ai.state === 'idle') {
        ai.state = 'slam';
        ai.t = 0.7;
        ai.lockD = p.d;
        sess.tele.lane(v.s, v.s + 10, (v.d + p.d) / 2, Math.abs(v.d - p.d) + 1.5, 0xff3040, 0.45);
      }
      if (ai.state === 'slam') {
        v.targetD = ai.lockD;
        v.targetSpeed = pv + 2;
        if (ai.t <= 0) {
          ai.state = 'idle';
          ai.cd = 1.6 / agg;
        }
      }
      break;
    }
    case 'rammer': {
      // CHARGE: lock a lane, flash it red, then drive straight down it. Exposed afterwards.
      if (ai.state === 'idle' && engaged && ai.cd <= 0 && (rel < -6 || rel > 10)) {
        ai.state = 'windup';
        ai.t = tele(1.0);
        ai.lockD = clamp(p.d, -half, half);
        const s0 = Math.min(v.s, p.s) - 4, s1 = Math.max(v.s, p.s) + 26;
        sess.tele.lane(s0, s1, ai.lockD, 2.6, 0xff2020, ai.t + 1.0);
        ai.n = rel < 0 ? 1 : -1; // 1 = charge from behind, -1 = brake-check from ahead
      } else if (ai.state === 'windup') {
        v.targetD = ai.lockD;
        v.targetSpeed = ai.n > 0 ? pv - 4 : pv + 4;
        v.flash = Math.max(v.flash, 0.5);
        if (ai.t <= 0) {
          ai.state = 'charge';
          ai.t = 1.5;
        }
      } else if (ai.state === 'charge') {
        v.targetD = ai.lockD;
        v.targetSpeed = ai.n > 0 ? pv + 17 : Math.max(5, pv - 20);
        if (ai.t <= 0) {
          ai.state = 'recover';
          ai.t = 1.4;
          v.expose(1.4);
        }
      } else if (ai.state === 'recover') {
        v.targetSpeed = pv - 6;
        if (ai.t <= 0) {
          ai.state = 'idle';
          ai.cd = 2.2 / agg;
        }
      }
      break;
    }
    case 'gunner': {
      // LANE BARRAGE: paint the player's lane, then rake it. Turret is exposed while reloading.
      if (task.kind === 'free') {
        v.targetSpeed = pv + clamp((p.s + 20 - v.s) * 1.2, -12, 14);
        v.targetD = clamp(p.d + ai.side * 4, -half, half);
      }
      if (ai.state === 'idle' && engaged && rel > 6 && ai.cd <= 0) {
        ai.state = 'aim';
        ai.t = tele(0.95);
        ai.lockD = clamp(p.d, -half, half);
        sess.tele.lane(p.s + 4, p.s + 4 + pv * 1.6, ai.lockD, 2.4, 0xff2050, ai.t + 0.5);
        sess.audio.telegraph();
      } else if (ai.state === 'aim' && ai.t <= 0) {
        ai.state = 'fire';
        ai.t = 0.5;
        sess.combat.laneBarrage(v, p.s + pv * 0.9, ai.lockD, 6, 5);
      } else if (ai.state === 'fire' && ai.t <= 0) {
        ai.state = 'reload';
        ai.t = 1.3;
        v.expose(1.3);
      } else if (ai.state === 'reload' && ai.t <= 0) {
        ai.state = 'idle';
        ai.cd = 2.4 / agg;
      }
      break;
    }
    case 'bomber': {
      // a slow rolling bomb that hugs its allies: shove it into them
      if (task.kind === 'free' || task.kind === 'slot') {
        let ally: AIVehicle | null = null, best = 40;
        for (const o of sess.vehicles) {
          if (o === v || o.dead || o.role !== 'enemy' || o.kind === 'bomber') continue;
          const dd = Math.abs(o.s - v.s);
          if (dd < best) {
            best = dd;
            ally = o;
          }
        }
        if (ally) {
          v.targetSpeed = Math.max(10, ally.vF) + clamp((ally.s - 3 - v.s) * 1.2, -8, 10);
          v.targetD = clamp(ally.d + ai.side * 2.6, -half, half);
        } else {
          v.targetSpeed = pv + clamp((p.s - v.s) * 1.0, -8, 8);
          v.targetD = clamp(p.d, -half, half);
        }
      }
      if (ai.fuse <= 0 && (dist < 5.5 || sess.time - v.lastPlayerHit < 0.2)) {
        ai.fuse = 1.1;
        sess.tele.follow(sess.tele.circle(v.pos.x, v.pos.z, 8.5, 0xff2020, 1.1), v.pos);
        sess.audio.warning();
      }
      if (ai.fuse > 0) {
        ai.fuse -= dt;
        if (ai.fuse <= 0) sess.combat.killVehicle(v, { chainId: v.chainId, byPlayer: sess.time - v.lastPlayerHit < 4, silent: true });
      }
      if (v.model.flashMat) {
        const rate = ai.fuse > 0 ? 30 : 6;
        glow(Math.sin(performance.now() * 0.001 * rate) > 0 ? 0xff2020 : 0x300000, Math.sin(performance.now() * 0.001 * rate) > 0 ? EMISSIVE.STRONG : 0.25, v.model.flashMat.color);
      }
      break;
    }
    case 'empvan': {
      // EMP FIELD: marks a dome ahead, then drops it. Shields are down while it deploys.
      if (task.kind === 'free') {
        v.targetSpeed = pv + clamp((p.s + ai.side * 8 - v.s) * 1.2, -12, 12);
        v.targetD = clamp(p.d + ai.side * 4.5, -half, half);
      }
      if (ai.state === 'idle' && engaged && ai.cd <= 0) {
        ai.state = 'charge';
        ai.t = tele(1.2);
        const o = { x: 0, y: 0, z: 0 };
        road.toWorld(p.s + pv * 1.5, clamp(p.d, -half, half), o);
        ai.lockD = o.x;
        ai.n = o.z;
        sess.tele.circle(o.x, o.z, 9, 0x4080ff, ai.t + 0.2);
        v.expose(ai.t + 2);
      } else if (ai.state === 'charge' && ai.t <= 0) {
        ai.state = 'idle';
        ai.cd = 6 / agg;
        sess.combat.empField(ai.lockD, ai.n, 9, 3);
      }
      if (v.model.flashMat) glow(ai.state === 'charge' ? 0x40c8ff : 0x2060ff, ai.state === 'charge' ? EMISSIVE.STRONG : EMISSIVE.MEDIUM, v.model.flashMat.color);
      break;
    }
    case 'blocker': {
      // closes lanes; vulnerable on its flanks
      if (task.kind === 'free' || task.kind === 'slot') {
        if (ai.cd <= 0) {
          ai.cd = 1.6 / agg;
          const n = lanesFor(w);
          let best = 0, bd = 99;
          for (let l = 0; l < n; l++) {
            const dd = Math.abs(laneOffset(w, l) - p.d);
            if (dd < bd) {
              bd = dd;
              best = l;
            }
          }
          ai.lane = best;
        }
        if (task.kind === 'free') v.targetSpeed = rel < -10 ? pv * 0.85 : pv + clamp((p.s + 26 - v.s) * 1.1, -10, 10);
        v.targetD = laneOffset(w, ai.lane);
      }
      break;
    }
    case 'drone': {
      // spotter: hovers ahead and calls electric strikes on your predicted position
      const off = 16;
      road.toWorld(p.s + off, clamp(p.d + Math.sin(sess.time * 1.3 + v.id) * 4, -half, half), tmpO);
      v.flyToward(dt, tmpO.x + p.velX * 0.15, tmpO.z + p.velZ * 0.15, Math.max(v.topSpeed, p.speed * 1.25));
      v.yaw = Math.atan2(p.pos.x - v.pos.x, p.pos.z - v.pos.z);
      if (ai.state === 'idle' && engaged && ai.cd <= 0) {
        ai.state = 'mark';
        ai.t = tele(1.3);
        const o = { x: 0, y: 0, z: 0 };
        road.toWorld(p.s + pv * 1.3, clamp(p.d + p.vL * 0.6, -half, half), o);
        ai.lockD = o.x;
        ai.n = o.z;
        sess.tele.circle(o.x, o.z, 3.4, 0xff30d0, ai.t);
      } else if (ai.state === 'mark' && ai.t <= 0) {
        ai.state = 'idle';
        ai.cd = 4.2 / agg;
        sess.combat.strike(ai.lockD, ai.n, 3.4, 14);
      }
      break;
    }
  }
}
