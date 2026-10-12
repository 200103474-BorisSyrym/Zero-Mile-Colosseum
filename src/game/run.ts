import { CONFIG } from '../core/config';
import { Random } from '../core/random';
import type { NodeMod } from '../data/events';
import { getItem, ITEMS, type ItemDef } from '../data/items';
import { DIFFICULTIES } from '../data/meta';
import { SYNERGIES, ARCHETYPE_NAMES, type SynergyDef } from '../data/synergies';
import type { AbilityId, Rarity, Stats, Tag, VehicleDef } from '../data/types';
import { BASE_STATS } from '../data/vehicles';
import { ZONES } from '../data/zones';
import type { SaveData } from '../save/save';

export type NodeType = 'ROAD' | 'ELITE' | 'SHOP' | 'EVENT' | 'GAS' | 'REPAIR' | 'RACE' | 'SHORTCUT' | 'BOSS';

export interface MapNode {
  id: number;
  row: number;
  col: number;
  x: number;
  type: NodeType;
  next: number[];
  visited: boolean;
  /** 1..5 difficulty preview shown on the map */
  stars: number;
}

export const NODE_INFO: Record<NodeType, { label: string; icon: string; color: string; desc: string }> = {
  ROAD: { label: 'ROAD', icon: '▲', color: '#8fb4ff', desc: 'Three encounters on the road. Pick a part at the end.' },
  ELITE: { label: 'ELITE', icon: '☠', color: '#ff4a6a', desc: 'A concentrated test with elite hunters. Rare+ reward and a shard.' },
  SHOP: { label: 'SHOP', icon: '$', color: '#ffd23a', desc: 'Spend credits on parts, repairs and fuel.' },
  EVENT: { label: 'EVENT', icon: '?', color: '#c58bff', desc: 'Something happens. Choose wisely.' },
  GAS: { label: 'GAS', icon: '⛽', color: '#58f0a0', desc: 'Refuel to full and repair 10%.' },
  REPAIR: { label: 'REPAIR', icon: '✚', color: '#5ad1ff', desc: 'Repair 35% of max HP.' },
  RACE: { label: 'RACE', icon: '⚑', color: '#ff9a3a', desc: 'Traffic, then a street race against a rival. Better part on a win.' },
  SHORTCUT: { label: 'HAZARD RUN', icon: '⤳', color: '#ff5ad0', desc: 'Hazard lanes and a race against the clock. Skips a row. Better loot.' },
  BOSS: { label: 'BOSS', icon: '◆', color: '#ff2a2a', desc: 'The guardian of this region.' },
};

export interface RunStats {
  distance: number;
  kills: number;
  ramKills: number;
  maxSpeed: number;
  bestCombo: number;
  damageTaken: number;
  creditsEarned: number;
  bossesDefeated: number;
  nearMisses: number;
  itemsCollected: number;
  time: number;
  maxChain: number;
  maxSynergies: number;
  score: number;
}

export class RunState {
  rng: Random;
  hp: number;
  fuel: number = CONFIG.FUEL.MAX;
  credits = 0;
  momentum = 0;
  items: string[] = [];
  zoneIndex = 0;
  map: MapNode[] = [];
  current: number | null = null;
  nextMod: NodeMod | null = null;
  maxHpBonus = 0;
  mem: Record<string, number> = {};
  stats: RunStats = { distance: 0, kills: 0, ramKills: 0, maxSpeed: 0, bestCombo: 0, damageTaken: 0, creditsEarned: 0, bossesDefeated: 0, nearMisses: 0, itemsCollected: 0, time: 0, maxChain: 0, maxSynergies: 0, score: 0 };
  shopRerolls = 0;
  nodesCleared = 0;
  firstItemGiven = false;
  difficulty: (typeof DIFFICULTIES)[number];
  /** the weekly Shift: everyone's city this week, scored on the iDos board (no tow trucks) */
  ranked = false;
  /** a tow truck already hauled this run back once */
  towUsed = false;
  /** nodes a toll pass opened: the toll express skips the next row */
  tollTargets: number[] | null = null;
  /** boss damage dealt this run, for THE DRIVER hunt */
  huntDamage = 0;
  /** the server's ticket for this run: finishRun presents it to be paid (idos/profile.ts) */
  ticket = '';
  /** salvage found at events on the road, paid with the run */
  eventSalvage = 0;
  /** archive entries decrypted on this run, recorded with it */
  lore: string[] = [];
  private cachedStats: Stats | null = null;

  constructor(public seed: number, public vehicle: VehicleDef, public module: AbilityId, public save: SaveData, difficulty: number) {
    this.rng = new Random(seed);
    this.difficulty = DIFFICULTIES[difficulty] ?? DIFFICULTIES[0];
    this.credits = 25 * (save.unlocks.perk_credits ?? 0);
    this.hp = this.computeStats().maxHp;
    if (save.unlocks.perk_momentum) this.momentum = 25;
    this.generateMap();
  }

