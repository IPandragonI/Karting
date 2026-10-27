import { describe, expect, it } from "vitest";
import { ENGINE_DSP_SOURCE, ENGINES, Gearbox, type EngineProfile } from "@/game/audio/engineDsp";

type Dsp = { process(out: Float32Array, n: number, rpm: number, load: number): void };
const SR = 48000;
const makeDsp = (profile: EngineProfile): Dsp =>
  new Function("profile", `${ENGINE_DSP_SOURCE}; return new EngineDsp(${SR}, profile);`)(
    profile,
  ) as Dsp;

/** Renders `seconds` at a steady rpm/load after a settling period. */
function render(profile: EngineProfile, rpm: number, load: number, seconds = 1) {
  const dsp = makeDsp(profile);
  const settle = new Float32Array(SR / 2);
  dsp.process(settle, settle.length, rpm, load);
  const out = new Float32Array(Math.round(SR * seconds));
  dsp.process(out, out.length, rpm, load);
  return out;
}

const rms = (a: Float32Array) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);

/** Fundamental frequency by normalized autocorrelation, searched between two frequencies. */
function pitch(a: Float32Array, fMin: number, fMax: number) {
  let best = -Infinity;
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

const profiles = Object.values(ENGINES) as EngineProfile[];

describe("engine DSP", () => {
  for (const p of profiles) {
    it(`${p.id}: stays finite, unclipped and audible across the rev range`, () => {
      for (const [rpm, load] of [
        [p.idle, 0],
        [(p.idle + p.redline) / 2, 1],
        [p.redline, 1],
        [p.redline, 0],
      ] as const) {
        const out = render(p, rpm, load, 0.4);
        expect(out.every(Number.isFinite)).toBe(true);
        expect(Math.max(...out.map(Math.abs))).toBeLessThan(1);
        expect(rms(out)).toBeGreaterThan(0.02);
      }
    });

    it(`${p.id}: is louder on throttle than coasting at the same revs`, () => {
      const rpm = p.idle + (p.redline - p.idle) * 0.6;
      expect(rms(render(p, rpm, 1, 0.4))).toBeGreaterThan(rms(render(p, rpm, 0, 0.4)) * 1.2);
    });
  }

  it("follows the firing rate of a four-stroke: cylinders / 2 pulses per revolution", () => {
    const p = ENGINES.f1;
    for (const rpm of [4500, 7500, 10000]) {
      const firing = (rpm / 60) * (p.cylinders / 2);
      const f = pitch(render(p, rpm, 1, 0.25), firing * 0.7, firing * 1.4);
      expect(Math.abs(f - firing) / firing).toBeLessThan(0.05);
    }
  });

  it("has no hard clicks through a full run up the gears", () => {
    const p = ENGINES.f1;
    const dsp = makeDsp(p);
    const box = new Gearbox(p);
    const block = new Float32Array(128);
    const dt = 128 / SR;
    let prev = 0;
    let maxStep = 0;
    for (let t = 0; t < 4; t += dt) {
      const g = box.update(dt, Math.min(1, t / 3.5), 1);
      dsp.process(block, 128, g.rpm, g.load);
      for (const v of block) {
        maxStep = Math.max(maxStep, Math.abs(v - prev));
        prev = v;
      }
    }
    expect(maxStep).toBeLessThan(0.6);
  });
});

describe("gearbox", () => {
  /** Accelerates flat out from a standstill to top speed, collecting every update. */
  function runUp(p: EngineProfile, seconds = 6) {
    const box = new Gearbox(p);
    const out = [];
    const dt = 1 / 60;
    for (let t = 0; t < seconds; t += dt)
      out.push(box.update(dt, Math.min(1, t / (seconds - 1)), 1));
    return out;
  }

  it("idles when stopped and holds launch revs on throttle", () => {
    const box = new Gearbox(ENGINES.f1);
    expect(box.update(1 / 60, 0, 0).rpm).toBe(ENGINES.f1.idle);
    expect(box.update(1 / 60, 0, 1).rpm).toBeGreaterThanOrEqual(ENGINES.f1.launch);
  });

  it("goes up through every gear, never past the limiter, dropping revs at each shift", () => {
    for (const p of [ENGINES.f1, ENGINES.v8, ENGINES.diesel]) {
      const run = runUp(p);
      expect(run.at(-1)!.gear).toBe(p.gears.length);
      run.forEach((s, i) => {
        expect(s.rpm).toBeLessThanOrEqual(p.redline * 1.04 + 1e-6);
        if (s.shift === "up") {
          expect(s.rpm).toBeLessThan(run[i - 1]!.rpm);
          // Ignition cut while the next gear goes in.
          expect(s.load).toBe(0);
        }
      });
    }
  });

  it("shifts down with a throttle blip when slowing", () => {
    const p = ENGINES.f1;
    const box = new Gearbox(p);
    for (let t = 0; t < 5; t += 1 / 60) box.update(1 / 60, Math.min(1, t / 4), 1);
    const top = box.gear;
    let down = null;
    for (let s = 1; s > 0.3 && !down; s -= 0.01) {
      const r = box.update(1 / 60, s, 0);
      if (r.shift === "down") down = r;
    }
    expect(down?.gear).toBe(top - 1);
    expect(down!.load).toBeGreaterThan(0.5);
  });

  it("never shifts the gearless kart", () => {
    expect(runUp(ENGINES.kart).every((s) => s.gear === 1 && s.shift === null)).toBe(true);
  });
});
