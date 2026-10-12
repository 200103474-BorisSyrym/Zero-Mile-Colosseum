import * as THREE from 'three';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { suv } from './atlas';

export type V3 = [number, number, number];

/**
 * Builds one asset mesh: triangles tagged with an atlas surface, outward-oriented by a hint, finished with creased
 * normals (smooth across panels, sharp at real edges). The modelling helpers here — loft, lathe, extrude, tube,
 * bevelled box — are what authored assets are made from.
 */
export class MeshKit {
  private pos: number[] = [];
  private uv: number[] = [];

  /**
   * Detail level: 0 = hero (every chamfer, full round sections), 1 = standard (small parts lose their chamfers,
   * round sections ~30% fewer sides), 2 = far LOD (no chamfers, round sections ~60% fewer sides).
   */
  constructor(readonly detail: 0 | 1 | 2 = 0) {}

  /** Sides of a round section at this detail level. */
  sides(n: number) {
    return this.detail === 2 ? Math.max(5, Math.round(n * 0.4)) : this.detail === 1 ? Math.max(6, Math.round(n * 0.7)) : n;
  }

  get triangles() {
    return this.pos.length / 9;
  }

  tri(a: V3, b: V3, c: V3, s: number, hint?: V3) {
    if (hint) {
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (nx * hint[0] + ny * hint[1] + nz * hint[2] < 0) [b, c] = [c, b];
    }
    const [u, v] = suv(s);
    this.pos.push(...a, ...b, ...c);
    this.uv.push(u, v, u, v, u, v);
  }

  quad(a: V3, b: V3, c: V3, d: V3, s: number, hint?: V3) {
    this.tri(a, b, c, s, hint);
    this.tri(a, c, d, s, hint);
  }

