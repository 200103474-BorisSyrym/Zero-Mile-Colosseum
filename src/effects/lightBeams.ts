import * as THREE from 'three';

/**
 * Fake volumetric light: a cone (or several merged cones) drawn additively with a shader that hides its geometry.
 *  - edges fade by viewing angle: the silhouette of the cone never shows, only light thickest through its middle
 *  - brightness falls off along the beam from the source (`along` attribute: 0 at the lamp, 1 at the far end)
 *  - a slow shimmer of dust in the air, a fade when the camera is inside it, and fog takes the far end
 * Used for headlights, street lamps, searchlights, the lighthouse, pickup light shafts.
 */
export function beamGeometry(length: number, r0: number, r1: number, segs = 16): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r0, r1, length, segs, 4, true);
  g.translate(0, -length / 2, 0);
  g.rotateX(-Math.PI / 2); // apex at the origin, beam along +Z
  const p = g.getAttribute('position');
  const along = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) along[i] = Math.max(0, Math.min(1, p.getZ(i) / length));
  g.setAttribute('along', new THREE.BufferAttribute(along, 1));
  g.deleteAttribute('uv');
  return g;
}

export interface BeamUniforms {
  color: { value: THREE.Color };
  intensity: { value: number };
  time: { value: number };
  fogCol: { value: THREE.Color };
  fogDen: { value: number };
}

const shared = { time: { value: 0 }, fogCol: { value: new THREE.Color() }, fogDen: { value: 0 } };
/** Advance the shimmer and copy the scene fog (call once per frame). */
export function updateBeams(dt: number, scene: THREE.Scene) {
  shared.time.value += dt;
  const f = scene.fog as THREE.FogExp2 | null;
  if (f) {
    shared.fogCol.value.copy(f.color);
    shared.fogDen.value = f.density;
  }
}

export function beamMaterial(color: THREE.ColorRepresentation, intensity: number, falloff = 1.6, fogAmt = 0.85): THREE.ShaderMaterial & { uniforms: BeamUniforms } {
  return new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color(color) }, intensity: { value: intensity }, time: shared.time, fogCol: shared.fogCol, fogDen: shared.fogDen, falloff: { value: falloff }, fogAmt: { value: fogAmt } },
    vertexShader: /* glsl */ `
      attribute float along;
      varying float vAlong; varying vec3 vN; varying vec3 vV; varying vec3 vW; varying float vDepth;
      void main(){
        vAlong = along;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        vec4 mv = viewMatrix * w;
        vV = -mv.xyz;
        vN = normalize(normalMatrix * normal);
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 color; uniform float intensity; uniform float time; uniform vec3 fogCol; uniform float fogDen; uniform float falloff; uniform float fogAmt;
      varying float vAlong; varying vec3 vN; varying vec3 vV; varying vec3 vW; varying float vDepth;
      void main(){
        float facing = abs(dot(normalize(vN), normalize(vV)));
        float edge = pow(facing, 1.8);
        float along = pow(1.0 - vAlong, falloff) * smoothstep(0.0, 0.05, vAlong);
        float dust = 0.82 + 0.18 * sin(vW.x * 0.9 + time * 0.7) * sin(vW.z * 0.7 - time * 0.5 + vW.y * 1.3);
        float near = smoothstep(0.6, 3.5, vDepth);
        float fog = 1.0 - exp(-fogDen * fogDen * vDepth * vDepth);
        float a = intensity * edge * along * dust * near * (1.0 - fog * fogAmt);
        gl_FragColor = vec4(color * a, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  }) as THREE.ShaderMaterial & { uniforms: BeamUniforms };
}

/** Two headlight cones, merged, aimed along +Z from lamps at ±x, dipped a little toward the road. */
const pairCache = new Map<string, THREE.BufferGeometry>();
export function headlightBeams(x: number, length = 20, spread = 3.2): THREE.BufferGeometry {
  const key = `${x.toFixed(2)}|${length}|${spread}`;
  let g = pairCache.get(key);
  if (g) return g;
  const parts: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    const c = beamGeometry(length, 0.09, spread, 14);
    c.rotateX(0.07); // dipped
    c.rotateY(side * 0.05); // a little outward
    c.translate(side * x, 0, 0);
    parts.push(c);
  }
  g = mergeGeometries(parts);
  pairCache.set(key, g);
  return g;
}

/** Minimal merge for geometries with identical attribute sets. */
export function mergeGeometries(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  const names = Object.keys(list[0].attributes);
  const flat = list.map((g) => (g.index ? g.toNonIndexed() : g));
  for (const n of names) {
    const item = flat[0].getAttribute(n).itemSize;
    const total = flat.reduce((a, g) => a + g.getAttribute(n).count, 0);
    const arr = new Float32Array(total * item);
    let o = 0;
    for (const g of flat) {
      const a = g.getAttribute(n);
      arr.set(a.array as Float32Array, o);
      o += a.count * item;
    }
    out.setAttribute(n, new THREE.BufferAttribute(arr, item));
  }
  out.computeBoundingSphere();
  return out;
}
