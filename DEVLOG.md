# ZERO MILE — Devlog

## v2 — Core rework + visual overhaul

The v1 audit found a game that looked like a car-combat roguelite but played like a passive one:
auto-weapons did most of the killing, enemies rarely came near the player (≈5% of the time within ramming range),
bosses trailed behind and died to passive DPS, corners never asked for the brake, and the screen was too dark
to read. v2 rebuilds the gameplay around one rule: **driving is the combat system.**

### What changed

**Driving** (`src/player/player.ts`, `src/core/config.ts` → `DRIVE`)
- Lateral grip budget: entering a corner too fast now understeers wide instead of turning on rails.
- Trail braking adds front grip; drifting has its own, higher grip cap, so a good drift is the fastest way through
  a hairpin and fills CHARGE.
- Speed soft cap (≈205 km/h) with diminishing returns up to a hard cap (≈238 km/h).
- Wall hits are classified light / medium / heavy: light keeps most of the combo, heavy wipes it and the combo bank.
  Hull damage from walls is capped per hit — walls cost speed and combo, not runs.
- Short recovery after hits, limited air control, camera with look-ahead into the corner.
- Bot validation on a 900 m test track: flat-out 26.9 s with 5 heavy crashes; braking 27.0 s with 0 crashes;
  brake + drift 23.7 s. Skill beats both holding W and over-caution.

**Encounter-first roads** (`src/encounters/`)
- The director plans each node (intro → [rest, signed approach, stage pieces] × N → finish) *before* the road is
  generated, and the generator builds exactly the geometry each encounter needs (splits with medians, wide arenas,
  sharp turns, chicanes, shortcut lanes).
- 11 encounters: Roadblock, Convoy, Ambush, Pursuit, Hazard Run, Traffic Wave, Escape, Race, Escort, Bounty,
  Gauntlet — each with a primary objective, an optional bonus, rewards and a clean resolve.
- Road language: gold = reward line, cyan = shortcut, yellow = hazard, red = danger; 3D gantry signs announce
  encounters; corner chevron boards on sharp turns.

**Combat without auto-fire** (`src/combat/combat.ts`, `src/enemies/ai.ts`)
- Ram classification (side / rear / front / glancing), perfect rams, weak sides, EXPOSED states, armour.
- Enemies have tasks (slot, block, flee, pursue, attack target, cross) and telegraphed attacks: interceptor
  cut-offs, rammer lane charges, gunner lane barrages, bomber fuses, EMP domes, drone strikes, hunter slams.
- Lured crashes (into walls, barrels, other cars) are credited to the player; chain reactions remain.
- Tiered near misses; a combo **bank** that pays out only if the chain ends without a crash.

**Buildcraft** (`src/data/items.ts`, `src/data/synergies.ts`)
- Six archetypes with a verb and a resource: RAM/MASS, DRIFT/CHARGE, SPEED/VELOCITY, FIRE/traps,
  ELECTRIC/STATIC, GHOST/PHASE. 35 parts, every one written as *WHEN YOU DO X → Y*.
- 12 synergies at 3 / 5 parts change rules (e.g. Perfect Exit shockwaves, Slide Chain carry-over charge,
  Time Pressure slowing hostiles at high speed, Burning Road, Chain Shock, Phantom).

**Bosses as driving problems** (`src/bosses/bosses.ts`)
- Shared framework with an explicit state machine:
  INTRO → PHASE_START → ACTIVE ⇄ TELEGRAPH → ATTACK → BREAK → VULNERABLE → RECOVER / PHASE_COMPLETE → DEFEATED.
- Stability only drops when the mechanic is solved; a break removes 30% of the phase and opens a 3–5 s
  vulnerability window (the timer slows while the boss limps back into reach). Outside the window damage is ~0;
  HP is gated per phase so passive builds can't skip mechanics.
- Iron Mule: lure its lane charge into anvils. Drowned Line: herd the bus into electrified water.
  Taxon: feint its lane prediction (later phases learn your dodge side). Apex: a sector race; it crashes when it
  chases you through corners. The Driver: call-and-answer duel shaped by your strongest archetype.

**Lighting & visuals** (`src/world/environment.ts`, `src/world/world.ts`, `src/effects/postfx.ts`)
- Night ≠ black: brighter, saturated fog per zone (sodium amber, flood teal, Old City magenta, Skyway blue,
  Zero Mile crimson) so buildings read as silhouettes; zone-tinted hemisphere fill; shadow lift in the grade;
  exposure 1.22.
- A pool of six real point lights follows the nearest street lamps, so lamps light cars and props as they pass;
  a soft fill light from the camera side keeps the backs of cars readable.
