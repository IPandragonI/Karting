import * as THREE from "three";
import { toInstanceParts, type Models } from "./assets";
import { CELL } from "./track/pieces";
import { cellKey, footprintCells, trackBounds, type TrackData } from "./track/Track";

// Static world dressing: sky, light rig, ground, and a forest that fills the empty cells around
// the circuit. Trees are instanced per model part, so hundreds of trees cost a few draw calls.

export const PALETTE = {
  skyTop: new THREE.Color("#7fb8e6"),
  skyHorizon: new THREE.Color("#d9ecf2"),
  grass: new THREE.Color("#79b956"),
  grassDark: new THREE.Color("#68a84a"),
};

export class Lighting {
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  private readonly offset = new THREE.Vector3(-18, 30, -12);

  constructor(scene: THREE.Scene) {
    this.hemi = new THREE.HemisphereLight("#d4ecff", "#5f8a44", 1.6);
    scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight("#fff3dc", 2.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const s = this.sun.shadow.camera;
    s.left = -32;
    s.right = 32;
    s.top = 32;
    s.bottom = -32;
    s.near = 1;
    s.far = 90;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    scene.add(this.sun, this.sun.target);
  }

  /** Keeps the shadow frustum centred on what the camera is looking at. */
  follow(x: number, z: number) {
    // Snap to shadow texels to avoid shimmering edges while moving.
    const texel = 64 / 2048;
    const sx = Math.round(x / texel) * texel;
    const sz = Math.round(z / texel) * texel;
    this.sun.target.position.set(sx, 0, sz);
    this.sun.position.set(sx + this.offset.x, this.offset.y, sz + this.offset.z);
  }
}

export function createSky(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(600, 24, 12);
  const colors: number[] = [];
  const pos = geo.getAttribute("position");
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = Math.max(0, pos.getY(i) / 600);
    c.copy(PALETTE.skyHorizon).lerp(PALETTE.skyTop, Math.pow(t, 0.6));
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
  return sky;
}

function hash(x: number, z: number, seed = 0) {
  let h = (x * 374761393 + z * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Large grass ground with soft colour patches baked into vertex colours. */
export function createGround(): THREE.Mesh {
  const size = 1200;
  const seg = 120;
  const geo = new THREE.PlaneGeometry(size, size, seg, seg).rotateX(-Math.PI / 2);
  const pos = geo.getAttribute("position");
  const colors: number[] = [];
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const n =
      0.5 +
      0.5 *
        Math.sin(x * 0.05 + Math.sin(z * 0.031) * 2) *
        Math.cos(z * 0.043 + Math.sin(x * 0.027));
    c.copy(PALETTE.grassDark).lerp(PALETTE.grass, n);
    colors.push(c.r, c.g, c.b);
  }
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  const ground = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
  ground.receiveShadow = true;
  return ground;
}

export type Forest = { group: THREE.Group; dispose: () => void };

/**
 * Trees and tents on empty cells around the circuit. Cells touching the track get sparse
 * dressing so the chase camera keeps a clear view; cells further out become dense forest.
 */
export function createForest(track: TrackData, models: Models): Forest {
  const occupied = new Set<string>();
  for (const p of track.pieces) for (const [x, z] of footprintCells(p)) occupied.add(cellKey(x, z));
  const b = trackBounds(track);
  const pad = 4;
  const minX = Math.round(b.minX / CELL + 0.5) - pad;
  const maxX = Math.round(b.maxX / CELL - 0.5) + pad;
  const minZ = Math.round(b.minZ / CELL + 0.5) - pad;
  const maxZ = Math.round(b.maxZ / CELL - 0.5) + pad;

  const near = (x: number, z: number) => {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) if (occupied.has(cellKey(x + dx, z + dz))) return true;
    }
    return false;
  };

  type Placement = { x: number; z: number; rot: number; scale: number };
  const large: Placement[] = [];
  const small: Placement[] = [];
  const tents: Placement[] = [];

  for (let cz = minZ; cz <= maxZ; cz++) {
    for (let cx = minX; cx <= maxX; cx++) {
      if (occupied.has(cellKey(cx, cz))) continue;
      const isNear = near(cx, cz);
      const count = isNear ? (hash(cx, cz, 1) < 0.45 ? 1 : 0) : 3 + Math.floor(hash(cx, cz, 2) * 3);
      if (isNear && hash(cx, cz, 9) < 0.12) {
        tents.push({
          x: cx * CELL,
          z: cz * CELL,
          rot: Math.floor(hash(cx, cz, 4) * 4) * (Math.PI / 2),
          scale: 4,
        });
        continue;
      }
      for (let i = 0; i < count; i++) {
        // Near the track keep trees in the middle of the cell, away from the tire walls.
        const spread = isNear ? 0.25 : 0.8;
        const x = cx * CELL + (hash(cx, cz, 10 + i) - 0.5) * CELL * spread;
        const z = cz * CELL + (hash(cx, cz, 20 + i) - 0.5) * CELL * spread;
        const p = {
          x,
          z,
          rot: hash(cx, cz, 30 + i) * Math.PI * 2,
          scale: 3.4 + hash(cx, cz, 40 + i) * 2.2,
        };
        (hash(cx, cz, 50 + i) < 0.55 ? large : small).push(p);
      }
    }
  }

  const group = new THREE.Group();
  group.name = "forest";
  const geometries: THREE.BufferGeometry[] = [];
  const instanced: THREE.InstancedMesh[] = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const v = new THREE.Vector3();
  const sc = new THREE.Vector3();
  const addInstances = (model: THREE.Object3D, list: Placement[], shadows: boolean) => {
    if (list.length === 0) return;
    for (const part of toInstanceParts(model)) {
      geometries.push(part.geometry);
      const mesh = new THREE.InstancedMesh(part.geometry, part.material, list.length);
      list.forEach((p, i) => {
        q.setFromAxisAngle(up, p.rot);
        m.compose(v.set(p.x, 0, p.z), q, sc.setScalar(p.scale));
        mesh.setMatrixAt(i, m);
      });
      mesh.castShadow = shadows;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
      instanced.push(mesh);
    }
  };
  addInstances(models.treeLarge, large, true);
  addInstances(models.treeSmall, small, true);
  addInstances(models.tentClosed, tents, true);

  return {
    group,
    dispose: () => {
      for (const g of geometries) g.dispose();
      for (const i of instanced) i.dispose();
    },
  };
}
