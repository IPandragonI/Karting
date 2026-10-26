import { describe, expect, it } from "vitest";
import { changeLevel, makePiece, pieceAt, placePiece } from "@/game/track/editing";
import { CELL, LEVEL_HEIGHT, type PieceType, type Rot } from "@/game/track/pieces";
import {
  analyzeTrack,
  buildRacePath,
  ceilingHeight,
  DECK_DEPTH,
  groundHeight,
  isRaceable,
  queryTrack,
  type TrackData,
} from "@/game/track/Track";

const p = (type: PieceType, x: number, z: number, rot: Rot, y = 0) =>
  makePiece(type, x, z, rot, { y });

/**
 * Figure-8 with an overpass: north along x = 0 at ground level (through the crossing cell 0,0),
 * up a ramp, round to the east, back west over the start straight on a bridge at level 1, down
 * a ramp and home.
 */
function figure8(): TrackData {
  return {
    version: 1,
    name: "Figure 8",
    props: [],
    pieces: [
      p("start", 0, -1, 0),
      p("straight", 0, 0, 0),
      p("straight", 0, 1, 0),
      p("ramp", 0, 2, 0),
      p("corner", 0, 3, 0, 1),
      p("straight", 1, 3, 1, 1),
      p("corner", 2, 3, 1, 1),
      p("straight", 2, 2, 0, 1),
      p("straight", 2, 1, 0, 1),
      p("corner", 2, 0, 2, 1),
      p("straight", 1, 0, 1, 1),
      p("straight", 0, 0, 1, 1), // the bridge over (0, 0)
      p("straight", -1, 0, 1, 1),
      p("corner", -2, 0, 0, 1),
      p("ramp", -2, -1, 0),
      p("corner", -2, -2, 3),
      p("straight", -1, -2, 1),
      p("corner", 0, -2, 2),
    ],
  };
}

const LOWER = 1; // index of the ground-level straight in cell (0, 0)
const BRIDGE = 11;

describe("multi-level circuits", () => {
  it("accepts two roads in one cell a level apart, as one closed circuit through both", () => {
    const t = figure8();
    const layout = analyzeTrack(t);
    expect(layout.issues).toEqual([]);
    expect(isRaceable(layout)).toBe(true);
    expect(layout.order).toHaveLength(t.pieces.length);
    expect(layout.occupancy.get("0,0")?.sort()).toEqual([LOWER, BRIDGE]);
  });

  it("drives on the level the kart is on: under the bridge, on it, never through it", () => {
    const t = figure8();
    const layout = analyzeTrack(t);
    const path = buildRacePath(t, layout);
    expect(queryTrack(layout, path, 0, 0, 0).piece?.pieceIndex).toBe(LOWER);
    expect(queryTrack(layout, path, 0, 0, LEVEL_HEIGHT).piece?.pieceIndex).toBe(BRIDGE);
    expect(groundHeight(layout, path, 0, 0, 0)).toBe(0);
    expect(groundHeight(layout, path, 0, 0, LEVEL_HEIGHT)).toBeCloseTo(LEVEL_HEIGHT, 6);
    // Slightly airborne over the bridge: still the bridge, not the road below.
    expect(groundHeight(layout, path, 0.5, 0.5, LEVEL_HEIGHT + 0.6)).toBeCloseTo(LEVEL_HEIGHT, 6);
    // The deck above the lower road, and open sky above the bridge.
    expect(ceilingHeight(layout, path, 0, 0, 0)).toBeCloseTo(LEVEL_HEIGHT - DECK_DEPTH, 6);
    expect(ceilingHeight(layout, path, 0, 0, LEVEL_HEIGHT)).toBe(Infinity);
    // Race progress follows the route: the two passes through the cell are far apart on the lap.
    const under = queryTrack(layout, path, 0, 0, 0).distance;
    const over = queryTrack(layout, path, 0, 0, LEVEL_HEIGHT).distance;
    expect(Math.abs(over - under)).toBeGreaterThan(CELL * 5);
  });

  it("keeps the route continuous in plan and in height across the levels", () => {
    const t = figure8();
    const layout = analyzeTrack(t);
    const path = buildRacePath(t, layout);
    const loop = path.pieces.filter((x) => x.order >= 0).sort((a, b) => a.order - b.order);
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i]!;
      const b = loop[(i + 1) % loop.length]!;
      const end = a.points.at(-1)!;
      expect(Math.hypot(end.x - b.points[0]!.x, end.z - b.points[0]!.z)).toBeLessThan(1e-6);
      expect(Math.abs(a.heights.at(-1)! - b.heights[0]!)).toBeLessThan(1e-9);
    }
  });

  it("still rejects pieces too close vertically, and steps between levels", () => {
    const t = figure8();
    // A level-1 road in the cell of the ramp (levels 0–1): they would intersect.
    t.pieces[BRIDGE] = p("straight", 0, 2, 1, 1);
    expect(analyzeTrack(t).issues.some((i) => i.message.includes("overlapping"))).toBe(true);
    // A ground road meeting the bridge's open end is a height step, not a junction.
    const s = figure8();
    s.pieces[BRIDGE - 1] = p("straight", 1, 0, 1, 0);
    expect(analyzeTrack(s).issues.some((i) => i.message.startsWith("Height step"))).toBe(true);
  });

  it("lets the editor build over and under a road, and pick the piece on the working level", () => {
    let t: TrackData = { version: 1, name: "t", pieces: [], props: [] };
    const must = (r: ReturnType<typeof placePiece>) => {
      if (!r.ok) throw new Error(r.reason);
      return r.track;
    };
    t = must(placePiece(t, "straight", 0, 0, 0));
    // Over it, a level up: both stay.
    t = must(placePiece(t, "straight", 0, 0, 1, { y: 1 }));
    expect(t.pieces).toHaveLength(2);
    // Same level as an existing piece: replaces it.
    t = must(placePiece(t, "corner", 0, 0, 0, { y: 1 }));
    expect(t.pieces).toHaveLength(2);
    expect(t.pieces.find((x) => x.type === "corner")?.y).toBe(1);
    // A ramp spanning levels 0–1 cannot share the cell with either.
    expect(placePiece(t, "ramp", 0, 0, 0)).toMatchObject({ ok: false });
    expect(pieceAt(t, 0, 0, 0)).toBe(t.pieces.findIndex((x) => x.type === "straight"));
    expect(pieceAt(t, 0, 0, 1)).toBe(t.pieces.findIndex((x) => x.type === "corner"));
    // Lowering the upper piece onto the lower one is refused.
    expect(changeLevel(t, 0, 0, -1, 1)).toMatchObject({
      ok: false,
      reason: "A road passes just below",
    });
    expect(changeLevel(t, 0, 0, 1, 1)).toMatchObject({ ok: true });
  });
});
