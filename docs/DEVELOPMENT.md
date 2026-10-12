# Developing ZERO MILE

Build, publish, debug and profile. Back to the [README](../README.md).

## Publish (itch.io)

```bash
npm run package
```

This type-checks, builds and writes two archives to `release/`:

- `zero-mile-web-v<version>.zip` — the game itself: static HTML/JS/CSS/fonts with `index.html` at the zip root.
  No server and no commands are needed to play it. On itch.io: *Kind of project* → **HTML**, upload this zip and
  tick **This file will be played in the browser**; set the viewport to 1280 × 720 and enable the
  **Fullscreen button**.
- `zero-mile-source-v<version>.zip` — a clean source archive of the committed files (no `node_modules`, `dist`,
  `release` or editor tooling).

`npm` is only needed to develop and build the game, never to play it. Developer tools (F1 overlay, cheat keys,
visual lab, the `zm` console API) are off in published builds unless the page is opened with `?debug`.

## Project layout

| Part of the game (source) | Development only — not shipped, not archived |
| --- | --- |
| `src/`, `index.html`, `package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts`, `scripts/`, `README.md`, `ASSETS.md`, `DEVLOG.md` | `node_modules/` (installed by `npm install`), `dist/` and `release/` (generated) |

## Development

- Seeded runs: every run shows `RUN #seed`. Enter a seed on the garage PLAY tab to replay a run; *Restart Run*
  in the pause menu restarts with the same seed.
- Debug overlay (F1): live stats (encounter state, boss state/stability, archetype resources), selectors to
  **play any encounter**, **fight any boss** and **add a themed build**, plus keys `1` credits · `2` heal ·
  `3` fuel · `4` random part · `5` spawn enemy · `6` teleport forward · `7` break the boss · `8` complete road ·
  `9` god mode · `0` collision log. CHAOS fires a debris drop, a wrong-way truck or a pile-up ahead.
  VISUAL → LAB builds an emissive test row; VIEW switches Normal / Emissive /
  Lighting / Bloom / Wireframe / Fog off; clicking a surface shows the material inspector.
- Console QA helpers: `zm.bot(true)` enables an autopilot that drives the current road; `zm.state()` returns the
  current game state; `zm.lineup({ view, clay, cars, props })` renders the model lineup in a neutral studio (no HUD,
  no post) and returns the frame as an image.
- Performance tools — details and measurements in [docs/PERFORMANCE.md](PERFORMANCE.md):
  - **Frame profiler** in every build: press **F9** or open the page with `?perf`. It shows:
    - FPS, frame time, p95/p99/worst, CPU and GPU time;
    - per-phase times: physics, AI, world generation, VFX, render;
    - draw calls, triangles, geometries, textures, shader programs;
    - vehicles, enemies, lights and particles;
    - render size, DPR and render scale;
    - the last frame spikes over 30 ms with what caused them.
  - **Benchmarks** (debug builds): `zm.bench('A')` … `'E'` (driving, combat, heavy combat, boss, maximum chaos),
    `zm.bench('G')` (restarts / leak check), or `?debug&bench=F` for a first load.
- Quality: the preset (LOW / MEDIUM / HIGH / VERY HIGH) sets the render-resolution ceiling. **AUTO QUALITY** only
  moves the resolution under that ceiling to hold the frame rate. It never touches traffic, enemies, effects, lights or
  post-processing, and never changes the saved preset.
- See [DEVLOG.md](../DEVLOG.md) for the design rework notes and QA results.

## Code map

```
src/
  assets/      authored models: surface atlas, modelling kit, vehicles (lofted bodies, wheels, parts, catalogue),
               kit/ (props, building relief, industry, bridges and tunnels), idle-time cache prewarm
  core/        config (all balance values), input manager, seeded RNG, math, frame profiler (perf.ts)
  data/        vehicles, parts (trigger hooks), synergies, abilities, enemies, zones, events, meta
  encounters/  encounter director (plans the road before it is built) and the 11 encounter definitions
  world/       road model & generator, streaming world builder (time-sliced), telegraph decals, environment, textures,
               scenery.ts (buildings, roadside, crossings, road wear), landmarks.ts, smoke.ts, artTextures.ts
  player/      arcade vehicle physics (grip budget, understeer, drift, soft/hard speed cap, wall severity)
  enemies/     AI vehicles: tasks, attack patterns, telegraphs, weak sides
  combat/      collisions, ram classification, explosions, chain reactions, hazards, abilities
  bosses/      boss framework (state machine, stability, break, vulnerability) and five bosses
  game/        game state machine, run state & map, driving session, chase camera, duels (chase.ts),
               chaos events (chaos.ts)
  effects/     pooled particles/debris/rings/bolts, post-processing
  render/      visual budget (emissive tiers, bloom), debug views, model lineup studio (lineup.ts), shader warm-up
               (warmup.ts), render resolution and the AUTO quality governor (quality.ts)
  audio/       procedural Web Audio: mix buses, engine/tyre/surface layers, SFX; music.ts = adaptive soundtrack
  ui/          HUD and menu screens; login.ts = signing in, the account panel, the connection screen
  idos/        iDos Games: the account and its sign-in methods (platform.ts), Solana wallets (wallets.ts), the
               progression on the server (profile.ts), the street economy, duels and the depot
  save/        the progression view the account fills (and the one-time import of a browser save)
  dev/         debug-only tools loaded on demand: the physics bench (physicsTests.ts), the frame-time benchmark
               (bench.ts)
```

Game states (`src/game/game.ts`): BOOT, SIGN_IN, MAIN_MENU, GARAGE, RUN_PREP, MAP, DRIVING, EVENT, SHOP, BOSS, PAUSE,
REWARD, GAME_OVER, VICTORY.
