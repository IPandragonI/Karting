import * as THREE from "three";
import { toInstanceParts, type Models } from "./assets";
import { CELL } from "./track/pieces";
import { cellKey, footprintCells, trackBounds, type TrackData } from "./track/Track";

// World dressing: light rig, sky with sun, drifting clouds and a few birds, rolling ground, and a
// forest (broadleaf trees, pines, bushes, rocks, flower patches) that fills the empty cells around
// the circuit. Everything repeated is instanced, so hundreds of trees cost a few draw calls, and
// the only animation is in the vertex shader (wind sway, wing flaps) or a dozen matrices a frame.

export const PALETTE = {
  skyTop: new THREE.Color("#2f7fd6"),
  skyHorizon: new THREE.Color("#cfe9f7"),
  sunGlow: new THREE.Color("#fff4d6"),
  grass: new THREE.Color("#6fb64a"),
  grassDark: new THREE.Color("#5a9e3c"),
  grassHill: new THREE.Color("#7fbf55"),
  fog: new THREE.Color("#c4e2f2"),
};

/** Direction the sunlight comes from (unit vector, pointing towards the sun). */
export const SUN_DIR = new THREE.Vector3(-0.55, 0.62, -0.56).normalize();

export class Lighting {
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  private readonly offset = SUN_DIR.clone().multiplyScalar(60);

  constructor(scene: THREE.Scene, lowPower: boolean) {
    // Soft daylight: a generous sky fill (cool from above, grass-tinted bounce from below) does
    // most of the lighting, a warm sun models the shapes. Shadows are soft-edged (PCF radius)
    // and lifted (intensity < 1): the shaded side of a stand still shows its colour.
    this.hemi = new THREE.HemisphereLight("#d4ebff", "#6e8f4c", 1.35);
    scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight("#fff3df", 2.5);
    this.sun.castShadow = true;
    const size = lowPower ? 1024 : 2048;
    this.sun.shadow.mapSize.set(size, size);
    const s = this.sun.shadow.camera;
    s.left = -38;
    s.right = 38;
    s.top = 38;
    s.bottom = -38;
    s.near = 5;
    s.far = 130;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.05;
    this.sun.shadow.radius = 3;
    this.sun.shadow.intensity = 0.72;
    scene.add(this.sun, this.sun.target);
  }

  /** Keeps the shadow frustum centred on what the camera is looking at. */
  follow(x: number, z: number) {
    // Snap to shadow texels to avoid shimmering edges while moving.
    const texel = 76 / this.sun.shadow.mapSize.x;
    const sx = Math.round(x / texel) * texel;
    const sz = Math.round(z / texel) * texel;
    this.sun.target.position.set(sx, 0, sz);
    this.sun.position.set(sx + this.offset.x, this.offset.y, sz + this.offset.z);
  }
}

export function createSky(): THREE.Group {
  const group = new THREE.Group();
  const geo = new THREE.SphereGeometry(900, 32, 16);
  const colors: number[] = [];
  const pos = geo.getAttribute("position");
  const c = new THREE.Color();
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize();
    const t = Math.max(0, v.y);
    c.copy(PALETTE.skyHorizon).lerp(PALETTE.skyTop, Math.pow(t, 0.55));
    // Warm glow around the sun.
    const glow = Math.pow(Math.max(0, v.dot(SUN_DIR)), 6);
    c.lerp(PALETTE.sunGlow, glow * 0.8);
    colors.push(c.r, c.g, c.b);
  }
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.BackSide,
    fog: false,
    depthWrite: false,
  });
  const sky = new THREE.Mesh(geo, mat);
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  group.add(sky);
  // Sun disc: a bright billboard far out along the sun direction (no fog, never culled).
  const sun = new THREE.Mesh(
    new THREE.CircleGeometry(26, 24),
    new THREE.MeshBasicMaterial({ color: "#fff8e6", fog: false, depthWrite: false }),
  );
  sun.position.copy(SUN_DIR).multiplyScalar(860);
  sun.lookAt(0, 0, 0);
  sun.renderOrder = -9;
  sun.frustumCulled = false;
  group.add(sun);
  const clouds = createClouds();
  clouds.name = "clouds";
  group.add(clouds);
  return group;
}

