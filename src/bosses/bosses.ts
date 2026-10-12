import { clamp } from '../core/math';
import { Random, frand } from '../core/random';
import { applyBossPresence } from '../render/visualBudget';
import { buildBossRig, type BossRig } from './bossRig';
import type { ModelKind } from '../data/enemies';
import type { Tag } from '../data/types';
import type { BossId, SegmentType } from '../data/zones';
import { AIVehicle, cornerSpeed } from '../enemies/ai';
import type { Piece } from '../encounters/director';
import type { DrivingSession } from '../game/driving';
import { buildCar } from '../vehicles/carModels';
import { MARK } from '../world/generator';
import type { Telegraph } from '../world/telegraph';
import { laneOffset, lanesFor, type Prop } from '../world/world';

export interface BossDef {
  id: BossId;
  name: string;
  title: string;
  hp: number;
  mass: number;
  speed: number;
  accel: number;
  length: number;
  width: number;
  cornerGrip: number;
  model: ModelKind;
  color: number;
  accent: number;
  lore: string;
  /** one line: the driving problem this boss poses */
  howTo: string;
  phaseNames: [string, string, string];
}

export const BOSSES: Record<BossId, BossDef> = {
  iron_mule: {
    id: 'iron_mule', name: 'IRON MULE', title: 'THE INDUSTRIAL JUGGERNAUT', hp: 900, mass: 9, speed: 52, accel: 14, length: 12.5, width: 3.3, cornerGrip: 20,
    model: 'boss_mule', color: 0x3a2a1a, accent: 0xff8a1a, lore: 'lore_mule',
    howTo: 'STAY IN A LANE WITH AN ANVIL AHEAD — DODGE LATE AND LET IT CHARGE INTO THE STEEL',
    phaseNames: ['THE CHARGE', 'CARGO SPILL', 'RUNAWAY FREIGHT'],
  },
  drowned_line: {
    id: 'drowned_line', name: 'DROWNED LINE', title: 'NIGHT BUS ZERO', hp: 1000, mass: 7, speed: 50, accel: 16, length: 14, width: 3.1, cornerGrip: 20,
    model: 'boss_bus', color: 0x1a3a40, accent: 0x20f0e0, lore: 'lore_bus',
    howTo: 'HERD THE BUS INTO THE FLOODED LANE WHEN THE PYLONS LIGHT UP — BLOCK ITS ESCAPE LANE',
    phaseNames: ['HIGH WATER', 'LIVE WIRE', 'FLOODGATE'],
  },
  taxon: {
    id: 'taxon', name: 'TAXON', title: 'PREDICTIVE ENFORCEMENT UNIT', hp: 1000, mass: 2.4, speed: 62, accel: 26, length: 5.2, width: 2.25, cornerGrip: 28,
    model: 'boss_taxon', color: 0x101828, accent: 0x3060ff, lore: 'lore_taxon',
    howTo: 'IT STRIKES THE LANE IT PREDICTS — STAY IN IT, THEN SWITCH AT THE LAST MOMENT',
    phaseNames: ['PREDICTION', 'PATTERN LEARNED', 'TOTAL MODEL'],
  },
  apex: {
    id: 'apex', name: 'APEX', title: 'THE FASTEST THING ALIVE', hp: 900, mass: 1.9, speed: 66, accel: 28, length: 5.0, width: 2.15, cornerGrip: 25,
    model: 'boss_apex', color: 0xe8f0ff, accent: 0x40ffd0, lore: 'lore_apex',
    howTo: 'WIN THE SECTORS — WHEN YOU LEAD, APEX TAKES RISKS AND CRASHES',
    phaseNames: ['GREEN FLAG', 'NO LIFTING', 'LAST LAP'],
  },
  the_driver: {
    id: 'the_driver', name: 'THE DRIVER', title: 'WAITING AT ZERO MILE', hp: 1200, mass: 2, speed: 64, accel: 28, length: 5.2, width: 2.2, cornerGrip: 27,
    model: 'boss_driver', color: 0x050507, accent: 0xff1040, lore: 'lore_driver',
    howTo: 'ANSWER ITS CHALLENGES — EVERY MOVE IT CALLS, YOU DRIVE BETTER',
    phaseNames: ['MIRROR', 'COUNTERPOINT', 'ZERO MILE'],
  },
};

export type BossState = 'INTRO' | 'PHASE_START' | 'ACTIVE' | 'TELEGRAPH' | 'ATTACK' | 'BREAK' | 'VULNERABLE' | 'RECOVER' | 'PHASE_COMPLETE' | 'DEFEATED';

export interface BossHud {
  name: string;
  title: string;
  hp: number;
  phase: number;
  phases: number;
  stability: number;
  state: BossState;
  vuln: number;
  objective: string;
  race: { pos: number; gap: number; sector: number; sectors: number } | null;
  prompt: { text: string; progress: number; time: number } | null;
}

const PHASES = 3;

/**
 * Shared boss framework. Bosses are driving problems:
 *  - STABILITY only drops when the player solves the boss's mechanic (lure, herd, feint, out-race, answer).
 *  - At zero stability the boss BREAKS (a chunk of HP is lost) and becomes VULNERABLE for a few seconds.
 *  - Only during VULNERABLE does ramming and build damage really hurt; HP is gated per phase.
 * Explicit state machine: INTRO → PHASE_START → ACTIVE ⇄ TELEGRAPH → ATTACK → … → BREAK → VULNERABLE → RECOVER/PHASE_COMPLETE → … → DEFEATED.
 */
export abstract class BossController {
  state: BossState = 'INTRO';
  stateT = 0;
  phase = 1;
  t = 0;
  stability = 100;
  readonly stabMax = 100;
  vulnT = 0;
  vulnMax = 4;
  ramMul = 1;
  wallMul = 1;
  raceMode = false;
  vehicle: AIVehicle;
  attackCd = 3;
  objective = '';
  protected rng: Random;
  protected diff: number;
  private slotTele: Telegraph | null = null;
  private pieceN = 0;
  /** its own lights and living effects (bossRig.ts) */
  /** its light rig (VFX only) */
  readonly rig: BossRig;

  constructor(public def: BossDef, public sess: DrivingSession, diff: number) {
    this.diff = diff;
    this.rng = new Random((sess.config.seed ^ 0xb055) >>> 0);
    const model = buildCar(def.model, { color: def.color, accent: def.accent, beams: true });
    applyBossPresence(model, def.accent);
    this.rig = buildBossRig(def.id, model, sess.fx);
    this.vehicle = new AIVehicle('boss', def.id, model, { hp: def.hp * (1 + diff * 0.15), mass: def.mass, length: def.length, width: def.width, topSpeed: def.speed, accel: def.accel });
    this.vehicle.boss = this;
    this.vehicle.grip = 8;
    this.vehicle.cornerGrip = def.cornerGrip;
    this.vulnMax = clamp(4.6 - diff * 0.35, 3, 5);
  }

  // ---------------------------------------------------------------- framework

  get defeated() {
    return this.vehicle.dead;
  }
  get hpFrac() {
    return this.vehicle.hp / this.vehicle.maxHp;
  }
  get chunk() {
    return this.vehicle.maxHp / PHASES;
  }
  /** HP can't drop below the end of the current phase until that phase is earned. */
  get floor() {
    return this.phase >= PHASES ? 0 : this.vehicle.maxHp - this.chunk * this.phase;
  }
  get open() {
    return this.state === 'VULNERABLE' || this.state === 'BREAK';
  }

