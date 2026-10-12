import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { ModelKind } from '../data/enemies';
import { applyCarDamage, buildCar, type CarRole } from '../vehicles/carModels';
import { envMaterial } from '../assets/atlas';
import { prop, type PropName } from '../assets/kit/props';
import { GeoBuilder } from '../world/geobuilder';
import { EMISSIVE, glow } from './visualBudget';

/**
 * Model lineup (debug): vehicles side by side in a neutral studio — same light for all, no HUD, no post, no fog —
 * rendered straight to the canvas. Used to judge silhouettes, forms and materials on their own:
 *   views  front34 / rear34 / side / front / rear / top, plus far (120 m) and near (12 m)
 *   clay   one grey material on everything: only silhouette and form are left to read
 * `zm.lineup({ view: 'front34' })` returns a JPEG data URL of the frame.
 */
export interface LineupCar {
  kind: ModelKind;
  color: number;
  accent: number;
  role?: CarRole;
  variant?: number;
  elite?: boolean;
}

export interface LineupOpts {
  cars?: LineupCar[];
  view?: 'front34' | 'rear34' | 'side' | 'front' | 'rear' | 'top' | 'far' | 'near';
  clay?: boolean;
  /** frame only this car (index into `cars`) */
  focus?: number;
  /** extra yaw for every car, radians */
  yaw?: number;
  /** kit props instead of cars: name and paint colour */
  props?: { name: PropName; paint?: number }[];
  /** hull 0..1 for the player cars: shows the damage state */
  hull?: number;
  /** extra geometries (any kit asset) with a paint colour */
  geos?: { geo: THREE.BufferGeometry; paint?: number }[];
}

/** The test set from the brief: player, traffic, rammer, hunter, blocker, EMP and a boss. */
export const LINEUP: LineupCar[] = [
  { kind: 'courier', color: 0x1f6fff, accent: 0x40e0ff, role: 'player' },
  { kind: 'sedan', color: 0x7a2a2a, accent: 0x222222, role: 'traffic' },
  { kind: 'rammer', color: 0x8a3a10, accent: 0xff7020, role: 'enemy' },
  { kind: 'hunter', color: 0x101014, accent: 0xff2050, role: 'enemy' },
  { kind: 'blocker', color: 0x3a3a40, accent: 0xffb020, role: 'enemy' },
  { kind: 'empvan', color: 0x203048, accent: 0x40a0ff, role: 'enemy' },
  { kind: 'boss_mule', color: 0x5a4a30, accent: 0xff8020, role: 'boss' },
];

let env: THREE.Texture | null = null;
const clayMat = new THREE.MeshStandardMaterial({ color: 0x4a4a4a, roughness: 0.8, metalness: 0 });

