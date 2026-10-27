import { describe, expect, it } from "vitest";
import { CIRCUITS } from "@/game/track/circuits";
import { analyzeTrack, isRaceable, trackId } from "@/game/track/Track";
import { drive } from "./helpers/autopilot";

describe("built-in circuits", () => {
  it("have unique ids, names and layouts", () => {
    const tracks = CIRCUITS.map((c) => c.create());
    expect(new Set(CIRCUITS.map((c) => c.id)).size).toBe(CIRCUITS.length);
    expect(new Set(tracks.map((t) => t.name)).size).toBe(CIRCUITS.length);
    expect(new Set(tracks.map(trackId)).size).toBe(CIRCUITS.length);
  });

  for (const c of CIRCUITS) {
    it(`${c.id} is a single closed, valid loop`, () => {
      const t = c.create();
      const layout = analyzeTrack(t);
      expect(layout.issues).toEqual([]);
      expect(layout.closed).toBe(true);
      expect(layout.order).toHaveLength(t.pieces.length);
      expect(isRaceable(layout)).toBe(true);
    });

    // Simulates two full laps: slow when the other test files run in parallel.
    it(`${c.id} can be lapped by the autopilot`, () => {
      const { times } = drive(c.create(), 2);
      expect(times).toHaveLength(2);
    }, 30_000);
  }
});
