# ZERO MILE — performance pass

The goal: the itch.io WebGL build is smooth and stable. The pass found the real causes of frame spikes and fixed
them; nothing was turned off and nothing was cut. Every number below was measured: nothing is estimated.

## How it was measured

**Tools (shipped with the game):**

- **Frame profiler** — every build, **F9** or `?perf`. It shows:
  - FPS, frame time (start-to-start: what the player feels, including GPU waits and GC), p95/p99/worst;
  - CPU time of the frame and GPU time (`EXT_disjoint_timer_query_webgl2`, polled without ever blocking);
  - time per phase: player physics, world generation, AI, combat, director, VFX, camera, lamps, audio, HUD, render;
  - draw calls, triangles, geometries, textures, shader programs;
  - vehicles, enemies, live lights, particles;
  - render size, DPR, render scale and quality;
  - cars and road segments built so far, and the shader warm-up;
  - the last spikes over 30 ms, with the phases of the frame that caused them and what happened in it: segment
    builds, model builds, shader compiles, texture and geometry uploads.
- **Benchmark** — debug builds, `zm.bench(profile)` or `?debug&bench=X`. It runs a real session: the QA autopilot
  drives, the profile schedules the load, and every frame interval is recorded. The seeds are fixed, so runs compare
  like with like. It also reports every shader compiled during the run, with the part of its key that differs from
  the nearest warmed one.

| Profile | Load |
| --- | --- |
| A | driving: zone 1, traffic, autopilot |
| B | combat: two enemies every 4 s |
| C | heavy combat: three enemies every 2.5 s, explosions every 1.2 s, EMP, missiles, skills |
| D | boss fight, with enemies, explosions and skills |
| E | maximum chaos: zone 4, everything in C plus traffic clusters, pile-ups, debris and oncoming trucks |
| F | first load: boot to driving from a cold page |
| G | restarts: four runs in a row, forced GC between them (leaks) |

**Harness (not shipped):** headless Edge on the GPU (ANGLE over D3D11, the same path Chrome and Edge use for every
Windows player), driven over the DevTools protocol.

- **Every run is a first visit**, the worst case for an itch player: a fresh browser profile (no saved game, no
  HTTP cache) and the GPU shader disk cache disabled. The same empty save also means both builds play the very same
  plan.
- **No vsync** in headless mode, so the frame time is the real cost of the frame.
- **Before and after alternate profile by profile**, so heat and background load hit both builds alike.
- **CPU×4 throttling is re-applied every second**: navigation can move the page to a new renderer process, which
  drops the setting.

- Machine: Intel i7-13700HX, RTX 4070 Laptop GPU. Weak hardware was modelled two ways:
  - **CPU×4**: DevTools CPU throttling ×4, a weak laptop CPU;
  - **high DPI**: 1920×1080 at DPR 2, four times the pixels of 1080p at DPR 1.
- Configurations:
  - 1280×720 page;
  - itch embed: the game in a 1280×720 iframe, as the itch.io HTML player hosts it;
  - high DPI;
  - CPU×4.
- **Before** is the commit before this pass (733baaa) with the same profiler and benchmark added and nothing else.
  **After** is this pass. Both are production builds (`vite build`).
- Tracing: CPU profiles, allocation sampling and Chrome traces were used to find causes (below).

## Root causes (before)

All measured on the build before this pass, 1280×720, first visit.

