import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

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

/**
 * The player's car: Kenney Car Kit "race", a low-poly open-wheel single-seater (CC0, ASSETS.md).
 * Its forward axis is +Z like the physics heading and its base sits at y = 0. Physics never sees
 * this model: the collider is the kart sphere, so only the look changes.
 */
export const VEHICLE = {
  model: "race",
  /** Model units → metres: 2.56 long → 2.1 m, close to the collider's footprint. */
  scale: 0.82,
  /** Helmet centre in model units: on the cockpit deck (y 0.49), in front of the roll hoop. */
  helmet: { y: 0.63, z: 0.1 },
  /**
   * First-person eye relative to the car origin (metres): at the visor, above the bodywork and in
   * front of the roll hoop, so the camera never sits inside solid geometry.
   */
  eye: { y: 0.74, z: 0.2 },
} as const;

const MODELS = [
  "race",
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

/**
 * Loads every model once (about 0.6 MB in total). The Racing Kit models carry an odd root offset,
 * so props are re-centred: footprint centred on the origin, base at y = 0. The kart is left
 * untouched because its wheel nodes define the pivots we animate.
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
      if (!name.startsWith("kart-")) recenter(root);
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
  } else if (model.startsWith("kart-")) {
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
