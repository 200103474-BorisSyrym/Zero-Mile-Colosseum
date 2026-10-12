import { ABILITIES } from '../data/abilities';
import { ACHIEVEMENTS, UNLOCKS } from '../data/meta';
import { PAINTS, VEHICLES } from '../data/vehicles';
import type { AbilityId } from '../data/types';
import { defaultSave, defaultSettings, readLegacySave, retireLegacySave, validateSettings, type BestRun, type SaveData, type Settings } from '../save/save';
import { ACHIEVEMENT_SALVAGE } from './catalog';
import { ACTION_GAP_MS, idos } from './platform';

/**
 * The driver's progression, kept by iDos Games. The game holds a view of it (SaveData) and never writes it directly:
 *
 * - owned cars, upgrade levels and paints are items in the `garage` catalog; SALVAGE is the title's virtual currency
 * - records (best run, runs, wins, the deepest night unlocked, the archive) are the ReadOnly `profile`, which only the
 *   Cloud Code script writes: a run is opened with `startRun` and closed with `finishRun`, which checks the numbers
 *   and pays the salvage
 * - achievements are permanent quests (`ach_<id>`), claimed for SALVAGE in the ARCHIVE
 * - the garage choices (car, module, paint per car, difficulty) are the driver's Private `prefs`
 *
 * Only the device's own settings (volume, graphics) stay in the browser.
 */

interface ServerProfile {
  best: BestRun;
  runs: number;
  wins: number;
  totalSalvage: number;
  maxDifficulty: number;
  lore: string[];
  tutorialDone: boolean;
}

interface Prefs {
  selectedVehicle?: string;
  module?: string;
  paint?: Record<string, string>;
  difficulty?: number;
  messagesSeen?: number;
  streetIntro?: boolean;
}

export type AchievementStatus = 'locked' | 'ready' | 'claimed';

const SETTINGS_KEY = 'zeromile.settings';
const PREFS_KEY = 'prefs';

/**
 * cloud code answers: `{ ok: true, ... }` or `{ ok: false, error }`; a script crash comes back as `Error`. The
 * scripts go out one at a time (a run closed and the next one opened back to back arrive in that order).
 */
function script<T extends object>(name: string, args: Record<string, unknown>, onFail?: (m: string) => void) {
  return idos.lane('script', 250, () => runScript<T>(name, args, onFail));
}

async function runScript<T extends object>(name: string, args: Record<string, unknown>, onFail?: (m: string) => void): Promise<({ ok: true } & T) | { ok: false; error: string }> {
  let res = await idos.call((c) => c.cloudCode.execute(name, args as never));
  // one more try on a dropped connection (the server refuses a replayed finish by its ticket)
  if (!res && /connection|timeout|fetch/i.test(idos.lastError)) {
    await new Promise((r) => setTimeout(r, 1500));
    res = await idos.call((c) => c.cloudCode.execute(name, args as never));
  }
  if (!res) {
    const error = /unauthorized/i.test(idos.lastError) ? 'signed_out' : 'connection';
    onFail?.(error === 'signed_out' ? 'SIGNED OUT — SIGN IN AGAIN' : 'NO CONNECTION — TRY AGAIN');
    return { ok: false, error };
  }
  const out = res.FunctionResult as ({ ok?: boolean; error?: string } & T) | null;
  if (res.Error || !out || out.ok !== true) {
    const error = out?.error ?? (res.Error ? 'script' : 'refused');
    onFail?.(SCRIPT_ERRORS[error] ?? 'REFUSED — TRY AGAIN');
    return { ok: false, error };
  }
  return out as { ok: true } & T;
}

const SCRIPT_ERRORS: Record<string, string> = {
  funds: 'NOT ENOUGH SALVAGE',
  owned: 'ALREADY YOURS',
  unknown: 'NOT FOR SALE',
  difficulty_locked: 'THAT NIGHT IS STILL LOCKED',
  no_open_run: 'THE RUN WAS ALREADY RECORDED',
  clock: 'THE RUN COULD NOT BE VERIFIED',
  grant: 'THE SERVER COULD NOT PAY OUT — TRY AGAIN',
  no_policy: 'NO POLICY ON FILE — TRY AGAIN',
  expired: 'THE CLAIM WINDOW HAS CLOSED',
  already_insured: 'THIS RUN IS ALREADY INSURED',
  nothing_to_insure: 'NOTHING TO CLAIM',
};

