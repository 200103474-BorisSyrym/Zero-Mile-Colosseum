import { CONFIG } from '../core/config';
import { fmtTime } from '../core/math';
import { ABILITIES, MODULE_ABILITIES } from '../data/abilities';
import type { EventDef } from '../data/events';
import { getItem, RARITY_COLOR, type ItemDef } from '../data/items';
import { ACHIEVEMENTS, DIFFICULTIES, LORE, UNLOCKS } from '../data/meta';
import { ARCHETYPE_VERB, SYNERGIES } from '../data/synergies';
import type { Tag } from '../data/types';
import { PAINTS, VEHICLES } from '../data/vehicles';
import { ZONES } from '../data/zones';
import type { Game } from '../game/game';
import { NODE_INFO, type RunState } from '../game/run';
import type { Settings } from '../save/save';
import { depotTab, hubButtons, hubPanel, onlineChip, playExtras, streetTab, tollButton, voucherButton } from './street';
import { accountChip } from './login';
import { achievementSalvage, achievementStatus } from '../idos/profile';

export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const tagHtml = (t: Tag) => `<span class="tag" style="color:${TAG_COLORS[t] ?? '#aab'}">${t}</span>`;
export const TAG_COLORS: Partial<Record<Tag, string>> = {
  RAM: '#ff8a3a', SPEED: '#33e0ff', DRIFT: '#ff5ad0', FIRE: '#ff5a20', ELECTRIC: '#5ad1ff', GHOST: '#b9a6ff',
};

/** "WHEN YOU DO X → Y": every part is triggered by something you do with the car. */
const itemText = (it: ItemDef) => `<span class="trig">${esc(it.trigger)}</span> → ${esc(it.effect)}`;

export function itemCard(it: ItemDef, run: RunState | null, extra = '', idx = -1) {
  const tc = run?.tagCounts() ?? {};
  const synHints: string[] = [];
  for (const s of SYNERGIES) {
    const entries = Object.entries(s.req) as [Tag, number][];
    if (!entries.some(([t]) => it.tags.includes(t))) continue;
    const ok = entries.every(([t, n]) => (tc[t] ?? 0) + (it.tags.includes(t) ? 1 : 0) >= n);
    const was = entries.every(([t, n]) => (tc[t] ?? 0) >= n);
    if (ok && !was) synHints.push(`ACTIVATES ${s.name}`);
    else if (!ok) {
      const prog = entries.map(([t, n]) => `${t} ${(tc[t] ?? 0) + (it.tags.includes(t) ? 1 : 0)}/${n}`).join(' · ');
      if (synHints.length < 2) synHints.push(`${s.name}: ${prog}`);
    }
  }
  return `<div class="card" tabindex="0" style="--rc:${RARITY_COLOR[it.rarity]}" data-item="${it.id}">
    ${idx >= 0 ? `<div class="key">${idx + 1}</div>` : ''}
    <div class="rarity">${it.rarity}</div>
    <div class="icon">${it.icon}</div>
    <div class="name">${esc(it.name)}</div>
    <div>${it.tags.map(tagHtml).join('')}${it.tags[0] ? `<span class="verb">${ARCHETYPE_VERB[it.tags[0]]}</span>` : ''}</div>
    <div class="desc">${itemText(it)}</div>
    ${it.drawback ? `<div class="draw">▼ ${esc(it.drawback)}</div>` : ''}
    ${synHints.map((h) => `<div class="syn">◆ ${esc(h)}</div>`).join('')}
    ${extra}
  </div>`;
}

export function synergyPanel(run: RunState) {
  const tc = run.tagCounts();
  return SYNERGIES.filter((s) => (Object.keys(s.req) as Tag[]).some((t) => (tc[t] ?? 0) > 0))
    .map((s) => {
      const entries = Object.entries(s.req) as [Tag, number][];
      const active = entries.every(([t, n]) => (tc[t] ?? 0) >= n);
      const prog = entries.map(([t, n]) => `${t} ${Math.min(tc[t] ?? 0, n)}/${n}`).join(' · ');
      return `<div class="syn-row ${active ? 'active' : ''}"><span>${s.name}${active ? ' — ACTIVE' : ''}</span><span class="p">${prog}</span></div><div class="syn-desc">${esc(s.description)}</div>`;
    })
    .join('') || '<div class="dim">No synergies in progress. Items with matching tags combine into powerful effects.</div>';
}

