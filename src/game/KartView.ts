import * as THREE from "three";
import type { VehicleDef } from "./assets";
import type { KartState } from "./Vehicle";

// Visual kart: the selected Car Kit vehicle (VEHICLES in assets.ts) animated from the arcade
// model's state. Wheels spin with forward speed, front wheels steer (and counter-steer in a drift), the body rolls with
// lateral load and pitches under acceleration and braking, and the driver leans into corners.

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
  /** The kit's driver figure, when the vehicle shows it (hidden in first person). */
  private readonly character: THREE.Object3D[] = [];
  private readonly owned: {
    geometries: THREE.BufferGeometry[];
    materials: THREE.Material[];
    textures: THREE.Texture[];
  } = { geometries: [], materials: [], textures: [] };

  constructor(
    model: THREE.Group,
    livery: string,
    readonly vehicle: VehicleDef,
  ) {
    const scale = vehicle.scale;
    const kart = model.clone(true);
    kart.scale.setScalar(scale);
    // One material for the whole car (the kit shares a palette texture), repainted per livery.
    let material: THREE.MeshStandardMaterial | null = null;
    kart.traverse((o) => {
      const name = o.name.toLowerCase();
      const mesh = o as THREE.Mesh;
      if (name === "character") {
        o.visible = vehicle.character;
        this.character.push(o);
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
      this.wheelRadius = o.position.y * scale;
      if (name.includes("front")) this.frontWheels.push(o);
      if (name.includes("back")) this.rearLocal.push(o.position.clone().multiplyScalar(scale));
    });
    // The driver keeps its real size whatever the car's scale, helmet at the cockpit point; the
    // lean pivot sits at seat level so leaning tilts the shoulders, not the whole figure.
    this.lean.position.set(0, SEAT_Y, vehicle.helmet?.z ?? 0);
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
    // Sized to the vehicle (the truck is wider and longer than the single-seater).
    const k = scale / 0.82;
    this.blob = new THREE.Mesh(
      new THREE.PlaneGeometry(1.5 * k, 2.2 * k).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
    );
    this.blob.position.y = 0.035;
    this.blob.renderOrder = 1;
    this.root.add(this.blob);
  }

  /**
   * First person: the kit's driver figure would fill the view, so it is hidden, and the
   * (double-sided) bodywork is drawn front faces only, so from inside a closed cabin the roof and
   * doors vanish while the bonnet ahead stays in view.
   */
  setFirstPerson(on: boolean) {
    for (const c of this.character) c.visible = this.vehicle.character && !on;
    for (const m of this.owned.materials) {
      m.side = on ? THREE.FrontSide : THREE.DoubleSide;
      m.needsUpdate = true;
    }
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
