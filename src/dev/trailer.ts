import type * as THREE from 'three';
import { VEHICLES } from '../data/vehicles';
import type { EnemyKind } from '../data/enemies';
import type { Game } from '../game/game';
import type { DrivingSession } from '../game/driving';
import type { DuelBlow, DuelScript } from '../world/duelStage';

/**
 * The pitch trailer (debug builds: `zm.trailer()`, or `npm run trailer`, which drives this from a browser and cuts
 * the film). The game plays for real: the QA autopilot drives, and every shot stages its own moment — a road, the part
 * cards, the map, a boss, the garage, the Solana sign-in, the street, a PvP duel, the depot, the weekly Shift.
 *
 * The browser tab itself is recorded (getDisplayMedia on the current tab, full screen), so the menus are in the
 * picture. Each shot is its own clip, recorded `XF` seconds longer than its slot so the edit can dissolve into the
 * next one; scripts/trailer.mjs joins them with transitions under an original soundtrack cut to the same plan
 * (scripts/trailer-music.mjs). The game's own music is off while recording; its sound effects stay, under the track.
 * The titles are a transparent canvas on top of the page.
 */

const W = 1920;
const H = 1080;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));

interface Caption {
  /** seconds into the shot */
  at: number;
  /** seconds on screen */
  len: number;
  kicker?: string;
  title: string;
  /** 'logo' = the big centred title; 'low' = lower third (road shots); 'band' = a bar at the bottom (menu shots) */
  kind?: 'logo' | 'low' | 'center' | 'band';
  color?: string;
}

interface Shot {
  name: string;
  /** seconds this shot holds in the finished film (a multiple of half a second: the cuts land on the beat) */
  len: number;
  /** the transition into this shot (an ffmpeg xfade name) */
  trans?: string;
  /** 'film' = a road: letterbox, vignette, no HUD; 'ui' = a screen of the game as the player sees it; 'card' = the end */
  look: 'film' | 'ui' | 'card';
  captions: Caption[];
  /** dark wash over the picture (0..1) */
  dim?: number;
  /** puts the moment on screen (recorder off) */
  setup: (g: TG, game: Game) => void | Promise<void>;
  /** off-the-record settle time after setup, ms */
  preroll?: number;
  /** every frame while recorded (t = seconds into the shot) */
  stage?: (g: TG, t: number) => void;
  /** a clean 3D still (no UI, no titles) for the README, this far into the shot */
  still?: { name: string; at: number };
  /** a screenshot of the whole page (UI included) for the README, taken when the shot ends */
  snap?: string;
}

/** each clip runs this much past its slot: the length of the dissolve into the next shot */
export const XF = 0.4;

type TG = {
  launchRun(seed: number): void;
  startDrive(m: string): void;
  showMap(): void;
  offerReward(tier: number, title: string, sub: string, done: () => void): void;
  openBuild(back: () => void): void;
  showSignIn(): void;
  toMainMenu(): void;
  toGarage(tab: string): void;
  showGarageCar(id: string): void;
  playDuel(script: DuelScript, outcome: { won: boolean; draw: boolean; prize: string; stake: string; opponent: string }): void;
  closeDuel(): void;
  run: { zoneIndex: number; vehicle: unknown; addItem(id: string): void; items: unknown[] } | null;
  state: string;
  qaBot: boolean;
  qaDrift: boolean;
  autoPause: () => void;
  debugForced?: string[];
  save: { tutorialDone: boolean; settings: { autoQuality: boolean; quality: number; music: number } };
  warm?: { run(): Promise<void> };
  applySettings?: () => void;
  resize?: () => void;
  session: DrivingSession;
  renderer: THREE.WebGLRenderer;
  audio: { ctx: AudioContext | null; init(): void; volumes: { master: number; music: number; sfx: number }; applyVolumes(): void };
  input: { virtualPress(a: 'ability1' | 'ability2'): void };
};

const ACCENT = '#33e0ff';
const HOT = '#ff3d7f';
const GOLD = '#ffd23a';
const VIOLET = '#b07cff';

