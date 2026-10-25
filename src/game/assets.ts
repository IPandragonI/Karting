import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// Models are CC0 assets from Kenney (see ASSETS.md), served from /public/models.

export const KART_MODELS = [
  "kart-oobi",
  "kart-oodi",
  "kart-ooli",
  "kart-oopi",
  "kart-oozi",
] as const;
export type KartModel = (typeof KART_MODELS)[number];

/**
 * Livery per driver. The drivers all wear a white helmet, so from the chase camera the kart body
 * colour is what tells them apart (and what the menu swatches show).
 */
export const KART_LIVERY: Record<KartModel, string> = {
  "kart-oobi": "#f2efe6",
  "kart-oodi": "#8fd36a",
  "kart-ooli": "#79b8e8",
  "kart-oopi": "#f28fb8",
  "kart-oozi": "#f2c14e",
};

const PROP_MODELS = [
  "cone",
  "treeLarge",
  "treeSmall",
  "tentClosed",
  "grandStand",
  "flagCheckers",
] as const;
export type PropModel = (typeof PROP_MODELS)[number];

/** Props are all loaded up front; karts load lazily (only the chosen one at startup). */
export type Models = Record<PropModel, THREE.Group> & {
  karts: Partial<Record<KartModel, THREE.Group>>;
};

const loader = new GLTFLoader();
const cache = new Map<string, Promise<THREE.Group>>();

/**
 * Loads a model once (cached). The Racing Kit models carry an odd root offset, so props are
 * re-centred: footprint centred on the origin, base at y = 0. Karts are left untouched because
 * their wheel nodes define the pivots we animate.
 */
function loadModel(name: KartModel | PropModel): Promise<THREE.Group> {
  let p = cache.get(name);
  if (!p) {
    p = loader.loadAsync(`/models/${name}.glb`).then((gltf) => {
      const root = gltf.scene;
      root.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) {
          const mesh = o as THREE.Mesh;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
        }
      });
      if (!name.startsWith("kart-")) recenter(root);
      return root;
    });
    // A failed download may succeed on retry; do not cache the rejection.
    p.catch(() => cache.delete(name));
    cache.set(name, p);
  }
  return p;
}

export async function loadModels(
  kart: KartModel,
  onProgress?: (loaded: number, total: number) => void,
): Promise<Models> {
  const names = [...PROP_MODELS];
  const total = names.length + 1;
  let loaded = 0;
  const tick = <T>(v: T) => {
    onProgress?.(++loaded, total);
    return v;
  };
  const [kartRoot, ...props] = await Promise.all([
    loadModel(kart).then(tick),
    ...names.map((n) => loadModel(n).then(tick)),
  ]);
  const models = Object.fromEntries(names.map((n, i) => [n, props[i]!])) as Record<
    PropModel,
    THREE.Group
  >;
  return { ...models, karts: { [kart]: kartRoot } };
}

export async function loadKart(models: Models, kart: KartModel): Promise<THREE.Group> {
  const existing = models.karts[kart];
  if (existing) return existing;
  const root = await loadModel(kart);
  models.karts[kart] = root;
  return root;
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
