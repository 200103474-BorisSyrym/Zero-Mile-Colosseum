import type { EnemyKind } from './enemies';

export type SegmentType =
  | 'STRAIGHT' | 'CURVE' | 'S_CURVE' | 'INTERSECTION' | 'TUNNEL' | 'BRIDGE' | 'JUMP'
  | 'NARROW_STREET' | 'PARKING_AREA' | 'INDUSTRIAL_ZONE' | 'HAZARD_ZONE' | 'TURN_SHARP' | 'CHICANE'
  /** broken bridge: run-up, ramp, a real hole in the road, landing zone */
  | 'GAP_JUMP';

export type BossId = 'iron_mule' | 'drowned_line' | 'taxon' | 'apex' | 'the_driver';

export interface ZoneDef {
  id: string;
  index: number;
  name: string;
  subtitle: string;
  description: string;
  fog: number;
  fogDensity: number;
  skyTop: number;
  skyBottom: number;
  ambient: number;
  neon: number[];
  streetLight: number;
  barrierColor: number;
  rain: number;
  traffic: number;
  traction: number;
  baseWidth: number;
  segments: [SegmentType, number][];
  enemies: [EnemyKind, number][];
  hazard: 'oil' | 'water' | 'electric' | 'fire' | 'glitch';
  boss: BossId;
  music: { root: number; bpm: number; scale: number[] };
  buildingHeight: [number, number];
  buildingGap: number;
  elevated: boolean;
}

