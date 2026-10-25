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

  it("brakes to a stop, then reverses with a limited top speed", () => {
    const s = run(createKartState(), input({ throttle: 1 }), 8);
    run(s, input({ brake: 1 }), 0.75);
    expect(Math.abs(s.forwardSpeed)).toBeLessThan(1);
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

  it("recovers grip smoothly after releasing the handbrake", () => {
    const s = run(createKartState(), input({ throttle: 1 }), 3);
    run(s, input({ throttle: 1, steer: 1, handbrake: true }), 1.2);
    run(s, input({ throttle: 1 }), 1.5);
    expect(s.drifting).toBe(false);
    expect(slipAngle(s)).toBeLessThan(0.1);
  });
});
