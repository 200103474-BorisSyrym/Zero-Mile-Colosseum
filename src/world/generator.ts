import { CONFIG } from '../core/config';
import { clamp, lerp, smoothstep } from '../core/math';
import type { Random } from '../core/random';
import type { SegmentType, ZoneDef } from '../data/zones';
import type { Road } from './road';

export interface SegmentInfo {
  index: number;
  type: SegmentType;
  startS: number;
  endS: number;
  width: number;
  tunnel: boolean;
  bridge: boolean;
  lipS: number;
  gapSide: number;
  gapStart: number;
  gapEnd: number;
  crossS: number;
  tag: PieceTag | null;
  split: { s0: number; s1: number; medianD: number; medianW: number } | null;
  marks: { L: number; R: number };
  /** GAP_JUMP: where the ramp lip is and where the hole begins and ends */
  gapJump: { lipS: number; s0: number; s1: number; h: number } | null;
}

/** Lane-marking language painted on the road. */
export const MARK = { NORMAL: 0, HAZARD: 1, REWARD: 2, SHORTCUT: 3, DANGER: 4 } as const;

export interface PieceTag {
  enc: number;
  role: 'intro' | 'approach' | 'stage' | 'rest' | 'finish';
  part?: number;
}

/** Instructions from the encounter director for one road piece. */
export interface PieceOpts {
  width?: number;
  length?: number;
  /** central median splitting the road between from..to metres into the piece */
  split?: { from: number; to: number; medianD: number; medianW: number; markL?: number; markR?: number };
  marks?: { L: number; R: number };
  /** gentle bend for straights (1/R) */
  bend?: number;
  /** GAP_JUMP: length of the hole */
  gapLen?: number;
  tag?: PieceTag;
}

/** Produces road centre-line samples, one segment at a time, from weighted segment templates. */
export class RoadGenerator {
  heading = 0;
  x = 0;
  z = 0;
  s = 0;
  width: number;
  segIndex = 0;
  forced: SegmentType[] = [];
  lastType: SegmentType = 'STRAIGHT';

  constructor(public road: Road, public zone: ZoneDef, public rng: Random, public narrowAllowed = true) {
    this.width = zone.baseWidth;
  }

  private turnDir() {
    // keep the road heading broadly "north" so it never loops back on itself
    if (this.heading > 0.55) return -1;
    if (this.heading < -0.55) return 1;
    return this.rng.sign();
  }

