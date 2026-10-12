# ZERO MILE — visual content pass

## Audit (14 frames: zone starts, traffic, combat, chase, bridge, chaos, boss, last seconds, arrival, all five zones)

Baseline: 200–250 draw calls, ~35k triangles, 1.3–3.4 ms per simulated + rendered frame (1280×720).

| Question | What the frames show |
| --- | --- |
| What fills the image? | Two continuous walls of identical dark boxes (≈55% of every frame) and a flat road (≈30%). |
| Foreground / midground / background? | Foreground = road only. Midground = the box walls. Background = a flat sky gradient; the skyline strip is hidden behind the walls. No layering. |
| Scale? | None: every building is the same box, no near/far size contrast, nothing bigger than a building. |
| Where is the player? | Readable — mostly because of the cyan underglow blob, which is also the most toy-like thing on screen. |
| A story of the place? | No. Nothing says *industrial*, *flooded*, *old city* except the fog colour. |
| Landmarks? | One every ~5 segments and usually hidden by the walls; nothing to remember a route by. |
| Shape / material variety? | Boxes; one dark facade material with random pink/blue/cream window squares ("confetti"), one asphalt. |
| Strip of road with objects on top? | Yes — exactly that. |
| Empty space? | The roadside (barrier → building) is an empty grey strip; the sky is empty. |
| Reason to look beyond the car? | Neon signs only. |
| ZERO MILE or generic neon prototype? | Generic: black boxes + neon + bloom. |

## Visual gap report — the biggest causes, in order

1. **Facades.** Same box everywhere with randomly coloured window squares: no floors, no mullions, no warm "lived-in" light, no roof silhouettes. It is half of every frame.
2. **No foreground layer.** Nothing between the barrier and the buildings: no poles, fences, stops, parked vehicles, billboards, wrecks — no callback every 20–50 m.
3. **No depth.** A single wall of buildings at the roadside, no second row, no towers behind, no skyline above, no giant structures, no smoke or haze layers.
4. **Zone identity is only colour.** Industrial, Flood and Old City use the same buildings; Zero Mile's wireframe cubes read as debug geometry.
5. **Flat road.** A uniform texture with large orange light-pool blobs; perfect repeating dashes; no wear, tyre tracks, patches, oil, joints.
6. **Cars read as toys.** Underglow blob, flat paint, no grille / mirrors / plates / exhaust, enemies are dark shapes that vanish at night, traffic is a few coloured boxes.
7. **Telegraphs paint the road.** Big flat colour slabs carry the danger; the world itself (debris, damage, warning hardware) doesn't.
8. **Empty sky.** Gradient + stars; nothing moving, nothing far away.

## Plan (each step checked against the same 14 frames)

- **P0** facades and building massing per zone · second row and back towers · roadside layer per zone · road wear and markings · landmarks and skyline layers.
- **P1** vehicle detail and materials, hostile lighting language, traffic variants · chaos-event and bridge spectacle · boss presentation · lighting/material tuning.
- **P2** damage states · atmosphere (haze, smoke columns, distant life) · camera framing.
- **P3** colour grading and final image treatment.

Rules: no gameplay change (all scenery sits outside the barriers or is non-colliding), merged geometry per segment, shared materials, no new per-frame cost beyond a handful of animated lights.

## What changed

**P0 — shapes and environment**

- Facades: office glass / homes / corrugated industrial, with floor slabs, mullions and night lighting by floor or window; zone tints; setbacks, rooftop clutter and warning lights; shop fronts with awnings at street level; warehouses with dock lamps; a taller back row; factory stacks with smoke (GPU point batches, one draw call per segment).
- Roadside layer outside the barriers, a callback every 20–45 m from the zone's family: utility poles and sagging wires, fences, flood walls and sandbags, billboards, bus stops, parked and burnt-out cars, containers, pallets, barrels, jersey barriers, flood-light masts, roadworks with a digger and flashing lamps, police checkpoints, trees, kiosks, road signs. Elevated zones: wind fences, sign gantries, highways crossing far below.
- Overhead crossings per zone: pipe bridge, monorail, skybridge, upper deck, broken ring.
- Road: tyre tracks, patches, oil, cracks, manholes, drains, skid marks on bends, bridge joints; varied and worn dashes; quieter lamp pools.
- Landmarks, three per zone, 105–330 m off the road and drawn through their own haze: cooling towers with steam, flare stack, refinery · dam, sunken towers, lighthouse · mega tower, TV tower, pagoda · arcology, twin towers, suspension bridge · the Zero ring, an inverted tower, floating shards. A cloud deck lit by the city; aircraft and searchlights in the sky.
- Cars: static parts merged per material (more detail at the same draw-call cost): grilles, bumpers, panel lines, mirrors, pillars, plates, exhausts; hostile cars with red light slits and a visor; clear-coat paint on car-sized cars; contact shadows; traffic variants (sports, wagon, SUV, ambulance, pickup, tanker, flatbed); softer underglow.