- Zone landmarks: gantry cranes, transmission pylons, holo-billboard towers, suspension towers, the Zero ring.

**HUD, audio, debug, save**
- Contextual objective panel, boss panel with phase pips, segmented HP, stability / vulnerability bar,
  combo bank, off-screen threat arrows, damage-direction arcs, archetype resource meters.
- Stereo-panned impacts, explosions and threat beeps; music ducks on heavy hits, boss alerts, victory and defeat.
- Debug overlay selectors: play any encounter, fight any boss, add a themed build.
- Save format v4 with migration (old saves keep progress; removed modules fall back to EMP).

### QA (automated bot, production build)

The QA bot drives with a corner-aware autopilot, no drifting, scripted boss behaviour, and uses shops/repairs
when low. It is weaker than a human player, so its results are a floor, not a target.

- 20 normal runs across 12 seeds: no runtime errors. After balancing, 3 of 5 runs in the final batch beat Iron Mule,
  one beat Drowned Line and reached Old City.
- 6 archetype runs (RAM, DRIFT, SPEED, FIRE, ELECTRIC, GHOST starting builds): no errors; every archetype's
  synergies activated (e.g. FIRE → Burning Road + Inferno, ELECTRIC → Chain Shock + Storm).
- Every boss tested in isolation with a mechanic bot: each one breaks through its mechanic, cycles through all
  three phases, and Iron Mule was defeated end to end (~70 s). The Driver's defeat leads to the VICTORY screen.
- Balancing from QA: wall/anvil crash damage capped per hit, boss contact damage capped at 12, boss arena
  obstacles act as crash cushions, phase clears heal 15%, zone-1 damage scaling lowered, combo bank and shop
  prices tightened (credits were piling up unspent).

### Known limits

- The bot cannot drift, so it loses most Apex races and Race encounters; a human using drifts is ~15–20% faster
  through corners.
- Visual assets are procedural and low-poly by design; there are no textures or models from outside sources.

## v2.1 — Curb and wall collisions: punish mistakes, don't erase momentum

**Problem.** Touching a curb at speed stopped the car. Measured with throttle held at 180 km/h:
a 10° touch ended at 46 km/h, 30° at 52, 85° at 10 — all within 1.5 s.

**Cause** (`PlayerCar.wallContact`, before):
1. A multiplicative "scrub" was applied to the *whole* velocity on *every frame* of contact (×0.97 for a
   "light" touch, ×0.85 "medium") — 60 times a second, so a short scrape compounded into a near stop.
2. The nose stayed pointed into the barrier (it was only nudged by `vOut × 0.05`), so throttle and tyre grip kept
   rebuilding velocity into the wall, re-triggering the scrub: the car stuck.
3. Severity looked only at the speed into the wall, never the angle, and every surface used the same response.

**Fix** (`src/core/collision.ts`, `PlayerCar.surfaceContact`):
- A contact is an **impact** (first frame, or a clearly harder hit while touching) followed by **sliding**.
  An impact splits velocity into normal and tangential parts, keeps a severity-dependent share of the tangential
  speed, bounces a little, and turns the nose along the surface. Sliding only cancels the into-surface velocity and
  applies friction **proportional to how hard the car presses in** (μ × load), plus a tiny base friction.
- Severity from impact angle (scrape < 7°, light < 18°, medium < 40°, heavy above), capped by normal speed both
  ways (a slow bump is never a crash; ≥ 26 m/s straight into a wall always is).
- Collision materials with their own retention, friction, bounce, deflection, damage and combo weight:
  **curb** (open-road barrier: soft, rideable by 0.3 m), **wall** (tunnels: firmer), **divider** (split roads),
  **heavyProp** (blocks, pillars), **cushion** (boss-arena anvils: stop you, barely scratch the hull).
- Deflection depends on severity: scrapes and light touches skim (nose turned 85% along the curb), solid hits
  don't steer you round a corner for free (20%). While sliding, the nose is turned off the surface quickly at
  shallow angles (never stick), slowly at solid angles, and pivots off head-on hits (never pinned).
- Penalties by severity: scrape — sparks, rasp, a slow combo bleed, 0 HP; light — −15% combo (×material), small
  camera nudge, 0 HP on curbs; medium — −40% combo, −30% bank, ≤ 4 HP, brief loss of grip; heavy — crash: combo
  and bank lost, ≤ 11 HP, screen shake, heavy-impact sound. New curb-scrape sound distinct from the crash.
- Telemetry: last contacts in the F1 overlay; `0` in debug mode (or `zm.collisions(true)`) prints every contact:
  `CURB LIGHT 182 → 174 km/h (-8) · 10° · vN 8.7 vT 49.2 · bounce 1.0 · combo -0.9`.

