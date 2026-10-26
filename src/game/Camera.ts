import * as THREE from "three";
import { KART } from "./Vehicle";
import { VEHICLE } from "./assets";

// Camera rig with interchangeable follow modes, plus the editor and orbit views.
//
// A follow mode only says where the camera wants to be and what it wants to look at, given the
// kart's pose; the rig owns the shared smoothing, shake and field of view. Adding a mode means
// adding one entry to FOLLOW_MODES.
//
// - elevated (default): high and behind, looking down at the kart and well ahead, in the spirit of
//   Starter Kit Racing, but turning with the kart so corners open up in front of you;
// - chase: just behind and above the kart;
// - first: the driver's eye point (the driver model is hidden in this mode).

export type CameraMode = "elevated" | "chase" | "first";

export const CAMERA_MODES: { id: CameraMode; label: string }[] = [
  { id: "elevated", label: "Elevated" },
  { id: "chase", label: "Chase" },
  { id: "first", label: "First person" },
];

/**
 * Kart pose at render time: the interpolated physics transform (smooth even when frames arrive
 * unevenly) plus the visual chassis pitch and roll.
 */
export type FollowTarget = {
  x: number;
  y: number;
  z: number;
  yaw: number;
  vx: number;
  vz: number;
  pitch: number;
  roll: number;
  /** Slope of the road (or the flight path) under the kart, rad, nose up positive. */
  slope: number;
  /** Underside of the lowest deck above the kart's level at a point (Infinity: open sky). */
  ceilingAt?: (x: number, z: number) => number;
};

type FollowMode = {
  /** Vertical field of view for a landscape and a portrait screen, plus extra at top speed. */
  fov: { landscape: number; portrait: number; speed: number };
  near: number;
  /**
   * Rigid: mounted on the kart (first person). No lag at all, so the kart parts in view never
   * float relative to the camera. Otherwise the heading and height are smoothed.
   */
  rigid?: boolean;
  /** How fast the camera heading catches up with the kart (1/s). */
  yawRate: number;
  /** How much the heading follows the direction of travel instead of the nose (0..1). */
  velocityBias: number;
  /** Height follow rate (1/s). */
  heightRate: number;
  /** Stays under bridge decks (the chase camera is lower than a deck over the road). */
  underDecks?: boolean;
  shake: number;
  place: (
    t: FollowTarget,
    yaw: number,
    speed01: number,
    pos: THREE.Vector3,
    look: THREE.Vector3,
  ) => void;
};

const FOLLOW_MODES: Record<CameraMode, FollowMode> = {
  elevated: {
    fov: { landscape: 50, portrait: 68, speed: 6 },
    near: 0.3,
    yawRate: 3,
    velocityBias: 0.7,
    heightRate: 4,
    shake: 0.12,
    place(t, yaw, s, pos, look) {
      const fx = Math.sin(yaw);
      const fz = Math.cos(yaw);
      const back = 9.5 + s * 2;
      const height = 8.5 + s * 1.5;
      // Heights are relative to the kart, so raised sections are framed like the ground.
      pos.set(t.x - fx * back, t.y + height, t.z - fz * back);
      const ahead = 3 + s * 5;
      look.set(t.x + fx * ahead, t.y, t.z + fz * ahead);
    },
  },
  chase: {
    fov: { landscape: 62, portrait: 78, speed: 10 },
    near: 0.1,
    yawRate: 4.5,
    velocityBias: 0.65,
    heightRate: 6,
    underDecks: true,
    shake: 0.14,
    place(t, yaw, s, pos, look) {
      const fx = Math.sin(yaw);
      const fz = Math.cos(yaw);
      const back = 5.2 + s * 1.6;
      pos.set(t.x - fx * back, t.y + 2.8 + s * 0.4, t.z - fz * back);
      const ahead = 3 + s * 3;
      look.set(t.x + fx * ahead, t.y + 0.8, t.z + fz * ahead);
    },
  },
  first: {
    fov: { landscape: 74, portrait: 88, speed: 8 },
    near: 0.05,
    rigid: true,
    yawRate: 0,
    velocityBias: 0,
    heightRate: 0,
    shake: 0.04,
    place(t, yaw, _s, pos, look) {
      const fx = Math.sin(yaw);
      const fz = Math.cos(yaw);
      // Eye point of the seated driver: at the visor, over the cockpit rim (VEHICLE.eye).
      pos.set(t.x + fx * VEHICLE.eye.z, t.y + VEHICLE.eye.y, t.z + fz * VEHICLE.eye.z);
      look.set(t.x + fx * 12, t.y + VEHICLE.eye.y - 0.55, t.z + fz * 12);
    },
  },
};

