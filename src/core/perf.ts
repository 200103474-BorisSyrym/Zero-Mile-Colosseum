import type * as THREE from 'three';

/**
 * Frame profiler (hidden in every build: `?perf` in the URL or F9). It times the phases of a frame, logs frame-time
 * spikes with what was going on in the frame that caused them (phases, segment builds, model builds, shader
 * compiles, uploads), and reads the renderer's counters. Off, it costs a branch per call.
 *
 * Frame time is measured start-to-start (what the player feels, including GPU waits and GC). A spike is attributed
 * to the frame before the gap — that is the frame whose work delayed the next one.
 */
export interface Spike {
  /** start-to-start interval, ms */
  ms: number;
  /** CPU time of the frame that caused it, ms */
  cpu: number;
  phases: [string, number][];
  events: string[];
  at: number;
  /** the frame it came from; its GPU time once the timer result is in (gpuOf) */
  frame: number;
}

const RING = 900;

class Perf {
  on = false;
  /** recording for a benchmark: every frame interval of the run */
  recording: number[] | null = null;
  phases = new Map<string, number>();
  private open = new Map<string, number>();
  events: string[] = [];
  private lastPhases: [string, number][] = [];
  private lastEvents: string[] = [];
  private lastCpu = 0;
  private lastStart = 0;
  private frameT0 = 0;
  frames = new Float32Array(RING);
  cpus = new Float32Array(RING);
  gpus = new Float32Array(RING);
  private n = 0;
  spikes: Spike[] = [];
  programLog: string[] = [];
  /** things built new while playing (cars, road segments): the overlay shows them per second */
  built = { car: 0, segment: 0 };
  /** a new object was built (counted with the profiler on or off: one increment) */
  count(kind: 'car' | 'segment') {
    this.built[kind]++;
  }
  phaseAvg = new Map<string, number>();
  private prevPrograms = -1;
  private prevGeo = -1;
  private prevTex = -1;
  /** latest GPU time (ms) from the timer query, or -1 when the extension is missing */
  gpuMs = -1;
  /** keep the GPU timer running with the profiler off (the AUTO quality governor reads it) */
  gpuAlways = false;
  private gl: WebGL2RenderingContext | null = null;
  private ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null = null;
  private queries: WebGLQuery[] = [];
  private pending: { q: WebGLQuery; frame: number }[] = [];
  /** GPU time per frame (ring by frame number), -1 until the result arrives */
  private gpuRing = new Float32Array(1024).fill(-1);
  private frameNo = 0;
  private active: WebGLQuery | null = null;

  /** Start of a phase (nesting is fine: phases are inclusive). */
  begin(name: string) {
    if (!this.on) return;
    this.open.set(name, performance.now());
  }
  end(name: string) {
    if (!this.on) return;
    const t = this.open.get(name);
    if (t === undefined) return;
    this.phases.set(name, (this.phases.get(name) ?? 0) + performance.now() - t);
  }
  /** Something that happened this frame (shown with a spike it causes). */
  event(text: string) {
    if (!this.on) return;
    if (this.events.length < 12) this.events.push(text);
  }

  frameBegin(now: number) {
    if (!this.on) return;
    if (this.lastStart > 0) {
      const ms = now - this.lastStart;
      const i = this.n % RING;
      this.frames[i] = ms;
      this.cpus[i] = this.lastCpu;
      this.gpus[i] = this.gpuMs;
      this.n++;
      this.recording?.push(ms);
      if (ms > 30) {
        this.spikes.push({ ms: Math.round(ms * 10) / 10, cpu: Math.round(this.lastCpu * 10) / 10, phases: this.lastPhases, events: this.lastEvents, at: now, frame: this.frameNo });
        if (this.spikes.length > 40) this.spikes.shift();
      }
    }
    this.lastStart = now;
    this.frameNo++;
    this.gpuRing[this.frameNo % 1024] = -1;
    this.frameT0 = performance.now();
    this.phases.clear();
    this.events = [];
  }

