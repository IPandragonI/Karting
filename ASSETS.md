# Third-party assets

All 3D models are stored locally in `public/models/` (no hotlinking). They are used unmodified;
the game only re-centres props and scales models at load time (`src/game/assets.ts`).

| File(s) | Source | Author | License |
| --- | --- | --- | --- |
| `kart-oobi.glb` (kart chassis; its character is hidden in game) | [Car Kit 3.1](https://kenney.nl/assets/car-kit) | Kenney | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `cone.glb` | [Car Kit 3.1](https://kenney.nl/assets/car-kit) | Kenney | CC0 1.0 |
| `Textures/colormap.png` (shared palette texture of the Car Kit models) | [Car Kit 3.1](https://kenney.nl/assets/car-kit) | Kenney | CC0 1.0 |
| `treeLarge.glb`, `treeSmall.glb`, `tentClosed.glb`, `grandStand.glb`, `grandStandCovered.glb`, `flagCheckers.glb`, `flagGreen.glb`, `flagRed.glb`, `billboard.glb`, `billboardLow.glb`, `fenceStraight.glb`, `lightPostLarge.glb`, `bannerTowerGreen.glb`, `bannerTowerRed.glb`, `pitsGarage.glb`, `pitsGarageClosed.glb`, `pitsOffice.glb` | [Racing Kit](https://kenney.nl/assets/racing-kit) | Kenney | CC0 1.0 |

The license file shipped with both packs reads: *"License: (Creative Commons Zero, CC0) … You can
use this content for personal, educational, and commercial purposes. Support by crediting
'Kenney' or 'www.kenney.nl' (this is not a requirement)."* Thank you, Kenney!

## Made for this project (no third-party source)

- Track surfaces, verges, kerbs, tire walls, start gantry and lights: generated in code from
  the track centerlines (`src/game/track/TrackBuilder.ts`).
- The kart driver (suit, arms, helmet with visor) in the livery colour (`src/game/KartView.ts`).
- Chevron corner boards (canvas texture), bushes, clouds, rolling terrain, sky with sun glow, skid
  marks, smoke and dust particles: generated in code.
- All sounds: synthesized at runtime with the Web Audio API. The engine is a procedural
  single-cylinder two-stroke kart engine running in an AudioWorklet
  (`src/game/audio/engineDsp.ts`); tire squeal, braking scrub, wind, grass rumble, impacts and lap
  chimes are in `src/game/AudioManager.ts`. No audio files are shipped.
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
- Engine recordings: no go-kart engine loop with a clear CC0 license and a direct download was
  found. The closest, [racing car engine sound loops](https://opengameart.org/content/racing-car-engine-sound-loops)
  (OpenGameArt, CC0), are car engines and their comment thread questions the source sample, so
  the engine is synthesized instead.
- The other Car Kit karts (`kart-oodi`, `kart-ooli`, `kart-oopi`, `kart-oozi`) share the same
  chassis and only differ by the character, which the game replaces, so they are no longer shipped.
