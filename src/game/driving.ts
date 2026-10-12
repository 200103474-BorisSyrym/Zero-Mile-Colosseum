import * as THREE from 'three';
import type { AudioEngine } from '../audio/audio';
import { createBoss, type BossController } from '../bosses/bosses';
import { Combat } from '../combat/combat';
import { COLLISION_MATERIALS, formatContact, type CollisionMaterialId, type CollisionSeverity } from '../core/collision';
import { CONFIG } from '../core/config';
import { HANDLING } from '../core/handling';
import { perf } from '../core/perf';
import { ABILITIES } from '../data/abilities';
import type { Input, InputState } from '../core/input';
import { clamp, damp, KMH, wrapAngle } from '../core/math';
import { Random, frand } from '../core/random';
import type { NodeMod } from '../data/events';
import { ENEMIES, TRAFFIC_KINDS, type EnemyKind, type TrafficKind } from '../data/enemies';
import { getItem, type ItemDef } from '../data/items';
import type { AbilityId, Tag } from '../data/types';
import type { BossId, ZoneDef } from '../data/zones';
import type { Effects } from '../effects/particles';
import { updateCarLights } from '../effects/carLights';
import { VfxLab } from '../effects/vfxLab';
import { beamGeometry, beamMaterial } from '../effects/lightBeams';
import { ADD_FRAME, poolTexture } from '../effects/vfxTextures';
import { AIVehicle, makeEnemy, makeTraffic, updateAlly, updateEnemy, updateRacer, updateTraffic } from '../enemies/ai';
import { TargetTag } from '../enemies/targetTag';
import { EncounterDirector } from '../encounters/director';
import type { EncounterId } from '../encounters/defs';
import { PlayerCar } from '../player/player';
import { bossPresenceLight, EMISSIVE, glow, LIGHTS, updateBossPresence } from '../render/visualBudget';
import type { Environment } from '../world/environment';
import { Telegraphs } from '../world/telegraph';
import { VisualLab } from '../world/visualLab';
import { laneOffset, lanesFor, type Prop, type World } from '../world/world';
import type { ChaseCamera } from './camera';
import { ChaosDirector } from './chaos';
import { ChaseSystem } from './chase';
import type { RunState } from './run';
import type { ArchetypeRes, ExplodeOpts, HazardKind, Sim, SimVehicle } from './simApi';

export type DriveMode = 'ROAD' | 'ELITE' | 'RACE' | 'SHORTCUT' | 'BOSS' | 'ATTRACT';

export interface DriveConfig {
  mode: DriveMode;
  zone: ZoneDef;
  seed: number;
  tutorial: boolean;
  mod: NodeMod | null;
  bossId?: BossId;
  /** debug: force a specific encounter list */
  forced?: EncounterId[];
  /** debug: the physics lab track (a fixed run of segments, no encounters) */
  lab?: boolean;
}

/**
 * Physics lab track: long straight, a hairpin-tight corner, a chicane, the ramp, a sweeper, the broken bridge,
 * an S, a tunnel (walls), a narrow street, an intersection, a hazard zone (oil / water), a wide lot, a bridge —
 * then the zone's own road. Wet road, trucks, traffic and enemies come from the debug panel.
 */
export const LAB_TRACK: import('../data/zones').SegmentType[] = [
  'STRAIGHT', 'STRAIGHT', 'TURN_SHARP', 'CHICANE', 'JUMP', 'CURVE', 'GAP_JUMP', 'S_CURVE', 'TUNNEL', 'NARROW_STREET',
  'INTERSECTION', 'HAZARD_ZONE', 'PARKING_AREA', 'BRIDGE', 'TURN_SHARP', 'JUMP', 'STRAIGHT',
];

export interface NodeResult {
  mode: DriveMode;
  encounters: number;
  won: number;
  avgSpeedKmh: number;
}

export interface HudApi {
  notify(text: string, color?: string, big?: boolean): void;
  popup(text: string, color?: string): void;
  hint(text: string, key: string): void;
  chain(n: number): void;
  skillCallout(key: string, name: string, pitch: string, color: string): void;
  skillFired(slot: 'q' | 'e'): void;
  nearMiss(n: number, tier: number): void;
  bossIntro(name: string, title: string): void;
  damageFrom(angle: number, amount: number): void;
  arrivalCard(title: string, sub: string, stats: [string, string][], color: string): void;
}

export interface SessionHost {
  hud: HudApi;
  onNodeComplete(r: NodeResult): void;
  onPlayerDestroyed(): void;
  onBossDefeated(): void;
  onShards(): void;
  unlockAchievement(id: string): void;
  tutorialFlags: Set<string>;
}

type PickupKind = 'credits' | 'gold' | 'fuel' | 'repair' | 'momentum' | 'boost' | 'shard';
interface Pickup {
  kind: PickupKind;
  x: number;
  y: number;
  z: number;
  s: number;
  value: number;
  mesh: THREE.Object3D;
  magnet: boolean;
  t: number;
  /** hangs in the air (on a jump line): collected only by a car that is up there */
  air?: boolean;
}

// Shared pickup visuals: distinct shapes and colours, with a light beam on the valuable ones.
const PKG: Record<PickupKind, THREE.BufferGeometry> = {
  credits: new THREE.OctahedronGeometry(0.42),
  gold: new THREE.OctahedronGeometry(0.62),
  fuel: new THREE.BoxGeometry(0.6, 0.8, 0.35),
  repair: new THREE.BoxGeometry(0.85, 0.3, 0.3),
  momentum: new THREE.IcosahedronGeometry(0.5, 0),
  boost: new THREE.ConeGeometry(0.4, 0.9, 4),
  shard: new THREE.TetrahedronGeometry(0.7),
};
const PKM: Record<PickupKind, THREE.MeshBasicMaterial> = {
  credits: new THREE.MeshBasicMaterial({ color: glow(0xffb820, EMISSIVE.MEDIUM) }),
  gold: new THREE.MeshBasicMaterial({ color: glow(0xffb818, EMISSIVE.STRONG) }),
  fuel: new THREE.MeshBasicMaterial({ color: glow(0x28ff58, EMISSIVE.STRONG) }),
  repair: new THREE.MeshBasicMaterial({ color: glow(0x30ff3a, EMISSIVE.STRONG) }),
  momentum: new THREE.MeshBasicMaterial({ color: glow(0xe828ff, EMISSIVE.STRONG) }),
  boost: new THREE.MeshBasicMaterial({ color: glow(0x20d8ff, EMISSIVE.STRONG) }),
  shard: new THREE.MeshBasicMaterial({ color: glow(0x9048ff, EMISSIVE.STRONG) }),
};
/** pure hues for the effects (the materials above are pre-brightened for bloom) */
const PK_HEX: Record<PickupKind, number> = { credits: 0xffb820, gold: 0xffc030, fuel: 0x40ff70, repair: 0x50ff50, momentum: 0xe040ff, boost: 0x30d8ff, shard: 0x9a60ff };
const PK_GLARE = {} as Record<PickupKind, THREE.Color>;
for (const k of Object.keys(PK_HEX) as PickupKind[]) PK_GLARE[k] = new THREE.Color(PK_HEX[k]);
// the valuable ones stand in a soft shaft of their own light: a fake-volumetric cone, edges hidden, fading upward
const SHAFT_GEO = beamGeometry(5.5, 0.2, 0.7, 12).rotateX(-Math.PI / 2).translate(0, -0.95, 0);
const SHAFT_MAT: Partial<Record<PickupKind, THREE.ShaderMaterial>> = {};
for (const k of ['gold', 'shard', 'repair', 'fuel'] as PickupKind[]) SHAFT_MAT[k] = beamMaterial(PK_HEX[k], 0.5, 1.3);
// each pickup throws a little of its own light on the road under it: an irregular pool, never a perfect disc
const POOL_GEO = new THREE.PlaneGeometry(2.8, 2.8).rotateX(-Math.PI / 2);
const POOL_MAT = {} as Record<PickupKind, THREE.MeshBasicMaterial>;
for (const k of Object.keys(PKM) as PickupKind[]) POOL_MAT[k] = new THREE.MeshBasicMaterial({ map: poolTexture(), color: new THREE.Color(PK_HEX[k]).multiplyScalar(0.42), transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false });
const PK_COLORS: Record<PickupKind, string> = { credits: '#ffd23a', gold: '#ffe066', fuel: '#58f0a0', repair: '#7dff7d', momentum: '#e05aff', boost: '#5af0ff', shard: '#b98bff' };

export interface Threat {
  angle: number;
  dist: number;
  attacking: boolean;
}

export class DrivingSession implements Sim {
  player!: PlayerCar;
  vehicles: AIVehicle[] = [];
  pickups: Pickup[] = [];
  combat: Combat;
  director: EncounterDirector;
  tele: Telegraphs;
  /** duels and out-run chasers (game/chase.ts) */
  chase: ChaseSystem;
  /** falling debris, wrong-way trucks, pile-ups between the fights (game/chaos.ts) */
  chaos: ChaosDirector;
  boss: BossController | null = null;
  /** debug: emissive/lighting test row (F1 → LAB) */
  lab: VisualLab;
  time = 0;
  config!: DriveConfig;
  items: ItemDef[] = [];
  rng = new Random(1);
  res: ArchetypeRes = { mass: 0, massMax: 5, velocity: 0, static: 0, phaseHits: 0 };
  // flow state
  combo = 0;
  comboTimer = 0;
  comboBank = 0;
  nmStreak = 0;
  nmTimer = 0;
  finished = false;
  /** last ~500 m of a road: the climax before the gate */
  finalPush = false;
  /** the arrival sequence after crossing the line (or beating a boss) — input is the arrival autopilot */
  arrival: { t: number; variant: 'drift' | 'smash' | 'limp' | 'victory'; side: number; result: boolean; done: boolean } | null = null;
  private nodeKills = 0;
  private nodeTopKmh = 0;
  dying = 0;
  /** the street-race rival is a real driver from this week's Shift board (iDos), when the street is online */
  rivalIdentity: { name: string; rank: number } | null = null;
  hitStopT = 0;
  slowT = 0;
  slowScale = 1;
  postEmp = 0;
  private lampGlareCol = new THREE.Color();
  private tunnelK = 0;
  /** debug: every effect on demand */
  vfxLab!: VfxLab;
  damageFlash = 0;
  godMode = false;
  tutorialEasy = false;
  style = { rams: 0, drift: 0, speed: 0, left: 0, right: 0 };
  difficulty = { enemyMul: 1, aggression: 1, hazard: 1 };
  difficultyDamage = 1;
  bossIntroT = 0;
  bossDefeatedT = 0;
  shardCount = 0;
  perfectWindow = -1;
  droneMark = false;
  encountersDone = 0;
  encountersWon = 0;
  threats: Threat[] = [];
  /** per skill slot: would using it help right now? (drives the PRESS Q / PRESS E prompt) */
  skillUseful = { q: false, e: false };
  private usefulT = { q: 0, e: 0 };
  private readyIdleT = { q: 0, e: 0 };
  private recalloutDone = { q: false, e: false };
  damageLog: { t: number; kind: string; amount: number }[] = [];
  private bossSpawned = false;
  private trafficT = 0;
  private speedSum = 0;
  private speedN = 0;
  private outOfFuelWarned = false;
  private lowHpT = 0;
  private synergyCache = new Set<string>();
  private tagCache: Partial<Record<Tag, number>> = {};
  private autopilotLane = 1;
  private nitroWas = false;
  private stuckHinted = false;
  private massDecayT = 0;
  private lastDriftEnd = -9;
  private gapJumpT = -9;
  private bossBlast = 0;
  /** worded markers over road hazards (anvils, falling debris) */
  private hazardTags: { kind: 'anvil' | 'debris'; tag: TargetTag; holder: THREE.Group; props: Prop[]; count: number; s: number; until: number }[] = [];
  private jointIdx = 0;
  private gapWarned = -1;
  private carriedCharge = 0;
  private drafting = false;
  private dHist: { t: number; d: number }[] = [];
  private threatBeepT = 0;
  private keyLight = new THREE.PointLight(0xdde6ff, LIGHTS.playerKey.intensity, LIGHTS.playerKey.distance, LIGHTS.playerKey.decay);
  private lampTmp: { x: number; y: number; z: number; s: number }[] = [];
  /** two headlamps where the model has them, each its own soft spot; and the glow of a lit exhaust on the road */
  private headLights = [0, 1].map(() => new THREE.SpotLight(0xfff2dd, LIGHTS.headlight.intensity * 0.6, LIGHTS.headlight.distance, LIGHTS.headlight.angle, LIGHTS.headlight.penumbra, LIGHTS.headlight.decay));
  private exhaustLight = new THREE.PointLight(0x60a0ff, 0, 9, 2);
  /** VFX-only per-car memory: previous speed (brake lights), previous lateral position (indicators) */
  private fxMemo = new WeakMap<object, { vF: number; d: number; brake: number; ind: number; indT: number }>();

