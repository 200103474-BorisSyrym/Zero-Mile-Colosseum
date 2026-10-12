import * as THREE from 'three';
import { S } from '../atlas';
import { MeshKit, type V3 } from '../meshkit';

/**
 * Industrial kit: the Industrial Ring's vocabulary — storage tanks with stairs and rings, silo batteries, cooling
 * towers, banded stacks with aviation lights, refinery columns with platforms, pipe racks and pipe bridges, gantry
 * and tower cranes. Each piece is a cached geometry in its own space (origin on the ground, +Y up); pipe racks and
 * bridges run along X.
 */
export type IndustryName = 'tank' | 'tankSmall' | 'silos' | 'coolingTower' | 'stack' | 'column' | 'pipeRack' | 'pipeBridge' | 'gantryCrane' | 'towerCrane' | 'flare' | 'hopper';

const cache = new Map<string, THREE.BufferGeometry>();
export function industry(name: IndustryName): THREE.BufferGeometry {
  let g = cache.get(name);
  if (!g) {
    const k = new MeshKit(1);
    BUILD[name](k);
    g = k.build(0.6);
    cache.set(name, g);
  }
  return g;
}
export function industryStats() {
  return (Object.keys(BUILD) as IndustryName[]).map((n) => ({ name: n, tris: industry(n).getAttribute('position').count / 3 }));
}

/** Lattice between two points: two chords and zig-zag diagonals, in the plane given by `up`. */
function lattice(k: MeshKit, a: V3, b: V3, up: V3, depth: number, n: number, r: number, surf = S.STEEL) {
  const top = (p: V3): V3 => [p[0] + up[0] * depth, p[1] + up[1] * depth, p[2] + up[2] * depth];
  k.tube(a, b, r * 1.4, 5, surf);
  k.tube(top(a), top(b), r * 1.4, 5, surf);
  for (let i = 0; i < n; i++) {
    const t0 = i / n, t1 = (i + 1) / n;
    const p0: V3 = [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0, a[2] + (b[2] - a[2]) * t0];
    const p1: V3 = [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1, a[2] + (b[2] - a[2]) * t1];
    k.tube(i % 2 ? p0 : top(p0), i % 2 ? top(p1) : p1, r, 4, surf);
    k.tube(p1, top(p1), r, 4, surf);
  }
}

/** Ring of railing around a cylinder top. */
function ringRail(k: MeshKit, c: V3, r: number, h: number, n = 16) {
  k.lathe([c[0], c[1] + h, c[2]], [0, 1, 0], [[r, 0], [r, 0.05]], n, S.STEEL);
  k.lathe([c[0], c[1] + h * 0.5, c[2]], [0, 1, 0], [[r, 0], [r, 0.04]], n, S.STEEL);
  for (let i = 0; i < n; i += 2) {
    const a = (i / n) * Math.PI * 2;
    k.tube([c[0] + Math.cos(a) * r, c[1], c[2] + Math.sin(a) * r], [c[0] + Math.cos(a) * r, c[1] + h, c[2] + Math.sin(a) * r], 0.025, 4, S.STEEL);
  }
}