  get zone() {
    return ZONES[this.zoneIndex];
  }

  invalidate() {
    this.cachedStats = null;
  }

  tagCounts(): Partial<Record<Tag, number>> {
    const c: Partial<Record<Tag, number>> = {};
    for (const id of this.items) {
      const it = getItem(id);
      if (!it) continue;
      for (const t of it.tags) c[t] = (c[t] ?? 0) + 1;
    }
    return c;
  }

  synergies(): SynergyDef[] {
    const c = this.tagCounts();
    return SYNERGIES.filter((s) => Object.entries(s.req).every(([t, n]) => (c[t as Tag] ?? 0) >= (n as number)));
  }

  hasSynergy(id: string) {
    return this.synergies().some((s) => s.id === id);
  }

  computeStats(): Stats {
    if (this.cachedStats) return this.cachedStats;
    const st: Stats = { ...BASE_STATS, ...this.vehicle.stats };
    st.maxHp += 10 * (this.save.unlocks.perk_hp ?? 0) + this.maxHpBonus;
    const defs = this.items.map(getItem).filter((x): x is ItemDef => !!x);
    const syn = this.synergies();
    for (const d of [...defs, ...syn]) if (d.add) for (const [k, v] of Object.entries(d.add)) (st as unknown as Record<string, number>)[k] += v as number;
    for (const d of [...defs, ...syn]) if (d.mul) for (const [k, v] of Object.entries(d.mul)) (st as unknown as Record<string, number>)[k] *= v as number;
    st.maxHp = Math.round(Math.max(20, st.maxHp));
    this.cachedStats = st;
    return st;
  }

  archetype(): string {
    const c = this.tagCounts();
    let best: Tag | null = null, n = 0;
    for (const [t, v] of Object.entries(c)) if ((v as number) > n && ARCHETYPE_NAMES[t as Tag]) { n = v as number; best = t as Tag; }
    if (!best || n < 2) return 'STREET STOCK';
    return ARCHETYPE_NAMES[best]!;
  }

  addItem(id: string) {
    this.items.push(id);
    this.stats.itemsCollected++;
    const before = this.computeStats().maxHp;
    this.invalidate();
    const after = this.computeStats().maxHp;
    if (after > before) this.hp += after - before;
    this.hp = Math.min(this.hp, after);
    this.stats.maxSynergies = Math.max(this.stats.maxSynergies, this.synergies().length);
  }

  removeItem(id: string) {
    const i = this.items.indexOf(id);
    if (i >= 0) this.items.splice(i, 1);
    this.invalidate();
    this.hp = Math.min(this.hp, this.computeStats().maxHp);
  }

  itemPool(): ItemDef[] {
    return ITEMS.filter((i) => !i.pack || this.save.unlocks[i.pack]);
  }

  /** Roll n distinct items. `tier`: 0 normal, 1 elite, 2 boss. */
  rollItems(n: number, tier = 0, rng = this.rng, forced?: Rarity): ItemDef[] {
    const pool = this.itemPool();
    const out: ItemDef[] = [];
    const z = this.zoneIndex;
    const bonus = this.difficulty.rarityBonus;
    const weights: [Rarity, number][] = tier === 2
      ? [['COMMON', 0], ['RARE', 30], ['EPIC', 50], ['LEGENDARY', 20 + bonus * 100]]
      : tier === 1
        ? [['COMMON', 20], ['RARE', 50], ['EPIC', 24 + z * 3], ['LEGENDARY', 4 + z * 2 + bonus * 60]]
        : [['COMMON', 62 - z * 7], ['RARE', 28 + z * 3], ['EPIC', 8 + z * 3 + bonus * 50], ['LEGENDARY', 2 + z * 1 + bonus * 30]];
    let guard = 0;
    while (out.length < n && guard++ < 200) {
      const rarity = forced ?? rng.weighted(weights);
      let cands = pool.filter((i) => i.rarity === rarity && !out.includes(i));
      // prefer items not yet owned, but allow stacking
      const fresh = cands.filter((i) => !this.items.includes(i.id));
      if (fresh.length) cands = fresh;
      if (!cands.length) continue;
      // nudge toward the player's dominant tags for coherent builds
      const tc = this.tagCounts();
      const it = rng.weighted(cands.map((c) => [c, 1 + c.tags.reduce((a, t) => a + (tc[t] ?? 0) * 0.6, 0)] as [ItemDef, number]));
      out.push(it);
    }
    return out;
  }