function parse<T>(v: string | null | undefined): T | null {
  if (!v) return null;
  try {
    return JSON.parse(v) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the device's settings

export function loadSettings(): Settings {
  try {
    const own = localStorage.getItem(SETTINGS_KEY);
    if (own) return validateSettings(JSON.parse(own));
    // the browser-only game kept its settings inside the save
    const legacy = readLegacySave();
    if (legacy) return legacy.settings;
  } catch {
    /* storage unavailable */
  }
  return defaultSettings();
}

export function storeSettings(s: Settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: the settings last for this visit */
  }
}

// ---------------------------------------------------------------- reading the account

let questStatus: Record<string, string> = {};
let serverProfile: ServerProfile | null = null;

/** everything the account holds, into a fresh view (the device's settings carried over) */
export async function hydrate(settings: Settings): Promise<SaveData | null> {
  idos.knownName = '';
  const [data, , , named] = await Promise.all([
    idos.call((c) => c.userCustomData.getMyUserCustomData()),
    idos.call((c) => c.user.getUserInventory()),
    loadAchievements(),
    // a resumed session's state may not carry the public name
    idos.name ? null : script<{ name: string }>('profile', {}),
  ]);
  if (!data) return null;
  if (named?.ok && named.name) idos.knownName = named.name;
  serverProfile = parse<ServerProfile>(data.ReadOnly?.profile?.Value);
  const prefs = parse<Prefs>(data.Private?.[PREFS_KEY]?.Value) ?? {};
  const sv = defaultSave();
  sv.settings = settings;
  applyAccount(sv);
  applyPrefs(sv, prefs);
  return sv;
}

/** the parts of the view that follow the account: balance, owned things, records, achievements */
export function applyAccount(sv: SaveData) {
  sv.salvage = idos.salvage;
  sv.unlockedVehicles = ['courier', ...VEHICLES.filter((v) => v.price > 0 && idos.itemCount(`car_${v.id}`) > 0).map((v) => v.id)];
  sv.unlocks = {};
  for (const u of UNLOCKS) {
    const n = Math.min(u.levels ?? 1, idos.itemCount(`up_${u.id}`));
    if (n > 0) sv.unlocks[u.id] = n;
  }
  sv.paints = ['stock', ...PAINTS.filter((p) => p.price > 0 && idos.itemCount(`paint_${p.id}`) > 0).map((p) => p.id)];
  // free paints (price 0) are everyone's
  for (const p of PAINTS) if (p.price <= 0 && !sv.paints.includes(p.id)) sv.paints.push(p.id);
  const p = serverProfile;
  if (p) {
    sv.best = { ...sv.best, ...p.best };
    sv.runs = p.runs;
    sv.wins = p.wins;
    sv.totalSalvage = p.totalSalvage;
    sv.maxDifficultyUnlocked = Math.min(2, Math.max(0, p.maxDifficulty));
    sv.lore = Array.from(new Set(['lore_intro', ...(p.lore ?? []), ...sv.lore]));
    sv.tutorialDone = p.tutorialDone || sv.tutorialDone;
  }
  sv.achievements = ACHIEVEMENTS.filter((a) => achievementStatus(a.id) !== 'locked' || sv.achievements.includes(a.id)).map((a) => a.id);
  // a choice that is no longer owned falls back
  if (!sv.unlockedVehicles.includes(sv.selectedVehicle)) sv.selectedVehicle = 'courier';
  if (sv.difficulty > sv.maxDifficultyUnlocked) sv.difficulty = sv.maxDifficultyUnlocked;
}

function applyPrefs(sv: SaveData, p: Prefs) {
  if (p.selectedVehicle && sv.unlockedVehicles.includes(p.selectedVehicle)) sv.selectedVehicle = p.selectedVehicle;
  if (p.module && p.module in ABILITIES) sv.module = p.module as AbilityId;
  if (p.paint && typeof p.paint === 'object') for (const [car, paint] of Object.entries(p.paint)) if (typeof paint === 'string' && sv.paints.includes(paint)) sv.paint[car] = paint;
  if (typeof p.difficulty === 'number') sv.difficulty = Math.min(sv.maxDifficultyUnlocked, Math.max(0, Math.floor(p.difficulty)));
  if (typeof p.messagesSeen === 'number') sv.messagesSeen = p.messagesSeen;
  if (p.streetIntro === true) sv.streetIntroSeen = true;
}

let prefsTimer: ReturnType<typeof setTimeout> | null = null;

/** the garage choices, a moment after the last change */
export function savePrefs(sv: SaveData) {
  if (prefsTimer) clearTimeout(prefsTimer);
  prefsTimer = setTimeout(() => {
    prefsTimer = null;
    const prefs: Prefs = { selectedVehicle: sv.selectedVehicle, module: sv.module, paint: sv.paint, difficulty: sv.difficulty, messagesSeen: sv.messagesSeen, streetIntro: sv.streetIntroSeen };
    void idos.call((c) => c.userCustomData.setPrivateData(PREFS_KEY, JSON.stringify(prefs)));
  }, 800);
}

// ---------------------------------------------------------------- a run

export interface RunReport {
  won: boolean;
  stats: { distance: number; kills: number; bosses: number; zone: number; time: number; maxSpeed: number; combo: number; score: number; nodes: number };
  eventSalvage: number;
  lore: string[];
}

/** what the server made of a run: the salvage it paid and what it unlocked, or why it could not record it */
export type FinishResult = { ok: true; salvage: number; notes: string[] } | { ok: false; message: string; retry: boolean };

export async function startRun(difficulty: number, ranked: boolean, onFail?: (m: string) => void): Promise<string | null> {
  const r = await script<{ ticket: string }>('startRun', { difficulty, ranked }, onFail);
  return r.ok ? r.ticket : null;
}

/**
 * close the run on the server: it checks the numbers, pays the salvage and keeps the records. A dropped connection or
 * an ended session can be retried (the ticket stays open); a refusal on the merits is final.
 */
export async function finishRun(ticket: string, report: RunReport): Promise<FinishResult> {
  let message = '';
  const r = await script<{ salvage: number; notes: string[]; profile: ServerProfile }>('finishRun', { ticket, ...report }, (m) => (message = m));
  if (!r.ok) {
    const retry = r.error === 'connection' || r.error === 'signed_out';
    return { ok: false, message: retry ? `THE RUN IS NOT RECORDED YET — ${message}` : message, retry };
  }
  serverProfile = r.profile;
  await idos.call((c) => c.user.getUserInventory());
  return { ok: true, salvage: r.salvage, notes: r.notes ?? [] };
}

/** wreck insurance: the policy was just spent (a timed boost); the server pays the wrecked run's salvage again */
export async function insureRun(onFail?: (m: string) => void): Promise<number | null> {
  const r = await script<{ salvage: number }>('insureRun', {}, onFail);
  if (!r.ok) return null;
  await idos.call((c) => c.user.getUserInventory());
  return r.salvage;
}

// ---------------------------------------------------------------- the garage

export type GarageKind = 'vehicle' | 'unlock' | 'paint';

/** a car, an upgrade level or a paint for SALVAGE: one atomic charge-and-grant on the server */
export async function garageBuy(kind: GarageKind, id: string, onFail?: (m: string) => void): Promise<boolean> {
  const r = await script<{ item: string }>('garageBuy', { kind, id }, onFail);
  if (!r.ok) return false;
  await idos.call((c) => c.user.getUserInventory());
  return true;
}

// ---------------------------------------------------------------- achievements

export async function loadAchievements() {
  const st = await idos.call((c) => c.quest.getUserQuestState());
  const perm = st?.State?.PermanentQuests ?? {};
  questStatus = Object.fromEntries(Object.entries(perm).map(([id, q]) => [id, String((q as { Status?: string }).Status ?? 'Active')]));
}

export function achievementStatus(id: string): AchievementStatus {
  const s = questStatus[`ach_${id}`];
  return s === 'Claimed' ? 'claimed' : s === 'Completed' ? 'ready' : 'locked';
}

export const achievementSalvage = (id: string) => ACHIEVEMENT_SALVAGE[id] ?? 25;

/** earned on the road: completes the achievement's quest (its reward waits in the ARCHIVE) */
export async function reportAchievement(id: string) {
  const r = await idos.lane('quest', ACTION_GAP_MS, () => idos.call((c) => c.quest.addQuestProgress(`ach_${id}`, 1)));
  const done = r?.Updates?.find((u) => u.QuestID === `ach_${id}`);
  if (done) questStatus[`ach_${id}`] = done.Status;
  else if (r) questStatus[`ach_${id}`] ??= 'Completed';
  return !!r;
}

export async function claimAchievement(id: string, onFail?: (m: string) => void) {
  const r = await idos.call((c) => c.quest.claimQuestReward(`ach_${id}`), onFail);
  if (r) questStatus[`ach_${id}`] = 'Claimed';
  return r;
}

// ---------------------------------------------------------------- the browser-only save

/**
 * A driver who played the browser-only game brings that garage onto the account once: owned cars, upgrades and paints,
 * the records, and the salvage up to a cap. The server takes it only on a fresh account. Afterwards the browser copy is
 * retired (kept under another key, never read again).
 */
export async function importLegacy(): Promise<string | null> {
  const legacy = readLegacySave();
  if (!legacy || (legacy.runs === 0 && legacy.salvage === 0)) return null;
  const save = { unlockedVehicles: legacy.unlockedVehicles, unlocks: legacy.unlocks, paints: legacy.paints, salvage: legacy.salvage, totalSalvage: legacy.totalSalvage, best: legacy.best, runs: legacy.runs, wins: legacy.wins, maxDifficultyUnlocked: legacy.maxDifficultyUnlocked, tutorialDone: legacy.tutorialDone, lore: legacy.lore };
  const r = await script<{ profile: ServerProfile; salvage: number; items: number }>('importLegacy', { save });
  if (r.ok) {
    serverProfile = r.profile;
    retireLegacySave();
    await idos.call((c) => c.user.getUserInventory());
    // the old achievements carry over as completed quests (one report each, spaced, while the driver is already in)
    for (const a of legacy.achievements) if (ACHIEVEMENTS.some((x) => x.id === a)) void reportAchievement(a);
    return `Your garage from this browser is on your account now${r.salvage ? ` · +${r.salvage} SALVAGE` : ''}`;
  }
  // an account that already has progress keeps its own: the browser copy is retired either way
  if (r.error === 'done' || r.error === 'not_fresh') retireLegacySave();
  return null;
}