const BUILD: Record<IndustryName, (k: MeshKit) => void> = {
  /** Storage tank, 22 m across: shell courses, wind girder, roof, spiral stair, top rail, bund wall. */
  tank(k) {
    const R = 11, H = 14;
    k.lathe([0, 0, 0], [0, 1, 0], [[R, 0], [R, H], [R * 0.98, H + 0.3], [R * 0.4, H + 1.6], [0.5, H + 2.0]], 28, S.WHITE, false, true);
    for (let y = 2.4; y < H; y += 2.4) k.lathe([0, y, 0], [0, 1, 0], [[R + 0.04, 0], [R + 0.04, 0.12]], 28, S.STEEL);
    k.lathe([0, H - 1.2, 0], [0, 1, 0], [[R + 0.05, 0], [R + 0.7, 0.05], [R + 0.7, 0.2], [R + 0.05, 0.25]], 28, S.STEEL);
    // spiral stair up the shell
    const steps = 22;
    for (let i = 0; i < steps; i++) {
      const a0 = -0.4 + (i / steps) * 1.6, a1 = -0.4 + ((i + 1) / steps) * 1.6;
      const y0 = (i / steps) * H, y1 = ((i + 1) / steps) * H;
      const p0: V3 = [Math.cos(a0) * (R + 0.6), y0, Math.sin(a0) * (R + 0.6)], p1: V3 = [Math.cos(a1) * (R + 0.6), y1, Math.sin(a1) * (R + 0.6)];
      k.tube(p0, p1, 0.06, 4, S.STEEL);
      k.tube([p0[0], p0[1] + 1, p0[2]], [p1[0], p1[1] + 1, p1[2]], 0.03, 4, S.STEEL);
    }
    ringRail(k, [0, H + 0.3, 0], R * 0.97, 1.0, 24);
    k.lathe([0, 0, 0], [0, 1, 0], [[R + 4, 0], [R + 4, 1.2], [R + 4.4, 1.2], [R + 4.4, 0]], 28, S.CONCRETE);
    k.box([R + 0.3, 1.2, 0], [1.0, 1.2, 1.4], S.STEEL, 0, 0.05);
    k.tube([R + 0.8, 0.8, 0], [R + 4.6, 0.8, 0], 0.3, 8, S.STEEL);
    k.box([0, H + 2.1, 0], [0.4, 0.4, 0.4], S.TAIL, 0, 0.05);
  },

  /** Small tank on saddles, horizontal. */
  tankSmall(k) {
    k.lathe([-4, 2.1, 0], [1, 0, 0], [[0.3, -0.5], [1.4, -0.25], [1.8, 0.1], [1.8, 7.9], [1.4, 8.25], [0.3, 8.5]], 16, S.WHITE);
    for (const x of [-2.5, 2.5]) k.extrude([[-1.5, 0], [1.5, 0], [1.5, 0.6], [0.8, 1.2], [-0.8, 1.2], [-1.5, 0.6]], 0.4, new THREE.Matrix4().makeTranslation(x, 0, 0).multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2)), S.CONCRETE);
    k.box([0, 4.0, 0], [1.0, 0.1, 1.0], S.GRILLE, 0, 0.01);
    k.lathe([0, 3.9, 0], [0, 1, 0], [[0.3, 0], [0.3, 0.6]], 8, S.STEEL, false, true);
  },

  /** Battery of four silos on a steel frame, a conveyor gallery on top. */
  silos(k) {
    const R = 3.2, H = 22, legs = 6;
    for (const x of [-3.5, 3.5]) for (const z of [-3.5, 3.5]) {
      k.lathe([x, legs, z], [0, 1, 0], [[0.4, -3.2], [R, 0], [R, H], [R * 0.6, H + 1.4], [0.6, H + 1.8]], 14, S.STEEL, true, true);
      for (let y = legs + 3; y < legs + H; y += 3.5) k.lathe([x, y, z], [0, 1, 0], [[R + 0.04, 0], [R + 0.04, 0.15]], 14, S.DARK);
    }
    for (const x of [-6.5, -0.5, 0.5, 6.5]) for (const z of [-6.5, 6.5]) k.box([x, legs / 2, z], [0.4, legs, 0.4], S.DARK, 0, 0.02);
    k.box([0, legs - 0.2, 0], [14, 0.4, 14], S.DARK, 0, 0.05);
    k.box([0, legs + H + 2.6, 0], [16, 2.4, 3], S.PAINT, 0, 0.1);
    for (let x = -7; x <= 7; x += 2) k.box([x, legs + H + 2.6, 1.51], [1.2, 0.6, 0.02], S.WINDOW, 0, 0.01);
    lattice(k, [8, legs + H + 1.8, 0], [24, 3, 0], [0, 1.6, 0], 1, 8, 0.08);
  },

  /** Hyperbolic cooling tower, 60 m, on raking legs. */
  coolingTower(k) {
    const prof: [number, number][] = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10, y = 6 + t * 54;
      const r = 14 + 12 * Math.pow(Math.abs(t - 0.72) / 0.72, 1.6) * (t < 0.72 ? 1 : 0.35);
      prof.push([r, y]);
    }
    k.lathe([0, 0, 0], [0, 1, 0], prof, 28, S.CONCRETE);
    k.lathe([0, 0, 0], [0, 1, 0], prof.map(([r, y]): [number, number] => [r - 0.5, y]).reverse(), 28, S.DARK, false, false, true);
    k.lathe([0, 59.6, 0], [0, 1, 0], [[prof[10][0] - 0.5, 0], [prof[10][0] + 0.3, 0.2], [prof[10][0] + 0.3, 0.6], [prof[10][0] - 0.5, 0.6]], 28, S.CONCRETE);
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2, b = ((i + 1) / 24) * Math.PI * 2;
      const r0 = prof[0][0];
      k.tube([Math.cos(a) * (r0 + 1.4), 0, Math.sin(a) * (r0 + 1.4)], [Math.cos(b) * r0, 6.2, Math.sin(b) * r0], 0.35, 4, S.CONCRETE);
    }
    k.lathe([0, 0, 0], [0, 1, 0], [[prof[0][0] + 3, 0], [prof[0][0] + 3, 1.2]], 28, S.CONCRETE);
    for (const a of [0, Math.PI * 0.5, Math.PI, Math.PI * 1.5]) k.box([Math.cos(a) * (prof[10][0] + 0.2), 59.9, Math.sin(a) * (prof[10][0] + 0.2)], [0.5, 0.5, 0.5], S.TAIL, -a, 0.05);
  },

  /** Industrial chimney, 70 m: tapered, banded red/white at the top, gallery, aviation lights. */
  stack(k) {
    const r0 = 3.2, r1 = 1.9, H = 70;
    const r = (y: number) => r0 + (r1 - r0) * (y / H);
    k.lathe([0, 0, 0], [0, 1, 0], [[r0 + 0.6, 0], [r0 + 0.6, 2.5], [r0, 3]], 16, S.CONCRETE);
    k.lathe([0, 3, 0], [0, 1, 0], [[r(3), 0], [r(52), 49]], 16, S.CONCRETE);
    const bands = [52, 55, 58, 61, 64, 67, 70];
    for (let i = 0; i < bands.length - 1; i++) k.lathe([0, bands[i], 0], [0, 1, 0], [[r(bands[i]), 0], [r(bands[i + 1]), bands[i + 1] - bands[i]]], 16, i % 2 ? S.WHITE : S.RED);
    k.lathe([0, H, 0], [0, 1, 0], [[r1, 0], [r1 - 0.3, 0.3], [r1 - 0.5, 0.3]], 16, S.DARK);
    for (const y of [40, 66]) {
      k.lathe([0, y, 0], [0, 1, 0], [[r(y) + 1.2, 0], [r(y) + 1.2, 0.15]], 16, S.GRILLE, true);
      ringRail(k, [0, y, 0], r(y) + 1.2, 1.0, 16);
    }
    for (let y = 3; y < H; y += 0.6) k.box([r(y) + 0.1, y, 0], [0.2, 0.04, 0.5], S.STEEL, 0, 0);
    for (const y of [36, 69]) for (const a of [0, Math.PI]) k.box([Math.cos(a) * (r(y) + 0.2), y, Math.sin(a) * (r(y) + 0.2)], [0.45, 0.45, 0.45], S.TAIL, 0, 0.05);
  },

  /** Refinery column, 42 m, with platforms, ladders and a pipe running down it. */
  column(k) {
    const R = 1.6, H = 42;
    k.box([0, 0.6, 0], [4.4, 1.2, 4.4], S.CONCRETE, 0, 0.05);
    k.lathe([0, 1.2, 0], [0, 1, 0], [[R, 0], [R, H - 2], [R * 0.6, H - 0.8], [0.3, H]], 14, S.STEEL);
    for (const y of [9, 18, 27, 36]) {
      k.lathe([0, y, 0], [0, 1, 0], [[R, 0], [R + 1.4, 0], [R + 1.4, 0.12], [R, 0.12]], 14, S.GRILLE);
      ringRail(k, [0, y, 0], R + 1.4, 1.0, 14);
    }
    k.tube([R + 0.45, 1.2, 0.3], [R + 0.45, H - 3, 0.3], 0.18, 6, S.RUST);
    k.tube([R + 0.45, H - 3, 0.3], [0.5, H - 1.5, 0.3], 0.18, 6, S.RUST);
    for (const s of [-0.25, 0.25]) k.tube([-R - 0.3, 1.2, s], [-R - 0.3, 37, s], 0.03, 4, S.STEEL);
    for (let y = 2; y < 37; y += 0.4) k.tube([-R - 0.3, y, -0.25], [-R - 0.3, y, 0.25], 0.02, 3, S.STEEL);
    k.box([0, H + 0.2, 0], [0.4, 0.4, 0.4], S.TAIL, 0, 0.05);
  },

  /** Pipe rack, 24 m along X: steel bents every 6 m, four pipes on two levels, a cable tray. */
  pipeRack(k) {
    const L = 24, Wd = 4;
    for (let x = -L / 2; x <= L / 2 + 0.01; x += 6) {
      for (const z of [-Wd / 2, Wd / 2]) {
        k.box([x, 3.5, z], [0.3, 7, 0.3], S.DARK, 0, 0.02);
        k.box([x, 0.15, z], [0.7, 0.3, 0.7], S.CONCRETE, 0, 0.03);
      }
      for (const y of [4.2, 6.6]) k.box([x, y, 0], [0.3, 0.3, Wd + 0.3], S.DARK, 0, 0.02);
    }
    for (const [y, z, r, s] of [[4.65, -1.2, 0.4, S.RUST], [4.6, 0, 0.35, S.STEEL], [4.55, 1.2, 0.25, S.WHITE], [7.0, -0.8, 0.35, S.STEEL], [6.95, 0.8, 0.25, S.YELLOW]] as const) {
      k.lathe([-L / 2 - 0.3, y, z], [1, 0, 0], [[r, 0], [r, L + 0.6]], 8, s);
      k.lathe([-0.08, y, z], [1, 0, 0], [[r + 0.06, 0], [r + 0.06, 0.16]], 8, S.DARK);
    }
    k.box([0, 7.6, 1.6], [L, 0.1, 0.6], S.GRILLE, 0, 0.01);
  },

  /** Pipe bridge over the road (span 36 m along Z): lattice towers each side, twin truss, pipes and a lit walkway. */
  pipeBridge(k) {
    const span = 36, H = 12, tw = 2.4;
    for (const z of [-span / 2, span / 2]) {
      for (const [x, zz] of [[-tw / 2, -tw / 2], [tw / 2, -tw / 2], [-tw / 2, tw / 2], [tw / 2, tw / 2]] as const) k.tube([x, 0, z + zz], [x, H + 2.4, z + zz], 0.16, 5, S.RUST);
      for (let y = 1.5; y < H; y += 2.6) {
        k.tube([-tw / 2, y, z - tw / 2], [tw / 2, y + 2.6, z - tw / 2], 0.07, 4, S.RUST);
        k.tube([-tw / 2, y, z + tw / 2], [tw / 2, y + 2.6, z + tw / 2], 0.07, 4, S.RUST);
        k.tube([-tw / 2, y + 1.3, z - tw / 2], [-tw / 2, y + 2.6, z + tw / 2], 0.07, 4, S.RUST);
        k.tube([tw / 2, y + 1.3, z - tw / 2], [tw / 2, y + 2.6, z + tw / 2], 0.07, 4, S.RUST);
      }
      k.box([0, 0.3, z], [tw + 1, 0.6, tw + 1], S.CONCRETE, 0, 0.05);
    }
    for (const x of [-tw / 2, tw / 2]) lattice(k, [x, H, -span / 2], [x, H, span / 2], [0, 1, 0], 2.4, 12, 0.07, S.RUST);
    for (const [x, y, r, s] of [[-0.6, H + 0.55, 0.45, S.RUST], [0.5, H + 0.5, 0.38, S.STEEL], [0.0, H + 1.6, 0.3, S.WHITE]] as const) {
      k.lathe([x, y, -span / 2 - 2], [0, 0, 1], [[r, 0], [r, span + 4]], 10, s);
      for (let z = -span / 2; z <= span / 2; z += 6) k.lathe([x, y, z - 0.08], [0, 0, 1], [[r + 0.06, 0], [r + 0.06, 0.16]], 10, S.DARK);
    }
    k.box([0, H - 0.05, 0], [tw, 0.1, span], S.GRILLE, 0, 0.01);
    for (let z = -span / 2 + 4; z < span / 2; z += 7) {
      k.box([0, H - 0.25, z], [0.5, 0.15, 0.5], S.DARK, 0, 0.02);
      k.box([0, H - 0.33, z], [0.4, 0.02, 0.4], S.HEAD, 0, 0.01);
    }
    for (let z = -span / 2; z <= span / 2; z += 1.2) k.box([0, H - 0.6, z], [tw + 0.4, 0.1, 0.5], z % 2.4 < 1.2 ? S.YELLOW : S.DARK, 0, 0);
  },

  /** Gantry crane over a container yard: two A-frame legs on rails, girder, trolley, hoist. */
  gantryCrane(k) {
    const span = 30, H = 22;
    for (const x of [-span / 2, span / 2]) {
      for (const z of [-5, 5]) k.extrude([[-0.5, 0], [0.5, 0], [0.4, H], [-0.4, H]], 1.0, new THREE.Matrix4().makeTranslation(x, 0, z * 0.85), S.YELLOW);
      k.box([x, 0.6, 0], [1.6, 1.2, 12], S.YELLOW, 0, 0.08);
      k.box([x, H * 0.45, 0], [0.8, 0.8, 8.5], S.YELLOW, 0, 0.05);
      for (const z of [-5.5, 5.5]) k.box([x, 0.25, z], [1.2, 0.5, 1.2], S.DARK, 0, 0.05);
    }
    for (const z of [-4.25, 4.25]) k.box([0, H + 1, z], [span + 6, 2.0, 1.2], S.YELLOW, 0, 0.08);
    k.box([4, H + 2.6, 0], [4, 1.4, 9.5], S.PAINT, 0, 0.1);
    k.box([2, H - 0.6, -3.5], [2, 2.2, 2], S.YELLOW, 0, 0.08);
    k.box([2.9, H - 0.6, -3.5], [0.2, 1.6, 1.8], S.GLASS, 0, 0.02);
    for (const z of [-0.6, 0.6]) k.tube([4, H, z], [4, 8, z], 0.03, 4, S.STEEL);
    k.box([4, 7.6, 0], [3, 0.6, 2.4], S.YELLOW, 0, 0.05);
    for (const x of [-span / 2 - 3, span / 2 + 3]) k.box([x, H + 2.2, 0], [0.4, 0.4, 0.4], S.TAIL, 0, 0.05);
  },

  /** Tower crane, 55 m: lattice mast, slewing unit and cab, jib and counter-jib with ballast, hook. */
  towerCrane(k) {
    const H = 50, m = 1.0;
    for (const [x, z] of [[-m, -m], [m, -m], [-m, m], [m, m]] as const) k.tube([x, 0, z], [x, H, z], 0.09, 4, S.YELLOW);
    for (let y = 0; y < H; y += 2) {
      k.tube([-m, y, -m], [m, y + 2, -m], 0.04, 3, S.YELLOW);
      k.tube([m, y, m], [-m, y + 2, m], 0.04, 3, S.YELLOW);
      k.tube([-m, y, m], [-m, y + 2, -m], 0.04, 3, S.YELLOW);
      k.tube([m, y, -m], [m, y + 2, m], 0.04, 3, S.YELLOW);
    }
    k.box([0, 0.5, 0], [5, 1, 5], S.CONCRETE, 0, 0.05);
    k.box([0, H + 0.8, 0], [2.6, 1.6, 2.6], S.YELLOW, 0, 0.08);
    k.box([1.6, H + 0.6, 1.6], [1.3, 1.8, 1.4], S.WHITE, 0, 0.08);
    k.box([2.26, H + 0.8, 1.6], [0.05, 1.0, 1.1], S.GLASS, 0, 0.01);
    // jib along +x, counter-jib along -x
    const jl = 40, cj = 13;
    for (const z of [-0.8, 0.8]) k.tube([0, H + 1.6, z], [jl, H + 1.6, z * 0.4], 0.08, 4, S.YELLOW);
    k.tube([0, H + 3.4, 0], [jl, H + 1.9, 0], 0.08, 4, S.YELLOW);
    for (let x = 0; x < jl; x += 2) {
      const yt = H + 3.4 - (x / jl) * 1.5;
      k.tube([x, H + 1.6, -0.8 * (1 - (x / jl) * 0.6)], [x + 2, yt, 0], 0.035, 3, S.YELLOW);
      k.tube([x, H + 1.6, 0.8 * (1 - (x / jl) * 0.6)], [x + 2, yt, 0], 0.035, 3, S.YELLOW);
    }
    for (const z of [-0.9, 0.9]) k.tube([0, H + 1.6, z], [-cj, H + 1.6, z], 0.08, 4, S.YELLOW);
    k.box([-cj + 2, H + 1.0, 0], [3.2, 2.0, 2.0], S.CONCRETE, 0, 0.05);
    k.box([0, H + 6, 0], [0.8, 8, 0.8], S.YELLOW, 0, 0.03);
    k.tube([0, H + 10, 0], [jl * 0.7, H + 1.8, 0], 0.03, 3, S.STEEL);
    k.tube([0, H + 10, 0], [-cj, H + 1.8, 0], 0.03, 3, S.STEEL);
    k.box([24, H + 1.2, 0], [1.6, 0.6, 1.6], S.DARK, 0, 0.03);
    k.tube([24, H + 0.9, 0], [24, 18, 0], 0.025, 3, S.STEEL);
    k.box([24, 17.6, 0], [0.6, 0.8, 0.4], S.YELLOW, 0, 0.05);
    for (const x of [jl, -cj, 0]) k.box([x, H + (x === 0 ? 10.2 : 2.1), 0], [0.4, 0.4, 0.4], S.TAIL, 0, 0.05);
  },

  /** Flare stack: slim lattice-braced pipe with a tip (the flame is a glow added by the scenery). */
  flare(k) {
    k.lathe([0, 0, 0], [0, 1, 0], [[0.9, 0], [0.6, 2], [0.6, 48], [0.9, 49], [0.9, 50]], 10, S.STEEL);
    for (let y = 2; y < 46; y += 4) k.tube([2.5, y, 0], [0.6, y + 4, 0], 0.08, 4, S.STEEL);
    k.tube([2.5, 0, 0], [2.5, 46, 0], 0.12, 5, S.STEEL);
    k.lathe([0, 50, 0], [0, 1, 0], [[1.1, 0], [1.1, 0.12]], 10, S.GRILLE, true);
  },

  /** Ore hopper on legs with a chute (Industrial Ring). */
  hopper(k) {
    for (const x of [-3, 3]) for (const z of [-3, 3]) k.box([x, 5, z], [0.5, 10, 0.5], S.DARK, 0, 0.02);
    k.lathe([0, 8, 0], [0, 1, 0], [[0.8, 0], [4.4, 3.5], [4.4, 8], [4.0, 8.4]], 4, S.RUST, true, true);
    k.extrude([[0, 0], [5, -3], [5, -2.2], [0, 0.8]], 1.6, new THREE.Matrix4().makeTranslation(0, 8, 0), S.STEEL);
    for (const y of [3, 7]) for (const z of [-3, 3]) k.tube([-3, y, z], [3, y + 2.5, z], 0.08, 4, S.DARK);
  },
};
