import * as THREE from 'three';
import type { Random } from '../../core/random';
import { S } from '../atlas';
import { MeshKit } from '../meshkit';
import { prop } from './props';

/**
 * Building kit: the relief that turns a textured block into a building — balconies, AC units, down-pipes, cornices,
 * plinths, floor slabs and fins, steel pilasters, pipe runs, fire escapes, entrance canopies, roof parapets, crowns.
 * Modules are authored once and placed on the facade grid of the facade textures (bays of 1.6 m, floors of 3.2 m),
 * so a balcony sits under a window and a fin between two.
 *
 * Module space: origin on the facade surface, +Z out of the wall, X along the facade, Y up.
 */
export const BAY = 1.6;
export const FLOOR = 3.2;

type Put = (geo: THREE.BufferGeometry, m: THREE.Matrix4, paint?: THREE.Color) => void;

const cache = new Map<string, THREE.BufferGeometry>();
function mod(name: string, build: (k: MeshKit) => void) {
  let g = cache.get(name);
  if (!g) {
    const k = new MeshKit(1);
    build(k);
    g = k.build(0.5);
    cache.set(name, g);
  }
  return g;
}

/** Balcony two bays wide: slab, front rail and balusters (or a glass front), side rails. */
const balconyBars = () =>
  mod('balconyBars', (k) => {
    k.box([0, 0.08, 0.6], [3.0, 0.16, 1.2], S.CONCRETE, 0, 0);
    k.box([0, 1.02, 1.17], [3.0, 0.05, 0.06], S.DARK, 0, 0);
    k.box([0, 0.59, 1.17], [2.94, 0.86, 0.02], S.GRILLE, 0, 0);
    for (const x of [-1.47, 1.47]) k.box([x, 0.59, 0.6], [0.03, 0.9, 1.12], S.GRILLE, 0, 0);
  });
const balconyGlass = () =>
  mod('balconyGlass', (k) => {
    k.box([0, 0.09, 0.65], [3.1, 0.18, 1.3], S.CONCRETE, 0, 0);
    k.box([0, 0.62, 1.28], [3.06, 0.86, 0.03], S.GLASS, 0, 0);
    k.box([0, 1.07, 1.28], [3.1, 0.05, 0.07], S.STEEL, 0, 0);
    for (const x of [-1.53, 1.53]) k.box([x, 0.62, 0.65], [0.04, 0.86, 1.26], S.GLASS, 0, 0);
  });
/** Wall-hung AC unit on brackets. */
const acWall = () =>
  mod('acWall', (k) => {
    k.box([0, 0.32, 0.26], [0.85, 0.6, 0.36], S.WHITE, 0, 0);
    k.box([0.12, 0.32, 0.445], [0.42, 0.42, 0.01], S.DARK, 0, 0);
    for (const x of [-0.3, 0.3]) k.box([x, 0.0, 0.25], [0.04, 0.04, 0.5], S.STEEL, 0, 0);
  });
/** One metre of down-pipe (scaled in y), with its brackets as a separate module. */
const pipeUnit = () => mod('pipeUnit', (k) => k.lathe([0, 0, 0.12], [0, 1, 0], [[0.06, 0], [0.06, 1]], 6, S.DARK));
/** Entrance: a door frame, a canopy with a lit soffit, a lamp. */
const entrance = () =>
  mod('entrance', (k) => {
    k.box([0, 1.25, 0.06], [2.2, 2.5, 0.12], S.DARK, 0, 0);
    k.box([0, 1.15, 0.13], [1.7, 2.3, 0.02], S.WINDOW, 0, 0);
    k.box([0, 2.85, 0.75], [3.0, 0.16, 1.5], S.CONCRETE, 0, 0);
    k.box([0, 2.76, 0.75], [2.6, 0.02, 1.2], S.HEAD, 0, 0);
    for (const x of [-1.35, 1.35]) k.box([x, 1.4, 1.42], [0.08, 2.8, 0.08], S.STEEL, 0, 0);
  });
/** Roller door frame over the painted door of the warehouse cladding: guides, drum housing, bollards, a lamp. */
const rollerDoor = () =>
  mod('rollerDoor', (k) => {
    for (let y = 0.3; y < 5.6; y += 0.45) k.box([0, y, 0.035], [2.4, 0.04, 0.03], S.DARK, 0, 0);
    for (const x of [-1.27, 1.27]) {
      k.box([x, 2.9, 0.08], [0.14, 5.8, 0.16], S.DARK, 0, 0);
      k.box([x + Math.sign(x) * 0.25, 0.5, 0.35], [0.2, 1.0, 0.2], S.YELLOW, 0, 0);
    }
    k.box([0, 6.05, 0.22], [2.9, 0.5, 0.44], S.DARK, 0, 0);
    k.box([0, 6.55, 0.42], [0.5, 0.18, 0.3], S.DARK, 0, 0);
    k.box([0, 6.46, 0.52], [0.4, 0.02, 0.2], S.HEAD, 0, 0);
  });
