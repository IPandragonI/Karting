import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { KartState } from "./Vehicle";

// Visual kart: the Kenney kart chassis animated from the arcade model's state, with a small
// procedural driver in the livery colours (the Car Kit character's oversized round head read as a
// placeholder ball from the chase cameras). Wheels spin with forward speed, front wheels steer
// (and counter-steer in a drift), the body rolls with lateral load and pitches under
// acceleration and braking, and the driver leans into corners.

export const KART_SCALE = 1.25;
const WHEEL_RADIUS = 0.21 * KART_SCALE;

export class KartView {
  readonly root = new THREE.Group();
  private readonly body = new THREE.Group();
  private readonly driver: THREE.Group;
  private readonly wheels: THREE.Object3D[] = [];
  private readonly frontWheels: THREE.Object3D[] = [];
  private readonly rearLocal: THREE.Vector3[] = [];
  /** Visual chassis attitude (rad), shared with the first-person camera. */
  roll = 0;
  pitch = 0;
  /** Smoothed slope of the road under the kart (rad, nose up positive). */
  slope = 0;
  private accel = 0;
  private wheelSpin = 0;
  private blob: THREE.Mesh;
  private readonly owned: { geometries: THREE.BufferGeometry[]; materials: THREE.Material[] } = {
    geometries: [],
    materials: [],
  };

