import * as THREE from 'three';
import type { ModelKind } from '../data/enemies';
import { buildCar, type CarModel } from '../vehicles/carModels';
import { radialTexture } from './textures';

/**
 * Street duels, staged in the pit (the garage floor): two real cars, one ram at a time.
 *
 * The fight itself is decided on the iDos server (an instant battle between two server-side cars); this only performs
 * the result. Every blow in the server's battle log becomes a charge: the defender swings to present the zone the
 * attacker aimed at (FRONT · SIDE · REAR), the attacker drives into it, and the outcome reads at the moment of contact:
 * a hit shoves the car back, a crit throws it, a block (the defender braced that zone) clangs off with blue sparks, a
 * dodge leaves the attacker skidding past. Nothing here changes the outcome.
 */

export type RamZone = 'front' | 'side' | 'rear';
export type BlowOutcome = 'hit' | 'crit' | 'blocked' | 'dodged';

export interface DuelBlow {
  /** 0 = the left car (you), 1 = the right car */
  by: 0 | 1;
  zone: RamZone;
  /** the zone the defender braced */
  brace: RamZone;
  outcome: BlowOutcome;
  damage: number;
  /** both cars' hull after the blow */
  hp: [number, number];
  round: number;
}

export interface DuelCar {
  name: string;
  model: ModelKind;
  color: number;
  accent: number;
  maxHp: number;
  label: string;
}

export interface DuelScript {
  cars: [DuelCar, DuelCar];
  blows: DuelBlow[];
  /** 0 left wins, 1 right wins, -1 draw */
  winner: 0 | 1 | -1;
}

export type DuelEvent =
  | { type: 'start' }
  | { type: 'blow'; index: number; blow: DuelBlow }
  | { type: 'end'; winner: 0 | 1 | -1 };

const MARK_X = 4.3;
const MARK_Z = 0.6;
/** seconds per blow; a crit gets a beat of slow motion on top */
const BLOW_T = 1.75;
const CHARGE_AT = 0.5;
const IMPACT_AT = 0.86;
const SETTLE_AT = 1.25;

interface Actor {
  car: CarModel;
  x: number;
  z: number;
  yaw: number;
  /** knock-back velocity and spin after a hit */
  vx: number;
  vz: number;
  spin: number;
  shake: number;
  flash: number;
  smokeT: number;
  hp: number;
  maxHp: number;
  dead: boolean;
}

/** Small particle pools that live in the garage scene from the start (compiled with it; empty until a duel). */
class Pool {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private col: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private max: Float32Array;
  private base: Float32Array;
  private n = 0;

  constructor(private cap: number, size: number, additive: boolean, private grav: number, private drag: number) {
    this.pos = new Float32Array(cap * 3);
    this.col = new Float32Array(cap * 4);
    this.vel = new Float32Array(cap * 3);
    this.life = new Float32Array(cap);
    this.max = new Float32Array(cap);
    this.base = new Float32Array(cap * 4);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    const mat = new THREE.PointsMaterial({
      size,
      map: radialTexture(additive ? 'duel_spark' : 'duel_smoke', 'rgba(255,255,255,1)', additive ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.55)'),
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      sizeAttenuation: true,
    });
    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 6 : 5;
  }

  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, r: number, g: number, b: number, a: number) {
    if (this.n >= this.cap) return;
    const i = this.n++;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.life[i] = life;
    this.max[i] = life;
    this.base.set([r, g, b, a], i * 4);
  }

  update(dt: number) {
    let w = 0;
    for (let i = 0; i < this.n; i++) {
      const l = this.life[i] - dt;
      if (l <= 0) continue;
      const k = Math.max(0, 1 - this.drag * dt);
      const vx = this.vel[i * 3] * k, vy = this.vel[i * 3 + 1] * k - this.grav * dt, vz = this.vel[i * 3 + 2] * k;
      let y = this.pos[i * 3 + 1] + vy * dt;
      let bvy = vy;
      if (y < 0.03 && this.grav > 0) {
        y = 0.03;
        bvy = -vy * 0.35;
      }
      this.pos[w * 3] = this.pos[i * 3] + vx * dt;
      this.pos[w * 3 + 1] = y;
      this.pos[w * 3 + 2] = this.pos[i * 3 + 2] + vz * dt;
      this.vel[w * 3] = vx;
      this.vel[w * 3 + 1] = bvy;
      this.vel[w * 3 + 2] = vz;
      this.life[w] = l;
      this.max[w] = this.max[i];
      const f = l / this.max[i];
      for (let c = 0; c < 3; c++) this.base[w * 4 + c] = this.base[i * 4 + c];
      this.base[w * 4 + 3] = this.base[i * 4 + 3];
      this.col[w * 4] = this.base[w * 4];
      this.col[w * 4 + 1] = this.base[w * 4 + 1];
      this.col[w * 4 + 2] = this.base[w * 4 + 2];
      this.col[w * 4 + 3] = this.base[w * 4 + 3] * (this.grav > 0 ? f : Math.sin(f * Math.PI));
      w++;
    }
    this.n = w;
    const g = this.points.geometry;
    g.setDrawRange(0, w);
    (g.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (g.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }

  clear() {
    this.n = 0;
    this.points.geometry.setDrawRange(0, 0);
  }
}

const ease = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const easeIn = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * t);
const lerpAngle = (a: number, b: number, t: number) => {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
};

