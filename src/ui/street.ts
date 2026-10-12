import { CONTRACT_BONUS, DUEL_RULES, DUEL_STATS, HUNT, LIVERIES, LIVERY_COLOR, SUPPLIES, UPGRADE_PRICE, type LiveryDef } from '../idos/catalog';
import * as D from '../idos/duels';
import * as E from '../idos/economy';
import * as G from '../idos/garage';
import { idos } from '../idos/platform';
import { SALVAGE } from '../idos/title';
import { VEHICLES, getVehicle } from '../data/vehicles';
import type { Online } from '../game/online';
import type { DuelBlow, DuelScript } from '../world/duelStage';
import { esc } from './screens';

/**
 * The garage's online panels: the balance chip, the weekly Shift and the contracts on PLAY, the STREET tab (duel garage,
 * challenges, ram plan) and the DEPOT tab (MileToken shop, livery crate, wraps, street market). Plain HTML like the rest
 * of the UI; every button is a data-a="o-…" action handled by game/online.ts.
 */

const hex = (n: number) => '#' + n.toString(16).padStart(6, '0');
const n = (v: number) => Math.round(v).toLocaleString('en-US');
const svx = (v: number) => `${n(v)} SV`;
const left = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}D ${h}H` : h ? `${h}H ${m}M` : `${m}M`;
};

function busy(o: Online, key: string) {
  return o.busy.has(key) ? 'disabled' : '';
}

function note(o: Online) {
  return o.note ? `<div class="o-note ${o.note.good ? 'good' : ''}">${esc(o.note.text)}</div>` : '';
}

const swatch = (l: LiveryDef | undefined, size = 1.2) => (l ? `<i class="o-wrap" style="--c:${hex(l.color)};--a:${hex(l.accent)};width:${size}em;height:${size}em"></i>` : '');

/** the balance chip in the garage's top bar */
export function onlineChip(o: Online) {
  if (!idos.online) return '';
  return `<div class="o-chip">
    <div class="o-bal"><b>${n(idos.salvage)}</b><small>SALVAGE</small></div>
    <div class="o-bal token"><b>${n(idos.tokens)}</b><small>MILETOKEN</small></div>
    ${o.walletButton ? `<button class="btn small" data-a="o-wallet" data-tutorial-anchor="lobby:wallet">WALLET</button>` : ''}
  </div>`;
}

// ---------------------------------------------------------------- the hub: what the street has going on, on the main menu

/** the main menu's three street buttons: PvP, the ranked week, the MileToken shop */
export function hubButtons(o: Online) {
  const open = o.challenges?.length ?? 0;
  const ends = o.shift?.endsAt ?? E.weekEndsAt();
  const rank = o.shift?.myRank;
  return `<div class="hub-buttons">
    <button class="btn hub-btn duel" data-a="duels"><span class="hub-ic">⚔</span><span class="hub-t">STREET DUELS <em>PVP</em></span><small>Real drivers, real stakes: SALVAGE or MileToken. Winner takes the pot.</small>${open ? `<b class="hub-badge">${open} OPEN</b>` : ''}</button>
    <button class="btn hub-btn shift" data-a="shift"><span class="hub-ic">★</span><span class="hub-t">THE WEEKLY SHIFT <em>RANKED</em></span><small>One city for every driver this week · ends in ${left(ends - Date.now())}. Top 100 are paid.</small>${rank ? `<b class="hub-badge">#${rank}</b>` : ''}</button>
    <button class="btn hub-btn token" data-a="depot"><span class="hub-ic">◎</span><span class="hub-t">THE DEPOT <em>MILETOKEN</em></span><small>Spend the game's Solana token: cars, supplies, wraps, crates.</small></button>
  </div>`;
}

/** the main menu's right panel: balances and the wallet, open challenges, the Shift, contracts, the hunt */
export function hubPanel(o: Online) {
  if (!o.online) return '';
  const ready = (o.contracts ?? []).filter((c) => c.status === 'Completed').length;
  const done = (o.contracts ?? []).filter((c) => c.status !== 'Active').length;
  const total = o.contracts?.length ?? 6;
  const open = o.challenges ?? null;
  const top = (o.shift?.rows ?? []).slice(0, 3);
  const pct = Math.min(1, o.huntTotal / HUNT.goal);
  const challengeRows = open === null
    ? '<div class="dim">Looking for drivers…</div>'
    : open.length
      ? open.slice(0, 3).map((c) => `<button class="hub-row" data-a="duels"><span>${esc(D.driverTag(c.match.CreatorID))} <i>${esc(getVehicle(c.vehicle).name)}</i></span><b>${esc(D.stakeLabel(c.stake))}</b></button>`).join('')
      : '<div class="dim hub-small">No open challenges right now. Post the first one: whoever takes it fights your ram plan.</div>';
  return `<div class="hub-head">THE STREET TONIGHT</div>
    <div class="hub-bal">
      <div><b>${n(idos.salvage)}</b><small>SALVAGE</small></div>
      <div class="token"><b>${n(idos.tokens)}</b><small>MILETOKEN</small></div>
    </div>
    ${o.walletButton ? `<button class="btn small o-token hub-wallet" data-a="wallet">◎ WALLET · DEPOSIT / WITHDRAW</button>` : ''}
    <div class="hub-sec"><span>⚔ OPEN CHALLENGES</span>${open?.length ? `<b>${open.length}</b>` : ''}</div>
    ${challengeRows}
    <button class="btn small hub-go" data-a="duels">${open?.length ? 'TAKE ONE' : 'POST A CHALLENGE'} ▶</button>
    <div class="hub-sec"><span>★ WEEKLY SHIFT</span>${o.shift?.myRank ? `<b>#${o.shift.myRank}</b>` : ''}</div>
    ${top.length ? `<div class="o-board">${top.map((r) => `<div class="${r.me ? 'me' : ''}"><span>#${r.rank}</span><span>${esc(r.name)}</span><b>${n(r.score)}</b></div>`).join('')}</div>` : '<div class="dim hub-small">Nobody has run the Shift this week yet. The board is yours to take.</div>'}
    <div class="hub-sec"><span>✓ DAILY CONTRACTS</span><b>${done}/${total}</b></div>
    ${ready ? `<button class="btn small primary hub-go" data-a="contracts">${ready} READY · CLAIM SALVAGE ▶</button>` : '<div class="dim hub-small">Six jobs a day, paid in SALVAGE. Every run counts toward them.</div>'}
    <div class="hub-sec"><span>☠ THE DRIVER HUNT</span><b>${n(o.huntTotal)}</b></div>
    <div class="o-bar big"><i style="width:${(pct * 100).toFixed(1)}%"></i></div>
    <div class="dim hub-small">Every boss any driver beats this week chips at the city's count.</div>`;
}

