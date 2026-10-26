import { describe, expect, it } from "vitest";
import { createDefaultTrack } from "@/game/track/defaultTrack";
import { CELL, LEVEL_HEIGHT, PIECES } from "@/game/track/pieces";
import {
  analyzeTrack,
  buildRacePath,
  groundHeight,
  isRaceable,
  pieceCenterline,
  queryTrack,
  trackId,
  worldConnectors,
  type TrackData,
} from "@/game/track/Track";
import { decodeTrack, encodeTrack, fromJson, toJson } from "@/game/track/TrackSerializer";

/** The default circuit with a crest on the main straight: ramp up, then ramp down. */
function crest(): TrackData {
  const t = createDefaultTrack();
  const up = t.pieces.findIndex((p) => p.x === 0 && p.z === 1);
  const down = t.pieces.findIndex((p) => p.x === 0 && p.z === 2);
  // Up: A (−z, level 0) → B (+z, level 1). Down: turned around, its B (−z) is level 1.
  t.pieces[up] = { type: "ramp", x: 0, z: 1, rot: 0 };
  t.pieces[down] = { type: "ramp", x: 0, z: 2, rot: 2 };
  return t;
}

describe("elevation", () => {
  it("connects ramps into a valid circuit with a crest", () => {
    const t = crest();
    const layout = analyzeTrack(t);
    expect(layout.issues).toEqual([]);
    expect(isRaceable(layout)).toBe(true);
  });

  it("gives a continuous, smooth height profile along the race path", () => {
    const t = crest();
    const layout = analyzeTrack(t);
    const path = buildRacePath(t, layout);
    const loop = path.pieces.filter((p) => p.order >= 0);
    let top = 0;
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i]!;
      const b = loop[(i + 1) % loop.length]!;
      // Same height where pieces join, and no step inside a piece.
      expect(Math.abs(a.heights.at(-1)! - b.heights[0]!)).toBeLessThan(1e-9);
      for (let k = 1; k < a.heights.length; k++) {
        expect(Math.abs(a.heights[k]! - a.heights[k - 1]!)).toBeLessThan(0.25);
        top = Math.max(top, a.heights[k]!);
      }
    }
    expect(top).toBeCloseTo(LEVEL_HEIGHT, 6);
  });

  it("reports the drivable height: road deck on the pieces, ground elsewhere", () => {
    const t = crest();
    const layout = analyzeTrack(t);
    const path = buildRacePath(t, layout);
    // Top of the crest is the joint between the two ramps (z = 1.5 cells).
    expect(groundHeight(layout, path, 0, CELL * 1.5)).toBeCloseTo(LEVEL_HEIGHT, 3);
    expect(groundHeight(layout, path, 0, CELL)).toBeCloseTo(LEVEL_HEIGHT / 2, 3);
    // Across the deck, out to the tire walls, and back to the ground beyond them.
    expect(groundHeight(layout, path, 5, CELL * 1.5)).toBeCloseTo(LEVEL_HEIGHT, 3);
    expect(groundHeight(layout, path, -7, CELL * 1.5)).toBe(0);
    // Climbing: positive grade in the race direction on the way up.
    expect(queryTrack(layout, path, 0, CELL * 0.9).grade).toBeGreaterThan(0);
    expect(queryTrack(layout, path, 0, CELL * 2.1).grade).toBeLessThan(0);
  });

  it("flags a height step between pieces that otherwise connect", () => {
    const t = crest();
    const i = t.pieces.findIndex((p) => p.x === 0 && p.z === 2);
    t.pieces[i] = { type: "straight", x: 0, z: 2, rot: 0 };
    const layout = analyzeTrack(t);
    expect(layout.closed).toBe(false);
    const step = layout.issues.find((x) => x.message.startsWith("Height step"));
    expect(step?.severity).toBe("error");
    expect(step?.cells).toContainEqual([0, 1]);
  });

  it("keeps pieces within the level range", () => {
    const t = createDefaultTrack();
    t.pieces[1] = { ...t.pieces[1]!, y: 9 };
    expect(analyzeTrack(t).issues.some((x) => x.message.includes("level"))).toBe(true);
  });

  it("mirrors a flipped piece left to right", () => {
    const corner = { type: "corner" as const, x: 0, z: 0, rot: 0 as const };
    expect(worldConnectors(corner).map((c) => c.dir)).toEqual([2, 1]);
    expect(worldConnectors({ ...corner, flip: true }).map((c) => c.dir)).toEqual([2, 3]);
    const line = pieceCenterline({ ...corner, flip: true });
    expect(line.points.at(-1)!.x).toBeCloseTo(-CELL / 2, 6);
  });

  it("builds a chicane whose two bends join smoothly and land one cell over", () => {
    const c = { type: "chicane" as const, x: 0, z: 0, rot: 0 as const };
    const { points, tangents } = pieceCenterline(c, 0.5);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!;
      const b = points[i]!;
      expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeLessThan(0.6);
      const ta = tangents[i - 1]!;
      const tb = tangents[i]!;
      expect(ta.x * tb.x + ta.z * tb.z).toBeGreaterThan(0.99);
    }
    expect(points[0]!.x).toBeCloseTo(0, 6);
    expect(points[0]!.z).toBeCloseTo(-CELL / 2, 6);
    expect(points.at(-1)!.x).toBeCloseTo(CELL, 6);
    expect(points.at(-1)!.z).toBeCloseTo(CELL * 1.5, 6);
    expect(PIECES.chicane.connectors[1]).toEqual({ cell: [1, 1], dir: 0 });
  });

  it("keeps the fingerprint of flat circuits, and changes it for any level change", () => {
    const flat = createDefaultTrack();
    const explicit = createDefaultTrack();
    explicit.pieces[3] = { ...explicit.pieces[3]!, y: 0, flip: false };
    expect(trackId(explicit)).toBe(trackId(flat));
    expect(trackId(crest())).not.toBe(trackId(flat));
    const raised = crest();
    raised.pieces[0] = { ...raised.pieces[0]!, y: 1 };
    expect(trackId(raised)).not.toBe(trackId(crest()));
  });

  it("round-trips levels and flips through JSON and links, and still reads version 1", () => {
    const t = crest();
    const i = t.pieces.findIndex((p) => p.x === 0 && p.z === 2);
    t.pieces[i] = { ...t.pieces[i]!, y: 0, flip: true };
    t.pieces.push({ type: "straight", x: 9, z: 9, rot: 1, y: 3 });
    const clean = (x: TrackData) => ({
      ...x,
      pieces: x.pieces.map((p) => {
        const out: Record<string, unknown> = { type: p.type, x: p.x, z: p.z, rot: p.rot };
        if (p.y) out.y = p.y;
        if (p.flip) out.flip = true;
        return out;
      }),
    });
    const json = fromJson(toJson(t));
    expect(json.ok && clean(json.track)).toEqual(clean(t));
    const link = decodeTrack(encodeTrack(t));
    expect(link.ok && clean(link.track)).toEqual(clean(t));
    // A flat circuit is still written (and read) as version 1.
    const flat = createDefaultTrack();
    expect(encodeTrack(flat).startsWith("AQ")).toBe(true);
    expect(decodeTrack(encodeTrack(flat))).toEqual({ ok: true, track: flat });
    // Version 1 JSON without levels.
    const v1 = JSON.stringify({
      format: "low-poly-karting",
      version: 1,
      name: "Old",
      pieces: flat.pieces.map((p) => [p.type, p.x, p.z, p.rot]),
      props: [],
    });
    expect(fromJson(v1).ok).toBe(true);
    // Hostile levels are rejected.
    const bad = JSON.stringify({
      format: "low-poly-karting",
      version: 2,
      name: "x",
      pieces: [["straight", 0, 0, 0, 99]],
      props: [],
    });
    expect(fromJson(bad)).toMatchObject({ ok: false });
  });
});
