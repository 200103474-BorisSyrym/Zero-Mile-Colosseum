import * as THREE from 'three';
import { perf } from '../core/perf';
import { DECALS, EMISSIVE, glow, nearFade } from '../render/visualBudget';
import type { ModelKind } from '../data/enemies';
import { carShadowTexture, poolTexture, roadBeamTexture, underglowTexture } from '../effects/vfxTextures';
import { beamMaterial, headlightBeams, mergeGeometries } from '../effects/lightBeams';
import type { Anchors } from '../assets/vehicles/body';
import { S, atlasMaterial, kitMaterial } from '../assets/atlas';
import { MeshKit } from '../assets/meshkit';
import { vehicleAsset, type WheelSpec } from '../assets/vehicles/catalog';
import { wheelGeometry } from '../assets/vehicles/wheel';

/**
 * Cars in the scene. The models themselves are authored in src/assets/vehicles (lofted bodies, fascias, wheels and
 * add-on parts, see catalog.ts); here a model becomes a car: one body mesh with a per-car atlas material (paint,
 * live head/tail/accent light colours, damage), four to six wheels on steering pivots, soft and contact shadows,
 * headlight beam and underglow.
 *
 * Visual language: your car has warm white lights; hostile cars look at you with narrow red eyes; traffic lights are
 * dimmer. Collision never looks at any of this: `length`/`width` are the gameplay footprint the model was built to.
 */

/** Visual variants of traffic kinds — same footprint as the kind (collision is unchanged), a different vehicle. */
const VARIANTS: Record<string, number> = { sedan: 3, hatch: 2, van: 3, truck: 3 };
export function variantCount(kind: string) {
  return VARIANTS[kind] ?? 1;
}

// soft shadow in the shape of the footprint, plus a tight, dark contact shadow with the four tyre patches: the car
// stands on the road
const shadowMat = new THREE.MeshBasicMaterial({ map: carShadowTexture(false), transparent: true, depthWrite: false, color: 0x000000, opacity: 0.72 });
shadowMat.alphaMap = shadowMat.map;
const contactMat = new THREE.MeshBasicMaterial({ map: carShadowTexture(true), transparent: true, depthWrite: false, color: 0x000000, opacity: 0.9 });
contactMat.alphaMap = contactMat.map;
// light thrown on the road ahead by the headlamps: a fan with a hot near end, not a disc
const roadBeamMat = (color: number, k: number) =>
  nearFade(new THREE.MeshBasicMaterial({ map: roadBeamTexture(), color, transparent: true, opacity: DECALS.headlightBeam * k, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }), 2, 7);
const roadBeamMats = { warm: roadBeamMat(0xfff2dc, 1), dim: roadBeamMat(0xfff2dc, 0.55), hostile: roadBeamMat(0xffd8c8, 0.85) };
// the beams themselves, visible in the wet air: soft cones that never show their edges
const beamVolumeMats = { player: beamMaterial(0xfff0d8, 0.11), hostile: beamMaterial(0xffc0b0, 0.085), traffic: beamMaterial(0xfff0d8, 0.05) };
/** Glare colours: warm white lamps, red eyes on hostile cars, red tails, amber indicators. */
export const LAMP = {
  head: new THREE.Color(1, 0.94, 0.84),
  hostile: new THREE.Color(1, 0.16, 0.12),
  tail: new THREE.Color(1, 0.05, 0.06),
  amber: new THREE.Color(1, 0.55, 0.08),
  reverse: new THREE.Color(0.9, 0.95, 1),
};
const sharedPlane = new THREE.PlaneGeometry(1, 1);

/** Far body + far wheels in one geometry, per vehicle variant (cached; shared by every car of that variant). */
const farMerged = new Map<string, THREE.BufferGeometry>();
function farWithWheels(key: string, far: THREE.BufferGeometry, wheels: WheelSpec[]) {
  let g = farMerged.get(key);
  if (g) return g;
  const parts: THREE.BufferGeometry[] = [far];
  for (const w of wheels) {
    const wg = wheelGeometry(w.r, w.w, w.style, 2).clone();
    // the left-hand wheels are mirrored, as the near ones are (scale.x = -1): mirror the triangles' winding too
    if (w.x < 0) {
      wg.scale(-1, 1, 1);
      flipWinding(wg);
    }
    wg.translate(w.x, w.y, w.z);
    parts.push(wg);
  }
  g = mergeGeometries(parts);
  g.computeBoundingBox();
  g.userData.bodyCount = far.getAttribute('position').count;
  for (const p of parts.slice(1)) p.dispose();
  farMerged.set(key, g);
  return g;
}
/** Reverse the winding of a non-indexed triangle list (after a mirror). */
function flipWinding(g: THREE.BufferGeometry) {
  for (const name of Object.keys(g.attributes)) {
    const a = g.getAttribute(name) as THREE.BufferAttribute;
    const n = a.itemSize, arr = a.array as Float32Array;
    for (let t = 0; t < a.count; t += 3) {
      for (let k = 0; k < n; k++) {
        const i1 = (t + 1) * n + k, i2 = (t + 2) * n + k;
        const tmp = arr[i1];
        arr[i1] = arr[i2];
        arr[i2] = tmp;
      }
    }
    a.needsUpdate = true;
  }
}
/** Distance (m) at which traffic and enemy cars switch to their far models. */
const LOD_FAR = 48;

