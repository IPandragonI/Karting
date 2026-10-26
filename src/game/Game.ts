import * as THREE from "three";
import { LIVERIES, loadModels, type LiveryId, type Models } from "./assets";
import { AudioManager, DEFAULT_VOLUME, type AudioState } from "./AudioManager";
import {
  CAMERA_MODES,
  CameraRig,
  defaultFov,
  FOV_RANGE,
  type CameraMode,
  type FollowTarget,
} from "./Camera";
import { Particles, SkidMarks } from "./Effects";
import {
  cloneBindings,
  DEFAULT_BINDINGS,
  InputManager,
  parseBindings,
  type Bindings,
} from "./InputManager";
import {
  decodeGhost,
  encodeGhost,
  GhostRecorder,
  sampleGhost,
  type GhostLap,
  type GhostPose,
} from "./Ghost";
import { GhostView } from "./GhostView";
import { KartView } from "./KartView";
import { GRAVITY, KART_RADIUS, Physics } from "./Physics";
import { RaceManager, type RaceEvent, type RacePhase, type SectorResult } from "./RaceManager";
import {
  createForest,
  createGround,
  createSky,
  createTerrain,
  Lighting,
  PALETTE,
  type Forest,
} from "./Scenery";
import { Store } from "./store";
import { createDefaultTrack } from "./track/defaultTrack";
import { CELL, ROAD_HALF, TIRE_RADIUS, WALL_OFFSET } from "./track/pieces";
import {
  analyzeTrack,
  buildRacePath,
  cloneTrack,
  groundHeight,
  isRaceable,
  queryTrack,
  startGrid,
  toWorld,
  trackBounds,
  trackId,
  type Issue,
  type RacePath,
  type TrackData,
  type TrackLayout,
  type TrackQuery,
} from "./track/Track";
import { buildTrack, type BuiltTrack } from "./track/TrackBuilder";
import { fromJson, toJson, trackFromHash } from "./track/TrackSerializer";
import { TrackEditor, type EditorTool, type EditorUi } from "./TrackEditor";
import { createTrackside, type Trackside } from "./Trackside";
import {
  afterCollision,
  ASPHALT,
  createKartState,
  GRASS,
  KART,
  stepKart,
  type KartState,
} from "./Vehicle";

// The game opens straight onto the track: the kart sits on the grid and the player drives an
// endless time trial (out lap, then every lap timed). The editor, pause menu and settings are
// overlays reachable from the HUD; nothing requires a trip through a menu.

export type Screen = "loading" | "playing" | "paused" | "editor" | "error";

export type Toast = { id: number; text: string; tone: "info" | "success" | "warning" };

export type RaceUi = {
  phase: RacePhase;
  lap: number;
  laps: number[];
  lastLap: number | null;
  bestLap: number | null;
  recordLap: number | null;
  /** Sector being driven (0..2), -1 when no valid lap is being timed. */
  sector: number;
  /** Splits on display: the current lap's, or the last lap's for a moment after the line. */
  splits: SectorResult[];
  splitsFromLastLap: boolean;
  /** All-time best sector times on this circuit. */
  bestSectors: (number | null)[];
};

export type UiState = {
  screen: Screen;
  loadProgress: number;
  error: string | null;
  trackName: string;
  /** Whether the loaded track is a valid closed circuit (lap timing needs one). */
  raceable: boolean;
  livery: LiveryId;
  camera: CameraMode;
  muted: boolean;
  audio: AudioState;
  race: RaceUi;
  /** Player setting: show the best-lap ghost. */
  ghost: boolean;
  /** Comfort settings (persisted). */
  fov: { chase: number; first: number };
  volume: number;
  bindings: Bindings;
  /** Lap time of the stored ghost for this circuit (null: none yet). */
  ghostTime: number | null;
  toast: Toast | null;
  stuckHint: boolean;
  wrongWay: boolean;
  editor: EditorUi;
  /** Validation result of the current track. */
  issues: Issue[];
  /** Graphics setting chosen by the player; `auto` may fall back to performance once. */
  quality: QualitySetting;
  /** Profile actually in use. */
  qualityActive: "high" | "performance";
};

export type QualitySetting = "auto" | "high" | "performance";