export interface DuelSounds {
  impact(strength: number, pan?: number): void;
  heavyImpact(): void;
  metal(s?: number): void;
  scrape(): void;
  explosion(size?: number, pan?: number): void;
  nitroStart(): void;
}

export class DuelStage {
  readonly root = new THREE.Group();
  readonly sparks = new Pool(700, 0.13, true, 9, 1.2);
  readonly glow = new Pool(40, 2.4, true, 0, 3);
  readonly smoke = new Pool(260, 1.7, false, -0.6, 0.8);
  private actors: Actor[] = [];
  private script: DuelScript | null = null;
  private t = 0;
  private blow = -1;
  private ended = false;
  private endT = 0;
  private slow = 1;
  private shakeCam = 0;
  private punch = 0;
  private impactAt = new THREE.Vector3();
  private onEvent: (e: DuelEvent) => void = () => {};
  private sounds: DuelSounds | null = null;
  active = false;

  constructor(scene: THREE.Scene) {
    scene.add(this.root, this.sparks.points, this.glow.points, this.smoke.points);
  }

  play(script: DuelScript, onEvent: (e: DuelEvent) => void, sounds: DuelSounds | null) {
    this.stop();
    this.script = script;
    this.onEvent = onEvent;
    this.sounds = sounds;
    this.actors = script.cars.map((c, i) => {
      const car = buildCar(c.model, { color: c.color, accent: c.accent, underglow: true, beams: false, role: 'player' });
      this.root.add(car.group);
      const side = i === 0 ? -1 : 1;
      return { car, x: side * MARK_X, z: MARK_Z, yaw: side < 0 ? Math.PI / 2 : -Math.PI / 2, vx: 0, vz: 0, spin: 0, shake: 0, flash: 0, smokeT: 0, hp: c.maxHp, maxHp: c.maxHp, dead: false };
    });
    this.t = -1.2;
    this.blow = -1;
    this.ended = false;
    this.endT = 0;
    this.active = true;
    this.place();
    onEvent({ type: 'start' });
  }

  /** jump to the result */
  skip() {
    const s = this.script;
    if (!s || this.ended) return;
    for (let i = this.blow + 1; i < s.blows.length; i++) {
      const b = s.blows[i];
      this.actors[0].hp = b.hp[0];
      this.actors[1].hp = b.hp[1];
      this.onEvent({ type: 'blow', index: i, blow: b });
    }
    this.blow = s.blows.length;
    this.finish();
  }

  stop() {
    for (const a of this.actors) {
      this.root.remove(a.car.group);
      a.car.dispose();
    }
    this.actors = [];
    this.script = null;
    this.active = false;
    this.sparks.clear();
    this.glow.clear();
    this.smoke.clear();
  }

  /** advance the performance; the camera is posed here while a duel is on */
  update(rawDt: number, camera: THREE.PerspectiveCamera) {
    this.sparks.update(rawDt);
    this.glow.update(rawDt);
    this.smoke.update(rawDt);
    if (!this.active || !this.script) return;
    const s = this.script;
    // slow motion eases back to real time after a crit
    this.slow += (1 - this.slow) * Math.min(1, rawDt * 2.2);
    const dt = rawDt * this.slow;
    // a long fight speeds up after the opening exchanges, so twenty blows never drag
    this.t += dt * (this.t > BLOW_T * 6 ? 1.45 : 1);
    const bi = Math.floor(Math.max(0, this.t) / BLOW_T);
    if (!this.ended && this.t >= 0 && bi >= s.blows.length) this.finish();
    if (!this.ended && this.t >= 0) this.stepBlow(bi, (this.t - bi * BLOW_T), dt);
    if (this.ended) this.endT += dt;
    for (const a of this.actors) this.physics(a, dt);
    this.place();
    this.poseCamera(camera, rawDt);
  }

