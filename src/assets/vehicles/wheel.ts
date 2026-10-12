import * as THREE from 'three';
import { S } from '../atlas';
import { MeshKit } from '../meshkit';

/**
 * Wheels: a round tyre with shoulders and sidewall, a rim barrel, spokes, a hub cap and a brake disc behind them.
 * Built along +X (the spoke face looks outward on the right side; left wheels are mirrored). One atlas mesh per
 * wheel, shared by every car with the same wheel size and style.
 */
const cache = new Map<string, THREE.BufferGeometry>();

export type RimStyle = 'spoke5' | 'spoke6' | 'mesh' | 'steel' | 'heavy';

export function wheelGeometry(r: number, w: number, style: RimStyle = 'spoke5', detail: 0 | 1 | 2 = 0): THREE.BufferGeometry {
  const key = `${r.toFixed(3)}|${w.toFixed(3)}|${style}|${detail}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const segs = [22, 14, 9][detail];
  const k = new MeshKit();
  if (detail === 2) {
    // far: a round tyre and a flat rim face — reads as a wheel at 50 m
    const rr = r * 0.64;
    k.lathe([-w / 2, 0, 0], [1, 0, 0], [[rr, 0], [r, w * 0.1], [r, w * 0.9], [rr, w]], segs, S.RUBBER);
    k.lathe([w / 2 - 0.02, 0, 0], [1, 0, 0], [[rr, 0], [rr * 0.3, 0.02]], segs, style === 'steel' ? S.TRIM : S.RIM, false, true);
    const g2 = k.build(0.55);
    cache.set(key, g2);
    return g2;
  }
  const h = w / 2;
  const rr = r * (style === 'heavy' ? 0.58 : 0.66); // rim radius
  // tyre: inner bead → sidewall → rounded shoulder → tread → shoulder → sidewall → outer bead
  k.lathe([-h, 0, 0], [1, 0, 0], [
    [rr, 0.01],
    [r * 0.9, 0],
    [r * 0.985, w * 0.08],
    [r, w * 0.2],
    [r, w * 0.8],
    [r * 0.985, w * 0.92],
    [r * 0.9, w],
    [rr, w - 0.01],
  ], segs, S.RUBBER);
  // rim barrel and lip
  k.lathe([-h, 0, 0], [1, 0, 0], [[rr * 0.97, 0.02], [rr * 0.97, w - 0.03], [rr, w - 0.02], [rr * 0.93, w - 0.01]], segs, style === 'steel' ? S.TRIM : S.RIM);
  // dark dish at the back, the brake disc and caliper in front of it — seen through the spokes
  k.lathe([h - 0.13, 0, 0], [1, 0, 0], [[rr * 0.94, 0], [rr * 0.94, 0.006]], segs, S.UNDER, false, true);
  if (detail === 0) k.lathe([h - 0.085, 0, 0], [1, 0, 0], [[rr * 0.74, 0], [rr * 0.74, 0.02]], segs, S.CHROME, false, true);
  k.box([h - 0.06, rr * 0.5, 0.14], [0.05, rr * 0.38, rr * 0.34], S.TAIL, 0, detail === 0 ? 0.01 : 0);
  // face: spokes radiate from the hub; mesh rims get more, thinner spokes; steel wheels get a dished face
  const n = style === 'spoke6' ? 6 : style === 'mesh' ? 10 : style === 'heavy' ? 8 : 5;
  if (style === 'steel') {
    k.lathe([h - 0.04, 0, 0], [1, 0, 0], [[rr * 0.93, 0], [rr * 0.6, 0.03], [rr * 0.3, 0.03], [rr * 0.25, 0.05]], segs, S.TRIM, false, true);
  } else {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const len = rr * 0.78;
      const wsp = style === 'mesh' ? rr * 0.08 : style === 'heavy' ? rr * 0.2 : rr * 0.15;
      const m = new THREE.Matrix4().makeRotationX(a);
      m.multiply(new THREE.Matrix4().makeTranslation(h - 0.03, rr * 0.18 + len / 2, 0));
      if (detail === 0) k.add(new THREE.BoxGeometry(0.035, len, wsp), m, S.RIM);
      else {
        const p = new THREE.Vector3(h - 0.03, rr * 0.18 + len / 2, 0).applyAxisAngle(new THREE.Vector3(1, 0, 0), a);
        k.box([p.x, p.y, p.z], [0.035, len, wsp], S.RIM, 0, 0, a);
      }
    }
  }
  // hub cap and wheel nuts
  k.lathe([h - 0.04, 0, 0], [1, 0, 0], [[rr * 0.24, 0], [rr * 0.22, 0.03], [rr * 0.12, 0.045], [0.001, 0.05]], 10, style === 'heavy' ? S.CHROME : S.RIM, false, false);
  const g = k.build(0.55);
  cache.set(key, g);
  return g;
}
