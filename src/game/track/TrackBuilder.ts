import * as THREE from "three";
import type { Models } from "../assets";
import type { WallSegment } from "../Physics";
import { CELL, PIECES, ROAD_HALF, TIRE_RADIUS, WALL_OFFSET, type Vec2 } from "./pieces";
import {
  cellKey,
  footprintCells,
  pieceCenterline,
  toWorld,
  type PieceData,
  type TrackData,
  type TrackLayout,
} from "./Track";

// Builds the visible track and the list of wall colliders from track data. Road and kerbs of all
// pieces are merged into one geometry each, tire walls are a single InstancedMesh, so a whole
// circuit costs a handful of draw calls.

const ROAD_Y = 0.012;
const LINE_Y = 0.02;
const KERB_Y = 0.028;

const COLORS = {
  asphalt: new THREE.Color("#5b5f68"),
  asphaltEdge: new THREE.Color("#4c5058"),
  line: new THREE.Color("#f2f0ea"),
  kerbRed: new THREE.Color("#d9483b"),
  kerbWhite: new THREE.Color("#f2efe6"),
  tire: new THREE.Color("#2a2c31"),
  tireRed: new THREE.Color("#c9443a"),
  tireWhite: new THREE.Color("#e8e6df"),
};

/** Deterministic 0..1 hash of a 2D point, for tiny colour variations. */
function hash2(x: number, z: number) {
  const h = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return h - Math.floor(h);
}

class MeshBuilder {
  positions: number[] = [];
  colors: number[] = [];
  indices: number[] = [];

  vertex(x: number, y: number, z: number, c: THREE.Color, shade = 1) {
    this.positions.push(x, y, z);
    this.colors.push(c.r * shade, c.g * shade, c.b * shade);
    return this.positions.length / 3 - 1;
  }

  quad(a: number, b: number, c: number, d: number) {
    // a-b on the near row, c-d on the far row; counter-clockwise seen from +Y.
    this.indices.push(a, c, b, b, c, d);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.positions, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.colors, 3));
    g.setIndex(this.indices);
    g.computeVertexNormals();
    return g;
  }
}

/** Right-hand normal of a tangent (matches the kart's right vector). */
const right = (t: Vec2): Vec2 => ({ x: -t.z, z: t.x });

/**
 * Adds a strip that follows the centerline between lateral offsets `o0` and `o1`.
 * `color(i, u)` picks the colour per vertex (i = sample index, u = 0 near / 1 far edge).
 */
function strip(
  mb: MeshBuilder,
  points: Vec2[],
  tangents: Vec2[],
  o0: number,
  o1: number,
  y: number,
  color: (i: number, side: 0 | 1, x: number, z: number) => THREE.Color,
) {
  let prev: [number, number] | null = null;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const n = right(tangents[i]!);
    const ax = p.x + n.x * o0;
    const az = p.z + n.z * o0;
    const bx = p.x + n.x * o1;
    const bz = p.z + n.z * o1;
    const a = mb.vertex(ax, y, az, color(i, 0, ax, az));
    const b = mb.vertex(bx, y, bz, color(i, 1, bx, bz));
    // Winding depends on which side is "left"; keep faces pointing up either way.
    if (prev) {
      if (o1 > o0) mb.quad(prev[1], prev[0], b, a);
      else mb.quad(prev[0], prev[1], a, b);
    }
    prev = [a, b];
  }
}

/** Kerb stripes: separate quads so each stripe has a flat colour. */
function kerb(mb: MeshBuilder, points: Vec2[], tangents: Vec2[], o0: number, o1: number) {
  const offset = (o0 + o1) / 2;
  let along = 0;
  for (let i = 1; i < points.length; i++) {
    const p0 = points[i - 1]!;
    const p1 = points[i]!;
    const n0 = right(tangents[i - 1]!);
    const n1 = right(tangents[i]!);
    const segLen = Math.hypot(
      p1.x + n1.x * offset - (p0.x + n0.x * offset),
      p1.z + n1.z * offset - (p0.z + n0.z * offset),
    );
    const c = Math.floor((along + segLen / 2) / 1.1) % 2 === 0 ? COLORS.kerbRed : COLORS.kerbWhite;
    along += segLen;
    const a = mb.vertex(p0.x + n0.x * o0, KERB_Y, p0.z + n0.z * o0, c);
    const b = mb.vertex(p0.x + n0.x * o1, KERB_Y, p0.z + n0.z * o1, c);
    const d = mb.vertex(p1.x + n1.x * o0, KERB_Y, p1.z + n1.z * o0, c);
    const e = mb.vertex(p1.x + n1.x * o1, KERB_Y, p1.z + n1.z * o1, c);
    if (o1 > o0) mb.quad(b, a, e, d);
    else mb.quad(a, b, d, e);
  }
}

