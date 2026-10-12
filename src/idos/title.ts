/**
 * The iDos Games title this build plays as, and the ids the game's online systems are configured under.
 *
 * Production builds play as the live title. `npm run dev` and the platform's test address for a staged build
 * (gjf4gvxp-dev.idos.games) play against the DEV sandbox (GJF4GVXP-DEV), which has the
 * same modules configured but no on-chain token: there a virtual stand-in ("MT") plays MileToken's part. The URL can
 * override either way: `?idos=live` or `?idos=dev`.
 */

export const LIVE_TITLE_ID = 'GJF4GVXP';
export const DEV_TITLE_ID = 'GJF4GVXP-DEV';

export type IdosMode = 'live' | 'dev';

export function idosMode(): IdosMode {
  const q = new URLSearchParams(location.search).get('idos');
  if (q === 'live' || q === 'dev') return q;
  // the platform's test address for a staged build plays against the sandbox, like `npm run dev`
  if (/^gjf4gvxp-dev\./i.test(location.hostname)) return 'dev';
  return import.meta.env.DEV ? 'dev' : 'live';
}

export interface ResourceRef {
  Type: 'VirtualCurrency' | 'CryptoCurrency';
  CurrencyID: string;
}

/** MileToken: the title's Solana token. On the DEV sandbox, a virtual currency stands in for it. */
export function tokenRef(mode: IdosMode): ResourceRef {
  return mode === 'live' ? { Type: 'CryptoCurrency', CurrencyID: 'Main' } : { Type: 'VirtualCurrency', CurrencyID: 'MT' };
}

/** SALVAGE: the garage currency of the street scene. Earned by playing (contracts, the weekly Shift, duels), never bought with salvage. */
export const SALVAGE: ResourceRef = { Type: 'VirtualCurrency', CurrencyID: 'SV' };

/** Ids shared by the game code and the title configuration (docs/IDOS_INTEGRATION.md lists the whole setup). */
export const IDS = {
  /** the weekly Shift: one seed for everyone, best score of the week */
  shiftBoard: 'weekly_shift',
  /** THE DRIVER hunt: each driver's boss damage this week */
  huntBoard: 'driver_hunt',
  /** daily contracts (quest cycle) */
  contractCycle: 'contracts',
  /** street duels: one match rule per stake currency */
  duelRuleSalvage: 'street_tq',
  duelRuleToken: 'street_mt',
  /** consumables bought in the depot and spent on the road */
  items: {
    towTruck: 'tow_truck',
    tollPass: 'toll_pass',
    voucher: 'bm_voucher',
    insurance: 'insurance',
  },
  /** the depot */
  store: 'depot',
} as const;
