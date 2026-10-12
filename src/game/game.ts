import * as THREE from 'three';
import { AudioEngine } from '../audio/audio';
import { BOSSES } from '../bosses/bosses';
import { buildBossRig } from '../bosses/bossRig';
import { COLLISION_MATERIALS, IMPACT } from '../core/collision';
import { TONE } from '../render/visualBudget';
import { inspectMaterial, MaterialViews, type ViewMode } from '../render/debugViews';
import { CONFIG } from '../core/config';
import { DEBUG_ENABLED } from '../core/debug';
import { Input } from '../core/input';
import { newSeed, Random } from '../core/random';
import { ABILITIES } from '../data/abilities';
import { ENEMIES, TRAFFIC_KINDS, type EnemyKind, type ModelKind } from '../data/enemies';
import { EVENTS, type EventCtx, type EventDef } from '../data/events';
import { getItem, ITEMS, type ItemDef } from '../data/items';
import { ACHIEVEMENTS, UNLOCKS } from '../data/meta';
import type { Rarity, VehicleDef } from '../data/types';
import { BASE_STATS, getVehicle, PAINTS, VEHICLES } from '../data/vehicles';
import { ZONES, type BossId } from '../data/zones';
import { Effects } from '../effects/particles';
import { PostFX } from '../effects/postfx';
import { PlayerCar } from '../player/player';
import { defaultSave, type SaveData } from '../save/save';
import { HUD } from '../ui/hud';
import * as S from '../ui/screens';
import { buildCar, variantCount } from '../vehicles/carModels';
import { ShaderWarmup } from '../render/warmup';
import { RENDER_SCALE, ResolutionGovernor } from '../render/quality';
import { Environment } from '../world/environment';
import { renderLineup, type LineupOpts } from '../render/lineup';
import { prewarmAssets } from '../assets/prewarm';
import { GarageScene } from '../world/garageScene';
import { World } from '../world/world';
import { setSmokeRenderScale } from '../world/smoke';
import { vfxTexturesAll } from '../effects/vfxTextures';
import { perf } from '../core/perf';
import { ChaseCamera } from './camera';
import { DrivingSession, type DriveMode, type NodeResult, type SessionHost } from './driving';
import { RunState, type MapNode } from './run';
import { Online, type DuelOutcome } from './online';
import * as ST from '../ui/street';
import { shiftSeed } from '../idos/economy';
import * as IG from '../idos/garage';
import * as P from '../idos/profile';
import { idos, onPlatformSite, type Account } from '../idos/platform';
import { walletOptions } from '../idos/wallets';
import { accountModal, connectionScreen, LoginScreen, type AccountView, type LoginOptions } from '../ui/login';
import type { DuelScript } from '../world/duelStage';

export type GameState =
  | 'BOOT' | 'SIGN_IN' | 'MAIN_MENU' | 'GARAGE' | 'RUN_PREP' | 'MAP' | 'DRIVING' | 'EVENT' | 'SHOP' | 'BOSS'
  | 'PAUSE' | 'GAME_OVER' | 'VICTORY' | 'REWARD';

type UiHandler = (action: string, el: HTMLElement) => void;

/** a single line while the server answers */
const loadingLine = (text: string) => `<div class="screen" style="align-items:center;justify-content:center;font-family:var(--display);letter-spacing:0.4em;color:var(--accent)">${text}</div>`;

const TUTORIAL_KEYS = ['drive', 'nitro', 'ram', 'drift', 'drift2', 'momentum', 'pickup', 'build'];

/** Per-zone grade (multiplies the image): sodium warmth, flood teal, old-town violet, skyway steel, zero red. */
const ZONE_GRADE: Record<string, [number, number, number]> = {
  industrial: [1.04, 1.0, 0.94],
  flood: [0.95, 1.02, 1.05],
  oldcity: [1.03, 0.96, 1.04],
  skyway: [0.96, 1.0, 1.06],
  zeromile: [1.05, 0.95, 0.97],
};

export class Game implements SessionHost {
  state: GameState = 'BOOT';
  private returnState: GameState = 'MAIN_MENU';
  renderer: THREE.WebGLRenderer;
  worldScene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(62, 1, 0.1, 1600);
  cam: ChaseCamera;
  post: PostFX;
  world: World;
  env: Environment;
  fx: Effects;
  audio = new AudioEngine();
  input = new Input();
  hud: HUD;
  garage: GarageScene;
  session: DrivingSession;
  save: SaveData;
  run: RunState | null = null;
  ui: HTMLElement;
  overlay: HTMLElement;
  tutorialFlags = new Set<string>();
  customSeed: string | null = null;
  private garageTab = 'PLAY';
  private handler: UiHandler | null = null;
  private keyHandler: ((code: string) => void) | null = null;
  private last = performance.now();
  private fpsAvg = 60;
  private shop: { stock: (ItemDef | null)[]; prices: number[]; rerolls: number } | null = null;
  private pendingNode: MapNode | null = null;
  private inGarageScene = false;
  private menuZone = 0;
  private settingsReturn: (() => void) | null = null;
  private buildReturn: (() => void) | null = null;
  private views!: MaterialViews;
  /** iDos Games: the street economy, duels, the weekly Shift (game/online.ts) */
  online!: Online;
  /** the night market's under-the-counter shelf was already opened at this stop */
  shopVoucherUsed = false;
  /** signing in (ui/login.ts) */
  login: LoginScreen;
  /** a session is open and the account's progression has been read into the save */
  private hydrated = false;
  /** a line under the garage tabs: what the server said about the last garage action */
  garageNote: { text: string; good: boolean } | null = null;
  /** garage purchases in flight */
  busy = new Set<string>();
  /** a run the server has not recorded yet (connection lost, session ended): sent again when it can be */
  private unrecorded: { ticket: string; report: P.RunReport } | null = null;
  /** the run being recorded right now: the next run opens only after it */
  private recording: Promise<P.FinishResult | null> | null = null;
  private opening = false;

  constructor(canvas: HTMLCanvasElement, uiRoot: HTMLElement) {
    // the device's settings now; the driver's progression once a session is open (idos/profile.ts)
    this.save = defaultSave();
    this.save.settings = P.loadSettings();
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.toneMapping = TONE.mapping;
    this.renderer.toneMappingExposure = TONE.exposure;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // shader error checks read the compile logs back synchronously (a stall per program): debug builds only
    this.renderer.debug.checkShaderErrors = DEBUG_ENABLED;
    this.cam = new ChaseCamera(this.camera);
    this.post = new PostFX(this.renderer, this.worldScene, this.camera);
    this.world = new World(this.worldScene);
    // build the authored model caches while the title and garage idle
    prewarmAssets();
    this.env = new Environment(this.worldScene, this.renderer);
    this.fx = new Effects(this.worldScene);
    // upload the effect textures now: an upload on first use is a visible hitch in the middle of an explosion
    for (const t of vfxTexturesAll()) this.renderer.initTexture(t);
    this.garage = new GarageScene(this.renderer);
    this.ui = uiRoot;
    this.overlay = document.createElement('div');
    this.overlay.id = 'overlay';
    this.hud = new HUD(uiRoot);
    uiRoot.appendChild(this.overlay);
    this.hud.onAbilityClick = (slot) => this.input.virtualPress(slot === 'q' ? 'ability1' : 'ability2');
    this.hud.onDebug = (cmd) => this.debugCommand(cmd);
    this.views = new MaterialViews(this.worldScene, (on) => this.post.setBloomOnly(on));
    // debug material inspector: click a surface while the F1 overlay is open
    canvas.addEventListener('mousedown', (e) => {
      if (!this.hud.debugOn) return;
      const r = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, this.camera);
      const hit = ray.intersectObjects(this.worldScene.children, true).find((h) => (h.object as THREE.Mesh).isMesh && h.object.visible);
      this.hud.setInspector(hit ? inspectMaterial(hit, this.worldScene) : 'nothing under the cursor');
    });
    this.session = new DrivingSession(this.worldScene, this.world, this.env, this.fx, this.audio, this.cam, null, this);
    // balances and owned things follow the account (registered before the garage panels re-draw on the same event)
    idos.on(() => {
      if (this.hydrated && idos.online) P.applyAccount(this.save);
    });
    idos.onSessionLost = () => this.sessionLost();
    this.online = new Online(this);
    this.login = new LoginScreen(this);
    this.warm = this.queueWarmup();

