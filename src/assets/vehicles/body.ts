import { S } from '../atlas';
import { MeshKit, type V3 } from '../meshkit';

/**
 * Car bodies, lofted. A body is ~45 cross-sections along its length; each section is a half-profile of 11 points
 * (underbody, rocker, door, door bulge, shoulder, belt crease, greenhouse base, roof rail, roof) whose shape comes
 * from a handful of design lines: roof/hood/deck height, beltline, plan-view rounding, tumblehome, wheel arches.
 * The loft gives real surfaces — a hood that falls to the nose, a raked windshield, pillars, wheel arches cut into
 * the side with flares around them — and the atlas surface of every face (paint, glass, trim, lights) comes from
 * where it sits on the car. Fascias (grille, lamps, bumpers, diffuser) are added as shaped parts on the end faces.
 */
export interface BodyDesign {
  L: number;
  W: number;
  /** roof height */
  H: number;
  /** underbody height */
  clear: number;
  wheelR: number;
  wheelW: number;
  /** front / rear overhang: axle to body end */
  ohF: number;
  ohR: number;
  /** extra axles (trucks), as z positions */
  axlesExtra?: number[];
  /** only these axles get arches (cab of a truck: the front axle) */
  axlesOnly?: number[];
  /** design stations, fractions of L from the rear */
  deckEnd: number;
  roofStart: number;
  roofEnd: number;
  cowl: number;
  belt: [number, number];
  deckH: number;
  tailH: number;
  hoodH: number;
  noseH: number;
  sill: number;
  tumble: number;
  tumbleBase: number;
  bulge: number;
  flare: number;
  planR: number;
  crown: number;
  roofSurf?: number;
  pillarSurf?: number;
  /** side windows from/to (fractions of L); default = greenhouse */
  winFrom?: number;
  winTo?: number;
  /** extra B/C pillars (fractions of L) */
  pillars?: number[];
  /** open pickup bed between these fractions */
  bed?: [number, number];
  head: 'slit' | 'wide' | 'round' | 'block' | 'quad';
  tail: 'bar' | 'pair' | 'block' | 'slim';
  grille: 'none' | 'small' | 'wide' | 'big' | 'mesh';
  bumper: 'body' | 'dark' | 'heavy';
  sideSkirt?: boolean;
  /** slope of the front fascia (0 = vertical) */
  noseRake?: number;
  /** mirror placement: none for trucks that get their own */
  mirrors?: boolean;
  /** door shut lines (fractions of L): real panel gaps, cut into the skin as narrow dark strips */
  seams?: number[];
  /** side intake behind the doors (fractions of L) */
  vent?: [number, number];
  /** hood and boot shut lines (default on for cars with a hood) */
  shutLines?: boolean;
  /** surface of the side windows (a lit bus: the accent glow) */
  glassSurf?: number;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Where the lights and tailpipes are, in vehicle space: the lighting and exhaust effects attach here. */
export interface Anchors {
  heads: V3[];
  tails: V3[];
  indicators: V3[];
  exhausts: V3[];
}
export const emptyAnchors = (): Anchors => ({ heads: [], tails: [], indicators: [], exhausts: [] });

export interface BodyInfo {
  axles: number[];
  wheelX: number;
  /** z of front and rear faces, belt height at the ends, half widths: where the fascia parts go */
  hwEnd: number;
  anchors: Anchors;
}

/** Height of the top line (deck / rear glass / roof / windshield / hood) at u. */
function topAt(d: BodyDesign, u: number) {
  if (u <= d.deckEnd) return lerp(d.tailH, d.deckH, smooth(0, Math.min(0.09, d.deckEnd + 0.001), u));
  if (u <= d.roofStart) {
    const t = (u - d.deckEnd) / Math.max(1e-4, d.roofStart - d.deckEnd);
    return lerp(d.deckH, d.H, Math.sin((t * Math.PI) / 2) * 0.85 + t * 0.15);
  }
  if (u <= d.roofEnd) {
    const t = (u - d.roofStart) / Math.max(1e-4, d.roofEnd - d.roofStart);
    return d.H + Math.sin(t * Math.PI) * 0.018;
  }
  if (u <= d.cowl) {
    const t = (u - d.roofEnd) / Math.max(1e-4, d.cowl - d.roofEnd);
    return lerp(d.H, d.hoodH, Math.pow(t, 0.92));
  }
  const t = (u - d.cowl) / Math.max(1e-4, 1 - d.cowl);
  return lerp(d.hoodH, d.noseH, Math.pow(t, 1.7));
}

/** How much greenhouse there is at u (0 on the hood and deck, 1 under the roof). */
function cabinAt(d: BodyDesign, u: number) {
  return smooth(d.deckEnd, d.roofStart, u) * (1 - smooth(d.roofEnd, d.cowl, u));
}

export function buildBody(kit: MeshKit, d: BodyDesign, z0 = 0): BodyInfo {
  const L = d.L, L2 = L / 2;
  const zF = L2 - d.ohF, zR = -L2 + d.ohR;
  const axles = d.axlesOnly ?? [zR, ...(d.axlesExtra ?? []), zF];
  const rA = d.wheelR + 0.07;
  // stations: even spacing plus the arch edges and the design stations, so arches and glass edges are crisp
  const us = new Set<number>();
  const step = [0.11, 0.15, 0.34][kit.detail];
  const N = Math.max(kit.detail === 2 ? 12 : 26, Math.round(L / step));
  for (let i = 0; i <= N; i++) us.add(i / N);
  const archOffs = kit.detail === 2 ? [-rA - 0.002, rA + 0.002, -rA * 0.5, rA * 0.5] : [-rA - 0.002, -rA + 0.002, rA - 0.002, rA + 0.002, -rA * 0.7, rA * 0.7, -rA * 0.35, rA * 0.35, 0];
  for (const za of axles) for (const off of archOffs) {
    const u = (za + off + L2) / L;
    if (u > 0.002 && u < 0.998) us.add(u);
  }
  for (const u of [d.deckEnd, d.roofStart, d.roofEnd, d.cowl, 0.012, 0.035, 0.965, 0.988]) if (u > 0 && u < 1) us.add(u);
  // panel gaps: a pair of stations ~2 cm apart around every shut line, the strip between them is the gap
  const gw = 0.011 / L;
  const hoodLine = d.cowl + 0.02, bootLine = d.deckEnd - 0.02;
  const shut = d.shutLines !== false && d.cowl < 0.97 && kit.detail < 2;
  // default door lines: just behind the front wheel and at each pillar
  const gaps = kit.detail === 2 ? [] : [...(d.seams ?? [(zF - rA - 0.12 + L2) / L, ...(d.pillars ?? [(d.roofStart + d.roofEnd) / 2])])];
  const topGaps = shut ? [hoodLine, ...(d.deckEnd > 0.06 ? [bootLine] : [])] : [];
  for (const g of [...gaps, ...topGaps]) for (const o of [-gw, gw]) us.add(g + o);
  if (d.vent) for (const u of d.vent) us.add(u);
  const isGap = (u: number, list: number[]) => list.some((g) => Math.abs(u - g) < gw);
  const U = [...us].sort((a, b) => a - b).filter((u, i, a) => i === 0 || u - a[i - 1] > 0.0015);

  const archAt = (z: number) => {
    let a = 0;
    for (const za of axles) {
      const dz = Math.abs(z - za);
      if (dz < rA) a = Math.max(a, d.wheelR + Math.sqrt(rA * rA - dz * dz));
    }
    return a;
  };
  const flareAt = (z: number) => {
    let f = 0;
    for (const za of axles) f = Math.max(f, 1 - smooth(rA * 0.6, rA + 0.35, Math.abs(z - za)));
    return f;
  };
  const halfW = (u: number) => {
    const dz = Math.min(u, 1 - u) * L;
    const r = d.planR;
    if (dz >= r) return d.W / 2;
    return d.W / 2 - r + Math.sqrt(Math.max(0, r * r - (r - dz) * (r - dz)));
  };

  type Sec = { z: number; u: number; p: [number, number][]; hw: number; belt: number; top: number; c: number; arch: number };
  const secs: Sec[] = U.map((u) => {
    const z = -L2 + u * L;
    const hw0 = halfW(u);
    const end = Math.min(u, 1 - u) * L;
    const top = topAt(d, u);
    const c = cabinAt(d, u);
    const arch = archAt(z);
    const fa = flareAt(z);
    const fl = fa * d.flare;
    // over the wheels the fenders rise above the hood or deck when they have to: a crest over each wheel with the
    // hood sitting between them, instead of a tyre poking through the bodywork
    const beltLine = Math.min(lerp(d.belt[0], d.belt[1], u), top - 0.015);
    const fender = d.wheelR * 2 + 0.16;
    const belt = Math.max(beltLine, lerp(beltLine, fender, fa * (1 - c)));
    const yb = d.clear + Math.max(0, 0.38 - end) * 0.3;
    const sill = Math.max(yb + 0.1, Math.min(d.sill, belt - 0.12));
    const hw = hw0;
    const bulge = d.bulge * smooth(0, 0.3, end);
    const gb = lerp(hw - 0.05, hw - d.tumbleBase, c);
    const gt = lerp(hw * 0.86, hw - d.tumble, c);
    const p: [number, number][] = [
      [0, yb],
      [hw * 0.82, yb],
      [hw - 0.04, yb + 0.07],
      [hw + fl, sill],
      [hw + bulge + fl * 0.7, (sill + belt) / 2 - 0.02],
      [hw + bulge * 0.45 + fl * 0.2, belt - 0.06],
      [hw - 0.015, belt],
      [gb, belt + 0.025],
      [gt, lerp(belt + (top - belt) * 0.55, top - 0.07, c)],
      [lerp(hw * 0.62, gt - 0.1, c), top - 0.006],
      [0, top + d.crown],
    ];
    if (arch > 0) {
      // the wheel well: the side is cut up to the arch, the well is a dark pocket behind the wheel; the panel above
      // the arch is kept monotonic up to the shoulder
      p[1] = [hw - 0.36, Math.min(arch - 0.02, belt - 0.1)];
      p[2] = [hw + fl * 0.6, Math.min(arch, belt - 0.08)];
      p[3] = [hw + fl, Math.min(Math.max(sill, arch + 0.035), belt - 0.05)];
      p[4] = [p[4][0], Math.max(p[4][1], p[3][1] + 0.012)];
      p[5] = [p[5][0], Math.max(p[5][1], p[4][1] + 0.01)];
    }
    return { z: z + z0, u, p, hw, belt, top, c, arch };
  });

  const inGlass = (u: number, lo: number, hi: number) => u > lo + 0.006 && u < hi - 0.006;
  const winFrom = d.winFrom ?? d.deckEnd, winTo = d.winTo ?? d.cowl;
  const pillar = (u: number) => {
    const ps = d.pillars ?? [(d.roofStart + d.roofEnd) / 2];
    return ps.some((pu) => Math.abs(u - pu) < 0.014);
  };
  const surfFor = (j: number, u: number, s0: Sec): number => {
    const front = u > 0.955, rear = u < 0.045;
    if (j >= 3 && j <= 6 && s0.arch === 0 && isGap(u, gaps)) return S.UNDER;
    if (j >= 7 && isGap(u, topGaps) && s0.c < 0.3) return S.UNDER;
    if (d.vent && (j === 4 || j === 5) && u > d.vent[0] && u < d.vent[1]) return S.GRILLE;
    switch (j) {
      case 0:
        return S.UNDER;
      case 1:
        return s0.arch > 0 ? S.UNDER : S.TRIM;
      case 2:
        return d.sideSkirt || s0.arch > 0 ? S.TRIM : S.PAINT;
      case 3:
        if ((front || rear) && d.bumper !== 'body') return S.TRIM;
        return S.PAINT;
      case 4:
        if (front && (d.head === 'wide' || d.head === 'block')) return S.HEAD;
        if (rear && d.tail === 'block') return S.TAIL;
        return S.PAINT;
      case 5:
        if (u > 0.965) return S.HEAD;
        if (u < 0.03) return S.TAIL;
        return S.PAINT;
      case 6:
        return S.PAINT;
      case 7:
        if (d.bed && u > d.bed[0] && u < d.bed[1]) return S.PAINT;
        if (inGlass(u, winFrom, winTo) && s0.c > 0.2) return pillar(u) ? d.pillarSurf ?? S.PAINT2 : d.glassSurf ?? S.GLASS;
        return s0.c > 0.5 ? d.pillarSurf ?? S.PAINT : S.PAINT;
      case 8:
        if (d.bed && u > d.bed[0] && u < d.bed[1]) return S.PAINT;
        if (inGlass(u, d.roofEnd, d.cowl) || inGlass(u, d.deckEnd, d.roofStart)) return d.pillarSurf ?? S.PAINT2;
        return s0.c > 0.9 ? d.roofSurf ?? S.PAINT : S.PAINT;
      default:
        if (d.bed && u > d.bed[0] && u < d.bed[1]) return S.BED;
        if (inGlass(u, d.roofEnd, d.cowl) || inGlass(u, d.deckEnd, d.roofStart)) return S.GLASS;
        return s0.c > 0.9 ? d.roofSurf ?? S.PAINT : S.PAINT;
    }
  };

  // skin: both halves
  for (let i = 0; i < secs.length - 1; i++) {
    const a = secs[i], b = secs[i + 1];
    const um = (a.u + b.u) / 2;
    for (let j = 0; j < a.p.length - 1; j++) {
      const s = surfFor(j, um, a.arch > 0 || b.arch > 0 ? (a.arch > 0 ? a : b) : a);
      // outward normal of the profile segment: the half-profile runs counter-clockwise (bottom centre → side →
      // roof centre), so it is the right-hand perpendicular of the segment direction
      let dx = a.p[j + 1][0] - a.p[j][0] + b.p[j + 1][0] - b.p[j][0];
      let dy = a.p[j + 1][1] - a.p[j][1] + b.p[j + 1][1] - b.p[j][1];
      if (Math.abs(dx) + Math.abs(dy) < 1e-6) {
        dx = 0;
        dy = j < 5 ? 1 : -1;
      }
      for (const side of [1, -1]) {
        const P = (sec: Sec, k: number): V3 => [side * sec.p[k][0], sec.p[k][1], sec.z];
        kit.quad(P(a, j), P(b, j), P(b, j + 1), P(a, j + 1), s, [side * dy, -dx, 0]);
      }
    }
  }
  // end faces
  const cap = (sec: Sec, dir: number) => {
    const loop: V3[] = [...sec.p.map(([x, y]) => [x, y, sec.z] as V3), ...[...sec.p].reverse().slice(1, -1).map(([x, y]) => [-x, y, sec.z] as V3)];
    const yc = (sec.p[0][1] + sec.top) / 2;
    const c: V3 = [0, yc, sec.z];
    for (let k = 0; k < loop.length; k++) kit.tri(c, loop[k], loop[(k + 1) % loop.length], S.PAINT, [0, 0, dir]);
  };
  const rearSec = secs[0], frontSec = secs[secs.length - 1];
  cap(rearSec, -1);
  cap(frontSec, 1);
  const anchors = emptyAnchors();
  fascia(kit, d, frontSec, 1, anchors);
  fascia(kit, d, rearSec, -1, anchors);

  // mirrors on the doors, just behind the A-pillar
  if (d.mirrors !== false && d.cowl < 0.98 && kit.detail < 2) {
    const u = d.cowl - 0.035;
    const s = secs.reduce((best, x) => (Math.abs(x.u - u) < Math.abs(best.u - u) ? x : best), secs[0]);
    for (const side of [-1, 1]) {
      // housing, glass face to the rear, the stalk to the door
      kit.box([side * (s.hw - s.c * d.tumbleBase + 0.12), s.belt + 0.11, s.z], [0.17, 0.1, 0.12], S.PAINT, side * 0.15, 0.035);
      kit.box([side * (s.hw - s.c * d.tumbleBase + 0.12), s.belt + 0.11, s.z - 0.062], [0.14, 0.075, 0.01], S.GLASS, side * 0.15, 0.004);
      kit.box([side * (s.hw - s.c * d.tumbleBase + 0.03), s.belt + 0.07, s.z + 0.01], [0.1, 0.035, 0.06], S.TRIM, 0, 0.01);
    }
  }
  return { axles: axles.map((a) => a + z0), wheelX: d.W / 2 - d.wheelW / 2 - 0.03, hwEnd: frontSec.hw, anchors };
}

/** Front and rear fascia parts: grille, lamps, bumper, diffuser, plate, exhaust. */
function fascia(kit: MeshKit, d: BodyDesign, sec: Sec2, dir: number, out: Anchors) {
  const z = sec.z + dir * 0.012;
  const hw = sec.hw;
  const belt = sec.belt;
  const yb = sec.p[0][1];
  if (dir > 0) {
    // grille
    const gw = d.grille === 'big' ? hw * 1.5 : d.grille === 'wide' ? hw * 1.3 : d.grille === 'mesh' ? hw * 1.1 : hw * 0.7;
    const far = kit.detail === 2;
    if (d.grille !== 'none') {
      const gy0 = yb + 0.16, gy1 = Math.min(belt - 0.07, yb + (d.grille === 'big' ? 0.75 : 0.42));
      kit.box([0, (gy0 + gy1) / 2, z], [gw, gy1 - gy0, 0.05], S.GRILLE, 0, 0.02);
      // chrome or dark surround
      if (!far) kit.box([0, gy1 + 0.015, z + 0.005], [gw + 0.06, 0.03, 0.04], d.grille === 'big' ? S.CHROME : S.TRIM, 0, 0.01);
      if (!far && (d.grille === 'mesh' || d.grille === 'big')) for (let k = -2; k <= 2; k++) kit.box([0, gy0 + ((gy1 - gy0) * (k + 2.5)) / 5, z + 0.02], [gw * 0.96, 0.018, 0.02], S.TRIM, 0, 0);
    }
    // lamps
    const ly = belt - 0.1;
    const lx = hw * 0.62;
    const lw = d.head === 'slit' ? hw * 0.55 : d.head === 'wide' ? hw * 0.7 : d.head === 'round' ? 0.22 : d.head === 'quad' ? 0.18 : hw * 0.42;
    const lh = d.head === 'slit' ? 0.05 : d.head === 'round' ? 0.2 : d.head === 'quad' ? 0.15 : 0.11;
    for (const side of [-1, 1]) {
      out.heads.push([side * lx, ly, z + 0.03]);
      out.indicators.push([side * (hw - 0.06), ly - lh / 2 - 0.05, z + 0.01]);
      if (d.head === 'round') kit.lathe([side * lx, ly, z], [0, 0, 1], [[0.11, -0.02], [0.11, 0.02], [0.08, 0.04], [0, 0.045]], 10, S.HEAD);
      else if (d.head === 'quad') for (const o of [-0.11, 0.11]) kit.box([side * (lx + o), ly, z], [lw, lh, 0.05], S.HEAD, 0, 0.02);
      else kit.box([side * lx, ly, z], [lw, lh, 0.05], S.HEAD, 0, 0.015);
      if (far) continue;
      kit.box([side * lx, ly, z - 0.004], [lw + 0.05, lh + 0.04, 0.04], S.TRIM, 0, 0.012);
      // indicator
      kit.box([side * (hw - 0.06), ly - lh / 2 - 0.05, z - 0.01], [0.12, 0.04, 0.04], S.AMBER, 0, 0.01);
    }
    // bumper and splitter
    const by = yb + 0.08;
    if (d.bumper === 'heavy') {
      kit.box([0, by + 0.14, z + 0.12], [hw * 2 + 0.1, 0.24, 0.22], S.TRIM, 0, 0.05);
      for (const side of [-1, 1]) kit.box([side * hw * 0.5, by + 0.32, z + 0.18], [0.12, 0.3, 0.12], S.CHROME, 0, 0.02);
    } else kit.box([0, by, z + 0.03], [hw * 2 - 0.08, 0.06, 0.08], S.TRIM, 0, 0.02);
    // number plate
    if (!far) kit.box([0, yb + 0.13, z + 0.02], [0.46, 0.11, 0.02], S.PLATE, 0, 0.005);
  } else {
    const far = kit.detail === 2;
    // tail lamps
    const ty = belt - 0.07;
    for (const side of [-1, 1]) out.tails.push(d.tail === 'bar' ? [side * hw * 0.62, ty, z - 0.03] : d.tail === 'block' ? [side * (hw - 0.14), ty - 0.12, z - 0.03] : [side * hw * 0.68, ty, z - 0.03]);
    for (const side of [-1, 1]) out.indicators.push([side * (hw - 0.1), ty - (d.tail === 'block' ? 0.28 : 0.08), z - 0.03]);
    for (const side of d.tail === 'bar' ? [-1, 1] : [1]) out.exhausts.push([side * hw * 0.55, yb + 0.07, z - 0.13]);
    if (d.tail === 'bar') {
      kit.box([0, ty, z], [hw * 2 - 0.12, 0.06, 0.04], S.TAIL, 0, 0.015);
    } else if (d.tail === 'pair' || d.tail === 'slim') {
      for (const side of [-1, 1]) kit.box([side * hw * 0.68, ty, z], [hw * 0.5, d.tail === 'slim' ? 0.05 : 0.11, 0.04], S.TAIL, 0, 0.015);
    } else {
      for (const side of [-1, 1]) kit.box([side * (hw - 0.14), ty - 0.12, z], [0.2, 0.34, 0.05], S.TAIL, 0, 0.02);
    }
    // plate, bumper, diffuser, exhaust
    if (!far) kit.box([0, ty - 0.2, z - 0.01], [0.48, 0.12, 0.02], S.PLATE, 0, 0.005);
    if (d.bumper === 'heavy') kit.box([0, yb + 0.2, z - 0.1], [hw * 2 + 0.08, 0.2, 0.18], S.TRIM, 0, 0.04);
    else {
      kit.box([0, yb + 0.07, z - 0.02], [hw * 2 - 0.1, 0.1, 0.06], S.TRIM, 0, 0.02);
      // diffuser fins only on the sporty cars
      if (d.bumper === 'dark' && !far) for (let k = -2; k <= 2; k++) kit.box([k * hw * 0.25, yb + 0.06, z - 0.05], [0.03, 0.1, 0.12], S.TRIM, 0, 0);
    }
    if (!far) for (const side of d.tail === 'bar' ? [-1, 1] : [1]) kit.tube([side * hw * 0.55, yb + 0.07, z - 0.02], [side * hw * 0.55, yb + 0.07, z - 0.12], 0.045, 8, S.CHROME, true);
  }
}

type Sec2 = { z: number; p: [number, number][]; hw: number; belt: number };

/** The pickup bed walls and tailgate (the loft leaves the bed region as a dark floor). */
export function pickupBed(kit: MeshKit, d: BodyDesign) {
  if (!d.bed) return;
  const L2 = d.L / 2;
  const z0 = -L2 + d.bed[0] * d.L, z1 = -L2 + d.bed[1] * d.L;
  const h = d.deckH;
  for (const side of [-1, 1]) kit.box([side * (d.W / 2 - 0.06), h + 0.05, (z0 + z1) / 2], [0.1, 0.12, z1 - z0], S.PAINT, 0, 0.03);
  kit.box([0, h + 0.05, z1 - 0.05], [d.W - 0.1, 0.12, 0.1], S.PAINT, 0, 0.03);
  kit.box([0, h + 0.05, z0 + 0.04], [d.W - 0.1, 0.12, 0.08], S.PAINT, 0, 0.03);
}

