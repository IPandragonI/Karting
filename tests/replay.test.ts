import { describe, expect, it } from "vitest";
import { replay } from "@/game/sim/replay";
import { decodeTrace } from "@/game/sim/trace";
import { createDefaultTrack } from "@/game/track/defaultTrack";
import type { TrackData } from "@/game/track/Track";
import { drive } from "./helpers/autopilot";

describe("deterministic replay", () => {
  const track = createDefaultTrack();
  const session = drive(track, 2);

  it("drives real laps with the autopilot", () => {
    expect(session.times).toHaveLength(2);
    for (const t of session.times) expect(t).toBeGreaterThan(10);
  });

  it("replays a recorded session to exactly the same lap times", () => {
    const t0 = performance.now();
    const r = replay(track, decodeTrace(session.trace));
    const ms = performance.now() - t0;
    expect(r.laps.map((l) => l.time)).toEqual(session.times);
    // Sector splits add up to the lap.
    for (const l of r.laps) {
      expect(l.sectors).toHaveLength(3);
      expect(l.sectors.reduce((a, b) => a + b, 0)).toBeCloseTo(l.time, 9);
    }
    console.log(
      `replay: ${r.steps} steps in ${ms.toFixed(0)} ms (${(ms / r.steps).toFixed(3)} ms/step)`,
    );
  });

  it("does not depend on the order pieces and props are listed in", () => {
    const shuffled: TrackData = {
      ...track,
      pieces: [...track.pieces].reverse(),
      props: [...track.props].reverse(),
    };
    expect(replay(shuffled, decodeTrace(session.trace)).laps.map((l) => l.time)).toEqual(
      session.times,
    );
  });

  it("replays long, wall-scraping sessions identically, whatever ran before in the process", () => {
    // Collisions amplify the smallest difference: any state leaking between physics worlds
    // shows up here as lost or different laps.
    const scraping = drive(track, 5, 3.6, 5, 60 * 60 * 6);
    expect(scraping.times.length).toBeGreaterThanOrEqual(3);
    drive(track, 1, -3, 4); // another session in between
    const r = replay(track, decodeTrace(scraping.trace));
    expect(r.laps.map((l) => l.time)).toEqual(scraping.times);
  });

  it("stops after the requested lap", () => {
    const r = replay(track, decodeTrace(session.trace), 1);
    expect(r.laps).toHaveLength(1);
    expect(r.steps).toBeLessThan(session.steps);
  });

  it("rejects malformed or inconsistent traces", () => {
    expect(() => decodeTrace("")).toThrow();
    expect(() => decodeTrace("not base64!")).toThrow();
    // Claimed step count different from the runs it contains.
    const bin = atob(session.trace);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    new DataView(bytes.buffer).setUint32(3, 5);
    expect(() => decodeTrace(btoa(String.fromCharCode(...bytes)))).toThrow();
  });
});
