import type { InstantBattleResponse } from '@idosgames/core';
import { DUEL_RULES, DUEL_STATS, SUPPLIES, type LiveryDef, type SupplyId } from '../idos/catalog';
import * as D from '../idos/duels';
import * as E from '../idos/economy';
import * as G from '../idos/garage';
import { idos } from '../idos/platform';
import { SALVAGE } from '../idos/title';
import { openWallet, walletAvailable, watchWallet } from '../idos/wallet';
import type { DuelEvent, DuelScript } from '../world/duelStage';
import { getVehicle } from '../data/vehicles';
import type { Game } from './game';

/**
 * The game's side of the iDos integration: what the garage tabs show, what their buttons do, and the moments in a run
 * where the platform steps in (a tow truck after a wreck, the toll express, the black market, insurance, the weekly
 * Shift's score, the contracts and the hunt). Every server call is guarded against double clicks; a refusal is shown in
 * plain words in the panel that asked. The driver is always signed in here (the game has no other way to play).
 */
export type StreetView = 'open' | 'post' | 'mine';
export type DepotView = 'shop' | 'wraps' | 'market';

export interface DuelOutcome {
  won: boolean;
  draw: boolean;
  /** what the winner took home, as text */
  prize: string;
  stake: string;
  opponent: string;
}

export class Online {
  /** actions in flight: a button that already fired stays disabled until the server answers */
  busy = new Set<string>();
  note: { text: string; good: boolean } | null = null;

  challenges: D.Challenge[] | null = null;
  mine: D.Challenge[] | null = null;
  shelves: E.Shelf[] | null = null;
  shift: Awaited<ReturnType<typeof E.board>> | null = null;
  hunt: Awaited<ReturnType<typeof E.board>> | null = null;
  huntTotal = 0;
  contracts: E.ContractView[] | null = null;
  marketGroups: { itemId: string; listings: number }[] | null = null;
  marketItem: string | null = null;
  marketOffers: Awaited<ReturnType<typeof E.marketOffers>> | null = null;
  myListings: Awaited<ReturnType<typeof E.marketMine>> | null = null;
  /** the wraps a crate just gave */
  crateReveal: LiveryDef[] | null = null;

  duelCar = 'courier';
  plan: D.PlanStep[] = D.DEFAULT_PLAN.map((p) => ({ ...p }));
  stake: D.Stake = { ref: SALVAGE, amount: 50 };
  street: StreetView = 'open';
  depot: DepotView = 'shop';
  /** the duel that is being performed in the pit */
  duel: { script: DuelScript; outcome: DuelOutcome } | null = null;

  constructor(private game: Game) {
    idos.on(() => this.game.refreshGarageUi());
  }

  get online() {
    return idos.online;
  }

  /** Called after every sign-in: the street's state for this account (duel cars, contracts, the boards). */
  start() {
    this.duelCar = this.game.save.selectedVehicle;
    this.challenges = this.mine = this.shelves = this.contracts = this.marketGroups = this.myListings = this.marketOffers = null;
    this.shift = this.hunt = null;
    this.huntTotal = 0;
    void watchWallet();
    void (async () => {
      await G.loadCars();
      this.plan = D.savedPlan();
      const won = await E.claimWeekly();
      if (won > 0) this.game.hud.toast('LAST WEEK', `Rank rewards: +${won} SALVAGE`);
      void this.loadContracts();
      void this.loadHunt();
      // the board also names the street-race rivals
      void this.loadShift();
      // the main menu shows the open challenges
      void this.loadStreet();
      this.game.refreshGarageUi();
    })();
  }

  // ---------------------------------------------------------------- loading

  /** load what a garage tab shows (cheap reads; each re-renders when it lands) */
  enterTab(tab: string) {
    if (!this.online) return;
    if (tab === 'PLAY') {
      void this.loadShift();
      void this.loadContracts();
      void this.loadHunt();
    } else if (tab === 'STREET') {
      void G.loadCars().then(() => this.game.refreshGarageUi());
      void this.loadStreet();
    } else if (tab === 'DEPOT') {
      void this.loadDepot();
      if (this.depot === 'market') void this.loadMarket();
    }
  }

