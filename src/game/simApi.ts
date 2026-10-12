import type { Vector3 } from 'three';
import type { Stats, Tag } from '../data/types';

/** The minimal view of any car-like entity that items/systems can affect. */
export interface SimVehicle {
  pos: Vector3;
  velX: number;
  velZ: number;
  yaw: number;
  hp: number;
  maxHp: number;
  dead: boolean;
  mass: number;
  flying: boolean;
  isBoss: boolean;
  isTraffic: boolean;
  stun(t: number): void;
  expose(t: number): void;
  burn(t: number, dps: number): void;
  impulse(x: number, z: number, spin?: number): void;
  chainId: number;
  chainTime: number;
  burnT: number;
}

export type DamageKind = 'ram' | 'weapon' | 'explosion' | 'fire' | 'electric' | 'wall' | 'collision' | 'ghost';
export type HazardKind = 'oil' | 'fire' | 'electric' | 'water' | 'ghost' | 'mine' | 'spikes' | 'boost' | 'emp';

export interface ExplodeOpts {
  chainId?: number;
  hurtsPlayer?: boolean;
  color?: number;
  byPlayer?: boolean;
  fire?: boolean;
}

export interface PlayerView {
  pos: Vector3;
  velX: number;
  velZ: number;
  yaw: number;
  speed: number;
  hp: number;
  maxHp: number;
  heat: number;
  momentum: number;
  fuel: number;
  nitro: number;
  drifting: boolean;
  driftTime: number;
  driftCharge: number;
  nitroActive: boolean;
  grounded: boolean;
  phase: number;
  stats: Stats;
}

/** Archetype resources: each build archetype has its own meter that the driving fills. */
export interface ArchetypeRes {
  /** RAM: stacks that make the car heavier and its hits harder */
  mass: number;
  massMax: number;
  /** SPEED: 0..100, filled by pace, near misses and drafting */
  velocity: number;
  /** ELECTRIC: 0..100, filled by close passes and contact */
  static: number;
  /** GHOST: cars passed through during the current phase */
  phaseHits: number;
}

export interface DriftInfo {
  duration: number;
  perfect: number;
  charge: number;
  perfectExit: boolean;
}

export interface Sim {
  time: number;
  player: PlayerView;
  res: ArchetypeRes;
  tagCount(t: Tag): number;
  hasItem(id: string): boolean;
  synergy(id: string): boolean;
  /** per-item scratch state (cooldowns, counters) for the current run */
  mem: Record<string, number>;
  damageVehicle(v: SimVehicle, amount: number, kind: DamageKind, opts?: { chainId?: number; byPlayer?: boolean }): void;
  explode(x: number, z: number, radius: number, damage: number, opts?: ExplodeOpts): void;
  spawnHazard(kind: HazardKind, x: number, z: number, radius: number, life: number, dps?: number): void;
  chainLightning(x: number, z: number, targets: number, damage: number, range?: number): void;
  emp(x: number, z: number, radius: number, damage: number): void;
  shockwave(x: number, z: number, radius: number, force: number, damage: number): void;
  /** forward cone of force from the car: yaw = direction */
  cannon(x: number, z: number, yaw: number, length: number, width: number, damage: number): void;
  missiles(count: number, damage: number): void;
  nearest(x: number, z: number, radius: number, n: number, includeTraffic?: boolean): SimVehicle[];
  addMomentum(n: number): void;
  addNitro(n: number): void;
  addFuel(n: number): void;
  addCredits(n: number): void;
  addCombo(n: number, reason: string): void;
  addMass(n: number): void;
  addVelocity(n: number): void;
  addStatic(n: number): void;
  boost(seconds: number): void;
  heal(n: number): void;
  setPhase(sec: number): void;
  notify(text: string, color?: string): void;
  popup(text: string, color?: string): void;
  slowMo(duration: number, scale: number): void;
  pull(v: SimVehicle, x: number, z: number, strength: number): void;
  sparks(x: number, y: number, z: number, n: number, color?: number): void;
}