/** spawns a few enemies ahead so the shot has something to hit */
function enemiesAhead(s: DrivingSession, kinds: EnemyKind[], gap = 30) {
  const p = s.player;
  kinds.forEach((k, i) => s.spawnEnemyAt(k, p.s + gap + i * 14, ((i % 3) - 1) * 3.4, p.vF * 0.8));
}

/** fires at `first` seconds, then every `period` */
function everyFn() {
  const next: Record<string, number> = {};
  return (key: string, t: number, period: number, first: number) => {
    if (next[key] === undefined) next[key] = first;
    if (t < next[key]) return false;
    next[key] = t + period;
    return true;
  };
}

/** a road in a region, driven by the autopilot */
function drive(zone: number, vehicle: string, mode: 'ROAD' | 'BOSS', encounter?: string, drift = false) {
  return (g: TG) => {
    const run = g.run!;
    run.zoneIndex = zone;
    const v = VEHICLES.find((x) => x.id === vehicle);
    if (v) run.vehicle = v;
    if (encounter) g.debugForced = [encounter];
    g.startDrive(mode);
    g.qaBot = true;
    g.qaDrift = drift;
    g.session.godMode = true;
  };
}

/** a staged street duel for the pit: the same renderer the server's battles play through */
function duelScript(): DuelScript {
  const car = (id: string, name: string, color?: number) => {
    const v = VEHICLES.find((x) => x.id === id)!;
    return { name, model: (v.model === 'rammer' ? 'player_rammer' : v.model) as DuelScript['cars'][0]['model'], color: color ?? v.color, accent: v.accent, maxHp: 120, label: v.name };
  };
  // three blows: the knockout lands inside the shot
  const blows: DuelBlow[] = [
    { by: 1, zone: 'front', brace: 'side', outcome: 'hit', damage: 26, hp: [94, 120], round: 1 },
    { by: 0, zone: 'side', brace: 'front', outcome: 'crit', damage: 58, hp: [94, 62], round: 1 },
    { by: 0, zone: 'side', brace: 'rear', outcome: 'crit', damage: 62, hp: [94, 0], round: 2 },
  ];
  return { cars: [car('rammer', 'YOU', 0xd4a017), car('ghost', 'NIGHT SHIFT')], blows, winner: 0 };
}

/**
 * The edit. Slots are on a 120 BPM grid (a beat is half a second, a bar two): the music is cut to the same plan.
 * 0 open · 4 the road (combat, drift, chaos) · 14 the run (parts, build, map) · 22 boss · 26 the street · 46 end.
 */
