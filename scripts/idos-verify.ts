// Live check of ZERO MILE's server side against the iDos DEV title (fresh guest drivers, real server calls): the street
// economy, duels and boards, and the progression Cloud Code keeps (runs, garage purchases, insurance, achievements,
// the one-time import of a browser save):
//   node scripts/idos-verify.ts            (GJF4GVXP-DEV)
// Exits 1 on the first failed step and prints what the server said. Nothing here touches the live title.
import { createIDosGamesClient, NoopPlatformAdapter, type IDosGamesClient, type OperationResult } from '@idosgames/core';

const TITLE = process.env.IDOS_TITLE_ID ?? 'GJF4GVXP-DEV';
if (!TITLE.endsWith('-DEV')) {
  console.error('refusing to run against a non-DEV title');
  process.exit(2);
}

let failed = 0;
const results: { step: string; ok: boolean; note: string }[] = [];

async function step<T>(name: string, fn: () => Promise<OperationResult<T>>, check?: (d: T) => string | true): Promise<T | null> {
  const r = await fn();
  if (!r.ok) {
    failed++;
    results.push({ step: name, ok: false, note: `${r.reason}: ${r.error}` });
    console.log(`✗ ${name} — ${r.reason}: ${r.error}`);
    return null;
  }
  const c = check ? check(r.data) : true;
  if (c !== true) {
    failed++;
    results.push({ step: name, ok: false, note: c });
    console.log(`✗ ${name} — ${c}`);
    return r.data;
  }
  results.push({ step: name, ok: true, note: '' });
  console.log(`✓ ${name}`);
  return r.data;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** every client is its own device, so A and B are two different guest drivers */
class TestDevice extends NoopPlatformAdapter {
  private id = 'zm-verify-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  getDeviceID() {
    return this.id;
  }
}

function makeClient(): IDosGamesClient {
  return createIDosGamesClient({ titleID: TITLE, platform: new TestDevice(), clientPlatform: 'Web', loginViews: 'none', appVersion: 'verify', throttleMs: 0 });
}

const svx = (c: IDosGamesClient) => c.data.user.state?.InventoryV2?.VirtualCurrencies?.SV?.Amount ?? 0;
const mt = (c: IDosGamesClient) => c.data.user.state?.InventoryV2?.VirtualCurrencies?.MT?.Amount ?? 0;
const items = (c: IDosGamesClient, id: string) => c.data.user.state?.InventoryV2?.Items?.[id]?.TotalAmount ?? 0;

const a = makeClient();
const b = makeClient();
await step('A logs in as a guest', () => a.auth.loginWithDeviceID());
await step('B logs in as a guest', () => b.auth.loginWithDeviceID());
console.log(`  A ${a.auth.context?.userID}  SV ${svx(a)}  MT ${mt(a)}`);
console.log(`  B ${b.auth.context?.userID}  SV ${svx(b)}  MT ${mt(b)}`);

// ---------------------------------------------------------------- the duel garage
const defs = await step('character definitions: four duel cars', () => a.character.getCharacterDefinitions(), (d) => (['Main', 'rammer', 'ghost', 'hauler'].every((k) => d.Definitions?.[k]) ? true : 'missing cars'));
void defs;
const tqBefore = svx(a);
await step('A tunes the courier\'s HULL with SALVAGE', () => a.character.upgradeStatLevel('Main', 'Hull', {}), (d) => ((d.StatLevel ?? 0) >= 1 ? true : 'no level'));
console.log(`  SALVAGE ${tqBefore} → ${svx(a)}`);
await pause(700);
await step('A tunes RAM two levels at once', () => a.character.upgradeStatLevel('Main', 'Ram', { levels: 2 }), (d) => ((d.StatLevel ?? 0) >= 2 ? true : 'no level'));
await step('server-side balance after tuning', () => a.user.getUserInventory(), (d) => ((d.VirtualCurrencies?.SV?.Amount ?? 0) === 150 - 30 - 30 - 38 ? true : 'SALVAGE ' + d.VirtualCurrencies?.SV?.Amount));

