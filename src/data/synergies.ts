import type { Stats, Tag } from './types';

export interface SynergyDef {
  id: string;
  name: string;
  req: Partial<Record<Tag, number>>;
  description: string;
  mul?: Partial<Stats>;
  add?: Partial<Stats>;
}

/**
 * Two tiers per archetype. Effects change how the car plays (checked in the systems via sim.synergy(id)),
 * not just its numbers.
 */
export const SYNERGIES: SynergyDef[] = [
  { id: 'mass_increase', name: 'MASS INCREASE', req: { RAM: 3 }, description: 'MASS caps at 8 instead of 5 and decays half as fast.' },
  { id: 'unstoppable', name: 'UNSTOPPABLE', req: { RAM: 5 }, description: 'Every heavy collision adds MASS. At 5+ MASS nothing can knock you around and walls barely slow you.' },
  { id: 'perfect_exit', name: 'PERFECT EXIT', req: { DRIFT: 3 }, description: 'Wider perfect window. Every perfect drift exit releases a burst that shoves cars aside.' },
  { id: 'slide_chain', name: 'SLIDE CHAIN', req: { DRIFT: 5 }, description: 'Chain drifts within 1s to keep your CHARGE; every chained exit fires a burst.' },
  { id: 'velocity', name: 'VELOCITY', req: { SPEED: 3 }, description: 'VELOCITY fills 50% faster. At full VELOCITY your top speed rises.' },
  { id: 'time_pressure', name: 'TIME PRESSURE', req: { SPEED: 5 }, description: 'Above 180 km/h the world slows 30% around you, and your brakes bite 30% harder.' },
  { id: 'burning_road', name: 'BURNING ROAD', req: { FIRE: 3 }, description: 'Oil ignites when a ram or explosion happens near it. Fire lasts twice as long.' },
  { id: 'inferno', name: 'INFERNO', req: { FIRE: 5 }, description: 'Fire zones chain into each other. Burning enemies explode when they die.' },
  { id: 'chain_shock', name: 'CHAIN SHOCK', req: { ELECTRIC: 3 }, description: 'Every discharge arcs to 2 extra targets.' },
  { id: 'storm', name: 'STORM', req: { ELECTRIC: 5 }, description: 'Arcs keep jumping to the next nearest enemy. Stunned enemies take double damage.' },
  { id: 'afterimage', name: 'AFTERIMAGE', req: { GHOST: 3 }, description: 'Phase lasts 50% longer and leaves a damaging echo behind you.', mul: { phaseDuration: 1.5 } },
  { id: 'phantom', name: 'PHANTOM', req: { GHOST: 5 }, description: 'Every perfect near miss phases you. Enemies you pass through are exposed.' },
];

export const ARCHETYPE_NAMES: Record<Tag, string> = {
  RAM: 'JUGGERNAUT',
  DRIFT: 'DRIFT ARTIST',
  SPEED: 'VELOCITY DEMON',
  FIRE: 'ARSONIST',
  ELECTRIC: 'STORMBRINGER',
  GHOST: 'PHANTOM',
};

export const ARCHETYPE_VERB: Record<Tag, string> = {
  RAM: 'HIT · MASS',
  DRIFT: 'SLIDE · CHARGE',
  SPEED: 'PASS · VELOCITY',
  FIRE: 'LAY TRAPS · OIL',
  ELECTRIC: 'CHAIN · STATIC',
  GHOST: 'PASS THROUGH · PHASE',
};
