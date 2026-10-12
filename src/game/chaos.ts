import { clamp } from '../core/math';
import { frand } from '../core/random';
import type { AIVehicle } from '../enemies/ai';
import { makeTraffic } from '../enemies/ai';
import type { Prop } from '../world/world';
import { laneOffset, lanesFor } from '../world/world';
import { EMISSIVE, glow } from '../render/visualBudget';

import type { DrivingSession } from './driving';

/**
 * Chaos events — the road itself attacks. Short, readable, telegraphed moments that force a decision at speed
 * and that also hit the enemies chasing you:
 *   DEBRIS    slabs fall from above onto a lane (shadow circles mark where) — change lanes
 *   ONCOMING  a wrong-way truck barrels down a lane (the lane flashes red, it sounds its horn) — get out of its way
 *   PILEUP    a crash blocks all lanes but one (the open lane is lit) — find the gap
 * Cadence: calm → event → recovery → calm, between encounters only; the final stretch runs hotter and always
 * gets one big event before the gate.
 */
type ChaosKind = 'DEBRIS' | 'ONCOMING' | 'PILEUP';

interface Falling {
  props: Prop[];
  x: number;
  z: number;
  s: number;
  d: number;
  t: number;
  dur: number;
  landed: boolean;
}

const ZONE_WEIGHTS: Record<string, [ChaosKind, number][]> = {
  industrial: [['DEBRIS', 3], ['PILEUP', 1.5], ['ONCOMING', 1]],
  flood: [['PILEUP', 2], ['DEBRIS', 1.5], ['ONCOMING', 1.5]],
  oldcity: [['PILEUP', 2.5], ['ONCOMING', 1.5], ['DEBRIS', 1]],
  skyway: [['ONCOMING', 2.5], ['DEBRIS', 2], ['PILEUP', 1]],
  zeromile: [['DEBRIS', 2], ['ONCOMING', 2], ['PILEUP', 2]],
};

const DROP_H = 15;

/** Encounters that are chases: chaos layers onto them (set-piece fights bring their own obstacles). */
const CHASE_FIGHTS = new Set<string>(['PURSUIT', 'ESCAPE', 'CONVOY', 'DESTROY_TARGET']);

export class ChaosDirector {
  private phase: 'calm' | 'event' | 'recovery' = 'calm';
  private timer = 10;
  private kind: ChaosKind | null = null;
  private endS = 0;
  private falling: Falling[] = [];
  private wrecks: AIVehicle[] = [];
  private burning: AIVehicle | null = null;
  private truck: AIVehicle | null = null;
  private t = 0;
  private finaleDone = false;
  private last: ChaosKind | null = null;
  /** debug: skip the free-road check once */
  private forced = false;
  /** events fired this road (debug / QA) */
  count = 0;

  constructor(private sess: DrivingSession) {}

  reset() {
    this.phase = 'calm';
    this.timer = 12;
    this.kind = null;
    this.falling = [];
    this.wrecks = [];
    this.truck = null;
    this.burning = null;
    this.finaleDone = false;
    this.last = null;
    this.count = 0;
  }

  /**
   * Is the road ahead free for a chaos moment? Not on a jump, not at the gate, not in set-piece fights that bring
   * their own obstacles — but chases carry it well: debris and a wrong-way truck hit the cars chasing you too.
   */
  private roadFree(from: number, to: number, kind: ChaosKind) {
    const s = this.sess;
    if (this.forced) return true;
    const cur = s.director.current;
    if (cur && !(CHASE_FIGHTS.has(cur.def.id) && kind !== 'PILEUP')) return false;
    for (const e of s.director.encounters) {
      if (e === cur || e.state === 'resolved' || e.startS <= 0) continue;
      if (e.startS - 60 < to && e.endS > from) return false;
    }
    if (s.world.road.gapNear(from, to - from + 40, 60)) return false;
    const fin = s.director.finishS;
    if (fin > 0 && to > fin - 40) return false;
    return to < s.world.road.endS - 10;
  }