// ---------------------------------------------------------------- the depot
const sf = await step('depot storefront', () => a.store.getStorefront({ forceRefresh: true }), (d) => ((d.Stores ?? []).some((s) => s.StoreID === 'depot') ? true : 'no depot'));
const offerCount = (sf?.Stores ?? []).flatMap((s) => s.Sections ?? []).flatMap((s) => s.Slots ?? []).filter((s) => s.Offer).length;
console.log(`  ${offerCount} offers on the shelves`);
await step('A buys 5 toll passes for MileToken (test)', () => a.store.purchase('toll_x5', 1, { selectedOptionID: 'token', slot: { storeID: 'depot', sectionID: 'supplies', slotID: 'toll_x5' } }), () => (items(a, 'toll_pass') >= 5 ? true : `toll passes ${items(a, 'toll_pass')}`));
await step('A spends one toll pass on the road (timed boost)', () => a.timedBoost.activate('use_toll', { selectedOptionID: 'stock' }), () => (items(a, 'toll_pass') === 4 ? true : `toll passes ${items(a, 'toll_pass')}`));
await pause(700);
await step('A calls a tow truck on the spot with MileToken (test)', () => a.timedBoost.activate('use_tow', { selectedOptionID: 'token' }));

// ---------------------------------------------------------------- liveries
const crate = await step('A opens a livery crate', () => a.lootbox.open('livery_crate', 1, 'token'));
const wrap = crate?.Results?.[0]?.Grant?.Standard?.Entries?.find((e) => e.Type === 'Item')?.ItemID;
console.log(`  crate gave ${wrap}`);
if (wrap) await step('A wraps the courier in it', () => a.character.equipSkin('Main', wrap));

// ---------------------------------------------------------------- street duel
const plan = [{ AttackTarget: 'Head', DefenseTarget: 'Torso' }, { AttackTarget: 'Legs', DefenseTarget: 'Head' }, { AttackTarget: 'Torso', DefenseTarget: 'Legs' }] as const;
const made = await step('A posts a 25 SALVAGE challenge', () => a.match.createMatch({ Entries: [{ Type: 'VirtualCurrency', CurrencyID: 'SV', Amount: 25 }] }, 'street_tq', 'Main', [...plan]));
await pause(1000);
const open = await step('B lists open challenges', () => b.match.getAvailableMatches(0, 30), (d) => ((d.Matches ?? []).some((m) => m.MatchID === made?.MatchID) ? true : 'A\'s challenge not listed'));
void open;
const fight = await step('B takes it in the rammer', () => b.match.instantBattle(made!.MatchID!, 'street_tq', 'rammer', [{ AttackTarget: 'Torso', DefenseTarget: 'Head' }]), (d) => ((d.Battle?.BattleLog?.length ?? 0) > 0 ? true : 'empty battle log'));
if (fight?.Battle) {
  const bt = fight.Battle;
  console.log(`  ${bt.BattleLog!.length} blows, winner ${bt.WinnerUserID === a.auth.context?.userID ? 'A' : bt.WinnerUserID ? 'B' : 'draw'}, HP ${bt.P1BattleProfile?.Stats?.MaxHp} vs ${bt.P2BattleProfile?.Stats?.MaxHp}`);
  for (const e of bt.BattleLog!.slice(0, 4)) console.log(`    r${e.RoundIndex} ${e.AttackerID === a.auth.context?.userID ? 'A' : 'B'} ${e.AttackZone}→${e.DefenseZone} ${e.HitType} ${e.DamageDealt} (hp ${e.DefenderHpRemaining})`);
}

// ---------------------------------------------------------------- weekly Shift, contracts, hunt
await step('A submits a Shift score', () => a.leaderboard.submitScore('weekly_shift', 48210), (d) => (d.NewScore === 48210 ? true : `score ${d.NewScore}`));
await step('weekly Shift board', () => a.leaderboard.getLeaderboard('weekly_shift'), (d) => ((d.TopUsers ?? []).length > 0 ? true : 'empty board'));
await step('A reports 6 ram kills to the contracts', () => a.quest.addQuestProgress('ram_kills', 6));
await step('contract state', () => a.quest.getUserQuestState(), (d) => (d.State?.Cycles?.contracts ? true : 'no contracts cycle'));
const hk = await step('hunt key (Cloud Code)', () => a.cloudCode.execute('huntKey'), (d) => (d.Error ? JSON.stringify(d.Error) : true));
const key = (hk?.FunctionResult as { key?: string } | null)?.key ?? '';
await step('A reports 1,800 boss damage to the hunt', () => a.cloudCode.execute('huntHit', { damage: 1800 }), (d) => (d.Error ? JSON.stringify(d.Error) : (d.FunctionResult as { ok?: boolean })?.ok ? true : JSON.stringify(d.FunctionResult)));
await step('A\'s hunt damage on the weekly board', () => a.leaderboard.submitScore('driver_hunt', 1800));
await pause(700);
await step('city-wide hunt counter', () => a.titleCustomData.getPublicTitleDataKeys([key]), (d) => (Number(d.Runtime?.[key]?.Value ?? 0) >= 1800 ? true : `counter ${d.Runtime?.[key]?.Value}`));