export type CarRole = 'player' | 'enemy' | 'traffic' | 'boss';

export interface CarModel {
  group: THREE.Group;
  body: THREE.Group;
  wheels: THREE.Object3D[];
  frontWheels: THREE.Object3D[];
  /** the car's atlas material: `color` is the paint, `emissive` flashes the whole car */
  bodyMat: THREE.MeshStandardMaterial;
  /** colour holders: the atlas shader reads these as the tail-light and accent emission */
  tailMat: THREE.MeshBasicMaterial;
  accentMat: THREE.MeshBasicMaterial;
  flashMat?: THREE.MeshBasicMaterial;
  /** headlight light on the road */
  beam?: THREE.Mesh;
  /** the visible beams in the air (cars that carry them) */
  beamVolume?: THREE.Mesh;
  /** brake lights on the road behind the car */
  brakeGlow?: THREE.Mesh;
  /** lamps, indicators and tailpipes in vehicle space, and what the lights are doing this frame */
  anchors: Anchors;
  lights: CarLights;
  lampColor: THREE.Color;
  role: CarRole;
  underglow?: THREE.Mesh;
  rotors?: THREE.Object3D[];
  /** wheel pivots and their rest heights: suspension droop moves them */
  pivots?: { o: THREE.Object3D; y: number }[];
  /** damage presentation (player): soot, dents, a loose bumper, stuttering lights */
  damage?: { bumper: THREE.Object3D; head: THREE.Color; headBase: THREE.Color };
  length: number;
  width: number;
  height: number;
  wheelR: number;
  dispose(): void;
}

/** Light state, set every frame by whoever drives the car; read by the light effects. */
export interface CarLights {
  /** 0..1, how hard the car is braking */
  brake: number;
  reverse: boolean;
  /** -1 left, 1 right, 0 off */
  indicator: number;
  hazard: boolean;
  /** headlamps 0..1 (they stutter when the car is dying) */
  head: number;
  /** full beams 0..1 (flashed at you by the wrong-way truck) */
  highBeam: number;
}

export interface CarOpts {
  color: number;
  accent: number;
  beams?: boolean;
  underglow?: boolean;
  headlights?: boolean;
  role?: CarRole;
  variant?: number;
  /** elite enemies: armoured flanks and a roof scoop on top of the class silhouette */
  elite?: boolean;
}

/** The loose front bumper of a wrecked car: a bar with a torn bracket, hinged at one end. */
let looseBumper: THREE.BufferGeometry | null = null;
function bumperGeometry() {
  if (looseBumper) return looseBumper;
  const k = new MeshKit();
  k.box([-0.8, 0, 0], [1.6, 0.2, 0.12], S.TRIM, 0, 0.04);
  k.box([-0.8, -0.06, 0.04], [1.5, 0.05, 0.08], S.UNDER, 0, 0.01);
  k.box([-0.05, 0.02, -0.08], [0.08, 0.12, 0.16], S.CHROME, 0.4, 0.01);
  looseBumper = k.build(0.6);
  return looseBumper;
}

export function buildCar(kind: ModelKind, opts: CarOpts): CarModel {
  const t0 = performance.now();
  const m = buildCarInner(kind, opts);
  perf.event(`car ${kind} ${(performance.now() - t0).toFixed(1)}ms`);
  perf.count('car');
  return m;
}

