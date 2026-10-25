import * as THREE from "three";
import { KART_LIVERY, loadKart, loadModels, type KartModel, type Models } from "./assets";
import { AudioManager } from "./AudioManager";
import { CameraRig } from "./Camera";
import { Particles, SkidMarks } from "./Effects";
import { InputManager } from "./InputManager";
import { KartView } from "./KartView";
import { KART_RADIUS, Physics } from "./Physics";
import { RaceManager, type RaceEvent } from "./RaceManager";
import { createForest, createGround, createSky, Lighting, PALETTE, type Forest } from "./Scenery";
import { Store } from "./store";
import { createDefaultTrack } from "./track/defaultTrack";
import { CELL, ROAD_HALF, TIRE_RADIUS, WALL_OFFSET } from "./track/pieces";
import {
  analyzeTrack,
  buildRacePath,
  cloneTrack,
  isRaceable,
  queryTrack,
  startGrid,
  toWorld,
  trackBounds,
  trackId,
  type RacePath,
  type TrackData,
  type TrackLayout,
  type Issue,
  type TrackQuery,
} from "./track/Track";
import { buildTrack, type BuiltTrack } from "./track/TrackBuilder";
import { fromJson, toJson, trackFromHash } from "./track/TrackSerializer";
import { TrackEditor, type EditorTool, type EditorUi } from "./TrackEditor";
import {
  afterCollision,
  ASPHALT,
  createKartState,
  GRASS,
  KART,
  stepKart,
  type KartState,
} from "./Vehicle";

export type Screen = "loading" | "menu" | "playing" | "paused" | "finished" | "editor" | "error";
export type Mode = "free" | "trial";

export type Toast = { id: number; text: string; tone: "info" | "success" | "warning" };

export type RaceUi = {
  lap: number;
  totalLaps: number;
  laps: number[];
  bestLap: number | null;
  recordLap: number | null;
};

export type FinishUi = { total: number; bestLap: number; newRecord: boolean; laps: number[] };

export type UiState = {
  screen: Screen;
  mode: Mode;
  loadProgress: number;
  error: string | null;
  trackName: string;
  /** Whether the loaded track is a valid closed circuit (time trial needs one). */
  raceable: boolean;
  kartModel: KartModel;
  muted: boolean;
  /** Countdown: number of red lights lit (1..5), "go" for a moment after the start, or null. */
  countdown: number | "go" | null;
  race: RaceUi;
  finish: FinishUi | null;
  toast: Toast | null;
  stuckHint: boolean;
  wrongWay: boolean;
  editor: EditorUi;
  /** Validation result of the current track. */
  issues: Issue[];
  /** True when the track being driven came from the editor (pause menu offers to go back). */
  fromEditor: boolean;
};

/** Values sampled every rendered frame for the HUD (never stored in React state). */
export type FrameInfo = {
  speed: number;
  offTrack: boolean;
  drifting: boolean;
  lapTime: number;
  timing: boolean;
  x: number;
  z: number;
  yaw: number;
};

const STEP = 1 / 120;
const MAX_STEPS = 8;
const TRIAL_LAPS = 3;
const BEST_KEY = "karting:best:";
const KART_KEY = "karting:kart";
const TRACK_KEY = "karting:track";

function readNumber(key: string): number | null {
  try {
    const v = localStorage.getItem(key);
    const n = v === null ? NaN : Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage blocked (private mode): records only last for this session.
  }
}

const _wheels: [THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(), new THREE.Vector3()];