  private async loadShift() {
    this.shift = await E.board('weekly_shift');
    this.game.refreshGarageUi();
  }

  async loadContracts() {
    this.contracts = await E.loadContracts();
    this.game.refreshGarageUi();
  }

  private async loadHunt() {
    this.huntTotal = await E.huntTotal();
    this.hunt = await E.board('driver_hunt');
    this.game.refreshGarageUi();
  }

  private async loadStreet() {
    const [open, mine] = [await D.listOpen(), await D.listMine()];
    this.challenges = open;
    this.mine = mine;
    this.game.refreshGarageUi();
  }

  private async loadDepot() {
    this.shelves = await E.loadDepot();
    this.game.refreshGarageUi();
  }

  private async loadMarket() {
    this.marketGroups = await E.marketGroups();
    this.myListings = await E.marketMine();
    if (this.marketItem) this.marketOffers = await E.marketOffers(this.marketItem);
    this.game.refreshGarageUi();
  }

  // ---------------------------------------------------------------- actions

  private say(text: string, good = false) {
    this.note = { text, good };
    this.game.refreshGarageUi();
  }

  private fail = (m: string) => this.say(m, false);

  /** run one guarded server action */
  private async run<T>(key: string, fn: () => Promise<T | null>): Promise<T | null> {
    if (this.busy.has(key)) return null;
    this.busy.add(key);
    this.note = null;
    this.game.refreshGarageUi();
    try {
      return await fn();
    } finally {
      this.busy.delete(key);
      this.game.refreshGarageUi();
    }
  }