/**
 * Ambient life: one clock for the wind (shared by every swaying material), slowly drifting
 * clouds, and a few birds circling high over the part of the circuit the camera looks at.
 */
export class Ambient {
  readonly time = { value: 0 };
  private readonly clouds: THREE.Object3D | null;
  private readonly birds: THREE.InstancedMesh;
  private readonly flocks: { r: number; y: number; speed: number }[] = [
    { r: 34, y: 42, speed: 0.16 },
    { r: 52, y: 55, speed: -0.11 },
  ];
  private readonly matrix = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly scale = new THREE.Vector3(1.4, 1.4, 1.4);
  private readonly up = new THREE.Vector3(0, 1, 0);
  private focusX = 0;
  private focusZ = 0;

  constructor(scene: THREE.Scene, sky: THREE.Group) {
    this.clouds = sky.getObjectByName("clouds") ?? null;
    // V-winged birds (two triangles); the wings flap in the vertex shader.
    const wing = new THREE.BufferGeometry();
    wing.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(
        [0, 0, 0.25, -0.7, 0.05, -0.15, 0, 0, -0.2, 0, 0, 0.25, 0, 0, -0.2, 0.7, 0.05, -0.15],
        3,
      ),
    );
    wing.computeVertexNormals();
    const mat = new THREE.MeshLambertMaterial({ color: "#2b2f36", side: THREE.DoubleSide });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.time;
      shader.vertexShader = `uniform float uTime;\n${shader.vertexShader}`.replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
          float phase = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.21;
          transformed.y += sin(uTime * 9.0 + phase) * abs(position.x) * 0.55;
        #endif`,
      );
    };
    mat.customProgramCacheKey = () => "bird-flap";
    this.birds = new THREE.InstancedMesh(wing, mat, this.flocks.length * 6);
    this.birds.frustumCulled = false;
    this.birds.castShadow = false;
    scene.add(this.birds);
  }

  /** Advances the wind clock and moves clouds and birds; `x`, `z`: where the camera looks. */
  update(dt: number, x: number, z: number) {
    this.time.value += dt;
    if (this.clouds) this.clouds.rotation.y += dt * 0.003;
    // The flocks drift after the camera's target, so they stay in view without following it.
    const k = 1 - Math.exp(-0.15 * dt);
    this.focusX += (x - this.focusX) * k;
    this.focusZ += (z - this.focusZ) * k;
    const t = this.time.value;
    let i = 0;
    this.flocks.forEach((flock, f) => {
      const dir = Math.sign(flock.speed);
      for (let b = 0; b < 6; b++, i++) {
        // A loose V: each bird a little behind and outside the leader, bobbing on its own.
        const rank = Math.ceil(b / 2);
        const a = t * flock.speed + f * 2.1 - rank * 0.05 * dir;
        const r = flock.r + (b % 2 ? 1 : -1) * rank * 1.8;
        this.pos.set(
          this.focusX + Math.cos(a) * r,
          flock.y + Math.sin(t * 0.7 + b) * 0.8 + rank * 0.4,
          this.focusZ + Math.sin(a) * r,
        );
        // Heading along the circle (its tangent), in the direction of travel.
        this.quat.setFromAxisAngle(this.up, Math.atan2(-Math.sin(a) * dir, Math.cos(a) * dir));
        this.birds.setMatrixAt(i, this.matrix.compose(this.pos, this.quat, this.scale));
      }
    });
    this.birds.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.birds.geometry.dispose();
    (this.birds.material as THREE.Material).dispose();
    this.birds.dispose();
  }
}

/**
 * A copy of `source` whose vertices sway in the wind: displacement grows with the square of the
 * height above the model's base (trunks stay put, crowns move), phase from the instance position
 * so neighbours are out of step. Instanced meshes only. `amount` is in model units per unit².
 */
