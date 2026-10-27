import { describe, expect, it } from "vitest";
import {
  formatDelta,
  formatSplit,
  formatTime,
  RaceManager,
  type RaceEvent,
  type SectorResult,
} from "@/game/RaceManager";

const LENGTH = 300;

/** A race whose clock is running (out lap done). */
function timing(loop = 20, record: number | null = null, sectors?: (number | null)[]) {
  const r = new RaceManager(loop, record, LENGTH, sectors);
  r.start();
  expect(r.onLineCrossed(true, 0)).toEqual([{ type: "lapStart" }]);
  expect(r.phase).toBe("timing");
  return r;
}

/**
 * Drive one clean lap: visit every piece in order while the route distance advances, then cross
 * the line. `split` gives the share of the lap time spent in each sector (defaults to equal).
 */
function lap(
  r: RaceManager,
  loop: number,
  seconds: number,
  overshoot = 0,
  split: [number, number, number] = [1 / 3, 1 / 3, 1 / 3],
): RaceEvent[] {
  const events: RaceEvent[] = [];
  const steps = 600;
  const dt = seconds / steps;
  let dist = 0;
  for (let k = 1; k <= steps; k++) {
    // Time share -> distance: each sector covers a third of the route.
    const t = k / steps;
    let d: number;
    if (t <= split[0]) d = (t / split[0]) * (LENGTH / 3);
    else if (t <= split[0] + split[1]) d = LENGTH / 3 + ((t - split[0]) / split[1]) * (LENGTH / 3);
    else d = (2 * LENGTH) / 3 + ((t - split[0] - split[1]) / split[2]) * (LENGTH / 3);
    d = Math.min(d, LENGTH - 1e-6);
    r.tick(dt);
    r.onPiece(Math.min(loop - 1, Math.floor((d / LENGTH) * loop)));
    events.push(...r.onProgress(dist, d, dt));
    dist = d;
  }
  events.push(...r.onLineCrossed(true, overshoot));
  return events;
}

const lapOf = (events: RaceEvent[]) => events.find((e) => e.type === "lap");
const sectorsOf = (events: RaceEvent[]): SectorResult[] =>
  events.flatMap((e) => (e.type === "sector" ? [e.sector] : []));

describe("RaceManager", () => {
  it("starts on an out lap and starts the clock at the first forward crossing", () => {
    const r = new RaceManager(10, null);
    r.start();
    expect(r.phase).toBe("outLap");
    r.tick(5);
    expect(r.lapTime).toBe(0);
    expect(r.onLineCrossed(false, 0)).toEqual([]);
    expect(r.phase).toBe("outLap");
    expect(r.onLineCrossed(true, 0.003)).toEqual([{ type: "lapStart" }]);
    expect(r.lapTime).toBeCloseTo(0.003);
    expect(r.snapshot().lap).toBe(1);
  });

  it("times laps endlessly, subtracting the overshoot past the line", () => {
    const r = timing();
    for (let i = 0; i < 5; i++) {
      const e = lapOf(lap(r, 20, 30, 0.004));
      expect(e?.type).toBe("lap");
      if (e?.type === "lap") expect(e.time).toBeCloseTo(30, 2);
    }
    expect(r.laps).toHaveLength(5);
    expect(r.phase).toBe("timing");
    expect(r.snapshot().lap).toBe(6);
  });

  it("does not count a lap when crossing the line repeatedly", () => {
    const r = timing();
    for (let i = 0; i < 3; i++) {
      expect(r.onLineCrossed(false, 0)).toEqual([]);
      expect(r.onLineCrossed(true, 0)).toEqual([]);
    }
    expect(r.laps).toEqual([]);
  });

  it("voids the lap when reversing over the line after the checkpoints", () => {
    const r = timing();
    for (let i = 1; i < 20; i++) r.onPiece(i);
    r.onLineCrossed(false, 0);
    expect(r.onLineCrossed(true, 0)).toEqual([]);
    expect(r.laps).toEqual([]);
  });

  it("reports a missed checkpoint when a shortcut skips part of the circuit", () => {
    const r = timing();
    r.onPiece(r.checkpoints[0]!);
    r.tick(12);
    expect(r.onLineCrossed(true, 0.01)).toEqual([{ type: "missedCheckpoint" }]);
    expect(r.laps).toEqual([]);
    // Timing restarts cleanly from the line.
    expect(r.lapTime).toBeCloseTo(0.01);
    expect(r.snapshot().sector).toBe(0);
  });

  it("requires checkpoints in order", () => {
    const r = timing();
    for (const cp of [...r.checkpoints].reverse()) r.onPiece(cp);
    expect(r.onLineCrossed(true, 0)).toEqual([{ type: "missedCheckpoint" }]);
  });

  it("tracks session bests, deltas and the all-time record", () => {
    const r = timing(20, 31);
    const l1 = lapOf(lap(r, 20, 32));
    const l2 = lapOf(lap(r, 20, 29));
    const l3 = lapOf(lap(r, 20, 30));
    expect(l1).toMatchObject({ type: "lap", lap: 1, best: false, record: false });
    if (l1?.type === "lap") expect(l1.delta).toBeCloseTo(1);
    expect(l2).toMatchObject({ type: "lap", lap: 2, best: true, record: true });
    expect(l3).toMatchObject({ type: "lap", lap: 3, best: false, record: false });
    expect(r.recordLap).toBeCloseTo(29);
    expect(r.bestLap).toBeCloseTo(29);
  });

  it("gives lap deltas against the record (the ghost), not the session best", () => {
    // Back on a circuit lapped before: a session best that stays off the record.
    const r = timing(20, 25);
    lap(r, 20, 30);
    const l2 = lapOf(lap(r, 20, 28));
    expect(l2).toMatchObject({ type: "lap", best: true, record: false });
    if (l2?.type === "lap") expect(l2.delta).toBeCloseTo(3);
    expect(r.recordLap).toBeCloseTo(25);
    expect(r.bestLap).toBeCloseTo(28);
  });

  it("keeps session bests across restarts and ignores everything when off", () => {
    const r = timing();
    lap(r, 20, 25);
    r.start();
    expect(r.laps).toEqual([]);
    expect(r.bestLap).toBeCloseTo(25);
    r.stop();
    expect(r.onLineCrossed(true, 0)).toEqual([]);
    expect(r.onProgress(10, 200, 0.1)).toEqual([]);
    r.tick(3);
    expect(r.lapTime).toBe(0);
  });

  it("works on a tiny loop", () => {
    const r = timing(3);
    expect(r.checkpoints.length).toBeGreaterThan(0);
    expect(lap(r, 3, 10).map((e) => e.type)).toEqual(["sector", "sector", "sector", "lap"]);
  });
});

