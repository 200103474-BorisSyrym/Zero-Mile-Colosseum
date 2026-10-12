import * as THREE from 'three';
import { VFX } from '../render/visualBudget';
import { frand } from '../core/random';
import { ADD_FRAME, addAtlas, flashTexture, hazardTexture, skidTexture, smokeAtlas, waveTexture } from './vfxTextures';
import { updateBeams } from './lightBeams';

/**
 * ZERO MILE effects. Everything is pooled and drawn in a handful of draw calls:
 *   sprites   — additive textured points (flames, fireballs, glows, embers, crackle) and alpha points (smoke, dust,
 *               tyre smoke, mist), each rotating, tumbling in turbulence, growing and fading on its own curve
 *   streaks   — instanced quads stretched along their motion: sparks, water droplets, electric arcs, speed lines
 *   debris    — instanced shards, chunks and panels with tumbling ballistic paths
 *   lights    — a few pooled point lights with an attack / decay envelope: blasts and impacts light the world
 *   ground    — pooled decals on the road: blast flashes, pressure waves, scorch marks
 *   skids     — a ring buffer of tyre marks laid where the tyres actually lose grip
 *   glare     — lamp glare for vehicle lights, rebuilt every frame from the cars on screen
 * High-level effects (impact, explosion, emp, fire, exhaust…) are staged over time — a flash, then the hot core, then
 * sparks and debris, then smoke — and vary from one call to the next. Cosmetic randomness only.
 */

// ------------------------------------------------------------------------------------------------ shared fog

const FOG = { color: { value: new THREE.Color(0, 0, 0) }, density: { value: 0 } };
const FOG_GLSL = /* glsl */ `
  uniform vec3 fogCol; uniform float fogDen;
  float fogAmount(float d) { return 1.0 - exp(-fogDen * fogDen * d * d); }
`;

/** Scratch emission record: callers fill it, `emit` copies it. Defaults are reset by `E0()`. */
interface Emit {
  x: number; y: number; z: number; vx: number; vy: number; vz: number;
  life: number; size: number; grow: number;
  r: number; g: number; b: number; r1: number; g1: number; b1: number;
  alpha: number; fadeIn: number; drag: number; grav: number; turb: number;
  rot: number; spin: number; frame: number;
}
const E: Emit = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, size: 1, grow: 0, r: 1, g: 1, b: 1, r1: 1, g1: 1, b1: 1, alpha: 1, fadeIn: 0.1, drag: 1, grav: 0, turb: 0, rot: 0, spin: 0, frame: 0 };
function E0() {
  E.vx = E.vy = E.vz = 0;
  E.grow = 0;
  E.alpha = 1;
  E.fadeIn = 0.1;
  E.drag = 1;
  E.grav = 0;
  E.turb = 0;
  E.rot = frand(0, Math.PI * 2);
  E.spin = frand(-1, 1);
  E.frame = 0;
  return E;
}
const col = (E: Emit, c: THREE.Color, k = 1) => {
  E.r = c.r * k;
  E.g = c.g * k;
  E.b = c.b * k;
};
const col1 = (E: Emit, c: THREE.Color, k = 1) => {
  E.r1 = c.r * k;
  E.g1 = c.g * k;
  E.b1 = c.b * k;
};

// ------------------------------------------------------------------------------------------------ sprite points

class SpriteSystem {
  readonly points: THREE.Points;
  private pos: Float32Array; private col: Float32Array; private size: Float32Array; private alpha: Float32Array; private rf: Float32Array;
  private vel: Float32Array; private life: Float32Array; private maxLife: Float32Array; private grow: Float32Array;
  private drag: Float32Array; private grav: Float32Array; private c0: Float32Array; private c1: Float32Array;
  private peak: Float32Array; private fadeIn: Float32Array; private turb: Float32Array; private spin: Float32Array; private seed: Float32Array;
  count = 0;
  private mat: THREE.ShaderMaterial;
  constructor(private cap: number, readonly additive: boolean, map: THREE.Texture, grid: [number, number]) {
    const f = (n: number) => new Float32Array(cap * n);
    this.pos = f(3); this.col = f(3); this.size = f(1); this.alpha = f(1); this.rf = f(2);
    this.vel = f(3); this.life = f(1); this.maxLife = f(1); this.grow = f(1); this.drag = f(1); this.grav = f(1);
    this.c0 = f(3); this.c1 = f(3); this.peak = f(1); this.fadeIn = f(1); this.turb = f(1); this.spin = f(1); this.seed = f(1);
    const g = new THREE.BufferGeometry();
    const dyn = (a: Float32Array, n: number) => new THREE.BufferAttribute(a, n).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', dyn(this.pos, 3));
    g.setAttribute('color', dyn(this.col, 3));
    g.setAttribute('size', dyn(this.size, 1));
    g.setAttribute('alpha', dyn(this.alpha, 1));
    g.setAttribute('rf', dyn(this.rf, 2));
    g.setDrawRange(0, 0);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: map }, grid: { value: new THREE.Vector2(grid[0], grid[1]) }, scale: { value: 600 }, maxSize: { value: 256 }, fogCol: FOG.color, fogDen: FOG.density, tint: { value: new THREE.Color(1, 1, 1) } },
      vertexShader: /* glsl */ `
        attribute float size; attribute float alpha; attribute vec3 color; attribute vec2 rf;
        uniform float scale; uniform float maxSize;
        varying vec3 vC; varying float vA; varying float vRot; varying float vFrame; varying float vDepth;
        void main(){
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vC = color; vRot = rf.x; vFrame = rf.y; vDepth = -mv.z;
          // a puff the camera flies through dissolves instead of filling the screen — relative to its size, so a
          // fireball or smoke column right beside the camera thins out rather than turning the frame into mush
          vA = alpha * smoothstep(1.5, 5.0, -mv.z) * smoothstep(0.25, 0.9, -mv.z / max(size, 0.01));
          gl_PointSize = clamp(size * scale / -mv.z, 1.0, maxSize);
          // a sprite is a flat card at the depth of its centre, so the road and walls in front of its lower half
          // would slice it along a hard line. Pull its depth toward the camera by about its radius, along the view ray
          // (same place on screen, same size), so it only meets geometry it is really behind
          float d = -mv.z, push = min(size * 0.8, d * 0.5);
          gl_Position = projectionMatrix * vec4(mv.xyz * ((d - push) / d), 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D map; uniform vec2 grid; uniform vec3 tint;
        varying vec3 vC; varying float vA; varying float vRot; varying float vFrame; varying float vDepth;
        ${FOG_GLSL}
        void main(){
          vec2 p = gl_PointCoord - 0.5;
          float c = cos(vRot), s = sin(vRot);
          p = vec2(c * p.x - s * p.y, s * p.x + c * p.y) + 0.5;
          if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) discard;
          // atlas cells are drawn top-down on the canvas, and the canvas texture is flipped: row 0 is at the top (v = 1)
          vec2 cell = vec2(mod(vFrame, grid.x), grid.y - 1.0 - floor(vFrame / grid.x + 0.001));
          vec4 t = texture2D(map, (cell + vec2(p.x, 1.0 - p.y)) / grid);
          float fog = fogAmount(vDepth);
          ${additive
            ? 'gl_FragColor = vec4(vC * t.rgb * t.a * vA * (1.0 - fog), 1.0);'
            : 'vec3 rgb = mix(vC * tint * t.rgb, fogCol, fog); gl_FragColor = vec4(rgb, t.a * vA * smoothstep(1.0, 0.7, gl_PointCoord.y));'}
        }`,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    // smoke draws after fire and glare: flame shows through thin smoke and is swallowed by thick smoke, the way a
    // fireball turns into a smoke cloud (fire on top of smoke would always read as a glowing cotton ball)
    this.points.renderOrder = additive ? 4 : 5;
  }
  setScale(h: number, maxSize: number) {
    this.mat.uniforms.scale.value = h * 0.75;
    this.mat.uniforms.maxSize.value = maxSize;
  }
  /** Ambient tint for alpha particles: smoke at night takes the colour of the light around it. */
  setTint(c: THREE.Color) {
    this.mat.uniforms.tint.value.copy(c);
  }
  get full() {
    return this.count >= this.cap;
  }
  emit(e: Emit) {
    if (this.count >= this.cap) return;
    const i = this.count++;
    const i3 = i * 3;
    this.pos[i3] = e.x; this.pos[i3 + 1] = e.y; this.pos[i3 + 2] = e.z;
    this.vel[i3] = e.vx; this.vel[i3 + 1] = e.vy; this.vel[i3 + 2] = e.vz;
    this.c0[i3] = e.r; this.c0[i3 + 1] = e.g; this.c0[i3 + 2] = e.b;
    this.c1[i3] = e.r1; this.c1[i3 + 1] = e.g1; this.c1[i3 + 2] = e.b1;
    this.life[i] = e.life; this.maxLife[i] = e.life; this.size[i] = e.size; this.grow[i] = e.grow;
    this.drag[i] = e.drag; this.grav[i] = e.grav; this.peak[i] = e.alpha; this.fadeIn[i] = Math.max(0.01, e.fadeIn);
    this.turb[i] = e.turb; this.spin[i] = e.spin; this.seed[i] = Math.random() * 100;
    this.rf[i * 2] = e.rot; this.rf[i * 2 + 1] = e.frame;
    this.alpha[i] = 0;
  }
  private kill(i: number) {
    const j = --this.count;
    if (i === j) return;
    const i3 = i * 3, j3 = j * 3;
    for (let k = 0; k < 3; k++) {
      this.pos[i3 + k] = this.pos[j3 + k]; this.vel[i3 + k] = this.vel[j3 + k];
      this.c0[i3 + k] = this.c0[j3 + k]; this.c1[i3 + k] = this.c1[j3 + k]; this.col[i3 + k] = this.col[j3 + k];
    }
    this.life[i] = this.life[j]; this.maxLife[i] = this.maxLife[j]; this.size[i] = this.size[j]; this.grow[i] = this.grow[j];
    this.drag[i] = this.drag[j]; this.grav[i] = this.grav[j]; this.peak[i] = this.peak[j]; this.fadeIn[i] = this.fadeIn[j];
    this.turb[i] = this.turb[j]; this.spin[i] = this.spin[j]; this.seed[i] = this.seed[j];
    this.rf[i * 2] = this.rf[j * 2]; this.rf[i * 2 + 1] = this.rf[j * 2 + 1]; this.alpha[i] = this.alpha[j];
  }
  update(dt: number, time: number) {
    let i = 0;
    while (i < this.count) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.kill(i);
        continue;
      }
      const i3 = i * 3;
      const d = Math.exp(-this.drag[i] * dt);
      const tb = this.turb[i];
      let vx = this.vel[i3] * d, vy = this.vel[i3 + 1] * d - this.grav[i] * dt, vz = this.vel[i3 + 2] * d;
      if (tb > 0) {
        // curl-ish wander: smoke rolls instead of drifting in straight lines
        const sd = this.seed[i];
        vx += Math.sin(time * 1.7 + sd * 3.1 + this.pos[i3 + 1] * 0.6) * tb * dt;
        vz += Math.cos(time * 1.3 + sd * 2.3 + this.pos[i3] * 0.5) * tb * dt;
        vy += Math.sin(time * 0.9 + sd) * tb * 0.3 * dt;
      }
      this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
      this.pos[i3] += vx * dt; this.pos[i3 + 1] += vy * dt; this.pos[i3 + 2] += vz * dt;
      if (this.pos[i3 + 1] < 0.03 && this.grav[i] > 0) {
        this.pos[i3 + 1] = 0.03;
        this.vel[i3 + 1] *= -0.35;
        this.vel[i3] *= 0.7;
        this.vel[i3 + 2] *= 0.7;
      }
      const t = 1 - this.life[i] / this.maxLife[i];
      // fast growth that slows down: a puff blooms, then hangs
      this.size[i] += this.grow[i] * dt * (1.4 - t);
      this.rf[i * 2] += this.spin[i] * dt;
      const fi = this.fadeIn[i];
      this.alpha[i] = this.peak[i] * (t < fi ? t / fi : Math.pow(1 - (t - fi) / (1 - fi), 1.4));
      const ct = Math.sqrt(t);
      for (let k = 0; k < 3; k++) this.col[i3 + k] = this.c0[i3 + k] + (this.c1[i3 + k] - this.c0[i3 + k]) * ct;
      i++;
    }
    const g = this.points.geometry;
    g.setDrawRange(0, this.count);
    for (const a of ['position', 'color', 'size', 'alpha', 'rf']) (g.attributes[a] as THREE.BufferAttribute).needsUpdate = true;
  }
  clear() {
    this.count = 0;
  }
  /** Immediate mode (lamp glare): write one sprite for this frame only. */
  direct(x: number, y: number, z: number, r: number, g: number, b: number, size: number, alpha: number, frame: number, rot = 0) {
    if (this.count >= this.cap) return;
    const i = this.count++, i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.col[i3] = r; this.col[i3 + 1] = g; this.col[i3 + 2] = b;
    this.size[i] = size; this.alpha[i] = alpha;
    this.rf[i * 2] = rot; this.rf[i * 2 + 1] = frame;
  }
  /** Upload this frame's immediate sprites and start collecting the next frame's. */
  flush() {
    const g = this.points.geometry;
    g.setDrawRange(0, this.count);
    for (const a of ['position', 'color', 'size', 'alpha', 'rf']) (g.attributes[a] as THREE.BufferAttribute).needsUpdate = true;
    this.count = 0;
  }
}

