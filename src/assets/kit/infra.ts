import * as THREE from 'three';
import { S } from '../atlas';
import { MeshKit } from '../meshkit';

/**
 * Bridge and tunnel kit. Pieces that depend on the road width are built per (rounded) width and cached.
 * Space: origin on the road centre line at road level, +Z along the road, X across it, Y up.
 */
const cache = new Map<string, THREE.BufferGeometry>();
function get(key: string, build: (k: MeshKit) => void) {
  let g = cache.get(key);
  if (!g) {
    const k = new MeshKit(1);
    build(k);
    g = k.build(0.6);
    cache.set(key, g);
  }
  return g;
}
const rw = (w: number) => Math.round(w * 2) / 2;

/** Octagonal column section, extruded vertically. */
function column(k: MeshKit, x: number, z: number, y0: number, y1: number, wx: number, wz: number, surf = S.CONCRETE) {
  const c = 0.22;
  const o: [number, number][] = [[-wx / 2 + c, -wz / 2], [wx / 2 - c, -wz / 2], [wx / 2, -wz / 2 + c], [wx / 2, wz / 2 - c], [wx / 2 - c, wz / 2], [-wx / 2 + c, wz / 2], [-wx / 2, wz / 2 - c], [-wx / 2, -wz / 2 + c]];
  // outline in x/z: extrude along local z then turn it upright
  k.extrude(o, y1 - y0, new THREE.Matrix4().makeTranslation(x, (y0 + y1) / 2, z).multiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2)), surf);
}

/**
 * Highway pier: a chamfered column flaring into a hammerhead cap, bearing pads under the deck, drain pipe.
 * `h` = height from the ground to the deck underside, `w` = deck width.
 */
export function pier(h: number, w: number) {
  return get(`pier|${Math.round(h)}|${rw(w)}`, (k) => {
    const top = -2.2;
    const capH = 2.4;
    column(k, 0, 0, top - h, top - capH - 1.6, 3.4, 2.6);
    // flare into the cap
    k.extrude([[-1.7, 0], [1.7, 0], [w * 0.36, 1.6], [-w * 0.36, 1.6]], 2.6, new THREE.Matrix4().makeTranslation(0, top - capH - 1.6, 0), S.CONCRETE);
    k.box([0, top - capH / 2, 0], [w * 0.78, capH, 2.8], S.CONCRETE, 0, 0.12);
    for (const x of [-w * 0.3, -w * 0.1, w * 0.1, w * 0.3]) k.box([x, top - 0.1, 0], [0.9, 0.2, 0.9], S.DARK, 0, 0.03);
    k.tube([1.75, top - capH, 1.0], [1.75, top - h, 1.0], 0.12, 6, S.DARK);
    k.box([0, top - h + 0.4, 0], [4.6, 0.8, 3.8], S.CONCRETE, 0, 0.06);
  });
}

/** Under-deck girders (10 m along z): two I-girders, a cross frame, the deck slab edge drip. */
export function girders(w: number) {
  return get(`girders|${rw(w)}`, (k) => {
    for (const x of [-w * 0.28, w * 0.28]) {
      k.box([x, -2.25, 0], [0.7, 0.06, 10], S.STEEL, 0, 0);
      k.box([x, -3.3, 0], [0.06, 2.1, 10], S.STEEL, 0, 0);
      k.box([x, -4.35, 0], [0.9, 0.08, 10], S.STEEL, 0, 0);
      for (const z of [-3.3, 0, 3.3]) k.box([x, -3.3, z], [0.5, 2.0, 0.04], S.STEEL, 0, 0);
    }
    k.tube([-w * 0.28, -2.4, -5], [w * 0.28, -4.3, -5], 0.08, 4, S.STEEL);
    k.tube([-w * 0.28, -4.3, -5], [w * 0.28, -2.4, -5], 0.08, 4, S.STEEL);
    k.box([0, -4.3, -5], [w * 0.56, 0.12, 0.2], S.STEEL, 0, 0);
  });
}

/**
 * Cable-stayed pylon: an H-frame straddling the road, rising 42 m, a cross-beam over the traffic, stay cables
 * fanning down to both deck edges, aviation lights.
 */
export function pylon(w: number) {
  return get(`pylon|${rw(w)}`, (k) => {
    const x = w / 2 + 1.6, H = 42;
    for (const side of [-1, 1]) {
      k.extrude([[-1.0, -1.2], [1.0, -1.2], [1.0, 1.2], [-1.0, 1.2]], 0.01, new THREE.Matrix4(), S.CONCRETE);
      column(k, side * x, 0, -8, H - 6, 2.2, 2.6);
      column(k, side * (x - 0.4), 0, H - 6, H, 1.6, 2.0);
      k.box([side * (x - 0.4), H + 0.4, 0], [0.5, 0.5, 0.5], S.TAIL, 0, 0.05);
      // stays: fan from the head down to the deck edge, both directions along the road
      for (const dir of [-1, 1]) for (let i = 0; i < 6; i++) {
        const zz = dir * (10 + i * 7);
        k.tube([side * (x - 0.4), H - 2 - i * 1.6, dir * 0.6], [side * (w / 2 + 0.5), 0.9, zz], 0.07, 4, S.WHITE);
      }
    }
    k.box([0, 14, 0], [2 * x, 2.4, 2.4], S.CONCRETE, 0, 0.12);
    k.box([0, H - 8, 0], [2 * x - 1, 1.8, 2.0], S.CONCRETE, 0, 0.1);
    for (const side of [-1, 1]) k.box([side * x * 0.5, 12.65, 0], [0.6, 0.2, 0.4], S.HEAD, 0, 0.02);
  });
}