**P1 — spectacle and light**

- Boss rigs: Iron Mule beacons, furnace grille and stack smoke; the bus lit inside with arcs on the roof; Taxon's strobing light bar and takedown lights; Apex's tail-light streaks; The Driver's breathing seams. They flare when the boss telegraphs and go white when it is vulnerable. Boss defeat: a chain of blasts, burning debris, a smoke column.
- Chaos: debris breaks loose in a shower of sparks and lands with a flash and a dust ring; pile-ups happen with sparks and glass, one car on its roof burning, hazard lights going; the wrong-way truck flashes full beams and hazards at you.
- Broken bridge: floodlight masts and beacons on the edge, torn barrier ends, barricades and a police car on the shoulder, a car nose-down in the canal, rubble.
- Arrival gate: 16 m pylons, a big lit header with checkered bands, stadium lights over the approach, runway lights pulsing into the gate.
- Rim light from ahead (zone-tinted), pickups throw light on the road under them.

**P2/P3 — feel and image**

- Player car damage states: dust and dull paint below 70 %, dents and scorch marks with a hanging bumper below 40 %, stuttering lights below 20 % (plus the existing smoke and sparks).
- Camera opens up (FOV) while airborne; speed specks stream past the edges of the view instead of blobbing in the middle.
- A gentle grade per zone on top of the existing tone mapping, vignette and grain (no extra bloom or exposure).

## Results

| | before | after |
| --- | --- | --- |
| draw calls (zones 0/2/3/4) | 198 / 210 / 180 / 251 | 267 / 182 / 205 / 230 |
| triangles | 31–35k | 45–51k |
| GPU time per frame (timer query) | 0.35–0.43 ms | 0.41–0.65 ms |
| segment build (new road piece) | — | ~6 ms median |

The browser pane was hidden during testing, which throttles wall-clock timings (they swung 2–112 ms for an unchanged frame), so CPU frame time is reported through draw calls and per-piece build cost rather than FPS.

Gameplay: no balance, damage, handling, AI or encounter values changed. All scenery is non-colliding and generated from its own random stream; removing the old building loop shifts which cones and blocks a given seed places (same rules, same density). Five-zone production smoke test and a full autopilot run: no errors.

---

# 3D asset / modelling overhaul

The visual pass above dressed the world; its objects were still built from boxes, cylinders and cones. This pass
replaces them with authored models: real silhouettes first, then primary and secondary forms, separated materials,
details — readable with no bloom, fog or post. Full register: [ASSETS.md](ASSETS.md).

## Audit — what was primitive, and what was done with it

| Object | Was | Class | Now |
| --- | --- | --- | --- |
| Player cars | an extruded side profile + a glass box + boxes for lights, plow, cage | A — replace | Lofted bodies with arches, flares and fender crests, raked glass, pillars, panel gaps, fascias, mirrors, real wheels; Courier is a hot hatch with a roof wing, Ghost a mid-engined canopy car, Rammer a lifted pickup with a ram blade and cage, Hauler an expedition van |
| Traffic | the same extrusion in five sizes | A | 13 vehicles: sedan, sports coupe, wagon, hatchback, compact SUV, minibus, utility van, crew-cab pickup, box truck, tanker, curtain-sider, taxi, police car |
| Enemies | the extrusion with spoiler / plow boxes | A | Interceptor (low coupe, wing, splitter), Rammer (wide armoured pickup, curved ram blade, cage), Gunner (fastback, roof turret), Bomber (buggy with cage and drums), EMP van (dish, coils, antennas), Blocker (armoured truck with blade and warning band), Hunter (canopy wedge, fins, blade wing); elite = armour + roof scoop |
| Bosses | the extrusion at boss size | A | Iron Mule (armoured cab-over with blade and stacks), Drowned Line (city bus with roof units, cow-catcher, destination board), Taxon (pursuit car with push bar, armour, light bar), Apex (hypercar with canopy and huge wing), The Driver (black wedge) |
| Wheels | 3 cylinders | A | Tyre with shoulders, rim lip, spokes, brake disc and caliper, hub |
| Roadside props | boxes and prisms | A | 48 modelled props (street furniture, roadworks, plant, industrial, flood debris, boats) |
| Gameplay props | cone/cylinder/box primitives | A | Kit models; collision radii unchanged |
| Building blocks | textured boxes | B — keep the textured block, add relief | Balconies, AC units, down-pipes, cornices, plinths, slab edges and fins, steel pilasters, pipe runs, roller-door frames, fire escapes, entrances and canopies, roof plant — placed on the texture's window grid |
| Industrial background | a prism with a red cube | A | Tanks, silos, cooling tower, chimney, refinery column, cranes, flare, hopper; pipe racks along the road and a pipe bridge over it |
| Bridges / elevated roads | box piers, red-lit poles | A | Hammerhead piers, deck girders, cable-stayed pylons with stays, parapet rails |
| Tunnels | flat walls | A | Portals with surround and name band, ribs with jet fans, cable trays, pipes, walkways, exit signs |
| Landmarks | prisms and lathes | B | Industrial ones rebuilt from the kit at landmark scale; dam with buttresses, gate piers and intake towers; mega tower with piers, fins and a lattice crown; TV tower with tripod, pod levels and stepped mast; twin towers with fins and crowns |
| Skyline | one textured band | C | Two bands: a far band in the haze, a darker, denser near band |
| Road, decals, smoke, rain, signs, neon, facades' window textures | procedural | D — keep | (placement, wear, atmosphere stay procedural) |

