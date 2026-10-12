import type { IDosGamesClient, OperationResult } from '@idosgames/core';
import { DEV_TITLE_ID, idosMode, LIVE_TITLE_ID, SALVAGE, tokenRef, type IdosMode, type ResourceRef } from './title';
import { connectWallet, toHex } from './wallets';

/**
 * ZERO MILE is an iDos Games game: a driver plays signed in, and everything the driver owns lives on the server.
 *
 * Boot resumes a remembered session (or the one-time code idosgames.com hands over); otherwise the sign-in screen asks
 * for a method — a Solana wallet, the iDos Games account, e-mail, Telegram inside a Mini App, or a guest profile. There
 * is no offline game: a server that cannot be reached is a connection screen with a retry, never a different game.
 */

export type AccountKind = 'wallet' | 'idos' | 'email' | 'guest' | 'telegram';
export interface Account {
  kind: AccountKind;
  address?: string;
}
export type AuthResult = { ok: true; account: Account } | { ok: false; error: string };
export type ResumeResult = 'online' | 'needs-login' | 'unreachable';
export type NetStatus = 'connecting' | 'online' | 'signed-out' | 'unreachable';

/** the Solana network id in the title's Blockchain.Networks */
export const NETWORK_ID = 'solana';
const LOGIN_TIMEOUT_MS = 20000;
/**
 * The live server answers the same action twice within about a second with a 429 (measured on GJF4GVXP: two
 * GetLeaderboard calls 0.7 s apart). Calls of one kind start at least this far apart.
 */
export const ACTION_GAP_MS = 1100;

