import * as THREE from 'three';
import { perf, summarize } from '../core/perf';
import type { Game } from '../game/game';

/**
 * Real-time benchmark (debug builds, `zm.bench('C')`, or `?bench=F` on load). The game runs normally — the QA
 * autopilot drives, the profile schedules spawns, explosions, skills, chaos and bosses — and every frame interval is
 * recorded. Same seeds every time, so before / after runs compare like with like.
 *
 *   A driving · B combat · C heavy combat · D boss · E maximum chaos · F first load · G restarts (leak check)
 */
export type BenchProfile = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';

interface Peak {
  calls: number;
  tris: number;
  particles: number;
  lights: number;
  vehicles: number;
  enemies: number;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));

/** a fresh browser profile (the benchmark's) has no session: a guest on the sandbox drives */
async function ensureSignedIn(game: Game) {
  const { idos } = await import('../idos/platform');
  if (idos.online) return;
  const r = await idos.guest(false);
  if (!r.ok) throw new Error(`bench: no session (${r.error})`);
  game.signedIn(r.account);
  for (let i = 0; i < 300 && game.state !== 'MAIN_MENU'; i++) await wait(100);
}

async function startRun(game: Game, zone: number, seed: number, mode: 'ROAD' | 'BOSS') {
  const g = game as unknown as {
    launchRun(seed: number): void; startDrive(m: string): void; run: { zoneIndex: number; momentum: number } | null; state: string; qaBot: boolean;
    autoPause: () => void; save: { settings: { autoQuality: boolean } }; warm?: { run(): Promise<void> };
  };
  // the real launch waits for the shader warm-up too (Game.launchRun)
  await g.warm?.run();
  g.autoPause = () => {};
  g.save.settings.autoQuality = false;
  g.run = null;
  g.launchRun(seed);
  // the server opens the run (startRun): wait for its ticket
  const opened = () => g.run;
  for (let i = 0; i < 300 && !opened(); i++) await wait(50);
  const run = opened();
  if (!run) throw new Error('bench: the run did not open');
  run.zoneIndex = zone;
  g.startDrive(mode);
  await nextFrame();
  g.state = mode === 'BOSS' ? 'BOSS' : 'DRIVING';
  g.qaBot = true;
}

function countLights(scene: THREE.Scene) {
  let n = 0;
  scene.traverseVisible((o) => {
    const l = o as THREE.PointLight;
    if ((l.isPointLight || (o as THREE.SpotLight).isSpotLight) && l.intensity > 0) n++;
  });
  return n;
}

