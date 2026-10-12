import type { ResourceEntry, StorefrontOfferView, StorefrontPriceOptionView, MarketplaceOfferView, LeaderboardUserEntry, QuestDefinitions, UserQuestState } from '@idosgames/core';
import { CONTRACT_BONUS, CONTRACTS, CRATE, HUNT, LIVERIES, SUPPLIES, type LiveryDef, type SupplyId } from './catalog';
import { ACTION_GAP_MS, idos } from './platform';
import { IDS, SALVAGE, type ResourceRef } from './title';

/**
 * The street economy on iDos Games: the depot (MileToken and SALVAGE prices), supplies spent on the road, the livery
 * crate, the weekly Shift, daily contracts, THE DRIVER hunt and the street market. Every grant and every charge happens
 * on the server; the game only asks, shows the answer and applies the effect a supply buys on the road.
 */

// ---------------------------------------------------------------- prices

export interface Price {
  ref: ResourceRef | { Type: 'Item'; ItemID: string };
  amount: number;
}

export function pricesOf(opt: StorefrontPriceOptionView | undefined | null): Price[] {
  return (opt?.Cost?.Standard?.Entries ?? []).map(entryPrice).filter((p): p is Price => !!p);
}

export function entryPrice(e: ResourceEntry): Price | null {
  if (!e.Amount) return null;
  if (e.Type === 'Item' && e.ItemID) return { ref: { Type: 'Item', ItemID: e.ItemID }, amount: e.Amount };
  if ((e.Type === 'VirtualCurrency' || e.Type === 'CryptoCurrency') && e.CurrencyID) return { ref: { Type: e.Type, CurrencyID: e.CurrencyID }, amount: e.Amount };
  return null;
}

export const isToken = (p: Price) => p.ref.Type !== 'Item' && p.ref.CurrencyID === idos.token.CurrencyID;

export function canAfford(p: Price): boolean {
  if (p.ref.Type === 'Item') return idos.itemCount(p.ref.ItemID) >= p.amount;
  return idos.balance(p.ref) >= p.amount;
}

export function priceLabel(p: Price): string {
  if (p.ref.Type === 'Item') return `${p.amount} × ${SUPPLIES.find((s) => s.id === (p.ref as { ItemID: string }).ItemID)?.name ?? p.ref.ItemID}`;
  return `${p.amount.toLocaleString('en-US')} ${p.ref.CurrencyID === SALVAGE.CurrencyID ? 'SV' : 'MILETOKEN'}`;
}

// ---------------------------------------------------------------- the depot

export interface Shelf {
  id: string;
  name: string;
  items: { slot: { storeID: string; sectionID: string; slotID: string }; offer: StorefrontOfferView }[];
}

export async function loadDepot(onFail?: (m: string) => void): Promise<Shelf[]> {
  const r = await idos.call((c) => c.store.getStorefront({ forceRefresh: true }), onFail);
  const store = r?.Stores?.find((s) => s.StoreID === IDS.store);
  if (!store) return [];
  return [...(store.Sections ?? [])]
    .sort((a, b) => a.SortOrder - b.SortOrder)
    .map((sec) => ({
      id: sec.SectionID,
      name: sec.Identity?.DisplayName ?? sec.SectionID,
      items: [...(sec.Slots ?? [])].sort((a, b) => a.SortOrder - b.SortOrder).filter((s) => s.Offer).map((s) => ({ slot: { storeID: store.StoreID, sectionID: sec.SectionID, slotID: s.SlotID }, offer: s.Offer! })),
    }))
    .filter((s) => s.items.length);
}

export async function buy(item: Shelf['items'][number], optionId: string, onFail?: (m: string) => void) {
  return idos.call((c) => c.store.purchase(item.offer.OfferID, 1, { selectedOptionID: optionId, slot: item.slot }), onFail);
}

/** what an offer hands over, for its card */
export function offerContents(o: StorefrontOfferView): { item?: string; amount: number; salvage?: number } {
  const e = o.Rewards?.Standard?.Entries?.[0];
  if (!e) return { amount: 0 };
  if (e.Type === 'Item') return { item: e.ItemID ?? undefined, amount: e.Amount ?? 1 };
  return { amount: e.Amount ?? 0, salvage: e.Amount ?? 0 };
}

// ---------------------------------------------------------------- livery crate

export async function openCrate(withKey: boolean, onFail?: (m: string) => void): Promise<LiveryDef[] | null> {
  const r = await idos.call((c) => c.lootbox.open(CRATE.id, 1, withKey ? 'key' : 'token'), onFail);
  if (!r) return null;
  const ids = (r.Results ?? []).flatMap((op) => op.Grant?.Standard?.Entries ?? []).map((e) => e.ItemID).filter(Boolean) as string[];
  return ids.map((id) => LIVERIES.find((l) => l.id === id)).filter((l): l is LiveryDef => !!l);
}

// ---------------------------------------------------------------- supplies on the road

export const supply = (id: SupplyId) => SUPPLIES.find((s) => s.id === id)!;

/**
 * Spend a supply: one from stock, or — with none in stock — MileToken on the spot. The server charges it (a timed boost
 * priced in the item or the token); the caller applies the effect only when this resolves true.
 */
