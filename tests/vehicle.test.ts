import { describe, expect, it } from "vitest";
import {
  ASPHALT,
  createKartState,
  GRASS,
  KART,
  stepKart,
  type KartInput,
  type KartState,
  type Surface,
} from "@/game/Vehicle";

const DT = 1 / 120;
const input = (o: Partial<KartInput> = {}): KartInput => ({
  throttle: 0,
  brake: 0,
  steer: 0,
  handbrake: false,
  ...o,
});

function run(s: KartState, i: KartInput, seconds: number, surface: Surface = ASPHALT, dt = DT) {
  for (let t = 0; t < seconds; t += dt) stepKart(s, i, surface, dt);
  return s;
}

const speed = (s: KartState) => Math.hypot(s.vx, s.vz);
/** Angle between the nose and the direction of travel. */
const slipAngle = (s: KartState) => {
  const a = Math.atan2(s.vx, s.vz) - s.yaw;
  return Math.abs(Math.atan2(Math.sin(a), Math.cos(a)));
};

describe("longitudinal", () => {
  it("accelerates briskly and tops out at max speed", () => {
    const s = createKartState();
    run(s, input({ throttle: 1 }), 2);
    expect(speed(s)).toBeGreaterThan(15);
    run(s, input({ throttle: 1 }), 8);
    expect(s.forwardSpeed).toBeGreaterThan(KART.maxSpeed * 0.88);
    expect(s.forwardSpeed).toBeLessThanOrEqual(KART.maxSpeed);
  });

  it("brakes progressively from top speed: real time and distance, no emergency stop", () => {
    const s = run(createKartState(), input({ throttle: 1 }), 10);
    let t = 0;
    let distance = 0;
    let maxDecel = 0;
    while (speed(s) > 0.3 && t < 10) {
      const before = s.forwardSpeed;
      stepKart(s, input({ brake: 1 }), ASPHALT, DT);
      maxDecel = Math.max(maxDecel, (before - s.forwardSpeed) / DT);
      distance += speed(s) * DT;
      t += DT;
    }
    expect(t).toBeGreaterThan(1.6);
    expect(t).toBeLessThan(3);
    expect(distance).toBeGreaterThan(18);
    // About 1 g at most, never the old 3.5 g slam.
    expect(maxDecel).toBeLessThan(13);
  });

  it("brakes in proportion to the pedal and builds up instead of snapping", () => {
    const full = run(createKartState(), input({ throttle: 1 }), 8);
    const half = run(createKartState(), input({ throttle: 1 }), 8);
    const v0 = full.forwardSpeed;
    // The first 50 ms of braking take off less than a quarter of a second's worth.
    run(full, input({ brake: 1 }), 0.05);
    expect(v0 - full.forwardSpeed).toBeLessThan(0.6);
    run(full, input({ brake: 1 }), 0.75);
    run(half, input({ brake: 0.5 }), 0.8);
    // Rolling resistance and engine braking act regardless of the pedal, hence not exactly half.
    expect(v0 - half.forwardSpeed).toBeLessThan((v0 - full.forwardSpeed) * 0.75);
  });

  it("lets go of the brake smoothly: no jump in speed", () => {
    const s = run(createKartState(), input({ throttle: 1 }), 8);
    run(s, input({ brake: 1 }), 0.6);
    let maxChange = 0;
    for (let i = 0; i < 60; i++) {
      const before = s.forwardSpeed;
      stepKart(s, input(), ASPHALT, DT);
      maxChange = Math.max(maxChange, Math.abs(s.forwardSpeed - before));
    }
    expect(maxChange).toBeLessThan(0.12);
  });

  it("still comes to a complete stop, then reverses with a limited top speed", () => {
    const s = run(createKartState(), input({ throttle: 1 }), 8);
    let t = 0;
    while (s.forwardSpeed > 0.01 && t < 4) {
      stepKart(s, input({ brake: 1 }), ASPHALT, DT);
      t += DT;
    }
    expect(s.forwardSpeed).toBeLessThanOrEqual(0.01);
    expect(s.forwardSpeed).toBeGreaterThan(-0.5);
    run(s, input({ brake: 1 }), 6);
    expect(s.forwardSpeed).toBeLessThan(-3);
    expect(s.forwardSpeed).toBeGreaterThanOrEqual(-KART.maxReverse);
  });

  it("coasts to a stop through rolling resistance", () => {
    const s = run(createKartState(), input({ throttle: 1 }), 3);
    run(s, input(), 10);
    expect(speed(s)).toBeLessThan(0.01);
  });

  it("is much slower on grass", () => {
    const s = run(createKartState(), input({ throttle: 1 }), 10, GRASS);
    expect(speed(s)).toBeLessThan(KART.maxSpeed * GRASS.speedFactor + 0.1);
  });

  it("does not depend on the step size", () => {
    const a = run(createKartState(), input({ throttle: 1, steer: 0.4 }), 3, ASPHALT, 1 / 120);
    const b = run(createKartState(), input({ throttle: 1, steer: 0.4 }), 3, ASPHALT, 1 / 60);
    expect(Math.abs(speed(a) - speed(b)) / speed(a)).toBeLessThan(0.03);
    expect(Math.abs(a.yaw - b.yaw)).toBeLessThan(0.1);
  });
});