export const ZONES: ZoneDef[] = [
  {
    id: 'industrial', index: 0, name: 'INDUSTRIAL RING', subtitle: 'SODIUM LIGHT AND RUST',
    description: 'The outer ring. Container stacks, cranes and heavy haulers that never stop moving.',
    fog: 0x40281a, fogDensity: 0.0052, skyTop: 0x0c0a12, skyBottom: 0x5a3420, ambient: 0x5a4030,
    neon: [0xff8a1a, 0xffc040, 0xff4a20, 0x40d0ff], streetLight: 0xffa040, barrierColor: 0xff8a1a,
    rain: 0.5, traffic: 0.55, traction: 1, baseWidth: 12,
    segments: [['TURN_SHARP', 2], ['CHICANE', 1.5], ['STRAIGHT', 3], ['CURVE', 3], ['S_CURVE', 2], ['INDUSTRIAL_ZONE', 3], ['TUNNEL', 1], ['JUMP', 1], ['INTERSECTION', 1.5], ['PARKING_AREA', 1], ['HAZARD_ZONE', 1]],
    enemies: [['interceptor', 4], ['rammer', 3], ['blocker', 1.5], ['bomber', 1.5], ['gunner', 1]],
    hazard: 'oil', boss: 'iron_mule', music: { root: 45, bpm: 104, scale: [0, 3, 5, 7, 10] },
    buildingHeight: [8, 26], buildingGap: 5, elevated: false,
  },
  {
    id: 'flood', index: 1, name: 'FLOOD DISTRICT', subtitle: 'THE STREETS REMEMBER THE RIVER',
    description: 'Half-drowned avenues. Live cables in the water and almost no grip.',
    fog: 0x123440, fogDensity: 0.0058, skyTop: 0x050c14, skyBottom: 0x18485a, ambient: 0x2a5060,
    neon: [0x20f0e0, 0x40a0ff, 0x80ffd0, 0xff40a0], streetLight: 0x80e0ff, barrierColor: 0x20e0ff,
    rain: 1, traffic: 0.4, traction: 0.82, baseWidth: 12,
    segments: [['TURN_SHARP', 2], ['CHICANE', 1.5], ['STRAIGHT', 2.5], ['CURVE', 3], ['S_CURVE', 2.5], ['BRIDGE', 3], ['HAZARD_ZONE', 2.5], ['TUNNEL', 1], ['INTERSECTION', 1], ['JUMP', 1]],
    enemies: [['interceptor', 3], ['empvan', 2.5], ['drone', 2.5], ['gunner', 2], ['bomber', 1.5], ['rammer', 1]],
    hazard: 'water', boss: 'drowned_line', music: { root: 43, bpm: 98, scale: [0, 2, 3, 7, 8] },
    buildingHeight: [10, 34], buildingGap: 6, elevated: false,
  },
  {
    id: 'oldcity', index: 2, name: 'OLD CITY', subtitle: 'A THOUSAND SIGNS, NONE POINTING OUT',
    description: 'Dense neon canyons, sharp corners and traffic everywhere.',
    fog: 0x341640, fogDensity: 0.0056, skyTop: 0x0e0614, skyBottom: 0x5a1e56, ambient: 0x553060,
    neon: [0xff2bd6, 0xff3060, 0x40e0ff, 0xffe040, 0x9a5bff], streetLight: 0xff70d0, barrierColor: 0xff2bd6,
    rain: 0.75, traffic: 1, traction: 0.95, baseWidth: 11.5,
    segments: [['NARROW_STREET', 3], ['CURVE', 3], ['S_CURVE', 3], ['INTERSECTION', 3], ['STRAIGHT', 1.5], ['PARKING_AREA', 1], ['HAZARD_ZONE', 1], ['TUNNEL', 1]],
    enemies: [['interceptor', 3], ['gunner', 2.5], ['bomber', 2], ['empvan', 1.5], ['rammer', 1.5], ['drone', 1.5], ['hunter', 0.5]],
    hazard: 'fire', boss: 'taxon', music: { root: 47, bpm: 112, scale: [0, 3, 5, 6, 7, 10] },
    buildingHeight: [16, 48], buildingGap: 2, elevated: false,
  },
  {
    id: 'skyway', index: 3, name: 'SKYWAY', subtitle: 'NOTHING BELOW BUT LIGHT',
    description: 'Elevated super-highways. Huge speed, jumps, and gaps in the barriers.',
    fog: 0x1a2a58, fogDensity: 0.0036, skyTop: 0x040818, skyBottom: 0x2a4280, ambient: 0x34487a,
    neon: [0x60a0ff, 0xffffff, 0x40ffd0, 0xff60a0], streetLight: 0xb0d0ff, barrierColor: 0x60a0ff,
    rain: 0.35, traffic: 0.8, traction: 1, baseWidth: 15.5,
    segments: [['TURN_SHARP', 2], ['CHICANE', 1.5], ['STRAIGHT', 3], ['CURVE', 3], ['JUMP', 2.5], ['BRIDGE', 2], ['S_CURVE', 1.5], ['HAZARD_ZONE', 1], ['TUNNEL', 0.8]],
    enemies: [['interceptor', 3], ['hunter', 1.5], ['drone', 2.5], ['gunner', 2], ['bomber', 1.5], ['rammer', 1.5], ['blocker', 1]],
    hazard: 'electric', boss: 'apex', music: { root: 50, bpm: 122, scale: [0, 2, 4, 7, 9] },
    buildingHeight: [30, 90], buildingGap: 14, elevated: true,
  },
  {
    id: 'zeromile', index: 4, name: 'ZERO MILE', subtitle: 'WHERE THE CITY FORGETS ITSELF',
    description: 'Reality comes apart. Impossible roads over a neon void.',
    fog: 0x2a0818, fogDensity: 0.0046, skyTop: 0x040004, skyBottom: 0x480a26, ambient: 0x4a1830,
    neon: [0xff1040, 0xffffff, 0xff40ff, 0x40ffff], streetLight: 0xff3060, barrierColor: 0xff1040,
    rain: 0.25, traffic: 0.5, traction: 0.95, baseWidth: 12.5,
    segments: [['TURN_SHARP', 2], ['CHICANE', 1.5], ['STRAIGHT', 2], ['CURVE', 2.5], ['S_CURVE', 2.5], ['JUMP', 2], ['HAZARD_ZONE', 2.5], ['BRIDGE', 1.5], ['TUNNEL', 1.5], ['NARROW_STREET', 1]],
    enemies: [['hunter', 2], ['interceptor', 2], ['drone', 2], ['bomber', 2], ['empvan', 1.5], ['gunner', 1.5], ['rammer', 1.5], ['blocker', 0.7]],
    hazard: 'glitch', boss: 'the_driver', music: { root: 41, bpm: 126, scale: [0, 1, 3, 6, 7, 10] },
    buildingHeight: [10, 70], buildingGap: 10, elevated: true,
  },
];