export function mainMenu(g: Game) {
  const sv = g.save;
  const best = sv.best;
  return `<div class="screen menu">
    <div class="left">
      <div class="logo">ZERO<br><span>MILE</span></div>
      <div class="tagline">DRIVE. ADAPT. SURVIVE.</div>
      <button class="btn primary hub-btn run" data-a="start"><span class="hub-ic">▶</span><span class="hub-t">START RUN</span><small>Five regions, five bosses, one night. Every run pays SALVAGE.</small></button>
      ${hubButtons(g.online)}
      <div class="menu-row">
        <button class="btn small" data-a="garage">GARAGE</button>
        <button class="btn small" data-a="archive">ARCHIVE</button>
        <button class="btn small" data-a="settings">SETTINGS</button>
        <button class="btn small" data-a="quit">QUIT</button>
      </div>
      <div class="meta">
        ${sv.runs ? `RUNS <b>${sv.runs}</b> · WINS <b>${sv.wins}</b> · BEST <b>${ZONES[Math.min(best.zone, 4)].name}</b>` : 'The city rebuilds itself every night. Tonight, drive to the center.'}
        <br>SALVAGE <b>${sv.salvage}</b>${g.online.online ? ` · MILETOKEN <b class="mt">${Math.floor(g.online.tokens)}</b>` : ""}
      </div>
    </div>
    <div class="hub panel" id="hub">${hubPanel(g.online)}</div>
    ${accountChip()}
    <div class="corner-note">W/S ACCEL · A/D STEER · SPACE DRIFT · SHIFT NITRO · Q/E ABILITIES<br>GAMEPAD SUPPORTED · v1.2</div>
  </div>`;
}