  constructor(
    public scene: THREE.Scene,
    public world: World,
    public env: Environment,
    public fx: Effects,
    public audio: AudioEngine,
    public cam: ChaseCamera,
    public run: RunState | null,
    public host: SessionHost,
  ) {
    this.combat = new Combat(this);
    this.director = new EncounterDirector(this);
    this.tele = new Telegraphs(scene, () => this.world.road);
    this.chase = new ChaseSystem(this);
    this.chaos = new ChaosDirector(this);
    this.lab = new VisualLab(this);
    this.vfxLab = new VfxLab(this);
    // an energy pulse makes the street lamps around it cut out and stutter back
    fx.onPulse = (x, z, r) => env.stutterLamps(x, z, r);
    // lifting off at high revs: the pops you hear come out of the tailpipes as flame, on the same beat
    audio.onPops = (at) => {
      for (const t of at) fx.after(t, () => this.exhaustPop());
    };
    this.world.onSegment = (info) => this.director.onSegment(info);
    this.keyLight.position.set(0, 6, -0.5);
    // permanent, dark until a boss holds it: the scene's light count never changes (see applyBossPresence)
    scene.add(bossPresenceLight());
  }

  get zone() {
    return this.config.zone;
  }
  get mem() {
    return this.run?.mem ?? {};
  }
  get attract() {
    return this.config.mode === 'ATTRACT';
  }

  // ---------------------------------------------------------------- setup

  start(cfg: DriveConfig, player: PlayerCar, renderer: THREE.WebGLRenderer) {
    this.config = cfg;
    this.rng = new Random(cfg.seed);
    this.time = 0;
    this.finished = false;
    this.finalPush = false;
    this.arrival = null;
    this.gapWarned = -1;
    this.gapJumpT = -9;
    this.nodeKills = 0;
    this.nodeTopKmh = 0;
    this.cam.shot = null;
    this.cam.fovBoost = 0;
    this.dying = 0;
    this.combo = 0;
    this.comboBank = 0;
    this.nmStreak = 0;
    this.bossSpawned = false;
    this.boss = null;
    this.bossDefeatedT = 0;
    this.bossIntroT = 0;
    this.speedSum = this.speedN = 0;
    this.outOfFuelWarned = false;
    this.stuckHinted = false;
    this.encountersDone = this.encountersWon = 0;
    this.res = { mass: 0, massMax: 5, velocity: 0, static: 0, phaseHits: 0 };
    this.dHist = [];
    this.perfectWindow = -1;
    this.damageLog = [];
    this.threats.length = 0;
    this.clearVehicles();
    this.clearPickups();
    this.combat.reset();
    this.chase.reset();
    this.chaos.reset();
    this.clearHazardTags();
    this.tele.clear();
    this.lab.clear();
    this.fx.clear();
    this.refreshBuild();
    if (this.run) {
      const d = this.run.difficulty;
      this.difficulty = { enemyMul: d.enemyMul, aggression: d.aggression, hazard: d.hazard };
      this.difficultyDamage = (0.68 + cfg.zone.index * 0.08) * (1 + d.id * 0.15);
    }
    this.tutorialEasy = cfg.tutorial;
    this.env.setZone(cfg.zone, renderer);
    // smoke takes a little of the zone's light (sodium amber, flood teal…), lit by the city it hangs in
    this.fx.setAmbient(new THREE.Color(cfg.zone.streetLight).lerp(new THREE.Color(1, 1, 1), 0.55));

    // encounter-first: plan the node before the first road piece is generated
    if (cfg.mode === 'ATTRACT' || cfg.lab) {
      this.director.reset();
      this.world.source = null;
    } else if (cfg.mode === 'BOSS') {
      this.director.planBoss();
      this.boss = createBoss(cfg.bossId ?? cfg.zone.boss, this, this.run?.difficulty.id ?? 0);
      this.world.source = this.director;
    } else {
      this.director.plan(cfg.mode, cfg.zone.index, cfg.seed, { tutorial: cfg.tutorial, mod: cfg.mod, difficulty: this.run?.difficulty.id ?? 0, forced: cfg.forced });
      this.world.source = this.director;
    }
    this.world.reset(cfg.zone, cfg.seed, { forced: cfg.lab ? LAB_TRACK : ['STRAIGHT', 'CURVE'], tutorial: cfg.tutorial, propDensity: cfg.mode === 'ATTRACT' ? 0.6 : 0.8 });

    this.player = player;
    this.scene.add(player.model.group);
    player.model.group.add(this.keyLight, this.exhaustLight);
    // the headlamps sit in the lamps of this model, aimed down the road and a little outward
    const heads = [...player.model.anchors.heads].sort((a, b) => a[0] - b[0]);
    const hl = heads.length ? [heads[0], heads[heads.length - 1]] : [[-0.6, 0.7, 2], [0.6, 0.7, 2]];
    this.headLights.forEach((l, i) => {
      const h = hl[i];
      l.position.set(h[0], h[1], h[2]);
      l.target.position.set(h[0] * 2.2, 0, h[2] + 30);
      player.model.group.add(l, l.target);
    });
    const ex = player.model.anchors.exhausts[0];
    this.exhaustLight.position.set(0, (ex?.[1] ?? 0.4) + 0.1, (ex?.[2] ?? -player.model.length / 2) - 0.9);
    player.placeAt(this.world.road, 6, 0, cfg.mode === 'ATTRACT' ? 30 : CONFIG.PLAYER.START_SPEED);
    if (this.run) {
      player.hp = Math.min(this.run.hp, player.stats.maxHp);
      player.maxHp = player.stats.maxHp;
      player.fuel = this.run.fuel;
      player.momentum = this.run.momentum;
    }
    player.nitro = player.stats.nitroCapacity * (cfg.mod === 'tailwind' ? 1 : 0.6);
    // the first road starts with both skills charged: they get used in the first minute, not discovered at the boss
    if (cfg.tutorial) player.momentum = Math.max(player.momentum, 50);
    this.skillUseful = { q: false, e: false };
    this.usefulT = { q: 0, e: 0 };
    this.readyIdleT = { q: 0, e: 0 };
    this.recalloutDone = { q: false, e: false };
    player.heat = 0;
    player.phase = 0;
    player.systemsLock = 0;
    player.overheatLock = 0;
    this.cam.snap(player.pos.x, player.pos.y, player.pos.z, player.yaw);
    this.cam.cinematic = 0;
    this.cam.cinematicTarget = null;

    this.trafficT = 0;
    const tCount = cfg.mode === 'ATTRACT' ? 8 : 2;
    for (let i = 0; i < tCount; i++) this.spawnTraffic(60 + i * (300 / Math.max(1, tCount)));
    if (cfg.mod === 'fog') this.scene.fog = new THREE.FogExp2(cfg.zone.fog, cfg.zone.fogDensity * 2);
  }

  refreshBuild() {
    if (!this.run) {
      this.items = [];
      this.synergyCache.clear();
      this.tagCache = {};
      return;
    }
    this.items = this.run.items.map(getItem).filter((x): x is ItemDef => !!x);
    this.synergyCache = new Set(this.run.synergies().map((s) => s.id));
    this.tagCache = this.run.tagCounts();
    this.res.massMax = this.synergy('mass_increase') ? 8 : 5;
    if (this.player) {
      const st = this.run.computeStats();
      this.player.stats = st;
      this.player.maxHp = st.maxHp;
      this.player.hp = Math.min(this.player.hp, st.maxHp);
    }
  }

  /** Archetype resources are only meaningful when the build (or chassis) uses them. */
  usesRes(r: 'mass' | 'velocity' | 'static' | 'charge') {
    if (!this.run) return false;
    if (r === 'mass') return this.tagCount('RAM') > 0 || this.run.vehicle.id === 'rammer';
    if (r === 'velocity') return this.tagCount('SPEED') > 0;
    if (r === 'static') return this.tagCount('ELECTRIC') > 0;
    return this.tagCount('DRIFT') > 0;
  }

  // ---------------------------------------------------------------- spawning

  spawnTraffic(offsetS: number, kind?: TrafficKind) {
    const road = this.world.road;
    const s = this.player.s + offsetS;
    if (s > road.endS - 5 || s < this.world.minS + 2) return null;
    const w = road.at(s).width;
    const lane = this.rng.int(0, lanesFor(w) - 1);
    return this.spawnTrafficAt(s, laneOffset(w, lane), frand(14, 22), kind);
  }

  spawnTrafficAt(s: number, d: number, speed: number, kind?: TrafficKind) {
    const road = this.world.road;
    if (s > road.endS - 5 || s < this.world.minS + 2) return null;
    if (road.gapNear(s, 260, 5)) return null;
    d = this.world.safeD(s, d);
    for (const v of this.vehicles) if (!v.dead && Math.abs(v.s - s) < 7 && Math.abs(v.d - d) < 2.4) return null;
    const v = makeTraffic(kind ?? this.rng.pick(TRAFFIC_KINDS), this.zone.id === 'zeromile');
    v.place(road, s, d, speed);
    this.addVehicle(v);
    return v;
  }

  spawnEnemyAt(kind: EnemyKind, s: number, d: number, speed: number, elite = false, hpMul = 1): AIVehicle | null {
    const road = this.world.road;
    s = clamp(s, this.world.minS + 3, road.endS - 5);
    const enemyCount = this.vehicles.filter((v) => v.role === 'enemy' && !v.dead).length;
    if (enemyCount >= CONFIG.SPAWN.MAX_ENEMIES + (this.boss ? 3 : 0)) return null;
    const mul = (1 + this.zone.index * 0.18 + (this.run?.difficulty.id ?? 0) * 0.15) * hpMul;
    const v = makeEnemy(kind, mul, elite);
    const w = road.at(s).width;
    v.place(road, s, this.world.safeD(s, clamp(d, -w / 2 + 1.3, w / 2 - 1.3)), Math.max(0, speed));
    this.addVehicle(v);
    return v;
  }

  /** Debug / legacy convenience: an enemy relative to the player. */
  spawnEnemy(kind: EnemyKind, offsetS: number, elite = false): AIVehicle | null {
    const v = this.spawnEnemyAt(kind, this.player.s + offsetS, this.player.d, Math.max(12, this.player.vF * (offsetS > 0 ? 0.8 : 1.1)), elite);
    return v;
  }

  addVehicle(v: AIVehicle) {
    this.vehicles.push(v);
    this.scene.add(v.model.group);
  }

  /**
   * Put a worded marker ("ANVIL", "DEBRIS 90 m") over a hazard on the road. Drawn over everything and readable from
   * ~200 m, so nothing that can stop you appears out of nowhere. With a prop it lives as long as the prop.
   */
  markHazard(kind: 'anvil' | 'debris', x: number, z: number, s: number, prop: Prop | null, life = 60) {
    if (this.attract) return;
    // hazards side by side (two anvils, a double drop) share one label: "ANVIL x2"
    const near = this.hazardTags.find((h) => h.kind === kind && Math.abs(h.s - s) < 12 && h.until > this.time);
    if (near) {
      near.count++;
      if (prop) near.props.push(prop);
      near.holder.position.x = (near.holder.position.x * (near.count - 1) + x) / near.count;
      near.holder.position.z = (near.holder.position.z * (near.count - 1) + z) / near.count;
      near.until = Math.max(near.until, this.time + life);
      return;
    }
    const tag = new TargetTag();
    const holder = new THREE.Group();
    holder.position.set(x, this.world.road.at(s).y, z);
    holder.add(tag.sprite);
    this.scene.add(holder);
    this.hazardTags.push({ kind, tag, holder, props: prop ? [prop] : [], count: 1, s, until: this.time + life });
  }

  private updateHazardTags() {
    const p = this.player;
    for (let i = this.hazardTags.length - 1; i >= 0; i--) {
      const h = this.hazardTags[i];
      let alive = 0, sx = 0, sz = 0;
      for (const pr of h.props) {
        if (!pr.alive) continue;
        alive++;
        sx += pr.x;
        sz += pr.z;
      }
      const gone = h.props.length > 0 && alive === 0;
      if (gone || this.time > h.until || h.s < p.s - 8 || this.finished) {
        this.scene.remove(h.holder);
        h.tag.dispose();
        this.hazardTags.splice(i, 1);
        continue;
      }
      if (alive) {
        h.holder.position.x = sx / alive;
        h.holder.position.z = sz / alive;
      }
      const dist = Math.hypot(h.holder.position.x - p.pos.x, h.holder.position.z - p.pos.z);
      // close up it is in plain view: get the label out of the way
      h.tag.update(h.kind, 1, dist, 2.6, dist > 9 && dist < 230, h.props.length ? Math.max(1, alive) : h.count);
    }
  }

  private clearHazardTags() {
    for (const h of this.hazardTags) {
      this.scene.remove(h.holder);
      h.tag.dispose();
    }
    this.hazardTags = [];
  }

  /** A car went into a hole in the road. */
  private vehicleFell(v: AIVehicle) {
    if (!v.dead) {
      v.dead = true;
      v.hp = 0;
      v.deathTimer = 3;
      if (v.hostile && !v.isBoss) {
        this.onKill(v, 'fall', false);
        this.fx.explosion(v.pos.x, v.pos.y - 2, v.pos.z, 5, 0xff8a30);
        this.audio.explosion(0.7, this.relPan(v.pos.x, v.pos.z));
      }
    }
    if (v.pos.y < this.world.road.at(v.s).y - 28) this.removeVehicle(v);
  }

  /** Take a car out of the world (despawn). */
  removeVehicle(v: AIVehicle) {
    v.removed = true;
    this.scene.remove(v.model.group);
    v.model.dispose();
    v.disposeTag();
  }

  clearVehicles() {
    for (const v of this.vehicles) this.removeVehicle(v);
    this.vehicles = [];
  }