/** Tunnel portal: the face wall around the bore, a chamfered surround, a name band (accent), wing walls. */
export function portal(w: number) {
  return get(`portal|${rw(w)}`, (k) => {
    const hw = w / 2 + 0.8, H = 7.5;
    // face wall: left, right and the lintel above the bore
    for (const side of [-1, 1]) k.box([side * (hw + 2.0), H / 2 + 1.5, 0], [4.0, H + 3, 1.6], S.CONCRETE, 0, 0.1);
    k.box([0, H + 1.7, 0], [2 * hw, 3.4, 1.6], S.CONCRETE, 0, 0.1);
    // surround: a raised frame inside the bore edge
    for (const side of [-1, 1]) k.box([side * (hw - 0.2), H / 2, 0.85], [0.6, H, 0.3], S.CONCRETE, 0, 0.06);
    k.box([0, H - 0.25, 0.85], [2 * hw, 0.5, 0.3], S.CONCRETE, 0, 0.06);
    k.box([0, H + 1.6, 0.84], [2 * hw * 0.7, 0.9, 0.06], S.ACCENT, 0, 0.02);
    k.box([0, H + 1.6, 0.81], [2 * hw * 0.72, 1.1, 0.04], S.DARK, 0, 0.02);
    // parapet and wing walls stepping down
    k.box([0, H + 3.6, -0.2], [2 * hw + 8.4, 0.5, 2.0], S.CONCRETE, 0, 0.06);
    for (const side of [-1, 1]) for (let i = 0; i < 3; i++) k.box([side * (hw + 4.6 + i * 2.6), (H + 3) * (0.8 - i * 0.22) / 2, -0.6 - i * 0.6], [2.6, (H + 3) * (0.8 - i * 0.22), 1.0], S.CONCRETE, 0, 0.06);
    // lamps over the bore
    for (const x of [-hw * 0.5, hw * 0.5]) {
      k.box([x, H + 0.15, 1.1], [0.9, 0.25, 0.35], S.DARK, 0, 0.03);
      k.box([x, H + 0.02, 1.15], [0.7, 0.02, 0.25], S.HEAD, 0, 0.01);
    }
  });
}

/** Tunnel rib (every ~12 m): wall pilasters, a ceiling beam, a pair of jet fans on alternate ribs. */
export function rib(w: number, fans: boolean) {
  return get(`rib|${rw(w)}|${fans ? 1 : 0}`, (k) => {
    const hw = w / 2 + 0.8, H = 7.5;
    for (const side of [-1, 1]) k.box([side * (hw - 0.2), H / 2, 0], [0.4, H, 0.8], S.CONCRETE, 0, 0.05);
    k.box([0, H - 0.3, 0], [2 * hw, 0.6, 0.8], S.CONCRETE, 0, 0.05);
    if (fans) {
      for (const x of [-hw * 0.4, hw * 0.4]) {
        k.lathe([x, H - 1.3, -1.6], [0, 0, 1], [[0.55, 0], [0.6, 0.15], [0.6, 3.0], [0.55, 3.2]], 12, S.STEEL);
        for (const z of [-1.6, 1.6]) k.lathe([x, H - 1.3, z], [0, 0, z > 0 ? 1 : -1], [[0.5, 0], [0.5, 0.02]], 12, S.GRILLE, false, true);
        for (const z of [-0.8, 0.8]) k.box([x, H - 0.75, z], [0.08, 0.6, 0.08], S.STEEL, 0, 0.01);
      }
    }
  });
}

/** Tunnel wall furniture (10 m along z): cable trays and a pipe, the emergency walkway kerb, a niche sign. */
export function tunnelWall(w: number, sign: boolean) {
  return get(`twall|${rw(w)}|${sign ? 1 : 0}`, (k) => {
    const hw = w / 2 + 0.8;
    for (const side of [-1, 1]) {
      for (const y of [4.6, 5.0]) k.box([side * (hw - 0.25), y, 0], [0.4, 0.06, 10], S.STEEL, 0, 0);
      k.lathe([side * (hw - 0.2), 3.6, -5], [0, 0, 1], [[0.14, 0], [0.14, 10]], 8, S.RED);
      for (const z of [-3, 2]) k.box([side * (hw - 0.15), 4.8, z], [0.3, 0.5, 0.06], S.STEEL, 0, 0);
      k.box([side * (hw - 0.5), 0.2, 0], [1.0, 0.4, 10], S.CONCRETE, 0, 0.04);
      if (sign) {
        k.box([side * (hw - 0.06), 2.6, 1], [0.04, 0.5, 1.1], S.GREEN, 0, 0.01);
        k.box([side * (hw - 0.09), 2.6, 1.2], [0.02, 0.3, 0.3], S.WHITE, 0, 0.005);
        k.box([side * (hw - 0.05), 1.3, -1], [0.12, 1.2, 0.8], S.RED, 0, 0.02);
      }
    }
  });
}

/** Bridge parapet post and rail unit (5 m), sits on the barrier line. */
export function parapet() {
  return get('parapet', (k) => {
    for (const z of [-2.5, 0]) k.box([0, 1.15, z], [0.12, 0.55, 0.12], S.STEEL, 0, 0.02);
    k.box([0, 1.42, -1.25], [0.14, 0.1, 5.0], S.STEEL, 0, 0.02);
    k.box([0, 1.18, -1.25], [0.06, 0.06, 5.0], S.STEEL, 0, 0.01);
  });
}