// ------------------------------------------------------------------------------------------------ streaks

/**
 * Quads stretched along a vector in view space: a spark is a short hot line in the direction it flies, an arc segment
 * is a line between two points, a droplet is a thin bright dash.
 */
class StreakSystem {
  readonly mesh: THREE.Mesh;
  private iPos: Float32Array; private iTail: Float32Array; private iCol: Float32Array; private iW: Float32Array;
  private vel: Float32Array; private life: Float32Array; private maxLife: Float32Array; private drag: Float32Array; private grav: Float32Array;
  private stretch: Float32Array; private minLen: Float32Array; private c0: Float32Array; private c1: Float32Array; private fixed: Uint8Array; private peak: Float32Array;
  count = 0;
  private geo: THREE.InstancedBufferGeometry;
  constructor(private cap: number) {
    const f = (n: number) => new Float32Array(cap * n);
    this.iPos = f(3); this.iTail = f(3); this.iCol = f(4); this.iW = f(1);
    this.vel = f(3); this.life = f(1); this.maxLife = f(1); this.drag = f(1); this.grav = f(1);
    this.stretch = f(1); this.minLen = f(1); this.c0 = f(3); this.c1 = f(3); this.fixed = new Uint8Array(cap); this.peak = f(1);
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const ia = (a: Float32Array, n: number) => new THREE.InstancedBufferAttribute(a, n).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', ia(this.iPos, 3));
    g.setAttribute('iTail', ia(this.iTail, 3));
    g.setAttribute('iCol', ia(this.iCol, 4));
    g.setAttribute('iW', ia(this.iW, 1));
    g.instanceCount = 0;
    this.geo = g;
    const mat = new THREE.ShaderMaterial({
      uniforms: { fogCol: FOG.color, fogDen: FOG.density, pxH: { value: 300 } },
      vertexShader: /* glsl */ `
        attribute vec3 iPos; attribute vec3 iTail; attribute vec4 iCol; attribute float iW;
        uniform float pxH;
        varying vec4 vC; varying vec2 vQ; varying float vDepth;
        void main(){
          vec4 h = modelViewMatrix * vec4(iPos, 1.0);
          vec4 t = modelViewMatrix * vec4(iPos - iTail, 1.0);
          vec3 p = mix(t.xyz, h.xyz, position.y);
          vec3 d = h.xyz - t.xyz;
          vec3 side = cross(normalize(d + vec3(0.0, 1e-4, 0.0)), normalize(p));
          // never thinner than ~1.3 px: a 3 cm spark 20 m away would fall between pixels and vanish. A widened
          // streak gives back part of its brightness, so far sparks stay thin and faint instead of fat
          float w = max(iW, 1.3 * max(-p.z, 0.1) / (projectionMatrix[1][1] * pxH));
          p += normalize(side + vec3(1e-5)) * position.x * w;
          vC = iCol; vQ = position.xy; vDepth = -p.z;
          vC.a *= mix(1.0, iW / w, 0.55);
          vC.a *= smoothstep(0.6, 2.5, -p.z);
          gl_Position = projectionMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying vec4 vC; varying vec2 vQ; varying float vDepth;
        ${FOG_GLSL}
        void main(){
          float across = 1.0 - vQ.x * vQ.x;
          float along = mix(0.15, 1.0, vQ.y) * smoothstep(0.0, 0.25, vQ.y);
          gl_FragColor = vec4(vC.rgb * across * along * vC.a * (1.0 - fogAmount(vDepth)), 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      // the quad's winding follows the side vector, which flips with the streak's direction: draw both faces
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
  }
  setPx(halfHeight: number) {
    ((this.mesh.material as THREE.ShaderMaterial).uniforms.pxH as { value: number }).value = halfHeight;
  }
  /** A moving streak: tail = velocity × stretch (+ a minimum length). */
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, width: number, stretch: number, minLen: number, c0: THREE.Color, c1: THREE.Color, k: number, drag: number, grav: number) {
    if (this.count >= this.cap) return;
    const i = this.count++, i3 = i * 3;
    this.iPos[i3] = x; this.iPos[i3 + 1] = y; this.iPos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.life[i] = this.maxLife[i] = life; this.iW[i] = width; this.stretch[i] = stretch; this.minLen[i] = minLen;
    this.c0[i3] = c0.r * k; this.c0[i3 + 1] = c0.g * k; this.c0[i3 + 2] = c0.b * k;
    this.c1[i3] = c1.r * k; this.c1[i3 + 1] = c1.g * k; this.c1[i3 + 2] = c1.b * k;
    this.drag[i] = drag; this.grav[i] = grav; this.fixed[i] = 0; this.peak[i] = 1;
  }
  /** A fixed segment from a to b (electric arcs). */
  segment(ax: number, ay: number, az: number, bx: number, by: number, bz: number, life: number, width: number, c: THREE.Color, k: number) {
    if (this.count >= this.cap) return;
    const i = this.count++, i3 = i * 3;
    this.iPos[i3] = bx; this.iPos[i3 + 1] = by; this.iPos[i3 + 2] = bz;
    this.iTail[i3] = bx - ax; this.iTail[i3 + 1] = by - ay; this.iTail[i3 + 2] = bz - az;
    this.vel[i3] = this.vel[i3 + 1] = this.vel[i3 + 2] = 0;
    this.life[i] = this.maxLife[i] = life; this.iW[i] = width;
    this.c0[i3] = c.r * k; this.c0[i3 + 1] = c.g * k; this.c0[i3 + 2] = c.b * k;
    this.c1[i3] = c.r * k * 0.5; this.c1[i3 + 1] = c.g * k * 0.5; this.c1[i3 + 2] = c.b * k * 0.5;
    this.drag[i] = 0; this.grav[i] = 0; this.fixed[i] = 1; this.peak[i] = 1;
  }
  private kill(i: number) {
    const j = --this.count;
    if (i === j) return;
    const i3 = i * 3, j3 = j * 3;
    for (let k = 0; k < 3; k++) {
      this.iPos[i3 + k] = this.iPos[j3 + k]; this.iTail[i3 + k] = this.iTail[j3 + k]; this.vel[i3 + k] = this.vel[j3 + k];
      this.c0[i3 + k] = this.c0[j3 + k]; this.c1[i3 + k] = this.c1[j3 + k];
    }
    for (let k = 0; k < 4; k++) this.iCol[i * 4 + k] = this.iCol[j * 4 + k];
    this.life[i] = this.life[j]; this.maxLife[i] = this.maxLife[j]; this.iW[i] = this.iW[j]; this.stretch[i] = this.stretch[j];
    this.minLen[i] = this.minLen[j]; this.drag[i] = this.drag[j]; this.grav[i] = this.grav[j]; this.fixed[i] = this.fixed[j]; this.peak[i] = this.peak[j];
  }
  update(dt: number) {
    let i = 0;
    while (i < this.count) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.kill(i);
        continue;
      }
      const i3 = i * 3;
      const t = 1 - this.life[i] / this.maxLife[i];
      if (!this.fixed[i]) {
        const d = Math.exp(-this.drag[i] * dt);
        this.vel[i3] *= d;
        this.vel[i3 + 1] = this.vel[i3 + 1] * d - this.grav[i] * dt;
        this.vel[i3 + 2] *= d;
        this.iPos[i3] += this.vel[i3] * dt;
        this.iPos[i3 + 1] += this.vel[i3 + 1] * dt;
        this.iPos[i3 + 2] += this.vel[i3 + 2] * dt;
        if (this.iPos[i3 + 1] < 0.03 && this.grav[i] > 0) {
          // sparks skip off the asphalt and lose their heat
          this.iPos[i3 + 1] = 0.03;
          this.vel[i3 + 1] *= -0.3;
          this.vel[i3] *= 0.6;
          this.vel[i3 + 2] *= 0.6;
        }
        const st = this.stretch[i];
        const vx = this.vel[i3], vy = this.vel[i3 + 1], vz = this.vel[i3 + 2];
        const sp = Math.hypot(vx, vy, vz) || 1;
        const len = sp * st + this.minLen[i];
        this.iTail[i3] = (vx / sp) * len; this.iTail[i3 + 1] = (vy / sp) * len; this.iTail[i3 + 2] = (vz / sp) * len;
      }
      const a = (1 - t) * (1 - t);
      for (let k = 0; k < 3; k++) this.iCol[i * 4 + k] = this.c0[i3 + k] + (this.c1[i3 + k] - this.c0[i3 + k]) * t;
      this.iCol[i * 4 + 3] = a * this.peak[i];
      i++;
    }
    this.geo.instanceCount = this.count;
    for (const n of ['iPos', 'iTail', 'iCol', 'iW']) (this.geo.attributes[n] as THREE.InstancedBufferAttribute).needsUpdate = true;
  }
  clear() {
    this.count = 0;
    this.geo.instanceCount = 0;
  }
}

// ------------------------------------------------------------------------------------------------ debris

type DebrisShape = 0 | 1 | 2; // shard, chunk, panel
interface Debris {
  shape: DebrisShape; x: number; y: number; z: number; vx: number; vy: number; vz: number;
  rx: number; ry: number; rz: number; wx: number; wy: number; s: number; life: number; col: THREE.Color; rest: number;
}
/** A torn body panel: a sheet creased across the middle and buckled, with a ragged outline (seen from both sides). */
function panelGeo() {
  const g = new THREE.PlaneGeometry(1, 0.7, 4, 3).rotateX(-Math.PI / 2);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    const edge = Math.abs(x) > 0.49 || Math.abs(z) > 0.34;
    const jag = edge ? 0.72 + 0.28 * Math.abs(Math.sin(i * 2.7 + 1.3)) : 1;
    p.setXYZ(i, x * jag, 0.16 * (0.5 - Math.abs(x)) + 0.05 * Math.sin(z * 9 + x * 4), z * jag);
  }
  g.deleteAttribute('uv');
  g.computeVertexNormals();
  return g;
}

/** A broken lump (concrete, asphalt, a cast part): a squashed, irregular rock — never a cube. */
function chunkGeo() {
  const g = new THREE.IcosahedronGeometry(0.5, 0);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const k = 0.72 + 0.4 * Math.abs(Math.sin(p.getX(i) * 7.1 + p.getY(i) * 3.7 + p.getZ(i) * 5.3));
    p.setXYZ(i, p.getX(i) * k * 1.1, p.getY(i) * k * 0.72, p.getZ(i) * k);
  }
  g.deleteAttribute('uv');
  g.computeVertexNormals();
  return g;
}

function shardGeo() {
  const g = new THREE.BufferGeometry();
  // a flat, torn wedge: three-cornered top and bottom faces
  const v = [0, 0.04, 0.5, 0.42, 0.03, -0.3, -0.36, 0.05, -0.22, 0, -0.04, 0.5, 0.42, -0.03, -0.3, -0.36, -0.05, -0.22];
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.setIndex([0, 1, 2, 3, 5, 4, 0, 3, 4, 0, 4, 1, 1, 4, 5, 1, 5, 2, 2, 5, 3, 2, 3, 0]);
  return g.toNonIndexed().computeVertexNormals() as unknown as THREE.BufferGeometry;
}

// ------------------------------------------------------------------------------------------------ the effects

interface FlashLight { light: THREE.PointLight; t: number; attack: number; decay: number; power: number; flicker: number }
interface GroundFx { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; life: number; max: number; s0: number; s1: number; a0: number; kind: 'flash' | 'wave' | 'scorch' }
interface Later { t: number; fn: () => void }

const C = new THREE.Color();
const C2 = new THREE.Color();
const tmpC = (hex: number) => C.setHex(hex);
const WHITE = new THREE.Color(1, 1, 1);

/**
 * Smoke profiles: colour (start → end), size, growth, life, rise, drag, turbulence, opacity. Colours are mid-tones on
 * purpose: lighter than a night street and darker than the lit sky, so smoke reads against both (a realistically dark
 * smoke vanishes into the buildings behind it, a bright one into the haze); fire-lit smoke starts warm.
 */
export type SmokeKind = 'exhaust' | 'damage' | 'explosion' | 'dust' | 'burning' | 'tyre' | 'industrial' | 'mist' | 'steam' | 'rocket';
const SMOKE: Record<SmokeKind, { c0: number; c1: number; size: [number, number]; grow: number; life: [number, number]; rise: [number, number]; drag: number; turb: number; alpha: number }> = {
  exhaust: { c0: 0x8a8e96, c1: 0x5a5e66, size: [0.25, 0.45], grow: 1.6, life: [0.5, 0.9], rise: [0.3, 0.9], drag: 2.2, turb: 1.2, alpha: 0.32 },
  damage: { c0: 0x625c58, c1: 0x484748, size: [0.5, 0.9], grow: 1.8, life: [1.2, 2.0], rise: [1.6, 2.8], drag: 1.2, turb: 2.2, alpha: 0.55 },
  explosion: { c0: 0xa87454, c1: 0x5a5856, size: [1.4, 2.6], grow: 2.4, life: [2.2, 3.6], rise: [2.2, 4.2], drag: 1.1, turb: 2.6, alpha: 0.9 },
  dust: { c0: 0x9a8e78, c1: 0x7a7266, size: [0.6, 1.2], grow: 2.2, life: [0.7, 1.4], rise: [0.3, 0.9], drag: 2.4, turb: 1.4, alpha: 0.42 },
  burning: { c0: 0x6e5c50, c1: 0x444243, size: [0.9, 1.6], grow: 2.0, life: [1.8, 3.0], rise: [2.4, 4.0], drag: 0.9, turb: 2.4, alpha: 0.72 },
  tyre: { c0: 0xc8ccd4, c1: 0x9ea2aa, size: [0.6, 1.0], grow: 2.8, life: [0.9, 1.7], rise: [0.3, 0.8], drag: 2.0, turb: 1.8, alpha: 0.3 },
  industrial: { c0: 0x8a8680, c1: 0x5a5856, size: [2, 3.5], grow: 2.4, life: [4, 6], rise: [3, 5], drag: 0.6, turb: 2, alpha: 0.5 },
  mist: { c0: 0xc8d8e8, c1: 0xa0b0c0, size: [0.25, 0.5], grow: 1.4, life: [0.3, 0.55], rise: [0.05, 0.3], drag: 3, turb: 0.8, alpha: 0.18 },
  steam: { c0: 0xd0d4dc, c1: 0xa8acb4, size: [0.6, 1.0], grow: 2.6, life: [1.0, 1.8], rise: [1.4, 2.4], drag: 1.4, turb: 1.6, alpha: 0.3 },
  // a rocket motor's trail: pale, dense, hangs in the air where the missile passed
  rocket: { c0: 0xb4b0a8, c1: 0x6c6a68, size: [0.3, 0.5], grow: 1.5, life: [0.9, 1.6], rise: [0.05, 0.35], drag: 3, turb: 1.1, alpha: 0.45 },
};

export class Effects {
  readonly group = new THREE.Group();
  /** additive textured points: flames, fireballs, glows, embers, crackle */
  add: SpriteSystem;
  /** alpha points: smoke, dust, mist */
  smoke: SpriteSystem;
  /** lamp glare, rebuilt every frame */
  glare: SpriteSystem;
  streaks: StreakSystem;
  private debris: Debris[] = [];
  private debrisMeshes: THREE.InstancedMesh[] = [];
  private lights: FlashLight[] = [];
  private ground: GroundFx[] = [];
  private later: Later[] = [];
  private dummy = new THREE.Object3D();
  private time = 0;
  readonly skids: SkidMarks;
  /** environment response hook: an energy pulse makes the lamps around it stutter */
  onPulse: ((x: number, z: number, r: number) => void) | null = null;
  density = 1;

  constructor(private scene: THREE.Scene) {
    scene.add(this.group);
    this.add = new SpriteSystem(4200, true, addAtlas(), [4, 2]);
    this.smoke = new SpriteSystem(2800, false, smokeAtlas(), [2, 2]);
    this.glare = new SpriteSystem(400, true, addAtlas(), [4, 2]);
    this.streaks = new StreakSystem(2400);
    this.group.add(this.smoke.points, this.add.points, this.glare.points, this.streaks.mesh);
    const dm = new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.55, side: THREE.DoubleSide });
    const geos = [shardGeo(), chunkGeo(), panelGeo()];
    for (const g of geos) {
      const m = new THREE.InstancedMesh(g, dm, 120);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // the colour buffer exists from the start: created by the first setColorAt it switched the shader to another
      // variant (a compile in the middle of the first crash)
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(120 * 3).fill(1), 3).setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      m.frustumCulled = false;
      this.group.add(m);
      this.debrisMeshes.push(m);
    }
    for (let i = 0; i < 4; i++) {
      const light = new THREE.PointLight(0xffaa55, 0, 34, 2);
      light.position.set(0, -50, 0);
      this.group.add(light);
      this.lights.push({ light, t: 1, attack: 0.02, decay: 0.3, power: 0, flicker: 0 });
    }
    const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    for (let i = 0; i < 18; i++) {
      const mat = new THREE.MeshBasicMaterial({ map: flashTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -3 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.renderOrder = 3;
      this.group.add(mesh);
      this.ground.push({ mesh, mat, life: 0, max: 1, s0: 1, s1: 1, a0: 1, kind: 'flash' });
    }
    this.skids = new SkidMarks(900);
    this.group.add(this.skids.mesh);
  }

  setViewportHeight(h: number, maxPoint = 256) {
    for (const s of [this.add, this.smoke, this.glare]) s.setScale(h, maxPoint);
    this.streaks.setPx(h / 2);
  }
  /** The zone's light colours tint smoke (sodium amber, flood teal…) so it sits in the scene. */
  setAmbient(c: THREE.Color) {
    this.smoke.setTint(c);
  }

  private n(k: number) {
    return Math.max(1, Math.round(k * this.density));
  }
  /** Run `fn` after `delay` seconds of effect time: stages of one event. */
  after(delay: number, fn: () => void) {
    if (delay <= 0) fn();
    else this.later.push({ t: delay, fn });
  }

  // ---------------------------------------------------------------- building blocks

  /** One smoke puff of a profile. */
  puff(kind: SmokeKind, x: number, y: number, z: number, vx = 0, vy = 0, vz = 0, scale = 1, alphaK = 1) {
    const p = SMOKE[kind];
    const e = E0();
    e.x = x; e.y = y; e.z = z;
    e.vx = vx + frand(-0.6, 0.6); e.vy = vy + frand(p.rise[0], p.rise[1]); e.vz = vz + frand(-0.6, 0.6);
    e.life = frand(p.life[0], p.life[1]) * Math.sqrt(scale);
    e.size = frand(p.size[0], p.size[1]) * scale;
    e.grow = p.grow * scale * frand(0.8, 1.2);
    col(e, tmpC(p.c0), frand(0.85, 1.1));
    col1(e, tmpC(p.c1), frand(0.85, 1.1));
    e.alpha = p.alpha * alphaK * frand(0.75, 1);
    e.fadeIn = kind === 'explosion' ? 0.14 : 0.12;
    e.drag = p.drag;
    e.turb = p.turb;
    e.spin = frand(-0.6, 0.6);
    e.frame = Math.floor(Math.random() * 4);
    this.smoke.emit(e);
  }

  /** Flame tongue / fireball lump (additive): white-hot → orange → dark red. */
  flame(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, life: number, ball = false, hot = 1) {
    const e = E0();
    e.x = x; e.y = y; e.z = z; e.vx = vx; e.vy = vy; e.vz = vz;
    e.life = life; e.size = size; e.grow = ball ? size * 1.6 : -size * 0.6;
    const k = VFX.spark * 0.8 * hot;
    // (red-heavy: overlapping lumps add up, and anything with much green or blue in it sums to white under bloom)
    e.r = 1.0 * k; e.g = 0.6 * k; e.b = 0.22 * k;
    e.r1 = 0.5 * k; e.g1 = 0.08 * k; e.b1 = 0.01 * k;
    e.alpha = 1;
    e.fadeIn = 0.05;
    e.drag = ball ? 3 : 1.4;
    e.grav = ball ? -1.5 : -3;
    e.turb = 2;
    e.rot = ball ? frand(0, 6.28) : frand(-0.3, 0.3);
    e.spin = ball ? frand(-1.5, 1.5) : frand(-0.4, 0.4);
    e.frame = ball ? (Math.random() < 0.5 ? ADD_FRAME.ballA : ADD_FRAME.ballB) : Math.random() < 0.5 ? ADD_FRAME.flameA : ADD_FRAME.flameB;
    this.add.emit(e);
  }

  /** A soft glow dot or glare (additive), static or drifting. */
  glow(x: number, y: number, z: number, color: number, size: number, life: number, k = 1, frame: number = ADD_FRAME.dot, vx = 0, vy = 0, vz = 0) {
    const e = E0();
    e.x = x; e.y = y; e.z = z; e.vx = vx; e.vy = vy; e.vz = vz;
    e.life = life; e.size = size; e.grow = 0;
    col(e, tmpC(color), k);
    col1(e, C, k * 0.6);
    e.alpha = 1; e.fadeIn = 0.06; e.drag = 2; e.spin = 0; e.rot = 0; e.frame = frame;
    this.add.emit(e);
  }

  /** Ground decal: a hot flash, a pressure wave, a scorch mark. */
  decal(kind: GroundFx['kind'], x: number, y: number, z: number, s0: number, s1: number, color: number, alpha: number, life: number) {
    const gfx = this.ground.find((q) => q.life <= 0) ?? this.ground.reduce((a, b) => (a.life < b.life ? a : b));
    gfx.kind = kind;
    gfx.life = gfx.max = life;
    gfx.s0 = s0; gfx.s1 = s1; gfx.a0 = alpha;
    const m = gfx.mat;
    m.map = kind === 'wave' ? waveTexture() : kind === 'scorch' ? hazardTexture('scorch') : flashTexture();
    m.blending = kind === 'scorch' ? THREE.NormalBlending : THREE.AdditiveBlending;
    m.color.setHex(color);
    m.needsUpdate = true;
    gfx.mesh.position.set(x, y + 0.03 + (kind === 'scorch' ? 0 : 0.01), z);
    gfx.mesh.rotation.y = frand(0, Math.PI * 2);
    gfx.mesh.visible = true;
    gfx.mesh.scale.setScalar(s0);
  }

  /** A pooled point light with an attack/decay envelope (and optional flicker). */
  flashLight(x: number, y: number, z: number, color: number, power: number, life: number, attack = 0.02, flicker = 0) {
    const f = this.lights.reduce((a, b) => (a.t / (a.attack + a.decay) > b.t / (b.attack + b.decay) ? a : b));
    f.light.position.set(x, y, z);
    f.light.color.setHex(color);
    f.t = 0;
    f.attack = attack;
    f.decay = life;
    f.power = power;
    f.flicker = flicker;
  }

  // ---------------------------------------------------------------- sparks, impacts, debris

  /**
   * Hot sparks: short streaks thrown along `dir` (the slide or the contact) inside a cone, a few that skip off the
   * road; white-yellow cooling to deep orange. No direction → a burst up and out.
   */
  sparks(x: number, y: number, z: number, n: number, color = 0xffc060, speed = 10, dirX = 0, dirZ = 0) {
    const hot = C.setHex(color).lerp(C2.setRGB(1, 1, 1), 0.45).clone();
    const cool = C2.setHex(0xff3a08).clone();
    const dl = Math.hypot(dirX, dirZ);
    const ux = dl > 0.5 ? dirX / dl : 0, uz = dl > 0.5 ? dirZ / dl : 0;
    for (let i = 0; i < this.n(n); i++) {
      let vx: number, vz: number;
      const sp = frand(0.35, 1) * speed + dl * 0.6;
      if (dl > 0.5) {
        // a fan along the direction, a little spread either side
        const a = Math.atan2(ux, uz) + frand(-0.55, 0.55);
        vx = Math.sin(a) * sp;
        vz = Math.cos(a) * sp;
      } else {
        const a = frand(0, Math.PI * 2);
        vx = Math.cos(a) * sp;
        vz = Math.sin(a) * sp;
      }
      const big = Math.random() < 0.18;
      this.streaks.emit(x, y, z, vx, frand(0.3, 1.1) * speed * 0.55, vz, frand(0.16, 0.42) * (big ? 1.4 : 1), big ? 0.045 : 0.028, 0.03, 0.04, hot, cool, VFX.spark, 1.4, 22);
    }
  }

  /**
   * Hit something. strength 0..1, dir = the slide / contact direction, surface: what was hit.
   * Staged: contact flash and sparks now, shards a beat later, dust and (on big hits) smoke after that.
   * Varies between calls: sparks only, sparks + dust, shards, or the full set.
   */
  impact(x: number, y: number, z: number, dirX: number, dirZ: number, strength: number, surface: 'metal' | 'concrete' | 'glass' | 'plastic' = 'metal', paint = 0x777777) {
    const s = Math.max(0, Math.min(1, strength));
    const v = Math.random();
    const sp = 5 + s * 12;
    // contact: a short white-hot flash where the metal meets
    this.glow(x, y, z, 0xfff0d0, 0.5 + s * 1.6, 0.07 + s * 0.06, 1.6, ADD_FRAME.glare);
    if (s > 0.35) this.flashLight(x, y + 0.8, z, 0xffd8a0, 0.8 + s * 2.4, 0.08 + s * 0.08);
    const nSparks = surface === 'concrete' ? 3 + s * 14 : surface === 'plastic' ? 2 + s * 6 : 5 + s * 34;
    this.sparks(x, y, z, nSparks, 0xffc070, sp, dirX * 0.6, dirZ * 0.6);
    if (s > 0.25 || v > 0.5) {
      this.after(0.03, () => {
        const nd = Math.round(s * (surface === 'concrete' ? 10 : 7) + (v > 0.7 ? 2 : 0));
        if (nd > 0) this.debrisBurst(x, y, z, nd, surface === 'concrete' ? 0x8a8a90 : paint, 3 + s * 7, dirX, dirZ, surface === 'concrete' ? 1 : 0);
        if (surface === 'glass' || (s > 0.6 && v > 0.4)) this.glassBurst(x, y + 0.4, z, 4 + Math.round(s * 10), dirX, dirZ);
      });
    }
    this.after(0.05, () => {
      const nd = Math.round(1 + s * (surface === 'concrete' ? 6 : 3));
      for (let i = 0; i < this.n(nd); i++) this.puff('dust', x + frand(-0.6, 0.6), 0.25, z + frand(-0.6, 0.6), dirX * 0.15 + frand(-1.5, 1.5), 0, dirZ * 0.15 + frand(-1.5, 1.5), 0.6 + s * 0.6);
    });
    if (s > 0.55) this.after(0.25, () => {
      for (let i = 0; i < this.n(2 + s * 3); i++) this.puff('damage', x + frand(-0.5, 0.5), y + 0.3, z + frand(-0.5, 0.5), dirX * 0.08, 0, dirZ * 0.08, 0.8);
    });
  }

  /** Tumbling pieces. shape: 0 shards (metal), 1 chunks (concrete / body), 2 panels; mixed when undefined. */
  debrisBurst(x: number, y: number, z: number, n: number, color: number, speed = 9, dirX = 0, dirZ = 0, shape?: DebrisShape, size = 1) {
    const base = new THREE.Color(color);
    const dl = Math.hypot(dirX, dirZ) || 1;
    for (let i = 0; i < this.n(n); i++) {
      if (this.debris.length >= 330) this.debris.shift();
      const sh: DebrisShape = shape ?? (Math.random() < 0.5 ? 0 : Math.random() < 0.6 ? 2 : 1);
      const a = frand(0, Math.PI * 2);
      const sp = frand(0.3, 1) * speed;
      const c = Math.random() < 0.55 ? base.clone().multiplyScalar(frand(0.6, 1)) : new THREE.Color(0x1c1c22);
      this.debris.push({
        shape: sh, x, y: y + 0.4, z,
        vx: Math.cos(a) * sp + (dirX / dl) * speed * 0.5, vy: frand(2.5, 8) * (sh === 1 ? 0.8 : 1), vz: Math.sin(a) * sp + (dirZ / dl) * speed * 0.5,
        rx: frand(0, 6), ry: frand(0, 6), rz: frand(0, 6), wx: frand(-12, 12), wy: frand(-12, 12),
        s: (sh === 1 ? frand(0.12, 0.38) : sh === 2 ? frand(0.14, 0.38) : frand(0.15, 0.48)) * size, life: frand(1.6, 3.2), col: c, rest: 0,
      });
    }
  }
  /** Glass: small bright shards that glint and scatter low. */
  glassBurst(x: number, y: number, z: number, n: number, dirX = 0, dirZ = 0) {
    this.debrisBurst(x, y, z, n, 0xb8d8f0, 6, dirX, dirZ, 0);
    for (let i = 0; i < this.n(n); i++) this.glow(x + frand(-0.6, 0.6), y + frand(-0.2, 0.4), z + frand(-0.6, 0.6), 0xd0e8ff, 0.07, frand(0.15, 0.35), 1.6, ADD_FRAME.dot, frand(-3, 3) + dirX * 0.2, frand(1, 4), frand(-3, 3) + dirZ * 0.2);
  }

  // ---------------------------------------------------------------- fire and smoke

  /** Flames (burning wrecks, fire hazards): tongues licking up, with smoke above them. */
  fire(x: number, y: number, z: number, n = 1, size = 1) {
    for (let i = 0; i < this.n(n); i++) {
      this.flame(x + frand(-0.45, 0.45) * size, y + frand(0, 0.2), z + frand(-0.45, 0.45) * size, frand(-0.4, 0.4), frand(1.6, 3.4) * Math.sqrt(size), frand(-0.4, 0.4), frand(0.5, 0.9) * size, frand(0.28, 0.5), false, 0.9);
      if (Math.random() < 0.35) this.puff('burning', x + frand(-0.3, 0.3), y + 1.1 * size, z + frand(-0.3, 0.3), 0, 0, 0, Math.sqrt(size) * 0.8);
    }
  }

  /** Legacy smoke call: dark = damage / burning smoke, light = dust. */
  smokePuff(x: number, y: number, z: number, n: number, dark = true, size = 1) {
    for (let i = 0; i < this.n(n); i++) this.puff(dark ? (size > 1.6 ? 'burning' : 'damage') : 'dust', x + frand(-0.8, 0.8) * size, y + frand(0, 0.6), z + frand(-0.8, 0.8) * size, frand(-1, 1), 0, frand(-1, 1), size);
  }

  /** Tyre smoke from a contact patch: low, rolling, spreading into the car's wake. */
  tireSmoke(x: number, z: number, vx: number, vz: number, intensity: number, tint = 0xc8ccd4) {
    if (intensity < 0.05 || Math.random() > (0.45 + intensity * 0.55) * this.density) return;
    const p = SMOKE.tyre;
    const e = E0();
    e.x = x + frand(-0.15, 0.15); e.y = 0.22; e.z = z + frand(-0.15, 0.15);
    e.vx = vx * 0.22 + frand(-1.2, 1.2); e.vy = frand(p.rise[0], p.rise[1]); e.vz = vz * 0.22 + frand(-1.2, 1.2);
    e.life = frand(p.life[0], p.life[1]) * (0.8 + intensity * 0.4);
    e.size = frand(p.size[0], p.size[1]) * (0.7 + intensity * 0.5);
    e.grow = p.grow * (0.8 + intensity * 0.5);
    const c = tmpC(tint);
    col(e, c, 0.9);
    col1(e, c, 0.7);
    e.alpha = p.alpha * Math.min(1, 0.25 + intensity * 0.65);
    e.fadeIn = 0.08; e.drag = p.drag; e.turb = p.turb; e.spin = frand(-0.8, 0.8); e.frame = Math.floor(Math.random() * 4);
    this.smoke.emit(e);
  }

  /** Dust kicked up (shoulders, impacts, landings): dry, lighter than smoke, low and quick. */
  dust(x: number, y: number, z: number, n: number, spread = 1, vx = 0, vz = 0) {
    for (let i = 0; i < this.n(n); i++) this.puff('dust', x + frand(-spread, spread), y, z + frand(-spread, spread), vx * 0.2 + frand(-2, 2) * spread, 0, vz * 0.2 + frand(-2, 2) * spread, 0.7 + spread * 0.3);
  }

  /** Wet road: a fan of mist and thin bright droplets thrown back off a tyre. */
  spray(x: number, z: number, vx: number, vz: number, intensity: number) {
    if (Math.random() > intensity * this.density) return;
    // a fine, wide haze (faint: it is mostly the droplets that read), never a puff
    if (Math.random() < 0.35) this.puff('mist', x, 0.25, z, vx * 0.35, 0, vz * 0.35, 1 + intensity * 0.6, 0.2);
    // (streaks copy the colour components: the scratch colours need no copies)
    const c0 = C.setRGB(0.75, 0.85, 1);
    const c1 = C2.setRGB(0.3, 0.4, 0.5);
    for (let i = 0; i < 2; i++) this.streaks.emit(x + frand(-0.2, 0.2), 0.15, z + frand(-0.2, 0.2), vx * 0.5 + frand(-2, 2), frand(1, 3), vz * 0.5 + frand(-2, 2), frand(0.15, 0.3), 0.012, 0.02, 0.05, c0, c1, 0.6, 1.5, 9);
  }

  // ---------------------------------------------------------------- exhausts

  /**
   * Exhaust at a tailpipe, pointing `dir` (unit, world). Modes:
   *   boost — a hot core at the nozzle, a stable blue-white jet streaking back, a little orange flame at its end
   *   pop   — one short bang of flame and a smoke puff (hard throttle, gear shifts)
   *   smoke — a damaged engine coughing dark smoke
   */
  exhaust(x: number, y: number, z: number, dx: number, dy: number, dz: number, carVx: number, carVz: number, mode: 'boost' | 'pop' | 'smoke', color = 0x40a0ff, k = 1) {
    if (mode === 'boost') {
      const c = tmpC(color);
      // C2 stays untouched until the core segment below (glow only uses C)
      const core = C2.copy(c).lerp(WHITE, 0.6);
      this.glow(x, y, z, core.getHex(), 0.6 * k, 0.05, 1.9, ADD_FRAME.glare);
      // seen from behind (the usual view) the jet points at the camera: what reads is a hot, ragged lobe at the nozzle
      for (let i = 0; i < 2; i++) this.glow(x + dx * (0.12 + i * 0.22), y, z + dz * (0.12 + i * 0.22), color, (0.34 - i * 0.08) * k, frand(0.04, 0.07), 1.5, Math.random() < 0.5 ? ADD_FRAME.ballA : ADD_FRAME.ballB, carVx + dx * 6, 0, carVz + dz * 6);
      // the jet: a white-hot core and a coloured sheath, flickering in length, redrawn every frame on the nozzle
      const lc = (0.55 + Math.random() * 0.35) * k, ls = (0.9 + Math.random() * 0.5) * k;
      this.streaks.segment(x, y, z, x + dx * lc, y + dy * lc, z + dz * lc, 0.02, 0.06 * k, core, VFX.nitro * 1.6);
      this.streaks.segment(x, y, z, x + dx * ls, y + dy * ls, z + dz * ls, 0.02, 0.13 * k, c, VFX.nitro * 0.9);
      if (Math.random() < 0.7) this.flame(x + dx * 0.3, y, z + dz * 0.3, carVx + dx * 5, 0.3, carVz + dz * 5, 0.32 * k, frand(0.06, 0.12), false, 0.8);
      if (Math.random() < 0.15) this.puff('exhaust', x + dx * 0.8, y, z + dz * 0.8, carVx * 0.6, 0, carVz * 0.6, 0.6, 0.5);
    } else if (mode === 'pop') {
      for (let i = 0; i < 3; i++) this.flame(x + dx * 0.15, y, z + dz * 0.15, carVx + dx * frand(3, 6), frand(0, 0.6), carVz + dz * frand(3, 6), frand(0.25, 0.4), frand(0.06, 0.11), true, 1.1);
      this.glow(x, y, z, 0xffb060, 0.5, 0.06, 1.6, ADD_FRAME.glare);
      this.puff('exhaust', x + dx * 0.4, y, z + dz * 0.4, carVx * 0.5 + dx * 2, 0, carVz * 0.5 + dz * 2, 0.8, 0.8);
    } else {
      this.puff('damage', x + dx * 0.2, y, z + dz * 0.2, carVx * 0.4 + dx * 1.5, 0, carVz * 0.4 + dz * 1.5, 0.5, 0.7);
    }
  }

  /** Legacy nitro call (enemy boosts): routed to the exhaust jet. */
  nitro(x: number, y: number, z: number, vx: number, vz: number, color = 0x40c0ff) {
    const l = Math.hypot(vx, vz) || 1;
    this.exhaust(x, y, z, vx / l, 0, vz / l, 0, 0, 'boost', color, 0.8);
  }

  // ---------------------------------------------------------------- energy

  /** Electric crackle around a point: tiny arcs and crackle sprites. */
  electric(x: number, y: number, z: number, n: number, color = 0x80d8ff) {
    const c = new THREE.Color(color);
    for (let i = 0; i < this.n(n); i++) {
      const px = x + frand(-0.7, 0.7), py = y + frand(0, 1), pz = z + frand(-0.7, 0.7);
      if (Math.random() < 0.5) this.glow(px, py, pz, color, frand(0.25, 0.5), frand(0.06, 0.14), VFX.electric * 0.8, ADD_FRAME.crackle);
      else this.streaks.segment(px, py, pz, px + frand(-0.5, 0.5), py + frand(-0.4, 0.4), pz + frand(-0.5, 0.5), frand(0.05, 0.1), 0.02, c, VFX.electric);
    }
  }

  /** Lightning between two points: a jagged chain of glowing segments with a bright core, and a crackle at the end. */
  bolt(ax: number, ay: number, az: number, bx: number, by: number, bz: number, color = 0x9fe8ff) {
    const c = new THREE.Color(color);
    const white = new THREE.Color(1, 1, 1);
    const segs = 9;
    let px = ax, py = ay, pz = az;
    const len = Math.hypot(bx - ax, by - ay, bz - az);
    const j = Math.min(1.1, len * 0.08);
    for (let i = 1; i <= segs; i++) {
      const t = i / segs;
      const end = i === segs;
      const qx = ax + (bx - ax) * t + (end ? 0 : frand(-j, j)), qy = ay + (by - ay) * t + (end ? 0 : frand(-j, j) * 0.7), qz = az + (bz - az) * t + (end ? 0 : frand(-j, j));
      this.streaks.segment(px, py, pz, qx, qy, qz, 0.14, 0.09, c, VFX.electric * 0.7);
      this.streaks.segment(px, py, pz, qx, qy, qz, 0.1, 0.025, white, VFX.electric);
      px = qx; py = qy; pz = qz;
    }
    this.electric(bx, by, bz, 5, color);
    this.glow(bx, by, bz, color, 0.9, 0.1, 1.4, ADD_FRAME.glare);
  }

  /**
   * EMP: a blue-white core flash and light, arcs snapping out, a fast faint wave of energy along the ground (lives a
   * quarter of a second, broken up — read as a pulse, not a ring), motes thrown outward, and the lamps around stutter.
   */
  emp(x: number, y: number, z: number, radius: number, color = 0x5ad1ff) {
    this.glow(x, y + 0.8, z, 0xe0f4ff, 2.6, 0.14, 2.2, ADD_FRAME.glare);
    this.flashLight(x, y + 2, z, color, 2.2, 0.22, 0.01, 0.6);
    this.decal('flash', x, y, z, radius * 0.2, radius * 0.38, color, 0.12, 0.16);
    this.decal('wave', x, y, z, radius * 0.25, radius * 1.15, color, 0.16, 0.26);
    for (let i = 0; i < 9; i++) {
      const a = (i / 7) * Math.PI * 2 + frand(-0.3, 0.3), r = radius * frand(0.35, 0.7);
      this.bolt(x, y + 1, z, x + Math.cos(a) * r, y + frand(0.2, 1.4), z + Math.sin(a) * r, color);
    }
    const c = new THREE.Color(color);
    for (let i = 0; i < this.n(30); i++) {
      const a = frand(0, Math.PI * 2), sp = radius * frand(2.2, 3.4);
      this.streaks.emit(x + Math.cos(a) * 1.2, y + frand(0.2, 1.4), z + Math.sin(a) * 1.2, Math.cos(a) * sp, frand(-0.5, 1), Math.sin(a) * sp, frand(0.2, 0.32), 0.03, 0.025, 0.1, c, c, VFX.electric * 0.6, 3, 0);
    }
    this.onPulse?.(x, z, radius * 2.2);
  }

  /**
   * Energy release (abilities, repair, phase, pickup bursts): a soft glow on the ground under it and motes thrown out
   * along the road — never a drawn circle.
   */
  pulse(x: number, y: number, z: number, radius: number, color: number, life = 0.45) {
    this.decal('flash', x, y, z, radius * 0.4, radius * 1.1, color, 0.5, life * 0.7);
    const c = new THREE.Color(color);
    for (let i = 0; i < this.n(18 + radius * 2); i++) {
      const a = frand(0, Math.PI * 2), sp = radius * frand(1.6, 2.6);
      this.streaks.emit(x + Math.cos(a) * 0.8, y + frand(0.1, 1), z + Math.sin(a) * 0.8, Math.cos(a) * sp, frand(0, 2), Math.sin(a) * sp, frand(0.18, 0.3), 0.04, 0.02, 0.08, c, c, 1.2, 3.5, 0);
    }
    this.glow(x, y + 0.8, z, color, radius * 0.5, 0.12, 1.2, ADD_FRAME.glare);
  }
  /** Legacy ring call: now an energy pulse. */
  ring(x: number, y: number, z: number, radius: number, color: number, life = 0.5) {
    this.pulse(x, y, z, radius, color, life);
  }

  /** Shockwave (an ability's blast of force): dust thrown out in a wave along the road, a faint pressure band. */
  shock(x: number, y: number, z: number, radius: number, color = 0xffe066) {
    this.decal('wave', x, y, z, radius * 0.2, radius * 1.1, 0xd8c8a8, 0.32, 0.3);
    this.decal('flash', x, y, z, radius * 0.3, radius * 0.6, color, 0.45, 0.18);
    for (let i = 0; i < this.n(26); i++) {
      const a = (i / 26) * Math.PI * 2 + frand(-0.1, 0.1), sp = radius * frand(1.4, 2.2);
      this.puff('dust', x + Math.cos(a) * 1.5, 0.3, z + Math.sin(a) * 1.5, Math.cos(a) * sp, 0, Math.sin(a) * sp, 0.9);
    }
    this.sparks(x, 0.4, z, 16, 0xffe0a0, 9);
  }

  /** Muzzle flash: a directional tongue of flame, a white core, smoke, a short light pulse. */
  muzzle(x: number, y: number, z: number, dirX: number, dirZ: number, color = 0xffb040) {
    this.glow(x, y, z, 0xfff0d0, 0.9, 0.05, 2, ADD_FRAME.glare);
    for (let i = 0; i < 4; i++) this.flame(x + dirX * 0.2 * i, y, z + dirZ * 0.2 * i, dirX * frand(6, 12), frand(-0.5, 0.5), dirZ * frand(6, 12), 0.45 - i * 0.07, 0.07, true, 1.2);
    const c = new THREE.Color(color);
    for (let i = 0; i < 5; i++) this.streaks.emit(x, y, z, dirX * frand(18, 30) + frand(-3, 3), frand(-1, 2), dirZ * frand(18, 30) + frand(-3, 3), 0.08, 0.03, 0.02, 0.1, c, c, 1.8, 2, 4);
    this.puff('exhaust', x + dirX * 0.6, y, z + dirZ * 0.6, dirX * 3, 0.5, dirZ * 3, 0.9, 0.7);
    this.flashLight(x, y + 0.4, z, color, 6, 0.08);
  }

  /** Pickup collected: motes rush in, then a small bright burst and a glint. */
  collect(x: number, y: number, z: number, color: number) {
    const c = new THREE.Color(color);
    this.flashLight(x, y + 0.3, z, color, 1.4, 0.2, 0.06);
    for (let i = 0; i < this.n(16); i++) {
      const a = frand(0, Math.PI * 2), r = frand(1.2, 2.2), h = frand(-0.6, 1);
      this.streaks.emit(x + Math.cos(a) * r, y + h, z + Math.sin(a) * r, -Math.cos(a) * r * 7, -h * 7, -Math.sin(a) * r * 7, 0.12, 0.035, 0.02, 0.05, c, c, 1.6, 0, 0);
    }
    this.after(0.1, () => {
      this.glow(x, y, z, color, 1.6, 0.16, 1.6, ADD_FRAME.glare);
      for (let i = 0; i < this.n(12); i++) this.glow(x, y, z, color, 0.14, frand(0.25, 0.45), 1.6, ADD_FRAME.star, frand(-4, 4), frand(1, 5), frand(-4, 4));
    });
  }

  /**
   * Speed: thin air streaks rushing past the sides and top of the view (never the middle, where you read the road)
   * and a few motes caught in the light. k 0..1 above cruising speed.
   */
  speedLines(x: number, y: number, z: number, fx: number, fz: number, vx: number, vz: number, k: number) {
    if (Math.random() > Math.min(1, k * 1.2) * this.density) return;
    const c0 = C.setRGB(0.55, 0.62, 0.72);
    const side = Math.random() < 0.5 ? -1 : 1;
    const up = Math.random() < 0.3;
    const off = up ? frand(-6, 6) : frand(5.5, 11) * side;
    const h = up ? frand(5, 8) : frand(0.4, 4.5);
    const d = frand(22, 34);
    this.streaks.emit(x + fx * d - fz * off, y + h, z + fz * d + fx * off, -vx * 1.15, 0, -vz * 1.15, 0.28, 0.012, 0.045, 0.2, c0, c0, 0.5 + k * 0.4, 0, 0);
    if (Math.random() < 0.35) this.glow(x + fx * d - fz * off * 0.7, y + frand(0.3, 2), z + fz * d + fx * off * 0.7, 0xc8d4e8, 0.05, 0.3, 0.7, ADD_FRAME.dot, -vx, 0, -vz);
  }

  /** Air ripping past: a few thin streaks at a point, flowing back along a velocity (near misses, slipstream). */
  whoosh(x: number, y: number, z: number, vx: number, vz: number, n: number, color = 0xc8e4ff, k = 0.8) {
    const c = C.setHex(color).clone();
    for (let i = 0; i < this.n(n); i++) {
      this.streaks.emit(x + frand(-0.8, 0.8), y + frand(-0.6, 0.8), z + frand(-0.8, 0.8), -vx * frand(0.5, 0.9), frand(-0.3, 0.3), -vz * frand(0.5, 0.9), frand(0.12, 0.22), 0.016, 0.05, 0.3, c, c, k, 0.5, 0);
    }
  }

  /** A glowing trail dot (light ribbons, phase trails). */
  trail(x: number, y: number, z: number, color: number, size = 0.5, life = 0.35) {
    this.glow(x, y, z, color, size, life, VFX.trail * 0.8);
  }

  // ---------------------------------------------------------------- explosions

  /**
   * Explosion, staged:
   *   0 ms   flash: a white core, a light that lights the street, a hot flash on the road
   *   0-80   fireball lumps rolling out and up; sparks and hot embers thrown wide
   *   40     the pressure wave: dust along the road, a faint broken band
   *   60     debris chunks
   *   120+   dark smoke rolling up, lit orange from below at first
   *   300    for big ones, secondary pops; a scorch mark stays on the asphalt
   */
  explosion(x: number, y: number, z: number, radius: number, color = 0xff8a30) {
    const k = Math.min(2.2, Math.max(0.5, radius / 6));
    const v = Math.random();
    this.glow(x, y + 1, z, 0xfff4e0, 3.4 * k, 0.11, 2.4, ADD_FRAME.glare);
    this.flashLight(x, y + 2.4, z, color, 8 * k, 0.5 + 0.2 * k, 0.015, 0.25);
    this.decal('flash', x, y, z, radius * 0.9, radius * 1.8, color, 0.55, 0.45);
    // the fireball: a hot core and lumps rolling out and up, about as big as the blast
    // (two offset cores, so the ball is lumpy from the first frame)
    this.flame(x, y + 1.2, z, 0, 2, 0, radius * 1.0, 0.32, true, 0.7);
    this.flame(x + frand(-1, 1) * k, y + 1.9 * k, z + frand(-1, 1) * k, 0, 3, 0, radius * 0.8, 0.45, true, 0.6);
    for (let i = 0; i < this.n(12 * k); i++) {
      const a = frand(0, Math.PI * 2), sp = frand(3, 10) * k;
      this.flame(x + Math.cos(a) * 0.6, y + frand(0.4, 1.6), z + Math.sin(a) * 0.6, Math.cos(a) * sp, frand(1.5, 6) * k, Math.sin(a) * sp, frand(0.35, 0.7) * radius, frand(0.35, 0.8), true, frand(0.4, 0.7));
    }
    this.sparks(x, y + 0.8, z, 26 * k, 0xffd080, 15 * k);
    // embers: slow, long-lived, falling
    for (let i = 0; i < this.n(14 * k); i++) this.glow(x, y + 1, z, 0xff9a40, frand(0.07, 0.14), frand(0.8, 1.6), 1.5, ADD_FRAME.star, frand(-6, 6) * k, frand(4, 11) * k, frand(-6, 6) * k);
    this.after(0.04, () => {
      this.decal('wave', x, y, z, radius * 0.5, radius * 3, 0xd0b898, 0.22, 0.32);
      for (let i = 0; i < this.n(14 * k); i++) {
        const a = (i / (14 * k)) * Math.PI * 2, sp = radius * frand(2.5, 3.5);
        this.puff('dust', x + Math.cos(a) * 0.8, 0.3, z + Math.sin(a) * 0.8, Math.cos(a) * sp, 0, Math.sin(a) * sp, 0.8 * k);
      }
    });
    this.after(0.06, () => this.debrisBurst(x, y + 0.4, z, Math.round(6 + radius * 1.2), 0x2a2622, 9 * k, 0, 0, v < 0.5 ? 1 : undefined));
    // smoke: born around the fireball's shell while it still burns, rolling outward and up, swallowing it; it is
    // darker and greyer than the lit haze behind it, so it reads against the sky instead of melting into the fog
    this.after(0.08, () => {
      for (let i = 0; i < this.n(12 * k); i++) {
        const a = frand(0, Math.PI * 2), r = radius * frand(0.25, 0.5);
        this.puff('explosion', x + Math.cos(a) * r, y + frand(0.8, 2.2) * k, z + Math.sin(a) * r, Math.cos(a) * 1.6, frand(0, 1.5), Math.sin(a) * 1.6, k * 1.1);
      }
    });
    // then the column: fed in waves for a second, so the smoke hangs over the spot instead of blinking out
    for (let w = 0; w < 4; w++) {
      this.after(0.45 + w * 0.28, () => {
        for (let i = 0; i < this.n(3 * k); i++) this.puff('burning', x + frand(-0.8, 0.8) * k, y + (1.6 + w * 0.5) * k, z + frand(-0.8, 0.8) * k, 0, 0, 0, k * (1 - w * 0.12));
      });
    }
    if (radius > 6 || v > 0.6) {
      this.after(frand(0.22, 0.36), () => {
        const a = frand(0, Math.PI * 2), r = radius * 0.4;
        for (let i = 0; i < 4; i++) this.flame(x + Math.cos(a) * r, y + 1, z + Math.sin(a) * r, frand(-2, 2), frand(2, 5), frand(-2, 2), frand(0.8, 1.2) * k, 0.4, true, 1.1);
        this.sparks(x + Math.cos(a) * r, y + 1, z + Math.sin(a) * r, 10, 0xffd080, 10);
      });
    }
    this.decal('scorch', x, y, z, radius * 1.1, radius * 1.25, 0x000000, 0.6, 9);
  }

  /**
   * A big machine dying (bosses): it escalates — sparks and small pops from the body, then the main blast, then
   * secondary blasts walking along it — and burns: a column of black smoke, flames and embers for seconds after.
   * size ~ the machine's half length.
   */
  /**
   * The death of a big machine, staged on a live position (the wreck keeps rolling): popping escalation,
   * the main blast, two secondaries, then a burning, smoking hulk whose smoke stays where it was made.
   */
  deathSequence(at: { x: number; y: number; z: number }, size: number, color = 0xff8020) {
    for (let i = 0; i < 6; i++) {
      this.after(i * 0.1, () => {
        const x = at.x + frand(-size, size), z = at.z + frand(-size, size);
        this.sparks(x, at.y + 1.2, z, 10, 0xffd080, 8);
        this.flame(x, at.y + 1.2, z, 0, 2, 0, 0.8, 0.25, true, 1.2);
        this.flashLight(x, at.y + 2, z, color, 3, 0.12);
      });
    }
    this.after(0.7, () => this.explosion(at.x, at.y, at.z, 5 + size, color));
    this.after(1.05, () => this.explosion(at.x + frand(-size, size), at.y + 0.5, at.z + frand(-size, size), 3 + size * 0.6, 0xffd060));
    this.after(1.4, () => this.explosion(at.x + frand(-size, size), at.y + 0.5, at.z + frand(-size, size), 3 + size * 0.5, color));
    for (let i = 0; i < 30; i++) {
      this.after(0.8 + i * 0.1, () => {
        const { x, y, z } = at;
        this.puff('burning', x + frand(-0.6, 0.6) * size, y + 1.5 + size * 0.3, z + frand(-0.6, 0.6) * size, 0, 0, 0, 1.2 + size * 0.15);
        if (i % 2 === 0) this.fire(x + frand(-0.5, 0.5) * size, y + 0.6, z + frand(-0.5, 0.5) * size, 1, 1.1);
        if (i % 3 === 0) this.glow(x, y + 1.5, z, 0xff9040, 0.08, frand(1, 2), 1.5, ADD_FRAME.star, frand(-3, 3), frand(3, 7), frand(-3, 3));
      });
    }
  }

  // ---------------------------------------------------------------- frame

  update(dt: number) {
    this.time += dt;
    updateBeams(dt, this.scene);
    const fog = this.scene.fog as THREE.FogExp2 | null;
    if (fog) {
      FOG.color.value.copy(fog.color);
      FOG.density.value = fog.density;
    } else FOG.density.value = 0;
    for (let i = this.later.length - 1; i >= 0; i--) {
      const l = this.later[i];
      l.t -= dt;
      if (l.t <= 0) {
        this.later.splice(i, 1);
        l.fn();
      }
    }
    this.add.update(dt, this.time);
    this.smoke.update(dt, this.time);
    this.glare.flush();
    this.streaks.update(dt);
    this.skids.update(this.time);
    for (const g of this.ground) {
      if (g.life <= 0) continue;
      g.life -= dt;
      const t = 1 - g.life / g.max;
      const s = g.s0 + (g.s1 - g.s0) * (g.kind === 'scorch' ? Math.min(1, t * 8) : 1 - Math.pow(1 - t, 2.2));
      g.mesh.scale.setScalar(s);
      const a = g.kind === 'scorch' ? (t < 0.75 ? 1 : 1 - (t - 0.75) / 0.25) : g.kind === 'wave' ? Math.sin(Math.min(1, t) * Math.PI) : Math.pow(1 - t, 1.5);
      g.mat.opacity = g.a0 * Math.max(0, a);
      if (g.life <= 0) g.mesh.visible = false;
    }
    // debris
    const counts = [0, 0, 0];
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.life -= dt;
      if (d.life <= 0) {
        this.debris.splice(i, 1);
        continue;
      }
      if (d.rest < 1) {
        d.vy -= 24 * dt;
        d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
        d.rx += d.wx * dt; d.ry += d.wy * dt;
        const floor = d.s * (d.shape === 2 ? 0.05 : 0.3);
        if (d.y < floor) {
          d.y = floor;
          d.vy *= -0.3;
          d.vx *= 0.55; d.vz *= 0.55; d.wx *= 0.5; d.wy *= 0.5;
          if (Math.abs(d.vy) < 0.6 && Math.hypot(d.vx, d.vz) < 0.8) {
            d.rest = 1;
            // lie flat
            d.rx = d.shape === 1 ? Math.round(d.rx / (Math.PI / 2)) * (Math.PI / 2) : 0;
            d.rz = 0;
          }
        }
      }
    }
    for (const d of this.debris) {
      const m = this.debrisMeshes[d.shape];
      const idx = counts[d.shape]++;
      if (idx >= 120) continue;
      this.dummy.position.set(d.x, d.y, d.z);
      this.dummy.rotation.set(d.rx, d.ry, d.rz);
      const sc = d.s * Math.min(1, d.life * 1.5);
      this.dummy.scale.set(sc, sc, sc);
      this.dummy.updateMatrix();
      m.setMatrixAt(idx, this.dummy.matrix);
      m.setColorAt(idx, d.col);
    }
    this.debrisMeshes.forEach((m, i) => {
      m.count = Math.min(120, counts[i]);
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    });
    for (const f of this.lights) {
      f.t += dt;
      const total = f.attack + f.decay;
      if (f.t >= total || f.power <= 0) {
        f.light.intensity = 0;
        continue;
      }
      const env = f.t < f.attack ? f.t / f.attack : Math.pow(1 - (f.t - f.attack) / f.decay, 2);
      const fl = f.flicker > 0 ? 1 - f.flicker * 0.5 * (1 + Math.sin(this.time * 61 + f.t * 37)) : 1;
      f.light.intensity = f.power * env * fl * 4;
    }
  }

  /** Lamp glare for this frame (vehicle lights): a hot core with streaks, sized in metres. */
  lampGlare(x: number, y: number, z: number, color: THREE.Color, size: number, k: number) {
    if (k <= 0.01) return;
    this.glare.direct(x, y, z, color.r * k, color.g * k, color.b * k, size, 1, ADD_FRAME.glare);
  }

  /** Count of live particles (budget, QA). */
  stats() {
    return { add: this.add.count, smoke: this.smoke.count, glare: this.glare.count, streaks: this.streaks.count, debris: this.debris.length, skids: this.skids.count };
  }

  clear() {
    this.add.clear();
    this.smoke.clear();
    this.glare.clear();
    this.streaks.clear();
    this.debris = [];
    this.later = [];
    for (const g of this.ground) {
      g.life = 0;
      g.mesh.visible = false;
    }
    for (const f of this.lights) {
      f.power = 0;
      f.light.intensity = 0;
    }
    this.skids.clear();
  }
}

// ------------------------------------------------------------------------------------------------ skid marks

/**
 * Tyre marks: a ring buffer of quads laid along each wheel's path while it slides. Width, darkness and wear vary
 * with how hard the tyre is working; old marks fade out over ~14 s.
 */
export class SkidMarks {
  readonly mesh: THREE.Mesh;
  private pos: Float32Array;
  private uv: Float32Array;
  private info: Float32Array; // birth time, strength
  private head = 0;
  count = 0;
  private tracks = new Map<number, { x: number; z: number; v: number; w: number }>();
  private mat: THREE.ShaderMaterial;
  constructor(private cap: number) {
    this.pos = new Float32Array(cap * 4 * 3);
    this.uv = new Float32Array(cap * 4 * 2);
    this.info = new Float32Array(cap * 4 * 2).fill(-999);
    const idx: number[] = [];
    for (let i = 0; i < cap; i++) idx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('info', new THREE.BufferAttribute(this.info, 2).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(idx);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: skidTexture() }, time: { value: 0 }, fogCol: FOG.color, fogDen: FOG.density },
      vertexShader: /* glsl */ `
        attribute vec2 info; varying vec2 vUv; varying float vA; varying float vDepth;
        uniform float time;
        void main(){
          vUv = uv;
          float age = time - info.x;
          vA = info.y * (1.0 - smoothstep(9.0, 14.0, age)) * step(0.0, age);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vDepth = -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D map; varying vec2 vUv; varying float vA; varying float vDepth;
        ${FOG_GLSL}
        void main(){
          float a = texture2D(map, vUv).a * vA * (1.0 - fogAmount(vDepth));
          gl_FragColor = vec4(0.012, 0.012, 0.014, a * 0.72);
        }`,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }
  private time = 0;
  update(time: number) {
    this.time = time;
    this.mat.uniforms.time.value = time;
  }
  /** Lift a wheel (mark ends). */
  lift(track: number) {
    this.tracks.delete(track);
  }
  /** Add a point to a wheel's mark: strength 0..1 (darkness), width in metres. */
  mark(track: number, x: number, y: number, z: number, width: number, strength: number) {
    const last = this.tracks.get(track);
    if (!last) {
      this.tracks.set(track, { x, z, v: Math.random() * 4, w: width });
      return;
    }
    const dx = x - last.x, dz = z - last.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.45) return;
    if (len > 6) {
      this.tracks.set(track, { x, z, v: Math.random() * 4, w: width });
      return;
    }
    const nx = -dz / len, nz = dx / len;
    const w0 = last.w / 2, w1 = width / 2;
    const i = this.head;
    this.head = (this.head + 1) % this.cap;
    this.count = Math.min(this.cap, this.count + 1);
    const p = i * 12, u = i * 8, f = i * 8;
    const yy = y + 0.022;
    const P = [last.x - nx * w0, yy, last.z - nz * w0, last.x + nx * w0, yy, last.z + nz * w0, x + nx * w1, yy, z + nz * w1, x - nx * w1, yy, z - nz * w1];
    for (let k = 0; k < 12; k++) this.pos[p + k] = P[k];
    const v0 = last.v, v1 = last.v + len / 3;
    const U = [0, v0, 1, v0, 1, v1, 0, v1];
    for (let k = 0; k < 8; k++) this.uv[u + k] = U[k];
    const st = Math.max(0, Math.min(1, strength)) * (0.75 + Math.random() * 0.25);
    for (let k = 0; k < 4; k++) {
      this.info[f + k * 2] = this.time;
      this.info[f + k * 2 + 1] = st;
    }
    const g = this.mesh.geometry;
    const pa = g.attributes.position as THREE.BufferAttribute, ua = g.attributes.uv as THREE.BufferAttribute, ia = g.attributes.info as THREE.BufferAttribute;
    pa.addUpdateRange(p, 12);
    ua.addUpdateRange(u, 8);
    ia.addUpdateRange(f, 8);
    pa.needsUpdate = ua.needsUpdate = ia.needsUpdate = true;
    this.tracks.set(track, { x, z, v: v1, w: width });
  }
  clear() {
    this.info.fill(-999);
    (this.mesh.geometry.attributes.info as THREE.BufferAttribute).needsUpdate = true;
    this.tracks.clear();
    this.count = 0;
  }
}