  placePickup(kind: PickupKind, s: number, d: number, value = 0, height = 0) {
    const o = { x: 0, y: 0, z: 0 };
    this.world.road.toWorld(s, d, o);
    o.y += height;
    const g = new THREE.Group();
    g.add(new THREE.Mesh(PKG[kind], PKM[kind]));
    const shaft = SHAFT_MAT[kind];
    if (shaft && height <= 0) g.add(new THREE.Mesh(SHAFT_GEO, shaft));
    if (height <= 0) {
      const pool = new THREE.Mesh(POOL_GEO, POOL_MAT[kind]);
      pool.position.y = -0.96;
      pool.rotation.y = Math.random() * Math.PI * 2;
      pool.scale.set(frand(0.85, 1.1), 1, frand(0.75, 1));
      pool.renderOrder = 2;
      g.add(pool);
    }
    g.position.set(o.x, o.y + 1, o.z);
    this.scene.add(g);
    this.pickups.push({ kind, x: o.x, y: o.y + 1, z: o.z, s, value: value || (kind === 'credits' ? 3 : kind === 'gold' ? 8 : 0), mesh: g, magnet: false, t: Math.random() * 6, air: height > 0 });
  }

  dropCredits(x: number, z: number, amount: number) {
    const n = Math.min(6, Math.max(1, Math.round(amount / 4)));
    for (let i = 0; i < n; i++) {
      const mesh = new THREE.Mesh(PKG.credits, PKM.credits);
      const px = x + frand(-1.5, 1.5), pz = z + frand(-1.5, 1.5);
      mesh.position.set(px, 1, pz);
      this.scene.add(mesh);
      this.pickups.push({ kind: 'credits', x: px, y: 1, z: pz, s: this.player.s, value: amount / n, mesh, magnet: true, t: 0 });
    }
  }

  /** Shader warm-up: pickups with their shafts and pools, the target tag, telegraphs and ground hazards. */
  warmObjects(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    for (const k of Object.keys(PKM) as PickupKind[]) out.push(new THREE.Mesh(PKG[k], PKM[k]), new THREE.Mesh(POOL_GEO, POOL_MAT[k]));
    for (const m of Object.values(SHAFT_MAT)) out.push(new THREE.Mesh(SHAFT_GEO, m));
    out.push(new TargetTag().sprite, ...this.tele.warmObjects(), ...this.combat.warmObjects());
    return out;
  }

  private clearPickups() {
    for (const p of this.pickups) this.scene.remove(p.mesh);
    this.pickups = [];
  }

  // ---------------------------------------------------------------- Sim API

  tagCount(t: Tag) {
    return this.tagCache[t] ?? 0;
  }
  hasItem(id: string) {
    return !!this.run && this.run.items.includes(id);
  }
  synergy(id: string) {
    return this.synergyCache.has(id);
  }
  damageVehicle(v: SimVehicle, amount: number, kind: Parameters<Sim['damageVehicle']>[2], opts?: { chainId?: number; byPlayer?: boolean }) {
    this.combat.damageVehicle(v as AIVehicle, amount, kind, opts);
  }
  explode(x: number, z: number, radius: number, damage: number, opts?: ExplodeOpts) {
    this.combat.explode(x, z, radius, damage, opts);
  }
  spawnHazard(kind: HazardKind, x: number, z: number, radius: number, life: number, dps = 0) {
    this.combat.addHazard(kind, x, z, radius, life, dps, true);
  }
  chainLightning(x: number, z: number, targets: number, damage: number, range?: number) {
    this.combat.chainLightning(x, z, targets, damage, range);
  }
  emp(x: number, z: number, radius: number, damage: number) {
    this.combat.emp(x, z, radius, damage);
  }
  shockwave(x: number, z: number, radius: number, force: number, damage: number) {
    this.combat.shockwave(x, z, radius, force, damage);
  }
  cannon(x: number, z: number, yaw: number, length: number, width: number, damage: number) {
    this.combat.cannon(x, z, yaw, length, width, damage);
  }
  missiles(count: number, damage: number) {
    this.combat.missiles(count, damage);
  }
  nearest(x: number, z: number, radius: number, n: number, includeTraffic = false): SimVehicle[] {
    const out: { v: AIVehicle; d: number }[] = [];
    for (const v of this.vehicles) {
      if (v.dead || v.removed || (!includeTraffic && !v.hostile)) continue;
      const d = Math.hypot(v.pos.x - x, v.pos.z - z);
      if (d < radius) out.push({ v, d });
    }
    return out.sort((a, b) => a.d - b.d).slice(0, n).map((o) => o.v);
  }
  addMomentum(n: number) {
    const p = this.player;
    if (n > 0) n *= p.stats.momentumGain * (1 + Math.min(this.combo, 30) * 0.02);
    p.momentum = clamp(p.momentum + n, 0, CONFIG.MOMENTUM.MAX);
  }
  addNitro(n: number) {
    this.player.nitro = clamp(this.player.nitro + n, 0, this.player.stats.nitroCapacity);
  }
  addFuel(n: number) {
    this.player.fuel = clamp(this.player.fuel + n, 0, CONFIG.FUEL.MAX);
    if (this.player.fuel > 0) this.outOfFuelWarned = false;
  }
  addCredits(n: number) {
    if (!this.run || n <= 0) return;
    const v = Math.round(n * this.player.stats.creditGain);
    this.run.credits += v;
    this.run.stats.creditsEarned += v;
  }
  addHeat(n: number) {
    this.player.heat = clamp(this.player.heat + n, 0, CONFIG.HEAT.MAX);
  }
  addMass(n: number) {
    if (!this.usesRes('mass')) return;
    const before = this.res.mass;
    this.res.mass = clamp(this.res.mass + n, 0, this.res.massMax);
    this.massDecayT = 3.2;
    if (Math.floor(this.res.mass) > Math.floor(before)) this.popup(`MASS ${Math.floor(this.res.mass)}`, '#ffb020');
  }
  addVelocity(n: number) {
    if (!this.usesRes('velocity')) return;
    this.res.velocity = clamp(this.res.velocity + n * (this.synergy('velocity') ? 1.5 : 1), 0, 100);
  }
  addStatic(n: number) {
    if (!this.usesRes('static')) return;
    const before = this.res.static;
    this.res.static = clamp(this.res.static + n, 0, 100);
    if (before < 100 && this.res.static >= 100) this.popup('STATIC CHARGED', '#5ad1ff');
  }
  boost(seconds: number) {
    this.player.boostTimer = Math.max(this.player.boostTimer, seconds);
  }
  heal(n: number) {
    const p = this.player;
    p.hp = Math.min(p.maxHp, p.hp + n);
  }
  setPhase(sec: number) {
    if (this.player.phase <= 0) this.res.phaseHits = 0;
    this.player.phase = Math.max(this.player.phase, sec * this.player.stats.phaseDuration);
    this.fx.pulse(this.player.pos.x, 0.3, this.player.pos.z, 3.5, 0xb9a6ff, 0.4);
  }
  notify(text: string, color = '#ffffff', big = false) {
    if (!this.attract) this.host.hud.notify(text, color, big);
  }
  popup(text: string, color = '#ffffff') {
    if (!this.attract) this.host.hud.popup(text, color);
  }
  hint(text: string, key: string) {
    if (this.attract || this.host.tutorialFlags.has(key)) return;
    this.host.tutorialFlags.add(key);
    this.host.hud.hint(text, key);
  }
  slowMo(duration: number, scale: number) {
    this.slowT = Math.max(this.slowT, duration);
    this.slowScale = Math.min(this.slowScale, scale);
  }
  pull(v: SimVehicle, x: number, z: number, strength: number) {
    const dx = x - v.pos.x, dz = z - v.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    v.velX += (dx / d) * strength;
    v.velZ += (dz / d) * strength;
  }
  sparks(x: number, y: number, z: number, n: number, color?: number) {
    this.fx.sparks(x, y, z, n, color);
  }
  hitStop(t: number) {
    if (!this.attract) this.hitStopT = Math.max(this.hitStopT, t);
  }
  /** Stereo pan for a world position relative to the player. */
  relPan(x: number, z: number) {
    const p = this.player;
    if (!p) return 0;
    const dx = x - p.pos.x, dz = z - p.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    return clamp((dx * -Math.cos(p.yaw) + dz * Math.sin(p.yaw)) / d, -1, 1) * 0.8;
  }
  /** Player lateral position some seconds ago (pursuers follow your old line). */
  pastD(delay: number) {
    const t = this.time - delay;
    for (let i = this.dHist.length - 1; i >= 0; i--) if (this.dHist[i].t <= t) return this.dHist[i].d;
    return this.dHist[0]?.d ?? this.player.d;
  }

  // ---------------------------------------------------------------- combo: risk/reward

  /**
   * Every stunt adds to the combo and to a credit BANK. The bank pays out when the chain ends on its own;
   * a crash wipes it. Long chains = big money, but only if you survive them.
   */
  addCombo(amount: number, _reason: string) {
    if (this.attract) return;
    const before = Math.floor(this.combo);
    this.combo = Math.min(CONFIG.COMBO.MAX, this.combo + amount);
    this.comboTimer = CONFIG.COMBO.DECAY_TIME;
    this.comboBank += amount * (1 + this.combo * 0.25) * (this.hasItem('gamblers_clutch') ? 1.6 : 1);
    if (Math.floor(this.combo) > before) this.audio.combo(Math.floor(this.combo));
    if (this.run) this.run.stats.bestCombo = Math.max(this.run.stats.bestCombo, Math.floor(this.combo));
  }

  addScore(base: number) {
    if (!this.run || this.attract) return;
    this.run.stats.score += Math.round(base * this.comboMult);
  }

  breakCombo(reason: string) {
    if (this.combo >= 3 && this.comboBank >= 15) this.popup(`${reason} — COMBO LOST`, '#ff6060');
    if (this.hasItem('gamblers_clutch') && this.comboBank > 10) this.combat.damagePlayer(5, 'drain');
    this.combo = 0;
    this.comboBank = 0;
  }

  private cashCombo() {
    const bank = Math.round(this.comboBank);
    if (bank >= 2) {
      this.addCredits(bank);
      if (bank >= 15) this.popup(`COMBO x${this.comboMult.toFixed(1)} CASHED`, '#ffd23a');
      for (const it of this.items) it.onComboCash?.(this, bank);
    }
    this.combo = 0;
    this.comboBank = 0;
  }

  get comboMult() {
    return 1 + Math.floor(this.combo) * CONFIG.COMBO.STEP;
  }

  // ---------------------------------------------------------------- callbacks from combat

  onKill(v: AIVehicle, kind: string, chained: boolean) {
    const run = this.run;
    if (v.isBoss) return;
    this.director.onKill(v, kind);
    if (!run) return;
    this.nodeKills++;
    run.stats.kills++;
    if (kind === 'ram' || kind === 'collision') run.stats.ramKills++;
    this.host.unlockAchievement('first_blood');
    if (run.stats.ramKills >= 10) this.host.unlockAchievement('juggernaut');
    this.addMomentum(CONFIG.MOMENTUM.KILL * (v.elite ? 2 : 1));
    this.addCombo(1.5, 'kill');
    this.dropCredits(v.pos.x, v.pos.z, v.credits * (chained ? 1.3 : 1));
    this.addScore(v.elite ? 400 : 120);
    const how = kind === 'wall' ? 'CRASHED' : kind === 'explosion' ? 'BLOWN UP' : kind === 'collision' ? 'PILED UP' : kind === 'fall' ? 'FELL' : 'WRECKED';
    this.popup(v.elite ? 'ELITE DOWN' : `${ENEMIES[v.kind as EnemyKind]?.name ?? 'ENEMY'} ${how}`, v.elite ? '#ffd000' : '#ff8a5a');
    for (const it of this.items) it.onKill?.(this, v, kind);
  }

  onChain(count: number) {
    this.host.hud.chain(count);
    this.addScore(150 * count);
    this.addMomentum(CONFIG.MOMENTUM.CHAIN);
    this.addCombo(1, 'chain');
    this.cam.addTrauma(0.2);
    if (this.run) this.run.stats.maxChain = Math.max(this.run.stats.maxChain, count);
    if (count >= 5) this.host.unlockAchievement('chain_reaction');
  }

  onPlayerRam(v: AIVehicle, impact: number, kind: string, perfect: boolean) {
    if (v.hostile) this.style.rams += 1;
    this.boss?.onRammed(v, kind, impact, perfect);
    if (this.config.tutorial && v.hostile) this.hint('DRIFT — HOLD SPACE WHILE TURNING', 'drift');
  }

  onPropSmash(_p: Prop) {
    this.addScore(10);
  }

  onBossDamaged(_amount: number, _kind: string) {}

  onPlayerDamaged(amount: number, kind: string, sx?: number, sz?: number) {
    // coalesce per-frame damage (fire, electric fields) into one entry per half second
    const last = this.damageLog[this.damageLog.length - 1];
    if (last && last.kind === kind && this.time - last.t < 0.5) last.amount += amount;
    else {
      if (this.damageLog.length > 120) this.damageLog.shift();
      this.damageLog.push({ t: this.time, kind, amount });
    }
    this.damageFlash = Math.min(1, this.damageFlash + amount / 30);
    if (this.run) this.run.stats.damageTaken += amount;
    if (sx !== undefined && sz !== undefined) {
      const p = this.player;
      const ang = wrapAngle(Math.atan2(sx - p.pos.x, sz - p.pos.z) - p.yaw);
      this.host.hud.damageFrom(ang, amount);
    }
    if (amount > 14 && kind !== 'drain') this.breakCombo('HEAVY HIT');
  }

