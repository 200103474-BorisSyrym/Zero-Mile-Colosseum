/** Seeded RNG (mulberry32). All gameplay generation goes through this. */
export class Random {
  private s: number;
  constructor(public readonly seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number) {
    return a + (b - a) * this.next();
  }
  int(a: number, b: number) {
    return Math.floor(this.range(a, b + 1));
  }
  chance(p: number) {
    return this.next() < p;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  sign() {
    return this.next() < 0.5 ? -1 : 1;
  }
  weighted<T>(entries: readonly (readonly [T, number])[]): T {
    let total = 0;
    for (const e of entries) total += Math.max(0, e[1]);
    let r = this.next() * total;
    for (const e of entries) {
      r -= Math.max(0, e[1]);
      if (r <= 0) return e[0];
    }
    return entries[entries.length - 1][0];
  }
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  /** Derive an independent child stream. */
  fork(salt: number): Random {
    return new Random((this.seed * 2654435761 + salt * 40503 + 12345) >>> 0);
  }
}

export const newSeed = () => (Math.floor(Math.random() * 900000) + 100000) >>> 0;
/** Cosmetic-only randomness (particles etc.) — not seeded on purpose. */
export const frand = (a = 0, b = 1) => a + (b - a) * Math.random();