  next(type?: SegmentType, opts: PieceOpts = {}): SegmentInfo {
    let t: SegmentType = type ?? this.forced.shift() ?? this.rng.weighted(this.zone.segments);
    if (!type && t === this.lastType && (t === 'JUMP' || t === 'PARKING_AREA' || t === 'TUNNEL')) t = 'STRAIGHT';
    if (!this.narrowAllowed && t === 'NARROW_STREET') t = 'CURVE';
    this.lastType = t;
    const rng = this.rng;
    const base = this.zone.baseWidth;
    let L = 140;
    let width = base;
    let k: (u: number) => number = () => 0;
    let tunnel = false, bridge = false;
    let yAt: (u: number, m: number) => number = () => 0;
    let lipS = -1;
    let gapSide = 0, gapStart = -1, gapEnd = -1, crossS = -1;
    let hole: { lipS: number; s0: number; s1: number; h: number } | null = null;
    let traction = this.zone.traction;
    if (opts.width) width = opts.width;

    switch (t) {
      case 'STRAIGHT': {
        L = opts.length ?? rng.range(110, 180);
        const drift = opts.bend !== undefined ? opts.bend * this.turnDir() : rng.range(-0.0015, 0.0015);
        k = () => drift;
        break;
      }
      case 'CURVE': {
        L = rng.range(90, 160);
        const R = rng.range(75, 150);
        const dir = this.turnDir();
        k = (u) => (dir / R) * smoothstep(0, 0.22, u) * (1 - smoothstep(0.78, 1, u));
        break;
      }
      case 'S_CURVE': {
        L = rng.range(150, 210);
        const R = rng.range(80, 140);
        const dir = this.turnDir();
        k = (u) => (dir / R) * Math.sin(u * Math.PI * 2);
        break;
      }
      case 'TURN_SHARP': {
        // a genuine braking/drift corner: 60-80 degrees at a tight radius
        const R = rng.range(34, 46);
        const dir = this.turnDir();
        // never let the road swing beyond ~70 degrees off its general direction
        const ang = Math.max(0.6, Math.min(rng.range(1.0, 1.35), 1.25 - dir * this.heading));
        L = Math.round(R * ang) + 30;
        const a0 = 15 / L, a1 = 1 - 15 / L;
        k = (u) => (u > a0 && u < a1 ? dir / R : 0);
        break;
      }
      case 'CHICANE': {
        const R = rng.range(40, 55);
        L = 150;
        const dir = this.rng.sign();
        k = (u) => (u < 0.15 || u > 0.85 ? 0 : u < 0.5 ? dir / R : -dir / R);
        break;
      }
      case 'INTERSECTION': {
        L = 80;
        width = base + 1;
        crossS = this.s + L / 2;
        break;
      }
      case 'TUNNEL': {
        L = rng.range(130, 190);
        const R = rng.range(200, 400);
        const dir = this.turnDir();
        k = (u) => (dir / R) * Math.sin(u * Math.PI);
        tunnel = true;
        break;
      }
      case 'BRIDGE': {
        L = rng.range(150, 210);
        const R = rng.range(250, 500);
        const dir = this.turnDir();
        k = () => dir / R;
        bridge = true;
        width = base + 1;
        break;
      }
      case 'JUMP': {
        L = 110;
        const h = this.zone.elevated ? 3.4 : 2.6;
        const rampStart = 34, rampLen = 18;
        lipS = this.s + rampStart + rampLen;
        yAt = (_u, m) => (m >= rampStart && m < rampStart + rampLen ? ((m - rampStart) / rampLen) * h : 0);
        this.road.lips.push({ s: lipS, slope: h / rampLen });
        break;
      }
      case 'GAP_JUMP': {
        // run-up, a steep ramp, the hole, and a long straight landing zone (nothing to steer around)
        const G = opts.gapLen ?? 22;
        const run = 46, rampLen = 20;
        const h = 4.2;
        const lipM = run + rampLen;
        L = lipM + G + 64;
        lipS = this.s + lipM;
        hole = { lipS, s0: lipS, s1: lipS + G, h };
        yAt = (_u, m) => (m >= run && m <= lipM ? ((m - run) / rampLen) * h : 0);
        this.road.lips.push({ s: lipS, slope: h / rampLen });
        this.road.gaps.push({ s0: hole.s0, s1: hole.s1 });
        k = () => 0;
        break;
      }
      case 'NARROW_STREET': {
        L = rng.range(120, 170);
        width = Math.max(9.6, base - 5);
        const R = rng.range(110, 200);
        const dir = this.turnDir();
        k = (u) => (dir / R) * Math.sin(u * Math.PI * 2);
        break;
      }
      case 'PARKING_AREA': {
        L = 110;
        width = base + 10;
        break;
      }
      case 'INDUSTRIAL_ZONE': {
        L = rng.range(130, 170);
        const R = rng.range(160, 300);
        const dir = this.turnDir();
        k = (u) => (dir / R) * Math.sin(u * Math.PI);
        break;
      }
      case 'HAZARD_ZONE': {
        L = rng.range(130, 170);
        if (this.zone.hazard === 'water') traction *= 0.85;
        const R = rng.range(160, 260);
        const dir = this.turnDir();
        k = (u) => (dir / R) * Math.sin(u * Math.PI * 2);
        break;
      }
    }

    // elevated zones: occasional barrier gap = fall hazard
    if (this.zone.elevated && !opts.tag && (t === 'STRAIGHT' || t === 'CURVE') && rng.chance(0.4)) {
      gapSide = rng.sign();
      gapStart = this.s + L * 0.35;
      gapEnd = gapStart + 24;
    }

    L = Math.round(L);
    const startS = this.s;
    const startWidth = this.width;
    const sp = CONFIG.WORLD.SAMPLE_SPACING;
    const first = this.road.samples.length === 0;
    for (let m = first ? 0 : sp; m <= L; m += sp) {
      const u = m / L;
      this.heading += k(u) * sp;
      if (!first || m > 0) {
        this.x += Math.sin(this.heading) * sp;
        this.z += Math.cos(this.heading) * sp;
      }
      const sNow = startS + m;
      const w = lerp(startWidth, width, clamp(m / 25, 0, 1));
      const inGap = gapSide !== 0 && sNow >= gapStart && sNow <= gapEnd;
      const inHole = !!hole && sNow > hole.s0 + 0.5 && sNow < hole.s1;
      let median = 0, medianD = 0;
      let markL = opts.marks?.L ?? 0, markR = opts.marks?.R ?? 0;
      if (opts.split && m >= opts.split.from && m <= opts.split.to) {
        // tapered nose at both ends so the median deflects instead of stopping the car dead
        const taper = Math.min(1, (m - opts.split.from) / 6, (opts.split.to - m) / 6);
        median = opts.split.medianW * Math.max(0.15, taper);
        medianD = opts.split.medianD;
        markL = opts.split.markL ?? markL;
        markR = opts.split.markR ?? markR;
      }
      this.road.push({
        x: this.x,
        z: this.z,
        y: inHole ? 0 : yAt(u, m),
        heading: this.heading,
        width: w,
        barrierL: !(inGap && gapSide < 0) && !inHole,
        barrierR: !(inGap && gapSide > 0) && !inHole,
        tunnel,
        traction,
        seg: this.segIndex,
        median,
        medianD,
        markL,
        markR,
        gap: inHole,
      });
    }
    this.s = startS + L;
    this.width = width;
    return {
      index: this.segIndex++,
      type: t,
      startS,
      endS: this.s,
      width,
      tunnel,
      bridge,
      lipS,
      gapSide,
      gapStart,
      gapEnd,
      crossS,
      tag: opts.tag ?? null,
      split: opts.split ? { s0: startS + opts.split.from, s1: startS + opts.split.to, medianD: opts.split.medianD, medianW: opts.split.medianW } : null,
      marks: opts.marks ?? { L: 0, R: 0 },
      gapJump: hole,
    };
  }
}