/** once per account: what the street is and where it lives */
export function streetIntro() {
  const card = (ic: string, t: string, d: string, cls = '') => `<div class="intro-card ${cls}"><div class="hub-ic">${ic}</div><div><b>${t}</b><p>${d}</p></div></div>`;
  return `<div class="screen modal"><div class="panel intro">
    <h2>THIS IS THE STREET</h2>
    <p class="dim">The runs are yours alone. Around them, every driver on iDos Games shares one city.</p>
    <div class="intro-grid">
      ${card('⚔', 'STREET DUELS · PvP', 'Your car has a server twin. Tune it with SALVAGE, set a ram plan, and take a real driver\'s challenge or post your own. The server fights it out; the winner takes both stakes.', 'duel')}
      ${card('★', 'THE WEEKLY SHIFT', 'The same city for every driver, once a week. Your best score ranks on the board; the top 100 are paid in SALVAGE and crate keys.', 'shift')}
      ${card('◎', 'MILETOKEN', 'The game\'s Solana token. Spend it in the depot on cars, supplies and wraps, or on the road to call a tow truck. Deposit and withdraw it with your wallet.', 'token')}
      ${card('✓', 'CONTRACTS & THE HUNT', 'Six daily jobs paid in SALVAGE, and a city-wide boss count every driver adds to. Every run you drive counts.')}
    </div>
    <div class="btn-row"><button class="btn primary" data-a="duels">⚔ TO THE STREET DUELS</button><button class="btn" data-a="close">LATER</button></div>
  </div></div>`;
}

// ---------------------------------------------------------------- PLAY tab: the weekly Shift, contracts, the hunt

export function playExtras(o: Online): { left: string; right: string } {
  if (!o.online) return { left: '', right: '' };
  const sh = o.shift;
  const ends = sh?.endsAt ?? E.weekEndsAt();
  const top = (sh?.rows ?? []).slice(0, 5);
  const shiftHtml = `<h3>★ THE WEEKLY SHIFT <span class="dim" style="font-size:0.6em">RANKED</span></h3>
    <div class="row-item o-shift">
      <div class="grow">
        <div class="name">SAME CITY FOR EVERY DRIVER <span class="dim">· ENDS IN ${left(ends - Date.now())}</span></div>
        <div class="desc">Night One rules, no supplies. Your best score of the week ranks on the board; the top 100 are paid in SALVAGE and crate keys.${sh ? `<br>Your best: <b>${n(sh.myScore)}</b>${sh.myRank ? ` · rank <b>#${sh.myRank}</b> of ${n(sh.total)}` : ''}` : ''}</div>
        ${top.length ? `<div class="o-board">${top.map((r) => `<div class="${r.me ? 'me' : ''}"><span>#${r.rank}</span><span>${esc(r.name)}</span><b>${n(r.score)}</b></div>`).join('')}</div>` : ''}
      </div>
    </div>
    <button class="btn primary" data-a="o-shift">▶ RUN THE SHIFT</button>`;
  return { left: shiftHtml, right: contractsHtml(o) + huntHtml(o) };
}

