import { getWallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';

/**
 * Solana wallets for signing in: everything that registers through the Wallet Standard (Phantom, Solflare, Backpack…),
 * plus the legacy injected providers. A sign-in is a signature over the server's challenge: no transaction, no fee, and
 * no key ever leaves the wallet.
 */

export interface WalletOption {
  id: string;
  name: string;
  icon: string | null;
}

export interface WalletSigner {
  address: string;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
}

type ConnectFeature = { connect(input?: { silent?: boolean }): Promise<{ accounts: readonly WalletAccount[] }> };
type SignMessageFeature = { signMessage(...inputs: { account: WalletAccount; message: Uint8Array }[]): Promise<{ signature: Uint8Array }[]> };

interface InjectedProvider {
  publicKey?: { toString(): string } | null;
  connect(): Promise<{ publicKey?: { toString(): string } } | void>;
  signMessage(msg: Uint8Array, display?: string): Promise<{ signature: Uint8Array } | Uint8Array>;
}

let standard: Wallet[] = [];
const listeners = new Set<() => void>();
let started = false;

function start() {
  if (started) return;
  started = true;
  try {
    const api = getWallets();
    const refresh = () => {
      standard = api.get().filter((w) => w.chains.some((c) => c.startsWith('solana:')) && 'standard:connect' in w.features && 'solana:signMessage' in w.features);
      for (const f of listeners) f();
    };
    refresh();
    api.on('register', refresh);
    api.on('unregister', refresh);
  } catch {
    /* no Wallet Standard in this browser: the injected providers below still work */
  }
}

function injected(): [string, InjectedProvider][] {
  const w = window as unknown as { phantom?: { solana?: InjectedProvider }; solflare?: InjectedProvider; solana?: InjectedProvider };
  const out: [string, InjectedProvider][] = [];
  if (w.phantom?.solana) out.push(['Phantom', w.phantom.solana]);
  if (w.solflare) out.push(['Solflare', w.solflare]);
  if (w.solana && w.solana !== w.phantom?.solana && w.solana !== w.solflare) out.push(['Solana wallet', w.solana]);
  return out;
}

/** wallets this browser has, de-duplicated by name */
export function walletOptions(): WalletOption[] {
  start();
  const list: WalletOption[] = standard.map((w) => ({ id: `std:${w.name}`, name: w.name, icon: w.icon ?? null }));
  const names = new Set(list.map((o) => o.name.toLowerCase()));
  for (const [name] of injected()) if (!names.has(name.toLowerCase())) list.push({ id: `inj:${name}`, name, icon: null });
  return list;
}

export function onWalletsChanged(f: () => void) {
  start();
  listeners.add(f);
  return () => listeners.delete(f);
}

/** connect the chosen wallet and hand back an address and a message signer */
export async function connectWallet(id: string): Promise<WalletSigner> {
  start();
  if (id.startsWith('std:')) {
    const w = standard.find((x) => `std:${x.name}` === id);
    if (w) {
      const features = w.features as Record<string, unknown>;
      const { accounts } = await (features['standard:connect'] as ConnectFeature).connect();
      const account = accounts.find((a) => a.chains.some((c) => c.startsWith('solana:'))) ?? accounts[0];
      if (!account) throw new Error('The wallet returned no account');
      return {
        address: account.address,
        async signMessage(message) {
          const [out] = await (features['solana:signMessage'] as SignMessageFeature).signMessage({ account, message });
          return out.signature;
        },
      };
    }
  }
  if (id.startsWith('inj:')) {
    const p = injected().find(([n]) => `inj:${n}` === id);
    if (p) {
      const provider = p[1];
      const res = await provider.connect();
      const key = (res && 'publicKey' in res ? res.publicKey : null) ?? provider.publicKey;
      if (!key) throw new Error('The wallet returned no address');
      return {
        address: key.toString(),
        async signMessage(message) {
          const r = await provider.signMessage(message, 'utf8');
          return r instanceof Uint8Array ? r : r.signature;
        },
      };
    }
  }
  throw new Error('Wallet not found: reload the page after installing it');
}

/** phones have no wallet extension: these reopen the game inside the wallet app's own browser */
export function walletAppLinks(): { name: string; href: string }[] {
  const url = encodeURIComponent(location.href.split('#')[0]);
  const ref = encodeURIComponent(location.origin);
  return [
    { name: 'Phantom', href: `https://phantom.app/ul/browse/${url}?ref=${ref}` },
    { name: 'Solflare', href: `https://solflare.com/ul/v1/browse/${url}?ref=${ref}` },
  ];
}

export const isMobileBrowser = () => typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

export const toHex = (bytes: Uint8Array) => '0x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