export function garage(g: Game, tab: string) {
  const sv = g.save;
  const veh = VEHICLES.find((v) => v.id === sv.selectedVehicle)!;
  // the street's tabs come right after PLAY, marked: they are the game's shared side
  const tabs = ['PLAY', 'STREET', 'DEPOT', 'VEHICLES', 'UPGRADES', 'ARCHIVE', 'SETTINGS'];
  const TAB_LABEL: Record<string, string> = { STREET: '⚔ DUELS · PVP', DEPOT: '◎ DEPOT' };
  const ready = (g.online.contracts ?? []).filter((c) => c.status === 'Completed').length;
  const open = g.online.challenges?.length ?? 0;
  const badge = (t: string) => (t === 'PLAY' && ready ? `<b class="tab-badge">${ready}</b>` : t === 'STREET' && open ? `<b class="tab-badge">${open}</b>` : '');
  let left = '';
  let right = '';
  const pip = (n: number) => `<div class="pips">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</div>`;
  const statBlock = `
    <div class="stat-row"><span>HULL</span>${pip(veh.rating.hp)}</div>
    <div class="stat-row"><span>SPEED</span>${pip(veh.rating.speed)}</div>
    <div class="stat-row"><span>MASS</span>${pip(veh.rating.mass)}</div>
    <div class="stat-row"><span>GRIP</span>${pip(veh.rating.grip)}</div>`;
  const msgs = garageMessages(g);
  switch (tab) {
    case 'PLAY': {
      const modules = MODULE_ABILITIES.filter((m) => !ABILITIES[m].unlock || sv.unlocks[ABILITIES[m].unlock!]);
      left = `<h2>RUN SETUP</h2>
        <div class="section-title">CHASSIS</div>
        <div class="display" style="font-size:1.4em">${veh.name} <span class="dim" style="font-size:0.6em">${veh.role}</span></div>
        <div class="dim" style="font-size:0.9em">${esc(veh.description)}</div>
        <div class="section-title">Q · CHASSIS SPECIAL</div>
        <div class="row-item"><div class="aicon" style="color:${ABILITIES[veh.special].color};font-size:1.6em">${ABILITIES[veh.special].icon}</div><div class="grow"><div class="name">${ABILITIES[veh.special].name}</div><div class="desc">${esc(ABILITIES[veh.special].description)}</div></div></div>
        <div class="section-title">E · MODULE</div>
        <div class="card-list">${modules.map((m) => `<div class="row-item interactive ${sv.module === m ? 'owned' : ''}" data-a="module" data-v="${m}" style="cursor:pointer"><div style="color:${ABILITIES[m].color};font-size:1.5em;width:1.3em;text-align:center">${ABILITIES[m].icon}</div><div class="grow"><div class="name">${ABILITIES[m].name} ${sv.module === m ? '✓' : ''}</div><div class="desc">${esc(ABILITIES[m].description)} · ${ABILITIES[m].cost} momentum</div></div></div>`).join('')}</div>
        <div class="section-title">DIFFICULTY</div>
        <div class="btn-row" style="margin-top:0">${DIFFICULTIES.map((d) => `<button class="btn small ${sv.difficulty === d.id ? 'selected' : ''}" data-a="diff" data-v="${d.id}" ${d.id > sv.maxDifficultyUnlocked ? 'disabled' : ''}>${d.name}</button>`).join('')}</div>
        <div class="dim" style="font-size:0.85em;margin-top:0.4em">${esc(DIFFICULTIES[sv.difficulty].description)}</div>
        <div class="section-title">SEED (OPTIONAL, FOR TESTING)</div>
        <input type="text" id="seed-input" placeholder="random" maxlength="9" value="${g.customSeed ?? ''}">
        <button class="btn primary" style="margin-top:1em" data-a="launch">▶ LAUNCH RUN</button>`;
      // the ranked week and the contracts first: the radio is flavour
      const ex = playExtras(g.online);
      right = `${ex.left}${ex.right}<h3 style="margin-top:1em">RADIO</h3>${msgs}`;
      break;
    }
    case 'STREET': {
      const st = streetTab(g.online, sv.unlockedVehicles);
      left = st.left;
      right = st.right;
      break;
    }
    case 'DEPOT': {
      const dp = depotTab(g.online);
      left = dp.left;
      right = dp.right;
      break;
    }
    case 'VEHICLES': {
      left = `<h2>VEHICLES</h2><div class="card-list">${VEHICLES.map((v) => {
        const owned = sv.unlockedVehicles.includes(v.id);
        const sel = sv.selectedVehicle === v.id;
        return `<div class="row-item interactive ${owned ? 'owned' : 'locked'}" data-a="${owned ? 'selcar' : 'buycar'}" data-v="${v.id}" style="cursor:pointer;${sel ? 'border-color:var(--accent)' : ''}">
          <div class="grow"><div class="name">${v.name} <span class="dim">${v.role}</span> ${sel ? '◀' : ''}</div><div class="desc">${esc(v.description)}<br><span style="color:var(--accent2)">${esc(v.identity)}</span><br>Special: ${ABILITIES[v.special].name}</div></div>
          ${owned ? '' : `<button class="btn small" data-a="buycar" data-v="${v.id}" ${sv.salvage < v.price || g.busy.has(`vehicle-${v.id}`) ? 'disabled' : ''}>${v.price} SALVAGE</button>`}
        </div>`;
      }).join('')}</div>`;
      const curPaint = sv.paint[veh.id] ?? 'stock';
      right = `<h3>${veh.name}</h3>${statBlock}
        <div class="section-title">PAINT</div>
        <div class="swatches">${PAINTS.map((p) => {
          const own = sv.paints.includes(p.id);
          const col = p.color < 0 ? veh.color : p.color;
          return `<div class="swatch interactive ${curPaint === p.id ? 'sel' : ''} ${own ? '' : 'locked'}" data-a="paint" data-v="${p.id}" data-price="${p.price}" title="${p.name}" style="background:#${col.toString(16).padStart(6, '0')}"></div>`;
        }).join('')}</div>
        <div class="dim" style="font-size:0.8em;margin-top:0.4em">Locked paints cost salvage. Click to buy/apply.</div>`;
      break;
    }
    case 'UPGRADES': {
      const cats = ['ITEMS', 'ABILITIES', 'EVENTS', 'PERKS'] as const;
      left = `<h2>UPGRADES</h2><div class="dim" style="font-size:0.9em">Permanent upgrades unlock possibilities — new parts, modules and events. Minimal stat inflation.</div>
        ${cats.map((c) => `<div class="section-title">${c}</div><div class="card-list">${UNLOCKS.filter((u) => u.category === c).map((u) => {
          const lvl = sv.unlocks[u.id] ?? 0;
          const max = u.levels ?? 1;
          const done = lvl >= max;
          const price = u.price * (lvl + 1);
          return `<div class="row-item ${done ? 'owned' : ''}"><div class="grow"><div class="name">${u.name}${max > 1 ? ` <span class="dim">${lvl}/${max}</span>` : ''}</div><div class="desc">${esc(u.description)}</div></div>
            ${done ? '<span class="display" style="color:var(--good)">OWNED</span>' : `<button class="btn small" data-a="unlock" data-v="${u.id}" ${sv.salvage < price || g.busy.has(`unlock-${u.id}`) ? 'disabled' : ''}>${price}</button>`}</div>`;
        }).join('')}</div>`).join('')}`;
      right = `<h3>ITEM POOL</h3><div class="dim" style="font-size:0.9em;line-height:1.6">${g.itemPoolSummary()}</div>`;
      break;
    }
    case 'ARCHIVE': {
      left = `<h2>ARCHIVE</h2>${LORE.map((l) => {
        const has = sv.lore.includes(l.id);
        return `<div class="row-item ${has ? '' : 'locked'}"><div class="grow"><div class="name">${has ? l.title : '— ENCRYPTED —'}</div><div class="desc">${has ? esc(l.text) : 'Found on the road: events, wrecks and bosses.'}</div></div></div>`;
      }).join('')}`;
      right = `<h3>RECORDS</h3>
        <div class="results" style="grid-template-columns:1fr">
          <div><span>RUNS</span><b>${sv.runs}</b></div><div><span>WINS</span><b>${sv.wins}</b></div>
          <div><span>BEST REGION</span><b>${ZONES[Math.min(sv.best.zone, 4)].name}</b></div>
          <div><span>BEST DISTANCE</span><b>${(sv.best.distance / 1000).toFixed(1)} KM</b></div>
          <div><span>MOST KILLS</span><b>${sv.best.kills}</b></div><div><span>TOP SPEED</span><b>${Math.round(sv.best.maxSpeed)} KM/H</b></div>
          <div><span>BEST COMBO</span><b>${sv.best.combo}</b></div><div><span>BEST SCORE</span><b>${sv.best.score.toLocaleString('en-US')}</b></div><div><span>TOTAL SALVAGE</span><b>${sv.totalSalvage}</b></div>
        </div>
        <h3 style="margin-top:1em">ACHIEVEMENTS ${sv.achievements.length}/${ACHIEVEMENTS.length}</h3>
        <div class="card-list">${ACHIEVEMENTS.map((a) => {
          const st = achievementStatus(a.id);
          const has = sv.achievements.includes(a.id);
          const pay = achievementSalvage(a.id);
          const right = st === 'ready' ? `<button class="btn small primary" data-a="claim-ach" data-v="${a.id}" ${g.busy.has(`ach-${a.id}`) ? 'disabled' : ''}>CLAIM ${pay} SV</button>` : st === 'claimed' ? '<span class="display" style="color:var(--good)">PAID</span>' : has ? '<span class="dim display">RECORDING…</span>' : `<span class="dim display">${pay} SV</span>`;
          return `<div class="row-item ${has ? 'owned' : 'locked'}"><div class="grow"><div class="name">${has ? '★' : '☆'} ${a.name}</div><div class="desc">${esc(a.description)}</div></div>${right}</div>`;
        }).join('')}</div>`;
      break;
    }
    case 'SETTINGS':
      left = `<h2>SETTINGS</h2>${settingsForm(sv.settings, true)}`;
      right = `<h3>CONTROLS</h3>${controlsHtml()}`;
      break;
  }
  return `<div class="screen garage">
    <div class="top">
      <button class="btn small" data-a="back">◀ MENU</button>
      <div class="tabs">${tabs.map((t) => `<button class="btn small ${t === tab ? 'selected' : ''} ${TAB_LABEL[t] ? 'tab-street' : ''}" data-a="tab" data-v="${t}">${TAB_LABEL[t] ?? t}${badge(t)}</button>`).join('')}</div>
      ${onlineChip(g.online)}
      ${accountChip()}
    </div>
    <div class="body">
      <div class="side panel">${g.garageNote ? `<div class="o-note ${g.garageNote.good ? 'good' : ''}">${esc(g.garageNote.text)}</div>` : ''}${left}</div>
      <div class="center-info"><div class="carname">${veh.name}</div><div class="dim display" style="letter-spacing:0.4em">${veh.role}</div></div>
      <div class="side right panel">${right}</div>
    </div>
  </div>`;
}