**Results** (180 km/h, throttle held, no steering correction):

| contact | before | after |
| --- | --- | --- |
| 3° curb | drained to ~150 | 183 → 181, holds speed with a tiny correction |
| 10° curb | 46 | 182 → 174, combo −13%, 0 HP |
| 30° curb | 52 | 180 → 147, combo −26%, ~2 HP |
| 60° curb | 38 | 180 → 91 (crash), combo lost |
| 85° curb | 10 | 180 → 40 (crash) |
| drift into curb, 12° | drift lost, 52 | drift continues, 161 → 154 → 180 |
| 10° at 205 km/h | — | 197 → 191 |
| tunnel wall 10° / 30° | — | 170 / 145 (firmer than a curb) |
| divider 8° / 25° | — | 164 / 148 |

**Skill hierarchy** (900 m of sharp turns and chicanes, average of 8 seeds):
skilled drift line 22.3 s · reckless flat-out 22.0 s · centre-line drift 23.4 s · braking 24.8 s ·
deliberate curb-riding 24.1 s. With the old code flat-out was 26.7 s — but only because every curb touch stalled it.
These generated "sharp" turns are 58–74° at R 35–46 m on a 12 m road; with the full road width they are nearly
flat-out-able, so on raw time flat-out and a good drift line are now level. Flat-out pays with 5–6 hard hits per
900 m (combo and bank lost on each crash, hull damage); braking and drifting finish clean. Making flat-out
clearly slower on time would need tighter corners (hairpins) from the road generator, not harsher curbs.

## v2.2 — Visual energy budget: glow, don't explode

**Problem.** After the lighting overhaul, approaching emissive surfaces (lane paint, neon, pickups, signs) blew the
frame out into white smears. Measured in a debug test row ("visual lab", F1 → LAB) with frame read-back:
approaching the painted lane marks from 40 m to 2.5 m, mean frame brightness went 0.25 → 0.64 and 9% of the frame
clipped to white; the dense neon street reached 5.9% white.

**Causes** (all multiplying each other):
1. *Material intensity* — persistent surfaces used HDR colours up to ×3.0, including large-area ones: lane paint
   ×2.2, barrier strips ×1.6, lamp heads ×2.2, pickups ×3, markers ×2.8, landmarks ×2.4–3; additive signs ×1.7.
2. *Bloom* — the high-pass sent the **whole** pixel (not the excess) into bloom, with a hard cut at a low 0.86
   threshold and no cap. Bloom energy therefore grew with on-screen area: the closer you got, the more it exploded.
3. *Tone mapping* — ACES desaturates hot colours toward white, so ×2 cyan read as white.
4. *Near-camera additive volumes* — pickup light-beam cylinders filled a third of the screen when the camera
   passed next to one.
5. *Lights and reflections* — inverse-square close to a 220-intensity headlight spot and a 16-intensity key
   light on the player car; lamp lights at 140 on top of an additive light-pool decal; env-map neon at ×2.5,
   flood water reflecting at ×2.2.

**Fix — one budget, `src/render/visualBudget.ts`:**
- Emissive tiers, expressed as the *peak channel* of a saturated colour (`glow(color, tier)`), so bright stays
  coloured: **SUBTLE 0.8** (windows, paint, strips — never blooms), **MEDIUM 1.3** (neon, signs, lamp heads, car
  lights), **STRONG 1.9** (pickups, boss accents, landmarks, hazards), **EXTREME 4** (short-lived VFX only).
  Every persistent glow in the world, cars, pickups, markers, telegraphs and landmarks now goes through it.
- Bloom: threshold 1.0, soft knee 0.35, **only energy above the threshold**, **capped per pixel at 1.4**,
  strength 0.6, radius 0.4 — a small neon gets a halo; a screen-filling one can't white out the frame.
- Tone mapping: Khronos **PBR Neutral** (hue-preserving), exposure 1.75 — the same mid-tone brightness the night
  pass had at 1.22 under three's ACES (which scales by 1/0.6 internally). The night is not darker.
- Light profiles: street lamp 70 / 22 m / decay 2, headlight 90 / 55 m, player key light 7 / 12 m;
  light pools 0.32, headlight cones 0.2. Bulbs *look* bright; the pooled lights do the lighting.
- Reflections: env neon ×1.4, water 1.3.
- Particle budget (`VFX`): sparks 1.8, electric 2, nitro 1.2 and trails 1.25 (these stream behind the camera).
- Near-camera fade (`nearFade`) for additive volumes (pickup beams, headlight cones), smooth in view depth.
- Boss presence: STRONG accent strips plus one accent-coloured light behind the boss — readable by silhouette
  against a lit patch of road, not by raw glow.
