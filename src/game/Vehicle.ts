// Arcade kart model. The physics engine owns the kart's position and resolves collisions with a
// sphere collider; this model owns the heading and decides, every fixed step, what the planar
// velocity should become. It splits the velocity into forward and lateral parts relative to
// the heading and treats them separately:
// - forward: engine, brakes, reverse, rolling resistance and drag;
// - lateral: tire grip pulling the lateral velocity to zero, limited by a maximum lateral
//   acceleration. Exceeding that limit (fast corners, handbrake) is what makes the kart slide,
//   so grip loss at speed falls out of the model instead of being scripted.
// Steering sets a target yaw rate from a bicycle model whose maximum steering angle shrinks with
// speed, capped by what the tires can hold, so the kart never pirouettes on the spot.

export type KartInput = {
  /** 0..1 */
  throttle: number;
  /** 0..1, brakes when rolling forward, reverses when (nearly) stopped. */
  brake: number;
  /** −1 (left) .. 1 (right) */
  steer: number;
  handbrake: boolean;
};

export type Surface = {
  /** 1 on asphalt, lower on grass. */
  grip: number;
  /** Max-speed multiplier. */
  speedFactor: number;
  /** Extra rolling resistance in u/s². */
  drag: number;
};

export const ASPHALT: Surface = { grip: 1, speedFactor: 1, drag: 0 };
export const GRASS: Surface = { grip: 0.65, speedFactor: 0.55, drag: 7 };

export const KART = {
  maxSpeed: 24,
  maxReverse: 7,
  engineAccel: 17,
  brakeDecel: 34,
  rollingResistance: 0.9,
  /** Deceleration when the throttle is released (lift-off helps turn in). */
  engineBrake: 2.6,
  airDrag: 0.0015,
  /** Brake held at a standstill this long (s) before reverse engages. */
  reverseDelay: 0.2,
  wheelBase: 1.05,
  maxSteerLow: 0.62,
  maxSteerHigh: 0.12,
  /** Speed at which steering has narrowed down to maxSteerHigh. */
  steerFalloffSpeed: 18,
  steerResponse: 9,
  yawResponse: 11,
  /** Lateral acceleration the tires can hold on asphalt, at low and at top speed. */
  lateralGripLow: 34,
  lateralGripHigh: 26,
  /** Fraction of the grip available while drifting, from counter-steer to full lock into it. */
  driftGripMin: 0.45,
  driftGripMax: 0.95,
  /** Slip angle (rad) the kart settles at in a drift, from counter-steer to full lock into it. */
  driftAngleMin: 0.3,
  driftAngleMax: 0.75,
  driftMinSpeed: 7,
  /** Fraction of scrubbed lateral speed that a drift turns back into forward speed. */
  driftCarry: 0.4,
  handbrakeDecel: 6,
} as const;

export type KartState = {
  /** Heading in radians, three.js convention: forward = (sin yaw, 0, cos yaw). */
  yaw: number;
  yawRate: number;
  /** Planar world velocity. */
  vx: number;
  vz: number;
  /** Smoothed steering input −1..1 (for visuals too). */
  steer: number;
  drifting: boolean;
  /** −1/1: side of the current drift. */
  driftDir: number;
  /** 0..1, grip blends back in after a drift instead of snapping. */
  gripRecovery: number;
  // Derived each step, read by effects, audio, HUD:
  forwardSpeed: number;
  lateralSpeed: number;
  /** Signed longitudinal acceleration (u/s²) of the last step. */
  accel: number;
  /** 0..1 how hard the tires are sliding. */
  slip: number;
  /** Time the brake has been held at a standstill. */
  stoppedTime: number;
};

export function createKartState(yaw = 0): KartState {
  return {
    yaw,
    yawRate: 0,
    vx: 0,
    vz: 0,
    steer: 0,
    drifting: false,
    driftDir: 0,
    gripRecovery: 1,
    forwardSpeed: 0,
    lateralSpeed: 0,
    accel: 0,
    slip: 0,
    stoppedTime: 0,
  };
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Frame-rate independent exponential approach factor. */
const approach = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);