/** Diagnostics for the performance overlay (sampled, never pushed through React per frame). */
export type PerfStats = {
  fps: number;
  frameMs: number;
  worstFrameMs: number;
  physicsMs: number;
  renderMs: number;
  calls: number;
  triangles: number;
  pixelRatio: number;
  shadowMap: number;
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

// Fixed 60 Hz physics with interpolated rendering. The kart model is step-size independent (same
// braking, steering and drift figures as at 120 Hz), and halving the steps halves crashcat's
// per-step cost and the garbage it allocates.
const STEP = 1 / 60;
const MAX_STEPS = 5;
const WALLS_PER_BODY = 16;
/** Share of gravity acting along slopes (slower climbs, faster descents). */
const SLOPE_PULL = 0.35;
const BEST_KEY = "karting:best:";
const LIVERY_KEY = "karting:livery";
const CAMERA_KEY = "karting:camera";
const QUALITY_KEY = "karting:quality";
/** Auto quality falls back when frames average more than this (ms) for AUTO_SLOW_SECONDS. */
const AUTO_SLOW_FRAME_MS = 24;
const AUTO_SLOW_SECONDS = 3;
const TRACK_KEY = "karting:track";
/** Per circuit (keyed by the layout fingerprint, so any edit starts fresh records). */
const SECTORS_KEY = "karting:sectors:";
const GHOST_KEY = "karting:ghost:";
const SHOW_GHOST_KEY = "karting:showGhost";
const FOV_KEY = "karting:fov";
const BINDINGS_KEY = "karting:bindings";
/** Ghosts kept in storage (most recent circuits); older ones are dropped. */
const MAX_GHOSTS = 8;
/** How long the finished lap's splits stay on screen after the line (s). */
const SPLIT_HOLD = 4;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function readNumber(key: string): number | null {
  const v = read(key);
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function readSectors(key: string): (number | null)[] {
  try {
    const v = JSON.parse(read(key) ?? "null") as unknown;
    if (Array.isArray(v) && v.length === 3)
      return v.map((x) => (typeof x === "number" && x > 0 && Number.isFinite(x) ? x : null));
  } catch {
    // Corrupt entry: start over.
  }
  return [null, null, null];
}

/** Stores a ghost, keeping only the MAX_GHOSTS most recent circuits. */
function writeGhost(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
    const ghosts: { key: string; savedAt: number }[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(GHOST_KEY))
        ghosts.push({ key: k, savedAt: decodeGhost(localStorage.getItem(k))?.savedAt ?? 0 });
    }
    ghosts.sort((a, b) => b.savedAt - a.savedAt);
    for (const g of ghosts.slice(MAX_GHOSTS)) localStorage.removeItem(g.key);
  } catch {
    // Storage blocked or full: the ghost only lasts for this session.
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage blocked (private mode): settings and records only last for this session.
  }
}

const _wheels: [THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(), new THREE.Vector3()];

/** Static scenery never moves: compute its matrices once instead of on every frame. */
function freeze<T extends THREE.Object3D>(root: T): T {
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    o.matrixAutoUpdate = false;
    o.matrixWorldAutoUpdate = false;
  });
  return root;
}

export class Game {
  readonly store = new Store<UiState>({
    screen: "loading",
    loadProgress: 0,
    error: null,
    trackName: "",
    raceable: true,
    livery: "kerb",
    camera: "elevated",
    muted: false,
    audio: "locked",
    race: {
      phase: "off",
      lap: 0,
      laps: [],
      lastLap: null,
      bestLap: null,
      recordLap: null,
      sector: -1,
      splits: [],
      splitsFromLastLap: false,
      bestSectors: [null, null, null],
    },
    ghost: true,
    ghostTime: null,
    fov: { chase: defaultFov("chase"), first: defaultFov("first") },
    volume: DEFAULT_VOLUME,
    bindings: cloneBindings(DEFAULT_BINDINGS),
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
      level: 0,
      flip: false,
      dirty: false,
    },
    issues: [],
    quality: "auto",
    qualityActive: "high",
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
  private ground: THREE.Mesh | null = null;
  private groundKey = "";
  private forest: Forest | null = null;
  private trackside: Trackside | null = null;
  private props: THREE.Object3D[] = [];
  private propGeometry: THREE.BufferGeometry[] = [];
  private coneMeshes: { mesh: THREE.Object3D; body: Physics["cones"][number] }[] = [];

  private physics: Physics | null = null;
  private kart: KartState = createKartState();
  private kartView: KartView | null = null;
  private lastQuery: TrackQuery | null = null;
  private onTrackQuery: TrackQuery | null = null;
  private race = new RaceManager(1, null);
  private readonly line = { x: 0, z: 0, fx: 0, fz: 1 };
  /** Route distance of the start/finish line, and the kart's lap progress from it. */
  private lineDistance = 0;
  private progress: number | null = null;
  private splitHold = 0;
  private readonly ghostRecorder = new GhostRecorder();
  private ghostLap: GhostLap | null = null;
  private ghostView: GhostView | null = null;
  private readonly ghostPose: GhostPose = { x: 0, y: 0, z: 0, yaw: 0 };

  // Interpolation between fixed physics steps.
  private readonly prevPos = new THREE.Vector3();
  private readonly currPos = new THREE.Vector3();
  private prevYaw = 0;
  private readonly prevVel = new THREE.Vector2();
  private readonly currVel = new THREE.Vector2();
  private readonly follow: FollowTarget = {
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    vx: 0,
    vz: 0,
    pitch: 0,
    roll: 0,
    slope: 0,
  };
  private currYaw = 0;
  /** Road slope along the heading (or the flight path when airborne), rad, nose up. */
  private slope = 0;

  private raf = 0;
  private lastTime = 0;
  private accumulator = 0;
  private elapsed = 0;
  private stuckTime = 0;
  private wrongWayTime = 0;
  private toastId = 0;
  private toastTimer = 0;
  private emitTimer = 0;
  private lastThrottle = 0;
  private lastBrake = 0;
  private disposed = false;
  private pendingToast: { text: string; tone: Toast["tone"] } | null = null;
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
  private readonly lowPower: boolean;
  /** Shadow map refresh interval in frames (performance profile: every other frame). */
  private shadowEvery = 1;
  private frameIndex = 0;
  private emitInterval = 0.035;
  private slowTime = 0;
  private readonly perf: PerfStats = {
    fps: 0,
    frameMs: 0,
    worstFrameMs: 0,
    physicsMs: 0,
    renderMs: 0,
    calls: 0,
    triangles: 0,
    pixelRatio: 1,
    shadowMap: 0,
  };
  private perfWindow = { time: 0, frames: 0, worst: 0, physics: 0, render: 0 };

  constructor(private readonly canvas: HTMLCanvasElement) {
    // Phones and tablets: cap the pixel ratio and shadow resolution to keep a steady frame rate.
    this.lowPower = window.matchMedia("(pointer: coarse)").matches;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
    });
    // Pixel ratio and shadow resolution are set by applyQuality() once the light rig exists.
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Filmic tone mapping rolls off the bright sun gently and keeps colours rich instead of the
    // flat, clipped look of untone-mapped lighting.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene.fog = new THREE.Fog(PALETTE.fog, 160, 520);
    this.scene.add(createSky(), this.skids.mesh, this.particles.points);
    this.lighting = new Lighting(this.scene, this.lowPower);
    this.rig = new CameraRig(1);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();