/** Fire-escape landing (one floor): grating, rails, the stair down to the floor below. */
const fireLanding = () =>
  mod('fireLanding', (k) => {
    k.box([0, 0, 0.55], [3.2, 0.06, 1.1], S.GRILLE, 0, 0);
    k.box([0, 0.95, 1.08], [3.2, 0.04, 0.04], S.DARK, 0, 0);
    k.box([0, 0.5, 1.08], [3.2, 0.03, 0.03], S.DARK, 0, 0);
    for (const x of [-1.58, -0.53, 0.53, 1.58]) k.box([x, 0.48, 1.08], [0.04, 0.96, 0.04], S.DARK, 0, 0);
    for (const x of [-1.58, 1.58]) k.box([x, 0.95, 0.55], [0.04, 0.04, 1.1], S.DARK, 0, 0);
    // stair: a stringer slab from this landing down to the next, with a hand-rail
    const len = Math.hypot(2.6, FLOOR);
    const ang = Math.atan2(FLOOR, 2.6);
    k.extrude([[0, -0.08], [len, -0.08], [len, 0.08], [0, 0.08]], 0.7, new THREE.Matrix4().compose(new THREE.Vector3(1.3, -FLOOR, 0.55), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI - ang)), new THREE.Vector3(1, 1, 1)), S.GRILLE, S.DARK);
  });

/** I-beam pilaster, one metre (scaled in y). */
const pilasterUnit = () =>
  mod('pilaster', (k) => {
    k.box([0, 0.5, 0.06], [0.42, 1, 0.04], S.DARK, 0, 0);
    k.box([0, 0.5, 0.36], [0.42, 1, 0.04], S.DARK, 0, 0);
    k.box([0, 0.5, 0.21], [0.04, 1, 0.3], S.DARK, 0, 0);
  });
/** Rooftop air-handling unit: a cabinet with two fan rings on top. */
const roofAC = () =>
  mod('roofAC', (k) => {
    k.box([0, 0.75, 0], [3.4, 1.5, 1.8], S.WHITE, 0, 0);
    k.box([0, 0.75, 0.91], [3.0, 1.1, 0.02], S.GRILLE, 0, 0);
    for (const x of [-0.8, 0.8]) k.lathe([x, 1.5, 0], [0, 1, 0], [[0.6, 0], [0.6, 0.18]], 8, S.DARK, false, true);
  });

/** Wall lamp. */
const wallLamp = () =>
  mod('wallLamp', (k) => {
    k.box([0, 0, 0.18], [0.5, 0.14, 0.36], S.DARK, 0, 0, 0.2);
    k.box([0, -0.07, 0.2], [0.4, 0.02, 0.28], S.HEAD, 0, 0, 0.2);
    k.box([0, 0.05, 0.03], [0.12, 0.25, 0.06], S.DARK, 0, 0);
  });
/** Pipe bracket. */
const bracket = () => mod('bracket', (k) => k.box([0, 0, 0.12], [0.08, 0.08, 0.26], S.STEEL, 0, 0));
/** One metre of horizontal pipe (scaled in x). */
const pipeRunUnit = (r: number) => mod('pipeRun' + r, (k) => k.lathe([0, 0, 0], [1, 0, 0], [[r, 0], [r, 1]], 8, S.RUST));

export interface BuildingSpec {
  /** centre of the block footprint and the height of its foot */
  cx: number;
  cz: number;
  baseY: number;
  /** block yaw (the road heading at the block) */
  yaw: number;
  /** footprint: across the road (local x) and along it (local z), height */
  sx: number;
  sz: number;
  h: number;
  /** which local x face looks at the road: +1 or -1 */
  face: 1 | -1;
  style: 'office' | 'resi' | 'ind';
  zone: string;
  /** bay offset of the facade texture (whole bays): where the painted doors and windows fall */
  uoBays: number;
  /** dress the roof (false when another block stands on it) */
  roof: boolean;
  /** close to the road: the full set of relief; far: silhouette pieces only */
  near: boolean;
}

