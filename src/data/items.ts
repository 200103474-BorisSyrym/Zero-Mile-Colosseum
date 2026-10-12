import type { DriftInfo, Sim, SimVehicle } from '../game/simApi';
import type { Rarity, Stats, Tag } from './types';

/**
 * Item design rule: WHEN YOU DO X → Y HAPPENS.
 * Every item is triggered by a driving action (ram, drift, near miss, nitro, phase...). No timers that kill by
 * themselves — the car has to be driven for the build to work.
 */
export interface ItemDef {
  id: string;
  name: string;
  rarity: Rarity;
  tags: Tag[];
  /** the driving action that triggers it, shown on the card */
  trigger: string;
  /** what happens */
  effect: string;
  drawback?: string;
  icon: string;
  add?: Partial<Stats>;
  mul?: Partial<Stats>;
  pack?: string;
  onUpdate?(sim: Sim, dt: number): void;
  onRam?(sim: Sim, target: SimVehicle, impact: number, kind: string, perfect: boolean): void;
  onDriftTick?(sim: Sim, dt: number): void;
  onDriftEnd?(sim: Sim, info: DriftInfo): void;
  onNearMiss?(sim: Sim, tier: number, streak: number): void;
  onNitroStart?(sim: Sim): void;
  onNitroTick?(sim: Sim, dt: number): void;
  onKill?(sim: Sim, target: SimVehicle, cause: string): void;
  onDamaged?(sim: Sim, amount: number, kind: string): void;
  onPhaseThrough?(sim: Sim, target: SimVehicle): void;
  onPickup?(sim: Sim, kind: string): void;
  onLanding?(sim: Sim, good: boolean): void;
  onComboCash?(sim: Sim, credits: number): void;
}

const behind = (sim: Sim, dist: number) => {
  const p = sim.player;
  return { x: p.pos.x - Math.sin(p.yaw) * dist, z: p.pos.z - Math.cos(p.yaw) * dist };
};
const ready = (sim: Sim, key: string, cd: number) => {
  if ((sim.mem[key] ?? -999) + cd > sim.time) return false;
  sim.mem[key] = sim.time;
  return true;
};
const KMH = 3.6;