  /** the paint under the soot, for a tow-truck comeback */
  private wreckPaint = 0;

  playerDestroyed() {
    if (this.dying > 0) return;
    const p = this.player;
    this.wreckPaint = p.model.bodyMat.color.getHex();
    this.dying = 1.6;
    p.hp = 0;
    this.fx.explosion(p.pos.x, p.pos.y, p.pos.z, 12, 0xff6020);
    this.fx.debrisBurst(p.pos.x, p.pos.y, p.pos.z, 40, p.model.bodyMat.color.getHex(), 14);
    this.fx.smokePuff(p.pos.x, p.pos.y, p.pos.z, 30, true, 1.5);
    this.audio.explosion(2);
    this.audio.setEngine(false);
    this.audio.defeat();
    this.cam.addTrauma(1);
    this.slowMo(1.2, 0.3);
    this.damageFlash = 1;
    p.model.bodyMat.color.setHex(0x111111);
  }

  collectShard() {
    this.shardCount++;
    this.notify(`ITEM SHARD ${this.shardCount}/3`, '#b98bff');
    if (this.shardCount >= 3) {
      this.shardCount = 0;
      this.host.onShards();
    }
  }

  // ---------------------------------------------------------------- main update

  update(rawDt: number, input: Input) {
    const dt0 = Math.min(rawDt, 1 / 30);
    if (this.hitStopT > 0) {
      this.hitStopT -= rawDt;
      this.updateCamera(rawDt);
      return;
    }
    let scale = 1;
    if (this.slowT > 0) {
      this.slowT -= rawDt;
      scale = this.slowScale;
      if (this.slowT <= 0) this.slowScale = 1;
    }
    if (this.bossIntroT > 0) scale = Math.min(scale, 0.35);
    const dt = dt0 * scale;
    this.time += dt;
    const p = this.player;
    const run = this.run;

    // ---- input
    const inp: InputState = this.attract ? this.autopilot(dt) : this.dying > 0 ? NO_INPUT : this.arrival ? this.arrivalInput() : this.finished ? NO_INPUT : input.state;
    if (inp === input.state) this.vfxLab.applyInput(inp);
    this.vfxLab.update(dt);
    if (!this.attract && this.dying <= 0 && !this.finished) {
      if (input.action('ability1') && run) this.fireSkill('q', run.vehicle.special);
      if (input.action('ability2') && run) this.fireSkill('e', run.module);
      if (input.action('reset') && p.stuckTime > CONFIG.PLAYER.STUCK_TIME) this.respawnPlayer(false);
    }
    if (!this.attract && this.synergy('time_pressure') && p.speed * KMH > 180) inp.brake = Math.min(1, inp.brake * 1.3);

    // ---- player physics with build modifiers
    this.applyDriveMods();
    p.wet = this.vfxLab.forceWet || this.zone.rain >= HANDLING.wetRain;
    perf.begin('player');
    if (this.dying <= 0) {
      p.update(dt, inp, this.world.road, this.world.minS);
      this.handlePlayerEvents();
    } else {
      p.velX *= Math.exp(-1.5 * dt);
      p.velZ *= Math.exp(-1.5 * dt);
      p.pos.x += p.velX * dt;
      p.pos.z += p.velZ * dt;
      p.model.group.position.copy(p.pos);
      p.model.group.rotation.y += dt * 0.6;
      if (Math.random() < 0.6) this.fx.fire(p.pos.x, p.pos.y + 1, p.pos.z, 2, 1.2);
      this.fx.smokePuff(p.pos.x, p.pos.y + 1, p.pos.z, 1, true);
      this.dying -= rawDt;
      if (this.dying <= 0) {
        this.dying = Infinity;
        this.host.onPlayerDestroyed();
      }
    }
    perf.end('player');
    this.dHist.push({ t: this.time, d: p.d });
    while (this.dHist.length > 2 && this.time - this.dHist[0].t > 2.5) this.dHist.shift();

    // ---- world streaming
    perf.begin('world');
    this.world.ensureAhead(p.s, CONFIG.WORLD.GEN_BUDGET_MS);
    this.world.trimBehind(p.s);
    this.world.update(dt);
    perf.end('world');
    for (const h of this.world.pendingHazards) this.combat.addHazard(h.kind, h.x, h.z, h.r, 9999, h.kind === 'fire' ? 18 : 10, false);
    this.world.pendingHazards.length = 0;

    // ---- resources & passive gains
    if (!this.attract && this.dying <= 0) {
      this.updateResources(dt);
      this.updateSkillPrompts(dt);
    }

    // ---- AI
    perf.begin('ai');
    const pressure = this.synergy('time_pressure') && p.speed * KMH > 180 ? 0.7 : 1;
    this.droneMark = this.vehicles.some((v) => v.kind === 'drone' && v.hostile && !v.dead && Math.abs(v.s - p.s) < 60);
    for (const v of this.vehicles) {
      if (v.removed) continue;
      const vdt = v.hostile ? dt * pressure : dt;
      if (!v.dead && v.stunT <= 0) {
        if (v.role === 'traffic') updateTraffic(v, vdt, this);
        else if (v.role === 'enemy') updateEnemy(v, vdt, this);
        else if (v.role === 'ally') updateAlly(v, vdt, this);
        else if (v.role === 'rival') updateRacer(v, vdt, this, 0.45 + this.zone.index * 0.12);
      }
      if (v.isBoss && this.boss && !v.dead) this.boss.update(vdt);
      const res = v.drive(vdt, this.world);
      if (v.fallen) this.vehicleFell(v);
      if (res.wall > 0) this.combat.wallDamage(v, res.wall);
      v.updateVisual(vdt);
      v.updateTag(Math.hypot(v.pos.x - p.pos.x, v.pos.z - p.pos.z), this.config.tutorial);
      if (v.dead) {
        v.deathTimer -= dt;
        // a wreck burns from the engine bay: flames licking out, black smoke going up
        const bx = v.pos.x + Math.sin(v.yaw) * v.length * 0.3, bz = v.pos.z + Math.cos(v.yaw) * v.length * 0.3;
        if (Math.random() < 0.35 * this.fx.density) this.fx.puff('burning', bx, v.pos.y + 1.2, bz, v.velX * 0.3, 0, v.velZ * 0.3, 0.9);
        if (Math.random() < 0.45) this.fx.fire(bx, v.pos.y + 0.7, bz, 1, 0.7);
      }
    }

    perf.end('ai');
    // ---- combat
    perf.begin('combat');
    this.combat.updateCollisions();
    this.combat.update(dt);
    if (!this.attract) this.combat.updateProjectiles(dt);
    this.combat.updateHazards(dt);
    this.tele.update(dt);

    perf.end('combat');
    // ---- near misses, encounters, population
    perf.begin('director');
    if (!this.attract && this.dying <= 0) {
      this.updateNearMiss(dt);
      this.director.update(dt);
      this.chase.update(dt);
      this.chaos.update(dt);
      this.updateThreats(dt);
    }
    this.updatePopulation(dt);
    this.updatePickups(dt);
    if (this.config.mode === 'BOSS') this.updateBossFlow(rawDt);
    perf.end('director');

    // ---- broken bridge ahead: one clear warning
    if (!this.attract && this.dying <= 0) {
      const g = this.world.road.gapNear(p.s, 170, 0);
      if (g && g.s0 > p.s && this.gapWarned !== g.s0) {
        this.gapWarned = g.s0;
        this.notify('BRIDGE OUT — FULL SPEED, JUMP IT', '#ff8a1a', true);
        this.audio.warning();
      }
    }

    // ---- final push → arrival → result → reward (never a hard stop into a menu)
    const fin = this.director.finishS;
    if (!this.attract && this.dying <= 0 && fin > 0) {
      if (!this.finalPush && fin - p.s < 480) this.beginFinalPush();
      // a clean approach gets the barrier lifted; arrive flat out and you go through it
      if (this.finalPush && fin - p.s < 60 && p.speed * KMH < 160) this.world.openGate();
      if (!this.finished && p.s >= fin) this.beginArrival();
    }
    if (this.arrival) this.updateArrival(rawDt);
    this.nodeTopKmh = Math.max(this.nodeTopKmh, p.speed * KMH);
    // the view opens up for the final stretch and while you are in the air
    const airWide = !p.grounded && p.airTime > 0.12 && !p.falling ? 8 : 0;
    this.cam.fovBoost = damp(this.cam.fovBoost, (this.finalPush && !this.arrival ? 5 : 0) + airWide, airWide ? 3 : 1.5, rawDt);

    // ---- effects, camera, audio
    perf.begin('vfx');
    this.updateVehicleFx();
    this.updateHazardTags();
    this.fx.update(dt);
    perf.end('vfx');
    perf.begin('camera');
    this.updateCamera(rawDt);
    perf.end('camera');
    perf.begin('lamps');
    this.env.setCameraYaw(Math.atan2(this.cam.camera.position.x - p.pos.x, this.cam.camera.position.z - p.pos.z) + Math.PI);
    this.env.placeLamps(this.world.lampsBetween(p.s - 30, p.s + 110, this.lampTmp), p.pos.x, p.pos.z);
    // the lamp heads themselves: a soft glare on each source (it stutters with the lights when a pulse hits)
    this.lampGlareCol.setHex(this.zone.streetLight);
    for (const l of this.lampTmp) this.fx.lampGlare(l.x, l.y + 0.5, l.z, this.lampGlareCol, 1.5, 0.3 * this.env.lampFlicker(l.x, l.z));
    // in a tunnel the air holds the headlight beams: they read thicker
    this.tunnelK = damp(this.tunnelK, this.world.road.sample(p.s)?.tunnel ? 1 : 0, 3, rawDt);
    const bm = p.model.beamVolume?.material as THREE.ShaderMaterial | undefined;
    if (bm) {
      bm.userData.base ??= bm.uniforms.intensity.value;
      bm.uniforms.intensity.value = bm.userData.base * (1 + 0.9 * this.tunnelK) * p.model.lights.head;
    }
    for (const l of this.headLights) l.intensity = LIGHTS.headlight.intensity * 0.6 * p.model.lights.head;
    updateBossPresence();
    perf.end('lamps');
    perf.begin('audio');
    this.postEmp = Math.max(0, this.postEmp - rawDt * 1.5);
    this.damageFlash = Math.max(0, this.damageFlash - rawDt * 3);
    const tyres = p.drifting ? clamp(Math.abs(p.driftAngle) * 2, 0.3, 1) : p.sliding ? 0.5 : p.braking && p.grounded && p.speed > 15 && inp.brake > 0 ? clamp(p.speed / 60, 0.2, 0.55) : 0;
    this.audio.updateEngine(p.speed, p.stats.maxSpeed, inp.accelerate, p.nitroActive, tyres, p.hp < p.maxHp * 0.3 ? 1 : 0, !p.grounded);
    this.updateAudioScene();
    perf.end('audio');

    if (run && this.dying <= 0) {
      run.hp = p.hp;
      run.fuel = p.fuel;
      run.momentum = p.momentum;
      run.stats.time += dt;
      run.stats.maxSpeed = Math.max(run.stats.maxSpeed, p.speed * KMH);
    }
  }

  /** Surfaces, bridges, the enemy closest to you, and what the music should be doing. */
  private updateAudioScene() {
    const p = this.player;
    const sm = this.world.road.sample(p.s);
    this.audio.setSurface({ wet: this.zone.rain > 0.4, tunnel: !!sm?.tunnel });
    const seg = this.world.segmentAt(p.s);
    const j = Math.floor(p.s / 14);
    if (seg?.bridge && p.grounded && j !== this.jointIdx && p.speed > 8) this.audio.joint();
    this.jointIdx = j;
    let best: AIVehicle | null = null, bd = 45;
    if (!this.attract && this.dying <= 0) {
      for (const v of this.vehicles) {
        if (!v.hostile || v.dead || v.removed) continue;
        const d = Math.hypot(v.pos.x - p.pos.x, v.pos.z - p.pos.z);
        if (d < bd) {
          bd = d;
          best = v;
        }
      }
    }
    if (best) this.audio.updateEnemy(bd, this.relPan(best.pos.x, best.pos.z), best.speed, best.boosting);
    else this.audio.updateEnemy(-1, 0, 0, false);
    this.audio.updateMusic();
  }

  private applyDriveMods() {
    const m = this.player.mods;
    m.massMul = 1 + this.res.mass * 0.12;
    m.perfectWiden = this.synergy('perfect_exit') ? 0.12 : 0;
    m.driftBoostMul = this.hasItem('kick_turn') ? 1.5 : 1;
    m.driftNoLoss = this.hasItem('infinite_angle');
    m.chargeMul = 1;
    m.topSpeedBonus = this.synergy('velocity') && this.res.velocity >= 99 ? 0.06 : 0;
    m.gripMul = 1;
  }

