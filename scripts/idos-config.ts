// Writes the iDos Games title configuration for ZERO MILE's online systems, one JSON file per config section:
//   node scripts/idos-config.ts dev    → idos/config/dev/*.json   (GJF4GVXP-DEV: a virtual "MT" stands in for MileToken)
//   node scripts/idos-config.ts live   → idos/config/live/*.json  (GJF4GVXP: MileToken is the Solana token "Main")
// Each file is the complete value of one section (save_<section> replaces a section whole). The numbers come from
// src/idos/catalog.ts, which the game reads too.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACHIEVEMENTS, DIFFICULTIES, LORE, UNLOCKS } from '../src/data/meta.ts';
import { PAINTS, VEHICLES } from '../src/data/vehicles.ts';
import { ACHIEVEMENT_SALVAGE, CAR_KEYS, CONTRACT_BONUS, RUN_RULES, CONTRACT_POINTS, CONTRACTS, CRATE, DEPOT, DUEL_CARS, DUEL_RULES, DUEL_STATS, HUNT, LIVERIES, SHIFT_REWARDS, SUPPLIES, UPGRADE_PRICE } from '../src/idos/catalog.ts';

const mode = process.argv[2] === 'live' ? 'live' : 'dev';
const out = join(process.cwd(), 'idos', 'config', mode);
mkdirSync(out, { recursive: true });

type Entry = Record<string, unknown>;
const SV = 'SV';
// long.MaxValue (no cap): a JS number cannot hold it exactly, so a marker is swapped for the literal when the JSON is written
const MAX_BALANCE = '__LONG_MAX__';
const vc = (id: string, amount: number): Entry => ({ Type: 'VirtualCurrency', CurrencyID: id, Amount: amount });
const token = (amount: number): Entry => (mode === 'live' ? { Type: 'CryptoCurrency', CurrencyID: 'Main', Amount: amount } : vc('MT', amount));
const item = (catalog: string, id: string, amount = 1): Entry => ({ Type: 'Item', CatalogID: catalog, ItemID: id, Amount: amount });
const bundle = (...entries: Entry[]) => ({ Standard: { Entries: entries } });
const option = (id: string, name: string, ...entries: Entry[]) => ({ OptionID: id, Name: name, Cost: bundle(...entries) });
const tokenName = mode === 'live' ? 'MileToken' : 'MileToken (test)';

const catalogOf = (id: string) => (id.startsWith('liv_') ? 'livery' : /^(car|up|paint)_/.test(id) ? 'garage' : 'supply');
const write = (name: string, value: unknown) => writeFileSync(join(out, `${name}.json`), JSON.stringify(value).split(JSON.stringify(MAX_BALANCE)).join('9223372036854775807') + '\n');

// ---------------------------------------------------------------- Currency
// Live keeps the platform-managed MileToken ("Main", protected) and its IOU currency exactly as they are.
const salvage = {
  CurrencyID: SV,
  DisplayName: 'Salvage',
  Economy: { ValueInUSD: 0.001, InitialDeposit: 150, MinBalance: 0, MaxBalance: MAX_BALANCE },
  Permissions: { IsTradable: true, IsPurchasable: false, IsRefundable: false },
  Status: 'Active',
};
write('Currency', mode === 'live'
  ? {
      VirtualCurrencies: {
        Main_IOU: { CurrencyID: 'Main_IOU', DisplayName: 'MileToken (IOU)', Economy: { ValueInUSD: 0, InitialDeposit: 0, MinBalance: 0, MaxBalance: MAX_BALANCE }, Permissions: { IsTradable: false, IsPurchasable: false, IsRefundable: false }, Status: 'Active' },
        SV: salvage,
      },
      CryptoRewardsFromDeveloperShare: false,
      CryptoIouForScriptsAndAI: false,
      CryptoAutoRepayIouOnWithdrawal: true,
    }
  : {
      VirtualCurrencies: {
        SV: salvage,
        MT: { CurrencyID: 'MT', DisplayName: 'MileToken (test stand-in)', Economy: { ValueInUSD: 0, InitialDeposit: 100, MinBalance: 0, MaxBalance: MAX_BALANCE }, Permissions: { IsTradable: false, IsPurchasable: false, IsRefundable: false }, Status: 'Active' },
      },
      CryptoRewardsFromDeveloperShare: false,
      CryptoIouForScriptsAndAI: false,
      CryptoAutoRepayIouOnWithdrawal: true,
    });

