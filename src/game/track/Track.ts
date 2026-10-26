import {
  CELL,
  DIR_VEC,
  flipDir,
  LEVEL_HEIGHT,
  MAX_LEVEL,
  PIECES,
  riseProfile,
  ROAD_HALF,
  rotateDir,
  rotateVec,
  sampleSegments,
  WALL_OFFSET,
  type Dir,
  type PieceType,
  type PropType,
  type Rot,
  type Vec2,
} from "./pieces";

export type PieceData = {
  type: PieceType;
  x: number;
  z: number;
  rot: Rot;
  /** Elevation level at connector A (0 = ground, omitted when 0). */
  y?: number;
  /** Mirrored left ↔ right before rotating (omitted when false). */
  flip?: boolean;
};
/** Props sit on a half-unit grid in world space (not cells) so cones can line a corner. */
export type PropData = { type: PropType; x: number; z: number; rot: Rot };

export type TrackData = {
  version: 1;
  name: string;
  pieces: PieceData[];
  props: PropData[];
};

export const MAX_PIECES = 400;
export const MAX_PROPS = 400;
/** Cells are limited to ±GRID_LIMIT so they fit the compact share encoding. */
export const GRID_LIMIT = 60;

export const cellKey = (x: number, z: number) => `${x},${z}`;

/** Local (piece) vector to world orientation: mirror if flipped, then rotate. */
function orient(p: PieceData, x: number, z: number): [number, number] {
  return rotateVec(p.flip ? -x : x, z, p.rot);
}

export function footprintCells(p: PieceData): [number, number][] {
  return PIECES[p.type].footprint.map(([dx, dz]) => {
    const [rx, rz] = orient(p, dx, dz);
    return [p.x + rx, p.z + rz];
  });
}

/** Elevation level of a piece at connector A. */
export const pieceLevel = (p: PieceData) => p.y ?? 0;

/** Lowest and highest level a piece occupies (a ramp spans its two ends). */
export function levelRange(p: PieceData): [number, number] {
  const lo = pieceLevel(p);
  return [lo, lo + PIECES[p.type].rise];
}

/**
 * Two pieces can share a grid cell when a full level lies between them (one passes over the
 * other: a bridge, an overpass). Closer than that, they would intersect.
 */
export function levelsClear(a: PieceData, b: PieceData): boolean {
  const [alo, ahi] = levelRange(a);
  const [blo, bhi] = levelRange(b);
  return ahi + 1 <= blo || bhi + 1 <= alo;
}

/** Thickness of a raised deck where it passes over another road (its underside). */
export const DECK_DEPTH = 0.35;

export type WorldConnector = {
  /** Cell the road leaves from. */
  cell: [number, number];
  /** Direction it leaves in. */
  dir: Dir;
  /** Elevation level of the road at this end. */
  level: number;
};

export function worldConnectors(p: PieceData): [WorldConnector, WorldConnector] {
  const def = PIECES[p.type];
  return def.connectors.map((c, k) => {
    const [rx, rz] = orient(p, c.cell[0], c.cell[1]);
    return {
      cell: [p.x + rx, p.z + rz],
      dir: rotateDir(p.flip ? flipDir(c.dir) : c.dir, p.rot),
      level: pieceLevel(p) + (k === 1 ? def.rise : 0),
    };
  }) as [WorldConnector, WorldConnector];
}

export function toWorld(p: PieceData, v: Vec2): Vec2 {
  const [rx, rz] = orient(p, v.x, v.z);
  return { x: p.x * CELL + rx, z: p.z * CELL + rz };
}

export function rotateWorld(p: PieceData, v: Vec2): Vec2 {
  const [rx, rz] = orient(p, v.x, v.z);
  return { x: rx, z: rz };
}

/**
 * World-space centerline of a piece from connector A to B, with the road height at each point
 * (level plus the ramp profile by distance along the piece).
 */