export function renderLineup(renderer: THREE.WebGLRenderer, opts: LineupOpts = {}): string {
  const cars = opts.cars ?? LINEUP;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x15171c);
  if (!env) {
    const pm = new THREE.PMREMGenerator(renderer);
    env = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    pm.dispose();
  }
  scene.environment = env;
  scene.environmentIntensity = 0.55;
  // three-point light: warm key from the front left, cool rim from behind, soft sky fill
  scene.add(new THREE.HemisphereLight(0xc8d8ff, 0x202024, 0.9));
  const key = new THREE.DirectionalLight(0xfff2e0, 2.6);
  key.position.set(9, 12, 10);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x9fc8ff, 1.8);
  rim.position.set(-7, 6, -12);
  scene.add(rim);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: 0x2c2e33, roughness: 0.85, metalness: 0.05 }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  // cars side by side along x, all facing +z (or kit assets, as cars-shaped entries: a group and a footprint)
  const kitMat = envMaterial({ head: glow(0xffe0b0, EMISSIVE.MEDIUM), tail: glow(0xff2020, EMISSIVE.MEDIUM), accent: glow(0x30e0ff, EMISSIVE.MEDIUM) });
  const kitItems = [...(opts.props ?? []).map((p) => ({ geo: prop(p.name), paint: p.paint })), ...(opts.geos ?? [])];
  const models = kitItems.length
    ? kitItems.map((it) => {
        const b = new GeoBuilder(true);
        b.add(it.geo, new THREE.Matrix4(), new THREE.Color(it.paint ?? 0x808080));
        const geo = b.build();
        geo.computeBoundingBox();
        const group = new THREE.Group();
        const body = new THREE.Group();
        body.add(new THREE.Mesh(geo, kitMat));
        group.add(body);
        const bb = geo.boundingBox!;
        return { group, body, wheels: [] as THREE.Object3D[], width: Math.max(0.5, bb.max.x - bb.min.x), dispose: () => geo.dispose() };
      })
    : cars.map((c) => {
        const m = buildCar(c.kind, { color: c.color, accent: c.accent, role: c.role, variant: c.variant, elite: c.elite, beams: false });
        if (opts.hull !== undefined) applyCarDamage(m, opts.hull, 0.3);
        return m;
      });
  let x = 0;
  const box = new THREE.Box3();
  models.forEach((m, i) => {
    if (i > 0) x += models[i - 1].width / 2 + 1.4 + m.width / 2;
    m.group.position.set(x, 0, 0);
    m.group.rotation.y = opts.yaw ?? 0;
    scene.add(m.group);
  });
  const target = opts.focus !== undefined ? models[opts.focus] : null;
  // frame the bodies and wheels, not the shadow planes
  scene.updateMatrixWorld(true);
  const boxes: THREE.Box3[] = [];
  for (const m of target ? [target] : models) {
    const b = new THREE.Box3().expandByObject(m.body);
    for (const w of m.wheels) b.expandByObject(w);
    boxes.push(b);
    box.union(b);
  }
  if (opts.clay) scene.overrideMaterial = clayMat;

  const size = new THREE.Vector3(), c = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(c);
  const canvas = renderer.domElement;
  const aspect = canvas.width / canvas.height;
  const view = opts.view ?? 'front34';
  const cam = new THREE.PerspectiveCamera(view === 'far' ? 50 : 32, aspect, 0.1, 2000);
  const r = Math.max(size.x, size.z * 0.8, size.y * 1.6) * 0.5;
  const dist = view === 'far' ? 120 : view === 'near' ? 12 : (r / Math.tan(THREE.MathUtils.degToRad(cam.fov / 2))) * (aspect < 1.4 ? 1.25 : 1.05) + 2;
  const dir: Record<string, [number, number, number]> = {
    front34: [-0.62, 0.32, 0.78],
    rear34: [-0.62, 0.3, -0.78],
    side: [-1, 0.12, 0],
    front: [0, 0.18, 1],
    rear: [0, 0.2, -1],
    top: [0.001, 1, 0.12],
    far: [-0.5, 0.3, 0.8],
    near: [-0.62, 0.22, 0.78],
  };
  const d = new THREE.Vector3(...dir[view]).normalize();
  const look = new THREE.Vector3(c.x, view === 'top' ? 0 : c.y * 0.7, c.z);
  const place = (k: number) => {
    cam.position.copy(look).addScaledVector(d, k);
    cam.position.y = Math.max(cam.position.y, 0.6);
    cam.lookAt(look);
    cam.updateMatrixWorld();
  };
  // fit: pull in or back until the framed cars fill ~85% of the frame (fixed distances for far / near)
  let k = dist;
  place(k);
  if (view !== 'far' && view !== 'near') {
    const p = new THREE.Vector3();
    for (let it = 0; it < 4; it++) {
      let ext = 0;
      // fit the cars themselves (each one's corners), not the empty corners of the row's box
      for (const b of boxes) for (let i = 0; i < 8; i++) {
        p.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).project(cam);
        ext = Math.max(ext, Math.abs(p.x), Math.abs(p.y));
      }
      k *= ext / 0.85;
      place(k);
    }
  }

  renderer.render(scene, cam);
  const url = canvas.toDataURL('image/jpeg', 0.9);

  models.forEach((m) => m.dispose());
  kitMat.dispose();
  ground.geometry.dispose();
  (ground.material as THREE.Material).dispose();
  return url;
}