| # | Cause | Evidence | Cost |
| --- | --- | --- | --- |
| 1 | **Shader compiles mid-game.** three.js compiles a material's shader the first time it is drawn; over ANGLE/D3D11 a lit shader takes 0.1–0.7 s with a cold cache. The first enemy, explosion, debris burst, chimney plume, lane telegraph and boss each compiled theirs in the middle of the action. | "+N shader program(s)" in the spike frames; render phase = the whole frame | 280–720 ms per first sight |
| 2 | **The boss light changed the light count.** The boss's presence light was added to the scene when the boss appeared; a new light count changes every lit material's program, so **12 shaders** recompiled in one frame. | profile D: one frame, +12 programs | **4.1–5.5 s** freeze at the boss |
| 3 | **Title screen compiled synchronously.** The first frame compiled ~45 programs one after another, on the main thread. | boot 5.9 s with a cold shader cache, 1.4 s with a warm one | 4.5 s frozen page on a first visit |
| 4 | **Road segments built in one frame.** Geometry, scenery, props and the encounter's dressing of a 100–300 m segment ran in one go every couple of seconds. | `segment STRAIGHT 20–34 ms` events; CPU profile: scenery 41%, geometry build 20%, dressing 16% | 31–60 ms frames every 2–4 s; up to 200 ms at CPU×4 |
| 5 | **Driver work on first draw.** A linked program is not finished: ANGLE completes some of it on the first draw with real vertex buffers and the frame's render-target format. | Chrome trace: `CommandBuffer::Flush` 56 ms on the GPU main thread with ANGLE compile workers, no JS in the frame | 40–200 ms frames with ~3 ms of our CPU |
| 6 | **Resolution was not what the settings said.** The post chain kept the pixel ratio it was created with (1), so the scene always rendered at CSS resolution whatever the preset, and the canvas only upscaled it. Particle sizes were computed for the canvas, so on high-DPI screens sprites were 1.25–2× too big (more overdraw than designed). | `EffectComposer` created before the first `setPixelRatio` | quality presets ineffective; extra fill on high DPI |
| 7 | **AUTO QUALITY degraded the game for good.** Under 40 fps for 5 s it lowered the *saved* preset (and with it particle density) and never raised it again. | `autoQuality()` | permanent quality loss after one heavy fight |
| 8 | **Per-frame garbage and hidden costs.** Per frame: a new vehicles array (`filter`), lamp sorting with fresh objects, colour clones in particle emitters, synergy/archetype recomputation in the HUD, CSS custom properties rewritten unchanged, and a DOM query. Also `checkShaderErrors` reading compile logs back synchronously (218 ms over a boot). | allocation and CPU profiles | ~0.3 ms per frame, 218 ms at boot |
| 9 | **Draw calls on weak CPUs.** With a CPU four times slower the render phase (three.js submitting 300–600 draw calls) dominated: 28–45 ms per frame in combat. Every far car still drew its 4–6 wheels separately, and lane paint, decals and roadside props 300–700 m away, invisible under the fog, were still submitted. | CPU×4 profiles; draw-call census of a chaos frame: 18 cars ≈ 250 objects, road ≈ 380 | 22–39 fps in combat at CPU×4 |

Checked and **not** a cause:
- **GC.** Main-thread pauses were ≤ 5.2 ms (trace), and GC was 0.4% of CPU time.
- **Audio.** Buffers are created once; per-sound nodes are cheap.
- **Shadow maps.** There are none (blob shadows).
- **Leaks.** After a forced GC, heap, geometries, textures and programs return to the same level run after run.
- **Restarts.** No growth across four runs.

## Fixes

1. **Shader warm-up** (`src/render/warmup.ts`, `Game.queueWarmup`). Behind the boot screen, every kind of thing the
   game can draw is compiled with `KHR_parallel_shader_compile`, so the driver works on its own threads and the boot
   bar keeps moving:
   - every car: player, enemy (plain and elite), traffic (every variant), escort, parked, and the five bosses with
     their light rigs;
   - every road material, the gameplay props, signs, the finish gate, chimney plumes and landmarks;
   - pickups, the target tag, telegraphs, hazards, and the garage.

   Each set is compiled against the real scene's lights and fog, through the same render-target state as a frame,
   then **drawn once** into a 64×64 target of the frame's format. That draw makes the driver finish what it otherwise
   finishes on first use (cause 5). Textures are uploaded in the same pass, ≤ 4 ms per frame.

   The warm objects are kept: a program lives as long as one material uses it, so a quiet stretch never throws a
   shader away. The benchmark checks the result: **0 shaders compiled during any profile**.