  private stepBlow(i: number, u: number, dt: number) {
    const s = this.script!;
    const b = s.blows[i];
    const att = this.actors[b.by], def = this.actors[1 - b.by];
    const side = b.by === 0 ? -1 : 1;
    // the defender's mark and the angle it shows the attacker
    const faceAtt = side < 0 ? -Math.PI / 2 : Math.PI / 2;
    const present = b.zone === 'front' ? faceAtt : b.zone === 'side' ? faceAtt + Math.PI / 2 * (i % 2 ? 1 : -1) : faceAtt + Math.PI;
    const homeAtt = side * MARK_X, homeDef = -side * MARK_X;
    const attYaw = side < 0 ? Math.PI / 2 : -Math.PI / 2;
    if (u < CHARGE_AT) {
      // wind-up: the attacker backs off a little, the defender swings round
      const k = ease(u / CHARGE_AT);
      att.x += (homeAtt + side * 0.9 * Math.sin(k * Math.PI) - att.x) * Math.min(1, dt * 10);
      att.z += (MARK_Z - att.z) * Math.min(1, dt * 6);
      att.yaw = lerpAngle(att.yaw, attYaw, Math.min(1, dt * 8));
      def.yaw = lerpAngle(def.yaw, present, Math.min(1, dt * 7));
      def.x += (homeDef - def.x) * Math.min(1, dt * 4);
      def.z += (MARK_Z - def.z) * Math.min(1, dt * 4);
      if (this.blow < i - 1 + 1 && u > CHARGE_AT * 0.7 && !att.car.group.userData.revved) {
        att.car.group.userData.revved = true;
        this.sounds?.nitroStart();
      }
    } else if (u < IMPACT_AT) {
      // the charge: accelerate into the defender
      const k = easeIn((u - CHARGE_AT) / (IMPACT_AT - CHARGE_AT));
      const reach = def.x - side * (b.outcome === 'dodged' ? -1.5 : this.contactGap(att, def, b.zone));
      att.x = homeAtt + (reach - homeAtt) * k;
      att.yaw = lerpAngle(att.yaw, attYaw, Math.min(1, dt * 8));
      if (b.outcome === 'dodged') def.z += (MARK_Z + (i % 2 ? 2.4 : -2.4) - def.z) * Math.min(1, dt * 9);
      // exhaust flame-glow behind the charging car
      if (Math.random() < 0.7) this.glow.emit(att.x - Math.sin(att.yaw) * 2.1, 0.45, att.z - Math.cos(att.yaw) * 2.1, 0, 0.2, 0, 0.18, 0.3, 0.6, 1.4, 0.7);
    }
    if (this.blow < i && u >= IMPACT_AT) {
      this.blow = i;
      att.car.group.userData.revved = false;
      this.impact(att, def, b, side);
      this.onEvent({ type: 'blow', index: i, blow: b });
    } else if (u >= SETTLE_AT) {
      // both roll back to their marks
      const k = Math.min(1, dt * 3.2);
      att.x += (homeAtt - att.x) * k;
      att.z += (MARK_Z - att.z) * k;
      att.yaw = lerpAngle(att.yaw, attYaw, k);
      if (!def.dead) {
        def.x += (homeDef - def.x) * k * 0.8;
        def.z += (MARK_Z - def.z) * k * 0.8;
        def.yaw = lerpAngle(def.yaw, side < 0 ? -Math.PI / 2 : Math.PI / 2, k * 0.8);
      }
    }
  }

  /** how far from the defender's centre the attacker's nose stops for each zone */
  private contactGap(att: Actor, def: Actor, zone: RamZone) {
    const dl = def.car.length / 2, dw = def.car.width / 2, al = att.car.length / 2;
    return al + (zone === 'side' ? dw : dl) - 0.25;
  }

