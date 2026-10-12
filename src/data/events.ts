import type { Random } from '../core/random';
import type { Rarity } from './types';

export type NodeMod = 'ambush' | 'police' | 'bounty' | 'safe' | 'tailwind' | 'race' | 'fog';

export interface EventCtx {
  rng: Random;
  hp: number;
  maxHp: number;
  credits: number;
  fuel: number;
  momentum: number;
  itemCount: number;
  mass: number;
  damagePct(p: number): void;
  healPct(p: number): void;
  addCredits(n: number): void;
  addFuel(n: number): void;
  addMomentum(n: number): void;
  addMaxHp(n: number): void;
  giveItem(rarity?: Rarity): string;
  giveSpecific(id: string): string | null;
  removeRandomItem(): string | null;
  /** Remove a random item and return its rarity (for upgrades). */
  sacrificeItem(): Rarity | null;
  setNextMod(mod: NodeMod): void;
  gainSalvage(n: number): void;
  lore(id: string): void;
}

export interface EventOption {
  label: string;
  detail: string;
  requires?: (c: EventCtx) => boolean;
  apply: (c: EventCtx) => string;
}

export interface EventDef {
  id: string;
  title: string;
  text: string;
  icon: string;
  unlock?: string;
  options: EventOption[];
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

export const EVENTS: EventDef[] = [
  {
    id: 'gas_station', title: 'GAS STATION', icon: '⛽',
    text: 'A pump island glows under a dead sign. The attendant is asleep behind bulletproof glass.',
    options: [
      { label: 'FILL UP', detail: '-15 credits · fuel to full', requires: (c) => c.credits >= 15, apply: (c) => { c.addCredits(-15); c.addFuel(100); return 'Tank full. The attendant never wakes up.'; } },
      { label: 'SIPHON THE TANKS', detail: '+50 fuel · 50%: alarm, ambush next', apply: (c) => { c.addFuel(50); if (c.rng.chance(0.5)) { c.setNextMod('ambush'); return 'The alarm screams. Headlights are already turning toward you.'; } return 'Clean getaway. Nobody saw a thing.'; } },
      { label: 'COFFEE AND A NAP', detail: '-10 credits · repair 15%', requires: (c) => c.credits >= 10, apply: (c) => { c.addCredits(-10); c.healPct(0.15); return 'Ten minutes with your eyes closed. Your hands stop shaking.'; } },
    ],
  },
  {
    id: 'mysterious_driver', title: 'MYSTERIOUS DRIVER', icon: '◐', unlock: 'ev_blackmarket',
    text: 'A matte black coupe pulls alongside. The window drops an inch. "You want to see the center? Trade me something."',
    options: [
      { label: 'TRADE A PART', detail: 'lose a random item · gain an EPIC item', requires: (c) => c.itemCount > 0, apply: (c) => { const l = c.removeRandomItem(); const g = c.giveItem('EPIC'); return `You hand over ${l}. In return: ${g}.`; } },
      { label: 'RACE HIM', detail: 'next road is a race · win big', apply: (c) => { c.setNextMod('race'); return '"Next stretch. Try to keep up."'; } },
      { label: 'ASK ABOUT THE SHIFT', detail: '-10 fuel · archive entry', apply: (c) => { c.addFuel(-10); c.lore('lore_driver'); return '"The city is not changing. It is searching." The coupe is gone before you can answer.'; } },
    ],
  },
  {
    id: 'abandoned_garage', title: 'ABANDONED GARAGE', icon: '⚒',
    text: 'Roll-up door half open. Tools still on the bench, a car lift humming on emergency power.',
    options: [
      { label: 'SCAVENGE PARTS', detail: 'COMMON item · 30%: -10% HP', apply: (c) => { const g = c.giveItem('COMMON'); if (c.rng.chance(0.3)) { c.damagePct(0.1); return `Found ${g} — then a shelf came down on the hood.`; } return `Found ${g} under a tarp.`; } },
      { label: 'USE THE LIFT', detail: 'repair 30% · -15 fuel', apply: (c) => { c.healPct(0.3); c.addFuel(-15); return 'You patch the worst of it while the generator drinks your fuel.'; } },
      { label: 'SEARCH THE OFFICE', detail: '+30 credits · archive entry', apply: (c) => { c.addCredits(30); c.lore('lore_garage'); return 'A cash box and a logbook: "Night 1,204. The ring road moved again."'; } },
    ],
  },
  {
    id: 'police_checkpoint', title: 'POLICE CHECKPOINT', icon: '⛉',
    text: 'Strobe lights and a spike strip. A drone scans your plates. "Vehicle, stop for inspection."',
    options: [
      { label: 'STOP', detail: '-15 fuel · next road is quiet', apply: (c) => { c.addFuel(-15); c.setNextMod('safe'); return 'Forty minutes of idling. They wave you through with a warning.'; } },
      { label: 'RAM THROUGH', detail: `-15% HP · +50 credits · +30 Momentum`, apply: (c) => { c.damagePct(0.15); c.addCredits(50); c.addMomentum(30); return 'Barrier, drone and dignity all go flying. Their evidence locker bounces off your roof.'; } },
      { label: 'EMP THE BOOTH', detail: '-30 Momentum · RARE item', requires: (c) => c.momentum >= 30, apply: (c) => { c.addMomentum(-30); const g = c.giveItem('RARE'); return `Everything goes dark. You help yourself to their gear: ${g}.`; } },
      { label: 'TAKE THE SERVICE ROAD', detail: 'police chase next · double credits', apply: (c) => { c.setNextMod('police'); return 'Sirens behind you within seconds. Make it worth it.'; } },
    ],
  },
  {
    id: 'roadblock', title: 'ROADBLOCK', icon: '▦',
    text: 'Concrete blocks and a burning car across all lanes. Someone wants this road closed.',
    options: [
      { label: 'PUNCH THROUGH', detail: 'heavy cars: -5% HP · light cars: -20% HP · +40 Momentum', apply: (c) => { c.damagePct(c.mass >= 2 ? 0.05 : 0.2); c.addMomentum(40); return c.mass >= 2 ? 'Concrete crumbles off your bumper.' : 'You make it through. Your suspension makes a new noise.'; } },
      { label: 'DETOUR', detail: '-20 fuel', apply: (c) => { c.addFuel(-20); return 'The long way round. The city watches.'; } },
      { label: 'PAY THE SMUGGLERS', detail: '-30 credits · +RARE item', requires: (c) => c.credits >= 30, apply: (c) => { c.addCredits(-30); const g = c.giveItem('RARE'); return `They move a block and slide a crate into your trunk: ${g}.`; } },
    ],
  },
  {
    id: 'forked_shortcut', title: 'FORKED SHORTCUT', icon: '⑂',
    text: 'The road splits. Left: an unlit tunnel nobody uses. Right: a bright highway with tolls.',
    options: [
      { label: 'LEFT · THE TUNNEL', detail: '50%: RARE item · 50%: -20% HP', apply: (c) => { if (c.rng.chance(0.5)) { const g = c.giveItem('RARE'); return `A wrecked courier van. Its cargo: ${g}.`; } c.damagePct(0.2); return 'Something in the dark hits you broadside and is gone.'; } },
      { label: 'RIGHT · THE HIGHWAY', detail: '+20 fuel · +15 credits', apply: (c) => { c.addFuel(20); c.addCredits(15); return 'A service plaza, open all night. Small mercies.'; } },
    ],
  },
  {
    id: 'illegal_race', title: 'ILLEGAL RACE', icon: '⚑',
    text: 'A parking deck full of tuned engines and bad decisions. A flag-girl drone hovers, waiting for entries.',
    options: [
      { label: 'ENTER', detail: '-20 credits · next road is a race · EPIC prize', requires: (c) => c.credits >= 20, apply: (c) => { c.addCredits(-20); c.setNextMod('race'); return 'Your number is painted on the windshield. Race starts on the next stretch.'; } },
      { label: 'BET ON THE FAVORITE', detail: '50%: +40 credits · 50%: -20 credits', requires: (c) => c.credits >= 20, apply: (c) => { if (c.rng.chance(0.5)) { c.addCredits(40); return 'The favorite wins by a bumper. Easy money.'; } c.addCredits(-20); return 'The favorite hits the wall on lap two.'; } },
      { label: 'SABOTAGE THE GRID', detail: '+RARE item · ambush next', apply: (c) => { const g = c.giveItem('RARE'); c.setNextMod('ambush'); return `You walk off with ${g}. They will come looking.`; } },
    ],
  },
  {
    id: 'broken_light', title: 'BROKEN TRAFFIC LIGHT', icon: '◍',
    text: 'Every signal at the intersection flashes green at once. Cross traffic is not slowing down.',
    options: [
      { label: 'FLOOR IT', detail: '60%: +30 Momentum, +25 credits · 40%: -15% HP', apply: (c) => { if (c.rng.chance(0.6)) { c.addMomentum(30); c.addCredits(25); return 'You thread three lanes of chaos. Someone films it.'; } c.damagePct(0.15); return 'A delivery truck clips your tail. You spin, recover, keep going.'; } },
      { label: 'WAIT FOR A GAP', detail: '-10 fuel', apply: (c) => { c.addFuel(-10); return 'Patience. The gap comes eventually.'; } },
      { label: 'DIRECT TRAFFIC', detail: '-20 Momentum · repair 10% · COMMON item', requires: (c) => c.momentum >= 20, apply: (c) => { c.addMomentum(-20); c.healPct(0.1); const g = c.giveItem('COMMON'); return `Headlights and horn untangle the mess. A grateful trucker gives you ${g}.`; } },
    ],
  },
  {
    id: 'ambush', title: 'AMBUSH', icon: '⚠',
    text: 'Headlights in every mirror. They were waiting for you specifically.',
    options: [
      { label: 'FIGHT', detail: 'ambush next road · double credits', apply: (c) => { c.setNextMod('bounty'); return 'You turn the radio up. Let them come.'; } },
      { label: 'DUMP CARGO AND RUN', detail: '-25 credits · start next road with full nitro', requires: (c) => c.credits >= 25, apply: (c) => { c.addCredits(-25); c.setNextMod('tailwind'); return 'Credits scatter across the asphalt. They stop to collect. You do not.'; } },
      { label: 'HIDE IN AN ALLEY', detail: '-15 fuel · 30%: found, -15% HP', apply: (c) => { c.addFuel(-15); if (c.rng.chance(0.3)) { c.damagePct(0.15); return 'A searchlight finds you. You burst out through a wall of bins.'; } return 'Engine off. Lights off. They pass.'; } },
    ],
  },
  {
    id: 'black_market', title: 'BLACK MARKET', icon: '⛬', unlock: 'ev_blackmarket',
    text: 'A shipping container with velvet curtains. Prices are not negotiable. Neither is silence.',
    options: [
      { label: 'MYSTERY CRATE', detail: '-90 credits · LEGENDARY item', requires: (c) => c.credits >= 90, apply: (c) => { c.addCredits(-90); const g = c.giveItem('LEGENDARY'); return `The crate is warm to the touch. Inside: ${g}.`; } },
      { label: 'SELL A PART', detail: 'lose a random item · +60 credits', requires: (c) => c.itemCount > 0, apply: (c) => { const l = c.removeRandomItem(); c.addCredits(60); return `${l} is gone. The broker does not count the cash twice.`; } },
      { label: 'TAKE THE FREE SAMPLE', detail: 'EPIC item · -15 max HP', apply: (c) => { const g = c.giveItem('EPIC'); c.addMaxHp(-15); return `${g}. Nothing is free. Your frame groans.`; } },
    ],
  },
  {
    id: 'crash_site', title: 'CRASH SITE', icon: '✖',
    text: 'A courier van on its roof, wheels still spinning. Something in the cargo bay glows.',
    options: [
      { label: 'PULL OUT THE DRIVER', detail: '-10 fuel · RARE item · archive entry', apply: (c) => { c.addFuel(-10); const g = c.giveItem('RARE'); c.lore('lore_courier'); return `She is alive. She insists you take ${g}. "Don't go to the center."`; } },
      { label: 'STRIP THE WRECK', detail: '+40 credits · +20 fuel', apply: (c) => { c.addCredits(40); c.addFuel(20); return 'Fuel, cash, a working battery. The glow fades as you leave.'; } },
      { label: 'TAP THE REACTOR', detail: '+50 Momentum · -15% HP', apply: (c) => { c.addMomentum(50); c.damagePct(0.15); return 'Raw energy floods your systems. Some of it burns.'; } },
    ],
  },
  {
    id: 'strange_signal', title: 'STRANGE SIGNAL', icon: '〰',
    text: 'Your radio tunes itself. A voice counts down mile markers that do not exist.',
    options: [
      { label: 'FOLLOW THE SIGNAL', detail: '50%: EPIC item · 50%: ambush in fog', apply: (c) => { if (c.rng.chance(0.5)) { const g = c.giveItem('EPIC'); return `The signal leads to a sealed locker: ${g}.`; } c.setNextMod('fog'); return 'The signal leads into a fog bank. Engines start all around you.'; } },
      { label: 'RECORD IT', detail: '+15 salvage · archive entry', apply: (c) => { c.gainSalvage(15); c.lore('lore_signal'); return 'You save the transmission. Played backward, it is your own voice.'; } },
      { label: 'JAM IT', detail: '+15 Momentum', apply: (c) => { c.addMomentum(15); return 'Static. Silence. Your engine sounds louder than before.'; } },
    ],
  },
  {
    id: 'neon_chapel', title: 'NEON CHAPEL', icon: '✝', unlock: 'ev_blackmarket',
    text: 'Drivers leave keys and hood ornaments on an altar of tube lights. It hums like an engine.',
    options: [
      { label: 'LEAVE AN OFFERING', detail: '-30 credits · +15 max HP · repair 15%', requires: (c) => c.credits >= 30, apply: (c) => { c.addCredits(-30); c.addMaxHp(15); c.healPct(0.15); return 'The lights brighten. So does something in your chassis.'; } },
      { label: 'SACRIFICE A PART', detail: 'lose a random item · gain one of higher rarity', requires: (c) => c.itemCount > 0, apply: (c) => { const r = c.sacrificeItem(); const up: Record<string, Rarity> = { COMMON: 'RARE', RARE: 'EPIC', EPIC: 'LEGENDARY', LEGENDARY: 'LEGENDARY' }; const g = c.giveItem(up[r ?? 'COMMON']); return `The altar takes it. It gives back ${g}.`; } },
      { label: 'SIT IN SILENCE', detail: 'Momentum to full', apply: (c) => { c.addMomentum(100); return 'For a moment the city stops moving.'; } },
    ],
  },
  {
    id: 'scrap_dealer', title: 'SCRAP DEALER', icon: '⚙',
    text: 'An old man with a tow truck and a scale. "Fuel, parts, plates. Everything has a price."',
    options: [
      { label: 'SELL FUEL', detail: '-20 fuel · +40 credits', requires: (c) => c.fuel >= 25, apply: (c) => { c.addFuel(-20); c.addCredits(40); return 'He siphons it into a jerrycan, whistling.'; } },
      { label: 'BUY ARMOR PATCH', detail: '-25 credits · +20 max HP', requires: (c) => c.credits >= 25, apply: (c) => { c.addCredits(-25); c.addMaxHp(20); return 'Two plates riveted on in five minutes flat.'; } },
      { label: 'ASK FOR DIRECTIONS', detail: '+10 Momentum · archive entry', apply: (c) => { c.addMomentum(10); c.lore('lore_scrap'); return '"Directions? Kid, the roads ask *you* where to go now."'; } },
    ],
  },
  {
    id: 'radio_broadcast', title: 'RADIO BROADCAST', icon: '📻',
    text: 'Every station plays the same engine note. Then a voice: "I see you. Keep driving."',
    options: [
      { label: 'ANSWER', detail: 'bounty hunters next · double credits · archive', apply: (c) => { c.setNextMod('bounty'); c.lore('lore_broadcast'); return '"Good." The Driver has marked you. Hunters are on the way.'; } },
      { label: 'SWITCH IT OFF', detail: 'repair 10%', apply: (c) => { c.healPct(0.1); return 'Silence feels like armor.'; } },
    ],
  },
];

export const describePct = pct;