  /** Append another geometry (transformed), every triangle on one surface. */
  add(geo: THREE.BufferGeometry, m: THREE.Matrix4, s: number) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    g.applyMatrix4(m);
    const p = g.getAttribute('position');
    const [u, v] = suv(s);
    for (let i = 0; i < p.count; i++) {
      this.pos.push(p.getX(i), p.getY(i), p.getZ(i));
      this.uv.push(u, v);
    }
  }

  /**
   * Chamfered box: every edge cut by b — 6 faces, 12 bevel strips, 8 corner triangles. Centred at c, size s,
   * yaw then pitch. Chamfers catch the light: a block reads as a made object, not a primitive.
   */
  box(c: V3, size: V3, s: number, yaw = 0, b = 0.04, pitch = 0) {
    if (this.detail === 2 || (this.detail === 1 && b <= 0.021)) b = 0;
    const hx = size[0] / 2, hy = size[1] / 2, hz = size[2] / 2;
    const bx = Math.min(b, hx * 0.45), by = Math.min(b, hy * 0.45), bz = Math.min(b, hz * 0.45);
    const m = new THREE.Matrix4().compose(new THREE.Vector3(...c), new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ')), new THREE.Vector3(1, 1, 1));
    const v = new THREE.Vector3();
    const T = (x: number, y: number, z: number): V3 => {
      v.set(x, y, z).applyMatrix4(m);
      return [v.x, v.y, v.z];
    };
    const N = (x: number, y: number, z: number): V3 => {
      v.set(x, y, z).transformDirection(m);
      return [v.x, v.y, v.z];
    };
    if (b <= 0) {
      // plain box: six faces, no chamfers (architecture, where edges are crisp anyway)
      const Q = (sx: number, sy: number, sz: number) => T(sx * hx, sy * hy, sz * hz);
      for (const k of [-1, 1]) {
        this.quad(Q(k, -1, -1), Q(k, 1, -1), Q(k, 1, 1), Q(k, -1, 1), s, N(k, 0, 0));
        this.quad(Q(-1, k, -1), Q(1, k, -1), Q(1, k, 1), Q(-1, k, 1), s, N(0, k, 0));
        this.quad(Q(-1, -1, k), Q(1, -1, k), Q(1, 1, k), Q(-1, 1, k), s, N(0, 0, k));
      }
      return;
    }
    const X = (sx: number, sy: number, sz: number) => T(sx * hx, sy * (hy - by), sz * (hz - bz));
    const Y = (sx: number, sy: number, sz: number) => T(sx * (hx - bx), sy * hy, sz * (hz - bz));
    const Z = (sx: number, sy: number, sz: number) => T(sx * (hx - bx), sy * (hy - by), sz * hz);
    for (const k of [-1, 1]) {
      this.quad(X(k, -1, -1), X(k, 1, -1), X(k, 1, 1), X(k, -1, 1), s, N(k, 0, 0));
      this.quad(Y(-1, k, -1), Y(1, k, -1), Y(1, k, 1), Y(-1, k, 1), s, N(0, k, 0));
      this.quad(Z(-1, -1, k), Z(1, -1, k), Z(1, 1, k), Z(-1, 1, k), s, N(0, 0, k));
    }
    for (const a of [-1, 1]) for (const bb of [-1, 1]) {
      this.quad(X(a, bb, -1), Y(a, bb, -1), Y(a, bb, 1), X(a, bb, 1), s, N(a, bb, 0));
      this.quad(X(a, -1, bb), Z(a, -1, bb), Z(a, 1, bb), X(a, 1, bb), s, N(a, 0, bb));
      this.quad(Y(-1, a, bb), Z(-1, a, bb), Z(1, a, bb), Y(1, a, bb), s, N(0, a, bb));
    }
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) this.tri(X(sx, sy, sz), Y(sx, sy, sz), Z(sx, sy, sz), s, N(sx, sy, sz));
  }

  /** Surface of revolution around the axis from `a` along `dir`: profile of [radius, distance]. */
  lathe(a: V3, dir: V3, profile: [number, number][], n: number, s: number, capStart = false, capEnd = false, flip = false) {
    n = this.sides(n);
    const d = new THREE.Vector3(...dir).normalize();
    const u = new THREE.Vector3(1, 0, 0);
    if (Math.abs(d.x) > 0.9) u.set(0, 1, 0);
    u.cross(d).normalize();
    const w = new THREE.Vector3().crossVectors(d, u);
    const P = (r: number, t: number, ang: number): V3 => [a[0] + d.x * t + (u.x * Math.cos(ang) + w.x * Math.sin(ang)) * r, a[1] + d.y * t + (u.y * Math.cos(ang) + w.y * Math.sin(ang)) * r, a[2] + d.z * t + (u.z * Math.cos(ang) + w.z * Math.sin(ang)) * r];
    for (let j = 0; j < profile.length - 1; j++) {
      const [r0, t0] = profile[j], [r1, t1] = profile[j + 1];
      for (let k = 0; k < n; k++) {
        const a0 = (k / n) * Math.PI * 2, a1 = ((k + 1) / n) * Math.PI * 2, am = (a0 + a1) / 2;
        const ctr = P(0, (t0 + t1) / 2, 0);
        const out = P(1, (t0 + t1) / 2, am);
        const f = flip ? -1 : 1;
        this.quad(P(r0, t0, a0), P(r0, t0, a1), P(r1, t1, a1), P(r1, t1, a0), s, [(out[0] - ctr[0]) * f, (out[1] - ctr[1]) * f, (out[2] - ctr[2]) * f]);
      }
    }
    const cap = (r: number, t: number, sign: number) => {
      const c = P(0, t, 0);
      for (let k = 0; k < n; k++) this.tri(c, P(r, t, (k / n) * Math.PI * 2), P(r, t, ((k + 1) / n) * Math.PI * 2), s, [d.x * sign, d.y * sign, d.z * sign]);
    };
    if (capStart) cap(profile[0][0], profile[0][1], -1);
    if (capEnd) cap(profile[profile.length - 1][0], profile[profile.length - 1][1], 1);
  }

  /** Tube between two points. */
  tube(a: V3, b: V3, r: number, n: number, s: number, caps = false) {
    const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len = Math.hypot(...d);
    this.lathe(a, d, [[r, 0], [r, len]], n, s, caps, caps);
  }

  /**
   * Extrude a 2D outline (in the X/Y plane of a local frame) by depth along local Z, then place it.
   * Good for cross-section objects: barriers, bumpers, wings, plows, roof profiles, I-beams.
   */
  extrude(outline: [number, number][], depth: number, m: THREE.Matrix4, s: number, sides = s) {
    const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
    const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, steps: 1, curveSegments: 1 });
    g.translate(0, 0, -depth / 2);
    // caps take `s`, the sides take `sides`
    const caps = g.groups[0];
    const gi = g.toNonIndexed();
    gi.applyMatrix4(m);
    const p = gi.getAttribute('position');
    const [u0, v0] = suv(s), [u1, v1] = suv(sides);
    const capCount = caps ? caps.count : 0;
    for (let i = 0; i < p.count; i++) {
      this.pos.push(p.getX(i), p.getY(i), p.getZ(i));
      const isCap = i < capCount;
      this.uv.push(isCap ? u0 : u1, isCap ? v0 : v1);
    }
  }

  build(crease = 0.6): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    const out = toCreasedNormals(g, crease);
    out.computeBoundingSphere();
    out.computeBoundingBox();
    return out;
  }
}