function contractsHtml(o: Online) {
  const cs = o.contracts;
  if (!cs) return `<h3 style="margin-top:1em">DAILY CONTRACTS</h3><div class="dim">Loading the board…</div>`;
  const pts = E.boardPoints();
  const ends = E.contractsEndAt();
  return `${note(o)}<h3 style="margin-top:1em">DAILY CONTRACTS ${ends ? `<span class="dim" style="font-size:0.6em">RESET IN ${left(ends - Date.now())}</span>` : ''}</h3>
    <div class="card-list">${cs.map((c) => `<div class="row-item ${c.status === 'Claimed' ? 'owned' : ''}">
      <div class="grow"><div class="name">${esc(c.name)} <span class="dim" style="font-size:0.8em">${svx(c.salvage)}</span></div>
      <div class="desc">${esc(c.desc)}</div>
      <div class="o-bar"><i style="width:${Math.round((c.progress / c.target) * 100)}%"></i></div></div>
      ${c.status === 'Completed' ? `<button class="btn small primary" data-a="o-claim" data-v="${c.id}" ${busy(o, `claim-${c.id}`)}>CLAIM</button>` : c.status === 'Claimed' ? '<span class="display" style="color:var(--good)">PAID</span>' : `<span class="dim display">${n(c.progress)}/${n(c.target)}</span>`}
    </div>`).join('')}</div>
    <div class="row-item"><div class="grow"><div class="name">FULL BOARD</div><div class="desc">${Math.min(pts, CONTRACT_BONUS.points)}/${CONTRACT_BONUS.points} points · a crate key</div><div class="o-bar"><i style="width:${Math.min(100, (pts / CONTRACT_BONUS.points) * 100)}%"></i></div></div>
      ${pts >= CONTRACT_BONUS.points ? `<button class="btn small" data-a="o-bonus" ${busy(o, 'bonus')}>CLAIM</button>` : ''}</div>`;
}

function huntHtml(o: Online) {
  const pct = Math.min(1, o.huntTotal / HUNT.goal);
  const mine = o.hunt?.myScore ?? 0;
  return `<h3 style="margin-top:1em">THE DRIVER HUNT</h3>
    <div class="dim" style="font-size:0.85em">Every boss any driver takes down this week chips at the city's count. Your share pays out at ${HUNT.milestones.map((m) => n(m.at)).join(' · ')}.</div>
    <div class="o-bar big"><i style="width:${(pct * 100).toFixed(1)}%"></i></div>
    <div class="display" style="display:flex;justify-content:space-between"><span>${n(o.huntTotal)} / ${n(HUNT.goal)}</span><span class="dim">YOURS ${n(mine)}</span></div>`;
}

// ---------------------------------------------------------------- STREET tab

export function streetTab(o: Online, unlocked: string[]): { left: string; right: string } {
  if (!o.online) return waitingPanels();
  const car = o.duelCar;
  const m = G.model(car);
  const worn = G.wornLiveryOf(m);
  const cars = VEHICLES.filter((v) => unlocked.includes(v.id));
  const left = `<h2>⚔ YOUR DUEL CAR</h2>
    <div class="dim" style="font-size:0.9em">Street duels are fought by your car's server twin: six stats you tune with SALVAGE, and a ram plan. The server decides every blow; the pit shows it.</div>
    <div class="section-title">DUEL CAR</div>
    <div class="btn-row" style="margin-top:0">${cars.map((v) => `<button class="btn small ${v.id === car ? 'selected' : ''}" data-a="o-duelcar" data-v="${v.id}">${v.name}</button>`).join('')}</div>
    <div class="display" style="margin:0.3em 0">POWER <b style="color:var(--gold)">${n(G.power(car))}</b> ${worn ? `· ${swatch(worn)} ${esc(worn.name)}` : ''}</div>
    <div class="card-list">${DUEL_STATS.map((s) => {
      const lv = G.statLevel(car, s.id, m);
      const max = lv >= UPGRADE_PRICE.maxLevel;
      const cost = G.upgradeCost(lv + 1);
      return `<div class="row-item o-stat"><div class="grow"><div class="name">${s.label} <span class="dim">${G.statText(s.id, G.statValue(car, s.id, lv))}${max ? '' : ` → ${G.statText(s.id, G.statValue(car, s.id, lv + 1))}`}</span></div>
        <div class="o-lv">${Array.from({ length: UPGRADE_PRICE.maxLevel }, (_, i) => `<i class="${i < lv ? 'on' : ''}"></i>`).join('')}</div><div class="desc">${esc(s.desc)}</div></div>
        ${max ? '<span class="display" style="color:var(--good)">MAX</span>' : `<button class="btn small" data-a="o-tune" data-v="${s.id}" ${idos.salvage < cost || o.busy.has(`tune-${s.id}`) ? 'disabled' : ''}>${svx(cost)}</button>`}</div>`;
    }).join('')}</div>
    <div class="section-title">WRAP</div>
    ${wrapPicker(o, car)}`;
  const tabs = `<div class="btn-row" style="margin-top:0">${(['open', 'post', 'mine'] as const).map((t) => `<button class="btn small ${o.street === t ? 'selected' : ''}" data-a="o-street" data-v="${t}">${{ open: 'CHALLENGES', post: 'POST', mine: 'MINE' }[t]}</button>`).join('')}</div>`;
  let body = '';
  if (o.street === 'open') body = openList(o);
  else if (o.street === 'post') body = postForm(o);
  else body = mineList(o);
  const guide = `<div class="street-guide"><span><b>1</b> TUNE your car on the left</span><span><b>2</b> SET a ram plan under POST</span><span><b>3</b> TAKE a challenge, or POST your own stake</span></div>`;
  return { left, right: `<h3>⚔ STREET DUELS <span class="dim" style="font-size:0.6em">PVP · REAL DRIVERS</span></h3>${guide}${tabs}${note(o)}${body}` };
}

