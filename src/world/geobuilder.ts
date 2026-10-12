import * as THREE from 'three';
import { S, suv, surfAt } from '../assets/atlas';

type V3 = [number, number, number];

/** Growable float buffer: segment geometry is written straight into typed memory, no boxing, no re-copies. */
class FBuf {
  a = new Float32Array(768);
  n = 0;
  reserve(k: number) {
    if (this.n + k <= this.a.length) return;
    let c = this.a.length * 2;
    while (c < this.n + k) c *= 2;
    const b = new Float32Array(c);
    b.set(this.a.subarray(0, this.n));
    this.a = b;
  }
  p3(x: number, y: number, z: number) {
    this.reserve(3);
    const a = this.a, n = this.n;
    a[n] = x;
    a[n + 1] = y;
    a[n + 2] = z;
    this.n = n + 3;
  }
  p2(x: number, y: number) {
    this.reserve(2);
    this.a[this.n] = x;
    this.a[this.n + 1] = y;
    this.n += 2;
  }
  out() {
    return this.a.slice(0, this.n);
  }
}

/** Accumulates quads/boxes into a single BufferGeometry (one draw call per material per segment). */
export class GeoBuilder {
  private pos = new FBuf();
  private nor = new FBuf();
  private uv = new FBuf();
  private col: FBuf | null = null;
  private v = 0;

  constructor(withColor = false) {
    if (withColor) this.col = new FBuf();
  }

  get empty() {
    return this.v === 0;
  }

  get vertices() {
    return this.v;
  }