  /** Damage gating: outside a vulnerability window, almost nothing gets through. */
  damageMul(kind: string, amount: number): number {
    let mul: number;
    if (this.open) {
      if (kind === 'ram' || kind === 'collision') mul = (this.chunk * 0.36) / 37;
      // the crash that caused the break already paid out; only later wall hits count
      else if (kind === 'wall') mul = this.state === 'VULNERABLE' ? 1.2 : 0;
      else mul = this.chunk * 0.011;
    } else mul = kind === 'ram' ? 0.03 : 0;
    const room = Math.max(0, this.vehicle.hp - this.floor - (this.phase >= PHASES ? 0 : 0.01));
    return Math.min(mul, room / Math.max(0.001, amount));
  }

  /** The mechanic was solved (or partly): knock stability down. */
  hitStability(amount: number, reason: string) {
    if (!(this.state === 'ACTIVE' || this.state === 'TELEGRAPH' || this.state === 'ATTACK')) return;
    this.stability = Math.max(0, this.stability - amount);
    const s = this.sess;
    s.popup(`${reason} · STABILITY -${Math.round(amount)}`, '#ffd23a');
    s.addCombo(1, 'boss');
    s.addMomentum(8);
    s.cam.addTrauma(0.25);
    if (this.stability <= 0) this.enterBreak(reason);
  }

  protected restoreStability(amount: number) {
    this.stability = Math.min(this.stabMax, this.stability + amount);
  }

  private enterBreak(reason: string) {
    const s = this.sess;
    const v = this.vehicle;
    this.cancelAttack();
    this.set('BREAK', 0.9);
    // the mechanic itself hurts: a guaranteed slice of the phase
    v.hp = Math.max(this.phase >= PHASES ? 1 : this.floor, v.hp - this.chunk * 0.3);
    v.flash = 1;
    v.stunT = 0;
    s.notify(`${this.def.name} BROKEN — ${reason}`, '#ffffff', true);
    s.slowMo(0.45, 0.35);
    s.hitStop(0.08);
    s.audio.heavyImpact();
    s.audio.shockwave();
    s.fx.explosion(v.pos.x, v.pos.y + 1, v.pos.z, 5, 0xffd060);
    s.fx.debrisBurst(v.pos.x, 1.5, v.pos.z, 24, this.def.accent, 10);
    s.fx.shock(v.pos.x, 0, v.pos.z, 11, 0xfff0d0);
    s.cam.addTrauma(0.5);
    s.addScore(800);
    this.onBreak();
  }

  protected set(state: BossState, t: number) {
    this.state = state;
    this.stateT = t;
  }

  /** Begin a telegraphed attack. The subclass draws the warning; the framework times it. */
  protected telegraph(dur: number) {
    this.set('TELEGRAPH', dur * clamp(1.1 - this.diff * 0.08 - (this.phase - 1) * 0.08, 0.7, 1.1));
    this.sess.audio.telegraph();
  }
  protected endAttack(cd: number) {
    this.vehicle.ai.state = 'idle';
    this.attackCd = cd * clamp(1.05 - this.diff * 0.08, 0.7, 1.05);
    this.set('ACTIVE', 0);
  }
  protected cancelAttack() {
    this.vehicle.ai.state = 'idle';
  }

  enter() {
    this.set('INTRO', 0);
    this.place();
  }

  update(dt: number) {
    this.t += dt;
    this.stateT -= dt;
    const v = this.vehicle;
    const s = this.sess;
    if (!this.raceMode) this.leash();
    switch (this.state) {
      case 'INTRO':
        this.cruise(dt);
        if (s.bossIntroT > 0) break;
        this.set('PHASE_START', 1.4);
        s.notify(`PHASE ${this.phase} — ${this.def.phaseNames[this.phase - 1]}`, '#' + this.def.accent.toString(16).padStart(6, '0'), true);
        this.stability = this.stabMax;
        this.onPhaseStart();
        break;
      case 'PHASE_START':
        this.cruise(dt);
        if (this.stateT <= 0) this.set('ACTIVE', 0);
        break;
      case 'ACTIVE':
      case 'TELEGRAPH':
      case 'ATTACK':
        this.attackCd -= dt;
        this.think(dt);
        break;
      case 'BREAK':
        v.targetSpeed = Math.max(0, v.vF - 30 * dt);
        v.yawRate += Math.sin(this.t * 20) * 0.4 * dt;
        if (Math.random() < 0.5) s.fx.sparks(v.pos.x, 1, v.pos.z, 3, 0xffd060, 6);
        if (this.stateT <= 0) {
          this.set('VULNERABLE', this.vulnMax);
          this.vulnT = this.vulnMax;
          v.setMarker('exposed');
          this.slotTele = s.tele.follow(s.tele.circle(v.pos.x, v.pos.z, v.length * 0.75, 0xffffff, this.vulnMax, 0.5), v.pos);
          s.hint('VULNERABLE — RAM IT NOW (SIDE HITS COUNT MOST)', 'boss_vuln');
        }
        break;
      case 'VULNERABLE': {
        // the window only really runs while the boss is within reach
        const far = Math.abs(v.s - s.player.s) > 22;
        if (far) this.stateT += dt * 0.8;
        v.accel = far ? Math.max(this.def.accel, 26) : this.def.accel;
        this.vulnT = this.stateT;
        this.present(dt);
        if (Math.random() < 0.3) s.fx.smokePuff(v.pos.x, v.pos.y + 1.5, v.pos.z, 1, true, 0.8);
        if (v.hp <= this.floor + 0.5 && this.phase < PHASES) this.completePhase();
        else if (this.stateT <= 0) {
          this.set('RECOVER', 1);
          this.clearSlot();
          v.setMarker(null);
          this.stability = this.stabMax * 0.8;
          v.accel = this.def.accel;
          s.notify(`${this.def.name} RECOVERS`, '#ff8060');
        }
        break;
      }
      case 'RECOVER':
        this.cruise(dt);
        if (this.stateT <= 0) this.endAttack(2);
        break;
      case 'PHASE_COMPLETE':
        this.cruise(dt);
        if (this.stateT <= 0) {
          this.phase++;
          this.stability = this.stabMax;
          this.set('PHASE_START', 1.6);
          s.notify(`PHASE ${this.phase} — ${this.def.phaseNames[this.phase - 1]}`, '#ff4060', true);
          s.audio.bossAlert();
          s.cam.addTrauma(0.3);
          this.onPhaseStart();
          if (this.diff >= 2) {
            s.spawnEnemyAt('hunter', s.player.s - 40, 0, s.player.vF + 6, true);
            s.spawnEnemyAt('interceptor', s.player.s + 45, 0, s.player.vF * 0.8);
          }
        }
        break;
      case 'DEFEATED':
        break;
    }
    this.objective = this.computeObjective();
    if (!v.dead) this.rig.update(this.t, dt, this.state, v.pos, v.yaw);
  }

  private completePhase() {
    const s = this.sess;
    this.vehicle.accel = this.def.accel;
    this.clearSlot();
    this.vehicle.setMarker(null);
    this.set('PHASE_COMPLETE', 1.8);
    s.notify(`PHASE ${this.phase} CLEAR`, '#ffd000', true);
    s.addScore(1500);
    s.addCredits(10);
    s.heal(s.player.maxHp * 0.15);
    s.popup('+15% HULL', '#7dff7d');
    s.audio.item();
  }

