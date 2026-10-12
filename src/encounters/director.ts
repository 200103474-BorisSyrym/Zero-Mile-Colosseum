import { Random } from '../core/random';
import type { NodeMod } from '../data/events';
import type { EnemyKind, TrafficKind } from '../data/enemies';
import type { SegmentType } from '../data/zones';
import { makeAlly, makeEnemy, makeTraffic, type AIVehicle, type Task } from '../enemies/ai';
import type { DrivingSession } from '../game/driving';
import type { HazardKind } from '../game/simApi';
import type { PieceOpts, SegmentInfo } from '../world/generator';
import { laneOffset, lanesFor, type PropKind } from '../world/world';
import { ENCOUNTERS, type EncounterDef, type EncounterId } from './defs';

export type EncState = 'planned' | 'warned' | 'active' | 'resolved';

export interface Objective {
  label: string;
  progress: number;
  target: number;
  done: boolean;
  failed: boolean;
  /** show as a countdown instead of a bar */
  timer?: number;
}

export interface Encounter {
  index: number;
  def: EncounterDef;
  tier: number;
  elite: boolean;
  rng: Random;
  startS: number;
  endS: number;
  state: EncState;
  primary: Objective;
  optional: Objective | null;
  vehicles: AIVehicle[];
  t: number;
  result: 'success' | 'fail' | null;
  /** per-definition scratch data */
  data: Record<string, unknown>;
  rewardMul: number;
}

export interface Piece {
  type: SegmentType;
  opts: PieceOpts;
}

/** What encounter definitions are allowed to do to the world. */
export class EncCtx {
  constructor(public dir: EncounterDirector, public enc: Encounter) {}
  get sess() {
    return this.dir.sess;
  }
  get rng() {
    return this.enc.rng;
  }
  get tier() {
    return this.enc.tier;
  }
  get p() {
    return this.dir.sess.player;
  }
  width(s: number) {
    return this.sess.world.road.at(s).width;
  }
  lanes(s: number) {
    return lanesFor(this.width(s));
  }
  laneD(s: number, lane: number) {
    return laneOffset(this.width(s), lane);
  }
  enemy(kind: EnemyKind, s: number, d: number, speed: number, task: Task, opts: { elite?: boolean; target?: boolean; hpMul?: number } = {}) {
    const v = this.sess.spawnEnemyAt(kind, s, d, speed, opts.elite ?? this.enc.elite, opts.hpMul ?? 1);
    if (!v) return null;
    v.task = task;
    v.encId = this.enc.index;
    if (opts.target) {
      v.isTarget = true;
      v.setMarker('target');
    }
    this.enc.vehicles.push(v);
    return v;
  }
  traffic(s: number, d: number, speed: number, kind?: TrafficKind) {
    const v = this.sess.spawnTrafficAt(s, d, speed, kind);
    if (v) {
      v.task = { kind: 'cruise', speed, d };
      v.ai.t = speed;
    }
    return v;
  }
  crossTraffic(s: number, fromSide: number, speed: number) {
    const road = this.sess.world.road;
    const w = this.width(s);
    const v = makeTraffic(this.rng.pick(['sedan', 'van', 'hatch', 'truck'] as TrafficKind[]));
    v.crossing = true;
    v.task = { kind: 'cross', speed };
    v.place(road, s, fromSide * (w / 2 + 14), speed, (-fromSide * Math.PI) / 2);
    this.sess.addVehicle(v);
    return v;
  }
  ally(s: number, d: number, speed: number) {
    const v = makeAlly();
    v.place(this.sess.world.road, s, d, speed);
    v.task = { kind: 'cruise', speed, d };
    v.encId = this.enc.index;
    this.sess.addVehicle(v);
    this.enc.vehicles.push(v);
    return v;
  }
  rival(s: number, d: number, speed: number) {
    const v = makeEnemy('hunter', 1, false);
    v.role = 'rival';
    v.model.bodyMat.color.setHex(0xe8e8f0);
    v.model.accentMat.color.setHex(0x40ffd0);
    v.setMarker('rival');
    const who = this.sess.rivalIdentity;
    if (who) v.tagLabel = who.name.toUpperCase().slice(0, 18);
    v.hp = v.maxHp = 400;
    v.topSpeed = this.p.stats.maxSpeed * 0.98;
    v.place(this.sess.world.road, s, d, speed);
    v.encId = this.enc.index;
    this.sess.addVehicle(v);
    this.enc.vehicles.push(v);
    return v;
  }
  prop(kind: PropKind, s: number, d: number) {
    return this.sess.world.spawnProp(kind, s, d);
  }
  pickup(kind: 'credits' | 'gold' | 'fuel' | 'repair' | 'momentum' | 'boost' | 'shard', s: number, d: number, value = 0) {
    this.sess.placePickup(kind, s, d, value);
  }
  hazard(kind: HazardKind, s: number, d: number, r: number, life = 9999, dps = 12) {
    const o = { x: 0, y: 0, z: 0 };
    this.sess.world.road.toWorld(s, d, o);
    this.sess.combat.addHazard(kind, o.x, o.z, r, life, dps, false);
  }
  sign(s: number, text: string, color: number, where: 'gantry' | -1 | 1 = 'gantry', sub = '') {
    this.sess.world.addSign(s, text, color, where, sub);
  }
  /** Count alive hostile vehicles that belong to this encounter. */
  alive(filter?: (v: AIVehicle) => boolean) {
    return this.enc.vehicles.filter((v) => !v.dead && !v.removed && v.hostile && (!filter || filter(v))).length;
  }
}

