import { clamp, KMH } from '../core/math';
import type { Random } from '../core/random';
import type { EnemyKind } from '../data/enemies';
import type { SegmentType } from '../data/zones';
import type { AIVehicle } from '../enemies/ai';
import type { HazardKind } from '../game/simApi';
import { MARK, type SegmentInfo } from '../world/generator';
import type { EncCtx, Piece } from './director';

export type EncounterId =
  | 'ROADBLOCK' | 'CONVOY' | 'AMBUSH' | 'PURSUIT' | 'HAZARD_RUN' | 'TRAFFIC_WAVE'
  | 'ESCAPE' | 'RACE' | 'PROTECT' | 'DESTROY_TARGET' | 'SURVIVE';

export interface EncounterDef {
  id: EncounterId;
  name: string;
  tagline: string;
  color: number;
  hint?: string;
  /** what the first road says instead (plain words, keys in [brackets]) */
  tutorialHint?: string;
  /** the road this encounter needs (encounter-first generation) */
  pieces(rng: Random, tier: number, baseW: number): Piece[];
  approachWidth?(baseW: number): number;
  /** metres before the stage start at which it activates (negative = inside the stage) */
  triggerLead?: number;
  /** if false, reaching the end without the primary objective is a failure */
  endIsSuccess?: boolean;
  prepare?(c: EncCtx): void;
  decorate?(c: EncCtx, info: SegmentInfo): void;
  start(c: EncCtx): void;
  update(c: EncCtx, dt: number): 'active' | 'success' | 'fail';
  finish?(c: EncCtx, res: 'success' | 'fail'): void;
  onKill?(c: EncCtx, v: AIVehicle, kind: string): void;
  onNearMiss?(c: EncCtx, tier: number): void;
  onPickup?(c: EncCtx, kind: string): void;
  onDrift?(c: EncCtx, perfect: boolean): void;
}

const P = (type: SegmentType, opts: Piece['opts'] = {}): Piece => ({ type, opts });
const hazardFor = (zoneHazard: string): HazardKind => (zoneHazard === 'water' ? 'water' : zoneHazard === 'electric' || zoneHazard === 'glitch' ? 'electric' : zoneHazard === 'fire' ? 'fire' : 'oil');
const zoneEnemy = (c: EncCtx, allow: EnemyKind[]) => {
  const w = c.sess.zone.enemies.filter(([k]) => allow.includes(k));
  return w.length ? c.rng.weighted(w) : c.rng.pick(allow);
};
const objective = (label: string, target = 1, timer?: number) => ({ label, progress: 0, target, done: false, failed: false, timer });

/** Elite variants add a gold-marked hunter that tails you through the whole encounter. */
function eliteHunter(c: EncCtx) {
  if (c.enc.elite) c.enemy('hunter', c.p.s - 40, c.p.d, c.p.vF + 4, { kind: 'pursue', gap: 5, delay: 0.3 }, { elite: true });
}

function deadIn(c: EncCtx, f: (v: AIVehicle) => boolean) {
  return c.enc.vehicles.filter((v) => f(v) && v.dead).length;
}

