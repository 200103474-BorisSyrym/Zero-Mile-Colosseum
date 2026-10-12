import type { BattleResult, BattleStepConfig, CharacterModel, PvPMatch, ResourceBundle } from '@idosgames/core';
import type { ModelKind } from '../data/enemies';
import { getVehicle, VEHICLES } from '../data/vehicles';
import type { BlowOutcome, DuelBlow, DuelScript, RamZone } from '../world/duelStage';
import { characterOf, model, vehicleOfCharacter, wornLiveryOf } from './garage';
import { idos } from './platform';
import { IDS, SALVAGE, type ResourceRef } from './title';

/**
 * Street duels: asynchronous PvP on the iDos match system (instant battles).
 *
 * A driver posts a challenge: a stake in SALVAGE (or in depot consumables), the car they bring and a ram plan. Anyone
 * can take it; the server fights the two server-side cars round by round and pays the winner both stakes minus a
 * 5% burn. The game never decides who won: it only performs the server's battle log in the pit (world/duelStage.ts).
 *
 * The ram plan is the match system's strategy: each step names where you ram (AttackTarget) and which side you brace
 * (DefenseTarget). FRONT · SIDE · REAR map onto the system's three zones. Ram where they don't brace.
 */

export const ZONES: RamZone[] = ['front', 'side', 'rear'];
const TO_PART: Record<RamZone, BattleStepConfig['AttackTarget']> = { front: 'Head', side: 'Torso', rear: 'Legs' };
const FROM_PART: Record<string, RamZone> = { Head: 'front', Torso: 'side', Legs: 'rear' };

export interface PlanStep {
  ram: RamZone;
  brace: RamZone;
}

export const DEFAULT_PLAN: PlanStep[] = [
  { ram: 'front', brace: 'front' },
  { ram: 'side', brace: 'rear' },
  { ram: 'rear', brace: 'side' },
];

export function toStrategy(plan: PlanStep[]): BattleStepConfig[] {
  return plan.slice(0, 10).map((p) => ({ AttackTarget: TO_PART[p.ram], DefenseTarget: TO_PART[p.brace] }));
}

export function fromStrategy(s: BattleStepConfig[] | undefined | null): PlanStep[] {
  if (!s?.length) return DEFAULT_PLAN.map((p) => ({ ...p }));
  return s.map((x) => ({ ram: FROM_PART[x.AttackTarget] ?? 'front', brace: FROM_PART[x.DefenseTarget] ?? 'front' }));
}

/** What a challenge is played for, in the words of the game. */
export interface Stake {
  ref: ResourceRef | { Type: 'Item'; ItemID: string };
  amount: number;
}

export function stakeOf(entry: ResourceBundle | null | undefined): Stake | null {
  const e = entry?.Entries?.[0];
  if (!e || !e.Amount) return null;
  if (e.Type === 'Item' && e.ItemID) return { ref: { Type: 'Item', ItemID: e.ItemID }, amount: e.Amount };
  if (e.Type === 'VirtualCurrency' && e.CurrencyID) return { ref: { Type: 'VirtualCurrency', CurrencyID: e.CurrencyID }, amount: e.Amount };
  return null;
}

export function stakeBundle(s: Stake): ResourceBundle {
  if (s.ref.Type === 'Item') return { Entries: [{ Type: 'Item', ItemID: s.ref.ItemID, CatalogID: 'supply', Amount: s.amount }] };
  return { Entries: [{ Type: s.ref.Type, CurrencyID: s.ref.CurrencyID, Amount: s.amount }] };
}

/** The rule a stake is played under: SALVAGE duels, or the high-stakes pit where the entry fee is in MileToken. */
export function ruleFor(highStakes: boolean) {
  return highStakes ? IDS.duelRuleToken : IDS.duelRuleSalvage;
}

/** A short driver tag from a user id (challenges carry ids, not names). */
export function driverTag(userId: string | null | undefined) {
  if (!userId) return 'UNKNOWN';
  // user ids are a 16-character hash followed by the title id: the hash names the driver
  return 'DRIVER-' + userId.replace(/[^a-z0-9]/gi, '').slice(0, 5).toUpperCase();
}

export interface Challenge {
  match: PvPMatch;
  vehicle: string;
  stake: Stake | null;
  mine: boolean;
}

export function challengeOf(m: PvPMatch): Challenge {
  return { match: m, vehicle: vehicleOfCharacter(m.CreatorCharacterID ?? 'Main'), stake: stakeOf(m.Entry), mine: m.CreatorID === idos.userId };
}

export async function listOpen(onFail?: (m: string) => void): Promise<Challenge[]> {
  const r = await idos.call((c) => c.match.getAvailableMatches(0, 30), onFail);
  const now = Date.now();
  return (r?.Matches ?? [])
    .filter((m) => m.Status === 'Open' && m.CreatorID !== idos.userId && (!m.ExpiresAt || Date.parse(m.ExpiresAt) > now))
    .map(challengeOf);
}