function buildCarInner(kind: ModelKind, opts: CarOpts): CarModel {
  if (kind === 'drone') return buildDrone(opts);
  const vCount = variantCount(kind);
  const vIdx = Math.max(0, Math.min(vCount - 1, opts.variant ?? 0));
  const role: CarRole = opts.role ?? (kind.startsWith('boss_') ? 'boss' : 'traffic');
  // your car and the bosses are hero models; everything else swaps to a far model past LOD_FAR metres
  const hero = role === 'player' || role === 'boss';
  const asset = vehicleAsset(kind, vIdx, !!opts.elite, hero ? 0 : 1);
  const far = hero ? null : vehicleAsset(kind, vIdx, !!opts.elite, 2);
  const hostile = role === 'enemy' || role === 'boss';
  const headlights = opts.headlights !== false;

  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);

  // live light colours: the shader reads them every frame
  const accentMat = new THREE.MeshBasicMaterial({ color: opts.accent });
  const tailMat = new THREE.MeshBasicMaterial({ color: 0x660008 });
  const head = !headlights
    ? new THREE.Color(0, 0, 0)
    : hostile
      ? glow(0xff2a20, EMISSIVE.MEDIUM)
      : role === 'player'
        ? glow(0xfff0d8, EMISSIVE.MEDIUM)
        : glow(0xfff0d8, 1.0);
  // clear coat for you and hostile cars; plain paint for traffic and anything truck-sized (big flat panels under a
  // clear coat mirror the whole neon sky and wash out)
  const physical = role !== 'traffic' && asset.L <= 6.5;
  const bodyMat = atlasMaterial(physical, { head, tail: tailMat.color, accent: accentMat.color });
  bodyMat.color.setHex(opts.color);
  bodyMat.userData.halfL.value = asset.L / 2;
  const disposables: THREE.Material[] = [bodyMat, accentMat, tailMat];

  if (far) {
    const lod = new THREE.LOD();
    lod.addLevel(new THREE.Mesh(asset.geo, bodyMat), 0);
    // far: the far body with its far wheels baked in — one draw instead of five to seven (wheel spin, steer and
    // droop do not read past LOD_FAR; the wheel texels take no paint, so the body's material draws them the same)
    lod.addLevel(new THREE.Mesh(farWithWheels(`${kind}|${vIdx}|${opts.elite ? 1 : 0}`, far.geo, asset.wheels), bodyMat), LOD_FAR);
    body.add(lod);
  } else body.add(new THREE.Mesh(asset.geo, bodyMat));

  // wheels: pivots steer, the inner group spins, the mesh is mirrored on the right-hand side
  const wheels: THREE.Object3D[] = [];
  const frontWheels: THREE.Object3D[] = [];
  const pivots: { o: THREE.Object3D; y: number }[] = [];
  const wm = kitMaterial();
  // traffic and enemies: the wheels hang off one LOD at the car's origin — the same point as the body's LOD — so they
  // disappear in the very frame the body switches to its far model with the wheels baked in
  let wheelParent: THREE.Object3D = group;
  if (!hero) {
    const wl = new THREE.LOD();
    const near = new THREE.Group();
    wl.addLevel(near, 0);
    wl.addLevel(new THREE.Object3D(), LOD_FAR);
    group.add(wl);
    wheelParent = near;
  }
  for (const w of asset.wheels) {
    const pivot = new THREE.Group();
    pivot.position.set(w.x, w.y, w.z);
    const spin = new THREE.Group();
    const wmesh = new THREE.Mesh(wheelGeometry(w.r, w.w, w.style, hero ? 0 : 1), wm);
    if (w.x < 0) wmesh.scale.x = -1;
    spin.add(wmesh);
    pivot.add(spin);
    wheelParent.add(pivot);
    wheels.push(spin);
    pivots.push({ o: pivot, y: w.y });
    if (w.front) frontWheels.push(pivot);
  }
  const wheelR = asset.wheels[0]?.r ?? 0.35;

  // soft shadow plus a tight, dark contact shadow: the car sits on the road
  const shadow = new THREE.Mesh(sharedPlane, shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.scale.set(asset.W * 1.55, asset.L * 1.22, 1);
  shadow.position.y = 0.03;
  shadow.renderOrder = 1;
  group.add(shadow);
  const contact = new THREE.Mesh(sharedPlane, contactMat);
  contact.rotation.x = -Math.PI / 2;
  contact.scale.set(asset.W * 1.1, asset.L * 1.04, 1);
  contact.position.y = 0.035;
  contact.renderOrder = 1;
  group.add(contact);

  const L2 = asset.L / 2;
  const anchors = asset.anchors;
  const heads = anchors.heads.length ? anchors.heads : [[-asset.W * 0.3, 0.7, L2], [asset.W * 0.3, 0.7, L2]];
  const lampX = Math.max(...heads.map((h) => Math.abs(h[0])));
  const lampY = heads.reduce((a, h) => a + h[1], 0) / heads.length;
  const lampZ = Math.max(...heads.map((h) => h[2]));
  // headlight light on the road (every car with lit lamps): spread from the two lamps, reaching ~26 m
  let beam: THREE.Mesh | undefined;
  if (headlights) {
    beam = new THREE.Mesh(sharedPlane, hostile ? roadBeamMats.hostile : role === 'traffic' ? roadBeamMats.dim : roadBeamMats.warm);
    beam.rotation.x = -Math.PI / 2;
    const len = role === 'traffic' ? 18 : 26;
    beam.scale.set(Math.max(6, lampX * 2 + 5), len, 1);
    beam.position.set(0, 0.045, lampZ + len / 2 - 0.4);
    beam.renderOrder = 2;
    group.add(beam);
  }
  // the beams in the air: your car and the hostile cars that drive with them
  let beamVolume: THREE.Mesh | undefined;
  if (opts.beams && headlights) {
    beamVolume = new THREE.Mesh(headlightBeams(lampX, role === 'player' ? 22 : 16, role === 'player' ? 3.4 : 2.8), role === 'player' ? beamVolumeMats.player : hostile ? beamVolumeMats.hostile : beamVolumeMats.traffic);
    beamVolume.position.set(0, lampY, lampZ);
    beamVolume.renderOrder = 7;
    beamVolume.frustumCulled = false;
    group.add(beamVolume);
  }
  // brake lights on the road behind: a red sheen that comes and goes with the pedal
  const brakeMat = new THREE.MeshBasicMaterial({ map: poolTexture(), color: 0xff1020, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
  disposables.push(brakeMat);
  const brakeGlow = new THREE.Mesh(sharedPlane, brakeMat);
  brakeGlow.rotation.x = -Math.PI / 2;
  brakeGlow.scale.set(asset.W * 1.5, 5.5, 1);
  brakeGlow.position.set(0, 0.05, -L2 - 2.2);
  brakeGlow.renderOrder = 2;
  brakeGlow.visible = false;
  group.add(brakeGlow);
  let underglow: THREE.Mesh | undefined;
  if (opts.underglow) {
    // neon under the sills: light along the edges of the car, its own shadow in the middle
    const um = new THREE.MeshBasicMaterial({ map: underglowTexture(), color: opts.accent, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false });
    disposables.push(um);
    underglow = new THREE.Mesh(sharedPlane, um);
    underglow.rotation.x = -Math.PI / 2;
    underglow.scale.set(asset.W * 1.45, asset.L * 1.18, 1);
    underglow.position.y = 0.06;
    underglow.renderOrder = 2;
    group.add(underglow);
  }

  // damage states (player): the bumper hangs from its right-hand bracket once the car is badly hurt
  let damage: CarModel['damage'];
  if (role === 'player') {
    const hinge = new THREE.Group();
    hinge.position.set(asset.W / 2 - 0.15, 0.32, L2 + 0.04);
    const bar = new THREE.Mesh(bumperGeometry(), bodyMat);
    bar.scale.x = (asset.W - 0.3) / 1.6;
    hinge.add(bar);
    hinge.visible = false;
    body.add(hinge);
    damage = { bumper: hinge, head, headBase: head.clone() };
  }

  const flashMat = kind === 'bomber' || kind === 'empvan' ? accentMat : undefined;
  const bb = asset.geo.boundingBox!;
  return {
    group, body, wheels, frontWheels, bodyMat, tailMat, accentMat, flashMat, beam, beamVolume, brakeGlow, underglow, damage, pivots,
    anchors, lights: { brake: 0, reverse: false, indicator: 0, hazard: false, head: headlights ? 1 : 0, highBeam: 0 }, lampColor: hostile ? LAMP.hostile : LAMP.head, role,
    length: asset.L, width: asset.W, height: bb.max.y, wheelR,
    dispose() {
      disposables.forEach((m) => m.dispose());
    },
  };
}

/**
 * Show the car's condition — presentation only, called every frame with hull 0..1:
 *   100–70% clean · 70–40% dust and dull paint, first dents · 40–20% soot, crumpled ends, the bumper hangs ·
 *   under 20% the lights stutter.
 */
export function applyCarDamage(model: CarModel, hull: number, time: number) {
  const d = model.damage;
  if (!d) return;
  const u = model.bodyMat.userData;
  u.dirt.value = hull < 0.7 ? Math.min(1, (0.7 - hull) / 0.5) : 0;
  u.dent.value = hull < 0.7 ? Math.min(1, (0.7 - hull) / 0.55) : 0;
  u.scorch.value = hull < 0.4 ? Math.min(1, (0.4 - hull) / 0.3) : 0;
  if (model.bodyMat instanceof THREE.MeshPhysicalMaterial) model.bodyMat.clearcoat = 1 - u.dirt.value * 0.8;
  d.bumper.visible = hull < 0.4;
  d.bumper.rotation.z = hull < 0.4 ? -0.22 - Math.sin(time * 9) * 0.04 : 0;
  d.bumper.rotation.x = hull < 0.4 ? 0.12 : 0;
  // critical: the lights stutter
  const flicker = hull < 0.2 ? (Math.sin(time * 37) * Math.sin(time * 13.7) > 0.35 ? 0.12 : 1) : 1;
  d.head.copy(d.headBase).multiplyScalar(flicker);
  model.lights.head = flicker;
}

/** Suspension travel: wheels hang down (droop, metres) when the car is in the air and tuck back on landing. */
export function applySuspension(model: CarModel, droop: number) {
  if (!model.pivots) return;
  for (const p of model.pivots) p.o.position.y = p.y - droop;
}

/** Drone: a pod with four ducted rotors on arms and a red sensor eye. */
let droneGeo: { hull: THREE.BufferGeometry; rotor: THREE.BufferGeometry } | null = null;
function droneGeometry() {
  if (droneGeo) return droneGeo;
  const k = new MeshKit();
  // pod: a lathe along z, flattened by its profile
  k.lathe([0, 0, -0.55], [0, 0, 1], [[0.05, -0.05], [0.24, 0.05], [0.32, 0.3], [0.32, 0.75], [0.24, 1.0], [0.1, 1.12]], 12, S.PAINT);
  k.box([0, 0.2, 0.05], [0.42, 0.14, 0.7], S.PAINT2, 0, 0.04);
  k.box([0, 0.02, 0.55], [0.36, 0.08, 0.06], S.ACCENT, 0, 0.02);
  k.box([0, -0.25, 0], [0.12, 0.18, 0.12], S.TRIM, 0, 0.02);
  for (const [x, z] of [[-0.75, 0.6], [0.75, 0.6], [-0.75, -0.6], [0.75, -0.6]]) {
    k.tube([Math.sign(x) * 0.2, 0, z * 0.4], [x, 0.05, z], 0.05, 6, S.TRIM);
    // duct ring around the rotor
    k.lathe([x, 0.0, z], [0, 1, 0], [[0.46, 0], [0.5, 0.02], [0.5, 0.16], [0.46, 0.18]], 16, S.PAINT2);
    k.lathe([x, 0.06, z], [0, 1, 0], [[0.07, 0], [0.07, 0.1]], 8, S.TRIM, false, true);
  }
  const hull = k.build(0.6);
  const r = new MeshKit();
  for (let i = 0; i < 3; i++) r.box([0, 0, 0], [0.84, 0.015, 0.09], S.TRIM, (i / 3) * Math.PI, 0.005);
  droneGeo = { hull, rotor: r.build(0.6) };
  return droneGeo;
}

function buildDrone(opts: CarOpts): CarModel {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  const accentMat = new THREE.MeshBasicMaterial({ color: opts.accent });
  const tailMat = new THREE.MeshBasicMaterial({ color: 0xff2040 });
  const bodyMat = atlasMaterial(false, { head: new THREE.Color(0, 0, 0), tail: tailMat.color, accent: accentMat.color });
  bodyMat.color.setHex(opts.color);
  const g = droneGeometry();
  body.add(new THREE.Mesh(g.hull, bodyMat));
  const rotors: THREE.Object3D[] = [];
  for (const [x, z] of [[-0.75, 0.6], [0.75, 0.6], [-0.75, -0.6], [0.75, -0.6]]) {
    const r = new THREE.Mesh(g.rotor, kitMaterial());
    r.position.set(x, 0.12, z);
    body.add(r);
    rotors.push(r);
  }
  const shadow = new THREE.Mesh(sharedPlane, shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.scale.set(2, 2, 1);
  shadow.position.y = 0.03;
  shadow.userData.isShadow = true;
  group.add(shadow);
  return {
    group, body, wheels: [], frontWheels: [], bodyMat, tailMat, accentMat, rotors,
    anchors: { heads: [], tails: [], indicators: [], exhausts: [] }, lights: { brake: 0, reverse: false, indicator: 0, hazard: false, head: 0, highBeam: 0 }, lampColor: LAMP.hostile, role: 'enemy',
    length: 1.6, width: 1.6, height: 0.4, wheelR: 0,
    dispose() {
      bodyMat.dispose();
      accentMat.dispose();
      tailMat.dispose();
    },
  };
}