// ---------------------------------------------------------------- progression: Cloud Code is the authority
type Res = { ok?: boolean; error?: string; ticket?: string; salvage?: number; profile?: { runs?: number; lore?: string[] } };
const run = (c: IDosGamesClient, name: string, args: Record<string, unknown> = {}) => () => c.cloudCode.execute(name, args as never);
const fr = (d: { FunctionResult?: unknown }) => (d.FunctionResult ?? {}) as Res;
const ok = (d: { Error?: unknown; FunctionResult?: unknown }) => (d.Error ? JSON.stringify(d.Error) : fr(d).ok ? true : JSON.stringify(d.FunctionResult));
const refused = (code: string) => (d: { FunctionResult?: unknown }) => (fr(d).error === code ? true : `expected ${code}, got ${JSON.stringify(d.FunctionResult)}`);
const serverSv = async (c: IDosGamesClient) => {
  const r = await c.user.getUserInventory();
  return r.ok ? r.data.VirtualCurrencies?.SV?.Amount ?? 0 : -1;
};
const report = (ticket: string, won = false) => ({ ticket, won, stats: { distance: 780, kills: 12, bosses: 0, zone: 0, time: 5, maxSpeed: 182, combo: 9, score: 15400, nodes: 1 }, eventSalvage: 15, lore: ['lore_signal', 'not_a_lore'] });

let sv0 = await serverSv(b);
const opened = await step('B opens a run (startRun)', run(b, 'startRun', { difficulty: 0, ranked: false }), ok);
await step('a night B has not unlocked is refused', run(b, 'startRun', { difficulty: 2 }), refused('difficulty_locked'));
const ticket = opened ? fr(opened).ticket ?? '' : '';
await pause(1500);
const paid = await step('B closes it: the server pays 6 + 18 + 15 (events) = 39 SALVAGE', run(b, 'finishRun', report(ticket)), (d) => (fr(d).salvage === 39 ? true : JSON.stringify(d.FunctionResult)));
await step('the payout is on B\'s balance', async () => ({ ok: true as const, data: await serverSv(b) }), (v) => (v === sv0 + 39 ? true : `SV ${sv0} → ${v}`));
await step('the same ticket cannot be paid twice', run(b, 'finishRun', report(ticket)), refused('no_open_run'));
const lore = paid ? fr(paid).profile?.lore ?? [] : [];
console.log(`  records: ${paid ? fr(paid).profile?.runs : '?'} run(s), archive ${lore.join(', ')}`);
const fast = await step('B opens another run', run(b, 'startRun', { difficulty: 0 }), ok);
await step('a run longer than the real clock is refused', run(b, 'finishRun', { ...report(fast ? fr(fast).ticket ?? '' : ''), stats: { ...report('').stats, time: 3600 } }), refused('clock'));

// garage purchases: one atomic charge and grant
sv0 = await serverSv(b);
await step('B buys CRIMSON paint (40 SALVAGE)', run(b, 'garageBuy', { kind: 'paint', id: 'crimson' }), ok);
await step('B buys REINFORCED FRAME level 1 (60 SALVAGE)', run(b, 'garageBuy', { kind: 'unlock', id: 'perk_hp' }), ok);
await step('…and right after it, NIGHT SAVINGS level 1 (50 SALVAGE)', run(b, 'garageBuy', { kind: 'unlock', id: 'perk_credits' }), ok);
await step('garage items and every charge on the server', () => b.user.getUserInventory(), (d) => {
  const n = (id: string) => d.Items?.[id]?.TotalAmount ?? d.Items?.[id]?.StackableAmount ?? 0;
  const left = d.VirtualCurrencies?.SV?.Amount ?? 0;
  return n('paint_crimson') === 1 && n('up_perk_hp') === 1 && n('up_perk_credits') === 1 && left === sv0 - 150 ? true : `paint ${n('paint_crimson')} hp ${n('up_perk_hp')} credits ${n('up_perk_credits')} SV ${sv0} → ${left}`;
});
await step('an owned paint is not sold twice', run(b, 'garageBuy', { kind: 'paint', id: 'crimson' }), refused('owned'));
await step('a car B cannot afford is refused', run(b, 'garageBuy', { kind: 'vehicle', id: 'hauler' }), refused('funds'));

