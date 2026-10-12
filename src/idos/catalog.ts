/**
 * The street economy's catalogue, shared by the game and by the title configuration (scripts/idos-config.ts writes
 * the iDos sections from these same tables, so a price on screen and a price on the server cannot drift apart).
 *
 * No imports on purpose: Node runs this file directly when the configuration is generated.
 */

export type LiveryRarity = 'COMMON' | 'RARE' | 'EPIC' | 'LEGENDARY';

export interface LiveryDef {
  id: string;
  name: string;
  rarity: LiveryRarity;
  color: number;
  accent: number;
  /** direct sale price in MileToken (legendaries only drop) */
  token?: number;
  /** direct sale price in SALVAGE */
  salvage?: number;
  /** crate weight */
  weight: number;
}

/** Liveries: wraps that dress a car in the run, in the pit and on other drivers' screens. One wrap fits one car at a time. */
export const LIVERIES: LiveryDef[] = [
  { id: 'liv_hazard', name: 'HAZARD', rarity: 'COMMON', color: 0xf2b705, accent: 0xff3a1a, token: 3, salvage: 700, weight: 15 },
  { id: 'liv_ion', name: 'ION', rarity: 'COMMON', color: 0x1f5bff, accent: 0x5af0ff, token: 3, salvage: 700, weight: 15 },
  { id: 'liv_rust', name: 'RUST BUCKET', rarity: 'COMMON', color: 0x7a3c1c, accent: 0xffa040, token: 3, salvage: 700, weight: 14 },
  { id: 'liv_mint', name: 'MINT CONDITION', rarity: 'COMMON', color: 0x4ee6b0, accent: 0xf0fff8, token: 3, salvage: 700, weight: 14 },
  { id: 'liv_magma', name: 'MAGMA', rarity: 'RARE', color: 0x2a0905, accent: 0xff4a10, token: 6, weight: 10 },
  { id: 'liv_toxic', name: 'TOXIC', rarity: 'RARE', color: 0x16181a, accent: 0x8aff20, token: 6, weight: 10 },
  { id: 'liv_synth', name: 'SYNTHWAVE', rarity: 'RARE', color: 0x3a0a6a, accent: 0xff2bd6, token: 6, weight: 10 },
  { id: 'liv_wraith', name: 'WRAITH', rarity: 'EPIC', color: 0xeef0ff, accent: 0x8a7aff, token: 12, weight: 4 },
  { id: 'liv_bloodmoon', name: 'BLOOD MOON', rarity: 'EPIC', color: 0x5a0008, accent: 0xff2a2a, token: 12, weight: 4 },
  { id: 'liv_carbon', name: 'CARBON NIGHT', rarity: 'EPIC', color: 0x0b0c0f, accent: 0x33e0ff, token: 12, weight: 4 },
  { id: 'liv_24k', name: '24 KARAT', rarity: 'LEGENDARY', color: 0xc99a18, accent: 0xfff0a0, weight: 1 },
  { id: 'liv_zero', name: 'ZERO POINT', rarity: 'LEGENDARY', color: 0x050506, accent: 0xff0030, weight: 1 },
];

export const LIVERY_COLOR: Record<LiveryRarity, string> = { COMMON: '#aab4c8', RARE: '#4aa8ff', EPIC: '#c060ff', LEGENDARY: '#ffb020' };

export type SupplyId = 'tow_truck' | 'toll_pass' | 'bm_voucher' | 'insurance' | 'crate_key';

export interface SupplyDef {
  id: SupplyId;
  name: string;
  icon: string;
  desc: string;
  /** the timed boost that spends one on the road (or charges MileToken in its place) */
  boost?: string;
  /** MileToken price when used on the spot without one in stock */
  onTheSpot?: number;
}

export const SUPPLIES: SupplyDef[] = [
  { id: 'tow_truck', name: 'TOW TRUCK', icon: '⛟', desc: 'Wrecked? Back on the road with a full hull, same run. Once per run. Not in ranked Shift runs.', boost: 'use_tow', onTheSpot: 3 },
  { id: 'toll_pass', name: 'TOLL PASS', icon: '⛿', desc: 'The toll express on the map: skip the next row of the city and patch 20% hull on the way.', boost: 'use_toll', onTheSpot: 2 },
  { id: 'bm_voucher', name: 'BLACK MARKET VOUCHER', icon: '✦', desc: 'At any night market: one EPIC part from under the counter, free.', boost: 'use_voucher', onTheSpot: 3 },
  { id: 'insurance', name: 'WRECK INSURANCE', icon: '⛨', desc: 'When a run ends in a wreck: the payout is doubled.', boost: 'use_insurance', onTheSpot: 2 },
  { id: 'crate_key', name: 'CRATE KEY', icon: '⚿', desc: 'Opens a LIVERY CRATE. Earned in contracts and in the weekly Shift.' },
];