function wrapPicker(o: Online, car: string) {
  const wraps = G.ownedWraps();
  const worn = G.wornLiveryOf(G.model(car));
  if (!wraps.length) return `<div class="dim" style="font-size:0.85em">No wraps yet. The depot sells them, the livery crate drops them, the Shift pays them out.</div>`;
  return `<div class="o-wraps">
    <button class="o-wrapbtn ${!worn ? 'sel' : ''}" data-a="o-wear" data-v="stock" ${busy(o, 'wear')} title="Stock paint"><span>STOCK</span></button>
    ${wraps.map((w) => `<button class="o-wrapbtn ${w.on === car ? 'sel' : ''}" data-a="o-wear" data-v="${w.instance}" ${busy(o, 'wear')} title="${esc(w.def.name)}${w.on && w.on !== car ? ` (on the ${getVehicle(w.on).name})` : ''}" style="--rc:${LIVERY_COLOR[w.def.rarity]}">${swatch(w.def, 1.6)}<span>${esc(w.def.name)}</span>${w.on && w.on !== car ? `<em>${getVehicle(w.on).name}</em>` : ''}</button>`).join('')}
  </div>`;
}

function openList(o: Online) {
  const list = o.challenges;
  if (!list) return '<div class="dim">Looking for drivers…</div>';
  if (!list.length) return `<div class="dim" style="margin-top:0.6em">No open challenges right now. Be the first: post a stake, and whoever takes it fights your ram plan. Your car's twin defends it while you drive.</div>
    <button class="btn primary" style="margin-top:0.8em" data-a="o-street" data-v="post">⚔ POST THE FIRST CHALLENGE ▶</button>`;
  return `<div class="card-list" style="margin-top:0.6em">${list.map((c) => {
    const v = getVehicle(c.vehicle);
    const canPay = c.stake ? (c.stake.ref.Type === 'Item' ? idos.itemCount(c.stake.ref.ItemID) >= c.stake.amount : idos.balance(c.stake.ref) >= c.stake.amount) : true;
    return `<div class="row-item"><div class="grow"><div class="name">${D.driverTag(c.match.CreatorID)} <span class="dim">· ${v.name}</span></div>
      <div class="desc">Stake <b>${esc(D.stakeLabel(c.stake))}</b> each · winner takes both minus 5%${c.match.ExpiresAt ? ` · ${left(Date.parse(c.match.ExpiresAt) - Date.now())} left` : ''}</div></div>
      <button class="btn small primary" data-a="o-take" data-v="${c.match.MatchID}" ${!canPay || o.busy.has(`take-${c.match.MatchID}`) ? 'disabled' : ''}>TAKE IT</button></div>`;
  }).join('')}</div>`;
}

const ZONE_LABEL = { front: 'FRONT', side: 'SIDE', rear: 'REAR' } as const;