export function pieceCenterline(
  p: PieceData,
  step = 1,
): { points: Vec2[]; tangents: Vec2[]; heights: number[] } {
  const def = PIECES[p.type];
  const s = sampleSegments(def.segments, step);
  const points = s.points.map((v) => toWorld(p, v));
  const along = [0];
  for (let i = 1; i < s.points.length; i++) {
    const a = s.points[i - 1]!;
    const b = s.points[i]!;
    along.push(along[i - 1]! + Math.hypot(b.x - a.x, b.z - a.z));
  }
  const total = along.at(-1) || 1;
  const base = pieceLevel(p);
  return {
    points,
    tangents: s.tangents.map((v) => rotateWorld(p, v)),
    heights: along.map((d) => (base + def.rise * riseProfile(d / total)) * LEVEL_HEIGHT),
  };
}

export type Issue = {
  severity: "error" | "warning";
  message: string;
  /** Cells to highlight in the editor. */
  cells: [number, number][];
};

/** An "open end": a connector that does not join a matching connector on a neighbour. */
export type OpenEnd = { cell: [number, number]; dir: Dir; level: number };

export type OrderedPiece = {
  index: number;
  /** True when the race runs connector B → A through this piece. */
  reversed: boolean;
};

export type TrackLayout = {
  /** Map from cell key to the pieces covering it (several when roads pass over each other). */
  occupancy: Map<string, number[]>;
  startIndex: number;
  /** Pieces in race order starting at the start piece (only when the loop is closed). */
  order: OrderedPiece[];
  closed: boolean;
  issues: Issue[];
  openEnds: OpenEnd[];
};

/**
 * Builds the occupancy map, follows the circuit from the start line and reports every problem.
 * A valid circuit is a single closed loop with exactly one start piece and no stray pieces.
 */
