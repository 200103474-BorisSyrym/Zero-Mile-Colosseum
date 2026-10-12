// npm run trailer — records and cuts the ~50 s pitch trailer on this computer.
//
// 1. Record. Starts the dev server, opens the game in your Chrome (or Edge), signs in a guest on the DEV sandbox and
//    runs `zm.trailer()` (src/dev/trailer.ts): the window goes full screen and every shot is recorded as its own clip
//    (roads driven by the autopilot in real time on your GPU, then the part cards, the map, a boss, the garage, the
//    Solana sign-in, the street, a PvP duel, the depot and the weekly Shift). Clips and the edit plan go to
//    trailer/clips/; screenshots for the README go to docs/media/.
// 2. Score. scripts/trailer-music.mjs renders an original soundtrack cut to the same plan (trailer/soundtrack.wav).
// 3. Cut. ffmpeg joins the clips with transitions, lays the soundtrack over the game's sound effects and writes
//    trailer/zero-mile-trailer.mp4 (1920×1080, 60 fps).
//
// It needs a real window (a headless browser records black) and ffmpeg on the PATH for step 3.
//
// Options:  --edit-only          skip recording: re-score and re-cut the clips already in trailer/clips/
//           --music=<file>       use your own track instead of the generated one
//           --browser=<path>     a Chrome/Chromium executable (or CHROME_PATH)
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderMusic, wavBuffer } from './trailer-music.mjs';

const args = process.argv.slice(2);
const opt = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const editOnly = args.includes('--edit-only');
const exe = opt('browser') || process.env.CHROME_PATH;
const ownMusic = opt('music');

const outDir = resolve('trailer');
const clipDir = resolve(outDir, 'clips');
const planFile = resolve(clipDir, 'plan.json');
const music = resolve(outDir, 'soundtrack.wav');
const mp4 = resolve(outDir, 'zero-mile-trailer.mp4');
const media = resolve('docs', 'media');

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
if (!hasFfmpeg) {
  console.error('ffmpeg is needed to cut the film. Install it (Windows: winget install ffmpeg · macOS: brew install ffmpeg) and run again.');
  process.exit(1);
}

// ---------------------------------------------------------------- 1. record

async function record() {
  const { createServer } = await import('vite');
  const { chromium } = await import('playwright-core');
  rmSync(clipDir, { recursive: true, force: true });
  mkdirSync(clipDir, { recursive: true });
  mkdirSync(media, { recursive: true });

  const server = await createServer({ logLevel: 'error', server: { port: 5191, strictPort: false } });
  await server.listen();
  const url = server.resolvedUrls.local[0];
  console.log(`dev server: ${url}`);

  const flags = [
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--ignore-gpu-blocklist',
    '--window-size=1920,1080',
    '--force-device-scale-factor=1',
    // record the tab without the "choose what to share" dialog
    '--auto-accept-this-tab-capture',
    '--auto-select-tab-capture-source-by-title=ZERO MILE',
  ];
  const launch = async () => {
    const base = { headless: false, args: flags };
    if (exe) return chromium.launch({ ...base, executablePath: exe });
    for (const channel of ['chrome', 'msedge', 'chromium']) {
      try {
        return await chromium.launch({ ...base, channel });
      } catch {}
    }
    throw new Error('No Chrome or Edge found. Install Google Chrome, or pass --browser=<path to chrome>.');
  };

  let browser;
  let closed = false;
  const closeAll = async () => {
    if (closed) return;
    closed = true;
    await browser?.close().catch(() => {});
    await server.close().catch(() => {});
  };
  // Playwright can reject an internal promise once the browser is gone; by then the work is done
  process.on('unhandledRejection', (e) => {
    if (closed || (e instanceof Error && e.name === 'TargetClosedError')) return;
    console.error(e);
    process.exit(1);
  });
  try {
    browser = await launch();
    // the real window, not an emulated viewport: the tab capture records what is actually on screen
    const page = await browser.newPage({ viewport: null });
    page.on('pageerror', (e) => console.log(`[page error] ${e.message}`));
    page.on('console', (m) => m.text().startsWith('[trailer]') && console.log(m.text()));
    // screenshots of whole screens (UI included) for the README: the middle 16:9 of the window
    await page.exposeFunction('zmSnap', async (name) => {
      const { w, h } = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
      const cw = Math.min(w, Math.round((h * 16) / 9));
      const ch = Math.round((cw * 9) / 16);
      await page.screenshot({ path: resolve(media, `${name}.jpg`), type: 'jpeg', quality: 88, clip: { x: (w - cw) / 2, y: (h - ch) / 2, width: cw, height: ch } });
      console.log(`saved docs/media/${name}.jpg`);
    });
    // each clip arrives in base64 chunks as soon as its shot is done
    await page.exposeFunction('zmClip', async (file, part, b64, last) => {
      const path = resolve(clipDir, file);
      if (part === 0) writeFileSync(path, Buffer.from(b64, 'base64'));
      else appendFileSync(path, Buffer.from(b64, 'base64'));
      if (last) console.log(`  saved clips/${file}`);
    });
    // a fresh profile: no remembered session, the trailer signs a guest in on the DEV sandbox
    await page.goto(`${url}?debug&idos=dev`);
    console.log('loading the game…');
    await page.waitForFunction(() => {
      const s = window.zm?.state();
      return s === 'SIGN_IN' || s === 'MAIN_MENU';
    }, null, { timeout: 180_000, polling: 500 });
    console.log('recording (about two minutes with the set-up between shots — leave the window alone)…');
    const recorded = page.evaluate(() => window.zm.trailer());
    recorded.catch(() => {});
    // the tab capture needs a click: the trailer puts up a button for it
    await page.waitForSelector('#zm-trailer-start', { timeout: 300_000 });
    await page.click('#zm-trailer-start');
    await page.mouse.move(0, 0);
    const plan = await recorded;
    writeFileSync(planFile, JSON.stringify(plan, null, 2));
    // clean 3D stills of the game for the README (docs/media/*.jpg)
    const stills = await page.evaluate(() => window.zmTrailer?.stills ?? {});
    for (const [name, data] of Object.entries(stills)) {
      writeFileSync(resolve(media, `${name}.jpg`), Buffer.from(data.split(',')[1], 'base64'));
      console.log(`saved docs/media/${name}.jpg`);
    }
  } finally {
    await closeAll();
  }
}