  constructor(model: THREE.Group, livery: string) {
    const kart = model.clone(true);
    kart.scale.setScalar(KART_SCALE);
    let tinted = false;
    kart.traverse((o) => {
      const name = o.name.toLowerCase();
      const mesh = o as THREE.Mesh;
      if (name === "character") {
        o.visible = false;
        return;
      }
      // The chassis mesh is named after the model ("kart-oobi_1"); tint only that one.
      if (mesh.isMesh && name.startsWith("kart-") && !tinted) {
        const mat = (mesh.material as THREE.MeshStandardMaterial).clone();
        mat.color.set(livery);
        mesh.material = mat;
        this.owned.materials.push(mat);
        tinted = true;
      }
      if (!name.startsWith("wheel")) return;
      o.rotation.order = "YXZ";
      this.wheels.push(o);
      if (name.includes("front")) this.frontWheels.push(o);
      if (name.includes("back")) this.rearLocal.push(o.position.clone().multiplyScalar(KART_SCALE));
    });
    this.driver = this.buildDriver(livery);
    kart.add(this.driver);
    this.body.add(kart);
    this.root.add(this.body);

    // Soft contact shadow: grounds the kart even where the shadow map is coarse.
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext("2d")!;
    const grad = ctx.createRadialGradient(32, 32, 4, 32, 32, 32);
    grad.addColorStop(0, "rgba(0,0,0,0.5)");
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

  /**
   * Seated driver in kart-model units (the kart group is scaled by KART_SCALE): suit, arms reaching
   * for the steering wheel, and a smooth helmet with a dark visor facing forward (+Z).
   */
  private buildDriver(livery: string): THREE.Group {
    const g = new THREE.Group();
    const suitColor = new THREE.Color(livery).multiplyScalar(0.8);
    const suit = new THREE.MeshStandardMaterial({ color: suitColor, roughness: 0.8 });
    const helmet = new THREE.MeshStandardMaterial({
      color: livery,
      roughness: 0.35,
      metalness: 0.1,
    });
    const stripe = new THREE.MeshStandardMaterial({ color: "#f4f2ec", roughness: 0.4 });
    const visor = new THREE.MeshStandardMaterial({
      color: "#151b24",
      roughness: 0.15,
      metalness: 0.4,
    });
    const glove = new THREE.MeshStandardMaterial({ color: "#2a2c31", roughness: 0.9 });
    this.owned.materials.push(suit, helmet, stripe, visor, glove);
    const geo = <T extends THREE.BufferGeometry>(x: T) => {
      this.owned.geometries.push(x);
      return x;
    };
    const add = (
      geometry: THREE.BufferGeometry,
      material: THREE.Material,
      setup: (m: THREE.Mesh) => void,
    ) => {
      const m = new THREE.Mesh(geometry, material);
      m.castShadow = true;
      setup(m);
      g.add(m);
      return m;
    };

    // Torso, leaning back into the seat.
    add(geo(new THREE.CapsuleGeometry(0.13, 0.16, 6, 12)), suit, (m) => {
      m.position.set(0, 0.5, -0.17);
      m.rotation.x = -0.25;
      m.scale.set(1.15, 1, 0.85);
    });
    // Arms: from the shoulders down to the steering wheel.
    const arm = geo(new THREE.CapsuleGeometry(0.045, 0.22, 4, 8));
    const hand = geo(new THREE.SphereGeometry(0.05, 10, 8));
    for (const side of [-1, 1]) {
      const shoulder = new THREE.Vector3(side * 0.15, 0.6, -0.12);
      const grip = new THREE.Vector3(side * 0.11, 0.48, 0.14);
      const mid = shoulder.clone().add(grip).multiplyScalar(0.5);
      const dir = grip.clone().sub(shoulder).normalize();
      add(arm, suit, (m) => {
        m.position.copy(mid);
        m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      });
      add(hand, glove, (m) => m.position.copy(grip));
    }
    // Helmet with a white stripe and a visor on the front.
    const head = new THREE.Group();
    head.position.set(0, 0.79, -0.13);
    g.add(head);
    const shell = new THREE.Mesh(geo(new THREE.SphereGeometry(0.135, 20, 14)), helmet);
    shell.scale.set(1, 0.95, 1.1);
    shell.castShadow = true;
    head.add(shell);
    const band = new THREE.Mesh(geo(new THREE.TorusGeometry(0.128, 0.018, 6, 24)), stripe);
    band.rotation.y = Math.PI / 2;
    band.scale.set(1, 1, 1.1);
    head.add(band);
    const vis = new THREE.Mesh(
      geo(
        new THREE.SphereGeometry(
          0.139,
          20,
          8,
          Math.PI * 0.12,
          Math.PI * 0.76,
          Math.PI * 0.36,
          Math.PI * 0.2,
        ),
      ),
      visor,
    );
    // Sphere segments start at −X and sweep through +Z: centre the visor on the front.
    vis.scale.set(1, 0.95, 1.1);
    head.add(vis);
    return this.mergeByMaterial(g, new Set([suit, helmet]));
  }

  /**
   * Bakes the driver's parts into one mesh per material (9 meshes → 5 draw calls), and lets only
   * the large parts cast shadows: visor, stripe and gloves are too small to show in the shadow
   * map, yet each one would cost an extra draw in the shadow pass.
   */
  private mergeByMaterial(g: THREE.Group, shadowCasters: Set<THREE.Material>): THREE.Group {
    g.updateMatrixWorld(true);
    const parts = new Map<THREE.Material, THREE.BufferGeometry[]>();
    g.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mat = mesh.material as THREE.Material;
      const list = parts.get(mat) ?? [];
      list.push(mesh.geometry.clone().applyMatrix4(mesh.matrixWorld));
      parts.set(mat, list);
    });
    const merged = new THREE.Group();
    for (const [mat, list] of parts) {
      const geometry = mergeGeometries(list)!;
      for (const piece of list) piece.dispose();
      this.owned.geometries.push(geometry);
      const mesh = new THREE.Mesh(geometry, mat);
      mesh.castShadow = shadowCasters.has(mat);
      merged.add(mesh);
    }
    // The source geometries are no longer needed.
    g.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.geometry.dispose();
    });
    return merged;
  }

  /** Hide the driver for the first-person camera (the camera sits in their helmet). */
  setDriverVisible(visible: boolean) {
    this.driver.visible = visible;
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

  /** `slope`: road slope along the heading (rad, nose up), or the flight path when airborne. */
  update(state: KartState, x: number, y: number, z: number, yaw: number, dt: number, slope = 0) {
    this.root.position.set(x, y, z);
    // Filtered so the kart settles onto a ramp instead of snapping at the joint.
    this.slope += (slope - this.slope) * (1 - Math.exp(-14 * dt));
    this.root.rotation.set(-this.slope, yaw, 0, "YXZ");

    // The per-step acceleration is noisy (collisions, lateral scrub): filter it before it drives
    // the pitch, so the chassis leans smoothly instead of twitching.
    this.accel += (state.accel - this.accel) * (1 - Math.exp(-5 * dt));
    const k = 1 - Math.exp(-6 * dt);
    const lateralAccel = state.forwardSpeed * state.yawRate;
    this.roll += (THREE.MathUtils.clamp(lateralAccel * 0.0035, -0.08, 0.08) - this.roll) * k;
    this.pitch += (THREE.MathUtils.clamp(-this.accel * 0.003, -0.06, 0.06) - this.pitch) * k;
    this.body.rotation.set(this.pitch, 0, this.roll, "YXZ");
    // The driver leans into the corner a little more than the chassis rolls out of it.
    this.driver.rotation.z = -this.roll * 1.6;

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
    for (const g of this.owned.geometries) g.dispose();
    for (const m of this.owned.materials) m.dispose();
    this.blob.geometry.dispose();
    const mat = this.blob.material as THREE.MeshBasicMaterial;
    mat.map?.dispose();
    mat.dispose();
  }
}