  update(dt: number) {
    const s = this.sess;
    this.t += dt;
    this.updateFalling(dt);
    this.updateWrecks();
    const tr = this.truck;
    if (tr && !tr.removed) {
      // flashing its full beams and hazards (glare on its own headlamps, not sprites stuck on the cab)
      const on = Math.sin(this.t * 9) > 0;
      tr.model.lights.highBeam = on ? 1 : 0;
      tr.model.lights.hazard = true;
      glow(0xffa010, on ? EMISSIVE.STRONG : 0.2, tr.model.tailMat.color);
    }
    if (s.attract || s.config.mode === 'BOSS' || s.finished || s.dying > 0) return;
    const p = s.player;
    if (this.phase === 'event') {
      const truckGone = !this.truck || this.truck.removed || this.truck.dead || this.truck.s < p.s - 25;
      if (p.s > this.endS && (this.kind !== 'ONCOMING' || truckGone)) {
        this.phase = 'recovery';
        this.timer = frand(5, 8);
        this.truck = null;
      }
      return;
    }
    this.timer -= dt;
    // the last stretch always gets one big moment ahead of the gate
    const fin = s.director.finishS;
    if (s.finalPush && !this.finaleDone && fin > 0 && fin - p.s < 400 && fin - p.s > 150 && p.speed > 12) {
      if (this.fire(Math.random() < 0.5 ? 'DEBRIS' : 'ONCOMING', true)) {
        this.finaleDone = true;
        return;
      }
    }
    if (this.timer > 0) return;
    if (this.phase === 'recovery') {
      this.phase = 'calm';
      this.timer = s.finalPush ? frand(3, 5) : frand(9, 15);
      return;
    }
    if (p.speed < 15 || p.s < 300) return;
    if (s.config.tutorial && s.encountersDone < 2) return;
    const w = ZONE_WEIGHTS[s.zone.id] ?? ZONE_WEIGHTS.zeromile;
    const pool = w.filter(([k]) => k !== this.last);
    if (!this.fire(s.rng.weighted(pool), false)) this.timer = 2;
  }