  frameEnd(renderer: THREE.WebGLRenderer) {
    if (!this.on) return;
    const info = renderer.info;
    const programs = info.programs?.length ?? 0;
    if (this.prevPrograms >= 0 && programs > this.prevPrograms) {
      // the cache key opens with the shader id (physical, standard, basic…) or, for shader materials, a source hash
      const names = info.programs!.slice(this.prevPrograms).map((p) => p.name || String(p.cacheKey).split(',')[0].slice(0, 18)).join(', ');
      this.event(`+${programs - this.prevPrograms} shader program(s): ${names}`);
      // the full keys, for working out which variant was missed (debug: zm.perf().programLog)
      for (const p of info.programs!.slice(this.prevPrograms)) if (this.programLog.length < 50) this.programLog.push(String(p.cacheKey));
    }
    if (this.prevGeo >= 0 && info.memory.geometries > this.prevGeo + 4) this.event(`+${info.memory.geometries - this.prevGeo} geometries`);
    if (this.prevTex >= 0 && info.memory.textures > this.prevTex) this.event(`+${info.memory.textures - this.prevTex} texture(s)`);
    this.prevPrograms = programs;
    this.prevGeo = info.memory.geometries;
    this.prevTex = info.memory.textures;
    this.lastCpu = performance.now() - this.frameT0;
    const list = [...this.phases.entries()].sort((a, b) => b[1] - a[1]);
    this.lastPhases = list.map(([k, v]) => [k, Math.round(v * 100) / 100] as [string, number]);
    this.lastEvents = this.events;
    for (const [k, v] of this.phases) this.phaseAvg.set(k, (this.phaseAvg.get(k) ?? v) * 0.97 + v * 0.03);
  }

  // ---- GPU timer (EXT_disjoint_timer_query_webgl2), optional
  gpuInit(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as typeof this.ext;
  }
  gpuBegin() {
    if ((!this.on && !this.gpuAlways) || !this.ext || !this.gl || this.active) return;
    const q = this.queries.pop() ?? this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = q;
  }
  gpuEnd() {
    if (!this.active || !this.ext || !this.gl) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push({ q: this.active, frame: this.frameNo });
    this.active = null;
    // read finished queries (never block: results arrive a few frames later)
    const gl = this.gl;
    while (this.pending.length) {
      const { q, frame } = this.pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
      if (!disjoint) {
        this.gpuMs = ns / 1e6;
        if (this.frameNo - frame < 1024) this.gpuRing[frame % 1024] = this.gpuMs;
      }
      this.queries.push(this.pending.shift()!.q);
    }
  }

  /** GPU time of a given frame (-1: not measured, or no longer in the ring) */
  gpuOf(frame: number) {
    return this.frameNo - frame < 1024 ? this.gpuRing[frame % 1024] : -1;
  }

  /** GPU time to feed a consumer: -1 when nobody is measuring it */
  get gpuLive() {
    return (this.on || this.gpuAlways) && this.ext ? this.gpuMs : -1;
  }

  /** Summary over the last `count` frames. */
  stats(count = 120) {
    const k = Math.min(count, this.n, RING);
    if (k === 0) return null;
    const arr: number[] = [];
    let cpu = 0, gpu = 0, gpuN = 0;
    for (let j = 0; j < k; j++) {
      const i = (this.n - 1 - j + RING) % RING;
      arr.push(this.frames[i]);
      cpu += this.cpus[i];
      if (this.gpus[i] >= 0) {
        gpu += this.gpus[i];
        gpuN++;
      }
    }
    return summarize(arr, cpu / k, gpuN ? gpu / gpuN : -1);
  }
}

export function summarize(frames: number[], cpu = -1, gpu = -1) {
  const s = [...frames].sort((a, b) => a - b);
  const sum = frames.reduce((a, b) => a + b, 0);
  const pct = (p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return {
    frames: frames.length,
    avgMs: +(sum / Math.max(1, frames.length)).toFixed(2),
    fps: +(1000 / Math.max(0.01, sum / Math.max(1, frames.length))).toFixed(1),
    p50: +pct(0.5).toFixed(1),
    p95: +pct(0.95).toFixed(1),
    p99: +pct(0.99).toFixed(1),
    worst: +(s[s.length - 1] ?? 0).toFixed(1),
    over30: frames.filter((f) => f > 30).length,
    over50: frames.filter((f) => f > 50).length,
    over100: frames.filter((f) => f > 100).length,
    cpu: +cpu.toFixed(2),
    gpu: +gpu.toFixed(2),
  };
}

export const perf = new Perf();