  private updateResources(dt: number) {
    const p = this.player;
    const st = p.stats;
    // MASS decays unless you keep hitting things
    if (this.res.mass > 0) {
      this.massDecayT -= dt;
      const hold = this.hasItem('deadweight') && p.speed * KMH > 120;
      if (this.massDecayT <= 0 && !hold) {
        this.res.mass = Math.max(0, this.res.mass - 1);
        this.massDecayT = this.synergy('mass_increase') ? 4 : 2.2;
      }
    }
    // VELOCITY: pace builds it, slowing down bleeds it
    if (this.usesRes('velocity')) {
      const kmh = p.speed * KMH;
      if (kmh > 170) this.addVelocity(10 * dt);
      else if (kmh < 130) this.res.velocity = Math.max(0, this.res.velocity - 22 * dt);
    }
    // drafting (slipstream) — anyone gets a little; SPEED builds get a lot
    this.drafting = false;
    if (p.speed > 20) {
      for (const v of this.vehicles) {
        if (v.dead || v.flying) continue;
        const ds = v.s - p.s;
        if (ds > 4 && ds < 16 && Math.abs(v.d - p.d) < 1.8) {
          this.drafting = true;
          break;
        }
      }
    }
    p.slipstream = this.drafting ? 1 : 0;
    if (this.drafting) {
      this.addVelocity((this.hasItem('slipstream_kit') ? 30 : 10) * dt);
      this.addMomentum(2 * dt);
      if (Math.random() < 0.5) this.fx.whoosh(p.pos.x + Math.sin(p.yaw) * 3, 0.9, p.pos.z + Math.cos(p.yaw) * 3, p.velX, p.velZ, 1, 0xa0d0ff, 0.6);
      this.mem.drafting = 1;
    } else if (this.mem.drafting) {
      this.mem.drafting = 0;
      if (this.hasItem('slipstream_kit')) {
        this.boost(1);
        this.popup('SLINGSHOT', '#5af0ff');
      }
    }
    // speed builds momentum a little; driving well builds it a lot
    if (p.speed > 25) this.addMomentum(CONFIG.MOMENTUM.SPEED_RATE * Math.pow(p.speed / st.maxSpeed, 2) * dt);
    if (p.drifting) {
      this.addMomentum(CONFIG.DRIFT.MOMENTUM_RATE * st.driftMomentum * (p.inPerfect ? 1.6 : 1) * dt);
      this.style.drift += dt;
      this.addCombo(0.4 * dt, 'drift');
      for (const it of this.items) it.onDriftTick?.(this, dt);
      if (p.driftTime > 5) this.host.unlockAchievement('neon_drift');
      if (this.synergy('slide_chain') && this.carriedCharge > 0) {
        p.driftCharge = Math.min(100, p.driftCharge + this.carriedCharge);
        this.carriedCharge = 0;
      }
    }
    this.style.speed += (p.speed / st.maxSpeed) * dt * 0.3;
    if (p.d > 1) this.style.right += dt;
    else if (p.d < -1) this.style.left += dt;
    // nitro hooks
    if (p.nitroActive) {
      if (!this.nitroWas) {
        this.audio.nitroStart();
        for (const it of this.items) it.onNitroStart?.(this);
      }
      for (const it of this.items) it.onNitroTick?.(this, dt);
    }
    this.nitroWas = p.nitroActive;
    for (const it of this.items) it.onUpdate?.(this, dt);
    if (st.regen > 0) this.heal(st.regen * dt);
    if (p.phase <= 0) this.res.phaseHits = 0;
    // combo decays; stopping kills it fast; ending on your own pays the bank
    if (this.combo > 0) {
      this.comboTimer -= dt * (p.speed < 6 ? 3 : 1);
      if (this.comboTimer <= 0) this.cashCombo();
    }
    // warnings
    if (p.fuel <= 0 && !this.outOfFuelWarned) {
      this.outOfFuelWarned = true;
      this.notify('OUT OF FUEL — FIND A CANISTER', '#ff8a3a', true);
    }
    this.lowHpT -= dt;
    if (p.hp < p.maxHp * 0.25 && this.lowHpT <= 0) {
      this.lowHpT = 3;
      this.audio.warning();
    }
    if (this.config.tutorial) {
      if (this.time > 0.5) this.hint('[W] GAS · [A] [D] STEER · [S] BRAKE', 'drive');
      if (this.time > 30) this.hint('[SHIFT] NITRO · BRAKE OR DRIFT [SPACE] INTO SHARP CORNERS', 'corner');
    }
    if (p.sliding && p.speed > 30) this.hint('TOO FAST FOR THIS CORNER — BRAKE OR DRIFT', 'understeer');
    if (p.stuckTime > CONFIG.PLAYER.STUCK_TIME && !this.stuckHinted) {
      this.stuckHinted = true;
      this.host.hud.hint('STUCK? PRESS R TO RESET', 'stuck_' + Math.floor(this.time));
    }
    if (p.stuckTime < 1) this.stuckHinted = false;
    if (this.run) this.run.stats.distance += Math.max(0, p.vF) * dt;
    this.speedSum += p.speed;
    this.speedN++;
  }

  private handlePlayerEvents() {
    const p = this.player;
    for (const e of p.events) {
      switch (e.type) {
        case 'driftStart':
          if (this.config.tutorial) this.hint('HOLD THE ANGLE IN THE PINK ZONE FOR A PERFECT DRIFT', 'drift2');
          if (this.synergy('slide_chain') && this.time - this.lastDriftEnd < 1) this.popup('CHAIN SLIDE', '#ff5ad0');
          break;
        case 'driftEnd': {
          this.lastDriftEnd = this.time;
          if (e.duration > 0.8) {
            const perfect = e.perfectExit && e.perfect > 0.4;
            this.addScore(Math.round(e.duration * 40 + e.perfect * 60));
            this.addCombo(perfect ? 1.5 : 0.75, 'drift');
            this.popup(perfect ? `PERFECT DRIFT ${e.duration.toFixed(1)}s` : `DRIFT ${e.duration.toFixed(1)}s`, perfect ? '#ff5ad0' : '#d0b0ff');
            if (perfect) this.addMomentum(CONFIG.DRIFT.PERFECT_MOMENTUM_BONUS + e.perfect * 3);
            this.director.onDrift(perfect);
            this.boss?.onDrift(e.duration, perfect);
            if (perfect && this.synergy('perfect_exit')) this.combat.shockwave(p.pos.x, p.pos.z, 9, 22, 18);
            if (this.synergy('slide_chain')) {
              this.carriedCharge = e.charge * 0.8;
              if (this.time - this.lastDriftEnd < 1.2 && e.charge > 40) this.combat.cannon(p.pos.x, p.pos.z, Math.atan2(p.velX, p.velZ), 22, 6, 25);
            }
            this.hint('DRIFT → MOMENTUM · SPEND IT ON Q / E', 'momentum');
          }
          const info = { duration: e.duration, perfect: e.perfect, charge: e.charge, perfectExit: e.perfectExit };
          for (const it of this.items) it.onDriftEnd?.(this, info);
          break;
        }
        case 'wall':
          this.onImpact(e.material, e.severity, e.impact, e.x, e.z, e.side);
          break;
        case 'scrape': {
          // a running scrape: sparks, rasp, a tiny vibration and a slow combo bleed — never a crash
          this.fx.sparks(e.x, 0.4, e.z, 1 + Math.round(e.intensity * 2.5), 0xffd090, 5, p.velX * 0.6, p.velZ * 0.6);
          if (Math.random() < 0.2) this.fx.dust(e.x, 0.25, e.z, 1, 0.3, p.velX, p.velZ);
          this.audio.curbScrape(e.intensity, this.relPan(e.x, e.z));
          this.cam.addTrauma(0.012);
          if (this.combo > 0) this.combo *= 1 - 0.006 * COLLISION_MATERIALS[e.material].comboMul;
          break;
        }
        case 'jump':
          if (this.world.road.gapNear(p.s, 3, 0)) {
            // the big one: a beat of slow motion over the hole
            this.gapJumpT = this.time;
            this.slowMo(0.5, 0.5);
            this.cam.addTrauma(0.12);
            this.audio.nitroStart();
          } else this.popup('AIRBORNE', '#5af0ff');
          this.addScore(50);
          this.addMomentum(CONFIG.MOMENTUM.JUMP);
          break;
        case 'land': {
          this.cam.land(e.impact);
          this.audio.impact(clamp(e.impact * 1.3, 5, 30), 0);
          if (e.grade === 'bad' || e.impact > 16) this.audio.heavyImpact();
          this.cam.addTrauma(clamp(e.impact / 40, 0.05, 0.4) * (e.good ? 0.6 : 1));
          this.fx.dust(p.pos.x, 0.25, p.pos.z, Math.round(2 + e.impact / 6), 1.2, p.velX, p.velZ);
          if (e.impact > 10) this.fx.sparks(p.pos.x, 0.2, p.pos.z, Math.round(e.impact * 0.8), 0xffd090, 6, p.velX * 0.6, p.velZ * 0.6);
          if (e.air > 1.5) this.host.unlockAchievement('airtime');
          if (this.time - this.gapJumpT < 4) {
            this.gapJumpT = -9;
            this.notify('CLEARED THE GAP', '#ffd23a', true);
            this.addScore(300);
            this.addMomentum(12);
            this.addCombo(1.5, 'stunt');
            this.hitStop(0.04);
            this.fx.sparks(p.pos.x, 0.2, p.pos.z, 24, 0xffd090, 9, p.velX * 0.6, p.velZ * 0.6);
          }
          if (e.grade === 'bad') this.popup('BAD LANDING', '#ff8060');
          if (e.perfect) {
            // stuck it: a burst of speed out of the landing
            this.popup('PERFECT LANDING', '#ffd23a');
            this.boost(1.1);
            this.addScore(250);
            this.addMomentum(CONFIG.MOMENTUM.PERFECT_LANDING * 1.5);
            this.addCombo(1.5, 'stunt');
          } else if (e.good && e.air > 0.35) {
            this.popup('CLEAN LANDING', '#5af0ff');
            this.addScore(150);
            this.addMomentum(CONFIG.MOMENTUM.PERFECT_LANDING);
            this.addCombo(1, 'stunt');
          }
          for (const it of this.items) it.onLanding?.(this, e.good);
          break;
        }
        case 'fall':
          this.respawnPlayer(true);
          break;
        case 'boostStart':
          // the shove: the view kicks back and widens, the exhaust roars
          this.cam.fovKick(4);
          this.cam.addTrauma(0.05);
          break;
        case 'save':
          // caught a slide after a hit: a quiet nod, a little momentum — not a popup storm
          this.popup('SAVED IT', '#7dffb0');
          this.addMomentum(4);
          this.addCombo(0.4, 'save');
          this.audio.nearMiss(1, 1);
          break;
        case 'rollScrape':
          // on its roof for an instant: sparks and the scrape of metal on asphalt
          this.fx.sparks(p.pos.x, 0.3, p.pos.z, 18, 0xffd090, 8, p.velX * 0.7, p.velZ * 0.7);
          this.audio.metal(0.9);
          this.audio.curbScrape(1, 0);
          break;
        case 'rollLand':
          this.fx.dust(p.pos.x, 0.3, p.pos.z, 6, 1.4, p.velX, p.velZ);
          this.audio.impact(22, 0);
          this.cam.land(10);
          this.cam.addTrauma(0.2);
          break;
        case 'autoReset':
          if (!this.finished && !this.arrival && !this.attract && this.dying <= 0) this.respawnPlayer(false);
          break;
        case 'unstick':
          break;
        case 'crash':
          // the roll plays out in slow motion: you see the hit, then you drive away from it
          this.slowMo(0.45, 0.4);
          this.cam.addTrauma(0.5);
          this.cam.fovKick(7);
          this.fx.impact(p.pos.x, 0.6, p.pos.z, p.velX, p.velZ, 1, 'metal', p.model.bodyMat.color.getHex());
          this.fx.glassBurst(p.pos.x, 1.1, p.pos.z, 12, p.velX * 0.3, p.velZ * 0.3);
          this.fx.dust(p.pos.x, 0.3, p.pos.z, 8, 1.6, p.velX, p.velZ);
          this.audio.metal(1);
          this.popup('ROLLED IT', '#ff8060');
          break;
        case 'overheat':
          this.overheat();
          break;
      }
    }
  }

  /**
   * Penalties for hitting something, by severity and material.
   * SCRAPE costs almost nothing; LIGHT a bit of combo; MEDIUM a real chunk of combo and a little hull;
   * HEAVY is a crash: the combo and its bank are lost, the hull takes a hit, the screen shakes.
   */
  onImpact(material: CollisionMaterialId, severity: CollisionSeverity, vN: number, x: number, z: number, side = 0) {
    const p = this.player;
    if (this.arrival) return;
    const mat = COLLISION_MATERIALS[material];
    const pan = this.relPan(x, z);
    const combo0 = this.combo;
    const hp0 = p.hp;
    const kickSide = side || Math.sign(pan) || 1;
    switch (severity) {
      case 'scrape':
        break;
      case 'light':
        this.fx.impact(x, 0.6, z, p.velX, p.velZ, 0.22, impactSurface(material), p.model.bodyMat.color.getHex());
        this.audio.curbScrape(0.9, pan);
        this.audio.impact(vN * 0.5, pan);
        this.cam.kick(kickSide, 0.06);
        this.cam.addTrauma(0.05);
        this.combo *= 1 - 0.15 * mat.comboMul;
        this.comboBank *= 1 - 0.08 * mat.comboMul;
        if (material !== 'curb') this.combat.damagePlayer(Math.min(2, vN * 0.15) * mat.damageMul, 'wall', x, z);
        break;
      case 'medium':
        this.fx.impact(x, 0.6, z, p.velX, p.velZ, 0.55, impactSurface(material), p.model.bodyMat.color.getHex());
        this.audio.impact(vN, pan);
        this.cam.kick(kickSide, 0.14);
        this.cam.addTrauma(0.14);
        this.combo *= 1 - 0.4 * mat.comboMul;
        this.comboBank *= 1 - 0.3 * mat.comboMul;
        this.combat.damagePlayer(Math.min(4, Math.max(0.5, (vN - 4) * 0.3)) * mat.damageMul, 'wall', x, z);
        this.popup(`SCRAPED ${mat.label}`, '#ffb060');
        this.boss?.onPlayerCrash();
        break;
      case 'heavy':
        this.fx.impact(x, 0.6, z, p.velX, p.velZ, 0.92, impactSurface(material), p.model.bodyMat.color.getHex());
        this.audio.heavyImpact();
        this.audio.impact(vN, pan);
        this.breakCombo('CRASH');
        this.boss?.onPlayerCrash();
        this.cam.addTrauma(0.45);
        this.cam.fovKick(5);
        p.bump(0.8);
        if (vN > 24 && p.speed * KMH > 60) p.crash(-kickSide);
        // walls cost speed, combo and the bank — some hull, never a run
        this.combat.damagePlayer(Math.min(11, Math.max(2, (vN - 8) * 0.45)) * mat.damageMul, 'wall', x, z);
        if (this.synergy('unstoppable')) this.addMass(1);
        break;
    }
    const rec = p.contactLog[p.contactLog.length - 1];
    if (rec && rec.combo === undefined) {
      rec.combo = this.combo - combo0;
      rec.hp = hp0 - p.hp;
      if (PlayerCar.debugContacts) console.info('[contact+]', formatContact(rec));
    }
  }