/**
 * Encounter-first generation. A node is planned as a list of encounters; the director turns that plan into road
 * pieces (each encounter brings its own geometry), dresses the segments as they are built, triggers encounters as
 * the player arrives, tracks objectives and resolves them with rewards and cleanup.
 */
export class EncounterDirector {
  encounters: Encounter[] = [];
  private queue: Piece[] = [];
  finishS = -1;
  current: Encounter | null = null;
  bossMode = false;
  private rng = new Random(1);
  /** encounters announced on the HUD this node */
  banner: { text: string; color: string; t: number } | null = null;

  constructor(public sess: DrivingSession) {}

  reset() {
    this.encounters = [];
    this.queue = [];
    this.finishS = -1;
    this.current = null;
    this.bossMode = false;
    this.banner = null;
  }

  /** Plan the node. Returns nothing; road pieces are produced lazily via next(). */
  plan(nodeType: string, zoneIndex: number, seed: number, opts: { tutorial: boolean; mod: NodeMod | null; difficulty: number; forced?: EncounterId[] }) {
    this.reset();
    this.rng = new Random(seed);
    const rng = this.rng;
    let tier = Math.min(4, zoneIndex + (opts.difficulty > 0 ? 1 : 0));
    let ids: EncounterId[];
    let elite = -1;
    const pool: [EncounterId, number][] = [
      ['ROADBLOCK', 3], ['CONVOY', 3], ['AMBUSH', 2.5], ['PURSUIT', 2.5], ['HAZARD_RUN', 2], ['TRAFFIC_WAVE', 2],
      ['PROTECT', 1.5], ['DESTROY_TARGET', 2], ['SURVIVE', 1.2 + zoneIndex * 0.3], ['ESCAPE', 1.5],
    ];
    const pick = (n: number, exclude: EncounterId[] = []) => {
      const out: EncounterId[] = [];
      let guard = 0;
      while (out.length < n && guard++ < 50) {
        const id = rng.weighted(pool);
        if (!out.includes(id) && !exclude.includes(id)) out.push(id);
      }
      return out;
    };
    if (opts.forced) ids = opts.forced;
    else if (opts.tutorial) {
      ids = ['DESTROY_TARGET', 'ROADBLOCK', 'PURSUIT'];
      tier = 0;
    } else {
      switch (nodeType) {
        case 'ELITE':
          ids = [...pick(1, ['SURVIVE']), rng.pick(['AMBUSH', 'PURSUIT', 'CONVOY'] as EncounterId[])];
          if (ids[0] === ids[1]) ids[0] = 'ROADBLOCK';
          elite = 1;
          break;
        case 'RACE':
          ids = ['TRAFFIC_WAVE', 'RACE'];
          break;
        case 'SHORTCUT':
          ids = ['HAZARD_RUN', 'ESCAPE'];
          tier = Math.min(4, tier + 1);
          break;
        default:
          ids = pick(3);
      }
      if (opts.mod === 'ambush') ids[0] = 'AMBUSH';
      if (opts.mod === 'police') ids[0] = 'PURSUIT';
      if (opts.mod === 'bounty') ids[0] = 'DESTROY_TARGET';
      if (opts.mod === 'race' && !ids.includes('RACE')) ids[ids.length - 1] = 'RACE';
      if (opts.mod === 'safe') ids = ids.slice(0, 2);
    }
    // one broken bridge per road — a big moment between two fights (first road: before the chase)
    const gapAt = opts.forced || nodeType === 'RACE' ? -1 : opts.tutorial ? 2 : rng.int(1, Math.max(1, ids.length - 1));
    const gapLen = opts.tutorial ? 15 : this.sess.zone.elevated ? 26 : 20 + zoneIndex * 1.5;
    // the director lays out the whole node: intro, then [rest, approach, stage] per encounter, then the finish
    this.queue.push({ type: 'STRAIGHT', opts: { length: 70, tag: { enc: -1, role: 'intro' } } });
    ids.forEach((id, i) => {
      const def = ENCOUNTERS[id];
      const enc: Encounter = {
        index: i,
        def,
        tier,
        elite: i === elite,
        rng: rng.fork(i * 97 + 13),
        startS: 0,
        endS: 0,
        state: 'planned',
        primary: { label: '', progress: 0, target: 1, done: false, failed: false },
        optional: null,
        vehicles: [],
        t: 0,
        result: null,
        data: {},
        rewardMul: (i === elite ? 1.8 : 1) * (opts.mod === 'bounty' && i === 0 ? 2 : 1),
      };
      this.encounters.push(enc);
      const restLen = i === 0 ? 60 : rng.range(150, 210);
      this.queue.push({ type: rng.pick(['STRAIGHT', 'CURVE'] as SegmentType[]), opts: { length: restLen, bend: 0.002, tag: { enc: i, role: 'rest' } } });
      if (i === gapAt) this.queue.push({ type: 'GAP_JUMP', opts: { gapLen, tag: { enc: i, role: 'rest' } } });
      this.queue.push({ type: 'STRAIGHT', opts: { length: 90, width: def.approachWidth?.(this.sess.zone.baseWidth), tag: { enc: i, role: 'approach' } } });
      const pieces = def.pieces(enc.rng, tier, this.sess.zone.baseWidth);
      pieces.forEach((pc, k) => {
        pc.opts.tag = { enc: i, role: 'stage', part: k };
        this.queue.push(pc);
      });
    });
    this.queue.push({ type: 'STRAIGHT', opts: { length: 160, tag: { enc: -1, role: 'rest' } } });
    this.queue.push({ type: 'STRAIGHT', opts: { length: 300, tag: { enc: -1, role: 'finish' } } });
  }

