import { MusicEngine, type MusicScene } from './music';

/**
 * Procedural Web Audio: layered engine, tyres and surfaces, enemies, one-shot SFX and an adaptive soundtrack
 * (see music.ts). No external audio files are required.
 *
 * Mix priority (loudest / never masked first): music > cues > crashes > tyres > enemies > environment > engine.
 * Every sound goes through its bus; cues and crashes duck the layers under them for a moment so the important
 * thing always reads. The player's engine is a bed under everything, not the lead instrument.
 */
type Bus = 'cue' | 'crash' | 'tires' | 'enemy' | 'env' | 'engine';

const MIX: Record<Bus, number> = { cue: 1, crash: 0.95, tires: 0.7, enemy: 0.65, env: 0.5, engine: 0.17 };

export interface SurfaceState {
  wet: boolean;
  tunnel: boolean;
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private musicGain!: GainNode;
  private sfx!: GainNode;
  private comp!: DynamicsCompressorNode;
  private noiseBuf!: AudioBuffer;
  private buses = {} as Record<Bus, GainNode>;
  private curBus: Bus = 'crash';
  // engine layers
  private engBody!: OscillatorNode;
  private engSub!: OscillatorNode;
  private engGrowl!: OscillatorNode;
  private engBodyF!: BiquadFilterNode;
  private engGrowlF!: BiquadFilterNode;
  private engGrowlG!: GainNode;
  private intakeF!: BiquadFilterNode;
  private intakeG!: GainNode;
  private engGain!: GainNode;
  private whine!: OscillatorNode;
  private whineGain!: GainNode;
  private crackleGain!: GainNode;
  private lastThrottle = 0;
  private lastRpm = 0;
  // tyres & surfaces
  private skidGain!: GainNode;
  private rollGain!: GainNode;
  private wetGain!: GainNode;
  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;
  private echo!: GainNode;
  // enemies
  private enemyOsc!: OscillatorNode;
  private enemyF!: BiquadFilterNode;
  private enemyG!: GainNode;
  private enemyPan!: StereoPannerNode | null;
  private engineOn = false;
  // music
  private music: MusicEngine | null = null;
  musicIntensity = 0.5;
  private musicRoot = 45;
  private musicScale = [0, 3, 5, 7, 10];
  private bpm = 104;
  private musicMode: 'menu' | 'drive' | 'boss' | 'off' = 'off';
  private speed01 = 0;
  private resultOn = false;
  volumes = { master: 0.8, music: 0.55, sfx: 0.8 };
  private lastPlay: Record<string, number> = {};

  /** Must be called from a user gesture. Safe to call repeatedly. */
  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14;
    this.comp.ratio.value = 4;
    this.master = ctx.createGain();
    this.musicGain = ctx.createGain();
    this.sfx = ctx.createGain();
    this.musicGain.connect(this.master);
    this.sfx.connect(this.master);
    this.master.connect(this.comp);
    this.comp.connect(ctx.destination);
    for (const b of Object.keys(MIX) as Bus[]) {
      const g = ctx.createGain();
      g.gain.value = MIX[b];
      g.connect(this.sfx);
      this.buses[b] = g;
    }
    this.applyVolumes();

    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // ---- engine: a warm body (triangle + sub), a growl band that opens under load, intake noise
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    // tunnels: a short slap-back echo on the engine and tyres
    const delay = ctx.createDelay(0.5);
    delay.delayTime.value = 0.09;
    const fb = ctx.createGain();
    fb.gain.value = 0.38;
    this.echo = ctx.createGain();
    this.echo.gain.value = 0;
    this.engGain.connect(this.buses.engine);
    this.engGain.connect(delay);
    delay.connect(fb).connect(delay);
    delay.connect(this.echo).connect(this.buses.env);

