import './style.css';
import { DEBUG_ENABLED } from './core/debug';
import { Game } from './game/game';

async function boot() {
  const msg = document.getElementById('boot-msg')!;
  try {
    // fonts are used by canvas-generated neon signs, so make sure they are ready first
    await Promise.race([
      Promise.all([document.fonts.load('700 40px Rajdhani'), document.fonts.load('600 16px Barlow')]),
      new Promise((r) => setTimeout(r, 2500)),
    ]);
  } catch {
    /* fall back to system fonts */
  }
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const ui = document.getElementById('ui')!;
  let game: Game;
  try {
    game = new Game(canvas, ui);
  } catch (e) {
    console.error(e);
    msg.textContent = 'WEBGL UNAVAILABLE — PLEASE USE A MODERN BROWSER WITH HARDWARE ACCELERATION';
    return;
  }
  if (DEBUG_ENABLED) (window as unknown as { zm: unknown }).zm = game.debugApi();
  msg.textContent = 'COMPILING SHADERS...';
  // shaders and the iDos session in parallel; the boot screen stays up until the first real screen is ready
  await game.start((stage) => (msg.textContent = stage));
  const w = window as unknown as { __boot: Record<string, number>; __bench: unknown };
  w.__boot = { gameReadyMs: Math.round(performance.now()) };
  requestAnimationFrame(() => (w.__boot.firstFrameMs = Math.round(performance.now())));
  // ?debug&bench=F: the first-load benchmark, straight from a cold page
  const bench = DEBUG_ENABLED ? new URLSearchParams(location.search).get('bench') : null;
  const benchSec = Number(new URLSearchParams(location.search).get('benchSec') ?? 25);
  if (bench) setTimeout(() => void import('./dev/bench').then(async (m) => (w.__bench = bench === 'G' ? await m.runRestarts(game) : await m.runBench(game, bench as never, benchSec))), 300);
  const bootEl = document.getElementById('boot')!;
  bootEl.style.opacity = '0';
  setTimeout(() => bootEl.remove(), 600);
}

void boot();