- Material classes (`MAT_DEFAULT … MAT_VFX`) with roughness, metalness, allowed emissive range and bloom priority.

**Debug tools (F1):** VISUAL → *LAB AHEAD* builds a row of test stations (wall, neon sign, windows, road marks,
street lamp, pickups, boss, headlights, hazards, billboard, wet road, dense neon street) from the game's own
materials; VIEW → Normal / Emissive / Lighting / Bloom / Wireframe / Fog off; click any surface for the material
inspector (type, base colour, emissive × intensity, tier, metalness/roughness, class, whether it blooms, which
lights reach it).

**Results** (lab, % of frame clipped to white at 2.5 m · mean brightness 40 m → 2.5 m):

| station | before | after |
| --- | --- | --- |
| road marks | 9.1% · 0.25 → 0.64 | 2.8%* · 0.15 → 0.23 |
| dense neon street | 5.9% · 0.24 → 0.44 | 2.1%* · 0.19 → 0.20 |
| pickups | 4.1% | 1.4% |
| neon sign | 3.7% | 0.7% |
| headlights | 3.3% | 1.7% |
| wet road | 3.0% | 1.6% |
| boss | 2.4% | 1.1% |

\* includes the lab's own white caption sprite in view. Remaining saturated pixels are coloured (hot cyan, red,
magenta), not white. All five zones checked at a landmark: Industrial amber, Flood teal with wet reflections,
Old City magenta neon, Skyway blue, Zero Mile crimson — each keeps its identity; the garage keeps its look.

**Self-review — still bright on purpose:** headlight lenses and the white "EXPOSED" marker are white by meaning,
kept at MEDIUM; explosions may flash hot (EXTREME, short-lived); Zero Mile is the darkest zone overall (by design —
it relies on selective glow).

## v3 — Spectacle, clarity and flow

Driven by real player feedback: the controls felt twitchy, the point wasn't clear ("coins and arrows like in
Cyberpunk", "Subway Surfers with cars"), nobody found the skills, and levels ended by freezing. Audit and plan:
[docs/REWORK_V3_PLAN.md](docs/REWORK_V3_PLAN.md).

**P0 — control and clarity.** A heading assist brings the car back parallel to the road when you let go, and
keyboard steering ramps in (a 0.2 s tap at 180 km/h is now one lane, not two lanes into the wall). Cars carry
worded tags (DESTROY / ENEMY / ELITE / PROTECT / RIVAL / HIT IT!) with health. The first road teaches by play:
destroy one slow target, smash a blockade with the pre-charged skills, survive a pursuit. Skill docks show a
charge ring, READY and PRESS Q when the skill would help. Roads end in a final stretch, an arrival gate (lift it
or smash it), a result card and only then the reward screen.

**P1 — chases, chaos, verticality.** Enemies chase on their own speed plus a boost tank with visible flames; out-run
them and they take a side street and may cut in ahead. One that holds on becomes a timed **DUEL**. Chaos events
(falling debris, a wrong-way truck, pile-ups) run on a calm → event → recovery cadence, ride along chase
encounters and always hit once more before the gate. Broken bridges are real holes: jump them at speed, or drop
into the canal and recover on the far side; enemies that fall in are yours.

**P2 — game feel.** The car pitches with its arc in the air, PERFECT landings boost you, and big crashes roll the
car once in slow motion before it lands on its wheels.

**P3 — audio.** Buses with a fixed priority (music > cues > crashes > tyres > enemies > environment > engine) and
ducking under cues and crashes. The engine is a quiet layered bed (triangle body, sub, a growl band that opens
with throttle, intake noise, exhaust pops on lift-off). Tyres rumble, wet roads hiss, tunnels echo, bridge joints
thump, and you hear the nearest enemy's engine from where it is — louder when it boosts. The score is an original
adaptive rock/electronic piece: sections for menu, cruise, drive, chase, boss, final stretch and result; phrase-level
progression and riff variation, drum fills, bar-line transitions with a crash.

**QA**

- Seeded roads with the autopilot: 3–4 chaos events, 1 broken bridge, 2–5 duels per road (before tuning duels
  fired every ~10 s and ended in 1–2 s; now they need 2 s of contact, skip interceptors and have a 14 s cooldown).
- Broken bridge: cleared at 229 km/h (76 m flight, 8 m peak); at 61 km/h the car falls in and recovers 14 m past
  the hole with ~10 % hull lost.
- Music rendered offline per section (RMS): cruise 0.012 < drive 0.019 < chase 0.022 < boss 0.024; live mix
  after 30 s of play: music 0.046 RMS on top, engine below tyres and cues.