export class Game {
  readonly store = new Store<UiState>({
    screen: "loading",
    mode: "trial",
    loadProgress: 0,
    error: null,
    trackName: "",
    raceable: true,
    kartModel: "kart-oobi",
    muted: false,
    countdown: null,
    race: { lap: 1, totalLaps: TRIAL_LAPS, laps: [], bestLap: null, recordLap: null },
    finish: null,
    toast: null,
    stuckHint: false,
    wrongWay: false,
    editor: {
      tool: "straight",
      rot: 0,
      canUndo: false,
      canRedo: false,
      hint: null,
      hintOk: true,
      preview: false,
    },
    issues: [],
    fromEditor: false,
  });
  readonly input = new InputManager();
  readonly audio = new AudioManager();

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly rig: CameraRig;
  private readonly lighting: Lighting;
  private readonly skids = new SkidMarks();
  private readonly particles = new Particles();
  private models: Models | null = null;
  private editor: TrackEditor | null = null;

  private track: TrackData = createDefaultTrack();
  private layout: TrackLayout = analyzeTrack(this.track);
  private path: RacePath = buildRacePath(this.track, this.layout);
  private built: BuiltTrack | null = null;
  private forest: Forest | null = null;
  private props: THREE.Object3D[] = [];
  private propGeometry: THREE.BufferGeometry[] = [];
  private coneMeshes: { mesh: THREE.Object3D; body: Physics["cones"][number] }[] = [];

  private physics: Physics | null = null;
  private kart: KartState = createKartState();
  private kartView: KartView | null = null;
  private lastQuery: TrackQuery | null = null;
  private onTrackQuery: TrackQuery | null = null;
  private race = new RaceManager(1, TRIAL_LAPS, null);
  private readonly line = { x: 0, z: 0, fx: 0, fz: 1 };

  // Interpolation between fixed physics steps.
  private readonly prevPos = new THREE.Vector3();
  private readonly currPos = new THREE.Vector3();
  private prevYaw = 0;
  private currYaw = 0;

  private raf = 0;
  private lastTime = 0;
  private accumulator = 0;
  private elapsed = 0;
  private stuckTime = 0;
  private wrongWayTime = 0;
  private goTimer = 0;
  private toastId = 0;
  private toastTimer = 0;
  private emitTimer = 0;
  private lastThrottle = 0;
  private disposed = false;
  private readonly frameListeners = new Set<(f: FrameInfo) => void>();
  private readonly frame: FrameInfo = {
    speed: 0,
    offTrack: false,
    drifting: false,
    lapTime: 0,
    timing: false,
    x: 0,
    z: 0,
    yaw: 0,
  };
  private readonly resizeObserver: ResizeObserver;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene.fog = new THREE.Fog(PALETTE.skyHorizon, 110, 360);
    this.scene.add(createSky(), createGround(), this.skids.mesh, this.particles.points);
    this.lighting = new Lighting(this.scene);
    this.rig = new CameraRig(1);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();

    this.input.onAction = (a) => {
      if (a === "reset") this.resetKart();
      if (a === "pause") this.togglePause();
    };
    this.input.attach();
    document.addEventListener("visibilitychange", this.onVisibility);

