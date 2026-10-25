import * as THREE from "three";
import type { KartState } from "./Vehicle";

// Visual kart: the Kenney kart model (with its driver), animated from the arcade model's state.
// Wheels spin with forward speed, front wheels steer (and counter-steer in a drift), the body
// rolls with lateral load and pitches under acceleration and braking.

export const KART_SCALE = 1.25;
const WHEEL_RADIUS = 0.21 * KART_SCALE;

export class KartView {
  readonly root = new THREE.Group();
  private readonly body = new THREE.Group();
  private readonly wheels: THREE.Object3D[] = [];
  private readonly frontWheels: THREE.Object3D[] = [];
  private readonly rearLocal: THREE.Vector3[] = [];
  private roll = 0;
  private pitch = 0;
  private wheelSpin = 0;
  private blob: THREE.Mesh;
  private livery: THREE.Material | null = null;

  constructor(model: THREE.Group, livery?: string) {
    const kart = model.clone(true);
    kart.scale.setScalar(KART_SCALE);
    kart.traverse((o) => {
      // The chassis mesh is named after the model ("kart-oobi_1"); tint only that one.
      const mesh = o as THREE.Mesh;
      if (livery && mesh.isMesh && mesh.name.startsWith("kart-") && !this.livery) {
        const mat = (mesh.material as THREE.MeshStandardMaterial).clone();
        mat.color.set(livery);
        mesh.material = mat;
        this.livery = mat;
      }
      const name = o.name.toLowerCase();
      if (!name.startsWith("wheel")) return;
      o.rotation.order = "YXZ";
      this.wheels.push(o);
      if (name.includes("front")) this.frontWheels.push(o);
      if (name.includes("back")) this.rearLocal.push(o.position.clone().multiplyScalar(KART_SCALE));
    });
    this.body.add(kart);
    this.root.add(this.body);

    // Soft contact shadow: grounds the kart even where the shadow map is coarse.
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext("2d")!;
    const grad = ctx.createRadialGradient(32, 32, 4, 32, 32, 32);
    grad.addColorStop(0, "rgba(0,0,0,0.55)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(canvas);
    this.blob = new THREE.Mesh(
      new THREE.PlaneGeometry(1.5, 2.2).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
    );
    this.blob.position.y = 0.035;
    this.blob.renderOrder = 1;
    this.root.add(this.blob);
  }

  /** World positions of the rear wheel contact patches (for skid marks and smoke). */
  rearContacts(out: [THREE.Vector3, THREE.Vector3]) {
    for (let i = 0; i < 2; i++) {
      const p = this.rearLocal[i];
      if (!p) continue;
      out[i]!.set(p.x + Math.sign(p.x) * 0.12, 0, p.z).applyMatrix4(this.root.matrixWorld);
      out[i]!.y = 0;
    }
  }

  update(state: KartState, x: number, y: number, z: number, yaw: number, dt: number) {
    this.root.position.set(x, y, z);
    this.root.rotation.y = yaw;

    const k = 1 - Math.exp(-8 * dt);
    const lateralAccel = state.forwardSpeed * state.yawRate;
    this.roll += (THREE.MathUtils.clamp(lateralAccel * 0.004, -0.09, 0.09) - this.roll) * k;
    this.pitch += (THREE.MathUtils.clamp(-state.accel * 0.0035, -0.07, 0.07) - this.pitch) * k;
    this.body.rotation.set(this.pitch, 0, this.roll, "YXZ");
    // A little bounce from sliding / speed.
    this.body.position.y = Math.abs(Math.sin(performance.now() * 0.03)) * 0.015 * state.slip;

    this.wheelSpin += (state.forwardSpeed / WHEEL_RADIUS) * dt;
    for (const w of this.wheels) w.rotation.x = this.wheelSpin;
    // Front wheels follow steering; in a drift they point where the kart is going (counter-steer).
    let steer = -state.steer * 0.45;
    if (state.drifting) {
      const speed = Math.hypot(state.vx, state.vz);
      if (speed > 1) {
        let slip = Math.atan2(state.vx, state.vz) - yaw;
        slip = Math.atan2(Math.sin(slip), Math.cos(slip));
        steer = THREE.MathUtils.clamp(slip, -0.6, 0.6);
      }
    }
    for (const w of this.frontWheels)
      w.rotation.y += (steer - w.rotation.y) * (1 - Math.exp(-14 * dt));
  }

  dispose() {
    this.livery?.dispose();
    this.blob.geometry.dispose();
    const mat = this.blob.material as THREE.MeshBasicMaterial;
    mat.map?.dispose();
    mat.dispose();
  }
}
