import * as THREE from 'three';
import type { ModelKind } from '../data/enemies';
import { buildCar, type CarModel } from '../vehicles/carModels';
import { DuelStage } from './duelStage';
import { radialTexture, signAtlas, SIGN_WORDS, stripeTexture } from './textures';

/** The player's garage: a real little place with a turntable, light strips and clutter. */
export class GarageScene {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
  private car: CarModel | null = null;
  private turntable: THREE.Mesh;
  private t = 0;
  private strips: THREE.MeshBasicMaterial[] = [];
  private dust: THREE.Points;
  private envRT: THREE.WebGLRenderTarget | null = null;
  /** street duels are staged on this floor (the pit); its particle pools live in the scene from the start */
  readonly duel: DuelStage;
  private turntableDeco: THREE.Object3D[] = [];

  constructor(renderer: THREE.WebGLRenderer) {
    const s = this.scene;
    s.background = new THREE.Color(0x05060a);
    s.fog = new THREE.Fog(0x05060a, 14, 40);
    s.add(new THREE.HemisphereLight(0x8090c0, 0x100808, 0.5));
    const key = new THREE.SpotLight(0xffffff, 120, 30, 0.6, 0.7, 1.6);
    key.position.set(3, 9, 4);
    key.target.position.set(0, 0, 0);
    s.add(key, key.target);
    const rim = new THREE.PointLight(0xff2bd6, 22, 14, 2);
    rim.position.set(-6, 3.5, -5);
    const rim2 = new THREE.PointLight(0x33e0ff, 22, 14, 2);
    rim2.position.set(4.5, 2.5, -2);
    s.add(rim, rim2);

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ color: 0x15161b, roughness: 0.25, metalness: 0.6 }));
    floor.rotation.x = -Math.PI / 2;
    s.add(floor);
    const grid = new THREE.GridHelper(40, 40, 0x1c2238, 0x12162a);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.5;
    grid.position.y = 0.005;
    s.add(grid);

    this.turntable = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 3.5, 0.18, 64), new THREE.MeshStandardMaterial({ color: 0x22252e, roughness: 0.35, metalness: 0.8 }));
    this.turntable.position.y = 0.09;
    s.add(this.turntable);
    const ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.4, 2.2, 2.6) });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(3.45, 0.03, 8, 96), ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.19;
    s.add(ring);
    this.turntableDeco.push(ring);
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshBasicMaterial({ map: radialTexture(), color: 0x33e0ff, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.02;
    s.add(glow);
    this.turntableDeco.push(glow);

    // walls
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x101116, roughness: 0.9 });
    const back = new THREE.Mesh(new THREE.PlaneGeometry(40, 12), wallMat);
    back.position.set(0, 6, -9);
    s.add(back);
    for (const side of [-1, 1]) {
      const w = new THREE.Mesh(new THREE.PlaneGeometry(30, 12), wallMat);
      w.position.set(side * 11, 6, 2);
      w.rotation.y = -side * Math.PI / 2;
      s.add(w);
    }
    // light strips on ceiling and wall
    for (let i = 0; i < 4; i++) {
      const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 2.3, 2.6) });
      this.strips.push(m);
      const st = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.06, 9), m);
      st.position.set(-3 + i * 2, 7.5, 0);
      s.add(st);
    }
    for (const [x, c] of [[-10.9, 0xff2bd6], [10.9, 0x33e0ff]] as [number, number][]) {
      const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(2.2) });
      this.strips.push(m);
      const st = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.08, 20), m);
      st.position.set(x, 1.2, 0);
      s.add(st);
    }
    // neon sign
    const atlas = signAtlas();
    const idx = SIGN_WORDS.indexOf('GARAGE');
    const tex = atlas.clone();
    tex.needsUpdate = true;
    tex.repeat.set(0.25, 0.2);
    tex.offset.set((idx % 4) * 0.25, 1 - (Math.floor(idx / 4) + 1) * 0.2);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(6, 3), new THREE.MeshBasicMaterial({ map: tex, transparent: true, blending: THREE.AdditiveBlending, color: new THREE.Color(1.8, 1.8, 1.8) }));
    sign.position.set(-3.5, 5.5, -8.9);
    s.add(sign);
    // clutter: shelves, tyres, barrels, toolbox
    const dark = new THREE.MeshStandardMaterial({ color: 0x24262e, roughness: 0.6, metalness: 0.5 });
    for (let i = 0; i < 3; i++) {
      const shelf = new THREE.Mesh(new THREE.BoxGeometry(4, 0.1, 1), dark);
      shelf.position.set(5.5, 1 + i * 1.3, -8.4);
      s.add(shelf);
      for (let k = 0; k < 4; k++) {
        const b = new THREE.Mesh(new THREE.BoxGeometry(0.5 + Math.random() * 0.4, 0.4 + Math.random() * 0.4, 0.6), new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(Math.random(), 0.3, 0.25), roughness: 0.8 }));
        b.position.set(4 + k * 0.95, 1.3 + i * 1.3, -8.4);
        s.add(b);
      }
    }
    const tyreGeo = new THREE.TorusGeometry(0.4, 0.17, 8, 16);
    const tyreMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.9 });
    for (let i = 0; i < 5; i++) {
      const t = new THREE.Mesh(tyreGeo, tyreMat);
      t.rotation.x = Math.PI / 2;
      t.position.set(-8, 0.17 + i * 0.34, -6);
      s.add(t);
    }
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 1.1, 14), new THREE.MeshStandardMaterial({ color: 0xc03020, roughness: 0.5, metalness: 0.4 }));
    barrel.position.set(-6.6, 0.55, -7);
    s.add(barrel);
    const stripe = new THREE.Mesh(new THREE.PlaneGeometry(12, 0.5), new THREE.MeshStandardMaterial({ map: stripeTexture(), roughness: 0.7 }));
    stripe.rotation.x = -Math.PI / 2;
    stripe.position.set(0, 0.01, 5.5);
    (stripe.material as THREE.MeshStandardMaterial).map!.repeat.set(12, 1);
    s.add(stripe);
    // floating dust
    const n = 300;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) pos.set([(Math.random() - 0.5) * 20, Math.random() * 8, (Math.random() - 0.5) * 16], i * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.dust = new THREE.Points(g, new THREE.PointsMaterial({ color: 0x8090b0, size: 0.04, transparent: true, opacity: 0.6, depthWrite: false }));
    s.add(this.dust);

    // reflection environment
    const pm = new THREE.PMREMGenerator(renderer);
    const es = new THREE.Scene();
    es.background = new THREE.Color(0x05060a);
    for (const [x, c] of [[-6, 0xff2bd6], [6, 0x33e0ff], [0, 0xffffff]] as [number, number][]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(2, 0.3, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(1.1) }));
      m.position.set(x, 6, 0);
      es.add(m);
    }
    this.envRT = pm.fromScene(es, 0.04);
    s.environment = this.envRT.texture;
    pm.dispose();

    this.camera.position.set(6.5, 2.6, 7.5);
    this.camera.lookAt(0, 0.8, 0);
    this.duel = new DuelStage(s);
  }

  /** the pit: the turntable and its car make way for two cars on the floor */
  setDuelMode(on: boolean) {
    this.turntable.visible = !on;
    for (const o of this.turntableDeco) o.visible = !on;
    if (!on) this.duel.stop();
  }

  setCar(model: ModelKind, color: number, accent: number) {
    if (this.car) {
      this.turntable.remove(this.car.group);
      this.car.dispose();
    }
    this.car = buildCar(model, { color, accent, underglow: true, beams: false, role: 'player' });
    this.car.group.position.y = 0.09;
    this.turntable.add(this.car.group);
  }

  resize(w: number, h: number) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  update(dt: number) {
    this.t += dt;
    if (this.duel.active) {
      this.duel.update(dt, this.camera);
      this.dust.rotation.y += dt * 0.01;
      return;
    }
    this.duel.update(dt, this.camera);
    this.turntable.rotation.y += dt * 0.35;
    const a = Math.sin(this.t * 0.12) * 0.35;
    this.camera.position.set(Math.cos(0.75 + a) * 9.5, 2.4 + Math.sin(this.t * 0.2) * 0.2, Math.sin(0.75 + a) * 9.5);
    this.camera.lookAt(-0.6, 0.9, 0);
    this.strips.forEach((m, i) => {
      if (i < 4) m.color.setScalar(2.2 + Math.sin(this.t * 2 + i) * 0.05 + (Math.random() < 0.003 ? -1.8 : 0));
    });
    this.dust.rotation.y += dt * 0.01;
  }
}