describe("sectors", () => {
  it("splits the lap into three sectors that add up exactly to the lap time", () => {
    const r = timing();
    const events = lap(r, 20, 30, 0.004, [0.3, 0.45, 0.25]);
    const s = sectorsOf(events);
    expect(s.map((x) => x.index)).toEqual([0, 1, 2]);
    expect(s[0]!.time).toBeCloseTo(9, 2);
    expect(s[1]!.time).toBeCloseTo(13.5, 2);
    expect(s[2]!.time).toBeCloseTo(7.5, 2);
    const l = lapOf(events);
    if (l?.type === "lap") expect(s[0]!.time + s[1]!.time + s[2]!.time).toBeCloseTo(l.time, 9);
    // Sector 1 and 2 come out while driving, sector 3 with the lap.
    expect(events.map((e) => e.type)).toEqual(["sector", "sector", "sector", "lap"]);
  });

  it("is neutral the first time, then purple / green / yellow against the bests", () => {
    const r = timing();
    expect(sectorsOf(lap(r, 20, 30)).map((s) => s.status)).toEqual([
      "neutral",
      "neutral",
      "neutral",
    ]);
    // Slower everywhere: yellow, deltas against the best.
    const slow = sectorsOf(lap(r, 20, 33));
    expect(slow.map((s) => s.status)).toEqual(["yellow", "yellow", "yellow"]);
    expect(slow[0]!.delta).toBeCloseTo(1, 2);
    // Faster S1 only: purple there.
    const mixed = sectorsOf(lap(r, 20, 30, 0, [0.3, 0.35, 0.35]));
    expect(mixed.map((s) => s.status)).toEqual(["purple", "yellow", "yellow"]);
    expect(mixed[0]!.delta).toBeCloseTo(-1, 2);
    expect(r.bestSectors[0]).toBeCloseTo(9, 2);
  });

  it("shows green for a session improvement that does not beat the stored best", () => {
    // Stored bests from an earlier session: 9 s each.
    const r = timing(20, 27, [9, 9, 9]);
    lap(r, 20, 33); // 11 s each: yellow, sets the session bests
    const s = sectorsOf(lap(r, 20, 30)); // 10 s each: better than session, worse than stored
    expect(s.map((x) => x.status)).toEqual(["green", "green", "green"]);
    expect(s[0]!.delta).toBeCloseTo(1, 2);
    expect(r.bestSectors).toEqual([9, 9, 9]);
  });

  it("counts each boundary once, ignores jumps, and stops after reversing over the line", () => {
    const r = timing();
    r.tick(5);
    // A reset that teleports the kart far along the route does not trigger sectors.
    expect(r.onProgress(10, 150, 1 / 60)).toEqual([]);
    expect(r.onProgress(99, 101, 1 / 60).map((e) => e.type)).toEqual(["sector"]);
    // Rocking back and forth over the boundary does not repeat it.
    expect(r.onProgress(101, 99, 1 / 60)).toEqual([]);
    expect(r.onProgress(99, 101, 1 / 60)).toEqual([]);
    // Backwards over the finish line: the lap is void, no more sectors.
    r.onLineCrossed(false, 0);
    expect(r.onProgress(199, 201, 1 / 60)).toEqual([]);
    expect(r.snapshot().sector).toBe(-1);
  });

  it("interpolates the crossing time inside the physics step", () => {
    const r = timing();
    r.tick(10);
    const e = r.onProgress(99, 101, 0.1)[0];
    // Boundary at 100, halfway through the 0.1 s step.
    if (e?.type === "sector") expect(e.sector.time).toBeCloseTo(9.95, 9);
  });
});

describe("formatting", () => {
  it("formats minutes, seconds and milliseconds", () => {
    expect(formatTime(83.4567)).toBe("1:23.457");
    expect(formatTime(5.1)).toBe("0:05.100");
    expect(formatTime(null)).toBe("–:––.–––");
  });

  it("formats sector splits and deltas", () => {
    expect(formatSplit(24.5821)).toBe("24.582");
    expect(formatSplit(64.5)).toBe("1:04.500");
    expect(formatDelta(-0.1834)).toBe("−0.183");
    expect(formatDelta(0.2)).toBe("+0.200");
    expect(formatDelta(null)).toBe("");
  });
});