function garageMessages(g: Game) {
  const sv = g.save;
  const msgs: [string, string][] = [];
  if (sv.runs === 0) msgs.push(['DISPATCH', 'New driver on the board. The Shift starts at dusk. Get to the Industrial Ring, keep your speed up and do not stop for anything.']);
  if (sv.runs > 0 && sv.best.zone === 0) msgs.push(['MECHANIC', "Rough night. Salvage is salvage — spend it in UPGRADES. More parts on the road means more ways to build."]);
  if (sv.best.zone >= 1) msgs.push(['DISPATCH', 'You made it past the Iron Mule. The Flood District eats traction — drift carefully, and overtake the night bus fast.']);
  if (sv.best.zone >= 2) msgs.push(['UNKNOWN', 'TAXON learns how you drive. Change it up when it adapts.']);
  if (sv.best.zone >= 3) msgs.push(['UNKNOWN', 'APEX does not fight. It races. Slipstream, boost, and never brake.']);
  if (sv.best.zone >= 4) msgs.push(['THE DRIVER', '"You are close. I have been watching how you drive. I will drive like you."']);
  if (sv.wins > 0) msgs.push(['DISPATCH', 'Zero Mile reached. The city is still shifting. Deeper nights are open — the rewards are better.']);
  if (!sv.unlockedVehicles.includes('rammer') && sv.salvage >= 160) msgs.push(['MECHANIC', 'You can afford the RAMMER now. Heavy, slow, unstoppable.']);
  return msgs.slice(-3).map(([who, txt]) => `<div class="message"><b>${who}</b>${esc(txt)}</div>`).join('');
}

