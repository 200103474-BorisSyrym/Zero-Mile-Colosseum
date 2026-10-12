# ZERO MILE — VFX pass

Goal: make the existing effects convincing. **No new effects.** Every effect should answer five questions in one
glance: what happened, where, in which direction, how hard, and why it belongs to this world.

Process: audit → prioritisation → implementation → visual QA. The capture set (16 game situations plus raw
frames with no post-processing) was re-shot after every round, in the same scenes, and compared against the
"before" frames.

## Audit — what was a primitive

| Effect | Before | Why it read as fake |
| --- | --- | --- |
| Hits, EMP, abilities, perfect ram | `fx.ring`: a flat expanding ring | a geometric shape on the road; it says neither direction nor strength |
| Headlights | spotlight hotspot plus a flat trapezoid plane | a lit ellipse and a visible polygon edge on the asphalt; no lamps, no air |
| Brake, reverse and turn lights | an emissive colour only | nothing reached the road; no blink, nothing at night |
| Boost | streaks stretched along velocity | from the chase camera they pointed into the body and vanished |
| Smoke | one grey sprite for exhaust, damage, dust, explosions | the same blob everywhere; round, opaque, cut off by the road |
| Explosions | a few round sprites | small, soft, no flash, no stages, no aftermath |
| Sparks, EMP arcs, spray | 1-px lines and dots | sub-pixel at 10 m; arcs were straight lines |
| Projectiles | instanced white boxes | glowing bricks flying through the air |
| Pickups | a vertical cylinder and a radial disc | a laser tube plus a perfect circle on the road |
| Hazards | radial discs | oil, water, fire and energy were all the same circle |
| Lamp pools, puddles | radial textures, ellipse gradients | rows of perfect discs; puddles with bright rims |
| Underglow | a ring with a dark centre | a cyan outline around the car |
| Boss death | random `explosion` calls | noise, not a sequence; the lights stayed on |
| Chaos (wrong-way truck) | two sprites stuck on the cab | headlamps not on the lamps |
| Post | constant chromatic aberration, a strong radial blur, a full-screen EMP tint | everything always on, edges always smeared |

## Problems found during QA that the brief did not list

These were invisible in code review and showed up only in the frames. Several of them hid the work above.

1. **Atlas rows were swapped.** The canvas texture is flipped in Y but the shader picked cells top-down. Fireballs
   drew the electric "crackle" frame, lamp glare drew a flame tongue, flames drew the glare. Fixed in the sprite shader.
2. **Streaks were back-face culled.** The quad's winding follows the side vector, which flips with direction, so
   most sparks, EMP rays, spray drops, boost jets and speed lines never drew. Now double-sided.
3. **Point sprites were sliced by the ground.** A point sprite is a flat card at its centre's depth, so the road in
   front of its lower half cut every smoke puff along a hard line (square smoke). Sprites now pull their depth toward
   the camera by about their radius (same screen position and size), and the smoke base fades softly.
4. **Sparks fell between pixels.** A 3 cm streak 20 m away is sub-pixel. Streaks now have a minimum on-screen width of
   about 1.3 px and return part of their brightness when widened.
5. **Smoke vanished at night.** Dark smoke on dark buildings, and orange smoke on orange haze, has no contrast. Smoke
   palettes are now mid-tones: lighter than the street, darker than the lit sky, warm while fire-lit. The zone tint
   hook (`setAmbient`) was never called; it is now wired.
6. **Fire washed to white.** Additive lumps with green and blue in them sum to white under bloom. The flame ramp is
   now red-heavy, there are fewer lumps, and smoke draws *after* fire, so a fireball turns into a smoke cloud
   instead of a glowing cotton ball.
7. **Camera inside an effect.** A big sprite next to the camera filled the frame with mush. Sprites now fade with
   distance relative to their size.
8. **Puddles in the roughness map** were perfect ellipses with a mid-roughness rim that caught every lamp as a ring.
   They are now ragged, low-contrast gloss patches.
9. **Debris** chunks were cubes and panels were flat cards. They are now an irregular rock and a creased, torn sheet;
   cone and plastic strikes throw small shards.
