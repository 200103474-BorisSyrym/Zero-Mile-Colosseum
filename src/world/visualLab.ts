import * as THREE from 'three';
import type { DrivingSession } from '../game/driving';
import { applyBossPresence } from '../render/visualBudget';
import { buildCar } from '../vehicles/carModels';
import { SIGN_WORDS } from './textures';

/**
 * Debug "visual lab": a row of the game's own emissive / lit / reflective objects placed on the road ahead,
 * built from the same materials the world uses, so you can drive (or step the camera) up to each one and check
 * brightness, bloom and whiteout. F1 → LAB.
 */
export interface LabStation {
  name: string;
  s: number;
  d: number;
}

export class VisualLab {
  group = new THREE.Group();
  stations: LabStation[] = [];
  private owned: { dispose(): void }[] = [];

  constructor(private sess: DrivingSession) {}

  build(s0: number) {
    this.clear();
    const sess = this.sess;
    const world = sess.world;
    world.ensureAhead(s0 + 260);
    const road = world.road;
    const at = (s: number, d: number, y = 0) => {
      const o = { x: 0, y: 0, z: 0 };
      road.toWorld(s, d, o);
      return new THREE.Vector3(o.x, o.y + y, o.z);
    };
    const heading = (s: number) => road.at(s).heading;
    const add = (o: THREE.Object3D) => {
      this.group.add(o);
      return o;
    };
    const box = (mat: THREE.Material, s: number, d: number, y: number, sx: number, sy: number, sz: number) => {
      const g = new THREE.BoxGeometry(sx, sy, sz);
      this.owned.push(g);
      const m = new THREE.Mesh(g, mat);
      m.position.copy(at(s, d, y));
      m.rotation.y = heading(s);
      return add(m) as THREE.Mesh;
    };
    /** plane facing the oncoming player */
    const panel = (mat: THREE.Material, s: number, d: number, y: number, w: number, h: number, uv?: [number, number, number, number]) => {
      const g = new THREE.PlaneGeometry(w, h);
      if (uv) {
        const a = g.attributes.uv as THREE.BufferAttribute;
        const [u0, v0, u1, v1] = uv;
        a.setXY(0, u0, v1);
        a.setXY(1, u1, v1);
        a.setXY(2, u0, v0);
        a.setXY(3, u1, v0);
      }
      this.owned.push(g);
      const m = new THREE.Mesh(g, mat);
      m.position.copy(at(s, d, y));
      m.rotation.y = heading(s) + Math.PI;
      return add(m) as THREE.Mesh;
    };
    const cell = (i: number): [number, number, number, number] => {
      const u0 = (i % 4) / 4, row = Math.floor(i / 4);
      return [u0, 1 - (row + 1) / 5, u0 + 0.25, 1 - row / 5];
    };
    const w = road.at(s0).width;
    const edge = w / 2 - 1.2;
    let s = s0;
    const station = (name: string, d = 0) => {
      this.stations.push({ name, s, d });
      const sign = add(new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(name), depthWrite: false, fog: false })));
      sign.position.copy(at(s - 4, d, 4.2));
      sign.scale.set(5, 1.25, 1);
      this.owned.push((sign as THREE.Sprite).material);
      const st = s;
      s += 22;
      return st;
    };

    // A — plain concrete wall
    let st = station('WALL', edge);
    box(world.getMat('tunnel'), st, edge + 1, 2.5, 1.2, 5, 10);
    // B — neon sign (street sign atlas, additive)
    st = station('NEON SIGN', -edge);
    panel(world.getMat('sign'), st, -edge, 3, 6, 3, cell(SIGN_WORDS.indexOf('NEON') >= 0 ? SIGN_WORDS.indexOf('NEON') : 2));
    // C — building with emissive windows
    st = station('WINDOWS', edge);
    box(world.getMat('building'), st, edge + 6, 9, 10, 18, 8);
    // D — painted lane language
    st = station('ROAD MARKS', 0);
    box(world.getMat('mark2'), st, -1.95, 0.03, 0.3, 0.02, 14);
    box(world.getMat('mark3'), st, 1.95, 0.03, 0.3, 0.02, 14);
    box(world.getMat('mark4'), st, 0, 0.03, 0.3, 0.02, 14);
    // E — street lamp with its light pool and a real lamp light
    st = station('STREET LAMP', -edge);
    box(world.getMat('pole'), st, -edge - 1.6, 4, 0.22, 8, 0.22);
    box(world.getMat('lamp'), st, -edge + 1.2, 7.85, 0.6, 0.15, 1.4);
    const pool = box(world.getMat('pool'), st, -edge + 1.5, 0.04, 15, 0.01, 15);
    pool.renderOrder = 2;
    const lp = at(st, -edge + 1.2, 7.2);
    world.addLabLamp({ x: lp.x, y: lp.y, z: lp.z, s: st });
    // F — pickups
    st = station('PICKUPS', 0);
    sess.placePickup('gold', st, -2, 10);
    sess.placePickup('shard', st, 2);
    sess.placePickup('repair', st + 4, 0);
    // G — boss, lights on, facing you
    st = station('BOSS', 2);
    const boss = buildCar('boss_driver', { color: 0x050507, accent: 0xff1040, beams: true });
    applyBossPresence(boss, 0xff1040);
    boss.group.position.copy(at(st, 2));
    boss.group.rotation.y = heading(st) + Math.PI;
    add(boss.group);
    this.owned.push(boss);
    // H — oncoming car headlights
    st = station('HEADLIGHTS', -2);
    const car = buildCar('sedan', { color: 0xd8d8e0, accent: 0x40a0ff, beams: true });
    car.group.position.copy(at(st, -2));
    car.group.rotation.y = heading(st) + Math.PI;
    add(car.group);
    this.owned.push(car);
    // I — live hazards on the road
    st = station('HAZARDS', 0);
    const hp = at(st, -2), hq = at(st, 2.5);
    sess.combat.addHazard('electric', hp.x, hp.z, 3, 9999, 0, true);
    sess.combat.addHazard('fire', hq.x, hq.z, 2.5, 9999, 0, true);
    // J — billboard
    st = station('BILLBOARD', edge);
    box(world.getMat('pole'), st, edge + 3, 7, 1, 14, 1);
    panel(world.getMat('sign'), st - 1, edge + 3, 12, 16, 6, cell(3));
    // K — wet road and a reflective wall
    st = station('WET ROAD', 0);
    box(world.getMat('water'), st, 0, 0.02, w - 1, 0.02, 16);
    box(new THREE.MeshStandardMaterial({ color: 0x9aa0aa, roughness: 0.15, metalness: 1 }), st, edge + 1, 2, 0.4, 4, 12);
    // L — dense neon street: several signs and glow strips together
    st = station('NEON STREET', 0);
    for (let k = 0; k < 6; k++) {
      const side = k % 2 ? 1 : -1;
      panel(world.getMat('sign'), st + k * 3, side * (edge + 0.5), 2.5 + (k % 3), 4, 2, cell((k * 3) % SIGN_WORDS.length));
    }
    for (const side of [-1, 1]) box(world.getMat('strip'), st + 8, side * (edge + 0.8), 0.8, 0.1, 0.1, 18);
    this.group.name = 'visual-lab';
    sess.scene.add(this.group);
    return this.stations;
  }

  clear() {
    this.sess.scene.remove(this.group);
    for (const o of this.owned) o.dispose();
    this.owned = [];
    this.group = new THREE.Group();
    this.stations = [];
    this.sess.world.clearLabLamps();
  }
}

function labelTexture(text: string) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(0,0,0,0.6)';
  g.fillRect(0, 0, 512, 128);
  g.fillStyle = '#ffffff';
  g.font = 'bold 64px Rajdhani, Arial Narrow, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 256, 66);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

