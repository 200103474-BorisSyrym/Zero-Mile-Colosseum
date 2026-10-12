export type EnemyKind = 'interceptor' | 'rammer' | 'gunner' | 'bomber' | 'empvan' | 'blocker' | 'drone' | 'hunter';
export type TrafficKind = 'sedan' | 'hatch' | 'van' | 'truck' | 'taxi';
export type ModelKind =
  | EnemyKind | TrafficKind
  | 'courier' | 'ghost' | 'hauler' | 'player_rammer'
  | 'boss_mule' | 'boss_bus' | 'boss_taxon' | 'boss_apex' | 'boss_driver' | 'police';

export interface EnemyDef {
  kind: EnemyKind;
  name: string;
  description: string;
  hp: number;
  mass: number;
  speed: number;
  accel: number;
  length: number;
  width: number;
  credits: number;
  color: number;
  accent: number;
  threat: number;
  /** hits from this side deal double damage */
  weak: 'side' | 'rear' | 'front' | 'any';
  /** damage multiplier for hits that are neither on the weak side nor while exposed */
  armor: number;
}

export const ENEMIES: Record<EnemyKind, EnemyDef> = {
  interceptor: { kind: 'interceptor', name: 'INTERCEPTOR', description: 'Cuts across your line to force you into walls. Flimsy from the side.', hp: 40, mass: 1.1, speed: 50, accel: 22, length: 4.3, width: 1.95, credits: 6, color: 0x1b1b24, accent: 0xff2a4a, threat: 1, weak: 'side', armor: 0.8 },
  rammer: { kind: 'rammer', name: 'RAMMER', description: 'Locks a lane, flashes it red, then charges down it. Exposed after the charge.', hp: 70, mass: 2.4, speed: 46, accel: 18, length: 5.0, width: 2.2, credits: 9, color: 0x2a2018, accent: 0xff6a00, threat: 1.5, weak: 'rear', armor: 0.6 },
  gunner: { kind: 'gunner', name: 'GUNNER', description: 'Paints your lane and rakes it. Turret exposed while reloading; weak from behind.', hp: 45, mass: 1.3, speed: 48, accel: 18, length: 4.6, width: 2.0, credits: 8, color: 0x1a2028, accent: 0xffd400, threat: 1.3, weak: 'rear', armor: 0.7 },
  bomber: { kind: 'bomber', name: 'BOMBER', description: 'A rolling bomb that hugs its allies. Ram it and the fuse starts — push it into them.', hp: 20, mass: 0.9, speed: 38, accel: 18, length: 3.6, width: 1.85, credits: 6, color: 0x281818, accent: 0xff1a1a, threat: 1.1, weak: 'any', armor: 1 },
  empvan: { kind: 'empvan', name: 'EMP VAN', description: 'Drops EMP domes that shut down nitro and abilities. Shields drop while it deploys.', hp: 60, mass: 1.9, speed: 44, accel: 15, length: 5.2, width: 2.2, credits: 10, color: 0x1a1c2a, accent: 0x40a0ff, threat: 1.4, weak: 'side', armor: 0.35 },
  blocker: { kind: 'blocker', name: 'BLOCKER', description: 'Heavy hauler that closes lanes. Armoured nose, soft flanks. Shove it into others.', hp: 120, mass: 4.5, speed: 34, accel: 10, length: 9.0, width: 2.6, credits: 12, color: 0x23262b, accent: 0xff9a00, threat: 1.6, weak: 'side', armor: 0.5 },
  drone: { kind: 'drone', name: 'DRONE', description: 'Spotter: marks your path and calls electric strikes. Low enough to ram.', hp: 15, mass: 0.4, speed: 60, accel: 30, length: 1.6, width: 1.6, credits: 5, color: 0x202028, accent: 0xff3355, threat: 0.8, weak: 'any', armor: 1 },
  hunter: { kind: 'hunter', name: 'HUNTER', description: 'Elite pursuer. Tails and side-slams. Juke it into walls, hazards and traffic.', hp: 110, mass: 1.6, speed: 60, accel: 26, length: 4.6, width: 2.0, credits: 22, color: 0x0b0b0f, accent: 0xff0040, threat: 3, weak: 'side', armor: 0.6 },
};

export const TRAFFIC_KINDS: TrafficKind[] = ['sedan', 'hatch', 'van', 'truck', 'taxi', 'sedan', 'hatch'];
export const TRAFFIC_DIMS: Record<TrafficKind, { length: number; width: number; mass: number; hp: number }> = {
  sedan: { length: 4.5, width: 1.95, mass: 1.3, hp: 35 },
  hatch: { length: 3.9, width: 1.85, mass: 1.1, hp: 30 },
  van: { length: 5.2, width: 2.15, mass: 1.9, hp: 50 },
  truck: { length: 8.0, width: 2.5, mass: 4.0, hp: 90 },
  taxi: { length: 4.5, width: 1.95, mass: 1.3, hp: 35 },
};
