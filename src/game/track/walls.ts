import type { WallSegment } from "../Physics";
import { CELL, PIECES, WALL_OFFSET, type Vec2 } from "./pieces";
import {
  cellKey,
  levelRange,
  pieceCenterline,
  type PieceData,
  type TrackData,
  type TrackLayout,
} from "./Track";

// Wall colliders of a circuit, from the same centerlines the road is built from. Pure (no
// three.js): the browser's renderer and physics and the server's lap replay build exactly the
// same walls, in the same order.

/** Deck edge of raised road: just outside the tire walls (where the verge ends). */
export const DECK_EDGE = WALL_OFFSET + 0.55;

/** Right-hand normal of a tangent (matches the kart's right vector). */
export const right = (t: Vec2): Vec2 => ({ x: -t.z, z: t.x });

/**
 * For each centerline point of a raised piece: whether it passes over another road there (a lower
 * piece in the same cell). Over a road the piece is a bridge: no retaining wall down to the ground.
 */
export function overRoadMask(
  track: TrackData,
  layout: TrackLayout,
  pieceIndex: number,
  points: Vec2[],
): boolean[] {
  const [lo] = levelRange(track.pieces[pieceIndex]!);
  return points.map((p) =>
    (layout.occupancy.get(cellKey(Math.round(p.x / CELL), Math.round(p.z / CELL))) ?? []).some(
      (j) => j !== pieceIndex && levelRange(track.pieces[j]!)[1] < lo,
    ),
  );
}

function pieceWalls(
  track: TrackData,
  layout: TrackLayout,
  pieceIndex: number,
  piece: PieceData,
  out: WallSegment[],
) {
  const def = PIECES[piece.type];
  const { points, tangents, heights } = pieceCenterline(piece, 1);

  // Tire walls on both sides: one box on flat straights, every 2 m along curves and slopes,
  // tilted with the road.
  const straight = def.rise === 0 && def.segments.every((g) => g.kind === "line");
  for (const side of [-1, 1]) {
    const o = side * WALL_OFFSET;
    const wall = points.map((p, i) => {
      const n = right(tangents[i]!);
      return { x: p.x + n.x * o, y: heights[i]!, z: p.z + n.z * o };
    });
    const colliderStep = straight ? wall.length - 1 : 2;
    for (let i = 0; i < wall.length - 1; i += colliderStep) {
      const a = wall[i]!;
      const b = wall[Math.min(i + colliderStep, wall.length - 1)]!;
      out.push({ x1: a.x, z1: a.z, x2: b.x, z2: b.z, y1: a.y, y2: b.y });
    }
  }

  // Raised road: retaining walls from the ground up to the deck, every 2 m on both sides (a kart
  // on the grass beside a raised section hits them instead of being lifted on top). None where
  // the piece is a bridge over another road.
  if (!heights.some((h) => h > 0.01)) return;
  const overRoad = overRoadMask(track, layout, pieceIndex, points);
  for (const side of [-1, 1]) {
    const o = side * DECK_EDGE;
    for (let i = 1; i < points.length; i++) {
      if (i % 2 !== 0 && i !== points.length - 1) continue;
      const j = i % 2 === 0 ? i - 2 : i - 1;
      if (overRoad[i] || overRoad[j]) continue;
      const p = points[i]!;
      const n = right(tangents[i]!);
      const q = points[j]!;
      const m = right(tangents[j]!);
      out.push({
        x1: q.x + m.x * o,
        z1: q.z + m.z * o,
        x2: p.x + n.x * o,
        z2: p.z + n.z * o,
        height: Math.max(heights[i]!, heights[j]!) + 0.05,
      });
    }
  }
}

/** Every wall collider of a circuit, piece by piece in track order. */
export function trackWalls(track: TrackData, layout: TrackLayout): WallSegment[] {
  const out: WallSegment[] = [];
  track.pieces.forEach((piece, i) => pieceWalls(track, layout, i, piece, out));
  return out;
}
