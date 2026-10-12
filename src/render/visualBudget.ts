import * as THREE from 'three';

/**
 * ZERO MILE visual energy budget — the single place that decides how bright anything may be.
 *
 * Rule: emissive objects glow, they don't explode. Persistent surfaces stay at SUBTLE..STRONG; only short-lived
 * VFX (explosions, flashes) may use EXTREME. Brightness is expressed as the *peak channel* of a saturated colour,
 * so a bright cyan stays cyan instead of drifting to white.
 *
 * Pipeline: material level → bloom (soft threshold, only the energy ABOVE the threshold, capped per pixel)
 * → exposure → hue-preserving tone mapping.
 */

/** Peak channel value (scene-linear, before exposure) for each emissive tier. Bloom starts at BLOOM.threshold. */
export const EMISSIVE = {
  /** windows, small signage, decorative strips, road paint — never blooms */
  SUBTLE: 0.8,
  /** neon, road signs, vehicle lights, lamp heads — a soft halo */
  MEDIUM: 1.3,
  /** boss accents, landmarks, pickups, hazards, important interactables — a clear glow */
  STRONG: 1.9,
  /** explosions and very short-lived VFX only */
  EXTREME: 4,
} as const;
export type EmissiveLevel = keyof typeof EMISSIVE;

/**
 * A glow colour: the hue of `color` scaled so its brightest channel equals the tier (or a raw peak value).
 * Saturated input stays saturated — bright, never white.
 */
export function glow(color: THREE.ColorRepresentation, level: EmissiveLevel | number, out = new THREE.Color()): THREE.Color {
  out.set(color);
  const peak = typeof level === 'number' ? level : EMISSIVE[level];
  const m = Math.max(out.r, out.g, out.b, 1e-4);
  return out.multiplyScalar(peak / m);
}

/** Unlit glowing material (neon tubes, lamp heads, markings, glow strips). */
export function neonMaterial(color: THREE.ColorRepresentation, level: EmissiveLevel | number, opts: THREE.MeshBasicMaterialParameters & { additive?: boolean } = {}) {
  const { additive, ...rest } = opts;
  return new THREE.MeshBasicMaterial({
    ...rest,
    color: glow(color, level),
    ...(additive ? { transparent: true, blending: THREE.AdditiveBlending, depthWrite: false } : {}),
  });
}

/**
 * Bloom: reacts to neon, lights, hazards, boss cores and VFX — not to walls, asphalt, paint or props.
 * Only the energy above `threshold` (with a soft knee) feeds the bloom, and no pixel can feed more than `maxInput`,
 * so an emissive surface filling half the screen right in front of the camera gives a bounded glow, not a whiteout.
 */
export const BLOOM = {
  threshold: 1.0,
  knee: 0.35,
  maxInput: 1.4,
  strength: 0.6,
  strengthLow: 0.45,
  radius: 0.4,
};

/**
 * Tone mapping: Khronos PBR Neutral keeps hue and saturation in the highlights (ACES pushes hot colours toward
 * white). Exposure stays where the night lighting pass put it — the night must stay readable.
 */
export const TONE = {
  mapping: THREE.NeutralToneMapping as THREE.ToneMapping,
  // same mid-tone brightness as the v2 night pass (1.22 under three's ACES, which scales by 1/0.6 internally)
  exposure: 1.75,
};

/** Real light sources. Visual brightness (the emissive bulb) and actual light contribution are separate on purpose. */
export const LIGHTS = {
  /** pooled point lights that follow the nearest street lamps: light the car, road and nearby wall — not the district */
  streetLamp: { intensity: 70, distance: 22, decay: 2 },
  /** player headlights: light the road ahead without turning the car in front into a white block */
  headlight: { intensity: 90, distance: 62, decay: 1.45, angle: 0.44, penumbra: 0.92 },
  /** soft key light riding above the player car so it always reads */
  playerKey: { intensity: 7, distance: 12, decay: 1.6 },
  /** explosion flashes (short-lived) */
  flash: { distance: 30, decay: 2 },
};

/**
 * Near-camera fade for additive volumes (light beams, halos): a beam the camera drives through must not fill the
 * screen. Smooth in view depth — no popping. Ground decals under the car are deliberately NOT faded.
 */
export const NEAR_FADE = { start: 1.5, end: 9 };
export function nearFade<T extends THREE.Material>(mat: T, start = NEAR_FADE.start, end = NEAR_FADE.end): T {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.nearFadeStart = { value: start };
    shader.uniforms.nearFadeEnd = { value: end };
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'varying float vNearDepth;\nvoid main() {')
      .replace('#include <project_vertex>', '#include <project_vertex>\n\tvNearDepth = -mvPosition.z;');
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'uniform float nearFadeStart;\nuniform float nearFadeEnd;\nvarying float vNearDepth;\nvoid main() {')
      .replace('#include <dithering_fragment>', 'gl_FragColor.a *= smoothstep(nearFadeStart, nearFadeEnd, vNearDepth);\n\t#include <dithering_fragment>');
  };
  mat.customProgramCacheKey = () => `nearFade:${start}:${end}`;
  return mat;
}

/** Reflections: the neon "room" baked into the environment map and how strongly wet surfaces mirror it. */
export const REFLECTIONS = {
  envNeon: 1.4,
  envTop: 1,
  wetRoad: 1,
  water: 1.3,
};

/** Sky elements: a pale moon, not a white hole in the sky. */
export const SKY = { moon: 0.5 };

/** Additive helper decals (light pools, headlight cones) — real lights do the lighting now. */
export const DECALS = {
  lightPool: 0.2,
  headlightBeam: 0.2,
};

/**
 * Additive particle brightness (multiplier on the effect colour). Sparks and explosions are short and may be hot;
 * things that stream continuously right behind the camera (nitro, trails) stay modest so the three systems —
 * neon + lights + particles — never add up to a whiteout.
 */
