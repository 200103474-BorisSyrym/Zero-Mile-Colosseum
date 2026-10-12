# ZERO MILE on iDos Games

Since v1.2, ZERO MILE is an iDos Games game from the first screen to the last. There is no separate offline version.

- **Sign-in.** A driver plays signed in to an iDos Games account.
- **Progression.** Everything the driver owns and has achieved lives on that account: the garage, SALVAGE, MileToken,
  the records and the archive.
- **No connection.** If the server cannot be reached, the game shows a connection screen with a retry.

The runs themselves are unchanged: the driving, the parts, the bosses, the balance and the physics are the same game.

- **Title.** Live is `GJF4GVXP`; the DEV sandbox is `GJF4GVXP-DEV`.
- **SDK.** `@idosgames/core` 0.21.2 and `@idosgames/wallet` 0.6.2. Solana wallets are found through the Wallet Standard
  (`@wallet-standard/app`).
- **Boot.** The SDK loads while the shaders compile. The boot screen stays up until the session is resolved, then shows
  the menu, the sign-in screen, or the connection screen.

## Signing in

[src/ui/login.ts](../src/ui/login.ts) is the screen; [src/idos/platform.ts](../src/idos/platform.ts) does the work.

| Method | How it works |
| --- | --- |
| **Solana wallet** (first) | The server's challenge is signed in the wallet: one free signature, no transaction. Outside idosgames.com, the game connects the wallet the driver picks (Wallet Standard or injected Phantom/Solflare) and calls `requestWalletChallenge` → `signMessage` → `loginWithWallet`. Inside the idosgames.com frame, the site's wallet signs (`loginWithWalletViaPlatform`). On a phone with no wallet extension, the screen offers to reopen the game inside the Phantom or Solflare app. |
| **iDos Games account** | `beginSsoRedirect` to idosgames.com and back with a one-time code (`loginWithSsoCode`). A live platform session comes back silently. Shown only on hosts the platform redirects back to (the title's `*.idos.games` address and idosgames.com). |
| **E-mail** | Sign in; create an account (`registerWithEmail` → code → `confirmEmailRegistration`, with resend); forgot / reset password. The reset never reveals whether an address has an account. |
| **Telegram** | Only inside a Telegram Mini App. |
| **Guest** | `loginWithDeviceID`. The garage stays in this browser. Once a day, on the menu, a guest is invited to sign in with a real account. |

- **"Remember me."** The setting applies to every method; `setRememberSession` is called before each login.
- **Boot.** `resume()` first uses the code idosgames.com handed over. Otherwise it restores the remembered session,
  retrying only on connection failures. It never creates a guest by itself.
  - "The server is unreachable" leads to the connection screen.
  - "Sign in again" leads to the sign-in screen.
- **The account panel** is the chip at the top of the menu and garage, and also under SETTINGS. It shows:
  - the driver's name (`changeUsername`), shown on the boards, in duels and on the market
  - how the account signs in
  - the linked Solana wallet (`linkWallet`), which receives MileToken withdrawals
  - SIGN OUT
- **Session loss.** If the session ends under the game, the sign-in screen comes back, but never in the middle of a
  run. A run that could not be recorded is kept and sent again after the next sign-in.

## Where progression lives

| What | Where on the account |
| --- | --- |
| SALVAGE | virtual currency `SV` (150 for a new account) |
| Cars, upgrade levels, paints | stackable items in the `garage` catalog: `car_<id>`, `up_<unlock>` (count = level), `paint_<id>` |
| Records: best run, runs, wins, the deepest night unlocked, the archive, tutorial done | ReadOnly user data `profile`, written only by Cloud Code |
| Achievements | permanent quests `ach_<id>`, completed on the road, claimed for SALVAGE in the ARCHIVE |
| Garage choices: car, E module, paint per car, difficulty | Private user data `prefs` |
| MileToken | crypto `Main` (on DEV, the virtual `MT` stands in) |
| Duel cars, wraps, supplies, Shift, hunt, contracts | see "The street" below |

Only the device's own settings stay in the browser (`zeromile.settings`): volume, graphics, controls.

**A browser save from v1.0/v1.1** (`zeromile.save`) is brought onto the account once. The `importLegacy` handler only
accepts it for an account that has not driven yet. It carries over:

- owned cars, upgrades and paints
- the records and the archive
- SALVAGE, up to 2,500

Old achievements are reported as completed quests. The browser copy is then kept aside as `zeromile.save.imported`.

## Cloud Code: the authority

[idos/cloudcode.template.js](../idos/cloudcode.template.js) is the script. `npm run idos:config` fills in its tables
from the game's own data and writes [idos/cloudcode.js](../idos/cloudcode.js).

| Handler | What it does |
| --- | --- |
| `startRun` | Opens a run and returns a ticket. A night the driver has not unlocked is refused. |
| `finishRun` | Closes the ticket and checks the numbers. It pays SALVAGE and keeps the records. A win also pays out its unlocks: the next night, the LEGENDARY CACHE and NIGHT GOLD. |
| `insureRun` | Wreck insurance pays the wrecked run's SALVAGE again. It needs a policy (the `use_insurance` boost) taken out after the run closed. One policy covers one run, and the claim window is 10 minutes. |
| `garageBuy` | Buys a car, an upgrade level or a paint for SALVAGE in one atomic charge and grant. Refusal codes: `owned`, `funds`, `unknown`. |
| `importLegacy` | Imports the browser save, once per fresh account. |
| `huntHit`, `huntKey` | THE DRIVER hunt: the city-wide weekly boss-damage counter. |

`finishRun` checks each run report:

- The run's clock can't be ahead of the real one.
- Distance is bounded by time × 80 m/s.
- Kills are bounded by distance.
- Bosses can't exceed regions reached.
- A win needs region 5 and five bosses.
- Event salvage is capped at 60, and a run at 1,500.
- A ticket pays once.

The pay formula is the game's own: distance/130 + kills × 1.5 + bosses × 40 + region × 20 (+150 for a win), × the
night's multiplier.

The resource policy allows the script to grant and consume virtual currency and items. It caps SALVAGE grants at
20,000 per player per day. Per-handler rate limits apply on top (`CloudCodePolicy.json`).

> **Platform gotcha.** `server.ApplyResourceOperation` treats a repeated `Reason` as a replay and skips it while still
> answering `Success`. Every operation therefore gets a unique reason: the run ticket, the insurance's run, or
> `once(prefix)` for purchases.

## The street

The street is the game's shared side, and it is on the first screen.

- **Main menu.**
  - Under START RUN sit three marked buttons:
    - **STREET DUELS · PvP** (magenta), with a badge for open challenges
    - **THE WEEKLY SHIFT · RANKED** (gold), with the driver's rank
    - **THE DEPOT · MILETOKEN** (violet)
  - A live panel, **THE STREET TONIGHT**, shows:
    - the SALVAGE and MileToken balances
    - **WALLET · DEPOSIT / WITHDRAW**
    - the open challenges
    - the Shift's top three
    - the daily contracts, with a claim button when any are ready
    - THE DRIVER hunt's city count
  - On a phone, the panel gives way to the buttons, and the balances sit under them.
- **First visit.** One time per account, the street's introduction explains duels, the Shift, MileToken and
  contracts, and leads to the duels.
- **Garage tabs.** DUELS · PvP and DEPOT come right after PLAY, marked in the street's colour, with badges for open
  challenges and contracts ready to claim.
  - The DUELS tab starts with three steps: tune, plan, take or post.
  - With no open challenges, it offers to post the first one.
  - On PLAY, the weekly Shift and the contracts head the right panel.
- **After every run.** **DUEL A REAL DRIVER** sits next to NEW RUN.

| In the game | Platform module | Ids |
| --- | --- | --- |
| **Street duels**: asynchronous PvP fought in the garage pit | Match, instant battle | rules `street_tq` (10–250 SV or 1–5 supplies), `street_mt` (500–5000 SV, 1 MileToken posting fee) |
| **The duel garage**: every car has a server twin with six stats tuned with SALVAGE | Character | `Main` (courier), `rammer`, `ghost`, `hauler`; stats `Hull` `Ram` `Plate` `Grip` `Nitro` `Launch` |
| **Liveries**: wraps that show in runs, in the pit and on other players' screens | Item (non-stackable) + Character skins | catalog `livery`, 12 wraps `liv_*` |
| **The depot**: the MileToken shop | Store | store `depot`; sections supplies, cars, salvage packs, liveries, scrapyard (SALVAGE) |
| **The livery crate** | Lootbox | `livery_crate`; pity: EPIC or better every 12 |
| **Supplies spent during a run** | TimedBoost (priced in the item, or in MileToken on the spot) | `use_tow`, `use_toll`, `use_voucher`, `use_insurance` |
| **The weekly Shift**: one seed for every player, ranked | Leaderboard | `weekly_shift` (BestScore, weekly, ranks 1–100 paid) |
| **THE DRIVER hunt**: the whole city's boss damage | Cloud Code + title data + Leaderboard | `huntHit` → `hunt_w<week>`; board `driver_hunt` |
| **Daily contracts** | Quest | cycle `contracts`; full-board bonus is a crate key |
| **Street market**: players trade with each other | Marketplace | wraps and supplies for SV, 5% commission burned |
| **Wallet** | `@idosgames/wallet` | the site panel inside idosgames.com, the game's page elsewhere |

### Inside a run

- **Tow truck.** After a wreck: back on the road with a full hull, once per run. It costs one from stock or 3
  MileToken.
- **Toll express.** One toll pass (or 2 MileToken) skips the next row of the map and repairs 20%.
- **Under the counter.** At the night market, one voucher (or 3 MileToken) shows three EPIC parts; take one free.
- **Wreck insurance.** On a wreck's results screen, the run's SALVAGE is paid again (from stock, or 2 MileToken).
- **The weekly Shift** allows no supplies.
- **The street-race rival** is a real driver from this week's Shift board.

### Where MileToken goes

- **What it is spent on.** Depot offers, the crate, supplies bought on the spot, and the high-stakes posting fee.
- **Where it goes.** All of it goes to the developer share.
- **What the game never does.** It never grants MileToken: the token's `ServerGrantPolicy` stays disabled.
- **Withdrawal fees.** They are set per currency in `Currency.CryptoCurrencies.Main` and are 0 now.

## What the server decides, and what it trusts

| Server-authoritative | Client-reported (bounded) |
| --- | --- |
| Every SALVAGE and MileToken charge and grant; owned cars, upgrades and paints; run payouts and records (checked by `finishRun`); insurance; duel outcomes; tuning; crate rolls; market settlement | Achievement completion (one report each, `MaxProgressPerCall` 1); contract progress (bounded per call; exceeding it bans the account); Shift scores; hunt damage (capped at 9,000 per report, one report per 40 s) |

## Changing the economy

1. Edit the numbers in the game data ([src/data](../src/data)) or in [src/idos/catalog.ts](../src/idos/catalog.ts).
2. Run `npm run idos:config`. It writes `idos/config/{dev,live}/*.json`, one file per config section, and regenerates
   `idos/cloudcode.js`.
3. Upload the changes with the iDos MCP tools, DEV title first:
   - `save_<section>`. A save replaces the whole section.
   - `publish_cloud_code` for the script.
   - `save_cloud_code` for `CloudCodePolicy.json` (the resource policy and rate limits). It replaces the whole CloudCode
     section, active revision included; a later publish keeps the policy.
4. Run `npm run idos:verify` to check DEV for real. Fresh guest drivers run the whole loop on the server:
   - the duel garage, the depot, supplies, a crate and a wrap
   - a duel, the Shift, contracts and the hunt
   - runs opened and closed, a replayed and a too-fast run refused
   - garage purchases, insurance and achievements
   - the browser-save import
   - a market sale

   Last run: 58/58.

## Modes

- `npm run dev` and the test address of a staged build (`gjf4gvxp-dev.idos.games`) play against the DEV title.
- A production build plays against the live title.
- `?idos=live` and `?idos=dev` override this.

## Not built yet (next steps)

- **Moving a guest garage onto a real account.** Wallet sign-in creates its own account, and a wallet linked to a guest
  does not sign in to it.
- **Solana NFT withdrawal of liveries.** The platform config supports it; `@idosgames/wallet` 0.6.2 has no Solana NFT
  helper.
- **Player-made liveries**, **realtime races**, and **a season pass priced in MileToken**.
