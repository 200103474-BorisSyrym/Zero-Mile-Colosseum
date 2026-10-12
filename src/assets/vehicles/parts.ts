import * as THREE from 'three';
import { S } from '../atlas';
import type { MeshKit, V3 } from '../meshkit';

/** Add-on parts: what gives each vehicle class its identity. All in car space (z forward, y up). */

const M = (x: number, y: number, z: number, ry = 0, rx = 0, rz = 0) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')), new THREE.Vector3(1, 1, 1));

/** Rear wing on two struts: an airfoil section extruded across the car. */
export function wing(k: MeshKit, z: number, y: number, span: number, chord: number, surf = S.PAINT2, endplates = true) {
  const t = chord;
  const foil: [number, number][] = [[-t * 0.5, 0], [-t * 0.2, t * 0.09], [t * 0.3, t * 0.07], [t * 0.5, t * 0.01], [t * 0.5, -t * 0.02], [-t * 0.45, -t * 0.03]];
  // outline is in (z, y); extrude along x
  k.extrude(foil.map(([zz, yy]) => [zz, yy] as [number, number]), span, M(0, y, z, Math.PI / 2), surf);
  for (const side of [-1, 1]) {
    k.box([side * span * 0.3, y - 0.12, z - t * 0.1], [0.05, 0.24, t * 0.4], S.TRIM, 0, 0.015);
    if (endplates) k.box([side * (span / 2 + 0.015), y + 0.02, z], [0.03, 0.16, t * 1.05], surf, 0, 0.01);
  }
}

/** Roll cage over the cabin: hoops and side bars. */
export function cage(k: MeshKit, zA: number, zB: number, y: number, hw: number, h: number) {
  for (const z of [zA, zB]) {
    for (const side of [-1, 1]) k.tube([side * hw, y, z], [side * hw * 0.85, y + h, z], 0.04, 6, S.TRIM);
    k.tube([-hw * 0.85, y + h, z], [hw * 0.85, y + h, z], 0.04, 6, S.TRIM);
  }
  for (const side of [-1, 1]) k.tube([side * hw * 0.85, y + h, zA], [side * hw * 0.85, y + h, zB], 0.035, 6, S.TRIM);
  k.tube([-hw * 0.85, y + h, zA], [hw * 0.85, y + h, zB], 0.03, 6, S.TRIM);
}

/**
 * Ram plow: a curved steel blade (concave face forward, curling back at the top), braced by ribs and two push arms,
 * with a glowing cutting edge and bolted wear strips across the face.
 */
export function plow(k: MeshKit, z: number, y: number, w: number, h: number, surf = S.CHROME) {
  // blade section in (forward, up): an arc from the cutting edge up and back, 6 cm thick
  const n = 7, arc: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, a = t * 1.25;
    arc.push([0.5 - Math.sin(a) * 0.16 - t * 0.12, Math.sin((t * Math.PI) / 2) * h]);
  }
  const back = [...arc].reverse().map(([f, u]) => [f - 0.07, u] as [number, number]);
  k.extrude([...arc, ...back], w, M(0, y, z, -Math.PI / 2), surf, S.TRIM);
  // ribs behind the blade, push arms to the chassis
  for (let i = -2; i <= 2; i++) k.box([i * w * 0.21, y + h * 0.42, z + 0.2], [0.06, h * 0.7, 0.26], S.TRIM, 0, 0.015);
  for (const side of [-1, 1]) k.tube([side * w * 0.3, y + h * 0.3, z + 0.18], [side * w * 0.26, y + h * 0.25, z - 0.25], 0.055, 8, S.UNDER);
  // wear strips across the face and the cutting edge
  for (const t of [0.35, 0.65]) k.box([0, y + h * t, z + 0.5 - Math.sin(t * 1.25) * 0.16 - t * 0.12 + 0.02], [w * 0.98, 0.035, 0.03], S.TRIM, 0, 0.008, -0.3);
  k.box([0, y + 0.03, z + 0.47], [w * 1.02, 0.06, 0.08], S.ACCENT, 0, 0.02);
}

/** Light bar (police / utility): a housing with lenses; `ab` picks the lens surfaces. */
export function lightbar(k: MeshKit, z: number, y: number, w: number, a = S.TAIL, b = S.HEAD) {
  k.box([0, y, z], [w, 0.1, 0.32], S.TRIM, 0, 0.03);
  for (const side of [-1, 1]) k.box([side * w * 0.25, y + 0.07, z], [w * 0.46, 0.08, 0.26], side < 0 ? a : b, 0, 0.03);
  for (const side of [-1, 1]) k.box([side * w * 0.35, y - 0.06, z], [0.06, 0.06, 0.06], S.TRIM, 0, 0.01);
}

