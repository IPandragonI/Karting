// Arcade kart model. The physics engine owns the kart's position and resolves collisions with a
// sphere collider; this model owns the heading and decides, every fixed step, what the planar
// velocity should become. It splits the velocity into forward and lateral parts relative to
// the heading and treats them separately:
// - forward: engine, brakes, reverse, rolling resistance and drag;
// - lateral: tire grip pulling the lateral velocity to zero, limited by a maximum lateral
//   acceleration. Exceeding that limit (fast corners, handbrake) is what makes the kart slide,
//   so grip loss at speed falls out of the model instead of being scripted.
// Steering sets a target yaw rate from a bicycle model whose maximum steering angle shrinks with
// speed. Below the tire limit the yaw rate is capped by what the tires can hold; steering hard at
// speed may over-rotate, the slip angle grows, grip fades along a friction curve and the kart
// slides into a drift, which then settles at a controlled angle instead of spinning.
// Keyboard inputs are digital, so steering and brake are smoothed like a wheel and a pedal.

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
  /** Braking deceleration (u/s²) = brakeBase + brakeSpeed × forward speed, times pedal (0..1). */
  brakeBase: 6.5,
  brakeSpeed: 0.17,
  /** Pedal smoothing rates (1/s): how fast the brake builds up and lets go. */
  brakeRise: 6,
  brakeRelease: 10,
  rollingResistance: 0.9,
  /** Deceleration when the throttle is released (lift-off helps turn in). */
  engineBrake: 2.6,
  airDrag: 0.0015,
  /** Brake held at a standstill this long (s) before reverse engages. */
  reverseDelay: 0.2,
  wheelBase: 1.05,
  maxSteerLow: 0.46,
  maxSteerHigh: 0.09,
  /** Speed at which steering has narrowed down to maxSteerHigh. */
  steerFalloffSpeed: 20,
  /**
   * Steering wheel rates (1/s): turning in (slower only at high speed) and returning to centre.
   * Returning is quicker than turning in, so the kart stops rotating soon after a release.
   */
  steerRiseLow: 10,
  steerRiseHigh: 4.5,
  steerReturn: 12,
  /** How quickly the yaw rate follows its target (1/s): the rotational inertia of the kart. */
  yawResponse: 10,
  /** Extra yaw allowed beyond the grip limit at full lock and speed: lets slides start. */
  overRotation: 0.32,
  /** Lateral acceleration the tires can hold on asphalt, at low and at top speed. */
  lateralGripLow: 34,
  lateralGripHigh: 26,
  /** Fraction of the grip available while drifting, from counter-steer to full lock into it. */
  driftGripMin: 0.45,
  driftGripMax: 0.95,
  /** Slip angle (rad) the kart settles at in a drift, from counter-steer to full lock into it. */
  driftAngleMin: 0.28,
  driftAngleMax: 0.65,
  driftMinSpeed: 7,
  /** How hard the nose is pulled to the drift angle (1/s per rad of error). */
  driftAngleGain: 9,
  /** Grip lost once the tires slide (kinetic vs static friction), between these slip angles. */
  slideGripLoss: 0.3,
  slideStart: 0.12,
  slideFull: 0.45,
  /** A slide this wide (rad) at speed with the wheel held turns into a drift by itself. */
  autoDriftSlip: 0.2,
  /** Self-starting drifts belong to fast corners, not hairpins. */
  autoDriftMinSpeed: 13,
  /** Grip available the moment a drift ends; the rest blends back over gripRecoveryTime. */
  gripRecoveryStart: 0.8,
  /** Effective wheel speed (u/s) the throttle gives the steering when the kart is blocked. */
  pivotSpeed: 2.5,
  /** Seconds for full grip to come back after a drift. */
  gripRecoveryTime: 0.4,
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
  /** Smoothed brake pedal 0..1. */
  brake: number;
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
    brake: 0,
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

  const speed01 = clamp(speed / KART.maxSpeed, 0, 1);
  // Slip angle: between the nose and the direction of travel.
  const slipAngle = speed > 1 ? Math.atan2(Math.abs(vl), Math.abs(vf)) : 0;

  // ── Input smoothing (keyboard is digital, a steering wheel and a pedal are not). ──
  // Turning in is slower at speed (stability), returning to centre is quicker (forgiveness).
  const centring = input.steer === 0 || input.steer * s.steer < 0;
  // The slower turn-in only applies in the upper speed range, where twitchiness hurts; at
  // hairpin speeds the wheel stays quick.
  const steerRate = centring
    ? KART.steerReturn
    : KART.steerRiseLow + (KART.steerRiseHigh - KART.steerRiseLow) * smoothstep(0.4, 1, speed01);
  s.steer += (input.steer - s.steer) * approach(steerRate, dt);
  const brakeRate = input.brake > s.brake ? KART.brakeRise : KART.brakeRelease;
  s.brake += (input.brake - s.brake) * approach(brakeRate, dt);

  // ── Drift state. ──
  if (!s.drifting) {
    const handbrakeEntry = input.handbrake && Math.abs(input.steer) > 0.25;
    // Steering hard at speed: once the rear has stepped out far enough, it becomes a drift.
    // Not while grip is still coming back from the previous drift: catching a slide with
    // opposite lock must not flick the kart into a drift the other way (pendulum / snap-back).
    const slideEntry =
      Math.abs(s.steer) > 0.6 &&
      slipAngle > KART.autoDriftSlip &&
      vf > KART.autoDriftMinSpeed &&
      s.gripRecovery >= 1;
    if ((handbrakeEntry || slideEntry) && vf > KART.driftMinSpeed) {
      s.drifting = true;
      s.driftDir = Math.sign(handbrakeEntry ? input.steer : s.steer);
    }
  } else {
    // A drift lives on while the handbrake is held or the wheel stays turned into it;
    // relaxing the wheel or counter-steering (without handbrake) straightens the kart.
    const holding = input.handbrake || s.steer * s.driftDir > 0.3;
    if (!holding || vf < KART.driftMinSpeed * 0.6) {
      s.drifting = false;
      s.gripRecovery = 0;
    }
  }
  s.gripRecovery = Math.min(1, s.gripRecovery + dt / KART.gripRecoveryTime);

  // ── Longitudinal forces. ──
  const prevVf = vf;
  if (input.throttle > 0 && vf > -0.5) {
    const ratio = clamp(vf / maxSpeed, 0, 1.2);
    vf += KART.engineAccel * input.throttle * (1 - Math.pow(ratio, 2.5)) * dt;
  } else if (input.throttle > 0) {
    // Throttle while rolling backwards brakes the reverse motion.
    vf = Math.min(0, vf + (KART.brakeBase + KART.brakeSpeed * -vf) * input.throttle * dt);
  }
  if (vf > 0.5 && s.brake > 0.001) {
    // Progressive braking: proportional to the (smoothed) pedal and a little stronger at speed.
    vf = Math.max(0, vf - (KART.brakeBase + KART.brakeSpeed * vf) * s.brake * dt);
    s.stoppedTime = 0;
  } else if (input.brake > 0) {
    if (vf > 0.5) {
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
  // Pinned against a barrier the kart barely moves, yet spinning rear wheels still let it pivot
  // away: throttle provides a small effective speed (no throttle: no turning on the spot).
  const blockedPivot = KART.pivotSpeed * Math.max(input.throttle, vf < 0.5 ? input.brake : 0);
  const steerSpeed =
    Math.abs(vf) < blockedPivot
      ? input.brake > input.throttle
        ? -blockedPivot
        : blockedPivot
      : vf;
  let targetYaw = (-steerSpeed / KART.wheelBase) * Math.tan(steerAngle);

  const gripBase =
    KART.lateralGripLow +
    (KART.lateralGripHigh - KART.lateralGripLow) * smoothstep(0, KART.maxSpeed, speed);
  let lateralGrip = gripBase * surface.grip;

  // Trail braking: the pedal unloads the rear a little, helping the kart rotate into a corner.
  lateralGrip *= 1 - 0.12 * s.brake;

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
    // Stiff enough that a counter-steer visibly bites within a few tenths of a second.
    targetYaw = error * KART.driftAngleGain;
    lateralGrip *= KART.driftGripMin + (KART.driftGripMax - KART.driftGripMin) * amount;
  } else {
    // Tires can only sustain v·ω ≤ grip. Turning hard at speed may over-rotate a little more:
    // that is what lets the rear step out and a slide develop naturally.
    const aggressive = smoothstep(0.55, 1, Math.abs(s.steer)) * smoothstep(10, 20, absVf);
    const maxYaw = (lateralGrip / Math.max(absVf, 3)) * (1.05 + KART.overRotation * aggressive);
    targetYaw = clamp(targetYaw, -maxYaw, maxYaw);
    // Friction curve: once the tires slide they hold less (progressive grip loss). Drifts have
    // their own grip model above, so this only shapes the slide that leads into one.
    lateralGrip *= 1 - KART.slideGripLoss * smoothstep(KART.slideStart, KART.slideFull, slipAngle);
    // Handbrake without a drift (low speed / no steering): rear unloads, grip drops a bit.
    if (input.handbrake) lateralGrip *= 0.6;
    // After a drift, grip comes back progressively: no snap.
    lateralGrip *=
      KART.gripRecoveryStart + (1 - KART.gripRecoveryStart) * smoothstep(0, 1, s.gripRecovery);
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