export const ENCOUNTERS: Record<EncounterId, EncounterDef> = {
  // ------------------------------------------------------------------------------------------------ ROADBLOCK
  ROADBLOCK: {
    id: 'ROADBLOCK', name: 'ROADBLOCK', tagline: 'SQUEEZE · BYPASS · BREAK', color: 0xffa020,
    hint: 'PICK A LINE: THE GAP HAS LOOT, THE BYPASS IS SAFE',
    tutorialHint: 'BLOCKADE AHEAD — [Q] AFTERBURNER SMASHES THROUGH · [E] EMP STUNS THEM',
    pieces: (_r, _t, w) => [P('STRAIGHT', { length: 240, width: w + 4.5, bend: 0, split: { from: 70, to: 185, medianD: (w + 4.5) / 2 - 4.3, medianW: 0.9, markR: MARK.SHORTCUT } }), P('STRAIGHT', { length: 60, width: w })],
    approachWidth: (w) => w + 4.5,
    decorate(c, info) {
      if (c.enc.data.gapLane !== undefined) return;
      const W = info.width;
      const blockS = info.startS + 130;
      const mainL = -W / 2, mainR = W / 2 - 4.3 - 0.45;
      const lanes = [mainL + 1.85, (mainL + mainR) / 2, mainR - 1.85];
      const gap = c.rng.int(0, 2);
      c.enc.data = { gapLane: gap, lanes, blockS };
      // loot sits in the gap and just behind it: the greedy line
      for (let i = 0; i < 4; i++) c.pickup('gold', blockS - 4 + i * 5, lanes[gap], 6);
      if (c.rng.chance(0.4 + c.tier * 0.1)) c.pickup('shard', blockS + 22, lanes[gap]);
      // explosive tanker beside a truck: one well-placed shove clears the blockade
      const tankLane = gap === 1 ? (c.rng.chance(0.5) ? 0 : 2) : 1;
      c.prop('xbarrel', blockS - 7, lanes[tankLane] + (gap > tankLane ? 1.2 : -1.2));
      c.prop('xbarrel', blockS - 8.5, lanes[tankLane] + (gap > tankLane ? 1.2 : -1.2));
      // bypass is narrow and lined with cones; signed so it reads from far away
      c.sign(info.startS + 62, 'BYPASS ▸', 0x30f0ff, 1);
      for (let s = info.startS + 75; s < info.startS + 180; s += 15) c.prop('cone', s, W / 2 - 0.5);
    },
    prepare(c) {
      const { lanes, gapLane, blockS } = c.enc.data as { lanes: number[]; gapLane: number; blockS: number };
      if (!lanes) return;
      if (c.sess.config.tutorial) c.sess.player.momentum = Math.max(c.sess.player.momentum, 50);
      for (let i = 0; i < 3; i++) if (i !== gapLane) c.enemy('blocker', blockS, lanes[i], 0, { kind: 'block', s: blockS, d: lanes[i], speed: 0 });
      if (c.tier >= 2) c.enemy('bomber', blockS - 14, lanes[(gapLane + 1) % 3], 0, { kind: 'block', s: blockS - 14, d: lanes[(gapLane + 1) % 3], speed: 0 });
    },
    start(c) {
      c.enc.primary = objective('GET THROUGH THE BLOCKADE');
      c.enc.optional = objective('WRECK 2 BLOCKERS', 2);
      const { blockS } = c.enc.data as { blockS: number };
      // waiting muscle: joins the chase once you pass
      if (c.tier >= 1) c.enemy('rammer', blockS + 30, -2, 0, { kind: 'block', s: blockS + 30, d: -2, speed: 0 });
      if (c.tier >= 3) c.enemy('empvan', blockS + 45, 2, 0, { kind: 'block', s: blockS + 45, d: 2, speed: 0 });
      if (c.tier >= 4) c.enemy('hunter', c.p.s - 45, c.p.d, c.p.vF, { kind: 'pursue', gap: 6, delay: 0.4 });
      eliteHunter(c);
    },
    update(c) {
      const { blockS } = c.enc.data as { blockS: number };
      c.enc.optional!.progress = deadIn(c, (v) => v.kind === 'blocker');
      if (c.enc.optional!.progress >= 2) c.enc.optional!.done = true;
      // parked muscle wakes up when you go by
      for (const v of c.enc.vehicles) {
        if (v.dead || v.task.kind !== 'block' || v.kind === 'blocker' || v.kind === 'bomber') continue;
        if (c.p.s > (v.task as { s: number }).s - 25) v.task = { kind: 'pursue', gap: 6, delay: 0.5 };
      }
      if (c.p.s > blockS + 20) c.enc.primary.progress = 1;
      return 'active';
    },
  },

  // ------------------------------------------------------------------------------------------------ CONVOY
  CONVOY: {
    id: 'CONVOY', name: 'CONVOY', tagline: 'HUNT THE LEADER', color: 0xff5040,
    hint: 'RAM THE GOLD-MARKED LEADER — HIT IT FROM BEHIND OR THE SIDE',
    pieces: () => [P('CURVE'), P('STRAIGHT', { length: 200 }), P('TURN_SHARP'), P('STRAIGHT', { length: 180 }), P('S_CURVE'), P('STRAIGHT', { length: 170 })],
    endIsSuccess: false,
    start(c) {
      c.enc.primary = objective('DESTROY THE CONVOY LEADER');
      c.enc.optional = objective('WRECK ALL ESCORTS', 1);
      const s0 = c.p.s + 55;
      const leader = c.enemy('blocker', s0, 0, Math.max(20, c.p.vF * 0.82), { kind: 'flee', minSpeed: 28, maxSpeed: 44 }, { target: true, hpMul: 1 + c.tier * 0.2 });
      if (!leader) return;
      leader.weak = 'rear';
      c.enc.data.leader = leader;
      const escorts: [EnemyKind, number, number][] = [['interceptor', -8, -3.6], ['interceptor', -8, 3.6]];
      if (c.tier >= 1) escorts.push(['rammer', -18, 0]);
      if (c.tier >= 2) escorts.push([zoneEnemy(c, ['gunner', 'drone']), 12, -3]);
      if (c.tier >= 3) escorts.push(['bomber', 2, 3.6]);
      for (const [k, rel, d] of escorts) c.enemy(k, s0 + rel, d, leader.vF, { kind: 'slot', anchor: leader, rel, d });
      c.enc.optional.target = escorts.length;
      eliteHunter(c);
    },
    update(c) {
      const leader = c.enc.data.leader as AIVehicle | undefined;
      const esc = deadIn(c, (v) => v !== leader && !v.elite);
      c.enc.optional!.progress = esc;
      if (esc >= c.enc.optional!.target) c.enc.optional!.done = true;
      // escorts break formation to defend when you close in on the leader
      if (leader && !leader.dead) {
        for (const v of c.enc.vehicles) {
          if (v === leader || v.dead || v.task.kind !== 'slot') continue;
          if (Math.abs(c.p.s - leader.s) < 25) v.task = { kind: 'free' };
        }
      }
      if (leader && leader.removed && !leader.dead) return 'fail';
      if (leader && leader.dead && !c.enc.primary.done) {
        c.enc.primary.done = true;
        for (let i = 0; i < 5; i++) c.pickup('gold', leader.s + 4 + i * 3, leader.d + (i % 2 ? 1.2 : -1.2), 7);
        c.pickup(c.rng.chance(0.5) ? 'shard' : 'repair', leader.s + 22, leader.d);
        return 'success';
      }
      return 'active';
    },
    finish(c, res) {
      const leader = c.enc.data.leader as AIVehicle | undefined;
      if (res === 'fail' && leader && !leader.dead) {
        leader.topSpeed *= 1.4;
        leader.task = { kind: 'flee', minSpeed: 60, maxSpeed: 70 };
        c.sess.notify('THE CONVOY GOT AWAY', '#ff6070');
      }
    },
  },

  // ------------------------------------------------------------------------------------------------ AMBUSH
  AMBUSH: {
    id: 'AMBUSH', name: 'AMBUSH', tagline: 'FIND THE WAY OUT', color: 0xff3060,
    hint: 'THEY COME FROM BOTH SIDES — PICK AN EXIT AND COMMIT',
    pieces: (_r, _t, w) => [P('STRAIGHT', { length: 280, width: w + 6, bend: 0 }), P('STRAIGHT', { length: 50, width: w })],
    approachWidth: (w) => w + 6,
    triggerLead: -55,
    decorate(c, info) {
      if (info.tag?.part !== 0) return;
      const W = info.width;
      // side streets between parked cars; barrels at two of the entrances
      for (let s = info.startS + 20; s < info.endS - 20; s += 16) {
        for (const side of [-1, 1]) {
          if (c.rng.chance(0.3)) continue;
          c.prop('parked', s, side * (W / 2 - 1.4));
        }
      }
      for (const side of [-1, 1]) {
        const s = info.startS + c.rng.range(90, 170);
        c.prop('xbarrel', s, side * (W / 2 - 3.2));
        c.prop('xbarrel', s + 1.6, side * (W / 2 - 3.6));
      }
      c.pickup('gold', info.startS + 150, 0, 10);
      c.pickup('gold', info.startS + 156, 0, 10);
    },
    start(c) {
      c.enc.primary = objective('BREAK OUT OF THE AMBUSH');
      c.enc.optional = objective('WRECK 3 ATTACKERS', 3);
      const p = c.p;
      const W = c.width(p.s + 40);
      // pincer from the side streets, cutting inward
      for (const side of [-1, 1]) {
        const v = c.enemy('interceptor', p.s + 38, side * (W / 2 - 1.5), p.vF * 0.8, { kind: 'free' });
        if (v) {
          v.place(c.sess.world.road, v.s, v.d, p.vF * 0.8, -side * 0.55);
          v.ai.side = side;
        }
      }
      c.enemy(zoneEnemy(c, ['rammer', 'interceptor']), p.s - 28, p.d, p.vF + 3, { kind: 'pursue', gap: 8, delay: 0.6 });
      c.enemy('blocker', p.s + 85, 0, 16, { kind: 'slot', anchor: 'player', rel: 55, d: 0 });
      if (c.tier >= 1) c.enemy('gunner', p.s + 70, -W / 4, p.vF, { kind: 'free' });
      if (c.tier >= 2) c.enemy('bomber', p.s + 60, W / 4, p.vF * 0.7, { kind: 'free' });
      if (c.tier >= 3) c.enemy('empvan', p.s - 20, W / 4, p.vF, { kind: 'free' });
      if (c.tier >= 4) c.enemy('hunter', p.s - 50, 0, p.vF + 5, { kind: 'pursue', gap: 5, delay: 0.3 });
      eliteHunter(c);
      c.sess.cam.addTrauma(0.15);
      c.sess.audio.warning();
    },
    update(c) {
      c.enc.optional!.progress = deadIn(c, () => true);
      if (c.enc.optional!.progress >= 3) c.enc.optional!.done = true;
      c.enc.primary.progress = clamp((c.p.s - c.enc.startS) / (c.enc.endS - c.enc.startS), 0, 1);
      c.enc.primary.target = 1;
      return 'active';
    },
  },

  // ------------------------------------------------------------------------------------------------ PURSUIT
  PURSUIT: {
    id: 'PURSUIT', name: 'PURSUIT', tagline: 'LURE THEM INTO THE WALLS', color: 0x5080ff,
    hint: 'PURSUERS FOLLOW YOUR LINE — DODGE LATE AND THEY HIT THE OBSTACLE',
    tutorialHint: 'THEY ARE BEHIND YOU — SWERVE PAST A BLOCK AT THE LAST MOMENT AND THEY HIT IT',
    pieces: () => [P('STRAIGHT', { length: 200 }), P('CURVE'), P('STRAIGHT', { length: 220 }), P('S_CURVE'), P('STRAIGHT', { length: 170 })],
    decorate(c, info) {
      // anvils and explosive barrels in random lanes: dodge them at the last second
      for (let s = info.startS + (info.tag?.part === 0 ? 70 : 20); s < info.endS - 20; s += c.rng.range(70, 100)) {
        const lanes = c.lanes(s);
        const l = c.rng.int(0, lanes - 1);
        const kind = c.rng.chance(0.3) ? 'xbarrel' : 'block';
        c.prop(kind, s, c.laneD(s, l));
        if (kind === 'xbarrel') c.prop('xbarrel', s + 1.4, c.laneD(s, l) + 0.8);
      }
    },
    start(c) {
      c.enc.primary = objective('SURVIVE THE PURSUIT');
      c.enc.optional = objective('CRASH 2 PURSUERS', 2);
      const p = c.p;
      const n = 2 + Math.floor(c.tier / 2);
      for (let i = 0; i < n; i++) {
        const kind: EnemyKind = i === 0 && c.tier >= 3 ? 'hunter' : c.rng.chance(0.5) ? 'interceptor' : 'rammer';
        c.enemy(kind, p.s - 35 - i * 12, p.d + (i % 2 ? 2.5 : -2.5), p.vF + 6, { kind: 'pursue', gap: 7 + i * 4, delay: 0.55 + i * 0.1 });
      }
      eliteHunter(c);
      c.enc.data.crashed = 0;
      c.sess.notify('PURSUERS BEHIND YOU', '#5080ff');
    },
    onKill(c, _v, kind) {
      if (kind === 'wall' || kind === 'collision' || kind === 'explosion') c.enc.data.crashed = ((c.enc.data.crashed as number) ?? 0) + 1;
    },
    update(c) {
      c.enc.optional!.progress = (c.enc.data.crashed as number) ?? 0;
      if (c.enc.optional!.progress >= 2) c.enc.optional!.done = true;
      c.enc.primary.progress = clamp((c.p.s - c.enc.startS) / (c.enc.endS - c.enc.startS), 0, 1);
      if (c.enc.t > 3 && c.alive() === 0) return 'success';
      return 'active';
    },
  },

  // ------------------------------------------------------------------------------------------------ HAZARD RUN
  HAZARD_RUN: {
    id: 'HAZARD_RUN', name: 'HAZARD RUN', tagline: 'SAFE LANE OR GOLD LANE', color: 0xff40c0,
    hint: 'LEFT LANE: HAZARDS, BOOST PADS AND GOLD. RIGHT LANE: SAFE BUT SLOW',
    pieces: (_r, _t, w) => [P('STRAIGHT', { length: 340, width: w + 3, bend: 0.0015, split: { from: 25, to: 320, medianD: 0, medianW: 0.9, markL: MARK.HAZARD, markR: MARK.NORMAL } }), P('CHICANE')],
    approachWidth: (w) => w + 3,
    decorate(c, info) {
      if (info.tag?.part !== 0) return;
      const W = info.width;
      const riskD = -W / 4 - 0.2, safeD = W / 4 + 0.2;
      const hz = hazardFor(c.sess.zone.hazard);
      c.sign(info.startS + 18, 'RISK ◂', 0xffc21a, -1);
      c.sign(info.startS + 18, '▸ SAFE', 0xe8ecf8, 1);
      let gold = 0;
      for (let s = info.startS + 45; s < info.endS - 30; s += 32) {
        // hazards alternate across the risk corridor, always leaving a threadable gap
        const side = (Math.floor((s - info.startS) / 32) % 2 ? 1 : -1);
        c.hazard(hz, s, riskD + side * 1.4, 2.1, 9999, 16);
        c.hazard('boost', s + 14, riskD, 1.6, 9999);
        if (gold < 6) {
          c.pickup('gold', s + 8, riskD - side * 1.3, 6);
          gold++;
        }
      }
      c.enc.data.gold = gold;
      // safe side: slower, cluttered with cones and a crawling truck
      for (let s = info.startS + 60; s < info.endS - 40; s += 55) c.prop('cone', s, safeD + (c.rng.chance(0.5) ? 1.4 : -1.4));
      c.enc.data.collapse = [info.startS + 150, info.startS + 245];
      c.enc.data.riskD = riskD;
      c.enc.data.safeD = safeD;
    },
    start(c) {
      c.enc.primary = objective('REACH THE END');
      c.enc.optional = objective('GRAB 4 GOLD IN THE RISK LANE', 4);
      const safeD = c.enc.data.safeD as number;
      c.traffic(c.enc.startS + 120, safeD, 13, 'truck');
      c.traffic(c.enc.startS + 220, safeD, 15);
      if (c.tier >= 1) c.enemy('drone', c.p.s + 40, 0, c.p.vF, { kind: 'free' });
      if (c.tier >= 2) c.enemy('gunner', c.p.s + 60, safeD, c.p.vF, { kind: 'slot', anchor: 'player', rel: 30, d: safeD, absD: true });
      eliteHunter(c);
      c.enc.data.got = 0;
    },
    onPickup(c, kind) {
      if (kind === 'gold' && c.p.d < 0) c.enc.data.got = ((c.enc.data.got as number) ?? 0) + 1;
    },
    update(c) {
      c.enc.optional!.progress = (c.enc.data.got as number) ?? 0;
      if (c.enc.optional!.progress >= 4) c.enc.optional!.done = true;
      c.enc.primary.progress = clamp((c.p.s - c.enc.startS) / (c.enc.endS - c.enc.startS), 0, 1);
      // collapsing barriers: flagged in yellow, then debris drops into the risk lane
      const col = c.enc.data.collapse as number[];
      for (let i = 0; i < col.length; i++) {
        const s = col[i];
        if (s < 0) continue;
        if (c.p.s > s - 85) {
          const riskD = c.enc.data.riskD as number;
          c.sess.tele.lane(s - 2, s + 4, riskD, 3.4, 0xffc21a, 1.1);
          col[i] = -1;
          const sess = c.sess;
          sess.combat.schedule(1.0, () => {
            sess.world.spawnProp('plastic', s, riskD - 0.9);
            sess.world.spawnProp('plastic', s + 3, riskD + 0.9);
            sess.fx.debrisBurst(sess.world.road.at(s).x, 2, sess.world.road.at(s).z, 10, 0x888888, 4);
          });
        }
      }
      return 'active';
    },
  },

  // ------------------------------------------------------------------------------------------------ TRAFFIC WAVE
  TRAFFIC_WAVE: {
    id: 'TRAFFIC_WAVE', name: 'TRAFFIC WAVE', tagline: 'THREAD IT FOR COMBO', color: 0xe8ecf8,
    hint: 'WEAVE THROUGH — EVERY CLOSE PASS BUILDS COMBO AND MOMENTUM',
    pieces: (_r, _t, w) => [P('STRAIGHT', { length: 430, width: w + 4, bend: 0.0018 })],
    approachWidth: (w) => w + 4,
    triggerLead: 120,
    start(c) {
      c.enc.primary = objective('GET THROUGH THE TRAFFIC');
      c.enc.optional = objective('6 NEAR MISSES', 6);
      let gap = c.rng.int(0, 3);
      for (let s = c.enc.startS + 30; s < c.enc.endS - 30; s += c.rng.range(26, 34)) {
        const lanes = c.lanes(s);
        gap = clamp(gap + c.rng.int(-1, 1), 0, lanes - 1);
        for (let l = 0; l < lanes; l++) {
          if (l === gap) continue;
          if (c.rng.chance(0.15)) continue;
          c.traffic(s + c.rng.range(-3, 3), c.laneD(s, l), c.rng.range(13, 17), c.rng.chance(0.15) ? 'truck' : undefined);
        }
      }
      if (c.tier >= 2) c.enemy('interceptor', c.p.s + 120, 0, 16, { kind: 'free' });
      eliteHunter(c);
      c.enc.data.nm = 0;
      c.enc.data.crossAt = c.tier >= 1 ? c.enc.startS + 230 : -1;
    },
    onNearMiss(c) {
      c.enc.data.nm = ((c.enc.data.nm as number) ?? 0) + 1;
    },
    update(c) {
      c.enc.optional!.progress = (c.enc.data.nm as number) ?? 0;
      if (c.enc.optional!.progress >= 6) c.enc.optional!.done = true;
      c.enc.primary.progress = clamp((c.p.s - c.enc.startS) / (c.enc.endS - c.enc.startS), 0, 1);
      const crossAt = c.enc.data.crossAt as number;
      if (crossAt > 0 && c.p.s > crossAt - 110) {
        c.enc.data.crossAt = -1;
        c.sess.tele.lane(crossAt - 3, crossAt + 3, 0, c.width(crossAt), 0xffc21a, 1.6);
        c.crossTraffic(crossAt, 1, 16);
        c.crossTraffic(crossAt + 9, -1, 15);
      }
      return 'active';
    },
  },

  // ------------------------------------------------------------------------------------------------ ESCAPE
  ESCAPE: {
    id: 'ESCAPE', name: 'ESCAPE', tagline: 'BEAT THE CLOCK', color: 0x40ffd0,
    hint: 'THE CYAN LANE IS A SHORTCUT: BOOST PADS, BUT TIGHT',
    pieces: (_r, _t, w) => [P('STRAIGHT', { length: 170 }), P('TURN_SHARP'), P('STRAIGHT', { length: 260, width: w + 4, split: { from: 30, to: 235, medianD: (w + 4) / 2 - 4.1, medianW: 0.8, markR: MARK.SHORTCUT } }), P('CURVE'), P('STRAIGHT', { length: 150 })],
    endIsSuccess: false,
    decorate(c, info) {
      if (info.split) {
        const sd = (info.width / 2 + info.split.medianD + info.split.medianW / 2) / 2;
        c.sign(info.split.s0 - 8, 'SHORTCUT ▸', 0x30f0ff, 1);
        for (let s = info.split.s0 + 25; s < info.split.s1 - 15; s += 45) c.hazard('boost', s, sd, 1.5, 9999);
        c.hazard(hazardFor(c.sess.zone.hazard), info.split.s0 + 110, sd, 1.6, 9999, 14);
        for (let s = info.split.s0 + 40; s < info.split.s1; s += 70) {
          const l = c.rng.int(0, 1);
          c.prop('block', s, -info.width / 2 + 2 + l * 4);
        }
      }
      if (info.tag?.part === 4) c.sign(info.endS - 20, 'CHECKPOINT', 0x40ffd0);
    },
    start(c) {
      const len = c.enc.endS - c.enc.startS;
      const time = Math.round(len / (36 + c.tier * 1.5));
      c.enc.primary = objective('REACH THE CHECKPOINT', 1, time);
      c.enc.optional = objective('STAY ABOVE 150 KM/H FOR 12s', 12);
      c.enemy(c.rng.chance(0.5) ? 'interceptor' : 'rammer', c.p.s - 35, c.p.d, c.p.vF + 5, { kind: 'pursue', gap: 8, delay: 0.6 });
      if (c.tier >= 2) c.enemy('hunter', c.p.s - 55, c.p.d, c.p.vF + 5, { kind: 'pursue', gap: 5, delay: 0.35 });
      eliteHunter(c);
    },
    update(c, dt) {
      const o = c.enc.primary;
      o.timer = Math.max(0, (o.timer ?? 0) - dt);
      if (c.p.speed * KMH > 150) c.enc.optional!.progress += dt;
      if (c.enc.optional!.progress >= 12) c.enc.optional!.done = true;
      if (c.p.s >= c.enc.endS - 5) {
        o.done = true;
        return 'success';
      }
      if (o.timer <= 0) return 'fail';
      return 'active';
    },
  },

  // ------------------------------------------------------------------------------------------------ RACE
  RACE: {
    id: 'RACE', name: 'STREET RACE', tagline: 'FIRST TO THE GATE', color: 0xff9a3a,
    hint: 'THE RIVAL BRAKES FOR CORNERS — DRIFT THEM, TAKE THE SHORTCUT',
    pieces: (_r, _t, w) => [P('STRAIGHT', { length: 150 }), P('CURVE'), P('TURN_SHARP'), P('STRAIGHT', { length: 230, width: w + 4, split: { from: 30, to: 210, medianD: (w + 4) / 2 - 4.1, medianW: 0.8, markR: MARK.SHORTCUT } }), P('JUMP'), P('CHICANE'), P('STRAIGHT', { length: 200 })],
    triggerLead: 60,
    endIsSuccess: false,
    decorate(c, info) {
      if (info.split) {
        const sd = (info.width / 2 + info.split.medianD + info.split.medianW / 2) / 2;
        c.sign(info.split.s0 - 8, 'SHORTCUT ▸', 0x30f0ff, 1);
        for (let s = info.split.s0 + 20; s < info.split.s1 - 10; s += 40) c.hazard('boost', s, sd, 1.5, 9999);
        c.hazard(hazardFor(c.sess.zone.hazard), info.split.s0 + 95, sd, 1.5, 9999, 12);
      }
      if (info.tag?.part === 6) c.sign(info.endS - 20, 'FINISH', 0xff9a3a);
    },
    start(c) {
      const who = c.sess.rivalIdentity;
      c.enc.data.rivalName = who ? who.name.toUpperCase().slice(0, 18) : 'THE RIVAL';
      c.enc.primary = objective(`BEAT ${c.enc.data.rivalName} TO THE GATE`);
      if (who) c.sess.notify(`${c.enc.data.rivalName} · #${who.rank} ON THIS WEEK'S SHIFT`, '#ff9a3a');
      c.enc.optional = objective('3 PERFECT DRIFTS', 3);
      const r = c.rival(c.p.s + 4, clamp(c.p.d + (c.p.d > 0 ? -3.6 : 3.6), -4, 4), c.p.vF);
      r.topSpeed = c.p.stats.maxSpeed * (0.96 + c.tier * 0.012);
      c.enc.data.rival = r;
      c.enc.data.pd = 0;
    },
    update(c) {
      const r = c.enc.data.rival as AIVehicle;
      const name = (c.enc.data.rivalName as string) ?? 'THE RIVAL';
      c.enc.primary.label = c.p.s >= r.s ? `BEAT ${name} · YOU LEAD` : `BEAT ${name} · CATCH UP`;
      c.enc.primary.progress = clamp(0.5 + (c.p.s - r.s) / 100, 0, 1);
      c.enc.optional!.progress = (c.enc.data.pd as number) ?? 0;
      if (c.enc.optional!.progress >= 3) c.enc.optional!.done = true;
      if (r.s >= c.enc.endS - 5 && c.p.s < c.enc.endS - 5) return 'fail';
      if (c.p.s >= c.enc.endS - 5) {
        c.enc.primary.done = true;
        return 'success';
      }
      return 'active';
    },
    onDrift(c, perfect) {
      if (perfect) c.enc.data.pd = ((c.enc.data.pd as number) ?? 0) + 1;
    },
    finish(c, res) {
      const r = c.enc.data.rival as AIVehicle;
      r.role = 'traffic';
      r.task = { kind: 'cruise', speed: 18, d: r.d };
      if (res === 'success') c.sess.collectShard();
    },
  },

  // ------------------------------------------------------------------------------------------------ PROTECT
  PROTECT: {
    id: 'PROTECT', name: 'ESCORT', tagline: 'KEEP THE VAN ALIVE', color: 0x40ff90,
    hint: 'THEY TARGET THE GREEN VAN — BODY-CHECK THEM BEFORE THEY REACH IT',
    pieces: () => [P('STRAIGHT', { length: 200 }), P('CURVE'), P('STRAIGHT', { length: 200 }), P('S_CURVE'), P('STRAIGHT', { length: 160 })],
    endIsSuccess: true,
    start(c) {
      c.enc.primary = objective('ESCORT THE VAN');
      c.enc.optional = objective('WRECK 4 ATTACKERS', 4);
      const a = c.ally(c.p.s + 22, 0, Math.max(20, c.p.vF * 0.8));
      c.enc.data.ally = a;
      c.enc.data.wave = 1.5;
    },
    update(c, dt) {
      const a = c.enc.data.ally as AIVehicle;
      if (!a || a.dead) {
        c.enc.primary.failed = true;
        return 'fail';
      }
      // the van drives its route; it waits a little if you fall far behind
      a.task = { kind: 'cruise', speed: c.p.s < a.s - 70 ? 22 : 31, d: (a.task as { d: number }).d ?? 0 };
      c.enc.primary.label = `ESCORT THE VAN · HULL ${Math.ceil((a.hp / a.maxHp) * 100)}%`;
      c.enc.primary.progress = clamp((a.s - c.enc.startS) / (c.enc.endS - c.enc.startS), 0, 1);
      c.enc.optional!.progress = deadIn(c, (v) => v.role === 'enemy');
      if (c.enc.optional!.progress >= 4) c.enc.optional!.done = true;
      let w = (c.enc.data.wave as number) - dt;
      if (w <= 0 && a.s < c.enc.endS - 150) {
        w = 6.5 - c.tier * 0.5;
        for (let i = 0; i < 2; i++) {
          const behind = c.rng.chance(0.5);
          const kind: EnemyKind = c.rng.weighted([['interceptor', 3], ['bomber', c.tier >= 1 ? 2 : 0], ['rammer', 1.5], ['hunter', c.tier >= 3 ? 1 : 0]] as [EnemyKind, number][]);
          const v = c.enemy(kind, behind ? c.p.s - 40 - i * 10 : a.s + 70 + i * 10, c.rng.range(-3, 3), behind ? c.p.vF + 6 : 20, { kind: 'attackTarget', target: a });
          if (v) v.ai.side = i % 2 ? 1 : -1;
        }
        c.sess.notify('ATTACKERS INCOMING', '#ff6070');
      }
      c.enc.data.wave = w;
      if (a.s >= c.enc.endS - 10) {
        c.enc.primary.done = true;
        c.pickup('repair', a.s + 15, a.d);
        c.pickup('shard', a.s + 25, a.d);
        return 'success';
      }
      return 'active';
    },
    finish(c) {
      const a = c.enc.data.ally as AIVehicle;
      if (a && !a.dead) a.task = { kind: 'cruise', speed: 18, d: a.d };
    },
  },

  // ------------------------------------------------------------------------------------------------ DESTROY TARGET
  DESTROY_TARGET: {
    id: 'DESTROY_TARGET', name: 'BOUNTY', tagline: 'TAKE OUT THE RUNNER', color: 0xffd23a,
    hint: 'THE RUNNER WEAVES THROUGH TRAFFIC — CUT HIS LINE AND HIT HIS FLANK',
    tutorialHint: 'RAM THE CAR MARKED DESTROY — HIT ITS SIDE FOR THE MOST DAMAGE',
    pieces: () => [P('STRAIGHT', { length: 200 }), P('S_CURVE'), P('STRAIGHT', { length: 180 }), P('TURN_SHARP'), P('STRAIGHT', { length: 200 })],
    endIsSuccess: false,
    start(c) {
      const first = c.sess.config.tutorial;
      c.enc.primary = objective(first ? 'DESTROY THE TARGET' : 'TAKE OUT THE RUNNER');
      c.enc.optional = objective('WRECK THE ESCORTS', 1);
      // first road: a slow, fragile target and nothing else — the lesson is "that car is the enemy, ram it"
      const t = first
        ? c.enemy('interceptor', c.p.s + 45, 0, Math.max(20, c.p.vF * 0.7), { kind: 'flee', minSpeed: 24, maxSpeed: 33 }, { target: true, hpMul: 0.9 })
        : c.enemy('interceptor', c.p.s + 55, 0, Math.max(22, c.p.vF * 0.85), { kind: 'flee', minSpeed: 32, maxSpeed: 47 }, { target: true, hpMul: 1.8 + c.tier * 0.3 });
      c.enc.data.target = t;
      const n = first ? 0 : 1 + Math.floor(c.tier / 2);
      for (let i = 0; i < n && t; i++) c.enemy(zoneEnemy(c, ['rammer', 'gunner', 'interceptor']), t.s - 10, (i % 2 ? 1 : -1) * 3.6, t.vF, { kind: 'slot', anchor: t, rel: -10, d: (i % 2 ? 1 : -1) * 3.6 });
      c.enc.optional.target = n;
      if (first) c.enc.optional = null;
      for (let s = c.p.s + 120; s < c.enc.endS - 80; s += first ? 90 : 55) c.traffic(s, c.laneD(s, c.rng.int(0, c.lanes(s) - 1)), 16);
      eliteHunter(c);
    },
    update(c) {
      const t = c.enc.data.target as AIVehicle | undefined;
      if (c.enc.optional) {
        c.enc.optional.progress = deadIn(c, (v) => v !== t);
        if (c.enc.optional.progress >= c.enc.optional.target) c.enc.optional.done = true;
      }
      if (t && t.removed && !t.dead) return 'fail';
      if (t && t.dead) {
        c.enc.primary.done = true;
        for (let i = 0; i < 4; i++) c.pickup('gold', t.s + 5 + i * 3, t.d, 9);
        return 'success';
      }
      return 'active';
    },
  },

  // ------------------------------------------------------------------------------------------------ SURVIVE
  SURVIVE: {
    id: 'SURVIVE', name: 'GAUNTLET', tagline: 'SURVIVE 20 SECONDS', color: 0xff2a2a,
    hint: 'WAVES FROM EVERY SIDE — KEEP MOVING, USE THEM AGAINST EACH OTHER',
    pieces: (_r, _t, w) => [P('STRAIGHT', { length: 320, width: w + 4 }), P('CURVE', { width: w + 4 }), P('STRAIGHT', { length: 320, width: w + 4 }), P('STRAIGHT', { length: 260, width: w + 4 })],
    approachWidth: (w) => w + 4,
    start(c) {
      c.enc.primary = objective('SURVIVE', 1, 20);
      c.enc.optional = objective('WRECK 5', 5);
      c.enc.data.wave = 0.5;
      c.enc.data.n = 0;
      eliteHunter(c);
      for (let i = 0; i < 4; i++) {
        const s = c.p.s + 150 + i * 90;
        c.prop('xbarrel', s, c.laneD(s, c.rng.int(0, c.lanes(s) - 1)));
      }
    },
    update(c, dt) {
      const o = c.enc.primary;
      o.timer = Math.max(0, (o.timer ?? 20) - dt);
      c.enc.optional!.progress = deadIn(c, () => true);
      if (c.enc.optional!.progress >= 5) c.enc.optional!.done = true;
      let w = (c.enc.data.wave as number) - dt;
      if (w <= 0 && o.timer > 2) {
        const n = (c.enc.data.n as number) + 1;
        c.enc.data.n = n;
        w = 4.5;
        const count = 1 + Math.floor(n / 2) + Math.floor(c.tier / 2);
        for (let i = 0; i < count; i++) {
          const ahead = (n + i) % 2 === 0;
          const kind = zoneEnemy(c, ['interceptor', 'rammer', 'bomber', 'gunner', 'drone', 'empvan']);
          c.enemy(kind, ahead ? c.p.s + 55 + i * 8 : c.p.s - 35 - i * 8, c.rng.range(-4, 4), ahead ? c.p.vF * 0.75 : c.p.vF + 6, ahead ? { kind: 'free' } : { kind: 'pursue', gap: 7, delay: 0.5 });
        }
        c.sess.notify(`WAVE ${n}`, '#ff4040');
      }
      c.enc.data.wave = w;
      if (o.timer <= 0) {
        o.done = true;
        return 'success';
      }
      return 'active';
    },
  },
};
