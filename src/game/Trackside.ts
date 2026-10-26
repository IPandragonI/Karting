import * as THREE from "three";
import type { Models } from "./assets";
import { addInstances, type Terrain } from "./Scenery";
import { CELL, DIR_VEC, PIECES, rotateVec, type Dir } from "./track/pieces";
import {
  cellKey,
  footprintCells,
  toWorld,
  type RacePath,
  type TrackData,
  type TrackLayout,
} from "./track/Track";

// Trackside dressing derived from the layout, so it follows every edit: grandstands and pits by
// the start line, billboards, light posts and fences along straights, chevron boards and flags
// on the outside of corners. Decisions are hashed from cell coordinates (stable between rebuilds,
// varied along the circuit). Props only go in empty cells, set back from the tire walls, and have
// no colliders: they frame the circuit without ever blocking the road. Most cells stay empty on
// purpose, for clarity at speed.

export type Trackside = { group: THREE.Group; reserved: Set<string>; dispose: () => void };

type Placement = { x: number; y: number; z: number; rot: number; scale: number };

function hash(x: number, z: number, seed: number) {
  let h = (x * 374761393 + z * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Racing Kit models are authored facing +Z; this turns their front towards (dx, dz). */
const faceTowards = (dx: number, dz: number) => Math.atan2(dx, dz);

const KIT_SCALE = 4.5;

export function createTrackside(
  track: TrackData,
  layout: TrackLayout,
  path: RacePath,
  models: Models,
  terrain: Terrain,
): Trackside {
  const reserved = new Set<string>();
  const occupied = layout.occupancy;
  const free = (x: number, z: number) =>
    !occupied.has(cellKey(x, z)) && !reserved.has(cellKey(x, z));
  const groundY = (x: number, z: number) => terrain.height(x, z);
  const lists = new Map<keyof Models, Placement[]>();
  const put = (model: keyof Models, p: Omit<Placement, "y">) => {
    let list = lists.get(model);
    if (!list) lists.set(model, (list = []));
    list.push({ ...p, y: groundY(p.x, p.z) });
  };
  const chevrons: { left: Placement[]; right: Placement[] } = { left: [], right: [] };

  // ── Start / finish: grandstands on one side, pit building on the other. ──
  const start = track.pieces[layout.startIndex];
  if (start) {
    const sides: { cell: [number, number]; out: [number, number] }[] = [];
    for (const side of [-1, 1]) {
      const [dx, dz] = rotateVec(side, 0, start.rot);
      sides.push({ cell: [start.x + dx, start.z + dz], out: [dx, dz] });
    }
    const [a, b] = sides;
    const standSide = a && free(...a.cell) ? a : b && free(...b.cell) ? b : null;
    if (standSide) {
      reserved.add(cellKey(...standSide.cell));
      const [ox, oz] = standSide.out;
      // Edge between the start cell and this one; stands sit a few units back from it.
      const along: [number, number] = [-oz, ox];
      const cx = standSide.cell[0] * CELL - ox * (CELL / 2 - 3);
      const cz = standSide.cell[1] * CELL - oz * (CELL / 2 - 3);
      const rot = faceTowards(-ox, -oz);
      put("grandStandCovered", {
        x: cx - along[0] * 2.3,
        z: cz - along[1] * 2.3,
        rot,
        scale: KIT_SCALE,
      });
      put("grandStand", { x: cx + along[0] * 2.3, z: cz + along[1] * 2.3, rot, scale: KIT_SCALE });
    }
    const pitSide = standSide === a ? b : a;
    if (pitSide && free(...pitSide.cell)) {
      reserved.add(cellKey(...pitSide.cell));
      const [ox, oz] = pitSide.out;
      const along: [number, number] = [-oz, ox];
      const cx = pitSide.cell[0] * CELL - ox * (CELL / 2 - 3.2);
      const cz = pitSide.cell[1] * CELL - oz * (CELL / 2 - 3.2);
      const rot = faceTowards(-ox, -oz);
      const row: (keyof Models)[] = ["pitsGarage", "pitsGarageClosed", "pitsOffice"];
      row.forEach((model, i) => {
        const o = (i - 1) * KIT_SCALE * 0.98;
        put(model, { x: cx + along[0] * o, z: cz + along[1] * o, rot, scale: KIT_SCALE });
      });
    }
  }

  // ── Everything else: per empty neighbour cell of each piece. ──
  track.pieces.forEach((piece, index) => {
    const def = PIECES[piece.type];
    // Chevrons mark single-arc corners (not chicanes, whose bends alternate).
    const seg = def.segments.length === 1 ? def.segments[0]! : null;
    const arcCenter = seg?.kind === "arc" ? toWorld(piece, seg.center) : null;
    const tight = seg?.kind === "arc" && seg.radius < CELL;
    const racePiece = path.byPiece.get(index);

    for (const [tx, tz] of footprintCells(piece)) {
      for (const d of [0, 1, 2, 3] as Dir[]) {
        const [dx, dz] = DIR_VEC[d];
        const ex = tx + dx;
        const ez = tz + dz;
        if (!free(ex, ez)) continue;
        const key = cellKey(ex, ez);
        // Point on the shared edge, and the inward normal (towards the track).
        const edgeX = (tx + dx * 0.5) * CELL;
        const edgeZ = (tz + dz * 0.5) * CELL;
        const nx = -dx;
        const nz = -dz;
        const along: [number, number] = [-nz, nx];
        const back = (dist: number): [number, number] => [edgeX - nx * dist, edgeZ - nz * dist];
        const roll = hash(ex, ez, 7);

        if (arcCenter && seg?.kind === "arc") {
          const outside = Math.hypot(ex * CELL - arcCenter.x, ez * CELL - arcCenter.z) > seg.radius;
          if (!outside) continue;
          if (roll < (tight ? 0.75 : 0.5)) {
            // Chevron boards: arrows point the way the road turns, seen from the board's front.
            const tangent = racePiece
              ? nearestTangent(racePiece, edgeX, edgeZ)
              : { x: along[0], z: along[1] };
            // Screen-right of a viewer looking at the board's front (front faces +n).
            const rightX = nz;
            const rightZ = -nx;
            const toRight = tangent.x * rightX + tangent.z * rightZ >= 0;
            const count = tight ? 1 : 2;
            for (let i = 0; i < count; i++) {
              const o = (i - (count - 1) / 2) * 3.4;
              const [x, z] = back(1.6);
              (toRight ? chevrons.right : chevrons.left).push({
                x: x + along[0] * o,
                y: groundY(x, z),
                z: z + along[1] * o,
                rot: Math.atan2(nx, nz),
                scale: 1,
              });
            }
            reserved.add(key);
          } else if (roll < 0.62) {
            const [x, z] = back(2);
            put(hash(ex, ez, 8) < 0.5 ? "bannerTowerRed" : "bannerTowerGreen", {
              x,
              z,
              rot: faceTowards(nx, nz),
              scale: 4,
            });
            reserved.add(key);
          } else if (roll < 0.72) {
            const [x, z] = back(1.4);
            put(hash(ex, ez, 9) < 0.5 ? "flagRed" : "flagGreen", {
              x,
              z,
              rot: faceTowards(nx, nz),
              scale: 3,
            });
          }
          continue;
        }

        // Beside a straight (or the start).
        if (roll < 0.26) {
          const model = hash(ex, ez, 10) < 0.6 ? "billboard" : "billboardLow";
          const [x, z] = back(2.4);
          const pair = hash(ex, ez, 11) < 0.5;
          for (const o of pair ? [-2.4, 2.4] : [0]) {
            put(model, {
              x: x + along[0] * o,
              z: z + along[1] * o,
              rot: faceTowards(nx, nz),
              scale: KIT_SCALE,
            });
          }
          reserved.add(key);
        } else if (roll < 0.44) {
          const [x, z] = back(1.3);
          put("lightPostLarge", { x, z, rot: faceTowards(nx, nz), scale: 6 });
        } else if (roll < 0.56) {
          const [x, z] = back(1.5);
          for (const o of [-KIT_SCALE / 2, KIT_SCALE / 2]) {
            put("fenceStraight", {
              x: x + along[0] * o,
              z: z + along[1] * o,
              rot: faceTowards(nx, nz),
              scale: KIT_SCALE,
            });
          }
        } else if (roll < 0.62) {
          const [x, z] = back(2);
          put("bannerTowerRed", { x, z, rot: faceTowards(nx, nz), scale: 4 });
          reserved.add(key);
        }
      }
    }
  });

  const group = new THREE.Group();
  group.name = "trackside";
  const owned = { geometries: [] as THREE.BufferGeometry[], meshes: [] as THREE.InstancedMesh[] };
  // Thin props (flags, chain-link fences) do not cast shadows: a fence net would cast a solid
  // block in the shadow map anyway, and each caster costs a draw call in the shadow pass.
  const NO_SHADOW = new Set<keyof Models>(["fenceStraight", "flagRed", "flagGreen"]);
  for (const [model, list] of lists)
    addInstances(group, models[model], list, owned, !NO_SHADOW.has(model));
  const disposeChevrons = buildChevrons(group, chevrons);

  return {
    group,
    reserved,
    dispose: () => {
      for (const g of owned.geometries) g.dispose();
      for (const m of owned.meshes) m.dispose();
      disposeChevrons();
    },
  };
}

function nearestTangent(p: RacePath["pieces"][number], x: number, z: number) {
  let best = Infinity;
  let t = p.tangents[0]!;
  p.points.forEach((pt, i) => {
    const d = (pt.x - x) ** 2 + (pt.z - z) ** 2;
    if (d < best) {
      best = d;
      t = p.tangents[i]!;
    }
  });
  return t;
}

function chevronTexture(pointRight: boolean) {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 96;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#d9483b";
  ctx.fillRect(0, 0, 256, 96);
  ctx.fillStyle = "#f4f2ec";
  for (let i = 0; i < 3; i++) {
    const x0 = 40 + i * 70;
    ctx.beginPath();
    ctx.moveTo(x0, 14);
    ctx.lineTo(x0 + 30, 48);
    ctx.lineTo(x0, 82);
    ctx.lineTo(x0 + 22, 82);
    ctx.lineTo(x0 + 52, 48);
    ctx.lineTo(x0 + 22, 14);
    ctx.closePath();
    ctx.fill();
  }
  ctx.strokeStyle = "#f4f2ec";
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, 250, 90);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  if (!pointRight) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.repeat.x = -1;
  }
  return tex;
}

