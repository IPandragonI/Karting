import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { EngineId } from "./audio/engineDsp";

// Models are CC0 assets from Kenney (see ASSETS.md), served from /public/models.

/**
 * Liveries: the car's bodywork (its red palette swatches), the driver's suit and helmet take
 * this colour.
 */
export const LIVERIES = [
  { id: "snow", label: "Snow", color: "#f2efe6" },
  { id: "kerb", label: "Kerb red", color: "#e5483b" },
  { id: "sky", label: "Sky blue", color: "#4f9de0" },
  { id: "lime", label: "Lime", color: "#7cc35a" },
  { id: "sun", label: "Sunflower", color: "#f2c14e" },
] as const;
export type LiveryId = (typeof LIVERIES)[number]["id"];

export type VehicleDef = {
  id: string;
  label: string;
  description: string;
  model: ModelName;
  /** Model units → metres. Every vehicle keeps roughly the collider's footprint. */
  scale: number;
  /**
   * Helmet centre in model units, where the ghost's driver silhouette sits; null when the model
   * brings its own driver or has a closed cabin.
   */
  helmet: { y: number; z: number } | null;
  /** The kit's own driver figure ("character" node) is shown (hidden in first person). */
  character: boolean;
  /**
   * First-person eye relative to the car origin (metres): above the bodywork or under the cabin
   * roof, so the camera never sits inside solid geometry.
   */
  eye: { y: number; z: number };
  engine: EngineId;
};

/**
 * The player's vehicles, all from Kenney's Car Kit (CC0, ASSETS.md). Their forward axis is +Z like
 * the physics heading and their base sits at y = 0. Physics never sees these models: the
 * collider is the same kart sphere for all of them, so the choice changes the look, the driving
 * view and the engine, never the handling (lap records stay comparable).
 */
export const VEHICLES = [
  {
    id: "formula",
    label: "Formula",
    description: "Open-wheel single-seater with a howling V10 and a seven-speed paddle shift.",
    model: "race",
    // 2.56 long → 2.1 m.
    scale: 0.82,
    // On the cockpit deck (y 0.49), in front of the roll hoop.
    helmet: { y: 0.63, z: 0.1 },
    character: false,
    eye: { y: 0.74, z: 0.2 },
    engine: "f1",
  },
  {
    id: "kart",
    label: "Go-kart",
    description: "The real thing: a twin-cylinder kart, no gearbox, revs locked to the road.",
    model: "kart-oobi",
    // 1.43 long → 1.9 m (the kit's kart is short and tall: its driver is part of the model).
    scale: 1.3,
    helmet: null,
    character: true,
    eye: { y: 1.17, z: 0.05 },
    engine: "kart",
  },
  {
    id: "sports",
    label: "Sports car",
    description: "Low coupé with a burbling cross-plane V8 and a six-speed gearbox.",
    model: "sedan-sports",
    scale: 0.82,
    helmet: null,
    character: false,
    eye: { y: 0.72, z: 0.32 },
    engine: "v8",
  },
  {
    id: "truck",
    label: "Truck",
    description: "A pickup on the race track: six-cylinder diesel, five long gears.",
    model: "truck",
    // 2.95 long → 2.65 m: the biggest, still on the same collider.
    scale: 0.9,
    helmet: null,
    character: false,
    eye: { y: 1.02, z: 0.45 },
    engine: "diesel",
  },
] as const satisfies readonly VehicleDef[];

export type VehicleId = (typeof VEHICLES)[number]["id"];
export const DEFAULT_VEHICLE: VehicleId = "formula";

export function vehicleById(id: string): VehicleDef {
  return VEHICLES.find((v) => v.id === id) ?? VEHICLES[0];
}

