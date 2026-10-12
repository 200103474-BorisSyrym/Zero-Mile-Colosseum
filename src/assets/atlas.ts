import * as THREE from 'three';

/**
 * Surface atlas: every authored asset is one mesh with one material, and its surfaces (paint, glass, trim, rubber,
 * lights, concrete, steel…) are told apart by which texel of a tiny 8x4 atlas their UVs point at. Three textures
 * share the layout:
 *   COLOR  rgb = surface colour, a = 1 where the surface takes the material's colour (car paint)
 *   ORM    r = clear coat, g = roughness, b = metalness
 *   EMIT   r = headlight, g = tail light, b = accent — scaled by per-object colours in the shader
 * So a car body with glass, rubber, chrome and its lights is a single draw call, and its paint, brake lights and
 * accent strips are still per-car.
 */
export const enum S {
  PAINT = 0,
  GLASS = 1,
  TRIM = 2,
  CHROME = 3,
  RUBBER = 4,
  UNDER = 5,
  HEAD = 6,
  TAIL = 7,
  ACCENT = 8,
  GRILLE = 9,
  PAINT2 = 10,
  RIM = 11,
  BED = 12,
  PLATE = 13,
  CARBON = 14,
  AMBER = 15,
  // environment surfaces
  CONCRETE = 16,
  STEEL = 17,
  RUST = 18,
  WOOD = 19,
  WHITE = 20,
  RED = 21,
  YELLOW = 22,
  GREEN = 23,
  FOLIAGE = 24,
  BRICK = 25,
  TAR = 26,
  WINDOW = 27,
  SAND = 28,
  BLUE = 29,
  DARK = 30,
  ASPHALT = 31,
}

/** Atlas layout: 8 columns x 4 rows. */
export const ATLAS_COLS = 8;
export const ATLAS_ROWS = 4;

type Texel = { c: [number, number, number]; paint?: boolean; cc: number; r: number; m: number; e?: [number, number, number] };
const TEXELS: Texel[] = [
  { c: [1, 1, 1], paint: true, cc: 1, r: 0.3, m: 0.55 },
  { c: [0.035, 0.05, 0.075], cc: 1, r: 0.04, m: 0.85 },
  { c: [0.055, 0.057, 0.065], cc: 0, r: 0.62, m: 0.12 },
  { c: [0.62, 0.64, 0.68], cc: 0.4, r: 0.2, m: 1 },
  { c: [0.022, 0.022, 0.026], cc: 0, r: 0.93, m: 0 },
  { c: [0.012, 0.012, 0.014], cc: 0, r: 1, m: 0 },
  { c: [0.78, 0.78, 0.74], cc: 1, r: 0.08, m: 0.3, e: [1, 0, 0] },
  { c: [0.32, 0.02, 0.03], cc: 1, r: 0.12, m: 0.2, e: [0, 1, 0] },
  { c: [0.04, 0.04, 0.045], cc: 0.5, r: 0.4, m: 0.2, e: [0, 0, 1] },
  { c: [0.02, 0.02, 0.024], cc: 0, r: 0.45, m: 0.65 },
  { c: [0.045, 0.05, 0.06], cc: 1, r: 0.28, m: 0.55 },
  { c: [0.5, 0.52, 0.56], cc: 0.3, r: 0.26, m: 0.95 },
  { c: [0.035, 0.035, 0.04], cc: 0, r: 0.95, m: 0 },
  { c: [0.86, 0.86, 0.8], cc: 0, r: 0.5, m: 0 },
  { c: [0.03, 0.032, 0.036], cc: 1, r: 0.32, m: 0.35 },
  { c: [0.72, 0.42, 0.06], cc: 1, r: 0.15, m: 0.2 },
  // CONCRETE, STEEL (galvanised), RUST, WOOD, WHITE paint, RED paint, YELLOW (machinery / hazard), GREEN paint
  { c: [0.34, 0.34, 0.33], cc: 0, r: 0.9, m: 0.02 },
  { c: [0.42, 0.44, 0.47], cc: 0, r: 0.42, m: 0.85 },
  { c: [0.26, 0.13, 0.07], cc: 0, r: 0.78, m: 0.45 },
  { c: [0.27, 0.18, 0.1], cc: 0, r: 0.85, m: 0 },
  { c: [0.72, 0.72, 0.7], cc: 0, r: 0.5, m: 0.1 },
  { c: [0.5, 0.05, 0.04], cc: 0, r: 0.5, m: 0.15 },
  { c: [0.7, 0.48, 0.04], cc: 0, r: 0.5, m: 0.15 },
  { c: [0.07, 0.2, 0.11], cc: 0, r: 0.6, m: 0.2 },
  // FOLIAGE, BRICK, TAR (roofing), WINDOW (dark glass, faintly lit by the head colour), SAND (bags), BLUE paint,
  // DARK painted metal, ASPHALT
  { c: [0.05, 0.12, 0.06], cc: 0, r: 0.95, m: 0 },
  { c: [0.25, 0.1, 0.07], cc: 0, r: 0.9, m: 0 },
  { c: [0.04, 0.04, 0.045], cc: 0, r: 0.95, m: 0 },
  { c: [0.03, 0.035, 0.045], cc: 0, r: 0.1, m: 0.8, e: [0.28, 0, 0] },
  { c: [0.2, 0.165, 0.1], cc: 0, r: 1, m: 0 },
  { c: [0.05, 0.12, 0.3], cc: 0, r: 0.5, m: 0.2 },
  { c: [0.025, 0.026, 0.03], cc: 0, r: 0.55, m: 0.5 },
  { c: [0.06, 0.06, 0.065], cc: 0, r: 0.95, m: 0 },
];