function postForm(o: Online) {
  const st = o.stake;
  const chip = (val: string, label: string, sel: boolean, ok: boolean, w = '') => `<button class="btn small ${sel ? 'selected' : ''}" data-a="o-stake" data-v="${val}" ${w ? `data-w="${w}"` : ''} ${ok ? '' : 'disabled'}>${label}</button>`;
  const isTq = (a: number) => st.ref.Type !== 'Item' && st.amount === a;
  const supplyStakes = SUPPLIES.filter((s) => s.id !== 'crate_key' && idos.itemCount(s.id) > 0);
  const high = st.ref.Type !== 'Item' && st.amount >= DUEL_RULES.high.min;
  return `<div class="section-title">STAKE</div>
    <div class="btn-row" style="margin-top:0">${D.SALVAGE_STAKES.map((a) => chip(String(a), svx(a), isTq(a), idos.salvage >= a)).join('')}</div>
    <div class="btn-row" style="margin-top:0.3em">${D.HIGH_STAKES.map((a) => chip(String(a), `${svx(a)} ★`, isTq(a), idos.salvage >= a && idos.tokens >= DUEL_RULES.high.feeToken)).join('')}</div>
    ${supplyStakes.length ? `<div class="btn-row" style="margin-top:0.3em">${supplyStakes.map((s) => chip(`item:${s.id}`, `1 ${s.name}`, st.ref.Type === 'Item' && st.ref.ItemID === s.id, true, '1')).join('')}</div>` : ''}
    <div class="dim" style="font-size:0.8em;margin-top:0.3em">★ High stakes: posting costs ${DUEL_RULES.high.feeToken} MILETOKEN (returned if you withdraw). Every SALVAGE pot burns 5%.</div>
    <div class="section-title">RAM PLAN</div>
    <div class="dim" style="font-size:0.8em">Each round: where you ram, which side you brace. A blow into a braced side glances off. The plan loops.</div>
    <div class="o-plan">${o.plan.map((p, i) => `<div><span class="display">${i + 1}</span>
      <span class="toggle">${(['front', 'side', 'rear'] as const).map((z) => `<button class="btn small ${p.ram === z ? 'selected' : ''}" data-a="o-plan" data-v="${i}:ram" data-w="${z}">${ZONE_LABEL[z]}</button>`).join('')}</span>
      <span class="dim">BRACE</span>
      <span class="toggle">${(['front', 'side', 'rear'] as const).map((z) => `<button class="btn small ${p.brace === z ? 'selected' : ''}" data-a="o-plan" data-v="${i}:brace" data-w="${z}">${ZONE_LABEL[z][0]}</button>`).join('')}</span></div>`).join('')}</div>
    <div class="btn-row" style="margin-top:0.4em"><button class="btn small" data-a="o-plan-add">+ STEP</button><button class="btn small" data-a="o-plan-del">− STEP</button><button class="btn small" data-a="o-plan-save" ${busy(o, 'plan')}>SAVE AS DEFENCE</button></div>
    <button class="btn primary" style="margin-top:0.8em" data-a="o-post" ${busy(o, 'post')}>POST · ${esc(D.stakeLabel(st))}${high ? ` + ${DUEL_RULES.high.feeToken} MT` : ''} · ${getVehicle(o.duelCar).name}</button>`;
}

function mineList(o: Online) {
  const list = o.mine;
  if (!list) return '<div class="dim">Loading…</div>';
  if (!list.length) return '<div class="dim" style="margin-top:0.6em">You have not posted a challenge yet.</div>';
  return `<div class="card-list" style="margin-top:0.6em">${list.map((c) => {
    const m = c.match;
    // matches you posted, and ones you took: the opponent is whoever was on the other side
    const opp = c.mine ? m.JoinedByUserID : m.CreatorID;
    const car = c.mine ? c.vehicle : G.vehicleOfCharacter(m.JoinedByCharacterID ?? 'Main');
    const status = m.Status === 'Completed' ? (m.WinnerUserID === idos.userId ? '<b style="color:var(--good)">WON</b>' : m.WinnerUserID ? '<b style="color:var(--danger)">LOST</b>' : '<b>DRAW</b>') : m.Status === 'Open' ? '<b style="color:var(--accent)">WAITING</b>' : `<span class="dim">${esc(m.Status ?? '')}</span>`;
    return `<div class="row-item"><div class="grow"><div class="name">${getVehicle(car).name} · ${esc(D.stakeLabel(c.stake))}${c.mine ? '' : ' <span class="dim">· YOU TOOK IT</span>'}</div>
      <div class="desc">${status}${opp ? ` vs ${D.driverTag(opp)}` : ''}${m.Status === 'Open' && m.ExpiresAt ? ` · ${left(Date.parse(m.ExpiresAt) - Date.now())} left` : ''}</div></div>
      ${m.Status === 'Open' ? `<button class="btn small" data-a="o-cancel" data-v="${m.MatchID}" ${busy(o, `cancel-${m.MatchID}`)}>WITHDRAW</button>` : ''}</div>`;
  }).join('')}</div>`;
}

/** between a dropped session and the sign-in screen */
function waitingPanels() {
  return { left: '<div class="dim">Reconnecting to the street…</div>', right: '' };
}

// ---------------------------------------------------------------- DEPOT tab

export function depotTab(o: Online): { left: string; right: string } {
  if (!o.online) return waitingPanels();
  const tabs = `<div class="btn-row" style="margin-top:0">${(['shop', 'wraps', 'market'] as const).map((t) => `<button class="btn small ${o.depot === t ? 'selected' : ''}" data-a="o-depot" data-v="${t}">${{ shop: 'SHOP', wraps: 'CRATE & WRAPS', market: 'STREET MARKET' }[t]}</button>`).join('')}</div>`;
  let left = '';
  if (o.depot === 'shop') left = shopHtml(o);
  else if (o.depot === 'wraps') left = crateHtml(o);
  else left = marketHtml(o);
  const stock = SUPPLIES.map((s) => `<div class="row-item"><div style="font-size:1.4em;width:1.4em;text-align:center;color:var(--accent2)">${s.icon}</div><div class="grow"><div class="name">${s.name} <span class="dim">× ${idos.itemCount(s.id)}</span></div><div class="desc">${esc(s.desc)}</div></div></div>`).join('');
  return { left: `<h2>THE DEPOT</h2>${tabs}${note(o)}${left}`, right: `<h3>YOUR STOCK</h3><div class="card-list">${stock}</div><div class="dim" style="font-size:0.8em;margin-top:0.6em">MileToken is the game's Solana token. Spent here, it stays in Zero Mile's economy; deposits and withdrawals go through the WALLET.</div>` };
}