const MODELS = [
  "race",
  "kart-oobi",
  "sedan-sports",
  "truck",
  "cone",
  "treeLarge",
  "treeSmall",
  "tentClosed",
  "grandStand",
  "grandStandCovered",
  "flagCheckers",
  "flagGreen",
  "flagRed",
  "billboard",
  "billboardLow",
  "fenceStraight",
  "lightPostLarge",
  "bannerTowerGreen",
  "bannerTowerRed",
  "pitsGarage",
  "pitsGarageClosed",
  "pitsOffice",
] as const;
export type ModelName = (typeof MODELS)[number];
export type Models = Record<ModelName, THREE.Group>;

const loader = new GLTFLoader();

/** Vehicle models: left as authored (their wheel nodes define the pivots we animate). */
const VEHICLE_MODELS = new Set<string>(VEHICLES.map((v) => v.model));

/**
 * Loads every model once (about 1.2 MB in total, the four vehicles being most of it). The Racing
 * Kit models carry an odd root offset, so props are re-centred: footprint centred on the origin,
 * base at y = 0.
 */
export async function loadModels(
  onProgress?: (loaded: number, total: number) => void,
): Promise<Models> {
  let loaded = 0;
  const entries = await Promise.all(
    MODELS.map(async (name) => {
      const gltf = await loader.loadAsync(`/models/${name}.glb`);
      const root = gltf.scene;
      root.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) {
          const mesh = o as THREE.Mesh;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material])
            tuneMaterial(m as THREE.MeshStandardMaterial, name);
        }
      });
      if (!VEHICLE_MODELS.has(name)) recenter(root);
      onProgress?.(++loaded, MODELS.length);
      return [name, root] as const;
    }),
  );
  return Object.fromEntries(entries) as Models;
}

/**
 * The kit's materials are all fully rough. A touch of sheen gives the soft sun something to
 * model shapes with: painted kart bodies and plastic read glossier, glass reflects, everything
 * else stays matte. Materials are shared within a model, so each is tuned once.
 */
const tuned = new WeakSet<THREE.Material>();
function tuneMaterial(m: THREE.MeshStandardMaterial, model: string) {
  if (!m.isMeshStandardMaterial || tuned.has(m)) return;
  tuned.add(m);
  const name = m.name.toLowerCase();
  if (name === "glass") {
    m.roughness = 0.25;
    m.metalness = 0.1;
  } else if (VEHICLE_MODELS.has(model)) {
    m.roughness = 0.55;
  } else if (name === "pylon" || name === "checkers" || name === "red") {
    m.roughness = 0.7;
  } else {
    m.roughness = 0.92;
  }
}

function recenter(root: THREE.Group) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const center = box.getCenter(new THREE.Vector3());
  const wrapper = new THREE.Group();
  for (const child of [...root.children]) wrapper.add(child);
  wrapper.position.set(-center.x, -box.min.y, -center.z);
  root.add(wrapper);
}

/**
 * Flattens a (small) model into one geometry + material pair per material so it can be drawn
 * with InstancedMesh. Transforms are baked into the geometry.
 */
export function toInstanceParts(
  root: THREE.Object3D,
  scale = 1,
): { geometry: THREE.BufferGeometry; material: THREE.Material }[] {
  root.updateMatrixWorld(true);
  const parts: { geometry: THREE.BufferGeometry; material: THREE.Material }[] = [];
  const s = new THREE.Matrix4().makeScale(scale, scale, scale);
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const base = mesh.geometry
      .clone()
      .applyMatrix4(new THREE.Matrix4().multiplyMatrices(s, mesh.matrixWorld));
    if (materials.length === 1) {
      parts.push({ geometry: base, material: materials[0]! });
      return;
    }
    // Multi-material meshes: split by group so each part keeps a single material.
    for (const group of base.groups) {
      const g = base.clone();
      g.clearGroups();
      g.setDrawRange(0, Infinity);
      const index = base.index!;
      const slice = index.array.slice(group.start, group.start + group.count);
      g.setIndex(new THREE.BufferAttribute(slice, 1));
      parts.push({ geometry: g, material: materials[group.materialIndex ?? 0]! });
    }
  });
  return parts;
}