/** UV of a surface's texel centre. */
export function suv(s: number): [number, number] {
  return [((s % ATLAS_COLS) + 0.5) / ATLAS_COLS, (Math.floor(s / ATLAS_COLS) + 0.5) / ATLAS_ROWS];
}
/** Surface index of an atlas UV (inverse of suv). */
export function surfAt(u: number, v: number) {
  return Math.min(ATLAS_COLS - 1, Math.floor(u * ATLAS_COLS)) + Math.min(ATLAS_ROWS - 1, Math.floor(v * ATLAS_ROWS)) * ATLAS_COLS;
}

let tex: { color: THREE.DataTexture; orm: THREE.DataTexture; emit: THREE.DataTexture } | null = null;
function atlas() {
  if (tex) return tex;
  const mk = (fill: (t: Texel) => [number, number, number, number], srgb: boolean) => {
    const data = new Uint8Array(ATLAS_COLS * ATLAS_ROWS * 4);
    TEXELS.forEach((t, i) => {
      const v = fill(t);
      for (let k = 0; k < 4; k++) data[i * 4 + k] = Math.round(Math.max(0, Math.min(1, v[k])) * 255);
    });
    const d = new THREE.DataTexture(data, ATLAS_COLS, ATLAS_ROWS, THREE.RGBAFormat);
    d.magFilter = THREE.NearestFilter;
    d.minFilter = THREE.NearestFilter;
    d.generateMipmaps = false;
    d.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    d.needsUpdate = true;
    return d;
  };
  // colour texels are authored in linear terms; stored as sRGB so the shader decodes them back
  const toS = (x: number) => (x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
  tex = {
    color: mk((t) => [toS(t.c[0]), toS(t.c[1]), toS(t.c[2]), t.paint ? 1 : 0], true),
    orm: mk((t) => [t.cc, t.r, t.m, 1], false),
    emit: mk((t) => [...(t.e ?? [0, 0, 0]), 1] as [number, number, number, number], false),
  };
  return tex;
}

export interface AtlasLights {
  head: THREE.Color;
  tail: THREE.Color;
  accent: THREE.Color;
}

/**
 * The atlas material. `lights` colours are live references: change them (brake lights, hazard blink, hit flash on
 * the accent) and the shader picks it up next frame. `physical` adds the clear coat (hero and hostile cars).
 */
export function atlasMaterial(physical: boolean, lights?: AtlasLights): THREE.MeshStandardMaterial {
  const t = atlas();
  const params = { map: t.color, roughnessMap: t.orm, metalnessMap: t.orm, emissiveMap: t.emit, emissive: 0x000000, roughness: 1, metalness: 1, envMapIntensity: 1 };
  const m = physical ? new THREE.MeshPhysicalMaterial({ ...params, clearcoat: 1, clearcoatMap: t.orm, clearcoatRoughness: 0.1 }) : new THREE.MeshStandardMaterial(params);
  const L = lights ?? { head: new THREE.Color(0, 0, 0), tail: new THREE.Color(0, 0, 0), accent: new THREE.Color(0, 0, 0) };
  const dirt = { value: 0 };
  // damage: dent crumples the panels (vertex), scorch lays soot over them (fragment); halfL scales the crumple
  // towards the ends of the car, where hits land
  const dent = { value: 0 };
  const scorch = { value: 0 };
  const halfL = { value: 2.25 };
  m.userData.dirt = dirt;
  m.userData.dent = dent;
  m.userData.scorch = scorch;
  m.userData.halfL = halfL;
  m.userData.lights = L;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.headColor = { value: L.head };
    sh.uniforms.tailColor = { value: L.tail };
    sh.uniforms.accentColor = { value: L.accent };
    sh.uniforms.dirt = dirt;
    sh.uniforms.dent = dent;
    sh.uniforms.scorch = scorch;
    sh.uniforms.halfL = halfL;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float dent; uniform float halfL; varying vec3 vObj;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vObj = position;
        if (dent > 0.0) {
          float cr = sin(position.x * 9.1 + position.z * 4.3) * sin(position.y * 11.7 - position.z * 6.9) + 0.5 * sin(position.z * 13.0 + position.y * 5.0);
          float ends = 0.35 + 0.65 * smoothstep(0.35, 1.0, abs(position.z) / halfL);
          transformed -= objectNormal * dent * ends * 0.075 * clamp(cr, -0.4, 1.0);
        }`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 headColor; uniform vec3 tailColor; uniform vec3 accentColor; uniform float dirt; uniform float scorch; varying vec3 vObj;')
      .replace(
        '#include <map_fragment>',
        `#ifdef USE_MAP
          vec4 atlasTexel = texture2D( map, vMapUv );
          // alpha marks paint: it takes the material colour; every other surface keeps its own
          diffuseColor.rgb = mix( atlasTexel.rgb, diffuse * atlasTexel.rgb, atlasTexel.a );
          diffuseColor.rgb *= 1.0 - dirt * 0.35 * atlasTexel.a;
          if (scorch > 0.0) {
            // blotches, not stripes: three crossed waves multiplied
            float soot = sin(vObj.x * 4.1 + vObj.z * 2.3) * sin(vObj.y * 6.7 - vObj.z * 3.1) * sin(vObj.z * 2.9 + vObj.x * 1.3 + vObj.y * 2.0) * 2.2 + 0.25 * sin(vObj.z * 9.0);
            diffuseColor.rgb *= 1.0 - scorch * 0.88 * smoothstep(0.05, 0.7, soot);
          }
        #endif`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#ifdef USE_EMISSIVEMAP
          vec3 emMask = texture2D( emissiveMap, vEmissiveMapUv ).rgb;
          // the material emissive (hit flashes, heat, ghost) lights the paint; glass, rubber and trim only catch some of it
          float flashMask = mix( 0.3, 1.0, texture2D( map, vMapUv ).a );
          totalEmissiveRadiance = emissive * flashMask + headColor * emMask.r + tailColor * emMask.g + accentColor * emMask.b;
        #endif`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = min(1.0, roughnessFactor + dirt * 0.4 * texture2D( map, vMapUv ).a);');
  };
  m.customProgramCacheKey = () => (physical ? 'atlas-phys' : 'atlas-std');
  return m;
}

/** One shared atlas material for wheels and small dynamic parts: no paint, no lights. */
let shared: THREE.MeshStandardMaterial | null = null;
export function kitMaterial() {
  if (!shared) shared = atlasMaterial(false);
  return shared;
}

/**
 * The environment kit material: vertex colours tint the paint surfaces per object (a green dumpster, a blue van),
 * the light colours are the world's — warm lamp heads and lit windows, red warning lights, the zone's neon on accent
 * surfaces (set per zone).
 */
export function envMaterial(lights: AtlasLights) {
  const m = atlasMaterial(false, lights);
  m.vertexColors = true;
  m.customProgramCacheKey = () => 'atlas-env';
  return m;
}