  /** Boss nodes: the boss encounter owns the road. */
  planBoss() {
    this.reset();
    this.bossMode = true;
  }

  /** World asks for the next road piece. */
  next(): Piece | null {
    if (this.bossMode) return this.sess.boss?.nextPiece() ?? null;
    return this.queue.shift() ?? null;
  }

  /** World built a segment: let its encounter dress it, record stage extents. */
  onSegment(info: SegmentInfo) {
    const tag = info.tag;
    if (!tag) return;
    if (tag.role === 'finish' && this.finishS < 0) {
      this.finishS = info.startS + 40;
      this.sess.world.setFinish(this.finishS);
      return;
    }
    if (tag.enc < 0) {
      if (tag.role === 'rest') this.dressRest(info, null);
      return;
    }
    const enc = this.encounters[tag.enc];
    if (!enc) return;
    if (tag.role === 'rest') this.dressRest(info, enc);
    if (tag.role === 'approach') {
      const sub = enc.elite ? 'ELITE · ' + enc.def.tagline : enc.def.tagline;
      this.sess.world.addSign(info.startS + 25, (enc.elite ? '☠ ' : '') + enc.def.name, enc.elite ? 0xffd000 : enc.def.color, 'gantry', sub);
    }
    if (tag.role === 'stage') {
      if (tag.part === 0) enc.startS = info.startS;
      enc.endS = Math.max(enc.endS, info.endS);
      enc.def.decorate?.(new EncCtx(this, enc), info);
    }
  }