## Pipeline

- **One material per car.** Surfaces are told apart by a texel of an 8×4 atlas (colour, clear coat, roughness,
  metalness, emission). A car body is one draw call with paint, glass, rubber, chrome, carbon and lights separated;
  brake lights, hazard blinks, accents and the boss glow are live uniforms.
- **Damage in the shader:** dust and dull paint below 70 % hull, crumpled panels (vertex displacement towards the
  ends) and soot below 40 % with a loose bumper, stuttering lights below 20 %. No extra meshes.
- **Detail levels:** hero (player, bosses), standard (traffic and enemies up close), far (past 48 m, `THREE.LOD`).
  The environment kit is built at the standard level (no micro-chamfers on small parts).
- **Merged per segment:** every kit asset is copied into the segment's single kit mesh (typed-array builder);
  caches are built in idle slices while the menu is up.
- **Collision is untouched.** Every vehicle model is built to the gameplay footprint (verified for all 22 kinds and
  variants); gameplay props keep their radii; the segment random stream that places obstacles is not consumed by
  scenery.

## Triangle budget

| Vehicle | hero | standard | far |
| --- | --- | --- | --- |
| Courier (player) | 4,004 + 4 × 748 wheels | — | — |
| Sedan / hatch / van | — | 2,450–3,130 + 4 × 466 | 1,240–1,440 + 4 × 81 |
| Trucks (3 variants) / Blocker | — | 2,690–3,560 + 6 × 466 | 1,500–2,060 + 6 × 81 |
| Enemies | — | 2,580–3,550 | 1,310–1,770 |
| Bosses | 3,770–7,980 | — | — |

Props: 54–900 triangles (lamp 196, container ~500, excavator 746). Industrial pieces: 160–2,300.

## Results (same 14 checkpoints, 768×576)

| | before (procedural) | after (authored) |
| --- | --- | --- |
| triangles in view | 45–51k | 115–280k |
| draw calls | 182–267 | 118–296 |
| GPU time per frame (timer query) | 0.41–0.65 ms | 0.43–0.73 ms |
| segment build | ~6 ms median | 6–11 ms median (22 ms worst) |

GPU cost stayed flat because the extra triangles are in a handful of large merged meshes with one simple material;
draw calls did not grow (a car is one body call plus its wheels, a segment's whole kit is one call).

Trade-offs: the textured facade blocks remain the buildings' mass (their windows are texture), with modelled relief
on the road-facing side — a full modular-building rewrite would cost far more geometry for the same read at speed.
Landmarks stay silhouettes with lights (they sit in haze 100–340 m away). Vertex data per live segment grew to
roughly 2–4 MB.

## Tests

- Lineup in a neutral studio (`zm.lineup()`): player, traffic, rammer, hunter, blocker, EMP van, boss — front ¾,
  rear ¾, side, front, rear, top, 120 m, 12 m, and a clay render (one grey material: silhouette and form only).
- In-game frames with no post, no particles, no rain and no HUD, and the same frames in greyscale.
- 14 checkpoints re-shot from the same seeds as the before set.
- Typecheck, production build and preview, autopilot runs across zones, bosses, bridge, chase and finish: no errors.