function buildShots(): Shot[] {
  const every = everyFn();
  return [
    {
      // cold open: the city at night, one line, then the title on the beat
      name: 'open', len: 4, look: 'film', dim: 0.35, still: { name: 'hero', at: 3.0 },
      setup: drive(3, 'ghost', 'ROAD', 'TRAFFIC_WAVE'),
      captions: [
        { at: 0.2, len: 1.6, title: 'EVERY NIGHT THE CITY REBUILDS ITSELF.', kind: 'center' },
        { at: 2.0, len: 2.2, kicker: 'DRIVE · ADAPT · SURVIVE', title: 'ZERO MILE', kind: 'logo' },
      ],
    },
    {
      name: 'combat', len: 4, trans: 'fadewhite', look: 'film', still: { name: 'combat', at: 2.6 },
      setup: drive(1, 'rammer', 'ROAD', 'CONVOY'),
      captions: [{ at: 0.3, len: 3.4, kicker: 'NO GUNS. NO AUTO-FIRE.', title: 'YOUR CAR IS THE WEAPON', kind: 'low', color: HOT }],
      stage: (g, t) => {
        if (every('e1', t, 1.8, 0.05)) enemiesAhead(g.session, ['interceptor', 'rammer', 'gunner'], 24);
      },
    },
    {
      name: 'drift', len: 3, trans: 'fade', look: 'film', still: { name: 'drift', at: 2.0 },
      setup: drive(2, 'courier', 'ROAD', 'PURSUIT', true),
      captions: [{ at: 0.3, len: 2.5, kicker: 'DRIFT · RAM · NEAR MISS · LURE', title: 'DRIVING IS THE COMBAT', kind: 'low', color: ACCENT }],
      stage: (g, t) => {
        if (every('e2', t, 2.0, 0.3)) enemiesAhead(g.session, ['hunter', 'interceptor'], 32);
        if (every('sk2', t, 2.0, 1.0)) {
          g.session.player.momentum = 100;
          g.input.virtualPress('ability1');
        }
      },
    },
    {
      name: 'chaos', len: 3, trans: 'fade', look: 'film', still: { name: 'chaos', at: 2.0 },
      setup: drive(3, 'ghost', 'ROAD', 'HAZARD_RUN'),
      captions: [{ at: 0.3, len: 2.5, kicker: 'DEBRIS · WRONG-WAY TRUCKS · BROKEN BRIDGES', title: 'THE ROAD FIGHTS BACK', kind: 'low', color: GOLD }],
      stage: (g, t) => {
        const s = g.session;
        if (every('c3', t, 1.4, 0.1)) s.chaos.debugFire((['DEBRIS', 'ONCOMING', 'PILEUP'] as const)[Math.floor(t / 1.4) % 3] as never);
        if (every('x3', t, 1.0, 0.5)) {
          const o = { x: 0, y: 0, z: 0 };
          s.world.road.toWorld(s.player.s + 24, ((Math.floor(t * 3) % 3) - 1) * 3.5, o);
          s.combat.explode(o.x, o.z, 6, 20, { byPlayer: true, hurtsPlayer: false });
        }
      },
    },
    {
      // the part cards over the frozen road
      name: 'reward', len: 3, trans: 'fadeblack', look: 'ui', snap: 'parts', preroll: 900,
      setup: (g) => {
        g.qaBot = false;
        g.offerReward(2, 'ROAD CLEARED', 'CHOOSE ONE PART', () => {});
      },
      captions: [{ at: 0.3, len: 2.6, kicker: 'AFTER EVERY ROAD', title: 'PICK 1 OF 3 PARTS — EACH ONE CHANGES HOW YOU DRIVE', kind: 'band', color: ACCENT }],
    },
    {
      name: 'build', len: 2.5, trans: 'smoothleft', look: 'ui', preroll: 700,
      setup: (g) => {
        const run = g.run!;
        for (const id of ['iron_plow', 'deadweight', 'shock_bumper', 'wrecking_ball', 'reactive_armor', 'slide_saw', 'kinetic_plating', 'static_chassis']) run.addItem(id);
        g.session.refreshBuild?.();
        g.openBuild(() => {});
      },
      captions: [{ at: 0.3, len: 2.1, kicker: '35 PARTS · 6 ARCHETYPES', title: 'STACK A BUILD — UNLOCK SYNERGIES THAT CHANGE THE RULES', kind: 'band', color: HOT }],
    },
    {
      name: 'map', len: 2.5, trans: 'smoothleft', look: 'ui', snap: 'map', preroll: 1600,
      setup: (g) => {
        g.run!.zoneIndex = 2;
        g.showMap();
      },
      captions: [{ at: 0.3, len: 2.1, kicker: 'ONE RUN = ONE NIGHT', title: 'CHOOSE YOUR ROUTE ACROSS FIVE REGIONS', kind: 'band', color: GOLD }],
    },
    {
      name: 'boss', len: 4, trans: 'fadeblack', look: 'film', still: { name: 'boss', at: 2.8 },
      setup: drive(4, 'hauler', 'BOSS'),
      captions: [{ at: 0.3, len: 3.4, kicker: 'FIVE BOSSES', title: 'EVERY BOSS IS A DRIVING PROBLEM', kind: 'low', color: HOT }],
      stage: (g, t) => {
        if (every('sk5', t, 1.6, 0.8)) {
          g.session.player.momentum = 100;
          g.input.virtualPress(t % 2 < 1 ? 'ability1' : 'ability2');
        }
      },
    },
    {
      // the garage turntable, cycling the chassis on the beat
      name: 'garage', len: 2.5, trans: 'fadewhite', look: 'ui', still: { name: 'garage', at: 0.3 }, preroll: 1400,
      setup: (g) => {
        g.qaBot = false;
        g.toGarage('VEHICLES');
      },
      stage: (g, t) => {
        if (every('car', t, 0.5, 0.5)) g.showGarageCar(['rammer', 'ghost', 'hauler', 'courier'][Math.floor(t / 0.5) % 4]);
      },
      captions: [{ at: 0.3, len: 2.1, kicker: 'THE GARAGE', title: '4 CHASSIS · PAINTS · PERMANENT UPGRADES · ARCHIVE', kind: 'band', color: ACCENT }],
    },
    {
      name: 'signin', len: 2.5, trans: 'smoothleft', look: 'ui', snap: 'signin', preroll: 1200,
      setup: (g) => g.showSignIn(),
      captions: [{ at: 0.3, len: 2.1, kicker: 'PHANTOM · SOLFLARE · ANY WALLET STANDARD WALLET', title: 'SIGN IN WITH A SOLANA WALLET — ONE FREE SIGNATURE', kind: 'band', color: VIOLET }],
    },
    {
      name: 'menu', len: 2.5, trans: 'smoothleft', look: 'ui', snap: 'street', preroll: 2200,
      setup: (g) => g.toMainMenu(),
      captions: [{ at: 0.3, len: 2.1, kicker: 'SALVAGE AND MileToken BALANCES · WALLET · LIVE CHALLENGES', title: 'THE STREET IS ON THE FIRST SCREEN', kind: 'band', color: HOT }],
    },
    {
      name: 'street', len: 2.5, trans: 'smoothleft', look: 'ui', snap: 'duels', preroll: 2200,
      setup: (g) => g.toGarage('STREET'),
      captions: [{ at: 0.3, len: 2.1, kicker: 'TUNE · PLAN · POST OR TAKE A CHALLENGE', title: 'ASYNC PvP STREET DUELS', kind: 'band', color: HOT }],
    },
    {
      name: 'duel', len: 5, trans: 'fade', look: 'ui', still: { name: 'duel', at: 2.6 }, preroll: 300,
      setup: (g) => g.playDuel(duelScript(), { won: true, draw: false, prize: '100 SALVAGE', stake: '50 SALVAGE', opponent: 'NIGHT SHIFT' }),
      captions: [{ at: 0.3, len: 4.6, kicker: 'THE SERVER DECIDES · STAKES IN SALVAGE OR MileToken', title: 'RAM IT OUT IN THE PIT', kind: 'band', color: GOLD }],
    },
    {
      name: 'depot', len: 2.5, trans: 'fade', look: 'ui', snap: 'depot', preroll: 2200,
      setup: (g) => {
        g.closeDuel();
        g.toGarage('DEPOT');
      },
      captions: [{ at: 0.3, len: 2.1, kicker: 'SUPPLIES · CARS · LIVERIES · CRATES · PLAYER MARKET', title: 'THE DEPOT — SPEND MileToken, THE GAME\u2019S SOLANA TOKEN', kind: 'band', color: VIOLET }],
    },
    {
      name: 'shift', len: 2.5, trans: 'smoothleft', look: 'ui', preroll: 2200,
      setup: (g) => g.toGarage('PLAY'),
      captions: [{ at: 0.3, len: 2.1, kicker: 'ONE SEED FOR EVERY DRIVER · DAILY CONTRACTS · THE DRIVER HUNT', title: 'THE WEEKLY SHIFT — RANKED', kind: 'band', color: GOLD }],
    },
    {
      name: 'end', len: 4, trans: 'fadeblack', look: 'card', preroll: 200, captions: [],
      setup: () => {},
    },
  ];
}

