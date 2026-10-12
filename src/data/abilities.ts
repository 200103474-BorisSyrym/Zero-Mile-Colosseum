import type { AbilityId } from './types';

/** Active abilities cost Momentum (earned by driving well) and have a cooldown. */
export interface AbilityDef {
  id: AbilityId;
  name: string;
  description: string;
  cost: number;
  cooldown: number;
  color: string;
  icon: string;
  /** Meta unlock id required to equip as module (chassis specials are always available on their chassis). */
  unlock?: string;
  /** what it does, in five words — shown when the skill first becomes ready */
  pitch: string;
}

export const ABILITIES: Record<AbilityId, AbilityDef> = {
  emp: { id: 'emp', name: 'EMP', description: 'Pulse: stuns and exposes every enemy around you, erases incoming fire.', cost: 30, cooldown: 8, color: '#5ad1ff', icon: 'ϟ', pitch: 'STUN EVERY ENEMY AROUND YOU' },
  shockwave: { id: 'shockwave', name: 'SHOCKWAVE', description: 'Concussive ring that hurls nearby cars into each other and the walls.', cost: 25, cooldown: 6, color: '#ffe066', icon: '◉', pitch: 'BLAST NEARBY CARS INTO EACH OTHER' },
  harpoon: { id: 'harpoon', name: 'HARPOON', description: 'Hook the nearest enemy ahead and yank it into your path — or into its friends.', cost: 20, cooldown: 5, color: '#ff8a3d', icon: '⥅', pitch: 'YANK THE ENEMY AHEAD INTO YOUR PATH', unlock: 'ab_harpoon' },
  boost: { id: 'boost', name: 'BOOST', description: 'Instant forward burst. The next ram within 1s counts as perfect.', cost: 20, cooldown: 4, color: '#66ffa8', icon: '⏩', pitch: 'BURST FORWARD · NEXT RAM IS PERFECT', unlock: 'ab_boost' },
  phase: { id: 'phase', name: 'PHASE', description: 'Shift out of sync for 2.5s: drive straight through cars and fire.', cost: 30, cooldown: 10, color: '#b9a6ff', icon: '◌', pitch: 'GHOST THROUGH CARS FOR 2.5 S', unlock: 'ab_phase' },
  repair: { id: 'repair', name: 'REPAIR', description: 'Field repair: restore 25% of max HP.', cost: 45, cooldown: 15, color: '#7dff7d', icon: '✚', pitch: 'FIX 25% OF YOUR HULL', unlock: 'ab_repair' },
  afterburner: { id: 'afterburner', name: 'AFTERBURNER', description: 'Violent burst that breaks your speed limit. Rams during it are always perfect.', cost: 15, cooldown: 5, color: '#33e0ff', icon: '🔥', pitch: 'SPEED BURST · EVERY RAM IS PERFECT' },
  bulldozer: { id: 'bulldozer', name: 'BULLDOZER', description: '+3 MASS instantly and 4s of near-immunity to collisions.', cost: 20, cooldown: 9, color: '#ffb020', icon: '▰', pitch: 'HEAVY AND NEAR-UNSTOPPABLE FOR 4 S' },
  phaseshift: { id: 'phaseshift', name: 'PHASE SHIFT', description: '1.8s of phase with a speed surge. Cars you pass through are exposed.', cost: 20, cooldown: 7, color: '#ff2bd6', icon: '◇', pitch: 'SURGE THROUGH TRAFFIC AS A GHOST' },
  cargo: { id: 'cargo', name: 'CARGO DROP', description: 'Kick out explosive cargo behind you. Pursuers that hit it go up in flames.', cost: 15, cooldown: 4, color: '#7dff4a', icon: '▣', pitch: 'DROP EXPLOSIVES ON YOUR PURSUERS' },
};

export const MODULE_ABILITIES: AbilityId[] = ['emp', 'shockwave', 'harpoon', 'boost', 'phase', 'repair'];