  /** Quad a-b-c-d (in order around the perimeter). `hint` is the desired facing direction. */
  quad(a: V3, b: V3, c: V3, d: V3, hint: V3, uvs?: number[], color?: THREE.Color) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    const flip = nx * hint[0] + ny * hint[1] + nz * hint[2] < 0;
    if (flip) { nx = -nx; ny = -ny; nz = -nz; }
    const order = flip ? [a, d, c, b] : [a, b, c, d];
    const uvo = uvs ?? [0, 0, 1, 0, 1, 1, 0, 1];
    const uvOrder = flip ? [0, 3, 2, 1] : [0, 1, 2, 3];
    // two triangles: 0-1-2, 0-2-3
    for (const k of [0, 1, 2, 0, 2, 3]) {
      const p = order[k];
      this.pos.p3(p[0], p[1], p[2]);
      this.nor.p3(nx, ny, nz);
      const ui = uvOrder[k];
      this.uv.p2(uvo[ui * 2], uvo[ui * 2 + 1]);
      if (this.col) {
        const c2 = color ?? WHITE;
        this.col.p3(c2.r, c2.g, c2.b);
      }
    }
    this.v += 6;
  }

  /**
   * Oriented box. yaw rotates around Y (forward = +Z local).
   * uvScale: metres per texture unit for side faces (0 = unit UVs). uvOff offsets side UVs.
   */
  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, yaw = 0, uvScaleU = 0, uvScaleV = 0, uvOffU = 0, uvOffV = 0, color?: THREE.Color, skipBottom = true, skipTop = false) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const P = (lx: number, ly: number, lz: number): V3 => [cx + lx * c + lz * s, cy + ly, cz - lx * s + lz * c];
    const N = (lx: number, ly: number, lz: number): V3 => [lx * c + lz * s, ly, -lx * s + lz * c];
    const uvSide = (w: number) => {
      if (!uvScaleU) return undefined;
      const u0 = uvOffU, u1 = uvOffU + w / uvScaleU;
      const v0 = uvOffV, v1 = uvOffV + sy / uvScaleV;
      return [u0, v0, u1, v0, u1, v1, u0, v1];
    };
    // +Z face
    this.quad(P(-hx, -hy, hz), P(hx, -hy, hz), P(hx, hy, hz), P(-hx, hy, hz), N(0, 0, 1), uvSide(sx), color);
    // -Z
    this.quad(P(hx, -hy, -hz), P(-hx, -hy, -hz), P(-hx, hy, -hz), P(hx, hy, -hz), N(0, 0, -1), uvSide(sx), color);
    // +X
    this.quad(P(hx, -hy, hz), P(hx, -hy, -hz), P(hx, hy, -hz), P(hx, hy, hz), N(1, 0, 0), uvSide(sz), color);
    // -X
    this.quad(P(-hx, -hy, -hz), P(-hx, -hy, hz), P(-hx, hy, hz), P(-hx, hy, -hz), N(-1, 0, 0), uvSide(sz), color);
    if (!skipTop) this.quad(P(-hx, hy, hz), P(hx, hy, hz), P(hx, hy, -hz), P(-hx, hy, -hz), [0, 1, 0], uvScaleU ? [0.004, 0.998, 0.004, 0.998, 0.004, 0.998, 0.004, 0.998] : undefined, color);
    if (!skipBottom) this.quad(P(-hx, -hy, -hz), P(hx, -hy, -hz), P(hx, -hy, hz), P(-hx, -hy, hz), [0, -1, 0], undefined, color);
  }

  /** Vertical n-sided prism (tank, silo, pipe stack): radius r0 at y0 to r1 at y1, optionally capped on top. */
  prism(cx: number, y0: number, cz: number, r0: number, y1: number, r1: number, n = 8, color?: THREE.Color, cap = true) {
    this.lathe(cx, cz, [[r0, y0], [r1, y1]], n, color);
    if (cap) {
      for (let k = 0; k < n; k++) {
        const a0 = (k / n) * Math.PI * 2, a1 = ((k + 1) / n) * Math.PI * 2;
        this.quad([cx, y1, cz], [cx + Math.cos(a0) * r1, y1, cz + Math.sin(a0) * r1], [cx + Math.cos(a1) * r1, y1, cz + Math.sin(a1) * r1], [cx, y1, cz], [0, 1, 0], undefined, color);
      }
    }
  }

  /** Surface of revolution around a vertical axis through (cx, cz): profile of [radius, y] from bottom to top. */
  lathe(cx: number, cz: number, profile: [number, number][], n = 12, color?: THREE.Color) {
    for (let j = 0; j < profile.length - 1; j++) {
      const [ra, ya] = profile[j], [rb, yb] = profile[j + 1];
      for (let k = 0; k < n; k++) {
        const a0 = (k / n) * Math.PI * 2, a1 = ((k + 1) / n) * Math.PI * 2;
        const am = (a0 + a1) / 2;
        this.quad(
          [cx + Math.cos(a0) * ra, ya, cz + Math.sin(a0) * ra],
          [cx + Math.cos(a1) * ra, ya, cz + Math.sin(a1) * ra],
          [cx + Math.cos(a1) * rb, yb, cz + Math.sin(a1) * rb],
          [cx + Math.cos(a0) * rb, yb, cz + Math.sin(a0) * rb],
          [Math.cos(am), 0, Math.sin(am)],
          [k / n, j / (profile.length - 1), (k + 1) / n, j / (profile.length - 1), (k + 1) / n, (j + 1) / (profile.length - 1), k / n, (j + 1) / (profile.length - 1)],
          color,
        );
      }
    }
  }

  /** Round tube between two points (pipes, rails): n sides of radius r. */
  tube(a: V3, b: V3, r: number, n = 8, color?: THREE.Color) {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const len = Math.hypot(dx, dy, dz) || 1;
    const fx = dx / len, fy = dy / len, fz = dz / len;
    let ux = -fz, uy = 0, uz = fx;
    if (Math.abs(fy) > 0.9) {
      ux = 1;
      uz = 0;
    }
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul;
    uy /= ul;
    uz /= ul;
    const vx = fy * uz - fz * uy, vy = fz * ux - fx * uz, vz = fx * uy - fy * ux;
    const ring = (p: V3, ang: number): V3 => [p[0] + (ux * Math.cos(ang) + vx * Math.sin(ang)) * r, p[1] + (uy * Math.cos(ang) + vy * Math.sin(ang)) * r, p[2] + (uz * Math.cos(ang) + vz * Math.sin(ang)) * r];
    for (let k = 0; k < n; k++) {
      const a0 = (k / n) * Math.PI * 2, a1 = ((k + 1) / n) * Math.PI * 2, am = (a0 + a1) / 2;
      this.quad(ring(a, a0), ring(a, a1), ring(b, a1), ring(b, a0), [ux * Math.cos(am) + vx * Math.sin(am), uy * Math.cos(am) + vy * Math.sin(am), uz * Math.cos(am) + vz * Math.sin(am)], undefined, color);
    }
  }

  /** Square-section beam between two points (struts, cables, pipes, trusses). */
  beam(a: V3, b: V3, w: number, color?: THREE.Color) {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const len = Math.hypot(dx, dy, dz) || 1;
    const fx = dx / len, fy = dy / len, fz = dz / len;
    // a perpendicular pair (u, v)
    let ux = -fz, uy = 0, uz = fx;
    if (Math.abs(fy) > 0.9) {
      ux = 1;
      uy = 0;
      uz = 0;
    }
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul;
    uy /= ul;
    uz /= ul;
    const vx = fy * uz - fz * uy, vy = fz * ux - fx * uz, vz = fx * uy - fy * ux;
    const h = w / 2;
    const corner = (p: V3, su: number, sv: number): V3 => [p[0] + (ux * su + vx * sv) * h, p[1] + (uy * su + vy * sv) * h, p[2] + (uz * su + vz * sv) * h];
    const sides: [number, number, number, number][] = [[1, 1, 1, -1], [1, -1, -1, -1], [-1, -1, -1, 1], [-1, 1, 1, 1]];
    for (const [su0, sv0, su1, sv1] of sides) {
      const nx = (su0 + su1) / 2, ny = (sv0 + sv1) / 2;
      this.quad(corner(a, su0, sv0), corner(a, su1, sv1), corner(b, su1, sv1), corner(b, su0, sv0), [ux * nx + vx * ny, uy * nx + vy * ny, uz * nx + vz * ny], undefined, color);
    }
  }

  /**
   * Append an authored kit asset (non-indexed, with normals and atlas UVs), transformed by `m`. Paint surfaces take
   * `paint` as their vertex colour (everything else stays white); `remap` swaps surfaces — a parked car's lamps
   * become unlit lenses, a burnt-out car loses its glass.
   */
  add(geo: THREE.BufferGeometry, m: THREE.Matrix4, paint?: THREE.Color, remap?: Partial<Record<number, number>>) {
    const p = geo.getAttribute('position') as THREE.BufferAttribute;
    const n = geo.getAttribute('normal') as THREE.BufferAttribute;
    const t = geo.getAttribute('uv') as THREE.BufferAttribute;
    const e = m.elements;
    // normal matrix of a rotation + uniform scale: the upper 3x3, renormalised per vertex
    const pa = p.array, na = n.array, ta = t.array;
    const pc = paint ?? WHITE;
    const cnt = p.count;
    this.pos.reserve(cnt * 3);
    this.nor.reserve(cnt * 3);
    this.uv.reserve(cnt * 2);
    this.col?.reserve(cnt * 3);
    const P = this.pos.a, N = this.nor.a, T = this.uv.a, Cc = this.col?.a;
    let ip = this.pos.n, it = this.uv.n;
    let lastS = -1, lastU = 0, lastV = 0, isPaint = false;
    for (let i = 0; i < cnt; i++) {
      const i3 = i * 3;
      const x = pa[i3], y = pa[i3 + 1], z = pa[i3 + 2];
      P[ip] = e[0] * x + e[4] * y + e[8] * z + e[12];
      P[ip + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      P[ip + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
      const nx = na[i3], ny = na[i3 + 1], nz = na[i3 + 2];
      const ox = e[0] * nx + e[4] * ny + e[8] * nz, oy = e[1] * nx + e[5] * ny + e[9] * nz, oz = e[2] * nx + e[6] * ny + e[10] * nz;
      const l = 1 / (Math.sqrt(ox * ox + oy * oy + oz * oz) || 1);
      N[ip] = ox * l;
      N[ip + 1] = oy * l;
      N[ip + 2] = oz * l;
      const u = ta[i * 2], v = ta[i * 2 + 1];
      const s = surfAt(u, v);
      if (s !== lastS) {
        lastS = s;
        const r = remap?.[s];
        if (r !== undefined) [lastU, lastV] = suv(r);
        else {
          lastU = u;
          lastV = v;
        }
        isPaint = (r ?? s) === S.PAINT;
      }
      T[it] = lastU;
      T[it + 1] = lastV;
      if (Cc) {
        const c = isPaint ? pc : WHITE;
        Cc[ip] = c.r;
        Cc[ip + 1] = c.g;
        Cc[ip + 2] = c.b;
      }
      ip += 3;
      it += 2;
    }
    this.pos.n = ip;
    this.nor.n = ip;
    this.uv.n = it;
    if (this.col) this.col.n = ip;
    this.v += cnt;
  }

  /** build() as steps (World.buildSegmentSteps): one attribute per step, then the bounds. */
  *buildSteps(): Generator<string, THREE.BufferGeometry, void> {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.out(), 3));
    yield 'build: normals';
    g.setAttribute('normal', new THREE.BufferAttribute(this.nor.out(), 3));
    yield 'build: uvs';
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv.out(), 2));
    if (this.col) {
      yield 'build: colours';
      g.setAttribute('color', new THREE.BufferAttribute(this.col.out(), 3));
    }
    yield 'build: bounds';
    g.boundingSphere = boundingSphereOf(g.getAttribute('position').array as Float32Array);
    return g;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.out(), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nor.out(), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv.out(), 2));
    if (this.col) g.setAttribute('color', new THREE.BufferAttribute(this.col.out(), 3));
    g.boundingSphere = boundingSphereOf(g.getAttribute('position').array as Float32Array);
    return g;
  }
}

/**
 * The bounding sphere three.js would compute (box centre, farthest vertex), in two straight passes over the typed array:
 * the stock version reads every vertex through an accessor, the slowest part of building a segment's big kit mesh.
 */
function boundingSphereOf(a: Float32Array) {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < a.length; i += 3) {
    const x = a[i], y = a[i + 1], z = a[i + 2];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
  let r2 = 0;
  for (let i = 0; i < a.length; i += 3) {
    const dx = a[i] - cx, dy = a[i + 1] - cy, dz = a[i + 2] - cz;
    const d = dx * dx + dy * dy + dz * dz;
    if (d > r2) r2 = d;
  }
  return new THREE.Sphere(new THREE.Vector3(cx, cy, cz), Math.sqrt(r2));
}

const WHITE = new THREE.Color(1, 1, 1);
