import { explainAuthError, idos, onPlatformSite, ssoAvailable, telegramAvailable, type Account, type AuthResult } from '../idos/platform';
import { isMobileBrowser, onWalletsChanged, walletAppLinks, walletOptions, type WalletOption } from '../idos/wallets';
import { esc } from './screens';

/**
 * Signing in: the first screen of the game for a driver without a session, and the way back after signing out.
 *
 * A Solana wallet comes first (a free signature, no transaction), then the iDos Games account (where the platform can
 * send the driver back), e-mail with its register / confirm / forgot / reset steps, Telegram inside a Mini App, and a
 * guest profile last. "Remember me" goes with every method. The screen never says whether an e-mail has an account.
 */

type Mode = 'menu' | 'wallets' | 'email' | 'register' | 'verify' | 'forgot' | 'reset';

export interface LoginHost {
  show(html: string, handler: (a: string, el: HTMLElement) => void, keys?: ((code: string) => void) | null, focus?: boolean): void;
  readonly overlay: HTMLElement;
  /** a session is open: on to the game */
  signedIn(account: Account): void;
  /** the upgrade invitation was declined: back where the driver was */
  stayGuest(): void;
}

export interface LoginOptions {
  /** a guest invited to sign in with a real account */
  upgrade?: boolean;
  /** why the screen is back (the session ended) */
  notice?: string;
}

const KIND_LABEL: Record<Account['kind'], string> = { wallet: 'SOLANA WALLET', idos: 'IDOS GAMES', email: 'E-MAIL', guest: 'GUEST', telegram: 'TELEGRAM' };
export const kindLabel = (k: Account['kind']) => KIND_LABEL[k];