const withTimeout = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** where idosgames.com sends the one-time sign-in code back (the platform's allow-list) */
const SSO_ORIGINS = ['https://cloud.idosgames.com', 'https://idosgames.com', 'https://www.idosgames.com'];
const GAME_HOST = /^https:\/\/[a-z0-9]{8}(-dev)?\.idos\.games$/;

export function ssoAvailable() {
  return SSO_ORIGINS.includes(location.origin) || GAME_HOST.test(location.origin);
}

/** a sign-in code from idosgames.com is waiting in the address: boot must not show the sign-in screen */
export const ssoCodePending = () => /(^|[#&])idos_sso=/.test(location.hash);

export const telegramAvailable = () => !!(globalThis as { Telegram?: { WebApp?: { initData?: string } } }).Telegram?.WebApp?.initData;

export const inFrame = () => {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
};

/** framed by idosgames.com itself: there the SITE's wallet signs (never the game's own) */
export function onPlatformSite() {
  if (!inFrame()) return false;
  const isPlatform = (u: string) => {
    try {
      return /(^|\.)idosgames\.com$/.test(new URL(u).hostname);
    } catch {
      return false;
    }
  };
  const ancestors = (location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins;
  if (ancestors?.length) return isPlatform(ancestors[ancestors.length - 1]);
  return !!document.referrer && isPlatform(document.referrer);
}

function kindOf(authType: string): AccountKind {
  switch (authType) {
    case 'Wallet':
      return 'wallet';
    case 'iDosGames':
    case 'Google':
    case 'Apple':
      return 'idos';
    case 'Email':
      return 'email';
    case 'Telegram':
      return 'telegram';
    default:
      return 'guest';
  }
}

/** server refusal codes → words a driver can act on */
export function explainAuthError(code: string | undefined): string {
  const e = code ?? '';
  if (/reject|denied|cancel|declined/i.test(e)) return 'The signature was declined in the wallet. Nothing happened.';
  switch (e) {
    case 'NO_WALLET':
      return 'No Solana wallet found. Install Phantom, Solflare or Backpack and reload the page.';
    case 'PLATFORM_WALLET_UNAVAILABLE':
      return 'idosgames.com did not answer the signature request. Connect a wallet on the site, or open the game by its own address.';
    case 'WALLET_USE_SITE_PANEL':
      return 'Inside idosgames.com the wallet connects on the site itself.';
    case 'WALLET_LOGIN_DISABLED':
      return 'Wallet sign-in is unavailable right now. Pick another way.';
    case 'EMAIL_SENDER_NOT_CONFIGURED':
      return 'E-mail sign-in is unavailable right now. Pick another way.';
    case 'INVALID_VERIFICATION_CODE':
      return 'That code did not match. Check the e-mail and try again.';
    case 'VERIFICATION_CODE_ATTEMPTS_EXCEEDED':
      return 'Too many wrong codes. Ask for a new one.';
    case 'INCORRECT_EMAIL_OR_PASSWORD':
      return 'Wrong e-mail or password.';
    case 'INCORRECT_EMAIL':
      return 'That does not look like an e-mail address.';
    case 'PASSWORD_LENGTH_INVALID':
      return 'The password must be 8 to 100 characters.';
    case 'TOO_MANY_FAILED_ATTEMPTS':
    case 'RATE_LIMIT_EXCEEDED':
      return 'Too many attempts. Wait a moment and try again.';
    case 'PLAY_ACCESS_WALLET_USED_BY_ANOTHER_ACCOUNT':
      return 'This wallet is already linked to another account.';
    case 'WALLET_UNLINK_COOLDOWN':
      return 'This wallet was recently unlinked from another account. Try again in 7 days.';
    case 'timeout':
    case 'connection':
      return 'Cannot reach the server. Check the connection and try again.';
    default:
      return e ? `Sign-in failed: ${e.replace(/_/g, ' ').slice(0, 120)}` : 'Sign-in failed. Try again.';
  }
}

class Platform {
  readonly mode: IdosMode = idosMode();
  status: NetStatus = 'connecting';
  client: IDosGamesClient | null = null;
  account: Account | null = null;
  userId = '';
  lastError = '';
  /** the session ended under the game (expired, signed in elsewhere): the game asks the driver to sign in again */
  onSessionLost: (() => void) | null = null;
  private listeners = new Set<() => void>();
  private sdkPromise: Promise<IDosGamesClient> | null = null;

  get online() {
    return this.status === 'online' && !!this.client;
  }

  get titleId() {
    return this.mode === 'live' ? LIVE_TITLE_ID : DEV_TITLE_ID;
  }

  /** MileToken (the Solana token) — or its virtual stand-in on the DEV sandbox */
  get token(): ResourceRef {
    return tokenRef(this.mode);
  }

  /** the SDK, loaded once */
  sdk(): Promise<IDosGamesClient> {
    this.sdkPromise ??= import('@idosgames/core').then((sdk) => {
      // the SDK's own per-endpoint throttle refuses a second call within 600 ms (a run closed and the next one opened is
      // exactly that): the game spaces its own calls instead (profile.ts, the boards' queue in economy.ts)
      const client = sdk.createIDosGamesClient({ titleID: this.titleId, appVersion: '1.2.0', loginViews: 'none', throttleMs: 0 });
      this.client = client;
      // balances, inventory and every module's state arrive through the SDK's events: forward them to the UI
      const forward = () => this.emit();
      for (const ev of ['user:stateUpdated', 'user:virtualCurrencyUpdated', 'user:inventoryUpdated', 'user:characterUpdated', 'user:matchUpdated', 'user:questUpdated', 'user:leaderboardUpdated', 'user:customDataUpdated', 'user:storeUpdated', 'user:marketplaceUpdated'] as const) client.on(ev, forward);
      client.on('auth:unauthorized', () => this.lost());
      return client;
    });
    return this.sdkPromise;
  }

  /**
   * At boot: the code idosgames.com handed over, else the remembered session. Never creates a guest by itself, and
   * keeps "the server is unreachable" apart from "the driver has to sign in".
   */
  async resume(): Promise<ResumeResult> {
    this.status = 'connecting';
    this.emit();
    try {
      const client = await this.sdk();
      const { readSsoCodeFromUrl } = await import('@idosgames/core');
      const sso = readSsoCodeFromUrl();
      if (sso) {
        const res = await withTimeout(client.auth.loginWithSsoCode(sso.code), 10000);
        if (res?.ok) return this.signedIn({ kind: 'idos' }) ? 'online' : 'online';
        this.lastError = res ? res.error : 'timeout';
        if (!res || res.reason === 'connection') return this.unreachable();
        return this.signedOut();
      }
      if (client.auth.isLoggedIn) return this.signedIn({ kind: kindOf(client.auth.lastAuthType) }) ? 'online' : 'online';
      if (client.auth.lastAuthType === 'None') return this.signedOut();
      let res = await withTimeout(client.auth.autoLogin(), 8000);
      for (const wait of [1200, 2500]) {
        // only a connection failure is worth another try
        if (res && (res.ok || res.reason !== 'connection')) break;
        await sleep(wait);
        res = await withTimeout(client.auth.autoLogin(), 8000);
      }
      if (res?.ok) return this.signedIn({ kind: kindOf(client.auth.lastAuthType) }) ? 'online' : 'online';
      this.lastError = res ? res.error : 'timeout';
      if (!res || res.reason === 'connection') return this.unreachable();
      return this.signedOut();
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      return this.unreachable();
    }
  }

  private signedIn(account: Account) {
    this.account = account;
    this.userId = this.client?.auth.context?.userID ?? '';
    this.status = 'online';
    this.emit();
    return true;
  }

  private signedOut(): ResumeResult {
    this.status = 'signed-out';
    this.account = null;
    this.emit();
    return 'needs-login';
  }

  private unreachable(): ResumeResult {
    this.status = 'unreachable';
    this.emit();
    return 'unreachable';
  }

  private lost() {
    if (this.status !== 'online') return;
    this.status = 'signed-out';
    this.account = null;
    this.emit();
    this.onSessionLost?.();
  }

  // ---------------------------------------------------------------- sign-in methods (each remembers or not, as asked)

  private async run(remember: boolean, login: (c: IDosGamesClient) => Promise<OperationResult<unknown>>, account: Account): Promise<AuthResult> {
    try {
      const client = await this.sdk();
      client.auth.setRememberSession(remember);
      const res = await withTimeout(login(client), LOGIN_TIMEOUT_MS);
      if (!res) return { ok: false, error: explainAuthError('timeout') };
      if (!res.ok) return { ok: false, error: explainAuthError(res.reason === 'connection' ? 'connection' : res.error) };
      this.signedIn(account);
      return { ok: true, account };
    } catch (e) {
      return { ok: false, error: explainAuthError(e instanceof Error ? e.message : String(e)) };
    }
  }

  guest(remember: boolean) {
    return this.run(remember, (c) => c.auth.loginWithDeviceID(), { kind: 'guest' });
  }

  email(email: string, password: string, remember: boolean) {
    return this.run(remember, (c) => c.auth.loginWithEmail(email.trim(), password), { kind: 'email' });
  }

  async register(email: string, password: string, remember: boolean): Promise<{ ok: true; resendIn: number } | { ok: false; error: string }> {
    try {
      const client = await this.sdk();
      // before registering: the SDK keeps the credentials so the session it opens after confirmation can be remembered
      client.auth.setRememberSession(remember);
      const res = await withTimeout(client.auth.registerWithEmail(email.trim(), password), LOGIN_TIMEOUT_MS);
      if (!res) return { ok: false, error: explainAuthError('timeout') };
      if (!res.ok) return { ok: false, error: explainAuthError(res.error) };
      return { ok: true, resendIn: res.data.resendCooldownSeconds ?? 60 };
    } catch (e) {
      return { ok: false, error: explainAuthError(e instanceof Error ? e.message : String(e)) };
    }
  }

  confirm(email: string, code: string, remember: boolean) {
    return this.run(remember, (c) => c.auth.confirmEmailRegistration(email.trim(), code.trim()), { kind: 'email' });
  }

  async resend(email: string): Promise<string | null> {
    const client = await this.sdk();
    const r = await client.auth.resendVerificationCode(email.trim());
    return r.ok ? null : explainAuthError(r.error);
  }

  /** never says whether an account exists for the address */
  async forgot(email: string): Promise<string | null> {
    const client = await this.sdk();
    const r = await client.auth.forgotPassword(email.trim());
    return !r.ok && r.error === 'EMAIL_SENDER_NOT_CONFIGURED' ? explainAuthError(r.error) : null;
  }

  async reset(email: string, code: string, password: string): Promise<string | null> {
    const client = await this.sdk();
    const r = await client.auth.resetPassword(email.trim(), code.trim(), password);
    return r.ok ? null : explainAuthError(r.error);
  }

  telegram(remember: boolean) {
    return this.run(remember, (c) => c.auth.loginWithTelegram(), { kind: 'telegram' });
  }

  /** the iDos Games account: a live platform session comes back silently, otherwise a trip through idosgames.com */
  async idos(remember: boolean): Promise<AuthResult | 'redirecting'> {
    try {
      const client = await this.sdk();
      client.auth.setRememberSession(remember);
      if (client.auth.lastAuthType === 'iDosGames') {
        const res = await withTimeout(client.auth.autoLogin(), 8000);
        if (res?.ok) {
          this.signedIn({ kind: 'idos' });
          return { ok: true, account: { kind: 'idos' } };
        }
      }
      const { beginSsoRedirect } = await import('@idosgames/core');
      beginSsoRedirect({ titleID: this.titleId });
      return 'redirecting';
    } catch (e) {
      return { ok: false, error: explainAuthError(e instanceof Error ? e.message : String(e)) };
    }
  }

  /**
   * A Solana wallet: the server's challenge signed in the wallet (free, no transaction). Inside idosgames.com the site's
   * wallet signs; anywhere else the wallet the driver picked.
   */
  async wallet(optionId: string | null, remember: boolean): Promise<AuthResult> {
    try {
      const client = await this.sdk();
      client.auth.setRememberSession(remember);
      if (onPlatformSite()) {
        const pkg = await import('@idosgames/wallet');
        const res = await withTimeout(pkg.loginWithWalletViaPlatform({ client, networkID: NETWORK_ID, family: 'solana' }), 120000);
        if (!res) return { ok: false, error: explainAuthError('timeout') };
        if (!res.ok) return { ok: false, error: explainAuthError(res.error) };
        this.signedIn({ kind: 'wallet' });
        return { ok: true, account: { kind: 'wallet' } };
      }
      if (!optionId) return { ok: false, error: explainAuthError('NO_WALLET') };
      const signer = await connectWallet(optionId);
      const challenge = await client.auth.requestWalletChallenge(signer.address, NETWORK_ID);
      if (!challenge.ok) return { ok: false, error: explainAuthError(challenge.error) };
      const signature = await signer.signMessage(new TextEncoder().encode(challenge.data.Message));
      const res = await client.auth.loginWithWallet(signer.address, NETWORK_ID, toHex(signature));
      if (!res.ok) return { ok: false, error: explainAuthError(res.error) };
      const account: Account = { kind: 'wallet', address: signer.address };
      this.signedIn(account);
      return { ok: true, account };
    } catch (e) {
      return { ok: false, error: explainAuthError(e instanceof Error ? e.message : String(e)) };
    }
  }

  /** attach a wallet to an e-mail / iDos account (a guest signs in properly first) */
  async linkWallet(optionId: string | null): Promise<string | null> {
    try {
      const client = await this.sdk();
      if (onPlatformSite()) {
        const pkg = await import('@idosgames/wallet');
        const r = await pkg.linkWalletViaPlatform({ client, networkID: NETWORK_ID, family: 'solana' });
        return r.ok ? null : explainAuthError(r.error);
      }
      if (!optionId) return explainAuthError('NO_WALLET');
      const signer = await connectWallet(optionId);
      const step1 = await client.auth.linkWallet(signer.address, NETWORK_ID);
      if (!step1.ok) return explainAuthError(step1.error);
      if (step1.data.Linked) return null;
      if (!step1.data.Challenge) return explainAuthError('NO_CHALLENGE');
      const sig = await signer.signMessage(new TextEncoder().encode(step1.data.Challenge));
      const step2 = await client.auth.linkWallet(signer.address, NETWORK_ID, toHex(sig));
      return step2.ok ? null : explainAuthError(step2.error);
    } catch (e) {
      return explainAuthError(e instanceof Error ? e.message : String(e));
    }
  }

  /** wallets linked to the account (from the platform state) */
  async linkedWallets(): Promise<{ network: string; address: string }[]> {
    const r = await this.call((c) => c.blockchain.getPlayAccess());
    return (r?.LinkedWallets ?? []).map((w) => ({ network: w.NetworkID ?? '', address: w.Address ?? '' })).filter((w) => w.address);
  }

  logout() {
    this.client?.auth.logout();
    this.account = null;
    this.userId = '';
    this.status = 'signed-out';
    this.emit();
  }

  /** the public name when the session's state does not carry it (a resumed session): read from Cloud Code */
  knownName = '';

  get name(): string {
    return this.client?.data.user.state?.PublicData?.Username || this.knownName;
  }

  private renamed: string | null = null;
  get displayName(): string {
    return this.renamed ?? this.name;
  }

  async setName(name: string, onFail?: (m: string) => void) {
    const r = await this.call((c) => c.user.changeUsername(name.trim()), onFail);
    if (r?.Username) this.renamed = r.Username;
    this.emit();
    return r;
  }

  // ---------------------------------------------------------------- calls and state

  /**
   * Run one SDK call. Returns the data, or null when refused; the refusal is kept in `lastError` and passed to `onFail`
   * so a screen can say what happened in plain words.
   */
  async call<T>(fn: (c: IDosGamesClient) => Promise<OperationResult<T>>, onFail?: (msg: string) => void): Promise<T | null> {
    if (!this.online) {
      onFail?.(this.status === 'unreachable' ? 'NO CONNECTION' : 'SIGN IN FIRST');
      return null;
    }
    try {
      const r = await fn(this.client!);
      if (r.ok) return r.data;
      this.lastError = `${r.reason}: ${r.error}`;
      if (r.reason === 'unauthorized') this.lost();
      onFail?.(humanError(r.error, r.reason));
      return null;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      onFail?.('CONNECTION LOST');
      return null;
    }
  }

  /** Balance of a currency (crypto amounts are decimal strings on the wire). */
  balance(ref: ResourceRef): number {
    const inv = this.client?.data.user.state?.InventoryV2;
    if (!inv) return 0;
    if (ref.Type === 'CryptoCurrency') return Number(inv.CryptoCurrencies?.[ref.CurrencyID]?.Amount ?? 0) || 0;
    return inv.VirtualCurrencies?.[ref.CurrencyID]?.Amount ?? 0;
  }

  get salvage() {
    return this.balance(SALVAGE);
  }

  get tokens() {
    return this.balance(this.token);
  }

  /** How many of a stackable item the player holds. */
  itemCount(itemId: string): number {
    const t = this.client?.data.user.state?.InventoryV2?.Items?.[itemId];
    return t ? t.TotalAmount ?? t.StackableAmount ?? 0 : 0;
  }

  /** Display name of a currency. */
  currencyName(ref: ResourceRef): string {
    if (ref.CurrencyID === 'Main' || ref.CurrencyID === 'MT') return 'MILETOKEN';
    if (ref.CurrencyID === SALVAGE.CurrencyID) return 'SALVAGE';
    return ref.CurrencyID;
  }

  private lanes = new Map<string, { chain: Promise<unknown>; last: number }>();

  /**
   * Calls of one kind, one at a time and started at least `gapMs` apart: iDos answers bursts of the same action with
   * 429s (and its retries stall for seconds), so the game paces itself instead.
   */
  lane<T>(key: string, gapMs: number, task: () => Promise<T>): Promise<T> {
    let lane = this.lanes.get(key);
    if (!lane) this.lanes.set(key, (lane = { chain: Promise.resolve(), last: 0 }));
    const l = lane;
    const run = l.chain.then(async () => {
      const wait = l.last + gapMs - Date.now();
      if (wait > 0) await sleep(wait);
      l.last = Date.now();
      return task();
    });
    l.chain = run.catch(() => undefined);
    return run;
  }

  on(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const f of this.listeners) f();
  }
}

/** Server refusals in the words a player can act on. */
export function humanError(error: string, reason?: string): string {
  const e = (error || '').toUpperCase();
  if (reason === 'connection') return 'CONNECTION LOST — TRY AGAIN';
  if (reason === 'throttled') return 'ONE MOMENT…';
  if (e.includes('INSUFFICIENT') || e.includes('NOT_ENOUGH') || e.includes('BALANCE') || e === 'FUNDS') return 'NOT ENOUGH FUNDS';
  if (e.includes('LIMIT')) return 'LIMIT REACHED FOR NOW';
  if (e.includes('NOT_FOUND')) return 'NO LONGER AVAILABLE';
  if (e.includes('EXPIRED')) return 'EXPIRED';
  return (error || 'REFUSED').replace(/_/g, ' ').slice(0, 80);
}

export const idos = new Platform();