  /** Start an event. Returns false when the road ahead isn't free for it. */
  private fire(kind: ChaosKind, big: boolean): boolean {
    const s = this.sess;
    const p = s.player;
    const road = s.world.road;
    const pv = Math.max(20, p.vF);
    if (kind === 'DEBRIS') {
      // far enough to read and react: it lands about a second before you get there, so you see it hit
      const at = p.s + Math.max(110, pv * 3.2);
      if (!this.roadFree(p.s, at + 30, kind)) return false;
      const eta = (at - p.s) / pv;
      const dur = clamp(eta - 1.1, 1.3, 2.4);
      const w = road.at(at).width;
      const n = lanesFor(w);
      // your lane first, then (bigger moments) a neighbour — never every lane
      const mine = clamp(Math.round(((p.d + w / 2) / w) * n - 0.5), 0, n - 1);
      const lanes = [mine];
      if ((big || s.zone.index >= 2) && n >= 3) lanes.push(mine + (mine === 0 ? 1 : mine === n - 1 ? -1 : Math.random() < 0.5 ? 1 : -1));
      for (const [k, l] of lanes.entries()) {
        const d = laneOffset(w, l);
        // the whole lane lights up from just ahead of you to the drop: read it at a glance, not by finding a shadow
        s.tele.lane(p.s + 22, at + k * 9 + 8, d, 3, 0xff6a10, eta + 0.6, 0.42);
        this.drop(at + k * 9, d, dur + k * 0.25);
      }
      s.notify(big ? 'IT’S COMING DOWN — CHANGE LANES' : 'DEBRIS — CHANGE LANES', '#ff8a1a', true);
      s.audio.debris();
      this.endS = at + 25;
    } else if (kind === 'ONCOMING') {
      const at = p.s + 230;
      if (!this.roadFree(p.s, at, kind)) return false;
      const w = road.at(at).width;
      const n = lanesFor(w);
      const lane = clamp(Math.round(((p.d + w / 2) / w) * n - 0.5), 0, n - 1);
      const d = laneOffset(w, lane);
      const v = makeTraffic('truck');
      v.wrongWay = true;
      v.place(road, at, d, 21, Math.PI);
      v.targetD = d;
      v.topSpeed = big ? 25 : 21;
      s.addVehicle(v);
      this.truck = v;
      // full beams coming straight at you (flashed in update)
      v.model.lights.highBeam = 1;
      s.tele.lane(p.s + 30, at, d, 2.8, 0xff2030, 3.6);
      s.notify(big ? 'WRONG WAY — IT’S HEADING STRAIGHT FOR YOU' : 'WRONG-WAY TRUCK — GET OUT OF ITS LANE', '#ff3040', true);
      s.audio.horn(s.relPan(v.pos.x, v.pos.z));
      this.endS = p.s + 60;
    } else {
      const at = p.s + Math.max(150, pv * 3.2);
      if (!this.roadFree(p.s, at + 30, kind)) return false;
      const w = road.at(at).width;
      const n = lanesFor(w);
      const open = Math.floor(Math.random() * n);
      const kinds = ['sedan', 'hatch', 'van', 'taxi', 'truck'] as const;
      for (let l = 0; l < n; l++) {
        if (l === open) continue;
        const v = s.spawnTrafficAt(at + frand(-4, 4), laneOffset(w, l), 0, kinds[Math.floor(Math.random() * kinds.length)]);
        if (!v) continue;
        v.task = { kind: 'cruise', speed: 0, d: v.d };
        v.spin = 600;
        v.velX = v.velZ = 0;
        v.yaw += (Math.random() < 0.5 ? -1 : 1) * frand(0.4, 1.2);
        v.model.group.rotation.y = v.yaw;
        v.model.bodyMat.color.multiplyScalar(0.55);
        this.wrecks.push(v);
      }
      const fw = this.wrecks[this.wrecks.length - 1];
      if (fw) {
        s.combat.addHazard('fire', fw.pos.x, fw.pos.z, 2.4, 30, 12, false);
        // that one is on its roof
        fw.model.body.rotation.z = Math.PI;
        fw.model.body.position.y = fw.model.height * 0.92;
        this.burning = fw;
      }
      for (const v of this.wrecks) {
        s.fx.sparks(v.pos.x, 0.8, v.pos.z, 18, 0xffc070, 8);
        s.fx.debrisBurst(v.pos.x, 1, v.pos.z, 10, v.model.bodyMat.color.getHex(), 7);
        s.fx.debrisBurst(v.pos.x, 1.2, v.pos.z, 6, 0xc8e0ff, 6);
      }
      s.tele.lane(at - 70, at + 12, laneOffset(w, open), 2.6, 0x30ffa0, 4, 0.45);
      s.notify('PILE-UP AHEAD — FIND THE GAP', '#ffb020', true);
      s.audio.warning();
      this.endS = at + 30;
    }
    this.kind = kind;
    this.last = kind;
    this.phase = 'event';
    this.count++;
    return true;
  }

  /** Slabs fall from above: the shadow (a circle) grows on the road, then they land and stay as obstacles. */
  private drop(at: number, d: number, dur: number) {
    const s = this.sess;
    const props: Prop[] = [];
    for (const off of [0, 2.6]) {
      const pr = s.world.spawnProp('block', at + off, d);
      if (!pr) continue;
      pr.alive = false;
      // a container-sized slab (two props long, so it blocks the whole lane)
      pr.mesh.scale.set(2.6, 2.2, 2.7);
      pr.r = 1.5;
      pr.mesh.position.y = pr.y + DROP_H;
      pr.mesh.rotation.x = frand(-0.4, 0.4);
      props.push(pr);
    }
    if (!props.length) return;
    const o = { x: 0, y: 0, z: 0 };
    s.world.road.toWorld(at + 1.3, d, o);
    // where it lands: the shadow grows under it, a DEBRIS marker hangs over it from the first second
    s.tele.circle(o.x, o.z, 3.4, 0xff8a1a, dur, 0.85);
    s.markHazard('debris', o.x, o.z, at + 1.3, null, dur + 6);
    // it breaks loose up there: a shower of sparks and a puff of dust
    s.fx.sparks(o.x, o.y + DROP_H + 1.5, o.z, 36, 0xffd090, 9);
    s.fx.smokePuff(o.x, o.y + DROP_H + 1, o.z, 4, false, 1.4);
    this.falling.push({ props, x: o.x, z: o.z, s: at + 1.3, d, t: 0, dur, landed: false });
  }

