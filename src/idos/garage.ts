import type { CharacterModel } from '@idosgames/core';
import { DUEL_CARS, DUEL_STATS, LIVERIES, UPGRADE_PRICE, type LiveryDef } from './catalog';
import { idos } from './platform';

/**
 * The duel garage: every car the player drives has a server-side twin (an iDos character) that fights in the pit.
 * Its six stats are tuned with SALVAGE on the server; the wrap it wears (a livery item) shows in the pit, on the road and
 * on other drivers' screens. Nothing here changes how a car handles in a run: the run's balance is the game's own.
 */

export const characterOf = (vehicleId: string) => DUEL_CARS.find((c) => c.vehicle === vehicleId)?.character ?? 'Main';
export const vehicleOfCharacter = (characterId: string) => DUEL_CARS.find((c) => c.character === characterId)?.vehicle ?? 'courier';

export function model(vehicleId: string): CharacterModel | undefined {
  return idos.client?.data.user.state?.Character?.Characters?.[characterOf(vehicleId)];
}

export function statLevel(vehicleId: string, statId: string, m = model(vehicleId)): number {
  return m?.StatLevels?.[statId] ?? 0;
}

/** a stat's value at a level (the same curve the server evaluates: base + step × level) */
export function statValue(vehicleId: string, statId: string, level: number): number {
  const car = DUEL_CARS.find((c) => c.vehicle === vehicleId) ?? DUEL_CARS[0];
  const def = DUEL_STATS.find((s) => s.id === statId)!;
  return car.base[statId] + def.step * level;
}

export function statText(statId: string, v: number) {
  const def = DUEL_STATS.find((s) => s.id === statId)!;
  return def.pct ? `${Math.round(v * 100)}%` : v >= 10 ? String(Math.round(v)) : v.toFixed(2);
}

/** SALVAGE price of raising a stat to `target` (levels count from 1, rounded up once, like the server) */
export function upgradeCost(target: number) {
  return Math.ceil(UPGRADE_PRICE.salvage * Math.pow(1 + UPGRADE_PRICE.growth, target - 1) - 1e-9);
}

export const power = (vehicleId: string) => model(vehicleId)?.Power ?? 0;

export async function loadCars() {
  await idos.call((c) => c.character.getUserCharacters());
}

export async function upgrade(vehicleId: string, statId: string, onFail?: (m: string) => void) {
  return idos.call((c) => c.character.upgradeStatLevel(characterOf(vehicleId), statId, {}), onFail);
}

// ---------------------------------------------------------------- liveries

export const liveryDef = (itemId: string | null | undefined): LiveryDef | undefined => (itemId ? LIVERIES.find((l) => l.id === itemId) : undefined);

/** the livery a server car wears (its "@skin" slot) */
export function wornLiveryOf(m: CharacterModel | null | undefined): LiveryDef | undefined {
  return liveryDef(m?.Equipment?.['@skin']?.ItemID);
}

/** the colours a car wears: the player's own wrap for their car */
export function liveryOf(vehicleId: string, mine: boolean, m?: CharacterModel | null): { color: number; accent: number } | null {
  const l = wornLiveryOf(m ?? (mine ? model(vehicleId) : undefined));
  return l ? { color: l.color, accent: l.accent } : null;
}

export interface OwnedWrap {
  instance: string;
  def: LiveryDef;
  /** the car wearing it, if any */
  on: string | null;
}

/** every livery copy the player owns (each copy is one physical wrap) */
export function ownedWraps(): OwnedWrap[] {
  const inst = idos.client?.data.user.state?.InventoryV2?.UnstackableItems ?? {};
  const out: OwnedWrap[] = [];
  for (const [id, s] of Object.entries(inst)) {
    const def = liveryDef(s.ItemID);
    if (!def) continue;
    out.push({ instance: id, def, on: s.EquippedSlot?.CharacterID ? vehicleOfCharacter(s.EquippedSlot.CharacterID) : null });
  }
  const order = { LEGENDARY: 0, EPIC: 1, RARE: 2, COMMON: 3 };
  return out.sort((a, b) => order[a.def.rarity] - order[b.def.rarity] || a.def.name.localeCompare(b.def.name));
}

export async function wear(vehicleId: string, wrap: OwnedWrap | null, onFail?: (m: string) => void) {
  const ch = characterOf(vehicleId);
  if (!wrap) return idos.call((c) => c.character.equipSkin(ch, 'stock'), onFail);
  return idos.call((c) => c.character.equipSkin(ch, wrap.def.id, wrap.instance), onFail);
}