describe("steering", () => {
  it("cannot turn on the spot", () => {
    const s = run(createKartState(), input({ steer: 1 }), 1);
    expect(Math.abs(s.yaw)).toBeLessThan(1e-6);
  });

  it("can pivot away from a barrier it is pinned against (throttle + steer)", () => {
    const s = createKartState();
    for (let t = 0; t < 1; t += DT) {
      stepKart(s, input({ throttle: 1, steer: 1 }), ASPHALT, DT);
      // The wall cancels all motion every step.
      s.vx = 0;
      s.vz = 0;
    }
    expect(Math.abs(s.yaw)).toBeGreaterThan(0.5);
  });

  it("turns right for positive steer (towards −X when heading +Z)", () => {
    const s = run(createKartState(), input({ throttle: 1 }), 1.5);
    run(s, input({ throttle: 1, steer: 1 }), 0.3);
    expect(s.yaw).toBeLessThan(0);
    expect(s.vx).toBeLessThan(0);
  });

  it("widens the turning radius as speed rises", () => {
    const radius = (v: number) => {
      const s = createKartState();
      s.vz = v;
      // Constant speed: keep the throttle balancing drag by resetting forward speed each step.
      for (let t = 0; t < 1.5; t += DT) {
        stepKart(s, input({ steer: 1 }), ASPHALT, DT);
        const k = v / speed(s);
        s.vx *= k;
        s.vz *= k;
      }
      return v / Math.abs(s.yawRate);
    };
    const slow = radius(6);
    const fast = radius(22);
    expect(fast).toBeGreaterThan(slow * 2);
  });

  it("holds grip in a steady corner at moderate speed", () => {
    const s = run(createKartState(), input({ throttle: 1 }), 1.2);
    run(s, input({ throttle: 0.6, steer: 0.5 }), 2);
    expect(slipAngle(s)).toBeLessThan(0.2);
    expect(s.drifting).toBe(false);
  });

  it("builds steering up progressively instead of snapping the nose round", () => {
    const s = createKartState();
    s.vz = 14;
    const rates: number[] = [];
    for (let i = 0; i < 120; i++) {
      stepKart(s, input({ throttle: 0.5, steer: 1 }), ASPHALT, DT);
      rates.push(Math.abs(s.yawRate));
    }
    const steady = rates.at(-1)!;
    // Less than a third of the turn rate after 0.1 s, most of it by 0.6 s.
    expect(rates[11]!).toBeLessThan(steady * 0.33);
    expect(rates[71]!).toBeGreaterThan(steady * 0.75);
  });

  it("responds quickly to the wheel and stops rotating soon after it is released", () => {
    const s = createKartState();
    s.vz = 14;
    const keep = () => {
      const k = 14 / speed(s);
      s.vx *= k;
      s.vz *= k;
    };
    const rates: number[] = [];
    for (let i = 0; i < 120; i++) {
      stepKart(s, input({ throttle: 0.4, steer: 1 }), ASPHALT, DT);
      keep();
      rates.push(Math.abs(s.yawRate));
    }
    const steady = rates.at(-1)!;
    const t63 = rates.findIndex((r) => r > 0.63 * steady) * DT;
    expect(t63).toBeLessThan(0.25);
    let stopped = Infinity;
    for (let i = 0; i < 120; i++) {
      stepKart(s, input({ throttle: 0.4 }), ASPHALT, DT);
      keep();
      if (Math.abs(s.yawRate) < 0.1 * steady) {
        stopped = (i + 1) * DT;
        break;
      }
    }
    expect(stopped).toBeLessThan(0.45);
  });

  it("stays stable at top speed: a short steering tap only nudges the heading", () => {
    const s = createKartState();
    s.vz = 22;
    run(s, input({ throttle: 1, steer: 1 }), 0.15);
    run(s, input({ throttle: 1 }), 1);
    expect(Math.abs(Math.atan2(s.vx, s.vz))).toBeLessThan(0.17);
    expect(slipAngle(s)).toBeLessThan(0.05);
  });

  it("keeps enough lock at low speed for hairpins", () => {
    const s = createKartState();
    s.vz = 8;
    for (let t = 0; t < 1.5; t += DT) {
      stepKart(s, input({ steer: 1 }), ASPHALT, DT);
      const k = 8 / speed(s);
      s.vx *= k;
      s.vz *= k;
    }
    // Hairpin centerline radius is 6; the kart must be able to go tighter.
    expect(8 / Math.abs(s.yawRate)).toBeLessThan(4.5);
  });

  it("slides when cornering at full lock and full speed (grip loss at speed)", () => {
    const s = run(createKartState(), input({ throttle: 1 }), 8);
    let maxSlip = 0;
    for (let t = 0; t < 0.8; t += DT) {
      stepKart(s, input({ throttle: 1, steer: 1 }), ASPHALT, DT);
      maxSlip = Math.max(maxSlip, s.slip);
    }
    expect(maxSlip).toBeGreaterThan(0);
  });
});

