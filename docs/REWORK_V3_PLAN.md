# ZERO MILE v3 — audit and plan (spectacle, clarity, flow)

## Audit of the current build (fresh save, first run, measured)

| What testers said | What the build actually does |
| --- | --- |
| "управление шакалится" | A 0.3 s tap of D at 180 km/h turns the car 12° and it **stays** at 12°: the car crosses two lanes and hits the curb ~1 s later. Steering integrates heading with nothing bringing the car back parallel to the road, so every correction needs a counter-correction. Keyboard input is on/off with a 0.08 s ramp, so taps are all-or-nothing. |
| "не понятен смысл… монетки… стрелочки как в киберпанке" | The first thing a new player gets is **TRAFFIC WAVE — get through the traffic** (no enemy). In the first 40 s the most frequent messages are money (`+12 CR`, `COMBO x1.1 · +2 CR`, `BANK LOST`) and jargon (`EXPOSED` ×4 in 2 s, `REAR-END`). Enemy markers are bare chevrons with no word, no health, no state. The one key hint ("RAM THE GOLD-MARKED LEADER") is overwritten 1.2 s later by a drift hint. |
| "subway surfers в мире гоночек" | Lane-dodging traffic first, coins lined up in lanes on every rest section, gold on risky lines: the visible loop is *dodge + collect*. |
| "скиллы… не знал что есть" | Momentum hits its 100 cap 20 s into the first road and stays there. Nothing says "Q is ready"; the ready state looks almost identical to "not ready"; the only skill hint fires after a drift, which a W-only player never does. |
| End of level | Crossing the line at 187 km/h switches straight to the REWARD state: the world freezes mid-motion and a modal pops up. |
| "drive drive drive" | **36% of a level** has no encounter, no hostile within 80 m and no traffic ahead. The **last ~10 s before the finish are empty** — the opposite of a climax. |
| Chase | Pursuers use `targetSpeed = playerSpeed + offset` — speed matching, not behaviour. No duel state, no time limit, no escape. |
| Verticality | One 2.6 m ramp per JUMP segment that drops straight back to road level at the lip: nothing to jump over, no landing zone. The road is a single height field. |
| Audio | Engine = raw saw + square through a resonant filter with a gear-saw RPM sweep, on the SFX bus louder than music: it dominates permanently. Music = one 4-bar progression on a loop. |

### Answers to the design questions (target, not current)

- **Every second the player should want to:** get to (or away from) the next thing on the road — a target, a threat, a jump, a gap — at speed.
- **Fantasy:** you tear through a hostile night city at 200 km/h, hunting targets and escaping hunters while the road falls apart around you.
- **Skill expression:** line choice, braking/drifting into corners, timing rams, timing skills, reading telegraphs, landing jumps.
- **Why fast:** chases are won and lost on speed; slow players get caught, miss jumps and lose duels; rewards are on the risky line.
- **Why attack:** objectives are targets (DESTROY / PROTECT / ESCAPE); hunters keep coming until you deal with them.
- **Why risk:** the risky line is shorter, richer and is where the targets are; combo bank pays out only if you survive.
- **What makes it not Subway Surfers / a highway dodger / an arcade racer / a survivors-like:** objectives are *other cars* you fight with the car itself; enemies have behaviour and you duel them; bosses are driving problems; the build changes how you drive. Coins are change in your pocket, not the point.

## Classification

| Problem | Kind | Fix |
| --- | --- | --- |
| Steering | tuning + small mechanic | heading assist when not steering, progressive keyboard steering, re-validated against the brake/drift hierarchy |
| Unclear goal | systemic (language) | first road taught by play (TARGET → SKILL → DUEL); labelled target markers with health; plain-word objectives; fewer, clearer messages; coins demoted |
| Skills unseen | systemic (UI + design) | big ability dock with charge rings and READY state, first-ready callout, contextual "PRESS Q" prompts in situations that need it, louder impact |
| End of level | new mechanic | FINAL PUSH → ARRIVAL cinematic (variant by speed/HP) → RESULT beat → reward |
| Downtime / no climax | systemic (pacing) | micro-event director with cadence (calm → tension → event), denser last 20%, finale before the gate |
| Chase | new mechanic | adaptive pursuit with visible behaviour (boost bursts, re-entry ahead), DUEL state with timer, per-kind chase styles |
| Verticality | new mechanic + architecture | gap jumps, drops, crests, train crossing with ramp, overpasses, lifted high road on split sections; readable ramps with landing markers |
| Jump/crash physics | new mechanic | arcade orientation layer: launch pitch, ballistic attitude, limited air control, landing grades, rollover + auto-recovery |
| Audio | rework | layered engine pushed into the background, surface/tyre audio, adaptive procedural rock soundtrack with sections |