    this.engBody = ctx.createOscillator();
    this.engBody.type = 'triangle';
    this.engSub = ctx.createOscillator();
    this.engSub.type = 'sine';
    this.engBodyF = ctx.createBiquadFilter();
    this.engBodyF.type = 'lowpass';
    this.engBodyF.Q.value = 0.7;
    const gb = ctx.createGain();
    gb.gain.value = 0.55;
    const gs = ctx.createGain();
    gs.gain.value = 0.45;
    this.engBody.connect(gb).connect(this.engBodyF);
    this.engSub.connect(gs).connect(this.engBodyF);
    this.engBodyF.connect(this.engGain);
    this.engGrowl = ctx.createOscillator();
    this.engGrowl.type = 'sawtooth';
    this.engGrowlF = ctx.createBiquadFilter();
    this.engGrowlF.type = 'bandpass';
    this.engGrowlF.Q.value = 1.6;
    this.engGrowlG = ctx.createGain();
    this.engGrowlG.gain.value = 0;
    this.engGrowl.connect(this.engGrowlF).connect(this.engGrowlG).connect(this.engGain);
    const intake = this.loopNoise();
    this.intakeF = ctx.createBiquadFilter();
    this.intakeF.type = 'bandpass';
    this.intakeF.Q.value = 1.2;
    this.intakeG = ctx.createGain();
    this.intakeG.gain.value = 0;
    intake.connect(this.intakeF).connect(this.intakeG).connect(this.engGain);
    this.engBody.start();
    this.engSub.start();
    this.engGrowl.start();
    // turbo/nitro whine
    this.whine = ctx.createOscillator();
    this.whine.type = 'sine';
    this.whineGain = ctx.createGain();
    this.whineGain.gain.value = 0;
    this.whine.connect(this.whineGain).connect(this.buses.engine);
    this.whine.start();
    // damage crackle
    const crSrc = this.loopNoise();
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2500;
    this.crackleGain = ctx.createGain();
    this.crackleGain.gain.value = 0;
    crSrc.connect(hp).connect(this.crackleGain).connect(this.buses.engine);

    // ---- tyres: skid squeal, rolling rumble; surfaces: wet hiss
    const skidSrc = this.loopNoise();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1400;
    bp.Q.value = 3;
    this.skidGain = ctx.createGain();
    this.skidGain.gain.value = 0;
    skidSrc.connect(bp).connect(this.skidGain).connect(this.buses.tires);
    const rollSrc = this.loopNoise();
    const rlp = ctx.createBiquadFilter();
    rlp.type = 'lowpass';
    rlp.frequency.value = 220;
    this.rollGain = ctx.createGain();
    this.rollGain.gain.value = 0;
    rollSrc.connect(rlp).connect(this.rollGain).connect(this.buses.tires);
    this.rollGain.connect(delay);
    const wetSrc = this.loopNoise();
    const whp = ctx.createBiquadFilter();
    whp.type = 'highpass';
    whp.frequency.value = 3200;
    this.wetGain = ctx.createGain();
    this.wetGain.gain.value = 0;
    wetSrc.connect(whp).connect(this.wetGain).connect(this.buses.tires);

    // ---- environment: wind
    const windSrc = this.loopNoise();
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 500;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    windSrc.connect(this.windFilter).connect(this.windGain).connect(this.buses.env);

    // ---- enemies: the engine of whoever is closest — you hear it coming before you see it
    this.enemyOsc = ctx.createOscillator();
    this.enemyOsc.type = 'sawtooth';
    this.enemyF = ctx.createBiquadFilter();
    this.enemyF.type = 'lowpass';
    this.enemyF.frequency.value = 600;
    this.enemyF.Q.value = 2;
    this.enemyG = ctx.createGain();
    this.enemyG.gain.value = 0;
    this.enemyPan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    this.enemyOsc.connect(this.enemyF).connect(this.enemyG);
    if (this.enemyPan) this.enemyG.connect(this.enemyPan).connect(this.buses.enemy);
    else this.enemyG.connect(this.buses.enemy);
    this.enemyOsc.start();

