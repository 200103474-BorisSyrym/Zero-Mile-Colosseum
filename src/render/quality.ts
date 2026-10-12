/**
 * Render resolution and the AUTO quality governor.
 *
 * The scene renders into the post-processing chain at `scale` pixels per CSS pixel. The quality preset sets the
 * ceiling; with AUTO QUALITY on, the governor moves the scale between FLOOR and that ceiling to hold the frame rate.
 * The number of pixels the same picture is drawn with is the only thing it ever changes: traffic, enemies, effects,
 * lights, post-processing and the simulation are never touched, and the saved preset stays what the player chose.
 *
 * Decisions are made once a second. It steps down after a slow second in which the GPU (timer query when the browser
 * has it, otherwise a frame that spends most of its time outside our code) is the bottleneck — a CPU-bound frame does
 * not get faster with fewer pixels, so then it leaves the resolution alone. It steps back up after five calm seconds,
 * only when the GPU time scaled to the bigger frame still fits, and stops trying for a while if it keeps bouncing.
 */
export const RENDER_SCALE = {
  /** LOW · MEDIUM · HIGH · VERY HIGH: scene pixels per CSS pixel, never above the display's own density */
  ceiling(preset: number, dpr: number) {
    return [0.75, 1, Math.min(dpr, 1.25), Math.min(dpr, 2)][preset] ?? 1;
  },
  floor: 0.6,
  step: 0.1,
};

const round2 = (x: number) => Math.round(x * 100) / 100;

export class ResolutionGovernor {
  /** current scene scale */
  scale = 1;
  ceiling = 1;
  /** the display's frame interval, learned from the calmest seconds (never chases more than 60 fps) */
  vsyncMs = 1000 / 60;
  /** the last decision, for the profiler overlay */
  note = '';
  private frames: number[] = [];
  private winMs = 0;
  private cpuSum = 0;
  private gpuSum = 0;
  private gpuN = 0;
  private calmS = 0;
  private coolS = 0;
  private upLockS = 0;
  private downs: number[] = [];
  private clock = 0;

  /** A new ceiling (preset or window changed). With AUTO off the scale is the ceiling. */
  setCeiling(c: number, auto: boolean) {
    const changed = c !== this.ceiling;
    this.ceiling = c;
    if (!auto) {
      this.scale = c;
      this.note = 'fixed';
      return;
    }
    // a new preset starts at its own ceiling; a window resize keeps what the governor has settled on
    this.scale = changed ? c : Math.min(Math.max(this.scale, RENDER_SCALE.floor), c);
  }

  /** Feed one frame; true when the scale changed and the targets need resizing. */
  frame(intervalMs: number, cpuMs: number, gpuMs: number, auto: boolean): boolean {
    // a stall (back from another tab, a load) says nothing about the steady load; a slow GPU's 300 ms frames do
    if (intervalMs > 1000) return false;
    this.frames.push(intervalMs);
    this.winMs += intervalMs;
    this.cpuSum += cpuMs;
    if (gpuMs >= 0) {
      this.gpuSum += gpuMs;
      this.gpuN++;
    }
    if (this.winMs < 1000) return false;

    // ---- one second
    const n = this.frames.length;
    const sorted = this.frames.sort((a, b) => a - b);
    const med = sorted[n >> 1];
    const p90 = sorted[Math.floor(n * 0.9)];
    const avg = this.winMs / n;
    const cpu = this.cpuSum / n;
    const gpu = this.gpuN ? this.gpuSum / this.gpuN : -1;
    this.frames.length = 0;
    this.winMs = 0;
    this.cpuSum = this.gpuSum = 0;
    this.gpuN = 0;
    this.clock++;
    this.vsyncMs = Math.min(this.vsyncMs * 1.01, Math.max(med, 4));
    if (!auto) return false;

    const target = Math.max(1000 / 60, this.vsyncMs);
    this.coolS = Math.max(0, this.coolS - 1);
    this.upLockS = Math.max(0, this.upLockS - 1);
    const slow = avg > target * 1.2 || p90 > target * 1.8;
    const gpuBound = gpu >= 0 ? gpu > target * 0.7 : cpu < avg * 0.6;
    if (slow) this.calmS = 0;
    if (slow && gpuBound && this.scale > RENDER_SCALE.floor + 1e-3 && this.coolS <= 0) {
      this.scale = Math.max(RENDER_SCALE.floor, round2(this.scale - RENDER_SCALE.step));
      this.coolS = 2;
      this.downs.push(this.clock);
      this.downs = this.downs.filter((t) => this.clock - t < 60);
      // three steps down in a minute: the load swings, stop climbing back for half a minute
      if (this.downs.length >= 3) this.upLockS = 30;
      this.note = `down: ${avg.toFixed(1)} ms avg, gpu ${gpu >= 0 ? gpu.toFixed(1) : '?'} ms`;
      return true;
    }
    if (slow && !gpuBound) this.note = `cpu-bound (${cpu.toFixed(1)} ms): resolution kept`;
    const calm = avg <= target * 1.08 && p90 <= target * 1.4;
    this.calmS = calm ? this.calmS + 1 : 0;
    if (this.calmS >= 5 && this.upLockS <= 0 && this.coolS <= 0 && this.scale < this.ceiling - 1e-3) {
      const next = Math.min(this.ceiling, round2(this.scale + RENDER_SCALE.step));
      const k = (next / this.scale) ** 2;
      if (gpu < 0 || gpu * k < target * 0.65) {
        this.scale = next;
        this.calmS = 0;
        this.coolS = 4;
        this.note = `up: ${avg.toFixed(1)} ms avg, gpu ${gpu >= 0 ? gpu.toFixed(1) : '?'} ms`;
        return true;
      }
    }
    return false;
  }
}