## What I'm changing from the brief

- **No full multi-level road network.** Parallel roads at different heights would mean replacing the single-spline road model that the encounter generator, AI, collision and props all depend on. Instead: per-side lift on split sections (a real high road / low road with a wall between), gap jumps, drops, crests and overpasses — the same decisions without a rewrite.
- **No rigid-body physics.** An arcade attitude layer (pitch/roll + angular velocity, landing grades, rollover with auto-recovery) on top of the existing planar model — spectacle and predictability, not BeamNG.
- **Rubber-banding as behaviour, never as speed matching.** Pursuers close distance with visible boost bursts and drop back when they overheat; a runaway enemy re-enters ahead via a side road rather than magically matching your speed.
- **The soundtrack is original.** "Free Bird" and the F1 theme are references for energy and function only: no melody, harmony or arrangement is copied.
- **Zone identity through chaos events.** Each zone gets its own event mix (containers falling in Industrial, water surges in Flood, pile-ups and cross traffic in Old City, collapsing spans in Skyway, glitched road in Zero Mile) rather than new enemy classes.

## Not implementing

- Events every couple of seconds or random explosions with no decision attached.
- Motion-sickness camera effects (strong roll, heavy shake at speed).
- New currencies or new item systems — the problem is focus, not quantity.

## Plan and order

- **P0** — steering · objective language and target markers · onboarding road · skill dock and prompts · end-of-level sequence.
- **P1** — adaptive chase + DUEL · micro-event director with cadence and finale · vertical features.
- **P2** — jump attitude, landings, rollover and recovery · crash spectacle · speed camera.
- **P3** — engine layering and mix priority · surface and tyre audio · adaptive soundtrack.
- **P4** — VFX and UI polish, transitions.

After every stage: type-check, build, play in the browser (inputs as a player would), check the console, fix regressions.

## Status after P0–P3

**Done**

- **P0** — steering assist and progressive keyboard steering; worded target tags with health; message diet;
  coins demoted; first road teaches by play (DESTROY → skills at a blockade → pursuit, with a broken bridge
  before the chase); skill docks with READY / PRESS Q; final push → arrival gate → result card → reward.
- **P1 chase** — enemy speed budget: own top speed plus a boost tank (+18 %, visible flames, drains in ~4.5 s);
  out-run chasers re-route and cut in ahead later (never a visible teleport); **DUEL** state (2 s in the combat
  window, 26 s / 36 s elite, faster attacks, HUD panel, DUEL tag, music to chase, outcomes WON / SHOOK IT OFF /
  IT GOT AWAY), interceptors excluded (two-hit skirmishes are not duels).
- **P1 chaos** — DEBRIS / ONCOMING truck / PILEUP with per-zone weights, cadence calm (9–15 s) → event → recovery
  (5–8 s), layered onto chase-type encounters (not set-pieces), faster cadence in the final stretch and one
  guaranteed big event before the gate. Every event is telegraphed with the same language as enemy attacks.
- **P1 verticality** — GAP_JUMP (broken bridge): run-up with boost, 4.2 m ramp, a real hole (15 m first road,
  20–26 m later, wider on Skyway), canal and broken ends, landing markers, gold on the fast line, speed on the
  sign; AI cars jump it or fall in (a hostile that falls is your kill); a fall recovers you past the hole.
- **P2** — nose follows the arc in the air, air roll from steering, PERFECT landing grade with a boost, big
  crashes barrel-roll the car once in slow motion and it lands on its wheels.
- **P3** — mix buses with the requested priority and ducking, engine rebuilt as a quiet layered bed, exhaust
  pops, tyre rumble, wet hiss, tunnel echo, bridge joints, nearest-enemy engine panned and louder on boost,
  original adaptive soundtrack (menu / cruise / drive / chase / boss / final / result) with phrase variation.

**Cut or deferred** (each would need the road model to carry two heights or a second track)

- High road / low road on split sections, drops, crests, overpasses and the train crossing.
- Zone-only events (water surges, glitched road); zones differ by event mix instead.
- Mid-air flips; the roll is the crash spectacle.
