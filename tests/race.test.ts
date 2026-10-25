import { describe, expect, it } from "vitest";
import {
  COUNTDOWN_LIGHT_INTERVAL,
  COUNTDOWN_LIGHTS,
  formatTime,
  RaceManager,
  type RaceEvent,
} from "@/game/RaceManager";

function started(loop = 20, laps = 3, record: number | null = null) {
  const r = new RaceManager(loop, laps, record);
  r.startCountdown();
  r.tick((COUNTDOWN_LIGHTS + 1) * COUNTDOWN_LIGHT_INTERVAL + 0.01);
  expect(r.phase).toBe("racing");
  return r;
}

/** Drive one clean lap: visit every piece in order, then cross the line. */
function lap(r: RaceManager, loop: number, seconds: number, overshoot = 0): RaceEvent[] {
  for (let i = 1; i < loop; i++) {
    r.onPiece(i);
    r.tick(seconds / loop);
  }
  r.tick(seconds / loop);
  return r.onLineCrossed(true, overshoot);
}

describe("RaceManager", () => {
  it("runs the light countdown before GO", () => {
    const r = new RaceManager(10, 3, null);
    r.startCountdown();
    const events: RaceEvent[] = [];
    for (let t = 0; t < 5; t += 0.05) events.push(...r.tick(0.05));
    expect(events.filter((e) => e.type === "countdown")).toHaveLength(COUNTDOWN_LIGHTS);
    expect(events.at(-1)).toEqual({ type: "go" });
  });

  it("ignores the standing-start crossing right after GO", () => {
    const r = started();
    expect(r.onLineCrossed(true, 0)).toEqual([]);
    expect(r.laps).toEqual([]);
  });

  it("times a clean lap, subtracting the overshoot past the line", () => {
    const r = started();
    const events = lap(r, 20, 30, 0.004);
    const e = events[0];
    expect(e?.type).toBe("lap");
    if (e?.type === "lap") expect(e.time).toBeCloseTo(30 - 0.004, 6);
    expect(r.lapTime).toBeCloseTo(0.004);
  });

  it("does not count a lap when crossing the line repeatedly", () => {
    const r = started();
    r.onLineCrossed(true, 0);
    r.onLineCrossed(false, 0);
    r.onLineCrossed(true, 0);
    r.onLineCrossed(false, 0);
    r.onLineCrossed(true, 0);
    expect(r.laps).toEqual([]);
  });

  it("voids the lap when reversing over the line after the checkpoints", () => {
    const r = started();
    for (let i = 1; i < 20; i++) r.onPiece(i);
    r.onLineCrossed(false, 0);
    expect(r.onLineCrossed(true, 0)).toEqual([]);
    expect(r.laps).toEqual([]);
  });

  it("reports a missed checkpoint when a shortcut skips part of the circuit", () => {
    const r = started();
    r.onPiece(r.checkpoints[0]!);
    // Skips the remaining checkpoints.
    expect(r.onLineCrossed(true, 0)).toEqual([{ type: "missedCheckpoint" }]);
    expect(r.laps).toEqual([]);
  });

  it("requires checkpoints in order", () => {
    const r = started();
    for (const cp of [...r.checkpoints].reverse()) r.onPiece(cp);
    expect(r.onLineCrossed(true, 0)).toEqual([{ type: "missedCheckpoint" }]);
  });

  it("tracks best laps and deltas, and finishes after the last lap with a record", () => {
    const r = started(20, 3, 31);
    const l1 = lap(r, 20, 32)[0];
    const l2 = lap(r, 20, 29)[0];
    const end = lap(r, 20, 30);
    expect(l1).toMatchObject({ type: "lap", lap: 1, best: false });
    if (l1?.type === "lap") expect(l1.delta).toBeCloseTo(1);
    expect(l2).toMatchObject({ type: "lap", lap: 2, best: true });
    expect(end.map((e) => e.type)).toEqual(["lap", "finish"]);
    const finish = end[1];
    expect(finish).toMatchObject({ type: "finish", newRecord: true });
    if (finish?.type === "finish") {
      expect(finish.bestLap).toBeCloseTo(29);
      expect(finish.total).toBeCloseTo(91, 5);
    }
    expect(r.phase).toBe("finished");
    expect(r.recordLap).toBeCloseTo(29);
  });

  it("works on a tiny loop", () => {
    const r = started(3, 1);
    expect(r.checkpoints.length).toBeGreaterThan(0);
    expect(lap(r, 3, 10).map((e) => e.type)).toEqual(["lap", "finish"]);
  });
});

describe("formatTime", () => {
  it("formats minutes, seconds and milliseconds", () => {
    expect(formatTime(83.4567)).toBe("1:23.457");
    expect(formatTime(5.1)).toBe("0:05.100");
    expect(formatTime(null)).toBe("–:––.–––");
  });
});