/** Share of the chassis pitch/roll the first-person view takes: present, but subtle. */
const RIGID_BODY_MOTION = 0.5;

/**
 * Exponential follow, solved exactly for a target that moves linearly during the frame.
 * The usual `x += (target − x)(1 − e^(−r·dt))` assumes the target stands still for the frame, so
 * its lag behind a moving target changes with every uneven frame time: that was the source of
 * the visible camera jitter. This form gives the same smoothing at any frame rate.
 */
export function followLinear(
  x: number,
  prevTarget: number,
  target: number,
  rate: number,
  dt: number,
) {
  if (dt <= 0) return x;
  const v = (target - prevTarget) / dt;
  const lag = v / rate;
  return target - lag + (x - prevTarget + lag) * Math.exp(-rate * dt);
}

const _target = new THREE.Vector3();
const _look = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, "YXZ");

/** Default landscape field of view of a follow mode (degrees). */
export function defaultFov(mode: CameraMode): number {
  return FOLLOW_MODES[mode].fov.landscape;
}

/** Field of view range offered for the chase and first-person cameras. */
export const FOV_RANGE = { min: 60, max: 110 } as const;

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  private yaw = 0;
  private height = 0;
  /** Previous frame's targets, for the exact moving-target follow. */
  private prevDesiredYaw = 0;
  private prevDesiredHeight = 0;
  private initialized = false;
  private shake = 0;
  private aspect = 1;
  private mode: CameraMode = "elevated";
  /** Player-chosen landscape field of view per mode (portrait keeps the mode's extra width). */
  private readonly fovOverride: Partial<Record<CameraMode, number>> = {};
  /** A settings change jumps straight to the new lens instead of easing into it. */
  private lensSnap = false;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(60, aspect, 0.1, 1200);
  }

  resize(aspect: number) {
    this.aspect = aspect;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Field of view for a follow mode (landscape degrees); null restores the default. */
  setFov(mode: CameraMode, fov: number | null) {
    if (fov === null) delete this.fovOverride[mode];
    else this.fovOverride[mode] = fov;
    this.lensSnap = true;
  }

  /** Snap on the next follow update (after a reset or a mode change). */
  cut() {
    this.initialized = false;
  }

  addShake(amount: number) {
    this.shake = Math.min(1, this.shake + amount);
  }

  follow(mode: CameraMode, t: FollowTarget, dt: number) {
    if (mode !== this.mode) {
      this.mode = mode;
      this.initialized = false;
    }
    const m = FOLLOW_MODES[mode];
    const speed = Math.hypot(t.vx, t.vz);
    const s = Math.min(1, speed / KART.maxSpeed);

    const snap = !this.initialized;
    this.initialized = true;
    this.applyLens(m, s, snap || this.lensSnap, dt, this.fovOverride[mode]);
    this.lensSnap = false;

    if (m.rigid) {
      // Mounted on the kart: exact interpolated pose, heading and (a share of) chassis motion.
      m.place(t, t.yaw, s, _target, _look);
      this.camera.position.copy(_target);
      const down = Math.atan2(
        _target.y - _look.y,
        Math.hypot(_look.x - _target.x, _look.z - _target.z),
      );
      // Camera looks down −Z: yaw + π faces the kart forward; positive chassis pitch (nose
      // dipping) tilts the view down, roll turns about the viewing axis.
      // The road's slope is taken in full: the view climbs and dips with the track.
      _euler.set(
        -down + t.slope - t.pitch * RIGID_BODY_MOTION,
        t.yaw + Math.PI,
        -t.roll * RIGID_BODY_MOTION,
      );
      this.camera.quaternion.setFromEuler(_euler);
      this.yaw = t.yaw;
      this.prevDesiredYaw = t.yaw;
      this.applyShake(m, dt);
      return;
    }

    // Heading to follow: the direction of travel when moving forward, otherwise the nose, so a
    // drift does not swing the view sideways.
    const fwdSpeed = t.vx * Math.sin(t.yaw) + t.vz * Math.cos(t.yaw);
    const w = THREE.MathUtils.clamp((fwdSpeed - 2) / 6, 0, 1) * m.velocityBias;
    let desiredYaw = lerpAngle(t.yaw, Math.atan2(t.vx, t.vz), w);
    if (snap) {
      this.yaw = this.prevDesiredYaw = desiredYaw;
    } else {
      // Keep angles continuous (no ±π wrap between frames) before the exact follow.
      desiredYaw = this.prevDesiredYaw + wrapAngle(desiredYaw - this.prevDesiredYaw);
      this.yaw = this.prevDesiredYaw + wrapAngle(this.yaw - this.prevDesiredYaw);
      this.yaw = followLinear(this.yaw, this.prevDesiredYaw, desiredYaw, m.yawRate, dt);
      this.prevDesiredYaw = desiredYaw;
    }

    // Position and aim come straight from the smoothed heading and the interpolated kart
    // position: no separate positional lag that could drift relative to the kart.
    m.place(t, this.yaw, s, _target, _look);
    // Under a bridge: aim below the deck over the kart (eased like any height change), and never
    // let the camera itself end up inside a deck.
    const ceilingAt = m.underDecks ? t.ceilingAt : undefined;
    if (ceilingAt) _target.y = Math.min(_target.y, ceilingAt(t.x, t.z) - 0.35);
    if (snap) {
      this.height = this.prevDesiredHeight = _target.y;
    } else {
      this.height = followLinear(this.height, this.prevDesiredHeight, _target.y, m.heightRate, dt);
      this.prevDesiredHeight = _target.y;
    }
    if (ceilingAt) this.height = Math.min(this.height, ceilingAt(_target.x, _target.z) - 0.35);
    this.camera.position.set(_target.x, this.height, _target.z);
    this.applyShake(m, dt);
    this.camera.lookAt(_look);
  }

  private applyShake(m: FollowMode, dt: number) {
    if (this.shake <= 0.001) return;
    const a = this.shake * m.shake;
    this.camera.position.x += (Math.random() - 0.5) * a;
    this.camera.position.y += (Math.random() - 0.5) * a;
    this.shake *= Math.exp(-10 * dt);
  }

  private applyLens(m: FollowMode, s: number, snap: boolean, dt: number, landscape?: number) {
    const land = landscape ?? m.fov.landscape;
    const base = this.aspect < 1 ? land + (m.fov.portrait - m.fov.landscape) : land;
    const fov = base + s * m.fov.speed;
    const near = m.near;
    const next = snap ? fov : this.camera.fov + (fov - this.camera.fov) * (1 - Math.exp(-3 * dt));
    // Only rebuild the projection matrix when the lens actually changes.
    if (Math.abs(next - this.camera.fov) > 1e-3 || this.camera.near !== near) {
      this.camera.fov = next;
      this.camera.near = near;
      this.camera.updateProjectionMatrix();
    }
  }

  orbit(cx: number, cz: number, radius: number, time: number) {
    const a = time * 0.06;
    this.camera.position.set(cx + Math.cos(a) * radius, radius * 0.55, cz + Math.sin(a) * radius);
    this.camera.lookAt(cx, 0, cz);
    this.initialized = false;
  }

  /** Top-down-ish editor view centred on (x, z); `height` is the zoom. */
  editor(x: number, z: number, height: number) {
    if (this.camera.fov !== 60 || this.camera.near !== 0.3) {
      this.camera.fov = 60;
      this.camera.near = 0.3;
      this.camera.updateProjectionMatrix();
    }
    this.camera.position.set(x, height, z - height * 0.35);
    this.camera.lookAt(x, 0, z);
    this.initialized = false;
  }
}

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export function lerpAngle(a: number, b: number, t: number) {
  let d = b - a;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return a + d * t;
}