/** how far the picture extends past the 16:9 title frame on each side (a screen that is not 16:9) */
let bleedX = 0;
let bleedY = 0;

/** draws the titles of one moment */
export function drawCaption(c: CanvasRenderingContext2D, cap: Caption, local: number) {
  const t = local - cap.at;
  if (t < 0 || t > cap.len) return;
  const fadeIn = Math.min(1, t / 0.3);
  const fadeOut = Math.min(1, (cap.len - t) / 0.3);
  const a = Math.max(0, Math.min(fadeIn, fadeOut));
  const ease = 1 - Math.pow(1 - fadeIn, 3);
  const color = cap.color ?? ACCENT;
  c.save();
  c.globalAlpha = a;
  c.textBaseline = 'alphabetic';
  if (cap.kind === 'logo') {
    c.textAlign = 'center';
    c.font = `700 ${190 + 20 * (1 - ease)}px Rajdhani, sans-serif`;
    c.shadowColor = 'rgba(51,224,255,0.75)';
    c.shadowBlur = 50;
    c.fillStyle = '#fff';
    drawSpaced(c, cap.title, W / 2, H / 2 + 40, 26);
    c.shadowBlur = 0;
    if (cap.kicker) {
      c.font = '700 40px Rajdhani, sans-serif';
      c.fillStyle = color;
      drawSpaced(c, cap.kicker, W / 2, H / 2 + 120, 14);
    }
  } else if (cap.kind === 'center') {
    c.font = '700 64px Rajdhani, sans-serif';
    c.shadowColor = 'rgba(0,0,0,0.9)';
    c.shadowBlur = 18;
    c.fillStyle = cap.color ?? '#fff';
    drawSpaced(c, cap.title, W / 2, H / 2 + 20, 6, W - 200);
  } else if (cap.kind === 'band') {
    // a dark bar along the bottom, over the game's own screen
    const h = 176;
    const y0 = H - h + 40 * (1 - ease);
    const g = c.createLinearGradient(0, y0 - 60, 0, H);
    g.addColorStop(0, 'rgba(4,6,12,0)');
    g.addColorStop(0.3, 'rgba(4,6,12,0.88)');
    g.addColorStop(1, 'rgba(4,6,12,0.95)');
    c.fillStyle = g;
    c.fillRect(-bleedX, y0 - 60, W + 2 * bleedX, h + 60 + bleedY);
    c.fillStyle = color;
    c.fillRect(W / 2 - 60, y0 + 8, 120, 4);
    c.shadowColor = 'rgba(0,0,0,0.9)';
    c.shadowBlur = 10;
    if (cap.kicker) {
      c.font = '700 30px Rajdhani, sans-serif';
      c.fillStyle = color;
      drawSpaced(c, cap.kicker, W / 2, y0 + 56, 6, W - 200);
    }
    c.font = '700 60px Rajdhani, sans-serif';
    c.fillStyle = '#fff';
    drawSpaced(c, cap.title, W / 2, y0 + 122, 3, W - 160);
  } else {
    // lower third: a coloured bar, a kicker and a title sliding in from the left
    const x = 120 - 60 * (1 - ease);
    const y = H - 210;
    c.fillStyle = color;
    c.fillRect(x - 28, y - 96, 8, 136);
    c.shadowColor = 'rgba(0,0,0,0.85)';
    c.shadowBlur = 16;
    if (cap.kicker) {
      c.font = '700 34px Rajdhani, sans-serif';
      c.fillStyle = color;
      drawSpaced(c, cap.kicker, x, y - 52, 6, W - 260, 'left');
    }
    c.font = '700 76px Rajdhani, sans-serif';
    c.fillStyle = '#fff';
    drawSpaced(c, cap.title, x, y + 28, 4, W - 260, 'left');
  }
  c.restore();
}