// ---------------------------------------------------------------- 2. score

function score(plan) {
  if (ownMusic) {
    console.log(`soundtrack: ${ownMusic}`);
    return resolve(ownMusic);
  }
  console.log('scoring the soundtrack…');
  writeFileSync(music, wavBuffer(renderMusic(plan)));
  console.log(`saved ${music}`);
  return music;
}

// ---------------------------------------------------------------- 3. cut

function hasAudio(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim().length > 0;
}

function cut(plan, track) {
  const shots = plan.shots;
  const xf = plan.xf;
  const total = shots.reduce((n, s) => n + s.len, 0);
  const inputs = [];
  const f = [];
  shots.forEach((s, i) => {
    inputs.push('-i', resolve(clipDir, s.file));
    const d = (s.len + (i < shots.length - 1 ? xf : 0)).toFixed(3);
    // every clip: 1920×1080 (the middle 16:9 of the screen), 60 fps, exactly its slot plus the dissolve
    f.push(`[${i}:v]setpts=PTS-STARTPTS,fps=60,scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1,format=yuv420p,tpad=stop_mode=clone:stop_duration=2,trim=duration=${d},setpts=PTS-STARTPTS,settb=AVTB[v${i}]`);
    if (hasAudio(resolve(clipDir, s.file))) f.push(`[${i}:a]aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS,apad,atrim=duration=${d},asetpts=PTS-STARTPTS[a${i}]`);
    else f.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${d}[a${i}]`);
  });
  // the joins: each transition starts where the outgoing shot's slot ends
  let v = 'v0';
  let a = 'a0';
  let at = 0;
  for (let i = 1; i < shots.length; i++) {
    at += shots[i - 1].len;
    f.push(`[${v}][v${i}]xfade=transition=${shots[i].trans}:duration=${xf}:offset=${at.toFixed(3)}[vx${i}]`);
    f.push(`[${a}][a${i}]acrossfade=d=${xf}:c1=tri:c2=tri[ax${i}]`);
    v = `vx${i}`;
    a = `ax${i}`;
  }
  // the soundtrack over the game's sound effects, kept low underneath
  const m = shots.length;
  inputs.push('-i', track);
  f.push(`[${a}]volume=0.32[sfx]`);
  f.push(`[${m}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration=${total},afade=t=out:st=${(total - 1.2).toFixed(2)}:d=1.2[mus]`);
  f.push(`[mus][sfx]amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.84:level=0,loudnorm=I=-14:TP=-2:LRA=11,aresample=48000[aout]`);
  f.push(`[${v}]trim=duration=${total},fade=t=in:st=0:d=0.3[vout]`);
  // the graph goes on the command line (about 8 KB): -filter_complex_script is gone from ffmpeg 7 and its successor
  // is missing from older builds; a copy is kept next to the film for reading
  const graph = f.join(';');
  writeFileSync(resolve(outDir, 'edit.ffgraph'), f.join(';\n'));
  console.log('cutting the film…');
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-stats', ...inputs, '-filter_complex', graph, '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-r', '60', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', '-t', String(total), mp4], { stdio: 'inherit' });
  if (r.status !== 0 || !existsSync(mp4)) throw new Error('ffmpeg could not cut the film (see above)');
  console.log(`saved ${mp4} (${total.toFixed(1)} s)`);
}

// ---------------------------------------------------------------- run

try {
  if (!editOnly) await record();
  if (!existsSync(planFile)) throw new Error('no recorded clips in trailer/clips — run without --edit-only first');
  const plan = JSON.parse(readFileSync(planFile, 'utf8'));
  cut(plan, score(plan));
  process.exit(0);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