export function swaying(
  source: THREE.Material,
  amount: number,
  time: { value: number },
): THREE.Material {
  const m = source.clone();
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.vertexShader = `uniform float uTime;\n${shader.vertexShader}`.replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>
      #ifdef USE_INSTANCING
        float h = max(position.y, 0.0);
        float ph = instanceMatrix[3].x * 0.11 + instanceMatrix[3].z * 0.07;
        float gust = sin(uTime * 1.3 + ph) * 0.6 + sin(uTime * 2.3 + ph * 1.7) * 0.4;
        transformed.x += gust * ${amount.toFixed(4)} * h * h;
        transformed.z += gust * ${(amount * 0.6).toFixed(4)} * h * h;
      #endif`,
    );
  };
  m.customProgramCacheKey = () => `sway-${amount}`;
  return m;
}

/** A few puffy low-poly clouds: merged icosahedrons, instanced. */
function createClouds(): THREE.InstancedMesh {
  const puffs: THREE.BufferGeometry[] = [];
  const layout = [
    [0, 0, 0, 9],
    [9, -2, 2, 7],
    [-9, -2, -1, 7],
    [4, 3, -3, 6],
    [-4, 2, 3, 6],
  ] as const;
  for (const [x, y, z, r] of layout) {
    const g = new THREE.IcosahedronGeometry(r, 1);
    g.scale(1, 0.6, 1).translate(x, y, z);
    puffs.push(g.index ? g.toNonIndexed() : g);
  }
  const positions: number[] = [];
  for (const p of puffs) positions.push(...(p.getAttribute("position").array as Float32Array));
  const cloudGeo = new THREE.BufferGeometry();
  cloudGeo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  cloudGeo.computeVertexNormals();
  for (const p of puffs) p.dispose();
  const mat = new THREE.MeshLambertMaterial({
    color: "#ffffff",
    emissive: "#c9dcef",
    emissiveIntensity: 0.55,
    fog: false,
    flatShading: true,
  });
  const count = 16;
  const clouds = new THREE.InstancedMesh(cloudGeo, mat, count);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + hash(i, 3) * 0.3;
    const r = 380 + hash(i, 5) * 260;
    const s = 1.2 + hash(i, 7) * 1.6;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), hash(i, 9) * Math.PI);
    m.compose(
      new THREE.Vector3(Math.cos(a) * r, 110 + hash(i, 11) * 90, Math.sin(a) * r),
      q,
      new THREE.Vector3(s, s * 0.8, s),
    );
    clouds.setMatrixAt(i, m);
  }
  clouds.frustumCulled = false;
  return clouds;
}

