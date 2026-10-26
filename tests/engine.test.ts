import { describe, expect, it } from "vitest";
import { ENGINE_DSP_SOURCE, engineRpm, RPM_IDLE, RPM_MAX } from "@/game/audio/engineDsp";

type Dsp = { process(out: Float32Array, n: number, rpm: number, load: number): void };
const SR = 48000;
const makeDsp = (): Dsp =>
  new Function(`${ENGINE_DSP_SOURCE}; return new KartEngineDsp(${SR});`)() as Dsp;

/** Renders `seconds` at a steady rpm/load after a settling period. */
function render(rpm: number, load: number, seconds = 1) {
  const dsp = makeDsp();
  const settle = new Float32Array(SR / 2);
  dsp.process(settle, settle.length, rpm, load);
  const out = new Float32Array(Math.round(SR * seconds));
  dsp.process(out, out.length, rpm, load);
  return out;
}

const rms = (a: Float32Array) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);

/** Fundamental frequency by normalized autocorrelation, searched between two frequencies. */
function pitch(a: Float32Array, fMin: number, fMax: number) {
  let best = 0;
  let bestLag = 0;
  for (let lag = Math.floor(SR / fMax); lag <= Math.ceil(SR / fMin); lag++) {
    let num = 0;
    let den = 0;
    for (let i = 0; i + lag < a.length; i++) {
      num += a[i]! * a[i + lag]!;
      den += a[i]! * a[i]!;
    }
    const r = num / den;
    if (r > best) {
      best = r;
      bestLag = lag;
    }
  }
  return SR / bestLag;
}

describe("kart engine DSP", () => {
  it("stays finite, unclipped and audible across the rev range", () => {
    for (const [rpm, load] of [
      [RPM_IDLE, 0],
      [8000, 1],
      [RPM_MAX, 1],
      [RPM_MAX, 0],
    ] as const) {
      const out = render(rpm, load, 0.5);
      expect(out.every(Number.isFinite)).toBe(true);
      expect(Math.max(...out.map(Math.abs))).toBeLessThan(1);
      expect(rms(out)).toBeGreaterThan(0.02);
    }
  });

  it("is louder on throttle than coasting at the same revs", () => {
    expect(rms(render(10000, 1, 0.5))).toBeGreaterThan(rms(render(10000, 0, 0.5)) * 1.3);
  });

  it("follows the firing rate: one pulse per revolution", () => {
    for (const rpm of [4200, 9000, 13200]) {
      const f = pitch(render(rpm, 1, 0.4), 30, 320);
      const firing = rpm / 60;
      expect(Math.abs(f - firing) / firing).toBeLessThan(0.06);
    }
  });

  it("has no hard clicks when the revs sweep", () => {
    const dsp = makeDsp();
    const block = new Float32Array(128);
    let prev = 0;
    let maxStep = 0;
    const blocks = (SR * 2) / 128;
    for (let b = 0; b < blocks; b++) {
      const t = b / blocks;
      dsp.process(block, 128, RPM_IDLE + (RPM_MAX - RPM_IDLE) * t, t < 0.8 ? 1 : 0);
      for (const v of block) {
        maxStep = Math.max(maxStep, Math.abs(v - prev));
        prev = v;
      }
    }
    expect(maxStep).toBeLessThan(0.5);
  });
});

describe("engineRpm (gearless drivetrain)", () => {
  it("idles when stopped, holds launch revs on throttle, then locks to road speed", () => {
    expect(engineRpm(0, 0)).toBe(RPM_IDLE);
    expect(engineRpm(0, 1)).toBeGreaterThan(6000);
    expect(engineRpm(0.1, 1)).toBe(engineRpm(0, 1));
    expect(engineRpm(1, 1)).toBeCloseTo(RPM_MAX, -2);
    let prev = 0;
    for (let s = 0; s <= 1; s += 0.05) {
      const r = engineRpm(s, 1);
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
    // Coasting fast: engine braking keeps revs up; slow: clutch out, back to idle.
    expect(engineRpm(0.8, 0)).toBeGreaterThan(10000);
    expect(engineRpm(0.02, 0)).toBe(RPM_IDLE);
  });
});