10. **`fx.collect` was never called** — picking anything up had no feedback. It is wired, with a light.
11. **Death sequences were staged at a fixed point** while the wreck kept rolling. They now follow a live position.
12. **First-use texture uploads** caused 30–47 ms hitches in the first explosion. All VFX textures are uploaded at start.
13. **QA trap:** auto-quality dropped the harness to LOW (density 0.45, simple post) without notice. All final
    frames are at HIGH with auto-quality off.

## Priorities

- **P0** headlights, brake lights, boost, collisions, sparks, smoke, explosions, environment lights.
- **P1** EMP, boss VFX and boss death, damage, tyres, projectiles, pickups, chaos, local light response, fake
  volumetrics, atmosphere.
- **P2** speed, screen effects, micro particles, environment effects.
- **P3** final art direction across the whole capture set.

## What each effect is now

### Vehicle light (`src/effects/carLights.ts`, `carModels.ts`, `driving.ts`)

- **Headlights:**
  - **Placement:** lamps come from the model (`anchors.heads`, authored in the body loft). The player's two spotlights
    sit in those lamps, aimed down the road and a little outward.
  - **Look:** a glare core on each lamp, scaled by how much of the lamp faces the camera. On the road, a soft fan
    with a hot near end — no ellipse, no edge. In the air, a fake-volumetric beam (see below) for the player and for
    cars within 75 m. Beams are thicker in tunnels.
  - **Dying lamps:** they stutter (wrecks, a hull under 20%), and the spotlights follow the stutter.
  - *Why it belongs:* the lamps light what they point at — the car ahead, the barrier, the road — and they sit in
    the fog.
- **Brake lights:**
  - The tail glare grows with braking force, and a red sheen spreads on the asphalt behind the car.
  - Traffic brakes when it sheds speed (visual inference only).
  - On wet roads the sheen stretches into reflections.
- **Reverse, indicators and hazards:**
  - Reverse lamps are white.
  - Amber indicators blink about 1.5 times a second when traffic changes lane.
  - The wrong-way truck flashes full beams on its real lamps and runs its hazards.
- **Underglow:** a filled glow under the sills that only falls off outward.

### Boost and exhaust

- **Where:** jets come from the model's tailpipes (`anchors.exhausts`; the Mule's stacks point up).
- **Jet structure:** a white-blue core and a coloured sheath; the length flickers.
- **Read from behind:** a ragged hot lobe at the nozzle, a pooled light under the bumper, and an occasional puff.
  Flames inherit the car's velocity.
- **States:**
  - cruise — nothing;
  - lifting off at high revs — exhaust **pops**, triggered on the same beat as the audio pops through a VFX-only hook;
  - boost — the hot jet;
  - damage — a coughing grey tailpipe.
- Enemies on boost flame from their own tailpipes.

### Smoke profiles

The profiles are exhaust, damage, explosion, dust, burning, tyre, industrial, mist, steam and rocket. Each has its own
colour ramp (start → end), size, growth, life, rise, drag, turbulence and opacity, and is tinted by the zone light.
Dust is drier, lighter and lower; burning smoke rises in a column; mist is faint and wide; tyre smoke is a continuous
sheet whose opacity follows the slip.

### Tyres

- **Skid marks:** ring-buffer quads per wheel, only while that wheel slides. Strength varies; they fade with age.
- **Rear-tyre smoke:** on drifts and slides, plus a burst under hard braking.
- **Dry roads:** dust.
- **Wet roads:** a faint mist and droplet streaks thrown up by the tyres.

### Collisions — `fx.impact(x, y, z, dir, strength, surface, paint)`

Staged as anticipation → contact → follow-through → fade:

1. A white-hot contact flash (glare), plus a short light for medium and heavy hits.
2. A spark fan along the impact direction, with a count that depends on the surface (metal sparks far more than
   concrete).
3. Debris at 30 ms: shards, rock chunks or torn panels in the car's paint; glass on heavy hits.
4. Dust at 50 ms.
5. Damage smoke at 250 ms for heavy hits.

