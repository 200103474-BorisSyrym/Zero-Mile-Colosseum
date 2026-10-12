/**
 * The road is a dense centre-line sampled every SAMPLE_SPACING metres.
 * Everything on the road is expressed in road coordinates (s = distance along, d = lateral offset, + to the right).
 * Forward vector for heading h is (sin h, cos h); right vector is (-cos h, sin h).
 */
export interface RoadSample {
  x: number;
  z: number;
  y: number;
  heading: number;
  width: number;
  barrierL: boolean;
  barrierR: boolean;
  tunnel: boolean;
  traction: number;
  seg: number;
  /** width of a central median wall (0 = none) and its lateral offset; used by split-lane sections */
  median: number;
  medianD: number;
  /** lane marking language: 0 normal, 1 hazard (yellow), 2 reward (gold), 3 shortcut (cyan), 4 danger (red) */
  markL: number;
  markR: number;
  /** no road surface here (a broken bridge): you fly over it or you fall in */
  gap: boolean;
}

export interface RoadPoint {
  x: number;
  y: number;
  z: number;
  heading: number;
  width: number;
}

export interface Lip {
  s: number;
  slope: number;
}

export interface Gap {
  s0: number;
  s1: number;
}

export class Road {
  samples: RoadSample[] = [];
  startS = 0;
  readonly spacing = 1;
  lips: Lip[] = [];
  gaps: Gap[] = [];

  get endS() {
    return this.startS + (this.samples.length - 1) * this.spacing;
  }

  push(s: RoadSample) {
    this.samples.push(s);
  }

  last(): RoadSample | undefined {
    return this.samples[this.samples.length - 1];
  }

  trimBefore(s: number) {
    const n = Math.floor((s - this.startS) / this.spacing);
    if (n > 0 && n < this.samples.length - 2) {
      this.samples.splice(0, n);
      this.startS += n * this.spacing;
    }
    this.lips = this.lips.filter((l) => l.s >= this.startS);
    this.gaps = this.gaps.filter((g) => g.s1 >= this.startS);
  }

  /** The gap whose [s0 - before, s1 + after] contains s, if any. */
  gapNear(s: number, before = 0, after = 0): Gap | null {
    for (const g of this.gaps) if (s >= g.s0 - before && s <= g.s1 + after) return g;
    return null;
  }

  index(s: number) {
    const i = Math.round((s - this.startS) / this.spacing);
    return i < 0 ? 0 : i >= this.samples.length ? this.samples.length - 1 : i;
  }

  sample(s: number): RoadSample {
    return this.samples[this.index(s)];
  }

  /** Interpolated point on the centre line. */
  at(s: number, out: RoadPoint = { x: 0, y: 0, z: 0, heading: 0, width: 0 }): RoadPoint {
    const f = (s - this.startS) / this.spacing;
    let i = Math.floor(f);
    if (i < 0) i = 0;
    if (i >= this.samples.length - 1) i = this.samples.length - 2;
    const a = this.samples[i];
    const b = this.samples[i + 1] ?? a;
    let t = f - i;
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    out.x = a.x + (b.x - a.x) * t;
    out.y = a.y + (b.y - a.y) * t;
    out.z = a.z + (b.z - a.z) * t;
    let dh = b.heading - a.heading;
    if (dh > Math.PI) dh -= Math.PI * 2;
    if (dh < -Math.PI) dh += Math.PI * 2;
    out.heading = a.heading + dh * t;
    out.width = a.width + (b.width - a.width) * t;
    return out;
  }

  /** World position for road coordinates. */
  toWorld(s: number, d: number, out: { x: number; y: number; z: number }) {
    const p = this.at(s, tmpP);
    out.x = p.x - Math.cos(p.heading) * d;
    out.z = p.z + Math.sin(p.heading) * d;
    out.y = p.y;
    return out;
  }

  /** Project a world position to road coordinates, starting the search from hintS. */
  project(x: number, z: number, hintS: number, out: { s: number; d: number }) {
    if (this.samples.length < 2) {
      out.s = hintS;
      out.d = 0;
      return out;
    }
    let i = this.index(hintS);
    let along = 0;
    for (let iter = 0; iter < 6; iter++) {
      const p = this.samples[i];
      const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
      along = (x - p.x) * fx + (z - p.z) * fz;
      const step = Math.round(along / this.spacing);
      if (step === 0) break;
      const ni = Math.max(0, Math.min(this.samples.length - 1, i + step));
      if (ni === i) break;
      i = ni;
    }
    const p = this.samples[i];
    const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
    along = (x - p.x) * fx + (z - p.z) * fz;
    out.s = this.startS + i * this.spacing + along;
    out.d = (x - p.x) * -fz + (z - p.z) * fx;
    return out;
  }

  clear() {
    this.samples = [];
    this.lips = [];
    this.gaps = [];
    this.startS = 0;
  }
}

const tmpP: RoadPoint = { x: 0, y: 0, z: 0, heading: 0, width: 0 };