// ---------------------------------------------------------------- Item
const hex = (n: number) => '#' + n.toString(16).padStart(6, '0');
const items = {
  Catalogs: {
    supply: {
      Items: Object.fromEntries(SUPPLIES.map((s) => [s.id, {
        ItemID: s.id, CatalogID: 'supply', ItemClass: s.id === 'crate_key' ? 'Key' : 'Consumable', DisplayName: s.name, Description: s.desc,
        Tags: ['supply'], IsStackable: true, IsTradable: true, CustomData: { icon: s.icon }, Metadata: { RarityID: 'Common' },
      }])),
    },
    garage: {
      Items: Object.fromEntries([
        ...VEHICLES.filter((v) => v.price > 0).map((v) => [`car_${v.id}`, { ItemID: `car_${v.id}`, CatalogID: 'garage', ItemClass: 'Car', DisplayName: v.name, Description: v.description, Tags: ['car'], IsStackable: true, IsTradable: false, CustomData: { vehicle: v.id } }]),
        ...UNLOCKS.map((u) => [`up_${u.id}`, { ItemID: `up_${u.id}`, CatalogID: 'garage', ItemClass: 'Upgrade', DisplayName: u.name, Description: u.description, Tags: ['upgrade', u.category.toLowerCase()], IsStackable: true, IsTradable: false, CustomData: { levels: String(u.levels ?? 1) } }]),
        ...PAINTS.filter((p) => p.price > 0).map((p) => [`paint_${p.id}`, { ItemID: `paint_${p.id}`, CatalogID: 'garage', ItemClass: 'Paint', DisplayName: p.name, Tags: ['paint'], IsStackable: true, IsTradable: false, CustomData: { color: hex(p.color) } }]),
      ]),
    },
    livery: {
      Items: Object.fromEntries(LIVERIES.map((l) => [l.id, {
        ItemID: l.id, CatalogID: 'livery', ItemClass: 'Cosmetic', DisplayName: l.name, Description: `${l.rarity[0] + l.rarity.slice(1).toLowerCase()} livery. Wraps one car at a time.`,
        Tags: ['livery', l.rarity.toLowerCase()], IsStackable: false, IsTradable: true,
        CustomData: { color: hex(l.color), accent: hex(l.accent) }, Metadata: { RarityID: l.rarity[0] + l.rarity.slice(1).toLowerCase(), CollectionID: 'liveries' },
      }])),
    },
  },
};
write('Item', items);

// ---------------------------------------------------------------- Character (the duel garage)
const statDefs = (base: Record<string, number>) => Object.fromEntries(DUEL_STATS.map((s) => [s.id, {
  StatID: s.id, TypeID: s.role, DisplayName: s.label, Description: s.desc, MaxLevel: UPGRADE_PRICE.maxLevel, Weight: s.weight,
  BaseStatValue: base[s.id], ValueCurve: { Shape: 'PerStep', PerStep: s.step },
  // tuning is paid in SALVAGE only (the SDK's upgrade call always charges the first price option); MileToken reaches the
  // garage through the depot's SALVAGE packs
  PriceOptions: { salvage: option('salvage', 'Salvage', vc(SV, UPGRADE_PRICE.salvage)) },
  CostCurve: { Shape: 'Geometric', GrowthRate: UPGRADE_PRICE.growth },
}]));
const skins = {
  DefaultSkinID: 'stock',
  Definitions: {
    stock: { SkinID: 'stock', Identity: { DisplayName: 'STOCK' } },
    // wraps are sold in the depot and dropped by the crate; a skin entry only says the car can wear it
    ...Object.fromEntries(LIVERIES.map((l) => [l.id, { SkinID: l.id, Identity: { DisplayName: l.name }, Item: { ItemID: l.id, CatalogID: 'livery' } }])),
  },
};
write('Character', {
  Definitions: Object.fromEntries(DUEL_CARS.map((c, i) => [c.character, {
    CharacterID: c.character,
    Identity: { DisplayName: c.name, Description: `Street duel build of the ${c.name}.`, SortOrder: i },
    Classification: { ClassID: 'Car', RarityID: 'Common', Tags: [c.vehicle] },
    Unlock: { UnlockedByDefault: true },
    Stats: statDefs(c.base),
    Skins: skins,
  }])),
});

