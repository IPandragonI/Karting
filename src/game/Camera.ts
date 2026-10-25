import * as THREE from "three";
import { KART } from "./Vehicle";

// Cameras:
// - chase: third-person follow camera. It trails the direction of travel (blended with the kart's
//   heading at low speed), so drifts do not swing the view, pulls back and widens with speed,
//   and looks slightly ahead.
// - orbit: slow fly-around for the menu.
// - editor: top-down view the editor pans and zooms.

const _target = new THREE.Vector3();
const _look = new THREE.Vector3();

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  private yaw = 0;
  private readonly pos = new THREE.Vector3();
  private readonly lookAt = new THREE.Vector3();
  private initialized = false;
  private shake = 0;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(62, aspect, 0.1, 900);
  }

  resize(aspect: number) {
    this.camera.aspect = aspect;
    // Portrait screens: widen the view so the kart and the corner ahead stay visible.
    this.camera.fov = aspect < 1 ? 78 : 62;
    this.camera.updateProjectionMatrix();
  }

  /** Snap on the next chase update (after a reset or a mode change). */
  cut() {
    this.initialized = false;
  }

  addShake(amount: number) {
    this.shake = Math.min(1, this.shake + amount);
  }

  chase(x: number, z: number, yaw: number, vx: number, vz: number, dt: number) {
    const speed = Math.hypot(vx, vz);
    const t = Math.min(1, speed / KART.maxSpeed);
    // Direction to trail: velocity when moving forward with some speed, otherwise the heading.
    const fwdSpeed = vx * Math.sin(yaw) + vz * Math.cos(yaw);
    const velYaw = Math.atan2(vx, vz);
    const w = THREE.MathUtils.clamp((fwdSpeed - 2) / 6, 0, 1) * 0.65;
    const desiredYaw = lerpAngle(yaw, velYaw, w);

    if (!this.initialized) this.yaw = desiredYaw;
    else this.yaw = lerpAngle(this.yaw, desiredYaw, 1 - Math.exp(-4.5 * dt));

    const distance = 5.8 + t * 1.8;
    const height = 3.1 + t * 0.5;
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    _target.set(x - fx * distance, height, z - fz * distance);
    _look.set(x + fx * (3 + t * 3), 0.8, z + fz * (3 + t * 3));

    if (!this.initialized) {
      this.pos.copy(_target);
      this.lookAt.copy(_look);
      this.initialized = true;
    } else {
      // Position follows tightly (the yaw smoothing already softens turns); height lags a bit more.
      const k = 1 - Math.exp(-12 * dt);
      this.pos.x += (_target.x - this.pos.x) * k;
      this.pos.z += (_target.z - this.pos.z) * k;
      this.pos.y += (_target.y - this.pos.y) * (1 - Math.exp(-5 * dt));
      this.lookAt.lerp(_look, 1 - Math.exp(-14 * dt));
    }

    this.camera.position.copy(this.pos);
    if (this.shake > 0.001) {
      const s = this.shake * 0.25;
      this.camera.position.x += (Math.random() - 0.5) * s;
      this.camera.position.y += (Math.random() - 0.5) * s;
      this.shake *= Math.exp(-9 * dt);
    }
    this.camera.lookAt(this.lookAt);

    const baseFov = this.camera.aspect < 1 ? 78 : 62;
    const fov = baseFov + t * 10;
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov += (fov - this.camera.fov) * (1 - Math.exp(-3 * dt));
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
    this.camera.position.set(x, height, z - height * 0.35);
    this.camera.lookAt(x, 0, z);
    this.initialized = false;
  }
}

export function lerpAngle(a: number, b: number, t: number) {
  let d = b - a;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return a + d * t;
}
