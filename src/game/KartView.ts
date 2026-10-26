import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { VEHICLE } from "./assets";
import type { KartState } from "./Vehicle";

// Visual kart: the Car Kit single-seater (VEHICLE in assets.ts) animated from the arcade model's
// state, with a small procedural driver in the livery colours seated in its cockpit. Wheels spin
// with forward speed, front wheels steer (and counter-steer in a drift), the body rolls with
// lateral load and pitches under acceleration and braking, and the driver leans into corners.

/** The driver is modelled in these units (metres = units × DRIVER_UNITS). */
const DRIVER_UNITS = 1;
/** Driver-model point at the centre of the helmet (see buildDriver). */
const HELMET = { y: 0.79, z: -0.13 };
/** Cockpit deck height in car-model units: the driver's lean pivots here. */
const SEAT_Y = 0.49;

/**
 * The car's palette texture with its red swatches (the bodywork) repainted in a livery colour,
 * keeping each swatch's shading. Other colours (tyres, metal, number panels) are untouched.
 */
function liveryTexture(source: THREE.Texture | null, livery: string): THREE.Texture | null {
  const image = source?.image as CanvasImageSource & { width: number; height: number };
  if (!source || !image?.width) return source;
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = data.data;
  const c = new THREE.Color(livery);
  const [lr, lg, lb] = [c.r * 255, c.g * 255, c.b * 255];
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i]!;
    const g = px[i + 1]!;
    const b = px[i + 2]!;
    if (r > 110 && r > g * 1.7 && r > b * 1.7) {
      const shade = Math.min(1.2, r / 225);
      px[i] = Math.min(255, lr * shade);
      px[i + 1] = Math.min(255, lg * shade);
      px[i + 2] = Math.min(255, lb * shade);
    }
  }
  ctx.putImageData(data, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.flipY = source.flipY;
  tex.colorSpace = source.colorSpace;
  tex.magFilter = source.magFilter;
  tex.minFilter = source.minFilter;
  tex.wrapS = source.wrapS;
  tex.wrapT = source.wrapT;
  return tex;
}

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
  private wheelRadius = 0.25;
  private readonly lean = new THREE.Group();
  private blob: THREE.Mesh;
  private readonly owned: {
    geometries: THREE.BufferGeometry[];
    materials: THREE.Material[];
    textures: THREE.Texture[];
  } = { geometries: [], materials: [], textures: [] };

  constructor(model: THREE.Group, livery: string) {
    const kart = model.clone(true);
    kart.scale.setScalar(VEHICLE.scale);
    // One material for the whole car (the kit shares a palette texture), repainted per livery.
    let material: THREE.MeshStandardMaterial | null = null;
    kart.traverse((o) => {
      const name = o.name.toLowerCase();
      const mesh = o as THREE.Mesh;
      if (name === "character") {
        o.visible = false;
        return;
      }
      if (mesh.isMesh) {
        if (!material) {
          material = (mesh.material as THREE.MeshStandardMaterial).clone();
          material.map = liveryTexture(material.map, livery);
          this.owned.materials.push(material);
          if (material.map) this.owned.textures.push(material.map);
        }
        mesh.material = material;
      }
      if (!name.startsWith("wheel")) return;
      o.rotation.order = "YXZ";
      this.wheels.push(o);
      // Wheel pivots sit at the axle: their height is the wheel radius.
      this.wheelRadius = o.position.y * VEHICLE.scale;
      if (name.includes("front")) this.frontWheels.push(o);
      if (name.includes("back"))
        this.rearLocal.push(o.position.clone().multiplyScalar(VEHICLE.scale));
    });
    // The driver keeps its real size whatever the car's scale, helmet at the cockpit point; the
    // lean pivot sits at seat level so leaning tilts the shoulders, not the whole figure.
    this.driver = this.buildDriver(livery);
    const k = DRIVER_UNITS / VEHICLE.scale;
    this.driver.scale.setScalar(k);
    this.driver.position.set(0, VEHICLE.helmet.y - SEAT_Y - HELMET.y * k, -HELMET.z * k);
    this.lean.position.set(0, SEAT_Y, VEHICLE.helmet.z);
    this.lean.add(this.driver);
    kart.add(this.lean);
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
    this.lean.rotation.z = -this.roll * 1.6;

    this.wheelSpin += (state.forwardSpeed / this.wheelRadius) * dt;
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
    for (const t of this.owned.textures) t.dispose();
    this.blob.geometry.dispose();
    const mat = this.blob.material as THREE.MeshBasicMaterial;
    mat.map?.dispose();
    mat.dispose();
  }
}
