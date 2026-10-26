# Low-Poly Karting

A small browser karting game: arcade drift physics, time trials with sector splits, a live delta
and a best-lap ghost, a grid track editor with elevation and bridges, a verified leaderboard and a
community track library. Inspired by
[mrdoob/Starter-Kit-Racing](https://github.com/mrdoob/Starter-Kit-Racing).

Next.js (App Router) · React · TypeScript · Tailwind CSS + daisyUI · three.js · crashcat physics.

## Run

```sh
pnpm install
pnpm dev          # http://localhost:3000
pnpm check        # lint + typecheck + unit tests
pnpm build && pnpm start
```

Requires Node.js ≥ 22.13 (the server uses the built-in `node:sqlite`; no database to install).

### Server and data

The leaderboard and the track library run in the same Next.js server (`src/app/api/[...path]`,
logic in `src/server/`). Data is one SQLite file, created on first use:

- `KARTING_DB` sets its path (default `data/karting.sqlite`, git-ignored). Back it up by copying the
  file while the server is stopped.
- It needs a persistent disk: a long-running Node server (VPS, container with a volume, `pnpm start`
  behind a reverse proxy). Serverless hosts with an ephemeral filesystem would lose the data.
- Rate limits are kept in memory per process and keyed on the client address; behind a proxy, make
  sure it sets `X-Forwarded-For`. Run a single server process (or move the limits and the database
  to shared services before scaling out).
- Stored: an anonymous player id, the hash of its secret token, the nickname, published circuits,
  verified records. No IP address, e-mail or account.

## Play

| Keys      | Action                                          |
| --------- | ----------------------------------------------- |
| W / ↑     | Accelerate                                      |
| S / ↓     | Brake, then reverse                             |
| A D / ← → | Steer                                           |
| Space     | Handbrake / drift (hold while turning at speed) |
| R         | Reset onto the track                            |
| C         | Change camera (elevated, chase, first person)   |
| G         | Show / hide the best-lap ghost                  |
| Esc       | Pause / menu                                    |

All keys except Esc can be remapped in **Menu → Settings**. Touch screens get on-screen pedals;
gamepads work too (A/RT accelerate, B/LT brake, X/RB drift).

The game opens straight onto the track. There is no menu: drive an **endless time trial**. The
clock starts when you first cross the line, then every lap is timed (checkpoints prevent
shortcuts; best lap saved per circuit). An incomplete circuit is driven freely without timing.

- **Sectors**: each lap is split into three sectors of equal length along the route. The lap card
  shows every split with its delta to your best, F1 colours: purple = personal best, green =
  faster than your best this session (but not the record), yellow = slower, white = first run.
  The finished lap's splits stay up for a few seconds after the line.
- **Ghost**: your fastest lap on a circuit is recorded and replayed as a translucent kart, in sync
  with your lap clock (no collisions). It is saved per circuit and replaced only by a faster lap.
  Toggle it with G, the ghost button or Settings.
- **Live delta**: next to the lap number, the gap to your best lap at the same point of the route
  (negative and green: ahead; positive and red: behind), updated continuously. It compares
  positions along the circuit with the best lap's, not elapsed time with its total.
- Records, sector bests and ghosts are keyed by the circuit's layout: any change in the editor
  (piece, rotation, level) starts fresh records; an unchanged layout keeps them.

**HUD**: settings and tools top left (menu, editor, camera, ghost, sound, settings, leaderboard,
track library, reset), the timer top right (lap, time, live delta, best lap, S1–S3 bars), the map
bottom right (your heading as an arrow, the ghost as a ring, raised road drawn over the road it
crosses), speed at the bottom. Sound starts on the first key press or tap.

**Leaderboard** (trophy button): verified best laps per circuit. Pick a nickname (a display label,
up to 16 characters); when you beat your best on a circuit that is in the library, the lap is sent
for verification. The game sends the inputs of the session (every physics step), not a time: the
server replays them through the same deterministic simulation (`src/game/sim`) on the published
layout and records the time it computes, so edited timers or invented times are rejected. This
is strong but not cheat-proof: a crafted input sequence (a tool-assisted lap) replays as valid.
Sessions longer than 10 minutes cannot be verified (restart the lap).

**Track library** (book button): official and community circuits, sorted by popularity, date,
likes or name, or just yours. Preview, play, like, copy a link (`#lib=<id>`), report. Publish the
circuit you are driving (it must be a valid closed circuit); published versions never change, and
publishing your edits creates a new version with its own leaderboard. Earlier versions stay
playable.

**Settings** (Menu → Settings, saved in the browser): field of view for the chase and
first-person cameras (60–110°, applied live), master volume, ghost on/off, and key remapping (two
keys per action; a key already in use moves to the new action, with a notice). Restore defaults
resets them all.

**Graphics**: Auto (default) starts on High and switches once to Performance if the frame rate
stays low; Performance caps the pixel ratio at 1.25 and uses a 1024 shadow map refreshed every
other frame. Add `?perf` to the URL (or press F3) for an FPS / frame-time / draw-call overlay.

- **Track editor**: place straights, corners, sweepers, hairpins, chicanes, ramps, the start
  line, cones and tire stacks; rotate (R), flip (F), erase (right click or X), pick up a piece
  under the pointer (I), undo/redo (Ctrl+Z / Ctrl+Y), preview with scenery (P), then drive.
  Trackside decoration (stands, pits, billboards, chevrons…) follows the layout.
- **Multi-level circuits**: roads can cross over each other. A cell holds several pieces as long as
  a full level separates them; the raised one becomes a bridge (thin deck, open underneath, no
  retaining wall in the way). The kart, the camera, sectors, the ghost and lap detection all
  follow the level the kart is on. The editor works on a level (the grid is drawn at that height
  and clicks pick the piece on it).
- **Elevation**: pieces sit on levels 0–4 (2 m each). Ramps climb one level (the long ramp over
  two cells, more gently); turn a ramp around to go down. New pieces join raised road at its level
  automatically; − / + set the level for pieces placed elsewhere, and the height tool (H) raises a
  piece (right click lowers it). Raised road stands on retaining walls; tags on the grid show each
  piece's level (ramps read in the race direction, "2→1" is a descent). The kart follows the same
  height profile the road is built from, and takes off over a crest taken fast.
- **Validation**: open ends, overlaps, roads running into a piece, height steps between connected
  pieces, a missing start… are listed and marked on the grid. The circuit can also be mirrored,
  and an "Unsaved changes" badge offers to revert to the circuit you were driving.
- **Share**: copy a link (the circuit is encoded in the URL fragment, nothing is uploaded) or
  export/import JSON. Format version 2 adds levels and flips; flat circuits are still written in
  version 1, and version 1 links and files keep loading.

## Architecture

The simulation lives in `src/game` and has no React dependency. React components in
`src/components` only render the HUD, menu and editor overlays around a single `<canvas>`.

| Module                          | Role                                                                                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `Game.ts`                       | Lifecycle, the single animation loop, fixed 60 Hz physics steps with render interpolation, screens, graphics quality                         |
| `Vehicle.ts`                    | Arcade kart model (pure): forward/lateral velocity split, saturating tire grip, speed-dependent steering, stable drift                       |
| `Physics.ts`                    | crashcat world: ground, wall colliders, cones, kart sphere (translation only, heading owned by `Vehicle`)                                    |
| `sim/Simulation.ts`             | The deterministic driving simulation (kart, physics, ground following, race progress), shared by the game and the server                     |
| `sim/trace.ts`, `sim/replay.ts` | Quantized input traces (run-length encoded) and their replay, for lap verification                                                           |
| `online.ts`                     | Browser side of the API: anonymous player token, leaderboard, track library                                                                  |
| `../server/`                    | API (`api.ts`) and SQLite storage (`db.ts`) for the leaderboard and the library                                                              |
| `Camera.ts`                     | Follow-mode registry (elevated, chase, first person) plus orbit and editor views                                                             |
| `KartView.ts`                   | Kart chassis animation and the procedural driver                                                                                             |
| `track/pieces.ts`               | Piece definitions: footprint, centerline (lines and arcs), connectors, rise (ramps)                                                          |
| `track/Track.ts`                | Track data, circuit ordering and validation (incl. height steps), race path with heights, track queries (off-track, progress, ground height) |
| `track/TrackBuilder.ts`         | Road, kerbs, instanced tire walls, retaining walls, start gantry and (sloped) wall colliders, all from the centerlines                       |
| `track/editing.ts`              | Pure editing operations (place, level, mirror, auto level) and undo history                                                                  |
| `track/TrackSerializer.ts`      | Versioned JSON and compact binary URL format, strict import validation                                                                       |
| `TrackEditor.ts`                | Editor interaction (pointer/touch/keyboard), ghost preview, validation overlay                                                               |
| `RaceManager.ts`                | Endless lap timing: out lap, checkpoints, anti-cheat rules, three sectors, records                                                           |
| `Ghost.ts` / `GhostView.ts`     | Best-lap recording on a fixed time grid, synced playback, storage format / translucent ghost kart                                            |
| `Effects.ts`                    | Skid-mark ring buffer and pooled smoke/dust particles                                                                                        |
| `audio/engineDsp.ts`            | Two-stroke kart engine DSP (AudioWorklet) and the gearless clutch rpm model                                                                  |
| `AudioManager.ts`               | Web Audio graph: engine, squeal, braking scrub, wind, rumble, impacts, chimes                                                                |
| `InputManager.ts`               | Keyboard (remappable bindings, key capture), touch and gamepad input                                                                         |
| `Scenery.ts`                    | Sun and sky light, sky with clouds, rolling terrain, instanced forest and bushes                                                             |
| `Trackside.ts`                  | Grandstands, pits, billboards, fences, light posts, chevrons and flags from the layout                                                       |

Per-frame values (speed, lap clock, minimap dot) reach the HUD through `Game.onFrame` and are
written straight to the DOM; React state only changes on events (laps, screens, editor actions).

## Assets

Kenney CC0 models; sources and licenses in [ASSETS.md](./ASSETS.md).