export class LoginScreen {
  private mode: Mode = 'menu';
  private busy = false;
  private error = '';
  private info = '';
  private remember = true;
  private email = '';
  private password = '';
  private code = '';
  private resendAt = 0;
  private opts: LoginOptions = {};
  private open = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private host: LoginHost) {
    onWalletsChanged(() => this.open && this.mode === 'wallets' && !this.busy && this.render());
  }

  show(opts: LoginOptions = {}) {
    this.opts = opts;
    this.mode = 'menu';
    this.busy = false;
    this.error = '';
    this.info = opts.notice ?? '';
    this.open = true;
    this.render();
  }

  close() {
    this.open = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---------------------------------------------------------------- rendering

  private render() {
    if (!this.open) return;
    this.host.show(this.html(), (a, el) => this.action(a, el), (code) => {
      if (code === 'Escape' && this.mode !== 'menu' && !this.busy) this.go('menu');
    }, false);
    const form = this.host.overlay.querySelector<HTMLFormElement>('form.lg-form');
    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.action('lg-submit', form);
    });
    // the first empty field takes the cursor
    const field = [...this.host.overlay.querySelectorAll<HTMLInputElement>('.lg-form input')].find((i) => !i.value) ?? this.host.overlay.querySelector<HTMLInputElement>('.lg-form input');
    if (field && !this.busy) field.focus({ preventScroll: true });
    else this.host.overlay.querySelector<HTMLElement>('.btn.primary')?.focus({ preventScroll: true });
    // the resend button counts down
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.mode === 'verify' && this.resendAt > Date.now()) {
      this.timer = setInterval(() => {
        const b = document.getElementById('lg-resend') as HTMLButtonElement | null;
        const left = Math.ceil((this.resendAt - Date.now()) / 1000);
        if (!b || left <= 0) {
          if (this.timer) clearInterval(this.timer);
          this.timer = null;
          if (b) {
            b.disabled = this.busy;
            b.textContent = 'SEND THE CODE AGAIN';
          }
          return;
        }
        b.textContent = `SEND AGAIN IN ${left}S`;
      }, 500);
    }
  }

  private html() {
    const dis = this.busy ? 'disabled' : '';
    const title = this.opts.upgrade ? 'SIGN IN WITH AN ACCOUNT' : 'SIGN IN TO DRIVE';
    const lead = this.opts.upgrade
      ? 'A wallet, an iDos Games account or an e-mail keeps a garage on every device you sign in from. A new account starts its own garage; this guest garage stays in this browser.'
      : 'Your garage, your SALVAGE, your MileToken and your records live on your iDos Games account — on every device you sign in from.';
    let body = '';
    switch (this.mode) {
      case 'menu': {
        const site = onPlatformSite();
        body = `<div class="btn-col lg-col">
          <button class="btn primary lg-wallet" data-a="lg-wallet" ${dis}>◎ ${site ? 'SIGN IN WITH YOUR IDOSGAMES.COM WALLET' : 'SIGN IN WITH A SOLANA WALLET'}<small>One free signature. No transaction, no fee.</small></button>
          ${ssoAvailable() ? `<button class="btn" data-a="lg-idos" ${dis}>SIGN IN WITH IDOS GAMES</button>` : ''}
          <button class="btn" data-a="lg-mode" data-v="email" ${dis}>✉ SIGN IN WITH E-MAIL</button>
          ${telegramAvailable() ? `<button class="btn" data-a="lg-telegram" ${dis}>SIGN IN WITH TELEGRAM</button>` : ''}
          <div class="lg-or"><span>OR</span></div>
          <button class="btn" data-a="lg-guest" ${dis}>${this.opts.upgrade ? 'BACK TO THE GUEST GARAGE' : 'PLAY AS GUEST'}<small>The garage stays in this browser.</small></button>
        </div>`;
        break;
      }
      case 'wallets':
        body = this.walletsHtml();
        break;
      case 'email':
        body = `<form class="lg-form" novalidate>
            <label>E-MAIL</label><input type="email" id="lg-email" autocomplete="email" value="${esc(this.email)}" ${dis}>
            <label>PASSWORD</label><input type="password" id="lg-pass" autocomplete="current-password" value="${esc(this.password)}" ${dis}>
            <button class="btn primary" type="submit" ${dis}>SIGN IN ▶</button>
          </form>
          <div class="btn-row lg-links"><button class="btn small" data-a="lg-mode" data-v="register" ${dis}>CREATE AN ACCOUNT</button><button class="btn small" data-a="lg-mode" data-v="forgot" ${dis}>FORGOT THE PASSWORD?</button></div>`;
        break;
      case 'register':
        body = `<form class="lg-form" novalidate>
            <label>E-MAIL</label><input type="email" id="lg-email" autocomplete="email" value="${esc(this.email)}" ${dis}>
            <label>PASSWORD <span class="dim">8–100 CHARACTERS</span></label><input type="password" id="lg-pass" autocomplete="new-password" value="${esc(this.password)}" ${dis}>
            <button class="btn primary" type="submit" ${dis}>CREATE THE ACCOUNT ▶</button>
          </form>
          <div class="dim lg-small">We send a code to the address to confirm it.</div>`;
        break;
      case 'verify':
        body = `<div class="lg-small">A code is on its way to <b>${esc(this.email)}</b>.</div>
          <form class="lg-form" novalidate>
            <label>CODE</label><input type="text" id="lg-code" inputmode="numeric" autocomplete="one-time-code" value="${esc(this.code)}" ${dis}>
            <button class="btn primary" type="submit" ${dis}>CONFIRM ▶</button>
          </form>
          <div class="btn-row lg-links"><button class="btn small" id="lg-resend" data-a="lg-resend" ${this.busy || this.resendAt > Date.now() ? 'disabled' : ''}>SEND THE CODE AGAIN</button></div>`;
        break;
      case 'forgot':
        body = `<form class="lg-form" novalidate>
            <label>E-MAIL</label><input type="email" id="lg-email" autocomplete="email" value="${esc(this.email)}" ${dis}>
            <button class="btn primary" type="submit" ${dis}>SEND A RESET CODE ▶</button>
          </form>`;
        break;
      case 'reset':
        body = `<div class="lg-small">If <b>${esc(this.email)}</b> has an account, the code is already on its way.</div>
          <form class="lg-form" novalidate>
            <label>CODE</label><input type="text" id="lg-code" inputmode="numeric" autocomplete="one-time-code" value="${esc(this.code)}" ${dis}>
            <label>NEW PASSWORD <span class="dim">8–100 CHARACTERS</span></label><input type="password" id="lg-pass" autocomplete="new-password" value="" ${dis}>
            <button class="btn primary" type="submit" ${dis}>SET THE PASSWORD ▶</button>
          </form>`;
        break;
    }
    const back = this.mode !== 'menu' ? `<button class="btn small lg-back" data-a="lg-mode" data-v="${this.mode === 'reset' ? 'forgot' : this.mode === 'register' || this.mode === 'forgot' ? 'email' : 'menu'}" ${dis}>◀ BACK</button>` : '';
    const remember = this.mode !== 'verify' && this.mode !== 'forgot' && this.mode !== 'reset'
      ? `<button class="lg-remember ${this.remember ? 'on' : ''}" data-a="lg-remember" ${dis}><i></i>REMEMBER ME ON THIS DEVICE</button>`
      : '';
    return `<div class="screen modal login"><div class="panel">
      <div class="lg-logo">ZERO <span>MILE</span></div>
      <h2>${title}</h2>
      ${this.mode === 'menu' ? `<p class="dim lg-lead">${lead}</p>` : ''}
      ${back}
      ${body}
      ${remember}
      <p class="lg-error" role="alert">${esc(this.error)}</p>
      <p class="lg-info">${esc(this.info)}</p>
    </div></div>`;
  }

  private walletsHtml() {
    const list = walletOptions();
    const dis = this.busy ? 'disabled' : '';
    if (list.length) {
      return `<div class="lg-small">Choose your wallet. It asks for one signature to prove the address is yours.</div>
        <div class="btn-col lg-col">${list.map((w) => `<button class="btn lg-pick" data-a="lg-pick" data-v="${esc(w.id)}" ${dis}>${icon(w)}${esc(w.name)}</button>`).join('')}</div>`;
    }
    if (isMobileBrowser()) {
      return `<div class="lg-small">Phones keep the wallet in its own app. Open the game inside your wallet's browser and sign in there:</div>
        <div class="btn-col lg-col">${walletAppLinks().map((l) => `<a class="btn" href="${esc(l.href)}" target="_top" rel="noopener">OPEN IN ${esc(l.name.toUpperCase())}</a>`).join('')}</div>`;
    }
    return `<div class="lg-small">No Solana wallet in this browser. Install one, then reload the page:</div>
      <div class="btn-col lg-col">
        <a class="btn" href="https://phantom.com/download" target="_blank" rel="noopener">PHANTOM</a>
        <a class="btn" href="https://solflare.com/download" target="_blank" rel="noopener">SOLFLARE</a>
        <a class="btn" href="https://backpack.app/downloads" target="_blank" rel="noopener">BACKPACK</a>
        <button class="btn small" data-a="lg-reload">RELOAD THE PAGE</button>
      </div>`;
  }

  // ---------------------------------------------------------------- actions

  private go(mode: Mode) {
    this.capture();
    this.mode = mode;
    this.error = '';
    if (mode !== 'email') this.info = '';
    this.render();
  }

  /** what the driver typed survives a re-render */
  private capture() {
    const v = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value;
    this.email = v('lg-email')?.trim() ?? this.email;
    this.password = v('lg-pass') ?? this.password;
    this.code = v('lg-code')?.trim() ?? this.code;
  }

  /** run one sign-in attempt: every button waits, the answer is shown in plain words */
  private async act(fn: () => Promise<AuthResult | 'redirecting'>, waiting = '') {
    this.capture();
    this.busy = true;
    this.error = '';
    this.info = waiting;
    this.render();
    const r = await fn();
    if (!this.open) return;
    if (r === 'redirecting') {
      this.info = 'OPENING IDOSGAMES.COM…';
      this.render();
      return;
    }
    this.busy = false;
    if (r.ok) {
      this.close();
      this.host.signedIn(r.account);
      return;
    }
    this.error = r.error;
    this.info = '';
    this.render();
  }

  private async step(fn: () => Promise<string | null>, next: Mode | null, info = '') {
    this.capture();
    this.busy = true;
    this.error = '';
    this.render();
    const err = await fn();
    if (!this.open) return;
    this.busy = false;
    if (err) this.error = err;
    else if (next) {
      this.mode = next;
      this.info = info;
    }
    this.render();
  }

  private action(a: string, el: HTMLElement) {
    if (this.busy && a !== 'lg-reload') return;
    switch (a) {
      case 'lg-mode':
        this.go(el.dataset.v as Mode);
        break;
      case 'lg-remember':
        this.capture();
        this.remember = !this.remember;
        this.render();
        break;
      case 'lg-reload':
        location.reload();
        break;
      case 'lg-wallet': {
        if (onPlatformSite()) {
          void this.act(() => idos.wallet(null, this.remember), 'CONFIRM THE SIGNATURE IN THE IDOSGAMES.COM WALLET…');
          break;
        }
        const list = walletOptions();
        if (list.length === 1) void this.act(() => idos.wallet(list[0].id, this.remember), `CONFIRM THE SIGNATURE IN ${list[0].name.toUpperCase()}…`);
        else this.go('wallets');
        break;
      }
      case 'lg-pick': {
        const w = walletOptions().find((x) => x.id === el.dataset.v);
        if (w) void this.act(() => idos.wallet(w.id, this.remember), `CONFIRM THE SIGNATURE IN ${w.name.toUpperCase()}…`);
        break;
      }
      case 'lg-idos':
        void this.act(() => idos.idos(this.remember), 'CONNECTING TO IDOS GAMES…');
        break;
      case 'lg-telegram':
        void this.act(() => idos.telegram(this.remember), 'SIGNING IN WITH TELEGRAM…');
        break;
      case 'lg-guest':
        // invited to upgrade: the guest session is still open, so this is simply "not now"
        if (this.opts.upgrade && idos.online) {
          this.close();
          this.host.stayGuest();
        } else void this.act(() => idos.guest(this.remember), 'OPENING THE GARAGE…');
        break;
      case 'lg-resend':
        void this.step(async () => {
          const err = await idos.resend(this.email);
          if (!err) this.resendAt = Date.now() + 60000;
          return err;
        }, null);
        break;
      case 'lg-submit':
        this.submit();
        break;
    }
  }

  private submit() {
    this.capture();
    const email = this.email;
    if (this.mode !== 'verify' && this.mode !== 'reset' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      this.error = explainAuthError('INCORRECT_EMAIL');
      this.render();
      return;
    }
    switch (this.mode) {
      case 'email':
        void this.act(() => idos.email(email, this.password, this.remember), 'SIGNING IN…');
        break;
      case 'register':
        if (this.password.length < 8 || this.password.length > 100) {
          this.error = explainAuthError('PASSWORD_LENGTH_INVALID');
          this.render();
          return;
        }
        void this.step(async () => {
          const r = await idos.register(email, this.password, this.remember);
          if (!r.ok) return r.error;
          this.resendAt = Date.now() + r.resendIn * 1000;
          this.code = '';
          return null;
        }, 'verify');
        break;
      case 'verify':
        if (!this.code) return;
        void this.act(() => idos.confirm(email, this.code, this.remember), 'CONFIRMING…');
        break;
      case 'forgot':
        void this.step(() => idos.forgot(email), 'reset');
        break;
      case 'reset': {
        if (this.password.length < 8 || this.password.length > 100) {
          this.error = explainAuthError('PASSWORD_LENGTH_INVALID');
          this.render();
          return;
        }
        const pass = this.password;
        void this.step(async () => {
          const err = await idos.reset(email, this.code, pass);
          if (!err) this.password = '';
          return err;
        }, 'email', 'Password changed. Sign in with the new one.');
        break;
      }
    }
  }
}