  // ---------------------------------------------------------------- final push & arrival

  /** The last stretch: louder, denser, a pursuit at your back — the run never ends on an empty road. */
  private beginFinalPush() {
    this.finalPush = true;
    const p = this.player;
    this.notify('FINAL STRETCH — REACH THE GATE', '#ffd23a', true);
    this.audio.musicIntensity = 1;
    this.audio.climax(true);
    // a last chase: two pursuers come up from behind
    if (this.config.mode !== 'BOSS') {
      const n = this.config.tutorial ? 1 : 2;
      for (let i = 0; i < n; i++) {
        const v = this.spawnEnemyAt(i === 0 ? 'interceptor' : 'rammer', p.s - 40 - i * 14, p.d + (i % 2 ? 2.5 : -2.5), p.vF + 8);
        if (v) v.task = { kind: 'pursue', gap: 6 + i * 4, delay: 0.5 };
      }
    }
  }

  /** Cross the line: pick how you arrive, frame it, take the wheel. */
  beginArrival(force?: 'victory') {
    if (this.arrival) return;
    const p = this.player;
    const kmh = p.speed * KMH;
    const gateClosed = this.world.gateArms.length > 0 && this.world.gateArms.every((a) => a.mode === 'closed');
    const variant = force ?? (gateClosed && kmh > 100 ? 'smash' : p.hp < p.maxHp * 0.3 ? 'limp' : 'drift');
    this.finished = true;
    this.arrival = { t: 0, variant, side: p.d >= 0 ? 1 : -1, result: false, done: false };
    if (this.comboBank > 0) this.cashCombo();
    // the fight is over: what's left breaks off
    for (const v of this.vehicles) if (v.role === 'enemy' && !v.dead) v.task = { kind: 'retreat' };
    // camera: a low vantage point ahead and across the road, looking back at the car as it arrives
    const road = this.world.road;
    const sA = p.s + 16 + p.speed * 0.5;
    const w = road.at(sA).width;
    const o = { x: 0, y: 0, z: 0 };
    road.toWorld(sA, -this.arrival.side * (w / 2 - 1.8), o);
    this.cam.shot = new THREE.Vector3(o.x, o.y + 1.6, o.z);
    this.cam.shotFov = 46;
    if (variant === 'smash') {
      this.world.smashGate(p.velX, p.velZ);
      this.hitStop(0.07);
      this.slowMo(0.6, 0.3);
      this.audio.heavyImpact();
      this.audio.explosion(1.2);
      this.cam.addTrauma(0.55);
      this.fx.debrisBurst(p.pos.x, 1.2, p.pos.z, 40, 0xffb020, 14);
      this.fx.sparks(p.pos.x, 1, p.pos.z, 50, 0xffd070, 14);
    } else if (variant === 'drift' || variant === 'victory') this.slowMo(0.45, 0.55);
    this.audio.arrival(variant);
  }

  /** Arrival autopilot: hold the line, then slide (or brake) to a stop. */
  private arrivalInput(): InputState {
    const a = this.arrival!;
    const p = this.player;
    const road = this.world.road;
    const L = road.at(p.s + 12);
    const tx = L.x, tz = L.z;
    const center = clamp(-wrapAngle(Math.atan2(tx - p.pos.x, tz - p.pos.z) - p.yaw) * 2.2, -1, 1);
    // stopped: let go of everything (holding the brake at a standstill would reverse the car)
    if (p.speed < 1.2 || (a.t > 0.6 && p.vF < 0.5)) return { accelerate: 0, brake: 0, steer: 0, handbrake: false, nitro: false };
    if (a.variant === 'drift' || a.variant === 'victory') {
      if (a.t < 0.2) return { accelerate: 0.6, brake: 0, steer: center, handbrake: false, nitro: false };
      if (p.speed > 7) return { accelerate: 0, brake: 0.3, steer: a.side, handbrake: true, nitro: false };
      return { accelerate: 0, brake: Math.min(1, p.vF / 4), steer: 0, handbrake: false, nitro: false };
    }
    if (a.variant === 'smash') return a.t < 0.45 ? { accelerate: 1, brake: 0, steer: center, handbrake: false, nitro: false } : { accelerate: 0, brake: 0.7, steer: center, handbrake: false, nitro: false };
    return { accelerate: a.t < 1 ? 0.3 : 0, brake: a.t < 1 ? 0 : 0.4, steer: center, handbrake: false, nitro: false };
  }

  private updateArrival(dt: number) {
    const a = this.arrival!;
    const p = this.player;
    a.t += dt;
    // a firm, readable stop — but never an instant one
    const k = a.variant === 'smash' ? (a.t > 0.45 ? 1.3 : 0) : a.variant === 'limp' ? 1.1 : a.t > 0.2 ? 1.25 : 0;
    const settle = p.speed < 3 ? 6 : 0;
    p.velX *= Math.exp(-(k + settle) * dt);
    p.velZ *= Math.exp(-(k + settle) * dt);
    if (a.variant === 'limp' && Math.random() < 0.5) {
      this.fx.sparks(p.pos.x, 0.5, p.pos.z, 2, 0xffc060, 4);
      this.fx.smokePuff(p.pos.x, p.pos.y + 1, p.pos.z, 1, true, 1);
    }
    if (!a.result && a.t > 1.4) {
      a.result = true;
      const boss = this.boss;
      const title = a.variant === 'victory' && boss ? `${boss.def.name} DEFEATED` : a.variant === 'smash' ? 'THROUGH THE GATE' : a.variant === 'limp' ? 'MADE IT. BARELY.' : this.encountersDone > 0 && this.encountersWon === this.encountersDone && p.hp > p.maxHp * 0.6 ? 'PERFECT ARRIVAL' : 'ROAD CLEARED';
      const sub = a.variant === 'victory' ? (this.zone.name + ' IS OPEN') : this.zone.name + ' · CHECKPOINT';
      const stats: [string, string][] = [];
      if (this.encountersDone > 0) stats.push(['OBJECTIVES', `${this.encountersWon}/${this.encountersDone}`]);
      stats.push(['WRECKED', `${this.nodeKills}`]);
      stats.push(['TOP SPEED', `${Math.round(this.nodeTopKmh)} KM/H`]);
      stats.push(['HULL', `${Math.ceil((p.hp / p.maxHp) * 100)}%`]);
      this.host.hud.arrivalCard(title, sub, stats, a.variant === 'limp' ? '#ff8060' : a.variant === 'victory' ? '#ffd000' : '#5af0ff');
    }
    if (!a.done && a.t > 3.6) {
      a.done = true;
      if (this.config.mode === 'BOSS') this.host.onBossDefeated();
      else {
        const avg = this.speedN ? (this.speedSum / this.speedN) * KMH : 0;
        if (avg >= 150) this.host.unlockAchievement('no_brakes');
        this.host.onNodeComplete({ mode: this.config.mode, encounters: this.encountersDone, won: this.encountersWon, avgSpeedKmh: avg });
      }
    }
  }

  /** Use a skill; on success the dock flashes and the hit is felt. */
  private fireSkill(slot: 'q' | 'e', id: AbilityId) {
    if (!this.combat.useAbility(slot, id)) return;
    const p = this.player;
    this.host.hud.skillFired(slot);
    this.cam.addTrauma(0.12);
    this.fx.pulse(p.pos.x, 0.3, p.pos.z, 5, new THREE.Color(ABILITIES[id].color).getHex(), 0.45);
    this.audio.duck(0.25);
    this.readyIdleT[slot] = 0;
    if (this.run) this.run.mem['skill_used_' + slot] = 1;
  }

  /** Would this skill help right now? Enemies close, a target ahead, a pursuer behind, a weak hull. */
  private abilityUseful(id: AbilityId): boolean {
    const p = this.player;
    const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
    let near = 0, ahead = 0, behind = 0, attacking = 0, trafficAhead = 0;
    for (const v of this.vehicles) {
      if (v.dead || v.removed) continue;
      const dx = v.pos.x - p.pos.x, dz = v.pos.z - p.pos.z;
      const dist = Math.hypot(dx, dz) || 1;
      const fwd = (dx * fx + dz * fz) / dist;
      if (!v.hostile) {
        if (v.role === 'traffic' && fwd > 0.8 && dist < 45) trafficAhead++;
        continue;
      }
      if (dist < 22) near++;
      if (fwd > 0.6 && dist > 8 && dist < 70) ahead++;
      if (fwd < -0.4 && dist < 45) behind++;
      if (dist < 30 && (v.ai.state === 'windup' || v.ai.state === 'charge' || v.ai.state === 'slam' || v.ai.state === 'cut' || v.ai.fuse > 0)) attacking++;
    }
    const bossOpen = !!this.boss && this.boss.open;
    switch (id) {
      case 'emp':
      case 'shockwave':
        return near >= 2 || attacking > 0;
      case 'afterburner':
      case 'boost':
      case 'harpoon':
        return ahead > 0 || bossOpen;
      case 'bulldozer':
        return near > 0 || ahead > 0 || bossOpen;
      case 'phase':
      case 'phaseshift':
        return attacking > 0 || trafficAhead >= 2;
      case 'cargo':
        return behind > 0;
      case 'repair':
        return p.hp < p.maxHp * 0.45;
    }
    return false;
  }

  /** READY callouts (once per run per skill, again if a ready skill sits unused through a fight) and PRESS prompts. */
  private updateSkillPrompts(dt: number) {
    const run = this.run;
    if (!run || this.finished) {
      this.skillUseful = { q: false, e: false };
      return;
    }
    for (const slot of ['q', 'e'] as const) {
      const id = slot === 'q' ? run.vehicle.special : run.module;
      const def = ABILITIES[id];
      const ready = this.combat.cooldowns[slot] <= 0 && this.player.momentum >= this.combat.abilityCost(id) && this.player.systemsLock <= 0;
      const useful = ready && this.abilityUseful(id);
      this.usefulT[slot] = useful ? this.usefulT[slot] + dt : 0;
      this.skillUseful[slot] = this.usefulT[slot] > 0.3;
      const key = slot.toUpperCase();
      if (ready && !run.mem['skill_callout_' + slot]) {
        run.mem['skill_callout_' + slot] = 1;
        this.host.hud.skillCallout(key, def.name, def.pitch, def.color);
        this.audio.item();
      }
      // a ready skill ignored while it would have helped: say it once more this road
      this.readyIdleT[slot] = useful ? this.readyIdleT[slot] + dt : this.readyIdleT[slot];
      if (!ready) this.readyIdleT[slot] = 0;
      if (this.readyIdleT[slot] > 6 && !this.recalloutDone[slot] && !run.mem['skill_used_' + slot]) {
        this.recalloutDone[slot] = true;
        this.host.hud.skillCallout(key, def.name, def.pitch, def.color);
      }
    }
  }

  private overheat() {
    const p = this.player;
    p.overheatLock = CONFIG.HEAT.OVERHEAT_LOCK;
    p.nitroActive = false;
    this.combat.explode(p.pos.x, p.pos.z, 6, 30, { byPlayer: true, hurtsPlayer: false, color: 0xff6a20 });
    this.combat.damagePlayer(CONFIG.HEAT.OVERHEAT_SELF_DAMAGE, 'drain');
    this.notify('OVERHEAT — NITRO COOLING', '#ff6a20', true);
    this.audio.warning();
  }

  /**
   * A tow truck (an iDos supply the player spent on the server): the wreck is hauled back onto the road where it fell,
   * hull full, with a moment of grace. The run carries on as if the wreck never ended it.
   */
  revive() {
    if (this.dying <= 0) return;
    const p = this.player;
    this.dying = 0;
    p.hp = p.maxHp;
    p.model.bodyMat.color.setHex(this.wreckPaint);
    p.velX = p.velZ = 0;
    this.respawnPlayer(false, 'TOW TRUCK — BACK ON THE ROAD');
    p.invuln = 3.5;
    this.damageFlash = 0;
    this.audio.setEngine(true);
  }