    this.input.onAction = (a) => {
      if (a === "reset") this.resetKart();
      if (a === "pause") this.togglePause();
      if (a === "camera") this.cycleCamera();
      if (a === "ghost") this.setGhost(!this.store.get().ghost, true);
    };
    this.input.attach();
    document.addEventListener("visibilitychange", this.onVisibility);
    // Browsers only allow audio after a user gesture: unlock on the first one, anywhere.
    for (const type of ["pointerdown", "keydown", "touchstart"] as const) {
      window.addEventListener(type, this.onFirstGesture, { capture: true });
    }
    this.audio.onStateChange = (audio) => this.store.set({ audio });

    const livery = read(LIVERY_KEY);
    const camera = read(CAMERA_KEY);
    const quality = read(QUALITY_KEY);
    this.store.set({
      muted: this.audio.muted,
      livery: LIVERIES.some((l) => l.id === livery) ? (livery as LiveryId) : "kerb",
      camera: CAMERA_MODES.some((c) => c.id === camera) ? (camera as CameraMode) : "elevated",
      quality: quality === "high" || quality === "performance" ? quality : "auto",
      ghost: read(SHOW_GHOST_KEY) !== "0",
      volume: this.audio.volume,
    });
    // Comfort settings: field of view per camera and key bindings.
    try {
      const fov = JSON.parse(read(FOV_KEY) ?? "{}") as Partial<Record<"chase" | "first", unknown>>;
      for (const mode of ["chase", "first"] as const) {
        const v = fov[mode];
        if (typeof v === "number" && v >= FOV_RANGE.min && v <= FOV_RANGE.max)
          this.setFov(mode, v, false);
      }
    } catch {
      // Corrupt entry: defaults.
    }
    this.setBindings(parseBindings(read(BINDINGS_KEY)), false);
    this.applyQuality(this.store.get().quality === "performance" ? "performance" : "high");
  }

  // ─── Graphics quality ────────────────────────────────────────────────────

  setQuality(quality: QualitySetting) {
    this.store.set({ quality });
    write(QUALITY_KEY, quality);
    this.slowTime = 0;
    this.applyQuality(quality === "performance" ? "performance" : "high");
  }

  /**
   * High: full pixel ratio, 2048 shadows refreshed every frame. Performance: pixel ratio capped
   * at 1.25, 1024 shadows refreshed every other frame (the sun follows the camera slowly, so the
   * one-frame-old map is not noticeable), fewer smoke particles. Same scene, same gameplay.
   */
  private applyQuality(profile: "high" | "performance") {
    const high = profile === "high";
    const maxRatio = high ? (this.lowPower ? 1.75 : 2) : 1.25;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxRatio));
    const size = high && !this.lowPower ? 2048 : 1024;
    const shadow = this.lighting.sun.shadow;
    if (shadow.mapSize.x !== size) {
      shadow.mapSize.set(size, size);
      shadow.map?.dispose();
      shadow.map = null;
    }
    // Same penumbra width in world units whatever the map size (blur radius is in texels).
    shadow.radius = size >= 2048 ? 3 : 2;
    this.shadowEvery = high ? 1 : 2;
    this.renderer.shadowMap.autoUpdate = high;
    this.renderer.shadowMap.needsUpdate = true;
    this.emitInterval = high ? 0.035 : 0.06;
    this.store.set({ qualityActive: profile });
    this.resize();
  }

  /** Auto quality: fall back to the performance profile once if the game keeps running slow. */
  private watchFrameRate(dt: number) {
    const s = this.store.get();
    if (s.quality !== "auto" || s.qualityActive !== "high" || s.screen !== "playing") return;
    // Smoothed frame time; ignore single hiccups (GC, tab switches).
    this.slowTime = this.perf.frameMs > AUTO_SLOW_FRAME_MS ? this.slowTime + dt : 0;
    if (this.slowTime > AUTO_SLOW_SECONDS) {
      this.applyQuality("performance");
      this.toast("Switched to performance graphics (Menu › Graphics)", "info", 3);
    }
  }

  getPerfStats(): PerfStats {
    return this.perf;
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
    const saved = read(TRACK_KEY);
    if (saved) {
      const r = fromJson(saved);
      if (r.ok) return r.track;
    }
    return undefined;
  }

  async init(initialTrack?: TrackData) {
    try {
      this.models = await loadModels((loaded, total) =>
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
        onChange: (track) => this.loadTrack(track, { scenery: this.editor?.isPreview ?? false }),
        onUi: (ui) => this.store.set({ editor: { ...this.store.get().editor, ...ui } }),
        onNote: (text, tone) => this.toast(text, tone === "warning" ? "warning" : "info", 1.6),
      },
      this.track,
    );
    this.loadTrack(initialTrack ?? this.track);
    this.drive();
    if (this.pendingToast) this.toast(this.pendingToast.text, this.pendingToast.tone, 4);
    this.lastTime = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.input.detach();
    document.removeEventListener("visibilitychange", this.onVisibility);
    for (const type of ["pointerdown", "keydown", "touchstart"] as const) {
      window.removeEventListener(type, this.onFirstGesture, { capture: true });
    }
    this.audio.dispose();
    this.resizeObserver.disconnect();
    this.clearTrack();
    this.dropGround();
    this.editor?.dispose();
    this.kartView?.dispose();
    this.ghostView?.dispose();
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

  private readonly onFirstGesture = () => {
    this.audio.unlock();
    this.store.set({ audio: this.audio.state });
  };

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

  /** Builds everything for a track. `scenery: false` skips forest and trackside (editor). */
  loadTrack(track: TrackData, opts: { scenery?: boolean } = {}) {
    if (!this.models) {
      this.track = cloneTrack(track);
      return;
    }
    this.clearTrack();
    this.track = cloneTrack(track);
    this.layout = analyzeTrack(this.track);
    this.path = buildRacePath(this.track, this.layout);
    this.built = buildTrack(this.track, this.layout, this.models);
    this.scene.add(freeze(this.built.group));
    const terrain = createTerrain(this.track);
    // The ground (a 26k-vertex noise mesh, ~45 ms) only depends on the circuit's bounds, which
    // most editor clicks leave unchanged: keep it until they change.
    const b = trackBounds(this.track);
    const groundKey = `${b.minX},${b.maxX},${b.minZ},${b.maxZ}`;
    if (!this.ground || groundKey !== this.groundKey) {
      this.dropGround();
      this.ground = createGround(terrain);
      this.groundKey = groundKey;
      this.scene.add(freeze(this.ground));
    }
    if (opts.scenery ?? true) {
      this.trackside = createTrackside(this.track, this.layout, this.path, this.models, terrain);
      this.scene.add(freeze(this.trackside.group));
      this.forest = createForest(this.track, this.models, terrain, this.trackside.reserved);
      this.scene.add(freeze(this.forest.group));
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
    const id = trackId(this.track);
    this.race = new RaceManager(
      this.layout.order.length || 1,
      readNumber(BEST_KEY + id),
      this.path.totalLength,
      readSectors(SECTORS_KEY + id),
    );
    this.lineDistance = queryTrack(this.layout, this.path, this.line.x, this.line.z).distance;
    this.ghostLap = raceable ? decodeGhost(read(GHOST_KEY + id)) : null;
    this.splitHold = 0;
    this.store.set({
      trackName: this.track.name,
      raceable,
      race: this.raceUi(),
      ghostTime: this.ghostLap?.time ?? null,
      issues: this.layout.issues,
    });
    this.buildPhysics();
    // The gantry shows green: the session is always "live".
    this.updateLights(5, true);
  }

  private clearTrack() {
    const drop = (o: { group: THREE.Group; dispose: () => void } | null) => {
      if (!o) return;
      this.scene.remove(o.group);
      o.dispose();
    };
    drop(this.built);
    drop(this.forest);
    drop(this.trackside);
    this.built = null;
    this.forest = null;
    this.trackside = null;
    for (const p of this.props) this.scene.remove(p);
    for (const g of this.propGeometry) g.dispose();
    this.props = [];
    this.propGeometry = [];
    this.coneMeshes = [];
  }

  private dropGround() {
    if (!this.ground) return;
    this.scene.remove(this.ground);
    this.ground.geometry.dispose();
    (this.ground.material as THREE.Material).dispose();
    this.ground = null;
  }

  private buildPhysics() {
    const grid = startGrid(this.track, this.layout);
    const physics = new Physics(grid);
    const walls = (this.built?.walls ?? []).map((seg) => ({
      seg,
      halfThickness: TIRE_RADIUS,
      height: seg.height ?? 1.4,
    }));
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
      walls.push({ seg, halfThickness: 1, height: 3 });
    }
    // Walls in compound bodies of 16 boxes. Measured with the kart scraping a wall: a body per box
    // cost 1.6 ms and 78 KB of garbage per step, one compound for everything 0.7 ms / 18 KB,
    // groups of 16 0.37 ms / 3.7 KB (the broadphase skips far groups, the narrowphase stays small).
    for (let i = 0; i < walls.length; i += WALLS_PER_BODY)
      physics.addWalls(walls.slice(i, i + WALLS_PER_BODY));

    let tireGeo: THREE.BufferGeometry | null = null;
    const tireMat = new THREE.MeshStandardMaterial({ color: "#2a2c31", roughness: 0.85 });
    for (const prop of this.track.props) {
      if (prop.type === "tires") {
        physics.addTireStack(prop.x, prop.z);
        if (!tireGeo) {
          tireGeo = new THREE.TorusGeometry(0.3, 0.13, 8, 16).rotateX(Math.PI / 2);
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

  // ─── Kart & settings ─────────────────────────────────────────────────────

  private ensureKartView() {
    if (this.kartView || !this.models) return;
    const livery = LIVERIES.find((l) => l.id === this.store.get().livery) ?? LIVERIES[0];
    this.kartView = new KartView(this.models["kart-oobi"], livery.color);
    this.kartView.setDriverVisible(this.store.get().camera !== "first");
    this.scene.add(this.kartView.root);
    this.kartView.update(
      this.kart,
      this.currPos.x,
      this.currPos.y - KART_RADIUS,
      this.currPos.z,
      this.currYaw,
      0,
    );
    if (!this.ghostView) {
      this.ghostView = new GhostView(this.models["kart-oobi"]);
      this.scene.add(this.ghostView.root);
    }
  }

  // ─── Comfort settings ────────────────────────────────────────────────────

  /** Field of view of the chase or first-person camera, applied immediately (persisted). */
  setFov(mode: "chase" | "first", fov: number, persist = true) {
    const v = Math.round(Math.min(FOV_RANGE.max, Math.max(FOV_RANGE.min, fov)));
    this.rig.setFov(mode, v === defaultFov(mode) ? null : v);
    const next = { ...this.store.get().fov, [mode]: v };
    this.store.set({ fov: next });
    if (persist) write(FOV_KEY, JSON.stringify(next));
  }

  setVolume(volume: number) {
    this.audio.setVolume(volume);
    this.store.set({ volume: this.audio.volume });
  }

  setBindings(bindings: Bindings, persist = true) {
    this.input.setBindings(bindings);
    this.store.set({ bindings: this.input.getBindings() });
    if (persist) write(BINDINGS_KEY, JSON.stringify(bindings));
  }

  /** Remapping: the next key press is returned instead of reaching the game (null: cancelled). */
  captureKey(callback: (code: string | null) => void) {
    this.input.captureKey(callback);
  }

  cancelCapture() {
    this.input.cancelCapture();
  }

  /** Comfort settings back to their defaults (camera fields of view, volume, keys, ghost). */
  resetSettings() {
    this.setFov("chase", defaultFov("chase"));
    this.setFov("first", defaultFov("first"));
    this.setVolume(DEFAULT_VOLUME);
    this.setBindings(cloneBindings(DEFAULT_BINDINGS));
    this.setGhost(true);
  }

  /** Best-lap ghost on or off (persisted). Hidden immediately; nothing is sampled while off. */
  setGhost(on: boolean, announce = false) {
    this.store.set({ ghost: on });
    write(SHOW_GHOST_KEY, on ? "1" : "0");
    if (!on) this.ghostView?.set(null);
    if (announce) this.toast(`Best lap ghost: ${on ? "on" : "off"}`, "info", 1.2);
  }

  setLivery(livery: LiveryId) {
    this.store.set({ livery });
    write(LIVERY_KEY, livery);
    if (this.kartView) {
      this.scene.remove(this.kartView.root);
      this.kartView.dispose();
      this.kartView = null;
    }
    this.ensureKartView();
  }

  setCamera(camera: CameraMode) {
    this.store.set({ camera });
    write(CAMERA_KEY, camera);
    this.kartView?.setDriverVisible(camera !== "first");
    this.rig.cut();
  }

  cycleCamera() {
    const i = CAMERA_MODES.findIndex((c) => c.id === this.store.get().camera);
    const next = CAMERA_MODES[(i + 1) % CAMERA_MODES.length]!;
    this.setCamera(next.id);
    this.toast(`Camera: ${next.label}`, "info", 1.2);
  }

  setMuted(muted: boolean) {
    this.audio.unlock();
    this.audio.setMuted(muted);
    this.store.set({ muted, audio: this.audio.state });
  }

  /** Explicit "enable sound" from the HUD. */
  enableSound() {
    this.audio.unlock();
    if (this.audio.muted) this.audio.setMuted(false);
    this.store.set({ muted: false, audio: this.audio.state });
  }

  private placeKart(x: number, z: number, yaw: number) {
    this.ensureKartView();
    const ground = groundHeight(this.layout, this.path, x, z);
    this.physics?.teleportKart(x, z, ground);
    this.kart = createKartState(yaw);
    this.slope = 0;
    this.prevPos.set(x, ground + KART_RADIUS, z);
    this.currPos.copy(this.prevPos);
    this.prevYaw = this.currYaw = yaw;
    this.prevVel.set(0, 0);
    this.currVel.set(0, 0);
    this.lastQuery = this.onTrackQuery = queryTrack(this.layout, this.path, x, z);
    this.progress = null;
    this.stuckTime = 0;
    this.wrongWayTime = 0;
    this.store.set({ stuckHint: false, wrongWay: false });
    this.rig.cut();
  }

  /** R: back onto the centerline of the last piece we were on, facing the race direction. */
  resetKart() {
    if (this.store.get().screen !== "playing") return;
    const q = this.onTrackQuery;
    if (!q || !q.piece) {
      const g = startGrid(this.track, this.layout);
      this.placeKart(g.x, g.z, g.yaw);
      return;
    }
    this.placeKart(q.closest.x, q.closest.z, Math.atan2(q.tangent.x, q.tangent.z));
  }

  // ─── Flow ────────────────────────────────────────────────────────────────

  /** Put the kart on the grid and start (or restart) the session: out lap, then timed laps. */
  private drive() {
    this.buildPhysics();
    this.skids.clear();
    this.particles.clear();
    if (this.store.get().raceable) this.race.start();
    else this.race.stop();
    this.ghostRecorder.cancel();
    this.ghostView?.set(null);
    this.splitHold = 0;
    this.store.set({ screen: "playing", toast: null, race: this.raceUi() });
    this.input.enabled = true;
    this.accumulator = 0;
    this.lastTime = performance.now();
  }

  /** Back to the start line with a fresh out lap (session bests are kept). */
  restartLap() {
    this.drive();
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
    this.input.enabled = true;
    this.lastTime = performance.now();
    this.store.set({ screen: "playing" });
  }

  // ─── Editor ──────────────────────────────────────────────────────────────

  openEditor() {
    if (!this.editor) return;
    this.input.enabled = false;
    this.input.clear();
    this.store.set({ screen: "editor", toast: null, stuckHint: false, wrongWay: false });
    this.loadTrack(this.track, { scenery: false });
    this.editor.enable(cloneTrack(this.track));
  }

  /** Leave the editor and drive the edited circuit. */
  closeEditor() {
    if (!this.editor) return;
    const track = this.editor.track;
    this.editor.disable();
    this.loadTrack(track);
    write(TRACK_KEY, toJson(track));
    this.drive();
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

  editorLevel(level: number) {
    this.editor?.setLevel(level);
  }

  editorFlip() {
    this.editor?.toggleFlip();
  }

  editorMirror() {
    this.editor?.mirror();
  }

  editorRevert() {
    this.editor?.revert();
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
    this.loadTrack(this.editor.track, { scenery: preview });
  }

  getEditorTrack(): TrackData {
    return cloneTrack(this.editor?.track ?? this.track);
  }

  /** Import from the share dialog outside the editor: load it and start driving it. */
  importTrack(track: TrackData) {
    this.loadTrack(track);
    write(TRACK_KEY, toJson(track));
    this.drive();
  }

  private raceUi(): RaceUi {
    const s = this.race.snapshot();
    return {
      phase: s.phase,
      lap: s.lap,
      laps: s.laps,
      lastLap: s.laps.at(-1) ?? null,
      bestLap: s.bestLap,
      recordLap: s.recordLap,
      sector: s.sector,
      splits: this.splitHold > 0 ? s.lastSectors : s.sectors,
      splitsFromLastLap: this.splitHold > 0,
      bestSectors: s.bestSectors,
    };
  }

  /** A new lap began at the line during the last step: record it from the start. */
  private beginGhostLap() {
    const t = this.race.lapTime;
    const p = this.prevPos;
    const c = this.currPos;
    this.ghostRecorder.begin(t - STEP, p.x, p.y - KART_RADIUS, p.z, this.prevYaw);
    this.ghostRecorder.push(t, c.x, c.y - KART_RADIUS, c.z, this.currYaw);
  }

  /** Keeps the lap as the circuit's ghost when it beats the stored one. */
  private finishGhostLap(time: number) {
    const lap = this.ghostRecorder.finish(time);
    if (!lap || (this.ghostLap && this.ghostLap.time <= time)) return;
    this.ghostLap = lap;
    writeGhost(GHOST_KEY + trackId(this.track), encodeGhost(lap));
    this.store.set({ ghostTime: lap.time });
  }

  private toast(text: string, tone: Toast["tone"], seconds = 2) {
    this.store.set({ toast: { id: ++this.toastId, text, tone } });
    this.toastTimer = seconds;
  }

  private handleRaceEvents(events: RaceEvent[]) {
    for (const e of events) {
      switch (e.type) {
        case "lapStart":
          this.beginGhostLap();
          this.store.set({ race: this.raceUi() });
          break;
        case "sector": {
          const { status } = e.sector;
          if (status === "purple" || status === "neutral")
            write(SECTORS_KEY + trackId(this.track), JSON.stringify(this.race.bestSectors));
          // Sector 3 comes with the lap event, which refreshes the HUD.
          if (e.sector.index < 2) this.store.set({ race: this.raceUi() });
          break;
        }
        case "lap": {
          this.finishGhostLap(e.time);
          this.beginGhostLap();
          this.splitHold = SPLIT_HOLD;
          const delta =
            e.delta === null ? "" : ` (${e.delta < 0 ? "−" : "+"}${Math.abs(e.delta).toFixed(3)})`;
          if (e.record) write(BEST_KEY + trackId(this.track), String(e.time));
          if (e.best && e.delta !== null) {
            this.toast(
              `${e.record ? "New record" : "Best lap"}! ${e.time.toFixed(3)}s${delta}`,
              "success",
              2.5,
            );
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
          this.beginGhostLap();
          this.splitHold = 0;
          this.store.set({ race: this.raceUi() });
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

    const t0 = performance.now();
    if (screen === "playing") {
      this.accumulator += dt;
      let steps = 0;
      while (this.accumulator >= STEP && steps < MAX_STEPS) {
        this.fixedStep(STEP);
        this.accumulator -= STEP;
        steps++;
      }
      if (steps === MAX_STEPS) this.accumulator = 0;
    }
    const t1 = performance.now();

    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.store.set({ toast: null });
    }
    if (this.splitHold > 0 && screen === "playing") {
      this.splitHold -= dt;
      if (this.splitHold <= 0) this.store.set({ race: this.raceUi() });
    }

    // Performance profile: refresh the shadow map every `shadowEvery` frames.
    this.frameIndex++;
    if (this.shadowEvery > 1 && this.frameIndex % this.shadowEvery === 0) {
      this.renderer.shadowMap.needsUpdate = true;
    }
    this.render(dt, screen);
    this.samplePerf(dt, t1 - t0, performance.now() - t1);
    this.watchFrameRate(dt);
  };

  private fixedStep(dt: number) {
    const physics = this.physics;
    if (!physics) return;
    const input = this.input.read();
    this.race.tick(dt);
    this.lastThrottle = input.throttle;
    this.lastBrake = input.brake;

    // Surface under the kart.
    const q = queryTrack(this.layout, this.path, this.currPos.x, this.currPos.z);
    this.lastQuery = q;
    if (q.piece && q.lateral < ROAD_HALF + 1) this.onTrackQuery = q;
    const offTrack = q.lateral > ROAD_HALF + 0.6;

    stepKart(this.kart, input, offTrack ? GRASS : ASPHALT, dt);

    // Elevation: the kart rides the road's height profile. On the surface, its vertical speed
    // follows the ground under where it is heading (crashcat then subtracts one step of
    // gravity); when the ground falls away faster than gravity can pull the kart down (a crest
    // taken fast) it keeps its own vertical speed, flies, and lands further on.
    const foot = this.currPos.y - KART_RADIUS;
    const g0 = groundHeight(this.layout, this.path, this.currPos.x, this.currPos.z);
    const g1 = groundHeight(
      this.layout,
      this.path,
      this.currPos.x + this.kart.vx * dt,
      this.currPos.z + this.kart.vz * dt,
    );
    let vy = physics.kart.motionProperties.linearVelocity[1];
    const falling = foot - g0 > 0.05 ? vy : 0;
    // (A raised deck more than a step above is a wall: its collider stops the kart.)
    if (foot - g0 < 0.05 && g1 - foot < 1) {
      vy = Math.max((g1 - g0) / dt + GRAVITY * dt, vy);
      const speed = Math.hypot(this.kart.vx, this.kart.vz);
      if (speed > 0.5 && g1 !== g0) {
        const grade = THREE.MathUtils.clamp((g1 - g0) / (speed * dt), -0.5, 0.5);
        const k = 1 - (GRAVITY * SLOPE_PULL * grade * dt) / speed;
        this.kart.vx *= k;
        this.kart.vz *= k;
      }
    }
    physics.setKartVelocity(this.kart.vx, vy, this.kart.vz);
    const conesBefore = physics.coneHit;
    physics.step(dt);

    // Discrete steps can leave the kart a hair inside a rising surface: lift it out.
    const pos = physics.kart.position;
    const ground = groundHeight(this.layout, this.path, pos[0], pos[2]);
    if (pos[1] < ground + KART_RADIUS - 0.01 && ground - (pos[1] - KART_RADIUS) < 1)
      physics.setKartHeight(ground + KART_RADIUS);
    // Landing after a jump: a thump proportional to the vertical speed.
    if (falling < -4 && pos[1] - KART_RADIUS - ground < 0.03) {
      this.rig.addShake(Math.min(0.35, -falling / 30));
      this.audio.impact(-falling * 0.6);
    }

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
    this.prevVel.copy(this.currVel);
    this.currVel.set(this.kart.vx, this.kart.vz);

    // Race progress: piece in race order, sector boundaries (route distance from the line, from
    // where the kart was to where it is now) and start/finish line crossing.
    this.ghostRecorder.push(
      this.race.lapTime,
      this.currPos.x,
      this.currPos.y - KART_RADIUS,
      this.currPos.z,
      this.currYaw,
    );
    if (q.piece && q.piece.order >= 0) {
      this.race.onPiece(q.piece.order);
      const total = this.path.totalLength;
      const now = queryTrack(this.layout, this.path, this.currPos.x, this.currPos.z);
      if (now.piece && now.piece.order >= 0 && total > 0) {
        const progress = (((now.distance - this.lineDistance) % total) + total) % total;
        if (this.progress !== null)
          this.handleRaceEvents(this.race.onProgress(this.progress, progress, dt));
        this.progress = progress;
      }
    }
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

    // Slope for the chassis and the first-person view: the road along the heading, or the flight
    // path while airborne.
    const speedNow = Math.hypot(v[0], v[2]);
    if (p[1] - KART_RADIUS - ground > 0.15) {
      this.slope = THREE.MathUtils.clamp(Math.atan2(v[1], Math.max(speedNow, 4)), -0.35, 0.35);
    } else {
      const hx = Math.sin(this.kart.yaw) * 0.9;
      const hz = Math.cos(this.kart.yaw) * 0.9;
      const front = groundHeight(this.layout, this.path, p[0] + hx, p[2] + hz);
      const back = groundHeight(this.layout, this.path, p[0] - hx, p[2] - hz);
      this.slope = Math.abs(front - back) < 1 ? Math.atan2(front - back, 1.8) : 0;
    }

    // Fell out of the world (should not happen, but never leave the player stranded).
    if (p[1] < -5) this.resetKart();

    const speed = Math.hypot(this.kart.vx, this.kart.vz);
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

  private render(dt: number, screen: Screen) {
    const live = screen === "playing";
    const alpha = live ? this.accumulator / STEP : 1;
    const x = this.prevPos.x + (this.currPos.x - this.prevPos.x) * alpha;
    const y = this.prevPos.y + (this.currPos.y - this.prevPos.y) * alpha;
    const z = this.prevPos.z + (this.currPos.z - this.prevPos.z) * alpha;
    let dy = this.currYaw - this.prevYaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    const yaw = this.prevYaw + dy * alpha;
    const frameDt = live ? dt : 0;

    if (this.kartView) {
      this.kartView.update(this.kart, x, y - KART_RADIUS, z, yaw, frameDt, this.slope);
      this.kartView.root.updateMatrixWorld();
    }

    this.updateGhost(live, alpha);

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
    const braking = this.lastBrake > 0 && this.kart.forwardSpeed > 4 ? 1 : 0;
    this.audio.update(
      dt,
      live,
      Math.abs(this.kart.forwardSpeed) / KART.maxSpeed,
      this.lastThrottle,
      this.kart.slip + (this.kart.drifting ? 0.45 : 0),
      braking,
      offTrack,
    );

    if (screen === "editor" && this.editor) {
      this.editor.update(this.rig, dt);
      const t = this.editor.cameraTarget;
      this.lighting.follow(t.x, t.z);
    } else if (screen === "loading" || screen === "error") {
      const b = trackBounds(this.track);
      const cx = (b.minX + b.maxX) / 2;
      const cz = (b.minZ + b.maxZ) / 2;
      const r = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) * 0.75 + 20;
      this.rig.orbit(cx, cz, r, this.elapsed);
      this.lighting.follow(cx, cz);
    } else {
      const mode = this.store.get().camera;
      // Everything the camera follows is interpolated between the same two physics steps, so
      // position, heading and velocity stay consistent however frames and steps line up.
      const t = this.follow;
      t.x = x;
      t.y = y - KART_RADIUS;
      t.z = z;
      t.yaw = yaw;
      t.vx = this.prevVel.x + (this.currVel.x - this.prevVel.x) * alpha;
      t.vz = this.prevVel.y + (this.currVel.y - this.prevVel.y) * alpha;
      t.pitch = this.kartView?.pitch ?? 0;
      t.roll = this.kartView?.roll ?? 0;
      t.slope = this.kartView?.slope ?? 0;
      this.rig.follow(mode, t, frameDt);
      // Centre the shadow map ahead of the kart, where the camera is looking.
      const ahead = mode === "elevated" ? 10 : mode === "chase" ? 12 : 16;
      this.lighting.follow(x + Math.sin(yaw) * ahead, z + Math.cos(yaw) * ahead);
    }

    const f = this.frame;
    f.speed = speed;
    f.offTrack = offTrack;
    f.drifting = this.kart.drifting;
    f.lapTime = this.race.lapTime;
    f.timing = this.race.phase === "timing";
    f.x = x;
    f.z = z;
    f.yaw = yaw;
    for (const l of this.frameListeners) l(f);

    this.built?.updateLod(this.rig.camera.position);
    this.renderer.render(this.scene, this.rig.camera);
  }

  /** Ghost pose at the current lap time, interpolated between physics steps like the kart. */
  private updateGhost(live: boolean, alpha: number) {
    const view = this.ghostView;
    if (!view) return;
    const lap = this.ghostLap;
    if (!lap || !this.store.get().ghost || this.race.phase !== "timing") {
      view.set(null);
      return;
    }
    const t = this.race.lapTime - (live ? (1 - alpha) * STEP : 0);
    view.set(sampleGhost(lap, t, this.ghostPose) ? this.ghostPose : null);
  }

  /** Aggregates frame timings over half-second windows for the overlay and auto quality. */
  private samplePerf(dt: number, physicsMs: number, renderMs: number) {
    const w = this.perfWindow;
    w.time += dt;
    w.frames++;
    w.worst = Math.max(w.worst, dt * 1000);
    w.physics += physicsMs;
    w.render += renderMs;
    if (w.time < 0.5) return;
    const p = this.perf;
    p.fps = w.frames / w.time;
    p.frameMs = (w.time * 1000) / w.frames;
    p.worstFrameMs = w.worst;
    p.physicsMs = w.physics / w.frames;
    p.renderMs = w.render / w.frames;
    p.calls = this.renderer.info.render.calls;
    p.triangles = this.renderer.info.render.triangles;
    p.pixelRatio = this.renderer.getPixelRatio();
    p.shadowMap = this.lighting.sun.shadow.mapSize.x;
    w.time = w.frames = w.worst = w.physics = w.render = 0;
  }

  private updateEffects(dt: number, speed: number, offTrack: boolean) {
    this.particles.update(dt);
    if (dt === 0 || !this.kartView) return;
    this.kartView.rearContacts(_wheels);
    for (const w of _wheels) w.y = groundHeight(this.layout, this.path, w.x, w.z);
    const k = this.kart;
    // Marks when sliding, drifting or braking hard; none on grass.
    const braking = k.accel < -20 && speed > 6 ? 0.6 : 0;
    const intensity = offTrack ? 0 : Math.max(k.slip, k.drifting ? 0.7 : 0, braking);
    this.skids.add(0, _wheels[0], intensity);
    this.skids.add(1, _wheels[1], intensity);

    this.emitTimer -= dt;
    if (this.emitTimer <= 0) {
      this.emitTimer = this.emitInterval;
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
    this.particles.setViewportHeight(h * this.renderer.getPixelRatio());
  }

  /** Debug/test hook: a snapshot of the kart (exposed on window in development). */
  debugState() {
    return {
      x: this.currPos.x,
      y: this.currPos.y - KART_RADIUS,
      z: this.currPos.z,
      ground: groundHeight(this.layout, this.path, this.currPos.x, this.currPos.z),
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
