import * as THREE from 'three';
import { S } from '../atlas';
import { MeshKit, type V3 } from '../meshkit';

/**
 * Prop library: the street furniture, roadworks, industry and clutter of the city, authored as real objects —
 * profiles, lathes, frames and bolted parts — on the shared surface atlas, built once and merged per road segment.
 *
 * Conventions: origin on the ground at the object's centre, +Y up, +Z is the front (it faces the road when placed),
 * long objects run along X. Paint surfaces take the colour given at placement.
 */
export type PropName =
  | 'jersey' | 'cone' | 'lamp' | 'pole' | 'poleTx' | 'signPost' | 'billboard' | 'busStop' | 'bin' | 'dumpster' | 'barrierA'
  | 'generator' | 'excavator' | 'forklift' | 'pallet' | 'palletLoad' | 'crate' | 'drum' | 'block' | 'spool' | 'hydrant'
  | 'callbox' | 'kiosk' | 'pipe' | 'cabinet' | 'acunit' | 'container' | 'sandbags' | 'trafficLight' | 'bench' | 'waterTank'
  | 'dish' | 'tree' | 'bollard' | 'boat' | 'scaffold' | 'rubble' | 'heras' | 'transformer' | 'floodMast' | 'mast'
  // gameplay props (their footprints match the collision radii in world.ts)
  | 'xdrum' | 'wheelieBin' | 'glassRack' | 'plasticBarrier' | 'pillar' | 'warnSign' | 'awning';

const M = (x: number, y: number, z: number, ry = 0, rx = 0, rz = 0, s = 1) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')), new THREE.Vector3(s, s, s));

const cache = new Map<string, THREE.BufferGeometry>();

/** Geometry of a prop (cached). */
export function prop(name: PropName): THREE.BufferGeometry {
  let g = cache.get(name);
  if (!g) {
    const k = new MeshKit(1);
    BUILD[name](k);
    g = k.build(0.6);
    cache.set(name, g);
  }
  return g;
}

/** Triangle count of every prop (for the docs and the budget). */
export function propStats() {
  return (Object.keys(BUILD) as PropName[]).map((n) => ({ name: n, tris: prop(n).getAttribute('position').count / 3 }));
}

// ------------------------------------------------------------------------------------------------ helpers

/** A wheel on its side axis (x), for trailers and machines. */
function smallWheel(k: MeshKit, c: V3, r: number, w: number) {
  k.lathe([c[0] - w / 2, c[1], c[2]], [1, 0, 0], [[r * 0.5, 0], [r * 0.95, 0.01], [r, w * 0.2], [r, w * 0.8], [r * 0.95, w - 0.01], [r * 0.5, w]], 10, S.RUBBER, false, false);
  k.lathe([c[0] - w / 2 - 0.005, c[1], c[2]], [1, 0, 0], [[r * 0.5, 0], [r * 0.5, w + 0.01]], 10, S.STEEL, true, true);
}

/** Railing: posts and a top rail between two points (on the ground plane of the points). */
function railing(k: MeshKit, a: V3, b: V3, h: number, step = 1.2, r = 0.025, surf = S.STEEL) {
  const d = Math.hypot(b[0] - a[0], b[2] - a[2]);
  const n = Math.max(1, Math.round(d / step));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p: V3 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    k.tube(p, [p[0], p[1] + h, p[2]], r, 5, surf);
  }
  k.tube([a[0], a[1] + h, a[2]], [b[0], b[1] + h, b[2]], r * 1.3, 6, surf);
  k.tube([a[0], a[1] + h * 0.5, a[2]], [b[0], b[1] + h * 0.5, b[2]], r, 5, surf);
}

/** I-beam (H column) from y0 to y1 at (x, z): two flanges and a web. */
export function ibeam(k: MeshKit, x: number, z: number, y0: number, y1: number, w: number, surf = S.DARK, yaw = 0) {
  const h = y1 - y0, cy = (y0 + y1) / 2;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  for (const side of [-1, 1]) k.box([x + side * w * 0.45 * c, cy, z - side * w * 0.45 * s], [w * 0.1, h, w], surf, yaw, 0);
  k.box([x, cy, z], [w * 0.8, h, w * 0.08], surf, yaw, 0);
}

// ------------------------------------------------------------------------------------------------ props

