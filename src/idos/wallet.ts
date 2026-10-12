import { idos, inFrame, onPlatformSite } from './platform';

/**
 * MileToken lives on Solana; deposits and withdrawals go through the idosgames.com wallet.
 *
 * Inside the idosgames.com frame the game asks the site to open its wallet panel (the platform rule: a game never runs
 * its own wallet flow in a frame, and never tells the player to go elsewhere). Embedded on any other site through the
 * platform's embed, there is no wallet UI at all. Opened directly (the title's own address), the button opens the game's
 * page on idosgames.com, where the wallet is.
 */

/** two frames deep: the platform's embed placed on somebody else's site */
const onForeignSite = () => {
  try {
    return window.parent !== window.top;
  } catch {
    return true;
  }
};

/** whether a wallet button belongs on screen at all */
export function walletAvailable() {
  if (!idos.online) return false;
  if (onForeignSite()) return false;
  return true;
}

let watching = false;

/** keep balances fresh after deposits and withdrawals made in the site's panel */
export async function watchWallet() {
  if (watching || !inFrame() || !idos.online) return;
  watching = true;
  try {
    const w = await import('@idosgames/wallet');
    w.onWalletBalanceChanged(() => void idos.call((c) => c.user.getUserInventory()).then(() => idos.emit()));
  } catch {
    watching = false;
  }
}

const gamePage = () => `https://idosgames.com/go/${idos.titleId.replace(/-DEV$/, '')}/`;

/** open the wallet: the site's panel inside the idosgames.com frame, otherwise the game's page where the wallet is */
export async function openWallet(): Promise<boolean> {
  // anywhere else the page opens at once, still inside the click (a popup opened after an await is blocked)
  if (onPlatformSite()) {
    try {
      const w = await import('@idosgames/wallet');
      void watchWallet();
      if (await w.openPlatformWalletPanel()) return true;
    } catch {
      /* the site did not answer: fall through to the game page */
    }
  }
  return !!window.open(gamePage(), '_blank', 'noopener');
}