- Full runs: courier beat Iron Mule and the Drowned Line and fell in Old City; ghost (70 HP) fell in zone 1;
  flat-out run finished a road in 52 s with 38 damage — recklessness still costs more than braking and drifting.
  No console errors in any run.

### v3.1 — Anvils and debris: never a dead stop, never out of nowhere

Player feedback: anvils (Iron Mule) and falling debris stopped the car completely, seemed to appear from nowhere
and hit hard. Cause: heavy props used a static collision that reflected 130% of the speed going into them — a
square hit left you at ~0 km/h — and they were grey 1 m blocks marked only by a faint circle on the road.

- At speed a block, anvil or debris slab now **gives way**: it is knocked tumbling off the road and the car keeps
  going. Square hit at 187 km/h → 117 km/h (anvil → 128), a clip slides past at full speed; combo cut by up to a
  third, ~4 HP (anvil ~1.4) instead of a crash. A slow push is still solid; pillars are structure.
- Worded **hazard markers** ("ANVIL", "DEBRIS x2 140 m") drawn over everything, readable from ~200 m; side-by-side
  hazards share one label. Anvils are hazard-striped and chest-high.
- Debris falls further ahead (≥ 3.2 s at your speed) and lands about a second before you arrive; the whole lane
  lights up from just ahead of you to the drop. Being crushed costs 9 HP and half the combo (was 16 and all of it).

## v4 — Visual content pass

The game played like an arcade combat racer but looked like a prototype: two walls of identical boxes with
random coloured windows, an empty roadside, a flat road, an empty sky. Audit, gap report and results:
[docs/VISUAL_PASS.md](docs/VISUAL_PASS.md).

- **World:** real facades (floors, mullions, warm lights by floor or window), setbacks and rooftop clutter, shop
  fronts, warehouses, a taller back row, factory stacks with smoke; a roadside layer with a callback every 20–45 m
  (poles and wires, fences, billboards, stops, parked and burnt cars, roadworks, checkpoints, trees); crossings over
  the road; road wear (tyre tracks, patches, oil, cracks, manholes, joints); three giant landmarks per zone; a lit
  cloud deck, aircraft and searchlights.
- **Cars:** detailed and cheaper (merged per material), hostile red eyes, clear-coat paint, contact shadows, traffic
  variants, visible damage on your car.
- **Spectacle:** boss light rigs and death sequences, chaos events with real impact effects, a broken bridge that looks
  closed off, a stadium-lit arrival gate with runway lights.
- **Image:** rim light, airborne camera, per-zone grade.

## v5 — Authored models

Everything that was a box, a cylinder or an extruded side profile is now a modelled asset, authored in code
(`src/assets/`): see [docs/VISUAL_PASS.md](docs/VISUAL_PASS.md) for the audit and numbers and
[docs/ASSETS.md](docs/ASSETS.md) for the register.

- **Pipeline:** one 8×4 surface atlas (32 surfaces with colour, clear coat, roughness, metalness, emission) so a car
  is one body draw call with paint, glass, rubber, chrome and live lights; damage (dust, crumpled ends, soot) is a
  shader state; three detail levels with `THREE.LOD` past 48 m; the world kit merges into one mesh per segment
  through a typed-array builder; caches build in idle slices while the menu is open.
- **Vehicles:** lofted bodies (arches, flares, fender crests, raked glass, pillars, panel gaps, fascias, mirrors),
  real wheels, parts (wings, ram blades, cages, turret, EMP rig, armour, light bars, truck chassis, tank). 4 player
  cars — the Courier is now a hot hatch, matching its garage description — 13 traffic vehicles, 7 enemy classes and
  elites, 5 bosses; wheels droop in the air. Boss light rigs refitted (the bus is lit through its windows).
- **World:** 48 props; facade relief on the texture's window grid (balconies, AC units, pipes, cornices, fins,
  pilasters, roller doors, fire escapes, entrances, roof plant); industrial plant and pipe racks along the road; piers,
  girders and cable-stayed pylons; tunnel portals, ribs with jet fans and wall furniture; landmarks rebuilt with the
  kit; a second skyline band. Fixed the block footprint (width and depth were swapped, so shop fronts and signs
  could float off the facade).
- **Unchanged:** handling, collision (every model matches its gameplay footprint; prop radii kept; scenery never
  consumes the segment random stream), damage, AI, encounters, pacing, rewards.
- **Cost:** 115–280k triangles in view (was 45–51k), draw calls 118–296 (was 182–267), GPU 0.43–0.73 ms per frame
  (was 0.41–0.65), segment build 6–11 ms median.