    let kartModel = this.store.get().kartModel;
    try {
      const saved = localStorage.getItem(KART_KEY);
      if (saved && saved.startsWith("kart-")) kartModel = saved as KartModel;
    } catch {
      // Keep the default kart.
    }
    this.store.set({ muted: this.audio.muted, kartModel });
  }

  /**
   * Track to start with: a shared link (#track=…) wins, then the last circuit built in the
   * editor, then the default circuit.
   */
  initialTrack(): TrackData | undefined {
    const shared = trackFromHash(window.location.hash);
    if (shared?.ok) {
      this.pendingToast = { text: `Loaded shared circuit “${shared.track.name}”`, tone: "success" };
      return shared.track;
    }
    if (shared && !shared.ok) {
      this.pendingToast = {
        text: `Could not open the shared circuit: ${shared.error}`,
        tone: "warning",
      };
    }
    try {
      const saved = localStorage.getItem(TRACK_KEY);
      if (saved) {
        const r = fromJson(saved);
        if (r.ok) return r.track;
      }
    } catch {
      // Storage unavailable: fall back to the default circuit.
    }
    return undefined;
  }

  private pendingToast: { text: string; tone: Toast["tone"] } | null = null;

  async init(initialTrack?: TrackData) {
    try {
      this.models = await loadModels(this.store.get().kartModel, (loaded, total) =>
        this.store.set({ loadProgress: loaded / total }),
      );
    } catch (err) {
      console.error(err);
      this.store.set({
        screen: "error",
        error: "Could not load the 3D models. Check your connection and reload.",
      });
      return;
    }
    if (this.disposed) return;
    this.editor = new TrackEditor(
      {
        scene: this.scene,
        canvas: this.canvas,
        camera: () => this.rig.camera,
        models: () => this.models,
        onChange: (track) => this.loadTrack(track, { forest: this.editor?.isPreview ?? false }),
        onUi: (ui) => this.store.set({ editor: { ...this.store.get().editor, ...ui } }),
        onNote: (text, tone) => this.toast(text, tone === "warning" ? "warning" : "info", 1.6),
      },
      this.track,
    );
    this.loadTrack(initialTrack ?? this.track);
    this.store.set({ screen: "menu" });
    if (this.pendingToast) this.toast(this.pendingToast.text, this.pendingToast.tone, 4);
    this.lastTime = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.input.detach();
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.audio.dispose();
    this.resizeObserver.disconnect();
    this.clearTrack();
    this.editor?.dispose();
    this.kartView?.dispose();
    this.skids.dispose();
    this.particles.dispose();
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry.dispose();
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) m.dispose();
      }
    });
    this.renderer.dispose();
  }

  /** Hidden tabs get throttled to ~1 fps by the browser: pause instead of crawling. */
  private readonly onVisibility = () => {
    if (document.hidden) this.pause();
  };

  onFrame(listener: (f: FrameInfo) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  getTrack(): TrackData {
    return cloneTrack(this.track);
  }

  getRacePath(): RacePath {
    return this.path;
  }

  // ─── Track ───────────────────────────────────────────────────────────────

  loadTrack(track: TrackData, opts: { forest?: boolean } = {}) {
    if (!this.models) {
      this.track = cloneTrack(track);
      return;
    }
    this.clearTrack();
    this.track = cloneTrack(track);
    this.layout = analyzeTrack(this.track);
    this.path = buildRacePath(this.track, this.layout);
    this.built = buildTrack(this.track, this.layout, this.models);
    this.scene.add(this.built.group);
    if (opts.forest ?? true) {
      this.forest = createForest(this.track, this.models);
      this.scene.add(this.forest.group);
    }
    this.skids.clear();
    this.particles.clear();

    // Start/finish line in world space, for crossing detection.
    const start = this.track.pieces[this.layout.startIndex];
    if (start) {
      const c = toWorld(start, { x: 0, z: 0 });
      this.line.x = c.x;
      this.line.z = c.z;
      this.line.fx = Math.sin((start.rot * Math.PI) / 2);
      this.line.fz = Math.cos((start.rot * Math.PI) / 2);
    }
    const raceable = isRaceable(this.layout);
    this.race = new RaceManager(
      this.layout.order.length || 1,
      TRIAL_LAPS,
      readNumber(BEST_KEY + trackId(this.track)),
    );
    this.store.set({
      trackName: this.track.name,
      raceable,
      race: this.raceUi(),
      issues: this.layout.issues,
    });
    this.buildPhysics();
  }

  private clearTrack() {
    if (this.built) {
      this.scene.remove(this.built.group);
      this.built.dispose();
      this.built = null;
    }
    if (this.forest) {
      this.scene.remove(this.forest.group);
      this.forest.dispose();
      this.forest = null;
    }
    for (const p of this.props) this.scene.remove(p);
    for (const g of this.propGeometry) g.dispose();
    this.props = [];
    this.propGeometry = [];
    this.coneMeshes = [];
  }

  private buildPhysics() {
    const grid = startGrid(this.track, this.layout);
    const physics = new Physics(grid);
    for (const w of this.built?.walls ?? []) physics.addWall(w, TIRE_RADIUS);
    // Outer boundary so nobody drives off into the void.
    const b = trackBounds(this.track);
    const m = CELL * 3;
    const x0 = b.minX - m;
    const x1 = b.maxX + m;
    const z0 = b.minZ - m;
    const z1 = b.maxZ + m;
    for (const seg of [
      { x1: x0, z1: z0, x2: x1, z2: z0 },
      { x1: x1, z1: z0, x2: x1, z2: z1 },
      { x1: x1, z1: z1, x2: x0, z2: z1 },
      { x1: x0, z1: z1, x2: x0, z2: z0 },
    ]) {
      physics.addWall(seg, 1, 3);
    }

    let tireGeo: THREE.BufferGeometry | null = null;
    const tireMat = new THREE.MeshLambertMaterial({ color: "#2a2c31" });
    for (const prop of this.track.props) {
      if (prop.type === "tires") {
        physics.addTireStack(prop.x, prop.z);
        if (!tireGeo) {
          tireGeo = new THREE.TorusGeometry(0.3, 0.13, 6, 10).rotateX(Math.PI / 2);
          this.propGeometry.push(tireGeo);
        }
        const stack = new THREE.Group();
        for (let i = 0; i < 3; i++) {
          const t = new THREE.Mesh(tireGeo, tireMat);
          t.position.y = 0.13 + i * 0.26;
          t.castShadow = true;
          stack.add(t);
        }
        stack.position.set(prop.x, 0, prop.z);
        this.scene.add(stack);
        this.props.push(stack);
      } else if (this.models) {
        const body = physics.addCone(prop.x, prop.z);
        const mesh = this.models.cone.clone();
        mesh.scale.setScalar(1.2);
        // The cone model's base is at y = 0; the physics cylinder is centred at its middle.
        const holder = new THREE.Group();
        mesh.position.y = -0.36;
        holder.add(mesh);
        this.scene.add(holder);
        this.props.push(holder);
        this.coneMeshes.push({ mesh: holder, body });
      }
    }
    this.physics = physics;
    this.placeKart(grid.x, grid.z, grid.yaw);
  }

  // ─── Kart ────────────────────────────────────────────────────────────────

  private ensureKartView() {
    if (this.kartView || !this.models) return;
    const kartModel = this.store.get().kartModel;
    const model = this.models.karts[kartModel];
    if (!model) return;
    this.kartView = new KartView(model, KART_LIVERY[kartModel]);
    this.scene.add(this.kartView.root);
    this.kartView.update(this.kart, this.currPos.x, 0, this.currPos.z, this.currYaw, 0);
  }

  async setKartModel(model: KartModel) {
    this.store.set({ kartModel: model });
    write(KART_KEY, model);
    if (!this.models) return;
    try {
      await loadKart(this.models, model);
    } catch {
      this.toast("Could not load that kart. Check your connection.", "warning");
      return;
    }
    // Another driver may have been picked while this one was downloading.
    if (this.store.get().kartModel !== model) return;
    if (this.kartView) {
      this.scene.remove(this.kartView.root);
      this.kartView.dispose();
      this.kartView = null;
    }
    this.ensureKartView();
  }

  setMuted(muted: boolean) {
    this.audio.setMuted(muted);
    this.store.set({ muted });
  }

  private placeKart(x: number, z: number, yaw: number) {
    this.ensureKartView();
    this.physics?.teleportKart(x, z);
    this.kart = createKartState(yaw);
    this.prevPos.set(x, KART_RADIUS, z);
    this.currPos.copy(this.prevPos);
    this.prevYaw = this.currYaw = yaw;
    this.lastQuery = this.onTrackQuery = queryTrack(this.layout, this.path, x, z);
    this.stuckTime = 0;
    this.wrongWayTime = 0;
    this.store.set({ stuckHint: false, wrongWay: false });
    this.rig.cut();
  }

  /** R: back onto the centerline of the last piece we were on, facing the race direction. */
  resetKart() {
    if (this.store.get().screen !== "playing" || this.race.phase === "countdown") return;
    const q = this.onTrackQuery;
    if (!q || !q.piece) {
      const g = startGrid(this.track, this.layout);
      this.placeKart(g.x, g.z, g.yaw);
      return;
    }
    this.placeKart(q.closest.x, q.closest.z, Math.atan2(q.tangent.x, q.tangent.z));
  }

  // ─── Flow ────────────────────────────────────────────────────────────────

  startDriving(mode: Mode) {
    this.audio.unlock();
    if (mode === "trial" && !this.store.get().raceable) mode = "free";
    this.buildPhysics();
    this.skids.clear();
    this.particles.clear();
    if (mode === "trial") this.race.startCountdown();
    else this.race.startFree();
    this.store.set({
      screen: "playing",
      mode,
      finish: null,
      countdown: null,
      toast: null,
      race: this.raceUi(),
    });
    this.updateLights(0, false);
    this.input.enabled = true;
    this.accumulator = 0;
    this.lastTime = performance.now();
  }

  restart() {
    this.startDriving(this.store.get().mode);
  }

  togglePause() {
    const s = this.store.get().screen;
    if (s === "playing") this.pause();
    else if (s === "paused") this.resume();
  }

  pause() {
    if (this.store.get().screen !== "playing") return;
    this.input.enabled = false;
    this.input.clear();
    this.store.set({ screen: "paused" });
  }

  resume() {
    if (this.store.get().screen !== "paused") return;
    this.audio.unlock();
    this.input.enabled = true;
    this.lastTime = performance.now();
    this.store.set({ screen: "playing" });
  }

  quitToMenu() {
    this.input.enabled = false;
    this.input.clear();
    this.updateLights(0, false);
    this.store.set({ screen: "menu", countdown: null, toast: null, finish: null });
  }

  // ─── Editor ──────────────────────────────────────────────────────────────

  openEditor() {
    if (!this.editor) return;
    this.input.enabled = false;
    this.input.clear();
    this.updateLights(0, false);
    this.store.set({
      screen: "editor",
      countdown: null,
      toast: null,
      finish: null,
      stuckHint: false,
      wrongWay: false,
    });
    this.loadTrack(this.track, { forest: false });
    this.editor.enable(cloneTrack(this.track));
  }

  /** Leave the editor: to the menu, or straight onto the track. */
  closeEditor(next: "menu" | Mode) {
    if (!this.editor) return;
    const track = this.editor.track;
    this.editor.disable();
    this.loadTrack(track);
    write(TRACK_KEY, toJson(track));
    this.store.set({ fromEditor: next !== "menu" });
    if (next === "menu") this.quitToMenu();
    else this.startDriving(next);
  }

  editorTool(tool: EditorTool) {
    this.editor?.setTool(tool);
  }

  editorRotate(dir: 1 | -1 = 1) {
    this.editor?.rotate(dir);
  }

  editorUndo() {
    this.editor?.undo();
  }

  editorRedo() {
    this.editor?.redo();
  }

  editorReplace(track: TrackData) {
    this.editor?.replace(track);
  }

  editorRename(name: string) {
    this.editor?.rename(name);
    this.track = { ...this.track, name };
    this.store.set({ trackName: name });
  }

  editorPreview(preview: boolean) {
    if (!this.editor) return;
    this.editor.setPreview(preview);
    this.loadTrack(this.editor.track, { forest: preview });
  }

  getEditorTrack(): TrackData {
    return cloneTrack(this.editor?.track ?? this.track);
  }

  private raceUi() {
    const s = this.race.snapshot();
    return {
      lap: s.lap,
      totalLaps: s.totalLaps,
      laps: s.laps,
      bestLap: s.bestLap,
      recordLap: s.recordLap,
    };
  }

  private toast(text: string, tone: Toast["tone"], seconds = 2) {
    this.store.set({ toast: { id: ++this.toastId, text, tone } });
    this.toastTimer = seconds;
  }

  private handleRaceEvents(events: RaceEvent[]) {
    for (const e of events) {
      switch (e.type) {
        case "countdown":
          this.store.set({ countdown: e.lights });
          this.updateLights(e.lights, false);
          this.audio.beep("count");
          break;
        case "go":
          this.store.set({ countdown: "go" });
          this.updateLights(5, true);
          this.goTimer = 1;
          this.audio.beep("go");
          break;
        case "lap": {
          const delta =
            e.delta === null ? "" : ` (${e.delta < 0 ? "−" : "+"}${Math.abs(e.delta).toFixed(3)})`;
          if (e.best && e.delta !== null) {
            this.toast(`Best lap! ${e.time.toFixed(3)}s${delta}`, "success", 2.5);
            this.audio.beep("best");
          } else {
            this.toast(`Lap ${e.lap}: ${e.time.toFixed(3)}s${delta}`, "info", 2.5);
            this.audio.beep("lap");
          }
          this.store.set({ race: this.raceUi() });
          break;
        }
        case "missedCheckpoint":
          this.toast("Missed a checkpoint, lap not counted", "warning", 2.5);
          this.audio.beep("error");
          break;
        case "finish":
          if (e.newRecord) write(BEST_KEY + trackId(this.track), String(e.bestLap));
          this.audio.beep("finish");
          this.input.enabled = false;
          this.input.clear();
          this.store.set({
            screen: "finished",
            race: this.raceUi(),
            finish: {
              total: e.total,
              bestLap: e.bestLap,
              newRecord: e.newRecord,
              laps: [...this.race.laps],
            },
          });
          break;
      }
    }
  }

  private updateLights(count: number, green: boolean) {
    const lights = this.built?.lights ?? [];
    lights.forEach((l, i) => {
      const m = l.material as THREE.MeshStandardMaterial;
      if (green) m.emissive.set("#2bdc5a");
      else m.emissive.set(i < count ? "#ff2a1a" : "#000000");
      m.emissiveIntensity = green || i < count ? 2.2 : 0;
    });
  }

  // ─── Loop ────────────────────────────────────────────────────────────────

  private readonly loop = (now: number) => {
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min((now - this.lastTime) / 1000, 0.1);
    this.lastTime = now;
    this.elapsed += dt;
    const screen = this.store.get().screen;

    if (screen === "playing") {
      this.accumulator += dt;
      let steps = 0;
      while (this.accumulator >= STEP && steps < MAX_STEPS) {
        this.fixedStep(STEP);
        this.accumulator -= STEP;
        steps++;
      }
      if (steps === MAX_STEPS) this.accumulator = 0;
    } else if (screen === "finished") {
      // Let the kart roll to a stop behind the line.
      this.accumulator += dt;
      while (this.accumulator >= STEP) {
        this.fixedStep(STEP);
        this.accumulator -= STEP;
      }
    }

    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.store.set({ toast: null });
    }
    if (this.goTimer > 0) {
      this.goTimer -= dt;
      if (this.goTimer <= 0) {
        this.store.set({ countdown: null });
        this.updateLights(0, false);
      }
    }

    this.render(dt, screen);
  };

  private fixedStep(dt: number) {
    const physics = this.physics;
    if (!physics) return;
    const input = this.input.read();
    const racing = this.race.phase !== "countdown";
    this.handleRaceEvents(this.race.tick(dt));
    this.lastThrottle = input.throttle;

    // Surface under the kart.
    const q = queryTrack(this.layout, this.path, this.currPos.x, this.currPos.z);
    this.lastQuery = q;
    if (q.piece && q.lateral < ROAD_HALF + 1) this.onTrackQuery = q;
    const offTrack = q.lateral > ROAD_HALF + 0.6;

    if (racing) {
      stepKart(this.kart, input, offTrack ? GRASS : ASPHALT, dt);
    } else {
      // Countdown: engine revs, kart held on the grid.
      this.kart.vx = this.kart.vz = 0;
    }

    const vy = physics.kart.motionProperties.linearVelocity[1];
    physics.setKartVelocity(this.kart.vx, vy, this.kart.vz);
    const conesBefore = physics.coneHit;
    physics.step(dt);

    const p = physics.kart.position;
    const v = physics.kart.motionProperties.linearVelocity;
    // Any difference between the velocity we asked for and what came back is a collision.
    const impact = Math.hypot(v[0] - this.kart.vx, v[2] - this.kart.vz);
    if (impact > 0.05) {
      afterCollision(this.kart, v[0], v[2]);
      if (impact > 2.5) {
        this.rig.addShake(Math.min(1, impact / 20));
        this.audio.impact(impact);
      }
    }
    if (physics.coneHit !== conesBefore) this.audio.impact(4);

    this.prevPos.copy(this.currPos);
    this.currPos.set(p[0], p[1], p[2]);
    this.prevYaw = this.currYaw;
    this.currYaw = this.kart.yaw;

    // Race progress: piece in race order and start/finish line crossing.
    if (q.piece && q.piece.order >= 0) this.race.onPiece(q.piece.order);
    const l = this.line;
    const d0 = (this.prevPos.x - l.x) * l.fx + (this.prevPos.z - l.z) * l.fz;
    const d1 = (this.currPos.x - l.x) * l.fx + (this.currPos.z - l.z) * l.fz;
    if ((d0 < 0 && d1 >= 0) || (d0 >= 0 && d1 < 0)) {
      const lateral = Math.abs((this.currPos.x - l.x) * l.fz - (this.currPos.z - l.z) * l.fx);
      if (lateral < WALL_OFFSET + 1 && Math.abs(d1 - d0) < 2) {
        const forward = d1 >= 0;
        const overshoot = forward ? (d1 / (d1 - d0)) * dt : 0;
        this.handleRaceEvents(this.race.onLineCrossed(forward, overshoot));
      }
    }

    // Fell out of the world (should not happen, but never leave the player stranded).
    if (p[1] < -5) this.resetKart();

    const speed = Math.hypot(this.kart.vx, this.kart.vz);
    if (this.store.get().screen === "playing" && racing) {
      // Stuck: pushing but going nowhere for a while.
      if ((input.throttle > 0 || input.brake > 0) && speed < 0.8) this.stuckTime += dt;
      else this.stuckTime = Math.max(0, this.stuckTime - dt * 2);
      // Wrong way: travelling against the race direction on the circuit.
      const along =
        q.piece && q.piece.order >= 0 ? this.kart.vx * q.tangent.x + this.kart.vz * q.tangent.z : 0;
      if (along < -3) this.wrongWayTime += dt;
      else this.wrongWayTime = Math.max(0, this.wrongWayTime - dt * 3);
      this.store.set({ stuckHint: this.stuckTime > 2.5, wrongWay: this.wrongWayTime > 1.2 });
    }
  }

  private render(dt: number, screen: Screen) {
    const live = screen === "playing" || screen === "finished";
    const alpha = live ? this.accumulator / STEP : 1;
    const x = this.prevPos.x + (this.currPos.x - this.prevPos.x) * alpha;
    const y = this.prevPos.y + (this.currPos.y - this.prevPos.y) * alpha;
    const z = this.prevPos.z + (this.currPos.z - this.prevPos.z) * alpha;
    let dy = this.currYaw - this.prevYaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    const yaw = this.prevYaw + dy * alpha;
    const frameDt = live ? dt : 0;

    if (this.kartView) {
      this.kartView.update(this.kart, x, y - KART_RADIUS, z, yaw, frameDt);
      this.kartView.root.updateMatrixWorld();
    }

    for (const { mesh, body } of this.coneMeshes) {
      mesh.position.set(body.position[0], body.position[1], body.position[2]);
      mesh.quaternion.set(
        body.quaternion[0],
        body.quaternion[1],
        body.quaternion[2],
        body.quaternion[3],
      );
    }

    const offTrack = (this.lastQuery?.lateral ?? 0) > ROAD_HALF + 0.6;
    const speed = Math.hypot(this.kart.vx, this.kart.vz);
    this.updateEffects(frameDt, speed, offTrack);
    this.audio.update(
      screen === "playing",
      Math.abs(this.kart.forwardSpeed) / KART.maxSpeed,
      this.race.phase === "countdown" ? this.lastThrottle : Math.max(this.lastThrottle, 0),
      this.kart.slip + (this.kart.drifting ? 0.4 : 0),
      offTrack ? 1 : 0,
    );

    if (screen === "editor" && this.editor) {
      this.editor.update(this.rig, dt);
      const t = this.editor.cameraTarget;
      this.lighting.follow(t.x, t.z);
    } else if (screen === "menu" || screen === "loading" || screen === "error") {
      const b = trackBounds(this.track);
      const cx = (b.minX + b.maxX) / 2;
      const cz = (b.minZ + b.maxZ) / 2;
      const r = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) * 0.75 + 20;
      this.rig.orbit(cx, cz, r, this.elapsed);
      this.lighting.follow(cx, cz);
    } else {
      this.rig.chase(x, z, yaw, this.kart.vx, this.kart.vz, frameDt);
      this.lighting.follow(x, z);
    }

    const f = this.frame;
    f.speed = speed;
    f.offTrack = offTrack;
    f.drifting = this.kart.drifting;
    f.lapTime = this.race.lapTime;
    f.timing = this.race.phase === "racing";
    f.x = x;
    f.z = z;
    f.yaw = yaw;
    for (const l of this.frameListeners) l(f);

    this.renderer.render(this.scene, this.rig.camera);
  }

  private updateEffects(dt: number, speed: number, offTrack: boolean) {
    this.particles.update(dt);
    if (dt === 0 || !this.kartView) return;
    this.kartView.rearContacts(_wheels);
    const k = this.kart;
    // Marks when sliding, drifting or braking hard; none on grass.
    const braking = k.accel < -20 && speed > 6 ? 0.6 : 0;
    const intensity = offTrack ? 0 : Math.max(k.slip, k.drifting ? 0.7 : 0, braking);
    this.skids.add(0, _wheels[0], intensity);
    this.skids.add(1, _wheels[1], intensity);

    this.emitTimer -= dt;
    if (this.emitTimer <= 0) {
      this.emitTimer = 0.035;
      if (!offTrack && (k.slip > 0.35 || (k.drifting && speed > 8))) {
        for (const w of _wheels) this.particles.emit(w, k.vx, k.vz, "smoke");
      } else if (offTrack && speed > 4) {
        this.particles.emit(_wheels[Math.random() < 0.5 ? 0 : 1], k.vx, k.vz, "dust");
      }
    }
  }

  private resize() {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.rig.resize(w / h);
    this.particles.setViewportHeight(h * Math.min(window.devicePixelRatio, 2));
  }

  /** Debug/test hook: a snapshot of the kart (exposed on window in development). */
  debugState() {
    return {
      x: this.currPos.x,
      z: this.currPos.z,
      yaw: this.kart.yaw,
      speed: Math.hypot(this.kart.vx, this.kart.vz),
      drifting: this.kart.drifting,
      onRoad: this.lastQuery?.onRoad ?? false,
      lateral: this.lastQuery?.lateral ?? 0,
      screen: this.store.get().screen,
      race: this.race.snapshot(),
    };
  }
}
