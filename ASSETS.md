# Third-party assets

All 3D models are stored locally in `public/models/` (no hotlinking). They are used unmodified;
the game only re-centres props and scales models at load time (`src/game/assets.ts`).

| File(s)                                                                                                                                                                                                                                                                                                                                     | Source                                            | Author | License                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------ | ------------------------------------------------------------- |
| `race.glb`, `kart-oobi.glb`, `sedan-sports.glb`, `truck.glb` (the garage's vehicles and their ghosts: single-seater, go-kart, sports car, pickup truck; red bodywork is repainted per livery at runtime)                                                                                                                                    | [Car Kit 3.1](https://kenney.nl/assets/car-kit)   | Kenney | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `cone.glb`                                                                                                                                                                                                                                                                                                                                  | [Car Kit 3.1](https://kenney.nl/assets/car-kit)   | Kenney | CC0 1.0                                                       |
| `Textures/colormap.png` (shared palette texture of the Car Kit models)                                                                                                                                                                                                                                                                      | [Car Kit 3.1](https://kenney.nl/assets/car-kit)   | Kenney | CC0 1.0                                                       |
| `treeLarge.glb`, `treeSmall.glb`, `tentClosed.glb`, `grandStand.glb`, `grandStandCovered.glb`, `flagCheckers.glb`, `flagGreen.glb`, `flagRed.glb`, `billboard.glb`, `billboardLow.glb`, `fenceStraight.glb`, `lightPostLarge.glb`, `bannerTowerGreen.glb`, `bannerTowerRed.glb`, `pitsGarage.glb`, `pitsGarageClosed.glb`, `pitsOffice.glb` | [Racing Kit](https://kenney.nl/assets/racing-kit) | Kenney | CC0 1.0                                                       |

The license file shipped with both packs reads: _"License: (Creative Commons Zero, CC0) … You can
use this content for personal, educational, and commercial purposes. Support by crediting
'Kenney' or 'www.kenney.nl' (this is not a requirement)."_ Thank you, Kenney!

## Made for this project (no third-party source)

- Track surfaces, verges, kerbs, tire walls, start gantry and lights: generated in code from
  the track centerlines (`src/game/track/TrackBuilder.ts`).
- The kart driver (suit, arms, helmet with visor) in the livery colour (`src/game/KartView.ts`).
- Chevron corner boards (canvas texture), bushes, pines, rocks, flower tufts, birds, clouds, sun
  disc, rolling terrain, sky with sun glow, skid marks, smoke and dust particles: generated in code.
  Wind sway and wing flaps are vertex-shader animations (`src/game/Scenery.ts`).
- The garage turntable (`src/game/GaragePreview.ts`).
- All sounds: synthesized at runtime with the Web Audio API. The engines are procedural
  multi-cylinder four-strokes (F1 V10, kart twin, V8, diesel) running in an AudioWorklet, revved by
  a sequential gearbox model with ignition-cut upshifts, blipped downshifts and overrun crackles
  (`src/game/audio/engineDsp.ts`); tire squeal, braking scrub, wind, grass rumble, gear clunks,
  impacts and lap chimes are in `src/game/AudioManager.ts`. No audio files are shipped.
- Logo and favicons (`public/logo.png`, `src/app/favicon.ico`, `icon.png`, `apple-icon.png`): made
  from the project's own `new_logo.png`.

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
- Car Kit karts: `kart-oobi` was the first vehicle, replaced by the `race` single-seater (it reads
  better from every camera and is lighter: 1 952 vs 2 884 triangles). It is back as one of the
  garage's vehicles; its variants (`kart-oodi`, `-ooli`, `-oopi`, `-oozi`) are not shipped.
- Car Kit `race-future` (closed sci-fi cockpit, less karting) and the Racing Kit `raceCar*`
  models (their nodes carry baked, odd transforms; separate materials instead of the shared
  palette): evaluated for the vehicle change, not used.