function icon(w: WalletOption) {
  return w.icon && /^data:image\/(svg\+xml|png|webp|jpeg|gif)[;,]/.test(w.icon) ? `<img class="lg-icon" src="${esc(w.icon)}" alt="">` : '<span class="lg-icon">◎</span>';
}

// ---------------------------------------------------------------- around the game

/** the server cannot be reached: nothing to play until it can */
export function connectionScreen(detail: string) {
  return `<div class="screen modal login"><div class="panel">
    <div class="lg-logo">ZERO <span>MILE</span></div>
    <h2>NO CONNECTION</h2>
    <p class="dim lg-lead">ZERO MILE plays on your iDos Games account, and the server cannot be reached right now. Check the connection and try again.</p>
    <div class="btn-col lg-col"><button class="btn primary" data-a="retry">↻ TRY AGAIN</button></div>
    <p class="lg-info dim">${esc(detail)}</p>
  </div></div>`;
}

/** the account chip in the menus: who is driving */
export function accountChip() {
  const a = idos.account;
  if (!a) return '';
  const name = idos.displayName || 'DRIVER';
  return `<button class="acct-chip" data-a="account" title="Account"><i class="k-${a.kind}"></i><span>${esc(name)}</span><small>${kindLabel(a.kind)}</small></button>`;
}

