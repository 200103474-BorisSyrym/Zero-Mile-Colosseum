export interface AchievementDef {
  id: string;
  name: string;
  description: string;
}

export const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'first_blood', name: 'FIRST BLOOD', description: 'Destroy your first enemy.' },
  { id: 'neon_drift', name: 'NEON DRIFT', description: 'Hold a single drift for 5 seconds.' },
  { id: 'close_call', name: 'CLOSE CALL', description: 'Perform 10 near misses in one run.' },
  { id: 'juggernaut', name: 'JUGGERNAUT', description: 'Destroy 10 enemies by ramming in one run.' },
  { id: 'overdrive', name: 'OVERDRIVE', description: 'Reach 200 km/h.' },
  { id: 'chain_reaction', name: 'CHAIN REACTION', description: 'Destroy 5 enemies in a single chain reaction.' },
  { id: 'no_brakes', name: 'NO BRAKES', description: 'Finish a road with an average speed above 150 km/h.' },
  { id: 'survivor', name: 'SURVIVOR', description: 'Complete a run with less than 10% HP.' },
  { id: 'zero_mile', name: 'ZERO MILE', description: 'Reach the final boss.' },
  { id: 'driver', name: 'DRIVER', description: 'Complete the game.' },
  { id: 'buildcraft', name: 'BUILDCRAFT', description: 'Activate 3 synergies in one run.' },
  { id: 'airtime', name: 'AIRTIME', description: 'Stay airborne for 1.5 seconds.' },
  { id: 'boss_slayer', name: 'IRON WILL', description: 'Defeat your first boss.' },
  { id: 'hoarder', name: 'HOARDER', description: 'Carry 12 items at once.' },
];

export interface UnlockDef {
  id: string;
  name: string;
  description: string;
  price: number;
  category: 'ITEMS' | 'ABILITIES' | 'EVENTS' | 'PERKS';
  levels?: number;
}

export const UNLOCKS: UnlockDef[] = [
  { id: 'pack_fire', name: 'FIRE PACK', description: 'Adds Napalm Ram and Firewall to the part pool: ram to ignite, drift to burn a wall of fire.', price: 110, category: 'ITEMS' },
  { id: 'pack_electric', name: 'ELECTRIC PACK', description: 'Adds Arc Tires and Capacitor Bumper to the part pool: drift to charge, ram to discharge.', price: 110, category: 'ITEMS' },
  { id: 'pack_legend', name: 'LEGENDARY CACHE', description: 'Adds six rule-breaking legendaries, one per archetype: Juggernaut Core, Infinite Angle, Sound Barrier, Inferno Core, Storm Dynamo and Wraith Engine.', price: 200, category: 'ITEMS' },
  { id: 'ab_boost', name: 'MODULE: BOOST', description: 'Equip the Boost module in your E slot.', price: 60, category: 'ABILITIES' },
  { id: 'ab_harpoon', name: 'MODULE: HARPOON', description: 'Equip the Harpoon module in your E slot.', price: 80, category: 'ABILITIES' },
  { id: 'ab_repair', name: 'MODULE: REPAIR', description: 'Equip the Repair module in your E slot.', price: 100, category: 'ABILITIES' },
  { id: 'ab_phase', name: 'MODULE: PHASE', description: 'Equip the Phase module in your E slot.', price: 120, category: 'ABILITIES' },
  { id: 'ev_blackmarket', name: 'UNDERWORLD CONTACTS', description: 'Unlocks the Black Market, Mysterious Driver and Neon Chapel events.', price: 90, category: 'EVENTS' },
  { id: 'perk_hp', name: 'REINFORCED FRAME', description: '+10 starting max HP per level.', price: 60, category: 'PERKS', levels: 3 },
  { id: 'perk_credits', name: 'NIGHT SAVINGS', description: '+25 starting credits per level.', price: 50, category: 'PERKS', levels: 2 },
  { id: 'perk_reroll', name: 'SHOP CONNECTIONS', description: 'Your first reroll in every shop is free.', price: 70, category: 'PERKS' },
  { id: 'perk_momentum', name: 'WARM ENGINE', description: 'Start each region with +25 Momentum.', price: 60, category: 'PERKS' },
];