describe("drifting", () => {
  it("holds a controlled drift angle without spinning, and keeps its speed", () => {
    const s = run(createKartState(), input({ throttle: 1 }), 3);
    const entry = speed(s);
    let maxAngle = 0;
    for (let t = 0; t < 2.5; t += DT) {
      stepKart(s, input({ throttle: 1, steer: 1, handbrake: true }), ASPHALT, DT);
      if (t > 0.3) maxAngle = Math.max(maxAngle, slipAngle(s));
    }
    expect(s.drifting).toBe(true);
    expect(slipAngle(s)).toBeGreaterThan(0.2);
    expect(maxAngle).toBeLessThan(1.1);
    expect(speed(s)).toBeGreaterThan(entry * 0.5);
  });

  it("turns more sharply when steering into the drift than when counter-steering", () => {
    const heading = (steer: number) => {
      const s = run(createKartState(), input({ throttle: 1 }), 3);
      run(s, input({ throttle: 1, steer: 1, handbrake: true }), 0.2);
      run(s, input({ throttle: 1, steer, handbrake: true }), 1.5);
      return Math.atan2(s.vx, s.vz);
    };
    const into = heading(1);
    const counter = heading(-1);
    // Turning right lowers the heading, so "more turned" means more negative.
    expect(into).toBeLessThan(counter - 0.3);
  });

  it("drifts naturally when cornering hard at speed, without handbrake and without spinning", () => {
    const s = run(createKartState(), input({ throttle: 1 }), 8);
    const entry = speed(s);
    let maxAngle = 0;
    let drifted = false;
    for (let t = 0; t < 3; t += DT) {
      stepKart(s, input({ throttle: 1, steer: 1 }), ASPHALT, DT);
      maxAngle = Math.max(maxAngle, slipAngle(s));
      drifted ||= s.drifting;
    }
    expect(drifted).toBe(true);
    expect(maxAngle).toBeGreaterThan(0.25);
    expect(maxAngle).toBeLessThan(0.9);
    // Momentum is kept through the slide.
    expect(speed(s)).toBeGreaterThan(entry * 0.75);
  });

  it("straightens out smoothly when the wheel is released: no snap-back or oscillation", () => {
    const s = run(createKartState(), input({ throttle: 1 }), 8);
    run(s, input({ throttle: 1, steer: 1 }), 2);
    expect(s.drifting).toBe(true);
    const side = Math.sign(
      Math.atan2(
        Math.sin(Math.atan2(s.vx, s.vz) - s.yaw),
        Math.cos(Math.atan2(s.vx, s.vz) - s.yaw),
      ),
    );
    let maxYawRate = 0;
    let overshoot = 0;
    for (let t = 0; t < 2; t += DT) {
      stepKart(s, input({ throttle: 1 }), ASPHALT, DT);
      maxYawRate = Math.max(maxYawRate, Math.abs(s.yawRate));
      const a = Math.atan2(s.vx, s.vz) - s.yaw;
      const signed = Math.atan2(Math.sin(a), Math.cos(a));
      // Slip on the opposite side means the tail snapped past straight.
      if (Math.sign(signed) === -side) overshoot = Math.max(overshoot, Math.abs(signed));
    }
    expect(s.drifting).toBe(false);
    expect(slipAngle(s)).toBeLessThan(0.08);
    expect(overshoot).toBeLessThan(0.1);
    expect(maxYawRate).toBeLessThan(2.5);
  });

  it("catches a drift with counter-steer quickly, without swinging into one the other way", () => {
    const s = run(createKartState(), input({ throttle: 1 }), 8);
    run(s, input({ throttle: 1, steer: 1, handbrake: true }), 1.2);
    let t = 0;
    while (slipAngle(s) > 0.1 && t < 3) {
      stepKart(s, input({ throttle: 1, steer: -1 }), ASPHALT, DT);
      t += DT;
    }
    expect(t).toBeLessThan(0.5);
    let maxAfter = 0;
    for (let i = 0; i < 1 / DT; i++) {
      stepKart(s, input({ throttle: 1 }), ASPHALT, DT);
      maxAfter = Math.max(maxAfter, slipAngle(s));
      expect(s.drifting).toBe(false);
    }
    expect(maxAfter).toBeLessThan(0.15);
  });

  it("recovers grip smoothly after releasing the handbrake", () => {
    const s = run(createKartState(), input({ throttle: 1 }), 3);
    run(s, input({ throttle: 1, steer: 1, handbrake: true }), 1.2);
    run(s, input({ throttle: 1 }), 1.5);
    expect(s.drifting).toBe(false);
    expect(slipAngle(s)).toBeLessThan(0.1);
  });
});