/** Gun turret: ring, rotating housing, twin barrels. */
export function turret(k: MeshKit, z: number, y: number) {
  k.lathe([0, y, z], [0, 1, 0], [[0.42, 0], [0.42, 0.08], [0.36, 0.12]], 14, S.TRIM, false, true);
  k.box([0, y + 0.24, z], [0.6, 0.26, 0.7], S.PAINT2, 0, 0.06);
  for (const side of [-1, 1]) k.tube([side * 0.12, y + 0.27, z + 0.3], [side * 0.12, y + 0.27, z + 1.15], 0.045, 8, S.CHROME, true);
  k.box([0, y + 0.4, z - 0.1], [0.3, 0.06, 0.3], S.ACCENT, 0, 0.02);
}

/** EMP rig: a dish, emitter coils, antennas and equipment boxes. */
export function empRig(k: MeshKit, z: number, y: number, w: number) {
  k.box([0, y + 0.08, z], [w * 0.85, 0.12, 2.0], S.TRIM, 0, 0.03);
  k.lathe([0, y + 0.18, z - 0.4], [0, 0.6, 0.8], [[0.05, 0], [0.55, 0.12], [0.62, 0.2], [0.6, 0.22]], 16, S.CHROME);
  k.tube([0, y + 0.18, z - 0.4], [0, y + 0.55, z - 0.15], 0.03, 6, S.TRIM);
  for (const zz of [z + 0.55, z + 0.9]) {
    k.lathe([0, y + 0.14, zz], [0, 1, 0], [[0.16, 0], [0.16, 0.16], [0.2, 0.18], [0.2, 0.24], [0.12, 0.3]], 12, S.ACCENT, false, true);
  }
  for (const side of [-1, 1]) {
    k.tube([side * w * 0.36, y + 0.1, z - 0.9], [side * w * 0.36, y + 1.1, z - 0.95], 0.02, 5, S.TRIM);
    k.box([side * w * 0.3, y + 0.24, z + 0.1], [0.34, 0.26, 0.5], S.PAINT2, 0, 0.03);
  }
}

/** Side armour plates bolted along the doors. */
export function sideArmor(k: MeshKit, hw: number, y0: number, y1: number, z0: number, z1: number) {
  for (const side of [-1, 1]) {
    k.box([side * (hw + 0.05), (y0 + y1) / 2, (z0 + z1) / 2], [0.07, y1 - y0, z1 - z0], S.PAINT2, 0, 0.025);
    for (let z = z0 + 0.25; z < z1 - 0.1; z += 0.45) k.box([side * (hw + 0.1), y1 - 0.05, z], [0.03, 0.04, 0.04], S.CHROME, 0, 0.005);
  }
}

/** Hood scoop / roof scoop. */
export function scoop(k: MeshKit, z: number, y: number, w: number, len: number) {
  const prof: [number, number][] = [[-len / 2, 0], [len / 2, 0], [len / 2, 0.14], [len * 0.1, 0.16], [-len / 2, 0.02]];
  k.extrude(prof, w, M(0, y, z, -Math.PI / 2), S.PAINT, S.PAINT);
  k.box([0, y + 0.08, z + len / 2 + 0.005], [w * 0.8, 0.09, 0.02], S.GRILLE, 0, 0.005);
}

/** Exhaust stacks behind a truck cab. */
export function stacks(k: MeshKit, z: number, y: number, x: number, h: number) {
  for (const side of [-1, 1]) {
    k.tube([side * x, y, z], [side * x, y + h, z], 0.11, 10, S.CHROME);
    k.lathe([side * x, y + h, z], [0, 1, 0], [[0.11, 0], [0.13, 0.08], [0.13, 0.12]], 10, S.CHROME);
    k.tube([side * x, y + h * 0.4, z], [side * x, y + h * 0.7, z], 0.14, 10, S.TRIM);
  }
}

/** Spare wheel on a rear door or rack. */
export function spare(k: MeshKit, c: V3, r: number, axis: V3) {
  k.lathe(c, axis, [[r * 0.6, -0.11], [r, -0.1], [r, 0.1], [r * 0.6, 0.11]], 16, S.RUBBER, false, true);
}

/** Roof rack / ladder rack. */
export function rack(k: MeshKit, z: number, y: number, w: number, len: number, rails = 4) {
  for (const side of [-1, 1]) k.tube([side * w / 2, y, z - len / 2], [side * w / 2, y, z + len / 2], 0.025, 6, S.CHROME);
  for (let i = 0; i < rails; i++) {
    const zz = z - len / 2 + (len * (i + 0.5)) / rails;
    k.tube([-w / 2, y, zz], [w / 2, y, zz], 0.02, 6, S.CHROME);
  }
  for (const side of [-1, 1]) for (const zz of [z - len / 2, z + len / 2]) k.box([side * w / 2, y - 0.05, zz], [0.05, 0.1, 0.05], S.TRIM, 0, 0.01);
}