export const DIFFICULTIES = [
  { id: 0, name: 'NIGHT ONE', description: 'The standard Shift.', enemyMul: 1, aggression: 1, hazard: 1, rarityBonus: 0, salvageMul: 1 },
  { id: 1, name: 'DEEP NIGHT', description: 'More enemies, sharper AI, better loot. Unlocked by finishing a run.', enemyMul: 1.35, aggression: 1.25, hazard: 1.4, rarityBonus: 0.08, salvageMul: 1.4 },
  { id: 2, name: 'BLACKOUT', description: 'The city wants you gone. Bosses gain new tricks. Unlocked by winning on Deep Night.', enemyMul: 1.7, aggression: 1.5, hazard: 1.8, rarityBonus: 0.15, salvageMul: 1.8 },
];

export interface LoreDef {
  id: string;
  title: string;
  text: string;
}

export const LORE: LoreDef[] = [
  { id: 'lore_intro', title: 'GEOMETRIC INSTABILITY', text: 'Official bulletin, night 1: "Residents are advised that street layouts may vary between dusk and dawn. Do not rely on memory. Do not rely on maps." People started calling it THE SHIFT within a week.' },
  { id: 'lore_zero', title: 'ZERO MILE', text: 'Every road in the city still counts its distance from the same marker in the old center. Every night the marker moves. Couriers say that if you reach it before dawn, the city stops changing — for you.' },
  { id: 'lore_driver', title: 'THE DRIVER', text: 'Black car, no plates, no visible driver. It appears near the center every night the Shift is strong. Nobody has ever beaten it to Zero Mile. Some say it was the first car the city ever rebuilt.' },
  { id: 'lore_garage', title: 'LOGBOOK, NIGHT 1,204', text: '"The ring road moved again. Three containers ended up stacked on the roof. The forklifts keep working like nothing happened. I think the machines know something we don\'t."' },
  { id: 'lore_courier', title: 'THE COURIER', text: '"I made it to the Skyway once. The road kept going up. There were cars on it that I recognized — from my own garage. Don\'t go to the center. It copies you."' },
  { id: 'lore_signal', title: 'STRANGE SIGNAL', text: 'A transmission recorded on 88.0: mile markers counting down from 40 to 0, read in the voice of whoever is listening. At 0 the recording contains only an idling engine.' },
  { id: 'lore_scrap', title: 'THE SCRAP DEALER', text: '"Cars that get destroyed out there don\'t stay destroyed. The city takes the wrecks back. Melts them. Builds new roads out of them. You\'re driving on somebody\'s old bumper, kid."' },
  { id: 'lore_broadcast', title: 'BROADCAST', text: '"I see you. Keep driving. Every night you get closer, the city learns how you drive. When you reach me, you will be racing yourself."' },
  { id: 'lore_mule', title: 'IRON MULE', text: 'An automated freight hauler that kept running its route after the Shift scrambled the ring. It treats every car on the road as cargo that has fallen off.' },
  { id: 'lore_bus', title: 'DROWNED LINE', text: 'Night bus 0 never stopped running when the river came back. Its batteries are still charged. Its doors still open at every flooded stop.' },
  { id: 'lore_taxon', title: 'TAXON', text: 'Traffic Analysis and eXecution Over Night. A police AI built to predict accidents. After the Shift it started causing them, to make its predictions come true.' },
  { id: 'lore_apex', title: 'APEX', text: 'A racing program that has driven the Skyway every night for years, alone, chasing a lap time no human ever set.' },
  { id: 'lore_end', title: 'WHAT WAITS AT ZERO', text: 'The Driver was never an enemy. It was the city\'s attempt to understand the people who refused to stop moving. Beat it, and tomorrow the city will build roads with your name on them.' },
];