- **Tools:** `zm.lineup()` renders a neutral-studio lineup (any view, clay, damage states) without HUD or post.

## v6 — VFX pass: light, fire, smoke and impacts that read as real

No new effects; the existing ones rebuilt so each says what happened, where, which way and how hard. Audit, fixes
and numbers: [docs/VFX_PASS.md](docs/VFX_PASS.md).

- **Light:**
  - Headlamps, tail lamps, reverse lamps and indicators sit on each model's real lamps.
  - Headlights: glare on the lamp, a soft fan on the road, fake-volumetric beams in the air (thicker in tunnels).
  - Brake lights put a red sheen on the asphalt; traffic brakes and signals lane changes.
  - Street and tunnel lamps have glare, irregular pools and faint cones, and they stutter when an EMP goes off.
  - Searchlights and the lighthouse are volumetric beams.
- **Fire and smoke:**
  - Ten smoke profiles.
  - Staged explosions: flash, fireball, smoke that swallows it, debris, shock wave, a burning column, a scorch mark.
  - Boss deaths escalate, blow, burn — and the boss's lights go out.
  - Missiles have a motor, a smoke trail and a backblast.
  - Boost jets come from the real tailpipes; exhaust pops flash on the beat of the audio.
- **Impacts:** light, medium and heavy are one staged effect — contact flash, a directional spark fan, debris by
  surface (shards, rock chunks, torn panels, glass), dust, then smoke.
- **Tyres:** skid marks only while a wheel slides; rear-tyre smoke on drifts and hard braking; spray and mist on
  wet roads.
- **Pickups and hazards:**
  - Pickups: a glare, motes, a soft shaft and an irregular pool, plus a collection burst (it was never wired).
  - Hazards are stains, water, scorch and energy, not discs.
  - Telegraphs are feathered.
- **Renderer bugs that hid all of the above:**
  - swapped atlas rows;
  - back-face-culled streaks;
  - point sprites sliced by the ground;
  - sub-pixel sparks;
  - smoke with no contrast at night;
  - first-use texture hitches.
- **Post:** no chromatic aberration at rest, a softer edge-only radial blur, and an EMP tint at the edges.
- **Tools:** a VFX LAB in the debug panel (every effect on demand, the night test at 10–100 m, wet road, NO POST).
- **Unchanged:** damage, hitboxes, collisions, handling, AI, encounters, progression, rewards.

## v7 — Driving physics: fast, responsive, forgiving

Arcade-first handling. Every shared tuning value is in `src/core/handling.ts`; the audit, the changes and the numbers
are in [docs/PHYSICS_PASS.md](docs/PHYSICS_PASS.md).

- **Input and steering:**
  - A press bites on the first frame (17 ms to yaw), then builds; release fades.
  - High speed is more precise around the centre.
  - Braking keeps the steering alive.
- **Engine and brakes:**
  - The engine curve has a hard launch, a strong mid-range and an asymptote, so top speed is no longer a wall.
  - The brakes bite harder at speed and ease into the stop: 100→0 km/h in 19 m (was 11, a brick).
  - Nitro starts with a shove.
- **Drift:** a slip-angle state.
  - Steering into the turn opens the angle, countersteer closes it; it never spins on its own.
  - Entry is blended and the exit settles in 0.17 s.
  - Hold the handbrake, or tap it and steer.
  - Each car keeps its own drift grip.
- **Jumps:**
  - Fixed the dip before every ramp lip (the crooked jump).
  - The body follows the ramp, and the nose follows the arc; brake lifts it in the air, steering banks and nudges.
  - Landings are graded perfect / good / rough / bad / crash, with an assist that makes nearly-right right.
- **Contact:**
  - Rams depend on mass and direction.
    - A sedan costs 10 km/h and flies.
    - A T-bone spins and lifts the target.
    - A truck throws you back.
    - Bosses hit exactly as before.
  - Rubbing slides apart; a wreck's blast never stops you.
  - Walls bump, stumble or spin you, depending on the hit.
- **Recovery:**
  - A slide assist turns the nose into a slide after a knock; a countersteer catches it faster (SAVED IT).
  - Stuck cars pull themselves out, and are reset after 4.5 s as a last resort.
- **Feel:**
  - The body dives under braking, squats under power and rolls through corners.
  - Wheels counter-lock in drifts, droop in the air and climb curbs.
  - The camera pulls back under power, dips on landing, rides the arc in the air and widens on boosts and crashes.
  - Landing, braking and roof-scrape sounds are synced to the event.
  - AI cars roll, pitch, fly, land imperfectly and slide when hit.