export async function listMine(onFail?: (m: string) => void): Promise<Challenge[]> {
  const r = await idos.call((c) => c.match.getMyMatches(0, 20), onFail);
  return (r?.Matches ?? []).map(challengeOf);
}

export async function post(vehicleId: string, stake: Stake, plan: PlanStep[], highStakes: boolean, onFail?: (m: string) => void) {
  const rule = ruleFor(highStakes);
  return idos.call((c) => c.match.createMatch(stakeBundle(stake), rule, characterOf(vehicleId), toStrategy(plan), undefined, highStakes ? 'token' : undefined), onFail);
}

export async function cancel(matchId: string, onFail?: (m: string) => void) {
  return idos.call((c) => c.match.cancelMatch(matchId), onFail);
}

export async function savePlan(plan: PlanStep[]) {
  return idos.call((c) => c.match.saveStrategy(toStrategy(plan)));
}

export function savedPlan(): PlanStep[] {
  return fromStrategy(idos.client?.data.user.state?.Match?.PvPBattleStrategy);
}

/** Take a challenge: the server fights it out in one call. */
export async function take(ch: Challenge, vehicleId: string, plan: PlanStep[], onFail?: (m: string) => void) {
  const m = ch.match;
  return idos.call((c) => c.match.instantBattle(m.MatchID!, m.RuleID ?? IDS.duelRuleSalvage, characterOf(vehicleId), toStrategy(plan)), onFail);
}

/**
 * Turn the server's battle into a script for the pit. You are always the left car: as the joiner you are P2 in the
 * battle profile, so the sides swap.
 */
export function scriptOf(b: BattleResult, myVehicle: string, opponentName: string): DuelScript {
  const me = idos.userId;
  const p1 = b.P1BattleProfile, p2 = b.P2BattleProfile;
  const meIsP1 = p1?.UserID === me;
  const mine = meIsP1 ? p1 : p2;
  const theirs = meIsP1 ? p2 : p1;
  const hp: [number, number] = [mine?.Stats?.MaxHp ?? 100, theirs?.Stats?.MaxHp ?? 100];
  const maxHp: [number, number] = [hp[0], hp[1]];
  const blows: DuelBlow[] = [];
  for (const e of b.BattleLog ?? []) {
    const by: 0 | 1 = e.AttackerID === me ? 0 : 1;
    const outcome: BlowOutcome = e.HitType === 'Critical' ? 'crit' : e.HitType === 'Block' ? 'blocked' : e.HitType === 'Dodge' ? 'dodged' : 'hit';
    const def = 1 - by;
    hp[def] = Math.max(0, e.DefenderHpRemaining ?? hp[def] - (e.DamageDealt ?? 0));
    blows.push({ by, zone: FROM_PART[e.AttackZone ?? 'Head'] ?? 'front', brace: FROM_PART[e.DefenseZone ?? 'Head'] ?? 'front', outcome, damage: e.DamageDealt ?? 0, hp: [hp[0], hp[1]], round: e.RoundIndex ?? 0 });
  }
  const winner: 0 | 1 | -1 = b.IsDraw || !b.WinnerUserID ? -1 : b.WinnerUserID === me ? 0 : 1;
  // each car as the server fought it, in the wrap it wore
  const car = (vehicleId: string, name: string, max: number, m: CharacterModel | null | undefined) => {
    const v = getVehicle(vehicleId);
    const liv = wornLiveryOf(m);
    return { name, model: (v.model === 'rammer' ? 'player_rammer' : v.model) as ModelKind, color: liv?.color ?? v.color, accent: liv?.accent ?? v.accent, maxHp: max, label: v.name };
  };
  const theirVehicle = vehicleOfCharacter(theirs?.SelectedCharacterID ?? theirs?.SelectedCharacter?.CharacterID ?? 'Main');
  return { cars: [car(myVehicle, 'YOU', maxHp[0], mine?.SelectedCharacter ?? model(myVehicle)), car(theirVehicle, opponentName, maxHp[1], theirs?.SelectedCharacter)], blows, winner };
}

/** stakes offered when posting a challenge */
export const SALVAGE_STAKES = [25, 50, 100, 250];
export const HIGH_STAKES = [500, 1000, 2500];

export function stakeLabel(s: Stake | null): string {
  if (!s) return '—';
  if (s.ref.Type === 'Item') return `${s.amount} × ${s.ref.ItemID.replace(/_/g, ' ').toUpperCase()}`;
  return `${s.amount} ${idos.currencyName(s.ref)}`;
}

export const ownedDuelCars = (unlocked: string[]) => VEHICLES.filter((v) => unlocked.includes(v.id));
export { SALVAGE };