// ---------------------------------------------------------------- Match (street duels)
const role = (r: string) => DUEL_STATS.find((s) => s.role === r)!.id;
const settings = {
  StatMapping: {
    HealthStatID: role('Health'), DamageStatID: role('Damage'), ArmorStatID: role('Armor'), AttackSpeedStatID: role('AttackSpeed'),
    CritChanceStatID: role('CritChance'), CritDamageStatID: 'Impact', DodgeStatID: role('Dodge'), AllMightStatID: 'Overdrive',
  },
  Combat: { MaxRounds: DUEL_RULES.rounds, BlockDamageMultiplier: 0.15, MinHitDamage: 1, DefaultCritMultiplier: 1.6, MaxCritChance: 0.4, MaxDodgeChance: 0.35, ArmorMode: 'PercentReduction', MaxArmorReduction: 0.6 },
};
const supplyStakes = SUPPLIES.filter((s) => s.id !== 'crate_key').map((s) => ({ Kind: 'Item', CatalogID: 'supply', ItemID: s.id, MinAmount: 1, MaxAmount: DUEL_RULES.supplyMax }));
write('Match', {
  InstantBattle: {
    Rules: {
      street_tq: {
        RuleID: 'street_tq', DisplayName: 'Street duel', Description: 'Stake SALVAGE or supplies. Winner takes both stakes minus a 5% burn.',
        Economy: { BurnRate: DUEL_RULES.salvage.burn },
        Entry: { Allowed: [{ Kind: 'VirtualCurrency', CurrencyID: SV, MinAmount: DUEL_RULES.salvage.min, MaxAmount: DUEL_RULES.salvage.max }, ...supplyStakes], MaxPositions: 1 },
        Creation: { RefundCostOnCancel: true, MaxOpenMatches: 3, OfferLifetimeSeconds: 172800, Limits: { CooldownSeconds: 5, DailyCap: 30 }, AllowPrivateMatches: true, MaxMatchesPerOpponentPerDay: 3 },
        Settings: settings,
      },
      street_mt: {
        RuleID: 'street_mt', DisplayName: 'High-stakes duel', Description: `Big SALVAGE stakes. Posting costs ${DUEL_RULES.high.feeToken} ${tokenName}.`,
        Economy: { BurnRate: DUEL_RULES.high.burn },
        Entry: { Allowed: [{ Kind: 'VirtualCurrency', CurrencyID: SV, MinAmount: DUEL_RULES.high.min, MaxAmount: DUEL_RULES.high.max }], MaxPositions: 1 },
        Creation: {
          PriceOptions: { token: option('token', tokenName, token(DUEL_RULES.high.feeToken)) },
          RefundCostOnCancel: true, MaxOpenMatches: 2, OfferLifetimeSeconds: 172800, Limits: { CooldownSeconds: 10, DailyCap: 10 }, AllowPrivateMatches: true, MaxMatchesPerOpponentPerDay: 2,
        },
        Settings: settings,
      },
    },
  },
});