/** text with tracking; shrinks to fit maxW */
function drawSpaced(c: CanvasRenderingContext2D, text: string, x: number, y: number, track: number, maxW = W - 120, align: 'center' | 'left' = 'center') {
  c.letterSpacing = `${track}px`;
  const w = c.measureText(text).width;
  const k = w > maxW ? maxW / w : 1;
  c.save();
  c.translate(align === 'center' ? x - (w * k) / 2 : x, y);
  c.scale(k, k);
  c.textAlign = 'left';
  c.fillText(text, 0, 0);
  c.restore();
  c.letterSpacing = '0px';
}

export function drawEndCard(c: CanvasRenderingContext2D, t: number) {
  const a = Math.min(1, t / 0.4);
  c.fillStyle = '#05060b';
  c.fillRect(-bleedX, -bleedY, W + 2 * bleedX, H + 2 * bleedY);
  const g = c.createRadialGradient(W / 2, H * 0.62, 10, W / 2, H * 0.62, W * 0.6);
  g.addColorStop(0, `rgba(51,224,255,${0.18 * a})`);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = g;
  c.fillRect(-bleedX, -bleedY, W + 2 * bleedX, H + 2 * bleedY);
  c.save();
  c.globalAlpha = a;
  c.textAlign = 'center';
  c.font = '700 200px Rajdhani, sans-serif';
  c.shadowColor = 'rgba(51,224,255,0.8)';
  c.shadowBlur = 60;
  c.fillStyle = '#fff';
  drawSpaced(c, 'ZERO MILE', W / 2, H / 2 - 10, 28);
  c.shadowBlur = 0;
  c.font = '700 40px Rajdhani, sans-serif';
  c.fillStyle = ACCENT;
  drawSpaced(c, 'A 3D ARCADE DRIVING ROGUELITE · IN THE BROWSER', W / 2, H / 2 + 80, 10);
  c.globalAlpha = Math.max(0, Math.min(1, (t - 0.5) / 0.5));
  c.font = '600 34px Barlow, sans-serif';
  c.fillStyle = '#c8d0e0';
  drawSpaced(c, 'SOLANA WALLET SIGN-IN  ·  PvP STREET DUELS  ·  MileToken ON SOLANA', W / 2, H / 2 + 170, 3);
  c.font = '700 30px Rajdhani, sans-serif';
  c.fillStyle = GOLD;
  drawSpaced(c, 'AN iDos GAMES TITLE  ·  BUILT ON SOLANA', W / 2, H / 2 + 240, 8);
  c.restore();
}