export async function useSupply(id: SupplyId, fromStock: boolean, onFail?: (m: string) => void): Promise<boolean> {
  const s = supply(id);
  if (!s.boost) return false;
  const r = await idos.call((c) => c.timedBoost.activate(s.boost!, { selectedOptionID: fromStock ? 'stock' : 'token' }), onFail);
  return !!r;
}

// ---------------------------------------------------------------- the weekly Shift

const WEEK_MS = 7 * 24 * 3600 * 1000;
const MONDAY_EPOCH = Date.UTC(1970, 0, 5);

/** weeks start Monday 00:00 UTC, the boundary the weekly boards reset on */
export const weekIndex = (now = Date.now()) => Math.floor((now - MONDAY_EPOCH) / WEEK_MS);
export const weekEndsAt = (now = Date.now()) => MONDAY_EPOCH + (weekIndex(now) + 1) * WEEK_MS;

/** the Shift's seed: the same city for every driver this week */
export function shiftSeed(week = weekIndex()) {
  let h = (week * 2654435761) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519) >>> 0;
  return (h % 900000000) + 100000000;
}

export interface BoardRow {
  rank: number;
  name: string;
  score: number;
  me: boolean;
}

function rowsOf(top: LeaderboardUserEntry[] | null | undefined): BoardRow[] {
  return (top ?? []).map((u, i) => ({ rank: u.Rank ?? i + 1, name: u.PublicProfile?.Username ?? 'DRIVER', score: u.Score ?? 0, me: u.UserID === idos.userId }));
}

// ---------------------------------------------------------------- the boards' call queue

/**
 * iDos answers the same leaderboard action twice within about a second with a 429 (and the SDK's retry stalls for
 * seconds): each action (read a board, read my progress, submit, claim) has its own queue, its calls started
 * ACTION_GAP_MS apart and given 8 s before the queue moves on. Different actions do not wait for each other. Identical
 * reads in flight share one request.
 */
const BOARD_TIMEOUT_MS = 8000;
const boardReads = new Map<string, Promise<BoardView>>();

function boardCall<T>(action: 'read' | 'mine' | 'submit' | 'claim', fn: () => Promise<T | null>): Promise<T | null> {
  return idos.lane(`board:${action}`, ACTION_GAP_MS, () => Promise.race([fn(), new Promise<null>((r) => setTimeout(() => r(null), BOARD_TIMEOUT_MS))]));
}

type BoardView = { rows: BoardRow[]; endsAt: number; total: number; myRank: number | null; myScore: number };

export function board(id: string, onFail?: (m: string) => void): Promise<BoardView> {
  const pending = boardReads.get(id);
  if (pending) return pending;
  const read = readBoard(id, onFail);
  boardReads.set(id, read);
  void read.finally(() => boardReads.delete(id));
  return read;
}

async function readBoard(id: string, onFail?: (m: string) => void): Promise<BoardView> {
  const [lb, me] = await Promise.all([boardCall('read', () => idos.call((c) => c.leaderboard.getLeaderboard(id), onFail)), boardCall('mine', () => idos.call((c) => c.leaderboard.getMyProgress(id)))]);
  return {
    rows: rowsOf(lb?.TopUsers),
    endsAt: lb?.CycleEndUtc ? Date.parse(lb.CycleEndUtc) : weekEndsAt(),
    total: lb?.TotalParticipants ?? 0,
    myRank: me?.LastKnownRank ?? null,
    myScore: me?.CurrentScore ?? 0,
  };
}

export async function submitShift(score: number) {
  if (score <= 0) return null;
  return boardCall('submit', () => idos.call((c) => c.leaderboard.submitScore(IDS.shiftBoard, Math.floor(score))));
}

/** last week's rank rewards and every reachable milestone, in one call (the SDK does not claim them by itself) */
export async function claimWeekly(): Promise<number> {
  const r = await boardCall('claim', () => idos.call((c) => c.leaderboard.claimAllRewardsBatch([IDS.shiftBoard, IDS.huntBoard])));
  const entries = (r as unknown as { Resources?: { Grant?: { Standard?: { Entries?: ResourceEntry[] } } } } | null)?.Resources?.Grant?.Standard?.Entries ?? [];
  return entries.filter((e) => e.CurrencyID === SALVAGE.CurrencyID).reduce((a, e) => a + (e.Amount ?? 0), 0);
}

// ---------------------------------------------------------------- daily contracts

export interface ContractView {
  id: string;
  name: string;
  desc: string;
  progress: number;
  target: number;
  salvage: number;
  status: 'Active' | 'Completed' | 'Claimed' | 'Expired';
}

let questDefs: QuestDefinitions | null = null;
let questState: UserQuestState | null = null;

export async function loadContracts(onFail?: (m: string) => void): Promise<ContractView[]> {
  if (!questDefs) questDefs = await idos.call((c) => c.quest.getQuestDefinitions(), onFail);
  const st = await idos.call((c) => c.quest.getUserQuestState(), onFail);
  questState = st?.State ?? null;
  return contracts();
}