2. **Fixed light count** (`src/render/visualBudget.ts`). The boss presence light is one permanent scene light, dark
   until a boss holds it; it follows the boss each frame.

   Every light in the scene is pooled and driven by intensity, so the count never changes:
   - 6 street-lamp lights;
   - 4 effect flashes;
   - key, exhaust and boss-presence lights;
   - 2 headlight spots;
   - 3 directional, hemisphere and ambient.
3. **Instance colours from the start** (`src/effects/particles.ts`). The debris meshes created their colour buffer on
   the first `setColorAt`, which switched the shader to another variant in the middle of the first crash. The buffer
   now exists from the start.
4. **Road built in slices** (`World.ensureAhead`, `buildSegmentSteps`, `scenery.ts`, `geobuilder.ts`).
   - **When it starts.** A segment exists in the scene the moment it is generated. The encounter dresses it right
     away, exactly when it always did: the encounter's random stream is shared with its live play, so the same moment
     keeps the same run.
   - **The geometry** is a generator that yields at every part:
     - every 48 m of road surface;
     - every building;
     - every roadside piece;
     - every merged mesh;
     - every attribute of the big merged meshes.

     It runs under a **2 ms per-frame budget** (`CONFIG.WORLD.GEN_BUDGET_MS`); the landmarks get a slot of their own.
   - **The dressing itself was made cheap.**
     - The fallback-font symbols on the signs (◂ ▸ ☠ · —) are drawn once at boot; the first one cost ~10 ms.
     - A parked car beyond its 300 m draw distance gets its model in a later slot. Its collision is registered at once.
     - Bounding spheres are computed in two straight passes over the typed array (same sphere, a fraction of the time).
   - **Identical output.** Each part keeps its own seeded random stream. Built sliced (one step per call) and built in
     one go, three seeds gave identical segments, props to the millimetre, and road ends. With the same save, both
     builds plan the same encounters and the same traffic wave.
   - **Distances.** Look-ahead stays 720 m, and a segment within 260 m is never left to slices. When a road starts,
     the first 450 m are built at once: beyond that the fog hides 87–99% in every zone, so nothing pops in.
5. **Render resolution and the AUTO governor** (`src/render/quality.ts`, `PostFX.setSize`).
   - The post chain now renders at the pixel ratio it is given.
   - Particle and smoke sizes follow the real render height, so effects keep their designed size at any resolution.
   - Presets set a ceiling.
   - AUTO moves only the resolution, between 0.6 and that ceiling (details below).
6. **Far cars in one draw** (`src/vehicles/carModels.ts`). Past 48 m, a car switches to its far body with its far
   wheels baked in: one draw instead of five to seven. Spin and steer don't read at that distance, and the wheel
   texels take no paint, so the body material draws them the same.

   The wheels hang off one LOD placed at the same point as the body's, so both switch in the same frame. A
   triangle-by-triangle check confirms the mirrored wheels' winding matches their normals (100%).
7. **Fogged-out detail is not submitted** (`World.cullDetail`).
   - Lane paint, road decals, painted chevrons, cables, fences, road signs and crash cushions past 220–320 m are not
     drawn; neither are roadside props past 300 m.
   - At that distance they are one or two pixels under 60–90% fog.
   - Gameplay reads are never culled: ramps, corner boards, neon, lamps, buildings.
   - Collisions never look at visibility.
8. **Garbage and hidden costs removed.**
   - Vehicles array compacted in place.
   - Lamps sorted in reused arrays.
   - Emitters write scratch colours without clones.
   - The HUD build line is recomputed only when the items change; CSS custom properties are written only when they
     change; the HUD element is cached.
   - `checkShaderErrors` is on in debug builds only.

   Measured with allocation sampling in profile C, 12 s, the allocation rate went from 43.5 to 42.1 MB/s. Most of
   it is three.js itself: ~150 MB per 12 s in uniform upload and draw submission, the same in both builds. GC was
   never a cause of spikes: main-thread pauses stay ≤ 5 ms.