  private clearSlot() {
    this.slotTele?.kill();
    this.slotTele = null;
  }

  /** Vulnerable: limp alongside the player so a clean side ram is possible. */
  protected present(_dt: number) {
    const v = this.vehicle;
    const p = this.sess.player;
    const w = this.w;
    const side = p.d > 0 ? -1 : 1;
    v.targetD = clamp(p.d + side * 4, -w / 2 + v.width / 2 + 0.6, w / 2 - v.width / 2 - 0.6);
    // it comes to you: a wounded boss limps up alongside, then drifts past slowly
    const rel = v.s - p.s;
    v.targetSpeed = rel < -10 ? Math.max(28, p.vF + 20) : rel < 3 ? Math.max(12, p.vF + 5) : rel < 12 ? Math.max(8, p.vF - 7) : Math.max(6, p.vF - 22);
  }

  /** Neutral driving between attacks (phase start, recover). */
  protected cruise(_dt: number) {
    this.follow(-18);
  }

  /** Keep the fight on screen: a boss that falls far out of play re-enters just out of view. */
  protected leash() {
    const v = this.vehicle;
    const p = this.p;
    const rel = v.s - p.s;
    const road = this.sess.world.road;
    const w = this.w;
    if (rel < -95) v.place(road, Math.max(this.sess.world.minS + 5, p.s - 45), clamp(v.d, -w / 2 + 2, w / 2 - 2), p.vF + 6);
    else if (rel > 170) v.place(road, p.s + 70, clamp(v.d, -w / 2 + 2, w / 2 - 2), p.vF * 0.9);
  }

  /** Boss road: wide arenas by default; bosses that need specific geometry override. */
  nextPiece(): Piece | null {
    this.pieceN++;
    const n = this.pieceN;
    const w = Math.max(14, this.sess.zone.baseWidth + 3);
    if (n === 1) return { type: 'STRAIGHT', opts: { length: 260, width: w } };
    const type: SegmentType = this.rng.pick(['STRAIGHT', 'STRAIGHT', 'CURVE'] as SegmentType[]);
    return { type, opts: { length: this.rng.range(180, 260), width: w, bend: 0.0015 } };
  }

  // ---------------------------------------------------------------- hooks
  protected abstract think(dt: number): void;
  protected abstract place(): void;
  protected abstract activeObjective(): string;
  protected onPhaseStart() {}
  protected onBreak() {}
  onWall(_impact: number) {}
  onRammed(_v: AIVehicle, _kind: string, _impact: number, _perfect: boolean) {}
  onDrift(_duration: number, _perfect: boolean) {}
  onNearMiss(_tier: number) {}
  onPlayerCrash() {}

  private computeObjective() {
    switch (this.state) {
      case 'BREAK':
      case 'VULNERABLE':
        return `RAM IT! ${Math.max(0, this.vulnT).toFixed(1)}s`;
      case 'PHASE_COMPLETE':
        return 'PHASE CLEAR';
      case 'RECOVER':
        return 'IT RECOVERED — DO IT AGAIN';
      case 'PHASE_START':
      case 'INTRO':
        return this.def.phaseNames[this.phase - 1];
      default:
        return this.activeObjective();
    }
  }

  hud(): BossHud {
    return {
      name: this.def.name,
      title: this.def.title,
      hp: this.hpFrac,
      phase: this.phase,
      phases: PHASES,
      stability: this.stability / this.stabMax,
      state: this.state,
      vuln: this.state === 'VULNERABLE' ? this.vulnT / this.vulnMax : 0,
      objective: this.objective,
      race: this.raceHud(),
      prompt: this.promptHud(),
    };
  }
  protected raceHud(): BossHud['race'] {
    return null;
  }
  protected promptHud(): BossHud['prompt'] {
    return null;
  }

  // ---------------------------------------------------------------- helpers
  protected get p() {
    return this.sess.player;
  }
  protected get w() {
    return this.sess.world.road.at(this.vehicle.s).width;
  }
  /** Hold a gap to the player: rel = boss.s - player.s */
  protected follow(rel: number, extra = 0) {
    const v = this.vehicle;
    const pv = Math.max(15, this.p.vF);
    v.targetSpeed = clamp(pv + (rel - (v.s - this.p.s)) * 0.9 + extra, 0, v.topSpeed * 1.35);
  }
  protected snapLane(d: number, s = this.vehicle.s) {
    const w = this.sess.world.road.at(s).width;
    const n = lanesFor(w);
    let best = 0, bd = 99;
    for (let l = 0; l < n; l++) {
      const dd = Math.abs(laneOffset(w, l) - d);
      if (dd < bd) {
        bd = dd;
        best = l;
      }
    }
    return { lane: best, d: laneOffset(w, best), n, w };
  }
  protected worldAt(s: number, d: number) {
    const o = { x: 0, y: 0, z: 0 };
    this.sess.world.road.toWorld(s, d, o);
    return o;
  }
}

// =====================================================================================
// IRON MULE — lure its charge into the anvils
// =====================================================================================
class IronMule extends BossController {
  private lockD = 0;
  private laneTele: Telegraph | null = null;
  private teleD = 99;
  private anvils: { prop: Prop; s: number; d: number; tele: Telegraph }[] = [];
  private nextAnvilS = 0;
  private hitAnvil = false;
  private dropT = 0;

  protected place() {
    const p = this.p;
    this.vehicle.place(this.sess.world.road, p.s - 45, 0, p.vF + 4);
    this.nextAnvilS = p.s + 140;
  }

  protected onPhaseStart() {
    if (this.phase === 3) {
      this.sess.spawnEnemyAt('rammer', this.p.s + 50, -3, this.p.vF * 0.8);
      this.sess.spawnEnemyAt('rammer', this.p.s - 35, 3, this.p.vF + 5);
    }
  }

  protected activeObjective() {
    if (this.state === 'TELEGRAPH') return 'IT LOCKS YOUR LANE — GET AN ANVIL AHEAD OF YOU';
    if (this.state === 'ATTACK') return 'DODGE LATE!';
    return 'LURE THE CHARGE INTO AN ANVIL';
  }

  /** Anvils: heavy blocks in random lanes ahead, marked in orange. */
  private keepAnvils() {
    const s = this.sess;
    const p = this.p;
    for (const a of this.anvils) if (!a.prop.alive) a.tele.kill();
    this.anvils = this.anvils.filter((a) => a.prop.alive && a.s > p.s - 60);
    while (this.nextAnvilS < p.s + 260) {
      const sAt = this.nextAnvilS;
      const w = s.world.road.at(sAt).width;
      const n = lanesFor(w);
      const lanes = this.rng.shuffle([...Array(n).keys()]).slice(0, this.phase >= 2 ? 2 : 1);
      for (const l of lanes) {
        const d = s.world.safeD(sAt, laneOffset(w, l));
        const prop = s.world.spawnProp('block', sAt, d);
        if (!prop) continue;
        prop.cushion = true;
        // hazard-striped and chest-high: an anvil should read as an anvil from far away
        (prop.mesh as import('three').Mesh).material = s.world.getMat('stripe');
        prop.mesh.scale.set(2.5, 1.7, 1.4);
        const o = this.worldAt(sAt, d);
        const tele = s.tele.circle(o.x, o.z, 2.6, 0xff8a1a, 60, 0.55);
        s.markHazard('anvil', o.x, o.z, sAt, prop);
        this.anvils.push({ prop, s: sAt, d, tele });
      }
      this.nextAnvilS += this.rng.range(110, 150);
    }
  }

