import * as THREE from 'three';
import { Random } from '../core/random';
import type { ZoneDef } from '../data/zones';
import { EMISSIVE, glow } from '../render/visualBudget';
import { facadeTextures, smokeTexture } from './artTextures';
import { GeoBuilder } from './geobuilder';
import { beamGeometry, beamMaterial } from '../effects/lightBeams';
import { SmokeBatch } from './smoke';
import type { Road } from './road';
import { industry } from '../assets/kit/industry';
import { warmMesh } from '../render/warmup';

/** Kit piece into a silhouette builder: position, yaw, and a scale (x/z, y). */
const kitM = (x: number, y: number, z: number, yaw: number, sxz: number, sy = sxz) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(sxz, sy, sxz));

/**
 * Background landmarks: giant structures 170-340 m off the road, two or three kinds per zone, so a route has things
 * to remember ("I drove past the cooling towers, under the TV tower"). Built from a handful of shapes into merged
 * meshes, drawn without scene fog (they carry their own haze tint) so they read as silhouettes with lights.
 * Purely visual: nothing here can be reached or hit.
 */
type Kind = 'cooling' | 'flare' | 'refinery' | 'dam' | 'sunken' | 'lighthouse' | 'mega' | 'tv' | 'pagoda' | 'arcology' | 'twin' | 'suspension' | 'ring' | 'inverted' | 'shards';

const ZONE_KINDS: Record<string, Kind[]> = {
  industrial: ['cooling', 'flare', 'refinery'],
  flood: ['dam', 'sunken', 'lighthouse'],
  oldcity: ['mega', 'tv', 'pagoda'],
  skyway: ['arcology', 'twin', 'suspension'],
  zeromile: ['ring', 'inverted', 'shards'],
};

interface Item {
  group: THREE.Group;
  s: number;
  x: number;
  z: number;
  r: number;
  update?: (t: number, dt: number) => void;
}

