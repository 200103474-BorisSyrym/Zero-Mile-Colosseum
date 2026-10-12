import { ABILITIES } from '../data/abilities';
import type { AbilityId } from '../data/types';
import { VEHICLES } from '../data/vehicles';

export interface Settings {
  master: number;
  music: number;
  sfx: number;
  shake: boolean;
  reducedEffects: boolean;
  highContrast: boolean;
  quality: 0 | 1 | 2 | 3;
  autoQuality: boolean;
  cameraSensitivity: number;
  showFps: boolean;
}

export interface BestRun {
  distance: number;
  kills: number;
  zone: number;
  maxSpeed: number;
  combo: number;
  score: number;
  won: boolean;
}

export interface SaveData {
  version: number;
  salvage: number;
  totalSalvage: number;
  unlockedVehicles: string[];
  selectedVehicle: string;
  unlocks: Record<string, number>;
  module: AbilityId;
  paints: string[];
  paint: Record<string, string>;
  achievements: string[];
  lore: string[];
  settings: Settings;
  best: BestRun;
  runs: number;
  wins: number;
  maxDifficultyUnlocked: number;
  difficulty: number;
  tutorialDone: boolean;
  messagesSeen: number;
  /** the street's introduction was shown on this account */
  streetIntroSeen: boolean;
}

/**
 * The game's view of a driver's progression. Since v1.2 it is filled from the iDos Games account (idos/profile.ts):
 * nothing here is written to the browser. The browser-only save of earlier versions is read once, to bring it onto the
 * account, and then retired.
 */
export const SAVE_VERSION = 4;
const LEGACY_KEY = 'zeromile.save';
const RETIRED_KEY = 'zeromile.save.imported';

export const defaultSettings = (): Settings => ({
  master: 0.8,
  music: 0.55,
  sfx: 0.8,
  shake: true,
  reducedEffects: false,
  highContrast: false,
  quality: 2,
  autoQuality: true,
  cameraSensitivity: 1,
  showFps: false,
});

