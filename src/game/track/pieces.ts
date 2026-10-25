// Track pieces are defined once, in a local frame, as a centerline path inside a footprint of grid
// cells. Everything else (road mesh, curbs, tire walls, colliders, checkpoints, off-track tests)
// is derived from that centerline, so visuals and physics can never disagree.
//
// Conventions:
// - A cell is CELL × CELL world units; cell (cx, cz) is centred on (cx * CELL, cz * CELL).
// - Directions: 0 = +Z, 1 = +X, 2 = −Z, 3 = −X. A rotation `rot` turns a piece by rot × 90°
//   around +Y exactly like `object.rotation.y = rot * π / 2` in three.js, so it adds `rot`
//   to every direction index.
// - The local origin is the centre of the piece's anchor cell [0, 0].

export const CELL = 12;
/** Half width of the asphalt. */
export const ROAD_HALF = 4;
/** Distance from the centerline to the middle of the tire wall. */
export const WALL_OFFSET = 5.25;
/** Radius of one tire in a tire wall stack (also the half thickness of the wall collider). */
export const TIRE_RADIUS = 0.3;

export type Dir = 0 | 1 | 2 | 3;
export type Rot = 0 | 1 | 2 | 3;

export type PieceType = "straight" | "start" | "corner" | "wideCorner" | "hairpin";
export type PropType = "cone" | "tires";

export const PIECE_TYPES: readonly PieceType[] = [
  "straight",
  "start",
  "corner",
  "wideCorner",
  "hairpin",
];
export const PROP_TYPES: readonly PropType[] = ["cone", "tires"];

export type Vec2 = { x: number; z: number };

export type Segment =
  | { kind: "line"; from: Vec2; to: Vec2 }
  /** Arc around `center`, from angle `a0` to `a1` (radians, measured as x = cos a, z = sin a). */
  | { kind: "arc"; center: Vec2; radius: number; a0: number; a1: number };

export type Connector = { cell: [number, number]; dir: Dir };

export type PieceDef = {
  type: PieceType;
  label: string;
  description: string;
  footprint: [number, number][];
  /** Centerline from connector A (`connectors[0]`) to connector B (`connectors[1]`). */
  segment: Segment;
  connectors: [Connector, Connector];
  /** Corners get red/white kerbs; straights get a plain white edge line. */
  kerbs: boolean;
};

const H = CELL / 2;

export const PIECES: Record<PieceType, PieceDef> = {
  straight: {
    type: "straight",
    label: "Straight",
    description: "One cell of straight road",
    footprint: [[0, 0]],
    segment: { kind: "line", from: { x: 0, z: -H }, to: { x: 0, z: H } },
    connectors: [
      { cell: [0, 0], dir: 2 },
      { cell: [0, 0], dir: 0 },
    ],
    kerbs: false,
  },
  start: {
    type: "start",
    label: "Start / Finish",
    description: "Starting grid and finish line. The race runs towards the arrow.",
    footprint: [[0, 0]],
    segment: { kind: "line", from: { x: 0, z: -H }, to: { x: 0, z: H } },
    connectors: [
      { cell: [0, 0], dir: 2 },
      { cell: [0, 0], dir: 0 },
    ],
    kerbs: false,
  },
  corner: {
    type: "corner",
    label: "Corner",
    description: "Tight 90° corner in one cell. Rotate it to turn left or right.",
    footprint: [[0, 0]],
    segment: { kind: "arc", center: { x: H, z: -H }, radius: H, a0: Math.PI, a1: Math.PI / 2 },
    connectors: [
      { cell: [0, 0], dir: 2 },
      { cell: [0, 0], dir: 1 },
    ],
    kerbs: true,
  },
  wideCorner: {
    type: "wideCorner",
    label: "Sweeper",
    description: "Fast, wide 90° corner over 2 × 2 cells",
    footprint: [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ],
    segment: {
      kind: "arc",
      center: { x: CELL + H, z: -H },
      radius: CELL + H,
      a0: Math.PI,
      a1: Math.PI / 2,
    },
    connectors: [
      { cell: [0, 0], dir: 2 },
      { cell: [1, 1], dir: 1 },
    ],
    kerbs: true,
  },
  hairpin: {
    type: "hairpin",
    label: "Hairpin",
    description: "180° hairpin over 2 cells. Brake hard or drift!",
    footprint: [
      [0, 0],
      [1, 0],
    ],
    segment: { kind: "arc", center: { x: H, z: -H }, radius: H, a0: Math.PI, a1: 0 },
    connectors: [
      { cell: [0, 0], dir: 2 },
      { cell: [1, 0], dir: 2 },
    ],
    kerbs: true,
  },
};

export const DIR_VEC: Record<Dir, [number, number]> = {
  0: [0, 1],
  1: [1, 0],
  2: [0, -1],
  3: [-1, 0],
};

/** Rotates a local (x, z) vector by rot × 90° around +Y (three.js convention). */
export function rotateVec(x: number, z: number, rot: number): [number, number] {
  switch (((rot % 4) + 4) % 4) {
    case 0:
      return [x, z];
    case 1:
      return [z, -x];
    case 2:
      return [-x, -z];
    default:
      return [-z, x];
  }
}

export function rotateDir(dir: Dir, rot: number): Dir {
  return ((((dir + rot) % 4) + 4) % 4) as Dir;
}

export function segmentLength(s: Segment): number {
  if (s.kind === "line") return Math.hypot(s.to.x - s.from.x, s.to.z - s.from.z);
  return Math.abs(s.a1 - s.a0) * s.radius;
}

/**
 * Samples a segment at roughly `step` spacing (always including both ends) in local space.
 * Returns the points and unit tangents in the direction connector A → B.
 */
export function sampleSegment(s: Segment, step: number): { points: Vec2[]; tangents: Vec2[] } {
  const len = segmentLength(s);
  const n = Math.max(1, Math.ceil(len / step));
  const points: Vec2[] = [];
  const tangents: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    if (s.kind === "line") {
      const dx = s.to.x - s.from.x;
      const dz = s.to.z - s.from.z;
      points.push({ x: s.from.x + dx * t, z: s.from.z + dz * t });
      tangents.push({ x: dx / len, z: dz / len });
    } else {
      const a = s.a0 + (s.a1 - s.a0) * t;
      const sign = Math.sign(s.a1 - s.a0);
      points.push({
        x: s.center.x + s.radius * Math.cos(a),
        z: s.center.z + s.radius * Math.sin(a),
      });
      tangents.push({ x: -Math.sin(a) * sign, z: Math.cos(a) * sign });
    }
  }
  return { points, tangents };
}