  private anvilAhead(d: number, from: number, to: number) {
    return this.anvils.some((a) => a.s > from && a.s < to && Math.abs(a.d - d) < 2.2);
  }

  protected think(dt: number) {
    const v = this.vehicle;
    const p = this.p;
    const s = this.sess;
    this.keepAnvils();
    if (this.state === 'ACTIVE') {
      // shadow the player from behind, never parking on an anvil line
      this.follow(-24);
      let d = p.d + Math.sin(this.t * 0.7) * 2;
      if (this.anvilAhead(this.snapLane(d).d, v.s, v.s + 60)) d = -d;
      v.targetD = d;
      // phase 2: when it ends up in front it spills cargo behind it
      if (this.phase >= 2 && v.s > p.s + 8) {
        this.dropT -= dt;
        if (this.dropT <= 0) {
          this.dropT = 1.2;
          const o = this.worldAt(v.s - v.length * 0.6, v.d);
          s.tele.circle(o.x, o.z, 3, 0xff3020, 0.8);
          s.world.spawnProp('xbarrel', v.s - v.length * 0.6, v.d);
        }
      }
      if (this.attackCd <= 0 && v.s < p.s - 10) {
        this.telegraph(1.5);
        this.teleD = 99;
        s.notify('IRON MULE LOCKING ON', '#ff8a1a');
      }
    } else if (this.state === 'TELEGRAPH') {
      // it tracks your lane until the last instant, then commits
      this.follow(-22);
      const lane = this.snapLane(p.d, p.s);
      v.targetD = lane.d;
      if (Math.abs(lane.d - this.teleD) > 0.5) {
        this.laneTele?.kill();
        this.teleD = lane.d;
        this.laneTele = s.tele.lane(v.s, p.s + 90, lane.d, 3.4, 0xff4020, this.stateT + 0.2, 0.45);
        if (this.anvilAhead(lane.d, p.s + 10, p.s + 140)) s.popup('ANVIL AHEAD — HOLD…', '#ff8a1a');
      }
      if (this.stateT <= 0) {
        this.lockD = lane.d;
        this.hitAnvil = false;
        this.set('ATTACK', 3.2);
        v.ai.state = 'charge';
        s.audio.warning();
        s.cam.addTrauma(0.15);
        s.notify('CHARGE!', '#ff4020', true);
      }
    } else if (this.state === 'ATTACK') {
      v.targetD = this.lockD;
      v.targetSpeed = Math.min(72, p.vF + 22 + this.phase * 2);
      if (Math.random() < 0.6) s.fx.sparks(v.pos.x, 0.4, v.pos.z, 2, 0xff8a1a, 4);
      // phase 3: a second, shorter charge right after the first
      const passed = v.s > p.s + 30;
      if (this.stateT <= 0 || passed || this.hitAnvil) {
        this.laneTele?.kill();
        if (!this.hitAnvil && this.phase >= 3 && this.rng.chance(0.5)) {
          this.telegraph(0.9);
          this.teleD = 99;
        } else this.endAttack(this.rng.range(3, 4.5));
      }
    }
  }

  onWall(impact: number) {
    if (impact < 12) return;
    const charging = this.state === 'ATTACK';
    const s = this.sess;
    if (charging) {
      this.hitAnvil = true;
      // the anvil shatters: the Mule is free to limp on (and come to you)
      const v = this.vehicle;
      const a = this.anvils.find((x) => x.prop.alive && Math.hypot(x.prop.x - v.pos.x, x.prop.z - v.pos.z) < v.length * 0.6 + 3);
      if (a) {
        s.world.destroyProp(a.prop);
        a.tele.kill();
        s.fx.debrisBurst(a.prop.x, 1, a.prop.z, 30, 0x9a9a9a, 12);
        s.fx.smokePuff(a.prop.x, 1, a.prop.z, 10, false, 1.4);
      }
      this.vehicle.stun(1.2);
      this.hitStability(this.phase === 1 ? 100 : 65, 'ANVIL STRIKE');
    } else this.hitStability(clamp(impact * 0.9, 12, 35), 'SLAMMED');
    s.fx.sparks(this.vehicle.pos.x, 1, this.vehicle.pos.z, 30, 0xffb060, 10);
  }

  onRammed(v: AIVehicle, kind: string, impact: number, _perfect: boolean) {
    if (v !== this.vehicle || this.open) return;
    // heavy side rams shove it sideways: push it into the barrier or an anvil
    if (kind === 'SIDE' && impact > 14) {
      const p = this.p;
      const dx = v.pos.x - p.pos.x, dz = v.pos.z - p.pos.z;
      const dl = Math.hypot(dx, dz) || 1;
      v.velX += (dx / dl) * impact * 0.55;
      v.velZ += (dz / dl) * impact * 0.55;
      this.sess.popup('SHOVE IT INTO THE WALL', '#ffb060');
    }
  }
}

// =====================================================================================
// DROWNED LINE — herd the bus into electrified water
// =====================================================================================
interface Pool {
  s: number;
  d: number;
  x: number;
  z: number;
  r: number;
  warn: number;
  live: number;
  used: boolean;
  tele: Telegraph | null;
}

class DrownedLine extends BossController {
  private pools: Pool[] = [];
  private nextPoolS = 0;
  private laneD = 0;
  private laneT = 0;
  private strikeD = 0;

  protected place() {
    const p = this.p;
    this.vehicle.place(this.sess.world.road, p.s + 40, 0, p.vF);
    this.nextPoolS = p.s + 160;
  }

  protected activeObjective() {
    if (this.pools.some((q) => q.warn > 0 || q.live > 0)) return 'PYLONS CHARGING — BLOCK ITS ESCAPE LANE';
    return 'HERD THE BUS TOWARD THE FLOODED LANE';
  }

  protected onPhaseStart() {
    if (this.phase >= 2) {
      const p = this.p;
      this.sess.spawnEnemyAt('drone', p.s + 30, -3, p.vF);
      if (this.phase >= 3) this.sess.spawnEnemyAt('drone', p.s - 10, 3, p.vF);
    }
  }

  private keepPools() {
    const s = this.sess;
    const p = this.p;
    this.pools = this.pools.filter((q) => q.s > p.s - 80);
    while (this.nextPoolS < p.s + 300) {
      const sAt = this.nextPoolS;
      const w = s.world.road.at(sAt).width;
      const n = lanesFor(w);
      const count = this.phase >= 3 ? 2 : 1;
      const lanes = this.rng.shuffle([...Array(n).keys()]).slice(0, Math.min(count, n - 1));
      for (const l of lanes) {
        const d = s.world.safeD(sAt, laneOffset(w, l));
        const o = this.worldAt(sAt, d);
        s.combat.addHazard('water', o.x, o.z, 4.6, 120, 0, false);
        this.pools.push({ s: sAt, d, x: o.x, z: o.z, r: 4.6, warn: 0, live: 0, used: false, tele: null });
      }
      this.nextPoolS += this.rng.range(150, 200);
    }
    for (const q of this.pools) {
      const busGap = q.s - this.vehicle.s;
      if (!q.used && q.warn <= 0 && q.live <= 0 && busGap > 0 && busGap < 60) {
        q.warn = 1;
        q.tele = s.tele.circle(q.x, q.z, q.r + 0.6, 0x40f0ff, 1 + 2.6, 0.7);
        s.audio.telegraph();
      }
    }
  }