Light, medium and heavy are one function driven by strength, and the hit's surface comes from its collision
material. Camera kick and audio fire on the same frame.

### Explosions — `fx.explosion(x, y, z, radius)`

| Time | Stage |
| --- | --- |
| 0 s | Flash: a glare, a pooled light and a ground flash. A lumpy fireball (two offset cores and lumps with torn holes) with sparks and embers. |
| 40 ms | Shock wave on the ground and a ring of dust. |
| 60 ms | Debris. |
| 80 ms | Smoke born on the fireball's shell, rolling out and swallowing it. |
| 0.45–1.3 s | A burning smoke column, fed in waves. |
| 0.2–0.4 s | A secondary pop (big blasts and random ones). |
| up to 9 s | A scorch mark. |

`deathSequence(at, size)` stages a big machine's death on its live position:
1. escalating pops;
2. the main blast at 0.7 s;
3. secondaries at 1.05 s and 1.4 s;
4. three seconds of burning smoke and fire.

### Boss death

The sequence is impact → escalation → explosion → smoke → debris → **lights shutting down**:
- the accent, headlamps and tail lamps fade, with a last stutter;
- every lamp of the boss's light rig dies with it (`BossRig.shutdown`).

Audio blasts and camera trauma are scheduled on the visual stages. The Driver's flat halo slab became two light
strips cut into the roof.

### EMP

- A hot core flash and a short cold light.
- Jagged arcs: segmented bolts with a white core.
- Radial streaks, a short broken ground wave and a faint flash.
- Targets crackle.
- Street lamps within range cut out, then stutter back, far ones a beat later (`fx.onPulse` → `Environment.stutterLamps`).
- The screen tint is now mostly at the edges.

### Damage (`driving.ts`)

| Hull below | What shows |
| --- | --- |
| 55% | engine-bay smoke |
| 30% | sparks |
| 18% | engine-bay fire |
| 20% | the lamps stutter |

Dents, dirt and soot remain shader states on the body.

### Projectiles (missiles)

- **Body:** a dark, lit missile with fins.
- **Motor:** a glare and a short jet.
- **Trail:** a pale rocket trail that hangs where it flew.
- **Launch:** a backblast (muzzle flame, smoke and a light) for each missile, staggered.
- **Impact:** the explosion above.

### Pickups

- The object itself, its own glare and rising motes.
- A soft fake-volumetric shaft on valuable kinds; an irregular, rotated light pool on the road.
- Collection: motes rush in, then a burst, a glint and a short light.
- No rings, no cylinders.

### Hazards and telegraphs

- **Hazards:** oil, water, fire, spikes and energy use irregular textures (stains, standing water, scorch, energy
  glow) instead of discs.
- **Telegraphs** stay bold, because they are gameplay:
  - the ring is a feathered rim with inward ticks;
  - lane strips have feathered edges and hazard hatching;
  - chevrons are softened.

### Environment light

- **Street lamps:**
  - a glare on every lamp head;
  - irregular pools on the road, varied in size, orientation and mirroring;
  - a faint fake-volumetric cone under each lamp, thicker in rain and haze;
  - the real pooled point lights follow the nearest lamps.
- **Tunnels:** the ceiling lamps throw cones and patches of light on the road, and feed the point-light pool.
- **Searchlights and the lighthouse:** fake-volumetric beams with no silhouette.

### Screen effects (`src/effects/postfx.ts`)

| Effect | Change |
| --- | --- |
| Chromatic aberration | none at rest; a hint at top speed, a jolt on hits, the Zero Mile glitch |
| Radial blur | only the outer frame, capped and weaker |
| Speed vignette | capped |
| EMP | desaturation weighted to the edges |
| Damage flash | edges only, weaker |
| Camera shake | audited: squared trauma, decays at 1.7/s; no per-frame sources above noise level |

## Techniques