// ---------------------------------------------------------------- Leaderboard (weekly Shift, THE DRIVER hunt)
const weekly = { Mode: 'Cyclic', IsActive: true, Cyclic: { Reset: 'Weekly', ClaimGraceHours: 168 } };
write('Leaderboard', {
  Definitions: {
    weekly_shift: {
      LeaderboardID: 'weekly_shift', DisplayName: 'The weekly Shift', ScoreDisplayName: 'Score', IsEnabled: true, ScoreAggregation: 'BestScore',
      Schedule: weekly, TopUsersLimit: 100, MinScoreToEnterTop: 1, BracketSize: 0, MilestoneClaimMode: 'Instant', MilestoneClaimGraceHours: 48,
      RankRewards: SHIFT_REWARDS.map((r) => ({ Rank: r.rank, Rewards: bundle(vc(SV, r.salvage), ...(r.keys ? [item('supply', 'crate_key', r.keys)] : [])) })),
    },
    driver_hunt: {
      LeaderboardID: 'driver_hunt', DisplayName: 'THE DRIVER hunt', ScoreDisplayName: 'Boss damage', IsEnabled: true, ScoreAggregation: 'Sum',
      Schedule: weekly, TopUsersLimit: 100, MinScoreToEnterTop: 1, BracketSize: 0, MilestoneClaimMode: 'Instant', MilestoneClaimGraceHours: 48,
      RankRewards: [{ Rank: '1-10', Rewards: bundle(vc(SV, 600), item('supply', 'crate_key', 1)) }, { Rank: '11-100', Rewards: bundle(vc(SV, 150)) }],
      Milestones: Object.fromEntries(HUNT.milestones.map((m, i) => [m.id, { MilestoneID: m.id, DisplayName: `${m.at.toLocaleString('en-US')} boss damage this week`, RequiredProgress: m.at, SortOrder: i + 1, Rewards: bundle(vc(SV, m.salvage), ...(m.keys ? [item('supply', 'crate_key', m.keys)] : [])) }])),
    },
  },
});

// ---------------------------------------------------------------- Quest (daily contracts)
write('Quest', {
  Cycles: {
    contracts: {
      CycleID: 'contracts', DisplayName: 'Daily contracts', Schedule: { Mode: 'Cyclic', IsActive: true, Cyclic: { Reset: 'Daily' } },
      Milestones: { full_board: { MilestoneID: 'full_board', DisplayName: 'Full board', RequiredProgress: CONTRACT_BONUS.points, SortOrder: 1, Rewards: bundle(item('supply', 'crate_key', CONTRACT_BONUS.keys)) } },
    },
  },
  Quests: Object.fromEntries([...ACHIEVEMENTS.map((a, i) => [`ach_${a.id}`, {
    QuestID: `ach_${a.id}`,
    Identity: { DisplayName: a.name, Description: a.description, SortOrder: 100 + i, CustomParams: { kind: 'achievement' } },
    Linking: { CycleIDs: [] },
    Objectives: { main: { ObjectiveID: 'main', Source: 'ClientApi', MetricID: `ach_${a.id}`, MaxProgressPerCall: 1, TargetValue: 1, AggregationMethod: 'Sum' } },
    Reward: { Grant: bundle(vc(SV, ACHIEVEMENT_SALVAGE[a.id] ?? 25)) },
  }] as const), ...CONTRACTS.map((c, i) => [c.id, {
    QuestID: c.id,
    Identity: { DisplayName: c.name, Description: c.desc, SortOrder: i + 1 },
    Linking: { CycleIDs: ['contracts'] },
    Objectives: { main: { ObjectiveID: 'main', Source: 'ClientApi', MetricID: c.metric, MaxProgressPerCall: c.cap, TargetValue: c.target, AggregationMethod: 'Sum' } },
    Reward: { Grant: bundle(vc(SV, c.salvage)), PointsReward: CONTRACT_POINTS },
  }])]),
});