  private impact(att: Actor, def: Actor, b: DuelBlow, side: number) {
    const dirX = -side;
    const s = this.sounds;
    const hx = def.x + side * (b.outcome === 'dodged' ? 0 : this.contactGap(att, def, b.zone) - att.car.length / 2);
    const hz = att.z;
    this.impactAt.set(hx, 0.6, hz);
    def.hp = b.hp[b.by === 0 ? 1 : 0];
    att.hp = b.hp[b.by];
    const frac = Math.min(1, b.damage / Math.max(1, def.maxHp));
    if (b.outcome === 'dodged') {
      // a miss: the attacker skids past the line
      att.vx = dirX * 9;
      att.spin = (Math.random() < 0.5 ? -1 : 1) * 2.2;
      for (let k = 0; k < 18; k++) this.smoke.emit(att.x - dirX * 1.2, 0.25, att.z + (Math.random() - 0.5) * 1.6, -dirX * Math.random(), 0.5 + Math.random(), (Math.random() - 0.5), 1.2, 0.75, 0.76, 0.8, 0.35);
      s?.scrape();
      return;
    }
    const blocked = b.outcome === 'blocked';
    const crit = b.outcome === 'crit';
    const push = blocked ? 2.2 : crit ? 9 + frac * 10 : 4.5 + frac * 9;
    def.vx = dirX * push;
    def.vz = (Math.random() - 0.5) * (crit ? 3 : 1.2);
    def.spin = b.zone === 'side' ? (Math.random() < 0.5 ? -1 : 1) * (crit ? 4.5 : 2.2) : (Math.random() - 0.5) * (crit ? 3 : 1);
    def.shake = blocked ? 0.25 : crit ? 1 : 0.6;
    def.flash = blocked ? 0.35 : 1;
    att.vx = -dirX * (blocked ? 4 : 1.6);
    att.shake = 0.4;
    // sparks: amber on a hit, white-hot and lots of them on a crit, blue off the bracing plate on a block
    const n = blocked ? 60 : crit ? 150 : 80;
    const [r, g, bl] = blocked ? [0.45, 0.8, 1.6] : crit ? [1.6, 1.3, 0.9] : [1.5, 0.75, 0.25];
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2, sp = (crit ? 7 : 5) * (0.4 + Math.random());
      this.sparks.emit(hx, 0.55 + Math.random() * 0.4, hz + (Math.random() - 0.5) * 0.8, dirX * sp * 0.6 + Math.cos(a) * sp * 0.6, 1.5 + Math.random() * 4.5, Math.sin(a) * sp * 0.7, 0.35 + Math.random() * 0.55, r, g, bl, 1);
    }
    this.glow.emit(hx, 0.7, hz, 0, 0, 0, crit ? 0.32 : 0.2, r * 0.9, g * 0.9, bl * 0.9, crit ? 1.4 : 0.9);
    for (let k = 0; k < (crit ? 14 : 6); k++) this.smoke.emit(hx, 0.4, hz, (Math.random() - 0.5) * 2, 0.6 + Math.random() * 1.2, (Math.random() - 0.5) * 2, 1.1 + Math.random(), 0.42, 0.42, 0.45, 0.45);
    this.shakeCam = blocked ? 0.25 : crit ? 1 : 0.55;
    this.punch = crit ? 1 : 0.5;
    if (crit) this.slow = 0.25;
    if (blocked) s?.metal(0.8);
    else if (crit) s?.heavyImpact();
    else s?.impact(0.5 + frac * 2, 0);
    if (def.hp <= 0 && !def.dead) {
      def.dead = true;
      def.vx *= 1.4;
      def.spin += 3;
      s?.explosion(0.9, 0);
      for (let k = 0; k < 40; k++) this.sparks.emit(def.x, 0.8, def.z, (Math.random() - 0.5) * 10, 3 + Math.random() * 6, (Math.random() - 0.5) * 10, 0.6 + Math.random() * 0.6, 1.6, 0.8, 0.3, 1);
      this.glow.emit(def.x, 1, def.z, 0, 0.5, 0, 0.45, 1.6, 0.7, 0.25, 1.6);
    }
  }

  private physics(a: Actor, dt: number) {
    a.x += a.vx * dt;
    a.z += a.vz * dt;
    a.yaw += a.spin * dt;
    const k = Math.max(0, 1 - 3.2 * dt);
    a.vx *= k;
    a.vz *= k;
    a.spin *= Math.max(0, 1 - 2.6 * dt);
    a.shake = Math.max(0, a.shake - dt * 2.5);
    a.flash = Math.max(0, a.flash - dt * 4);
    // a battered car smokes from under the bonnet; a wrecked one pours it
    const dmg = 1 - a.hp / a.maxHp;
    a.smokeT -= dt;
    if ((dmg > 0.5 || a.dead) && a.smokeT <= 0) {
      a.smokeT = a.dead ? 0.04 : 0.16 - dmg * 0.08;
      const fx = Math.sin(a.yaw) * a.car.length * 0.32, fz = Math.cos(a.yaw) * a.car.length * 0.32;
      const v = a.dead ? 0.12 : 0.3;
      this.smoke.emit(a.x + fx, 0.9, a.z + fz, (Math.random() - 0.5) * 0.4, 1.2 + Math.random() * 0.8, (Math.random() - 0.5) * 0.4, 1.8, v, v, v * 1.05, a.dead ? 0.7 : 0.4);
      if (a.dead && Math.random() < 0.5) this.glow.emit(a.x + fx, 0.8, a.z + fz, 0, 0.6, 0, 0.25, 1.5, 0.55, 0.15, 0.6);
    }
    // keep both cars on the floor and inside the pit
    a.x = Math.max(-7.2, Math.min(7.2, a.x));
    a.z = Math.max(-3.5, Math.min(3.5, a.z));
  }

  private place() {
    for (const a of this.actors) {
      const g = a.car.group;
      const j = a.shake * 0.08;
      g.position.set(a.x + (Math.random() - 0.5) * j, 0.02 + Math.abs(Math.random() - 0.5) * j * 0.5, a.z + (Math.random() - 0.5) * j);
      g.rotation.set(a.dead ? 0.06 : 0, a.yaw, a.dead ? 0.1 : (Math.random() - 0.5) * a.shake * 0.05);
      a.car.bodyMat.emissive.setRGB(a.flash * 0.9, a.flash * 0.45, a.flash * 0.2);
      for (const w of a.car.wheels) w.rotation.x += (Math.abs(a.vx) + Math.abs(a.vz)) * 0.02;
    }
  }

  private camPos = new THREE.Vector3(0, 3.4, 10.5);
  private camLook = new THREE.Vector3(0, 0.6, 0.6);
  private poseCamera(camera: THREE.PerspectiveCamera, dt: number) {
    const time = performance.now() / 1000;
    this.punch = Math.max(0, this.punch - dt * 1.6);
    this.shakeCam = Math.max(0, this.shakeCam - dt * 2.2);
    const end = this.ended ? Math.min(1, this.endT / 1.5) : 0;
    // far enough back that both marks (and a shoved car) stay in frame on any screen shape
    const halfW = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect;
    const dist = Math.max(10.2, 7.4 / halfW);
    // a wide side-on shot that leans toward each impact, then circles the winner at the end
    const target = new THREE.Vector3(Math.sin(time * 0.25) * 1.6, 2.6 + dist * 0.06 - this.punch * 0.8, MARK_Z + dist - this.punch * Math.min(3.2, dist * 0.3));
    const look = new THREE.Vector3(this.impactAt.x * 0.35 * (1 - end), 0.7, MARK_Z);
    const w = this.script?.winner ?? -1;
    if (end > 0 && w >= 0) {
      const a = this.actors[w];
      const ang = time * 0.35;
      const r = Math.max(6.5, 3.4 / halfW);
      target.lerp(new THREE.Vector3(a.x + Math.cos(ang) * r, 2.4, a.z + Math.sin(ang) * r), end);
      look.lerp(new THREE.Vector3(a.x, 0.7, a.z), end);
    }
    this.camPos.lerp(target, Math.min(1, dt * 3));
    this.camLook.lerp(look, Math.min(1, dt * 4));
    const sh = this.shakeCam * 0.18;
    camera.position.set(this.camPos.x + (Math.random() - 0.5) * sh, this.camPos.y + (Math.random() - 0.5) * sh, this.camPos.z);
    camera.lookAt(this.camLook);
  }

  private finish() {
    if (this.ended) return;
    this.ended = true;
    this.endT = 0;
    const w = this.script!.winner;
    // the winner spins a victory donut on its mark
    if (w >= 0) this.actors[w].spin = 3.5;
    this.onEvent({ type: 'end', winner: w });
  }

  get finished() {
    return this.ended && this.endT > 1.2;
  }
}