- **Tools** (debug panel → PHYSICS):
  - lab track;
  - wet, truck, cars and enemy;
  - live readout;
  - a 24-invariant bench per car (`zm.physics('all')`).
- **Balance:** checked A/B against the previous build with the QA bot — damage taken, kills and pace are unchanged.

## v8 — Performance: no hitches, a first visit included

Measured first, then fixed. The method, every cause and the before/after numbers are in
[docs/PERFORMANCE.md](docs/PERFORMANCE.md).

- **Tools.**
  - A frame profiler in every build (F9 or `?perf`): frame and phase times, CPU/GPU, draw calls, memory, render scale,
    and every spike over 30 ms with what caused it.
  - Benchmark profiles A–G (`zm.bench`): driving, combat, heavy combat, boss, maximum chaos, first load, restarts.
- **Shaders.** Everything the game can draw is compiled and drawn once behind the boot screen, in parallel on the
  driver's threads. 0 shader compiles happen in play: the 0.4–0.7 s freezes at the first enemy, explosion or crash
  are gone.
- **Boss.** Its presence light was a new scene light: every lit shader recompiled, a 5 s freeze. It is now a permanent
  pooled light, and the light count never changes.
- **Road.** Segments are built in slices under a 2 ms budget instead of 20–35 ms in one frame. The result is
  identical, and the first 450 m are built at the start so nothing pops in.
- **Resolution.** The post chain now honours the pixel ratio, and effects keep their size at any resolution.
  - Presets set a ceiling.
  - AUTO QUALITY moves only the resolution, both ways, with hysteresis. It never lowers the saved preset, effects,
    traffic or enemies.
- **Draw calls.**
  - Far cars are one draw with their wheels baked in.
  - Lane paint, decals and props under the fog past 220–320 m are not submitted.
- **Garbage.** Per-frame allocations in the session, lamps, emitters and HUD were removed, and shader error checks
  run in debug builds only.
- **Result.** First visit, 1280×720, before → after:
  - worst frame in the boss fight 4077 → 39 ms; in combat 727 → 154 ms; in chaos 267 → 134 ms;
  - frames over 100 ms per 25 s of chaos 4 → 1;
  - boot 5.4–7.6 → 3.5–5.1 s;
  - draw calls in chaos 619 → 399.

  On a CPU slowed ×4: boss 29 → 38 fps, chaos 23 → 29 fps.
- **Unchanged:** physics (24/24 invariants per car, identical values), gameplay, road generation (identical segments
  and props by seed), effects and look.

## v9 — The street: iDos Games and MileToken inside the game

The design, the money flow and how to change prices are in [docs/IDOS_INTEGRATION.md](docs/IDOS_INTEGRATION.md).

- **Street duels.** Asynchronous PvP on the iDos match system.
  - A driver posts a challenge: a TORQUE or supplies stake, the car, and a ram plan (where to ram, which side to brace).
  - Anyone can take it. The server fights the two server-side cars, pays the winner both stakes and burns 5%.
  - The game performs the server's battle log in the garage pit as a real-time 3D duel: charges, sparks, blocks,
    dodges, crits and a smoking wreck.
  - High-stakes duels cost 1 MileToken to post.
- **Duel garage.** Every car has a server twin with six stats tuned with TORQUE. The tuning never touches how the car
  drives in a run.
- **Liveries.**
  - Twelve wraps: from the depot, the livery crate (a server roll with a pity rule), the weekly Shift and the street
    market.
  - A wrap shows on the road, in the pit and on other players' screens.
- **The depot.** MileToken buys supplies, car keys (the car is unlocked on every device), TORQUE and liveries. TORQUE
  buys the scrapyard shelf.
- **Supplies in a run.** Each comes from stock or is paid in MileToken on the spot, and is charged on the server before
  the effect applies.
  - Tow truck: back on the road after a wreck, once per run.
  - Toll express on the map: skips a row.
  - Black market at the night market: an EPIC part, free.
  - Wreck insurance: double salvage.
- **The weekly Shift.** The same city for every driver, ranked on a weekly board with TORQUE and crate-key rewards. No
  supplies, Night One rules.
- **THE DRIVER hunt.** Every boss any driver takes down adds to a city-wide weekly counter (Cloud Code, capped and rate
  limited). Each driver's share pays out at milestones.
- **Daily contracts** are fed by run numbers.
- **The street-race rival** is a real driver from this week's board.
- **The street market.** Wraps and supplies trade between players for TORQUE.
- **Offline first.** The SDK loads on demand, the login runs beside the shader warm-up, and with no network the game is
  exactly v8.