function hash(x: number, z: number, seed = 0) {
  let h = (x * 374761393 + z * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise in [0, 1]. */
function noise(x: number, z: number) {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const fx = x - xi;
  const fz = z - zi;
  const u = fx * fx * (3 - 2 * fx);
  const w = fz * fz * (3 - 2 * fz);
  const a = hash(xi, zi, 91);
  const b = hash(xi + 1, zi, 91);
  const c = hash(xi, zi + 1, 91);
  const d = hash(xi + 1, zi + 1, 91);
  return a + (b - a) * u + (c - a) * w + (a - b - c + d) * u * w;
}

export type Terrain = {
  /** Ground height at a world position: 0 on and around the circuit, hills further out. */
  height: (x: number, z: number) => number;
};

/** Flat around the circuit (plus a margin), rising into rolling hills beyond. */
export function createTerrain(track: TrackData): Terrain {
  const b = trackBounds(track);
  const margin = CELL * 3.5;
  const x0 = b.minX - margin;
  const x1 = b.maxX + margin;
  const z0 = b.minZ - margin;
  const z1 = b.maxZ + margin;
  return {
    height(x, z) {
      const dx = Math.max(x0 - x, 0, x - x1);
      const dz = Math.max(z0 - z, 0, z - z1);
      const d = Math.hypot(dx, dz);
      if (d <= 0) return 0;
      const ramp = Math.min(1, d / 120);
      const rise = ramp * ramp * (3 - 2 * ramp);
      const hills = noise(x / 70, z / 70) * 0.65 + noise(x / 28, z / 28) * 0.35;
      return rise * (6 + hills * 34);
    },
  };
}

/** Large grass ground following the terrain, with soft colour patches in vertex colours. */
export function createGround(terrain: Terrain): THREE.Mesh {
  const size = 1600;
  const seg = 160;
  const geo = new THREE.PlaneGeometry(size, size, seg, seg).rotateX(-Math.PI / 2);
  const pos = geo.getAttribute("position");
  const colors: number[] = [];
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const h = terrain.height(x, z);
    pos.setY(i, h);
    const n = noise(x / 22, z / 22) * 0.7 + noise(x / 6, z / 6) * 0.3;
    c.copy(PALETTE.grassDark).lerp(PALETTE.grass, n);
    if (h > 0) c.lerp(PALETTE.grassHill, Math.min(1, h / 30));
    colors.push(c.r, c.g, c.b);
  }
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const ground = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
  ground.receiveShadow = true;
  return ground;
}

export type Forest = { group: THREE.Group; dispose: () => void };

type Placement = { x: number; y: number; z: number; rot: number; scale: number };

/** Adds one InstancedMesh per material part of `model`. */
export function addInstances(
  group: THREE.Group,
  model: THREE.Object3D,
  list: Placement[],
  owned: { geometries: THREE.BufferGeometry[]; meshes: THREE.InstancedMesh[] },
  castShadow = true,
  material?: (m: THREE.Material) => THREE.Material,
) {
  if (list.length === 0) return;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const v = new THREE.Vector3();
  const sc = new THREE.Vector3();
  for (const part of toInstanceParts(model)) {
    owned.geometries.push(part.geometry);
    const mat = material ? material(part.material) : part.material;
    const mesh = new THREE.InstancedMesh(part.geometry, mat, list.length);
    list.forEach((p, i) => {
      q.setFromAxisAngle(up, p.rot);
      m.compose(v.set(p.x, p.y, p.z), q, sc.setScalar(p.scale));
      mesh.setMatrixAt(i, m);
    });
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    group.add(mesh);
    owned.meshes.push(mesh);
  }
}

let bushGeometry: THREE.BufferGeometry | null = null;
function bush() {
  if (!bushGeometry) {
    // Two squashed, slightly jittered icosahedrons: a chunky low-poly shrub.
    const a = new THREE.IcosahedronGeometry(1, 0);
    const b = new THREE.IcosahedronGeometry(0.75, 0).translate(0.7, -0.1, 0.3);
    const parts = [a, b].map((g) => (g.index ? g.toNonIndexed() : g.clone()));
    const positions: number[] = [];
    for (const p of parts) {
      const arr = p.getAttribute("position").array as Float32Array;
      for (let i = 0; i < arr.length; i += 3) {
        const j = (Math.sin(arr[i]! * 12.9 + arr[i + 2]! * 78.2) * 43758.5) % 1;
        positions.push(
          arr[i]! * (1 + j * 0.12),
          arr[i + 1]! * 0.7 + 0.45,
          arr[i + 2]! * (1 - j * 0.1),
        );
      }
      p.dispose();
    }
    a.dispose();
    b.dispose();
    bushGeometry = new THREE.BufferGeometry();
    bushGeometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    bushGeometry.computeVertexNormals();
  }
  return bushGeometry;
}

/** Merges non-indexed copies of geometries, painting each in one vertex colour. */
function paintedMerge(parts: [THREE.BufferGeometry, string][]): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const c = new THREE.Color();
  for (const [g, color] of parts) {
    const flat = g.index ? g.toNonIndexed() : g;
    const arr = flat.getAttribute("position").array as Float32Array;
    c.set(color);
    for (let i = 0; i < arr.length; i += 3) {
      positions.push(arr[i]!, arr[i + 1]!, arr[i + 2]!);
      colors.push(c.r, c.g, c.b);
    }
    if (flat !== g) flat.dispose();
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  out.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  out.computeVertexNormals();
  return out;
}

let pineGeometry: THREE.BufferGeometry | null = null;
/** Low-poly conifer, 1.6 units tall: a trunk and three stacked seven-sided cones. */
function pine() {
  pineGeometry ??= paintedMerge([
    [new THREE.CylinderGeometry(0.05, 0.07, 0.35, 5).translate(0, 0.17, 0), "#7a5235"],
    [new THREE.ConeGeometry(0.42, 0.65, 7).translate(0, 0.6, 0), "#2f6b3a"],
    [new THREE.ConeGeometry(0.33, 0.55, 7).translate(0, 0.98, 0), "#3a7d43"],
    [new THREE.ConeGeometry(0.22, 0.45, 7).translate(0, 1.36, 0), "#46904d"],
  ]);
  return pineGeometry;
}

let tuftGeometry: THREE.BufferGeometry | null = null;
let blossomGeometry: THREE.BufferGeometry | null = null;
/**
 * A low flowering tuft, in two parts drawn from the same placements (8 triangles each, so
 * hundreds stay cheap): the leafy cushion keeps its green, the white blossom on top takes the
 * instance colour.
 */
function flower(): [THREE.BufferGeometry, THREE.BufferGeometry] {
  tuftGeometry ??= paintedMerge([
    [new THREE.OctahedronGeometry(0.13, 0).scale(1.2, 0.45, 1.2).translate(0, 0.05, 0), "#7fbf55"],
  ]);
  blossomGeometry ??= paintedMerge([
    [new THREE.OctahedronGeometry(0.075, 0).scale(1, 0.6, 1).translate(0, 0.12, 0), "#ffffff"],
  ]);
  return [tuftGeometry, blossomGeometry];
}

let rockGeometry: THREE.BufferGeometry | null = null;
/** A chunky, squashed boulder. */
function rock() {
  if (!rockGeometry) {
    // Polyhedra come non-indexed: every face has its own vertices, so the jitter keeps it faceted.
    const g = new THREE.DodecahedronGeometry(0.6, 0);
    const pos = g.getAttribute("position");
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const j = 1 + (Math.sin(x * 17.1 + z * 31.7 + y * 7.3) * 0.5 + 0.5) * 0.18;
      pos.setXYZ(i, x * j, Math.max(-0.1, y * 0.62 * j) + 0.1, z * j * 0.9);
    }
    g.computeVertexNormals();
    rockGeometry = g;
  }
  return rockGeometry;
}

