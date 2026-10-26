import { GRAVITY, KART_RADIUS, Physics, type WallSegment } from "../Physics";
import { RaceManager, type RaceEvent } from "../RaceManager";
import { CELL, LEVEL_HEIGHT, ROAD_HALF, TIRE_RADIUS, WALL_OFFSET } from "../track/pieces";
import {
  analyzeTrack,
  buildRacePath,
  canonicalTrack,
  groundHeight,
  isRaceable,
  pieceLevel,
  queryTrack,
  startGrid,
  toWorld,
  trackBounds,
  type RacePath,
  type TrackData,
  type TrackLayout,
  type TrackQuery,
} from "../track/Track";
import { trackWalls } from "../track/walls";
import {
  afterCollision,
  ASPHALT,
  createKartState,
  GRASS,
  stepKart,
  type KartInput,
  type KartState,
} from "../Vehicle";

export { canonicalTrack };

// The driving simulation: kart model, physics world, ground following on raised road, race
// progress (checkpoints, sectors, laps). Pure TypeScript, no rendering, no clock, no randomness:
// the same circuit and the same per-step inputs always give the same laps, to the last bit. The
// game runs it at a fixed 60 Hz in the browser; the leaderboard server replays a submitted input
// trace through it to compute lap times itself instead of trusting the client's timer.

export const STEP = 1 / 60;
/** Walls per static compound body (measured best for crashcat's broadphase, see Physics.ts). */
const WALLS_PER_BODY = 16;
/** Share of gravity acting along slopes (slower climbs, faster descents). */
const SLOPE_PULL = 0.35;

/** One step of input: the kart controls plus the reset button. */
export type SimInput = KartInput & { reset: boolean };

export type Vec3 = { x: number; y: number; z: number };

export type StepResult = {
  events: RaceEvent[];
  /** Surface under the kart at the start of the step. */
  query: TrackQuery;
  offTrack: boolean;
  /** Collision strength (m/s of velocity taken by a wall), for sound and camera shake. */
  impact: number;
  coneHit: boolean;
  /** Vertical speed at touchdown after a jump (≤ 0), 0 otherwise. */
  landing: number;
  /** The kart was put back on the track this step (reset button or fell off the world). */
  reset: boolean;
  /** Lap clock during this step, before a line crossing restarted it. */
  lapTime: number;
};

export class Simulation {
  readonly track: TrackData;
  readonly layout: TrackLayout;
  readonly path: RacePath;
  readonly physics: Physics;
  readonly race: RaceManager;
  readonly raceable: boolean;
  /** Cone bodies in prop order (index into track.props), for rendering. */
  readonly cones: { prop: number; body: Physics["cones"][number] }[] = [];
  /** Start/finish line: centre, level and forward direction. */
  readonly line = { x: 0, y: 0, z: 0, fx: 0, fz: 1 };
  /** Route distance of the start line. */
  readonly lineDistance: number;

  kart: KartState = createKartState();
  readonly prevPos: Vec3 = { x: 0, y: 0, z: 0 };
  readonly currPos: Vec3 = { x: 0, y: 0, z: 0 };
  prevYaw = 0;
  currYaw = 0;
  readonly prevVel = { x: 0, z: 0 };
  readonly currVel = { x: 0, z: 0 };
  /** Lap progress along the route from the line (m), null until known. */
  progress: number | null = null;
  lastQuery: TrackQuery | null = null;
  /** Last surface query on the road (where a reset puts the kart back). */
  onTrackQuery: TrackQuery | null = null;
  /** Physics steps run since start(). */
  steps = 0;