## Quality settings

| Preset | Render scale ceiling (scene pixels per CSS pixel) | Bloom | Radial blur | Particle density |
| --- | --- | --- | --- | --- |
| LOW | 0.75 | off | off | 0.45 |
| MEDIUM | 1.0 | low strength | off | 0.7 |
| HIGH (default) | min(DPR, 1.25) | full | on | 1 |
| VERY HIGH | min(DPR, 2) | full | on | 1 |

**AUTO QUALITY** (on by default) is a resolution governor. It works inside the ceiling and touches nothing else.
- **Each second**, it looks at:
  - the average and 90th-percentile frame interval against the display's interval (never chasing more than 60 fps);
  - the GPU timer, when the browser exposes it. Otherwise it uses the share of the frame spent outside our code.
- **Down.** After a slow second it steps down by 0.1, but only if the GPU is the bottleneck.
  - A CPU-bound frame does not get faster with fewer pixels, so then the resolution is left alone.
  - It waits 2 s between steps; the floor is 0.6.
- **Up.** After five calm seconds it steps back up, but only if the GPU time scaled to the bigger frame still fits in
  65% of the budget. It then waits 4 s.
- **Swings.** Three steps down within a minute lock climbing for 30 s.
- **Never touched:** the saved preset, traffic, enemies, VFX, lights, post-processing and the simulation.

Measured:
- **Software GPU (SwiftShader, 640×360).** It stepped 1.0 → 0.9 → 0.8 → 0.7 → 0.6 two seconds apart (GPU 176 → 78
  ms) and held at the floor without oscillating.
- **Up from 0.6 (RTX).** It climbed back to 1.0 in four steps 5 s apart, then stopped at the ceiling.
- **RTX at 5120×2880** (VERY HIGH, DPR 3). GPU stayed at 8–10 ms, so the governor left it alone.

## Budgets

| Budget | Value | Why |
| --- | --- | --- |
| Frame | 16.7 ms at 60 Hz. Measured at 1280×720 on the test machine, the CPU frame is 2–8 ms (A–E) and the GPU frame 1.6–4 ms | headroom for weak CPUs (×4: 20–38 ms) |
| Road generation | 2 ms per frame; a segment is 40–75 steps of ≤ 1–5 ms | throughput 8× what 300 km/h consumes |
| Shaders | ~50 programs, all compiled at boot; 0 compiled in play | first-sight compiles cost 0.1–0.7 s each |
| Lights | 13 point + 2 spot + 3 directional + hemi + ambient, fixed for the life of the page | a count change recompiles every lit shader |
| Shadows | blob shadows only, no shadow maps | — |
| Render scale | ceiling by preset; AUTO floor 0.6 | resolution is the only automatic lever |
| Draw distance | road paint and decals 220–260 m, cables / fences / signs / cushions 300–320 m, props 300 m, far car LOD 48 m | fog hides 60–90% there |
| Particles | pooled: 4200 additive, 2800 smoke, 400 glare, 2400 streaks, 3×120 debris, 18 decals, 4 lights | nothing is allocated per effect |

## Before / after

Production builds, first visit (fresh profile, cold shader cache), 25 s per profile, before and after alternating.
"Frames >30 / >50 / >100" count the frames over those times in the run. Boot is page load to the title; launch is the
benchmark's start of a drive.

**1280×720 page**