/** a fresh browser profile has no session: a guest on the sandbox drives */
async function ensureSignedIn(game: Game) {
  const { idos } = await import('../idos/platform');
  if (idos.online) return;
  let r = await idos.guest(false);
  for (let i = 0; i < 4 && !r.ok; i++) {
    await wait(2000 * (i + 1));
    r = await idos.guest(false);
  }
  if (!r.ok) throw new Error(`trailer: no session (${r.error})`);
  game.signedIn(r.account);
  for (let i = 0; i < 300 && game.state !== 'MAIN_MENU'; i++) await wait(100);
}

/**
 * The tab, as a media stream (picture and sound). Capturing needs a click: a full-window button waits for one
 * (`npm run trailer` clicks it; by hand, you do). The browser asks which tab unless it was started with
 * --auto-accept-this-tab-capture.
 */
async function captureTab(): Promise<MediaStream> {
  const btn = document.createElement('button');
  btn.id = 'zm-trailer-start';
  btn.textContent = 'CLICK TO START RECORDING THE TRAILER';
  btn.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,0.85);color:#33e0ff;font:700 48px Rajdhani,sans-serif;letter-spacing:0.2em;border:0;cursor:pointer';
  document.body.appendChild(btn);
  const stream = await new Promise<MediaStream>((resolve, reject) => {
    btn.onclick = async () => {
      btn.remove();
      // full screen first: the tab is then exactly the screen, with no browser bars in the picture
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
      await wait(700);
      navigator.mediaDevices
        .getDisplayMedia({
          // a larger screen is scaled down to 1080p for the encoder
          video: { width: { max: W }, height: { max: H }, frameRate: 60, cursor: 'never', resizeMode: 'crop-and-scale' } as MediaTrackConstraints,
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
          preferCurrentTab: true,
          selfBrowserSurface: 'include',
          surfaceSwitching: 'exclude',
          systemAudio: 'exclude',
        } as DisplayMediaStreamOptions)
        .then(resolve, reject);
    };
  });
  return stream;
}

export interface TrailerOpts {
  /** recorder bitrate (bits/s) */
  bitrate?: number;
  /** progress lines (the npm script prints them) */
  log?: (m: string) => void;
}

/** what the npm script needs to cut the film */
export interface TrailerPlan {
  xf: number;
  shots: { name: string; len: number; trans: string; file: string }[];
}