  generateMap() {
    const rng = this.rng.fork(1000 + this.zoneIndex * 17);
    const rows = 6;
    const nodes: MapNode[] = [];
    let id = 0;
    const rowNodes: MapNode[][] = [];
    for (let r = 0; r < rows; r++) {
      const count = r === rows - 1 ? 1 : r === 0 ? (this.zoneIndex === 0 ? 1 : 2) : rng.int(2, 4);
      const row: MapNode[] = [];
      for (let c = 0; c < count; c++) {
        const x = count === 1 ? 0.5 : 0.15 + (0.7 * c) / (count - 1);
        row.push({ id: id++, row: r, col: c, x, type: 'ROAD', next: [], visited: false, stars: 1 });
      }
      rowNodes.push(row);
      nodes.push(...row);
    }
    // types
    const z = this.zoneIndex;
    for (const n of nodes) {
      if (n.row === rows - 1) n.type = 'BOSS';
      else if (n.row === 0) n.type = z === 0 ? 'ROAD' : rng.weighted([['ROAD', 3], ['EVENT', 1]] as [NodeType, number][]);
      else if (n.row === rows - 2) n.type = rng.weighted([['SHOP', 3], ['REPAIR', 3], ['GAS', 2], ['EVENT', 2], ['ROAD', 1]] as [NodeType, number][]);
      else n.type = rng.weighted([['ROAD', 4], ['EVENT', 2.6], ['ELITE', z === 0 && n.row === 1 ? 0 : 1.6], ['SHOP', 1.2], ['GAS', 1], ['REPAIR', 0.8], ['RACE', 1], ['SHORTCUT', n.row <= rows - 4 ? 0.8 : 0]] as [NodeType, number][]);
    }
    const mid = nodes.filter((n) => n.row >= 1 && n.row <= rows - 2);
    if (!mid.some((n) => n.type === 'SHOP')) rng.pick(mid.filter((n) => n.row >= 2)).type = 'SHOP';
    if (!mid.some((n) => n.type === 'ELITE')) rng.pick(mid.filter((n) => n.row >= 2 && n.row <= rows - 3 && n.type !== 'SHOP') .concat(mid.filter((n) => n.row === 2))).type = 'ELITE';
    if (!nodes.some((n) => n.row >= 1 && n.row <= 2 && n.type === 'ROAD')) rng.pick(nodes.filter((n) => n.row === 1)).type = 'ROAD';
    // edges
    for (let r = 0; r < rows - 1; r++) {
      const cur = rowNodes[r], nxt = rowNodes[r + 1];
      for (const n of cur) {
        const sorted = [...nxt].sort((a, b) => Math.abs(a.x - n.x) - Math.abs(b.x - n.x));
        n.next.push(sorted[0].id);
        if (sorted[1] && rng.chance(0.55)) n.next.push(sorted[1].id);
      }
      for (const m of nxt) {
        if (!cur.some((n) => n.next.includes(m.id))) {
          const closest = [...cur].sort((a, b) => Math.abs(a.x - m.x) - Math.abs(b.x - m.x))[0];
          closest.next.push(m.id);
        }
      }
    }
    // shortcuts skip a row
    for (const n of nodes) {
      if (n.type === 'SHORTCUT' && n.row + 2 < rows) {
        const target = rowNodes[n.row + 2];
        n.next = [[...target].sort((a, b) => Math.abs(a.x - n.x) - Math.abs(b.x - n.x))[0].id];
      }
    }
    // difficulty preview: region + depth + node type (+ a little noise so the map hides something)
    for (const n of nodes) {
      const base = 1 + z * 0.6 + n.row * 0.25 + (n.type === 'ELITE' ? 1.2 : n.type === 'SHORTCUT' ? 0.9 : n.type === 'RACE' ? 0.4 : 0) + this.difficulty.id * 0.5;
      n.stars = Math.max(1, Math.min(5, Math.round(base + rng.range(-0.4, 0.4))));
    }
    this.map = nodes;
    this.current = null;
    this.tollTargets = null;
  }

  availableNodes(): MapNode[] {
    if (this.tollTargets) return this.tollTargets.map((i) => this.map[i]);
    if (this.current === null) return this.map.filter((n) => n.row === 0);
    const cur = this.map.find((n) => n.id === this.current);
    return cur ? cur.next.map((i) => this.map[i]) : [];
  }

  /** where the toll express can take you: every node two rows on from here (null when there is no row to skip) */
  tollReach(): MapNode[] | null {
    const next = this.availableNodes();
    if (!next.length || next.some((n) => n.type === 'BOSS')) return null;
    const ids = new Set<number>();
    for (const n of next) for (const t of n.next) ids.add(t);
    const out = [...ids].map((i) => this.map[i]);
    return out.length ? out : null;
  }

  nextZone(): boolean {
    if (this.zoneIndex >= ZONES.length - 1) return false;
    this.zoneIndex++;
    this.generateMap();
    if (this.save.unlocks.perk_momentum) this.momentum = Math.max(this.momentum, 25);
    return true;
  }
}