export const defaultSave = (): SaveData => ({
  version: SAVE_VERSION,
  salvage: 0,
  totalSalvage: 0,
  unlockedVehicles: ['courier'],
  selectedVehicle: 'courier',
  unlocks: {},
  module: 'emp',
  paints: ['stock'],
  paint: {},
  achievements: [],
  lore: ['lore_intro'],
  settings: defaultSettings(),
  best: { distance: 0, kills: 0, zone: 0, maxSpeed: 0, combo: 0, score: 0, won: false },
  runs: 0,
  wins: 0,
  maxDifficultyUnlocked: 0,
  difficulty: 0,
  tutorialDone: false,
  messagesSeen: 0,
  streetIntroSeen: false,
});

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Merge parsed data onto defaults, field by field, discarding anything malformed. */
function validate(raw: unknown): SaveData {
  const d = defaultSave();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Record<string, unknown>;
  if (isNum(r.salvage) && r.salvage >= 0) d.salvage = Math.floor(r.salvage);
  if (isNum(r.totalSalvage)) d.totalSalvage = Math.floor(r.totalSalvage);
  if (isStrArr(r.unlockedVehicles)) d.unlockedVehicles = Array.from(new Set(['courier', ...r.unlockedVehicles.filter((id) => VEHICLES.some((v) => v.id === id))]));
  if (typeof r.selectedVehicle === 'string' && d.unlockedVehicles.includes(r.selectedVehicle)) d.selectedVehicle = r.selectedVehicle;
  if (r.unlocks && typeof r.unlocks === 'object') {
    for (const [k, v] of Object.entries(r.unlocks as Record<string, unknown>)) if (isNum(v)) d.unlocks[k] = v;
  }
  // a module id that no longer exists falls back to EMP
  if (typeof r.module === 'string' && r.module in ABILITIES) d.module = r.module as AbilityId;
  if (isStrArr(r.paints)) d.paints = Array.from(new Set(['stock', ...r.paints]));
  if (r.paint && typeof r.paint === 'object') {
    for (const [k, v] of Object.entries(r.paint as Record<string, unknown>)) if (typeof v === 'string') d.paint[k] = v;
  }
  if (isStrArr(r.achievements)) d.achievements = r.achievements;
  if (isStrArr(r.lore)) d.lore = Array.from(new Set(['lore_intro', ...r.lore]));
  d.settings = validateSettings(r.settings);
  if (r.best && typeof r.best === 'object') {
    const b = r.best as Record<string, unknown>;
    if (isNum(b.distance)) d.best.distance = b.distance;
    if (isNum(b.kills)) d.best.kills = b.kills;
    if (isNum(b.zone)) d.best.zone = b.zone;
    if (isNum(b.maxSpeed)) d.best.maxSpeed = b.maxSpeed;
    if (isNum(b.combo)) d.best.combo = b.combo;
    if (isNum(b.score)) d.best.score = b.score;
    if (typeof b.won === 'boolean') d.best.won = b.won;
  }
  if (isNum(r.runs)) d.runs = r.runs;
  if (isNum(r.wins)) d.wins = r.wins;
  if (isNum(r.maxDifficultyUnlocked)) d.maxDifficultyUnlocked = Math.min(2, Math.max(0, r.maxDifficultyUnlocked));
  if (isNum(r.difficulty)) d.difficulty = Math.min(d.maxDifficultyUnlocked, Math.max(0, r.difficulty));
  if (typeof r.tutorialDone === 'boolean') d.tutorialDone = r.tutorialDone;
  if (isNum(r.messagesSeen)) d.messagesSeen = r.messagesSeen;
  const ver = isNum(r.version) ? r.version : 1;
  if (ver < 4) {
    // the core rework changed every tutorial prompt: show the new ones once
    d.tutorialDone = false;
  }
  return d;
}

/** the device's settings, field by field, anything malformed left at its default */
export function validateSettings(raw: unknown): Settings {
  const ds = defaultSettings();
  if (!raw || typeof raw !== 'object') return ds;
  const s = raw as Record<string, unknown>;
  if (isNum(s.master)) ds.master = Math.min(1, Math.max(0, s.master));
  if (isNum(s.music)) ds.music = Math.min(1, Math.max(0, s.music));
  if (isNum(s.sfx)) ds.sfx = Math.min(1, Math.max(0, s.sfx));
  if (typeof s.shake === 'boolean') ds.shake = s.shake;
  if (typeof s.reducedEffects === 'boolean') ds.reducedEffects = s.reducedEffects;
  if (typeof s.highContrast === 'boolean') ds.highContrast = s.highContrast;
  if (isNum(s.quality) && s.quality >= 0 && s.quality <= 3) ds.quality = Math.floor(s.quality) as 0 | 1 | 2 | 3;
  if (typeof s.autoQuality === 'boolean') ds.autoQuality = s.autoQuality;
  if (isNum(s.cameraSensitivity)) ds.cameraSensitivity = Math.min(2, Math.max(0.3, s.cameraSensitivity));
  if (typeof s.showFps === 'boolean') ds.showFps = s.showFps;
  return ds;
}

/** the browser-only save of v1.0/v1.1, if this browser still has one */
export function readLegacySave(): SaveData | null {
  try {
    const txt = localStorage.getItem(LEGACY_KEY);
    if (!txt) return null;
    const parsed = JSON.parse(txt);
    return parsed && typeof parsed === 'object' ? validate(parsed) : null;
  } catch {
    return null;
  }
}

/** after the import: kept aside under another key, never read again */
export function retireLegacySave() {
  try {
    const txt = localStorage.getItem(LEGACY_KEY);
    if (txt) localStorage.setItem(RETIRED_KEY, txt);
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* storage unavailable */
  }
}
