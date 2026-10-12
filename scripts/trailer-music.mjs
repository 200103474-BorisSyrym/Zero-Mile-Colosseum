// The trailer's soundtrack: an original synthwave/rock cue rendered in code, cut to the trailer's own edit.
//
// renderMusic(plan) takes the plan zm.trailer() hands back (each shot's name and slot length, and the dissolve
// length) and returns stereo samples. Every cut sits on a beat of a 120 BPM grid, so the music is written against the
// shot list itself: a pad and a hit on the title, the full groove under the roads, a lighter build under the run's
// screens, a half-time drop for the boss, a brighter progression under the street, and a last hit on the end card.
// Nothing is sampled: kick, snare, hats, bass, pad, arpeggio, risers and impacts are all synthesized here.

const SR = 44100;
const BEAT = 0.5;
const BAR = 2;
const TAU = Math.PI * 2;

const hz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

/** a small deterministic noise source: the same film every render */
function makeNoise(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 4294967296) * 2 - 1;
  };
}

export function renderMusic(plan) {
  const start = {};
  let total = 0;
  for (const s of plan.shots) {
    start[s.name] = total;
    total += s.len;
  }
  const at = (name, fallback) => start[name] ?? fallback;
  // the film's cuts dissolve over plan.xf seconds; the beat lands in the middle of each dissolve
  const off = plan.xf / 2;
  const N = Math.ceil((total + 0.1) * SR);
  const noise = makeNoise(7);

  const bus = () => ({ L: new Float32Array(N), R: new Float32Array(N) });
  const drums = bus();
  const bass = bus();
  const pad = bus();
  const arp = bus();
  const fx = bus();
  const send = bus(); // reverb send
  const duck = new Float32Array(N).fill(1);

  const idx = (t) => Math.round((t + off) * SR);
  const put = (b, i, v, pan = 0) => {
    if (i < 0 || i >= N) return;
    b.L[i] += v * (1 - Math.max(0, pan));
    b.R[i] += v * (1 + Math.min(0, pan));
  };

  // ------------------------------------------------------------------ instruments

  const kicks = [];
  function kick(t, amp = 1) {
    kicks.push(t);
    const i0 = idx(t);
    let ph = 0;
    for (let k = 0; k < 0.45 * SR; k++) {
      const tt = k / SR;
      const f = 44 + 120 * Math.exp(-tt * 32);
      ph += (TAU * f) / SR;
      const body = Math.sin(ph) * Math.exp(-tt * 6.5);
      const click = noise() * Math.exp(-tt * 400) * 0.25;
      put(drums, i0 + k, (body + click) * amp);
    }
  }

  function snare(t, amp = 1) {
    const i0 = idx(t);
    let lp = 0;
    for (let k = 0; k < 0.28 * SR; k++) {
      const tt = k / SR;
      const n = noise();
      lp += 0.35 * (n - lp);
      const hiss = (n - lp) * Math.exp(-tt * 16) * 0.55;
      const tone = Math.sin(TAU * 188 * tt) * Math.exp(-tt * 28) * 0.45;
      const v = (hiss + tone) * amp;
      put(drums, i0 + k, v);
      put(send, i0 + k, v * 0.25);
    }
  }

  function hat(t, amp = 1, open = false, pan = 0.2) {
    const i0 = idx(t);
    let lp = 0;
    const len = open ? 0.25 : 0.06;
    for (let k = 0; k < len * SR; k++) {
      const tt = k / SR;
      const n = noise();
      lp += 0.6 * (n - lp);
      put(drums, i0 + k, (n - lp) * Math.exp(-tt * (open ? 14 : 70)) * 0.22 * amp, pan);
    }
  }

  /** a soft crash: long noise, bright, into the reverb */
  function crash(t, amp = 1) {
    const i0 = idx(t);
    let lp = 0;
    for (let k = 0; k < 1.8 * SR; k++) {
      const tt = k / SR;
      const n = noise();
      lp += 0.5 * (n - lp);
      const v = (n - lp) * Math.exp(-tt * 2.6) * 0.16 * amp;
      put(drums, i0 + k, v, k % 2 ? 0.3 : -0.3);
      put(send, i0 + k, v * 0.5);
    }
  }

  /** state-variable low-pass, run per voice */
  function svf() {
    let low = 0;
    let band = 0;
    return (x, fc, q = 0.7) => {
      const f = 2 * Math.sin((Math.PI * Math.min(fc, SR / 6)) / SR);
      low += f * band;
      const high = x - low - q * band;
      band += f * high;
      return low;
    };
  }

  function bassNote(t, dur, midi, amp = 1, drive = 0) {
    const i0 = idx(t);
    const f = hz(midi);
    const flt = svf();
    let p1 = 0;
    let p2 = 0;
    let ps = 0;
    const n = Math.floor(dur * SR);
    for (let k = 0; k < n + 0.03 * SR; k++) {
      const tt = k / SR;
      p1 = (p1 + f / SR) % 1;
      p2 = (p2 + (f * 1.004) / SR) % 1;
      ps += (TAU * f) / SR;
      const saw = (p1 * 2 - 1 + (p2 * 2 - 1)) * 0.5;
      const cut = 180 + 1400 * Math.exp(-tt * 10) + drive * 600;
      let v = flt(saw, cut, 0.5) * 0.8 + Math.sin(ps) * 0.6;
      if (drive) v = Math.tanh(v * (1 + drive * 3)) * 0.8;
      const env = Math.min(1, tt / 0.004) * (k > n ? Math.max(0, 1 - (k - n) / (0.03 * SR)) : 1);
      put(bass, i0 + k, v * env * amp);
    }
  }

  function padChord(t, dur, notes, amp = 1, bright = 1) {
    const i0 = idx(t);
    const n = Math.floor(dur * SR);
    const rel = 0.5 * SR;
    notes.forEach((midi, ni) => {
      const voices = [-0.08, 0, 0.08].map((cents, vi) => ({ f: hz(midi) * Math.pow(2, cents / 12), p: (ni * 0.13 + vi * 0.37) % 1, pan: (vi - 1) * 0.6 }));
      let lpL = 0;
      let lpR = 0;
      const a = 1 - Math.exp((-TAU * 1500 * bright) / SR);
      for (let k = 0; k < n + rel; k++) {
        const tt = k / SR;
        let l = 0;
        let r = 0;
        for (const v of voices) {
          v.p = (v.p + v.f / SR) % 1;
          const s = v.p * 2 - 1;
          l += s * (1 - Math.max(0, v.pan));
          r += s * (1 + Math.min(0, v.pan));
        }
        lpL += a * (l - lpL);
        lpR += a * (r - lpR);
        const env = Math.min(1, tt / 0.35) * (k > n ? Math.max(0, 1 - (k - n) / rel) : 1);
        const g = env * amp * 0.12;
        const i = i0 + k;
        if (i < 0 || i >= N) continue;
        pad.L[i] += lpL * g;
        pad.R[i] += lpR * g;
        send.L[i] += lpL * g * 0.4;
        send.R[i] += lpR * g * 0.4;
      }
    });
  }

  function pluck(t, midi, amp = 1, pan = 0, bright = 1) {
    const i0 = idx(t);
    const f = hz(midi);
    const flt = svf();
    let p = 0;
    for (let k = 0; k < 0.22 * SR; k++) {
      const tt = k / SR;
      p = (p + f / SR) % 1;
      const pulse = (p < 0.35 ? 1 : -1) * 0.7 + (p * 2 - 1) * 0.3;
      const v = flt(pulse, 400 + 3200 * bright * Math.exp(-tt * 18), 0.3) * Math.exp(-tt * 9) * amp;
      put(arp, i0 + k, v, pan);
    }
  }

  function impact(t, amp = 1) {
    kicks.push(t);
    const i0 = idx(t);
    let ph = 0;
    let lp = 0;
    for (let k = 0; k < 2.4 * SR; k++) {
      const tt = k / SR;
      const f = 30 + 60 * Math.exp(-tt * 5);
      ph += (TAU * f) / SR;
      const boom = Math.sin(ph) * Math.exp(-tt * 1.6) * 0.9;
      const n = noise();
      lp += 0.08 * (n - lp);
      const thud = lp * Math.exp(-tt * 3) * 2.2;
      const v = (boom + thud) * amp;
      put(fx, i0 + k, v);
      put(send, i0 + k, v * 0.35);
    }
    crash(t, 0.8 * amp);
  }

  /** a noise riser from t0 to t1, then silence: the next downbeat lands in the gap */
  function riser(t0, t1, amp = 1) {
    const i0 = idx(t0);
    const n = Math.floor((t1 - t0) * SR);
    const flt = svf();
    let ph = 0;
    for (let k = 0; k < n; k++) {
      const x = k / n;
      const fc = 300 * Math.pow(30, x);
      const v = flt(noise(), fc, 0.25) * 0.5 * x * x;
      ph += (TAU * (200 + 900 * x * x)) / SR;
      const tone = Math.sin(ph) * 0.08 * x * x;
      const fade = k > n - 0.01 * SR ? (n - k) / (0.01 * SR) : 1;
      put(fx, i0 + k, (v + tone) * amp * fade, Math.sin(x * 20) * 0.3);
      put(send, i0 + k, v * amp * 0.3 * fade);
    }
  }

  /** a short swish across a cut */
  function whoosh(tc, amp = 1) {
    const i0 = idx(tc - 0.3);
    const n = Math.floor(0.5 * SR);
    const flt = svf();
    for (let k = 0; k < n; k++) {
      const x = k / n;
      const bell = Math.sin(Math.PI * x) ** 2;
      const v = flt(noise(), 6000 * Math.pow(0.12, x), 0.4) * bell * 0.35 * amp;
      put(fx, i0 + k, v, x * 1.4 - 0.7);
    }
  }

  // ------------------------------------------------------------------ the score

  const A = 33; // A1
  const MAIN = [
    { pad: [57, 60, 64], root: A, arp: [69, 72, 76, 72] }, // Am
    { pad: [57, 60, 65], root: A - 4, arp: [65, 69, 72, 69] }, // F
    { pad: [55, 60, 64], root: A + 3, arp: [67, 72, 76, 72] }, // C
    { pad: [55, 59, 62], root: A - 2, arp: [67, 71, 74, 71] }, // G
  ];
  const STREET = [MAIN[1], MAIN[2], MAIN[3], MAIN[0]]; // F C G Am: the lift
  const BOSS = [
    { pad: [57, 60, 64], root: A, arp: [69, 72, 76, 72] }, // Am
    { pad: [58, 62, 65], root: A + 1, arp: [70, 74, 77, 74] }, // Bb
  ];

  const tCombat = at('combat', 4);
  const tRun = at('reward', 14);
  const tBoss = at('boss', 22);
  const tStreet = at('garage', 26);
  const tDuel = at('duel', 36);
  const tEnd = at('end', total - 4);
  const tLogo = at('open', 0) + 2;

  // intro: the city at night
  padChord(0, tLogo + 0.05, MAIN[0].pad, 0.9, 0.6);
  for (let t = 0; t < tCombat; t += BEAT) hat(t + BEAT / 2, 0.35);
  impact(tLogo, 1);
  padChord(tLogo, tCombat - tLogo, MAIN[1].pad, 1, 0.9);
  for (let t = tLogo; t < tCombat - 0.01; t += BEAT / 2) pluck(t, MAIN[1].arp[Math.round((t - tLogo) / (BEAT / 2)) % 4], 0.6 * ((t - tLogo) / (tCombat - tLogo)), 0.3, 0.5);
  bassNote(tLogo, tCombat - tLogo - 0.1, A - 4, 0.5);
  riser(tCombat - 1.5, tCombat - 0.02, 1);

  /** a groove from t0 to t1 over a progression; kind: 'full' | 'light' | 'half' */
  function groove(t0, t1, prog, kind, opts = {}) {
    const bright = opts.bright ?? 1;
    for (let bar = 0; t0 + bar * BAR < t1 - 0.01; bar++) {
      const tb = t0 + bar * BAR;
      const ch = prog[bar % prog.length];
      const barEnd = Math.min(t1, tb + BAR);
      padChord(tb, barEnd - tb, ch.pad, 1, bright);
      for (let b = 0; b < 4; b++) {
        const t = tb + b * BEAT;
        if (t >= t1 - 0.01) break;
        if (kind === 'full') {
          kick(t, 1);
          if (b % 2 === 1) snare(t, 0.9);
        } else if (kind === 'light') {
          if (b % 2 === 0) kick(t, 0.9);
        } else if (kind === 'half') {
          if (b === 0) kick(t, 1.1);
          if (b === 1) kick(t + BEAT / 2, 0.9);
          if (b === 2) snare(t, 1.1);
        }
        // hats: 16ths in the full groove, 8ths elsewhere
        const steps = kind === 'full' ? 4 : 2;
        for (let s = 0; s < steps; s++) {
          const th = t + (s * BEAT) / steps;
          if (th >= t1 - 0.01) break;
          const off8 = steps === 4 ? s === 2 : s === 1;
          hat(th, off8 ? 1 : 0.55, off8 && kind === 'full' && b === 3, s % 2 ? 0.25 : -0.15);
        }
        // bass: driving 8ths, an octave on the off-beat
        if (kind === 'half') {
          if (b === 0) bassNote(t, BAR - 0.05, ch.root, 0.75, 0.8);
        } else {
          for (let e = 0; e < 2; e++) {
            const te = t + (e * BEAT) / 2;
            if (te >= t1 - 0.01) break;
            bassNote(te, BEAT / 2 - 0.03, ch.root + (e === 1 && b % 2 === 1 ? 12 : 0), 0.7);
          }
        }
        // arpeggio: 16ths over the chord
        if (kind !== 'half' || b >= 2) {
          for (let s = 0; s < 4; s++) {
            const ta = t + (s * BEAT) / 4;
            if (ta >= t1 - 0.01) break;
            const note = ch.arp[(b * 4 + s) % ch.arp.length] + (opts.up ? 12 : 0);
            pluck(ta, note, kind === 'light' ? 0.7 : 0.85, s % 2 ? 0.35 : -0.35, bright);
          }
        }
      }
    }
  }

  /** a snare roll into a downbeat */
  function roll(t1, beats = 1) {
    const n = beats * 8;
    for (let k = 0; k < n; k++) snare(t1 - beats * BEAT + (k * beats * BEAT) / n, 0.35 + (0.6 * k) / n);
  }

  // the roads
  crash(tCombat, 1);
  groove(tCombat, tRun, MAIN, 'full');
  // the run's screens: lighter, building
  crash(tRun, 0.7);
  groove(tRun, tBoss, MAIN, 'light', { bright: 1.2 });
  roll(tBoss, 1);
  riser(tBoss - 2, tBoss - 0.02, 0.9);
  // the boss: half time, heavy
  impact(tBoss, 1);
  groove(tBoss, tStreet, BOSS, 'half', { bright: 0.8 });
  riser(tStreet - 1, tStreet - 0.02, 0.7);
  // the street: the lift
  impact(tStreet, 0.8);
  groove(tStreet, tEnd, STREET, 'full', { bright: 1.3, up: true });
  crash(tDuel, 0.9);
  roll(tEnd, 1);
  riser(tEnd - 2, tEnd - 0.02, 1);
  // the end card
  impact(tEnd, 1.2);
  padChord(tEnd, total - tEnd - 0.6, [57, 60, 64, 71], 1.2, 0.7);
  bassNote(tEnd, total - tEnd - 0.8, A, 0.5);

  // a swish on every cut that has no hit of its own
  const hits = new Set([tCombat, tBoss, tStreet, tEnd, tRun].map((t) => t.toFixed(2)));
  for (const s of plan.shots) {
    const t = start[s.name];
    if (t > 0 && !hits.has(t.toFixed(2))) whoosh(t, 0.8);
  }

  // ------------------------------------------------------------------ the mix

  // side-chain: pad, bass and arpeggio breathe with the kick
  for (const t of kicks) {
    const i0 = idx(t);
    for (let k = 0; k < 0.4 * SR; k++) {
      const i = i0 + k;
      if (i < 0 || i >= N) continue;
      const tt = k / SR;
      const g = 1 - 0.55 * Math.min(1, tt / 0.004) * Math.exp(-tt / 0.1);
      if (g < duck[i]) duck[i] = g;
    }
  }

  // ping-pong delay on the arpeggio (a dotted eighth)
  {
    const d = Math.round(0.375 * SR);
    for (let i = d; i < N; i++) {
      arp.L[i] += arp.R[i - d] * 0.32;
      arp.R[i] += arp.L[i - d] * 0.32;
    }
  }

  // reverb: four combs and two all-passes per side (Schroeder)
  const verb = (x, combs, aps) => {
    const y = new Float32Array(N);
    for (const len of combs) {
      const buf = new Float32Array(len);
      let j = 0;
      let lp = 0;
      for (let i = 0; i < N; i++) {
        const out = buf[j];
        lp += 0.3 * (out - lp);
        buf[j] = x[i] + lp * 0.8;
        y[i] += out * 0.25;
        j = (j + 1) % len;
      }
    }
    for (const len of aps) {
      const buf = new Float32Array(len);
      let j = 0;
      for (let i = 0; i < N; i++) {
        const b = buf[j];
        const v = y[i];
        buf[j] = v + b * 0.5;
        y[i] = b - v * 0.5;
        j = (j + 1) % len;
      }
    }
    return y;
  };
  const revL = verb(send.L, [1557, 1617, 1491, 1422], [225, 556]);
  const revR = verb(send.R, [1580, 1640, 1514, 1445], [248, 579]);

  const left = new Float32Array(N);
  const right = new Float32Array(N);
  let peak = 0;
  const fadeFrom = Math.round((total - 1.2) * SR);
  for (let i = 0; i < N; i++) {
    const du = duck[i];
    let l = drums.L[i] * 0.9 + bass.L[i] * 0.5 * du + pad.L[i] * 0.55 * du + arp.L[i] * 0.16 * du + fx.L[i] * 0.55 + revL[i] * 0.45;
    let r = drums.R[i] * 0.9 + bass.R[i] * 0.5 * du + pad.R[i] * 0.55 * du + arp.R[i] * 0.16 * du + fx.R[i] * 0.55 + revR[i] * 0.45;
    l = Math.tanh(l * 1.1);
    r = Math.tanh(r * 1.1);
    if (i > fadeFrom) {
      const f = Math.max(0, 1 - (i - fadeFrom) / (1.2 * SR));
      l *= f;
      r *= f;
    }
    left[i] = l;
    right[i] = r;
    peak = Math.max(peak, Math.abs(l), Math.abs(r));
  }
  const norm = peak > 0 ? 0.89 / peak : 1;
  for (let i = 0; i < N; i++) {
    left[i] *= norm;
    right[i] *= norm;
  }
  return { sampleRate: SR, left, right, seconds: total };
}

/** 16-bit stereo PCM WAV */
export function wavBuffer({ sampleRate, left, right }) {
  const n = left.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 4, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, left[i])) * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, right[i])) * 32767), 46 + i * 4);
  }
  return buf;
}