const FLOWER_TONES = ["#f6f3ea", "#f2c14e", "#e98bb4", "#9b7fd6", "#e5483b", "#ffd98a"].map(
  (c) => new THREE.Color(c),
);
const ROCK_TONES = ["#8d9096", "#9fa2a6", "#7c7f85", "#a8a39a"].map((c) => new THREE.Color(c));

/**
 * Trees, bushes and tents on empty cells around the circuit. Cells touching the track get sparse
 * dressing so the cameras keep a clear view; cells further out become forest climbing the hills.
 * `reserved` cells (trackside props, grandstands, pits) stay clear.
 */
export function createForest(
  track: TrackData,
  models: Models,
  terrain: Terrain,
  reserved: Set<string>,
  ambient: Ambient,
  lowPower = false,
): Forest {
  const occupied = new Set<string>();
  for (const p of track.pieces) for (const [x, z] of footprintCells(p)) occupied.add(cellKey(x, z));
  const b = trackBounds(track);
  const pad = 7;
  const minX = Math.round(b.minX / CELL + 0.5) - pad;
  const maxX = Math.round(b.maxX / CELL - 0.5) + pad;
  const minZ = Math.round(b.minZ / CELL + 0.5) - pad;
  const maxZ = Math.round(b.maxZ / CELL - 0.5) + pad;

  const ring = (x: number, z: number) => {
    // Chebyshev distance to the nearest track cell, capped at 3.
    for (let r = 1; r <= 2; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) if (occupied.has(cellKey(x + dx, z + dz))) return r;
      }
    }
    return 3;
  };

  // Dressing within two cells of the track casts shadows; the forest beyond does not (it is
  // mostly outside the shadow map anyway, and its shadow pass cost more than it showed).
  const near = emptySets();
  const far = emptySets();
  const flowers: (Placement & { tone: number })[] = [];

  for (let cz = minZ; cz <= maxZ; cz++) {
    for (let cx = minX; cx <= maxX; cx++) {
      const key = cellKey(cx, cz);
      if (occupied.has(key) || reserved.has(key)) continue;
      const r = ring(cx, cz);
      const at = (i: number, spread: number) => {
        const x = cx * CELL + (hash(cx, cz, 10 + i) - 0.5) * CELL * spread;
        const z = cz * CELL + (hash(cx, cz, 20 + i) - 0.5) * CELL * spread;
        return { x, z, y: terrain.height(x, z) };
      };
      // Flower patches: small, low and off the road, they colour the verges without hiding it.
      if (hash(cx, cz, 90) < (r === 1 ? 0.38 : r === 2 ? 0.3 : 0.1)) {
        const n = (lowPower ? 4 : 7) + Math.floor(hash(cx, cz, 91) * (lowPower ? 3 : 6));
        const px = cx * CELL + (hash(cx, cz, 92) - 0.5) * CELL * 0.5;
        const pz = cz * CELL + (hash(cx, cz, 93) - 0.5) * CELL * 0.5;
        const tone = Math.floor(hash(cx, cz, 94) * FLOWER_TONES.length);
        for (let i = 0; i < n; i++) {
          const a = hash(cx, cz, 100 + i) * Math.PI * 2;
          const d = Math.sqrt(hash(cx, cz, 120 + i)) * 1.5;
          const x = px + Math.cos(a) * d;
          const z = pz + Math.sin(a) * d;
          // Mostly one colour per patch, the odd different one.
          const t = hash(cx, cz, 140 + i) < 0.8 ? tone : (tone + 1 + i) % FLOWER_TONES.length;
          flowers.push({
            x,
            y: terrain.height(x, z),
            z,
            rot: a,
            scale: 1.3 + hash(cx, cz, 160 + i) * 0.9,
            tone: t,
          });
        }
      }
      if (r >= 2 && hash(cx, cz, 95) < 0.16) {
        (r === 2 ? near : far).rocks.push({
          ...at(7, 0.8),
          rot: hash(cx, cz, 96) * 6.28,
          scale: 0.6 + hash(cx, cz, 97) * 1.1,
        });
      }
      if (r === 1) {
        // Next to the track: an occasional tree, tent or a few bushes; never crowded.
        const roll = hash(cx, cz, 1);
        if (roll < 0.3)
          near.small.push({
            ...at(0, 0.3),
            rot: hash(cx, cz, 30) * 6.28,
            scale: 3.2 + hash(cx, cz, 40) * 1.4,
          });
        else if (roll < 0.4) {
          near.tents.push({
            x: cx * CELL,
            y: 0,
            z: cz * CELL,
            rot: Math.floor(hash(cx, cz, 4) * 4) * (Math.PI / 2),
            scale: 4,
          });
        } else if (roll < 0.75) {
          for (let i = 0; i < 3; i++)
            near.bushes.push({
              ...at(i, 0.5),
              rot: hash(cx, cz, 60 + i) * 6.28,
              scale: 0.55 + hash(cx, cz, 70 + i) * 0.5,
            });
        }
        continue;
      }
      const sets = r === 2 ? near : far;
      const count =
        r === 2 ? 1 + Math.floor(hash(cx, cz, 2) * 3) : 2 + Math.floor(hash(cx, cz, 2) * 3);
      for (let i = 0; i < count; i++) {
        const p = {
          ...at(i, 0.8),
          rot: hash(cx, cz, 30 + i) * Math.PI * 2,
          scale: 3.4 + hash(cx, cz, 40 + i) * 2.4,
        };
        // Broadleaf trees, with pines for variety (more of them in the far forest).
        const kind = hash(cx, cz, 50 + i);
        const pines = r === 2 ? 0.2 : 0.38;
        if (kind < pines) sets.pines.push(p);
        else (kind < 0.55 + pines * 0.45 ? sets.large : sets.small).push(p);
      }
      if (hash(cx, cz, 80) < 0.5) {
        sets.bushes.push({
          ...at(5, 0.9),
          rot: hash(cx, cz, 81) * 6.28,
          scale: 0.7 + hash(cx, cz, 82) * 0.6,
        });
      }
    }
  }

  const group = new THREE.Group();
  group.name = "forest";
  const owned = { geometries: [] as THREE.BufferGeometry[], meshes: [] as THREE.InstancedMesh[] };
  const time = ambient.time;
  const bushMat = swaying(
    new THREE.MeshLambertMaterial({ color: "#ffffff", flatShading: true }),
    0.05,
    time,
  );
  const pineMat = swaying(
    new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
    0.025,
    time,
  );
  const rockMat = new THREE.MeshLambertMaterial({ color: "#ffffff", flatShading: true });
  const flowerMat = swaying(new THREE.MeshLambertMaterial({ vertexColors: true }), 0.6, time);
  // One swaying copy per kit material, shared by every tree using it.
  const swayed = new Map<THREE.Material, THREE.Material>();
  const treeSway = (m: THREE.Material) => {
    let copy = swayed.get(m);
    if (!copy) swayed.set(m, (copy = swaying(m, 0.028, time)));
    return copy;
  };
  /** One InstancedMesh for a procedural geometry, tinted per instance when `tones` is given. */
  const place = (
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    list: (Placement & { tone?: number })[],
    shadows: boolean,
    tones?: THREE.Color[],
  ) => {
    if (list.length === 0) return;
    const mesh = new THREE.InstancedMesh(geometry, material, list.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const v = new THREE.Vector3();
    const sc = new THREE.Vector3();
    list.forEach((p, i) => {
      q.setFromAxisAngle(up, p.rot);
      mesh.setMatrixAt(i, m.compose(v.set(p.x, p.y, p.z), q, sc.setScalar(p.scale)));
      if (tones) {
        const k = p.tone ?? Math.floor(Math.abs(p.x * 7 + p.z * 13));
        mesh.setColorAt(i, tones[k % tones.length]!);
      }
    });
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    group.add(mesh);
    owned.meshes.push(mesh);
  };
  const tones = ["#4f8f36", "#5c9e3e", "#6aa947", "#4a8434"].map((c) => new THREE.Color(c));
  // Two batches: near dressing casting shadows, and the far forest without. Kept as whole
  // batches on purpose: on integrated GPUs draw calls, not triangles, are the bottleneck, and
  // splitting the forest into culled tiles cost more in draw calls than it saved.
  const batches: [Sets, boolean][] = [
    [near, true],
    [far, false],
  ];
  for (const [tile, shadows] of batches) {
    addInstances(group, models.treeLarge, tile.large, owned, shadows, treeSway);
    addInstances(group, models.treeSmall, tile.small, owned, shadows, treeSway);
    addInstances(group, models.tentClosed, tile.tents, owned, shadows);
    place(pine(), pineMat, tile.pines, shadows);
    place(rock(), rockMat, tile.rocks, shadows, ROCK_TONES);
    if (tile.bushes.length > 0) {
      const mesh = new THREE.InstancedMesh(bush(), bushMat, tile.bushes.length);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      tile.bushes.forEach((p, i) => {
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.rot);
        m.compose(
          new THREE.Vector3(p.x, p.y, p.z),
          q,
          new THREE.Vector3(p.scale, p.scale, p.scale),
        );
        mesh.setMatrixAt(i, m);
        mesh.setColorAt(i, tones[Math.floor(p.x * 7 + p.z * 13) & 3]!);
      });
      mesh.castShadow = shadows;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
      owned.meshes.push(mesh);
    }
  }

  // Flowers: no shadows (too small to show in the shadow map anyway).
  const [tuft, blossom] = flower();
  place(tuft, flowerMat, flowers, false);
  place(blossom, flowerMat, flowers, false, FLOWER_TONES);

  return {
    group,
    dispose: () => {
      for (const g of owned.geometries) g.dispose();
      for (const i of owned.meshes) i.dispose();
      for (const m of [bushMat, pineMat, rockMat, flowerMat, ...swayed.values()]) m.dispose();
    },
  };
}

type Sets = Record<"large" | "small" | "tents" | "bushes" | "pines" | "rocks", Placement[]>;
const emptySets = (): Sets => ({
  large: [],
  small: [],
  tents: [],
  bushes: [],
  pines: [],
  rocks: [],
});