  private updatePools(dt: number) {
    const s = this.sess;
    const v = this.vehicle;
    for (const q of this.pools) {
      if (q.warn > 0) {
        q.warn -= dt;
        if (q.warn <= 0) {
          q.live = 2.6;
          s.combat.addHazard('electric', q.x, q.z, q.r, 2.6, 16, false);
          s.fx.bolt(q.x + 6, 14, q.z, q.x, 0.3, q.z, 0x40ffff);
          s.fx.bolt(q.x - 6, 14, q.z, q.x, 0.3, q.z, 0x40ffff);
          s.audio.zap();
        }
      } else if (q.live > 0) {
        q.live -= dt;
        if (Math.random() < 0.4) s.fx.electric(q.x + frand(-q.r, q.r) * 0.6, 0.4, q.z + frand(-q.r, q.r) * 0.6, 2, 0x40ffff);
        if (!q.used && Math.hypot(v.pos.x - q.x, v.pos.z - q.z) < q.r + v.width * 0.5) {
          q.used = true;
          v.stun(1.5);
          s.fx.electric(v.pos.x, 2, v.pos.z, 50, 0x40ffff);
          s.fx.bolt(q.x, 0.3, q.z, v.pos.x, 3, v.pos.z, 0xffffff);
          this.hitStability(this.phase === 1 ? 100 : 60, 'SHORT-CIRCUIT');
        }
        if (q.live <= 0) q.used = true;
      }
    }
  }

  /** The bus avoids charged water — unless you take the other lanes away from it. */
  private chooseLane() {
    const v = this.vehicle;
    const p = this.p;
    const w = this.w;
    const n = lanesFor(w);
    const cur = this.snapLane(v.d).lane;
    let best = cur, bestScore = -1e9;
    for (let l = 0; l < n; l++) {
      const d = laneOffset(w, l);
      let score = -Math.abs(l - cur) * 2;
      for (const q of this.pools) {
        const ahead = q.s - v.s;
        if (ahead > -2 && ahead < 70 && (q.warn > 0 || q.live > 0) && Math.abs(q.d - d) < 3) score -= 40;
      }
      // the player physically blocks a lane when alongside or just ahead
      const rel = p.s - v.s;
      if (rel > -v.length * 0.7 && rel < 16 && Math.abs(p.d - d) < 2.8) score -= 60;
      // it can only move one lane at a time past the player
      if (Math.abs(l - cur) > 1 && rel > -v.length && rel < 10) score -= 30;
      if (score > bestScore) {
        bestScore = score;
        best = l;
      }
    }
    return laneOffset(w, best);
  }

  protected think(dt: number) {
    const v = this.vehicle;
    const p = this.p;
    const s = this.sess;
    this.keepPools();
    this.updatePools(dt);
    this.laneT -= dt;
    if (this.laneT <= 0) {
      this.laneT = 0.25;
      this.laneD = this.chooseLane();
    }
    if (v.stunT <= 0) v.targetD = this.laneD;
    if (this.state === 'ACTIVE') {
      this.follow(14);
      if (this.attackCd <= 0) {
        this.telegraph(1.3);
        this.strikeD = this.snapLane(p.d, p.s).d;
        if (this.phase >= 2) {
          s.tele.lane(p.s + 10, p.s + 90, this.strikeD, 3.4, 0x40f0ff, this.stateT, 0.5);
          s.notify('DISCHARGE', '#40f0ff');
        } else {
          const o = this.worldAt(v.s - v.length, v.d);
          s.tele.circle(o.x, o.z, 4, 0x40a0ff, this.stateT, 0.5);
          s.notify('THE BUS BRAKES', '#40a0ff');
        }
      }
    } else if (this.state === 'TELEGRAPH') {
      this.follow(14);
      if (this.stateT <= 0) {
        this.set('ATTACK', this.phase >= 2 ? 0.6 : 1.4);
        if (this.phase >= 2) {
          for (let i = 0; i < 4; i++) {
            const sAt = p.s + 20 + i * 18;
            s.combat.schedule(i * 0.12, () => {
              const o = this.worldAt(sAt, this.strikeD);
              s.combat.strike(o.x, o.z, 2.6, 9);
            });
          }
        }
      }
    } else if (this.state === 'ATTACK') {
      if (this.phase >= 2) this.follow(14);
      else {
        // brake check + wake: slippery water behind it
        v.targetSpeed = Math.max(8, p.vF - 18);
        if (Math.random() < dt * 8) {
          const o = this.worldAt(v.s - v.length * 0.7, v.d + frand(-2, 2));
          s.combat.addHazard('water', o.x, o.z, 3, 6, 0, false);
        }
      }
      if (this.stateT <= 0) this.endAttack(this.rng.range(3.5, 5));
    }
  }

  onRammed(v: AIVehicle, kind: string, impact: number, _perfect: boolean) {
    if (v !== this.vehicle || this.open) return;
    if ((kind === 'SIDE' || kind === 'GLANCE') && impact > 8) {
      // shoulder it over: the bus yields a lane away from you
      const p = this.p;
      const away = Math.sign(v.d - p.d) || 1;
      const w = this.w;
      this.laneD = clamp(this.snapLane(v.d).d + away * (w / lanesFor(w)), -w / 2 + 2, w / 2 - 2);
      this.laneT = 1.2;
      this.sess.popup('SHOULDERED', '#40f0ff');
    }
  }
}

// =====================================================================================
// TAXON — it strikes where it predicts you will be; feint it
// =====================================================================================
class Taxon extends BossController {
  private lockD: number[] = [];
  private teles: Telegraph[] = [];
  private dodges = { left: 0, right: 0 };
  private contact = false;
  private lastLane = 0;
  private relocks = 0;
  private readonly FEINT = 0.65;

  protected place() {
    const p = this.p;
    this.vehicle.place(this.sess.world.road, p.s - 30, -3, p.vF + 5);
  }

  protected activeObjective() {
    if (this.state === 'TELEGRAPH') return this.stateT > this.FEINT ? 'HOLD THE PREDICTED LANE…' : 'NOW — SWITCH LANES!';
    if (this.state === 'ATTACK') return 'FEINT!';
    return this.phase >= 2 ? 'IT LEARNED YOUR DODGE — SWITCH THE OTHER WAY' : 'LET IT PREDICT YOU — THEN FEINT';
  }

  private drawLocks(dur: number) {
    for (const t of this.teles) t.kill();
    const p = this.p;
    this.teles = this.lockD.map((d) => this.sess.tele.lane(p.s + 4, p.s + 80, d, 3.4, 0x3060ff, dur, 0.55));
  }

  private predict() {
    const p = this.p;
    const lane = this.snapLane(p.d, p.s);
    this.lastLane = lane.lane;
    this.lockD = [lane.d];
    // after phase 1 it also covers your favourite dodge
    if (this.phase >= 2 && lane.n > 2) {
      const dir = this.dodges.right > this.dodges.left ? 1 : -1;
      let l2 = lane.lane + dir;
      if (l2 < 0 || l2 >= lane.n) l2 = lane.lane - dir;
      this.lockD.push(laneOffset(lane.w, l2));
      this.sess.popup(`PATTERN: YOU DODGE ${dir > 0 ? 'RIGHT' : 'LEFT'}`, '#5080ff');
    }
  }