export const ITEMS: ItemDef[] = [
  // ======================================================================== RAM — verb: HIT · resource: MASS
  {
    id: 'iron_plow', name: 'IRON PLOW', rarity: 'COMMON', tags: ['RAM'], icon: '▰',
    trigger: 'WHEN YOU LAND A PERFECT RAM', effect: 'Gain 2 extra MASS. Ram damage +20%.',
    mul: { ramDamage: 1.2 },
    onRam(sim, _t, _i, _k, perfect) {
      if (perfect) sim.addMass(2);
    },
  },
  {
    id: 'deadweight', name: 'DEADWEIGHT', rarity: 'RARE', tags: ['RAM'], icon: '■',
    trigger: 'WHILE ABOVE 120 KM/H', effect: 'MASS stops decaying. Each MASS stack also cuts damage taken by 4%.',
    drawback: 'Heavier steering at high MASS',
  },
  {
    id: 'shock_bumper', name: 'SHOCK BUMPER', rarity: 'RARE', tags: ['RAM', 'ELECTRIC'], icon: '⬢',
    trigger: 'WHEN YOU RAM AT 3+ MASS', effect: 'Release a shockwave that throws nearby cars into each other.',
    onRam(sim, t, impact) {
      if (impact > 9 && sim.res.mass >= 3 && ready(sim, 'shockb', 0.5)) sim.shockwave(t.pos.x, t.pos.z, 11, 26, 18);
    },
  },
  {
    id: 'wrecking_ball', name: 'WRECKING BALL', rarity: 'EPIC', tags: ['RAM'], icon: '●',
    trigger: 'WHEN YOU RAM A CAR', effect: 'It is launched 60% harder and whatever it hits takes your ram damage.',
  },
  {
    id: 'juggernaut_core', name: 'JUGGERNAUT CORE', rarity: 'LEGENDARY', tags: ['RAM'], icon: '♜', pack: 'pack_legend',
    trigger: 'WHILE AT MAX MASS', effect: 'Collisions cannot hurt you, and you smash straight through concrete and parked cars.',
  },
  {
    id: 'reactive_armor', name: 'REACTIVE ARMOR', rarity: 'RARE', tags: ['RAM'], icon: '✷',
    trigger: 'WHEN YOU TAKE A HEAVY HIT (10+)', effect: 'The plating detonates (radius 8) and you gain 2 MASS.',
    onDamaged(sim, amount, kind) {
      if (amount >= 10 && kind !== 'drain' && ready(sim, 'reactive', 2)) {
        sim.explode(sim.player.pos.x, sim.player.pos.z, 8, 45, { byPlayer: true, hurtsPlayer: false, color: 0xffaa33 });
        sim.addMass(2);
      }
    },
  },
  {
    id: 'missile_rack', name: 'MISSILE RACK', rarity: 'RARE', tags: ['RAM'], icon: '➶',
    trigger: 'WHEN YOU LAND A PERFECT RAM', effect: 'Launch 2 homing missiles at the nearest enemies.',
    onRam(sim, _t, _i, _k, perfect) {
      if (perfect) sim.missiles(2, 40);
    },
  },
  // ======================================================================== DRIFT — verb: SLIDE · resource: CHARGE
  {
    id: 'drift_cannon', name: 'DRIFT CANNON', rarity: 'EPIC', tags: ['DRIFT'], icon: '⟫',
    trigger: 'WHEN YOU EXIT A DRIFT WITH 60+ CHARGE', effect: 'Fire a forward shock-cannon. Damage scales with CHARGE.',
    onDriftEnd(sim, info) {
      if (info.charge >= 60) {
        const p = sim.player;
        sim.cannon(p.pos.x, p.pos.z, Math.atan2(p.velX, p.velZ), 30, 7, 30 + info.charge * 0.7);
      }
    },
  },
  {
    id: 'slide_saw', name: 'SLIDE SAW', rarity: 'COMMON', tags: ['DRIFT', 'RAM'], icon: '✣',
    trigger: 'WHILE DRIFTING', effect: 'Side contacts deal double damage and leave the target exposed.',
  },
  {
    id: 'perfect_exit', name: 'PERFECT EXIT', rarity: 'COMMON', tags: ['DRIFT'], icon: '◐',
    trigger: 'WHEN YOU EXIT A DRIFT PERFECTLY', effect: 'Refill 25 nitro and add +1 combo.',
    onDriftEnd(sim, info) {
      if (info.perfectExit && info.duration > 0.7) {
        sim.addNitro(25);
        sim.addCombo(1, 'exit');
      }
    },
  },
  {
    id: 'orbit_tires', name: 'ORBIT TIRES', rarity: 'RARE', tags: ['DRIFT'], icon: '◎',
    trigger: 'WHILE DRIFTING', effect: 'Nearby enemies are dragged into your slide — line them up for the exit.',
    onDriftTick(sim, dt) {
      for (const v of sim.nearest(sim.player.pos.x, sim.player.pos.z, 16, 4)) if (!v.isBoss) sim.pull(v, sim.player.pos.x, sim.player.pos.z, 10 * dt);
    },
  },
  {
    id: 'infinite_angle', name: 'INFINITE ANGLE', rarity: 'LEGENDARY', tags: ['DRIFT'], icon: '∞', pack: 'pack_legend',
    trigger: 'WHILE DRIFTING', effect: 'No speed loss while sliding. Exiting a 3s+ drift releases a ring shockwave.',
    onDriftEnd(sim, info) {
      if (info.duration >= 3) sim.shockwave(sim.player.pos.x, sim.player.pos.z, 15, 30, 30);
    },
  },
  {
    id: 'kick_turn', name: 'KICK TURN', rarity: 'RARE', tags: ['DRIFT', 'SPEED'], icon: '⤳',
    trigger: 'WHEN YOU EXIT A DRIFT', effect: 'The exit boost is 50% stronger, and rams during it deal +50% damage.',
  },
  // ======================================================================== SPEED — verb: PASS · resource: VELOCITY
  {
    id: 'slipstream_kit', name: 'SLIPSTREAM KIT', rarity: 'COMMON', tags: ['SPEED'], icon: '⇶',
    trigger: 'WHILE DRAFTING BEHIND A CAR', effect: 'VELOCITY fills 3x faster. Pulling out of the draft gives a 1s burst.',
  },
  {
    id: 'afterburn_valve', name: 'AFTERBURN VALVE', rarity: 'RARE', tags: ['SPEED'], icon: '≫',
    trigger: 'WHEN YOU MAKE A CLOSE CALL ABOVE 160 KM/H', effect: '0.8s boost and +6 nitro.',
    onNearMiss(sim, tier) {
      if (tier >= 2 && sim.player.speed * KMH > 160) {
        sim.boost(0.8);
        sim.addNitro(6);
      }
    },
  },
  {
    id: 'kinetic_plating', name: 'KINETIC PLATING', rarity: 'RARE', tags: ['SPEED', 'RAM'], icon: '⇥',
    trigger: 'WHEN YOU RAM', effect: 'Ram damage +1% per point of VELOCITY (up to +100%).',
  },
  {
    id: 'redline', name: 'REDLINE', rarity: 'EPIC', tags: ['SPEED'], icon: '⧗',
    trigger: 'WHEN YOU PERFECT NEAR MISS AT FULL VELOCITY', effect: 'Time bends for 0.6s and you gain +2 combo.',
    onNearMiss(sim, tier) {
      if (tier >= 3 && sim.res.velocity >= 99 && ready(sim, 'redline', 2)) {
        sim.slowMo(0.6, 0.4);
        sim.addCombo(2, 'redline');
      }
    },
  },
  {
    id: 'sound_barrier', name: 'SOUND BARRIER', rarity: 'LEGENDARY', tags: ['SPEED'], icon: '⟿', pack: 'pack_legend',
    trigger: 'WHEN YOU HIT NITRO AT FULL VELOCITY', effect: 'A sonic boom blows every car ahead aside. Spends the VELOCITY.',
    onNitroStart(sim) {
      if (sim.res.velocity >= 99) {
        const p = sim.player;
        sim.cannon(p.pos.x, p.pos.z, p.yaw, 45, 12, 35);
        sim.res.velocity = 0;
        sim.notify('SONIC BOOM', '#5af0ff');
      }
    },
  },
  // ======================================================================== FIRE/OIL — verb: LAY TRAPS
  {
    id: 'oil_slick', name: 'OIL SLICK', rarity: 'COMMON', tags: ['FIRE'], icon: '◍',
    trigger: 'WHILE DRIFTING', effect: 'Leak oil. Enemies that cross it spin out and are exposed.',
    onDriftTick(sim) {
      const p = sim.player;
      if (p.grounded && p.speed > 10 && ready(sim, 'oil', 0.12)) {
        const b = behind(sim, 2.6);
        sim.spawnHazard('oil', b.x, b.z, 2.2, sim.synergy('burning_road') ? 12 : 8);
      }
    },
  },
  {
    id: 'igniter', name: 'IGNITER', rarity: 'RARE', tags: ['FIRE'], icon: '♨',
    trigger: 'WHEN YOUR NITRO FLAME PASSES OVER OIL', effect: 'The oil ignites into a burning pool and you recover 4 nitro per pool.',
    onNitroTick(sim) {
      if (ready(sim, 'ign', 0.12)) {
        const b = behind(sim, 3);
        sim.mem.igniteX = b.x;
        sim.mem.igniteZ = b.z;
        sim.mem.igniteT = sim.time;
      }
    },
  },
  {
    id: 'napalm_ram', name: 'NAPALM RAM', rarity: 'RARE', tags: ['FIRE', 'RAM'], icon: '♒', pack: 'pack_fire',
    trigger: 'WHEN YOU LAND A PERFECT RAM', effect: 'The victim bursts into flame and splashes burning oil around it.',
    onRam(sim, t, _i, _k, perfect) {
      if (!perfect) return;
      t.burn(4, 16);
      for (let i = 0; i < 3; i++) sim.spawnHazard('fire', t.pos.x + (Math.random() - 0.5) * 5, t.pos.z + (Math.random() - 0.5) * 5, 2.4, 5, 20);
    },
  },
  {
    id: 'firewall', name: 'FIREWALL', rarity: 'EPIC', tags: ['FIRE'], icon: '✺', pack: 'pack_fire',
    trigger: 'WHEN A BURNING ENEMY DIES', effect: 'It explodes in a fireball (radius 8) — set one alight in a pack.',
    onKill(sim, t) {
      if (t.burnT > 0) sim.explode(t.pos.x, t.pos.z, 8, 40, { byPlayer: true, hurtsPlayer: false, fire: true, chainId: t.chainId });
    },
  },
  {
    id: 'inferno_core', name: 'INFERNO CORE', rarity: 'LEGENDARY', tags: ['FIRE'], icon: '❂', pack: 'pack_legend',
    trigger: 'WHILE ENEMIES STAND IN YOUR FIRE', effect: 'They are exposed and take double damage from everything.',
  },
  // ======================================================================== ELECTRIC — verb: CHAIN · resource: STATIC
  {
    id: 'static_chassis', name: 'STATIC CHASSIS', rarity: 'COMMON', tags: ['ELECTRIC'], icon: 'ϟ',
    trigger: 'WHEN YOU RAM WITH FULL STATIC', effect: 'Near misses and contact build STATIC; a full charge arcs into 3 enemies on your next ram.',
    onRam(sim, t, impact) {
      if (impact > 6 && sim.res.static >= 99) {
        sim.res.static = 0;
        sim.chainLightning(t.pos.x, t.pos.z, 3, 30, 22);
      }
    },
  },
  {
    id: 'arc_tires', name: 'ARC TIRES', rarity: 'RARE', tags: ['ELECTRIC', 'DRIFT'], icon: '⌇', pack: 'pack_electric',
    trigger: 'WHEN YOU EXIT A DRIFT AT FULL STATIC', effect: 'Drifting builds STATIC fast; the exit discharges lightning into 4 enemies.',
    onDriftTick(sim, dt) {
      sim.addStatic(28 * dt);
    },
    onDriftEnd(sim) {
      if (sim.res.static >= 99) {
        sim.res.static = 0;
        sim.chainLightning(sim.player.pos.x, sim.player.pos.z, 4, 32, 26);
      }
    },
  },
  {
    id: 'capacitor_bumper', name: 'CAPACITOR BUMPER', rarity: 'EPIC', tags: ['ELECTRIC'], icon: '⌁', pack: 'pack_electric',
    trigger: 'WHEN YOUR ELECTRICITY HITS', effect: 'Targets are stunned and exposed for 2s. Abilities recharge 30% faster.',
    mul: { abilityCooldown: 0.7 },
  },
  {
    id: 'storm_dynamo', name: 'STORM DYNAMO', rarity: 'LEGENDARY', tags: ['ELECTRIC'], icon: '⚡', pack: 'pack_legend',
    trigger: 'WHEN YOU DISCHARGE', effect: 'Arcs chain +2 and jump through traffic as conductors.',
  },
  // ======================================================================== GHOST — verb: PASS THROUGH
  {
    id: 'phase_coil', name: 'PHASE COIL', rarity: 'COMMON', tags: ['GHOST'], icon: '◌',
    trigger: 'WHEN YOU PERFECT NEAR MISS', effect: 'Phase for 0.8s: drive straight through cars.',
    onNearMiss(sim, tier) {
      if (tier >= 3) sim.setPhase(0.8);
    },
  },
  {
    id: 'echo_trail', name: 'ECHO TRAIL', rarity: 'RARE', tags: ['GHOST'], icon: '≋',
    trigger: 'WHILE PHASED', effect: 'You leave an echo that wrecks anything following you.',
    onUpdate(sim) {
      const p = sim.player;
      if (p.phase > 0 && ready(sim, 'echo', 0.08)) {
        const b = behind(sim, 2.5);
        sim.spawnHazard('ghost', b.x, b.z, 1.9, 1.2, 70);
      }
    },
  },
  {
    id: 'spectral_ram', name: 'SPECTRAL RAM', rarity: 'EPIC', tags: ['GHOST', 'RAM'], icon: '◇',
    trigger: 'WHEN YOU PHASE THROUGH AN ENEMY', effect: 'It is exposed for 2.5s and you gain 12 Momentum.',
    onPhaseThrough(sim, t) {
      t.expose(2.5);
      sim.addMomentum(12);
    },
  },
  {
    id: 'wraith_engine', name: 'WRAITH ENGINE', rarity: 'LEGENDARY', tags: ['GHOST', 'SPEED'], icon: '☊', pack: 'pack_legend',
    trigger: 'WHEN YOU PHASE THROUGH 3 CARS IN ONE PHASE', effect: 'Wraith burst: shockwave and a full nitro tank.',
    onPhaseThrough(sim) {
      if (sim.res.phaseHits >= 3 && ready(sim, 'wraith', 1)) {
        sim.shockwave(sim.player.pos.x, sim.player.pos.z, 14, 28, 25);
        sim.addNitro(999);
        sim.notify('WRAITH BURST', '#b9a6ff');
      }
    },
  },
  // ======================================================================== UTILITY
  {
    id: 'field_mechanic', name: 'FIELD MECHANIC', rarity: 'COMMON', tags: [], icon: '✚',
    trigger: 'WHEN YOU CASH OUT A COMBO', effect: 'Repair 1 HP per 8 credits banked.',
    onComboCash(sim, credits) {
      sim.heal(credits / 8);
    },
  },
  {
    id: 'gamblers_clutch', name: "GAMBLER'S CLUTCH", rarity: 'RARE', tags: [], icon: '♠',
    trigger: 'WHILE YOUR COMBO RUNS', effect: 'The combo bank grows 60% faster.', drawback: 'Crashing loses the bank and 5 HP',
  },
  {
    id: 'economy_injector', name: 'ECONOMY INJECTOR', rarity: 'COMMON', tags: [], icon: '⛽',
    trigger: 'WHEN YOU GRAB FUEL', effect: '-40% fuel use. Fuel pickups also repair 5 HP.',
    mul: { fuelUse: 0.6 },
    onPickup(sim, kind) {
      if (kind === 'fuel') sim.heal(5);
    },
  },
  {
    id: 'stunt_frame', name: 'STUNT FRAME', rarity: 'COMMON', tags: ['SPEED'], icon: '⇕',
    trigger: 'WHEN YOU LAND CLEANLY', effect: 'Repair 6 HP, +15 Momentum and a 1s boost. Better air control.',
    mul: { airControl: 1.8 },
    onLanding(sim, good) {
      if (good) {
        sim.heal(6);
        sim.addMomentum(15);
        sim.boost(1);
      }
    },
  },
];

export const getItem = (id: string) => ITEMS.find((i) => i.id === id);

export const RARITY_COLOR: Record<string, string> = {
  COMMON: '#b8c4d6',
  RARE: '#3fa9ff',
  EPIC: '#c46bff',
  LEGENDARY: '#ffb428',
};