/** cars sold in the depot for MileToken: the same server item a salvage purchase in the garage grants */
export const CAR_KEYS: { vehicle: string; item: string; token: number }[] = [
  { vehicle: 'rammer', item: 'car_rammer', token: 8 },
  { vehicle: 'ghost', item: 'car_ghost', token: 12 },
  { vehicle: 'hauler', item: 'car_hauler', token: 15 },
];

/** achievements are permanent iDos quests: reported once, paid in salvage when claimed */
export const ACHIEVEMENT_SALVAGE: Record<string, number> = {
  first_blood: 15, neon_drift: 25, close_call: 30, juggernaut: 40, overdrive: 40, chain_reaction: 50, no_brakes: 50,
  survivor: 80, zero_mile: 120, driver: 250, buildcraft: 40, airtime: 25, boss_slayer: 60, hoarder: 40,
};

/** server rules for a run's payout (the script checks a run against these) */
export const RUN_RULES = { runCap: 1500, eventSalvageCap: 60, maxMetresPerSecond: 80, legacyCap: 2500, dailyCap: 20000 };

/** The duel car's server stats. Values at level 0; each of 10 levels adds `step`. */
export interface DuelStatDef {
  id: string;
  label: string;
  role: 'Health' | 'Damage' | 'Armor' | 'Dodge' | 'CritChance' | 'AttackSpeed';
  desc: string;
  step: number;
  weight: number;
  /** shown as a percentage */
  pct?: boolean;
}

export const DUEL_STATS: DuelStatDef[] = [
  { id: 'Hull', label: 'HULL', role: 'Health', desc: 'How much ramming it takes', step: 8, weight: 1 },
  { id: 'Ram', label: 'RAM', role: 'Damage', desc: 'Damage per blow', step: 1.6, weight: 6 },
  { id: 'Plate', label: 'ARMOR', role: 'Armor', desc: 'Share of every blow the plating soaks', step: 0.012, weight: 400, pct: true },
  { id: 'Grip', label: 'GRIP', role: 'Dodge', desc: 'Chance to slide clear of a blow', step: 0.01, weight: 500, pct: true },
  { id: 'Nitro', label: 'NITRO', role: 'CritChance', desc: 'Chance of a full-boost crit', step: 0.01, weight: 400, pct: true },
  { id: 'Launch', label: 'LAUNCH', role: 'AttackSpeed', desc: 'Who strikes first each round', step: 0.04, weight: 60 },
];

/** base duel stats per car (iDos character ids: the courier is the title's default character "Main") */
export const DUEL_CARS: { vehicle: string; character: string; name: string; base: Record<string, number> }[] = [
  { vehicle: 'courier', character: 'Main', name: 'COURIER', base: { Hull: 100, Ram: 20, Plate: 0.06, Grip: 0.1, Nitro: 0.12, Launch: 1.1 } },
  { vehicle: 'rammer', character: 'rammer', name: 'RAMMER', base: { Hull: 115, Ram: 19, Plate: 0.12, Grip: 0.03, Nitro: 0.06, Launch: 0.85 } },
  { vehicle: 'ghost', character: 'ghost', name: 'GHOST', base: { Hull: 85, Ram: 19, Plate: 0.04, Grip: 0.2, Nitro: 0.16, Launch: 1.25 } },
  { vehicle: 'hauler', character: 'hauler', name: 'HAULER', base: { Hull: 135, Ram: 16, Plate: 0.16, Grip: 0.02, Nitro: 0.05, Launch: 0.8 } },
];

/** stat upgrade prices in SALVAGE: level N costs base × (1 + growth)^(N-1), rounded up */
export const UPGRADE_PRICE = { salvage: 30, growth: 0.25, maxLevel: 10 };

/** daily contracts: run metrics reported to the quest system */
export interface ContractDef {
  id: string;
  name: string;
  desc: string;
  metric: string;
  target: number;
  /** ban trip-wire on one report: far above anything one run can honestly produce */
  cap: number;
  salvage: number;
}