/** Barrel (bomber cargo). */
export function barrel(k: MeshKit, c: V3, surf: number) {
  k.lathe(c, [0, 1, 0], [[0.2, 0], [0.22, 0.05], [0.22, 0.25], [0.2, 0.28], [0.22, 0.31], [0.22, 0.52], [0.2, 0.56]], 12, surf, false, true);
}

/** Bumper guard (push bar). */
export function pushbar(k: MeshKit, z: number, y: number, w: number) {
  for (const side of [-1, 1]) k.tube([side * w * 0.3, y - 0.15, z], [side * w * 0.3, y + 0.35, z + 0.04], 0.05, 8, S.TRIM);
  k.tube([-w * 0.36, y + 0.3, z + 0.04], [w * 0.36, y + 0.3, z + 0.04], 0.045, 8, S.TRIM);
  k.tube([-w * 0.36, y, z + 0.02], [w * 0.36, y, z + 0.02], 0.045, 8, S.TRIM);
}

/** Fins rising from the rear deck. */
export function fins(k: MeshKit, z: number, y: number, x: number, len: number, h: number) {
  for (const side of [-1, 1]) {
    const prof: [number, number][] = [[-len / 2, 0], [len / 2, 0], [-len * 0.2, h], [-len / 2, h * 0.9]];
    k.extrude(prof, 0.05, M(side * x, y, z, -Math.PI / 2), S.PAINT, S.PAINT);
  }
}

/** Box with ribs: a truck body / container. */
export function cargoBox(k: MeshKit, c: V3, size: V3, surf: number, ribs = true, doors = true) {
  k.box(c, size, surf, 0, 0.06);
  if (ribs) {
    for (let z = c[2] - size[2] / 2 + 0.4; z < c[2] + size[2] / 2 - 0.2; z += 0.6) {
      for (const side of [-1, 1]) k.box([c[0] + side * (size[0] / 2 + 0.012), c[1], z], [0.03, size[1] * 0.96, 0.06], S.TRIM, 0, 0.008);
    }
    k.box([c[0], c[1] + size[1] / 2 - 0.06, c[2]], [size[0] + 0.03, 0.08, size[2] + 0.02], S.TRIM, 0, 0.01);
  }
  if (doors) {
    const zb = c[2] - size[2] / 2 - 0.012;
    k.box([c[0], c[1], zb], [0.03, size[1] * 0.9, 0.02], S.TRIM, 0, 0);
    for (const side of [-1, 1]) for (const yy of [0.25, -0.25]) k.box([c[0] + side * size[0] * 0.2, c[1] + yy * size[1], zb - 0.01], [0.04, size[1] * 0.4, 0.04], S.CHROME, 0, 0.01);
  }
}

/** Truck chassis: rails, fuel tanks, steps, mudflaps, under-run guard. */
export function chassis(k: MeshKit, z0: number, z1: number, y: number, w: number) {
  for (const side of [-1, 1]) k.box([side * w * 0.32, y, (z0 + z1) / 2], [0.18, 0.26, z1 - z0], S.UNDER, 0, 0.02);
  for (const side of [-1, 1]) k.lathe([side * (w / 2 - 0.3), y + 0.05, z1 - 1.0], [0, 0, -1], [[0.28, 0], [0.3, 0.05], [0.3, 0.9], [0.28, 0.95]], 12, S.CHROME, true, true);
  k.box([0, y - 0.1, z0 - 0.04], [w * 0.95, 0.12, 0.1], S.ACCENT, 0, 0.02);
}

/** Tank (tanker trailer): a long barrel with domed ends, walkway and ladder. */
export function tank(k: MeshKit, z0: number, z1: number, y: number, r: number) {
  const len = z1 - z0;
  k.lathe([0, y, z0], [0, 0, 1], [[0.05, -0.2], [r * 0.7, -0.1], [r, 0.05], [r, len - 0.05], [r * 0.7, len + 0.1], [0.05, len + 0.2]], 18, S.CHROME);
  for (const zz of [z0 + 0.6, (z0 + z1) / 2, z1 - 0.6]) k.lathe([0, y, zz], [0, 0, 1], [[r + 0.03, 0], [r + 0.03, 0.1]], 18, S.TRIM);
  k.box([0, y + r + 0.06, (z0 + z1) / 2], [0.5, 0.05, len * 0.8], S.TRIM, 0, 0.01);
  for (const side of [-1, 1]) k.tube([side * 0.28, y + r + 0.06, z0 + 0.5], [side * 0.28, y + r + 0.06, z1 - 0.5], 0.02, 5, S.CHROME);
  k.box([0, y + r * 0.2, z0 - 0.2], [0.4, r * 1.2, 0.05], S.TRIM, 0, 0.01);
}
