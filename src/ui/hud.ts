import { BOSSES } from '../bosses/bosses';
import { LAB_EFFECTS } from '../effects/vfxLab';
import { formatContact } from '../core/collision';
import { CONFIG } from '../core/config';
import { clamp, KMH } from '../core/math';
import { ABILITIES } from '../data/abilities';
import type { AbilityId, Tag } from '../data/types';
import { ENCOUNTERS } from '../encounters/defs';
import type { DrivingSession, HudApi } from '../game/driving';
import { NODE_INFO } from '../game/run';

const el = <T extends HTMLElement = HTMLElement>(root: HTMLElement, sel: string) => root.querySelector(sel) as T;
const NM_TIER = ['', 'NEAR MISS', 'CLOSE CALL', 'PERFECT NEAR MISS'];
const NM_COLOR = ['', '#5af0ff', '#a0f0ff', '#ffffff'];
const BUILD_PRESETS: Tag[] = ['RAM', 'DRIFT', 'SPEED', 'FIRE', 'ELECTRIC', 'GHOST'];

/** In-game HUD. DOM is built once; per-frame updates only touch changed values. */
export class HUD implements HudApi {
  root: HTMLElement;
  private cache = new Map<string, string>();
  private refs: Record<string, HTMLElement> = {};
  private speedCanvas: HTMLCanvasElement;
  private speedCtx: CanvasRenderingContext2D;
  private lastNotif: Record<string, number> = {};
  private nmEl: HTMLElement | null = null;
  private nmTimer = 0;
  private chainEl: HTMLElement | null = null;
  private chainTimer = 0;
  private threatEls: HTMLElement[] = [];
  private dmgEls: HTMLElement[] = [];
  onAbilityClick: ((slot: 'q' | 'e') => void) | null = null;
  /** debug overlay commands: 'enc:<ID>', 'boss:<id>', 'build:<TAG>' */
  onDebug: ((cmd: string) => void) | null = null;
  debugOn = false;
  fpsOn = false;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.id = 'hud';
    this.root.innerHTML = `
      <div class="hud-tl">
        <div class="bar-label"><span>HULL</span><span class="v" data-r="hpv">100</span></div>
        <div class="bar hp-bar" style="--c:#58f0a0"><b data-r="hpghost"></b><i data-r="hp"></i></div>
        <div class="hud-gap"></div>
        <div class="bar-label"><span>FUEL</span><span class="v" data-r="fuelv">100</span></div>
        <div class="bar small-bar" style="--c:#ffb020"><i data-r="fuel"></i></div>
      </div>
      <div class="build-mini"><div class="arch" data-r="arch"></div><div class="syn" data-r="syns"></div></div>
      <div class="hud-tc">
        <div class="progress" data-r="progress">
          <div class="progress-title" data-r="ptitle"></div>
          <div class="bar"><i data-r="pbar" style="--c:#33e0ff"></i></div>
        </div>
        <div class="boss-bar" data-r="boss">
          <div class="bname"><span data-r="bname"></span><span class="pips" data-r="bpips"></span></div>
          <div class="bar seg3"><b data-r="bghost"></b><i data-r="bhp"></i></div>
          <div class="stab-row"><span class="lbl" data-r="bstate">STABILITY</span><div class="bar stab"><i data-r="bstab"></i></div></div>
          <div class="btitle" data-r="btitle"></div>
        </div>
        <div class="obj-ctx" data-r="ctx">
          <div class="h" data-r="ctxh"></div>
          <div class="o" data-r="ctxo"></div>
          <div class="bar"><i data-r="ctxb"></i></div>
          <div class="opt" data-r="ctxopt"></div>
        </div>
        <div class="duel-panel" data-r="duel"><div class="dh">DUEL</div><div class="dn" data-r="dueln"></div><div class="bar"><i data-r="duelhp"></i></div><div class="dtime"><i data-r="duelt"></i></div></div>
        <div class="enc-banner" data-r="banner"></div>
      </div>
      <div class="hud-tr">
        <div class="credits"><span data-r="cred">0</span> <small>CR</small></div>
        <div class="score-line" data-r="score"></div>
        <div class="shards" data-r="shards"></div>
        <div class="seed" data-r="seed"></div>
      </div>
      <div class="status-chips" data-r="chips"></div>
      <div class="combo" data-r="combo"><div class="l">COMBO</div><div class="x" data-r="combox">x1.0</div><div class="t" data-r="combot"></div><div class="bank" data-r="bank"></div></div>
      <div class="notify-zone" data-r="notify"></div>
      <div class="popup-zone" data-r="popups"></div>
      <div class="drift-meter" data-r="drift"><div>DRIFT <span class="dt" data-r="driftt">0.0</span></div><div class="track"><div class="zone" data-r="dzone"></div><div class="needle" data-r="dneedle"></div></div><div class="charge"><i data-r="dcharge"></i></div></div>
      <div class="res-row" data-r="res"></div>
      <div class="threats" data-r="threats"></div>
      <div class="dmg-dir" data-r="dmg"></div>
      <div class="hud-bottom">
        <div class="momentum-wrap">
          <div class="bar-label"><span>MOMENTUM</span><span data-r="momv">0</span></div>
          <div class="bar"><i data-r="mom"></i><div class="momentum-ticks"><span></span><span></span><span></span><span></span><span></span></div></div>
        </div>
        <div class="speedo" data-r="speedo"><canvas width="300" height="170"></canvas><div class="num" data-r="spd">0</div><div class="unit">KM/H</div></div>
        <div class="meters">
          <span>NITRO</span><div class="bar" style="--c:#33a8ff"><i data-r="nitro"></i></div><span class="val" data-r="nitrov">0</span>
          <span>HEAT</span><div class="bar" style="--c:#ff6a20"><i data-r="heat"></i></div><span class="val" data-r="heatv">0</span>
        </div>
      </div>
      <div class="ability left interactive" data-r="abq"><div class="tip" data-r="abqtip">PRESS Q</div><div class="ring"><div class="cd" data-r="abqcd"></div><div class="aicon" data-r="abqi"></div></div><div class="kc big">Q</div><div class="aname" data-r="abqn"></div><div class="cost" data-r="abqc"></div></div>
      <div class="ability right interactive" data-r="abe"><div class="tip" data-r="abetip">PRESS E</div><div class="ring"><div class="cd" data-r="abecd"></div><div class="aicon" data-r="abei"></div></div><div class="kc big">E</div><div class="aname" data-r="aben"></div><div class="cost" data-r="abec"></div></div>
      <div class="skill-callout" data-r="callout"></div>
      <div class="fps" data-r="fps"></div>
      <div class="debug panel interactive" data-r="debug"><div data-r="dbgtxt"></div><div class="dbg-tools" data-r="dbgbtn"></div></div>
    `;
    parent.appendChild(this.root);
    this.root.querySelectorAll<HTMLElement>('[data-r]').forEach((n) => (this.refs[n.dataset.r!] = n));
    this.speedCanvas = el<HTMLCanvasElement>(this.root, '.speedo canvas');
    this.speedCtx = this.speedCanvas.getContext('2d')!;
    this.refs.abq.addEventListener('click', () => this.onAbilityClick?.('q'));
    this.refs.abe.addEventListener('click', () => this.onAbilityClick?.('e'));
    for (let i = 0; i < 6; i++) {
      const a = document.createElement('div');
      a.className = 'threat';
      this.refs.threats.appendChild(a);
      this.threatEls.push(a);
    }
    this.buildDebugTools();
  }

  /** Material inspector output (debug overlay). */
  setInspector(html: string) {
    this.refs.dbginspect.innerHTML = html;
  }

  private buildDebugTools() {
    const encOpts = Object.values(ENCOUNTERS).map((e) => `<option value="${e.id}">${e.name}</option>`).join('');
    const bossOpts = Object.values(BOSSES).map((b) => `<option value="${b.id}">${b.name}</option>`).join('');
    this.refs.dbgbtn.innerHTML = `
      <div class="dbg-line"><span>ENCOUNTER</span><select data-dbg="enc">${encOpts}</select><button data-go="enc">PLAY</button></div>
      <div class="dbg-line"><span>BOSS</span><select data-dbg="boss">${bossOpts}</select><button data-go="boss">FIGHT</button></div>
      <div class="dbg-line"><span>BUILD</span>${BUILD_PRESETS.map((t) => `<button data-build="${t}">${t}</button>`).join('')}</div>
      <div class="dbg-line"><span>CHAOS</span>${['DEBRIS', 'ONCOMING', 'PILEUP'].map((k) => `<button data-cmd="chaos:${k}">${k}</button>`).join('')}</div>
      <div class="dbg-line"><span>VISUAL</span><button data-cmd="lab">LAB AHEAD</button><button data-cmd="labclear">CLEAR LAB</button></div>
      <div class="dbg-line"><span>VFX LAB</span>${LAB_EFFECTS.map((k) => `<button data-cmd="vfx:${k}">${k.toUpperCase()}</button>`).join('')}<button data-cmd="vfx:nopost">NO POST</button></div>
      <div class="dbg-line"><span>PHYSICS</span><button data-cmd="phys:lab">LAB TRACK</button><button data-cmd="phys:wet">WET</button><button data-cmd="phys:truck">TRUCK</button><button data-cmd="phys:cars">CARS</button><button data-cmd="phys:enemy">ENEMY</button><button data-cmd="phys:hud">READOUT</button><button data-cmd="phys:tests">RUN TESTS</button></div>
      <div class="dbg-line"><span>VIEW</span>${['normal', 'emissive', 'lighting', 'bloom', 'wireframe', 'nofog'].map((m) => `<button data-cmd="view:${m}">${m === 'nofog' ? 'FOG OFF' : m.toUpperCase()}</button>`).join('')}</div>
      <div class="dbg-inspect" data-r="dbginspect">click any surface to inspect its material</div>`;
    this.refs.dbginspect = this.refs.dbgbtn.querySelector('[data-r="dbginspect"]') as HTMLElement;
    this.refs.dbgbtn.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      if (b.dataset.build) this.onDebug?.('build:' + b.dataset.build);
      if (b.dataset.cmd) this.onDebug?.('cmd:' + b.dataset.cmd);
      const go = b.dataset.go;
      if (go) {
        const sel = this.refs.dbgbtn.querySelector<HTMLSelectElement>(`select[data-dbg="${go}"]`)!;
        this.onDebug?.(`${go}:${sel.value}`);
      }
      (document.activeElement as HTMLElement | null)?.blur();
    });
    this.refs.dbgbtn.addEventListener('keydown', (e) => e.stopPropagation());
  }

  show(on: boolean) {
    this.root.classList.toggle('on', on);
  }

  /** A CSS custom property on a HUD element, written only when it changes (every frame otherwise re-styles it). */
  private prop(key: string, name: string, val: string) {
    const k = key + name;
    if (this.cache.get(k) === val) return;
    this.cache.set(k, val);
    this.refs[key]?.style.setProperty(name, val);
  }

  private set(key: string, val: string, prop: 'text' | 'width' | 'html' | 'height' = 'text') {
    const k = key + prop;
    if (this.cache.get(k) === val) return;
    this.cache.set(k, val);
    const r = this.refs[key];
    if (!r) return;
    if (prop === 'text') r.textContent = val;
    else if (prop === 'html') r.innerHTML = val;
    else if (prop === 'width') r.style.width = val;
    else r.style.height = val;
  }

  private cls(key: string, c: string, on: boolean) {
    this.refs[key]?.classList.toggle(c, on);
  }

  notify(text: string, color = '#ffffff', big = false) {
    const now = performance.now();
    if ((this.lastNotif[text] ?? 0) + 900 > now) return;
    this.lastNotif[text] = now;
    const n = document.createElement('div');
    n.className = 'notif' + (big ? ' big' : '');
    n.style.color = color;
    n.textContent = text;
    const z = this.refs.notify;
    z.appendChild(n);
    while (z.children.length > 3) z.firstChild!.remove();
    setTimeout(() => n.remove(), 2300);
  }

  private popAt: Record<string, number> = {};
  popup(text: string, color = '#ffffff') {
    // de-duplicate: the same word twice in a second is noise
    const now = performance.now();
    if ((this.popAt[text] ?? -1e9) + 1000 > now) return;
    this.popAt[text] = now;
    const n = document.createElement('div');
    n.className = 'pop';
    n.style.color = color;
    n.textContent = text;
    const z = this.refs.popups;
    z.appendChild(n);
    while (z.children.length > 3) z.firstChild!.remove();
    setTimeout(() => n.remove(), 1400);
  }

  /** Hints queue: a new hint never wipes one the player has had less than ~3 s to read. */
  private hintQueue: string[] = [];
  private hintShownAt = -1e9;
  hint(text: string, _key: string) {
    if (this.hintQueue.includes(text)) return;
    const now = performance.now();
    if (now - this.hintShownAt < 3200) {
      if (this.hintQueue.length < 3) this.hintQueue.push(text);
      return;
    }
    this.showHint(text);
  }
  private showHint(text: string) {
    this.hintShownAt = performance.now();
    const n = document.createElement('div');
    n.className = 'hint panel';
    // key names in [brackets] are drawn as key caps
    n.innerHTML = text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!).replace(/\[([A-Z0-9 ]{1,8})\]/g, '<span class="kc">$1</span>');
    this.root.appendChild(n);
    this.root.querySelectorAll('.hint').forEach((h) => h !== n && h.remove());
    setTimeout(() => {
      n.remove();
      const next = this.hintQueue.shift();
      if (next) this.showHint(next);
    }, 4200);
  }

  toast(title: string, text: string) {
    const n = document.createElement('div');
    n.className = 'toast panel';
    n.innerHTML = `<b>${title}</b>${text}`;
    document.getElementById('ui')!.appendChild(n);
    setTimeout(() => n.remove(), 4600);
  }

  nearMiss(n: number, tier: number) {
    if (!this.nmEl) {
      this.nmEl = document.createElement('div');
      this.nmEl.className = 'big-counter nm';
      this.root.appendChild(this.nmEl);
    }
    const c = NM_COLOR[tier] ?? NM_COLOR[1];
    this.nmEl.innerHTML = `<div class="k t${tier}" style="color:${c};text-shadow:0 0 22px #33e0ff">${NM_TIER[tier] ?? NM_TIER[1]}${n > 1 ? ' x' + n : ''}</div>`;
    this.nmEl.style.display = 'block';
    this.nmTimer = 1.1;
  }

  chain(n: number) {
    if (!this.chainEl) {
      this.chainEl = document.createElement('div');
      this.chainEl.className = 'big-counter';
      this.chainEl.style.top = '25%';
      this.root.appendChild(this.chainEl);
    }
    this.chainEl.innerHTML = `<div class="k" style="color:#ffb020;text-shadow:0 0 26px #ff6a00">CHAIN REACTION x${n}</div>`;
    this.chainEl.style.display = 'block';
    this.chainTimer = 2;
  }

  /** Red edge flash pointing toward whatever hit you. angle: 0 = ahead, +/-PI = behind, + = left. */
  damageFrom(angle: number, amount: number) {
    if (amount < 2) return;
    const n = document.createElement('div');
    n.className = 'dmg-arc';
    n.style.transform = `rotate(${-angle}rad)`;
    n.style.opacity = `${clamp(amount / 20, 0.35, 1)}`;
    this.refs.dmg.appendChild(n);
    this.dmgEls.push(n);
    while (this.dmgEls.length > 4) this.dmgEls.shift()!.remove();
    setTimeout(() => n.remove(), 700);
  }

  bossIntro(name: string, title: string) {
    const n = document.createElement('div');
    n.className = 'boss-intro';
    n.innerHTML = `<div class="n">${name}</div><div class="t">${title}</div>`;
    this.root.appendChild(n);
    setTimeout(() => n.remove(), 2700);
  }

  private hudTL: Element | null = null;
  /** the items the build line was last drawn for */
  private buildItems: string[] = ['-'];
  reset() {
    this.buildItems = ['-'];
    this.refs.notify.innerHTML = '';
    this.refs.popups.innerHTML = '';
    this.refs.dmg.innerHTML = '';
    this.dmgEls = [];
    this.root.querySelectorAll('.hint,.boss-intro,.arrival-card').forEach((h) => h.remove());
    this.hintQueue = [];
    this.hintShownAt = -1e9;
    if (this.nmEl) this.nmEl.style.display = 'none';
    if (this.chainEl) this.chainEl.style.display = 'none';
    this.cls('boss', 'on', false);
    this.cache.clear();
  }

  update(dt: number, s: DrivingSession, fps: number, title: string) {
    const p = s.player;
    const run = s.run!;
    // HP / fuel
    const hpf = clamp(p.hp / p.maxHp, 0, 1);
    this.set('hp', `${hpf * 100}%`, 'width');
    this.set('hpghost', `${hpf * 100}%`, 'width');
    this.set('hpv', `${Math.ceil(p.hp)} / ${p.maxHp}`);
    this.prop('hp', '--c', hpf < 0.25 ? '#ff3a5c' : hpf < 0.5 ? '#ffb020' : '#58f0a0');
    this.hudTL ??= this.root.querySelector('.hud-tl');
    this.hudTL?.classList.toggle('hp-low', hpf < 0.25);
    this.set('fuel', `${p.fuel}%`, 'width');
    this.set('fuelv', p.fuel <= 0 ? 'EMPTY' : `${Math.ceil(p.fuel)}`);
    this.set('cred', `${run.credits}`);
    this.set('seed', `RUN #${run.seed}`);
    this.set('shards', s.shardCount ? `SHARDS ${'◆'.repeat(s.shardCount)}${'◇'.repeat(3 - s.shardCount)}` : '');

    this.root.classList.toggle('arriving', !!s.arrival);
    this.updateTop(s, title);

    // speed
    const kmh = Math.round(p.speed * KMH);
    this.set('spd', `${kmh}`);
    this.cls('speedo', 'fast', kmh > 160);
    this.cls('speedo', 'nitro', p.nitroActive);
    this.cls('speedo', 'capped', p.speed > CONFIG.DRIVE.SOFT_CAP);
    this.drawSpeedArc(p.speed / CONFIG.DRIVE.HARD_CAP);
    this.set('nitro', `${(p.nitro / p.stats.nitroCapacity) * 100}%`, 'width');
    this.set('nitrov', `${Math.round(p.nitro)}`);
    this.set('heat', `${p.heat}%`, 'width');
    this.set('heatv', p.overheatLock > 0 ? 'LOCK' : `${Math.round(p.heat)}`);
    this.set('mom', `${p.momentum}%`, 'width');
    this.set('momv', `${Math.floor(p.momentum)}`);
    this.ability('q', run.vehicle.special, s);
    this.ability('e', run.module, s);

    // build: archetype + active synergies (compact) — worked out again only when the items change
    let same = run.items.length === this.buildItems.length;
    for (let i = 0; same && i < run.items.length; i++) same = run.items[i] === this.buildItems[i];
    if (!same) {
      this.buildItems = [...run.items];
      this.set('arch', run.items.length ? run.archetype() : '');
      const syns = run.synergies();
      this.set('syns', syns.slice(0, 3).map((x) => `▸ ${x.name}`).join('<br>') + (syns.length > 3 ? `<br><span class="dim">+${syns.length - 3} MORE (TAB)</span>` : ''), 'html');
    }
    this.updateResources(s);

    // combo + bank (lost on a crash)
    this.cls('combo', 'on', s.combo >= 1);
    this.set('combox', `x${s.comboMult.toFixed(1)}`);
    this.set('score', `${run.stats.score.toLocaleString('en-US')} PTS`);
    this.set('combot', `${clamp(s.comboTimer / CONFIG.COMBO.DECAY_TIME, 0, 1) * 100}%`, 'width');
    this.set('bank', s.comboBank >= 1 ? `BANK ${Math.round(s.comboBank)} CR · CRASH = LOSE IT` : '');

    // drift meter + charge
    this.cls('drift', 'on', p.drifting);
    if (p.drifting) {
      const a = Math.abs(p.driftAngle);
      const wide = p.mods.perfectWiden;
      const max = 1.2;
      this.refs.dzone.style.left = `${((CONFIG.DRIFT.PERFECT_MIN - wide) / max) * 100}%`;
      this.refs.dzone.style.width = `${((CONFIG.DRIFT.PERFECT_MAX - CONFIG.DRIFT.PERFECT_MIN + wide * 2) / max) * 100}%`;
      this.refs.dneedle.style.left = `${clamp(a / max, 0, 1) * 100}%`;
      this.set('driftt', p.driftTime.toFixed(1));
      this.set('dcharge', `${clamp(p.driftCharge, 0, 100)}%`, 'width');
      this.cls('drift', 'perfect', p.inPerfect);
    }

    // threats outside the view
    for (let i = 0; i < this.threatEls.length; i++) {
      const t = s.threats[i];
      const e = this.threatEls[i];
      if (!t) {
        e.style.display = 'none';
        continue;
      }
      e.style.display = 'block';
      e.style.transform = `rotate(${-t.angle}rad) translateY(-34vh)`;
      e.classList.toggle('attack', t.attacking);
      e.style.opacity = `${clamp(1.2 - t.dist / 45, 0.35, 1)}`;
    }

    // status chips
    const chips: string[] = [];
    if (p.systemsLock > 0) chips.push('<span style="color:#6688ff">SYSTEMS JAMMED</span>');
    if (p.overheatLock > 0) chips.push('<span style="color:#ff6a20">OVERHEATED</span>');
    if (p.fuel <= 0) chips.push('<span style="color:#ffb020">NO FUEL</span>');
    else if (p.fuel < 20) chips.push('<span style="color:#ffb020">LOW FUEL</span>');
    if (p.phase > 0) chips.push('<span style="color:#b9a6ff">PHASED</span>');
    if (p.bulldozer > 0) chips.push('<span style="color:#ffb020">BULLDOZER</span>');
    if (p.slipstream > 0) chips.push('<span style="color:#80c0ff">SLIPSTREAM</span>');
    if (p.stuckTime > CONFIG.PLAYER.STUCK_TIME) chips.push('<span style="color:#fff">PRESS R TO RESET</span>');
    this.set('chips', chips.join(''), 'html');

    if (this.nmTimer > 0) {
      this.nmTimer -= dt;
      if (this.nmTimer <= 0 && this.nmEl) this.nmEl.style.display = 'none';
    }
    if (this.chainTimer > 0) {
      this.chainTimer -= dt;
      if (this.chainTimer <= 0 && this.chainEl) this.chainEl.style.display = 'none';
    }
    this.cls('fps', 'on', this.fpsOn || this.debugOn);
    if (this.fpsOn || this.debugOn) this.set('fps', `${fps.toFixed(0)} FPS`);
    this.cls('debug', 'on', this.debugOn);
    if (this.debugOn) this.updateDebug(s, fps);
  }

  /** Top-centre: route progress, the encounter you're in, or the boss. */
  private updateTop(s: DrivingSession, title: string) {
    const p = s.player;
    const boss = s.boss && s.config.mode === 'BOSS' && !s.boss.vehicle.removed && (s.boss.state !== 'INTRO' || s.bossIntroT > 0) ? s.boss : null;
    this.cls('boss', 'on', !!boss);
    this.refs.progress.style.display = boss ? 'none' : '';
    if (boss) {
      const h = boss.hud();
      this.set('bname', h.name);
      this.set('bpips', Array.from({ length: h.phases }, (_, i) => (i < h.phase - 1 ? '◆' : i === h.phase - 1 ? '◈' : '◇')).join(' '));
      this.set('bhp', `${h.hp * 100}%`, 'width');
      this.set('bghost', `${h.hp * 100}%`, 'width');
      const vul = h.state === 'VULNERABLE' || h.state === 'BREAK';
      this.set('bstab', `${(vul ? h.vuln : h.stability) * 100}%`, 'width');
      this.set('bstate', vul ? 'VULNERABLE' : h.state === 'TELEGRAPH' ? 'ATTACK INCOMING' : 'STABILITY');
      this.cls('boss', 'vuln', vul);
      this.cls('boss', 'tele', h.state === 'TELEGRAPH' || h.state === 'ATTACK');
      let sub = h.title;
      if (h.race) sub = `${h.race.pos === 1 ? 'P1 — YOU LEAD' : 'P2 — APEX LEADS'} · GAP ${Math.abs(h.race.gap).toFixed(0)} M · SECTORS ${h.race.sector}`;
      this.set('btitle', sub);
      this.cls('ctx', 'on', true);
      this.set('ctxh', h.prompt ? 'THE DRIVER CALLS' : 'HOW TO HURT IT');
      this.set('ctxo', h.objective);
      this.set('ctxb', `${(h.prompt ? h.prompt.progress : vul ? h.vuln : 1 - h.stability) * 100}%`, 'width');
      this.set('ctxopt', h.prompt ? `TIME ${Math.round(h.prompt.time * 100)}%` : '');
      this.cls('ctx', 'urgent', vul);
      this.set('banner', '');
      return;
    }
    const fin = s.director.finishS > 0 ? s.director.finishS : s.world.finishS > 0 ? s.world.finishS : 0;
    if (fin > 0) {
      this.set('pbar', `${clamp(p.s / fin, 0, 1) * 100}%`, 'width');
      this.set('ptitle', `${title} · <b>${Math.max(0, Math.round((fin - p.s) / 10) * 10)} M</b>`, 'html');
    } else {
      this.set('pbar', '0%', 'width');
      this.set('ptitle', `${title} · ${s.encountersDone} CLEARED`, 'html');
    }
    const du = s.chase.info();
    this.cls('duel', 'on', !!du && !s.arrival);
    if (du) {
      this.set('dueln', `${du.name} · ${Math.round(du.dist)} M`);
      this.set('duelhp', `${clamp(du.hp, 0, 1) * 100}%`, 'width');
      this.set('duelt', `${clamp(du.time, 0, 1) * 100}%`, 'width');
    }
    const o = s.director.hudObjective();
    this.cls('ctx', 'on', !!o);
    this.cls('ctx', 'urgent', false);
    if (o) {
      this.prop('ctx', '--ec', o.color);
      const pr = o.primary;
      this.set('ctxh', o.title);
      const timer = pr.timer !== undefined ? ` · ${Math.max(0, pr.timer).toFixed(1)}s` : '';
      this.set('ctxo', pr.label + (pr.done ? ' ✓' : pr.failed ? ' ✗' : '') + timer);
      this.set('ctxb', `${clamp(pr.progress / Math.max(1, pr.target), 0, 1) * 100}%`, 'width');
      const op = o.optional;
      this.set('ctxopt', op ? `BONUS: ${op.label} ${op.done ? '✓' : op.failed ? '✗' : `${Math.floor(op.progress)}/${op.target}`}` : '');
    }
    const b = s.director.banner;
    this.set('banner', b ? b.text : '');
    if (b) this.refs.banner.style.color = b.color;
  }

  /** Archetype resources: only the ones your build actually uses are shown. */
  private updateResources(s: DrivingSession) {
    const parts: string[] = [];
    const r = s.res;
    if (s.usesRes('mass')) parts.push(`<div class="res mass"><b>MASS</b>${Array.from({ length: r.massMax }, (_, i) => `<i class="${i < Math.floor(r.mass) ? 'on' : ''}"></i>`).join('')}</div>`);
    if (s.usesRes('charge')) parts.push(`<div class="res charge"><b>CHARGE</b><span class="m"><i style="width:${Math.round(s.player.driftCharge)}%"></i></span></div>`);
    if (s.usesRes('velocity')) parts.push(`<div class="res vel"><b>VELOCITY</b><span class="m"><i style="width:${Math.round(r.velocity)}%"></i></span></div>`);
    if (s.usesRes('static')) parts.push(`<div class="res stat${r.static >= 99 ? ' full' : ''}"><b>STATIC</b><span class="m"><i style="width:${Math.round(r.static)}%"></i></span></div>`);
    if (s.tagCount('GHOST') > 0) parts.push(`<div class="res ghost${s.player.phase > 0 ? ' full' : ''}"><b>PHASE</b><span class="m"><i style="width:${Math.round(clamp(s.player.phase / 2, 0, 1) * 100)}%"></i></span>${r.phaseHits ? ` <small>×${r.phaseHits}</small>` : ''}</div>`);
    this.set('res', parts.join(''), 'html');
  }

  private updateDebug(s: DrivingSession, fps: number) {
    const p = s.player;
    const run = s.run!;
    const tc = run.tagCounts();
    const enc = s.director.current;
    const bh = s.boss?.hud();
    this.set('dbgtxt', [
      `<b>DEBUG</b> (F1/\` to close)`,
      `FPS ${fps.toFixed(1)} · mode ${s.config.mode} · seed ${run.seed} · zone ${s.zone.name}`,
      `seg ${s.world.segmentAt(p.s)?.type ?? '-'} · s ${p.s.toFixed(0)} d ${p.d.toFixed(1)} · finish ${s.director.finishS.toFixed(0)}`,
      `speed ${(p.speed * KMH).toFixed(0)} km/h · vF ${p.vF.toFixed(1)} vL ${p.vL.toFixed(1)} · grip ${p.gripLoad.toFixed(2)}${p.sliding ? ' SLIDE' : ''}`,
      `HP ${p.hp.toFixed(1)}/${p.maxHp} · fuel ${p.fuel.toFixed(1)} · mom ${p.momentum.toFixed(0)} · combo ${s.combo.toFixed(1)} bank ${s.comboBank.toFixed(0)}`,
      `enc ${enc ? `${enc.def.id} [${enc.state}] t=${enc.t.toFixed(1)}` : '-'} · done ${s.encountersDone} won ${s.encountersWon} · chaos ${s.chaos.state} · duel ${s.chase.duel ? s.chase.duel.v.kind : '-'} · music ${s.audio.musicSection}`,
      bh ? `boss ${bh.state} ph${bh.phase} hp ${(bh.hp * 100).toFixed(0)}% stab ${(bh.stability * 100).toFixed(0)}%` : 'boss -',
      `vehicles ${s.vehicles.length} (hostile ${s.vehicles.filter((v) => v.hostile && !v.dead).length}) · props ${s.world.props.length} · hazards ${s.combat.hazards.length}`,
      `res mass ${s.res.mass.toFixed(1)} vel ${s.res.velocity.toFixed(0)} static ${s.res.static.toFixed(0)} charge ${p.driftCharge.toFixed(0)}`,
      `tags ${Object.entries(tc).map(([k, v]) => `${k}:${v}`).join(' ') || '-'} · ${run.items.length} items`,
      ...p.contactLog.slice(-3).map((r) => `<span style="color:#ffb060">${formatContact(r)}</span>`),
      `keys: 1 credits · 2 heal · 3 fuel · 4 item · 5 enemy · 6 tp+300 · 7 boss break · 8 finish · 9 god · 0 contact log → console`,
    ].join('<br>'), 'html');
  }

  private ability(slot: 'q' | 'e', id: AbilityId, s: DrivingSession) {
    const def = ABILITIES[id];
    const key = slot === 'q' ? 'abq' : 'abe';
    const cd = s.combat.cooldowns[slot];
    const cost = s.combat.abilityCost(id);
    this.set(key + 'i', def.icon);
    this.set(key + 'n', def.name);
    this.prop(key, '--ac', def.color);
    // the ring fills with momentum; full ring = usable
    const charge = clamp(s.player.momentum / Math.max(1, cost), 0, 1);
    this.prop(key, '--p', charge.toFixed(3));
    const cdFrac = cd > 0 ? cd / (def.cooldown * s.player.stats.abilityCooldown) : 0;
    this.prop(key, '--cd', clamp(cdFrac, 0, 1).toFixed(3));
    const ready = cd <= 0 && charge >= 1 && s.player.systemsLock <= 0;
    this.set(key + 'c', ready ? 'READY' : cd > 0 ? `${cd.toFixed(1)}s` : `CHARGING ${Math.floor(charge * 100)}%`);
    this.cls(key, 'ready', ready);
    this.cls(key, 'nomo', charge < 1);
    this.cls(key, 'useful', ready && s.skillUseful[slot]);
  }

  /** "Q AFTERBURNER READY — speed burst · every ram is perfect": once, the first time a skill can be used. */
  skillCallout(key: string, name: string, pitch: string, color: string) {
    const c = this.refs.callout;
    c.style.setProperty('--ac', color);
    c.innerHTML = `<span class="kc big">${key}</span><div><b>${name} READY</b><small>${pitch}</small></div>`;
    c.classList.remove('on');
    void c.offsetWidth;
    c.classList.add('on');
  }

  /** Arrival result: a short beat between the climax and the reward screen. */
  arrivalCard(title: string, sub: string, stats: [string, string][], color: string) {
    const n = document.createElement('div');
    n.className = 'arrival-card';
    n.style.setProperty('--ac', color);
    n.innerHTML = `<div class="t">${title}</div><div class="s">${sub}</div><div class="st">${stats.map(([k, v]) => `<div><b>${v}</b><span>${k}</span></div>`).join('')}</div>`;
    this.root.appendChild(n);
    setTimeout(() => n.remove(), 2600);
  }

  /** Flash a dock when its skill fires. */
  skillFired(slot: 'q' | 'e') {
    const el = this.refs[slot === 'q' ? 'abq' : 'abe'];
    el.classList.remove('fired');
    void el.offsetWidth;
    el.classList.add('fired');
  }

  private lastArc = -1;
  private drawSpeedArc(f: number) {
    f = clamp(f, 0, 1);
    if (Math.abs(f - this.lastArc) < 0.004) return;
    this.lastArc = f;
    const c = this.speedCtx;
    const W = 300, H = 170;
    c.clearRect(0, 0, W, H);
    const cx = W / 2, cy = H - 10, r = 120;
    const a0 = Math.PI * 1.08, a1 = Math.PI * 1.92;
    c.lineWidth = 6;
    c.strokeStyle = 'rgba(40,50,80,0.6)';
    c.beginPath();
    c.arc(cx, cy, r, a0, a1);
    c.stroke();
    // soft-cap zone: beyond it, speed costs more
    const sc = CONFIG.DRIVE.SOFT_CAP / CONFIG.DRIVE.HARD_CAP;
    c.strokeStyle = 'rgba(255,60,120,0.35)';
    c.beginPath();
    c.arc(cx, cy, r + 8, a0 + (a1 - a0) * sc, a1);
    c.stroke();
    const grad = c.createLinearGradient(cx - r, 0, cx + r, 0);
    grad.addColorStop(0, '#33e0ff');
    grad.addColorStop(0.7, '#a080ff');
    grad.addColorStop(1, '#ff2bd6');
    c.strokeStyle = grad;
    c.shadowColor = '#33e0ff';
    c.shadowBlur = 10;
    c.beginPath();
    c.arc(cx, cy, r, a0, a0 + (a1 - a0) * f);
    c.stroke();
    c.shadowBlur = 0;
    c.lineWidth = 2;
    c.strokeStyle = 'rgba(160,190,255,0.45)';
    for (let i = 0; i <= 10; i++) {
      const a = a0 + ((a1 - a0) * i) / 10;
      c.beginPath();
      c.moveTo(cx + Math.cos(a) * (r - 12), cy + Math.sin(a) * (r - 12));
      c.lineTo(cx + Math.cos(a) * (r - 4), cy + Math.sin(a) * (r - 4));
      c.stroke();
    }
  }

  nodeTitle(type: string) {
    return NODE_INFO[type as keyof typeof NODE_INFO]?.label ?? type;
  }
}