/** Run one profile; resolves with the measurements. */
export async function runBench(game: Game, profile: BenchProfile, seconds = 30) {
  const G = game as unknown as {
    session: import('../game/driving').DrivingSession; renderer: THREE.WebGLRenderer; worldScene: THREE.Scene; state: string;
    input: { virtualPress(a: 'ability1' | 'ability2'): void };
  };
  await ensureSignedIn(game);
  const wasOn = perf.on;
  perf.on = true;
  const zone = { A: 0, B: 1, C: 2, D: 0, E: 3, F: 0, G: 0 }[profile];
  const mode = profile === 'D' ? 'BOSS' : 'ROAD';
  const keys0 = (G.renderer.info.programs ?? []).map((p) => String(p.cacheKey));
  perf.programLog.length = 0;
  const t0 = performance.now();
  perf.spikes.length = 0;
  await startRun(game, zone, 7000 + zone, mode);
  // a few frames into the run: the launch itself (world build, first draws) is reported on its own
  for (let i = 0; i < 20; i++) await nextFrame();
  const startMs = performance.now() - t0;
  const startSpikes = perf.spikes.map((x) => ({ ms: x.ms, phases: x.phases.slice(0, 3), events: x.events }));
  const s = G.session;
  const peak: Peak = { calls: 0, tris: 0, particles: 0, lights: 0, vehicles: 0, enemies: 0 };
  const frames: number[] = [];
  perf.spikes.length = 0;
  perf.recording = frames;
  const memBefore = { geo: G.renderer.info.memory.geometries, tex: G.renderer.info.memory.textures, programs: G.renderer.info.programs?.length ?? 0 };
  const end = performance.now() + seconds * 1000;
  let nextEnemy = 2, nextBlast = 3, nextEmp = 6, nextSkill = 5, nextChaos = 8, nextMissile = 4, nextCars = 3, frame = 0;
  while (performance.now() < end) {
    await nextFrame();
    if (G.state !== 'DRIVING' && G.state !== 'BOSS') break;
    const t = (performance.now() - (end - seconds * 1000)) / 1000;
    const p = s.player;
    // the scenario
    if (profile !== 'A' && profile !== 'F' && profile !== 'G' && t > nextEnemy) {
      const n = profile === 'B' ? 2 : 3;
      for (let i = 0; i < n; i++) s.spawnEnemyAt((['interceptor', 'rammer', 'gunner', 'bomber', 'hunter'] as const)[(frame + i) % 5], p.s + 40 + i * 12, (i - 1) * 3.6, p.vF * 0.85);
      nextEnemy = t + (profile === 'B' ? 4 : 2.5);
    }
    if ((profile === 'C' || profile === 'D' || profile === 'E') && t > nextBlast) {
      const o = { x: 0, y: 0, z: 0 };
      s.world.road.toWorld(p.s + 15 + (frame % 3) * 8, ((frame % 5) - 2) * 3, o);
      s.combat.explode(o.x, o.z, 6, 20, { byPlayer: true, hurtsPlayer: false });
      nextBlast = t + (profile === 'D' ? 3 : 1.2);
    }
    if ((profile === 'C' || profile === 'E') && t > nextEmp) {
      s.combat.emp(p.pos.x, p.pos.z, 14, 10);
      nextEmp = t + 6;
    }
    if ((profile === 'C' || profile === 'E') && t > nextMissile) {
      s.combat.missiles(3, 20);
      nextMissile = t + 4;
    }
    if ((profile === 'C' || profile === 'D' || profile === 'E') && t > nextSkill) {
      p.momentum = 100;
      G.input.virtualPress(frame % 2 ? 'ability1' : 'ability2');
      nextSkill = t + 5;
    }
    if (profile === 'E' && t > nextCars) {
      const w = s.world.road.at(p.s + 40).width;
      for (let i = 0; i < 4; i++) s.spawnTrafficAt(p.s + 50 + i * 10, ((i % 3) - 1) * (w / 3.2), p.vF * 0.5);
      nextCars = t + 3;
    }
    if (profile === 'E' && t > nextChaos) {
      s.chaos.debugFire((['PILEUP', 'DEBRIS', 'ONCOMING'] as const)[frame % 3] as never);
      nextChaos = t + 8;
    }
    // peaks
    const info = G.renderer.info;
    peak.calls = Math.max(peak.calls, info.render.calls);
    peak.tris = Math.max(peak.tris, info.render.triangles);
    const fx = s.fx.stats();
    peak.particles = Math.max(peak.particles, fx.add + fx.smoke + fx.streaks + fx.glare);
    peak.vehicles = Math.max(peak.vehicles, s.vehicles.length);
    peak.enemies = Math.max(peak.enemies, s.vehicles.filter((v) => v.hostile && !v.dead).length);
    if (frame % 30 === 0) peak.lights = Math.max(peak.lights, countLights(G.worldScene));
    frame++;
  }
  perf.recording = null;
  const sum = summarize(frames);
  // what the spikes had in common
  const causes = new Map<string, number>();
  for (const sp of perf.spikes) {
    const top = sp.phases[0];
    if (top) causes.set(`phase:${top[0]}`, (causes.get(`phase:${top[0]}`) ?? 0) + 1);
    for (const e of sp.events) {
      const k = e.replace(/[\d.]+ms/, '').replace(/\+\d+/, '+n').trim();
      causes.set(k, (causes.get(k) ?? 0) + 1);
    }
    if (!sp.phases.length && !sp.events.length) causes.set('outside the frame (GC / GPU / browser)', (causes.get('outside the frame (GC / GPU / browser)') ?? 0) + 1);
  }
  const size = G.renderer.getDrawingBufferSize(new THREE.Vector2());
  const result = {
    profile,
    seconds,
    startMs: Math.round(startMs),
    startSpikes,
    warmup: (game as unknown as { warm?: { stats: unknown } }).warm?.stats,
    // shaders compiled during the run, with how their keys differ from the nearest warm one (a missed variant)
    newPrograms: perf.programLog.filter((k) => !keys0.includes(k)).map((k) => {
      const a = k.split(',');
      let best: string[] | null = null;
      for (const ok of keys0) {
        const o = ok.split(',');
        if (o[0] !== a[0]) continue;
        const d: string[] = [];
        for (let i = 0; i < Math.max(a.length, o.length); i++) if (a[i] !== o[i]) d.push(`${i}:${o[i]}>${a[i]}`);
        if (!best || d.length < best.length) best = d;
      }
      return { id: a[0], diff: best ?? 'new kind' };
    }),
    ...sum,
    peak,
    resolution: `${size.x}x${size.y}`,
    dpr: window.devicePixelRatio,
    pixelRatio: G.renderer.getPixelRatio(),
    memory: {
      geo: [memBefore.geo, G.renderer.info.memory.geometries],
      tex: [memBefore.tex, G.renderer.info.memory.textures],
      programs: [memBefore.programs, G.renderer.info.programs?.length ?? 0],
      heapMB: (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory ? Math.round((performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize / 1048576) : -1,
    },
    causes: [...causes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
    worstSpikes: [...perf.spikes].sort((a, b) => b.ms - a.ms).slice(0, 6).map((x) => ({ ms: x.ms, cpu: x.cpu, gpu: +perf.gpuOf(x.frame).toFixed(1), phases: x.phases.slice(0, 4), events: x.events })),
  };
  perf.on = wasOn;
  return result;
}

/** G: the same drive several times in a row — counters should come back to the same place each time. */
export async function runRestarts(game: Game, runs = 4, seconds = 15) {
  const out = [];
  for (let i = 0; i < runs; i++) {
    const r = await runBench(game, 'A', seconds);
    // a full collection first (the benchmark browser runs with --expose-gc): what is left is what is still referenced
    (window as unknown as { gc?: () => void }).gc?.();
    r.memory.heapMB = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory ? Math.round((performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize / 1048576) : -1;
    out.push({ run: i + 1, fps: r.fps, p99: r.p99, worst: r.worst, geo: r.memory.geo[1], tex: r.memory.tex[1], programs: r.memory.programs[1], heapMB: r.memory.heapMB, children: (game as unknown as { worldScene: THREE.Scene }).worldScene.children.length });
  }
  return out;
}