  respawnPlayer(fell: boolean, label = 'RESET') {
    const p = this.player;
    const road = this.world.road;
    const hole = fell ? road.gapNear(p.s, 40, 20) : null;
    const s = hole ? hole.s1 + 14 : Math.max(this.world.minS + 5, p.s - (fell ? 25 : 5));
    let d = 0;
    const w = road.at(s).width;
    for (const l of [0, 1, -1, 2, -2]) {
      const dd = this.world.safeD(s, l * (w / lanesFor(w)));
      if (!this.vehicles.some((v) => !v.dead && Math.abs(v.s - s) < 8 && Math.abs(v.d - dd) < 2.5)) {
        d = dd;
        break;
      }
    }
    p.placeAt(road, s, clamp(d, -w / 2 + 1.5, w / 2 - 1.5), 16);
    p.invuln = 2;
    p.phase = 1.5;
    p.stuckTime = 0;
    if (fell) {
      this.combat.damagePlayer(p.maxHp * CONFIG.WORLD.FALL_RESPAWN_DAMAGE, 'fall');
      this.breakCombo('FELL');
      this.notify('RECOVERED', '#ff8a3a');
    } else this.notify(label, label === 'RESET' ? '#ffffff' : '#7dffb0');
    this.cam.snap(p.pos.x, p.pos.y, p.pos.z, p.yaw);
  }

  /** Three tiers: NEAR MISS, CLOSE CALL, PERFECT NEAR MISS. Close is worth a lot — on purpose. */
  private updateNearMiss(dt: number) {
    const p = this.player;
    this.nmTimer -= dt;
    if (this.nmTimer <= 0) this.nmStreak = 0;
    if (p.speed < CONFIG.NEAR_MISS.MIN_SPEED) {
      for (const v of this.vehicles) v.nmRelPrev = v.s - p.s;
      return;
    }
    for (const v of this.vehicles) {
      if (v.dead || v.removed || (v.flying && v.hover > 2)) continue;
      const rel = v.s - p.s;
      const gap = Math.abs(v.d - p.d) - (v.width / 2 + CONFIG.CAR_HALF_WIDTH);
      if (Math.abs(rel) < v.length * 0.5 + 2.5) {
        v.nmActive = true;
        v.nmMinGap = Math.min(v.nmMinGap, gap);
      }
      if (v.nmActive && Math.sign(rel) !== Math.sign(v.nmRelPrev) && Math.abs(rel) > 0.1) {
        if (!v.nmTouched && v.nmMinGap < CONFIG.NEAR_MISS.GAP && v.nmMinGap > -0.25 && p.phase <= 0) this.nearMiss(v.nmMinGap < 0.35 ? 3 : v.nmMinGap < 0.75 ? 2 : 1, v.pos.x, v.pos.z, v);
      }
      if (Math.abs(rel) > v.length + 8) {
        v.nmActive = false;
        v.nmMinGap = 99;
        v.nmTouched = false;
      }
      v.nmRelPrev = rel;
    }
    for (const pr of this.world.props) {
      if (!pr.alive || !(pr.heavy || pr.explosive)) continue;
      const rel = pr.s - p.s;
      if (Math.abs(rel) > 6) {
        pr.nm = 0;
        continue;
      }
      this.world.road.project(pr.x, pr.z, pr.s, tmpAP);
      const gap = Math.abs(tmpAP.d - p.d) - (pr.r + CONFIG.CAR_HALF_WIDTH);
      if (!pr.nm) pr.nm = rel > 0 ? 1 : -1;
      if (pr.nm === 1 && rel <= 0) {
        pr.nm = 2;
        if (gap < 1.1 && gap > 0.08 && p.phase <= 0) this.nearMiss(gap < 0.3 ? 3 : gap < 0.6 ? 2 : 1, pr.x, pr.z, null);
      }
    }
  }

  private nearMiss(tier: number, x: number, z: number, v: AIVehicle | null) {
    this.nmStreak++;
    this.nmTimer = CONFIG.NEAR_MISS.CHAIN_WINDOW;
    this.host.hud.nearMiss(this.nmStreak, tier);
    this.audio.nearMiss(this.nmStreak, tier);
    const k = [0, 1, 1.8, 3][tier];
    // a breath of the view widening — felt, not shown
    this.cam.fovKick(0.8 + tier * 0.7);
    this.addScore(50 * this.nmStreak * k);
    this.addMomentum(CONFIG.MOMENTUM.NEAR_MISS * k * (1 + (this.nmStreak - 1) * 0.2));
    this.addCombo(0.8 * k, 'near');
    this.addVelocity(10 * k);
    this.addStatic(12 * k);
    if (tier >= 3) {
      this.hitStop(0.03);
      if (this.synergy('phantom') || this.run?.vehicle.id === 'ghost') this.setPhase(0.7);
    }
    if (this.run) {
      this.run.stats.nearMisses++;
      if (this.run.stats.nearMisses >= 10) this.host.unlockAchievement('close_call');
    }
    this.director.onNearMiss(tier);
    this.boss?.onNearMiss(tier);
    for (const it of this.items) it.onNearMiss?.(this, tier, this.nmStreak);
    if (v) v.nmActive = false;
    this.fx.whoosh(x, 1, z, this.player.velX - (v?.velX ?? 0), this.player.velZ - (v?.velZ ?? 0), 2 + tier * 2, tier >= 3 ? 0xffffff : 0xa8dcff, 0.7 + tier * 0.15);
  }