  protected think(_dt: number) {
    const v = this.vehicle;
    const p = this.p;
    const s = this.sess;
    if (this.state === 'ACTIVE') {
      this.follow(-16);
      v.targetD = p.d + (Math.sin(this.t) > 0 ? 3.5 : -3.5);
      if (this.attackCd <= 0) {
        this.predict();
        this.relocks = 0;
        this.telegraph(2.2);
        this.drawLocks(this.stateT + 1.6);
        s.notify('PREDICTION LOCKED', '#3060ff');
      }
    } else if (this.state === 'TELEGRAPH') {
      this.follow(-14);
      v.targetD = this.lockD[0];
      const lane = this.snapLane(p.d, p.s);
      if (lane.lane !== this.lastLane) {
        const dir = lane.lane > this.lastLane ? 1 : -1;
        if (this.stateT > this.FEINT && this.relocks < 3) {
          // too early: it simply re-predicts
          this.relocks++;
          if (dir > 0) this.dodges.right++;
          else this.dodges.left++;
          this.predict();
          this.stateT = Math.max(this.stateT, this.FEINT + 0.5);
          this.drawLocks(this.stateT + 1.6);
          s.popup('TOO EARLY — RE-PREDICTED', '#ff6060');
        }
        this.lastLane = lane.lane;
      }
      if (this.stateT <= 0) {
        this.set('ATTACK', 1.8);
        this.contact = false;
        v.ai.state = 'charge';
        // it commits to the lane you held at lock time
        const pl = this.snapLane(p.d, p.s).d;
        v.targetD = this.lockD.reduce((a, b) => (Math.abs(b - pl) < Math.abs(a - pl) ? b : a), this.lockD[0]);
        s.audio.warning();
        // phase 3: spikes in a lane it doesn't strike, so a feint needs a plan
        if (this.phase >= 3) {
          const w = s.world.road.at(p.s + 60).width;
          const n = lanesFor(w);
          const free = [...Array(n).keys()].map((l) => laneOffset(w, l)).filter((d) => !this.lockD.some((x) => Math.abs(x - d) < 1));
          if (free.length > 1) {
            const d = free[this.rng.int(0, free.length - 1)];
            const o = this.worldAt(p.s + 70, d);
            s.tele.circle(o.x, o.z, 2.6, 0xff3040, 2);
            s.combat.schedule(0.6, () => s.combat.addHazard('spikes', o.x, o.z, 2.4, 8, 0, false));
          }
        }
      }
    } else if (this.state === 'ATTACK') {
      v.targetSpeed = Math.min(80, p.vF + 30);
      if (Math.random() < 0.6) s.fx.trail(v.pos.x, 0.8, v.pos.z, 0x3060ff, 0.8, 0.3);
      const passed = v.s > p.s + 6;
      if (this.contact) {
        for (const t of this.teles) t.kill();
        this.endAttack(3);
      } else if (passed) {
        for (const t of this.teles) t.kill();
        v.stun(1);
        v.targetSpeed = p.vF - 12;
        this.hitStability(this.phase === 1 ? 100 : 55, 'MISPREDICTED');
        s.fx.sparks(v.pos.x, 0.6, v.pos.z, 20, 0x80a0ff, 8);
        if (this.state === 'ATTACK') this.endAttack(2.6);
      } else if (this.stateT <= 0) {
        for (const t of this.teles) t.kill();
        this.endAttack(2.5);
      }
    }
  }

  onRammed(v: AIVehicle, _kind: string, _impact: number, _perfect: boolean) {
    if (v !== this.vehicle) return;
    if (this.state === 'ATTACK') {
      this.contact = true;
      this.sess.combat.damagePlayer(10, 'collision', v.pos.x, v.pos.z);
      this.sess.popup('PREDICTED', '#ff4060');
    }
  }

  nextPiece(): Piece | null {
    const pc = super.nextPiece();
    if (pc) pc.opts.width = Math.max(15.5, pc.opts.width ?? 0);
    return pc;
  }
}

// =====================================================================================
// APEX — a real race: sectors, position, and a rival that cracks when you lead
// =====================================================================================
class Apex extends BossController {
  raceMode = true;
  private gates: { s: number; signed: boolean; done: boolean; apexFirst: boolean }[] = [];
  private sector = 0;
  private lungeSide = 1;
  private pieces: Piece[] = [];
  private mineT = 0;
  /** builds up while it carries too much speed into corners; at 1 it loses the car */
  risk = 0;

  protected place() {
    const p = this.p;
    const w = this.w;
    this.vehicle.place(this.sess.world.road, p.s + 2, p.d > 0 ? -w / 4 : w / 4, p.vF);
    const s0 = p.s + 120;
    for (let i = 1; i <= 30; i++) this.gates.push({ s: s0 + i * 420, signed: false, done: false, apexFirst: false });
  }

  protected activeObjective() {
    if (this.state === 'TELEGRAPH') return 'IT WILL DIVE — BLOCK OR LET IT CRASH';
    const lead = this.p.s > this.vehicle.s;
    return lead ? 'YOU LEAD — HOLD THE LINE TO THE GATE' : 'OVERTAKE BEFORE THE SECTOR GATE';
  }

  protected raceHud(): BossHud['race'] {
    const gap = this.p.s - this.vehicle.s;
    return { pos: gap >= 0 ? 1 : 2, gap, sector: this.sector, sectors: 0 };
  }

  nextPiece(): Piece | null {
    if (!this.pieces.length) {
      const w = 13.5;
      const r = this.rng;
      this.pieces.push(
        { type: 'STRAIGHT', opts: { length: r.range(140, 200), width: w } },
        { type: r.pick(['TURN_SHARP', 'CHICANE', 'CURVE'] as SegmentType[]), opts: { width: w } },
        { type: 'STRAIGHT', opts: { length: r.range(90, 140), width: w } },
        { type: r.pick(['S_CURVE', 'TURN_SHARP'] as SegmentType[]), opts: { width: w } },
      );
      // occasionally a split: the inside line is shorter but marked dangerous
      if (r.chance(0.5)) this.pieces.push({ type: 'STRAIGHT', opts: { length: 160, width: 17, split: { from: 30, to: 130, medianD: 2.5, medianW: 1.2, markL: MARK.SHORTCUT, markR: MARK.NORMAL } } });
    }
    return this.pieces.shift()!;
  }

  private sign() {
    const s = this.sess;
    for (const g of this.gates) {
      if (g.signed || g.s > s.world.road.endS - 5) continue;
      g.signed = true;
      s.world.addSign(g.s, `SECTOR ${this.gates.indexOf(g) + 1}`, 0x40ffd0, 'gantry', 'LEAD THROUGH THE GATE');
    }
  }

