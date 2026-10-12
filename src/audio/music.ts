/**
 * Adaptive soundtrack — original, procedural, high-energy rock/electronic.
 *
 * One band, several sections, chosen by what is happening on the road:
 *   menu    pad and a slow arpeggio
 *   cruise  bass, hats, pad — open road between fights
 *   drive   rock beat, palm-muted chugs and power chords, a 16th-note synth pulse under it
 *   chase   gallop kick and bass, chugging guitar, a lead riff on top — duels and hot fights
 *   boss    chase with a darker progression, faster
 *   final   the last stretch: a soaring lead over a building beat, snare rolls into every phrase
 *   result  a held chord and a quiet arpeggio after the gate
 * Phrases are 4 bars; every phrase picks a progression and a riff variation, the last bar of a phrase gets a fill,
 * and section changes land on bar lines with a crash — it should never sound like one loop.
 * Harmony is generic minor-key movement (i–VI–III–VII and friends) over the zone's own scale; nothing is taken
 * from any existing piece.
 */
export type Section = 'menu' | 'cruise' | 'drive' | 'chase' | 'boss' | 'final' | 'result';

export interface MusicScene {
  mode: 'menu' | 'drive' | 'boss' | 'off';
  /** 0..1 how hot the fight is */
  intensity: number;
  /** 0..1 speed relative to the car's top speed */
  speed: number;
  duel: boolean;
  climax: boolean;
  result: boolean;
}

const ENERGY: Record<Section, number> = { menu: 0, result: 0, cruise: 1, drive: 2, final: 3, chase: 3, boss: 4 };

/** Chord roots in semitones over the key root (minor-key movements). */
const PROGS: number[][] = [
  [0, 8, 3, 10],
  [0, 5, 8, 7],
  [0, 10, 8, 10],
  [0, 3, 5, 8],
  [0, 8, 5, 7],
];
const BOSS_PROGS: number[][] = [
  [0, 1, 0, 6],
  [0, 1, 8, 7],
];
const FINAL_PROGS: number[][] = [
  [8, 10, 0, 0],
  [5, 8, 10, 10],
];