export function analyzeTrack(track: TrackData): TrackLayout {
  const issues: Issue[] = [];
  const occupancy = new Map<string, number[]>();
  const overlapping = new Set<string>();

  track.pieces.forEach((p, i) => {
    for (const [cx, cz] of footprintCells(p)) {
      const key = cellKey(cx, cz);
      if (Math.abs(cx) > GRID_LIMIT || Math.abs(cz) > GRID_LIMIT) {
        issues.push({
          severity: "error",
          message: "Piece outside the build area",
          cells: [[cx, cz]],
        });
      }
      const list = occupancy.get(key);
      if (!list) {
        occupancy.set(key, [i]);
        continue;
      }
      // Sharing a cell is fine with a full level of clearance (a bridge over a road).
      if (list.some((j) => !levelsClear(track.pieces[j]!, p))) overlapping.add(key);
      list.push(i);
    }
  });
  if (overlapping.size > 0) {
    issues.push({
      severity: "error",
      message: `${overlapping.size} overlapping cell${overlapping.size > 1 ? "s" : ""} (pieces sharing a cell need a level between them)`,
      cells: [...overlapping].map((k) => k.split(",").map(Number) as [number, number]),
    });
  }

  // Elevation range.
  const tooHigh = track.pieces.flatMap((p) =>
    pieceLevel(p) < 0 || pieceLevel(p) + PIECES[p.type].rise > MAX_LEVEL
      ? [[p.x, p.z] as [number, number]]
      : [],
  );
  if (tooHigh.length > 0) {
    issues.push({
      severity: "error",
      message: `Pieces must stay between level 0 and ${MAX_LEVEL}`,
      cells: tooHigh,
    });
  }

  // Connection check for every connector, independent of the race order.
  const openEnds: OpenEnd[] = [];
  const blocked: [number, number][] = [];
  const steps: [number, number][] = [];
  track.pieces.forEach((p) => {
    for (const c of worldConnectors(p)) {
      const match = findMatch(track, occupancy, c);
      if (match !== null && match.level !== c.level) {
        steps.push(c.cell);
        openEnds.push(c);
      } else if (match === null) {
        // A road only runs "into the side" of a piece at its own height; one passing above or
        // below is not in the way.
        const [dx, dz] = DIR_VEC[c.dir];
        const neighbours = occupancy.get(cellKey(c.cell[0] + dx, c.cell[1] + dz)) ?? [];
        const inTheWay = neighbours.some((j) => {
          const [lo, hi] = levelRange(track.pieces[j]!);
          return c.level >= lo && c.level <= hi;
        });
        if (inTheWay) blocked.push(c.cell);
        openEnds.push(c);
      }
    }
  });

  const starts = track.pieces.flatMap((p, i) => (p.type === "start" ? [i] : []));
  if (track.pieces.length === 0) {
    issues.push({ severity: "error", message: "The track is empty", cells: [] });
  } else if (starts.length === 0) {
    issues.push({ severity: "error", message: "Add a Start / Finish piece", cells: [] });
  } else if (starts.length > 1) {
    issues.push({
      severity: "error",
      message: "Only one Start / Finish piece is allowed",
      cells: starts.map((i) => [track.pieces[i]!.x, track.pieces[i]!.z]),
    });
  }

  const startIndex = starts.length === 1 ? starts[0]! : -1;
  const order: OrderedPiece[] = [];
  let closed = false;

  if (startIndex >= 0 && overlapping.size === 0) {
    // Follow the road forward (connector A → B through the start) until we come back.
    const visited = new Set<number>([startIndex]);
    let current = startIndex;
    let reversed = false;
    order.push({ index: startIndex, reversed: false });
    for (let guard = 0; guard <= track.pieces.length; guard++) {
      const exit = worldConnectors(track.pieces[current]!)[reversed ? 0 : 1];
      const match = findMatch(track, occupancy, exit);
      if (match === null || match.level !== exit.level) break;
      if (match.index === startIndex) {
        // Its exit is already taken by the first link, so we can only come back in through A.
        closed = true;
        break;
      }
      if (visited.has(match.index)) break;
      visited.add(match.index);
      current = match.index;
      reversed = match.connector === 1;
      order.push({ index: current, reversed });
    }

    if (closed) {
      // Every open end now belongs to a stray piece: worth a warning, not a blocker.
      const stray = track.pieces.flatMap((p, i) =>
        visited.has(i) ? [] : [[p.x, p.z] as [number, number]],
      );
      if (stray.length > 0) {
        issues.push({
          severity: "warning",
          message: `${stray.length} piece${stray.length > 1 ? "s are" : " is"} not part of the circuit`,
          cells: stray,
        });
      }
    }
  }

  if (steps.length > 0) {
    issues.push({
      severity: "error",
      message: "Height step between connected pieces (add a ramp or change a level)",
      cells: steps,
    });
  }

  if (!closed) {
    if (blocked.length > 0) {
      issues.push({
        severity: "error",
        message: "Road runs into the side of another piece (check rotations)",
        cells: blocked,
      });
    }
    if (openEnds.length > blocked.length + steps.length) {
      issues.push({
        severity: "error",
        message: "The circuit has open ends",
        cells: openEnds.map((o) => o.cell),
      });
    }
    if (startIndex >= 0 && !issues.some((i) => i.severity === "error")) {
      issues.push({ severity: "error", message: "The circuit is not a closed loop", cells: [] });
    }
  }

  if (track.pieces.length > MAX_PIECES) {
    issues.push({ severity: "error", message: `Too many pieces (max ${MAX_PIECES})`, cells: [] });
  }

  return { occupancy, startIndex, order: closed ? order : [], closed, issues, openEnds };
}

/**
 * The piece end facing connector `c` across the cell edge. Ends only connect at the same level;
 * when the only facing end is at another level it is returned anyway (a height step, reported
 * as an error) rather than silently joining two levels.
 */