  protected think(dt: number) {
    const v = this.vehicle;
    const p = this.p;
    const s = this.sess;
    this.sign();
    const gap = p.s - v.s; // >0: player leads
    // pace: a real rival — fast, but never hopelessly far
    const base = p.stats.maxSpeed * (0.97 + this.phase * 0.02 + this.diff * 0.01);
    let tgt = base;
    if (gap > 45) tgt *= 1.12;
    else if (gap < -100) tgt *= 0.75;
    else if (gap < -45) tgt *= 0.86;
    // leading, it drives clean; chasing you, it overcommits every corner — and that's how it crashes
    v.cornerGrip = gap > 0 ? this.def.cornerGrip + 7 + this.phase * 2 : this.def.cornerGrip - 3;
    const safe = cornerSpeed(s.world.road, v.s, 22, this.def.cornerGrip + 2);
    if (v.vF > safe * 1.06 && v.stunT <= 0) {
      this.risk += dt * (v.vF / safe - 1) * 6;
      if (Math.random() < 0.3) s.fx.tireSmoke(v.pos.x, v.pos.z, v.velX, v.velZ, 0.8, 0x9098a8);
    } else this.risk = Math.max(0, this.risk - dt * 0.5);
    if (this.risk >= 1) {
      // it loses the rear: slide toward the outside wall
      this.risk = 0;
      const h0 = s.world.road.at(v.s).heading, h1 = s.world.road.at(v.s + 12).heading;
      const outside = Math.sign(h1 - h0) || 1;
      // +d (road left) in world space is (-cos h, sin h); a turn with rising heading throws you to +d
      const fx = -Math.cos(v.yaw), fz = Math.sin(v.yaw);
      v.velX += fx * outside * 16;
      v.velZ += fz * outside * 16;
      v.spin = 0.9;
      v.yawRate += outside * 2.5;
      s.popup('APEX LOSES IT', '#40ffd0');
    }
    // racing line: stay off the player's lane unless attacking
    const lane = this.snapLane(v.d);
    if (this.state === 'ACTIVE') {
      v.targetSpeed = tgt;
      v.targetD = Math.abs(p.d - lane.d) < 2.5 && Math.abs(gap) < 15 ? lane.d + (lane.d > p.d ? 2 : -2) : lane.d;
      if (gap > 0 && gap < 18 && this.attackCd <= 0) {
        this.lungeSide = p.d > 0 ? -1 : 1;
        this.telegraph(1.1);
        const o = this.worldAt(v.s + 10, p.d + this.lungeSide * 3.5);
        s.tele.arrow(o.x, o.z, s.world.road.at(v.s).heading, 12, 0x40ffd0, this.stateT);
      }
      // leading Apex drops mines behind (phase 2+)
      if (gap < -10 && this.phase >= 2) {
        this.mineT -= dt;
        if (this.mineT <= 0) {
          this.mineT = 2.2;
          const o = this.worldAt(v.s - 4, v.d);
          s.tele.circle(o.x, o.z, 2.6, 0xff3040, 1.2);
          s.combat.schedule(0.5, () => s.combat.addHazard('mine', o.x, o.z, 2.4, 10, 25, false));
        }
      }
    } else if (this.state === 'TELEGRAPH') {
      v.targetSpeed = tgt * 1.05;
      if (this.stateT <= 0) {
        this.set('ATTACK', 1.6);
        v.ai.state = 'charge';
        s.popup('APEX DIVES', '#40ffd0');
      }
    } else if (this.state === 'ATTACK') {
      // the dive: flat out up the inside, ignoring the corner
      v.targetSpeed = tgt * 1.2;
      v.targetD = p.d + this.lungeSide * 3.2;
      if (this.stateT <= 0 || v.s > p.s + 8) this.endAttack(this.rng.range(2.5, 4));
    }
    if (this.phase >= 3 || this.state === 'ATTACK') s.fx.nitro(v.pos.x - Math.sin(v.yaw) * 2.6, v.pos.y + 0.5, v.pos.z - Math.cos(v.yaw) * 2.6, -v.velX * 0.3, -v.velZ * 0.3, 0x40ffd0);
    // sector gates
    for (const g of this.gates) {
      if (g.done) continue;
      if (v.s >= g.s && p.s < g.s) g.apexFirst = true;
      if (p.s >= g.s) {
        g.done = true;
        this.sector++;
        if (!g.apexFirst) {
          s.notify(`SECTOR ${this.sector} — YOU LEAD`, '#40ffd0', true);
          this.hitStability(55, 'SECTOR WON');
        } else {
          s.notify(`SECTOR ${this.sector} — APEX LEADS`, '#ff6060');
          this.restoreStability(15);
          s.addMomentum(-10);
        }
      }
    }
  }

  protected cruise(_dt: number) {
    const v = this.vehicle;
    v.targetSpeed = this.p.stats.maxSpeed * 0.95;
  }

  onWall(impact: number) {
    if (impact < 10) return;
    // crashing while chasing you is the whole point
    const lead = this.p.s > this.vehicle.s;
    this.vehicle.stun(0.8);
    this.hitStability(clamp(impact * (lead ? 2.2 : 1.2), 15, 60), lead ? 'APEX CRASHED CHASING YOU' : 'APEX CLIPPED THE WALL');
  }

  onRammed(v: AIVehicle, _kind: string, _impact: number, _perfect: boolean) {
    if (v !== this.vehicle || this.open) return;
    // fair racing: contact when it dives and you hold your line spins it
    if (this.state === 'ATTACK') {
      v.stun(0.7);
      this.hitStability(25, 'DIVE BLOCKED');
      this.endAttack(3);
    }
  }

  protected leash() {}
}

// =====================================================================================
// THE DRIVER — a duel of calls and answers, shaped by your build
// =====================================================================================
type PromptKind = 'DRIFT' | 'PERFECT' | 'NEAR' | 'RAM' | 'SPEED' | 'CLEAN';
const PROMPT_TEXT: Record<PromptKind, string> = {
  DRIFT: 'DRIFT 1.5 SECONDS',
  PERFECT: 'PERFECT DRIFT EXIT',
  NEAR: 'THREE NEAR MISSES',
  RAM: 'SIDE-RAM ME',
  SPEED: 'HOLD 85% TOP SPEED',
  CLEAN: 'SURVIVE THE STORM — NO CRASHES',
};

class TheDriver extends BossController {
  private prompt: { kind: PromptKind; need: number; got: number; time: number; max: number } | null = null;
  private promptCd = 2;
  private topTag: Tag | null = null;
  private stormT = 0;

  constructor(def: BossDef, sess: DrivingSession, diff: number) {
    super(def, sess, diff);
    const tc = sess.run?.tagCounts() ?? {};
    let best = 0;
    for (const [k, n] of Object.entries(tc)) if ((n ?? 0) > best) {
      best = n ?? 0;
      this.topTag = k as Tag;
    }
  }

  protected place() {
    const p = this.p;
    this.vehicle.place(this.sess.world.road, p.s + 30, 0, p.vF);
  }

  protected onPhaseStart() {
    this.prompt = null;
    this.promptCd = 1.2;
    if (this.phase === 2) this.sess.notify('ZERO MILE DESTABILIZING', '#ff40c0', true);
  }

  protected activeObjective() {
    if (this.prompt) return `ANSWER: ${PROMPT_TEXT[this.prompt.kind]}`;
    if (this.state === 'TELEGRAPH') return 'MOVE OUT OF THE MARKED LANE';
    return 'IT IS CHOOSING A CHALLENGE…';
  }

  protected promptHud(): BossHud['prompt'] {
    if (!this.prompt) return null;
    return { text: PROMPT_TEXT[this.prompt.kind], progress: this.prompt.got / this.prompt.need, time: this.prompt.time / this.prompt.max };
  }