/** Small seeded RNG so a zone's riffs are its own but still vary phrase to phrase. */
function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class MusicEngine {
  private bus: GainNode;
  private drums: GainNode;
  private bassBus: GainNode;
  private gtrIn: GainNode;
  private synth: GainNode;
  private lead: GainNode;
  private sweep: BiquadFilterNode;
  private timer: number | null = null;
  private next = 0;
  private step = 0;
  private bar = 0;
  section: Section = 'cruise';
  private pending: Section | null = null;
  private prog: number[] = PROGS[0];
  private lastProg = -1;
  private riff: number[] = [];
  private riffMask: number[] = [];
  private leadLine: number[] = [];
  private rnd = mulberry(1);
  private root = 45;
  private scale = [0, 3, 5, 7, 10];
  private bpm = 130;
  private menuBpm = 96;
  private fillBar = false;
  scene: MusicScene = { mode: 'off', intensity: 0.5, speed: 0, duel: false, climax: false, result: false };

  constructor(private ctx: AudioContext, out: AudioNode, private noiseBuf: AudioBuffer) {
    this.bus = ctx.createGain();
    this.bus.gain.value = 1.6;
    // a master low-pass the arrangement can sweep (builds, result fade)
    this.sweep = ctx.createBiquadFilter();
    this.sweep.type = 'lowpass';
    this.sweep.frequency.value = 18000;
    this.sweep.Q.value = 0.8;
    this.bus.connect(this.sweep).connect(out);
    this.drums = this.node(0.95);
    this.bassBus = this.node(0.8);
    this.synth = this.node(0.45);
    this.lead = this.node(0.5);
    // "guitar": detuned saws into a soft-clip waveshaper, then a cabinet-ish band (no samples)
    this.gtrIn = ctx.createGain();
    this.gtrIn.gain.value = 1;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * 6) * 0.9;
    }
    shaper.curve = curve;
    shaper.oversample = '2x';
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 110;
    const cab = ctx.createBiquadFilter();
    cab.type = 'lowpass';
    cab.frequency.value = 3400;
    cab.Q.value = 0.9;
    const gtrOut = ctx.createGain();
    gtrOut.gain.value = 0.16;
    this.gtrIn.connect(shaper).connect(hp).connect(cab).connect(gtrOut).connect(this.bus);
    this.newRiff();
  }

  private node(gain: number) {
    const g = this.ctx.createGain();
    g.gain.value = gain;
    g.connect(this.bus);
    return g;
  }

  setKey(root: number, scale: number[], bpm: number) {
    this.root = root;
    this.scale = scale;
    // the zones' tempos, pushed up into driving territory (the menu keeps a slower pulse)
    this.bpm = Math.min(152, Math.max(124, bpm + 26));
    this.menuBpm = Math.round(bpm * 0.85);
    this.rnd = mulberry(root * 131 + bpm * 7);
    this.newRiff();
  }

  start() {
    if (this.timer !== null) return;
    this.next = this.ctx.currentTime + 0.08;
    this.step = 0;
    this.bar = 0;
    this.section = this.target();
    this.pickProg();
    this.timer = window.setInterval(() => this.schedule(), 25);
  }

  stop() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  get running() {
    return this.timer !== null;
  }

  /** Where the music wants to be right now. */
  private target(): Section {
    const sc = this.scene;
    if (sc.mode === 'menu') return 'menu';
    if (sc.result) return 'result';
    if (sc.mode === 'boss') return 'boss';
    if (sc.climax) return 'final';
    if (sc.duel || (sc.intensity >= 0.9 && sc.speed > 0.45)) return 'chase';
    if (sc.intensity >= 0.6 || sc.speed > 0.72) return 'drive';
    return 'cruise';
  }

  private spb() {
    const bpm = this.section === 'menu' || this.section === 'result' ? this.menuBpm : this.section === 'boss' ? this.bpm * 1.05 : this.bpm;
    return 60 / bpm / 4;
  }

  private schedule() {
    const ctx = this.ctx;
    if (ctx.state !== 'running') return;
    while (this.next < ctx.currentTime + 0.12) {
      this.tick(this.next);
      this.next += this.spb();
    }
  }

  private pickProg() {
    const set = this.section === 'boss' ? BOSS_PROGS : this.section === 'final' ? FINAL_PROGS : PROGS;
    let i = Math.floor(this.rnd() * set.length);
    if (set === PROGS && i === this.lastProg) i = (i + 1) % set.length;
    if (set === PROGS) this.lastProg = i;
    this.prog = set[i];
    // a fresh variation of the riff every phrase: rotate, flip, mask
    if (this.rnd() < 0.5) this.riff = [...this.riff.slice(2), ...this.riff.slice(0, 2)];
    if (this.rnd() < 0.3) this.riff = this.riff.map((n) => -n);
    this.riffMask = this.riff.map(() => (this.rnd() < 0.8 ? 1 : 0));
    this.riffMask[0] = 1;
    this.leadLine = Array.from({ length: 8 }, () => this.degree(Math.floor(this.rnd() * 7) - 1));
  }

  private newRiff() {
    this.riff = Array.from({ length: 8 }, (_, i) => (i === 0 ? 0 : this.degree(Math.floor(this.rnd() * 6) - 1)));
    this.riffMask = this.riff.map(() => 1);
    this.leadLine = Array.from({ length: 8 }, () => this.degree(Math.floor(this.rnd() * 7)));
  }

  /** k-th degree of the zone scale (octaves wrap), as semitones. */
  private degree(k: number) {
    const n = this.scale.length;
    const o = Math.floor(k / n);
    return this.scale[((k % n) + n) % n] + o * 12;
  }

  private midi(n: number) {
    return 440 * Math.pow(2, (n - 69) / 12);
  }

  private tick(t: number) {
    const s16 = this.step % 16;
    if (s16 === 0) this.onBar(t);
    const sec = this.section;
    const spb = this.spb();
    const chord = this.root + this.prog[this.bar % 4];
    const lastBar = this.bar % 4 === 3;
    const fill = lastBar && this.fillBar && s16 >= 12;

    // ---- drums
    if (sec === 'drive' || sec === 'final') {
      if (s16 === 0 || s16 === 8 || (s16 === 10 && this.bar % 2 === 1) || (sec === 'final' && s16 === 6)) this.kick(t, 1);
      if ((s16 === 4 || s16 === 12) && !fill) this.snare(t, 0.9);
      if (s16 % 2 === 0) this.hat(t, s16 % 4 === 2 ? 0.07 : 0.045, false);
      if (sec === 'final' && lastBar && s16 >= 8) this.snare(t, 0.35 + (s16 - 8) * 0.07);
    } else if (sec === 'chase' || sec === 'boss') {
      if (s16 === 0 || s16 === 3 || s16 === 8 || s16 === 11 || (sec === 'boss' && s16 === 14)) this.kick(t, 1);
      if ((s16 === 4 || s16 === 12) && !fill) this.snare(t, 1);
      this.hat(t, s16 % 2 === 0 ? 0.06 : 0.035, s16 === 14);
    } else if (sec === 'cruise') {
      if (s16 === 0 || s16 === 10) this.kick(t, 0.7);
      if (s16 === 12) this.snare(t, 0.35);
      if (s16 % 2 === 0) this.hat(t, 0.035, false);
    } else if (sec === 'menu') {
      if (s16 === 0) this.kick(t, 0.45);
      if (s16 % 4 === 2) this.hat(t, 0.025, false);
    }
    if (fill && ENERGY[sec] >= 1) this.snare(t, 0.4 + (s16 - 12) * 0.15);

    // ---- bass
    if (sec === 'chase' || sec === 'boss') {
      // gallop: 16ths with the octave on the off-beats
      const oct = s16 % 4 === 3 ? 12 : 0;
      this.bass(t, this.midi(chord - 24 + oct), spb * 0.9, 0.2, 900);
    } else if (sec === 'drive' || sec === 'final') {
      if (s16 % 2 === 0) this.bass(t, this.midi(chord - 24 + (s16 === 14 ? 12 : 0)), spb * 1.8, 0.2, 700);
    } else if (sec === 'cruise') {
      if (s16 === 0 || s16 === 6 || s16 === 8 || s16 === 14) this.bass(t, this.midi(chord - 24), spb * 3, 0.17, 420);
    } else if (sec === 'menu' && s16 === 0) this.bass(t, this.midi(chord - 24), spb * 14, 0.12, 300);

    // ---- guitar: palm-muted chugs, power chords on the accents
    if (sec === 'drive' || sec === 'final') {
      if (s16 === 0 || s16 === 8) this.power(t, chord - 12, spb * 7, 1);
      else if (s16 % 2 === 0 && s16 !== 4 && s16 !== 12) this.power(t, chord - 12, spb * 0.6, 0.55, true);
    } else if (sec === 'chase' || sec === 'boss') {
      if (s16 === 0 || s16 === 6 || s16 === 10) this.power(t, chord - 12, spb * (s16 === 0 ? 5 : 3), 1);
      else if (s16 % 2 === 1 || s16 === 4) this.power(t, chord - 12, spb * 0.55, 0.5, true);
    } else if (sec === 'result' && s16 === 0 && this.bar % 2 === 0) this.power(t, chord - 12, spb * 28, 0.8);

    // ---- synth: pad on every bar, a 16th-note pulse when it drives, an arpeggio when it's calm
    if (s16 === 0 && (sec === 'cruise' || sec === 'menu' || sec === 'result' || sec === 'final')) {
      for (const iv of [0, 7, 12 + (this.scale[1] ?? 3)]) this.pad(t, this.midi(chord + iv), spb * 15, sec === 'final' ? 0.03 : 0.024);
    }
    if (sec === 'drive' || sec === 'boss') {
      const n = chord + (s16 % 4 === 0 ? 12 : s16 % 4 === 2 ? 19 : 24);
      this.pluck(t, this.midi(n), spb * 0.7, 0.022, 1800 + (s16 % 8) * 220);
    }
    if ((sec === 'cruise' || sec === 'menu' || sec === 'result') && s16 % 2 === 0) {
      const idx = ((this.step >> 1) * 3 + this.bar) % this.scale.length;
      this.pluck(t, this.midi(chord + 12 + this.scale[idx] + (s16 % 8 > 5 ? 12 : 0)), spb * 1.6, sec === 'cruise' ? 0.02 : 0.016, 1600);
    }

    // ---- lead: the riff in a chase, a long soaring line over the final stretch
    if ((sec === 'chase' || sec === 'boss') && s16 % 2 === 0 && this.bar % 4 >= 2) {
      const k = (s16 >> 1) % 8;
      if (this.riffMask[k]) this.leadNote(t, this.midi(chord + 12 + this.riff[k]), spb * 1.7, 0.05, false);
    }
    if (sec === 'final' && (s16 === 0 || s16 === 6 || s16 === 12)) {
      const k = ((this.bar % 4) * 3 + (s16 === 0 ? 0 : s16 === 6 ? 1 : 2)) % 8;
      this.leadNote(t, this.midi(chord + 24 + this.leadLine[k]), spb * (s16 === 12 ? 4 : 6), 0.055, true);
    }
    this.step++;
  }

  /** Bar line: change section if the game asks for it, new progression every phrase, crash on the way up. */
  private onBar(t: number) {
    const want = this.target();
    const phraseStart = this.bar % 4 === 0;
    let changed = false;
    if (want !== this.section) {
      // up in energy: next bar; down: wait for the phrase (no jumpy drops); result/menu: right away
      const up = ENERGY[want] > ENERGY[this.section] || want === 'result' || want === 'menu';
      if (up || phraseStart || this.pending === want) {
        const rising = ENERGY[want] > ENERGY[this.section];
        this.section = want;
        this.pending = null;
        this.bar = 0;
        changed = true;
        if (rising && ENERGY[want] >= 2) this.crash(t, 1);
      } else this.pending = want;
    }
    if (this.bar % 4 === 0 || changed) {
      this.pickProg();
      this.fillBar = this.rnd() < 0.75;
      if (!changed && ENERGY[this.section] >= 2 && this.rnd() < 0.5) this.crash(t, 0.6);
    }
    // the last stretch opens the filter bar by bar; the result closes it down
    const f = this.section === 'result' ? 2200 : this.section === 'final' ? 6000 + (this.bar % 4) * 4000 : 18000;
    this.sweep.frequency.setTargetAtTime(f, t, 0.3);
    this.bar++;
  }

  // ------------------------------------------------------------ voices

  private env(g: GainNode, t: number, peak: number, a: number, d: number) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }

  private kick(t: number, v: number) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    this.env(g, t, 0.75 * v, 0.003, 0.26);
    o.connect(g).connect(this.drums);
    o.start(t);
    o.stop(t + 0.32);
    this.noiseHit(t, 'highpass', 2500, 0.05 * v, 0.02, this.drums);
  }

  private snare(t: number, v: number) {
    this.noiseHit(t, 'bandpass', 1900, 0.32 * v, 0.17, this.drums, 0.8);
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(230, t);
    o.frequency.exponentialRampToValueAtTime(150, t + 0.08);
    this.env(g, t, 0.18 * v, 0.002, 0.1);
    o.connect(g).connect(this.drums);
    o.start(t);
    o.stop(t + 0.14);
  }

  private hat(t: number, v: number, open: boolean) {
    this.noiseHit(t, 'highpass', 7500, v, open ? 0.22 : 0.04, this.drums);
  }

  private crash(t: number, v: number) {
    this.noiseHit(t, 'highpass', 4200, 0.16 * v, 1.6, this.drums, 0.5);
  }

  private noiseHit(t: number, type: BiquadFilterType, freq: number, peak: number, dur: number, dest: AudioNode, q = 1) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    this.env(g, t, peak, 0.002, dur);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random() * 1.5, dur + 0.05);
  }

  private bass(t: number, f: number, dur: number, peak: number, cutoff: number) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f;
    const s = ctx.createOscillator();
    s.type = 'sine';
    s.frequency.value = f;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(cutoff * 2, t);
    lp.frequency.exponentialRampToValueAtTime(cutoff * 0.5, t + dur);
    lp.Q.value = 2;
    const g = ctx.createGain();
    this.env(g, t, peak, 0.004, dur);
    o.connect(lp).connect(g);
    s.connect(g);
    g.connect(this.bassBus);
    o.start(t);
    s.start(t);
    o.stop(t + dur + 0.05);
    s.stop(t + dur + 0.05);
  }

  /** Power chord (root, fifth, octave) through the distortion. muted = short palm-muted chug. */
  private power(t: number, rootMidi: number, dur: number, v: number, muted = false) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    this.env(g, t, (muted ? 0.32 : 0.42) * v, 0.004, dur);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = muted ? 900 : 5000;
    f.connect(g).connect(this.gtrIn);
    for (const iv of muted ? [0, 7] : [0, 7, 12]) {
      for (const det of [-7, 6]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = this.midi(rootMidi + iv);
        o.detune.value = det;
        o.connect(f);
        o.start(t);
        o.stop(t + dur + 0.05);
      }
    }
  }

  private pad(t: number, f: number, dur: number, peak: number) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + dur * 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1100;
    lp.connect(g).connect(this.synth);
    for (const det of [-9, 8]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.detune.value = det;
      o.connect(lp);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
  }

  private pluck(t: number, f: number, dur: number, peak: number, cutoff: number) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = f;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(cutoff, t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(200, cutoff * 0.25), t + dur);
    const g = ctx.createGain();
    this.env(g, t, peak, 0.003, dur);
    o.connect(lp).connect(g).connect(this.synth);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  /** Lead voice: a bright saw with vibrato; `soar` slides into the note and holds it. */
  private leadNote(t: number, f: number, dur: number, peak: number, soar: boolean) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    if (soar) {
      o.frequency.setValueAtTime(f * 0.94, t);
      o.frequency.exponentialRampToValueAtTime(f, t + 0.09);
    } else o.frequency.value = f;
    const vib = ctx.createOscillator();
    vib.frequency.value = 5.6;
    const vg = ctx.createGain();
    vg.gain.value = soar ? 7 : 3;
    vib.connect(vg).connect(o.detune);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = soar ? 4200 : 3000;
    lp.Q.value = 3;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + (soar ? 0.06 : 0.01));
    g.gain.setValueAtTime(peak, t + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(lp).connect(g).connect(this.lead);
    o.start(t);
    vib.start(t);
    o.stop(t + dur + 0.05);
    vib.stop(t + dur + 0.05);
  }
}
