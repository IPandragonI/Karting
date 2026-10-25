import {
  CELL,
  DIR_VEC,
  PIECES,
  ROAD_HALF,
  rotateDir,
  rotateVec,
  sampleSegment,
  type Dir,
  type PieceType,
  type PropType,
  type Rot,
  type Vec2,
} from "./pieces";

export type PieceData = { type: PieceType; x: number; z: number; rot: Rot };
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

export function footprintCells(p: PieceData): [number, number][] {
  return PIECES[p.type].footprint.map(([dx, dz]) => {
    const [rx, rz] = rotateVec(dx, dz, p.rot);
    return [p.x + rx, p.z + rz];
  });
}

export type WorldConnector = {
  /** Cell the road leaves from. */
  cell: [number, number];
  /** Direction it leaves in. */
  dir: Dir;
};

export function worldConnectors(p: PieceData): [WorldConnector, WorldConnector] {
  const def = PIECES[p.type];
  return def.connectors.map((c) => {
    const [rx, rz] = rotateVec(c.cell[0], c.cell[1], p.rot);
    return { cell: [p.x + rx, p.z + rz], dir: rotateDir(c.dir, p.rot) };
  }) as [WorldConnector, WorldConnector];
}

export function toWorld(p: PieceData, v: Vec2): Vec2 {
  const [rx, rz] = rotateVec(v.x, v.z, p.rot);
  return { x: p.x * CELL + rx, z: p.z * CELL + rz };
}

export function rotateWorld(p: PieceData, v: Vec2): Vec2 {
  const [rx, rz] = rotateVec(v.x, v.z, p.rot);
  return { x: rx, z: rz };
}

/** World-space centerline of a piece from connector A to B. */
export function pieceCenterline(p: PieceData, step = 1): { points: Vec2[]; tangents: Vec2[] } {
  const s = sampleSegment(PIECES[p.type].segment, step);
  return {
    points: s.points.map((v) => toWorld(p, v)),
    tangents: s.tangents.map((v) => rotateWorld(p, v)),
  };
}

export type Issue = {
  severity: "error" | "warning";
  message: string;
  /** Cells to highlight in the editor. */
  cells: [number, number][];
};

/** An "open end": a connector that does not join a matching connector on a neighbour. */
export type OpenEnd = { cell: [number, number]; dir: Dir };

export type OrderedPiece = {
  index: number;
  /** True when the race runs connector B → A through this piece. */
  reversed: boolean;
};

export type TrackLayout = {
  /** Map from cell key to piece index. */
  occupancy: Map<string, number>;
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
  const occupancy = new Map<string, number>();
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
      if (occupancy.has(key)) overlapping.add(key);
      else occupancy.set(key, i);
    }
  });
  if (overlapping.size > 0) {
    issues.push({
      severity: "error",
      message: `${overlapping.size} overlapping cell${overlapping.size > 1 ? "s" : ""}`,
      cells: [...overlapping].map((k) => k.split(",").map(Number) as [number, number]),
    });
  }

  // Connection check for every connector, independent of the race order.
  const openEnds: OpenEnd[] = [];
  const blocked: [number, number][] = [];
  track.pieces.forEach((p) => {
    for (const c of worldConnectors(p)) {
      const match = findMatch(track, occupancy, c);
      if (match === null) {
        const [dx, dz] = DIR_VEC[c.dir];
        const neighbour = occupancy.get(cellKey(c.cell[0] + dx, c.cell[1] + dz));
        if (neighbour !== undefined) blocked.push(c.cell);
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
      if (match === null) break;
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

  if (!closed) {
    if (blocked.length > 0) {
      issues.push({
        severity: "error",
        message: "Road runs into the side of another piece (check rotations)",
        cells: blocked,
      });
    }
    if (openEnds.length > blocked.length) {
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

function findMatch(
  track: TrackData,
  occupancy: Map<string, number>,
  c: WorldConnector,
): { index: number; connector: 0 | 1 } | null {
  const [dx, dz] = DIR_VEC[c.dir];
  const nx = c.cell[0] + dx;
  const nz = c.cell[1] + dz;
  const index = occupancy.get(cellKey(nx, nz));
  if (index === undefined) return null;
  const opposite = rotateDir(c.dir, 2);
  const conns = worldConnectors(track.pieces[index]!);
  for (const k of [0, 1] as const) {
    const o = conns[k];
    if (o.cell[0] === nx && o.cell[1] === nz && o.dir === opposite) return { index, connector: k };
  }
  return null;
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
    let length = 0;
    for (let i = 1; i < points.length; i++) {
      length += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.z - points[i - 1]!.z);
    }
    const pp: PathPiece = { pieceIndex, order, points, tangents, startDistance: distance, length };
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
};

/** Finds where a world position is relative to the track (cell lookup, then nearest segment). */
export function queryTrack(layout: TrackLayout, path: RacePath, x: number, z: number): TrackQuery {
  const cx = Math.round(x / CELL);
  const cz = Math.round(z / CELL);
  const index = layout.occupancy.get(cellKey(cx, cz));
  const pp = index === undefined ? undefined : path.byPiece.get(index);
  if (!pp) {
    return {
      piece: null,
      lateral: Infinity,
      closest: { x, z },
      tangent: { x: 0, z: 1 },
      distance: 0,
      onRoad: false,
    };
  }
  let best = Infinity;
  let closest: Vec2 = pp.points[0]!;
  let tangent: Vec2 = pp.tangents[0]!;
  let along = 0;
  let bestAlong = 0;
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
  };
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
 * laps. Renaming a track or moving cones keeps its records.
 */
export function trackId(t: TrackData): string {
  const canon = t.pieces
    .map((p) => `${p.type}:${p.x}:${p.z}:${p.rot}`)
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