- **Verified live on the DEV title.** `npm run idos:verify` passes 26/26: tuning, purchases, boosts, a crate, a wrap, a
  duel, the Shift, contracts, the hunt and a market sale. Physics: 24/24 invariants per car, unchanged.

## v10 — One game, on the account

v9 added iDos Games beside the game: a browser save for the runs and the garage, and an online layer that appeared
when the network was there. v10 makes the platform the game's spine. There is no offline variant any more.

**Signing in** (`src/ui/login.ts`, `src/idos/platform.ts`, `src/idos/wallets.ts`)
- The first screen for a driver without a session. The methods, in order:
  - a Solana wallet: one free signature over the server's challenge. Outside idosgames.com, the game connects the
    wallet itself (Wallet Standard / injected); inside idosgames.com, the site's wallet signs. On phones, the screen
    offers to reopen the game inside the wallet app.
  - the iDos Games account (SSO and back)
  - e-mail with register / confirm / resend / forgot / reset
  - Telegram inside a Mini App
  - a guest
- "Remember me" applies to every method.
- Boot resumes the remembered session (or the code idosgames.com hands over) while the shaders compile. It keeps "the
  server is unreachable" (a connection screen with a retry) apart from "sign in again".
- The account panel holds the driver's name, how the account signs in, the linked wallet and sign-out. A guest is
  invited to sign in with a real account once a day.

**Progression on the server** (`src/idos/profile.ts`, `idos/cloudcode.template.js`)
- SALVAGE is the account's currency `SV`, the same currency the street uses. TORQUE is gone.
- Cars, upgrade levels and paints are items in the `garage` catalog.
- The records live in a ReadOnly profile that only Cloud Code writes. The garage choices live in the account's
  private data. Achievements are permanent quests, claimed for SALVAGE in the ARCHIVE.
- Every run is opened (`startRun`) and closed (`finishRun`) on the server. The script checks the report against the
  clock and the rules, pays the salvage with the game's own formula, and keeps the records. A run it could not record
  (connection, session) is sent again later.
- Garage purchases are one atomic charge-and-grant (`garageBuy`).
- Wreck insurance is paid by the server against a policy taken out after the run (`insureRun`).
- A browser save from earlier versions comes onto a fresh account once (`importLegacy`, salvage capped at 2,500), then
  is retired.
- Only the device's settings stay in the browser.

**Found on the way**
- `ApplyResourceOperation` treats a repeated `Reason` as a replay and skips it, while still answering `Success`.
  Every grant now carries a unique reason.
- `getUserState(['InventoryV2'])` can answer with a stale snapshot. The game refreshes balances with
  `getUserInventory()`.
- The SDK's per-endpoint throttle refused a second call within 600 ms, which is exactly "close the run, open the next
  one". The game turns that throttle off and paces its own calls: progression scripts 250 ms apart, calls of the same action
  (a quest report, a board read) 1.1 s apart, different actions side by side. The live title answers the same action
  twice within a second with a 429.

**Checked**
- `npm run idos:verify` on DEV: 58/58. The steps include:
  - runs opened and closed, with the exact payout on the balance
  - a replayed ticket and a too-fast run refused
  - two upgrades bought back to back
  - insurance paid once
  - an achievement completed and claimed
  - a browser-save import, accepted once and refused for an account that already drives
- In the browser:
  - sign-in screen, wallet list, e-mail validation, guest sign-in, sign-out, the account panel
  - garage purchases updating the balance at once
  - a run recorded with its server payout, insurance paid
  - an achievement claimed
  - the phone layout of the sign-in screen

### v10.1 — The street on the first screen

The first live session showed the problem: the duels, the Shift, the depot and the wallet were real, but they lived in
garage tabs, and the Shift sat at the bottom of a column. The street is the game's hook, so it moved to the front.

- **The main menu is a hub.**
  - Three marked buttons sit under START RUN: STREET DUELS · PvP, THE WEEKLY SHIFT · RANKED, and THE DEPOT ·
    MILETOKEN.
  - A live panel, THE STREET TONIGHT, holds:
    - the balances and the wallet
    - the open challenges
    - the Shift's top three
    - the contracts, with a claim button
    - the hunt
  - The panel updates as the server answers.
- **First visit.** The street's introduction shows once per account, and the flag is kept on the account.
- **Garage.**
  - The DUELS and DEPOT tabs come right after PLAY, marked, with badges.
  - DUELS opens with three steps, and with an empty street it offers to post the first challenge.
  - The Shift and the contracts head PLAY.
- **After every run.** DUEL A REAL DRIVER sits next to NEW RUN.
- **Names.** A resumed session's state did not always carry the public name, so the chip said DRIVER. Cloud Code's
  `profile` handler now returns the name, read on the server.
