import type { EnemyKind } from '../data/enemies';
import { ENEMIES } from '../data/enemies';
import type { AIVehicle } from '../enemies/ai';
import type { DrivingSession } from './driving';

/**
 * Chases and duels — the emergent "it caught up with me" moment, turned into a system.
 *
 * DUEL: when a hostile chaser holds the combat window around you (within ~26 m, in front or behind) it becomes
 * your duel opponent: it gets more aggressive, the HUD names it and shows its health and a timer, the music
 * shifts. A duel lasts at most ~30 s: you wreck it (DUEL WON), it breaks off (IT GOT AWAY), or you shake it (SHOOK IT).
 *
 * OUT-RUN → CUT-IN: a chaser that is hopelessly behind for a few seconds leaves the road (out of sight) and later
 * cuts back in ahead from the roadside — "it took a side street". Never a visible teleport, never speed matching.
 */
export interface DuelInfo {
  name: string;
  hp: number;
  time: number;
  dist: number;
}

// fragile interceptors die in two hits: they are a skirmish, not a duel (unless elite)
const DUEL_KINDS: EnemyKind[] = ['hunter', 'rammer', 'gunner', 'empvan', 'blocker'];

export class ChaseSystem {
  duel: { v: AIVehicle; t: number; max: number; farT: number } | null = null;
  private windowT = new Map<number, number>();
  private cutIns: { kind: EnemyKind; elite: boolean; encId: number; hp: number; at: number }[] = [];
  private cooldown = 0;

  constructor(private sess: DrivingSession) {}

  reset() {
    this.duel = null;
    this.windowT.clear();
    this.cutIns = [];
    this.cooldown = 8;
  }

  /** Can this car be a duel opponent? Real chasers only — not parked blockers, not bosses, not traffic. */
  private duelist(v: AIVehicle) {
    if (v.role !== 'enemy' || v.dead || v.removed || v.flying) return false;
    if (v.task.kind === 'block' || v.task.kind === 'retreat') return false;
    // objective targets already have their own panel; a nearly-wrecked car is not a fight any more
    if (v.isTarget || v.hp < v.maxHp * 0.5) return false;
    return DUEL_KINDS.includes(v.kind as EnemyKind) || v.elite;
  }