export const CONTRACTS: ContractDef[] = [
  { id: 'c_rams', name: 'WRECKING CREW', desc: 'Wreck 15 hunters by ramming them', metric: 'ram_kills', target: 15, cap: 600, salvage: 60 },
  { id: 'c_near', name: 'NEEDLE THREADER', desc: 'Pull off 40 near misses', metric: 'near_misses', target: 40, cap: 4000, salvage: 50 },
  { id: 'c_dist', name: 'NIGHT SHIFT', desc: 'Drive 12 km in total', metric: 'distance_m', target: 12000, cap: 400000, salvage: 50 },
  { id: 'c_boss', name: 'HEADHUNTER', desc: 'Take down a region boss', metric: 'bosses', target: 1, cap: 8, salvage: 80 },
  { id: 'c_duel', name: 'PIT REGULAR', desc: 'Fight 2 street duels', metric: 'duels', target: 2, cap: 1, salvage: 60 },
  { id: 'c_shift', name: 'ON THE CLOCK', desc: 'Finish a weekly Shift run', metric: 'shift_runs', target: 1, cap: 1, salvage: 40 },
];

/** contract points per claim, and the daily bonus that a full board of points unlocks */
export const CONTRACT_POINTS = 10;
export const CONTRACT_BONUS = { points: 40, keys: 1 };

/** weekly Shift rank rewards */
export const SHIFT_REWARDS: { rank: string; salvage: number; keys: number }[] = [
  { rank: '1', salvage: 2500, keys: 3 },
  { rank: '2-5', salvage: 1400, keys: 2 },
  { rank: '6-20', salvage: 700, keys: 1 },
  { rank: '21-100', salvage: 250, keys: 0 },
];

/** THE DRIVER hunt: the whole city's boss damage this week */
export const HUNT = { goal: 1_000_000, perRunCap: 9000, milestones: [{ id: 'h_5k', at: 5000, salvage: 80 }, { id: 'h_20k', at: 20000, salvage: 200, keys: 1 }, { id: 'h_60k', at: 60000, salvage: 500, keys: 1 }] };

/** street duel stakes */
export const DUEL_RULES = {
  salvage: { min: 10, max: 250, burn: 0.05 },
  high: { min: 500, max: 5000, burn: 0.05, feeToken: 1 },
  supplyMax: 5,
  rounds: 12,
};

/** depot offers: what MileToken buys */
export const DEPOT: { id: string; section: 'supplies' | 'salvage' | 'keys' | 'scrapyard'; name: string; grant: { item?: string; salvage?: number; amount: number }; token?: number; salvage?: number; dailyCap?: number; totalCap?: number }[] = [
  { id: 'tow_x3', section: 'supplies', name: '3 TOW TRUCKS', grant: { item: 'tow_truck', amount: 3 }, token: 6 },
  { id: 'toll_x5', section: 'supplies', name: '5 TOLL PASSES', grant: { item: 'toll_pass', amount: 5 }, token: 6 },
  { id: 'voucher_x2', section: 'supplies', name: '2 BLACK MARKET VOUCHERS', grant: { item: 'bm_voucher', amount: 2 }, token: 4 },
  { id: 'insurance_x3', section: 'supplies', name: '3 WRECK INSURANCE', grant: { item: 'insurance', amount: 3 }, token: 4 },
  { id: 'keys_x3', section: 'supplies', name: '3 CRATE KEYS', grant: { item: 'crate_key', amount: 3 }, token: 15 },
  { id: 'sv_500', section: 'salvage', name: '500 SALVAGE', grant: { salvage: 500, amount: 1 }, token: 5 },
  { id: 'sv_1800', section: 'salvage', name: '1,800 SALVAGE', grant: { salvage: 1800, amount: 1 }, token: 15 },
  { id: 'sv_6000', section: 'salvage', name: '6,000 SALVAGE', grant: { salvage: 6000, amount: 1 }, token: 45 },
  { id: 'tow_1_q', section: 'scrapyard', name: '1 TOW TRUCK', grant: { item: 'tow_truck', amount: 1 }, salvage: 350, dailyCap: 1 },
  { id: 'toll_1_q', section: 'scrapyard', name: '1 TOLL PASS', grant: { item: 'toll_pass', amount: 1 }, salvage: 150, dailyCap: 2 },
  { id: 'key_1_q', section: 'scrapyard', name: '1 CRATE KEY', grant: { item: 'crate_key', amount: 1 }, salvage: 900, dailyCap: 1 },
];

export const CRATE = { id: 'livery_crate', token: 5, pity: 12 };