/** the device's settings; the account row signs out or links a wallet (not in the middle of a run) */
export function settingsForm(s: Settings, account = false) {
  const q = ['LOW', 'MEDIUM', 'HIGH', 'VERY HIGH'];
  const slider = (id: string, v: number) => `<input type="range" min="0" max="100" value="${Math.round(v * 100)}" data-s="${id}">`;
  const tog = (id: string, v: boolean) => `<span class="toggle"><button class="btn small ${v ? 'selected' : ''}" data-s="${id}" data-v="1">ON</button><button class="btn small ${!v ? 'selected' : ''}" data-s="${id}" data-v="0">OFF</button></span>`;
  return `<div class="settings-grid">
    <label>MASTER VOLUME</label>${slider('master', s.master)}
    <label>MUSIC VOLUME</label>${slider('music', s.music)}
    <label>SFX VOLUME</label>${slider('sfx', s.sfx)}
    <label>QUALITY</label><span class="toggle">${q.map((n, i) => `<button class="btn small ${s.quality === i ? 'selected' : ''}" data-s="quality" data-v="${i}">${n}</button>`).join('')}</span>
    <label>AUTO QUALITY</label>${tog('autoQuality', s.autoQuality)}
    <label>SCREEN SHAKE</label>${tog('shake', s.shake)}
    <label>REDUCED EFFECTS</label>${tog('reducedEffects', s.reducedEffects)}
    <label>HIGH CONTRAST UI</label>${tog('highContrast', s.highContrast)}
    <label>CAMERA RESPONSE</label><input type="range" min="30" max="200" value="${Math.round(s.cameraSensitivity * 100)}" data-s="cameraSensitivity">
    <label>SHOW FPS</label>${tog('showFps', s.showFps)}
    ${account ? '<label>ACCOUNT</label><button class="btn small" data-a="account">ACCOUNT · WALLET · SIGN OUT</button>' : ''}
  </div>`;
}

export function controlsHtml() {
  return `<div class="keys">
    <kbd>W / ↑</kbd><span>Accelerate</span><kbd>S / ↓</kbd><span>Brake / Reverse</span><kbd>A D</kbd><span>Steer</span>
    <kbd>SPACE</kbd><span>Handbrake · hold while turning to DRIFT</span><kbd>SHIFT</kbd><span>Nitro</span>
    <kbd>Q</kbd><span>Chassis special</span><kbd>E</kbd><span>Module ability</span><kbd>TAB</kbd><span>Build & synergies</span>
    <kbd>ESC</kbd><span>Pause</span><kbd>R</kbd><span>Reset (only when stuck 3s+)</span><kbd>F1 / \`</kbd><span>Debug overlay</span>
    <kbd>PAD</kbd><span>RT/LT drive · A drift · B nitro · X/Y abilities</span>
  </div>`;
}