  /**
   * `track` must be canonical (see canonicalTrack) for replays to match; the game passes its own
   * layout and path to avoid analysing the circuit twice, and its RaceManager (with records).
   */
  constructor(
    track: TrackData,
    opts: { layout?: TrackLayout; path?: RacePath; race?: RaceManager; walls?: WallSegment[] } = {},
  ) {
    this.track = track;
    this.layout = opts.layout ?? analyzeTrack(track);
    this.path = opts.path ?? buildRacePath(track, this.layout);
    this.raceable = isRaceable(this.layout);

    const start = track.pieces[this.layout.startIndex];
    if (start) {
      const c = toWorld(start, { x: 0, z: 0 });
      this.line.x = c.x;
      this.line.y = pieceLevel(start) * LEVEL_HEIGHT;
      this.line.z = c.z;
      this.line.fx = Math.sin((start.rot * Math.PI) / 2);
      this.line.fz = Math.cos((start.rot * Math.PI) / 2);
    }
    this.lineDistance = queryTrack(
      this.layout,
      this.path,
      this.line.x,
      this.line.z,
      this.line.y,
    ).distance;
    this.race =
      opts.race ?? new RaceManager(this.layout.order.length || 1, null, this.path.totalLength);

    const grid = startGrid(track, this.layout);
    const physics = new Physics(grid);
    const walls = (opts.walls ?? trackWalls(track, this.layout)).map((seg) => ({
      seg,
      halfThickness: TIRE_RADIUS,
      height: seg.height ?? 1.4,
    }));
    // Outer boundary so nobody drives off into the void.
    const b = trackBounds(track);
    const m = CELL * 3;
    const [x0, x1, z0, z1] = [b.minX - m, b.maxX + m, b.minZ - m, b.maxZ + m];
    for (const seg of [
      { x1: x0, z1: z0, x2: x1, z2: z0 },
      { x1: x1, z1: z0, x2: x1, z2: z1 },
      { x1: x1, z1: z1, x2: x0, z2: z1 },
      { x1: x0, z1: z1, x2: x0, z2: z0 },
    ]) {
      walls.push({ seg, halfThickness: 1, height: 3 });
    }
    for (let i = 0; i < walls.length; i += WALLS_PER_BODY)
      physics.addWalls(walls.slice(i, i + WALLS_PER_BODY));
    track.props.forEach((prop, i) => {
      if (prop.type === "tires") physics.addTireStack(prop.x, prop.z);
      else this.cones.push({ prop: i, body: physics.addCone(prop.x, prop.z) });
    });
    this.physics = physics;
  }

  /** Kart on the grid, session (re)started: out lap, then timed laps (free drive if invalid). */
  start() {
    const grid = startGrid(this.track, this.layout);
    this.placeKart(grid.x, grid.z, grid.yaw, this.line.y);
    if (this.raceable) this.race.start();
    else this.race.stop();
    this.steps = 0;
  }

  /** `level`: height of the surface to put the kart on (where roads cross, which one). */
  private placeKart(x: number, z: number, yaw: number, level: number) {
    const ground = groundHeight(this.layout, this.path, x, z, level);
    this.physics.teleportKart(x, z, ground);
    this.kart = createKartState(yaw);
    this.prevPos.x = this.currPos.x = x;
    this.prevPos.y = this.currPos.y = ground + KART_RADIUS;
    this.prevPos.z = this.currPos.z = z;
    this.prevYaw = this.currYaw = yaw;
    this.prevVel.x = this.prevVel.z = this.currVel.x = this.currVel.z = 0;
    this.lastQuery = this.onTrackQuery = queryTrack(this.layout, this.path, x, z, ground);
    this.progress = null;
  }

  /** Back onto the centerline of the last piece the kart was on, facing the race direction. */
  private resetKart() {
    const q = this.onTrackQuery;
    if (!q || !q.piece) {
      const g = startGrid(this.track, this.layout);
      this.placeKart(g.x, g.z, g.yaw, this.line.y);
      return;
    }
    this.placeKart(q.closest.x, q.closest.z, Math.atan2(q.tangent.x, q.tangent.z), q.height);
  }

