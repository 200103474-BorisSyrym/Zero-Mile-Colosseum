# Assets

ZERO MILE generates almost everything at runtime:

- **3D models** (all cars, bosses, drones, props, building relief, industry, bridges, tunnels, landmarks): authored
  in code for this game — lofted car bodies, lathed wheels, modelled props and structures on one surface atlas
  (`src/assets/`, see [docs/ASSETS.md](docs/ASSETS.md) for the full register). All vehicles are original,
  fictional designs; no third-party or extracted 3D content.
- **Textures** (asphalt, facades, shop fronts, billboards, road wear, fences, road signs, neon signs, skyline,
  containers, hazard stripes, smoke): drawn on canvas at startup (`src/world/textures.ts`, `src/world/artTextures.ts`).
  Sign texts are generic words and billboard brands are invented (VOLTA, RUSTLINE, KAIJU…); no real brands or logos.
- **Audio and music**: synthesized with the Web Audio API (`src/audio/audio.ts`, `src/audio/music.ts`). No audio
  files. The soundtrack is an original procedural composition (generic minor-key chord movement over each zone's
  own scale, generated riffs); no melody, harmony or arrangement from any existing piece is used.

## Third-party files

| File | Source | License |
| --- | --- | --- |
| `src/fonts/Rajdhani-Bold.ttf`, `src/fonts/Rajdhani-SemiBold.ttf` | Rajdhani by Indian Type Foundry — github.com/google/fonts (`ofl/rajdhani`) | SIL Open Font License 1.1 |
| `src/fonts/Barlow-Regular.ttf`, `src/fonts/Barlow-SemiBold.ttf` | Barlow by Jeremy Tribby — github.com/google/fonts (`ofl/barlow`) | SIL Open Font License 1.1 |

The fonts are bundled locally; the game falls back to system fonts if they fail to load.

## Libraries

- [three.js](https://threejs.org) — MIT License (including `three/examples/jsm` post-processing passes).
- [Vite](https://vitejs.dev), [TypeScript](https://www.typescriptlang.org) — build tooling.