    this.music = new MusicEngine(ctx, this.musicGain, this.noiseBuf);
    this.music.setKey(this.musicRoot, this.musicScale, this.bpm);
    // music requested before the context existed starts now
    if (this.musicMode !== 'off') this.setMusic(this.musicMode);
  }

  private loopNoise() {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    src.loopStart = Math.random();
    src.start(0, Math.random());
    return src;
  }

  applyVolumes() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.volumes.master, t, 0.05);
    this.musicGain.gain.setTargetAtTime(this.volumes.music * 0.5, t, 0.05);
    this.sfx.gain.setTargetAtTime(this.volumes.sfx, t, 0.05);
  }

  setEngine(on: boolean) {
    this.engineOn = on;
    if (!this.ctx) return;
    if (!on) {
      const t = this.ctx.currentTime;
      for (const g of [this.engGain, this.skidGain, this.windGain, this.whineGain, this.crackleGain, this.rollGain, this.wetGain, this.enemyG, this.echo]) g.gain.setTargetAtTime(0, t, 0.08);
    }
  }

  /** Surfaces the tyres are on: wet roads hiss, tunnels echo. */
  private surface: SurfaceState = { wet: false, tunnel: false };
  setSurface(s: SurfaceState) {
    this.surface = s;
  }

  /** speed m/s, throttle 0..1, maxSpeed for rpm mapping. */
  updateEngine(speed: number, maxSpeed: number, throttle: number, nitro: boolean, drift: number, damaged: number, airborne: boolean) {
    if (!this.ctx || !this.engineOn) return;
    const t = this.ctx.currentTime;
    const ratio = Math.min(1.3, speed / Math.max(10, maxSpeed));
    this.speed01 = Math.min(1, ratio);
    // fake gearbox: 5 gears with an rpm saw
    const gears = 5;
    const g = Math.min(gears - 1, Math.floor(ratio * gears));
    const inGear = ratio * gears - g;
    let rpm = 0.25 + inGear * 0.65 + g * 0.03;
    if (airborne) rpm = Math.min(1.1, rpm + 0.25);
    rpm += throttle * 0.08;
    const f = 34 + rpm * 88 + (nitro ? 16 : 0);
    this.engBody.frequency.setTargetAtTime(f, t, 0.03);
    this.engSub.frequency.setTargetAtTime(f * 0.5, t, 0.03);
    this.engGrowl.frequency.setTargetAtTime(f, t, 0.03);
    this.engBodyF.frequency.setTargetAtTime(220 + rpm * 620, t, 0.05);
    this.engGrowlF.frequency.setTargetAtTime(f * 3 + throttle * 300, t, 0.05);
    this.engGrowlG.gain.setTargetAtTime(0.04 + throttle * 0.12 + (nitro ? 0.06 : 0), t, 0.05);
    this.intakeF.frequency.setTargetAtTime(500 + rpm * 1800, t, 0.05);
    this.intakeG.gain.setTargetAtTime(throttle * 0.1 * (0.4 + rpm), t, 0.05);
    this.engGain.gain.setTargetAtTime(0.09 + throttle * 0.05 + ratio * 0.03, t, 0.05);
    this.whine.frequency.setTargetAtTime(900 + ratio * 1800, t, 0.05);
    this.whineGain.gain.setTargetAtTime(nitro ? 0.025 : ratio * 0.004, t, 0.05);
    // lifting off at high revs: a few exhaust pops
    if (this.lastThrottle > 0.6 && throttle < 0.1 && this.lastRpm > 0.7 && this.throttleSfx('pops', 0.8)) this.pops();
    this.lastThrottle = throttle;
    this.lastRpm = rpm;
    // tyres and surfaces
    this.skidGain.gain.setTargetAtTime(Math.min(0.35, drift * 0.3), t, 0.04);
    this.rollGain.gain.setTargetAtTime(airborne ? 0 : Math.min(0.12, ratio * 0.12), t, 0.08);
    this.wetGain.gain.setTargetAtTime(this.surface.wet && !airborne ? Math.min(0.07, ratio * 0.08) : 0, t, 0.15);
    this.echo.gain.setTargetAtTime(this.surface.tunnel ? 0.55 : 0, t, 0.2);
    this.windGain.gain.setTargetAtTime(Math.min(0.1, ratio * ratio * 0.09), t, 0.1);
    this.windFilter.frequency.setTargetAtTime(300 + ratio * 1500, t, 0.1);
    this.crackleGain.gain.setTargetAtTime(damaged > 0 ? (Math.random() < 0.3 ? damaged * 0.06 : 0) : 0, t, 0.01);
  }

  /** visual hook: called with the delay of every pop, so the tailpipes flash on the beat of the sound */
  onPops: ((at: number[]) => void) | null = null;

  private pops() {
    const n = 2 + Math.floor(Math.random() * 3);
    const at: number[] = [];
    for (let i = 0; i < n; i++) at.push(0.05 + i * (0.06 + Math.random() * 0.07));
    this.onBus('engine', () => {
      for (let i = 0; i < n; i++) this.noise(0.04, 'bandpass', 600 + Math.random() * 500, 0.22, 1.5, at[i]);
    });
    this.onPops?.(at);
  }

  /**
   * The nearest hostile: its engine, panned to where it is, louder as it closes. A boosting one roars.
   * dist < 0 = nobody near.
   */
  updateEnemy(dist: number, pan: number, speed: number, boosting: boolean) {
    if (!this.ctx || !this.engineOn) return;
    const t = this.ctx.currentTime;
    const near = dist < 0 ? 0 : Math.max(0, 1 - dist / 45);
    this.enemyG.gain.setTargetAtTime(near * near * (boosting ? 0.11 : 0.06), t, 0.08);
    this.enemyOsc.frequency.setTargetAtTime(40 + Math.min(1.3, speed / 50) * 70 + (boosting ? 18 : 0), t, 0.05);
    this.enemyF.frequency.setTargetAtTime(400 + near * 500 + (boosting ? 700 : 0), t, 0.08);
    if (this.enemyPan) this.enemyPan.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), t, 0.05);
  }

  /** Bridge expansion joint: a double thump under the wheels. */
  joint() {
    if (!this.ctx || !this.throttleSfx('joint', 0.12)) return;
    this.onBus('tires', () => {
      this.tone('sine', 90, 50, 0.07, 0.12);
      this.tone('sine', 90, 50, 0.07, 0.1, 0.06);
    });
  }

  private throttleSfx(name: string, minGap: number) {
    if (!this.ctx) return false;
    const now = this.ctx.currentTime;
    if ((this.lastPlay[name] ?? -1) + minGap > now) return false;
    this.lastPlay[name] = now;
    return true;
  }

  private env(node: AudioNode, peak: number, attack: number, decay: number, when = 0) {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    const t = ctx.currentTime + when;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    node.connect(g);
    const out = this.buses[this.curBus] ?? this.sfx;
    if (this.curPan !== 0 && ctx.createStereoPanner) {
      const pn = ctx.createStereoPanner();
      pn.pan.value = Math.max(-1, Math.min(1, this.curPan));
      g.connect(pn).connect(out);
    } else g.connect(out);
    return g;
  }

  /** Stereo position for the next one-shots (-1 left .. 1 right). */
  private curPan = 0;
  private panned(pan: number, fn: () => void) {
    this.curPan = pan;
    fn();
    this.curPan = 0;
  }

  /** Route the next one-shots to a mix bus. */
  private onBus(bus: Bus, fn: () => void) {
    const prev = this.curBus;
    this.curBus = bus;
    fn();
    this.curBus = prev;
  }

  /** Pull the layers under a cue or a crash down for a moment so it reads. */
  private duckUnder(level: Bus, seconds: number, depth = 0.45) {
    if (!this.ctx) return;
    const order: Bus[] = ['cue', 'crash', 'tires', 'enemy', 'env', 'engine'];
    const t = this.ctx.currentTime;
    for (const b of order.slice(order.indexOf(level) + 1)) {
      const g = this.buses[b].gain;
      g.cancelScheduledValues(t);
      g.setTargetAtTime(MIX[b] * depth, t, 0.02);
      g.setTargetAtTime(MIX[b], t + seconds, 0.25);
    }
  }

  private noise(dur: number, filterType: BiquadFilterType, freq: number, peak: number, q = 1, when = 0, freqEnd?: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.value = freq;
    f.Q.value = q;
    const t = ctx.currentTime + when;
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    src.connect(f);
    this.env(f, peak, 0.005, dur, when);
    src.start(t, Math.random(), dur + 0.1);
  }

  private tone(type: OscillatorType, f0: number, f1: number, dur: number, peak: number, when = 0) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    const t = ctx.currentTime + when;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    this.env(o, peak, 0.005, dur, when);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  // ------------------------------------------------------------- crashes

  impact(strength: number, pan = 0) {
    if (!this.ctx || !this.throttleSfx('impact', 0.05)) return;
    const s = Math.min(1, strength / 30);
    if (s > 0.4) this.duckUnder('crash', 0.35, 0.6);
    this.onBus('crash', () =>
      this.panned(pan, () => {
        this.noise(0.15 + s * 0.3, 'lowpass', 800 + s * 2500, 0.25 + s * 0.5);
        this.tone('sine', 120, 40, 0.25, 0.3 + s * 0.4);
        if (s > 0.3) this.metal(s);
      }),
    );
  }

  /** Big, low, crunchy hit for perfect rams and boss breaks — ducks everything under it. */
  heavyImpact() {
    if (!this.ctx || !this.throttleSfx('heavy', 0.1)) return;
    this.duck(0.5);
    this.duckUnder('crash', 0.6);
    this.onBus('crash', () => {
      this.tone('sine', 70, 28, 0.6, 0.9);
      this.noise(0.5, 'lowpass', 900, 0.7, 0.8, 0, 90);
      this.metal(1);
    });
  }

  /** Briefly pull the music down so critical events read. */
  duck(seconds: number) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.musicGain.gain.cancelScheduledValues(t);
    this.musicGain.gain.setTargetAtTime(this.volumes.music * 0.15, t, 0.02);
    this.musicGain.gain.setTargetAtTime(this.volumes.music * 0.5, t + seconds, 0.3);
  }

  metal(s = 0.6) {
    if (!this.ctx) return;
    for (const f of [420, 637, 911, 1290]) this.tone('square', f * (0.9 + Math.random() * 0.2), f * 0.7, 0.18 + s * 0.2, 0.025 * s);
  }

  scrape() {
    if (!this.ctx || !this.throttleSfx('scrape', 0.08)) return;
    this.onBus('tires', () => this.noise(0.12, 'bandpass', 3000, 0.08, 4));
  }

  /** Rubber and concrete: a short gritty rasp plus a tyre squeal. Clearly not a crash. */
  curbScrape(intensity: number, pan = 0) {
    if (!this.ctx || !this.throttleSfx('curb', 0.07)) return;
    const k = Math.min(1, Math.max(0.1, intensity));
    this.onBus('tires', () =>
      this.panned(pan, () => {
        this.noise(0.1, 'bandpass', 1800 + k * 1400, 0.05 + k * 0.07, 3);
        if (k > 0.35) this.tone('triangle', 1250 + k * 300, 1050, 0.09, 0.025 * k);
      }),
    );
  }

  explosion(size = 1, pan = 0) {
    if (!this.ctx || !this.throttleSfx('explosion', 0.06)) return;
    if (size > 1.2) this.duck(0.4);
    if (size > 0.9) this.duckUnder('crash', 0.4, 0.6);
    this.onBus('crash', () =>
      this.panned(pan, () => {
        this.noise(0.9 * size + 0.3, 'lowpass', 1600, 0.9, 0.7, 0, 120);
        this.tone('sine', 90, 25, 0.8 * size, 0.8);
      }),
    );
  }

  /** A heavy slab hitting the road. */
  slam(pan = 0) {
    if (!this.ctx || !this.throttleSfx('slam', 0.08)) return;
    this.duck(0.3);
    this.duckUnder('crash', 0.5);
    this.onBus('crash', () =>
      this.panned(pan, () => {
        this.tone('sine', 80, 26, 0.7, 0.9);
        this.noise(0.6, 'lowpass', 1200, 0.7, 0.8, 0, 100);
        this.metal(0.7);
      }),
    );
  }

  // ------------------------------------------------------------- enemies & weapons

  /** Short directional warning (enemy attacking from a side / behind). */
  threat(pan: number) {
    if (!this.ctx || !this.throttleSfx('threat', 0.6)) return;
    this.onBus('cue', () =>
      this.panned(pan, () => {
        this.tone('square', 980, 980, 0.07, 0.05);
        this.tone('square', 740, 740, 0.07, 0.05, 0.09);
      }),
    );
  }

  /** Truck air horn: two low detuned blasts. */
  horn(pan = 0) {
    if (!this.ctx) return;
    this.duckUnder('enemy', 0.8, 0.6);
    this.onBus('enemy', () =>
      this.panned(pan, () => {
        for (const f of [185, 233]) {
          this.tone('sawtooth', f, f * 0.98, 1.0, 0.08);
          this.tone('sawtooth', f, f * 0.98, 0.7, 0.08, 1.2);
        }
      }),
    );
  }

  /** Falling debris: a metal creak and a falling whistle. */
  debris() {
    if (!this.ctx) return;
    this.onBus('enemy', () => {
      this.metal(0.5);
      this.tone('sine', 1400, 260, 1.4, 0.05);
      this.noise(1.3, 'bandpass', 900, 0.06, 2, 0, 300);
    });
  }

  shoot(kind: 'mg' | 'flak' | 'enemy' | 'missile') {
    if (!this.ctx || !this.throttleSfx('shoot' + kind, kind === 'mg' ? 0.07 : 0.05)) return;
    this.onBus(kind === 'enemy' ? 'enemy' : 'crash', () => {
      if (kind === 'mg') this.noise(0.05, 'highpass', 2000, 0.07);
      else if (kind === 'flak') this.noise(0.18, 'lowpass', 2500, 0.25);
      else if (kind === 'missile') this.noise(0.4, 'bandpass', 900, 0.18, 2, 0, 300);
      else this.tone('square', 700, 300, 0.07, 0.04);
    });
  }

  zap() {
    if (!this.ctx || !this.throttleSfx('zap', 0.05)) return;
    this.onBus('crash', () => {
      this.tone('sawtooth', 1800, 200, 0.12, 0.08);
      this.noise(0.1, 'highpass', 4000, 0.1);
    });
  }

  emp() {
    if (!this.ctx) return;
    this.duckUnder('crash', 0.5);
    this.onBus('crash', () => {
      this.tone('sine', 1600, 60, 0.7, 0.35);
      this.tone('sawtooth', 400, 40, 0.6, 0.12);
      this.noise(0.5, 'bandpass', 3000, 0.2, 2, 0, 200);
    });
  }

  shockwave() {
    if (!this.ctx) return;
    this.duckUnder('crash', 0.4);
    this.onBus('crash', () => {
      this.tone('sine', 200, 30, 0.6, 0.6);
      this.noise(0.4, 'lowpass', 600, 0.4);
    });
  }

  nitroStart() {
    if (!this.ctx || !this.throttleSfx('nitro', 0.2)) return;
    this.onBus('engine', () => this.noise(0.6, 'bandpass', 600, 0.5, 1, 0, 3000));
  }

  // ------------------------------------------------------------- cues

  pickup() {
    if (!this.ctx || !this.throttleSfx('pickup', 0.04)) return;
    this.onBus('cue', () => {
      this.tone('square', 880, 880, 0.06, 0.06);
      this.tone('square', 1320, 1320, 0.08, 0.06, 0.05);
    });
  }

  click() {
    if (!this.ctx) return;
    this.onBus('cue', () => this.tone('square', 1200, 600, 0.04, 0.05));
  }

  hover() {
    if (!this.ctx || !this.throttleSfx('hover', 0.03)) return;
    this.onBus('cue', () => this.tone('sine', 2200, 2000, 0.03, 0.025));
  }

  nearMiss(streak: number, tier = 1) {
    if (!this.ctx || !this.throttleSfx('nm', 0.05)) return;
    this.onBus('cue', () => {
      if (tier >= 3) this.tone('sine', 1760, 2600, 0.25, 0.06);
      if (tier >= 2) this.noise(0.25, 'highpass', 3000, 0.12, 1, 0.02);
      this.noise(0.35, 'bandpass', 800 + streak * 200, 0.3, 2, 0, 2500);
      this.tone('triangle', 660 + streak * 110, 660 + streak * 110, 0.12, 0.05, 0.05);
    });
  }

  combo(level: number) {
    if (!this.ctx || !this.throttleSfx('combo', 0.1)) return;
    const base = 440 * Math.pow(2, Math.min(level, 12) / 12);
    this.onBus('cue', () => this.tone('square', base, base, 0.07, 0.04));
  }

  item() {
    if (!this.ctx) return;
    this.duckUnder('cue', 0.4, 0.6);
    this.onBus('cue', () => [523, 659, 784, 1046].forEach((f, i) => this.tone('square', f, f, 0.12, 0.06, i * 0.07)));
  }

  warning() {
    if (!this.ctx || !this.throttleSfx('warn', 0.8)) return;
    this.duckUnder('cue', 0.5, 0.55);
    this.onBus('cue', () => {
      this.tone('square', 880, 880, 0.12, 0.06);
      this.tone('square', 660, 660, 0.12, 0.06, 0.15);
    });
  }

  telegraph() {
    if (!this.ctx || !this.throttleSfx('tele', 0.25)) return;
    this.onBus('cue', () => this.tone('square', 1400, 1400, 0.05, 0.03));
  }

  bossAlert() {
    if (!this.ctx) return;
    this.duck(1.3);
    this.duckUnder('cue', 1.3);
    this.onBus('cue', () => {
      for (let i = 0; i < 3; i++) {
        this.tone('sawtooth', 220, 440, 0.35, 0.18, i * 0.45);
        this.tone('sawtooth', 440, 220, 0.35, 0.12, i * 0.45 + 0.2);
      }
    });
  }

  victory() {
    if (!this.ctx) return;
    this.duck(1);
    this.onBus('cue', () => [0, 4, 7, 12, 16].forEach((s, i) => this.tone('square', 392 * Math.pow(2, s / 12), 392 * Math.pow(2, s / 12), 0.4, 0.08, i * 0.12)));
  }

  defeat() {
    if (!this.ctx) return;
    this.duck(1.6);
    this.resultOn = true;
    this.pushScene();
    this.onBus('cue', () => [12, 8, 5, 0].forEach((s, i) => this.tone('sawtooth', 220 * Math.pow(2, s / 12), 200 * Math.pow(2, s / 12), 0.5, 0.1, i * 0.2)));
  }

  /** Duel: a hit and a rising siren when one starts, a falling one when it ends; the music goes to the chase. */
  duelOn = false;
  duel(on: boolean) {
    if (on === this.duelOn) return;
    this.duelOn = on;
    this.pushScene();
    if (!this.ctx) return;
    this.onBus('cue', () => {
      if (on) {
        this.duck(0.35);
        this.tone('sine', 110, 38, 0.5, 0.7);
        this.noise(0.5, 'bandpass', 500, 0.25, 2, 0, 2600);
        this.tone('sawtooth', 330, 660, 0.45, 0.07, 0.05);
      } else this.tone('sawtooth', 660, 330, 0.4, 0.05);
    });
  }

  /** Final stretch: the music goes to its final section (a soaring lead over a building beat). */
  climaxOn = false;
  climax(on: boolean) {
    this.climaxOn = on;
    this.pushScene();
  }

  /** Arrival stinger: a crash-cymbal swell and a resolving chord; the music drops to its result section. */
  arrival(variant: 'drift' | 'smash' | 'limp' | 'victory') {
    if (!this.ctx) return;
    this.duck(1.2);
    this.climaxOn = false;
    this.resultOn = true;
    this.pushScene();
    this.onBus('cue', () => {
      this.noise(1.6, 'highpass', 5000, 0.18, 0.7);
      const root = this.musicRoot + 12;
      const chord = variant === 'limp' ? [0, 3, 7] : [0, 7, 12, 16];
      chord.forEach((iv, i) => this.tone('sawtooth', this.midi(root + iv), this.midi(root + iv), 1.6, 0.05, 0.05 + i * 0.03));
      if (variant === 'smash') this.tone('sine', 90, 30, 0.7, 0.8);
    });
  }

  // ------------------------------------------------------------- music

  setMusic(mode: 'menu' | 'drive' | 'boss' | 'off', root?: number, scale?: number[], bpm?: number) {
    const keyChanged = (root !== undefined && root !== this.musicRoot) || (bpm !== undefined && bpm !== this.bpm) || !!scale;
    if (root !== undefined) this.musicRoot = root;
    if (scale) this.musicScale = scale;
    if (bpm) this.bpm = bpm;
    if (mode !== this.musicMode && mode !== 'boss') {
      // a new road (or the menu) starts fresh: no leftover duel / final / result state
      this.resultOn = false;
      this.climaxOn = false;
      this.duelOn = false;
    }
    if (mode === 'drive') this.resultOn = false;
    this.musicMode = mode;
    if (!this.ctx || !this.music) return;
    if (keyChanged) this.music.setKey(this.musicRoot, this.musicScale, this.bpm);
    if (mode === 'off') {
      this.music.stop();
      return;
    }
    this.pushScene();
    this.music.start();
  }

  /** Tell the arranger what is happening (it changes section on the next bar line). */
  private pushScene() {
    if (!this.music) return;
    const sc: MusicScene = {
      mode: this.musicMode,
      intensity: this.musicIntensity,
      speed: this.speed01,
      duel: this.duelOn,
      climax: this.climaxOn,
      result: this.resultOn,
    };
    this.music.scene = sc;
  }

  /** Per frame from the session: the arranger reads intensity and speed continuously. */
  updateMusic() {
    this.pushScene();
  }

  /** For the debug overlay. */
  get musicSection() {
    return this.music?.running ? this.music.section : 'off';
  }

  private midi(n: number) {
    return 440 * Math.pow(2, (n - 69) / 12);
  }
}