export class Landmarks {
  private items: Item[] = [];
  private nextS = 140;
  private rng = new Random(1);
  private zone: ZoneDef | null = null;
  private sil = new THREE.MeshBasicMaterial({ color: 0x101010, fog: false });
  private win: THREE.MeshBasicMaterial;
  private red = new THREE.MeshBasicMaterial({ color: glow(0xff1018, EMISSIVE.STRONG), fog: false });
  private accent = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false });
  private accent2 = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false });
  private flame = new THREE.SpriteMaterial({ map: smokeTexture(), color: glow(0xff8a30, EMISSIVE.STRONG), blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  private beamMat = beamMaterial(0xfff0c0, 0.32, 1.0, 0.5);
  private time = 0;
  private kindIdx = 0;

  constructor(private root: THREE.Group) {
    const t = facadeTextures('office').emissive.clone();
    t.needsUpdate = true;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    this.win = new THREE.MeshBasicMaterial({ map: t, color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, polygonOffset: true, polygonOffsetFactor: -2 });
  }

  /** Shader warm-up: the landmark materials, including the per-item flood glass. */
  warmObjects(): THREE.Object3D[] {
    const glass = new THREE.MeshBasicMaterial({ color: 0xbfe8ff, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    const out: THREE.Object3D[] = [this.sil, this.win, this.red, this.accent, this.accent2, this.beamMat, glass].map((m) => warmMesh(m));
    out.push(new THREE.Sprite(this.flame));
    return out;
  }

  reset(zone: ZoneDef, seed: number) {
    this.clear();
    this.zone = zone;
    this.rng = new Random((seed * 31 + 7) >>> 0);
    this.nextS = 120 + this.rng.range(0, 120);
    this.kindIdx = this.rng.int(0, 2);
    // haze: far things take the fog colour; silhouettes a little darker than the sky behind them
    const fog = new THREE.Color(zone.fog);
    this.sil.color.copy(fog).multiplyScalar(0.42);
    this.win.color.copy(new THREE.Color(0xffd9a6).lerp(fog, 0.45)).multiplyScalar(0.75);
    glow(zone.neon[0], EMISSIVE.STRONG, this.accent.color);
    glow(zone.neon[1] ?? zone.neon[0], EMISSIVE.MEDIUM, this.accent2.color);
  }

  clear() {
    for (const it of this.items) {
      this.root.remove(it.group);
      it.group.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.Points) o.geometry.dispose();
      });
    }
    this.items = [];
  }

  /** Called as the road is generated: place the next landmark when its distance comes up. */
  onRoad(road: Road, endS: number) {
    if (!this.zone) return;
    // anything the new road now runs through goes away (it is still far away and in the haze)
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      for (let s = Math.max(road.startS, endS - 200); s < endS; s += 12) {
        const p = road.at(s);
        if (Math.hypot(p.x - it.x, p.z - it.z) < it.r + 40) {
          this.root.remove(it.group);
          this.items.splice(i, 1);
          break;
        }
      }
    }
    while (this.nextS < endS - 60) {
      this.place(road, this.nextS);
      this.nextS += this.rng.range(480, 760);
    }
  }

  private place(road: Road, s: number) {
    const zone = this.zone!;
    const rng = this.rng;
    const kinds = ZONE_KINDS[zone.id] ?? ZONE_KINDS.industrial;
    const kind = kinds[this.kindIdx++ % kinds.length];
    const p = road.at(s);
    const side = rng.sign();
    // close enough to the line of sight to be seen down the street, far enough to stay out of reach
    const lat = (zone.elevated ? rng.range(150, 250) : rng.range(105, 175)) * (kind === 'dam' ? 1.9 : kind === 'suspension' ? 1.5 : 1);
    const x = p.x - Math.cos(p.heading) * side * lat, z = p.z + Math.sin(p.heading) * side * lat;
    const base = zone.elevated ? -70 : 0;
    const g = new THREE.Group();
    g.position.set(x, base, z);
    g.rotation.y = p.heading + rng.range(-0.4, 0.4);
    const item: Item = { group: g, s, x, z, r: 60 };
    this.build(kind, g, item, rng, side, p.heading);
    this.root.add(g);
    this.items.push(item);
  }

  private mesh(b: GeoBuilder, mat: THREE.Material, g: THREE.Group) {
    if (b.empty) return null;
    const m = new THREE.Mesh(b.build(), mat);
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    g.add(m);
    return m;
  }

  private build(kind: Kind, g: THREE.Group, item: Item, rng: Random, side: number, heading: number) {
    const sil = new GeoBuilder(), win = new GeoBuilder(), red = new GeoBuilder(), acc = new GeoBuilder(), acc2 = new GeoBuilder();
    const winBox = (x: number, y: number, z: number, w: number, h: number, d: number, yaw = 0) => {
      sil.box(x, y, z, w, h, d, yaw, 0, 0, 0, 0, undefined, true, false);
      win.box(x, y, z, w + 0.05, h, d + 0.05, yaw, 32, 128, rng.range(0, 1), rng.range(0, 1), undefined, true, true);
    };
    const light = (x: number, y: number, z: number, s = 2.4) => red.box(x, y, z, s, s, s);
    switch (kind) {
      case 'cooling': {
        const plume = new SmokeBatch();
        // two hyperbolic cooling towers on their raking legs (the kit tower, at power-station scale), steam pouring
        // off the top, a stack and a turbine hall between them
        for (const ox of [-48, 48]) {
          sil.add(industry('coolingTower'), kitM(ox, 0, 0, 0, 1.45, 2.1));
          acc.lathe(ox, 0, [[22.2, 124], [22.3, 126.4]], 18);
          light(ox + 22, 128, 0);
          light(ox - 22, 128, 0);
          plume.column(ox, 130, 0, 12, 190, 55, ox > 0 ? 0.5 : 0);
        }
        sil.add(industry('stack'), kitM(0, 0, 40, 0, 1.4, 1.9));
        light(0, 134, 40, 2.4);
        sil.box(0, 14, -30, 70, 28, 26);
        for (let x = -30; x <= 30; x += 12) sil.box(x, 30, -30, 4, 4, 22);
        const pts = plume.build();
        if (pts) g.add(pts);
        item.r = 90;
        break;
      }
      case 'flare': {
        // refinery flare stack: the kit flare with its lattice brace at 165 m, a living flame, aircraft lights
        sil.add(industry('flare'), kitM(0, 0, 0, 0, 2.6, 3.3));
        for (let y = 30; y < 160; y += 32) acc.lathe(0, 0, [[2.2, y], [2.2, y + 1.2]], 10);
        light(0, 167, 0, 2);
        light(3, 90, 0, 1.6);
        const fl = new THREE.Sprite(this.flame);
        fl.position.set(0, 176, 0);
        fl.scale.set(18, 30, 1);
        g.add(fl);
        // a tank farm at its foot: storage tanks with their stairs and bunds, a column, a pipe rack
        for (const [x, z, sc] of [[-34, 14, 1.2], [30, -16, 1.0], [44, 30, 0.8]] as const) sil.add(industry('tank'), kitM(x, 0, z, x * 0.1, sc));
        sil.add(industry('column'), kitM(-10, 0, -30, 0, 1.6, 1.8));
        sil.add(industry('pipeRack'), kitM(0, 0, -12, 0.3, 2.2));
        item.update = (t) => fl.scale.set(16 + Math.sin(t * 13) * 3, 28 + Math.sin(t * 7.3) * 6, 1);
        break;
      }
      case 'refinery': {
        // distillation columns with their platforms (kit columns at refinery scale), sphere tanks, a gantry crane,
        // pipe racks running between them, and a thousand small lights
        for (const [x, z, h, r] of [[-30, 0, 90, 4], [-15, 8, 70, 3], [0, -6, 110, 5], [18, 4, 60, 3.5], [34, -2, 85, 4]] as const) {
          sil.add(industry('column'), kitM(x, 0, z, x, r / 1.6, h / 42));
          for (let y = 12; y < h; y += 14) acc.lathe(x, z, [[r + 0.6, y], [r + 0.6, y + 0.6]], 10);
          light(x, h + 1.5, z, 1.8);
        }
        for (const [x, z, r] of [[-50, 22, 12], [50, 20, 10]] as const) {
          sil.lathe(x, z, [[0.1, r * 0.25], [r * 0.7, r * 0.45], [r, r * 1.1], [r * 0.7, r * 1.75], [0.1, r * 2.1]], 14);
          for (const a of [0, 1.6, 3.2, 4.8]) sil.box(x + Math.cos(a) * r * 0.6, r * 0.5, z + Math.sin(a) * r * 0.6, 1.2, r, 1.2);
        }
        for (const [x, yaw] of [[-24, 0], [24, 0]] as const) sil.add(industry('pipeRack'), kitM(x, 0, 18, yaw, 2.0));
        sil.add(industry('gantryCrane'), kitM(0, 0, -34, 0, 1.4));
        item.r = 80;
        break;
      }
      case 'dam': {
        // a dam wall holding the river back: buttressed face, spillway gate piers and intake towers on the crest,
        // a long lit crest, and white water down its face
        sil.box(0, 40, 0, 320, 80, 24);
        for (let x = -150; x <= 150; x += 20) sil.box(x, 34, -16, 5, 68, 10);
        for (const x of [-60, -20, 20, 60]) sil.box(x, 88, 0, 5, 16, 26);
        sil.box(0, 96.5, 0, 130, 2, 28);
        for (const x of [-120, 120]) sil.prism(x, 0, 18, 9, 104, 7, 12);
        acc2.box(0, 80.6, -12.5, 320, 0.8, 0.8);
        for (let x = -140; x <= 140; x += 20) light(x, 82, -12, 1.6);
        const falls = new GeoBuilder();
        for (const x of [-40, 0, 40]) falls.box(x, 38, -12.6, 14, 76, 0.4);
        const fm = new THREE.MeshBasicMaterial({ color: 0xbfe8ff, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
        this.mesh(falls, fm, g);
        const mist = new SmokeBatch();
        for (const x of [-40, 0, 40]) mist.column(x, 2, -22, 5, 18, 40, x / 100);
        const mp = mist.build();
        if (mp) g.add(mp);
        // long side along the road, the water face toward it
        g.rotation.y = heading + Math.PI / 2 + (side > 0 ? Math.PI : 0);
        // it lies along the road: only its depth matters for clearance
        item.r = 90;
        break;
      }
      case 'sunken': {
        // tower blocks half under water, leaning
        for (const [x, z, h, w, tilt] of [[-30, 0, 130, 34, 0.12], [35, 20, 100, 28, -0.09]] as const) {
          const sub = new THREE.Group();
          sub.position.set(x, -20, z);
          sub.rotation.z = tilt;
          g.add(sub);
          const s2 = new GeoBuilder(), w2 = new GeoBuilder();
          s2.box(0, h / 2, 0, w, h, w * 0.8, 0, 0, 0, 0, 0, undefined, true, false);
          w2.box(0, h / 2 + 10, 0, w + 0.05, h - 20, w * 0.8 + 0.05, 0, 32, 128, rng.range(0, 1), rng.range(0, 1), undefined, true, true);
          this.mesh(s2, this.sil, sub);
          const wm = this.mesh(w2, this.win, sub);
          if (wm) wm.renderOrder = 1;
          const r2 = new GeoBuilder();
          r2.box(0, h + 1, 0, 2, 2, 2);
          this.mesh(r2, this.red, sub);
        }
        break;
      }
      case 'lighthouse': {
        sil.lathe(0, 0, [[9, 0], [6, 70], [7, 72], [7, 82], [4, 88], [0.5, 94]], 12);
        acc2.lathe(0, 0, [[7.1, 74], [7.1, 80]], 12);
        for (let y = 10; y < 66; y += 14) acc.lathe(0, 0, [[9 - y * 0.042 + 0.1, y], [9 - y * 0.042 + 0.1, y + 3]], 12);
        // the sweeping beam
        const beam = new THREE.Mesh(beamGeometry(260, 1.1, 14, 16).rotateY(Math.PI / 2), this.beamMat);
        beam.position.set(0, 77, 0);
        g.add(beam);
        item.update = (t) => (beam.rotation.y = t * 0.6);
        break;
      }
      case 'mega': {
        // the city's tallest tower: setbacks with corner piers and fins, a lattice crown, a spire with platforms
        let y = 0;
        for (const [w, h] of [[56, 90], [46, 70], [36, 50], [26, 34]] as const) {
          winBox(0, y + h / 2, 0, w, h, w);
          for (const sx of [-1, 1]) for (const sz of [-1, 1]) sil.box(sx * (w / 2 + 0.6), y + h / 2, sz * (w / 2 + 0.6), 3.4, h, 3.4);
          for (let k = -2; k <= 2; k++) for (const [fx, fz] of [[k * w * 0.18, w / 2 + 0.7], [k * w * 0.18, -w / 2 - 0.7], [w / 2 + 0.7, k * w * 0.18], [-w / 2 - 0.7, k * w * 0.18]] as const) sil.box(fx, y + h / 2, fz, Math.abs(fz) > Math.abs(fx) ? 0.8 : 1.4, h, Math.abs(fz) > Math.abs(fx) ? 1.4 : 0.8);
          y += h;
          acc.box(0, y - 1, 0, w + 0.6, 1.2, w + 0.6);
        }
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) sil.beam([sx * 13, y, sz * 13], [sx * 4, y + 22, sz * 4], 1.2);
        sil.box(0, y + 22, 0, 10, 2, 10);
        for (const yy of [y + 36, y + 52]) sil.box(0, yy, 0, 5, 1.2, 5);
        sil.prism(0, y, 0, 3, y + 70, 0.6, 8);
        light(0, y + 71, 0, 2);
        item.r = 60;
        break;
      }
      case 'tv': {
        // TV tower: a tripod base, the shaft, a two-level pod with its observation ring, the stepped antenna mast
        for (let k = 0; k < 3; k++) {
          const a = (k / 3) * Math.PI * 2;
          sil.beam([Math.cos(a) * 26, 0, Math.sin(a) * 26], [Math.cos(a) * 4, 70, Math.sin(a) * 4], 4);
        }
        sil.prism(0, 0, 0, 7, 260, 4.5, 12);
        sil.lathe(0, 0, [[4.5, 196], [18, 204], [22, 212], [24, 226], [20, 232], [16, 236], [5, 242]], 18);
        sil.lathe(0, 0, [[4.5, 160], [12, 166], [12, 170], [4.5, 174]], 14);
        sil.prism(0, 242, 0, 3, 290, 2, 8);
        sil.prism(0, 290, 0, 1.6, 330, 0.6, 6);
        for (const yy of [262, 282, 304]) sil.lathe(0, 0, [[0.5, yy], [4, yy + 1], [4, yy + 2], [0.5, yy + 3]], 8);
        acc.lathe(0, 0, [[24.2, 218], [24.2, 224]], 18);
        acc2.lathe(0, 0, [[12.2, 167], [12.2, 169]], 14);
        for (const yy of [120, 260, 331]) light(0, yy, 0, 2.4);
        break;
      }
      case 'pagoda': {
        let y = 0;
        for (let k = 0; k < 7; k++) {
          const w = 46 - k * 5, h = 22;
          winBox(0, y + h / 2, 0, w, h, w);
          y += h;
          // flared roof plate with a neon edge
          sil.box(0, y + 0.6, 0, w + 10, 1.2, w + 10);
          (k % 2 ? acc : acc2).box(0, y + 1.3, 0, w + 10.4, 0.5, w + 10.4);
        }
        sil.prism(0, y, 0, 2.5, y + 40, 0.4, 6);
        light(0, y + 41, 0);
        break;
      }
      case 'arcology': {
        let y = 0;
        for (const [w, h] of [[150, 40], [120, 45], [90, 45], [64, 50], [40, 60]] as const) {
          winBox(0, y + h / 2, 0, w, h, w * 0.7);
          y += h;
          acc.box(0, y + 0.4, 0, w + 0.5, 0.8, w * 0.7 + 0.5);
        }
        for (const ox of [-15, 15]) light(ox, y + 2, 0, 2.4);
        item.r = 110;
        break;
      }
      case 'twin': {
        for (const ox of [-34, 34]) {
          winBox(ox, 140, 0, 36, 280, 36);
          // vertical fins and a lattice crown on each tower
          for (let k = -3; k <= 3; k++) for (const sz of [-1, 1]) sil.box(ox + k * 5, 140, sz * 18.6, 0.8, 280, 1.4);
          for (const sx of [-1, 1]) for (const sz of [-1, 1]) sil.beam([ox + sx * 17, 280, sz * 17], [ox + sx * 6, 300, sz * 6], 1.4);
          sil.prism(ox, 280, 0, 2, 320, 0.5, 6);
          light(ox, 321, 0, 2);
          acc.box(ox, 279, 0, 36.6, 1.2, 36.6);
        }
        winBox(0, 182, 0, 32, 10, 12);
        acc.box(0, 176.5, 0, 32, 0.6, 12.4);
        item.r = 70;
        break;
      }
      case 'suspension': {
        // a giant bridge somewhere else in the city: two towers, the deck, the cables
        for (const ox of [-120, 120]) {
          for (const oz of [-9, 9]) sil.box(ox, 110, oz, 6, 220, 6);
          sil.box(ox, 205, 0, 6, 6, 24);
          light(ox, 223, 0, 2.4);
        }
        sil.box(0, 70, 0, 420, 5, 22);
        acc2.box(0, 72.8, -11.2, 420, 0.6, 0.6);
        for (const oz of [-9, 9]) {
          for (let k = 0; k < 16; k++) {
            const x0 = -200 + k * 25, x1 = x0 + 25;
            const y0 = 70 + 0.0028 * (Math.abs(x0) - 120) ** 2 * (Math.abs(x0) < 120 ? 1 : 0) + (Math.abs(x0) < 120 ? 0 : (Math.abs(x0) - 120) * 1.4);
            const y1 = 70 + 0.0028 * (Math.abs(x1) - 120) ** 2 * (Math.abs(x1) < 120 ? 1 : 0) + (Math.abs(x1) < 120 ? 0 : (Math.abs(x1) - 120) * 1.4);
            sil.beam([x0, Math.min(215, y0), oz], [x1, Math.min(215, y1), oz], 1.2);
          }
        }
        g.rotation.y = heading + Math.PI / 2;
        item.r = 220;
        break;
      }
      case 'ring': {
        // the Zero: a ring of light standing in the sky, turning
        const ring = new THREE.Mesh(new THREE.TorusGeometry(110, 4, 10, 64), this.accent);
        ring.position.set(0, 190, 0);
        g.add(ring);
        const inner = new THREE.Mesh(new THREE.TorusGeometry(92, 1.2, 6, 64), this.red);
        inner.position.set(0, 190, 0);
        g.add(inner);
        item.update = (t) => {
          ring.rotation.y = t * 0.12;
          inner.rotation.y = -t * 0.2;
          inner.rotation.x = Math.sin(t * 0.3) * 0.3;
        };
        item.r = 120;
        break;
      }
      case 'inverted': {
        // a tower hanging from the sky, upside down
        winBox(0, 330, 0, 44, 200, 44);
        winBox(0, 210, 0, 30, 40, 30);
        sil.prism(0, 140, 0, 0.5, 190, 2.5, 6);
        acc.box(0, 229.5, 0, 44.6, 1, 44.6);
        light(0, 139, 0, 2.4);
        break;
      }
      case 'shards': {
        for (let k = 0; k < 5; k++) {
          const sub = new THREE.Group();
          sub.position.set(rng.range(-80, 80), rng.range(60, 220), rng.range(-50, 50));
          sub.rotation.set(rng.range(-0.6, 0.6), rng.range(0, 3), rng.range(-0.6, 0.6));
          const s2 = new GeoBuilder(), a2 = new GeoBuilder();
          const w = rng.range(14, 30), h = rng.range(40, 90);
          s2.box(0, 0, 0, w, h, w * 0.3, 0, 0, 0, 0, 0, undefined, false, false);
          a2.box(0, h / 2, 0, w + 0.4, 0.8, w * 0.3 + 0.4);
          a2.box(0, -h / 2, 0, w + 0.4, 0.8, w * 0.3 + 0.4);
          this.mesh(s2, this.sil, sub);
          this.mesh(a2, this.red, sub);
          g.add(sub);
          const ph = rng.range(0, 6);
          const base = sub.position.y;
          const prev = item.update;
          item.update = (t, dt) => {
            prev?.(t, dt);
            sub.rotation.y += dt * 0.05;
            sub.position.y = base + Math.sin(t * 0.3 + ph) * 6;
          };
        }
        item.r = 100;
        break;
      }
    }
    this.mesh(sil, this.sil, g);
    const wm = this.mesh(win, this.win, g);
    if (wm) wm.renderOrder = 1;
    this.mesh(red, this.red, g);
    this.mesh(acc, this.accent, g);
    this.mesh(acc2, this.accent2, g);
  }

  update(dt: number, playerS: number) {
    this.time += dt;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (it.s < playerS - 260) {
        this.root.remove(it.group);
        it.group.traverse((o) => {
          if (o instanceof THREE.Mesh || o instanceof THREE.Points) o.geometry.dispose();
        });
        this.items.splice(i, 1);
        continue;
      }
      it.update?.(this.time, dt);
    }
  }
}
