# Third-party assets

All 3D models are stored locally in `public/models/` (no hotlinking). They are used unmodified;
the game only re-centres props and scales models at load time (`src/game/assets.ts`).

| File(s) | Source | Author | License |
| --- | --- | --- | --- |
| `kart-oobi.glb`, `kart-oodi.glb`, `kart-ooli.glb`, `kart-oopi.glb`, `kart-oozi.glb` (karts with drivers) | [Car Kit 3.1](https://kenney.nl/assets/car-kit) | Kenney | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `cone.glb` | [Car Kit 3.1](https://kenney.nl/assets/car-kit) | Kenney | CC0 1.0 |
| `Textures/colormap.png` (shared palette texture of the Car Kit models) | [Car Kit 3.1](https://kenney.nl/assets/car-kit) | Kenney | CC0 1.0 |
| `treeLarge.glb`, `treeSmall.glb`, `tentClosed.glb`, `grandStand.glb`, `flagCheckers.glb` | [Racing Kit](https://kenney.nl/assets/racing-kit) | Kenney | CC0 1.0 |

The license file shipped with both packs reads: *"License: (Creative Commons Zero, CC0) … You can
use this content for personal, educational, and commercial purposes. Support by crediting
'Kenney' or 'www.kenney.nl' (this is not a requirement)."* Thank you, Kenney!

## Made for this project (no third-party source)

- Track surfaces, kerbs, tire walls, start gantry and countdown lights: generated in code from
  the track centerlines (`src/game/track/TrackBuilder.ts`).
- Sky, ground, skid marks, smoke and dust particles: generated in code.
- All sounds (engine, tire squeal, grass rumble, impacts, beeps): synthesized at runtime with the
  Web Audio API (`src/game/AudioManager.ts`). No audio files are shipped.
- Favicon (`src/app/icon.svg`).

## Evaluated but not used

- [Go Kart Track and Pit Lane](https://3dassets.dev/packs/go-kart-track-and-pit-lane) (3dassets.dev):
  the pack page states CC0, but at the time of evaluation it listed no download route (GLB marked
  as not available), so nothing was downloaded.
- [Starter Kit Racing](https://github.com/mrdoob/Starter-Kit-Racing) (MIT code, CC0 Kenney assets):
  used as the gameplay and architecture reference (crashcat physics, sphere collider, grid track
  codec). Its truck models and 1-cell track tiles were not used: karts come from the Car Kit and
  the track is procedural, so hairpins and sweepers line up exactly with their colliders.
- Sketchfab: not needed once the Kenney packs covered karts, cones and scenery; licenses there
  vary per model, so avoiding it kept the licensing uniform (CC0 only).