  step(input: SimInput): StepResult {
    const dt = STEP;
    const physics = this.physics;
    let reset = false;
    if (input.reset) {
      this.resetKart();
      reset = true;
    }
    this.steps++;
    this.race.tick(dt);

    // Surface under the kart (at its own level where roads cross).
    const foot = this.currPos.y - KART_RADIUS;
    const q = queryTrack(this.layout, this.path, this.currPos.x, this.currPos.z, foot);
    this.lastQuery = q;
    if (q.piece && q.lateral < ROAD_HALF + 1) this.onTrackQuery = q;
    const offTrack = q.lateral > ROAD_HALF + 0.6;

    stepKart(this.kart, input, offTrack ? GRASS : ASPHALT, dt);

    // Elevation: the kart rides the road's height profile. On the surface, its vertical speed
    // follows the ground under where it is heading (crashcat then subtracts one step of
    // gravity); when the ground falls away faster than gravity can pull the kart down (a crest
    // taken fast) it keeps its own vertical speed, flies, and lands further on.
    const g0 = groundHeight(this.layout, this.path, this.currPos.x, this.currPos.z, foot);
    const g1 = groundHeight(
      this.layout,
      this.path,
      this.currPos.x + this.kart.vx * dt,
      this.currPos.z + this.kart.vz * dt,
      foot,
    );
    let vy = physics.kart.motionProperties.linearVelocity[1];
    const falling = foot - g0 > 0.05 ? vy : 0;
    // (A raised deck more than a step above is a wall: its collider stops the kart.)
    if (foot - g0 < 0.05 && g1 - foot < 1) {
      vy = Math.max((g1 - g0) / dt + GRAVITY * dt, vy);
      const speed = Math.hypot(this.kart.vx, this.kart.vz);
      if (speed > 0.5 && g1 !== g0) {
        const grade = Math.min(0.5, Math.max(-0.5, (g1 - g0) / (speed * dt)));
        const k = 1 - (GRAVITY * SLOPE_PULL * grade * dt) / speed;
        this.kart.vx *= k;
        this.kart.vz *= k;
      }
    }
    physics.setKartVelocity(this.kart.vx, vy, this.kart.vz);
    const conesBefore = physics.coneHit;
    physics.step(dt);

    // Discrete steps can leave the kart a hair inside a rising surface: lift it out.
    const pos = physics.kart.position;
    const ground = groundHeight(this.layout, this.path, pos[0], pos[2], pos[1] - KART_RADIUS);
    if (pos[1] < ground + KART_RADIUS - 0.01 && ground - (pos[1] - KART_RADIUS) < 1)
      physics.setKartHeight(ground + KART_RADIUS);
    const landing = falling < -4 && pos[1] - KART_RADIUS - ground < 0.03 ? falling : 0;

    const p = physics.kart.position;
    const v = physics.kart.motionProperties.linearVelocity;
    // Any difference between the velocity we asked for and what came back is a collision.
    const impact = Math.hypot(v[0] - this.kart.vx, v[2] - this.kart.vz);
    if (impact > 0.05) afterCollision(this.kart, v[0], v[2]);

    this.prevPos.x = this.currPos.x;
    this.prevPos.y = this.currPos.y;
    this.prevPos.z = this.currPos.z;
    this.currPos.x = p[0];
    this.currPos.y = p[1];
    this.currPos.z = p[2];
    this.prevYaw = this.currYaw;
    this.currYaw = this.kart.yaw;
    this.prevVel.x = this.currVel.x;
    this.prevVel.z = this.currVel.z;
    this.currVel.x = this.kart.vx;
    this.currVel.z = this.kart.vz;

    // Race progress: piece in race order, sector boundaries (route distance from the line, from
    // where the kart was to where it is now) and start/finish line crossing.
    const lapTime = this.race.lapTime;
    const events: RaceEvent[] = [];
    if (q.piece && q.piece.order >= 0) {
      this.race.onPiece(q.piece.order);
      const total = this.path.totalLength;
      const now = queryTrack(
        this.layout,
        this.path,
        this.currPos.x,
        this.currPos.z,
        this.currPos.y - KART_RADIUS,
      );
      if (now.piece && now.piece.order >= 0 && total > 0) {
        const progress = (((now.distance - this.lineDistance) % total) + total) % total;
        if (this.progress !== null)
          events.push(...this.race.onProgress(this.progress, progress, dt));
        this.progress = progress;
      }
    }
    const l = this.line;
    const d0 = (this.prevPos.x - l.x) * l.fx + (this.prevPos.z - l.z) * l.fz;
    const d1 = (this.currPos.x - l.x) * l.fx + (this.currPos.z - l.z) * l.fz;
    // (Only at the line's own level: driving under the start straight on a lower road is not a
    // line crossing.)
    const atLineLevel = Math.abs(this.currPos.y - KART_RADIUS - l.y) < LEVEL_HEIGHT * 0.75;
    if (atLineLevel && ((d0 < 0 && d1 >= 0) || (d0 >= 0 && d1 < 0))) {
      const lateral = Math.abs((this.currPos.x - l.x) * l.fz - (this.currPos.z - l.z) * l.fx);
      if (lateral < WALL_OFFSET + 1 && Math.abs(d1 - d0) < 2) {
        const forward = d1 >= 0;
        const overshoot = forward ? (d1 / (d1 - d0)) * dt : 0;
        events.push(...this.race.onLineCrossed(forward, overshoot));
      }
    }

    // Fell out of the world (should not happen, but never leave the player stranded).
    if (p[1] < -5) {
      this.resetKart();
      reset = true;
    }

    return {
      events,
      query: q,
      offTrack,
      impact,
      coneHit: physics.coneHit !== conesBefore,
      landing,
      reset,
      lapTime,
    };
  }
}