  private updateFalling(dt: number) {
    const s = this.sess;
    for (let i = this.falling.length - 1; i >= 0; i--) {
      const f = this.falling[i];
      f.t += dt;
      const k = clamp(f.t / f.dur, 0, 1);
      for (const [j, pr] of f.props.entries()) {
        // accelerating fall, a slow tumble
        pr.mesh.position.y = pr.y + DROP_H * (1 - k * k) + j * 0.02;
        pr.mesh.rotation.x *= 1 - dt * 2;
      }
      if (k < 1 || f.landed) continue;
      f.landed = true;
      this.falling.splice(i, 1);
      for (const pr of f.props) {
        pr.alive = true;
        pr.mesh.position.y = pr.y;
        pr.mesh.rotation.x = 0;
      }
      const p = s.player;
      const dist = Math.hypot(p.pos.x - f.x, p.pos.z - f.z);
      s.fx.debrisBurst(f.x, 0.8, f.z, 26, 0x8a8a90, 11);
      s.fx.sparks(f.x, 0.4, f.z, 40, 0xffc070, 12);
      s.fx.smokePuff(f.x, 1, f.z, 12, false, 2);
      s.fx.shock(f.x, 0, f.z, 8, 0xd8c8b0);
      s.fx.explosion(f.x, 0.8, f.z, 2.6, 0xffd090);
      s.audio.slam(s.relPan(f.x, f.z));
      s.cam.addTrauma(clamp(0.45 - dist / 90, 0.04, 0.45));
      // anything under it gets crushed — including whoever was chasing you
      for (const v of s.vehicles) {
        if (v.dead || v.removed || v.flying) continue;
        if (Math.hypot(v.pos.x - f.x, v.pos.z - f.z) < 3.4) s.combat.damageVehicle(v, v.isBoss ? 30 : 999, 'explosion', { byPlayer: v.hostile });
      }
      if (dist < 2.6) {
        s.combat.damagePlayer(9, 'debris', f.x, f.z);
        s.combo *= 0.5;
        s.popup('CLIPPED BY DEBRIS', '#ff8060');
      } else if (dist < 9 && p.speed > 20) s.popup('CLOSE ONE', '#ffd23a');
    }
  }

  /** Pile-up wrecks smoke and burn while they sit there. */
  private updateWrecks() {
    const s = this.sess;
    this.wrecks = this.wrecks.filter((v) => !v.removed);
    const on = Math.sin(this.t * 7) > 0;
    for (const v of this.wrecks) {
      v.spin = Math.max(v.spin, 1);
      if (Math.random() < 0.25 * s.fx.density) s.fx.smokePuff(v.pos.x, v.pos.y + 1.4, v.pos.z, 1, true, 1.1);
      glow(0xffa010, on ? EMISSIVE.MEDIUM : 0.15, v.model.tailMat.color);
    }
    const b = this.burning;
    if (b && !b.removed && Math.random() < 0.7 * s.fx.density) s.fx.fire(b.pos.x, b.pos.y + 0.6, b.pos.z, 1, 1.3);
  }

  /** Debug: fire an event right now (F1 → CHAOS). */
  debugFire(kind: ChaosKind) {
    this.phase = 'calm';
    this.forced = true;
    this.fire(kind, true);
    this.forced = false;
  }

  /** For the debug overlay. */
  get state() {
    return `${this.phase}${this.kind && this.phase === 'event' ? ' ' + this.kind : ''} t${this.timer.toFixed(1)} n${this.count}`;
  }
}

export type { ChaosKind };
