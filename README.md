# Low-Poly Karting

A small browser karting game: arcade drift physics, time trials with checkpoints and records, a
grid track editor, and shareable circuits. Inspired by
[mrdoob/Starter-Kit-Racing](https://github.com/mrdoob/Starter-Kit-Racing).

Next.js (App Router) · React · TypeScript · Tailwind CSS + daisyUI · three.js · crashcat physics.

## Run

```sh
pnpm install
pnpm dev          # http://localhost:3000
pnpm check        # lint + typecheck + unit tests
pnpm build && pnpm start
```

## Play

| Keys | Action |
| --- | --- |
| W / ↑ | Accelerate |
| S / ↓ | Brake, then reverse |
| A D / ← → | Steer |
| Space | Handbrake / drift (hold while turning at speed) |
| R | Reset onto the track |
| Esc | Pause |

Touch screens get on-screen pedals; gamepads work too (A/RT accelerate, B/LT brake, X/RB drift).

- **Time Trial**: light countdown, 3 laps, checkpoints, lap deltas, best lap saved per circuit.
- **Free Drive**: no clock.
- **Track editor**: place straights, corners, sweepers, hairpins, the start line, cones and tire
  stacks; rotate (R), erase (right click or X), undo/redo (Ctrl+Z / Ctrl+Y), preview with scenery
  (P), then test drive. Problems (open ends, roads running into a piece, missing start…) are listed
  and marked on the grid.
- **Share**: copy a link (the circuit is encoded in the URL fragment, nothing is uploaded) or
  export/import JSON.

## Architecture

The simulation lives in `src/game` and has no React dependency. React components in
`src/components` only render menus and the HUD around a single `<canvas>`.

| Module | Role |
| --- | --- |
| `Game.ts` | Lifecycle, the single animation loop, fixed 120 Hz physics steps with render interpolation, modes and screens |
| `Vehicle.ts` | Arcade kart model (pure): forward/lateral velocity split, saturating tire grip, speed-dependent steering, stable drift |
| `Physics.ts` | crashcat world: ground, wall colliders, cones, kart sphere (translation only, heading owned by `Vehicle`) |
| `Camera.ts` | Chase, menu orbit and editor cameras |
| `track/pieces.ts` | Piece definitions: footprint, centerline (line or arc), connectors |
| `track/Track.ts` | Track data, circuit ordering and validation, race path, track queries (off-track, progress) |
| `track/TrackBuilder.ts` | Road, kerbs, instanced tire walls, start gantry and wall colliders, all from the centerlines |
| `track/editing.ts` | Pure editing operations and undo history |
| `track/TrackSerializer.ts` | Versioned JSON and compact binary URL format, strict import validation |
| `TrackEditor.ts` | Editor interaction (pointer/touch/keyboard), ghost preview, validation overlay |
| `RaceManager.ts` | Countdown, laps, checkpoints, anti-cheat rules, records |
| `Effects.ts` | Skid-mark ring buffer and pooled smoke/dust particles |
| `AudioManager.ts` | Procedural Web Audio engine, squeal, rumble, impacts and beeps |
| `InputManager.ts` | Keyboard, touch and gamepad input |
| `Scenery.ts` | Lights, sky, ground and instanced forest |

Per-frame values (speed, lap clock, minimap dot) reach the HUD through `Game.onFrame` and are
written straight to the DOM; React state only changes on events (laps, screens, editor actions).

## Assets

Kenney CC0 models; sources and licenses in [ASSETS.md](./ASSETS.md).
