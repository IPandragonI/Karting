import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { KART_SCALE } from "./KartView";

// The best-lap ghost: the kart and a driver silhouette baked into one geometry and drawn as a
// translucent, slightly glowing shell. A depth-only pre-pass hides the inner faces, so it reads
// as one clean see-through kart instead of a jumble of overlapping parts. No shadows, no physics,
// no per-frame animation: two draw calls and a matrix update per frame.

const COLOR = "#8fd3ff";

export class GhostView {
  readonly root = new THREE.Group();
  private readonly geometry: THREE.BufferGeometry;
  private readonly materials: THREE.Material[];

  constructor(model: THREE.Group) {
    const kart = model.clone(true);
    kart.scale.setScalar(KART_SCALE);
    kart.updateMatrixWorld(true);
    const parts: THREE.BufferGeometry[] = [];
    kart.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      let hidden = false;
      for (let p: THREE.Object3D | null = o; p; p = p.parent)
        if (p.name.toLowerCase() === "character") hidden = true;
      if (hidden) return;
      parts.push(strip(mesh.geometry).applyMatrix4(mesh.matrixWorld));
    });
    // Driver silhouette: torso and helmet (kart-model units, as in KartView).
    const s = KART_SCALE;
    const torso = new THREE.CapsuleGeometry(0.13 * s, 0.16 * s, 4, 8);
    torso.rotateX(-0.25).translate(0, 0.5 * s, -0.17 * s);
    const head = new THREE.SphereGeometry(0.14 * s, 12, 8).translate(0, 0.79 * s, -0.13 * s);
    parts.push(strip(torso), strip(head));
    torso.dispose();
    head.dispose();
    this.geometry = mergeGeometries(parts)!;
    for (const p of parts) p.dispose();

    const depth = new THREE.MeshBasicMaterial({ colorWrite: false });
    const shell = new THREE.MeshLambertMaterial({
      color: COLOR,
      emissive: COLOR,
      emissiveIntensity: 0.5,
      transparent: true,
      opacity: 0.5,
      depthFunc: THREE.LessEqualDepth,
    });
    this.materials = [depth, shell];
    const pre = new THREE.Mesh(this.geometry, depth);
    const main = new THREE.Mesh(this.geometry, shell);
    // Drawn with the transparent pass, after the opaque scene: the pre-pass first.
    pre.renderOrder = 2;
    main.renderOrder = 3;
    depth.transparent = true;
    for (const m of [pre, main]) {
      m.castShadow = false;
      m.receiveShadow = false;
      m.frustumCulled = false;
      this.root.add(m);
    }
    this.root.visible = false;
    this.root.matrixAutoUpdate = false;
  }

  /** Shows the ghost at a pose, or hides it (null). */
  set(pose: { x: number; y: number; z: number; yaw: number } | null) {
    if (!pose) {
      this.root.visible = false;
      return;
    }
    this.root.visible = true;
    this.root.position.set(pose.x, pose.y, pose.z);
    this.root.rotation.y = pose.yaw;
    this.root.updateMatrix();
  }

  dispose() {
    this.geometry.dispose();
    for (const m of this.materials) m.dispose();
  }
}

/** Position and normal only, non-indexed, so parts from different sources merge. */
function strip(source: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = source.index ? source.toNonIndexed() : source.clone();
  for (const name of Object.keys(g.attributes))
    if (name !== "position" && name !== "normal") g.deleteAttribute(name);
  if (!g.attributes.normal) g.computeVertexNormals();
  return g;
}