export type BuiltTrack = {
  group: THREE.Group;
  walls: WallSegment[];
  /** Start gantry lights, index 0..4, for the countdown. */
  lights: THREE.Mesh[];
  dispose: () => void;
};

let sharedTire: THREE.BufferGeometry | null = null;
function tireStackGeometry() {
  if (sharedTire) return sharedTire;
  // Two stacked low-poly tires, lying flat.
  const t = new THREE.TorusGeometry(TIRE_RADIUS - 0.1, 0.1, 5, 9);
  t.rotateX(Math.PI / 2);
  const a = t.clone().translate(0, 0.1, 0);
  const b = t.clone().translate(0, 0.3, 0);
  const c = t.clone().translate(0, 0.5, 0);
  const merged = mergeGeometries([a, b, c]);
  t.dispose();
  a.dispose();
  b.dispose();
  c.dispose();
  sharedTire = merged;
  return merged;
}

function mergeGeometries(list: THREE.BufferGeometry[]) {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  let offset = 0;
  for (const g of list) {
    const pos = g.getAttribute("position");
    const nor = g.getAttribute("normal");
    for (let i = 0; i < pos.count; i++) {
      positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      normals.push(nor.getX(i), nor.getY(i), nor.getZ(i));
    }
    const idx = g.index!;
    for (let i = 0; i < idx.count; i++) indices.push(idx.getX(i) + offset);
    offset += pos.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  out.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  out.setIndex(indices);
  return out;
}

let checkerTexture: THREE.CanvasTexture | null = null;
function finishLineTexture() {
  if (checkerTexture) return checkerTexture;
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 16;
  const ctx = canvas.getContext("2d")!;
  for (let x = 0; x < 16; x++) {
    for (let y = 0; y < 2; y++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? "#f4f2ec" : "#25272c";
      ctx.fillRect(x * 8, y * 8, 8, 8);
    }
  }
  checkerTexture = new THREE.CanvasTexture(canvas);
  checkerTexture.magFilter = THREE.NearestFilter;
  checkerTexture.colorSpace = THREE.SRGBColorSpace;
  return checkerTexture;
}

export function buildTrack(
  track: TrackData,
  layout: TrackLayout,
  models: Models | null,
): BuiltTrack {
  const group = new THREE.Group();
  group.name = "track";
  const walls: WallSegment[] = [];
  const lights: THREE.Mesh[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];

  const road = new MeshBuilder();
  const marks = new MeshBuilder();
  type Stack = { x: number; z: number; color: THREE.Color };
  const stacks: Stack[] = [];

  for (const piece of track.pieces) {
    const def = PIECES[piece.type];
    const { points, tangents } = pieceCenterline(piece, 1);

    // Asphalt: darker towards the edges, with a faint per-vertex mottling.
    const offsets = [-ROAD_HALF, -ROAD_HALF + 0.7, 0, ROAD_HALF - 0.7, ROAD_HALF];
    for (let k = 0; k < offsets.length - 1; k++) {
      strip(road, points, tangents, offsets[k]!, offsets[k + 1]!, ROAD_Y, (_i, side, x, z) => {
        const o = side === 0 ? offsets[k]! : offsets[k + 1]!;
        const base = Math.abs(o) >= ROAD_HALF ? COLORS.asphaltEdge : COLORS.asphalt;
        return base.clone().multiplyScalar(0.96 + hash2(x, z) * 0.08);
      });
    }

    if (def.kerbs) {
      kerb(marks, points, tangents, -ROAD_HALF - 0.35, -ROAD_HALF + 0.55);
      kerb(marks, points, tangents, ROAD_HALF - 0.55, ROAD_HALF + 0.35);
    } else {
      strip(
        marks,
        points,
        tangents,
        -ROAD_HALF + 0.25,
        -ROAD_HALF + 0.5,
        LINE_Y,
        () => COLORS.line,
      );
      strip(marks, points, tangents, ROAD_HALF - 0.5, ROAD_HALF - 0.25, LINE_Y, () => COLORS.line);
    }

    // Tire walls on both sides. Colliders follow the same polyline (coarser on straights).
    for (const side of [-1, 1]) {
      const o = side * WALL_OFFSET;
      const wall = points.map((p, i) => {
        const n = right(tangents[i]!);
        return { x: p.x + n.x * o, z: p.z + n.z * o };
      });
      const colliderStep = def.segment.kind === "line" ? wall.length - 1 : 2;
      for (let i = 0; i < wall.length - 1; i += colliderStep) {
        const a = wall[i]!;
        const b = wall[Math.min(i + colliderStep, wall.length - 1)]!;
        walls.push({ x1: a.x, z1: a.z, x2: b.x, z2: b.z });
      }
      placeStacks(wall, def.kerbs, stacks);
    }

    if (piece.type === "start")
      buildStart(piece, group, lights, geometries, materials, models, layout);
  }

  const roadMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const roadGeo = road.build();
  const roadMesh = new THREE.Mesh(roadGeo, roadMat);
  roadMesh.receiveShadow = true;
  group.add(roadMesh);

  const marksMat = new THREE.MeshLambertMaterial({
    vertexColors: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const marksGeo = marks.build();
  const marksMesh = new THREE.Mesh(marksGeo, marksMat);
  marksMesh.receiveShadow = true;
  group.add(marksMesh);
  geometries.push(roadGeo, marksGeo);
  materials.push(roadMat, marksMat);

  if (stacks.length > 0) {
    const tireMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const tires = new THREE.InstancedMesh(tireStackGeometry(), tireMat, stacks.length);
    const m = new THREE.Matrix4();
    stacks.forEach((s, i) => {
      m.makeRotationY(hash2(s.x, s.z) * Math.PI);
      m.setPosition(s.x, 0, s.z);
      tires.setMatrixAt(i, m);
      tires.setColorAt(i, s.color);
    });
    tires.castShadow = true;
    tires.receiveShadow = true;
    tires.computeBoundingSphere();
    group.add(tires);
    materials.push(tireMat);
  }

  return {
    group,
    walls,
    lights,
    dispose: () => {
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      group.traverse((o) => {
        if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
      });
    },
  };
}

function placeStacks(
  wall: Vec2[],
  painted: boolean,
  out: { x: number; z: number; color: THREE.Color }[],
) {
  const spacing = TIRE_RADIUS * 2 + 0.02;
  let carry = 0;
  let n = 0;
  for (let i = 1; i < wall.length; i++) {
    const a = wall[i - 1]!;
    const b = wall[i]!;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    let d = carry;
    while (d < len) {
      const t = d / len;
      const color = painted
        ? n % 2 === 0
          ? COLORS.tireRed
          : COLORS.tireWhite
        : n % 6 === 0
          ? COLORS.tireWhite
          : COLORS.tire;
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, color });
      n++;
      d += spacing;
    }
    carry = d - len;
  }
}

const gantryMaterials = {
  post: new THREE.MeshLambertMaterial({ color: "#e8e6df" }),
  beam: new THREE.MeshLambertMaterial({ color: "#2f3238" }),
};

/** Start/finish dressing: checkered line, grid boxes, light gantry, flags and a grandstand. */
function buildStart(
  piece: PieceData,
  group: THREE.Group,
  lights: THREE.Mesh[],
  geometries: THREE.BufferGeometry[],
  materials: THREE.Material[],
  models: Models | null,
  layout: TrackLayout,
) {
  const root = new THREE.Group();
  const c = toWorld(piece, { x: 0, z: 0 });
  root.position.set(c.x, 0, c.z);
  root.rotation.y = (piece.rot * Math.PI) / 2;
  group.add(root);

  const lineGeo = new THREE.PlaneGeometry(ROAD_HALF * 2, 1).rotateX(-Math.PI / 2);
  const lineMat = new THREE.MeshLambertMaterial({
    map: finishLineTexture(),
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  });
  const line = new THREE.Mesh(lineGeo, lineMat);
  line.position.y = LINE_Y + 0.004;
  line.receiveShadow = true;
  root.add(line);
  geometries.push(lineGeo);
  materials.push(lineMat);

  // Grid boxes: open brackets behind the line.
  const slotMat = new THREE.MeshLambertMaterial({
    color: COLORS.line,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
  const barGeo = new THREE.PlaneGeometry(1.6, 0.18).rotateX(-Math.PI / 2);
  const sideGeo = new THREE.PlaneGeometry(0.18, 1.2).rotateX(-Math.PI / 2);
  geometries.push(barGeo, sideGeo);
  materials.push(slotMat);
  for (const [x, z] of [
    [-1.6, -2.2],
    [1.6, -4.4],
  ] as const) {
    const bar = new THREE.Mesh(barGeo, slotMat);
    bar.position.set(x, LINE_Y, z);
    root.add(bar);
    for (const sx of [-0.71, 0.71]) {
      const s = new THREE.Mesh(sideGeo, slotMat);
      s.position.set(x + sx, LINE_Y, z - 0.5);
      root.add(s);
    }
  }

  // Gantry over the line with five lights facing the grid (−Z local).
  const postGeo = new THREE.BoxGeometry(0.3, 4.2, 0.3);
  const beamGeo = new THREE.BoxGeometry(WALL_OFFSET * 2 + 0.3, 0.7, 0.4);
  const lightGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.12, 12).rotateX(Math.PI / 2);
  geometries.push(postGeo, beamGeo, lightGeo);
  for (const x of [-WALL_OFFSET, WALL_OFFSET]) {
    const post = new THREE.Mesh(postGeo, gantryMaterials.post);
    post.position.set(x, 2.1, 0.6);
    post.castShadow = true;
    root.add(post);
  }
  const beam = new THREE.Mesh(beamGeo, gantryMaterials.beam);
  beam.position.set(0, 4.2, 0.6);
  beam.castShadow = true;
  root.add(beam);
  for (let i = 0; i < 5; i++) {
    const mat = new THREE.MeshStandardMaterial({
      color: "#3a1512",
      emissive: "#000000",
      roughness: 0.4,
    });
    materials.push(mat);
    const light = new THREE.Mesh(lightGeo, mat);
    light.position.set((i - 2) * 0.62, 4.2, 0.35);
    root.add(light);
    lights.push(light);
  }

  if (!models) return;
  // Flags on both sides of the line, a grandstand on a free neighbouring cell.
  for (const x of [-WALL_OFFSET - 0.8, WALL_OFFSET + 0.8]) {
    const flag = models.flagCheckers.clone();
    flag.scale.setScalar(3);
    flag.position.set(x, 0, -0.6);
    root.add(flag);
  }
  for (const side of [-1, 1]) {
    const [dx, dz] = rotateCell(side, piece.rot);
    if (layout.occupancy.has(cellKey(piece.x + dx, piece.z + dz))) continue;
    const stand = models.grandStand.clone();
    stand.scale.setScalar(4.5);
    // Seats face the track; keep the whole stand in the neighbouring cell, clear of the wall.
    stand.position.set(side * (CELL / 2 + 3.2), 0, 0);
    stand.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
    root.add(stand);
    break;
  }
}

function rotateCell(side: number, rot: number): [number, number] {
  // Local ±X neighbour of the start cell, rotated into world space.
  switch (rot) {
    case 0:
      return [side, 0];
    case 1:
      return [0, -side];
    case 2:
      return [-side, 0];
    default:
      return [0, side];
  }
}

/** Cells used by pieces, as a set, for scenery placement. */
export function occupiedCells(track: TrackData): Set<string> {
  const s = new Set<string>();
  for (const p of track.pieces) for (const [x, z] of footprintCells(p)) s.add(cellKey(x, z));
  return s;
}
