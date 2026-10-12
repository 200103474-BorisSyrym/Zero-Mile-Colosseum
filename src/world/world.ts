import * as THREE from 'three';
import { CONFIG } from '../core/config';
import { damp } from '../core/math';
import { DECALS, EMISSIVE, glow, REFLECTIONS } from '../render/visualBudget';
import { Random } from '../core/random';
import type { SegmentType, ZoneDef } from '../data/zones';
import type { HazardKind } from '../game/simApi';
import { buildCar } from '../vehicles/carModels';
import { S as Surf, atlasMaterial, envMaterial, kitMaterial } from '../assets/atlas';
import { prop } from '../assets/kit/props';
import { girders, pier, portal, pylon, rib, tunnelWall, parapet } from '../assets/kit/infra';
import { GeoBuilder } from './geobuilder';
import { perf } from '../core/perf';
import { warmMesh } from '../render/warmup';
import { beamGeometry, beamMaterial, mergeGeometries } from '../effects/lightBeams';
import { poolTexture } from '../effects/vfxTextures';
import { RoadGenerator, type PieceOpts, type SegmentInfo } from './generator';
import { checkerTexture, chevronBoardTexture, roadArrowTexture, signTextTexture } from './textures';
import { adAtlas, facadeTextures, fenceTexture, roadDecalAtlas, roadSignAtlas, shopfrontTextures } from './artTextures';
import { SmokeBatch, setSmokeZone, updateSmoke } from './smoke';
import { buildScenery } from './scenery';
import { Landmarks } from './landmarks';
import { Road } from './road';
import { asphaltTextures, containerTexture, signAtlas, SIGN_WORDS, stripeTexture, windowTexture } from './textures';

/** cones of lamp light, pointing down from the lamp head */
const LAMP_BEAM = beamGeometry(7.4, 0.25, 3.3, 12).rotateX(Math.PI / 2);
const TUNNEL_BEAM = beamGeometry(6.9, 0.4, 2.6, 12).rotateX(Math.PI / 2);
const hash01 = (x: number) => {
  const h = Math.sin(x * 12.9898 + 4.1414) * 43758.5453;
  return h - Math.floor(h);
};
/** one of 8 orientations of the pool texture (4 turns × mirror) */
function poolUv(seed: number) {
  const h = hash01(seed);
  const base = [0, 0, 1, 0, 1, 1, 0, 1];
  const turn = Math.floor(h * 4) % 4;
  const out = base.slice(turn * 2).concat(base.slice(0, turn * 2));
  if (h * 8 % 2 > 1) for (let k = 0; k < 8; k += 2) out[k] = 1 - out[k];
  return out;
}

export type PropKind = 'cone' | 'barrel' | 'xbarrel' | 'sign' | 'trash' | 'glass' | 'plastic' | 'block' | 'parked' | 'pillar' | 'crate';

export interface Prop {
  kind: PropKind;
  x: number;
  y: number;
  z: number;
  s: number;
  r: number;
  heavy: boolean;
  explosive: boolean;
  alive: boolean;
  flying: boolean;
  mesh: THREE.Object3D;
  vx: number;
  vy: number;
  vz: number;
  spin: number;
  life: number;
  /** near-miss tracking state */
  nm?: number;
  /** boss-arena obstacle: stops the car and costs the combo, but barely scratches the hull */
  cushion?: boolean;
}

interface Anim {
  obj: THREE.Object3D;
  kind: 'blink' | 'spin' | 'spinZ' | 'float' | 'traffic';
  phase: number;
  base?: number;
  mat?: THREE.MeshBasicMaterial;
}

interface SegmentInstance {
  info: SegmentInfo;
  group: THREE.Group;
  /** small merged details with the road distance past which they are not drawn (see cullDetail) */
  detail: { mesh: THREE.Object3D; dist: number }[];
  geos: THREE.BufferGeometry[];
  props: Prop[];
  anims: Anim[];
  mats: THREE.Material[];
  lamps: { x: number; y: number; z: number; s: number }[];
}

export interface PendingHazard {
  kind: HazardKind;
  x: number;
  z: number;
  r: number;
}

export const lanesFor = (w: number) => Math.max(2, Math.round(w / CONFIG.WORLD.LANE_WIDTH));
export const laneOffset = (w: number, lane: number) => {
  const n = lanesFor(w);
  const lw = w / n;
  return -w / 2 + lw * (Math.min(n - 1, Math.max(0, lane)) + 0.5);
};

/** World matrix for a kit asset: position, yaw about Y, uniform scale. */
const UPV = new THREE.Vector3(0, 1, 0);
export function place(x: number, y: number, z: number, yaw = 0, scale = 1) {
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(UPV, yaw), new THREE.Vector3(scale, scale, scale));
}

// Shared prop geometries
const CABLE_GEO = new THREE.BoxGeometry(1, 1, 1);
/** Draw distance (m along the road) of the small merged details; everything not listed is always drawn. */
const DETAIL_DIST: Record<string, number> = {
  line: 240, lineY: 240, lineWorn: 220, mark1: 240, mark2: 240, mark3: 240, mark4: 240,
  chev1: 260, chev2: 260, chev3: 260, chev4: 260, decal: 220, cushion: 300, roadsign: 320, cable: 300, fence: 300,
};
/** Draw distance of the gameplay props (cones, barrels, bins, blocks, parked cars). */
const PROP_DRAW_DIST = 300;

const PG = {
  box: new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
};

export class World {
  readonly root = new THREE.Group();
  readonly road = new Road();
  gen!: RoadGenerator;
  zone!: ZoneDef;
  rng = new Random(1);
  segments: SegmentInstance[] = [];
  props: Prop[] = [];
  pendingHazards: PendingHazard[] = [];
  time = 0;
  propDensity = 1;
  tutorial = false;
  /** Upper bound on generated road length (for finite nodes); Infinity for endless. */
  maxLength = Infinity;
  finishS = -1;
  private finishGroup: THREE.Group | null = null;
  /** Encounter director supplies the next road piece; null = free generation. */
  source: { next(): { type: SegmentType; opts: PieceOpts } | null } | null = null;
  /** Called after every segment is built so encounters can dress it. */
  onSegment: ((info: SegmentInfo) => void) | null = null;

  private mats!: Record<string, THREE.Material>;
  private propMats!: Record<string, THREE.Material>;
  private kitLights = { head: new THREE.Color(1, 0.9, 0.7), tail: glow(0xff1018, EMISSIVE.MEDIUM), accent: new THREE.Color(0, 1, 1) };
  /** the faint cone of light under every lamp (street and tunnel): fake volumetric, thicker in rain and haze */
  private lampBeamMat = beamMaterial(0xffa040, 0.05, 1.1);

  /** giant background structures per zone (landmarks.ts) */
  readonly landmarks: Landmarks;
  private lastPlayerS = 0;

  constructor(private scene: THREE.Scene) {
    scene.add(this.root);
    this.landmarks = new Landmarks(this.root);
    this.createMaterials();
  }