function shopHtml(o: Online) {
  const shelves = o.shelves;
  if (!shelves) return '<div class="dim">Opening the depot…</div>';
  return shelves.map((sh) => `<div class="section-title">${esc(sh.name)}</div><div class="card-list">${sh.items.map((it) => {
    const off = it.offer;
    const c = E.offerContents(off);
    const liv = LIVERIES.find((l) => l.id === c.item);
    const sup = SUPPLIES.find((s) => s.id === c.item);
    const soldOut = off.State?.SoldOut || off.State?.RemainingToday === 0 || off.State?.RemainingTotal === 0;
    const owned = !!c.item?.startsWith('car_') && idos.itemCount(c.item) > 0;
    const opts = (off.PriceOptions ?? []).map((p) => {
      const prices = E.pricesOf(p);
      const ok = prices.every(E.canAfford) && !soldOut && !owned && !o.busy.has(`buy-${off.OfferID}`);
      return `<button class="btn small ${prices.some(E.isToken) ? 'o-token' : ''}" data-a="o-buy" data-v="${off.OfferID}" data-w="${p.OptionID}" ${ok ? '' : 'disabled'}>${prices.map(E.priceLabel).join(' + ')}</button>`;
    }).join('');
    const icon = liv ? swatch(liv, 1.6) : sup ? `<span style="font-size:1.4em;color:var(--accent2)">${sup.icon}</span>` : c.salvage ? '<span class="display" style="color:var(--gold)">SV</span>' : '<span style="font-size:1.3em">⚿</span>';
    return `<div class="row-item ${owned ? 'owned' : ''}" ${liv ? `style="border-color:${LIVERY_COLOR[liv.rarity]}66"` : ''}><div style="width:1.8em;text-align:center">${icon}</div>
      <div class="grow"><div class="name">${esc(off.Identity?.DisplayName ?? off.OfferID)}${liv ? ` <span style="color:${LIVERY_COLOR[liv.rarity]};font-size:0.75em">${liv.rarity}</span>` : ''}</div>
      <div class="desc">${owned ? 'OWNED — IN YOUR GARAGE' : soldOut ? 'SOLD OUT FOR TODAY' : sup ? esc(sup.desc) : c.salvage ? 'Spend it in the garage, on duel tuning and on the street market.' : c.item?.startsWith('car_') ? 'Yours for good: drive it in runs and in duels.' : ''}</div></div>
      <div class="o-opts">${opts}</div></div>`;
  }).join('')}</div>`).join('');
}

function crateHtml(o: Online) {
  const keys = idos.itemCount('crate_key');
  const reveal = o.crateReveal;
  const odds = (['COMMON', 'RARE', 'EPIC', 'LEGENDARY'] as const).map((r) => {
    const tot = LIVERIES.reduce((a, l) => a + l.weight, 0);
    const w = LIVERIES.filter((l) => l.rarity === r).reduce((a, l) => a + l.weight, 0);
    return `<span style="color:${LIVERY_COLOR[r]}">${r} ${((w / tot) * 100).toFixed(0)}%</span>`;
  }).join(' · ');
  return `<div class="section-title">LIVERY CRATE</div>
    <div class="row-item o-crate"><div class="grow"><div class="name">ONE WRAP PER CRATE</div><div class="desc">${odds}<br>Every 12th crate without an EPIC is guaranteed EPIC or better.</div></div></div>
    <div class="btn-row" style="margin-top:0.4em">
      <button class="btn small primary" data-a="o-crate" data-v="key" ${keys < 1 || o.busy.has('crate') ? 'disabled' : ''}>OPEN WITH A KEY (${keys})</button>
      <button class="btn small o-token" data-a="o-crate" data-v="token" ${idos.tokens < 5 || o.busy.has('crate') ? 'disabled' : ''}>OPEN · 5 MILETOKEN</button>
    </div>
    ${reveal ? `<div class="o-reveal">${reveal.map((l) => `<div style="--rc:${LIVERY_COLOR[l.rarity]}">${swatch(l, 3)}<b>${esc(l.name)}</b><span>${l.rarity}</span></div>`).join('')}</div>` : ''}
    <div class="section-title">YOUR WRAPS</div>
    ${G.ownedWraps().length ? `<div class="card-list">${G.ownedWraps().map((w) => `<div class="row-item" style="border-color:${LIVERY_COLOR[w.def.rarity]}66">${swatch(w.def, 1.6)}<div class="grow"><div class="name">${esc(w.def.name)} <span style="color:${LIVERY_COLOR[w.def.rarity]};font-size:0.75em">${w.def.rarity}</span></div><div class="desc">${w.on ? `On the ${getVehicle(w.on).name}` : 'In the garage'} · wear it from the STREET tab</div></div></div>`).join('')}</div>` : '<div class="dim">None yet.</div>'}`;
}

