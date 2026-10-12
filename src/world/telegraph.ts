import * as THREE from 'three';
import { EMISSIVE, glow } from '../render/visualBudget';
import type { Road } from './road';
import { warmMesh } from '../render/warmup';

/**
 * Reusable telegraph decals painted on the road: lane strips, circles, arrows and boxes.
 * Used for boss attacks, enemy charges, hazard warnings, drone strikes and objectives.
 * Pulses faster as the moment of danger approaches.
 */
export interface Telegraph {
  mesh: THREE.Mesh;
  life: number;
  max: number;
  ownGeo: boolean;
  follow: { pos: THREE.Vector3; yaw?: () => number } | null;
  offset: THREE.Vector3;
  baseOpacity: number;
  dead: boolean;
  kill(): void;
}

let arrowTex: THREE.Texture | null = null;
let ringTex: THREE.Texture | null = null;

function arrowTexture() {
  if (arrowTex) return arrowTex;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 128;
  const g = c.getContext('2d')!;
  // a feathered edge: light on the asphalt, not a sticker
  g.filter = 'blur(1.5px)';
  g.fillStyle = '#fff';
  for (let i = 0; i < 3; i++) {
    const y = 10 + i * 40;
    g.beginPath();
    g.moveTo(32, y);
    g.lineTo(60, y + 26);
    g.lineTo(48, y + 34);
    g.lineTo(32, y + 18);
    g.lineTo(16, y + 34);
    g.lineTo(4, y + 26);
    g.closePath();
    g.fill();
  }
  arrowTex = new THREE.CanvasTexture(c);
  return arrowTex;
}

/**
 * Danger zone on the ground: light, not paint. A feathered rim (no hard stroke), a faint fill brightest toward the
 * rim, and four short ticks pointing in — it reads at a glance and still sits on the asphalt.
 */
function ringTexture() {
  if (ringTex) return ringTex;
  const N = 256;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d')!;
  const img = g.createImageData(N, N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = (x + 0.5) / N * 2 - 1, v = (y + 0.5) / N * 2 - 1;
      const r = Math.hypot(u, v);
      const rim = Math.exp(-Math.pow((r - 0.9) / 0.045, 2));
      const fill = r < 0.9 ? 0.1 + 0.18 * Math.pow(r / 0.9, 3) : 0;
      const ang = Math.atan2(v, u);
      const tick = r > 0.5 && r < 0.78 ? Math.exp(-Math.pow(Math.sin(ang * 2) * r / 0.03, 2)) * 0.8 : 0;
      const i = (y * N + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(Math.min(1, rim + fill + tick) * 255);
    }
  }
  g.putImageData(img, 0, 0);
  ringTex = new THREE.CanvasTexture(c);
  return ringTex;
}

let laneTex: THREE.Texture | null = null;
/** Lane strip: bright feathered edges, a faint body with diagonal hazard hatching, repeating every 4 m. */
function laneTexture() {
  if (laneTex) return laneTex;
  const W = 64, H = 128;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const img = g.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W;
      const e = Math.min(u, 1 - u);
      const edge = Math.exp(-Math.pow((e - 0.07) / 0.035, 2));
      const body = e > 0.04 ? 0.16 : e / 0.04 * 0.16;
      const hatch = ((x + y) % 32) < 9 && e > 0.14 ? 0.2 : 0;
      const i = (y * W + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(Math.min(1, edge + body + hatch) * 255);
    }
  }
  g.putImageData(img, 0, 0);
  laneTex = new THREE.CanvasTexture(c);
  laneTex.wrapS = THREE.ClampToEdgeWrapping;
  laneTex.wrapT = THREE.RepeatWrapping;
  return laneTex;
}

const planeGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

export class Telegraphs {
  readonly group = new THREE.Group();
  private list: Telegraph[] = [];
  private t = 0;

  constructor(scene: THREE.Scene, private road: () => Road) {
    scene.add(this.group);
  }