// wreck insurance: the policy is spent after the run, the server pays the run again
const wreck = await step('B opens a run that ends in a wreck', run(b, 'startRun', { difficulty: 0 }), ok);
await pause(1200);
sv0 = await serverSv(b);
const wrecked = await step('B closes the wrecked run', run(b, 'finishRun', report(wreck ? fr(wreck).ticket ?? '' : '')), ok);
await step('a second run pays too', async () => ({ ok: true as const, data: await serverSv(b) }), (v) => (wrecked && v === sv0 + (fr(wrecked).salvage ?? 0) ? true : `SV ${sv0} → ${v}`));
await step('without a policy there is no payout', run(b, 'insureRun'), refused('no_policy'));
await step('B takes out a policy on the spot (MileToken, test)', () => b.timedBoost.activate('use_insurance', { selectedOptionID: 'token' }));
sv0 = await serverSv(b);
await step('the insurance pays the run again', run(b, 'insureRun'), (d) => (wrecked && fr(d).salvage === fr(wrecked).salvage ? true : JSON.stringify(d.FunctionResult)));
await step('…once', run(b, 'insureRun'), refused('already_insured'));
await step('the claim is on B\'s balance', async () => ({ ok: true as const, data: await serverSv(b) }), (v) => (wrecked && v === sv0 + (fr(wrecked).salvage ?? 0) ? true : `SV ${sv0} → ${v}`));

// achievements are permanent quests, claimed for SALVAGE
await step('B earns FIRST BLOOD', () => b.quest.addQuestProgress('ach_first_blood', 1));
await step('…which waits to be claimed', () => b.quest.getUserQuestState(), (d) => (d.State?.PermanentQuests?.ach_first_blood?.Status === 'Completed' ? true : JSON.stringify(d.State?.PermanentQuests?.ach_first_blood)));
sv0 = await serverSv(b);
await step('B claims it: +15 SALVAGE', () => b.quest.claimQuestReward('ach_first_blood'));
await step('the reward is on B\'s balance', async () => ({ ok: true as const, data: await serverSv(b) }), (v) => (v === sv0 + 15 ? true : `SV ${sv0} → ${v}`));

// the garage choices live on the account
await step('B keeps its garage choices (Private prefs)', () => b.userCustomData.setPrivateData('prefs', JSON.stringify({ selectedVehicle: 'courier', module: 'emp', paint: { courier: 'crimson' }, difficulty: 0 })));
await step('…and reads them back with its records', () => b.userCustomData.getMyUserCustomData(), (d) => {
  const prefs = JSON.parse(d.Private?.prefs?.Value ?? '{}');
  const prof = JSON.parse(d.ReadOnly?.profile?.Value ?? '{}');
  return prefs.paint?.courier === 'crimson' && prof.runs === 2 ? true : `prefs ${d.Private?.prefs?.Value} profile runs ${prof.runs}`;
});

// a browser-only save comes onto a fresh account once, salvage capped, only things the game sells
const c = makeClient();
await step('C logs in as a guest', () => c.auth.loginWithDeviceID());
const legacy = { unlockedVehicles: ['courier', 'rammer'], unlocks: { perk_hp: 2, not_an_unlock: 5 }, paints: ['stock', 'acid'], salvage: 99999, runs: 7, wins: 1, best: { distance: 21000, kills: 140, zone: 4, maxSpeed: 230, combo: 31, score: 812000, won: true }, maxDifficultyUnlocked: 1, tutorialDone: true, lore: ['lore_intro', 'lore_mule'] };
await step('C brings its browser save onto the account', run(c, 'importLegacy', { save: legacy }), (d) => (fr(d).salvage === 2500 && fr(d).profile?.runs === 7 ? true : JSON.stringify(d.FunctionResult)));
await step('C\'s garage is on the server', () => c.user.getUserInventory(), (d) => {
  const n = (id: string) => d.Items?.[id]?.TotalAmount ?? d.Items?.[id]?.StackableAmount ?? 0;
  return n('car_rammer') === 1 && n('up_perk_hp') === 2 && n('paint_acid') === 1 && !d.Items?.up_not_an_unlock ? true : JSON.stringify(Object.keys(d.Items ?? {}));
});
await step('a second import is refused', run(c, 'importLegacy', { save: legacy }), refused('done'));
await step('an account that already drives cannot import', run(b, 'importLegacy', { save: legacy }), refused('not_fresh'));

// ---------------------------------------------------------------- the street market
await step('market open', () => a.marketplace.getDefinitions(), (d) => (d.IsOpenNow !== false ? true : 'closed'));
const listing = await step('A lists a toll pass for 60 SALVAGE', () => a.marketplace.createListing('toll_pass', 'supply', 1, { Entries: [{ Type: 'VirtualCurrency', CurrencyID: 'SV', Amount: 60 }] }, 24));
await pause(800);
if (listing?.OfferID) await step('B buys it', () => b.marketplace.buy(listing.OfferID!), () => (items(b, 'toll_pass') === 1 ? true : `B toll passes ${items(b, 'toll_pass')}`));

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} steps passed`);
process.exit(failed ? 1 : 0);