/**
 * Dress a block with its relief. `put` receives each module's geometry with its world matrix and paint colour.
 */
export function dressBuilding(put: Put, rng: Random, b: BuildingSpec) {
  const T = new THREE.Matrix4().compose(new THREE.Vector3(b.cx, b.baseY, b.cz), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), b.yaw), new THREE.Vector3(1, 1, 1));
  const q = new THREE.Quaternion();
  const UP = new THREE.Vector3(0, 1, 0);
  const tmp = new THREE.Matrix4();
  /** module on face `f` (+1/-1 local x, or 2/-2 for the z faces) at facade x, height y */
  const at = (f: number, x: number, y: number, scale = new THREE.Vector3(1, 1, 1), out = 0) => {
    let px = 0, pz = 0, yaw = 0;
    if (Math.abs(f) === 1) {
      px = f * (b.sx / 2 + out);
      pz = -f * x;
      yaw = (f * Math.PI) / 2;
    } else {
      const s = Math.sign(f);
      pz = s * (b.sz / 2 + out);
      px = s * x;
      yaw = s > 0 ? 0 : Math.PI;
    }
    q.setFromAxisAngle(UP, yaw);
    tmp.compose(new THREE.Vector3(px, y, pz), q, scale);
    return new THREE.Matrix4().multiplyMatrices(T, tmp);
  };
  const W = b.sz; // facade width along the road
  const bays = Math.floor(W / BAY);
  const floors = Math.floor(b.h / FLOOR);
  const bayX = (i: number) => -W / 2 + (i + 0.5) * BAY;
  const F = b.face;
  const one = new THREE.Vector3(1, 1, 1);

  // --- crown: cornice / parapet all round, the line that finishes a building against the sky
  const cornice = mod('cornice', (k) => k.box([0, 0, 0], [1, 1, 1], S.CONCRETE, 0, 0));
  const ch = b.style === 'ind' ? 0.35 : 0.55;
  for (const f of [1, -1]) put(cornice, at(f, 0, b.h - ch / 2 + 0.25, new THREE.Vector3(b.sz + 0.5, ch, 0.5), 0));
  for (const f of [2, -2]) put(cornice, at(f, 0, b.h - ch / 2 + 0.25, new THREE.Vector3(b.sx + 0.5, ch, 0.5), 0));
  // plinth
  if (b.style !== 'ind') for (const f of [F]) put(cornice, at(f, 0, 0.45, new THREE.Vector3(W + 0.2, 0.9, 0.3), 0));
  // flood district: the water line, a dark stain band at the foot
  if (b.zone === 'flood') put(mod('stain', (k) => k.box([0, 0, 0], [1, 1, 1], S.ASPHALT, 0, 0)), at(F, 0, 0.9, new THREE.Vector3(W + 0.3, 1.8, 0.12), 0.02));

  if (!b.near) {
    if (b.style === 'office' && rng.chance(0.5)) officeFins(put, at, F, W, b.h, 4);
    return;
  }

  // --- down-pipes at the facade ends
  const pu = pipeUnit();
  for (const x of [-W / 2 + 0.25, W / 2 - 0.25]) put(pu, at(F, x, 0, new THREE.Vector3(1, b.h, 1)));

  if (b.style === 'resi') {
    // balcony stacks on one or two bay pairs, AC units under random windows, an entrance
    const glass = b.zone === 'skyway' || b.zone === 'zeromile' || rng.chance(0.3);
    const bal = glass ? balconyGlass() : balconyBars();
    const nCols = bays >= 8 && rng.chance(0.35) ? 2 : bays >= 3 && rng.chance(0.75) ? 1 : 0;
    const used = new Set<number>();
    for (let c = 0; c < nCols; c++) {
      const i = rng.int(0, Math.max(0, bays - 2));
      if (used.has(i) || used.has(i + 1) || used.has(i - 1)) continue;
      used.add(i);
      const x = -W / 2 + (i + 1) * BAY;
      for (let j = 1; j < Math.min(floors, 8); j++) put(bal, at(F, x, j * FLOOR, one));
    }
    const ac = acWall();
    for (let n = 0; n < Math.min(5, floors * 0.6); n++) {
      const i = rng.int(0, bays - 1), j = rng.int(1, Math.min(floors - 1, 9));
      if (used.has(i) || used.has(i - 1)) continue;
      put(ac, at(F, bayX(i) + 0.45, j * FLOOR + 0.05, one));
    }
    // fire escape: old city walk-ups
    if ((b.zone === 'oldcity' || b.zone === 'flood') && floors >= 3 && rng.chance(0.45)) {
      const i = rng.int(0, Math.max(0, bays - 2));
      const x = -W / 2 + (i + 1) * BAY;
      const fl = fireLanding();
      for (let j = 2; j < Math.min(floors, 7); j++) put(fl, at(F, x, j * FLOOR + 0.05, one));
    }
    if (bays >= 3) put(entrance(), at(F, bayX(Math.floor(bays / 2)), 0, one));
  } else if (b.style === 'office') {
    officeFins(put, at, F, W, b.h, b.zone === 'zeromile' || b.zone === 'skyway' ? 2 : rng.chance(0.5) ? 2 : 4);
    // slab edges every floor (accent strips on Zero Mile: the zone's light running round the floors)
    const slab = mod('slab', (k) => k.box([0, 0, 0], [1, 1, 1], S.DARK, 0, 0));
    const lit = mod('slabLit', (k) => k.box([0, 0, 0], [1, 1, 1], S.ACCENT, 0, 0));
    for (let j = 1; j < Math.min(floors, 14); j++) {
      const accent = b.zone === 'zeromile' && j % 3 === 0;
      put(accent ? lit : slab, at(F, 0, j * FLOOR - 0.12, new THREE.Vector3(W, accent ? 0.08 : 0.22, 0.25), 0.12));
    }
    // podium canopy
    const can = mod('canopy', (k) => {
      k.box([0, 0, 1.4], [1, 0.25, 2.8], S.DARK, 0, 0);
      k.box([0, -0.13, 1.4], [0.94, 0.01, 2.4], S.HEAD, 0, 0);
    });
    put(can, at(F, 0, 4.6, new THREE.Vector3(Math.min(W - 1, 12), 1, 1)));
  } else {
    // industrial: steel pilasters, a pipe run along the wall, roller doors, wall lamps
    const pil = pilasterUnit();
    for (let x = -W / 2 + 0.3; x <= W / 2 - 0.2; x += 6.4) put(pil, at(F, x, 0, new THREE.Vector3(1, b.h, 1)));
    const run = pipeRunUnit(0.16);
    const br = bracket();
    const py = Math.min(b.h - 1.2, 7.4);
    for (const y of [py, py + 0.45]) {
      put(run, at(F, W / 2 - 0.4, y, new THREE.Vector3(W - 0.8, 1, 1), 0.28));
      for (let x = -W / 2 + 1; x < W / 2 - 0.5; x += 3) put(br, at(F, x, y, one));
    }
    // frames on the painted roller doors (bays 0, 3 and 6 of every texture tile)
    const rd = rollerDoor();
    for (let i = 0; i < bays - 1; i++) {
      const tb = (((b.uoBays + i) % 8) + 8) % 8;
      if (tb === 0 || tb === 3 || tb === 6) put(rd, at(F, -W / 2 + (i + 0.875) * BAY, 0, one));
    }
    for (let x = -W / 2 + 3.2; x < W / 2 - 2; x += 6.4) put(wallLamp(), at(F, x, 7.0, one));
  }

  // --- roof: AC plant, a water tank or a mast — real objects against the sky
  if (!b.roof) return;
  const roofY = b.h + 0.6;
  const roofItems = b.style === 'ind' ? 3 : 2;
  for (let n = 0; n < roofItems; n++) {
    const lx = rng.range(-b.sx * 0.3, b.sx * 0.3), lz = rng.range(-b.sz * 0.3, b.sz * 0.3);
    const pick = b.style === 'ind' ? rng.pick(['roofAC', 'roofAC', 'pipe'] as const) : rng.pick(['roofAC', 'waterTank', 'dish', 'roofAC'] as const);
    if (pick === 'waterTank' && b.h > 60) continue;
    tmp.compose(new THREE.Vector3(lx, roofY, lz), q.setFromAxisAngle(UP, rng.range(0, 3)), one);
    put(pick === 'roofAC' ? roofAC() : prop(pick), new THREE.Matrix4().multiplyMatrices(T, tmp));
  }
}

function officeFins(put: Put, at: (f: number, x: number, y: number, scale?: THREE.Vector3, out?: number) => THREE.Matrix4, F: number, W: number, h: number, every: number) {
  const fin = mod('fin', (k) => k.box([0, 0.5, 0.2], [1, 1, 0.4], S.DARK, 0, 0));
  for (let i = 0; i * BAY <= W + 0.01; i += every) put(fin, at(F, -W / 2 + i * BAY, 0, new THREE.Vector3(0.14, h, 1)));
}