  /** Who is coming at you from outside the view — shown as edge arrows and heard in stereo. */
  private updateThreats(dt: number) {
    const p = this.player;
    this.threats.length = 0;
    this.threatBeepT -= dt;
    for (const v of this.vehicles) {
      if (!v.hostile || v.dead || v.removed) continue;
      const dx = v.pos.x - p.pos.x, dz = v.pos.z - p.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 45) continue;
      const ang = wrapAngle(Math.atan2(dx, dz) - p.yaw);
      if (Math.abs(ang) < 0.75) continue; // in view
      const attacking = v.ai.state === 'windup' || v.ai.state === 'charge' || v.ai.state === 'slam' || v.ai.state === 'cut' || v.ai.fuse > 0;
      this.threats.push({ angle: ang, dist, attacking });
      if (attacking && this.threatBeepT <= 0) {
        this.threatBeepT = 0.8;
        this.audio.threat(clamp(Math.sin(-ang), -1, 1));
      }
    }
  }

  private updatePopulation(dt: number) {
    const p = this.player;
    for (const v of this.vehicles) {
      if (v.removed) continue;
      const rel = v.s - p.s;
      const tooFar = rel < -CONFIG.SPAWN.DESPAWN_BEHIND || rel > CONFIG.SPAWN.DESPAWN_AHEAD;
      const retreatGone = v.task.kind === 'retreat' && rel < -50;
      if ((v.dead && v.deathTimer <= 0) || (tooFar && !v.isBoss) || retreatGone || v.s < this.world.minS - 5) this.removeVehicle(v);
    }
    // drop the removed ones in place (a fresh array every frame was steady garbage)
    let kept = 0;
    for (const v of this.vehicles) if (!v.removed) this.vehicles[kept++] = v;
    this.vehicles.length = kept;
    // ambient traffic only between encounters (encounters bring their own)
    this.trafficT -= dt;
    if (this.trafficT <= 0) {
      this.trafficT = 0.7;
      const busy = this.director.inEncounter(p.s + 150) || this.config.mode === 'BOSS';
      const target = this.attract ? 9 : this.finalPush && !this.arrival ? Math.round(this.zone.traffic * 5) + 3 : busy ? 1 : Math.round(this.zone.traffic * 5);
      const traffic = this.vehicles.filter((v) => v.role === 'traffic').length;
      if (traffic < target) this.spawnTraffic(this.rng.range(170, 260));
    }
  }

  private updatePickups(dt: number) {
    const p = this.player;
    const radius = p.stats.pickupRadius;
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const k = this.pickups[i];
      k.t += dt;
      const dx = p.pos.x - k.x, dz = p.pos.z - k.z;
      const dist = k.air ? Math.hypot(dx, dz, p.pos.y + 0.8 - k.y) : Math.hypot(dx, dz);
      if (dist < radius || k.magnet) {
        k.magnet = true;
        const sp = 30 + p.speed;
        k.x += (dx / (dist || 1)) * Math.min(dist, sp * dt);
        k.z += (dz / (dist || 1)) * Math.min(dist, sp * dt);
      }
      k.mesh.position.set(k.x, k.y + Math.sin(k.t * 3) * 0.2, k.z);
      k.mesh.rotation.y += dt * 3;
      // the pickup's own glow and a few motes rising off it (near ones only)
      const near = Math.abs(k.s - p.s) < 120;
      if (near) {
        const big = k.kind !== 'credits';
        this.fx.lampGlare(k.x, k.mesh.position.y, k.z, PK_GLARE[k.kind], big ? 1.2 : 0.7, (big ? 0.5 : 0.32) * (0.85 + 0.15 * Math.sin(k.t * 5)));
        if (big && Math.random() < dt * 5) this.fx.glow(k.x + frand(-0.5, 0.5), k.y - 0.5, k.z + frand(-0.5, 0.5), PK_HEX[k.kind], 0.07, frand(0.8, 1.3), 1.4, ADD_FRAME.dot, 0, frand(0.8, 1.6), 0);
      }
      if (dist < 2.2 && this.dying <= 0 && !this.attract) {
        this.collect(k);
        this.scene.remove(k.mesh);
        this.pickups.splice(i, 1);
        continue;
      }
      if (k.s < p.s - 60 && !k.magnet) {
        this.scene.remove(k.mesh);
        this.pickups.splice(i, 1);
      }
    }
  }

  private collect(k: Pickup) {
    const p = this.player;
    this.audio.pickup();
    this.fx.collect(k.x, k.mesh.position.y, k.z, PK_HEX[k.kind]);
    switch (k.kind) {
      case 'credits': this.addCredits(k.value); break;
      case 'gold':
        this.addCredits(k.value);
        this.addCombo(0.5, 'gold');
        break;
      case 'fuel': this.addFuel(CONFIG.FUEL.PICKUP_AMOUNT); this.popup('+FUEL', PK_COLORS.fuel); break;
      case 'repair': this.heal(p.maxHp * 0.15); this.popup('+REPAIR', PK_COLORS.repair); break;
      case 'momentum': this.addMomentum(25); this.popup('+MOMENTUM', PK_COLORS.momentum); break;
      case 'boost': this.boost(1.4); this.addNitro(30); this.popup('BOOST', PK_COLORS.boost); break;
      case 'shard': this.collectShard(); break;
    }
    this.director.onPickup(k.kind);
    for (const it of this.items) it.onPickup?.(this, k.kind);
    if (this.config.tutorial) this.hint('GOLD SITS ON THE RISKY LINE — WORTH IT?', 'pickup');
  }

  // ---------------------------------------------------------------- boss flow

  private updateBossFlow(rawDt: number) {
    const p = this.player;
    const boss = this.boss;
    if (!boss) return;
    if (!this.bossSpawned && p.s > 220) {
      this.bossSpawned = true;
      boss.enter();
      this.addVehicle(boss.vehicle);
      this.bossIntroT = 2.6;
      this.cam.cinematicTarget = boss.vehicle.pos;
      this.host.hud.bossIntro(boss.def.name, boss.def.title);
      this.audio.bossAlert();
      this.audio.setMusic('boss');
      if (boss.def.id === 'the_driver') this.host.unlockAchievement('zero_mile');
    }
    if (this.bossIntroT > 0) {
      this.bossIntroT -= rawDt;
      this.cam.cinematic = clamp(Math.min(this.bossIntroT, 2.6 - this.bossIntroT) * 1.5, 0, 1);
      if (this.bossIntroT <= 0) {
        this.cam.cinematic = 0;
        this.cam.cinematicTarget = null;
        this.host.hud.hint(boss.def.howTo, 'boss_' + boss.def.id + '_' + Math.floor(this.time));
      }
    }
    if (boss.defeated && this.bossDefeatedT <= 0 && !this.finished) {
      this.bossDefeatedT = 3;
      this.bossBlast = 1.9;
      // escalate, blow, burn: the staged death of a big machine, sized to it
      const bv = boss.vehicle;
      this.fx.deathSequence(bv.pos, Math.min(4, bv.length * 0.3), boss.def.accent);
      this.fx.after(0.7, () => {
        this.audio.explosion(1.4, this.relPan(bv.pos.x, bv.pos.z));
        this.cam.addTrauma(0.45);
        this.fx.debrisBurst(bv.pos.x, bv.pos.y + 1.5, bv.pos.z, 26, boss.def.color, 13);
      });
      for (const t of [1.05, 1.4]) this.fx.after(t, () => {
        this.audio.explosion(0.9, this.relPan(bv.pos.x, bv.pos.z));
        this.cam.addTrauma(0.15);
      });
      this.beginArrival('victory');
      this.slowMo(1.6, 0.3);
      this.notify(`${boss.def.name} DEFEATED`, '#ffd000', true);
      this.addScore(5000);
      this.audio.victory();
      if (this.run) this.run.stats.bossesDefeated++;
      this.addCredits(80);
      this.dropCredits(boss.vehicle.pos.x, boss.vehicle.pos.z, 40);
      for (const o of this.vehicles) if (o.role === 'enemy' && !o.dead) this.combat.killVehicle(o, { byPlayer: true });
    }
    if (this.bossDefeatedT > 0) this.bossDefeatedT -= rawDt;
    // its lights go out as it dies: accents and lamps fade to black, a last stutter on the way
    if (this.bossBlast > 0) {
      this.bossBlast -= rawDt;
      const m = boss.vehicle.model;
      const k = Math.max(0, this.bossBlast / 1.9);
      const st = Math.random() < 0.3 ? 0.2 : 1;
      m.accentMat.color.multiplyScalar(0.9 + 0.1 * k * st);
      m.lights.head = k * st;
      m.tailMat.color.multiplyScalar(0.92);
      boss.rig.shutdown(k);
    }
  }

  // ---------------------------------------------------------------- attract-mode driver

  autopilot(_dt: number): InputState {
    const p = this.player;
    const road = this.world.road;
    const w = road.at(p.s).width;
    const n = lanesFor(w);
    let best = this.autopilotLane, bestFree = -1;
    for (let l = 0; l < n; l++) {
      const ld = this.world.safeD(p.s + 30, laneOffset(w, l));
      let free = 90;
      for (const v of this.vehicles) {
        const ds = v.s - p.s;
        if (!v.dead && ds > -2 && ds < free && Math.abs(v.d - ld) < 2.6) free = ds;
      }
      for (const pr of this.world.props) {
        const ds = pr.s - p.s;
        if (pr.alive && (pr.heavy || pr.explosive) && ds > -2 && ds < free) {
          road.project(pr.x, pr.z, pr.s, tmpAP);
          if (Math.abs(tmpAP.d - ld) < 2.4) free = ds;
        }
      }
      const score = free - Math.abs(ld - p.d) * 0.8 + (l === this.autopilotLane ? 4 : 0);
      if (score > bestFree) {
        bestFree = score;
        best = l;
      }
    }
    this.autopilotLane = best;
    const look = road.at(p.s + 14);
    const td = this.world.safeD(p.s + 14, laneOffset(w, this.autopilotLane));
    const tx = look.x - Math.cos(look.heading) * td, tz = look.z + Math.sin(look.heading) * td;
    const err = wrapAngle(Math.atan2(tx - p.pos.x, tz - p.pos.z) - p.yaw);
    // brake for corners the way a careful driver would
    let k = 0;
    for (let s = p.s; s < p.s + 25 + p.speed; s += 4) {
      const a = road.at(s), b = road.at(s + 4);
      k = Math.max(k, Math.abs(wrapAngle(b.heading - a.heading)) / 4);
    }
    const vmax = k > 1e-4 ? Math.sqrt(CONFIG.DRIVE.CORNER_GRIP / k) * 0.95 : 99;
    const tooFast = p.speed > vmax + 1;
    return { accelerate: tooFast ? 0 : p.speed < 34 ? 1 : 0.4, brake: tooFast ? 1 : 0, steer: clamp(-err * 2.4, -1, 1), handbrake: false, nitro: false };
  }

  /** World position of a point in a car's space (body roll ignored: lamps and wheels sit close to the pivot). */
  private carPoint(pos: THREE.Vector3, yaw: number, p: number[], out = tmpV) {
    const c = Math.cos(yaw), sn = Math.sin(yaw);
    return out.set(pos.x + p[0] * c + p[2] * sn, pos.y + p[1], pos.z - p[0] * sn + p[2] * c);
  }

  private exhaustPop() {
    const p = this.player;
    if (!p || this.dying > 0) return;
    const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
    for (const e of p.model.anchors.exhausts) {
      if (Math.random() < 0.35) continue;
      const w = this.carPoint(p.pos, p.yaw, e);
      this.fx.exhaust(w.x, w.y + p.model.body.position.y, w.z, -fx, 0, -fz, p.velX, p.velZ, 'pop');
    }
  }

  private updateVehicleFx() {
    const p = this.player;
    const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
    const rx = -fz, rz = fx;
    const cam = this.cam.camera.position;
    // lights: every car on screen carries its own lamps, indicators and brake sheen
    const pm = p.model;
    pm.lights.brake = damp(pm.lights.brake, p.braking || p.drifting ? 1 : 0, 14, 1 / 60);
    pm.lights.reverse = p.vF < -0.8;
    updateCarLights(this.fx, pm, p.model.group.position, p.yaw, cam, this.time);
    for (const v of this.vehicles) {
      if (v.removed || !v.model.group.visible) continue;
      const vm = v.model;
      let memo = this.fxMemo.get(v);
      if (!memo) this.fxMemo.set(v, (memo = { vF: v.vF, d: v.d, brake: 0, ind: 0, indT: 0 }));
      // brake lights when it sheds speed, indicators when it changes lane (visual only)
      const decel = (memo.vF - v.vF) * 60;
      memo.brake = damp(memo.brake, v.dead ? 0 : clamp((decel - 2.5) / 7, 0, 1), 10, 1 / 60);
      const lat = (v.d - memo.d) * 60;
      if (Math.abs(lat) > 1.1 && !v.dead) {
        memo.ind = Math.sign(lat);
        memo.indT = 1.2;
      } else memo.indT -= 1 / 60;
      memo.vF = v.vF;
      memo.d = v.d;
      vm.lights.brake = memo.brake;
      vm.lights.indicator = v.role === 'traffic' && memo.indT > 0 ? memo.ind : 0;
      // (a dead boss is dimmed by its death sequence instead)
      if (!(v.isBoss && v.dead)) vm.lights.head = v.dead ? (Math.random() < 0.2 ? 0.3 : 0) : 1;
      updateCarLights(this.fx, vm, vm.group.position, v.yaw, cam, this.time);
    }
    if (this.dying > 0) return;
    // tyres: smoke from the rear contact patches, marks where they actually slide, spray on wet roads
    const slip = Math.abs(p.vL);
    const hardBrake = p.braking && p.speed > 15 && !p.drifting;
    const smokeI = p.drifting ? clamp(0.45 + slip * 0.05, 0, 1.25) : p.sliding ? 0.6 : slip > 6 ? 0.4 : hardBrake ? 0.28 : 0;
    const wheels = pm.pivots ?? [];
    const wet = p.wet;
    if (p.grounded) {
      for (let i = 0; i < wheels.length; i++) {
        const wp = wheels[i].o.position;
        const rearWheel = wp.z < 0;
        const w = this.carPoint(p.pos, p.yaw, [wp.x, 0, wp.z]);
        const sliding = (rearWheel && (p.drifting || slip > 5)) || hardBrake || p.sliding;
        if (sliding) this.fx.skids.mark(i, w.x, p.pos.y, w.z, 0.26, clamp((p.drifting ? 0.6 + slip * 0.03 : hardBrake ? 0.45 : 0.4) * (0.6 + p.speed / 60), 0, 1));
        else this.fx.skids.lift(i);
        if (rearWheel && smokeI > 0) this.fx.tireSmoke(w.x, w.z, p.velX, p.velZ, smokeI, p.inPerfect ? 0xd8a0ff : 0xc8ccd4);
        if (wet && rearWheel && p.speed > 14) this.fx.spray(w.x, w.z, -p.velX * 0.25, -p.velZ * 0.25, clamp((p.speed - 14) / 40, 0, 0.8));
      }
      // on the curb: grit kicked up by the wheels riding it
      if (Math.abs(p.curbSide) > 0.3 && p.speed > 10 && Math.random() < 0.35) {
        const side = -Math.sign(p.curbSide);
        const w = this.carPoint(p.pos, p.yaw, [side * p.width * 0.5, 0, -p.length * 0.3]);
        this.fx.dust(w.x, 0.2, w.z, 1, 0.5, p.velX * 0.3, p.velZ * 0.3);
      }
      if (p.inPerfect && Math.random() < 0.5) this.fx.trail(p.pos.x - fx * 1.4, 0.3, p.pos.z - fz * 1.4, 0xff40d0, 0.5, 0.35);
    } else for (let i = 0; i < wheels.length; i++) this.fx.skids.lift(i);
    // exhausts: a hot jet on boost, from the tailpipes of this model, and the road behind lit by it
    const boosting = p.nitroActive || p.afterburner > 0 || p.boostTimer > 0;
    const exColor = p.afterburner > 0 ? 0xff8a20 : p.boostTimer > 0 && !p.nitroActive ? 0xff40d0 : 0x40a0ff;
    this.exhaustLight.color.setHex(exColor);
    this.exhaustLight.intensity = boosting ? 3.2 + Math.random() * 1.6 : damp(this.exhaustLight.intensity, 0, 10, 1 / 60);
    if (boosting && this.fx.density > 0) {
      for (const e of pm.anchors.exhausts) {
        const w = this.carPoint(p.pos, p.yaw, e);
        this.fx.exhaust(w.x, w.y + pm.body.position.y, w.z, -fx, 0, -fz, p.velX, p.velZ, 'boost', exColor, p.speed > p.stats.maxSpeed * 0.9 ? 1.2 : 1);
      }
    }
    // enemies on boost: their own tailpipes flame — you can see them fighting to keep up
    if (this.fx.density > 0) {
      for (const v of this.vehicles) {
        if (!v.boosting || v.dead || v.removed || v.flying) continue;
        if (Math.hypot(v.pos.x - p.pos.x, v.pos.z - p.pos.z) > 90) continue;
        const vx = Math.sin(v.yaw), vz = Math.cos(v.yaw);
        const exs = v.model.anchors.exhausts.length ? v.model.anchors.exhausts : [[0, 0.45, -v.length / 2]];
        for (const e of exs) {
          const w = this.carPoint(v.pos, v.yaw, e);
          this.fx.exhaust(w.x, w.y, w.z, -vx, 0, -vz, v.velX, v.velZ, 'boost', v.duel ? 0xff2050 : 0xff7a20, 0.85);
        }
      }
    }
    // damage state: the engine bay smokes, then sparks, then small flames; a coughing tailpipe
    const hpf = p.hp / p.maxHp;
    const bay = this.carPoint(p.pos, p.yaw, [0, 0.9, pm.length / 2 - 0.9], tmpV2);
    if (hpf < 0.55 && Math.random() < (0.55 - hpf) * 1.4) this.fx.puff('damage', bay.x, bay.y, bay.z, p.velX * 0.5, 0, p.velZ * 0.5, 0.5 + (0.55 - hpf));
    if (hpf < 0.3 && Math.random() < 0.12) this.fx.sparks(bay.x + rx * frand(-0.8, 0.8), bay.y, bay.z + rz * frand(-0.8, 0.8), 4, 0xffc060, 3, p.velX * 0.3, p.velZ * 0.3);
    if (hpf < 0.18 && Math.random() < 0.25) this.fx.fire(bay.x, bay.y + 0.1, bay.z, 1, 0.35);
    if (hpf < 0.4 && Math.random() < 0.06) for (const e of pm.anchors.exhausts) {
      const w = this.carPoint(p.pos, p.yaw, e);
      this.fx.exhaust(w.x, w.y, w.z, -fx, 0, -fz, p.velX, p.velZ, 'smoke');
    }
    if (p.heat > CONFIG.HEAT.HIGH && Math.random() < 0.3) this.fx.fire(p.pos.x - fx * 2, p.pos.y + 0.6, p.pos.z - fz * 2, 1, 0.4);
    if (p.phase > 0 && Math.random() < 0.6) this.fx.trail(p.pos.x + frand(-1, 1), p.pos.y + 0.8, p.pos.z + frand(-1.5, 1.5), 0xb9a6ff, 0.6, 0.4);
    if (this.res.mass >= 3 && Math.random() < 0.15 * this.res.mass) this.fx.sparks(p.pos.x + fx * 2.2, p.pos.y + 0.4, p.pos.z + fz * 2.2, 1, 0xffb020, 2);
    if (this.res.static >= 99 && Math.random() < 0.4) this.fx.electric(p.pos.x, p.pos.y + 1, p.pos.z, 1, 0x80d8ff);
    if (p.speed > 44) this.fx.speedLines(p.pos.x, p.pos.y, p.pos.z, fx, fz, p.velX, p.velZ, (p.speed - 44) / 30);
  }

  private updateCamera(rawDt: number) {
    const p = this.player;
    if (this.attract) {
      this.cam.update(rawDt, p.pos, p.yaw + Math.sin(this.time * 0.15) * 0.6, p.velX, p.velZ, p.speed, p.stats.maxSpeed, false, false);
      return;
    }
    const ap = this.world.road.at(p.s + 18 + p.speed * 0.45);
    this.cam.update(rawDt, p.pos, p.yaw, p.velX, p.velZ, p.speed, p.stats.maxSpeed, p.drifting, p.nitroActive || p.afterburner > 0, { x: ap.x, y: ap.y, z: ap.z, heading: ap.heading }, p.driftAngle, { accel: p.accelLong, air: !p.grounded && !p.falling, vy: p.vy, roll: p.rolling ? p.visualRoll : 0 });
  }

  dispose() {
    this.clearHazardTags();
    this.clearVehicles();
    this.clearPickups();
    this.combat.reset();
    this.tele.clear();
    if (this.player) this.scene.remove(this.player.model.group);
  }
}

const tmpAP = { s: 0, d: 0 };
/** What the car hit, for the impact effect: concrete throws dust and chips, metal throws sparks. */
function impactSurface(m: CollisionMaterialId): 'metal' | 'concrete' | 'plastic' {
  return /rail|steel|metal|truck|car|anvil|vehicle|heavyProp/i.test(m) ? 'metal' : /cone|plastic|cushion|fence/i.test(m) ? 'plastic' : 'concrete';
}
const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const NO_INPUT: InputState = { accelerate: 0, brake: 0.3, steer: 0, handbrake: false, nitro: false };