  /** Short breather between encounters: pickups and a glimpse of what is next. Never empty. */
  private dressRest(info: SegmentInfo, _next: Encounter | null) {
    if (info.gapJump) return this.dressGap(info);
    const rng = this.rng.fork(info.index * 7 + 1);
    const p = this.sess.player;
    const len = info.endS - info.startS;
    if (len < 50) return;
    const w = info.width;
    const lane = rng.int(0, lanesFor(w) - 1);
    // no coin lines: money comes from wrecking enemies, objectives and the risky line — not from lane-collecting
    const need = p.fuel < 45 ? 'fuel' : p.hp < p.maxHp * 0.5 ? 'repair' : rng.chance(0.4) ? 'momentum' : null;
    if (need) this.sess.placePickup(need, info.startS + len * 0.65, laneOffset(w, (lane + 1) % lanesFor(w)));
    // a small greedy option: a gold pickup tucked beside an explosive barrel
    if (rng.chance(0.55)) {
      const side = rng.sign();
      const dd = side * (w / 2 - 1.2);
      this.sess.world.spawnProp('xbarrel', info.startS + len * 0.45, dd);
      this.sess.placePickup('gold', info.startS + len * 0.45 + 2.5, dd - side * 1.3, 12);
    }
  }

  /** Broken bridge: the warning signs, boost on the run-up and gold hanging on the line of a fast jump. */
  private dressGap(info: SegmentInfo) {
    const s = this.sess;
    const gj = info.gapJump!;
    const need = Math.ceil((jumpSpeed(gj.s1 - gj.s0, gj.h) * 3.6) / 10) * 10;
    s.world.addSign(info.startS - 100, 'BRIDGE OUT', 0xff8a1a, 1, 'AHEAD · KEEP YOUR SPEED');
    s.world.addSign(info.startS + 8, 'BRIDGE OUT', 0xff8a1a, 'gantry', `JUMP IT · ${need}+ KM/H`);
    for (const d of [-1.8, 1.8]) s.placePickup('boost', info.startS + 24, d);
    const vF = 46, vy = vF * (gj.h / 20) + 2.5;
    for (const t of [0.22, 0.42, 0.62]) s.placePickup('gold', gj.lipS + vF * t, 0, 10, gj.h + vy * t - 16 * t * t - 0.2);
  }

  /** Per frame: trigger, update and resolve encounters. */
  update(dt: number) {
    if (this.bossMode) return;
    const p = this.sess.player;
    if (this.banner) {
      this.banner.t -= dt;
      if (this.banner.t <= 0) this.banner = null;
    }
    for (const enc of this.encounters) {
      if (enc.state === 'resolved' || enc.startS === 0) continue;
      const ctx = new EncCtx(this, enc);
      if (enc.state === 'planned' && p.s > enc.startS - 240) {
        enc.state = 'warned';
        enc.def.prepare?.(ctx);
        this.sess.notify(`${enc.elite ? 'ELITE · ' : ''}${enc.def.name} AHEAD`, '#' + (enc.elite ? 0xffd000 : enc.def.color).toString(16).padStart(6, '0'));
      }
      if (enc.state === 'warned' && p.s > enc.startS - (enc.def.triggerLead ?? 30)) {
        enc.state = 'active';
        enc.t = 0;
        this.current = enc;
        enc.def.start(ctx);
        this.sess.audio.musicIntensity = 1;
        const tip = this.sess.config.tutorial ? enc.def.tutorialHint ?? enc.def.hint : undefined;
        if (tip) this.sess.hint(tip, 'enc_' + enc.def.id);
      }
      if (enc.state === 'active') {
        enc.t += dt;
        let res = enc.def.update(ctx, dt);
        if (res === 'active' && p.s > enc.endS) res = enc.def.endIsSuccess === false && !enc.primary.done ? 'fail' : 'success';
        if (enc.primary.done && res === 'active') res = 'success';
        if (res !== 'active') this.resolve(enc, res);
      }
    }
  }