export interface AccountView {
  wallets: { network: string; address: string }[] | null;
  /** several wallets in this browser: the driver picks the one to link */
  picking: WalletOption[] | null;
  note: { text: string; good: boolean } | null;
  busy: boolean;
}

const short = (s: string) => (s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s);

/** the account panel: the name others see, how this account signs in, its wallets, signing out */
export function accountModal(v: AccountView) {
  const a = idos.account!;
  const dis = v.busy ? 'disabled' : '';
  const wallets = v.wallets === null ? '<div class="dim">Reading…</div>' : v.wallets.length ? v.wallets.map((w) => `<div class="row-item"><div class="grow"><div class="name">◎ ${esc(short(w.address))}</div><div class="desc">${esc(w.network.toUpperCase())}</div></div></div>`).join('') : '<div class="dim">No wallet linked.</div>';
  const canLink = a.kind !== 'wallet' && !(v.wallets?.length);
  return `<div class="screen modal login"><div class="panel acct">
    <h2>YOUR ACCOUNT</h2>
    <div class="section-title">DRIVER NAME</div>
    <form class="lg-form acct-name" novalidate><input type="text" id="acct-name" maxlength="20" value="${esc(idos.displayName)}" placeholder="DRIVER" ${dis}><button class="btn small" type="submit" ${dis}>SAVE</button></form>
    <div class="dim lg-small">Shown on the weekly Shift board, in street duels and on the market.</div>
    <div class="section-title">SIGNED IN WITH</div>
    <div class="display">${kindLabel(a.kind)}${a.address ? ` · ◎ ${esc(short(a.address))}` : ''} <span class="dim" style="font-size:0.8em">· ID ${esc(idos.userId.slice(0, 8))}</span></div>
    ${a.kind === 'guest' ? '<div class="lg-small">A guest garage lives in this browser only. Sign in with an account to drive on any device.</div>' : ''}
    <div class="section-title">SOLANA WALLET</div>
    <div class="card-list">${wallets}</div>
    ${canLink ? `<div class="lg-small dim">A linked wallet receives MileToken withdrawals. It does not change how you sign in.</div>${v.picking?.length ? `<div class="btn-col lg-col">${v.picking.map((w) => `<button class="btn lg-pick" data-a="acct-pick" data-v="${esc(w.id)}" ${dis}>${icon(w)}${esc(w.name)}</button>`).join('')}</div>` : `<button class="btn small" data-a="acct-link" ${dis}>◎ LINK A WALLET</button>`}` : ''}
    <p class="lg-error ${v.note?.good ? 'good' : ''}" role="alert">${esc(v.note?.text ?? '')}</p>
    <div class="btn-row">
      <button class="btn primary" data-a="acct-close" ${dis}>BACK</button>
      ${a.kind === 'guest' ? `<button class="btn" data-a="acct-upgrade" ${dis}>SIGN IN WITH AN ACCOUNT</button>` : ''}
      <button class="btn danger" data-a="acct-signout" ${dis}>SIGN OUT</button>
    </div>
  </div></div>`;
}