| Technique | Where | Notes |
| --- | --- | --- |
| GPU point sprites with an atlas | `SpriteSystem` (additive and alpha) | Per particle: rotation, turbulence, colour ramp, alpha curve, fog. Size is in metres. Depth is pulled forward by the sprite's radius; there is a size-relative near fade. |
| Velocity-stretched streaks | `StreakSystem` (instanced quads) | Moving or fixed segments; minimum pixel width; double-sided. |
| Immediate-mode glare | `glare.direct()` / `flush()` | Lamp glare is rebuilt every frame from the lamp anchors, at no simulation cost. |
| Fake volumetric beams | `lightBeams.ts` | A Fresnel edge fade hides the cone. Falloff along the beam, a dust shimmer, a near-camera fade and fog. Merged per segment. |
| Pooled lights with an envelope | 4 point lights | attack / decay / flicker |
| Pooled ground decals | 18 quads | flash, wave, scorch |
| Instanced debris | 3 instanced meshes | shard, rock chunk, torn panel; bounce, settle, fade |
| Skid ring buffer | 900 quads, 1 draw | age fade in the shader |
| Staging scheduler | `fx.after(delay, fn)` | the stages of one event |
| Procedural textures | `vfxTextures.ts` | Canvas-drawn and irregular; all uploaded at start (`vfxTexturesAll`). |

All particle data lives in preallocated typed arrays; nothing is allocated per particle. Effect density scales with
the quality setting.

## Budget and measurements

**Caps:**
- 4200 additive and 2800 smoke sprites;
- 400 glare sprites and 2400 streaks;
- 330 debris (120 per shape);
- 900 skid quads, 4 lights and 18 decals.

**Draw calls:** the effects add about 10–25 (one per system, the visible decals and debris meshes, one lamp-beam mesh
per road segment, and beam volumes on cars within 75 m).

**Worst case** — boss fight, pile-up chaos, 4 enemies and 4 missiles, an explosion every 0.5 s, two EMPs and a death
sequence. Measured in the in-app Chromium at 1024×768 on HIGH:

| Metric | Value |
| --- | --- |
| Draw calls | average 238, peak 268 |
| Triangles in view | about 320k |
| Simulation | 0.3–0.45 ms per frame |
| Render (with `gl.finish`) | average 2.9 ms; p95 about 12 ms while several explosions overlap near the camera (fill rate) |
| Hitches | the 30–47 ms first-use spikes are gone after the texture pre-upload |
| Peak live particles | 274 additive, 714 smoke, 399 streaks, 273 debris, 900 skids |
| Renderer memory | 237 geometries, 66 textures, 92 programs |

## Trade-offs

- **Sprites are depth-pulled, not true soft particles.** A depth-texture pass would cost a full extra depth
  render. The pull removes the hard ground cut in the chase view, but smoke right behind a car can draw slightly over
  it.
- **Smoke draws after fire across the whole system.** That is right for fireballs and burning wrecks, but smoke far
  behind a lamp can dim its glare.
- **One shared point-light pool (4).** Simultaneous flashes beyond four take over the oldest light; the glare and
  decals still carry the moment.
- **Lamp beams and pools are baked per segment**, so they can't flicker individually. The EMP stutter acts on the
  real lights and the glare.

## Tools

- **VFX LAB** (debug panel, *VFX LAB* row): `night` (a car at 10 / 25 / 50 / 100 m), `wet`, `brake`, `boost`,
  `drift`, `hitL` / `hitM` / `hitH`, `sparks`, `explosion`, `smoke` (all profiles side by side), `emp`, `pickup`,
  `bossDeath`, `damage` (cycles the hull), `speed` and `NO POST` (renders with no post-processing at all).
- **Capture set:** the same 16 situations, raw frames, a frozen-world effect timeline (effects advance, the world
  doesn't) and the three final test frames. All frames are at HIGH with auto-quality off.

## Unchanged

Damage, hitboxes, collisions, handling, AI, chases, duels, progression, rewards and encounter logic. The only
additions are visual hooks and VFX-only state:
- light states (`CarLights`);
- the boss rig `shutdown`;
- the audio `onPops` hook;
- `onPulse`;
- the lamp stutter.