function findMatch(
  track: TrackData,
  occupancy: Map<string, number[]>,
  c: WorldConnector,
): { index: number; connector: 0 | 1; level: number } | null {
  const [dx, dz] = DIR_VEC[c.dir];
  const nx = c.cell[0] + dx;
  const nz = c.cell[1] + dz;
  const opposite = rotateDir(c.dir, 2);
  let other: { index: number; connector: 0 | 1; level: number } | null = null;
  for (const index of occupancy.get(cellKey(nx, nz)) ?? []) {
    const conns = worldConnectors(track.pieces[index]!);
    for (const k of [0, 1] as const) {
      const o = conns[k];
      if (o.cell[0] !== nx || o.cell[1] !== nz || o.dir !== opposite) continue;
      if (o.level === c.level) return { index, connector: k, level: o.level };
      if (!other || Math.abs(o.level - c.level) < Math.abs(other.level - c.level))
        other = { index, connector: k, level: o.level };
    }
  }
  return other;
}

export function isRaceable(layout: TrackLayout): boolean {
  return layout.closed && !layout.issues.some((i) => i.severity === "error");
}

// ─── Race path ────────────────────────────────────────────────────────────

export type PathPiece = {
  pieceIndex: number;
  /** Position of this piece in race order (or −1 when the piece is not on the circuit). */
  order: number;
  /** Centerline in race direction. */
  points: Vec2[];
  tangents: Vec2[];
  /** Road height at each point. */
  heights: number[];
  /** Highest level the piece reaches (drawing order on the map). */
  level: number;
  /** Distance along the whole circuit at points[0]. */
  startDistance: number;
  length: number;
};

export type RacePath = {
  pieces: PathPiece[];
  /** Lookup by piece index. */
  byPiece: Map<number, PathPiece>;
  totalLength: number;
};

/**
 * Centerlines in race order. Pieces that are not on the loop (or the whole track when it is
 * not raceable) still get an entry with their native direction so off-track tests work.
 */
export function buildRacePath(track: TrackData, layout: TrackLayout): RacePath {
  const pieces: PathPiece[] = [];
  const byPiece = new Map<number, PathPiece>();
  let distance = 0;
  const add = (pieceIndex: number, order: number, reversed: boolean) => {
    const c = pieceCenterline(track.pieces[pieceIndex]!, 1);
    const points = reversed ? [...c.points].reverse() : c.points;
    const tangents = reversed
      ? [...c.tangents].reverse().map((t) => ({ x: -t.x, z: -t.z }))
      : c.tangents;
    const heights = reversed ? [...c.heights].reverse() : c.heights;
    let length = 0;
    for (let i = 1; i < points.length; i++) {
      length += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.z - points[i - 1]!.z);
    }
    const pp: PathPiece = {
      pieceIndex,
      order,
      points,
      tangents,
      heights,
      level: pieceLevel(track.pieces[pieceIndex]!) + PIECES[track.pieces[pieceIndex]!.type].rise,
      startDistance: distance,
      length,
    };
    if (order >= 0) distance += length;
    pieces.push(pp);
    byPiece.set(pieceIndex, pp);
  };
  layout.order.forEach((o, i) => add(o.index, i, o.reversed));
  track.pieces.forEach((_, i) => {
    if (!byPiece.has(i)) add(i, -1, false);
  });
  return { pieces, byPiece, totalLength: distance };
}

export type TrackQuery = {
  /** Piece under the point, or null on grass. */
  piece: PathPiece | null;
  /** Unsigned distance from the centerline of that piece. */
  lateral: number;
  /** Closest centerline point and race-direction tangent. */
  closest: Vec2;
  tangent: Vec2;
  /** Distance along the circuit (only meaningful when piece.order ≥ 0). */
  distance: number;
  onRoad: boolean;
  /** Road height at the closest centerline point, and its slope along `tangent`. */
  height: number;
  grade: number;
};

/** Finds where a world position is relative to the track (cell lookup, then nearest segment). */
/** How far above the kart a surface may be and still be the one it drives on (ramps, steps). */
const STEP_UP = 0.8;
/** Out to the deck edge, a raised piece is solid ground (asphalt, verges, under the walls). */
const DECK_REACH = WALL_OFFSET + 0.6;

