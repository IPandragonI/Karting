import { describe, expect, it } from "vitest";
import { createDefaultTrack } from "@/game/track/defaultTrack";
import { CELL, ROAD_HALF } from "@/game/track/pieces";
import {
  analyzeTrack,
  buildRacePath,
  isRaceable,
  queryTrack,
  startGrid,
  type TrackData,
} from "@/game/track/Track";

const track = (pieces: TrackData["pieces"]): TrackData => ({
  version: 1,
  name: "t",
  pieces,
  props: [],
});

describe("default track", () => {
  it("is a single closed, valid loop that visits every piece", () => {
    const t = createDefaultTrack();
    const layout = analyzeTrack(t);
    expect(layout.issues).toEqual([]);
    expect(layout.closed).toBe(true);
    expect(layout.order).toHaveLength(t.pieces.length);
    expect(isRaceable(layout)).toBe(true);
  });

  it("has a continuous centerline in race order", () => {
    const t = createDefaultTrack();
    const layout = analyzeTrack(t);
    const path = buildRacePath(t, layout);
    const loop = path.pieces.filter((p) => p.order >= 0);
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i]!;
      const b = loop[(i + 1) % loop.length]!;
      const end = a.points[a.points.length - 1]!;
      const start = b.points[0]!;
      expect(Math.hypot(end.x - start.x, end.z - start.z)).toBeLessThan(1e-6);
      // Tangents line up at the joint too.
      const ta = a.tangents[a.tangents.length - 1]!;
      const tb = b.tangents[0]!;
      expect(ta.x * tb.x + ta.z * tb.z).toBeGreaterThan(0.999);
    }
    expect(path.totalLength).toBeGreaterThan(200);
  });

  it("spawns on the road, facing the race direction", () => {
    const t = createDefaultTrack();
    const layout = analyzeTrack(t);
    const path = buildRacePath(t, layout);
    const s = startGrid(t, layout);
    const q = queryTrack(layout, path, s.x, s.z);
    expect(q.onRoad).toBe(true);
    expect(q.piece?.order).toBe(0);
    expect(Math.sin(s.yaw) * q.tangent.x + Math.cos(s.yaw) * q.tangent.z).toBeCloseTo(1);
  });
});

describe("validation", () => {
  it("reports an empty track and a missing start", () => {
    expect(analyzeTrack(track([])).issues.map((i) => i.message)).toContain("The track is empty");
    const noStart = analyzeTrack(track([{ type: "straight", x: 0, z: 0, rot: 0 }]));
    expect(noStart.issues.map((i) => i.message)).toContain("Add a Start / Finish piece");
  });

  it("reports open ends on a disconnected start", () => {
    const layout = analyzeTrack(track([{ type: "start", x: 0, z: 0, rot: 0 }]));
    expect(layout.closed).toBe(false);
    expect(layout.openEnds).toHaveLength(2);
    expect(layout.issues.some((i) => i.message === "The circuit has open ends")).toBe(true);
  });

  it("reports overlapping pieces", () => {
    const layout = analyzeTrack(
      track([
        { type: "start", x: 0, z: 0, rot: 0 },
        { type: "wideCorner", x: -1, z: 0, rot: 0 },
      ]),
    );
    expect(layout.issues.some((i) => i.message.includes("overlapping"))).toBe(true);
  });

  it("detects a road running into the side of a piece", () => {
    const layout = analyzeTrack(
      track([
        { type: "start", x: 0, z: 0, rot: 0 },
        { type: "straight", x: 0, z: 1, rot: 1 },
      ]),
    );
    expect(layout.issues.some((i) => i.message.startsWith("Road runs into the side"))).toBe(true);
  });

  it("rejects more than one start", () => {
    const t = createDefaultTrack();
    const two = {
      ...t,
      pieces: [
        ...t.pieces.slice(0, 1),
        { ...t.pieces[1]!, type: "start" as const },
        ...t.pieces.slice(2),
      ],
    };
    expect(analyzeTrack(two).issues.map((i) => i.message)).toContain(
      "Only one Start / Finish piece is allowed",
    );
  });

  it("runs the circuit in reverse when the start piece is turned around", () => {
    const t = createDefaultTrack();
    const reversed = { ...t, pieces: [{ ...t.pieces[0]!, rot: 2 as const }, ...t.pieces.slice(1)] };
    const layout = analyzeTrack(reversed);
    expect(isRaceable(layout)).toBe(true);
    // The first piece after the start is now the corner that used to lead into it.
    expect(reversed.pieces[layout.order[1]!.index]!).toMatchObject({ type: "corner", x: 0, z: -1 });
  });

  it("flags stray pieces as a warning without blocking the race", () => {
    const t = createDefaultTrack();
    t.pieces.push({ type: "straight", x: 10, z: 10, rot: 0 });
    const layout = analyzeTrack(t);
    expect(isRaceable(layout)).toBe(true);
    expect(layout.issues.find((i) => i.severity === "warning")?.message).toMatch(
      /not part of the circuit/,
    );
  });
});

describe("queryTrack", () => {
  it("measures lateral distance from the centerline and road edges", () => {
    const t = track([{ type: "straight", x: 0, z: 0, rot: 0 }]);
    const layout = analyzeTrack(t);
    const path = buildRacePath(t, layout);
    expect(queryTrack(layout, path, 1, 2).lateral).toBeCloseTo(1);
    expect(queryTrack(layout, path, ROAD_HALF + 0.5, 0).onRoad).toBe(false);
    expect(queryTrack(layout, path, CELL * 3, 0).piece).toBeNull();
  });
});
