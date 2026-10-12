# ZERO MILE — driving physics pass

Arcade-first: player control, readability and fun come before realism. Every shared tuning value lives in
`src/core/handling.ts`; per-car personality stays in `src/data/vehicles.ts`. Run `zm.physics('all')` in a dev build
(or **PHYSICS → RUN TESTS** in the debug panel) for the benchmarks and invariants.

## Physics gap report (audit before the pass, Courier)

| Area | Found | Fix |
| --- | --- | --- |
| Braking | 100→0 km/h in 11 m (3.5 g): stops like a brick | speed-dependent bite: 19 m; 200→0 in 66 m |
| Top speed | full pull until a hard cap | asymptotic engine curve: no wall |
| Steering | 0.2 s ramp; a 0.2 m sidestep took 283 ms | instant first bite plus ramp; yaw in 17 ms, sidestep in 233 ms |
| Drift | yaw-rate driven; the angle ran to 88° uncontrolled; instant snap-in | slip-angle state on a spring (into / neutral / countersteer set the angle); blended entry; clean exit in 0.17 s; tap-to-drift is sustained by steering; per-car drift grip |
| Ramps | samples drop at the lip: the car sank 1 m just before take-off (the crooked jump); the body stayed level on the ramp | the lip continues the ramp; the body pitches with the slope; launch along the ramp |
| Air | yaw only, no orientation | the nose follows the arc; brake lifts the nose; steering banks; a small trajectory nudge |
| Landing | binary good/bad; a bad one cost 28% of the speed | perfect / good / rough / bad / crash, graded on pitch, roll and heading; assist scaled by the grade; nose-first hop; grip comes back over 0.3 s |
| Rams | plain impulse: rear-ending a sedan cost 58 km/h, a truck 72 | arcade response by mass and direction: sedan −10, T-bone −28, truck rear −34, head-on −60…−106; target launched, spun (side / corner), shoved (rear), lifted on big hits; rubbing slides apart; ram cooldown; heavier targets blend toward a plain impulse, bosses keep exactly the old response |
| Wreck blasts | a rammed car exploded and threw you back up to 8 m/s | blasts shove sideways and never stop a car driving through them |
| Walls / curbs | good material model; no body response | bump, stumble and a spin you can catch, graded by severity |
| Recovery | a stuck car needed R | pivots back when facing the wrong way, crawls off walls after 1 s, auto reset after 4.5 s |
| After a knock | no help | slide assist turns the nose into the slide (≈1.0 s hands-off, ≈0.8 s with countersteer); **SAVED IT** for a catch |
| Wet | traction only; spray from rain > 0.2 while nothing else changed | one threshold (zone rain ≥ 0.45: Industrial, Flood, Old City) for physics and spray: longer braking, slidier, easier drift, slower settle |
| Curb (shoulder) | climb only | two wheels up: less grip, a little drag, a rumble, grit thrown up — never a stop (the road is walled in: this is the off-road of this game) |
| Boost | +accel only | a shove on the first moment (spike, squat, camera kick) — once, tapping the button does not pump it |
| Suspension | small spring; wheels static | pitch and roll springs (dive, squat, roll, rebound); front wheels counter-lock in drifts; wheels droop in the air and climb curbs |
| AI | rigid bodies, airborne flat, scripted cross traffic ignored hits | body roll / pitch springs, air pitch and roll, imperfect landings (hop, wobble, spin), lifted by big hits, cross traffic slides when hit |
| Camera | speed only | pulls back under power, leans in under braking, dips on landing, rides the arc in the air, widens on boost / crash / near miss, leans in a rollover |
| Audio sync | landings silent | landing thump on the touchdown frame; hard-brake tyre noise; roof scrape mid-roll |

## Balance check (A/B against the build before this pass, QA autopilot)

Same seeds, same scripted bot, both builds running side by side.

**Road nodes** (15 runs × 60 s): the bot drives a little cleaner and hits walls less; kills and pace are unchanged.

| Metric | Before | After |
| --- | --- | --- |
| Damage taken per run | 334 | 304 |
| — from vehicle collisions | 157 | 149 |
| — from walls | 80 | 41 |
| Kills | 3 | 3 |
| Distance | 2642 m | 2603 m |

**Boss fights** (6 runs × 45 s each): collision damage taken.

| Boss | Before | After |
| --- | --- | --- |
| Iron Mule | 19 | 28 |
| Drowned Line | 21 | 9 |
| Taxon | 33 | 46 |
| Apex | 2 | 0 |
| The Driver | 10 | 6 |
| **Sum of total damage** | **125** | **122** |

Per boss the numbers move both ways at the bot's noise level. Boss contacts use the old impulse and no longer
unsettle the car. HP, damage formulas, enemy and boss stats are untouched.

Not done (trade-offs): the procedural road has no banking or hills (flat apart from ramps), so banked turns and
off-road surfaces don't exist — curbs, oil, water and wet zones are the surfaces.

## States

`CRUISE ACCELERATE BRAKE DRIFT AIRBORNE LANDING LIGHT_IMPACT HEAVY_IMPACT ROLLOVER RECOVERY OFFROAD BOOST`
(`PlayerCar.state`). Grip, steering and damping are blended, never switched.

## Tools

- `src/dev/physicsTests.ts`: a headless bench on synthetic roads with scripted input. It checks 24 invariants
  per car, all four cars pass. Among them:
  - 0–100 and stopping distance;
  - lane-change size and latency;
  - braking keeps steering;
  - a driven drift holds a curve, never spins, exits cleanly;
  - curbs keep their speed;
  - ramps launch and land well, and the gap is cleared;
  - spin recovery;
  - a wedged car gets free;
  - reverse, 300 km/h, no turning on the spot.
- **Debug panel → PHYSICS:**
  - **LAB TRACK** — straight, tight corner, chicane, ramp, gap, S, tunnel, narrow street, intersection, hazards,
    lot, bridge;
  - **WET**, **TRUCK**, **CARS**, **ENEMY**;
  - **READOUT** — live state, speed, slip, yaw, grip, air and landing data;
  - **RUN TESTS**.

Unchanged: HP balance, enemy stats, damage numbers, progression, rewards, encounters, chase rules, boss health.