const NO_TRACK = (x: number, z: number): TrackQuery => ({
  piece: null,
  lateral: Infinity,
  closest: { x, z },
  tangent: { x: 0, z: 1 },
  distance: 0,
  onRoad: false,
  height: 0,
  grade: 0,
});

/** Queries for every piece covering the point's cell (one per level where roads cross). */
function queryCell(layout: TrackLayout, path: RacePath, x: number, z: number): TrackQuery[] {
  const list = layout.occupancy.get(cellKey(Math.round(x / CELL), Math.round(z / CELL)));
  if (!list) return [];
  const out: TrackQuery[] = [];
  for (const index of list) {
    const pp = path.byPiece.get(index);
    if (pp) out.push(queryPiece(pp, x, z));
  }
  return out;
}

/**
 * The surface a kart at height `y` is on: the highest one at or just above its wheels (a kart
 * under a bridge stays on the lower road; on the bridge it cannot fall through). Without `y`,
 * the top surface.
 */
function pickSurface(qs: TrackQuery[], y: number): TrackQuery | null {
  let best: TrackQuery | null = null;
  for (const q of qs) {
    if (q.height > y + STEP_UP) continue;
    if (
      !best ||
      q.height > best.height + 1e-6 ||
      (Math.abs(q.height - best.height) < 1e-6 && q.lateral < best.lateral)
    )
      best = q;
  }
  if (best) return best;
  // Everything is above the kart: the lowest surface.
  for (const q of qs) if (!best || q.height < best.height) best = q;
  return best;
}

/**
 * Finds where a world position is relative to the track (cell lookup, then nearest segment).
 * `y` (the kart's base height) picks the level where roads pass over each other.
 */
export function queryTrack(
  layout: TrackLayout,
  path: RacePath,
  x: number,
  z: number,
  y = Infinity,
): TrackQuery {
  return pickSurface(queryCell(layout, path, x, z), y) ?? NO_TRACK(x, z);
}

function queryPiece(pp: PathPiece, x: number, z: number): TrackQuery {
  let best = Infinity;
  let closest: Vec2 = pp.points[0]!;
  let tangent: Vec2 = pp.tangents[0]!;
  let along = 0;
  let bestAlong = 0;
  let height = pp.heights[0] ?? 0;
  let grade = 0;
  for (let i = 1; i < pp.points.length; i++) {
    const a = pp.points[i - 1]!;
    const b = pp.points[i]!;
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const len2 = abx * abx + abz * abz;
    const t = Math.max(0, Math.min(1, ((x - a.x) * abx + (z - a.z) * abz) / len2));
    const px = a.x + abx * t;
    const pz = a.z + abz * t;
    const d = Math.hypot(x - px, z - pz);
    const segLen = Math.sqrt(len2);
    if (d < best) {
      best = d;
      closest = { x: px, z: pz };
      const len = segLen || 1;
      tangent = { x: abx / len, z: abz / len };
      bestAlong = along + segLen * t;
      const h0 = pp.heights[i - 1]!;
      const h1 = pp.heights[i]!;
      height = h0 + (h1 - h0) * t;
      grade = (h1 - h0) / len;
    }
    along += segLen;
  }
  return {
    piece: pp,
    lateral: best,
    closest,
    tangent,
    distance: pp.startDistance + bestAlong,
    onRoad: best <= ROAD_HALF,
    height,
    grade,
  };
}

/**
 * Height of the drivable surface under a kart whose base is at `y`: the road deck (asphalt,
 * verges and walls) where a piece is, the ground (0) elsewhere. The same profile builds the
 * road mesh, so what you see is what you drive on. Where roads cross, the deck the kart is on
 * (see pickSurface); without `y`, the top one.
 */