  private createMaterials() {
    const asp = asphaltTextures();
    this.mats = {
      road: new THREE.MeshStandardMaterial({ map: asp.color, roughnessMap: asp.rough, roughness: 1, metalness: 0.2, color: 0xa0a2b0, envMapIntensity: 1.0 }),
      sidewalk: new THREE.MeshStandardMaterial({ color: 0x2a2b31, roughness: 0.85, metalness: 0.05 }),
      line: new THREE.MeshBasicMaterial({ color: 0xc8ccd8 }),
      lineY: new THREE.MeshBasicMaterial({ color: 0xffc23a }),
      barrier: new THREE.MeshStandardMaterial({ color: 0x45474f, roughness: 0.7, metalness: 0.2 }),
      // barrier glow strip runs along the whole road beside the camera: SUBTLE, never blooms
      // barrier glow strip runs along the whole road beside the camera: SUBTLE, never blooms
      strip: new THREE.MeshBasicMaterial({ color: 0xffffff }),
      pole: new THREE.MeshStandardMaterial({ color: 0x24262c, roughness: 0.5, metalness: 0.6 }),
      lamp: new THREE.MeshBasicMaterial({ color: 0xffffff }),
      pool: new THREE.MeshBasicMaterial({ map: poolTexture(), transparent: true, opacity: DECALS.lightPool, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }),
      // windows glow (SUBTLE) — they never light the city or bloom
      building: new THREE.MeshStandardMaterial({ color: 0x1c1e27, roughness: 0.75, metalness: 0.25, emissiveMap: windowTexture(), emissive: 0xffffff, emissiveIntensity: EMISSIVE.SUBTLE * 0.9 }),
      roof: new THREE.MeshStandardMaterial({ color: 0x0c0d11, roughness: 0.9 }),
      // neon street signs: the atlas carries the saturated hue, the tint only sets the tier
      sign: new THREE.MeshBasicMaterial({ map: signAtlas(), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, color: glow(0xffffff, EMISSIVE.MEDIUM * 0.95) }),
      container: new THREE.MeshStandardMaterial({ map: containerTexture(), vertexColors: true, roughness: 0.6, metalness: 0.4 }),
      water: new THREE.MeshStandardMaterial({ color: 0x03070c, roughness: 0.06, metalness: 1, envMapIntensity: REFLECTIONS.water }),
      glow: new THREE.MeshBasicMaterial({ vertexColors: true }),
      tunnel: new THREE.MeshStandardMaterial({ color: 0x2c2d33, roughness: 0.75, metalness: 0.15 }),
      stripe: new THREE.MeshStandardMaterial({ map: stripeTexture(), roughness: 0.6, emissive: 0x332200, emissiveMap: stripeTexture() }),
      wire: new THREE.MeshBasicMaterial({ color: 0xff1040, wireframe: true, transparent: true, opacity: 0.6 }),
      deck: new THREE.MeshStandardMaterial({ color: 0x1c1d22, roughness: 0.8, metalness: 0.3 }),
      mark1: new THREE.MeshBasicMaterial({ color: glow(0xffb81a, EMISSIVE.SUBTLE) }),
      mark2: new THREE.MeshBasicMaterial({ color: glow(0xffc838, EMISSIVE.SUBTLE) }),
      mark3: new THREE.MeshBasicMaterial({ color: glow(0x20e8ff, EMISSIVE.SUBTLE) }),
      mark4: new THREE.MeshBasicMaterial({ color: glow(0xff2840, EMISSIVE.SUBTLE) }),
      chev1: this.chevMat(0xffc21a), chev2: this.chevMat(0xffd84a), chev3: this.chevMat(0x30f0ff), chev4: this.chevMat(0xff2840),
      median: new THREE.MeshStandardMaterial({ color: 0x6a6c74, roughness: 0.6, metalness: 0.2 }),
      cushion: new THREE.MeshStandardMaterial({ map: stripeTexture(), emissive: 0x664400, emissiveMap: stripeTexture(), roughness: 0.6 }),
      board: new THREE.MeshBasicMaterial({ map: chevronBoardTexture(), color: glow(0xffffff, EMISSIVE.SUBTLE * 1.25) }),
      // --- environment art (scenery.ts): structure lit by the scene, windows lit from inside
      facadeO: this.facadeMat('office', 0.5, 0.45),
      facadeR: this.facadeMat('resi', 0.85, 0.1),
      facadeI: this.facadeMat('ind', 0.7, 0.35),
      shop: new THREE.MeshStandardMaterial({ map: shopfrontTextures().color, emissiveMap: shopfrontTextures().emissive, emissive: 0xffffff, emissiveIntensity: EMISSIVE.MEDIUM * 0.75, roughness: 0.6, metalness: 0.2 }),
      ad: new THREE.MeshBasicMaterial({ map: adAtlas(), color: glow(0xffffff, EMISSIVE.SUBTLE * 1.1) }),
      fence: new THREE.MeshStandardMaterial({ map: fenceTexture(), alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.55, metalness: 0.6, color: 0x9aa0aa }),
      decal: new THREE.MeshBasicMaterial({ map: roadDecalAtlas(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }),
      roadsign: new THREE.MeshStandardMaterial({ map: roadSignAtlas(), emissiveMap: roadSignAtlas(), emissive: 0xffffff, emissiveIntensity: 0.22, roughness: 0.4, metalness: 0.3 }),
      glass: new THREE.MeshStandardMaterial({ color: 0x203040, transparent: true, opacity: 0.35, roughness: 0.05, metalness: 0.8, side: THREE.DoubleSide, depthWrite: false }),
      concrete: new THREE.MeshStandardMaterial({ color: 0x707076, roughness: 0.92, metalness: 0.02 }),
      paint: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.45 }),
      cable: new THREE.MeshBasicMaterial({ color: 0x08080a }),
      bark: new THREE.MeshStandardMaterial({ color: 0x2a2018, roughness: 1 }),
      leaf: new THREE.MeshStandardMaterial({ color: 0x24402a, roughness: 0.95, flatShading: true }),
      rust: new THREE.MeshStandardMaterial({ color: 0x6a4630, roughness: 0.7, metalness: 0.55 }),
      monolith: new THREE.MeshStandardMaterial({ color: 0x050507, roughness: 0.3, metalness: 0.8 }),
      lineWorn: new THREE.MeshBasicMaterial({ color: 0x5c6068 }),
      // authored kit assets (props, building relief, industry, bridges, tunnels): one atlas material; lamp heads and
      // lit windows take the zone's street light, warning lights are red, accent surfaces carry the zone's neon
      kit: envMaterial(this.kitLights),
    };
    // gameplay props are kit models too; each kind's paint (and the explosive drum's glowing seal) is its material
    const dark = () => ({ head: new THREE.Color(0, 0, 0), tail: new THREE.Color(0, 0, 0), accent: new THREE.Color(0, 0, 0) });
    const painted = (hex: number, lights = dark()) => {
      const m = atlasMaterial(false, lights);
      m.color.setHex(hex);
      return m;
    };
    this.propMats = {
      cone: painted(0xff5a10),
      barrel: painted(0x2f5fa0),
      xbarrel: painted(0xd02020, { head: new THREE.Color(0, 0, 0), tail: new THREE.Color(0, 0, 0), accent: glow(0xff4010, EMISSIVE.STRONG) }),
      trash: painted(0x2d4030),
      glass: new THREE.MeshStandardMaterial({ color: 0x80c0ff, transparent: true, opacity: 0.35, roughness: 0.05, metalness: 0.9, emissive: 0x102040 }),
      kit: kitMaterial(),
    };
  }

  private facadeMat(style: 'office' | 'resi' | 'ind', roughness: number, metalness: number) {
    const t = facadeTextures(style);
    return new THREE.MeshStandardMaterial({ map: t.color, emissiveMap: t.emissive, emissive: 0xffffff, emissiveIntensity: EMISSIVE.SUBTLE * 1.15, roughness, metalness, color: 0x8a8e98, envMapIntensity: 0.6 });
  }

  private chevMat(color: number) {
    return new THREE.MeshBasicMaterial({ map: roadArrowTexture(), color: glow(color, EMISSIVE.SUBTLE), transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
  }

  /** Nearest lateral position that is not inside a split median. */
  safeD(s: number, d: number) {
    const sm = this.road.sample(s);
    if (sm.median <= 0) return d;
    const half = sm.median / 2 + 1.5;
    const rel = d - sm.medianD;
    if (Math.abs(rel) >= half) return d;
    return sm.medianD + (rel >= 0 ? half : -half);
  }

  setZone(zone: ZoneDef) {
    this.zone = zone;
    glow(zone.barrierColor, EMISSIVE.SUBTLE, (this.mats.strip as THREE.MeshBasicMaterial).color);
    // the bulb only *looks* bright; the pooled point light does the actual lighting
    glow(zone.streetLight, EMISSIVE.MEDIUM, (this.mats.lamp as THREE.MeshBasicMaterial).color);
    (this.mats.pool as THREE.MeshBasicMaterial).color.setHex(zone.streetLight);
    this.lampBeamMat.uniforms.color.value.setHex(zone.streetLight);
    this.lampBeamMat.uniforms.intensity.value = 0.035 + zone.rain * 0.05 + Math.min(0.04, zone.fogDensity * 2);
    (this.mats.wire as THREE.MeshBasicMaterial).color.setHex(zone.neon[0]);
    glow(zone.streetLight, EMISSIVE.MEDIUM, this.kitLights.head);
    glow(zone.neon[0], EMISSIVE.MEDIUM, this.kitLights.accent);
    // facades take a little of the zone: warm rust, cold flood concrete, violet old town, steel skyway, ash zero
    const tint = ({ industrial: 0x9a8a78, flood: 0x7a8c96, oldcity: 0x8c7a8c, skyway: 0x8a96aa, zeromile: 0x5a4a52 } as Record<string, number>)[zone.id] ?? 0x8a8e98;
    for (const k of ['facadeO', 'facadeR', 'facadeI']) (this.mats[k] as THREE.MeshStandardMaterial).color.setHex(tint);
    setSmokeZone(new THREE.Color(zone.fog).lerp(new THREE.Color(0x9a9690), 0.55), new THREE.Color(zone.fog), zone.fogDensity);
    const roadMat = this.mats.road as THREE.MeshStandardMaterial;
    roadMat.color.setHex(zone.id === 'zeromile' ? 0x7a7088 : zone.id === 'flood' ? 0x8090a0 : 0xa0a2b0);
  }

  reset(zone: ZoneDef, seed: number, opts: { forced?: SegmentType[]; tutorial?: boolean; maxLength?: number; propDensity?: number; narrow?: boolean } = {}) {
    this.clear();
    this.setZone(zone);
    this.rng = new Random(seed);
    this.tutorial = !!opts.tutorial;
    this.propDensity = opts.propDensity ?? 1;
    this.maxLength = opts.maxLength ?? Infinity;
    this.finishS = this.maxLength < Infinity ? this.maxLength : -1;
    this.gen = new RoadGenerator(this.road, zone, this.rng.fork(7), opts.narrow !== false);
    this.gen.forced = opts.forced ? [...opts.forced] : ['STRAIGHT'];
    this.landmarks.reset(zone, seed);
    // the start of the road is built now, out to where the fog hides 87–99% of anything (no pop-in at the start);
    // the rest of the look-ahead streams in over the first frames
    this.ensureAhead(0, 0, CONFIG.WORLD.BUILD_ON_RESET);
  }

  clear() {
    // a half-built segment: finish it so its geometry exists to be disposed, then drop it
    // a half-built segment is already in the list: finish it so all its geometry exists to be disposed with the rest
    if (this.building) {
      let r: IteratorResult<string, SegmentInstance> = this.building.it.next();
      while (!r.done) r = this.building.it.next();
      this.building = null;
    }
    this.landmarksDue = false;
    this.jobs = [];
    this.lastPlayerS = 0;
    for (const seg of this.segments) this.disposeSegment(seg);
    this.segments = [];
    this.props = [];
    this.pendingHazards = [];
    this.road.clear();
    if (this.finishGroup) {
      this.root.remove(this.finishGroup);
      this.finishGroup = null;
      this.gateArms = [];
    }
  }

  /** model builds that can wait for a budget slot (parked cars far down the road) */
  private jobs: (() => void)[] = [];
  /** a segment was finished: the landmarks get their own slot before the next one starts */
  private landmarksDue = false;
  /** the segment being built a slice at a time, and the CPU time it has taken so far */
  private building: { info: SegmentInfo; it: Generator<string, SegmentInstance, void>; ms: number; maxStep: number; maxLabel: string; label: string; steps: number } | null = null;

  /**
   * Keep the road built GEN_AHEAD metres ahead. Building a segment (geometry, scenery, props) took 20–40 ms in one
   * frame — a visible hitch every few seconds. Now:
   *   - the segment exists the moment it is generated, and the encounter dresses it right then, exactly when it always
   *     did (the encounter's random stream is shared with its live play: the same moment keeps the same run);
   *   - its geometry is built in steps under `budgetMs` per frame (its own seeded stream: the same road however many
   *     frames it takes), then the landmarks get a slot, then the next segment starts.
   * The road closer than `urgentAhead` metres is never left to slices: a segment that starts there is finished at once.
   */
  ensureAhead(playerS: number, budgetMs = Infinity, urgentAhead: number = CONFIG.WORLD.BUILD_URGENT) {
    const t0 = performance.now();
    const spent = () => performance.now() - t0 >= budgetMs && this.road.endS >= playerS + urgentAhead;
    let guard = 0;
    for (;;) {
      if (this.jobs.length) {
        this.jobs.shift()!();
        if (spent()) break;
        continue;
      }
      if (this.landmarksDue) {
        const tl = performance.now();
        this.landmarks.onRoad(this.road, this.road.endS);
        this.landmarksDue = false;
        if (performance.now() - tl > 2) perf.event(`landmark ${(performance.now() - tl).toFixed(1)}ms`);
        if (spent()) break;
        continue;
      }
      if (!this.building) {
        if (this.road.endS >= playerS + CONFIG.WORLD.GEN_AHEAD || guard++ >= 12) break;
        if (this.finishS > 0 && this.road.endS > this.finishS + 260) break;
        const piece = this.source?.next() ?? null;
        const info = piece ? this.gen.next(piece.type, piece.opts) : this.gen.next();
        const seg = this.beginSegment(info);
        this.segments.push(seg);
        const td = performance.now();
        this.onSegment?.(info);
        if (this.finishS > 0 && !this.finishGroup && info.endS > this.finishS + 5) this.buildFinish();
        if (performance.now() - td > 2) perf.event(`dress ${info.type} ${(performance.now() - td).toFixed(1)}ms`);
        this.building = { info, it: this.buildSegmentSteps(seg), ms: 0, maxStep: 0, maxLabel: '', label: 'surface', steps: 0 };
      }
      const b = this.building;
      const urgent = b.info.startS < playerS + urgentAhead;
      const ts = performance.now();
      let r: IteratorResult<string, SegmentInstance>;
      do {
        const t1 = performance.now();
        r = b.it.next();
        const dt = performance.now() - t1;
        if (dt > b.maxStep) {
          b.maxStep = dt;
          b.maxLabel = b.label;
        }
        if (!r.done) b.label = r.value;
        b.steps++;
      } while (!r.done && (urgent || performance.now() - t0 < budgetMs));
      b.ms += performance.now() - ts;
      if (!r.done) break;
      this.building = null;
      perf.count('segment');
      perf.event(`segment ${b.info.type} ${b.ms.toFixed(1)}ms in ${b.steps} steps (max ${b.maxStep.toFixed(1)} ${b.maxLabel})${urgent ? ' (urgent)' : ''}`);
      this.landmarksDue = true;
      if (spent()) break;
    }
  }

  trimBehind(playerS: number) {
    this.lastPlayerS = playerS;
    const keep = playerS - CONFIG.WORLD.KEEP_BEHIND;
    while (this.segments.length > 2 && this.segments[0].info.endS < keep) {
      const seg = this.segments.shift()!;
      this.disposeSegment(seg);
      this.props = this.props.filter((p) => !seg.props.includes(p));
    }
    const minS = this.segments[0]?.info.startS ?? 0;
    this.road.trimBefore(minS - 2);
  }

  get minS() {
    return (this.segments[0]?.info.startS ?? 0) + 4;
  }

  /** Shader warm-up (render/warmup.ts): every material the road can draw, the gameplay props, runtime signs, the gate. */
  warmObjects(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    for (const m of [...Object.values(this.mats), ...Object.values(this.propMats), this.lampBeamMat]) out.push(warmMesh(m));
    const rng = new Random(1);
    for (const k of ['cone', 'barrel', 'xbarrel', 'trash', 'crate', 'glass', 'plastic', 'block', 'pillar', 'sign', 'parked'] as PropKind[]) {
      const p = this.makeProp(k, this.road.startS + 1, 0, rng);
      if (p) out.push(p.mesh);
    }
    // encounter signs and the finish gate build their materials when they appear: the same kinds here
    // (the first text sign drawn also pays ~20 ms of canvas text-and-shadow setup: one is drawn here)
    out.push(warmMesh(new THREE.MeshBasicMaterial({ map: signTextTexture('ZERO MILE', 0xffffff, 'CHECKPOINT'), color: 0xffffff, transparent: true })));
    // the signs' symbols are not in the display font: the first one drawn paid ~10 ms for the font fallback, in every
    // size the signs use (66 and 54 px titles, 30 px sub lines)
    signTextTexture('◂ ☠ ▸ · —', 0xffffff);
    signTextTexture('◂ ☠ ▸ · —', 0xffffff, '◂ ☠ ▸ · —');
    out.push(warmMesh(new THREE.MeshBasicMaterial({ map: checkerTexture(), color: 0xffffff })));
    out.push(warmMesh(new THREE.MeshBasicMaterial({ color: 0xffffff })));
    const chase = new THREE.InstancedMesh(PG.box, new THREE.MeshBasicMaterial({ color: 0xffffff }), 1);
    chase.setColorAt(0, new THREE.Color(0, 0, 0));
    out.push(chase);
    // chimney plumes (GPU points, their own shader): not every title road has one
    const plume = new SmokeBatch();
    plume.column(0, 0, 0, 2, 4, 2);
    const pts = plume.build();
    if (pts) out.push(pts);
    out.push(...this.landmarks.warmObjects());
    return out;
  }

  /** Debug access to the shared world materials (visual lab, material inspector). */
  getMat(key: string): THREE.Material {
    return this.mats[key];
  }

  /** Extra lamps registered by the debug visual lab. */
  private labLamps: { x: number; y: number; z: number; s: number }[] = [];
  addLabLamp(l: { x: number; y: number; z: number; s: number }) {
    this.labLamps.push(l);
  }
  clearLabLamps() {
    this.labLamps = [];
  }

  /** Street lamps in [s0, s1] (for the dynamic light pool). */
  lampsBetween(s0: number, s1: number, out: { x: number; y: number; z: number; s: number }[]) {
    out.length = 0;
    for (const l of this.labLamps) if (l.s >= s0 && l.s <= s1) out.push(l);
    if (this.finishGroup) for (const l of this.finishLamps) if (l.s >= s0 && l.s <= s1) out.push(l);
    for (const seg of this.segments) {
      if (seg.info.endS < s0 || seg.info.startS > s1) continue;
      for (const l of seg.lamps) if (l.s >= s0 && l.s <= s1) out.push(l);
    }
    return out;
  }

  segmentAt(s: number): SegmentInfo | undefined {
    for (const seg of this.segments) if (s >= seg.info.startS && s < seg.info.endS) return seg.info;
    return undefined;
  }

  private disposeSegment(seg: SegmentInstance) {
    this.root.remove(seg.group);
    for (const g of seg.geos) g.dispose();
    for (const m of seg.mats) m.dispose();
    for (const p of seg.props) {
      p.mesh.userData.gone = true;
      (p.mesh.userData.dispose as (() => void) | undefined)?.();
    }
  }

  /**
   * Small things far down the road are not drawn: lane paint, road decals, cables, fences and roadside props past
   * 220–320 m are a pixel or two under 60–90% fog, yet each one was a draw call. Gameplay-relevant reads (ramps, corner
   * boards, neon, lamps, buildings) are never culled, and props come back the moment they are in range — collisions
   * never look at visibility.
   */
  private cullDetail() {
    const s0 = this.lastPlayerS;
    for (const seg of this.segments) {
      const ahead = Math.max(seg.info.startS - s0, s0 - seg.info.endS, 0);
      for (const d of seg.detail) d.mesh.visible = ahead < d.dist;
      for (const p of seg.props) if (p.alive) p.mesh.visible = Math.abs(p.s - s0) < PROP_DRAW_DIST;
    }
  }

  update(dt: number) {
    this.time += dt;
    this.cullDetail();
    this.updateGate(dt);
    updateSmoke(this.time);
    this.landmarks.update(dt, this.lastPlayerS);
    for (const seg of this.segments) {
      for (const a of seg.anims) {
        if (a.kind === 'blink') a.obj.visible = Math.sin(this.time * 6 + a.phase) > 0;
        else if (a.kind === 'spin') {
          a.obj.rotation.y += dt * 0.4;
          a.obj.rotation.x += dt * 0.25;
        } else if (a.kind === 'spinZ') a.obj.rotation.z = this.time * 0.35 + a.phase;
        else if (a.kind === 'float') a.obj.position.y = (a.base ?? 0) + Math.sin(this.time * 0.7 + a.phase) * 2;

        else if (a.kind === 'traffic' && a.mat) {
          const t = (this.time * 0.6 + a.phase) % 3;
          glow(t < 1 ? 0xff1020 : t < 2 ? 0x20ff60 : 0xffc020, EMISSIVE.MEDIUM, a.mat.color);
        }
      }
    }
    // knocked props
    for (const p of this.props) {
      if (!p.flying) continue;
      p.vy -= CONFIG.GRAVITY * dt;
      p.x += p.vx * dt;
      p.z += p.vz * dt;
      p.y += p.vy * dt;
      if (p.y < 0) {
        p.y = 0;
        p.vy = -p.vy * 0.3;
        p.vx *= 0.7;
        p.vz *= 0.7;
      }
      p.mesh.position.set(p.x, p.y, p.z);
      p.mesh.rotation.x += p.spin * dt;
      p.mesh.rotation.z += p.spin * 0.7 * dt;
      p.life -= dt;
      if (p.life <= 0) {
        p.flying = false;
        p.mesh.visible = false;
      }
    }
  }

  /** Knock a light prop flying. */
  knockProp(p: Prop, vx: number, vz: number) {
    p.alive = false;
    p.flying = true;
    p.vx = vx * 0.9 + (Math.random() - 0.5) * 4;
    p.vz = vz * 0.9 + (Math.random() - 0.5) * 4;
    p.vy = 4 + Math.hypot(vx, vz) * 0.25;
    p.spin = (Math.random() - 0.5) * 16;
    p.life = 2.2;
  }

  destroyProp(p: Prop) {
    p.alive = false;
    p.flying = false;
    p.mesh.visible = false;
  }

  // ---------------------------------------------------------------- building

  /**
   * Zone landmarks — big, simple silhouettes that say where you are from 300 m away:
   * gantry cranes (Industrial), transmission pylons (Flood), holo-billboard towers (Old City),
   * suspension towers (Skyway), the Zero ring (Zero Mile).
   */
  private buildLandmark(seg: SegmentInstance, B: Record<string, GeoBuilder>, rng: Random, s: number) {
    const p = this.road.at(s);
    const h = p.heading;
    const r: [number, number] = [-Math.cos(h), Math.sin(h)];
    const at = (d: number): [number, number] => [p.x + r[0] * d, p.z + r[1] * d];
    const red = glow(0xff0c10, EMISSIVE.STRONG);
    const zone = this.zone;
    const neon = glow(zone.neon[0], EMISSIVE.MEDIUM);
    const side = rng.sign();
    switch (zone.id) {
      case 'industrial': {
        // gantry crane straddling the road, a container hanging from the trolley
        const span = p.width / 2 + 7;
        for (const sd of [-1, 1]) {
          const [x, z] = at(sd * span);
          for (const off of [-4, 4]) B.stripe.box(x + Math.sin(h) * off, 14, z + Math.cos(h) * off, 1.1, 28, 1.1, h, 1, 8);
        }
        const [cx, cz] = at(0);
        B.stripe.box(cx, 28.5, cz, span * 2 + 3, 2.2, 10, h, 6, 1);
        B.pole.box(cx + r[0] * 3, 26.4, cz + r[1] * 3, 3, 2, 4, h);
        B.pole.box(cx + r[0] * 3, 20, cz + r[1] * 3, 0.15, 11, 0.15, h);
        B.container.box(cx + r[0] * 3, 13.2, cz + r[1] * 3, 2.4, 2.6, 12, h, 4, 4, 0, 0, new THREE.Color().setHSL(0.03, 0.7, 0.4), false, false);
        for (const sd of [-1, 1]) {
          const [x, z] = at(sd * span);
          B.glow.box(x, 29.8, z, 0.6, 0.6, 0.6, h, 0, 0, 0, 0, red);
        }
        break;
      }
      case 'flood': {
        // transmission pylon beside the road, cables sagging over it
        const dist = p.width / 2 + 14;
        const [x, z] = at(side * dist);
        for (let k = 0; k < 6; k++) {
          const y0 = k * 6, w = 6 - k * 0.8;
          for (const [a, b] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) B.pole.box(x + r[0] * a * w / 2 + Math.sin(h) * b * w / 2, y0 + 3, z + r[1] * a * w / 2 + Math.cos(h) * b * w / 2, 0.35, 6, 0.35, h);
          B.pole.box(x, y0 + 6, z, w + 0.4, 0.3, 0.3, h);
        }
        B.pole.box(x, 34, z, 14, 0.5, 0.5, h);
        const [ox, oz] = at(-side * dist);
        for (const k of [-5, 5]) {
          const ax = x + r[0] * k, az = z + r[1] * k;
          const bx = ox + r[0] * k, bz = oz + r[1] * k;
          B.glow.box((ax + bx) / 2, 31, (az + bz) / 2, 0.08, 0.08, Math.hypot(bx - ax, bz - az), Math.atan2(bx - ax, bz - az), 0, 0, 0, 0, glow(0x20e0ff, EMISSIVE.MEDIUM));
          B.glow.box(ax, 34.5, az, 0.5, 0.5, 0.5, h, 0, 0, 0, 0, red);
        }
        break;
      }
      case 'oldcity': {
        // a holo-billboard tower: a tall mast carrying a giant sign facing the traffic
        const dist = p.width / 2 + 9;
        const [x, z] = at(side * dist);
        B.pole.box(x, 13, z, 1.2, 26, 1.2, h);
        const cell = Math.floor(rng.range(0, SIGN_WORDS.length));
        const w = 16, hh = 6;
        const fx = Math.sin(h), fz = Math.cos(h);
        // panel faces the oncoming player (towards -forward); same atlas layout as the street signs
        const u0 = (cell % 4) / 4, u1 = u0 + 0.25;
        const row = Math.floor(cell / 4);
        const v1 = 1 - row / 5, v0 = 1 - (row + 1) / 5;
        const c: [number, number, number] = [x - fx * 0.8, 24, z - fz * 0.8];
        B.sign.quad(
          [c[0] - r[0] * w / 2, c[1] - hh / 2, c[2] - r[1] * w / 2],
          [c[0] + r[0] * w / 2, c[1] - hh / 2, c[2] + r[1] * w / 2],
          [c[0] + r[0] * w / 2, c[1] + hh / 2, c[2] + r[1] * w / 2],
          [c[0] - r[0] * w / 2, c[1] + hh / 2, c[2] - r[1] * w / 2],
          [-fx, 0, -fz],
          [u0, v0, u1, v0, u1, v1, u0, v1],
        );
        B.glow.box(x - fx * 0.5, 20.8, z - fz * 0.5, w, 0.25, 0.25, h, 0, 0, 0, 0, neon);
        B.glow.box(x - fx * 0.5, 27.2, z - fz * 0.5, w, 0.25, 0.25, h, 0, 0, 0, 0, neon);
        break;
      }
      case 'skyway': {
        // suspension tower: two legs, a cross beam high above the deck, cables down to the barriers
        const span = p.width / 2 + 3;
        for (const sd of [-1, 1]) {
          const [x, z] = at(sd * span);
          B.deck.box(x, -10, z, 2.6, 110, 2.6, h);
          B.glow.box(x, 46, z, 0.7, 0.7, 0.7, h, 0, 0, 0, 0, red);
          for (const dir of [-1, 1]) {
            for (let k = 1; k <= 3; k++) {
              const ex = x + Math.sin(h) * dir * k * 14 - r[0] * sd * 0.5, ez = z + Math.cos(h) * dir * k * 14 - r[1] * sd * 0.5;
              const top = new THREE.Vector3(x, 44, z), end = new THREE.Vector3(ex, p.y + 1.2, ez);
              const cable = new THREE.Mesh(CABLE_GEO, this.mats.pole);
              cable.position.copy(top).add(end).multiplyScalar(0.5);
              cable.lookAt(end);
              cable.scale.set(0.14, 0.14, top.distanceTo(end));
              seg.group.add(cable);
            }
          }
        }
        const [cx, cz] = at(0);
        B.deck.box(cx, 40, cz, span * 2 + 3, 2.4, 2.6, h);
        B.glow.box(cx, 38.6, cz, span * 2, 0.2, 0.2, h, 0, 0, 0, 0, neon);
        break;
      }
      case 'zeromile': {
        // the Zero: a glowing ring over the road, slowly turning
        const ring = new THREE.Mesh(new THREE.TorusGeometry(p.width / 2 + 5, 0.6, 8, 48), new THREE.MeshBasicMaterial({ color: glow(0xff1a48, EMISSIVE.STRONG) }));
        seg.geos.push(ring.geometry);
        seg.mats.push(ring.material);
        const [cx, cz] = at(0);
        ring.position.set(cx, p.y + 6, cz);
        ring.rotation.y = h;
        seg.group.add(ring);
        seg.anims.push({ obj: ring, kind: 'spinZ', phase: rng.range(0, 6), base: ring.position.y });
        break;
      }
    }
  }

  /** Builds a segment as steps; each yield names the step that runs next (shown with the slowest step in the profiler). */
  /** An empty segment in the scene: dressing can attach to it at once, its geometry follows (buildSegmentSteps). */
  private beginSegment(info: SegmentInfo): SegmentInstance {
    const group = new THREE.Group();
    this.root.add(group);
    return { info, group, detail: [], geos: [], props: [], anims: [], mats: [], lamps: [] };
  }

  private *buildSegmentSteps(seg: SegmentInstance): Generator<string, SegmentInstance, void> {
    const { info, group } = seg;
    const z = this.zone;
    const rng = this.rng.fork(info.index * 31 + 3);
    const road = this.road;
    const i0 = road.index(info.startS);
    const i1 = road.index(info.endS);
    const S = road.samples;

    const B: Record<string, GeoBuilder> = {
      road: new GeoBuilder(), sidewalk: new GeoBuilder(), line: new GeoBuilder(), lineY: new GeoBuilder(),
      barrier: new GeoBuilder(), strip: new GeoBuilder(), pole: new GeoBuilder(), lamp: new GeoBuilder(),
      pool: new GeoBuilder(), building: new GeoBuilder(), roof: new GeoBuilder(), sign: new GeoBuilder(),
      container: new GeoBuilder(true), water: new GeoBuilder(), glow: new GeoBuilder(true), tunnel: new GeoBuilder(),
      stripe: new GeoBuilder(), deck: new GeoBuilder(),
      mark1: new GeoBuilder(), mark2: new GeoBuilder(), mark3: new GeoBuilder(), mark4: new GeoBuilder(),
      chev1: new GeoBuilder(), chev2: new GeoBuilder(), chev3: new GeoBuilder(), chev4: new GeoBuilder(),
      median: new GeoBuilder(), cushion: new GeoBuilder(), board: new GeoBuilder(),
      facadeO: new GeoBuilder(), facadeR: new GeoBuilder(), facadeI: new GeoBuilder(), shop: new GeoBuilder(), ad: new GeoBuilder(),
      fence: new GeoBuilder(), decal: new GeoBuilder(), roadsign: new GeoBuilder(), glass: new GeoBuilder(), concrete: new GeoBuilder(),
      paint: new GeoBuilder(true), monolith: new GeoBuilder(), cable: new GeoBuilder(), bark: new GeoBuilder(), leaf: new GeoBuilder(), rust: new GeoBuilder(), lineWorn: new GeoBuilder(),
      kit: new GeoBuilder(true),
    };

    const right = (h: number): [number, number] => [-Math.cos(h), Math.sin(h)];
    const P = (i: number, d: number, y = 0): [number, number, number] => {
      const p = S[Math.max(0, Math.min(i, S.length - 1))];
      const r = right(p.heading);
      return [p.x + r[0] * d, p.y + y, p.z + r[1] * d];
    };
    const PW = (i: number, d: number, y: number): [number, number, number] => {
      const p = S[Math.max(0, Math.min(i, S.length - 1))];
      const r = right(p.heading);
      return [p.x + r[0] * d, y, p.z + r[1] * d];
    };
    const up: [number, number, number] = [0, 1, 0];
    const elevated = z.elevated;

    // --- road surface, sidewalks, edges
    for (let i = i0; i < i1; i++) {
      if (i > i0 && (i - i0) % 48 === 0) yield 'surface';
      const a = S[i], b = S[i + 1];
      if (a.gap || b.gap) continue;
      const wa = a.width / 2, wb = b.width / 2;
      const sa = road.startS + i, sb = sa + 1;
      B.road.quad(P(i, -wa - 0.3), P(i, wa + 0.3), P(i + 1, wb + 0.3), P(i + 1, -wb - 0.3), up,
        [(-wa - 0.3) / 12, sa / 12, (wa + 0.3) / 12, sa / 12, (wb + 0.3) / 12, sb / 12, (-wb - 0.3) / 12, sb / 12]);
      if (!elevated && !a.tunnel && !info.bridge) {
        for (const side of [-1, 1]) {
          B.sidewalk.quad(P(i, side * (wa + 0.6), 0.14), P(i, side * (wa + 6), 0.14), P(i + 1, side * (wb + 6), 0.14), P(i + 1, side * (wb + 0.6), 0.14), up);
        }
      }
      // ramp face chevrons
      if (a.y > 0.05 || b.y > 0.05) {
        B.stripe.quad(P(i, -wa, 0.02), P(i, wa, 0.02), P(i + 1, wb, 0.02), P(i + 1, -wb, 0.02), up, [0, 0, wa, 0, wb, 1, 0, 1]);
        if (a.y > b.y + 0.5) {
          // lip: vertical face
          for (const side of [-1, 1]) void side;
          B.deck.quad(P(i, -wa), P(i, wa), PW(i, wa, 0), PW(i, -wa, 0), [Math.sin(a.heading), 0, Math.cos(a.heading)]);
        }
        if (a.y > 0.05) {
          for (const side of [-1, 1]) B.deck.quad(P(i, side * wa), P(i + 1, side * wb), PW(i + 1, side * wb, 0), PW(i, side * wa, 0), [side * right(a.heading)[0], 0, side * right(a.heading)[1]]);
        }
      }
      // elevated deck skirt
      if (elevated || info.bridge) {
        for (const side of [-1, 1]) {
          const r = right(a.heading);
          B.deck.quad(P(i, side * (wa + 0.6)), P(i + 1, side * (wb + 0.6)), PW(i + 1, side * (wb + 0.6), -2.2), PW(i, side * (wa + 0.6), -2.2), [side * r[0], 0, side * r[1]]);
        }
        B.deck.quad(PW(i, -wa - 0.6, -2.2), PW(i, wa + 0.6, -2.2), PW(i + 1, wb + 0.6, -2.2), PW(i + 1, -wb - 0.6, -2.2), [0, -1, 0]);
      }
    }

    yield 'lines';
    // --- lane lines (with the marking language: hazard / reward / shortcut / danger corridors)
    const lineQuad = (b: GeoBuilder, sA: number, sB: number, d: number, hw: number) => {
      const ia = road.index(sA), ib = road.index(sB);
      for (let i = ia; i < ib; i++) {
        if (S[i].gap || S[i + 1]?.gap) continue;
        b.quad(P(i, d - hw, 0.025), P(i, d + hw, 0.025), P(i + 1, d + hw, 0.025), P(i + 1, d - hw, 0.025), up);
      }
    };
    const markB = (m: number) => (m > 0 ? B['mark' + m] : null);
    {
      for (let s = info.startS; s < info.endS - 3; s += 9) {
        const sm = road.sample(s);
        const ww = sm.width;
        const n = lanesFor(ww);
        for (let k = 1; k < n; k++) {
          const d = -ww / 2 + (ww / n) * k;
          if (sm.median > 0 && Math.abs(d - sm.medianD) < sm.median / 2 + 0.6) continue;
          // a used road: dashes are not all the same length and some are worn half away
          const hsh = Math.sin(s * 12.9898 + k * 78.233) * 43758.5453;
          const fr = hsh - Math.floor(hsh);
          lineQuad(fr < 0.22 ? B.lineWorn : B.line, s, Math.min(s + 3.1 + fr * 0.8, info.endS), d, 0.08);
        }
      }
      for (let s = info.startS; s < info.endS; s += 6) {
        const e = Math.min(s + 6, info.endS);
        const sm = road.sample(s);
        const ww = sm.width;
        const mL = markB(sm.markL), mR = markB(sm.markR);
        lineQuad(mL ?? B.lineY, s, e, -ww / 2 + 0.35, mL ? 0.14 : 0.09);
        lineQuad(mR ?? B.line, s, e, ww / 2 - 0.35, mR ? 0.14 : 0.09);
        if (sm.median > 0) {
          lineQuad(mL ?? B.line, s, e, sm.medianD - sm.median / 2 - 0.3, mL ? 0.14 : 0.09);
          lineQuad(mR ?? B.line, s, e, sm.medianD + sm.median / 2 + 0.3, mR ? 0.14 : 0.09);
        }
      }
      // painted chevrons down the centre of marked corridors
      for (let s = info.startS + 4; s < info.endS - 4; s += 11) {
        const sm = road.sample(s);
        const i = road.index(s);
        const corridors: [number, number, number][] = [];
        if (sm.median > 0) {
          corridors.push([sm.markL, (-sm.width / 2 + sm.medianD - sm.median / 2) / 2, sm.medianD - sm.median / 2 + sm.width / 2]);
          corridors.push([sm.markR, (sm.width / 2 + sm.medianD + sm.median / 2) / 2, sm.width / 2 - sm.medianD - sm.median / 2]);
        } else if (sm.markL > 0 || sm.markR > 0) {
          corridors.push([sm.markL || sm.markR, 0, sm.width]);
        }
        for (const [m, d, cw] of corridors) {
          if (m <= 0) continue;
          const hw = Math.min(1.6, cw * 0.3);
          B['chev' + m].quad(P(i, d - hw, 0.03), P(i, d + hw, 0.03), P(i + 4, d + hw, 0.03), P(i + 4, d - hw, 0.03), up, [0, 0, 1, 0, 1, 1, 0, 1]);
        }
      }
      // split medians: concrete divider with crash-cushion noses
      let inMedian = false;
      for (let i = i0; i < i1; i++) {
        const a = S[i], b2 = S[i + 1];
        if (a.median <= 0 || b2.median <= 0) {
          inMedian = false;
          continue;
        }
        const r = right(a.heading);
        const ha = a.median / 2, hb = b2.median / 2;
        const h = 0.85;
        for (const side of [-1, 1]) {
          B.median.quad(P(i, a.medianD + side * ha), P(i + 1, b2.medianD + side * hb), P(i + 1, b2.medianD + side * hb, h), P(i, a.medianD + side * ha, h), [side * r[0], 0, side * r[1]]);
        }
        B.median.quad(P(i, a.medianD - ha, h), P(i, a.medianD + ha, h), P(i + 1, b2.medianD + hb, h), P(i + 1, b2.medianD - hb, h), up);
        if (i % 2 === 0) B.strip.quad(P(i, a.medianD - ha * 0.6, h + 0.01), P(i, a.medianD + ha * 0.6, h + 0.01), P(i + 1, b2.medianD + hb * 0.6, h + 0.01), P(i + 1, b2.medianD - hb * 0.6, h + 0.01), up);
        if (!inMedian) {
          const p = P(i, a.medianD, 0.6);
          B.cushion.box(p[0], p[1], p[2], 1.4, 1.2, 1.6, a.heading, 1, 1, 0, 0, undefined, true, false);
          const g = P(i, a.medianD, 2.6);
          B.glow.box(g[0], g[1], g[2], 0.5, 0.5, 0.5, a.heading, 0, 0, 0, 0, glow(0xffa010, EMISSIVE.MEDIUM), false, false);
        }
        inMedian = true;
      }
    }

    yield 'boards, tunnel';
    // --- chevron boards on the outside of sharp corners: read the turn from far away
    if (info.type === 'TURN_SHARP' || info.type === 'CHICANE') {
      for (let s = info.startS + 8; s < info.endS - 6; s += 9) {
        const a = road.sample(s), b2 = road.sample(s + 2);
        let dh = b2.heading - a.heading;
        if (dh > Math.PI) dh -= Math.PI * 2;
        if (dh < -Math.PI) dh += Math.PI * 2;
        if (Math.abs(dh) < 0.02) continue;
        const outer = dh > 0 ? 1 : -1; // turning left -> outside is the right
        const i = road.index(s);
        const r = right(a.heading);
        const f: [number, number] = [Math.sin(a.heading), Math.cos(a.heading)];
        const c = P(i, outer * (a.width / 2 + 0.7), 1.5);
        const hw = 0.75;
        const flip = outer > 0 ? 1 : 0;
        B.board.quad(
          [c[0] - r[0] * hw, c[1] - 0.55, c[2] - r[1] * hw],
          [c[0] + r[0] * hw, c[1] - 0.55, c[2] + r[1] * hw],
          [c[0] + r[0] * hw, c[1] + 0.55, c[2] + r[1] * hw],
          [c[0] - r[0] * hw, c[1] + 0.55, c[2] - r[1] * hw],
          [-f[0], 0, -f[1]],
          flip ? [1, 0, 0, 0, 0, 1, 1, 1] : [0, 0, 1, 0, 1, 1, 0, 1],
        );
      }
    }

    const beams: THREE.BufferGeometry[] = [];
    // --- tunnel architecture: portals at the mouths, ribs every 12 m (jet fans on every other), wall furniture
    for (let i = i0; i < i1; i++) {
      const a = S[i];
      if (!a.tunnel || a.gap) continue;
      const ww = a.width;
      if (!S[i - 1]?.tunnel) B.kit.add(portal(ww), place(a.x, a.y, a.z, a.heading + Math.PI));
      if (!S[i + 1]?.tunnel) B.kit.add(portal(ww), place(a.x, a.y, a.z, a.heading));
      const sAbs = road.startS + i;
      if (sAbs % 12 === 0) B.kit.add(rib(ww, sAbs % 24 === 0), place(a.x, a.y, a.z, a.heading));
      if (sAbs % 10 === 5) B.kit.add(tunnelWall(ww, sAbs % 50 === 5), place(a.x, a.y, a.z, a.heading));
    }

    yield 'barriers';
    // --- barriers / tunnel walls
    for (let i = i0; i < i1; i++) {
      const a = S[i], b = S[i + 1];
      if (a.gap || b.gap) continue;
      const wa = a.width / 2 + 0.3, wb = b.width / 2 + 0.3;
      const hgt = elevated ? 0.75 : 0.9;
      if (a.tunnel) {
        const th = 7.5;
        for (const side of [-1, 1]) {
          const r = right(a.heading);
          B.tunnel.quad(P(i, side * (wa + 0.5)), P(i + 1, side * (wb + 0.5)), P(i + 1, side * (wb + 0.5), th), P(i, side * (wa + 0.5), th), [-side * r[0], 0, -side * r[1]]);
          if (i % 2 === 0) B.strip.quad(P(i, side * (wa + 0.45), 1.2), P(i + 1, side * (wb + 0.45), 1.2), P(i + 1, side * (wb + 0.45), 1.35), P(i, side * (wa + 0.45), 1.35), [-side * r[0], 0, -side * r[1]]);
        }
        B.tunnel.quad(P(i, -wa - 0.5, 7.5), P(i, wa + 0.5, 7.5), P(i + 1, wb + 0.5, 7.5), P(i + 1, -wb - 0.5, 7.5), [0, -1, 0]);
        if (i % 7 === 0) {
          for (const d of [-a.width / 4, a.width / 4]) B.lamp.quad(P(i, d - 0.6, 7.4), P(i, d + 0.6, 7.4), P(Math.min(i + 2, i1), d + 0.6, 7.4), P(Math.min(i + 2, i1), d - 0.6, 7.4), [0, -1, 0]);
        }
        // every other tunnel lamp throws a cone of light through the haze and a patch of light on the road;
        // every third pair feeds the real light pool, so cars passing under them are lit
        if (i % 14 === 0 && i + 1 < i1) {
          const f: [number, number] = [Math.sin(a.heading), Math.cos(a.heading)];
          const r = right(a.heading);
          for (const d of [-a.width / 4, a.width / 4]) {
            const h = P(i + 1, d, 7.35);
            beams.push(TUNNEL_BEAM.clone().translate(h[0], h[1], h[2]));
            const c = P(i + 1, d, 0.04), Rr = 2.8;
            B.pool.quad([c[0] - f[0] * Rr - r[0] * Rr, c[1], c[2] - f[1] * Rr - r[1] * Rr], [c[0] - f[0] * Rr + r[0] * Rr, c[1], c[2] - f[1] * Rr + r[1] * Rr], [c[0] + f[0] * Rr + r[0] * Rr, c[1], c[2] + f[1] * Rr + r[1] * Rr], [c[0] + f[0] * Rr - r[0] * Rr, c[1], c[2] + f[1] * Rr - r[1] * Rr], up, poolUv(road.startS + i + d));
          }
          if (i % 42 === 0) {
            const h = P(i + 1, 0, 6.8);
            seg.lamps.push({ x: h[0], y: h[1], z: h[2], s: road.startS + i });
          }
        }
      }
      for (const side of [-1, 1]) {
        const has = side < 0 ? a.barrierL : a.barrierR;
        if (!has) {
          if (i % 4 === 0) {
            const p = P(i, side * wa);
            B.glow.box(p[0], p[1] + 0.4, p[2], 0.2, 0.8, 0.2, a.heading, 0, 0, 0, 0, glow(0xff2810, EMISSIVE.MEDIUM));
          }
          continue;
        }
        const r = right(a.heading);
        const n: [number, number, number] = [-side * r[0], 0, -side * r[1]];
        B.barrier.quad(P(i, side * wa), P(i + 1, side * wb), P(i + 1, side * wb, hgt), P(i, side * wa, hgt), n);
        B.barrier.quad(P(i, side * wa, hgt), P(i + 1, side * wb, hgt), P(i + 1, side * (wb + 0.35), hgt), P(i, side * (wa + 0.35), hgt), up);
        B.barrier.quad(P(i, side * (wa + 0.35)), P(i + 1, side * (wb + 0.35)), P(i + 1, side * (wb + 0.35), hgt), P(i, side * (wa + 0.35), hgt), [-n[0], 0, -n[2]]);
        B.strip.quad(P(i, side * (wa - 0.01), hgt - 0.16), P(i + 1, side * (wb - 0.01), hgt - 0.16), P(i + 1, side * (wb - 0.01), hgt - 0.08), P(i, side * (wa - 0.01), hgt - 0.08), n);
      }
    }

    yield 'lamps';
    // --- street lights + light pools
    if (!info.tunnel) {
      const spacing = elevated ? 38 : 30;
      let side = rng.sign();
      for (let s = info.startS + rng.range(4, 16); s < info.endS - 2; s += spacing) {
        side = -side;
        const i = road.index(s);
        const smp = S[i];
        if (smp.gap) continue;
        const d = side * (smp.width / 2 + 1.0);
        const base = P(i, d);
        const r = right(smp.heading);
        const hgt = 8;
        B.kit.add(prop('lamp'), place(base[0], base[1], base[2], smp.heading + side * Math.PI / 2));
        const lp = P(i, d - side * 2.8, hgt - 0.15);
        seg.lamps.push({ x: lp[0], y: lp[1] - 0.6, z: lp[2], s });
        beams.push(LAMP_BEAM.clone().translate(lp[0], lp[1] - 0.1, lp[2]));
        const pc = P(i, side * (smp.width / 2 - 3.0), 0.04);
        // no two pools alike: size, orientation and mirroring vary with the lamp (hashed, not drawn from the seed)
        const R = 7.5 * (0.86 + 0.26 * hash01(s * 0.731));
        const f: [number, number] = [Math.sin(smp.heading), Math.cos(smp.heading)];
        B.pool.quad(
          [pc[0] - f[0] * R - r[0] * R, pc[1], pc[2] - f[1] * R - r[1] * R],
          [pc[0] - f[0] * R + r[0] * R, pc[1], pc[2] - f[1] * R + r[1] * R],
          [pc[0] + f[0] * R + r[0] * R, pc[1], pc[2] + f[1] * R + r[1] * R],
          [pc[0] + f[0] * R - r[0] * R, pc[1], pc[2] + f[1] * R - r[1] * R],
          up,
          poolUv(s),
        );
      }
    }

    // --- buildings & signs
    const signCells = SIGN_WORDS.length;
    const addSign = (cx: number, cy: number, cz: number, nx: number, nz: number, w: number, h: number, cell: number) => {
      // plane facing (nx, nz)
      const tx = -nz, tz = nx; // tangent
      const u0 = (cell % 4) / 4, u1 = u0 + 0.25;
      const row = Math.floor(cell / 4);
      const v1 = 1 - row / 5, v0 = 1 - (row + 1) / 5;
      B.sign.quad(
        [cx - tx * w / 2, cy - h / 2, cz - tz * w / 2],
        [cx + tx * w / 2, cy - h / 2, cz + tz * w / 2],
        [cx + tx * w / 2, cy + h / 2, cz + tz * w / 2],
        [cx - tx * w / 2, cy + h / 2, cz - tz * w / 2],
        [nx, 0, nz],
        [u1, v0, u0, v0, u0, v1, u1, v1],
      );
    };
    // environment art: buildings, roadside, crossings, road wear (scenery.ts)
    const smoke = new SmokeBatch();
    yield 'scenery';
    yield* buildScenery({ B, zone: z, info, road, S, i0, i1, group, anims: seg.anims, geos: seg.geos, lamps: seg.lamps, neonSign: addSign, signCells, mats: this.mats, finishS: this.finishS, smoke });
    yield 'water, type';
    const plume = smoke.build();
    if (plume) {
      group.add(plume);
      seg.geos.push(plume.geometry);
    }

    // --- ground water / bridge water
    if ((z.id === 'flood' || info.bridge) && !elevated) {
      for (let i = i0; i < i1; i += 4) {
        const j = Math.min(i + 4, i1);
        for (const side of [-1, 1]) {
          const a = S[i], b = S[j];
          B.water.quad(PW(i, side * (a.width / 2 + (info.bridge ? 0.8 : 6)), -0.35), PW(i, side * 90, -0.35), PW(j, side * 90, -0.35), PW(j, side * (b.width / 2 + (info.bridge ? 0.8 : 6)), -0.35), up);
        }
      }
    }

    // --- segment type specifics
    const addProp = (kind: PropKind, s: number, d: number) => {
      const p = this.makeProp(kind, s, d, rng);
      if (p) {
        group.add(p.mesh);
        seg.props.push(p);
        this.props.push(p);
      }
    };
    const dens = this.propDensity * (this.tutorial ? 0.3 : 1);
    const w = info.width;
    switch (info.type) {
      case 'INTERSECTION': {
        const i = road.index(info.crossS);
        const smp = S[i];
        const f: [number, number] = [Math.sin(smp.heading), Math.cos(smp.heading)];
        const r = right(smp.heading);
        // cross street surface
        const cw = 7, cl = 70;
        const c0 = [smp.x, smp.z];
        for (const side of [-1, 1]) {
          const a0 = smp.width / 2 + 0.6;
          B.road.quad(
            [c0[0] + r[0] * side * a0 - f[0] * cw, 0.01, c0[1] + r[1] * side * a0 - f[1] * cw],
            [c0[0] + r[0] * side * cl - f[0] * cw, 0.01, c0[1] + r[1] * side * cl - f[1] * cw],
            [c0[0] + r[0] * side * cl + f[0] * cw, 0.01, c0[1] + r[1] * side * cl + f[1] * cw],
            [c0[0] + r[0] * side * a0 + f[0] * cw, 0.01, c0[1] + r[1] * side * a0 + f[1] * cw],
            up,
            [0, 0, 5, 0, 5, 2, 0, 2],
          );
        }
        // crosswalk stripes
        for (const off of [-cw + 1.5, cw - 1.5]) {
          for (let d = -smp.width / 2 + 0.8; d < smp.width / 2 - 0.5; d += 1.6) {
            const ci = road.index(info.crossS + off);
            B.line.quad(P(ci, d, 0.03), P(ci, d + 0.8, 0.03), P(ci + 1, d + 0.8, 0.03), P(ci + 1, d, 0.03), up);
          }
        }
        // traffic lights
        for (const side of [-1, 1]) {
          const base = P(road.index(info.crossS - cw - 1), side * (smp.width / 2 + 1.2));
          // kit signal: pole, mast arm, two heads; the lit lens cycles (its lamps are unlit lenses in the kit)
          const yaw = smp.heading + side * Math.PI / 2;
          B.kit.add(prop('trafficLight'), place(base[0], base[1], base[2], yaw), undefined, { [Surf.TAIL]: Surf.RED });
          const mat = new THREE.MeshBasicMaterial({ color: 0xff2020 });
          seg.mats.push(mat);
          const lensGeo = new THREE.CylinderGeometry(0.11, 0.11, 0.03, 10).rotateX(Math.PI / 2);
          seg.geos.push(lensGeo);
          const fz: [number, number] = [Math.sin(smp.heading), Math.cos(smp.heading)];
          for (const z of [3.2, 5.0]) {
            const light = new THREE.Mesh(lensGeo, mat);
            light.position.set(base[0] - side * r[0] * z - fz[0] * 0.17, 5.45, base[2] - side * r[1] * z - fz[1] * 0.17);
            light.rotation.y = smp.heading + Math.PI;
            group.add(light);
          }
          seg.anims.push({ obj: group, kind: 'traffic', phase: rng.range(0, 3), mat });
        }
        break;
      }
      case 'PARKING_AREA': {
        for (let s = info.startS + 30; s < info.endS - 20; s += 7) {
          for (const side of [-1, 1]) if (rng.chance(0.7 * dens + 0.2)) addProp('parked', s, side * (w / 2 - 2.2));
        }
        for (let s = info.startS + 35; s < info.endS - 20; s += 22) addProp('pillar', s, rng.range(-2, 2));
        break;
      }
      case 'INDUSTRIAL_ZONE': {
        for (let s = info.startS + 12; s < info.endS - 8; s += rng.range(14, 26)) {
          const side = rng.sign();
          if (rng.chance(0.55)) {
            addProp('xbarrel', s, side * (w / 2 - 1.2));
            if (rng.chance(0.6)) addProp('xbarrel', s + 1.4, side * (w / 2 - 2.1));
          } else addProp('crate', s, side * (w / 2 - 1.3));
          if (rng.chance(0.25 * dens)) this.pendingHazards.push({ kind: 'oil', ...this.xz(s + 4, rng.range(-w / 3, w / 3)), r: rng.range(2.5, 4) });
        }
        // container stacks beyond barriers
        for (const side of [-1, 1]) {
          for (let s = info.startS + 5; s < info.endS; s += 14) {
            const i = road.index(s);
            const smp = S[i];
            const r = right(smp.heading);
            const dist = smp.width / 2 + 5;
            // thin the wall of containers without touching the segment rng (it also places the gameplay props)
            if ((i * 7919 + (side + 1) * 31) % 10 >= 7) continue;
            const stack = rng.int(1, 3);
            for (let k = 0; k < stack; k++) {
              const col = new THREE.Color().setHSL(rng.pick([0.02, 0.08, 0.55, 0.33, 0.6]), 0.6, 0.3);
              B.kit.add(prop('container'), place(smp.x + r[0] * side * dist, k * 2.6, smp.z + r[1] * side * dist, smp.heading + Math.PI / 2 + (k % 2) * 0.04), col);
            }
          }
        }
        break;
      }
      case 'HAZARD_ZONE': {
        const hz = z.hazard;
        const kind: HazardKind = hz === 'water' ? 'water' : hz === 'electric' ? 'electric' : hz === 'fire' ? 'fire' : hz === 'glitch' ? 'electric' : 'oil';
        const n = lanesFor(w);
        for (let s = info.startS + 20; s < info.endS - 15; s += rng.range(18, 30)) {
          const free = rng.int(0, n - 1);
          for (let l = 0; l < n; l++) {
            if (l === free || !rng.chance(0.55 * dens + 0.15)) continue;
            this.pendingHazards.push({ kind, ...this.xz(s, laneOffset(w, l)), r: hz === 'water' ? 4.5 : 2.6 });
          }
          if (hz === 'fire' && rng.chance(0.5)) addProp('xbarrel', s, rng.sign() * (w / 2 - 1));
        }
        // warning lights
        for (let s = info.startS; s < info.endS; s += 10) {
          const p = P(road.index(s), (s % 20 < 10 ? -1 : 1) * (S[road.index(s)].width / 2 + 0.5), 1.4);
          const m = new THREE.Mesh(PG.box, this.mats.lamp);
          m.scale.set(0.3, 0.3, 0.3);
          m.position.set(p[0], p[1], p[2]);
          group.add(m);
          seg.anims.push({ obj: m, kind: 'blink', phase: s * 0.3 });
        }
        break;
      }
      case 'JUMP': {
        const i = road.index(info.lipS);
        for (const side of [-1, 1]) {
          const p = P(i, side * (S[i].width / 2 + 0.4), 0.5);
          B.glow.box(p[0], p[1] + 1.5, p[2], 0.3, 3, 0.3, 0, 0, 0, 0, 0, glow(0x18d8ff, EMISSIVE.MEDIUM));
        }
        break;
      }
      case 'GAP_JUMP': {
        const gj = info.gapJump!;
        const i0g = road.index(gj.s0), i1g = road.index(gj.s1);
        const A = S[i0g], Bs = S[i1g];
        const deep = elevated ? -2.2 : -7.5;
        const halfA = A.width / 2 + (elevated ? 0.6 : 6), halfB = Bs.width / 2 + (elevated ? 0.6 : 6);
        // the broken ends: raw concrete faces dropping into the hole (the far one faces you)
        B.deck.quad(PW(i0g, -halfA, A.y), PW(i0g, halfA, A.y), PW(i0g, halfA, deep), PW(i0g, -halfA, deep), [Math.sin(A.heading), 0, Math.cos(A.heading)]);
        B.deck.quad(PW(i1g, halfB, 0), PW(i1g, -halfB, 0), PW(i1g, -halfB, deep), PW(i1g, halfB, deep), [-Math.sin(Bs.heading), 0, -Math.cos(Bs.heading)]);
        // hazard stripes along the landing edge so you can see where the road comes back
        B.stripe.quad(PW(i1g, -Bs.width / 2, 0.03), PW(i1g, Bs.width / 2, 0.03), PW(i1g + 2, Bs.width / 2, 0.03), PW(i1g + 2, -Bs.width / 2, 0.03), up, [0, 0, 6, 0, 6, 1, 0, 1]);
        // rebar and broken slabs hanging off both edges
        for (const ie of [i0g, i1g]) {
          const e = S[ie];
          for (let k = 0; k < 7; k++) {
            const d = rng.range(-e.width / 2, e.width / 2);
            const p = PW(ie, d, (ie === i0g ? A.y : 0) - rng.range(0.4, 1.6));
            B.deck.box(p[0] + Math.sin(e.heading) * (ie === i0g ? 0.6 : -0.6), p[1], p[2] + Math.cos(e.heading) * (ie === i0g ? 0.6 : -0.6), rng.range(0.6, 1.6), rng.range(0.4, 1.2), rng.range(0.8, 1.8), e.heading + rng.range(-0.5, 0.5));
          }
        }
        if (!elevated) {
          // a canal under the broken bridge: dark water and its walls
          for (let i = i0g; i < i1g; i += 3) {
            const j = Math.min(i + 3, i1g);
            B.water.quad(PW(i, -S[i].width / 2 - 40, deep + 1.2), PW(i, S[i].width / 2 + 40, deep + 1.2), PW(j, S[j].width / 2 + 40, deep + 1.2), PW(j, -S[j].width / 2 - 40, deep + 1.2), up);
          }
        }
        // lip posts (cyan: take off here) and landing posts (gold: land here); red warning lights on the edges
        for (const side of [-1, 1]) {
          const lp = P(road.index(gj.lipS), side * (A.width / 2 + 0.4), 0);
          B.glow.box(lp[0], lp[1] + 1.6, lp[2], 0.32, 3.2, 0.32, 0, 0, 0, 0, 0, glow(0x18d8ff, EMISSIVE.STRONG));
          const ld = P(i1g + 6, side * (Bs.width / 2 + 0.4), 0);
          B.glow.box(ld[0], ld[1] + 1.6, ld[2], 0.32, 3.2, 0.32, 0, 0, 0, 0, 0, glow(0xffc21a, EMISSIVE.STRONG));
          for (const ie of [i0g, i1g]) {
            const wp = PW(ie, side * (S[ie].width / 2 + 0.3), (ie === i0g ? A.y : 0) + 0.5);
            const m = new THREE.Mesh(PG.box, this.mats.lamp);
            m.scale.set(0.35, 0.35, 0.35);
            m.position.set(wp[0], wp[1], wp[2]);
            group.add(m);
            seg.anims.push({ obj: m, kind: 'blink', phase: side + ie });
          }
        }
        // landing marks: gold chevrons down the middle of the landing zone
        for (let s = gj.s1 + 6; s < Math.min(info.endS - 6, gj.s1 + 40); s += 9) {
          const i = road.index(s);
          for (const d of [-S[i].width / 4, S[i].width / 4]) B.chev2.quad(P(i, d - 1.4, 0.03), P(i, d + 1.4, 0.03), P(i + 4, d + 1.4, 0.03), P(i + 4, d - 1.4, 0.03), up, [0, 0, 1, 0, 1, 1, 0, 1]);
        }
        // run-up: cyan arrows say "full speed, straight"
        for (let s = info.startS + 8; s < gj.lipS - 26; s += 10) {
          const i = road.index(s);
          B.chev3.quad(P(i, -1.5, 0.03), P(i, 1.5, 0.03), P(i + 4, 1.5, 0.03), P(i + 4, -1.5, 0.03), up, [0, 0, 1, 0, 1, 1, 0, 1]);
        }
        break;
      }
      case 'BRIDGE': {
        // cable-stayed pylons straddling the road, parapet rails on the barriers, girders and piers under the deck
        const len = info.endS - info.startS;
        for (const t of len > 220 ? [0.3, 0.75] : [0.5]) {
          const i = road.index(info.startS + len * t);
          B.kit.add(pylon(S[i].width), place(S[i].x, S[i].y, S[i].z, S[i].heading));
        }
        for (let s = info.startS + 2.5; s < info.endS - 2; s += 5) {
          const i = road.index(s);
          for (const side of [-1, 1]) {
            const p = P(i, side * (S[i].width / 2 + 0.47));
            B.kit.add(parapet(), place(p[0], p[1], p[2], S[i].heading));
          }
        }
        for (let s = info.startS + 5; s < info.endS - 4; s += 10) {
          const i = road.index(s);
          B.kit.add(girders(S[i].width + 1.2), place(S[i].x, S[i].y, S[i].z, S[i].heading));
        }
        if (!elevated) for (let s = info.startS + 20; s < info.endS - 10; s += 40) {
          const i = road.index(s);
          B.kit.add(pier(10, S[i].width + 1.2), place(S[i].x, S[i].y, S[i].z, S[i].heading));
        }
        break;
      }
      case 'NARROW_STREET': {
        for (let s = info.startS + 15; s < info.endS - 10; s += rng.range(16, 30)) {
          const i = road.index(s);
          const smp = S[i];
          const r = right(smp.heading);
          // hanging banner over the road
          const c = P(i, rng.range(-2, 2), rng.range(6, 9));
          addSign(c[0], c[1], c[2], Math.sin(smp.heading) * -1, Math.cos(smp.heading) * -1, 4, 2, Math.floor(rng.range(0, signCells)));
          void r;
          if (rng.chance(0.5 * dens)) addProp(rng.pick(['trash', 'cone', 'sign'] as PropKind[]), s, rng.sign() * (smp.width / 2 - 0.7));
        }
        break;
      }
    }

    yield 'landmark, pillars';
    // --- zone landmark: one big silhouette every few segments, readable through the fog
    if (!info.tunnel && info.index % 5 === 2 && info.endS - info.startS > 70) this.buildLandmark(seg, B, rng, (info.startS + info.endS) / 2);

    // elevated: support pillars
    if (elevated) {
      for (let s = info.startS + 8; s < info.endS; s += 40) {
        const i = road.index(s);
        if (S[i].gap) continue;
        B.kit.add(pier(68, S[i].width + 1.2), place(S[i].x, S[i].y, S[i].z, S[i].heading));
      }
      if (info.type !== 'BRIDGE') for (let s = info.startS + 5; s < info.endS - 4; s += 10) {
        const i = road.index(s);
        if (S[i].gap || S[i].tunnel) continue;
        B.kit.add(girders(S[i].width + 1.2), place(S[i].x, S[i].y, S[i].z, S[i].heading));
      }
    }

    yield 'clutter';
    // --- general clutter & lane obstacles (never on a jump: the run-up and the landing must be clean)
    if (!info.tunnel && info.type !== 'PARKING_AREA' && info.type !== 'GAP_JUMP') {
      for (let s = info.startS + rng.range(8, 20); s < info.endS - 6; s += rng.range(18, 34)) {
        if (!rng.chance(0.65 * dens)) continue;
        const ww = road.sample(s).width;
        const side = rng.sign();
        const kind = rng.pick(['cone', 'cone', 'trash', 'sign', 'plastic', 'glass', 'barrel'] as PropKind[]);
        addProp(kind, s, side * (ww / 2 - 0.8));
        if (kind === 'cone' && rng.chance(0.5)) {
          // cone line closing a lane diagonally
          for (let k = 1; k < 5; k++) addProp('cone', s + k * 3, side * (ww / 2 - 0.8 - k * 0.9));
        }
      }
      // squeeze moments: heavy blocks in lanes leaving a gap
      // (only on free road: encounters and boss arenas place their own obstacles)
      const ambient = info.tag ? info.tag.role === 'rest' : !this.source;
      if (ambient && !this.tutorial && rng.chance(0.4 * dens) && info.type !== 'JUMP') {
        const s = rng.range(info.startS + 30, info.endS - 20);
        const ww = road.sample(s).width;
        const n = lanesFor(ww);
        const free = rng.int(0, n - 1);
        for (let l = 0; l < n; l++) if (l !== free) addProp(rng.chance(0.7) ? 'block' : 'plastic', s, laneOffset(ww, l));
      }
      // overhead gantry with distance marker
      if (rng.chance(0.18)) {
        const i = road.index(info.startS + 10);
        const smp = S[i];
        for (const side of [-1, 1]) {
          const p = P(i, side * (smp.width / 2 + 0.8));
          B.pole.box(p[0], 3.6, p[2], 0.35, 7.2, 0.35, smp.heading);
        }
        const c = P(i, 0, 7.2);
        B.pole.box(c[0], c[1], c[2], smp.width + 2, 0.4, 0.4, smp.heading);
        addSign(c[0], c[1] - 1.1, c[2], -Math.sin(smp.heading), -Math.cos(smp.heading), 5, 1.8, SIGN_WORDS.indexOf('MILE 0'));
      }
    }

    yield 'assemble';
    // --- assemble meshes
    for (const [key, b] of Object.entries(B)) {
      if (b.empty) continue;
      yield `build ${key}`;
      // the big merged meshes (the kit, buildings) are copied out one attribute per step
      const geo = b.vertices > 20000 ? yield* b.buildSteps() : b.build();
      seg.geos.push(geo);
      const mesh = new THREE.Mesh(geo, this.mats[key]);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      if (key === 'pool' || key === 'sign') mesh.renderOrder = 2;
      const dd = DETAIL_DIST[key];
      if (dd) seg.detail.push({ mesh, dist: dd });
      group.add(mesh);
    }
    if (beams.length) {
      const geo = mergeGeometries(beams);
      for (const b of beams) b.dispose();
      seg.geos.push(geo);
      const mesh = new THREE.Mesh(geo, this.lampBeamMat);
      mesh.matrixAutoUpdate = false;
      mesh.renderOrder = 6;
      group.add(mesh);
    }
    return seg;
  }

  private xz(s: number, d: number) {
    const o = { x: 0, y: 0, z: 0 };
    this.road.toWorld(s, d, o);
    return { x: o.x, z: o.z };
  }

  private makeProp(kind: PropKind, s: number, d: number, rng: Random): Prop | null {
    const o = { x: 0, y: 0, z: 0 };
    this.road.toWorld(s, d, o);
    const heading = this.road.at(s).heading;
    let mesh: THREE.Object3D;
    let r = 0.5, heavy = false, explosive = false;
    const M = this.propMats;
    switch (kind) {
      // kit models; the collision radii are the gameplay values and do not follow the models
      case 'cone': mesh = new THREE.Mesh(prop('cone'), M.cone); mesh.scale.setScalar(1.1); r = 0.4; break;
      case 'barrel': mesh = new THREE.Mesh(prop('drum'), M.barrel); mesh.scale.setScalar(1.2); r = 0.5; break;
      case 'xbarrel': mesh = new THREE.Mesh(prop('xdrum'), M.xbarrel); mesh.scale.setScalar(1.2); r = 0.5; explosive = true; break;
      case 'trash': mesh = new THREE.Mesh(prop('wheelieBin'), M.trash); r = 0.55; break;
      case 'crate': mesh = new THREE.Mesh(prop('crate'), M.kit); r = 0.75; break;
      case 'glass': {
        const g = new THREE.Group();
        g.add(new THREE.Mesh(prop('glassRack'), M.kit));
        const pane = new THREE.Mesh(PG.box, M.glass);
        pane.scale.set(2.1, 2.1, 0.03);
        pane.position.y = 0.16;
        g.add(pane);
        mesh = g;
        r = 1.0;
        break;
      }
      case 'plastic': mesh = new THREE.Mesh(prop('plasticBarrier'), M.kit); r = 1.0; break;
      case 'block': mesh = new THREE.Mesh(prop('block'), M.kit); r = 1.25; heavy = true; break;
      case 'pillar': mesh = new THREE.Mesh(prop('pillar'), M.kit); r = 0.75; heavy = true; break;
      case 'sign': mesh = new THREE.Mesh(prop('warnSign'), M.kit); r = 0.35; break;
      case 'parked': {
        const kind = rng.pick(['sedan', 'hatch', 'van'] as const);
        const color = new THREE.Color().setHSL(rng.next(), 0.3, 0.2).getHex();
        const holder = new THREE.Group();
        const build = () => {
          if (holder.userData.gone) return;
          const car = buildCar(kind, { color, accent: 0x000000, headlights: false });
          holder.add(car.group);
          holder.userData.dispose = car.dispose;
        };
        // a whole car model per parked car: one past its draw distance (an ambush street is lined with twenty) gets
        // its model in a later budget slot — the collision below is registered now either way
        if (s - this.lastPlayerS > PROP_DRAW_DIST) this.jobs.push(build);
        else build();
        mesh = holder;
        r = 1.15;
        heavy = true;
        break;
      }
      default:
        return null;
    }
    mesh.position.set(o.x, o.y, o.z);
    mesh.rotation.y = heading + (kind === 'parked' ? Math.PI / 2 * (d > 0 ? 1 : -1) * 0 : kind === 'sign' ? 0 : rng.range(-0.3, 0.3));
    if (kind === 'parked') mesh.rotation.y = heading + Math.PI / 2;
    return { kind, x: o.x, y: o.y, z: o.z, s, r, heavy, explosive, alive: true, flying: false, mesh, vx: 0, vy: 0, vz: 0, spin: 0, life: 0 };
  }

  /**
   * Stylized 3D road sign: an overhead gantry panel ("gantry") or a roadside board (side = -1 / 1).
   * Used by encounters to announce what is coming: ROADBLOCK, SHORTCUT, DANGER, BOSS...
   */
  addSign(s: number, text: string, color: number, where: 'gantry' | -1 | 1 = 'gantry', sub = '') {
    const seg = this.segments.find((g) => s >= g.info.startS && s < g.info.endS);
    if (!seg) return;
    const p = this.road.at(s);
    const r: [number, number] = [-Math.cos(p.heading), Math.sin(p.heading)];
    const tex = signTextTexture(text, color, sub);
    const mat = new THREE.MeshBasicMaterial({ map: tex, color: glow(0xffffff, EMISSIVE.MEDIUM * 0.9), transparent: true });
    seg.mats.push(mat);
    const w = where === 'gantry' ? Math.min(p.width * 0.75, 9) : 4.2;
    const h = w / 4;
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    seg.geos.push(panel.geometry);
    panel.rotation.y = p.heading + Math.PI;
    if (where === 'gantry') {
      panel.position.set(p.x, p.y + 6.2, p.z);
      for (const side of [-1, 1]) {
        const pole = new THREE.Mesh(PG.box, this.mats.pole);
        pole.scale.set(0.35, 7, 0.35);
        pole.position.set(p.x + r[0] * side * (p.width / 2 + 0.8), p.y, p.z + r[1] * side * (p.width / 2 + 0.8));
        seg.group.add(pole);
      }
      const beam = new THREE.Mesh(PG.box, this.mats.pole);
      beam.scale.set(p.width + 2, 0.35, 0.35);
      beam.position.set(p.x, p.y + 7, p.z);
      beam.rotation.y = p.heading;
      seg.group.add(beam);
    } else {
      const d = where * (p.width / 2 + 1.6);
      panel.position.set(p.x + r[0] * d, p.y + 2.4, p.z + r[1] * d);
      const pole = new THREE.Mesh(PG.box, this.mats.pole);
      pole.scale.set(0.2, 2, 0.2);
      pole.position.set(p.x + r[0] * d, p.y, p.z + r[1] * d);
      seg.group.add(pole);
    }
    seg.group.add(panel);
  }

  /** Spawn a prop at runtime (boss roadblocks, cargo drops). Attached to the segment that contains s. */
  spawnProp(kind: PropKind, s: number, d: number) {
    const seg = this.segments.find((g) => s >= g.info.startS && s < g.info.endS);
    if (!seg) return null;
    const p = this.makeProp(kind, s, d, this.rng);
    if (!p) return null;
    seg.group.add(p.mesh);
    seg.props.push(p);
    this.props.push(p);
    return p;
  }

  setFinish(s: number) {
    this.finishS = s;
    if (this.finishGroup) {
      this.root.remove(this.finishGroup);
      this.finishGroup = null;
      this.gateArms = [];
    }
    if (this.road.endS > s + 5) this.buildFinish();
  }

  /** floodlights over the arrival approach (fed to the street-lamp light pool) */
  private finishLamps: { x: number; y: number; z: number; s: number }[] = [];
  private gateChase: { mesh: THREE.InstancedMesh; n: number; color: THREE.Color } | null = null;

  /** Barrier arms of the arrival gate: they lift for a clean arrival and fly off when smashed. */
  gateArms: { pivot: THREE.Group; side: number; mode: 'closed' | 'open' | 'flying'; t: number; vel: THREE.Vector3; spin: number }[] = [];

  /**
   * The arrival gate: two concrete pylons with neon edges, a checkpoint sign facing the player, and two striped
   * barrier arms across the road. Where the level ends — and where the arrival sequence plays out.
   */
  private buildFinish() {
    const g = new THREE.Group();
    const s = this.finishS;
    const p = this.road.at(s);
    const zone = this.zone;
    const neon = new THREE.MeshBasicMaterial({ color: glow(zone.neon[0], EMISSIVE.STRONG) });
    const concrete = this.mats.tunnel;
    const r: [number, number] = [-Math.cos(p.heading), Math.sin(p.heading)];
    const half = p.width / 2 + 1.6;
    this.gateArms = [];
    for (const side of [-1, 1]) {
      const px = p.x + r[0] * side * half, pz = p.z + r[1] * side * half;
      const pylon = new THREE.Mesh(PG.box, concrete);
      pylon.scale.set(2.6, 16, 2.6);
      pylon.position.set(px, p.y, pz);
      pylon.rotation.y = p.heading;
      g.add(pylon);
      for (const e of [-1, 1]) {
        const edge = new THREE.Mesh(PG.box, neon);
        edge.scale.set(0.18, 15.6, 0.18);
        edge.position.set(px - r[0] * side * 1.32 + Math.sin(p.heading) * e * 1.32, p.y, pz - r[1] * side * 1.32 + Math.cos(p.heading) * e * 1.32);
        g.add(edge);
      }
      // barrier arm on a pivot at the pylon's inner face
      const pivot = new THREE.Group();
      pivot.position.set(p.x + r[0] * side * (half - 1.15), p.y + 1.25, p.z + r[1] * side * (half - 1.15));
      pivot.rotation.y = p.heading;
      const len = half - 1.15;
      const arm = new THREE.Mesh(PG.box, this.mats.stripe);
      arm.scale.set(len, 0.38, 0.3);
      arm.position.set(side * len / 2, -0.19, 0);
      pivot.add(arm);
      const tip = new THREE.Mesh(PG.box, neon);
      tip.scale.set(0.3, 0.42, 0.34);
      tip.position.set(side * (len - 0.15), -0.21, 0);
      pivot.add(tip);
      g.add(pivot);
      this.gateArms.push({ pivot, side, mode: 'closed', t: 0, vel: new THREE.Vector3(), spin: 0 });
    }
    // header with the checkpoint sign facing the oncoming player
    const beam = new THREE.Mesh(PG.box, concrete);
    beam.scale.set(half * 2 + 2.6, 4.6, 1.8);
    beam.position.set(p.x, p.y + 12.6, p.z);
    beam.rotation.y = p.heading;
    g.add(beam);
    const signMat = new THREE.MeshBasicMaterial({ map: signTextTexture(zone.name, zone.neon[0], 'CHECKPOINT'), color: glow(0xffffff, EMISSIVE.MEDIUM * 0.9), transparent: true });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(14, 3.5), signMat);
    sign.position.set(p.x - Math.sin(p.heading) * 0.95, p.y + 14.9, p.z - Math.cos(p.heading) * 0.95);
    sign.rotation.y = p.heading + Math.PI;
    g.add(sign);
    const strip = new THREE.Mesh(PG.box, neon);
    strip.scale.set(half * 2 + 2.6, 0.16, 0.16);
    strip.position.set(p.x - Math.sin(p.heading) * 0.92, p.y + 12.5, p.z - Math.cos(p.heading) * 0.92);
    // checkered bands across the header
    const checker = new THREE.MeshBasicMaterial({ map: checkerTexture(), color: glow(0xffffff, EMISSIVE.SUBTLE) });
    for (const y of [10.6, 12.0]) {
      const band = new THREE.Mesh(new THREE.PlaneGeometry(half * 2 + 2.4, 1.0), checker);
      (band.material as THREE.MeshBasicMaterial).map!.repeat.set((half * 2 + 2.4) / 1, 1);
      band.position.set(p.x - Math.sin(p.heading) * 0.95, p.y + y, p.z - Math.cos(p.heading) * 0.95);
      band.rotation.y = p.heading + Math.PI;
      g.add(band);
    }
    // stadium lights either side of the approach, and a runway of chase lights pulling you into the gate
    const fwd: [number, number] = [Math.sin(p.heading), Math.cos(p.heading)];
    this.finishLamps = [];
    const lampMat = new THREE.MeshBasicMaterial({ color: glow(0xfff4e0, EMISSIVE.STRONG) });
    for (const side of [-1, 1]) {
      for (const back of [12, 60]) {
        const mx = p.x + r[0] * side * (half + 5) - fwd[0] * back, mz = p.z + r[1] * side * (half + 5) - fwd[1] * back;
        const mast = new THREE.Mesh(PG.box, this.mats.pole);
        mast.scale.set(0.5, 20, 0.5);
        mast.position.set(mx, p.y, mz);
        g.add(mast);
        const head = new THREE.Mesh(PG.box, lampMat);
        head.scale.set(3.2, 1.4, 0.4);
        head.position.set(mx - r[0] * side * 0.8, p.y + 19.4, mz - r[1] * side * 0.8);
        head.rotation.y = p.heading + side * 0.6;
        g.add(head);
        this.finishLamps.push({ x: mx - r[0] * side * 4, y: p.y + 18, z: mz - r[1] * side * 4, s: s - back });
      }
    }
    const n = 18;
    const chase = new THREE.InstancedMesh(PG.box, new THREE.MeshBasicMaterial({ color: 0xffffff }), n * 2);
    const m4 = new THREE.Matrix4();
    for (let k = 0; k < n; k++) {
      for (const side of [-1, 1]) {
        const back = 8 + k * 7;
        const pp = this.road.at(s - back);
        const rr: [number, number] = [-Math.cos(pp.heading), Math.sin(pp.heading)];
        m4.compose(new THREE.Vector3(pp.x + rr[0] * side * (pp.width / 2 + 0.6), pp.y + 0.15, pp.z + rr[1] * side * (pp.width / 2 + 0.6)), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), pp.heading), new THREE.Vector3(0.45, 0.3, 0.45));
        chase.setMatrixAt(k * 2 + (side > 0 ? 1 : 0), m4);
        chase.setColorAt(k * 2 + (side > 0 ? 1 : 0), new THREE.Color(0, 0, 0));
      }
    }
    chase.instanceMatrix.needsUpdate = true;
    g.add(chase);
    this.gateChase = { mesh: chase, n, color: new THREE.Color(zone.neon[0]) };
    strip.rotation.y = p.heading;
    g.add(strip);
    // a painted line on the road so the moment of arrival is visible
    const line = new THREE.Mesh(PG.box, neon);
    line.scale.set(p.width, 0.03, 0.6);
    line.position.set(p.x, p.y + 0.02, p.z);
    line.rotation.y = p.heading;
    g.add(line);
    this.finishGroup = g;
    this.root.add(g);
  }

  /** Lift the gate arms (clean arrival). */
  openGate() {
    for (const a of this.gateArms) if (a.mode === 'closed') a.mode = 'open';
  }

  /** Smash the arms off: they fly forward and spin (high-speed arrival). */
  smashGate(vx: number, vz: number) {
    for (const a of this.gateArms) {
      if (a.mode === 'flying') continue;
      a.mode = 'flying';
      a.t = 0;
      a.vel.set(vx * 0.55 + (Math.random() - 0.5) * 4, 6 + Math.random() * 3, vz * 0.55 + (Math.random() - 0.5) * 4);
      a.spin = (Math.random() < 0.5 ? -1 : 1) * (5 + Math.random() * 5);
    }
  }

  private updateGate(dt: number) {
    // runway lights: a pulse running toward the gate, over and over
    const gc = this.finishGroup ? this.gateChase : null;
    if (gc) {
      const head = (this.time * 1.6) % 1;
      const c = new THREE.Color();
      for (let k = 0; k < gc.n; k++) {
        const ph = 1 - k / gc.n;
        const d = Math.abs(ph - head);
        const v = Math.max(0, 1 - Math.min(d, 1 - d) * 7);
        c.copy(gc.color).multiplyScalar(0.25 + v * 2.2);
        gc.mesh.setColorAt(k * 2, c);
        gc.mesh.setColorAt(k * 2 + 1, c);
      }
      if (gc.mesh.instanceColor) gc.mesh.instanceColor.needsUpdate = true;
    }
    for (const a of this.gateArms) {
      if (a.mode === 'open') a.pivot.rotation.z = damp(a.pivot.rotation.z, a.side * 1.4, 3.5, dt);
      else if (a.mode === 'flying') {
        a.t += dt;
        a.vel.y -= 20 * dt;
        a.pivot.position.addScaledVector(a.vel, dt);
        a.pivot.rotation.x += a.spin * dt;
        a.pivot.rotation.z += a.spin * 0.4 * dt;
        if (a.pivot.position.y < 0.2 && a.vel.y < 0) {
          a.vel.multiplyScalar(0.45);
          a.vel.y = Math.abs(a.vel.y) * 0.3;
          a.spin *= 0.6;
        }
        if (a.t > 4) a.pivot.visible = false;
      }
    }
  }


  dispose() {
    this.clear();
    this.scene.remove(this.root);
  }
}