const BUILD: Record<PropName, (k: MeshKit) => void> = {
  /** Concrete safety barrier, 3 m: the F-shape profile, lifting slots, a reflector and the steel connectors. */
  jersey(k) {
    const prof: [number, number][] = [[-0.3, 0], [0.3, 0], [0.3, 0.08], [0.12, 0.33], [0.09, 0.82], [-0.09, 0.82], [-0.12, 0.33], [-0.3, 0.08]];
    k.extrude(prof, 2.98, M(0, 0, 0, Math.PI / 2), S.CONCRETE);
    for (const x of [-0.9, 0.9]) k.box([x, 0.05, 0], [0.3, 0.1, 0.62], S.DARK, 0, 0);
    k.box([0, 0.62, 0.105], [0.1, 0.07, 0.02], S.AMBER, 0, 0.005, -0.08);
    for (const x of [-1.49, 1.49]) k.box([x, 0.5, 0], [0.04, 0.5, 0.1], S.RUST, 0, 0.01);
  },

  /** Traffic cone: square rubber base, orange body (paint) with two reflective collars. */
  cone(k) {
    k.box([0, 0.025, 0], [0.42, 0.05, 0.42], S.RUBBER, 0, 0.02);
    const r = (y: number) => 0.17 - (y / 0.7) * 0.145;
    const bands: [number, number, number][] = [[0.05, 0.3, S.PAINT], [0.3, 0.4, S.WHITE], [0.4, 0.5, S.PAINT], [0.5, 0.57, S.WHITE], [0.57, 0.72, S.PAINT]];
    for (const [a, b, s] of bands) k.lathe([0, a, 0], [0, 1, 0], [[r(a - 0.05), 0], [r(b - 0.05), b - a]], 10, s, false, b > 0.7);
  },

  /** Street lamp, 8 m: plinth, tapered pole, a curved arm reaching over the road, the luminaire with its lens. */
  lamp(k) {
    k.box([0, 0.3, 0], [0.42, 0.6, 0.42], S.CONCRETE, 0, 0.04);
    k.lathe([0, 0.6, 0], [0, 1, 0], [[0.13, 0], [0.11, 1.2], [0.075, 7.3], [0.06, 7.6]], 8, S.DARK);
    k.lathe([0, 0.6, 0], [0, 1, 0], [[0.16, 0], [0.16, 0.5], [0.13, 0.6]], 8, S.DARK);
    // arm: a short rise then out over the road, in three straight pieces
    k.tube([0, 7.5, 0], [0, 7.95, 0.45], 0.055, 6, S.DARK);
    k.tube([0, 7.95, 0.45], [0, 8.1, 1.6], 0.05, 6, S.DARK);
    k.tube([0, 8.1, 1.6], [0, 8.05, 2.55], 0.05, 6, S.DARK);
    // luminaire: a flat housing with the lit lens underneath
    k.box([0, 8.02, 2.85], [0.42, 0.13, 0.9], S.DARK, 0, 0.04, 0.05);
    k.box([0, 7.94, 2.87], [0.32, 0.03, 0.7], S.HEAD, 0, 0.01, 0.05);
  },

  /** Concrete utility pole, 10 m, a cross-arm with insulators. */
  pole(k) {
    k.lathe([0, 0, 0], [0, 1, 0], [[0.17, 0], [0.12, 10]], 7, S.CONCRETE, false, true);
    k.box([0, 9.4, 0], [0.12, 0.14, 3.3], S.STEEL, 0, 0.02);
    for (const z of [-1.3, 0, 1.3]) k.lathe([0, 9.47, z], [0, 1, 0], [[0.05, 0], [0.07, 0.04], [0.04, 0.08], [0.06, 0.12], [0.03, 0.18]], 6, S.WHITE, false, true);
    for (const side of [-1, 1]) k.tube([0, 8.7, 0], [0, 9.35, side * 0.9], 0.03, 4, S.STEEL);
    k.box([0, 2.6, 0.17], [0.3, 0.9, 0.02], S.WHITE, 0, 0.005);
  },

  /** Utility pole with a transformer can and a step bolt ladder. */
  poleTx(k) {
    BUILD.pole(k);
    k.lathe([0, 6.6, 0.42], [0, 1, 0], [[0.28, 0], [0.3, 0.05], [0.3, 0.95], [0.26, 1.0], [0.1, 1.08]], 10, S.STEEL, true, true);
    k.box([0, 7.15, 0.18], [0.14, 0.6, 0.12], S.STEEL, 0, 0.02);
    for (const z of [0.3, 0.55]) k.lathe([0.12, 7.68, z], [0, 1, 0], [[0.03, 0], [0.04, 0.05], [0.025, 0.12]], 5, S.WHITE, false, true);
    for (let y = 2.5; y < 8.5; y += 0.45) k.tube([0, y, 0], [y % 0.9 < 0.45 ? 0.32 : -0.32, y, 0], 0.015, 4, S.STEEL);
  },

  /** Road sign support: two galvanised posts, rails and the back of the panel (the face is the sign atlas). */
  signPost(k) {
    for (const x of [-0.75, 0.75]) {
      k.lathe([x, 0, -0.06], [0, 1, 0], [[0.05, 0], [0.05, 4.3]], 6, S.STEEL, false, true);
      k.box([x, 0.04, -0.06], [0.22, 0.08, 0.22], S.CONCRETE, 0, 0.02);
    }
    for (const y of [3.15, 4.05]) k.box([0, y, -0.06], [2.5, 0.06, 0.05], S.STEEL, 0, 0.01);
    k.box([0, 3.6, -0.03], [2.66, 1.36, 0.035], S.STEEL, 0, 0.012);
  },

  /** Billboard structure: two I-beam legs, a catwalk with railing, three lamps on arms (face = ad atlas). */
  billboard(k) {
    for (const x of [-3.2, 3.2]) {
      ibeam(k, x, -0.4, 0, 8.5, 0.42);
      k.box([x, 0.15, -0.4], [0.9, 0.3, 0.9], S.CONCRETE, 0, 0.04);
      for (const y of [2.5, 5]) k.tube([x - 0.2, y, -0.4], [x + (x < 0 ? 1.5 : -1.5), y + 1.7, -0.4], 0.04, 5, S.DARK);
    }
    k.box([0, 8.6, -0.05], [13.3, 0.12, 0.25], S.DARK, 0, 0.02);
    k.box([0, 14.95, -0.05], [13.3, 0.12, 0.25], S.DARK, 0, 0.02);
    for (const x of [-6.6, 6.6]) k.box([x, 11.8, -0.05], [0.12, 6.45, 0.25], S.DARK, 0, 0.02);
    k.box([0, 11.8, -0.24], [13, 6.2, 0.06], S.DARK, 0, 0.01);
    // catwalk under the face
    k.box([0, 8.25, 0.65], [12.4, 0.06, 0.9], S.GRILLE, 0, 0.01);
    railing(k, [-6.2, 8.28, 1.08], [6.2, 8.28, 1.08], 1.0, 1.55);
    for (const x of [-4.4, 0, 4.4]) {
      k.tube([x, 8.6, 0.6], [x, 9.0, 1.6], 0.035, 5, S.DARK);
      k.box([x, 9.05, 1.68], [0.5, 0.14, 0.32], S.DARK, 0, 0.03, -0.6);
      k.box([x, 8.98, 1.62], [0.4, 0.03, 0.24], S.HEAD, 0, 0.01, -0.6);
    }
  },

  /** Bus shelter: frame, a roof that overhangs the kerb, glass back and side, bench, a lit advert box. */
  busStop(k) {
    for (const x of [-2.7, 0, 2.7]) k.box([x, 1.3, -0.65], [0.08, 2.6, 0.08], S.STEEL, 0, 0.015);
    for (const x of [-2.7, 2.7]) k.box([x, 1.3, 0.5], [0.08, 2.6, 0.08], S.STEEL, 0, 0.015);
    k.extrude([[-0.85, 0], [0.95, 0.12], [0.95, 0.2], [-0.85, 0.12]], 6.0, M(0, 2.62, 0, Math.PI / 2), S.DARK, S.STEEL);
    k.box([0, 1.45, -0.68], [5.3, 2.0, 0.03], S.GLASS, 0, 0.005);
    k.box([2.72, 1.45, -0.08], [0.03, 2.0, 1.1], S.GLASS, 0, 0.005);
    for (const y of [0.42, 2.48]) k.box([0, y, -0.68], [5.4, 0.06, 0.06], S.STEEL, 0, 0.01);
    // bench
    for (const x of [-1.6, 1.6]) k.box([x, 0.22, -0.4], [0.06, 0.44, 0.38], S.STEEL, 0, 0.01);
    for (const z of [-0.52, -0.4, -0.28]) k.box([0, 0.46, z], [3.6, 0.04, 0.09], S.WOOD, 0, 0.008);
    // advert lightbox at the end (the advert itself is the ad atlas)
    k.box([-2.95, 1.35, -0.05], [0.28, 2.3, 1.3], S.DARK, 0, 0.03);
    k.lathe([2.3, 0, 0.2], [0, 1, 0], [[0.2, 0], [0.22, 0.05], [0.22, 0.8], [0.2, 0.85]], 8, S.PAINT, false, true);
  },

  /** Street litter bin on a post. */
  bin(k) {
    k.lathe([0, 0, 0], [0, 1, 0], [[0.06, 0], [0.06, 0.25]], 6, S.DARK);
    k.lathe([0, 0.25, 0], [0, 1, 0], [[0.24, 0], [0.26, 0.04], [0.26, 0.7], [0.27, 0.72], [0.24, 0.76]], 10, S.PAINT, true, false);
    k.lathe([0, 1.01, 0], [0, 1, 0], [[0.27, 0], [0.22, 0.08], [0.1, 0.1]], 10, S.DARK, false, true);
  },

  /** Wheeled dumpster: tapered body, two lids, lifting pockets, castors. */
  dumpster(k) {
    k.extrude([[-0.8, 0.12], [0.8, 0.12], [0.95, 1.25], [-0.95, 1.25]], 1.9, M(0, 0, 0, Math.PI / 2), S.PAINT);
    for (const x of [-0.48, 0.48]) k.box([x, 1.32, 0.02], [0.92, 0.07, 2.0], S.DARK, 0, 0.02, x < 0 ? 0.05 : 0.18);
    for (const side of [-1, 1]) k.box([side * 0.98, 0.95, 0], [0.12, 0.14, 1.6], S.DARK, 0, 0.02);
    for (const x of [-0.8, 0.8]) for (const z of [-0.6, 0.6]) {
      k.box([x, 0.12, z], [0.08, 0.06, 0.12], S.STEEL, 0, 0.01);
      smallWheel(k, [x, 0.07, z], 0.07, 0.05);
    }
    k.box([0, 0.7, 0.88], [1.2, 0.08, 0.03], S.WHITE, 0, 0.005);
  },

  /** Roadworks barrier: A-frame legs, two striped boards, a flashing lamp on top. */
  barrierA(k) {
    for (const x of [-0.9, 0.9]) {
      k.tube([x, 0, -0.35], [x, 1.05, 0], 0.03, 5, S.STEEL);
      k.tube([x, 0, 0.35], [x, 1.05, 0], 0.03, 5, S.STEEL);
      k.box([x, 0.02, 0], [0.12, 0.04, 0.8], S.RUBBER, 0, 0.01);
    }
    for (const y of [0.55, 0.95]) for (let i = 0; i < 6; i++) k.box([-0.9 + 0.15 + i * 0.3, y, 0.03], [0.3, 0.2, 0.025], i % 2 ? S.WHITE : S.RED, 0, 0.004);
    k.box([0.9, 1.12, 0], [0.04, 0.12, 0.04], S.STEEL, 0, 0.005);
    k.lathe([0.9, 1.18, 0], [0, 0, 1], [[0.0, -0.03], [0.09, -0.03], [0.09, 0.03], [0, 0.04]], 8, S.AMBER);
  },

  /** Towable generator: canopy with louvres, exhaust, axle, drawbar and jockey wheel. */
  generator(k) {
    k.box([0, 0.95, 0], [2.4, 1.2, 1.1], S.PAINT, 0, 0.06);
    k.box([0, 1.58, 0], [2.3, 0.08, 1.0], S.PAINT, 0, 0.03);
    for (let i = 0; i < 6; i++) k.box([-0.8 + i * 0.08, 1.0, 0.56], [0.04, 0.6, 0.02], S.GRILLE, 0, 0);
    for (let i = 0; i < 6; i++) k.box([0.5 + i * 0.08, 1.0, 0.56], [0.04, 0.6, 0.02], S.GRILLE, 0, 0);
    k.box([-0.15, 1.05, 0.565], [0.4, 0.5, 0.01], S.DARK, 0, 0.003);
    k.tube([0.9, 1.6, -0.3], [0.9, 1.95, -0.3], 0.05, 6, S.RUST, true);
    k.box([0, 0.38, 0], [2.0, 0.08, 0.9], S.DARK, 0, 0.01);
    for (const side of [-1, 1]) smallWheel(k, [0, 0.3, side * 0.62], 0.3, 0.16);
    k.tube([1.2, 0.38, 0], [2.1, 0.32, 0], 0.04, 5, S.DARK);
    k.box([2.12, 0.32, 0], [0.12, 0.08, 0.1], S.STEEL, 0, 0.01);
    k.tube([1.7, 0.36, 0], [1.7, 0.08, 0], 0.025, 5, S.STEEL);
    smallWheel(k, [1.7, 0.07, 0], 0.07, 0.04);
  },

  /** Tracked excavator: tracks with sprockets, slewing upper with cab and counterweight, boom, stick, bucket, rams. */
  excavator(k) {
    const track = (z: number) => {
      k.extrude([[-1.7, 0.05], [1.7, 0.05], [1.95, 0.38], [1.75, 0.72], [-1.75, 0.72], [-1.95, 0.38]], 0.55, M(0, 0, z, 0), S.RUBBER);
      for (const x of [-1.7, 1.7]) k.lathe([x, 0.38, z - 0.3], [0, 0, 1], [[0.3, 0], [0.3, 0.6]], 10, S.DARK, true, true);
      for (let i = 0; i < 4; i++) k.lathe([-1.05 + i * 0.7, 0.16, z - 0.29], [0, 0, 1], [[0.12, 0], [0.12, 0.58]], 8, S.DARK, true, true);
    };
    track(-1.0);
    track(1.0);
    k.box([0, 0.75, 0], [2.6, 0.32, 1.5], S.DARK, 0, 0.04);
    k.lathe([0, 0.88, 0], [0, 1, 0], [[0.7, 0], [0.7, 0.14]], 14, S.DARK, false, true);
    // upper: body, engine hood, counterweight, cab
    k.box([-0.35, 1.45, 0], [2.6, 0.95, 2.3], S.PAINT, 0, 0.08);
    k.box([-1.55, 1.42, 0], [0.55, 1.0, 2.3], S.PAINT2, 0, 0.12);
    k.box([0.15, 2.05, 0.55], [0.08, 0.1, 0.9], S.GRILLE, 0, 0.01);
    k.box([0.95, 2.3, -0.55], [1.1, 1.6, 1.0], S.PAINT, 0, 0.05);
    k.box([1.48, 2.45, -0.55], [0.06, 1.1, 0.88], S.GLASS, 0, 0.01, -0.12);
    k.box([0.95, 2.5, -1.06], [0.95, 0.95, 0.03], S.GLASS, 0, 0.005);
    k.box([0.95, 3.12, -0.55], [1.15, 0.05, 1.05], S.DARK, 0, 0.01);
    k.box([0.95, 3.18, -0.78], [0.12, 0.06, 0.12], S.AMBER, 0, 0.02);
    // boom (two pieces), stick, bucket, rams
    const p0: V3 = [0.9, 1.7, 0.45], p1: V3 = [2.6, 4.1, 0.45], p2: V3 = [4.3, 3.3, 0.45], p3: V3 = [4.6, 0.9, 0.45];
    // boom pieces lie in the XY plane: tapered outlines extruded across the arm width
    const piece = (a: V3, b: V3, w: number, h0: number, h1: number) => {
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len = Math.hypot(dx, dy), ang = Math.atan2(dy, dx);
      k.extrude([[0, -h0 / 2], [len, -h1 / 2], [len, h1 / 2], [0, h0 / 2]], w, M(a[0], a[1], a[2], 0, 0, ang), S.PAINT);
    };
    piece(p0, p1, 0.5, 0.55, 0.45);
    piece(p1, p2, 0.5, 0.45, 0.4);
    piece(p2, p3, 0.36, 0.36, 0.28);
    k.extrude([[0, 0], [0.75, -0.1], [0.85, 0.45], [0.35, 0.75], [0, 0.55]], 0.95, M(4.35, 0.25, 0.45, 0, 0, 0.15), S.DARK);
    for (let i = 0; i < 4; i++) k.box([5.12, 0.22, 0.12 + i * 0.22], [0.12, 0.06, 0.08], S.STEEL, 0, 0.01);
    k.tube([1.3, 1.5, 0.75], [2.1, 3.3, 0.75], 0.08, 6, S.CHROME);
    k.tube([2.8, 4.3, 0.45], [3.9, 3.7, 0.45], 0.07, 6, S.CHROME);
    k.tube([4.4, 2.9, 0.75], [4.75, 1.4, 0.75], 0.06, 6, S.CHROME);
  },

  /** Forklift: body and counterweight, overhead guard, mast with forks, wheels. */
  forklift(k) {
    k.box([-0.2, 0.62, 0], [1.6, 0.7, 1.05], S.PAINT, 0, 0.06);
    k.box([-0.95, 0.75, 0], [0.4, 0.95, 1.05], S.PAINT2, 0, 0.1);
    for (const x of [-0.8, 0.45]) for (const z of [-0.45, 0.45]) k.tube([x, 0.95, z], [x + (x < 0 ? 0.05 : -0.05), 2.1, z], 0.035, 5, S.DARK);
    k.box([-0.17, 2.12, 0], [1.4, 0.06, 1.0], S.DARK, 0, 0.01);
    k.box([-0.3, 1.0, 0], [0.42, 0.5, 0.5], S.DARK, 0, 0.04);
    for (const z of [-0.36, 0.36]) k.box([0.72, 1.25, z], [0.1, 2.5, 0.1], S.STEEL, 0, 0.01);
    k.box([0.78, 0.5, 0], [0.06, 0.5, 0.95], S.DARK, 0, 0.01);
    for (const z of [-0.25, 0.25]) k.box([1.3, 0.1, z], [1.1, 0.05, 0.12], S.STEEL, 0, 0.01);
    for (const [x, r] of [[0.4, 0.3], [-0.85, 0.24]] as const) for (const side of [-1, 1]) {
      k.lathe([x, r, side * 0.45], [0, 0, side], [[r * 0.5, 0], [r, 0.02], [r, 0.2], [r * 0.5, 0.22]], 10, S.RUBBER, false, true);
    }
    k.box([-0.95, 1.28, 0], [0.1, 0.1, 0.1], S.AMBER, 0, 0.02);
  },

  /** Euro pallet: top boards, blocks, bottom boards. */
  pallet(k) {
    for (let i = 0; i < 5; i++) k.box([-0.5 + i * 0.25, 0.135, 0], [0.14, 0.022, 0.8], S.WOOD, 0, 0.004);
    for (const x of [-0.52, 0, 0.52]) for (const z of [-0.33, 0, 0.33]) k.box([x, 0.07, z], [0.14, 0.1, 0.14], S.WOOD, 0, 0.006);
    for (const z of [-0.33, 0, 0.33]) k.box([0, 0.012, z], [1.2, 0.022, 0.1], S.WOOD, 0, 0.004);
  },

  /** Pallet with a wrapped load. */
  palletLoad(k) {
    BUILD.pallet(k);
    k.box([0, 0.6, 0], [1.14, 0.9, 0.76], S.WHITE, 0, 0.04);
    for (const y of [0.35, 0.85]) k.box([0, y, 0], [1.16, 0.03, 0.78], S.DARK, 0, 0);
  },

  /** Wooden crate, 1.2 m: planked faces with framing boards and a diagonal brace. */
  crate(k) {
    k.box([0, 0.6, 0], [1.16, 1.16, 1.16], S.WOOD, 0, 0.02);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.box([sx * 0.57, 0.6, sz * 0.57], [0.1, 1.2, 0.1], S.WOOD, 0, 0.01);
    for (const y of [0.04, 1.16]) for (const sz of [-1, 1]) {
      k.box([0, y, sz * 0.585], [1.2, 0.09, 0.03], S.WOOD, 0, 0.005);
      k.box([sz * 0.585, y, 0], [0.03, 0.09, 1.2], S.WOOD, 0, 0.005);
    }
    for (const sz of [-1, 1]) k.box([0, 0.6, sz * 0.59], [1.45, 0.09, 0.025], S.WOOD, 0, 0.005, 0);
    k.box([0, 0.65, 0.6], [0.5, 0.18, 0.01], S.WHITE, 0, 0.002);
  },

  /** 200 l oil drum: rolling hoops, top chime and bung. */
  drum(k) {
    k.lathe([0, 0, 0], [0, 1, 0], [[0.27, 0], [0.29, 0.03], [0.29, 0.28], [0.3, 0.3], [0.29, 0.32], [0.29, 0.56], [0.3, 0.58], [0.29, 0.6], [0.29, 0.84], [0.27, 0.87], [0.27, 0.88]], 12, S.PAINT, false, true);
    k.lathe([0.15, 0.88, 0.05], [0, 1, 0], [[0.03, 0], [0.03, 0.015]], 6, S.STEEL, false, true);
  },

  /** Concrete block with chamfers and a lifting loop. */
  block(k) {
    k.box([0, 0.5, 0], [2.4, 1.0, 1.0], S.CONCRETE, 0, 0.08);
    k.tube([-0.12, 1.0, 0], [-0.12, 1.08, 0], 0.03, 5, S.RUST);
    k.tube([0.12, 1.0, 0], [0.12, 1.08, 0], 0.03, 5, S.RUST);
    k.tube([-0.12, 1.08, 0], [0.12, 1.08, 0], 0.03, 5, S.RUST);
    for (const x of [-0.8, 0.8]) k.box([x, 0.5, 0.505], [0.5, 0.12, 0.02], S.AMBER, 0, 0.004);
  },

  /** Cable spool: two plywood flanges, the core and wraps of cable. */
  spool(k) {
    for (const z of [-0.45, 0.45]) k.lathe([0, 0.8, z - 0.03], [0, 0, 1], [[0.8, 0], [0.8, 0.06]], 14, S.WOOD, true, true);
    k.lathe([0, 0.8, -0.42], [0, 0, 1], [[0.62, 0], [0.64, 0.05], [0.64, 0.79], [0.62, 0.84]], 14, S.DARK);
    k.lathe([0, 0.8, -0.5], [0, 0, 1], [[0.12, 0], [0.12, 1.0]], 8, S.STEEL, true, true);
  },

  /** Fire hydrant: flange, barrel, bonnet, two side outlets and the pump nozzle. */
  hydrant(k) {
    k.lathe([0, 0, 0], [0, 1, 0], [[0.16, 0], [0.16, 0.05], [0.11, 0.08], [0.11, 0.6], [0.14, 0.62], [0.14, 0.66], [0.1, 0.72], [0.04, 0.8], [0.03, 0.84]], 10, S.RED, false, true);
    for (const side of [-1, 1]) {
      k.tube([side * 0.08, 0.45, 0], [side * 0.2, 0.45, 0], 0.045, 8, S.RED, true);
      k.lathe([side * 0.2, 0.45, 0], [side, 0, 0], [[0.055, 0], [0.055, 0.03]], 6, S.STEEL, false, true);
    }
    k.tube([0, 0.4, 0.08], [0, 0.4, 0.2], 0.06, 8, S.RED, true);
  },

  /** Emergency call box on a post. */
  callbox(k) {
    k.lathe([0, 0, 0], [0, 1, 0], [[0.06, 0], [0.06, 1.1]], 6, S.STEEL);
    k.box([0, 1.4, 0], [0.42, 0.65, 0.3], S.YELLOW, 0, 0.04);
    k.box([0, 1.48, 0.155], [0.3, 0.3, 0.01], S.DARK, 0, 0.004);
    k.box([0, 1.2, 0.155], [0.1, 0.1, 0.012], S.RED, 0, 0.004);
    k.box([0, 1.77, 0], [0.12, 0.08, 0.12], S.TAIL, 0, 0.02);
  },

  /** Street kiosk: booth, shutter, serving hatch with counter, awning, lit sign band (accent = zone neon). */
  kiosk(k) {
    k.box([0, 1.3, 0], [3.0, 2.6, 2.2], S.PAINT, 0, 0.05);
    k.box([0, 2.68, 0], [3.2, 0.16, 2.4], S.DARK, 0, 0.03);
    k.box([0, 1.45, 1.11], [2.2, 1.0, 0.02], S.WINDOW, 0, 0.005);
    for (let i = 0; i < 6; i++) k.box([0, 1.95 + i * 0.05, 1.12], [2.2, 0.03, 0.02], S.STEEL, 0, 0);
    k.box([0, 0.95, 1.25], [2.3, 0.05, 0.3], S.STEEL, 0, 0.01);
    k.extrude([[0, 0], [0.9, -0.35], [0.9, -0.3], [0, 0.05]], 3.0, M(0, 2.45, 1.1, -Math.PI / 2), S.RED, S.WHITE);
    k.box([0, 2.95, 1.0], [2.6, 0.4, 0.08], S.ACCENT, 0, 0.02);
    k.box([0, 2.95, 0.94], [2.7, 0.48, 0.06], S.DARK, 0, 0.02);
  },

  /** Big pipe on saddles with flanges. */
  pipe(k) {
    k.lathe([-3, 0.75, 0], [1, 0, 0], [[0.55, 0], [0.55, 6]], 14, S.RUST, true, true);
    for (const x of [-2.9, 0, 2.9]) k.lathe([x - 0.06, 0.75, 0], [1, 0, 0], [[0.62, 0], [0.62, 0.12]], 14, S.RUST, true, true);
    for (const x of [-1.8, 1.8]) k.box([x, 0.2, 0], [0.3, 0.4, 1.3], S.CONCRETE, 0, 0.04);
  },

  /** Electrical cabinet: plinth, doors, louvres, warning plate. */
  cabinet(k) {
    k.box([0, 0.1, 0], [1.3, 0.2, 0.5], S.CONCRETE, 0, 0.02);
    k.box([0, 0.85, 0], [1.2, 1.3, 0.42], S.PAINT, 0, 0.03);
    k.box([0, 1.53, 0], [1.26, 0.06, 0.48], S.PAINT, 0, 0.02);
    k.box([0, 0.85, 0.212], [0.012, 1.2, 0.01], S.DARK, 0, 0);
    for (let i = 0; i < 5; i++) k.box([-0.3, 0.45 + i * 0.05, 0.215], [0.4, 0.02, 0.01], S.DARK, 0, 0);
    k.box([0.3, 1.2, 0.215], [0.22, 0.16, 0.008], S.YELLOW, 0, 0.003);
  },

  /** Air-conditioning condenser: casing, fan grille, fins. */
  acunit(k) {
    k.box([0, 0.45, 0], [1.0, 0.8, 0.45], S.WHITE, 0, 0.03);
    k.lathe([0.1, 0.47, 0.226], [0, 0, 1], [[0.3, 0], [0.32, 0.01]], 14, S.DARK, false, true);
    for (let i = 0; i < 4; i++) k.box([0.1, 0.47, 0.24], [0.6, 0.012, 0.01], S.STEEL, (i * Math.PI) / 4, 0);
    for (let i = 0; i < 5; i++) k.box([-0.42, 0.25 + i * 0.1, 0.226], [0.1, 0.02, 0.01], S.GRILLE, 0, 0);
    for (const x of [-0.4, 0.4]) k.box([x, 0.02, 0], [0.08, 0.04, 0.5], S.DARK, 0, 0.01);
  },

  /** 40 ft shipping container: corrugated sides, corner castings, top rails, doors with lock rods. */
  container(k) {
    const L = 12, W = 2.44, H = 2.6;
    k.box([0, H / 2, 0], [L - 0.1, H - 0.1, W - 0.06], S.PAINT, 0, 0.02);
    for (let x = -L / 2 + 0.7; x < L / 2 - 0.5; x += 1.4) for (const side of [-1, 1]) k.box([x, H / 2, side * (W / 2 - 0.015)], [0.5, H - 0.3, 0.035], S.PAINT, 0, 0);
    for (const sx of [-1, 1]) for (const sy of [0, 1]) for (const sz of [-1, 1]) k.box([sx * (L / 2 - 0.09), sy * (H - 0.16) + 0.08, sz * (W / 2 - 0.09)], [0.18, 0.16, 0.18], S.DARK, 0, 0.01);
    for (const sy of [0, 1]) for (const sz of [-1, 1]) k.box([0, sy * (H - 0.08) + 0.04, sz * (W / 2 - 0.04)], [L - 0.2, 0.08, 0.08], S.PAINT, 0, 0.01);
    for (const sz of [-0.85, -0.35, 0.35, 0.85]) k.tube([L / 2 + 0.02, 0.15, sz], [L / 2 + 0.02, H - 0.15, sz], 0.025, 5, S.STEEL);
    k.box([L / 2 - 0.02, H / 2, 0], [0.02, H - 0.25, 0.015], S.DARK, 0, 0);
    k.box([-L / 2 + 0.3, H - 0.4, W / 2 + 0.005], [0.45, 0.25, 0.01], S.WHITE, 0, 0.003);
  },

  /** Sandbag wall: three courses of bags, staggered. */
  sandbags(k) {
    for (let row = 0; row < 3; row++) {
      for (let i = 0; i < 6 - row; i++) {
        const x = -2.25 + row * 0.45 + i * 0.9;
        const y = 0.12 + row * 0.23;
        k.lathe([x - 0.42, y, 0], [1, 0, 0], [[0.07, 0], [0.15, 0.16], [0.15, 0.68], [0.07, 0.84]], 6, S.SAND, true, true);
      }
    }
  },

  /** Traffic signal: pole, mast arm over the road, two signal heads with visors (lenses lit by the world). */
  trafficLight(k) {
    k.lathe([0, 0, 0], [0, 1, 0], [[0.18, 0], [0.16, 0.4], [0.12, 0.5], [0.1, 6.4]], 8, S.DARK, false, true);
    k.tube([0, 6.0, 0], [0, 6.2, 5.2], 0.07, 6, S.DARK);
    k.tube([0, 5.0, 0], [0, 6.0, 1.5], 0.04, 5, S.DARK);
    for (const z of [3.2, 5.0]) {
      k.box([0, 5.45, z], [0.36, 1.0, 0.3], S.DARK, 0, 0.04);
      k.box([0, 5.95, z], [0.04, 0.06, 0.06], S.DARK, 0, 0);
      for (const [y, s] of [[5.75, S.TAIL], [5.45, S.AMBER], [5.15, S.GREEN]] as const) {
        k.lathe([0, y, z + 0.15], [0, 0, 1], [[0.11, 0], [0.11, 0.01]], 10, s, false, true);
        k.box([0, y + 0.1, z + 0.22], [0.26, 0.02, 0.14], S.DARK, 0, 0.005);
      }
    }
    k.box([0, 2.2, 0.12], [0.24, 0.32, 0.12], S.DARK, 0, 0.02);
  },

  /** Park bench: cast frame, slatted seat and back. */
  bench(k) {
    for (const x of [-0.8, 0.8]) {
      k.box([x, 0.22, 0], [0.06, 0.44, 0.5], S.DARK, 0, 0.01);
      k.box([x, 0.65, -0.22], [0.06, 0.5, 0.06], S.DARK, 0, 0.01, -0.2);
    }
    for (const z of [-0.15, 0, 0.15]) k.box([0, 0.46, z], [1.9, 0.035, 0.11], S.WOOD, 0, 0.006);
    for (const y of [0.62, 0.78]) k.box([0, y, -0.26 - (y - 0.62) * 0.2], [1.9, 0.1, 0.03], S.WOOD, 0, 0.006, -0.2);
  },

  /** Rooftop water tank on a steel stand. */
  waterTank(k) {
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.box([sx * 1.0, 1.2, sz * 1.0], [0.14, 2.4, 0.14], S.DARK, 0, 0.02);
    for (const y of [0.8, 1.9]) {
      k.box([0, y, 1.0], [2.1, 0.08, 0.08], S.DARK, 0, 0.01);
      k.box([0, y, -1.0], [2.1, 0.08, 0.08], S.DARK, 0, 0.01);
    }
    k.box([0, 2.45, 0], [2.4, 0.12, 2.4], S.DARK, 0, 0.02);
    k.lathe([0, 2.5, 0], [0, 1, 0], [[1.15, 0], [1.2, 0.1], [1.2, 2.4], [1.22, 2.45], [0.6, 2.95], [0.08, 3.1]], 12, S.WOOD, false, true);
    for (const y of [3.0, 3.8, 4.5]) k.lathe([0, y, 0], [0, 1, 0], [[1.22, 0], [1.22, 0.05]], 12, S.DARK);
  },

  /** Satellite dish on a wall bracket. */
  dish(k) {
    k.box([0, 0.5, -0.1], [0.08, 1.0, 0.08], S.STEEL, 0, 0.01);
    k.lathe([0, 1.0, 0], [0, 0.5, 0.86], [[0.03, 0], [0.5, 0.12], [0.55, 0.16]], 14, S.WHITE, true);
    k.lathe([0, 1.0, 0], [0, 0.5, 0.86], [[0.03, 0], [0.5, 0.12], [0.55, 0.16]], 14, S.WHITE, false, false, true);
    k.tube([0, 1.0, 0], [0, 1.25, 0.45], 0.015, 4, S.STEEL);
    k.box([0, 1.25, 0.46], [0.06, 0.06, 0.1], S.DARK, 0, 0.01);
  },

  /** Street tree: trunk with a root flare, three-lobed canopy, tree grate. */
  tree(k) {
    k.box([0, 0.03, 0], [1.3, 0.06, 1.3], S.DARK, 0, 0.02);
    k.lathe([0, 0, 0], [0, 1, 0], [[0.28, 0], [0.16, 0.25], [0.13, 2.4], [0.09, 3.6]], 7, S.WOOD);
    k.tube([0, 2.4, 0], [0.55, 3.3, 0.2], 0.07, 5, S.WOOD);
    k.tube([0, 2.6, 0], [-0.5, 3.4, -0.25], 0.06, 5, S.WOOD);
    const blob = (x: number, y: number, z: number, r: number) =>
      k.lathe([x, y - r * 0.8, z], [0, 1, 0], [[r * 0.2, 0], [r * 0.85, r * 0.3], [r, r * 0.8], [r * 0.85, r * 1.3], [r * 0.4, r * 1.65], [0.01, r * 1.75]], 7, S.FOLIAGE, true, false);
    blob(0, 3.6, 0, 1.6);
    blob(0.7, 3.3, 0.35, 1.15);
    blob(-0.65, 3.4, -0.4, 1.2);
    blob(0.1, 4.5, -0.1, 1.0);
  },

  /** Steel bollard with a reflective band. */
  bollard(k) {
    k.lathe([0, 0, 0], [0, 1, 0], [[0.1, 0], [0.1, 0.75], [0.08, 0.85], [0.03, 0.9]], 8, S.DARK, false, true);
    k.lathe([0, 0.62, 0], [0, 1, 0], [[0.105, 0], [0.105, 0.08]], 8, S.AMBER);
  },

  /** Small motorboat: lofted hull, cabin with windscreen, outboard motor (flood district). */
  boat(k) {
    const st = [[-2.3, 0.75, 0.55, 0.15], [-1.6, 0.9, 0.5, 0.05], [-0.4, 0.95, 0.5, 0], [0.8, 0.85, 0.55, 0.05], [1.8, 0.55, 0.75, 0.2], [2.5, 0.05, 1.0, 0.45]];
    const sec = (s: number[]): V3[] => {
      const [z, hw, top, keel] = s;
      return [[0, keel, z], [hw * 0.6, keel + 0.18, z], [hw, top * 0.55, z], [hw * 1.02, top, z]];
    };
    for (let i = 0; i < st.length - 1; i++) {
      const A = sec(st[i]), B = sec(st[i + 1]);
      for (let j = 0; j < 3; j++) for (const side of [-1, 1]) {
        const P = (p: V3): V3 => [side * p[0], p[1], p[2]];
        k.quad(P(A[j]), P(B[j]), P(B[j + 1]), P(A[j + 1]), j === 2 ? S.WHITE : S.PAINT, [side, j === 0 ? -1 : 0.2, 0]);
        // the inside of the topsides, seen from above
        if (j > 0) k.quad(P(A[j]), P(B[j]), P(B[j + 1]), P(A[j + 1]), S.WHITE, [-side, 0, 0]);
      }
    }
    const t = sec(st[0]);
    for (const side of [-1, 1]) for (let j = 0; j < 3; j++) k.tri([0, t[0][1], t[0][2]], [side * t[j][0], t[j][1], t[j][2]], [side * t[j + 1][0], t[j + 1][1], t[j + 1][2]], S.WHITE, [0, 0, -1]);
    k.box([0, 0.5, -0.3], [1.7, 0.06, 3.6], S.WOOD, 0, 0.01);
    k.box([0, 0.85, 0.2], [1.3, 0.6, 1.2], S.WHITE, 0, 0.05);
    k.box([0, 1.25, 0.75], [1.2, 0.35, 0.05], S.GLASS, 0, 0.01, -0.35);
    k.box([0, 0.85, -2.4], [0.3, 0.7, 0.35], S.DARK, 0, 0.05);
    k.tube([0, 0.5, -2.45], [0, -0.1, -2.45], 0.05, 5, S.DARK);
  },

  /** Scaffold tower: tube frame, ledgers, braces, planks, toe boards. */
  scaffold(k) {
    const W = 2.5, D = 1.3, lifts = 4, h = 2.0;
    for (const x of [-W / 2, W / 2]) for (const z of [-D / 2, D / 2]) k.tube([x, 0, z], [x, lifts * h + 1, z], 0.03, 5, S.STEEL);
    for (let l = 1; l <= lifts; l++) {
      const y = l * h;
      for (const z of [-D / 2, D / 2]) k.tube([-W / 2, y, z], [W / 2, y, z], 0.025, 5, S.STEEL);
      for (const x of [-W / 2, W / 2]) k.tube([x, y, -D / 2], [x, y, D / 2], 0.025, 5, S.STEEL);
      for (let i = 0; i < 5; i++) k.box([0, y + 0.03, -D / 2 + 0.13 + i * 0.26], [W, 0.04, 0.22], S.WOOD, 0, 0.005);
      k.tube([-W / 2, y - h, D / 2], [W / 2, y, D / 2], 0.022, 4, S.STEEL);
      k.tube([-W / 2, y + 1, -D / 2], [W / 2, y + 1, -D / 2], 0.022, 4, S.STEEL);
    }
    for (const x of [-W / 2, W / 2]) for (const z of [-D / 2, D / 2]) k.box([x, 0.02, z], [0.18, 0.04, 0.18], S.STEEL, 0, 0);
  },

  /** Rubble heap: broken slabs, blocks and a bent rebar. */
  rubble(k) {
    const pieces: [number, number, number, number, number, number, number, number][] = [
      [0, 0.25, 0, 1.6, 0.5, 1.2, 0.3, 0.1], [0.8, 0.18, 0.5, 0.9, 0.35, 0.8, 1.1, -0.2], [-0.9, 0.2, -0.3, 1.0, 0.4, 0.7, 2.0, 0.15],
      [0.2, 0.6, -0.1, 0.8, 0.3, 0.6, 0.7, 0.35], [-0.3, 0.12, 0.8, 0.6, 0.24, 0.5, 2.6, 0], [1.3, 0.12, -0.5, 0.5, 0.24, 0.6, 0.2, 0.1],
    ];
    for (const [x, y, z, w, h, d, yaw, pitch] of pieces) k.box([x, y, z], [w, h, d], S.CONCRETE, yaw, 0.05, pitch);
    k.tube([0.1, 0.5, 0], [0.6, 1.3, 0.3], 0.015, 4, S.RUST);
    k.tube([0.6, 1.3, 0.3], [0.9, 1.25, 0.6], 0.015, 4, S.RUST);
    k.tube([-0.4, 0.4, -0.2], [-0.8, 1.0, -0.5], 0.015, 4, S.RUST);
  },

  /** Temporary fence panel, 3.5 m: frame, mesh, rubber feet with clamps. */
  heras(k) {
    for (const x of [-1.75, 1.75]) k.tube([x, 0.12, 0], [x, 2.0, 0], 0.025, 5, S.STEEL);
    for (const y of [0.12, 2.0]) k.tube([-1.75, y, 0], [1.75, y, 0], 0.025, 5, S.STEEL);
    for (let x = -1.5; x <= 1.51; x += 0.25) k.box([x, 1.06, 0], [0.012, 1.86, 0.012], S.STEEL, 0, 0);
    for (let y = 0.35; y < 2.0; y += 0.3) k.box([0, y, 0], [3.48, 0.012, 0.012], S.STEEL, 0, 0);
    for (const x of [-1.75, 1.75]) k.box([x, 0.07, 0], [0.22, 0.14, 0.62], S.CONCRETE, 0, 0.03);
  },

  /** Pad-mounted transformer behind a fence of bollards. */
  transformer(k) {
    k.box([0, 0.1, 0], [2.2, 0.2, 1.8], S.CONCRETE, 0, 0.03);
    k.box([0, 0.85, -0.1], [1.7, 1.3, 1.2], S.GREEN, 0, 0.04);
    for (let i = 0; i < 6; i++) k.box([-0.86, 0.85, -0.55 + i * 0.18], [0.08, 1.1, 0.06], S.GREEN, 0, 0.01);
    k.box([0, 1.15, 0.51], [0.4, 0.3, 0.01], S.YELLOW, 0, 0.003);
    for (const x of [-1, 1]) for (const z of [-0.8, 0.8]) k.lathe([x, 0.2, z], [0, 1, 0], [[0.06, 0], [0.06, 0.9]], 6, S.YELLOW, false, true);
  },

  /** Flood-light mast, 16 m: lattice-free tube mast, a head frame with three lamps facing the road. */
  floodMast(k) {
    k.box([0, 0.3, 0], [0.9, 0.6, 0.9], S.CONCRETE, 0, 0.05);
    k.lathe([0, 0.6, 0], [0, 1, 0], [[0.28, 0], [0.24, 1], [0.15, 15.4]], 8, S.STEEL);
    k.box([0, 15.9, 0.15], [2.6, 0.12, 0.12], S.STEEL, 0, 0.02);
    k.box([0, 16.7, 0.15], [2.6, 0.12, 0.12], S.STEEL, 0, 0.02);
    for (const x of [-0.9, 0, 0.9]) {
      k.box([x, 16.3, 0.4], [0.75, 0.5, 0.3], S.DARK, 0, 0.04, 0.35);
      k.box([x, 16.24, 0.56], [0.62, 0.38, 0.02], S.HEAD, 0, 0.01, 0.35);
    }
    for (let y = 1.5; y < 15.5; y += 0.5) k.tube([0.14, y, 0], [0.28, y, 0], 0.012, 3, S.STEEL);
  },

  /** Explosive drum: red, hazard band, a glowing seal ring on top (accent = hazard glow). */
  xdrum(k) {
    k.lathe([0, 0, 0], [0, 1, 0], [[0.27, 0], [0.29, 0.03], [0.29, 0.28], [0.3, 0.3], [0.29, 0.32]], 12, S.RED);
    k.lathe([0, 0.32, 0], [0, 1, 0], [[0.29, 0], [0.29, 0.24]], 12, S.YELLOW);
    k.lathe([0, 0.56, 0], [0, 1, 0], [[0.29, 0], [0.3, 0.02], [0.29, 0.04], [0.29, 0.28], [0.27, 0.31], [0.27, 0.32]], 12, S.RED, false, true);
    k.lathe([0, 0.88, 0], [0, 1, 0], [[0.2, 0], [0.2, 0.025]], 12, S.ACCENT, false, true);
    for (let i = 0; i < 4; i++) k.box([Math.cos(i * 1.57) * 0.295, 0.44, Math.sin(i * 1.57) * 0.295], [0.1, 0.12, 0.1], S.DARK, -i * 1.57 + 0.785, 0.01);
  },

  /** Wheelie bin: tapered body, hinged lid, axle and two wheels, the handle. */
  wheelieBin(k) {
    k.extrude([[-0.3, 0.05], [0.3, 0.05], [0.36, 1.0], [-0.36, 1.0]], 0.7, M(0, 0, 0, 0), S.PAINT);
    k.box([0, 1.04, 0.02], [0.78, 0.07, 0.76], S.PAINT, 0, 0.02, 0.04);
    k.box([0, 0.98, -0.38], [0.6, 0.06, 0.05], S.DARK, 0, 0.01);
    for (const x of [-0.3, 0.3]) smallWheel(k, [x, 0.12, -0.32], 0.12, 0.06);
    k.box([0, 0.6, 0.355], [0.4, 0.3, 0.01], S.WHITE, 0, 0.003);
  },

  /** Glazier's rack: an A-frame of steel carrying the glass sheet (the sheet itself is a transparent mesh). */
  glassRack(k) {
    for (const x of [-0.95, 0.95]) {
      k.tube([x, 0, -0.45], [x, 2.25, -0.08], 0.035, 5, S.STEEL);
      k.tube([x, 0, 0.45], [x, 2.25, 0.08], 0.035, 5, S.STEEL);
      k.box([x, 0.04, 0], [0.12, 0.08, 1.0], S.RUBBER, 0, 0.01);
    }
    k.box([0, 0.12, 0], [2.3, 0.08, 0.2], S.STEEL, 0, 0.01);
    k.box([0, 2.25, 0], [2.0, 0.06, 0.16], S.STEEL, 0, 0.01);
  },

  /** Water-filled plastic barrier, 2.2 m: two red / white modules with their interlocking lugs. */
  plasticBarrier(k) {
    for (const [x, s] of [[-0.55, S.RED], [0.55, S.WHITE]] as const) {
      k.extrude([[-0.2, 0], [0.2, 0], [0.16, 0.12], [0.1, 0.86], [-0.1, 0.86], [-0.16, 0.12]], 1.08, M(x, 0, 0, Math.PI / 2), s);
      k.box([x, 0.86, 0], [0.5, 0.04, 0.12], s, 0, 0.015);
    }
    for (const x of [-1.1, 0, 1.1]) k.box([x, 0.5, 0], [0.06, 0.7, 0.16], S.DARK, 0, 0.01);
    k.box([0, 0.65, 0.105], [0.2, 0.08, 0.02], S.AMBER, 0, 0.004);
  },

  /** Parking-garage column, 7 m: octagonal, a capital, black-and-yellow hazard bands at bumper height. */
  pillar(k) {
    k.lathe([0, 0, 0], [0, 1, 0], [[0.75, 0], [0.7, 0.1], [0.7, 6.4], [0.95, 6.8], [0.95, 7.0]], 8, S.CONCRETE, false, true);
    for (let i = 0; i < 4; i++) k.lathe([0, 0.2 + i * 0.25, 0], [0, 1, 0], [[0.712, 0], [0.712, 0.25]], 8, i % 2 ? S.DARK : S.YELLOW);
  },

  /** Warning sign: post and a diamond plate with its border. */
  warnSign(k) {
    k.lathe([0, 0, 0], [0, 1, 0], [[0.05, 0], [0.05, 2.7]], 6, S.STEEL, false, true);
    k.box([0, 0.04, 0], [0.4, 0.08, 0.4], S.RUBBER, 0, 0.02);
    k.box([0, 2.5, 0.05], [0.66, 0.66, 0.03], S.DARK, 0, 0.01, 0);
    const m = M(0, 2.5, 0.07, 0, 0, Math.PI / 4);
    k.extrude([[-0.29, -0.29], [0.29, -0.29], [0.29, 0.29], [-0.29, 0.29]], 0.02, m, S.YELLOW, S.DARK);
    k.extrude([[-0.33, -0.33], [0.33, -0.33], [0.33, 0.33], [-0.33, 0.33]], 0.02, M(0, 2.5, 0.055, 0, 0, Math.PI / 4), S.DARK);
    k.box([0, 2.55, 0.085], [0.06, 0.26, 0.01], S.DARK, 0, 0);
    k.box([0, 2.36, 0.085], [0.06, 0.06, 0.01], S.DARK, 0, 0);
  },

  /** Shop awning, 4 m: sloping fabric over a steel frame (paint = fabric colour), a valance with scallops. */
  awning(k) {
    k.extrude([[0, 0], [1.3, -0.5], [1.3, -0.45], [0, 0.05]], 4.0, M(0, 0, 0, -Math.PI / 2), S.PAINT, S.PAINT);
    for (let i = 0; i < 8; i++) k.box([-1.75 + i * 0.5, -0.62, 1.32], [0.46, 0.22, 0.02], i % 2 ? S.PAINT : S.WHITE, 0, 0.005);
    for (const x of [-1.95, 1.95]) k.tube([x, 0.02, 0.02], [x, -0.48, 1.28], 0.02, 4, S.STEEL);
  },

  /** Antenna / radio mast with guy collar and red aviation lights. */
  mast(k) {
    for (const [x, z] of [[0, 0.35], [-0.3, -0.18], [0.3, -0.18]] as const) k.tube([x, 0, z], [x * 0.3, 12, z * 0.3], 0.04, 4, S.STEEL);
    for (let y = 1; y < 12; y += 1.2) {
      const s = 1 - (y / 12) * 0.7;
      k.tube([0, y, 0.35 * s], [-0.3 * s, y, -0.18 * s], 0.015, 3, S.STEEL);
      k.tube([-0.3 * s, y, -0.18 * s], [0.3 * s, y, -0.18 * s], 0.015, 3, S.STEEL);
      k.tube([0.3 * s, y, -0.18 * s], [0, y, 0.35 * s], 0.015, 3, S.STEEL);
    }
    k.tube([0, 12, 0], [0, 15, 0], 0.03, 4, S.STEEL);
    for (const y of [6, 15]) k.box([0, y + 0.1, 0], [0.16, 0.16, 0.16], S.TAIL, 0, 0.03);
  },
};
