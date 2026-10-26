import { describe, expect, it } from "vitest";
import {
  buildReference,
  decodeGhost,
  referenceTime,
  encodeGhost,
  GHOST_RATE,
  GhostRecorder,
  sampleGhost,
  type GhostPose,
} from "@/game/Ghost";

const DT = 1 / 60;

/** Records a lap of `seconds` on a circle of radius 20, starting `overshoot` past the line. */
function recordCircle(seconds: number, overshoot = 0.004, dt = DT) {
  const r = new GhostRecorder();
  const pose = (t: number) => {
    const a = (t / seconds) * Math.PI * 2;
    return [Math.sin(a) * 20, 0.5, 20 - Math.cos(a) * 20, wrap(a)] as const;
  };
  let t = overshoot - dt;
  r.begin(t, ...pose(t));
  while (t < seconds) {
    t += dt;
    r.push(t, ...pose(t));
  }
  return { r, pose };
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

describe("ghost", () => {
  it("records on a fixed time grid and plays the lap back in sync with the lap clock", () => {
    const { r, pose } = recordCircle(30);
    const lap = r.finish(30)!;
    expect(lap).not.toBeNull();
    expect(lap.samples.length / 4).toBeGreaterThanOrEqual(30 * GHOST_RATE);
    const out: GhostPose = { x: 0, y: 0, z: 0, yaw: 0 };
    for (const t of [0, 0.37, 7.5, 15.02, 29.99]) {
      expect(sampleGhost(lap, t, out)).toBe(true);
      const [x, , z, yaw] = pose(t);
      expect(Math.hypot(out.x - x, out.z - z)).toBeLessThan(0.05);
      expect(Math.abs(wrap(out.yaw - yaw))).toBeLessThan(0.01);
    }
  });

  it("gives the same ghost whatever the physics rate", () => {
    const a = recordCircle(10, 0, 1 / 60).r.finish(10)!;
    const b = recordCircle(10, 0, 1 / 120).r.finish(10)!;
    const pa: GhostPose = { x: 0, y: 0, z: 0, yaw: 0 };
    const pb: GhostPose = { ...pa };
    sampleGhost(a, 4.2, pa);
    sampleGhost(b, 4.2, pb);
    expect(Math.hypot(pa.x - pb.x, pa.z - pb.z)).toBeLessThan(0.01);
  });

  it("interpolates yaw across ±π without spinning", () => {
    const r = new GhostRecorder();
    r.begin(-DT, 0, 0, 0, Math.PI - 0.01);
    for (let k = 1; k <= 60; k++) r.push(k * DT, 0, 0, k * 0.1, Math.PI - 0.01 + k * 0.001);
    const lap = r.finish(1)!;
    const out: GhostPose = { x: 0, y: 0, z: 0, yaw: 0 };
    for (let t = 0; t < 1; t += 0.013) {
      sampleGhost(lap, t, out);
      expect(Math.abs(Math.abs(out.yaw) - Math.PI)).toBeLessThan(0.07);
    }
  });

  it("is hidden outside the lap and refuses incomplete or cancelled laps", () => {
    const { r } = recordCircle(5);
    const lap = r.finish(5)!;
    const out: GhostPose = { x: 0, y: 0, z: 0, yaw: 0 };
    expect(sampleGhost(lap, -0.1, out)).toBe(false);
    expect(sampleGhost(lap, 5.01, out)).toBe(false);
    // Recording stopped early: the lap is longer than what was recorded.
    expect(recordCircle(5).r.finish(8)).toBeNull();
    const c = recordCircle(5).r;
    c.cancel();
    expect(c.finish(5)).toBeNull();
    // Recording that began after the lap had already started.
    const late = new GhostRecorder();
    late.begin(1, 0, 0, 0, 0);
    late.push(2, 1, 0, 0, 0);
    expect(late.finish(2)).toBeNull();
  });

  it("snaps across a reset instead of sliding the ghost through walls", () => {
    const r = new GhostRecorder();
    r.begin(-DT, 0, 0, 0, 0);
    for (let k = 1; k <= 120; k++) r.push(k * DT, k < 60 ? 0 : 40, 0, 0, 0);
    const lap = r.finish(2)!;
    const out: GhostPose = { x: 0, y: 0, z: 0, yaw: 0 };
    for (let t = 0.9; t < 1.1; t += 0.01) {
      sampleGhost(lap, t, out);
      expect(out.x === 0 || out.x === 40).toBe(true);
    }
  });

  it("round-trips through storage and rejects corrupt data", () => {
    const lap = recordCircle(12).r.finish(12)!;
    const text = encodeGhost(lap, 123);
    expect(text.length).toBeLessThan(12 * GHOST_RATE * 16 * 1.4 + 200);
    const back = decodeGhost(text)!;
    expect(back.time).toBe(12);
    expect(back.savedAt).toBe(123);
    expect(Array.from(back.samples)).toEqual(Array.from(lap.samples));
    expect(decodeGhost(null)).toBeNull();
    expect(decodeGhost("{")).toBeNull();
    expect(decodeGhost(JSON.stringify({ v: 1, time: 12, step: 0.05, data: "AAAA" }))).toBeNull();
    expect(decodeGhost(text.replace('"time":12', '"time":99'))).toBeNull();
  });

  it("compares the live lap by position on the route, not by elapsed time", () => {
    // Reference lap on a 300 m route: slow first half (10 m/s), fast second half (20 m/s).
    const L = 300;
    const pos = (t: number) => (t <= 15 ? t * 10 : 150 + (t - 15) * 20);
    const r = new GhostRecorder();
    r.begin(-DT, 0, 0, L - 0.1, 0); // a hair before the line
    for (let t = DT; t < 22.5 + DT; t += DT) r.push(t, 0, 0, pos(Math.min(t, 22.5)), 0);
    const lap = r.finish(22.5)!;
    const progressAt = (_x: number, _y: number, z: number) => ((z % L) + L) % L;
    const ref = buildReference(lap, L, progressAt)!;
    expect(ref.progress[0]).toBe(0);
    for (let k = 1; k < ref.progress.length; k++)
      expect(ref.progress[k]!).toBeGreaterThanOrEqual(ref.progress[k - 1]!);
    expect(referenceTime(ref, 100)).toBeCloseTo(10, 1);
    expect(referenceTime(ref, 250)).toBeCloseTo(20, 1);
    // A kart at 100 m after 9.8 s is 0.2 s ahead, although the reference lap is 22.5 s long.
    expect(9.8 - referenceTime(ref, 100)).toBeCloseTo(-0.2, 1);
    expect(referenceTime(ref, -5)).toBe(0);
    expect(referenceTime(ref, 1e9)).toBe(22.5);
  });
});