function marketHtml(o: Online) {
  const groups = o.marketGroups;
  const sellable = [...G.ownedWraps().filter((w) => !w.on).map((w) => ({ id: w.instance, label: w.def.name, liv: w.def as LiveryDef | undefined })), ...SUPPLIES.filter((s) => idos.itemCount(s.id) > 0).map((s) => ({ id: s.id, label: `1 ${s.name}`, liv: undefined }))];
  const label = (id: string) => LIVERIES.find((l) => l.id === id)?.name ?? SUPPLIES.find((s) => s.id === id)?.name ?? id;
  return `<div class="dim" style="font-size:0.85em;margin-top:0.4em">Drivers sell wraps and supplies to each other for SALVAGE. 5% of every sale is burned.</div>
    <div class="section-title">FOR SALE</div>
    ${!groups ? '<div class="dim">Reading the street…</div>' : !groups.length ? '<div class="dim">Nothing listed right now.</div>' : `<div class="btn-row" style="margin-top:0">${groups.map((g) => `<button class="btn small ${o.marketItem === g.itemId ? 'selected' : ''}" data-a="o-mkt-item" data-v="${g.itemId}">${esc(label(g.itemId))} (${g.listings})</button>`).join('')}</div>`}
    ${o.marketItem && o.marketOffers ? `<div class="card-list" style="margin-top:0.5em">${o.marketOffers.map((of) => {
      const price = E.entryPrice(of.Price?.Entries?.[0] ?? {});
      const mine = of.CreatorUserID === idos.userId;
      return `<div class="row-item"><div class="grow"><div class="name">${esc(label(of.GoodsItemID ?? ''))} ×${of.GoodsAmount ?? 1}</div><div class="desc">from ${esc(of.CreatorPublicData?.Username ?? 'a driver')}</div></div>
        ${mine ? '<span class="dim">YOURS</span>' : `<button class="btn small" data-a="o-mkt-buy" data-v="${of.OfferID}" ${price && E.canAfford(price) && !o.busy.has(`mbuy-${of.OfferID}`) ? '' : 'disabled'}>${price ? E.priceLabel(price) : '?'}</button>`}</div>`;
    }).join('') || '<div class="dim">Sold out.</div>'}</div>` : ''}
    <div class="section-title">SELL</div>
    ${sellable.length ? `<div style="display:flex;gap:0.5em;align-items:center;margin-bottom:0.4em"><span class="dim">PRICE</span><input type="number" id="o-price" min="10" step="10" value="300" style="width:7em"><span class="dim">SV · listed for 3 days</span></div>
      <div class="card-list">${sellable.map((s) => `<div class="row-item">${swatch(s.liv, 1.4)}<div class="grow"><div class="name">${esc(s.label)}</div></div><button class="btn small" data-a="o-mkt-sell" data-v="${s.id}" ${busy(o, `sell-${s.id}`)}>LIST</button></div>`).join('')}</div>` : '<div class="dim">Nothing to sell (worn wraps must come off first).</div>'}
    ${o.myListings?.length ? `<div class="section-title">YOUR LISTINGS</div><div class="card-list">${o.myListings.map((of) => `<div class="row-item"><div class="grow"><div class="name">${esc(label(of.GoodsItemID ?? ''))}</div><div class="desc">${E.priceLabel(E.entryPrice(of.Price?.Entries?.[0] ?? {}) ?? { ref: SALVAGE, amount: 0 })}</div></div><button class="btn small" data-a="o-mkt-cancel" data-v="${of.OfferID}" ${busy(o, `mcancel-${of.OfferID}`)}>TAKE DOWN</button></div>`).join('')}</div>` : ''}`;
}

// ---------------------------------------------------------------- the pit: duel HUD and result

export function duelHud(s: DuelScript) {
  const bar = (i: 0 | 1) => {
    const c = s.cars[i];
    return `<div class="o-duelcar ${i ? 'right' : ''}"><div class="name">${esc(c.name)} <span class="dim">${esc(c.label)}</span></div><div class="o-hp"><i id="duel-hp-${i}" style="width:100%"></i></div><div class="dim" id="duel-hpt-${i}">${Math.ceil(c.maxHp)} / ${Math.ceil(c.maxHp)}</div></div>`;
  };
  return `<div class="screen o-duel"><div class="o-duelbar">${bar(0)}<div class="o-vs"><b>VS</b><span id="duel-round">ROUND 1</span></div>${bar(1)}</div>
    <div class="o-call" id="duel-call"></div>
    <div class="o-duel-skip"><button class="btn small" data-a="skip">SKIP ▶▶</button></div></div>`;
}

