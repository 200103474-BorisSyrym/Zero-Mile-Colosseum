# How ZERO MILE plays

The full player-facing rules. The short version is in the [README](../README.md).

## Controls

| Key | Action |
| --- | --- |
| W / ↑ | Accelerate |
| S / ↓ | Brake (trail-brake into corners) / reverse |
| A / D | Steer |
| SPACE | Handbrake — hold while turning to **drift** |
| SHIFT | Nitro |
| Q | Chassis special ability |
| E | Module ability |
| TAB | Build, parts & synergies |
| ESC | Pause |
| R | Reset car (only when stuck for 3+ seconds) |
| F1 or \` | Debug overlay — dev builds, or a published build opened with `?debug` |
| 1 / 2 / 3 | Pick a reward card / event option / map node |

Mouse: click the ability panels in the HUD corners. Gamepad (standard mapping): RT accelerate, LT brake,
left stick steer, A/RB drift, B/LB nitro, X/Y abilities, Start pause, Back build.

## How to play — driving is the combat system

- **There is no auto-fire.** You hurt things by how you drive: rams, lures, near misses, drifts, traps.
- **Ram** — *how* you hit matters: side hits (T-bones) are strongest, every enemy has a **weak side**
  (interceptors and blockers: flanks; gunners and rammers: rear), and a car that just spun out is **EXPOSED** (white marker) and takes double.
  Hard, square hits are **Perfect Rams**. Head-on hits hurt you too.
- **Lure** — enemies that crash into walls, barriers, barrels or each other while chasing you count as your kills.
- **Corners** — tyres have a grip budget. Too fast into a sharp turn and the car **understeers** wide.
  Brake (or trail-brake) into the corner, or **drift** through it: a drift holds more speed and charges **CHARGE**.
  Keep the slide angle in the pink window for a **Perfect Drift**; a clean exit gives a boost.
- **Speed** has a soft cap: past it, extra speed comes slowly and costs control. Nitro builds heat.
- **Walls** cost speed and your combo — a light scrape keeps most of it, a heavy crash wipes it.
- **Near misses** come in three tiers: NEAR MISS, CLOSE CALL and PERFECT. The closer, the bigger the reward.
- **Combo bank** — every stunt adds credits to a bank. The bank pays out when your chain ends on its own;
  a crash or a heavy hit **loses the whole bank**. Greed is a choice.
- **Encounters** are announced by an overhead gantry sign and a top-of-screen objective:
  Roadblock, Convoy, Ambush, Pursuit, Hazard Run, Traffic Wave, Escape, Race, Escort, Bounty, Gauntlet.
  Each has a primary objective and an optional bonus. Between encounters there are short breathers with pickups.
- **Tags** over cars say what they are to you: **DESTROY** (the objective), **ENEMY**, **ELITE**, **PROTECT**,
  **RIVAL** — with a health bar. **HIT IT!** means it is exposed right now.
- **Skills** — **Q** (your chassis special) and **E** (your module) sit beside the speedometer. A full ring and
  READY mean it's charged; **PRESS Q** appears when using it would help. They charge from momentum.
- **Duels** — an enemy that holds on to you becomes your **DUEL**: it is named on screen with its health and a
  timer, it fights harder, the music goes to the chase. Wreck it (DUEL WON), outrun it (SHOOK IT OFF), or it
  breaks off when the timer runs out. Enemies chase on their own speed plus a boost they can't hold forever; a
  chaser you leave far behind takes a side street and may **cut back in ahead**.
- **Chaos** — the road attacks too, always announced: **debris** drops onto a lane (the lane flashes, a shadow
  grows), a **wrong-way truck** comes down a lane (red lane, horn), a **pile-up** leaves one lane open (lit green).
  It crushes the cars chasing you as well.
- **Broken bridges** — *BRIDGE OUT* means a real hole in the road. Hit the ramp at the speed on the sign,
  straight; gold hangs on the line of a fast jump. Too slow and you drop into the canal and lose some hull.
- **Landings and crashes** — land straight for a **PERFECT LANDING** (speed boost). A big crash rolls the car;
  it lands back on its wheels and you drive on.
- **The gate** — the last stretch of every road is a **FINAL STRETCH** with pursuers at your back. Arrive clean
  and the barrier lifts; arrive flat out and you smash through it.
- **Road language** — lane paint tells you what a line is: **gold** = reward line, **cyan** = shortcut,
  **yellow** = hazard, **red** = danger. Split roads give you a safe line and a risky one.
- After each road choose **1 of 3 parts**. Every part reads *WHEN YOU DO X → Y*. Parts belong to archetypes:

| Archetype | Verb | Resource |
| --- | --- | --- |
| RAM | hit things | **MASS** — stacks from hits, makes you heavier and harder-hitting, decays when you stop |
| DRIFT | slide | **CHARGE** — fills while drifting, released on the exit |
| SPEED | pass, draft, stay fast | **VELOCITY** — fills at pace, near misses and in slipstream |
| FIRE | lay traps | oil and flame on the road behind you |
| ELECTRIC | chain | **STATIC** — from close passes, discharged as chain lightning |
| GHOST | pass through | **PHASE** — phase through traffic, cars you pass through count |

  Three or five parts of an archetype unlock **synergies** that change the rules (TAB shows progress).

## Bosses

Every boss has **Stability**. Only solving its mechanic lowers it. At zero it **BREAKS** (a slice of its HP goes)
and is **VULNERABLE** for a few seconds — that is when rams really hurt. Three phases each.

- **Iron Mule** — it charges down the lane you are in. Sit in a lane with an orange **anvil** ahead, dodge late,
  and let it hit the steel. Heavy side rams can shove it into the wall.
- **Drowned Line** — pylons electrify flooded lanes. The bus avoids charged water unless you take its
  escape lane away — run alongside it, block, shoulder it over.
- **Taxon** — it paints the lane it predicts you will be in and strikes it. Hold the lane, then switch at the last
  moment. Switch too early and it re-predicts; later phases learn which way you dodge.
- **Apex** — a real race through sector gates. Win sectors. When you lead, Apex overcommits in corners and
  dives up the inside — block the dive or let it crash.
- **The Driver** — calls challenges shaped by your build (drift, near misses, side-ram it, hold top speed,
  survive a storm). Answer them to break it.

## Content

- 4 playable chassis — Courier, Rammer, Ghost, Hauler — each with its own identity and special.
- Authored models for every vehicle (4 player cars, 13 traffic vehicles, 7 enemy classes and elites, 5 bosses) with
  real wheels, lights, damage states and suspension travel, and a world kit of 48 props, building relief, industrial
  plant, bridges and tunnels — all original, built in code (see [docs/ASSETS.md](ASSETS.md)).
- Arcade driving physics tuned for feel: instant steering, a drift you hold by angle, jumps with air control and
  landing grades, rams that launch what you hit, and a car that never gets stuck (see [docs/PHYSICS_PASS.md](PHYSICS_PASS.md)).
- Effects built from light, not shapes: lamps on every car and street, fake-volumetric beams, staged explosions and
  boss deaths, ten smoke profiles, directional sparks and debris by surface (see [docs/VFX_PASS.md](VFX_PASS.md)).
- 5 regions — Industrial Ring, Flood District, Old City, Skyway, Zero Mile — each with its own architecture,
  roadside life, fog and light, and three giant landmarks (cooling towers and a flare stack; a dam and a lighthouse;
  a mega tower and a TV tower; an arcology and a suspension bridge; the Zero ring and an inverted tower).
- 11 encounter types, 5 boss fights, 8 enemy types with tasks, telegraphs and weak sides.
- 35 parts across 6 archetypes (plus utility parts), 12 synergies, 10 abilities.
- 15 random events with meaningful choices.
- Garage with vehicles, paints, permanent unlocks (part packs, modules, events, perks), archive & achievements.
- 3 difficulty levels unlocked by winning; map nodes show a 1–5 star difficulty rating.
- Procedural Web Audio: a mix with priorities (music, cues, crashes, tyres, enemies, environment, then your
  engine as a bed), layered engine with exhaust pops, tyre rumble, wet roads, tunnel echo, bridge joints, the
  engine of the nearest enemy panned to where it is, and an original adaptive rock/electronic soundtrack per
  region with sections for cruising, driving, chases, bosses, the final stretch and the result.