export function groundHeight(
  layout: TrackLayout,
  path: RacePath,
  x: number,
  z: number,
  y = Infinity,
): number {
  const decks = queryCell(layout, path, x, z).filter((q) => q.lateral <= DECK_REACH);
  const q = pickSurface(decks, y);
  return q && q.height <= y + STEP_UP ? Math.max(0, q.height) : 0;
}

/** Underside of the lowest deck above height `y` at a point (Infinity when open sky). */
export function ceilingHeight(
  layout: TrackLayout,
  path: RacePath,
  x: number,
  z: number,
  y: number,
): number {
  let ceiling = Infinity;
  for (const q of queryCell(layout, path, x, z)) {
    const under = q.height - DECK_DEPTH;
    if (q.lateral <= DECK_REACH && under > y + 0.2) ceiling = Math.min(ceiling, under);
  }
  return ceiling;
}

/** Grid spawn slots behind the start line, in world space, with the race heading (yaw). */
export function startGrid(
  track: TrackData,
  layout: TrackLayout,
): { x: number; z: number; yaw: number } {
  const start = layout.startIndex >= 0 ? track.pieces[layout.startIndex] : track.pieces[0];
  if (!start) return { x: 0, z: 0, yaw: 0 };
  const p = toWorld(start, { x: -1.6, z: -3 });
  return { x: p.x, z: p.z, yaw: (start.rot * Math.PI) / 2 };
}

/** Bounding box of all pieces in world units. */
export function trackBounds(track: TrackData): {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
} {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of track.pieces) {
    for (const [cx, cz] of footprintCells(p)) {
      minX = Math.min(minX, cx);
      maxX = Math.max(maxX, cx);
      minZ = Math.min(minZ, cz);
      maxZ = Math.max(maxZ, cz);
    }
  }
  if (!Number.isFinite(minX)) return { minX: -CELL, maxX: CELL, minZ: -CELL, maxZ: CELL };
  return {
    minX: (minX - 0.5) * CELL,
    maxX: (maxX + 0.5) * CELL,
    minZ: (minZ - 0.5) * CELL,
    maxZ: (maxZ + 0.5) * CELL,
  };
}

/**
 * Stable identifier of a circuit's layout (pieces only, order-independent), used to key best
 * laps, sector records and ghosts. Any change to the driven layout (a piece, a rotation, a
 * level) gives a new id; renaming a track or moving cones keeps its records. Flat, unflipped
 * pieces hash exactly as before elevation existed, so older records stay valid.
 */
export function trackId(t: TrackData): string {
  const canon = t.pieces
    .map(
      (p) =>
        `${p.type}:${p.x}:${p.z}:${p.rot}${pieceLevel(p) ? `:y${pieceLevel(p)}` : ""}${p.flip ? ":f" : ""}`,
    )
    .sort()
    .join("|");
  let h = 0x811c9dc5;
  for (let i = 0; i < canon.length; i++) {
    h ^= canon.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function cloneTrack(t: TrackData): TrackData {
  return {
    version: 1,
    name: t.name,
    pieces: t.pieces.map((p) => ({ ...p })),
    props: t.props.map((p) => ({ ...p })),
  };
}

const pieceKey = (p: TrackData["pieces"][number]) =>
  `${p.type}:${p.x}:${p.z}:${p.rot}:${p.y ?? 0}:${p.flip ? 1 : 0}`;
const propKey = (p: TrackData["props"][number]) => `${p.type}:${p.x}:${p.z}:${p.rot}`;

/**
 * The circuit with pieces and props in a canonical order. The physics world is built in piece
 * order, so this is what makes a track file and its reordered copy simulate identically.
 */
export function canonicalTrack(t: TrackData): TrackData {
  const byKey =
    <T>(key: (x: T) => string) =>
    (a: T, b: T) =>
      key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
  return {
    version: 1,
    name: t.name,
    pieces: t.pieces.map((p) => ({ ...p })).sort(byKey(pieceKey)),
    props: t.props.map((p) => ({ ...p })).sort(byKey(propKey)),
  };
}