| Profile | FPS | avg ms | p99 ms | worst ms | frames >30 / >50 / >100 ms | draw calls (peak) |
| --- | --- | --- | --- | --- | --- | --- |
| F | 229.8 → **236.3** | 4.35 → **4.23** | 6.5 → **6** | 315.2 → **20.9** | 2 / 1 / 1 → **0 / 0 / 0** | 260 → **219** |
| A | 232.1 → **233.6** | 4.31 → **4.28** | 6.2 → **6.4** | 281.9 → **124.3** | 2 / 1 / 1 → **1 / 1 / 1** | 252 → **209** |
| B | 195.5 → **227.9** | 5.12 → **4.39** | 10.5 → **7.3** | 727.4 → **154.4** | 8 / 5 / 3 → **1 / 1 / 1** | 341 → **261** |
| C | 189.4 → **192.7** | 5.28 → **5.19** | 12 → **10.6** | 363.6 → **107.2** | 10 / 4 / 2 → **4 / 1 / 1** | 357 → **287** |
| D | 167.4 → **208.3** | 5.97 → **4.8** | 11 → **9.8** | 4076.7 → **38.8** | 8 / 6 / 5 → **5 / 0 / 0** | 318 → **258** |
| E | 136.7 → **171.6** | 7.31 → **5.83** | 18.9 → **13.1** | 267 → **133.8** | 13 / 5 / 4 → **6 / 3 / 1** | 619 → **399** |

Boot to the title went from 5.4–7.6 s to 3.5–5.1 s. That includes compiling every shader the game will ever need,
not just the title's. The longest frame while a drive starts went from 284–1066 ms to 120–306 ms.

**itch.io embed** (the game in a 1280×720 iframe)

| Profile | FPS | avg ms | p99 ms | worst ms | frames >30 / >50 / >100 ms | draw calls (peak) |
| --- | --- | --- | --- | --- | --- | --- |
| A | 235.8 → **236.4** | 4.24 → **4.23** | 5.8 → **6.3** | 39.7 → **13.8** | 3 / 0 / 0 → **0 / 0 / 0** | 290 → **236** |
| C | 184.5 → **196.2** | 5.42 → **5.1** | 11.9 → **11** | 327.6 → **87.3** | 9 / 6 / 4 → **3 / 1 / 0** | 334 → **277** |
| E | 164.5 → **165.7** | 6.08 → **6.04** | 13.8 → **13.1** | 249.4 → **113.1** | 9 / 5 / 2 → **8 / 3 / 2** | 591 → **455** |

Boot 5.3–6.2 s → 3.5–3.7 s. Longest launch frame 520–974 ms → 97–132 ms.

**High DPI** (1920×1080 at DPR 2). After the fix the scene really renders at the HIGH ceiling, 2400×1350. Before,
it rendered at 1920×1080 and was stretched to 2880×1620.

| Profile | FPS | avg ms | p99 ms | worst ms | frames >30 / >50 / >100 ms | draw calls (peak) |
| --- | --- | --- | --- | --- | --- | --- |
| A | 229.5 → **227.4** | 4.36 → **4.4** | 7.2 → **7.6** | 46 → **33.9** | 3 / 0 / 0 → **1 / 0 / 0** | 283 → **236** |
| E | 149 → **159.1** | 6.71 → **6.28** | 15.4 → **14.7** | 599.8 → **110.1** | 5 / 1 / 1 → **2 / 1 / 1** | 655 → **416** |

**Weak CPU** (CPU×4)