export const VFX = {
  spark: 1.8,
  nitro: 1.2,
  electric: 2,
  trail: 1.25,
  hazardGlow: 0.85,
  boostPad: 1.25,
  projectile: 2.6,
};

/**
 * Boss presence: readability through silhouette, not raw glow. Accent strips go to STRONG, and one accent-coloured
 * light rides just above and behind the boss so it stands out against a lit patch of road.
 */
export const BOSS_PRESENCE = { intensity: 34, distance: 16, decay: 2, height: 3.2, behind: 2.5 };
/**
 * The presence light is one permanent scene light, dark while no boss is out. Adding or removing a light changes the
 * scene's light count, and three.js then rebuilds the shader of every lit material — a multi-second freeze the moment
 * a boss appeared. The light stays in the scene and follows whichever boss holds it (`updateBossPresence`).
 */
const presence = {
  light: new THREE.PointLight(0xffffff, 0, BOSS_PRESENCE.distance, BOSS_PRESENCE.decay),
  target: null as THREE.Object3D | null,
  offset: new THREE.Vector3(),
};
export function bossPresenceLight() {
  return presence.light;
}
export function applyBossPresence(model: { group: THREE.Group; accentMat: THREE.MeshBasicMaterial; height: number; length: number }, accent: THREE.ColorRepresentation) {
  glow(accent, EMISSIVE.STRONG, model.accentMat.color);
  const p = BOSS_PRESENCE;
  presence.light.color.set(accent);
  presence.target = model.group;
  presence.offset.set(0, model.height + p.height - 1.5, -model.length / 2 - p.behind);
  return presence.light;
}
/** Per frame: the light rides above and behind its boss while the boss is in the scene, and is dark otherwise. */
export function updateBossPresence() {
  const t = presence.target;
  let root: THREE.Object3D | null = t;
  while (root?.parent) root = root.parent;
  const live = !!t && t.visible && (root as THREE.Scene | null)?.isScene === true;
  presence.light.intensity = live ? BOSS_PRESENCE.intensity : 0;
  if (!live) {
    if (t && !t.parent) presence.target = null;
    return;
  }
  t.updateWorldMatrix(true, false);
  presence.light.position.copy(presence.offset).applyMatrix4(t.matrixWorld);
}

export type BloomPriority = 'none' | 'low' | 'medium' | 'high';
export interface MaterialClass {
  roughness: number;
  metalness: number;
  /** allowed emissive peak range */
  emissive: [number, number];
  bloom: BloomPriority;
  note: string;
}

/** Material categories: base surface response and how much each may glow. Used by the inspector and the presets. */
export const MATERIAL_CLASSES: Record<string, MaterialClass> = {
  MAT_DEFAULT: { roughness: 0.7, metalness: 0.1, emissive: [0, 0], bloom: 'none', note: 'diffuse props' },
  MAT_ROAD: { roughness: 0.9, metalness: 0.2, emissive: [0, EMISSIVE.SUBTLE], bloom: 'none', note: 'wet asphalt reflects, paint is part of the surface' },
  MAT_BUILDING: { roughness: 0.75, metalness: 0.25, emissive: [0, EMISSIVE.SUBTLE], bloom: 'none', note: 'windows glow, never light the city' },
  MAT_GLASS: { roughness: 0.08, metalness: 0.6, emissive: [0, 0.1], bloom: 'none', note: 'slightly reflective' },
  MAT_METAL: { roughness: 0.3, metalness: 0.9, emissive: [0, 0], bloom: 'none', note: 'reflective' },
  MAT_NEON: { roughness: 1, metalness: 0, emissive: [EMISSIVE.SUBTLE, EMISSIVE.MEDIUM], bloom: 'low', note: 'signs, strips, billboards' },
  MAT_LAMP: { roughness: 1, metalness: 0, emissive: [EMISSIVE.MEDIUM, EMISSIVE.MEDIUM], bloom: 'low', note: 'bulb glows, the pooled point light lights' },
  MAT_PICKUP: { roughness: 1, metalness: 0, emissive: [EMISSIVE.MEDIUM, EMISSIVE.STRONG], bloom: 'medium', note: 'body glow + halo beam' },
  MAT_HAZARD: { roughness: 1, metalness: 0, emissive: [EMISSIVE.MEDIUM, EMISSIVE.STRONG], bloom: 'medium', note: 'telegraphs and live hazards' },
  MAT_BOSS: { roughness: 0.5, metalness: 0.4, emissive: [EMISSIVE.MEDIUM, EMISSIVE.STRONG], bloom: 'medium', note: 'silhouette first, then accent glow' },
  MAT_VFX: { roughness: 1, metalness: 0, emissive: [EMISSIVE.MEDIUM, EMISSIVE.EXTREME], bloom: 'high', note: 'explosions and flashes — short-lived only' },
};

/** Bloom high-pass: soft knee, excess-only, per-pixel cap. Replaces UnrealBloomPass's hard luminosity cut. */
export const BLOOM_HIGHPASS_FRAGMENT = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform float luminosityThreshold;
  uniform float smoothWidth;
  uniform float maxInput;
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(tDiffuse, vUv).rgb;
    float l = luminance(c);
    float knee = max(smoothWidth, 1e-4);
    float soft = clamp(l - luminosityThreshold + knee, 0.0, 2.0 * knee);
    soft = soft * soft / (4.0 * knee);
    float excess = max(soft, l - luminosityThreshold);
    vec3 b = c * (excess / max(l, 1e-4));
    float bl = luminance(b);
    b *= min(1.0, maxInput / max(bl, 1e-4));
    gl_FragColor = vec4(b, 1.0);
  }`;