/** Chevron boards on two posts; the printed face looks along local +Z. Returns a disposer. */
function buildChevrons(group: THREE.Group, sets: { left: Placement[]; right: Placement[] }) {
  // Plain box body plus a separate printed face: two single-material draws per variant instead
  // of six (one per box side).
  const boardGeo = new THREE.BoxGeometry(3, 1.1, 0.12).translate(0, 1.45, 0);
  const faceGeo = new THREE.PlaneGeometry(2.96, 1.06).translate(0, 1.45, 0.061);
  const postGeo = new THREE.BoxGeometry(0.12, 1.5, 0.12).translate(0, 0.75, -0.08);
  const postMat = new THREE.MeshStandardMaterial({ color: "#d9d6cf", roughness: 0.7 });
  const backMat = new THREE.MeshStandardMaterial({ color: "#3a3d44", roughness: 0.8 });
  const disposables: { dispose(): void }[] = [boardGeo, faceGeo, postGeo, postMat, backMat];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const one = new THREE.Vector3(1, 1, 1);
  const postMatrices: THREE.Matrix4[] = [];
  for (const [pointRight, list] of [
    [true, sets.right],
    [false, sets.left],
  ] as const) {
    if (list.length === 0) continue;
    const tex = chevronTexture(pointRight);
    const face = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55 });
    disposables.push(tex, face);
    const boards = new THREE.InstancedMesh(boardGeo, backMat, list.length);
    const faces = new THREE.InstancedMesh(faceGeo, face, list.length);
    list.forEach((p, i) => {
      q.setFromAxisAngle(up, p.rot);
      m.compose(new THREE.Vector3(p.x, p.y, p.z), q, one);
      boards.setMatrixAt(i, m);
      faces.setMatrixAt(i, m);
      const side = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
      for (const s of [-1.2, 1.2]) {
        postMatrices.push(
          new THREE.Matrix4().compose(
            new THREE.Vector3(p.x + side.x * s, p.y, p.z + side.z * s),
            q,
            one,
          ),
        );
      }
    });
    boards.castShadow = true;
    boards.receiveShadow = true;
    boards.computeBoundingSphere();
    faces.receiveShadow = true;
    faces.computeBoundingSphere();
    group.add(boards, faces);
    disposables.push(boards, faces);
  }
  if (postMatrices.length > 0) {
    const posts = new THREE.InstancedMesh(postGeo, postMat, postMatrices.length);
    postMatrices.forEach((pm, i) => posts.setMatrixAt(i, pm));
    posts.castShadow = true;
    posts.computeBoundingSphere();
    group.add(posts);
    disposables.push(posts);
  }
  return () => {
    for (const d of disposables) d.dispose();
  };
}