/** Advances the model by `dt` and writes the new planar velocity into `s.vx` / `s.vz`. */
export function stepKart(s: KartState, input: KartInput, surface: Surface, dt: number): void {
  const fx = Math.sin(s.yaw);
  const fz = Math.cos(s.yaw);
  // Right-hand side of the kart (screen right when the camera looks along +forward).
  const rx = -fz;
  const rz = fx;

  let vf = s.vx * fx + s.vz * fz;
  let vl = s.vx * rx + s.vz * rz;
  const speed = Math.hypot(vf, vl);
  const maxSpeed = KART.maxSpeed * surface.speedFactor;

  // ── Steering input smoothing (keyboard is digital, karts are not). ──
  s.steer += (input.steer - s.steer) * approach(KART.steerResponse, dt);

  // ── Drift state. ──
  if (!s.drifting) {
    if (input.handbrake && Math.abs(input.steer) > 0.25 && vf > KART.driftMinSpeed) {
      s.drifting = true;
      s.driftDir = Math.sign(input.steer);
    }
  } else if (!input.handbrake || vf < KART.driftMinSpeed * 0.6) {
    s.drifting = false;
    s.gripRecovery = 0;
  }
  s.gripRecovery = Math.min(1, s.gripRecovery + dt / 0.35);

  // ── Longitudinal forces. ──
  const prevVf = vf;
  if (input.throttle > 0 && vf > -0.5) {
    const ratio = clamp(vf / maxSpeed, 0, 1.2);
    vf += KART.engineAccel * input.throttle * (1 - Math.pow(ratio, 2.5)) * dt;
  } else if (input.throttle > 0) {
    vf = Math.min(0, vf + KART.brakeDecel * input.throttle * dt);
  }
  if (input.brake > 0) {
    if (vf > 0.5) {
      vf = Math.max(0, vf - KART.brakeDecel * input.brake * dt);
      s.stoppedTime = 0;
    } else if (input.throttle === 0 && (s.stoppedTime += dt) > KART.reverseDelay) {
      const ratio = clamp(-vf / KART.maxReverse, 0, 1.2);
      vf -= KART.engineAccel * 0.6 * input.brake * (1 - ratio * ratio) * dt;
    }
  }
  if (input.handbrake && !s.drifting) {
    vf -= Math.sign(vf) * Math.min(Math.abs(vf), KART.handbrakeDecel * dt);
  }
  const resist =
    KART.rollingResistance +
    surface.drag +
    KART.airDrag * vf * vf +
    (input.throttle === 0 && vf > 0 ? KART.engineBrake : 0);
  vf -= Math.sign(vf) * Math.min(Math.abs(vf), resist * dt);
  // Over the surface's top speed (e.g. arriving on grass) bleed off quickly but not instantly.
  if (vf > maxSpeed) vf = Math.max(maxSpeed, vf - 20 * dt);

  // ── Steering → yaw rate. ──
  const absVf = Math.abs(vf);
  const steerAngle =
    s.steer *
    (KART.maxSteerLow +
      (KART.maxSteerHigh - KART.maxSteerLow) * smoothstep(0, KART.steerFalloffSpeed, absVf));
  // Bicycle model: yaw rate = v / R, R = wheelbase / tan(angle). Negative because steering right
  // (positive input) must reduce yaw in three.js' right-handed frame.
  let targetYaw = (-vf / KART.wheelBase) * Math.tan(steerAngle);

  const gripBase =
    KART.lateralGripLow +
    (KART.lateralGripHigh - KART.lateralGripLow) * smoothstep(0, KART.maxSpeed, speed);
  let lateralGrip = gripBase * surface.grip;

  if (s.drifting) {
    // The nose settles at a slip angle inside the velocity direction. Steering into the drift
    // raises both that angle and the cornering force (tighter line); counter-steer opens the
    // line, but cannot flip the drift. Settling at an angle (instead of a fixed yaw rate)
    // is what keeps a drift from turning into a spin.
    const amount = clamp(0.5 + 0.5 * input.steer * s.driftDir, 0, 1);
    const angle = KART.driftAngleMin + (KART.driftAngleMax - KART.driftAngleMin) * amount;
    const velocityHeading = speed > 0.5 ? Math.atan2(s.vx, s.vz) : s.yaw;
    let error = velocityHeading - s.driftDir * angle - s.yaw;
    error = Math.atan2(Math.sin(error), Math.cos(error));
    targetYaw = error * 7;
    lateralGrip *= KART.driftGripMin + (KART.driftGripMax - KART.driftGripMin) * amount;
  } else {
    // Tires can only sustain v·ω ≤ grip; allow a little over-rotation so it feels lively.
    const maxYaw = (lateralGrip / Math.max(absVf, 3)) * 1.05;
    targetYaw = clamp(targetYaw, -maxYaw, maxYaw);
    // Handbrake without a drift (low speed / no steering): rear unloads, grip drops a bit.
    if (input.handbrake) lateralGrip *= 0.6;
    lateralGrip *= 0.35 + 0.65 * s.gripRecovery;
  }
  s.yawRate += (targetYaw - s.yawRate) * approach(KART.yawResponse, dt);
  s.yaw += s.yawRate * dt;

  // ── Lateral grip (saturating). ──
  // Re-project the velocity on the new heading: rotating the kart is what creates lateral slip.
  const nfx = Math.sin(s.yaw);
  const nfz = Math.cos(s.yaw);
  const nrx = -nfz;
  const nrz = nfx;
  const wx = fx * vf + rx * vl;
  const wz = fz * vf + rz * vl;
  vf = wx * nfx + wz * nfz;
  vl = wx * nrx + wz * nrz;

  const wanted = -vl * approach(25, dt);
  const limit = lateralGrip * dt;
  const dvl = clamp(wanted, -limit, limit);
  vl += dvl;
  if (s.drifting && vf > 0) {
    // Arcade drift: part of the scrubbed sideways speed carries the kart forward.
    vf = Math.min(maxSpeed, vf + Math.abs(dvl) * KART.driftCarry);
  }
  // Sliding scrubs speed.
  vf -= Math.sign(vf) * Math.min(Math.abs(vf), Math.abs(vl) * 0.5 * dt);

  s.vx = nfx * vf + nrx * vl;
  s.vz = nfz * vf + nrz * vl;
  s.forwardSpeed = vf;
  s.lateralSpeed = vl;
  s.accel = (vf - prevVf) / dt;
  s.slip = clamp((Math.abs(vl) - 1.2) / 5, 0, 1);
}

/** Lets the kart's heading follow a velocity change caused by a collision (glancing hits). */
export function afterCollision(s: KartState, vx: number, vz: number): void {
  s.vx = vx;
  s.vz = vz;
  s.yawRate *= 0.5;
}