  /** garage buttons with data-a="o-…" land here; returns true when handled */
  action(a: string, el: HTMLElement): boolean {
    if (!a.startsWith('o-')) return false;
    const v = el.dataset.v ?? '';
    const w = el.dataset.w ?? '';
    switch (a) {
      case 'o-wallet':
        void openWallet();
        break;
      // ---- street
      case 'o-street':
        this.street = v as StreetView;
        this.note = null;
        if (v !== 'post') void this.loadStreet();
        this.game.refreshGarageUi();
        break;
      case 'o-duelcar':
        this.duelCar = v;
        this.game.showGarageCar(v);
        this.game.refreshGarageUi();
        break;
      case 'o-tune':
        void this.run(`tune-${v}`, () => G.upgrade(this.duelCar, v, this.fail)).then((r) => r && this.say(`${DUEL_STATS.find((s) => s.id === v)?.label} → LEVEL ${r.StatLevel}`, true));
        break;
      case 'o-plan': {
        const [i, part] = v.split(':');
        const step = this.plan[Number(i)];
        if (step) step[part as 'ram' | 'brace'] = w as D.PlanStep['ram'];
        this.game.refreshGarageUi();
        break;
      }
      case 'o-plan-add':
        if (this.plan.length < 6) this.plan.push({ ram: 'front', brace: 'side' });
        this.game.refreshGarageUi();
        break;
      case 'o-plan-del':
        if (this.plan.length > 1) this.plan.pop();
        this.game.refreshGarageUi();
        break;
      case 'o-plan-save':
        void this.run('plan', () => D.savePlan(this.plan)).then((r) => r && this.say('RAM PLAN SAVED — IT DEFENDS YOUR POSTED CHALLENGES', true));
        break;
      case 'o-stake':
        this.stake = v.startsWith('item:') ? { ref: { Type: 'Item', ItemID: v.slice(5) }, amount: Number(w) || 1 } : { ref: SALVAGE, amount: Number(v) };
        this.game.refreshGarageUi();
        break;
      case 'o-post': {
        const high = this.stake.ref.Type !== 'Item' && this.stake.amount >= DUEL_RULES.high.min;
        void this.run('post', () => D.post(this.duelCar, this.stake, this.plan, high, this.fail)).then((r) => {
          if (!r) return;
          this.say(`CHALLENGE POSTED — ${D.stakeLabel(this.stake)} IN ESCROW FOR 48 H`, true);
          this.street = 'mine';
          void this.loadStreet();
        });
        break;
      }
      case 'o-cancel':
        void this.run(`cancel-${v}`, () => D.cancel(v, this.fail)).then((r) => {
          if (r) this.say('CHALLENGE WITHDRAWN — STAKE RETURNED', true);
          void this.loadStreet();
        });
        break;
      case 'o-take': {
        const ch = this.challenges?.find((c) => c.match.MatchID === v);
        if (ch) void this.take(ch);
        break;
      }
      // ---- wraps
      case 'o-wear': {
        const wrap = v === 'stock' ? null : G.ownedWraps().find((x) => x.instance === v) ?? null;
        void this.run('wear', () => G.wear(this.duelCar, wrap, this.fail)).then((r) => {
          if (!r) return;
          this.game.showGarageCar(this.duelCar);
          this.say(wrap ? `${wrap.def.name} WRAPPED ON THE ${getVehicle(this.duelCar).name}` : 'BACK TO STOCK PAINT', true);
        });
        break;
      }
      // ---- depot
      case 'o-depot':
        this.depot = v as DepotView;
        this.note = null;
        this.crateReveal = null;
        if (v === 'market') void this.loadMarket();
        this.game.refreshGarageUi();
        break;
      case 'o-buy': {
        const item = this.shelves?.flatMap((s) => s.items).find((x) => x.offer.OfferID === v);
        if (!item) break;
        void this.run(`buy-${v}`, () => E.buy(item, w, this.fail)).then((r) => {
          if (!r) return;
          this.say(`BOUGHT: ${item.offer.Identity?.DisplayName ?? v}`, true);
          // a car bought here is a garage item: it is in the VEHICLES tab at once
          void idos.call((c) => c.user.getUserInventory()).then(() => this.game.accountChanged());
          void this.loadDepot();
        });
        break;
      }
      case 'o-crate':
        void this.run('crate', () => E.openCrate(v === 'key', this.fail)).then((r) => {
          if (!r) return;
          this.crateReveal = r;
          this.game.audio.item();
          this.game.refreshGarageUi();
        });
        break;
      case 'o-mkt-item':
        this.marketItem = v;
        this.marketOffers = null;
        void E.marketOffers(v).then((o) => {
          this.marketOffers = o;
          this.game.refreshGarageUi();
        });
        this.game.refreshGarageUi();
        break;
      case 'o-mkt-buy':
        void this.run(`mbuy-${v}`, () => E.marketBuy(v, this.fail)).then((r) => {
          if (!r) return;
          this.say('BOUGHT ON THE STREET MARKET', true);
          void this.loadMarket();
        });
        break;
      case 'o-mkt-sell': {
        const price = Math.max(10, Math.round(Number((document.getElementById('o-price') as HTMLInputElement | null)?.value ?? '0')));
        const wrap = G.ownedWraps().find((x) => x.instance === v);
        const sup = SUPPLIES.find((s) => s.id === v);
        const call = wrap ? () => E.marketSellWrap(wrap.def.id, wrap.instance, price, this.fail) : sup ? () => E.marketSellSupply(sup.id, 1, price, this.fail) : null;
        if (!call) break;
        void this.run(`sell-${v}`, call).then((r) => {
          if (!r) return;
          this.say(`LISTED FOR ${price} SALVAGE — 5% OF THE SALE IS BURNED`, true);
          void this.loadMarket();
        });
        break;
      }
      case 'o-mkt-cancel':
        void this.run(`mcancel-${v}`, () => E.marketCancel(v, this.fail)).then(() => void this.loadMarket());
        break;
      // ---- contracts
      case 'o-claim':
        void this.run(`claim-${v}`, () => E.claimContract(v, this.fail)).then((r) => {
          if (!r) return;
          this.contracts = E.contracts();
          this.say('CONTRACT PAID', true);
        });
        break;
      case 'o-bonus':
        void this.run('bonus', () => E.claimBoardBonus(this.fail)).then((r) => r && this.say('FULL BOARD — A CRATE KEY IS YOURS', true));
        break;
      case 'o-shift':
        this.game.launchShift();
        break;
      default:
        return false;
    }
    return true;
  }

