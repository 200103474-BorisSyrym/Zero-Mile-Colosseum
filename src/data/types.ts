/** The six build archetypes. Items carry one or two. */
export type Tag = 'RAM' | 'DRIFT' | 'SPEED' | 'FIRE' | 'ELECTRIC' | 'GHOST';

export type Rarity = 'COMMON' | 'RARE' | 'EPIC' | 'LEGENDARY';

export type AbilityId =
  | 'emp' | 'shockwave' | 'harpoon' | 'boost' | 'phase' | 'repair'
  | 'afterburner' | 'bulldozer' | 'phaseshift' | 'cargo';

/** Multiplicative/additive modifiers aggregated from chassis + items + synergies. */
export interface Stats {
  maxHp: number;
  maxSpeed: number;
  acceleration: number;
  braking: number;
  reverseSpeed: number;
  steering: number;
  steeringAtHighSpeed: number;
  grip: number;
  driftGrip: number;
  mass: number;
  airControl: number;
  nitroMultiplier: number;
  nitroCapacity: number;
  nitroRegen: number;
  ramDamage: number;
  damageTaken: number;
  weaponDamage: number;
  fireRate: number;
  momentumGain: number;
  driftMomentum: number;
  heatGain: number;
  heatDissipation: number;
  fuelUse: number;
  creditGain: number;
  pickupRadius: number;
  explosionRadius: number;
  explosionDamage: number;
  electricDamage: number;
  fireDamage: number;
  abilityCooldown: number;
  phaseDuration: number;
  regen: number;
}

export interface VehicleDef {
  id: string;
  name: string;
  role: string;
  description: string;
  price: number;
  stats: Partial<Stats>;
  special: AbilityId;
  /** chassis identity, shown in the garage */
  identity: string;
  model: 'courier' | 'rammer' | 'ghost' | 'hauler';
  color: number;
  accent: number;
  rating: { hp: number; speed: number; mass: number; grip: number };
  extraSlots?: number;
}