  /** Shader warm-up: a telegraph material with each of its maps and without one. */
  warmObjects(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [laneTexture(), ringTexture(), arrowTexture(), null].map((t) => warmMesh(this.mat(0xffffff, t, 1)));
    // the lane strip as lane() builds it: positions and uvs only, drawn from both sides (two passes when transparent)
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 0, 1], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1], 2));
    const lane = new THREE.Mesh(g, this.mat(0xffffff, laneTexture(), 1));
    lane.material.side = THREE.DoubleSide;
    out.push(lane);
    return out;
  }

  private mat(color: number, map: THREE.Texture | null, opacity: number) {
    return new THREE.MeshBasicMaterial({
      color: glow(color, EMISSIVE.MEDIUM),
      map,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
    });
  }

  private push(mesh: THREE.Mesh, dur: number, ownGeo: boolean, opacity: number): Telegraph {
    mesh.renderOrder = 6;
    this.group.add(mesh);
    const t: Telegraph = {
      mesh, life: dur, max: dur, ownGeo, follow: null, offset: new THREE.Vector3(), baseOpacity: opacity, dead: false,
      kill: () => {
        t.life = 0;
      },
    };
    this.list.push(t);
    return t;
  }

  /** Strip along the road between s0..s1 centred on lateral offset d. */
  lane(s0: number, s1: number, d: number, width: number, color: number, dur: number, opacity = 0.55): Telegraph {
    const road = this.road();
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const step = 2;
    const o = { x: 0, y: 0, z: 0 };
    let n = 0;
    for (let s = s0; s <= s1 + 0.01; s += step) {
      const p = road.at(Math.min(s, s1));
      const rx = -Math.cos(p.heading), rz = Math.sin(p.heading);
      road.toWorld(Math.min(s, s1), d, o);
      pos.push(o.x - rx * width / 2, p.y + 0.06, o.z - rz * width / 2, o.x + rx * width / 2, p.y + 0.06, o.z + rz * width / 2);
      const v = (s - s0) / 4;
      uv.push(0, v, 1, v);
      if (n > 0) {
        const a = (n - 1) * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
      n++;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    const m = new THREE.Mesh(g, this.mat(color, laneTexture(), Math.min(1, opacity * 1.5)));
    m.material.side = THREE.DoubleSide;
    return this.push(m, dur, true, Math.min(1, opacity * 1.5));
  }

  circle(x: number, z: number, r: number, color: number, dur: number, opacity = 0.7): Telegraph {
    const m = new THREE.Mesh(planeGeo, this.mat(color, ringTexture(), opacity));
    const y = this.road().at(this.road().project(x, z, this.road().startS + 1, tmp).s).y;
    m.position.set(x, y + 0.07, z);
    m.scale.set(r * 2, 1, r * 2);
    return this.push(m, dur, false, opacity);
  }

  /** Chevron arrow on the ground pointing along yaw (forward = +Z local). */
  arrow(x: number, z: number, yaw: number, length: number, color: number, dur: number, opacity = 0.8): Telegraph {
    const m = new THREE.Mesh(planeGeo, this.mat(color, arrowTexture(), opacity));
    const y = this.road().at(this.road().project(x, z, this.road().startS + 1, tmp).s).y;
    m.position.set(x, y + 0.08, z);
    m.rotation.y = yaw + Math.PI;
    m.scale.set(length * 0.45, 1, length);
    return this.push(m, dur, false, opacity);
  }

  /** Attach a telegraph to a moving thing. */
  follow(t: Telegraph, pos: THREE.Vector3, yaw?: () => number) {
    t.follow = { pos, yaw };
    t.offset.set(0, 0.08, 0);
    return t;
  }

  update(dt: number) {
    this.t += dt;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const t = this.list[i];
      t.life -= dt;
      if (t.life <= 0) {
        this.group.remove(t.mesh);
        if (t.ownGeo) t.mesh.geometry.dispose();
        (t.mesh.material as THREE.Material).dispose();
        t.dead = true;
        this.list.splice(i, 1);
        continue;
      }
      const frac = 1 - t.life / t.max;
      const freq = 4 + frac * 14;
      const pulse = 0.55 + 0.45 * Math.sin(this.t * freq);
      (t.mesh.material as THREE.MeshBasicMaterial).opacity = t.baseOpacity * pulse * Math.min(1, t.life * 4);
      if (t.follow) {
        t.mesh.position.set(t.follow.pos.x, t.follow.pos.y + t.offset.y, t.follow.pos.z);
        if (t.follow.yaw) t.mesh.rotation.y = t.follow.yaw() + Math.PI;
      }
    }
  }

  clear() {
    for (const t of this.list) {
      this.group.remove(t.mesh);
      if (t.ownGeo) t.mesh.geometry.dispose();
      (t.mesh.material as THREE.Material).dispose();
      t.dead = true;
    }
    this.list = [];
  }
}

const tmp = { s: 0, d: 0 };
