import { describe, expect, it } from "vitest";
import { followLinear } from "@/game/Camera";

/** Follows a target moving at constant speed with the given frame times; returns lag per frame. */
function lags(
  frameTimes: number[],
  follow: (x: number, p: number, t: number, dt: number) => number,
) {
  const speed = 20;
  let t = 0;
  let target = 0;
  let x = -speed / 6; // start at the steady-state lag for rate 6
  const out: number[] = [];
  for (const dt of frameTimes) {
    const prev = target;
    t += dt;
    target = speed * t;
    x = follow(x, prev, target, dt);
    out.push(target - x);
  }
  return out;
}

// Uneven frames like the ones measured in the browser (8 ms / 25 ms pairs among 16.7 ms).
const uneven = Array.from({ length: 120 }, (_, i) =>
  i % 9 === 4 ? 0.0086 : i % 9 === 5 ? 0.0247 : 1 / 60,
);

describe("camera follow", () => {
  it("keeps a constant lag behind a steadily moving target, whatever the frame times", () => {
    const l = lags(uneven, (x, p, t, dt) => followLinear(x, p, t, 6, dt));
    expect(Math.max(...l) - Math.min(...l)).toBeLessThan(1e-6);
  });

  it("is what removed the jitter: the naive per-frame lerp's lag jumps on uneven frames", () => {
    const naive = lags(uneven, (x, _p, t, dt) => x + (t - x) * (1 - Math.exp(-6 * dt)));
    expect(Math.max(...naive) - Math.min(...naive)).toBeGreaterThan(0.05);
  });

  it("settles on a still target like ordinary exponential smoothing", () => {
    let x = 0;
    for (let i = 0; i < 60; i++) x = followLinear(x, 10, 10, 6, 1 / 60);
    expect(x).toBeCloseTo(10 - 10 * Math.exp(-6), 6);
  });
});