// ---------------------------------------------------------------- Store (the depot)
const offers: Record<string, unknown> = {};
const sections: Record<string, { name: string; order: number; slots: string[] }> = {
  supplies: { name: 'SUPPLIES', order: 1, slots: [] },
  keys: { name: 'CARS', order: 2, slots: [] },
  salvage: { name: 'SALVAGE', order: 3, slots: [] },
  liveries: { name: 'LIVERIES', order: 4, slots: [] },
  scrapyard: { name: 'SCRAPYARD', order: 5, slots: [] },
};
for (const o of DEPOT) {
  const grant = o.grant.item ? item(catalogOf(o.grant.item), o.grant.item, o.grant.amount) : vc(SV, o.grant.salvage!);
  offers[o.id] = {
    OfferID: o.id, Identity: { DisplayName: o.name, CustomParams: { item: o.grant.item ?? SV } },
    Pricing: { Options: o.token ? { token: option('token', tokenName, token(o.token)) } : { salvage: option('salvage', 'Salvage', vc(SV, o.salvage!)) } },
    Reward: { Grant: bundle(grant) },
    Availability: { Limits: { DailyCap: o.dailyCap ?? 0, TotalCap: o.totalCap ?? 0 } },
  };
  sections[o.section].slots.push(o.id);
}
for (const l of LIVERIES.filter((x) => x.token || x.salvage)) {
  offers[l.id] = {
    OfferID: l.id, Identity: { DisplayName: l.name, CustomParams: { item: l.id, rarity: l.rarity } },
    Pricing: { Options: { ...(l.token ? { token: option('token', tokenName, token(l.token)) } : {}), ...(l.salvage ? { salvage: option('salvage', 'Salvage', vc(SV, l.salvage)) } : {}) } },
    Reward: { Grant: bundle(item('livery', l.id, 1)) },
    Availability: { Limits: { DailyCap: 3 } },
  };
  sections.liveries.slots.push(l.id);
}
for (const k of CAR_KEYS) {
  const id = k.item;
  offers[id] = {
    OfferID: id, Identity: { DisplayName: k.vehicle.toUpperCase(), CustomParams: { item: id, vehicle: k.vehicle } },
    Pricing: { Options: { token: option('token', tokenName, token(k.token)) } },
    Reward: { Grant: bundle(item('garage', id, 1)) },
    Availability: { Limits: { TotalCap: 1 } },
  };
  sections.keys.slots.push(id);
}
write('Store', {
  Stores: {
    depot: {
      StoreID: 'depot', Identity: { DisplayName: 'THE DEPOT', SortOrder: 1 },
      Layout: { Sections: Object.fromEntries(Object.entries(sections).map(([id, s]) => [id, {
        SectionID: id, Identity: { DisplayName: s.name, SortOrder: s.order },
        Slots: Object.fromEntries(s.slots.map((o, i) => [o, { SlotID: o, Identity: { SortOrder: i + 1 }, Rotation: { Mode: 'Fixed', OfferID: o } }])),
      }])) },
    },
  },
  StoreOffers: offers,
});

// ---------------------------------------------------------------- Lootbox (the livery crate)
const pool = (filter: (l: (typeof LIVERIES)[number]) => boolean) => LIVERIES.filter(filter).map((l) => ({ Weight: l.weight, Reward: bundle(item('livery', l.id, 1)) }));
write('Lootbox', {
  Definitions: {
    [CRATE.id]: {
      LootboxID: CRATE.id,
      PriceOptions: {
        key: option('key', 'Crate key', item('supply', 'crate_key', 1)),
        token: option('token', tokenName, token(CRATE.token)),
      },
      RewardSlots: [{ SlotID: 'wrap', MinRolls: 1, MaxRolls: 1, Pool: pool(() => true) }],
      PityRules: [{ RuleID: 'epic_pity', Threshold: CRATE.pity, Pool: pool((l) => l.rarity === 'EPIC' || l.rarity === 'LEGENDARY') }],
      MaxOpenCount: 10,
    },
  },
  Settings: { MaxOpenCount: 10 },
});

// ---------------------------------------------------------------- TimedBoost (spending a supply on the road)
write('TimedBoost', {
  Definitions: Object.fromEntries(SUPPLIES.filter((s) => s.boost).map((s) => [s.boost!, {
    BoostID: s.boost, DisplayName: s.name, Description: s.desc,
    PriceOptions: {
      stock: option('stock', s.name, item('supply', s.id, 1)),
      token: option('token', tokenName, token(s.onTheSpot!)),
    },
    // a Custom effect: the server never applies it to anything; the game reads the boost id and does the rest
    Effect: { Target: 'Custom', Operation: 'AddFlat', Value: 1 },
    DurationSeconds: 60, StackingPolicy: 'Stack', MaxActiveInstances: 50, Tags: ['supply'],
  }])),
});