    // UI delegation
    uiRoot.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const a = t.closest<HTMLElement>('[data-a],[data-node],[data-item],[data-buy],[data-opt],[data-s]');
      if (!a || (a as HTMLButtonElement).disabled) return;
      this.audio.init();
      this.audio.click();
      if (a.dataset.s !== undefined) this.applySetting(a.dataset.s, a.dataset.v ?? '');
      else this.handler?.(a.dataset.a ?? (a.dataset.node !== undefined ? 'node' : a.dataset.buy !== undefined ? 'buy' : a.dataset.item !== undefined ? 'item' : 'opt'), a);
    });
    uiRoot.addEventListener('input', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.dataset.s) this.applySetting(t.dataset.s, t.value, true);
      if (t.id === 'seed-input') this.customSeed = t.value.replace(/\D/g, '') || null;
    });
    uiRoot.addEventListener('mouseover', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('.btn,.card,.node-wrap.avail');
      if (t && !t.contains(e.relatedTarget as Node)) this.audio.hover();
      const n = (e.target as HTMLElement).closest<HTMLElement>('[data-tip]');
      const tip = document.getElementById('map-tip');
      if (n && tip) tip.textContent = n.dataset.tip ?? '';
    });
    this.input.onAnyKey = (code) => {
      this.audio.init();
      this.keyHandler?.(code);
    };
    window.addEventListener('resize', () => this.resize());
    // hidden frame profiler: ?perf or F9
    perf.gpuInit(this.renderer.getContext() as WebGL2RenderingContext);
    this.renderer.info.autoReset = false;
    if (new URLSearchParams(location.search).has('perf')) perf.on = true;
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'F9') return;
      perf.on = !perf.on;
      if (!perf.on) {
        this.perfEl?.remove();
        this.perfEl = null;
      }
    });
    window.addEventListener('blur', () => this.autoPause());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.autoPause();
    });
    window.addEventListener('pointerdown', () => this.audio.init(), { once: true });
    this.applySettings();
    this.resize();
  }

  // ---------------------------------------------------------------- lifecycle

  /** boot: the shader warm-up and the iDos session in parallel; the first screen is the menu, or signing in */
  async start(stage: (msg: string) => void = () => {}) {
    const session = idos.resume();
    // the city behind the boot screen (and behind signing in)
    this.startAttract(this.menuZone);
    this.setState('SIGN_IN');
    // every shader the game can draw compiles in parallel behind the boot screen: a first visit used to freeze on the
    // first frame for seconds, and then again at the first enemy, explosion and boss. A frame drawn while a program it
    // needs is still compiling waits for it, so the title starts once all of them are ready.
    await this.warm.run();
    // and the post chain's own shaders: one full frame while the boot screen is still up
    this.post.render(0);
    const loop = () => {
      requestAnimationFrame(loop);
      this.frame();
    };
    loop();
    stage('SIGNING IN…');
    await this.afterResume(await session);
  }

  private async afterResume(r: Awaited<ReturnType<typeof idos.resume>>) {
    if (r === 'online') await this.enterGame(true);
    else if (r === 'needs-login') this.showSignIn(idos.lastError && idos.lastError !== 'timeout' ? { notice: 'SIGN IN AGAIN TO CONTINUE.' } : {});
    else this.showConnection();
  }

  /** a session is open: read the account, bring an old browser save onto it once, then the menu */
  private async enterGame(resumed: boolean) {
    this.show(loadingLine('OPENING THE GARAGE…'), null);
    const sv = await P.hydrate(this.save.settings);
    if (!sv) {
      this.showConnection();
      return;
    }
    this.save = sv;
    this.hydrated = true;
    const imported = await P.importLegacy();
    if (imported) P.applyAccount(this.save);
    const late = this.unrecorded ? await this.recordRun() : null;
    this.tutorialFlags.clear();
    if (this.save.tutorialDone) TUTORIAL_KEYS.forEach((k) => this.tutorialFlags.add(k));
    this.menuZone = Math.floor(Math.random() * (Math.min(this.save.best.zone, 4) + 1));
    this.applySettings();
    this.online.start();
    idos.client?.analytics.logEvent('session_start', { method: idos.account?.kind ?? 'unknown' });
    this.toMainMenu();
    if (imported) this.hud.toast('WELCOME BACK', imported);
    if (late?.ok) this.hud.toast('RUN RECORDED', `Your last run paid +${late.salvage} SALVAGE`);
    // a guest who just chose to play as a guest is not asked again straight away
    // the street, once per account; otherwise a guest may be invited to sign in properly
    if (!this.save.streetIntroSeen) this.showStreetIntro();
    else if (resumed) this.inviteGuest();
  }

  /** once per account, on the menu: what the street is (PvP, the ranked week, MileToken, contracts) and where it lives */
  private showStreetIntro() {
    setTimeout(() => {
      if (this.state !== 'MAIN_MENU' || this.save.streetIntroSeen) return;
      const seen = () => {
        this.save.streetIntroSeen = true;
        P.savePrefs(this.save);
      };
      this.show(ST.streetIntro(), (a) => {
        seen();
        if (a === 'duels') this.toGarage('STREET');
        else this.toMainMenu();
      }, (code) => {
        if (code !== 'Escape') return;
        seen();
        this.toMainMenu();
      });
    }, 900);
  }

  /** a guest is asked to sign in with a real account at most once a day, on the menu */
  private inviteGuest() {
    if (idos.account?.kind !== 'guest') return;
    const KEY = 'zeromile.guestInvite';
    let last = 0;
    try {
      last = Number(localStorage.getItem(KEY) ?? 0);
    } catch {
      return;
    }
    if (Date.now() - last < 24 * 3600 * 1000) return;
    setTimeout(() => {
      if (this.state !== 'MAIN_MENU' || idos.account?.kind !== 'guest') return;
      try {
        localStorage.setItem(KEY, String(Date.now()));
      } catch {
        /* storage unavailable */
      }
      this.showSignIn({ upgrade: true });
    }, 1500);
  }

  /** the sign-in screen over the night city */
  showSignIn(opts: LoginOptions = {}) {
    this.run = null;
    this.useGarageScene(false);
    if (!this.session.attract) this.startAttract(this.menuZone);
    this.setState('SIGN_IN');
    this.audio.setMusic('menu', ZONES[this.menuZone].music.root, ZONES[this.menuZone].music.scale, ZONES[this.menuZone].music.bpm);
    this.login.show(opts);
  }

  /** LoginHost: a sign-in went through */
  signedIn(_account: Account) {
    void this.enterGame(false);
  }

  /** LoginHost: a guest declined the invitation */
  stayGuest() {
    this.toMainMenu();
  }

  /** the server cannot be reached: a retry, never a different game */
  private showConnection() {
    this.hydrated = false;
    this.run = null;
    this.useGarageScene(false);
    if (!this.session.attract) this.startAttract(this.menuZone);
    this.setState('SIGN_IN');
    this.show(connectionScreen(idos.lastError ? `(${idos.lastError.slice(0, 90)})` : ''), (a) => {
      if (a !== 'retry') return;
      this.show(loadingLine('CONNECTING…'), null);
      void idos.resume().then((r) => this.afterResume(r));
    }, (code) => code === 'Enter' && this.overlay.querySelector<HTMLElement>('[data-a="retry"]')?.click());
  }

  /** the session ended under the game (expired, or signed in elsewhere): sign in again, never in the middle of a run */
  private sessionLost() {
    this.hydrated = false;
    if (this.run || this.state === 'GAME_OVER' || this.state === 'VICTORY') return;
    this.showSignIn({ notice: 'THE SESSION ENDED — SIGN IN AGAIN.' });
  }

  /** menus need the account: without one, the sign-in screen (or the connection screen) comes instead */
  private needsAccount() {
    if (this.hydrated && idos.online) return false;
    if (idos.status === 'unreachable') this.showConnection();
    else this.showSignIn(idos.status === 'signed-out' ? { notice: 'SIGN IN TO CONTINUE.' } : {});
    return true;
  }

  // ---------------------------------------------------------------- the account panel

  openAccount(back: () => void) {
    const view: AccountView = { wallets: null, note: null, busy: false, picking: null };
    const render = () => {
      if (this.overlay.querySelector('.acct') || view.wallets === null) this.show(accountModal(view), handler, (code) => code === 'Escape' && !view.busy && back());
      const form = this.overlay.querySelector<HTMLFormElement>('form.acct-name');
      form?.addEventListener('submit', (e) => {
        e.preventDefault();
        handler('acct-name', form);
      });
    };
    const busy = async (fn: () => Promise<void>) => {
      view.busy = true;
      view.note = null;
      render();
      await fn();
      view.busy = false;
      render();
    };
    const link = (optionId: string | null) => busy(async () => {
      view.picking = null;
      const err = await idos.linkWallet(optionId);
      view.note = err ? { text: err, good: false } : { text: 'WALLET LINKED', good: true };
      view.wallets = await idos.linkedWallets();
    });
    const handler = (a: string, el: HTMLElement) => {
      if (view.busy) return;
      switch (a) {
        case 'acct-close':
          back();
          break;
        case 'acct-signout':
          idos.logout();
          this.hydrated = false;
          this.showSignIn();
          break;
        case 'acct-upgrade':
          this.showSignIn({ upgrade: true });
          break;
        case 'acct-link': {
          if (onPlatformSite()) {
            void link(null);
            break;
          }
          const list = walletOptions();
          if (list.length === 1) void link(list[0].id);
          else {
            view.picking = list;
            view.note = list.length ? null : { text: 'NO SOLANA WALLET IN THIS BROWSER — INSTALL PHANTOM, SOLFLARE OR BACKPACK', good: false };
            render();
          }
          break;
        }
        case 'acct-pick':
          void link(el.dataset.v ?? null);
          break;
        case 'acct-name': {
          const name = (document.getElementById('acct-name') as HTMLInputElement | null)?.value.trim() ?? '';
          if (name.length < 3) {
            view.note = { text: 'THE NAME NEEDS 3 TO 20 CHARACTERS', good: false };
            render();
            break;
          }
          void busy(async () => {
            const r = await idos.setName(name, (m) => (view.note = { text: m, good: false }));
            if (r) view.note = { text: 'NAME SAVED', good: true };
          });
          break;
        }
      }
    };
    render();
    void idos.linkedWallets().then((w) => {
      view.wallets = w;
      if (this.overlay.querySelector('.acct')) render();
    });
  }

  /** Shader warm-up (render/warmup.ts): every kind of car, the boss rigs, the road's materials, pickups, hazards. */
  private warm: ShaderWarmup;
  private warmWait = false;
  private queueWarmup() {
    const w = new ShaderWarmup(this.renderer, this.worldScene, this.camera, () => this.post.composer.readBuffer);
    const paint = { color: 0x30343c, accent: 0x40a0ff };
    const heroes = ['courier', 'player_rammer', 'ghost', 'hauler'] as const;
    w.add({ name: 'player cars', build: () => heroes.map((k) => buildCar(k, { ...paint, beams: true, underglow: true, role: 'player' }).group) });
    w.add({
      name: 'enemies',
      build: () => (Object.keys(ENEMIES) as EnemyKind[]).flatMap((k) => [false, true].map((elite) => buildCar(k, { ...paint, beams: k === 'hunter' || k === 'interceptor', role: 'enemy', elite }).group)),
    });
    w.add({
      name: 'traffic',
      build: () => {
        const kinds = [...new Set<ModelKind>([...TRAFFIC_KINDS, 'police'])];
        const cars = kinds.flatMap((k) => Array.from({ length: variantCount(k) }, (_, v) => buildCar(k, { ...paint, role: 'traffic', variant: v }).group));
        // the escort van drives with its beams on
        cars.push(buildCar('van', { ...paint, beams: true }).group);
        return cars;
      },
    });
    w.add({
      name: 'bosses',
      build: () => Object.values(BOSSES).map((d) => {
        const m = buildCar(d.model, { color: d.color, accent: d.accent, beams: true });
        buildBossRig(d.id, m, this.fx);
        return m.group;
      }),
    });
    w.add({ name: 'road', build: () => this.world.warmObjects() });
    w.add({ name: 'session', build: () => this.session.warmObjects() });
    w.add({ name: 'garage', scene: this.garage.scene, camera: this.garage.camera, self: true, build: () => heroes.map((k) => buildCar(k, { ...paint, underglow: true, beams: false, role: 'player' }).group) });
    return w;
  }

  /** render resolution: the preset's ceiling, and the AUTO governor inside it (render/quality.ts) */
  private res = new ResolutionGovernor();
  private resize() {
    const w = window.innerWidth, h = window.innerHeight;
    const st = this.save.settings;
    this.res.setCeiling(RENDER_SCALE.ceiling(st.quality, window.devicePixelRatio || 1), st.autoQuality);
    perf.gpuAlways = st.autoQuality;
    this.applyRenderScale(w, h);
  }

  private applyRenderScale(w = window.innerWidth, h = window.innerHeight) {
    const pr = this.res.scale;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.garage.resize(w, h);
    this.post.setSize(w, h, pr);
    const gl = this.renderer.getContext();
    const ptRange = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array | null;
    this.fx.setViewportHeight(h * pr, Math.min(512, ptRange ? ptRange[1] : 128));
    setSmokeRenderScale(pr);
  }

  private errors = 0;
  private frame() {
    try {
      this.frameInner();
    } catch (e) {
      // never let a single bad frame kill the game loop
      if (this.errors++ < 5) console.error('[frame]', e);
      this.input.endFrame();
    }
  }

  private frameInner() {
    const now = performance.now();
    perf.frameBegin(now);
    if (perf.on) this.renderer.info.reset();
    const interval = now - this.last;
    const rawDt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.fpsAvg += (1 / Math.max(rawDt, 1e-4) - this.fpsAvg) * 0.05;
    this.input.update();
    if (this.qaBot) this.applyQaBot();
    this.handleGlobalInput();

    const s = this.state;
    const driving = s === 'DRIVING' || s === 'BOSS';
    if (driving) {
      perf.begin('sim');
      this.session.update(rawDt, this.input);
      perf.end('sim');
      perf.begin('hud');
      this.hud.update(rawDt, this.session, this.fpsAvg, this.nodeTitle());
      perf.end('hud');
    } else if (this.inGarageScene) {
      this.garage.update(rawDt);
    } else if (s === 'SIGN_IN' || s === 'MAIN_MENU' || s === 'MAP' || s === 'SHOP' || s === 'EVENT' || s === 'GAME_OVER' || s === 'VICTORY' || (s === 'REWARD' && this.session.attract)) {
      this.session.update(rawDt, this.input);
    } else if (s === 'REWARD' && this.session.arrival) {
      // the arrival keeps playing behind the reward screen: rain, smoke, the car settling — not a frozen frame
      this.session.update(rawDt, this.input);
    } else if (s === 'PAUSE' || s === 'REWARD') {
      // frozen world, keep camera still
    }
    perf.begin('env');
    this.env.update(rawDt, this.camera, performance.now() / 1000, { x: this.session.player?.velX ?? 0, z: this.session.player?.velZ ?? 0 });
    perf.end('env');

    // post uniforms
    const u = this.post.u;
    const p = this.session.player;
    const reduced = this.save.settings.reducedEffects;
    // shadows take the zone's fog colour: dark amber, teal, magenta — never flat black
    u.lift.value.setHex(this.inGarageScene ? 0x101018 : this.session.config?.zone.fog ?? 0x101018).multiplyScalar(0.18);
    const gr = ZONE_GRADE[this.inGarageScene ? '' : this.session.config?.zone.id ?? ''] ?? [1, 1, 1];
    u.grade.value.set(gr[0], gr[1], gr[2]);
    if (p && driving) {
      const sp = Math.max(0, (p.speed - 25) / 40);
      u.speed.value += ((reduced ? sp * 0.3 : sp) - u.speed.value) * 0.1;
      u.damage.value = this.session.damageFlash;
      u.lowHp.value = p.hp < p.maxHp * 0.25 ? 1 : 0;
      u.emp.value = Math.max(this.session.postEmp, p.systemsLock > 0 ? 0.35 : 0);
      u.glitch.value = this.session.zone.id === 'zeromile' && !reduced ? 0.25 + (this.session.boss?.phase ?? 0) * 0.12 : 0;
    } else {
      u.speed.value *= 0.9;
      u.damage.value = 0;
      u.lowHp.value = 0;
      u.emp.value = 0;
      u.glitch.value = this.inGarageScene ? 0 : this.session.config?.zone.id === 'zeromile' ? 0.15 : 0;
    }
    this.updatePhysHud();
    perf.begin('render');
    perf.gpuBegin();
    if (this.rawRender) {
      // VFX LAB: geometry, materials, lights and effects with no post-processing at all
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.worldScene, this.camera);
    } else this.post.render(rawDt);
    perf.gpuEnd();
    perf.end('render');
    this.input.endFrame();
    perf.frameEnd(this.renderer);
    this.updatePerfHud(now);
    if (this.res.frame(interval, performance.now() - now, perf.gpuLive, this.save.settings.autoQuality)) this.applyRenderScale();
  }

  private handleGlobalInput() {
    const inp = this.input;
    const s = this.state;
    if (inp.action('debug') && DEBUG_ENABLED) {
      this.hud.debugOn = !this.hud.debugOn;
      if (!this.hud.debugOn && this.views.mode !== 'normal') this.views.set('normal');
    }
    if (this.views.mode !== 'normal') this.views.update();
    if (s === 'DRIVING' || s === 'BOSS') {
      if (inp.action('pause')) this.pause();
      else if (inp.action('build')) this.openBuild(() => this.resumeDriving(s));
      if (this.hud.debugOn) this.debugKeys();
    } else if (s === 'PAUSE' && inp.action('pause')) this.resumeDriving(this.returnState);
    else if (s === 'MAP') {
      if (inp.action('build')) this.openBuild(() => this.showMap());
      if (inp.action('pause')) {
        if (this.overlay.querySelector('[data-a="resume"]')) this.showMap();
        else this.mapMenu();
      }
    }
  }

  private autoPause() {
    if (this.state === 'DRIVING' || this.state === 'BOSS') this.pause();
  }

  // ---------------------------------------------------------------- state & screens

  private setState(s: GameState) {
    this.state = s;
    const driving = s === 'DRIVING' || s === 'BOSS';
    this.hud.show(driving || s === 'PAUSE' || (s === 'REWARD' && !this.session.attract));
    document.body.dataset.state = s;
  }

  show(html: string, handler: UiHandler | null, keys: ((code: string) => void) | null = null, focus = true) {
    this.overlay.innerHTML = html;
    this.handler = handler;
    this.keyHandler = keys;
    if (!focus) return;
    const first = this.overlay.querySelector<HTMLElement>('.btn.primary');
    first?.focus({ preventScroll: true });
  }

  private clearOverlay() {
    this.overlay.innerHTML = '';
    this.handler = null;
    this.keyHandler = null;
  }

  private useGarageScene(on: boolean) {
    this.inGarageScene = on;
    if (on) {
      this.post.setScene(this.garage.scene, this.garage.camera);
      const v = getVehicle(this.garageTab === 'STREET' ? this.online.duelCar : this.save.selectedVehicle);
      this.garage.setCar(this.modelFor(v), this.paintFor(v), this.accentFor(v));
      this.audio.setEngine(false);
    } else this.post.setScene(this.worldScene, this.camera);
  }

  /** put a car on the turntable (the STREET tab shows the duel car in its wrap) */
  showGarageCar(vehicleId: string) {
    if (!this.inGarageScene) return;
    const v = getVehicle(vehicleId);
    this.garage.setCar(this.modelFor(v), this.paintFor(v), this.accentFor(v));
  }

  /** re-draw the garage panels after the server answers, keeping each panel's scroll position */
  refreshGarageUi() {
    // the main menu's street panel and buttons follow the server too
    if (this.state === 'MAIN_MENU') {
      const hub = document.getElementById('hub');
      if (hub) hub.innerHTML = ST.hubPanel(this.online);
      const buttons = this.overlay.querySelector('.hub-buttons');
      if (buttons) buttons.outerHTML = ST.hubButtons(this.online);
      return;
    }
    if ((this.state !== 'GARAGE' && this.state !== 'RUN_PREP') || this.duelOn) return;
    const scrolls = [...this.overlay.querySelectorAll<HTMLElement>('.side')].map((e) => e.scrollTop);
    const active = document.activeElement as HTMLElement | null;
    const price = (document.getElementById('o-price') as HTMLInputElement | null)?.value;
    const tab = this.garageTab;
    this.show(S.garage(this, tab), (a, el) => this.garageAction(a, el), (code) => {
      if (code === 'Escape') this.toMainMenu();
      if (code === 'Enter' && tab === 'PLAY') this.launchRun();
    }, false);
    this.overlay.querySelectorAll<HTMLElement>('.side').forEach((e, i) => (e.scrollTop = scrolls[i] ?? 0));
    const p = document.getElementById('o-price') as HTMLInputElement | null;
    if (p && price) p.value = price;
    if (active?.id === 'seed-input') (document.getElementById('seed-input') as HTMLInputElement | null)?.focus({ preventScroll: true });
  }

  modelFor(v: VehicleDef): ModelKind {
    return v.model === 'rammer' ? 'player_rammer' : v.model;
  }

  paintFor(v: VehicleDef) {
    const wrap = this.online.online ? IG.wornLiveryOf(IG.model(v.id)) : undefined;
    if (wrap) return wrap.color;
    const pid = this.save.paint[v.id] ?? 'stock';
    const p = PAINTS.find((x) => x.id === pid);
    return !p || p.color < 0 ? v.color : p.color;
  }

  /** the accent lights: a server wrap brings its own */
  accentFor(v: VehicleDef) {
    const wrap = this.online.online ? IG.wornLiveryOf(IG.model(v.id)) : undefined;
    return wrap ? wrap.accent : v.accent;
  }

  /** Background "attract" drive: used behind the main menu, map, shop and events. */
  private startAttract(zoneIndex: number) {
    const v = getVehicle(this.save.selectedVehicle);
    const model = buildCar(this.modelFor(v), { color: this.paintFor(v), accent: this.accentFor(v), beams: true, underglow: true, role: 'player' });
    const player = new PlayerCar(model, { ...BASE_STATS, ...v.stats, maxSpeed: 40 });
    this.session.dispose();
    this.session.run = null;
    this.session.start({ mode: 'ATTRACT', zone: ZONES[zoneIndex], seed: newSeed(), tutorial: false, mod: null }, player, this.renderer);
    this.audio.setEngine(false);
  }

  toMainMenu() {
    if (this.needsAccount()) return;
    this.run = null;
    this.useGarageScene(false);
    this.startAttract(this.menuZone);
    this.setState('MAIN_MENU');
    this.audio.setMusic('menu', ZONES[this.menuZone].music.root, ZONES[this.menuZone].music.scale, ZONES[this.menuZone].music.bpm);
    this.show(S.mainMenu(this), (a, el) => {
      if (a === 'start') {
        if (this.save.runs === 0) this.launchRun();
        else this.toGarage('PLAY');
      } else if (a === 'garage') this.toGarage('VEHICLES');
      else if (a === 'archive') this.toGarage('ARCHIVE');
      else if (a === 'settings') this.openSettings(() => this.toMainMenu());
      else if (a === 'account') this.openAccount(() => this.toMainMenu());
      // the street: PvP, the ranked week, the MileToken shop, the wallet, the contracts
      else if (a === 'duels') this.toGarage('STREET');
      else if (a === 'shift' || a === 'contracts') this.toGarage('PLAY');
      else if (a === 'depot') this.toGarage('DEPOT');
      else if (a === 'wallet') this.online.action('o-wallet', el);
      else if (a === 'quit') this.show(S.quitScreen(), () => this.toMainMenu());
    }, (code) => {
      if (code === 'Enter') this.save.runs === 0 ? this.launchRun() : this.toGarage('PLAY');
    });
  }

  toGarage(tab = this.garageTab) {
    if (this.needsAccount()) return;
    const entering = tab !== this.garageTab || !this.inGarageScene;
    if (entering) this.garageNote = null;
    this.garageTab = tab;
    if (entering) this.online.enterTab(tab);
    this.run = null;
    this.session.dispose();
    this.useGarageScene(true);
    this.setState(tab === 'PLAY' ? 'RUN_PREP' : 'GARAGE');
    this.audio.setMusic('menu');
    this.show(S.garage(this, tab), (a, el) => this.garageAction(a, el), (code) => {
      if (code === 'Escape') this.toMainMenu();
      if (code === 'Enter' && tab === 'PLAY') this.launchRun();
    });
  }

  private garageAction(a: string, el: HTMLElement) {
    if (this.online.action(a, el)) return;
    const sv = this.save;
    const v = el.dataset.v ?? '';
    switch (a) {
      case 'back': this.toMainMenu(); return;
      case 'tab': this.toGarage(v); return;
      case 'launch': this.launchRun(); return;
      case 'account': this.openAccount(() => this.toGarage(this.garageTab)); return;
      case 'claim-ach': this.claimAchievement(v); return;
      case 'module': sv.module = v as typeof sv.module; break;
      case 'diff': sv.difficulty = Number(v); break;
      case 'selcar': sv.selectedVehicle = v; break;
      case 'buycar': {
        const def = getVehicle(v);
        if (!sv.unlockedVehicles.includes(v) && sv.salvage >= def.price) {
          this.garageBuy('vehicle', v, `${def.name} IS YOURS`, () => (sv.selectedVehicle = v));
        }
        return;
      }
      case 'paint': {
        const p = PAINTS.find((x) => x.id === v)!;
        if (!sv.paints.includes(v)) {
          if (sv.salvage >= p.price) this.garageBuy('paint', v, `${p.name} PAINT BOUGHT`, () => (sv.paint[sv.selectedVehicle] = v));
          return;
        }
        sv.paint[sv.selectedVehicle] = v;
        break;
      }
      case 'unlock': {
        const u = UNLOCKS.find((x) => x.id === v)!;
        const lvl = sv.unlocks[v] ?? 0;
        if (lvl < (u.levels ?? 1) && sv.salvage >= u.price * (lvl + 1)) this.garageBuy('unlock', v, `${u.name}${(u.levels ?? 1) > 1 ? ` · LEVEL ${lvl + 1}` : ''} UNLOCKED`);
        return;
      }
    }
    // a choice in the garage: kept on the account a moment later
    P.savePrefs(sv);
    this.toGarage(this.garageTab);
  }

  /** a car, an upgrade or a paint for SALVAGE: the server charges and grants in one step */
  private garageBuy(kind: P.GarageKind, id: string, done: string, then?: () => void) {
    const key = `${kind}-${id}`;
    if (this.busy.has(key)) return;
    this.busy.add(key);
    this.garageNote = null;
    this.refreshGarageUi();
    void P.garageBuy(kind, id, (m) => (this.garageNote = { text: m, good: false })).then((ok) => {
      this.busy.delete(key);
      if (ok) {
        P.applyAccount(this.save);
        then?.();
        P.savePrefs(this.save);
        this.garageNote = { text: done, good: true };
        this.audio.item();
      }
      if (this.state === 'GARAGE' || this.state === 'RUN_PREP') this.toGarage(this.garageTab);
    });
  }

  /** the account changed under the garage (a depot purchase, a payout): the view follows */
  accountChanged() {
    if (!this.hydrated) return;
    P.applyAccount(this.save);
    this.refreshGarageUi();
  }

  /** an achievement's SALVAGE, from the ARCHIVE */
  private claimAchievement(id: string) {
    const key = `ach-${id}`;
    if (this.busy.has(key)) return;
    this.busy.add(key);
    this.garageNote = null;
    this.refreshGarageUi();
    void P.claimAchievement(id, (m) => (this.garageNote = { text: m, good: false })).then((r) => {
      this.busy.delete(key);
      if (r) {
        P.applyAccount(this.save);
        this.garageNote = { text: `+${P.achievementSalvage(id)} SALVAGE`, good: true };
        this.audio.item();
      }
      this.refreshGarageUi();
    });
  }

  /** a street duel is being performed in the pit: the garage panels wait */
  duelOn = false;

  /** perform a server-decided duel in the garage pit, then show what it paid */
  playDuel(script: DuelScript, outcome: DuelOutcome) {
    if (!this.inGarageScene) this.useGarageScene(true);
    this.duelOn = true;
    this.garage.setDuelMode(true);
    this.audio.duel(true);
    const stage = this.garage.duel;
    const a = this.audio;
    const sounds = { impact: (k: number, p = 0) => a.impact(k, p), heavyImpact: () => a.heavyImpact(), metal: (k = 0.6) => a.metal(k), scrape: () => a.scrape(), explosion: (k = 1, p = 0) => a.explosion(k, p), nitroStart: () => a.nitroStart() };
    let shown = false;
    const finish = () => {
      if (shown) return;
      shown = true;
      this.show(ST.duelResult(outcome), () => this.closeDuel(), (code) => (code === 'Enter' || code === 'Escape') && this.closeDuel());
      if (outcome.won) a.victory();
    };
    this.show(ST.duelHud(script), (act) => act === 'skip' && stage.skip(), (code) => {
      if (code === 'Escape' || code === 'Space' || code === 'Enter') stage.skip();
    }, false);
    stage.play(script, (e) => {
      if (e.type === 'blow') {
        for (const i of [0, 1] as const) {
          const bar = document.getElementById(`duel-hp-${i}`);
          const txt = document.getElementById(`duel-hpt-${i}`);
          const max = script.cars[i].maxHp;
          if (bar) bar.style.width = `${Math.max(0, (e.blow.hp[i] / max) * 100)}%`;
          if (txt) txt.textContent = `${Math.ceil(e.blow.hp[i])} / ${Math.ceil(max)}`;
        }
        const call = document.getElementById('duel-call');
        const round = document.getElementById('duel-round');
        const c = ST.blowCall(script, e.blow);
        if (call) {
          call.textContent = c.text;
          call.style.color = c.color;
          call.classList.remove('pop');
          void call.offsetWidth;
          call.classList.add('pop');
        }
        if (round) round.textContent = `ROUND ${e.blow.round}`;
      } else if (e.type === 'end') {
        const call = document.getElementById('duel-call');
        if (call) {
          call.textContent = e.winner < 0 ? 'TIME — DRAW' : e.winner === 0 ? 'YOU TAKE IT' : `${script.cars[1].name} TAKES IT`;
          call.style.color = e.winner === 0 ? '#ffd23a' : '#ff3a5c';
        }
        setTimeout(finish, 1800);
      }
    }, sounds);
  }

  private closeDuel() {
    if (!this.duelOn) return;
    this.duelOn = false;
    this.garage.setDuelMode(false);
    this.audio.duel(false);
    this.online.duelFinished();
    this.toGarage('STREET');
  }

  itemPoolSummary() {
    const pool = ITEMS.filter((i) => !i.pack || this.save.unlocks[i.pack]);
    const locked = ITEMS.length - pool.length;
    const by = (r: Rarity) => pool.filter((i) => i.rarity === r).length;
    return `${pool.length} parts available (${by('COMMON')} common · ${by('RARE')} rare · ${by('EPIC')} epic · ${by('LEGENDARY')} legendary).<br>${locked ? `${locked} parts are still locked behind upgrade packs.` : 'Every part is unlocked.'}`;
  }

  bossName(id: BossId) {
    return BOSSES[id].name;
  }

  // ---------------------------------------------------------------- run flow

  /** the weekly Shift: this week's city for every driver, Night One rules, no supplies, scored on the iDos board */
  launchShift() {
    this.launchRun(shiftSeed(), true);
  }

  launchRun(seed?: number, ranked = false) {
    // a first visit can get here before the warm-up is through: finish it behind a loading line, then go
    if (!this.warm.done) {
      if (this.warmWait) return;
      this.warmWait = true;
      this.show('<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-family:var(--display);letter-spacing:0.4em;color:var(--accent)">PREPARING THE ROAD…</div>', null);
      void this.warm.run().then(() => {
        this.warmWait = false;
        this.launchRun(seed, ranked);
      });
      return;
    }
    this.audio.init();
    if (this.opening || this.needsAccount()) return;
    // the server opens every run (its ticket is what finishRun is paid on); the last run is recorded first
    this.opening = true;
    const from = this.state;
    this.show(loadingLine('STARTING THE ENGINE…'), null);
    const difficulty = ranked ? 0 : this.save.difficulty;
    let refusal = '';
    void (async () => {
      await this.recording;
      if (this.unrecorded) await this.recordRun();
      return P.startRun(difficulty, ranked, (m) => (refusal = m));
    })().then((ticket) => {
      this.opening = false;
      if (!ticket) {
        this.garageNote = { text: refusal || 'THE RUN COULD NOT START — TRY AGAIN', good: false };
        if (!this.needsAccount()) this.toGarage('PLAY');
        return;
      }
      // the session ended while the server answered: the sign-in screen is up instead
      if (this.state !== from) return;
      this.openRun(ticket, seed, ranked, difficulty);
    });
  }

  private openRun(ticket: string, seed: number | undefined, ranked: boolean, difficulty: number) {
    const s = seed ?? (this.customSeed ? Number(this.customSeed) >>> 0 : newSeed());
    const v = getVehicle(this.save.selectedVehicle);
    const mod = ABILITIES[this.save.module].unlock && !this.save.unlocks[ABILITIES[this.save.module].unlock!] ? 'emp' : this.save.module;
    this.run = new RunState(s, v, mod, this.save, difficulty);
    this.run.ranked = ranked;
    this.run.ticket = ticket;
    this.useGarageScene(false);
    // the very first node starts immediately: get the player driving within seconds
    const first = this.run.availableNodes()[0];
    if (this.run.zoneIndex === 0 && first && first.type === 'ROAD') this.enterNode(first);
    else this.showMap();
  }

  private showMap() {
    const run = this.run!;
    if (!this.session.attract || this.session.config.zone.index !== run.zoneIndex) this.startAttract(run.zoneIndex);
    this.setState('MAP');
    this.audio.setMusic('menu', run.zone.music.root, run.zone.music.scale, run.zone.music.bpm);
    this.show(S.mapScreen(this, run), (a, el) => {
      if (a === 'node') {
        const id = Number(el.dataset.node);
        if (run.availableNodes().some((n) => n.id === id)) this.enterNode(run.map[id]);
      } else if (a === 'build') this.openBuild(() => this.showMap());
      else if (a === 'pause') this.mapMenu();
      else if (a === 'toll') this.useToll();
    }, (code) => {
      const avail = run.availableNodes();
      const k = Number(code.replace('Digit', ''));
      if (k >= 1 && k <= avail.length) this.enterNode(avail[k - 1]);
    });
  }

  /** a toll pass (or MileToken on the spot): the toll express skips the next row and patches the hull */
  private useToll() {
    const run = this.run!;
    const reach = run.tollReach();
    if (!reach || !this.online.canSupply(run.ranked)) return;
    const stock = this.online.stock('toll_pass') > 0;
    const tip = document.getElementById('map-tip');
    if (tip) tip.textContent = 'PAYING THE TOLL…';
    void this.online.spend('toll_pass', stock, (m) => tip && (tip.textContent = m)).then((ok) => {
      if (!ok || this.run !== run || this.state !== 'MAP') return;
      run.tollTargets = reach.map((n) => n.id);
      const st = run.computeStats();
      run.hp = Math.min(st.maxHp, run.hp + st.maxHp * 0.2);
      this.audio.item();
      this.showMap();
    });
  }

  private mapMenu() {
    this.show(S.pauseScreen().replace('RESUME', 'BACK TO MAP'), (a) => this.pauseAction(a, () => this.showMap()));
  }

  private enterNode(n: MapNode) {
    const run = this.run!;
    run.tollTargets = null;
    run.current = n.id;
    n.visited = true;
    this.pendingNode = n;
    switch (n.type) {
      case 'ROAD': case 'ELITE': case 'RACE': case 'SHORTCUT':
        this.startDrive(n.type);
        break;
      case 'BOSS':
        this.startDrive('BOSS');
        break;
      case 'SHOP':
        this.openShop();
        break;
      case 'EVENT':
        this.openEvent();
        break;
      case 'GAS':
        run.fuel = CONFIG.FUEL.MAX;
        run.hp = Math.min(run.computeStats().maxHp, run.hp + run.computeStats().maxHp * 0.1);
        this.setState('EVENT');
        this.show(S.infoModal('GAS STATION', 'Tank filled to the brim. Quick patch job on the hull (+10%).<br><span class="dim">The pumps hum. Somewhere a dog barks at nothing.</span>'), () => this.afterNode());
        break;
      case 'REPAIR': {
        const st = run.computeStats();
        run.hp = Math.min(st.maxHp, run.hp + st.maxHp * 0.35);
        this.setState('EVENT');
        this.show(S.infoModal('REPAIR BAY', `A mechanic who doesn't ask questions. Hull repaired by 35% (${Math.ceil(run.hp)}/${st.maxHp}).`), () => this.afterNode());
        break;
      }
    }
  }

  private startDrive(mode: DriveMode) {
    const run = this.run!;
    this.clearOverlay();
    this.hud.reset();
    const v = run.vehicle;
    const model = buildCar(this.modelFor(v), { color: this.paintFor(v), accent: this.accentFor(v), beams: true, underglow: true, role: 'player' });
    const stats = run.computeStats();
    const player = new PlayerCar(model, stats);
    player.maxHp = stats.maxHp;
    const forced = this.debugForced;
    const lab = this.debugPhysLab;
    this.debugPhysLab = false;
    const bossId = this.debugBoss ?? run.zone.boss;
    this.debugForced = undefined;
    this.debugBoss = undefined;
    const tutorial = !forced && mode === 'ROAD' && run.zoneIndex === 0 && run.nodesCleared === 0 && !this.save.tutorialDone;
    const mod = run.nextMod;
    run.nextMod = null;
    this.session.dispose();
    this.session.run = run;
    this.session.rivalIdentity = this.online.rivalFor(run.seed + (run.current ?? 0) * 7919);
    this.session.start({ mode: mode === 'RACE' ? 'RACE' : mode, zone: run.zone, seed: run.rng.fork(run.zoneIndex * 100 + (run.current ?? 0)).seed + (forced ? Date.now() % 1000 : 0), tutorial: tutorial && !lab, mod, bossId, forced, lab }, player, this.renderer);
    this.audio.setEngine(true);
    this.audio.setMusic(mode === 'BOSS' ? 'drive' : 'drive', run.zone.music.root, run.zone.music.scale, run.zone.music.bpm);
    this.setState(mode === 'BOSS' ? 'BOSS' : 'DRIVING');
    const label = mode === 'BOSS' ? `${run.zone.name} — BOSS` : `${run.zone.name} · ${mode}`;
    this.hud.notify(label, '#33e0ff', true);
    if (mod) this.hud.notify(({ ambush: 'AMBUSH AHEAD', police: 'POLICE PURSUIT — DOUBLE CREDITS', bounty: 'BOUNTY HUNTERS — DOUBLE CREDITS', safe: 'QUIET ROAD', tailwind: 'FULL NITRO', race: 'RACE', fog: 'FOG BANK' } as Record<string, string>)[mod], '#ff9a3a');
  }

  private nodeTitle() {
    const n = this.pendingNode;
    return n ? `${this.run?.zone.name ?? ''} · ${n.type}` : '';
  }

  private resumeDriving(s: GameState) {
    this.clearOverlay();
    this.setState(s === 'BOSS' ? 'BOSS' : 'DRIVING');
    this.audio.setEngine(true);
    this.last = performance.now();
  }

  private pause() {
    if (this.state !== 'DRIVING' && this.state !== 'BOSS') return;
    this.returnState = this.state;
    this.setState('PAUSE');
    this.audio.setEngine(false);
    this.show(S.pauseScreen(), (a) => this.pauseAction(a, () => this.resumeDriving(this.returnState)));
  }

  private pauseAction(a: string, resume: () => void) {
    switch (a) {
      case 'resume': resume(); break;
      case 'build': this.openBuild(() => (this.state === 'PAUSE' ? this.pauseAgain(resume) : this.mapMenu())); break;
      case 'settings': this.openSettings(() => (this.state === 'PAUSE' ? this.pauseAgain(resume) : this.mapMenu())); break;
      case 'restart': {
        const seed = this.run?.seed;
        this.endRun(false, true);
        this.launchRun(seed);
        break;
      }
      case 'garage': this.endRun(false, false, true); break;
      case 'menu': this.endRun(false, true); this.toMainMenu(); break;
    }
  }

  private pauseAgain(resume: () => void) {
    this.show(S.pauseScreen(), (a) => this.pauseAction(a, resume));
  }

  private openBuild(back: () => void) {
    if (!this.run) return;
    const wasDriving = this.state === 'DRIVING' || this.state === 'BOSS';
    if (wasDriving) {
      this.returnState = this.state;
      this.setState('PAUSE');
      this.audio.setEngine(false);
    }
    this.buildReturn = back;
    this.show(S.buildScreen(this.run), (a) => {
      if (a === 'close') this.buildReturn?.();
    }, (code) => {
      if (code === 'Tab' || code === 'Escape') this.buildReturn?.();
    });
  }

  private openSettings(back: () => void) {
    this.settingsReturn = back;
    this.show(S.settingsModal(this.save.settings, !this.run), (a) => {
      if (a === 'close') {
        P.storeSettings(this.save.settings);
        this.settingsReturn?.();
      } else if (a === 'account' && !this.run) this.openAccount(() => this.openSettings(back));
    });
  }

  private applySetting(key: string, val: string, fromSlider = false) {
    const st = this.save.settings as unknown as Record<string, unknown>;
    if (key === 'quality') st.quality = Number(val);
    else if (['master', 'music', 'sfx'].includes(key)) st[key] = Number(val) / 100;
    else if (key === 'cameraSensitivity') st[key] = Number(val) / 100;
    else st[key] = val === '1';
    this.applySettings();
    if (!fromSlider) {
      // refresh toggles in-place
      this.overlay.querySelectorAll<HTMLElement>(`[data-s="${key}"][data-v]`).forEach((b) => b.classList.toggle('selected', b.dataset.v === String(key === 'quality' ? st.quality : st[key] ? 1 : 0)));
    }
    P.storeSettings(this.save.settings);
  }

  private applySettings() {
    const s = this.save.settings;
    this.audio.volumes = { master: s.master, music: s.music, sfx: s.sfx };
    this.audio.applyVolumes();
    this.cam.shakeEnabled = s.shake;
    this.cam.sensitivity = s.cameraSensitivity;
    this.post.setQuality(s.quality, s.reducedEffects);
    this.fx.density = s.reducedEffects ? 0.4 : [0.45, 0.7, 1, 1][s.quality];
    this.env.reduced = s.reducedEffects;
    this.hud.fpsOn = s.showFps;
    document.body.classList.toggle('high-contrast', s.highContrast);
    this.resize();
  }

  // ---------------------------------------------------------------- node results & rewards

  onNodeComplete(r: NodeResult) {
    const run = this.run!;
    run.nodesCleared++;
    // the server records it with the run (finishRun: a cleared node ends the tutorial)
    this.save.tutorialDone = true;
    const clean = r.encounters > 0 && r.won >= r.encounters;
    const bonus = CONFIG.ECONOMY.NODE_CREDITS + run.zoneIndex * 5 + r.won * 4 + (clean ? 10 : 0);
    run.credits += bonus;
    run.stats.creditsEarned += bonus;
    const tier = r.mode === 'ELITE' || r.mode === 'SHORTCUT' || r.mode === 'RACE' || (clean && r.encounters >= 3) ? 1 : 0;
    const title = r.mode === 'ELITE' ? 'ELITES SURVIVED' : r.mode === 'RACE' ? 'RACE ROAD CLEARED' : r.mode === 'SHORTCUT' ? 'HAZARD RUN SURVIVED' : 'ROAD CLEARED';
    const sub = `${r.won}/${r.encounters} encounters won${clean ? ' · CLEAN SWEEP' : ''} · +${bonus} credits · avg ${Math.round(r.avgSpeedKmh)} km/h — choose a part`;
    this.audio.setEngine(false);
    this.offerReward(tier, title, sub, () => this.afterNode());
  }

  onShards() {
    const back = this.state;
    this.returnState = back;
    this.audio.setEngine(false);
    this.offerReward(0, 'SHARDS ASSEMBLED', 'Three shards make a part', () => this.resumeDriving(back));
  }

  private offerReward(tier: number, title: string, sub: string, done: () => void) {
    const run = this.run!;
    // the Hauler's bigger cargo bay offers an extra part to choose from
    const items = run.rollItems(3 + (run.vehicle.extraSlots ?? 0), tier, run.rng.fork(run.stats.itemsCollected * 13 + run.nodesCleared * 7 + Math.floor(run.stats.distance)));
    this.setState('REWARD');
    const pick = (id: string | null) => {
      if (id) {
        run.addItem(id);
        this.session.refreshBuild();
        this.audio.item();
        if (run.stats.itemsCollected === 1) this.hud.toast('BUILD STARTED', 'Parts change how your car drives. Press TAB to see your build.');
        if (run.synergies().length >= 3) this.unlockAchievement('buildcraft');
        if (run.items.length >= 12) this.unlockAchievement('hoarder');
        const newSyn = run.synergies();
        if (newSyn.length) this.hud.toast('SYNERGIES', newSyn.map((s) => s.name).join(' · '));
      } else {
        run.credits += 15;
      }
      done();
    };
    this.show(S.rewardScreen(run, items, title, sub), (a, el) => {
      if (a === 'item') pick(el.dataset.item!);
      else if (a === 'skip') pick(null);
    }, (code) => {
      const k = Number(code.replace('Digit', ''));
      if (k >= 1 && k <= items.length) pick(items[k - 1].id);
    });
  }

  private afterNode() {
    this.clearOverlay();
    this.showMap();
  }

  onBossDefeated() {
    const run = this.run!;
    const id = run.zone.boss;
    run.huntDamage += Math.round(this.session.boss?.vehicle.maxHp ?? BOSSES[id].hp);
    this.unlockAchievement('boss_slayer');
    this.unlockLore(BOSSES[id].lore);
    const st = run.computeStats();
    run.hp = Math.min(st.maxHp, this.session.player.hp + st.maxHp * 0.3);
    this.audio.setEngine(false);
    if (run.zoneIndex >= ZONES.length - 1) {
      this.victory();
      return;
    }
    this.offerReward(2, `${BOSSES[id].name} DEFEATED`, 'Hull repaired 30% · choose a prize part', () => {
      run.nextZone();
      run.fuel = Math.max(run.fuel, 60);
      this.save.best.zone = Math.max(this.save.best.zone, run.zoneIndex);
      this.clearOverlay();
      this.startAttract(run.zoneIndex);
      this.setState('EVENT');
      this.show(S.infoModal(`REGION ${run.zoneIndex + 1}: ${run.zone.name}`, `<span class="dim display" style="letter-spacing:0.4em">${run.zone.subtitle}</span><br><br>${S.esc(run.zone.description)}`, 'ENTER REGION ▶'), () => this.showMap());
    });
  }

  onPlayerDestroyed() {
    const run = this.run;
    if (run && !run.towUsed && this.online.canSupply(run.ranked)) this.offerTow(run);
    else this.endRun(false);
  }

  /** a wreck with the street online: haul it back (a tow truck from stock, or MileToken on the spot) or end the run */
  private offerTow(run: RunState, status = '') {
    if (this.state === 'DRIVING' || this.state === 'BOSS') this.returnState = this.state;
    this.setState('PAUSE');
    this.audio.setEngine(false);
    const o = this.online;
    this.show(ST.towModal(o.stock('tow_truck'), o.tokenPrice('tow_truck'), o.tokens, status), (a) => {
      if (a === 'tow-no') {
        this.endRun(false);
        return;
      }
      const stock = a === 'tow-stock';
      this.overlay.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.disabled = true));
      const st = document.getElementById('tow-status');
      if (st) st.textContent = 'THE TOW TRUCK IS ON ITS WAY…';
      void o.spend('tow_truck', stock, (m) => this.run === run && this.offerTow(run, m)).then((ok) => {
        if (!ok || this.run !== run) return;
        run.towUsed = true;
        this.session.revive();
        this.audio.setMusic('drive', run.zone.music.root, run.zone.music.scale, run.zone.music.bpm);
        this.resumeDriving(this.returnState);
      });
    });
  }

  private victory() {
    const run = this.run!;
    this.unlockAchievement('driver');
    if (run.hp < run.computeStats().maxHp * 0.1) this.unlockAchievement('survivor');
    this.unlockLore('lore_end');
    this.endRun(true);
  }

  /** Close the run on the server (it checks the numbers, pays the salvage, keeps the records) and show the results. */
  private endRun(won: boolean, silent = false, toGarage = false) {
    const run = this.run;
    if (!run) {
      if (toGarage) this.toGarage('PLAY');
      return;
    }
    const s = run.stats;
    if (s.maxSpeed >= 200) this.unlockAchievement('overdrive');
    this.unrecorded = {
      ticket: run.ticket,
      report: {
        won,
        stats: { distance: Math.round(s.distance), kills: s.kills, bosses: s.bossesDefeated, zone: run.zoneIndex, time: Math.round(s.time * 10) / 10, maxSpeed: Math.round(s.maxSpeed), combo: s.bestCombo, score: s.score, nodes: run.nodesCleared },
        eventSalvage: run.eventSalvage,
        lore: run.lore,
      },
    };
    const recording = (this.recording = this.recordRun());
    // the view keeps up at once; the account's own numbers replace it with the receipt
    const sv = this.save;
    sv.best.score = Math.max(sv.best.score, s.score);
    sv.best.zone = Math.max(sv.best.zone, run.zoneIndex);
    this.run = null;
    const street = { ranked: run.ranked, score: s.score, ramKills: s.ramKills, nearMisses: s.nearMisses, distance: s.distance, bosses: s.bossesDefeated, huntDamage: run.huntDamage };
    if (silent || toGarage) {
      if (this.online.online && s.distance > 200) void this.online.afterRun({ ...street, ranked: false, score: 0 });
      if (toGarage) {
        this.toGarage('PLAY');
        void recording.then((r) => {
          if (r?.ok) this.garageNote = { text: `RUN RECORDED · +${r.salvage} SALVAGE`, good: true };
          else if (r) this.garageNote = { text: r.message, good: false };
          this.refreshGarageUi();
        });
      }
      return;
    }
    this.setState(won ? 'VICTORY' : 'GAME_OVER');
    this.audio.setEngine(false);
    if (won) this.audio.victory();
    this.audio.setMusic('menu');
    let insured = false;
    let receipt: P.FinishResult | null = null;
    let onlineLines: string[] = [];
    const fill = () => {
      const big = document.querySelector('.salvage-big');
      const notes = document.querySelector('.unlock-list');
      const el = document.getElementById('online-results');
      if (!el) return;
      if (receipt?.ok) {
        if (big) big.textContent = `+${receipt.salvage * (insured ? 2 : 1)}`;
        if (notes) notes.innerHTML = receipt.notes.map((u) => `★ ${S.esc(u)}`).join('<br>');
      } else if (big) big.textContent = receipt ? '—' : '…';
      const o = this.online;
      const offer = !won && receipt?.ok && receipt.salvage > 0 && !insured && o.online ? { salvage: receipt.salvage, stock: o.stock('insurance'), tokenPrice: o.tokenPrice('insurance'), tokens: o.tokens } : null;
      const status = !receipt ? ['RECORDING THE RUN…'] : receipt.ok ? [] : [receipt.message];
      el.innerHTML = ST.resultsOnline([...status, ...onlineLines], offer, !!receipt && !receipt.ok && !!this.unrecorded);
    };
    this.show(S.resultsScreen(this, run, won, null, []), (a) => {
      if (a === 'newrun') this.launchRun(run.ranked ? run.seed : undefined, run.ranked);
      else if (a === 'garage') this.toGarage('PLAY');
      else if (a === 'duels') this.toGarage('STREET');
      else if (a === 'record' && this.unrecorded) {
        receipt = null;
        fill();
        void (this.recording = this.recordRun()).then((r) => {
          receipt = r;
          fill();
        });
      } else if (a === 'insure' && !insured && receipt?.ok) {
        const o = this.online;
        const btn = document.querySelector<HTMLButtonElement>('[data-a="insure"]');
        const say = (m: string) => btn && (btn.textContent = m);
        if (btn) {
          btn.disabled = true;
          btn.textContent = 'FILING THE CLAIM…';
        }
        void o.spend('insurance', o.stock('insurance') > 0, say).then(async (ok) => {
          if (!ok) return;
          const paid = await P.insureRun(say);
          if (paid === null) return;
          insured = true;
          P.applyAccount(this.save);
          onlineLines = [...onlineLines, `WRECK INSURANCE PAID · +${paid} SALVAGE`];
          fill();
          this.audio.item();
        });
      }
    }, (code) => {
      if (code === 'Enter') this.launchRun(run.ranked ? run.seed : undefined, run.ranked);
    });
    fill();
    void recording.then((r) => {
      receipt = r;
      fill();
    });
    if (this.online.online) {
      onlineLines = [run.ranked ? 'SUBMITTING YOUR SHIFT…' : 'REPORTING TO THE STREET…'];
      fill();
      void this.online.afterRun(street).then((lines) => {
        onlineLines = [...lines, ...onlineLines.filter((l) => !l.endsWith('…'))];
        fill();
      });
    }
  }

  /** send the closed run to the server; kept for another try when the connection or the session was the problem */
  private async recordRun(): Promise<P.FinishResult | null> {
    const u = this.unrecorded;
    if (!u) return null;
    const r = await P.finishRun(u.ticket, u.report);
    if (r.ok || !r.retry) this.unrecorded = null;
    if (r.ok) {
      P.applyAccount(this.save);
      if (this.save.tutorialDone) TUTORIAL_KEYS.forEach((k) => this.tutorialFlags.add(k));
    }
    return r;
  }

  // ---------------------------------------------------------------- shop & events

  rerollPrice() {
    const sh = this.shop;
    if (!sh) return CONFIG.ECONOMY.REROLL_PRICE;
    if (sh.rerolls === 0 && this.save.unlocks.perk_reroll) return 0;
    return CONFIG.ECONOMY.REROLL_PRICE + sh.rerolls * 10;
  }

  private openShop() {
    const run = this.run!;
    const stock = run.rollItems(3 + (run.vehicle.extraSlots ?? 0), 0, run.rng.fork(777 + (run.current ?? 0) * 3 + run.zoneIndex * 50));
    this.shop = { stock, prices: stock.map((i) => this.price(i)), rerolls: 0 };
    this.shopVoucherUsed = false;
    this.setState('SHOP');
    this.renderShop();
  }

  private price(i: ItemDef) {
    return Math.round(CONFIG.ECONOMY.PRICE[i.rarity] * (1 + (this.run?.zoneIndex ?? 0) * 0.08));
  }

  private renderShop() {
    const run = this.run!;
    const sh = this.shop!;
    this.show(S.shopScreen(this, run, sh.stock, sh.prices), (a, el) => {
      const st = run.computeStats();
      if (a === 'buy') {
        const i = Number(el.dataset.buy);
        const it = sh.stock[i];
        if (it && run.credits >= sh.prices[i]) {
          run.credits -= sh.prices[i];
          run.addItem(it.id);
          sh.stock[i] = null;
          this.audio.item();
          if (run.items.length >= 12) this.unlockAchievement('hoarder');
          if (run.synergies().length >= 3) this.unlockAchievement('buildcraft');
        }
      } else if (a === 'heal' && run.credits >= CONFIG.ECONOMY.HEAL_PRICE) {
        run.credits -= CONFIG.ECONOMY.HEAL_PRICE;
        run.hp = Math.min(st.maxHp, run.hp + st.maxHp * 0.3);
      } else if (a === 'fuel' && run.credits >= CONFIG.ECONOMY.FUEL_PRICE) {
        run.credits -= CONFIG.ECONOMY.FUEL_PRICE;
        run.fuel = CONFIG.FUEL.MAX;
      } else if (a === 'reroll') {
        const p = this.rerollPrice();
        if (run.credits >= p) {
          run.credits -= p;
          sh.rerolls++;
          sh.stock = run.rollItems(3 + (run.vehicle.extraSlots ?? 0), 0, run.rng.fork(9000 + sh.rerolls * 31 + (run.current ?? 0)));
          sh.prices = sh.stock.map((x) => this.price(x!));
        }
      } else if (a === 'voucher') {
        this.underTheCounter();
        return;
      } else if (a === 'leave') {
        this.shop = null;
        this.afterNode();
        return;
      }
      this.renderShop();
    }, (code) => {
      if (code === 'Escape') {
        this.shop = null;
        this.afterNode();
      }
    });
  }

  /** a black market voucher (or MileToken on the spot): three EPIC parts from under the counter, take one free */
  private underTheCounter() {
    const run = this.run!;
    if (!this.online.canSupply(run.ranked) || this.shopVoucherUsed) return;
    const stock = this.online.stock('bm_voucher') > 0;
    this.overlay.querySelectorAll<HTMLButtonElement>('[data-a="voucher"]').forEach((b) => {
      b.disabled = true;
      b.textContent = 'KNOCKING ON THE BACK DOOR…';
    });
    void this.online.spend('bm_voucher', stock, (m) => {
      this.overlay.querySelectorAll<HTMLButtonElement>('[data-a="voucher"]').forEach((b) => (b.textContent = m));
    }).then((ok) => {
      if (!ok || this.run !== run || !this.shop) return;
      this.shopVoucherUsed = true;
      const items = run.rollItems(3, 2, run.rng.fork(4242 + run.nodesCleared * 31 + run.zoneIndex * 7), 'EPIC');
      const pick = (id: string | null) => {
        if (id) {
          run.addItem(id);
          this.audio.item();
          if (run.synergies().length >= 3) this.unlockAchievement('buildcraft');
          if (run.items.length >= 12) this.unlockAchievement('hoarder');
        }
        this.renderShop();
      };
      this.show(S.rewardScreen(run, items, 'UNDER THE COUNTER', 'The black market keeps its best parts out of sight. Take one.').replace('SKIP (+15 CREDITS)', 'LEAVE THEM'), (a, el) => {
        if (a === 'item') pick(el.dataset.item!);
        else if (a === 'skip') pick(null);
      }, (code) => {
        const k = Number(code.replace('Digit', ''));
        if (k >= 1 && k <= items.length) pick(items[k - 1].id);
      });
    });
  }

  private openEvent() {
    const run = this.run!;
    const rng = run.rng.fork(5000 + (run.current ?? 0) * 17 + run.zoneIndex * 101);
    const pool = EVENTS.filter((e) => !e.unlock || this.save.unlocks[e.unlock]);
    const ev = rng.pick(pool);
    const ctx = this.eventCtx(rng);
    this.setState('EVENT');
    const choose = (i: number) => {
      const o = ev.options[i];
      if (!o || (o.requires && !o.requires(ctx))) return;
      const text = o.apply(ctx);
      this.show(S.eventResult(ev, text), () => this.afterNode(), (code) => {
        if (code === 'Enter' || code === 'Space') this.afterNode();
      });
    };
    this.show(S.eventScreen(ev, (i) => !ev.options[i].requires || ev.options[i].requires!(ctx)), (_a, el) => choose(Number(el.dataset.opt)), (code) => {
      const k = Number(code.replace('Digit', ''));
      if (k >= 1) choose(k - 1);
    });
    void (ev as EventDef);
  }

  private eventCtx(rng: Random): EventCtx {
    const run = this.run!;
    const st = () => run.computeStats();
    const game = this;
    return {
      rng,
      get hp() { return run.hp; },
      get maxHp() { return st().maxHp; },
      get credits() { return run.credits; },
      get fuel() { return run.fuel; },
      get momentum() { return run.momentum; },
      get itemCount() { return run.items.length; },
      get mass() { return st().mass; },
      damagePct(p) { run.hp = Math.max(1, run.hp - st().maxHp * p); run.stats.damageTaken += st().maxHp * p; },
      healPct(p) { run.hp = Math.min(st().maxHp, run.hp + st().maxHp * p); },
      addCredits(n) { run.credits = Math.max(0, run.credits + n); if (n > 0) run.stats.creditsEarned += n; },
      addFuel(n) { run.fuel = Math.max(0, Math.min(CONFIG.FUEL.MAX, run.fuel + n)); },
      addMomentum(n) { run.momentum = Math.max(0, Math.min(100, run.momentum + n)); },
      addMaxHp(n) { run.maxHpBonus += n; run.invalidate(); run.hp = Math.max(1, Math.min(st().maxHp, run.hp + Math.max(0, n))); },
      giveItem(r) {
        const it = run.rollItems(1, r === 'LEGENDARY' || r === 'EPIC' ? 2 : 1, rng, r)[0] ?? run.rollItems(1, 0, rng)[0];
        if (!it) return 'nothing';
        run.addItem(it.id);
        return it.name;
      },
      giveSpecific(id) {
        const it = getItem(id);
        if (!it) return null;
        run.addItem(id);
        return it.name;
      },
      removeRandomItem() {
        if (!run.items.length) return null;
        const id = rng.pick(run.items);
        run.removeItem(id);
        return getItem(id)?.name ?? 'a part';
      },
      sacrificeItem() {
        if (!run.items.length) return null;
        const id = rng.pick(run.items);
        const r = getItem(id)?.rarity ?? 'COMMON';
        run.removeItem(id);
        return r;
      },
      setNextMod(m) { run.nextMod = m; },
      gainSalvage(n) { run.eventSalvage += n; },
      lore(id) { game.unlockLore(id); },
    };
  }

  // ---------------------------------------------------------------- meta

  /** earned on the road: the account's achievement quest completes, its SALVAGE waits in the ARCHIVE */
  unlockAchievement(id: string) {
    if (this.save.achievements.includes(id)) return;
    const a = ACHIEVEMENTS.find((x) => x.id === id);
    if (!a) return;
    this.save.achievements.push(id);
    this.hud.toast('ACHIEVEMENT', `★ ${a.name} · +${P.achievementSalvage(id)} SALVAGE IN THE ARCHIVE`);
    void P.reportAchievement(id);
  }

  /** decrypted on the road: recorded on the account with the run */
  unlockLore(id: string) {
    if (this.save.lore.includes(id)) return;
    this.save.lore.push(id);
    this.run?.lore.push(id);
    this.hud.toast('ARCHIVE', 'New entry decrypted');
  }

  // ---------------------------------------------------------------- debug

  private debugKeys() {
    const inp = this.input;
    const s = this.session;
    const run = this.run;
    if (!run) return;
    if (inp.hit('Digit1')) { run.credits += 100; this.hud.popup('+100 CR (debug)'); }
    if (inp.hit('Digit2')) s.heal(s.player.maxHp);
    if (inp.hit('Digit3')) s.addFuel(100);
    if (inp.hit('Digit4')) {
      const it = run.rollItems(1, 1)[0];
      if (it) { run.addItem(it.id); s.refreshBuild(); this.hud.popup(`+${it.name}`, '#ffd23a'); }
    }
    if (inp.hit('Digit5')) s.spawnEnemy(new Random(Date.now()).weighted(run.zone.enemies), 50);
    if (inp.hit('Digit6')) { s.player.placeAt(s.world.road, Math.min(s.world.road.endS - 50, s.player.s + 300), 0, s.player.speed); s.world.ensureAhead(s.player.s); }
    if (inp.hit('Digit7') && s.boss) s.boss.hitStability(999, 'DEBUG');
    if (inp.hit('Digit8') && s.world.finishS > 0) { s.world.ensureAhead(s.world.finishS); s.player.placeAt(s.world.road, s.world.finishS - 3, 0, 30); }
    if (inp.hit('Digit9')) { s.godMode = !s.godMode; this.hud.popup(`GOD MODE ${s.godMode ? 'ON' : 'OFF'}`); }
    if (inp.hit('Digit0')) { PlayerCar.debugContacts = !PlayerCar.debugContacts; this.hud.popup(`CONTACT LOG ${PlayerCar.debugContacts ? 'ON' : 'OFF'}`); }
  }

  private debugForced: import('../encounters/defs').EncounterId[] | undefined;
  /** debug (VFX LAB): render without post-processing */
  rawRender = false;
  /** debug: the next drive is the physics lab track */
  private debugPhysLab = false;
  /** profiler overlay (F9 / ?perf), refreshed four times a second */
  private perfEl: HTMLDivElement | null = null;
  private perfT = 0;
  private updatePerfHud(now: number) {
    if (!perf.on) {
      // the renderer's counters only reset with the profiler on: keep them from growing without bound
      if (this.renderer.info.render.frame % 600 === 0) this.renderer.info.reset();
      return;
    }
    if (now - this.perfT < 250) return;
    this.perfT = now;
    if (!this.perfEl) {
      this.perfEl = document.createElement('div');
      this.perfEl.style.cssText = 'position:fixed;right:10px;top:10px;z-index:60;font:11px/1.4 monospace;color:#dfe;background:rgba(0,0,0,.7);padding:8px 10px;border-radius:4px;pointer-events:none;white-space:pre;max-width:46vw';
      document.body.appendChild(this.perfEl);
    }
    const st = perf.stats(120);
    const r = this.renderer;
    const info = r.info;
    const s = this.session;
    const vs = s.vehicles ?? [];
    const enemies = vs.filter((v) => v.hostile && !v.dead && !v.removed).length;
    const fxs = s.fx?.stats();
    let lights = 0;
    this.worldScene.traverseVisible((o) => {
      if (((o as THREE.PointLight).isPointLight || (o as THREE.SpotLight).isSpotLight) && (o as THREE.Light).intensity > 0) lights++;
    });
    const phases = [...perf.phaseAvg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 9).map(([k, v]) => `${k} ${v.toFixed(2)}`).join('  ');
    const sp = perf.spikes.slice(-3).reverse().map((x) => `  ${x.ms}ms cpu ${x.cpu} | ${x.phases.slice(0, 3).map((p) => p[0] + ' ' + p[1]).join(', ')}${x.events.length ? ' | ' + x.events.join('; ') : ''}`).join('\n');
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    this.perfEl.textContent = st
      ? `FPS ${st.fps}  frame ${st.avgMs} ms  p95 ${st.p95}  p99 ${st.p99}  worst ${st.worst}
CPU ${st.cpu} ms  GPU ${st.gpu >= 0 ? st.gpu + ' ms' : 'n/a'}   spikes>30 ${st.over30}/120
${phases}
draw ${info.render.calls}  tris ${(info.render.triangles / 1000).toFixed(0)}k  geo ${info.memory.geometries}  tex ${info.memory.textures}  programs ${info.programs?.length ?? 0}
vehicles ${vs.length}  enemies ${enemies}  lights ${lights}  shadow maps 0 (blob shadows)  fx ${fxs ? `add ${fxs.add} smoke ${fxs.smoke} streaks ${fxs.streaks} debris ${fxs.debris}` : '-'}
built new: cars ${perf.built.car}  road segments ${perf.built.segment}  (pooled: particles, decals, lights, streaks, debris)  warm-up ${this.warm.stats.programs} shaders in ${this.warm.stats.ms} ms
render ${size.x}x${size.y}  dpr ${window.devicePixelRatio}  scale ${this.res.scale.toFixed(2)}/${this.res.ceiling.toFixed(2)}  quality ${['LOW', 'MEDIUM', 'HIGH', 'VERY HIGH'][this.save.settings.quality]}${this.save.settings.autoQuality ? ` AUTO (${this.res.note || 'steady'})` : ''}
last spikes:
${sp || '  none'}`
      : 'collecting…';
  }

  /** debug: live physics readout (state, speed, slip, grip, yaw) */
  private physHud = false;
  private physHudEl: HTMLDivElement | null = null;
  private updatePhysHud() {
    const p = this.session.player;
    if (!this.physHud || !p) return;
    if (!this.physHudEl) {
      this.physHudEl = document.createElement('div');
      this.physHudEl.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:50;font:12px/1.45 monospace;color:#cfe;background:rgba(0,0,0,.55);padding:8px 10px;border-radius:4px;pointer-events:none;white-space:pre';
      document.body.appendChild(this.physHudEl);
    }
    const slip = Math.atan2(p.vL, Math.max(1, Math.abs(p.vF))) * 57.3;
    this.physHudEl.textContent = `${p.state.padEnd(13)} ${p.stateT.toFixed(1)}s
speed ${(p.speed * 3.6).toFixed(0).padStart(4)} km/h   vF ${(p.vF * 3.6).toFixed(0)}  vL ${(p.vL * 3.6).toFixed(0)}
slip  ${slip.toFixed(1).padStart(5)}°   yaw rate ${(p.yawRate * 57.3).toFixed(0)}°/s
grip  ${p.gripLoad.toFixed(2)}   accel ${p.accelLong.toFixed(1)} m/s²   ${p.wet ? 'WET' : 'DRY'}
${p.grounded ? 'ground' : 'air ' + p.airTime.toFixed(2) + 's'}   land ${p.landGrade}   stuck ${p.stuckTime.toFixed(1)}`;
  }
  private debugBoss: BossId | undefined;

  /** Debug overlay selectors: jump straight into an encounter or a boss, or give a themed build. */
  private debugCommand(cmd: string) {
    const run = this.run;
    if (!run) return;
    const [k, v, arg] = cmd.split(':');
    if (k === 'cmd' && v === 'view') {
      this.views.set(arg as ViewMode);
      this.hud.popup(`VIEW: ${arg.toUpperCase()}`, '#5af0ff');
      return;
    }
    if (k === 'cmd') {
      const s = this.session;
      if (v === 'lab') {
        const st = s.lab.build(s.player.s + 60);
        this.hud.popup(`VISUAL LAB: ${st.length} STATIONS AHEAD`, '#5af0ff');
      } else if (v === 'labclear') s.lab.clear();
      else if (v === 'chaos') s.chaos.debugFire(arg as import('./chaos').ChaosKind);
      else if (v === 'phys') {
        const p = s.player;
        if (arg === 'lab') {
          this.debugPhysLab = true;
          this.startDrive('ROAD');
          this.hud.popup('PHYSICS LAB TRACK', '#5af0ff');
        } else if (arg === 'wet') {
          s.vfxLab.forceWet = !s.vfxLab.forceWet;
          this.hud.popup(`WET ROAD ${s.vfxLab.forceWet ? 'ON' : 'OFF'}`, '#5af0ff');
        } else if (arg === 'truck') {
          s.spawnTrafficAt(p.s + 50, p.d, p.vF * 0.5, 'truck');
          this.hud.popup('HEAVY TRUCK AHEAD', '#5af0ff');
        } else if (arg === 'cars') {
          const w = s.world.road.at(p.s + 40).width;
          for (let i = 0; i < 5; i++) s.spawnTrafficAt(p.s + 35 + i * 9, (i % 3 - 1) * (w / 3.2), p.vF * (0.45 + (i % 2) * 0.15));
          this.hud.popup('TRAFFIC CLUSTER AHEAD', '#5af0ff');
        } else if (arg === 'enemy') {
          s.spawnEnemyAt(Math.random() < 0.5 ? 'interceptor' : 'rammer', p.s + 30, p.d + 3.5, p.vF * 0.8);
          this.hud.popup('ENEMY ALONGSIDE', '#5af0ff');
        } else if (arg === 'hud') {
          this.physHud = !this.physHud;
          if (!this.physHud) this.physHudEl?.remove();
          this.physHudEl = null;
        } else if (arg === 'tests') {
          void import('../dev/physicsTests').then((m) => {
            const all = m.runAll();
            for (const r of all) {
              console.info(`[physics] ${r.vehicle}: ${r.pass}/${r.total}`);
              console.table(r.checks);
            }
            this.hud.popup(`PHYSICS TESTS ${all.map((r) => `${r.vehicle.toUpperCase()} ${r.pass}/${r.total}`).join(' · ')}`, all.every((r) => r.pass === r.total) ? '#7dffb0' : '#ff8060');
          });
        }
      }
      else if (v === 'vfx') {
        if (arg === 'nopost') {
          this.rawRender = !this.rawRender;
          this.hud.popup(`POST ${this.rawRender ? 'OFF' : 'ON'}`, '#5af0ff');
        } else this.hud.popup('VFX: ' + s.vfxLab.fire(arg as import('../effects/vfxLab').LabEffect), '#5af0ff');
      }
      return;
    }
    if (k === 'build') {
      const owned = new Set(run.items);
      const picks = ITEMS.filter((it) => it.tags.includes(v as never) && !owned.has(it.id)).sort((a, b) => (a.rarity === 'LEGENDARY' ? 1 : 0) - (b.rarity === 'LEGENDARY' ? 1 : 0)).slice(0, 5);
      for (const it of picks) run.addItem(it.id);
      this.session.refreshBuild();
      this.hud.popup(`${v} BUILD +${picks.length} PARTS`, '#ffd23a');
      return;
    }
    if (k === 'enc') {
      this.debugForced = [v as import('../encounters/defs').EncounterId];
      this.startDrive('ROAD');
    } else if (k === 'boss') {
      this.debugBoss = v as BossId;
      this.startDrive('BOSS');
    }
  }

  /** QA autopilot (debug only): drives the current node so flows can be tested automatically. */
  qaBot = false;
  qaDrift = false;
  private applyQaBot() {
    const s = this.session;
    if (!s.player || s.attract || (this.state !== 'DRIVING' && this.state !== 'BOSS')) return;
    const ap = (s as unknown as { autopilot(dt: number): { steer: number } }).autopilot(1 / 60);
    const st = this.input.state;
    const api = ap as unknown as { accelerate: number; brake: number };
    st.accelerate = api.accelerate;
    st.brake = api.brake;
    st.steer = ap.steer;
    st.nitro = s.player.nitro > 40 && Math.abs(ap.steer) < 0.3;
    st.handbrake = this.qaDrift && Math.abs(ap.steer) > 0.45;
    // back out of dead ends
    if (!s.arrival && (s.player.stuckTime > 0.8 || this.qaReverse > 0)) {
      if (this.qaReverse <= 0) this.qaReverse = 1.2;
      this.qaReverse -= 1 / 60;
      st.accelerate = 0;
      st.brake = 1;
      st.steer = -ap.steer || 1;
      st.nitro = false;
    }
  }
  private qaReverse = 0;

  /** Exposed for automated QA from the console. */
  debugApi() {
    return {
      game: this,
      state: () => this.state,
      bot: (on = true, drift = false) => {
        this.qaBot = on;
        this.qaDrift = drift;
      },
      click: (sel: string) => (this.overlay.querySelector(sel) as HTMLElement | null)?.click(),
      /** live collision material table and balance config (tuning) */
      materials: COLLISION_MATERIALS,
      impact: IMPACT,
      config: CONFIG,
      /** print every collision (material, severity, speed before/after, normal/tangential speed) to the console */
      collisions: (on = true) => {
        PlayerCar.debugContacts = on;
        return this.session.player?.contactLog ?? [];
      },
      vehicles: VEHICLES.map((v) => v.id),
      /** driving physics bench: benchmarks + invariants on synthetic roads ('all' = every car) */
      physics: (vehicle = 'courier') => import('../dev/physicsTests').then((m) => (vehicle === 'all' ? m.runAll() : m.runPhysicsTests(vehicle))),
      /** real-time benchmark: A driving, B combat, C heavy combat, D boss, E chaos, F first load, G restarts */
      bench: (profile: string = 'A', seconds = 30) => import('../dev/bench').then((m): Promise<unknown> => (profile === 'G' ? m.runRestarts(this) : m.runBench(this, profile as never, seconds))),
      perf: () => perf,
      /** model lineup in a neutral studio (no HUD, no post): returns a JPEG data URL */
      lineup: (o?: LineupOpts) => renderLineup(this.renderer, o),
      /** the pitch trailer: records one clip per shot (npm run trailer cuts them into the film) */
      trailer: () => import('../dev/trailer').then((m) => m.runTrailer(this)),
    };
  }
}