| Profile | FPS | avg ms | p99 ms | worst ms | frames >30 / >50 / >100 ms | draw calls (peak) |
| --- | --- | --- | --- | --- | --- | --- |
| A | 54 → **56.9** | 18.51 → **17.57** | 50.2 → **44.4** | 212.7 → **62.9** | 112 / 14 / 3 → **116 / 3 / 0** | 281 → **216** |
| C | 39.3 → **35.9** | 25.48 → **27.83** | 74 → **69.1** | 107.8 → **112.4** | 204 / 34 / 1 → **287 / 53 / 2** | 357 → **276** |
| C (repeat) | 33.4 → **38.1** | 29.96 → **26.27** | 87.1 → **68.7** | 451.8 → **100.8** | 271 / 75 / 6 → **250 / 55 / 1** | 328 → **266** |
| C (repeat) | 41.1 → **40.7** | 24.34 → **24.54** | 85.6 → **59** | 338.5 → **96.7** | 206 / 48 / 5 → **232 / 36 / 0** | 341 → **285** |
| D | 28.6 → **38.2** | 34.97 → **26.19** | 92.2 → **67.1** | 4156.5 → **271.3** | 234 / 69 / 7 → **268 / 34 / 3** | 311 → **274** |
| E | 22.5 → **29.3** | 44.54 → **34.16** | 101.2 → **89.4** | 198.8 → **121.5** | 442 / 167 / 7 → **364 / 93 / 4** | 641 → **411** |

At CPU×4, single runs vary by about ±15% with the machine's state, so C was run three times. The average is the same
(37.9 → 38.2 fps); the tail is not (worst 108–452 → 97–112 ms).

## Validation

- **Shaders.** Every benchmark run lists the shaders compiled during play: **none**, in every profile and
  configuration. The warm-up compiles 50 programs and the rest of the boot (post chain, reflection maps) brings the total to 64; it
  stays 64 for the life of the page.
- **Restarts** (G, four runs, forced GC between them):
  - heap 111 / 114 / 111 / 106 MB, geometries 322–335, textures 69, programs 64 — no growth;
  - worst frame 41 / 24 / 13 / 14 ms (before: 381 / 35 / 38 / 35).
- **Long session.** Three minutes, three nodes in a row, autopilot:
  - FPS 210–232 and p99 7–9 ms in every 30 s window;
  - programs 64 throughout; heap back to 82 MB on every reward screen;
  - no trend over time.
- **Resize / fullscreen in the iframe.** Eight resizes from 800×450 to 1920×1080. The render target follows every
  size, the worst frame after a resize is 12–38 ms, and textures rose by 2 (road signs), not by the render targets.
- **Physics.** `zm.physics('all')`: 24/24 invariants for every car, with the same values as before the pass:
  - 0–100 km/h in 1.57 s;
  - 100–0 km/h in 19.4 m;
  - 17 ms to yaw.
- **Road and gameplay.**
  - Sliced and one-go generation give identical segments, props and road ends (three seeds).
  - With the same save, both builds plan the same encounters and spawn the same traffic wave (traced second by second).
  - The QA autopilot drives the same profiles in both.

## Remaining bottlenecks

- **Draw-call submission on weak CPUs.** At CPU×4 a chaos frame still costs ~34 ms, mostly three.js submitting 400
  draw calls. Near cars draw body, 4–6 wheels, two blob shadows and lamp decals separately. Batching the near wheels
  of all cars into instanced meshes would cut ~100 calls; it was left out because it touches every car's per-frame
  update.
- **Rare GPU-process stalls.** In some 25 s runs, one or two frames take 90–155 ms while our CPU work in them is
  2–6 ms:
  - no shader was compiled in them;
  - the GPU timer reports those frames as disjoint (a GPU power-state change or preemption);
  - a trivial WebGL page in the same harness never shows them;
  - in other runs of the same profile they do not occur at all (B, C and E with a worst of 30–45 ms).

  Some driver-side work under load remains here; it is not tied to an event in the game.
- **Starting a drive** builds the first 450 m of road at once (~50 ms on the test machine, so nothing pops in through
  the fog). The first frames upload that geometry to the GPU. The longest frame of a launch is 100–300 ms, at the
  moment the screen switches from the menu.
- **three.js allocation churn.** The renderer allocates about 110 bytes per draw call in uniform upload, ~12 MB/s in
  a heavy fight. Young-generation GC absorbs it in sub-millisecond scavenges. Removing it would mean patching
  three.js, and it never showed up as a spike.
