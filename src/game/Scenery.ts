import * as THREE from "three";
import { toInstanceParts, type Models } from "./assets";
import { CELL } from "./track/pieces";
import { cellKey, footprintCells, trackBounds, type TrackData } from "./track/Track";

// Static world dressing: light rig, sky with sun glow and clouds, rolling ground, and a forest with
// bushes that fills the empty cells around the circuit. Everything repeated is instanced, so
// hundreds of trees cost a few draw calls.

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
  group.add(createClouds());
  return group;
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
) {
  if (list.length === 0) return;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const v = new THREE.Vector3();
  const sc = new THREE.Vector3();
  for (const part of toInstanceParts(model)) {
    owned.geometries.push(part.geometry);
    const mesh = new THREE.InstancedMesh(part.geometry, part.material, list.length);
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
        (hash(cx, cz, 50 + i) < 0.55 ? sets.large : sets.small).push(p);
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
  const bushMat = new THREE.MeshLambertMaterial({ color: "#ffffff", flatShading: true });
  const tones = ["#4f8f36", "#5c9e3e", "#6aa947", "#4a8434"].map((c) => new THREE.Color(c));
  // Two batches: near dressing casting shadows, and the far forest without. Kept as whole
  // batches on purpose: on integrated GPUs draw calls, not triangles, are the bottleneck, and
  // splitting the forest into culled tiles cost more in draw calls than it saved.
  const batches: [Sets, boolean][] = [
    [near, true],
    [far, false],
  ];
  for (const [tile, shadows] of batches) {
    addInstances(group, models.treeLarge, tile.large, owned, shadows);
    addInstances(group, models.treeSmall, tile.small, owned, shadows);
    addInstances(group, models.tentClosed, tile.tents, owned, shadows);
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

  return {
    group,
    dispose: () => {
      for (const g of owned.geometries) g.dispose();
      for (const i of owned.meshes) i.dispose();
      bushMat.dispose();
    },
  };
}

type Sets = Record<"large" | "small" | "tents" | "bushes", Placement[]>;
const emptySets = (): Sets => ({ large: [], small: [], tents: [], bushes: [] });