  get walletButton() {
    return walletAvailable();
  }

  // ---------------------------------------------------------------- street duels

  private async take(ch: D.Challenge) {
    const res = await this.run(`take-${ch.match.MatchID}`, () => D.take(ch, this.duelCar, this.plan, this.fail));
    if (!res?.Battle) {
      void this.loadStreet();
      return;
    }
    const outcome = this.outcomeOf(res, ch);
    const script = D.scriptOf(res.Battle, this.duelCar, D.driverTag(ch.match.CreatorID));
    this.duel = { script, outcome };
    void E.reportRun({ duels: 1 });
    this.game.playDuel(script, outcome);
  }

  private outcomeOf(res: InstantBattleResponse, ch: D.Challenge): DuelOutcome {
    const b = res.Battle!;
    const draw = !!b.IsDraw || !b.WinnerUserID;
    const won = !draw && b.WinnerUserID === idos.userId;
    const net = D.stakeOf(b.NetReward ?? null);
    return { won, draw, prize: net ? D.stakeLabel(net) : '', stake: D.stakeLabel(ch.stake), opponent: D.driverTag(ch.match.CreatorID) };
  }

  /** after the pit: back to the street tab with fresh lists */
  duelFinished() {
    this.duel = null;
    this.street = 'open';
    void this.loadStreet();
    void this.loadContracts();
  }

  // ---------------------------------------------------------------- moments in a run

  /** supplies are off in the ranked Shift (and wait while a dropped session reconnects) */
  canSupply(ranked: boolean) {
    return this.online && !ranked;
  }

  stock(id: SupplyId) {
    return idos.itemCount(id);
  }

  /** spend one (from stock, or MileToken on the spot) */
  spend(id: SupplyId, fromStock: boolean, onFail: (m: string) => void) {
    return E.useSupply(id, fromStock, onFail);
  }

  tokenPrice(id: SupplyId) {
    return SUPPLIES.find((s) => s.id === id)?.onTheSpot ?? 0;
  }

  get tokens() {
    return idos.tokens;
  }

  /** a finished run: report the contracts, the Shift score and the hunt. Returns the Shift rank line, if any. */
  async afterRun(r: { ranked: boolean; score: number; ramKills: number; nearMisses: number; distance: number; bosses: number; huntDamage: number }): Promise<string[]> {
    if (!this.online) return [];
    const lines: string[] = [];
    await E.reportRun({ ram_kills: r.ramKills, near_misses: r.nearMisses, distance_m: r.distance, bosses: r.bosses, shift_runs: r.ranked ? 1 : 0 });
    if (r.ranked && r.score > 0) {
      const s = await E.submitShift(r.score);
      if (s) {
        const b = await E.board('weekly_shift');
        this.shift = b;
        lines.push(`WEEKLY SHIFT · BEST ${s.NewScore.toLocaleString('en-US')}${b.myRank ? ` · RANK #${b.myRank} OF ${b.total}` : ''}`);
      }
    }
    if (r.huntDamage > 0 && (await E.reportHunt(r.huntDamage))) lines.push(`THE DRIVER HUNT · +${Math.round(Math.min(r.huntDamage, 9000)).toLocaleString('en-US')} BOSS DAMAGE FOR THE CITY`);
    this.contracts = await E.loadContracts();
    const done = this.contracts.filter((c) => c.status === 'Completed').length;
    if (done) lines.push(`${done} CONTRACT${done > 1 ? 'S' : ''} READY TO CLAIM IN THE GARAGE`);
    return lines;
  }

  /** a real driver from this week's Shift board to race against (never yourself); null while reconnecting or on an empty board */
  rivalFor(salt: number): { name: string; rank: number } | null {
    const rows = (this.shift?.rows ?? []).filter((r) => !r.me && r.name).slice(0, 30);
    if (!this.online || !rows.length) return null;
    const r = rows[Math.abs(Math.floor(salt)) % rows.length];
    return { name: r.name, rank: r.rank };
  }
}