  /** It mirrors you: your strongest archetype decides which questions it asks. */
  private pickPrompt(): PromptKind {
    const w: [PromptKind, number][] = [['DRIFT', 2], ['PERFECT', 1], ['NEAR', 2], ['RAM', 2], ['SPEED', 1], ['CLEAN', 1 + (this.phase - 1)]];
    const boost = (k: PromptKind, n: number) => {
      const e = w.find((x) => x[0] === k);
      if (e) e[1] += n;
    };
    switch (this.topTag) {
      case 'RAM': boost('RAM', 3); break;
      case 'DRIFT': boost('DRIFT', 2); boost('PERFECT', 2); break;
      case 'SPEED': boost('SPEED', 2); boost('NEAR', 2); break;
      case 'FIRE': boost('CLEAN', 2); break;
      case 'ELECTRIC': boost('NEAR', 3); break;
      case 'GHOST': boost('NEAR', 2); boost('CLEAN', 1); break;
    }
    if (this.prompt) {
      const last = this.prompt.kind;
      const e = w.find((x) => x[0] === last);
      if (e) e[1] = 0;
    }
    return this.rng.weighted(w);
  }

  private startPrompt() {
    const s = this.sess;
    const p = this.p;
    const kind = this.pickPrompt();
    const max = kind === 'CLEAN' ? 8 : 11 - this.phase;
    const need = kind === 'NEAR' ? 3 : kind === 'SPEED' ? 3 : kind === 'CLEAN' ? 8 : 1;
    this.prompt = { kind, need, got: 0, time: max, max };
    s.notify(`THE DRIVER: ${PROMPT_TEXT[kind]}`, '#ff1040', true);
    s.audio.telegraph();
    if (kind === 'NEAR') {
      // it brings the traffic for you
      const w = s.world.road.at(p.s + 110).width;
      const n = lanesFor(w);
      for (let row = 0; row < 4; row++) {
        const gapLane = this.rng.int(0, n - 1);
        for (let l = 0; l < n; l++) if (l !== gapLane && this.rng.chance(0.75)) s.spawnTrafficAt(p.s + 110 + row * 45, laneOffset(w, l), p.vF * 0.45);
      }
    }
    if (kind === 'CLEAN') this.stormT = 0;
  }

  private progress(n: number) {
    const pr = this.prompt;
    if (!pr) return;
    pr.got = Math.min(pr.need, pr.got + n);
    if (pr.got >= pr.need) {
      this.prompt = null;
      this.promptCd = 2.2;
      this.sess.audio.item();
      this.hitStability(36, 'ANSWERED');
    }
  }

  private failPrompt() {
    const s = this.sess;
    const v = this.vehicle;
    this.prompt = null;
    this.promptCd = 2.5;
    this.restoreStability(12);
    s.notify('TOO SLOW', '#ff1040', true);
    s.fx.bolt(v.pos.x, 1.2, v.pos.z, this.p.pos.x, this.p.pos.y + 1, this.p.pos.z, 0xff40c0);
    s.combat.damagePlayer(8, 'electric', v.pos.x, v.pos.z);
    this.p.systemsLock = Math.max(this.p.systemsLock, 1.2);
  }

  protected think(dt: number) {
    const v = this.vehicle;
    const p = this.p;
    const s = this.sess;
    const pr = this.prompt;
    // positioning depends on what it asked for
    if (pr?.kind === 'RAM') {
      this.follow(4);
      v.targetD = p.d + (p.d > 0 ? -3.8 : 3.8);
    } else if (pr?.kind === 'NEAR' || pr?.kind === 'CLEAN') {
      this.follow(-30);
      v.targetD = -p.d;
    } else {
      this.follow(22);
      v.targetD = Math.sin(this.t * 0.6) * 3;
    }
    // mirror trail: its tyre marks become your build's element
    if (Math.random() < dt * 3) {
      const o = this.worldAt(v.s - 3, v.d);
      if (this.topTag === 'FIRE') s.combat.addHazard('fire', o.x, o.z, 2, 3, 16, false);
      else if (this.topTag === 'ELECTRIC') s.combat.addHazard('electric', o.x, o.z, 2, 2.5, 12, false);
      else s.fx.tireSmoke(v.pos.x, v.pos.z, v.velX, v.velZ, 0.8, 0x606070);
    }
    if (this.state === 'ACTIVE') {
      if (!pr) {
        this.promptCd -= dt;
        if (this.promptCd <= 0) this.startPrompt();
      } else {
        pr.time -= dt;
        if (pr.kind === 'SPEED') {
          if (p.speed > p.stats.maxSpeed * 0.85) this.progress(dt);
          else pr.got = Math.max(0, pr.got - dt * 2);
        }
        if (pr.kind === 'CLEAN') {
          this.progress(dt);
          this.stormT -= dt;
          if (this.stormT <= 0 && this.prompt) {
            this.stormT = 1.4 - this.phase * 0.2;
            const sAt = p.s + p.vF * 1.1;
            const d = this.snapLane(p.d, p.s).d;
            const o = this.worldAt(sAt, d);
            s.tele.circle(o.x, o.z, 2.8, 0xff1040, 0.9);
            s.combat.schedule(0.9, () => s.combat.strike(o.x, o.z, 2.8, 12));
          }
        }
        if (this.prompt && this.prompt.time <= 0) this.failPrompt();
      }
      // between questions it attacks: a marked lane strike
      if (!this.prompt && this.attackCd <= 0 && this.promptCd > 0.8) {
        this.telegraph(1.2);
        const d = this.snapLane(p.d, p.s).d;
        s.tele.lane(p.s + 10, p.s + 80, d, 3.4, 0xff1040, this.stateT, 0.5);
        v.ai.lockD = d;
      }
    } else if (this.state === 'TELEGRAPH') {
      if (this.stateT <= 0) {
        this.set('ATTACK', 0.5);
        const d = v.ai.lockD;
        for (let i = 0; i < 4; i++) {
          const sAt = p.s + 15 + i * 16;
          s.combat.schedule(i * 0.1, () => {
            const o = this.worldAt(sAt, d);
            s.combat.strike(o.x, o.z, 2.6, 12);
          });
        }
      }
    } else if (this.state === 'ATTACK') {
      if (this.stateT <= 0) this.endAttack(this.rng.range(3, 5));
    }
  }

  onDrift(duration: number, perfect: boolean) {
    const pr = this.prompt;
    if (!pr) return;
    if (pr.kind === 'DRIFT' && duration >= 1.5) this.progress(1);
    if (pr.kind === 'PERFECT' && perfect) this.progress(1);
  }

  onNearMiss(_tier: number) {
    if (this.prompt?.kind === 'NEAR') this.progress(1);
  }

  onPlayerCrash() {
    if (this.prompt?.kind === 'CLEAN') this.failPrompt();
    if (this.prompt?.kind === 'SPEED') this.prompt.got = 0;
  }

  onRammed(v: AIVehicle, kind: string, impact: number, perfect: boolean) {
    if (v !== this.vehicle || this.open) return;
    if (this.prompt?.kind === 'RAM' && (kind === 'SIDE' || perfect) && impact > 12) this.progress(1);
    else if (kind !== 'GLANCE') this.sess.popup('NOT LIKE THAT', '#ff4060');
  }
}

export function createBoss(id: BossId, sess: DrivingSession, diff: number): BossController {
  const def = BOSSES[id];
  switch (id) {
    case 'iron_mule': return new IronMule(def, sess, diff);
    case 'drowned_line': return new DrownedLine(def, sess, diff);
    case 'taxon': return new Taxon(def, sess, diff);
    case 'apex': return new Apex(def, sess, diff);
    case 'the_driver': return new TheDriver(def, sess, diff);
  }
}