export function contracts(): ContractView[] {
  const cyc = questState?.Cycles?.[IDS.contractCycle];
  return CONTRACTS.map((c) => {
    const q = cyc?.Quests?.[c.id];
    const def = questDefs?.Quests?.[c.id];
    return {
      id: c.id,
      name: def?.Identity?.DisplayName ?? c.name,
      desc: def?.Identity?.Description ?? c.desc,
      progress: Math.min(c.target, q?.Objectives?.main?.CurrentValue ?? 0),
      target: c.target,
      salvage: c.salvage,
      status: (q?.Status as ContractView['status']) ?? 'Active',
    };
  });
}

export const contractsEndAt = () => {
  const end = questState?.Cycles?.[IDS.contractCycle]?.CycleEndUtc;
  return end ? Date.parse(end) : 0;
};

/** report one run's numbers; one call per metric, only for what moved */
export async function reportRun(m: Partial<Record<'ram_kills' | 'near_misses' | 'distance_m' | 'bosses' | 'duels' | 'shift_runs', number>>) {
  if (!idos.online) return;
  for (const c of CONTRACTS) {
    const v = Math.floor(m[c.metric as keyof typeof m] ?? 0);
    if (v <= 0) continue;
    // never above the per-report cap (the server bans past it); a run cannot honestly come near it
    await idos.lane('quest', ACTION_GAP_MS, () => idos.call((cl) => cl.quest.addQuestProgress(c.metric, Math.min(v, c.cap))));
  }
}

export async function claimContract(id: string, onFail?: (m: string) => void) {
  const r = await idos.call((c) => c.quest.claimQuestReward(id, IDS.contractCycle), onFail);
  if (r) await loadContracts();
  return r;
}

/** the full-board bonus (a crate key) once enough contracts are claimed */
export async function claimBoardBonus(onFail?: (m: string) => void) {
  return idos.call((c) => c.quest.claimMilestoneReward(IDS.contractCycle, 'full_board'), onFail);
}

export const boardPoints = () => idos.client?.data.user.getQuestPointsProgress(IDS.contractCycle)?.Balance?.TotalEarned ?? 0;
export const BOARD_BONUS = CONTRACT_BONUS;

// ---------------------------------------------------------------- THE DRIVER hunt

export const huntKey = (week = weekIndex()) => `hunt_w${week}`;

export async function huntTotal(): Promise<number> {
  const key = huntKey();
  const r = await idos.call((c) => c.titleCustomData.getPublicTitleDataKeys([key]));
  return Number(r?.Runtime?.[key]?.Value ?? 0) || 0;
}

/** report a run's boss damage: to the city-wide counter (Cloud Code checks and caps it) and to the weekly hunt board */
export async function reportHunt(damage: number) {
  const d = Math.min(HUNT.perRunCap, Math.floor(damage));
  if (d <= 0 || !idos.online) return false;
  const r = await idos.call((c) => c.cloudCode.execute('huntHit', { damage: d }));
  const ok = !!r && !r.Error && (r.FunctionResult as { ok?: boolean } | null)?.ok === true;
  if (ok) await boardCall('submit', () => idos.call((c) => c.leaderboard.submitScore(IDS.huntBoard, d)));
  return ok;
}

// ---------------------------------------------------------------- the street market (liveries and supplies for SALVAGE)

export async function marketOffers(itemId: string): Promise<MarketplaceOfferView[]> {
  const r = await idos.call((c) => c.marketplace.getOffersByItem(itemId, 'Listing', undefined, 30));
  return (r?.Offers ?? []).filter((o) => o.Status === 'Active');
}

export async function marketGroups(): Promise<{ itemId: string; listings: number }[]> {
  const r = await idos.call((c) => c.marketplace.getGroupedOffers());
  return (r?.Groups ?? []).filter((g) => g.GoodsItemID && (g.CountsByType?.Listing ?? 0) > 0).map((g) => ({ itemId: g.GoodsItemID!, listings: g.CountsByType?.Listing ?? 0 }));
}

export async function marketBuy(offerId: string, onFail?: (m: string) => void) {
  return idos.call((c) => c.marketplace.buy(offerId), onFail);
}

export async function marketSellWrap(itemId: string, instance: string, salvage: number, onFail?: (m: string) => void) {
  return idos.call((c) => c.marketplace.createListing(itemId, 'livery', 1, { Entries: [{ Type: 'VirtualCurrency', CurrencyID: SALVAGE.CurrencyID, Amount: salvage }] }, 72, [instance]), onFail);
}

export async function marketSellSupply(itemId: string, count: number, salvage: number, onFail?: (m: string) => void) {
  return idos.call((c) => c.marketplace.createListing(itemId, 'supply', count, { Entries: [{ Type: 'VirtualCurrency', CurrencyID: SALVAGE.CurrencyID, Amount: salvage }] }, 72), onFail);
}

export async function marketMine() {
  const r = await idos.call((c) => c.marketplace.getMyState('All', { forceRefresh: true }));
  return r?.MyOffers ?? [];
}

export async function marketCancel(offerId: string, onFail?: (m: string) => void) {
  return idos.call((c) => c.marketplace.cancelListing(offerId), onFail);
}