/**
 * Hands a finished clip over: to `window.zmClip` when `npm run trailer` is listening (in chunks, as base64), or as a
 * download when the trailer runs by hand.
 */
async function deliver(file: string, blob: Blob) {
  const sink = (window as unknown as { zmClip?: (file: string, part: number, b64: string, last: boolean) => Promise<void> }).zmClip;
  if (!sink) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = file;
    document.body.appendChild(a);
    a.click();
    a.remove();
    return;
  }
  const CHUNK = 3 << 20;
  const buf = new Uint8Array(await blob.arrayBuffer());
  for (let i = 0, part = 0; i < buf.length || part === 0; i += CHUNK, part++) {
    const slice = buf.subarray(i, Math.min(buf.length, i + CHUNK));
    let bin = '';
    for (let j = 0; j < slice.length; j += 0x8000) bin += String.fromCharCode(...slice.subarray(j, j + 0x8000));
    await sink(file, part, btoa(bin), i + CHUNK >= buf.length);
  }
}

export async function recordTrailer(game: Game, o: TrailerOpts = {}): Promise<{ plan: TrailerPlan; stills: Record<string, string> }> {
  const log = o.log ?? ((m: string) => console.log(`[trailer] ${m}`));
  const g = game as unknown as TG;
  await ensureSignedIn(game);
  await g.warm?.run();
  g.autoPause = () => {};
  g.save.tutorialDone = true;
  g.save.settings.autoQuality = false;
  g.save.settings.quality = 3;
  // the film has its own soundtrack: the game's music is off, its sound effects stay
  const musicWas = g.save.settings.music;
  g.save.settings.music = 0;
  g.applySettings?.();
  g.audio.volumes.music = 0;
  g.audio.applyVolumes();
  g.resize?.();
  const css = document.createElement('style');
  css.textContent = 'body.zm-film #hud { visibility: hidden !important; } body.zm-trailer * { cursor: none !important; }';
  document.head.appendChild(css);
  document.body.classList.add('zm-trailer');

  // the titles: a transparent canvas over the whole page, the same shape as the screen; the titles sit in its
  // centred 16:9 frame (the film is cropped to it), the washes and bars cover all of it
  const out = document.createElement('canvas');
  out.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483646;pointer-events:none';
  document.body.appendChild(out);
  const c = out.getContext('2d')!;
  let CW = W;
  let CH = H;
  const fit = () => {
    const aspect = innerWidth / Math.max(1, innerHeight);
    if (aspect >= W / H) {
      CH = H;
      CW = Math.round(H * aspect);
    } else {
      CW = W;
      CH = Math.round(W / aspect);
    }
    if (out.width !== CW || out.height !== CH) {
      out.width = CW;
      out.height = CH;
    }
    bleedX = (CW - W) / 2;
    bleedY = (CH - H) / 2;
  };
  fit();
  const black = () => {
    fit();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, CW, CH);
    c.fillStyle = '#000';
    c.fillRect(0, 0, CW, CH);
  };
  black();

  log('waiting for the tab capture…');
  const stream = await captureTab();
  g.audio.init();
  if (g.audio.ctx?.state === 'suspended') await g.audio.ctx.resume();
  if (!stream.getAudioTracks().length) log('the capture has no sound track — only the soundtrack will be heard');

  // open one run on the server; every road is then a drive inside it
  g.launchRun(9100);
  for (let i = 0; i < 400 && !g.run; i++) await wait(50);
  if (!g.run) throw new Error('trailer: the run did not open');

  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
  const src = g.renderer.domElement;
  const stills: Record<string, string> = {};
  const grab = document.createElement('canvas');
  grab.width = W;
  grab.height = H;
  const snap = (window as unknown as { zmSnap?: (name: string) => Promise<void> }).zmSnap;

  /** the overlay for one frame of a shot */
  const overlay = (shot: Shot, t: number, first: boolean) => {
    fit();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, CW, CH);
    if (shot.look === 'card') {
      c.translate(bleedX, bleedY);
      drawEndCard(c, t);
      return;
    }
    // only the very first shot fades up from black: every other cut is a transition in the edit
    const dim = Math.max(shot.dim ?? 0, first ? Math.max(0, 1 - t / 0.5) : 0);
    if (dim > 0) {
      c.fillStyle = `rgba(0,0,0,${dim})`;
      c.fillRect(0, 0, CW, CH);
    }
    if (shot.look === 'film') {
      const v = c.createRadialGradient(CW / 2, CH / 2, H * 0.35, CW / 2, CH / 2, Math.max(CW, CH) * 0.55);
      v.addColorStop(0, 'rgba(0,0,0,0)');
      v.addColorStop(1, 'rgba(0,0,0,0.45)');
      c.fillStyle = v;
      c.fillRect(0, 0, CW, CH);
      c.fillStyle = '#000';
      c.fillRect(0, 0, CW, bleedY + 64);
      c.fillRect(0, CH - bleedY - 64, CW, bleedY + 64);
    }
    c.translate(bleedX, bleedY);
    for (const cap of shot.captions) drawCaption(c, cap, t);
  };

  const shots = buildShots();
  const plan: TrailerPlan = { xf: XF, shots: [] };
  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i];
    const last = i === shots.length - 1;
    log(`shot ${i + 1}/${shots.length}: ${shot.name}`);
    black();
    document.body.classList.toggle('zm-film', shot.look === 'film');
    try {
      await shot.setup(g, game);
    } catch (e) {
      log(`  setup failed, skipping: ${(e as Error).message}`);
      continue;
    }
    // pre-roll: the road builds and the car gets up to speed, the panel gets its server data — off the record
    const pre = performance.now() + (shot.preroll ?? 2400);
    while (performance.now() < pre) {
      await nextFrame();
      black();
    }
    // the shot's first picture is on screen before the recorder starts (no stale frame from the pre-roll)
    overlay(shot, 0, i === 0);
    const settle = performance.now() + 150;
    while (performance.now() < settle) await nextFrame();

    // one clip per shot, running XF past its slot for the dissolve into the next
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: o.bitrate ?? 16_000_000, audioBitsPerSecond: 192_000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = new Promise<void>((r) => (rec.onstop = () => r()));
    rec.start(250);
    const seconds = shot.len + (last ? 0 : XF);
    const t0 = performance.now();
    while (true) {
      await nextFrame();
      const t = (performance.now() - t0) / 1000;
      if (t >= seconds) break;
      if (shot.look === 'film' && g.state !== 'DRIVING' && g.state !== 'BOSS') {
        log(`  the road ended early (${g.state})`);
        break;
      }
      try {
        shot.stage?.(g, t);
      } catch (e) {
        log(`  stage: ${(e as Error).message}`);
      }
      if (shot.still && !stills[shot.still.name] && t >= shot.still.at) {
        // the middle 16:9 of the game canvas
        const sw = Math.min(src.width, (src.height * W) / H);
        const sh = (sw * H) / W;
        grab.getContext('2d')!.drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, 0, 0, W, H);
        stills[shot.still.name] = grab.toDataURL('image/jpeg', 0.9);
      }
      overlay(shot, t, i === 0);
    }
    rec.stop();
    await stopped;
    const file = `clip-${String(i).padStart(2, '0')}-${shot.name}.webm`;
    await deliver(file, new Blob(chunks, { type: mime || 'video/webm' }));
    plan.shots.push({ name: shot.name, len: shot.len, trans: shot.trans ?? 'fade', file });
    // a screenshot of the screen as the player sees it (no titles), off the record
    if (shot.snap && snap) {
      fit();
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, CW, CH);
      await nextFrame();
      await snap(shot.snap).catch(() => {});
    }
  }
  for (const tr of stream.getTracks()) tr.stop();
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
  g.qaBot = false;
  g.save.settings.music = musicWas;
  g.applySettings?.();
  out.remove();
  log('done');
  return { plan, stills };
}

/** records the trailer's clips; the plan and the stills wait in `window.zmTrailer` */
export async function runTrailer(game: Game, o: TrailerOpts = {}) {
  const r = await recordTrailer(game, o);
  (window as unknown as { zmTrailer: unknown }).zmTrailer = r;
  return r.plan;
}
