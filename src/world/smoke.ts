import * as THREE from 'three';
import { smokeTexture } from './artTextures';

/**
 * Smoke plumes as GPU-animated points: one draw call per batch, no per-frame CPU work. Each point is a puff that
 * rises from its stack, swells and fades, then starts again (phase offsets keep a column continuous).
 */
const uniforms = {
  time: { value: 0 },
  color: { value: new THREE.Color(0x8a8580) },
  opacity: { value: 0.42 },
  map: { value: null as THREE.Texture | null },
  fogColor: { value: new THREE.Color() },
  fogDensity: { value: 0 },
  /** puff size in pixels at 1 m: 520 at a render scale of 1, and it follows the scale so plumes keep their size on screen */
  pxScale: { value: 520 },
};

/** Render scale changed (render/quality.ts). */
export function setSmokeRenderScale(scale: number) {
  uniforms.pxScale.value = 520 * scale;
}

let material: THREE.ShaderMaterial | null = null;

export function smokeMaterial() {
  if (material) return material;
  uniforms.map.value = smokeTexture();
  material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    vertexShader: `
      attribute float phase; attribute float rise; attribute float size;
      uniform float time; uniform float pxScale;
      varying float vA; varying float vFog;
      void main(){
        float k = fract(time * 0.085 + phase);
        vec3 p = position + vec3(k * rise * 0.18, k * rise, 0.0);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(size * (0.35 + k * 1.3) * pxScale / max(1.0, -mv.z), 1.0, 900.0);
        vA = smoothstep(0.0, 0.12, k) * (1.0 - smoothstep(0.55, 1.0, k));
        vFog = -mv.z;
      }`,
    fragmentShader: `
      uniform vec3 color; uniform float opacity; uniform sampler2D map; uniform vec3 fogColor; uniform float fogDensity;
      varying float vA; varying float vFog;
      void main(){
        vec4 t = texture2D(map, gl_PointCoord);
        float f = 1.0 - exp(-fogDensity * fogDensity * vFog * vFog);
        gl_FragColor = vec4(mix(color, fogColor, f * 0.8), t.a * vA * opacity);
        if (gl_FragColor.a < 0.01) discard;
      }`,
  });
  return material;
}

/** Per-frame: advance the shared clock; zone sets the tint and the fog. */
export function updateSmoke(time: number) {
  uniforms.time.value = time;
}
export function setSmokeZone(color: THREE.Color, fogColor: THREE.Color, fogDensity: number) {
  uniforms.color.value.copy(color);
  uniforms.fogColor.value.copy(fogColor);
  uniforms.fogDensity.value = fogDensity;
}

/** Collects puffs, then builds one Points object. */
export class SmokeBatch {
  private pos: number[] = [];
  private phase: number[] = [];
  private rise: number[] = [];
  private size: number[] = [];

  /** A column of `n` puffs rising `rise` metres from (x, y, z), each `size` metres across when it leaves. */
  column(x: number, y: number, z: number, n: number, rise: number, size: number, seed = 0) {
    for (let k = 0; k < n; k++) {
      this.pos.push(x, y, z);
      this.phase.push((k / n + seed) % 1);
      this.rise.push(rise);
      this.size.push(size);
    }
  }

  get empty() {
    return this.pos.length === 0;
  }

  build(): THREE.Points | null {
    if (this.empty) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('phase', new THREE.Float32BufferAttribute(this.phase, 1));
    g.setAttribute('rise', new THREE.Float32BufferAttribute(this.rise, 1));
    g.setAttribute('size', new THREE.Float32BufferAttribute(this.size, 1));
    g.computeBoundingSphere();
    if (g.boundingSphere) g.boundingSphere.radius += 120;
    const p = new THREE.Points(g, smokeMaterial());
    p.renderOrder = 3;
    return p;
  }
}