  private resolve(enc: Encounter, res: 'success' | 'fail') {
    const s = this.sess;
    enc.state = 'resolved';
    enc.result = res;
    if (this.current === enc) this.current = null;
    enc.def.finish?.(new EncCtx(this, enc), res);
    let credits = 0;
    if (res === 'success') {
      enc.primary.done = true;
      credits = Math.round((18 + enc.tier * 7) * enc.rewardMul);
      if (enc.optional?.done) credits += Math.round((20 + enc.tier * 6) * enc.rewardMul);
      s.addCredits(credits);
      s.addMomentum(15);
      s.addCombo(1, 'encounter');
      s.addScore(500 + enc.tier * 150);
      this.banner = { text: `${enc.def.name} CLEARED${enc.optional?.done ? ' · BONUS' : ''} +${credits} CR`, color: '#58f0a0', t: 2.6 };
      s.audio.item();
      if (enc.elite) s.collectShard();
    } else {
      enc.primary.failed = true;
      this.banner = { text: `${enc.def.name} FAILED`, color: '#ff4060', t: 2.4 };
      s.audio.warning();
    }
    s.encountersDone++;
    if (res === 'success') s.encountersWon++;
    // cleanup: remaining hostiles break off and leave; their telegraphs expire on their own
    for (const v of enc.vehicles) {
      if (v.dead || v.removed) continue;
      if (v.role === 'enemy') v.task = { kind: 'retreat' };
    }
    s.audio.musicIntensity = 0.45;
  }

  onKill(v: AIVehicle, kind: string) {
    const e = this.encounters[v.encId];
    if (e && e.state === 'active') e.def.onKill?.(new EncCtx(this, e), v, kind);
  }
  onNearMiss(tier: number) {
    const e = this.current;
    if (e) e.def.onNearMiss?.(new EncCtx(this, e), tier);
  }
  onPickup(kind: string) {
    const e = this.current;
    if (e) e.def.onPickup?.(new EncCtx(this, e), kind);
  }
  onDrift(perfect: boolean) {
    const e = this.current;
    if (e) e.def.onDrift?.(new EncCtx(this, e), perfect);
  }

  /** The objective the HUD should show right now. */
  hudObjective(): { title: string; primary: Objective; optional: Objective | null; color: string } | null {
    const e = this.current ?? this.encounters.find((x) => x.state === 'warned');
    if (!e) return null;
    return { title: (e.elite ? 'ELITE · ' : '') + e.def.name, primary: e.primary, optional: e.optional, color: '#' + e.def.color.toString(16).padStart(6, '0') };
  }

  /** Is s inside an active encounter (used to thin out ambient traffic)? */
  inEncounter(s: number) {
    return this.encounters.some((e) => e.state === 'active' && s >= e.startS - 50 && s <= e.endS);
  }
}

/** Slowest take-off speed (m/s) that clears a hole of length gap from a lip h metres high (with a car length to spare). */
export function jumpSpeed(gap: number, h: number) {
  for (let v = 12; v < 90; v += 0.5) {
    const vy = v * (h / 20) + 2.5;
    const t = (vy + Math.sqrt(vy * vy + 2 * 32 * h)) / 32;
    if (v * t >= gap + 2.5) return v;
  }
  return 90;
}