  update(dt: number) {
    const s = this.sess;
    if (s.attract || s.finished || s.dying > 0 || s.boss) {
      if (this.duel && (s.finished || s.boss)) this.end('none');
      return;
    }
    const p = s.player;
    this.cooldown -= dt;

    // ---- out-run chasers leave, and cut back in ahead later
    for (const v of s.vehicles) {
      if (v.role !== 'enemy' || v.dead || v.removed || v.flying || v.isTarget) continue;
      const chasing = v.task.kind === 'pursue' || v.task.kind === 'free' || v.task.kind === 'attackTarget';
      if (!chasing) continue;
      const rel = v.s - p.s;
      // hopelessly behind = far back with its boost spent (it already tried)
      if (rel < -90 && v.boostE < 0.2) v.outrunT += dt;
      else v.outrunT = Math.max(0, v.outrunT - dt);
      // leave before the population sweep would silently despawn it (140 m behind)
      if ((v.outrunT > 3 && rel < -100) || rel < -132) {
        if (this.duel?.v === v) this.end('shook');
        // it took a side street: it comes back ahead while its fight is still on (elites always do)
        const enc = v.encId >= 0 ? s.director.encounters[v.encId] : null;
        if (v.elite || enc?.state === 'active') this.cutIns.push({ kind: v.kind as EnemyKind, elite: v.elite, encId: v.encId, hp: v.hp / v.maxHp, at: s.time + 5 + Math.random() * 4 });
        s.removeVehicle(v);
      }
    }
    for (let i = this.cutIns.length - 1; i >= 0; i--) {
      const c = this.cutIns[i];
      if (s.time < c.at) continue;
      this.cutIns.splice(i, 1);
      const enc = c.encId >= 0 ? s.director.encounters[c.encId] : null;
      if (!c.elite && enc?.state !== 'active') continue;
      if (s.finalPush || s.director.finishS > 0 && s.director.finishS - p.s < 220) continue;
      // cut in from the road edge ahead, slower than you: you catch it, it does not catch you
      const at = p.s + 150;
      const w = s.world.road.at(at).width;
      const side = Math.random() < 0.5 ? -1 : 1;
      const v = s.spawnEnemyAt(c.kind, at, side * (w / 2 - 1.6), Math.max(18, p.vF * 0.7), c.elite);
      if (!v) continue;
      v.hp = v.maxHp * Math.max(0.3, c.hp);
      v.encId = c.encId;
      v.setMarker(c.elite ? 'elite' : 'enemy');
      v.task = { kind: 'pursue', gap: 5, delay: 0.35 };
      if (enc) enc.vehicles.push(v);
      s.notify(`${c.elite ? 'ELITE ' : ''}${ENEMIES[c.kind].name} CUTS IN AHEAD`, '#ff6070');
      s.audio.warning();
      const o = { x: 0, y: 0, z: 0 };
      s.world.road.toWorld(at - 12, side * (w / 2 - 2.5), o);
      s.tele.arrow(o.x, o.z, s.world.road.at(at - 12).heading - side * 0.6, 8, 0xff3040, 2);
    }

    // ---- duels
    if (!this.duel) {
      if (this.cooldown > 0) return;
      let best: AIVehicle | null = null, bestT = 0;
      for (const v of s.vehicles) {
        if (!this.duelist(v)) continue;
        const d = Math.hypot(v.pos.x - p.pos.x, v.pos.z - p.pos.z);
        const t = d < 26 ? (this.windowT.get(v.id) ?? 0) + dt : 0;
        this.windowT.set(v.id, t);
        if (t > 2 && t > bestT) {
          best = v;
          bestT = t;
        }
      }
      if (best) this.start(best);
      return;
    }
    const d = this.duel;
    d.t += dt;
    const v = d.v;
    if (v.dead) return this.end('won');
    if (v.removed || v.task.kind === 'retreat') return this.end('none');
    const dist = Math.hypot(v.pos.x - p.pos.x, v.pos.z - p.pos.z);
    d.farT = dist > 85 ? d.farT + dt : 0;
    if (d.farT > 3) return this.end('shook');
    if (d.t > d.max) return this.end('escaped');
    // the opponent fights harder: attacks come round faster
    v.ai.cd -= dt * 0.6;
  }

  private start(v: AIVehicle) {
    const s = this.sess;
    this.duel = { v, t: 0, max: v.elite ? 36 : 26, farT: 0 };
    v.duel = true;
    if (!v.markerKind) v.setMarker('enemy');
    s.notify(`DUEL — ${(v.elite ? 'ELITE ' : '') + ENEMIES[v.kind as EnemyKind].name}`, '#ff3048', true);
    s.audio.duel(true);
    s.cam.addTrauma(0.12);
  }

  private end(how: 'won' | 'escaped' | 'shook' | 'none') {
    const s = this.sess;
    const d = this.duel;
    if (!d) return;
    this.duel = null;
    d.v.duel = false;
    this.cooldown = 14;
    this.windowT.clear();
    s.audio.duel(false);
    if (how === 'won') {
      s.notify('DUEL WON', '#ffd23a', true);
      s.addMomentum(20);
      s.addCredits(10);
      s.addScore(600);
    } else if (how === 'escaped') {
      s.notify('IT GOT AWAY', '#ff8060');
      d.v.task = { kind: 'retreat' };
      d.v.boostE = 1;
      d.v.targetSpeed = d.v.topSpeed * 1.2;
    } else if (how === 'shook') {
      s.notify('SHOOK IT OFF', '#5af0ff');
      s.addMomentum(10);
    }
  }

  /** For the HUD. */
  info(): DuelInfo | null {
    const d = this.duel;
    if (!d) return null;
    const v = d.v;
    const p = this.sess.player;
    const name = (v.elite ? 'ELITE ' : '') + ENEMIES[v.kind as EnemyKind].name;
    return { name, hp: v.hp / v.maxHp, time: 1 - d.t / d.max, dist: Math.hypot(v.pos.x - p.pos.x, v.pos.z - p.pos.z) };
  }
}
