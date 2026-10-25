import { describe, expect, it } from "vitest";
import { createDefaultTrack } from "@/game/track/defaultTrack";
import { eraseAt, History, placePiece, placeProp } from "@/game/track/editing";
import { CELL } from "@/game/track/pieces";
import { analyzeTrack, isRaceable, type TrackData } from "@/game/track/Track";

const empty = (): TrackData => ({ version: 1, name: "t", pieces: [], props: [] });

function must(r: ReturnType<typeof placePiece>): TrackData {
  if (!r.ok) throw new Error(r.reason);
  return r.track;
}

describe("editing", () => {
  it("builds a raceable oval piece by piece", () => {
    // Stadium: start + straight up x = 0, hairpins at both ends, two straights back down x = −1.
    let t = empty();
    t = must(placePiece(t, "start", 0, 0, 0));
    t = must(placePiece(t, "straight", 0, 1, 0));
    t = must(placePiece(t, "hairpin", -1, 2, 0));
    t = must(placePiece(t, "straight", -1, 1, 0));
    t = must(placePiece(t, "straight", -1, 0, 0));
    t = must(placePiece(t, "hairpin", 0, -1, 2));
    const layout = analyzeTrack(t);
    expect(layout.issues).toEqual([]);
    expect(isRaceable(layout)).toBe(true);
  });

  it("replaces a single overlapped piece, and refuses to overlap several", () => {
    let t = must(placePiece(empty(), "straight", 0, 0, 0));
    const replaced = placePiece(t, "corner", 0, 0, 1);
    expect(replaced.ok && replaced.note).toBe("Replaced a piece");
    t = must(placePiece(t, "straight", 1, 0, 0));
    const sweeper = placePiece(t, "wideCorner", 0, 0, 0);
    expect(sweeper).toEqual({ ok: false, reason: "Overlaps several pieces (erase them first)" });
  });

  it("refuses an identical piece and pieces outside the build area", () => {
    const t = must(placePiece(empty(), "straight", 0, 0, 0));
    expect(placePiece(t, "straight", 0, 0, 0)).toMatchObject({ ok: false });
    expect(placePiece(t, "straight", 999, 0, 0)).toEqual({
      ok: false,
      reason: "Outside the build area",
    });
  });

  it("keeps a single start line by moving it", () => {
    let t = must(placePiece(empty(), "start", 0, 0, 0));
    const r = placePiece(t, "start", 3, 3, 1);
    expect(r.ok && r.note).toBe("Start line moved");
    t = must(r);
    expect(t.pieces.filter((p) => p.type === "start")).toEqual([
      { type: "start", x: 3, z: 3, rot: 1 },
    ]);
  });

  it("snaps props, prevents stacking them, and erases props before pieces", () => {
    let t = must(placePiece(empty(), "straight", 0, 0, 0));
    const r = placeProp(t, "cone", 1.26, -0.74);
    expect(r.ok).toBe(true);
    t = must(r);
    expect(t.props[0]).toEqual({ type: "cone", x: 1.5, z: -0.5, rot: 0 });
    expect(placeProp(t, "tires", 1.6, -0.4)).toEqual({
      ok: false,
      reason: "Too close to another prop",
    });
    t = must(eraseAt(t, 1.5, -0.5));
    expect(t.props).toHaveLength(0);
    expect(t.pieces).toHaveLength(1);
    t = must(eraseAt(t, 2, CELL * 0.3));
    expect(t.pieces).toHaveLength(0);
    expect(eraseAt(t, 0, 0)).toEqual({ ok: false, reason: "Nothing to erase here" });
  });

  it("never mutates the input track", () => {
    const t = createDefaultTrack();
    const before = JSON.stringify(t);
    placePiece(t, "straight", 20, 20, 0);
    eraseAt(t, 0, 0);
    placeProp(t, "cone", 40, 40);
    expect(JSON.stringify(t)).toBe(before);
  });
});

describe("History", () => {
  it("undoes and redoes, and drops the redo branch on a new edit", () => {
    const h = new History();
    const a = empty();
    const b = must(placePiece(a, "straight", 0, 0, 0));
    const c = must(placePiece(b, "straight", 0, 1, 0));
    h.push(a);
    h.push(b);
    expect(h.undo(c)).toEqual(b);
    expect(h.undo(b)).toEqual(a);
    expect(h.canUndo).toBe(false);
    expect(h.redo(a)).toEqual(b);
    h.push(b);
    expect(h.canRedo).toBe(false);
  });
});