export function blowCall(s: DuelScript, b: DuelBlow) {
  const who = s.cars[b.by].name;
  const z = ZONE_LABEL[b.zone];
  const dmg = b.damage >= 1 ? Math.round(b.damage) : b.damage.toFixed(1);
  if (b.outcome === 'dodged') return { text: `${z} RAM — DODGED`, color: '#9fe8ff' };
  if (b.outcome === 'blocked') return { text: `${z} RAM — BRACED · ${dmg}`, color: '#5ad1ff' };
  if (b.outcome === 'crit') return { text: `${esc(who)} · FULL-BOOST ${z} RAM −${dmg}`, color: '#ffd23a' };
  return { text: `${z} RAM −${dmg}`, color: b.by === 0 ? '#58f0a0' : '#ff3a5c' };
}

export function duelResult(outcome: { won: boolean; draw: boolean; prize: string; stake: string; opponent: string }) {
  const title = outcome.draw ? 'DRAW' : outcome.won ? 'YOU WON THE DUEL' : 'WRECKED IN THE PIT';
  const line = outcome.draw ? `Both stakes go back. vs ${esc(outcome.opponent)}` : outcome.won ? `+${esc(outcome.prize)} · vs ${esc(outcome.opponent)}` : `−${esc(outcome.stake)} · ${esc(outcome.opponent)} takes the pot`;
  return `<div class="screen modal"><div class="panel" style="text-align:center;min-width:380px">
    <h2 style="color:${outcome.won ? 'var(--gold)' : outcome.draw ? 'var(--text)' : 'var(--danger)'}">${title}</h2>
    <div class="display" style="font-size:1.3em">${line}</div>
    <div class="btn-row" style="justify-content:center"><button class="btn primary" data-a="continue">BACK TO THE STREET ▶</button></div>
  </div></div>`;
}

// ---------------------------------------------------------------- moments in a run

/** a wreck: call a tow truck (from stock, or MileToken on the spot) or let the run end */
export function towModal(stock: number, tokenPrice: number, tokens: number, status = '') {
  return `<div class="screen modal"><div class="panel event-panel" style="text-align:center">
    <div class="eicon">⛟</div><h2>WRECKED</h2>
    <p>A tow truck can haul you back onto the road: full hull, same run, everything you built. Once per run.</p>
    <div class="btn-col">
      <button class="btn primary" data-a="tow-stock" ${stock < 1 ? 'disabled' : ''}>USE A TOW TRUCK (${stock} IN STOCK)</button>
      <button class="btn o-token" data-a="tow-token" ${tokens < tokenPrice ? 'disabled' : ''}>CALL ONE NOW · ${tokenPrice} MILETOKEN</button>
      <button class="btn" data-a="tow-no">END THE RUN</button>
    </div>
    <div class="o-note" id="tow-status">${esc(status)}</div>
  </div></div>`;
}

/** the night market's under-the-counter shelf */
export function voucherButton(stock: number, tokenPrice: number, tokens: number) {
  const ok = stock > 0 || tokens >= tokenPrice;
  return `<button class="btn small o-token" data-a="voucher" ${ok ? '' : 'disabled'}>✦ UNDER THE COUNTER · ${stock > 0 ? `VOUCHER (${stock})` : `${tokenPrice} MT`}</button>`;
}

/** the map's toll express */
export function tollButton(stock: number, tokenPrice: number, tokens: number) {
  const ok = stock > 0 || tokens >= tokenPrice;
  return `<button class="btn small o-token" data-a="toll" ${ok ? '' : 'disabled'}>⛿ TOLL EXPRESS · ${stock > 0 ? `PASS (${stock})` : `${tokenPrice} MT`}</button>`;
}

/** results: what the street made of the run, filled in when the server answers */
export function resultsOnline(lines: string[], insurance: { salvage: number; stock: number; tokenPrice: number; tokens: number } | null, retry = false) {
  return `${lines.map((l) => `<div class="o-line">${esc(l)}</div>`).join('')}
    ${retry ? '<div class="btn-row" style="margin-top:0.6em"><button class="btn small primary" data-a="record">↻ RECORD THE RUN</button></div>' : ''}
    ${insurance ? `<div class="btn-row" style="margin-top:0.6em"><button class="btn small o-token" data-a="insure" ${insurance.stock > 0 || insurance.tokens >= insurance.tokenPrice ? '' : 'disabled'}>⛨ CLAIM WRECK INSURANCE: +${insurance.salvage} SALVAGE · ${insurance.stock > 0 ? `POLICY (${insurance.stock})` : `${insurance.tokenPrice} MT`}</button></div>` : ''}`;
}

export { swatch };