export function mapScreen(g: Game, run: RunState) {
  const zone = run.zone;
  const avail = new Set(run.availableNodes().map((n) => n.id));
  const rows = 6;
  const pos = (n: { row: number; x: number }) => ({ x: n.x * 100, y: 92 - (n.row / (rows - 1)) * 84 });
  let lines = '';
  for (const n of run.map) {
    for (const t of n.next) {
      const a = pos(n), b = pos(run.map[t]);
      const active = (run.current === n.id && avail.has(t)) || (run.current === null && false);
      lines += `<line x1="${a.x}%" y1="${a.y}%" x2="${b.x}%" y2="${b.y}%" stroke="${active ? '#33e0ff' : n.visited && run.map[t].visited ? '#556' : '#2a3048'}" stroke-width="${active ? 3 : 2}" stroke-dasharray="${active ? '0' : '6 6'}"/>`;
    }
  }
  const nodes = run.map.map((n) => {
    const p = pos(n);
    const info = NODE_INFO[n.type];
    const cls = [avail.has(n.id) ? 'avail' : n.visited ? 'visited' : 'locked', run.current === n.id ? 'current' : '', n.type === 'BOSS' ? 'boss' : ''].join(' ');
    return `<div class="node-wrap ${cls}" style="left:${p.x}%;top:${p.y}%;--nc:${info.color}" data-node="${n.id}" data-tip="${esc(info.desc)}"><div class="node">${info.icon}</div><div class="lbl">${n.type === 'BOSS' ? esc(g.bossName(zone.boss)) : info.label}</div>${['ROAD', 'ELITE', 'RACE', 'SHORTCUT', 'BOSS'].includes(n.type) ? `<div class="stars" title="difficulty">${'★'.repeat(n.stars)}${'☆'.repeat(5 - n.stars)}</div>` : ''}</div>`;
  }).join('');
  const st = run.computeStats();
  return `<div class="screen map">
    <div class="header"><div class="dim display" style="letter-spacing:0.5em">REGION ${zone.index + 1} / 5 · ${run.ranked ? '<span style="color:var(--gold)">THE WEEKLY SHIFT · RANKED</span>' : `RUN #${run.seed}`}</div><h1>${zone.name}</h1><div class="zsub">${zone.subtitle}</div></div>
    <div class="board"><svg>${lines}</svg>${nodes}</div>
    <div class="tip" id="map-tip">Choose your next stop. Lit nodes are reachable.</div>
    <div class="footer">
      <span class="stat-chip">HULL <b style="color:var(--good)">${Math.ceil(run.hp)}/${st.maxHp}</b></span>
      <span class="stat-chip">FUEL <b style="color:var(--warn)">${Math.ceil(run.fuel)}</b></span>
      <span class="stat-chip">CREDITS <b style="color:var(--gold)">${run.credits}</b></span>
      <span class="stat-chip">MOMENTUM <b style="color:#ff8be8">${Math.floor(run.momentum)}</b></span>
      <span class="stat-chip">PARTS <b>${run.items.length}</b></span>
      <span class="stat-chip">BUILD <b style="color:var(--accent2)">${run.archetype()}</b></span>
      ${run.tollTargets ? '<span class="stat-chip" style="color:var(--accent2)">⛿ TOLL EXPRESS — PICK A LIT NODE</span>' : g.online.canSupply(run.ranked) && run.tollReach() ? tollButton(g.online.stock('toll_pass'), g.online.tokenPrice('toll_pass'), g.online.tokens) : ''}
      <button class="btn small" data-a="build">TAB · BUILD</button>
      <button class="btn small" data-a="pause">ESC · MENU</button>
    </div>
  </div>`;
}

export function rewardScreen(run: RunState, items: ItemDef[], title: string, sub: string) {
  return `<div class="screen modal"><div class="panel" style="max-width:900px;text-align:center">
    <h2>${title}</h2><div class="dim">${sub}</div>
    <div class="cards">${items.map((it, i) => itemCard(it, run, '', i)).join('')}</div>
    <div class="btn-row" style="justify-content:center"><button class="btn small" data-a="skip">SKIP (+15 CREDITS)</button></div>
  </div></div>`;
}

export function shopScreen(g: Game, run: RunState, stock: (ItemDef | null)[], prices: number[]) {
  const st = run.computeStats();
  const reroll = g.rerollPrice();
  return `<div class="screen modal"><div class="panel" style="max-width:980px;text-align:center">
    <h2>NIGHT MARKET</h2><div class="dim">Credits don't leave the run. Spend them.</div>
    <div class="display" style="font-size:1.6em;color:var(--gold);margin-top:0.4em">${run.credits} CR</div>
    <div class="cards">${stock.map((it, i) => it ? itemCard(it, run, `<div class="price">${prices[i]} CR</div>`, i).replace('class="card"', `class="card ${run.credits < prices[i] ? 'disabled' : ''}" data-buy="${i}"`) : `<div class="card bought"><div class="name">SOLD</div></div>`).join('')}</div>
    <div class="btn-row" style="justify-content:center">
      <button class="btn small" data-a="heal" ${run.credits < CONFIG.ECONOMY.HEAL_PRICE || run.hp >= st.maxHp ? 'disabled' : ''}>REPAIR 30% · ${CONFIG.ECONOMY.HEAL_PRICE} CR</button>
      <button class="btn small" data-a="fuel" ${run.credits < CONFIG.ECONOMY.FUEL_PRICE || run.fuel >= 99 ? 'disabled' : ''}>REFUEL · ${CONFIG.ECONOMY.FUEL_PRICE} CR</button>
      <button class="btn small" data-a="reroll" ${run.credits < reroll ? 'disabled' : ''}>REROLL · ${reroll === 0 ? 'FREE' : reroll + ' CR'}</button>
      ${g.online.canSupply(run.ranked) && !g.shopVoucherUsed ? voucherButton(g.online.stock('bm_voucher'), g.online.tokenPrice('bm_voucher'), g.online.tokens) : ''}
      <button class="btn small primary" data-a="leave">LEAVE ▶</button>
    </div>
  </div></div>`;
}

export function eventScreen(ev: EventDef, ctxOk: (i: number) => boolean) {
  return `<div class="screen modal"><div class="panel event-panel">
    <div class="eicon">${ev.icon}</div><h2>${ev.title}</h2><p>${esc(ev.text)}</p>
    <div class="btn-col">${ev.options.map((o, i) => `<button class="btn event-opt" data-opt="${i}" ${ctxOk(i) ? '' : 'disabled'}><span class="t">${i + 1}. ${esc(o.label)}</span><span class="d">${esc(o.detail)}</span></button>`).join('')}</div>
  </div></div>`;
}

export function eventResult(ev: EventDef, text: string) {
  return `<div class="screen modal"><div class="panel event-panel">
    <div class="eicon">${ev.icon}</div><h2>${ev.title}</h2>
    <div class="event-result">${esc(text)}</div>
    <div class="btn-row"><button class="btn primary" data-a="continue">CONTINUE ▶</button></div>
  </div></div>`;
}

export function infoModal(title: string, body: string, btn = 'CONTINUE ▶') {
  return `<div class="screen modal"><div class="panel" style="text-align:center"><h2>${title}</h2><div style="font-size:1.1em;line-height:1.6">${body}</div><div class="btn-row" style="justify-content:center"><button class="btn primary" data-a="continue">${btn}</button></div></div></div>`;
}

export function pauseScreen() {
  return `<div class="screen modal"><div class="panel" style="min-width:380px">
    <h2>PAUSED</h2>
    <div class="btn-col">
      <button class="btn primary" data-a="resume">RESUME</button>
      <button class="btn" data-a="build">BUILD & SYNERGIES</button>
      <button class="btn" data-a="restart">RESTART RUN (SAME SEED)</button>
      <button class="btn" data-a="settings">SETTINGS</button>
      <button class="btn" data-a="garage">ABANDON → GARAGE</button>
      <button class="btn danger" data-a="menu">QUIT TO MENU</button>
    </div>
    <div class="dim" style="font-size:0.8em;margin-top:1em">Abandoning a run still pays out salvage.</div>
  </div></div>`;
}

export function settingsModal(s: Settings, account = false) {
  return `<div class="screen modal"><div class="panel" style="min-width:min(760px,92vw)"><h2>SETTINGS</h2>${settingsForm(s, account)}<div class="section-title" style="margin-top:1.2em">CONTROLS</div>${controlsHtml()}<div class="btn-row"><button class="btn primary" data-a="close">BACK</button></div></div></div>`;
}

export function buildScreen(run: RunState) {
  const st = run.computeStats();
  const tc = run.tagCounts();
  const items = run.items.map(getItem).filter((x): x is ItemDef => !!x);
  return `<div class="screen modal"><div class="panel" style="width:min(1100px,94vw)">
    <h2>BUILD · <span style="color:var(--accent2)">${run.archetype()}</span></h2>
    <div style="margin-bottom:0.6em">${(Object.entries(tc) as [Tag, number][]).sort((a, b) => b[1] - a[1]).map(([t, n]) => `<span class="tag" style="color:${TAG_COLORS[t]}">${t} x${n}</span>`).join('') || '<span class="dim">No parts yet.</span>'}</div>
    <div class="build-panel">
      <div><div class="section-title">PARTS (${items.length})</div><div class="items">${items.map((it) => `<div class="row-item" style="border-color:${RARITY_COLOR[it.rarity]}55"><div style="color:${RARITY_COLOR[it.rarity]};font-size:1.5em;width:1.4em;text-align:center">${it.icon}</div><div class="grow"><div class="name">${esc(it.name)} <span style="color:${RARITY_COLOR[it.rarity]};font-size:0.7em">${it.rarity}</span></div><div class="desc">${itemText(it)}${it.drawback ? ` <span style="color:var(--danger)">${esc(it.drawback)}</span>` : ''}</div></div></div>`).join('') || '<div class="dim">Finish roads, beat elites and bosses, or visit shops to collect parts.</div>'}</div></div>
      <div>
        <div class="section-title">SYNERGIES</div>${synergyPanel(run)}
        <div class="section-title">VEHICLE</div>
        <div class="results" style="grid-template-columns:1fr 1fr;font-size:0.85em">
          <div><span>MAX HP</span><b>${st.maxHp}</b></div><div><span>TOP SPEED</span><b>${Math.round(st.maxSpeed * 3.6)}</b></div>
          <div><span>ACCEL</span><b>${st.acceleration.toFixed(1)}</b></div><div><span>MASS</span><b>${st.mass.toFixed(2)}</b></div>
          <div><span>GRIP</span><b>${st.grip.toFixed(1)}</b></div><div><span>RAM DMG</span><b>x${st.ramDamage.toFixed(2)}</b></div>
          <div><span>DMG TAKEN</span><b>x${st.damageTaken.toFixed(2)}</b></div><div><span>ABILITY CD</span><b>x${st.abilityCooldown.toFixed(2)}</b></div>
        </div>
      </div>
    </div>
    <div class="btn-row"><button class="btn primary" data-a="close">CLOSE (TAB)</button></div>
  </div></div>`;
}

/** salvage: what the server paid, or null while it records the run (filled in when it answers) */
export function resultsScreen(g: Game, run: RunState, won: boolean, salvage: number | null, unlocks: string[]) {
  const s = run.stats;
  const items = run.items.map(getItem).filter((x): x is ItemDef => !!x);
  return `<div class="screen modal"><div class="panel" style="width:min(820px,94vw)">
    <h2 style="color:${won ? 'var(--gold)' : 'var(--danger)'};font-size:3em">${won ? 'ZERO MILE COMPLETE' : 'RUN OVER'}</h2>
    <div class="dim display" style="letter-spacing:0.3em">${won ? 'THE CITY STOPS SHIFTING — FOR TONIGHT' : `DESTROYED IN ${run.zone.name}`} · RUN #${run.seed} · ${run.difficulty.name}</div>
    <div class="results">
      <div><span>DISTANCE</span><b>${(s.distance / 1000).toFixed(2)} KM</b></div>
      <div><span>TIME</span><b>${fmtTime(s.time)}</b></div>
      <div><span>ENEMIES DESTROYED</span><b>${s.kills}</b></div>
      <div><span>RAM KILLS</span><b>${s.ramKills}</b></div>
      <div><span>MAX SPEED</span><b>${Math.round(s.maxSpeed)} KM/H</b></div>
      <div><span>BEST COMBO</span><b>${s.bestCombo}</b></div>
      <div><span>NEAR MISSES</span><b>${s.nearMisses}</b></div>
      <div><span>BEST CHAIN</span><b>${s.maxChain}</b></div>
      <div><span>CREDITS EARNED</span><b>${s.creditsEarned}</b></div>
      <div><span>DAMAGE TAKEN</span><b>${Math.round(s.damageTaken)}</b></div>
      <div><span>ITEMS COLLECTED</span><b>${s.itemsCollected}</b></div>
      <div><span>BOSSES DEFEATED</span><b>${s.bossesDefeated}</b></div>
      <div><span>SCORE</span><b style="color:var(--gold)">${s.score.toLocaleString('en-US')}</b></div>
      <div><span>BEST SCORE</span><b>${Math.max(g.save.best.score, s.score).toLocaleString('en-US')}</b></div>
    </div>
    <div class="section-title">BUILD · ${run.archetype()} · ${run.vehicle.name}</div>
    <div style="font-size:0.85em;line-height:1.7">${items.map((it) => `<span style="color:${RARITY_COLOR[it.rarity]}">${it.icon} ${esc(it.name)}</span>`).join(' · ') || '<span class="dim">no parts</span>'}</div>
    <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-top:1em;gap:1em;flex-wrap:wrap">
      <div><div class="dim display" style="letter-spacing:0.3em">SALVAGE EARNED</div><div class="salvage-big">${salvage === null ? '…' : `+${salvage}`}</div></div>
      <div class="unlock-list">${unlocks.map((u) => `★ ${esc(u)}`).join('<br>')}</div>
    </div>
    <div id="online-results" class="o-results"></div>
    <div class="btn-row"><button class="btn primary" data-a="newrun">▶ NEW RUN</button><button class="btn tab-street" data-a="duels">⚔ DUEL A REAL DRIVER</button><button class="btn" data-a="garage">CONTINUE TO GARAGE</button></div>
  </div></div>`;
}

export function quitScreen() {
  return `<div class="screen modal"><div class="panel" style="text-align:center"><h2>ENGINE OFF</h2><p class="dim">Your garage is on your account. Close this tab to quit — the city will be waiting.</p><div class="btn-row" style="justify-content:center"><button class="btn primary" data-a="close">BACK TO MENU</button></div></div></div>`;
}