// ---------------------------------------------------------------- Marketplace (liveries and supplies, priced in SALVAGE)
write('Marketplace', {
  Enabled: true,
  PricePolicy: { AllowVirtualCurrency: true, AllowItems: false, AllowEventTokens: false, Allowed: [{ Kind: 'VirtualCurrency', CurrencyID: SV, MinAmount: 10, MaxAmount: 500000 }], MaxPositions: 1 },
  Commission: { Percent: 0.05, MinPerPosition: 1, Sink: 'Burn', ApplyToDirectTrades: false },
  Tradability: { AllowedCatalogIDs: ['livery', 'supply'], DeniedCatalogIDs: [], DeniedItemIDs: [], AllowUnstackableWithState: true, AllowedCurrencyIDs: [], DeniedCurrencyIDs: [] },
  Listings: { Enabled: true, AllowedDurationsHours: [24, 72, 168], MaxActiveListings: 10, CreateLimits: { CooldownSeconds: 5, DailyCap: 30 }, BuyLimits: { CooldownSeconds: 2, DailyCap: 60 }, RefundListingFeeOnCancel: false },
  Auctions: { Enabled: false },
  BuyOrders: { Enabled: false },
  DirectTrades: { Enabled: false },
});

// ---------------------------------------------------------------- CloudCode (progression authority) and its resource policy
const tables = {
  vehicles: Object.fromEntries(VEHICLES.filter((v) => v.price > 0).map((v) => [v.id, v.price])),
  unlocks: Object.fromEntries(UNLOCKS.map((u) => [u.id, { price: u.price, levels: u.levels ?? 1 }])),
  paints: Object.fromEntries(PAINTS.filter((p) => p.price > 0).map((p) => [p.id, p.price])),
  salvageMul: DIFFICULTIES.map((d) => d.salvageMul),
  difficultyNames: DIFFICULTIES.map((d) => d.name),
  lore: LORE.map((l) => l.id),
  runCap: RUN_RULES.runCap,
  eventSalvageCap: RUN_RULES.eventSalvageCap,
  maxMetresPerSecond: RUN_RULES.maxMetresPerSecond,
  legacyCap: RUN_RULES.legacyCap,
  huntReportCap: HUNT.perRunCap,
  huntCooldownMs: 40000,
  insuranceBoost: SUPPLIES.find((s) => s.id === 'insurance')!.boost,
  insuranceWindowMs: 10 * 60 * 1000,
};
const template = readFileSync(join(process.cwd(), 'idos', 'cloudcode.template.js'), 'utf8');
const code = template.replace('/*TABLES*/ null', JSON.stringify(tables)).replace(/^\/\/ Generated:[\s\S]*?\n\n/m, '// Generated by scripts/idos-config.ts from idos/cloudcode.template.js — edit the template, not this file.\n\n');
writeFileSync(join(process.cwd(), 'idos', 'cloudcode.js'), code);
write('CloudCodePolicy', {
  ResourcePolicy: {
    Enabled: true,
    AllowedGrantTypes: ['VirtualCurrency', 'Item'],
    AllowedConsumeTypes: ['VirtualCurrency', 'Item'],
    AllowEventTokens: false,
    Caps: { [`VirtualCurrency:${SV}`]: { PerPlayerDaily: RUN_RULES.dailyCap } },
  },
  RateLimit: { PerHandlerUserLimit: { startRun: { MaxRequests: 12, WindowSeconds: 60, BlockDurationSeconds: 60 }, finishRun: { MaxRequests: 12, WindowSeconds: 60, BlockDurationSeconds: 60 }, insureRun: { MaxRequests: 6, WindowSeconds: 60, BlockDurationSeconds: 60 }, garageBuy: { MaxRequests: 20, WindowSeconds: 60, BlockDurationSeconds: 30 }, importLegacy: { MaxRequests: 3, WindowSeconds: 3600, BlockDurationSeconds: 600 } } },
});

console.log(`iDos config (${mode}) written to ${out}`);
void HUNT;
