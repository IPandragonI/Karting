import * as THREE from "three";
import { vehicleById, type Models, type VehicleId } from "./assets";
import { KartView } from "./KartView";

// The garage's turntable: its own small renderer, scene, camera and lights, separate from the game
// (no physics, no game camera). The vehicle is built by KartView, so it wears the player's livery
// exactly as on track. It only renders while the garage is open, and the game skips its own
// frames meanwhile (Game.render), so the two never draw at the same time.

const PLATFORM_RADIUS = 2;
const PLATFORM_TOP = 0.28;
/** Turntable speed (rad/s) and how long a drag keeps spinning on its own (s). */
const SPIN = 0.5;
const DRAG_DECAY = 0.6;

export class GaragePreview {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  private readonly turntable = new THREE.Group();
  private readonly owned: { dispose: () => void }[] = [];
  private view: KartView | null = null;
  private raf = 0;
  private last = 0;
  private angle = -0.6;
  private dragVelocity = 0;
  private dragging: { x: number; t: number } | null = null;
  /** Pop-in of a newly shown vehicle (0 → 1). */
  private appear = 1;
  private readonly resizeObserver: ResizeObserver;
  /**
   * Its own canvas, made and removed with the preview: a canvas keeps the WebGL context it was
   * first given (even once lost), so each preview needs a fresh one.
   */
  private readonly canvas = document.createElement("canvas");

  constructor(
    private readonly container: HTMLElement,
    private readonly models: Models,
    private readonly livery: string,
  ) {
    const canvas = this.canvas;
    canvas.className = "block h-full w-full";
    container.appendChild(canvas);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    // Studio light: cool sky fill, a warm key casting one small shadow, a rim light behind.
    this.scene.add(new THREE.HemisphereLight("#dcecff", "#3a3f4a", 1.6));
    const key = new THREE.DirectionalLight("#fff1dc", 2.6);
    key.position.set(4, 7, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    const sc = key.shadow.camera;
    sc.left = sc.bottom = -3;
    sc.right = sc.top = 3;
    sc.near = 1;
    sc.far = 20;
    key.shadow.radius = 4;
    key.shadow.bias = -0.0005;
    const rim = new THREE.DirectionalLight("#9fc6ff", 1.4);
    rim.position.set(-5, 3, -6);
    this.scene.add(key, rim);

    this.buildPlatform();
    this.scene.add(this.turntable);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    canvas.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
  }

  /** Display platform: a low-poly plinth with a lit rim and a turning top. */
  private buildPlatform() {
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(PLATFORM_RADIUS + 0.15, PLATFORM_RADIUS + 0.35, 0.18, 40),
      new THREE.MeshStandardMaterial({ color: "#2b2f36", roughness: 0.8 }),
    );
    base.position.y = 0.09;
    base.receiveShadow = true;
    const rim = new THREE.Mesh(
      new THREE.CylinderGeometry(PLATFORM_RADIUS + 0.06, PLATFORM_RADIUS + 0.06, 0.05, 40, 1, true),
      new THREE.MeshStandardMaterial({
        color: "#e5483b",
        emissive: "#e5483b",
        emissiveIntensity: 0.6,
        side: THREE.DoubleSide,
      }),
    );
    rim.position.y = PLATFORM_TOP - 0.06;
    const top = new THREE.Mesh(
      new THREE.CylinderGeometry(PLATFORM_RADIUS, PLATFORM_RADIUS, 0.1, 40),
      new THREE.MeshStandardMaterial({ color: "#454b55", roughness: 0.55, metalness: 0.15 }),
    );
    top.position.y = PLATFORM_TOP - 0.05;
    top.receiveShadow = true;
    // A ring on the turning top, so its rotation reads.
    const stripes = new THREE.Mesh(
      new THREE.RingGeometry(PLATFORM_RADIUS * 0.82, PLATFORM_RADIUS * 0.9, 40, 1)
        .rotateX(-Math.PI / 2)
        .translate(0, PLATFORM_TOP + 0.002, 0),
      new THREE.MeshStandardMaterial({ color: "#f2efe6", roughness: 0.6 }),
    );
    stripes.receiveShadow = true;
    // Soft floor glow under the plinth.
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(PLATFORM_RADIUS * 2.2, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: glowTexture(), transparent: true, depthWrite: false }),
    );
    floor.position.y = 0.005;
    this.scene.add(base, rim, floor);
    this.turntable.add(top, stripes);
    for (const m of [base, rim, top, stripes, floor]) {
      this.owned.push(m.geometry);
      const mat = m.material as THREE.MeshStandardMaterial;
      this.owned.push(mat);
      if (mat.map) this.owned.push(mat.map);
    }
  }

  /** Shows a vehicle on the turntable (with a short pop-in), framing the camera to its size. */
  show(id: VehicleId) {
    const vehicle = vehicleById(id);
    if (this.view) {
      this.turntable.remove(this.view.root);
      this.view.dispose();
    }
    const view = new KartView(this.models[vehicle.model], this.livery, vehicle);
    view.root.position.y = PLATFORM_TOP;
    view.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
    this.turntable.add(view.root);
    this.view = view;
    this.appear = 0;
    const box = new THREE.Box3().setFromObject(view.root);
    const size = box.getSize(new THREE.Vector3());
    // Framed on the footprint (the kart's tall driver must not push the camera away), the
    // plinth's front edge in view.
    const length = Math.max(size.x, size.z);
    const d = 1.35 * length + 2.1;
    this.camera.position.set(d * 0.72, PLATFORM_TOP + 1.1 + length * 0.35, d * 0.72);
    this.camera.lookAt(0, PLATFORM_TOP + size.y * 0.3, 0);
  }

  start() {
    if (this.raf) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private readonly loop = (now: number) => {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (!this.dragging) {
      this.angle += (SPIN + this.dragVelocity) * dt;
      this.dragVelocity *= Math.exp(-dt / DRAG_DECAY);
    }
    this.turntable.rotation.y = this.angle;
    if (this.view && this.appear < 1) {
      this.appear = Math.min(1, this.appear + dt * 4);
      const e = 1 - Math.pow(1 - this.appear, 3);
      this.view.root.scale.setScalar(0.85 + 0.15 * e);
      this.view.root.position.y = PLATFORM_TOP + (1 - e) * 0.35;
    }
    this.renderer.render(this.scene, this.camera);
    this.raf = requestAnimationFrame(this.loop);
  };

  private resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private readonly onPointerDown = (e: PointerEvent) => {
    this.dragging = { x: e.clientX, t: performance.now() };
    this.dragVelocity = 0;
  };

  private readonly onPointerMove = (e: PointerEvent) => {
    const d = this.dragging;
    if (!d) return;
    const now = performance.now();
    const turn = ((e.clientX - d.x) / Math.max(1, this.canvas.clientWidth)) * Math.PI * 2;
    this.angle += turn;
    this.dragVelocity = turn / Math.max(0.008, (now - d.t) / 1000) - SPIN;
    this.dragging = { x: e.clientX, t: now };
  };

  private readonly onPointerUp = () => {
    this.dragging = null;
  };

  dispose() {
    this.stop();
    this.resizeObserver.disconnect();
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    this.view?.dispose();
    for (const o of this.owned) o.dispose();
    this.renderer.dispose();
    // The garage opens and closes often: give the WebGL context back right away.
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }
}

/** Radial glow for the floor under the plinth. */
function glowTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(64, 64, 10, 64, 64, 64);
  g.addColorStop(0, "rgba(229,72,59,0.35)");
  g.addColorStop(0.5, "rgba(229,72,59,0.08)");
  g.addColorStop(1, "rgba(229,72,59,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
