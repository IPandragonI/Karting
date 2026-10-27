import * as THREE from "three";
import type { Models } from "../assets";
import type { WallSegment } from "../Physics";
import { LEVEL_HEIGHT, PIECES, ROAD_HALF, TIRE_RADIUS, WALL_OFFSET, type Vec2 } from "./pieces";
import {
  cellKey,
  DECK_DEPTH,
  footprintCells,
  pieceCenterline,
  pieceLevel,
  toWorld,
  type PieceData,
  type TrackData,
  type TrackLayout,
} from "./Track";
import { DECK_EDGE, overRoadMask, right, trackWalls } from "./walls";

// Builds the visible track and the list of wall colliders from track data. Road and kerbs of all
// pieces are merged into one geometry each, tire walls are a single InstancedMesh, so a whole
// circuit costs a handful of draw calls. Every vertex, tire stack and collider takes its height
// from the piece's centerline profile (the same one the kart drives on); raised road sits on a
// deck with retaining walls down to the ground.

const VERGE_Y = 0.006;
const ROAD_Y = 0.012;
const LINE_Y = 0.02;
const KERB_Y = 0.028;

const COLORS = {
  asphalt: new THREE.Color("#5b5f68"),
  asphaltEdge: new THREE.Color("#4c5058"),
  line: new THREE.Color("#f2f0ea"),
  kerbRed: new THREE.Color("#d9483b"),
  kerbWhite: new THREE.Color("#f2efe6"),
  tire: new THREE.Color("#34373d"),
  tireRed: new THREE.Color("#c9443a"),
  tireWhite: new THREE.Color("#e8e6df"),
  verge: new THREE.Color("#78b850"),
  vergeDark: new THREE.Color("#4b7d34"),
  bank: new THREE.Color("#a49c8c"),
  bankDark: new THREE.Color("#6f6a60"),
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

/**
 * Adds a strip that follows the centerline between lateral offsets `o0` and `o1`.
 * `color(i, u)` picks the colour per vertex (i = sample index, u = 0 near / 1 far edge).
 */
function strip(
  mb: MeshBuilder,
  points: Vec2[],
  tangents: Vec2[],
  heights: number[],
  o0: number,
  o1: number,
  y: number,
  color: (i: number, side: 0 | 1, x: number, z: number) => THREE.Color,
) {
  let prev: [number, number] | null = null;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const n = right(tangents[i]!);
    const h = heights[i]! + y;
    const ax = p.x + n.x * o0;
    const az = p.z + n.z * o0;
    const bx = p.x + n.x * o1;
    const bz = p.z + n.z * o1;
    const a = mb.vertex(ax, h, az, color(i, 0, ax, az));
    const b = mb.vertex(bx, h, bz, color(i, 1, bx, bz));
    // Winding depends on which side is "left"; keep faces pointing up either way.
    if (prev) {
      if (o1 > o0) mb.quad(prev[1], prev[0], b, a);
      else mb.quad(prev[0], prev[1], a, b);
    }
    prev = [a, b];
  }
}

/** Kerb stripes: separate quads so each stripe has a flat colour. */
function kerb(
  mb: MeshBuilder,
  points: Vec2[],
  tangents: Vec2[],
  heights: number[],
  o0: number,
  o1: number,
) {
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
    const y0 = heights[i - 1]! + KERB_Y;
    const y1 = heights[i]! + KERB_Y;
    const a = mb.vertex(p0.x + n0.x * o0, y0, p0.z + n0.z * o0, c);
    const b = mb.vertex(p0.x + n0.x * o1, y0, p0.z + n0.z * o1, c);
    const d = mb.vertex(p1.x + n1.x * o0, y1, p1.z + n1.z * o0, c);
    const e = mb.vertex(p1.x + n1.x * o1, y1, p1.z + n1.z * o1, c);
    if (o1 > o0) mb.quad(b, a, e, d);
    else mb.quad(a, b, d, e);
  }
}

export type BuiltTrack = {
  group: THREE.Group;
  walls: WallSegment[];
  /** Start gantry lights, index 0..4, for the countdown. */
  lights: THREE.Mesh[];
  /** Swaps tire-wall batches between detailed and low-poly versions by distance. */
  updateLod: (camera: THREE.Vector3) => void;
  dispose: () => void;
};

/** Beyond this distance (from the batch's bounding sphere) tire walls use the low-poly stack. */
const TIRE_LOD_DISTANCE = 45;

const sharedTire: Record<"hi" | "lo", THREE.BufferGeometry | null> = { hi: null, lo: null };
/**
 * Three stacked tires lying flat. Detailed: 5 × 10 segments, round up close (300 triangles).
 * Low: 3 × 7 segments (126 triangles), indistinguishable at a distance. The walls line the whole
 * circuit (~1 100 stacks), which made them the largest share of the GPU's vertex work.
 */
function tireStackGeometry(detail: "hi" | "lo") {
  const cached = sharedTire[detail];
  if (cached) return cached;
  const t =
    detail === "hi"
      ? new THREE.TorusGeometry(TIRE_RADIUS - 0.1, 0.1, 5, 10)
      : new THREE.TorusGeometry(TIRE_RADIUS - 0.1, 0.1, 3, 7);
  t.rotateX(Math.PI / 2);
  const a = t.clone().translate(0, 0.1, 0);
  const b = t.clone().translate(0, 0.3, 0);
  const c = t.clone().translate(0, 0.5, 0);
  const merged = mergeGeometries([a, b, c]);
  t.dispose();
  a.dispose();
  b.dispose();
  c.dispose();
  sharedTire[detail] = merged;
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
  // Colliders come from the shared pure builder (the simulation uses the same one).
  const walls: WallSegment[] = trackWalls(track, layout);
  const lights: THREE.Mesh[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];

  const road = new MeshBuilder();
  const marks = new MeshBuilder();
  const verge = new MeshBuilder();
  const bank = new MeshBuilder();
  type Stack = { x: number; y: number; z: number; color: THREE.Color };
  // Tire walls are batched per few consecutive pieces: one InstancedMesh for the whole circuit is
  // never culled, one per piece costs a draw call (twice, with the shadow pass) for each.
  const PIECES_PER_WALL_BATCH = 4;
  const stackChunks: Stack[][] = [];
  let stacks: Stack[] = [];

  for (const [pieceIndex, piece] of track.pieces.entries()) {
    const def = PIECES[piece.type];
    const { points, tangents, heights } = pieceCenterline(piece, 1);
    if (pieceIndex % PIECES_PER_WALL_BATCH === 0) stackChunks.push((stacks = []));

    // Grass verge between the road and the tire walls, darkening towards the wall: it outlines
    // the circuit from above and fakes the ambient occlusion at the foot of the barrier.
    for (const side of [-1, 1]) {
      const inner = side * (ROAD_HALF - 0.1);
      const outer = side * (WALL_OFFSET + 0.55);
      strip(verge, points, tangents, heights, inner, outer, VERGE_Y, (_i, s, x, z) =>
        (s === 0 ? COLORS.verge : COLORS.vergeDark)
          .clone()
          .multiplyScalar(0.97 + hash2(x, z) * 0.06),
      );
    }

    // Asphalt: darker towards the edges, with a faint per-vertex mottling.
    const offsets = [-ROAD_HALF, -ROAD_HALF + 0.7, 0, ROAD_HALF - 0.7, ROAD_HALF];
    for (let k = 0; k < offsets.length - 1; k++) {
      strip(
        road,
        points,
        tangents,
        heights,
        offsets[k]!,
        offsets[k + 1]!,
        ROAD_Y,
        (_i, side, x, z) => {
          const o = side === 0 ? offsets[k]! : offsets[k + 1]!;
          const base = Math.abs(o) >= ROAD_HALF ? COLORS.asphaltEdge : COLORS.asphalt;
          return base.clone().multiplyScalar(0.96 + hash2(x, z) * 0.08);
        },
      );
    }

    if (def.kerbs) {
      kerb(marks, points, tangents, heights, -ROAD_HALF - 0.35, -ROAD_HALF + 0.55);
      kerb(marks, points, tangents, heights, ROAD_HALF - 0.55, ROAD_HALF + 0.35);
    } else {
      strip(
        marks,
        points,
        tangents,
        heights,
        -ROAD_HALF + 0.25,
        -ROAD_HALF + 0.5,
        LINE_Y,
        () => COLORS.line,
      );
      strip(
        marks,
        points,
        tangents,
        heights,
        ROAD_HALF - 0.5,
        ROAD_HALF - 0.25,
        LINE_Y,
        () => COLORS.line,
      );
    }

    // Tire walls on both sides, along the same polylines as their colliders (walls.ts).
    for (const side of [-1, 1]) {
      const o = side * WALL_OFFSET;
      const wall = points.map((p, i) => {
        const n = right(tangents[i]!);
        return { x: p.x + n.x * o, y: heights[i]!, z: p.z + n.z * o };
      });
      placeStacks(wall, def.kerbs, stacks);
    }

    // Raised road: retaining walls from the deck edge down to the ground on both sides. Where it
    // passes over another road (a lower piece in the same cell) it becomes a bridge: a thin deck
    // with a short skirt and an underside, no wall (nor wall collider) blocking the road below.
    if (heights.some((h) => h > 0.01)) {
      const overRoad = overRoadMask(track, layout, pieceIndex, points);
      for (const side of [-1, 1]) {
        const o = side * DECK_EDGE;
        let prev: [number, number] | null = null;
        for (let i = 0; i < points.length; i++) {
          const p = points[i]!;
          const n = right(tangents[i]!);
          const x = p.x + n.x * o;
          const z = p.z + n.z * o;
          const bridge = overRoad[i]!;
          const top = bank.vertex(x, heights[i]! + VERGE_Y, z, COLORS.bank);
          const bottomY = bridge ? heights[i]! - DECK_DEPTH : -0.05;
          const bottom = bank.vertex(x, bottomY, z, bridge ? COLORS.bank : COLORS.bankDark);
          if (prev) {
            if (side > 0) bank.quad(prev[0], top, prev[1], bottom);
            else bank.quad(top, prev[0], bottom, prev[1]);
          }
          prev = [top, bottom];
        }
      }
      // Bridge underside, seen from the road below.
      let prevUnder: [number, number] | null = null;
      for (let i = 0; i < points.length; i++) {
        if (!overRoad[i] && !overRoad[i - 1] && !overRoad[i + 1]) {
          prevUnder = null;
          continue;
        }
        const p = points[i]!;
        const n = right(tangents[i]!);
        const y = heights[i]! - DECK_DEPTH;
        const a = bank.vertex(p.x - n.x * DECK_EDGE, y, p.z - n.z * DECK_EDGE, COLORS.bankDark);
        const b = bank.vertex(p.x + n.x * DECK_EDGE, y, p.z + n.z * DECK_EDGE, COLORS.bankDark);
        if (prevUnder) bank.quad(prevUnder[0], prevUnder[1], a, b);
        prevUnder = [a, b];
      }
    }

    if (piece.type === "start") buildStart(piece, group, lights, geometries, materials, models);
  }

  if (bank.positions.length > 0) {
    // Double-sided: the walls are seen from outside, and from the deck when looking over it.
    const bankMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    const bankGeo = bank.build();
    const bankMesh = new THREE.Mesh(bankGeo, bankMat);
    bankMesh.receiveShadow = true;
    bankMesh.castShadow = true;
    group.add(bankMesh);
    geometries.push(bankGeo);
    materials.push(bankMat);
  }

  const vergeMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const vergeGeo = verge.build();
  const vergeMesh = new THREE.Mesh(vergeGeo, vergeMat);
  vergeMesh.receiveShadow = true;
  group.add(vergeMesh);
  geometries.push(vergeGeo);
  materials.push(vergeMat);

  // Standard materials: the low sun gives the asphalt and kerbs a soft sheen.
  const roadMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.86,
    metalness: 0,
  });
  const roadGeo = road.build();
  const roadMesh = new THREE.Mesh(roadGeo, roadMat);
  roadMesh.receiveShadow = true;
  group.add(roadMesh);

  const marksMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.6,
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

  const tireMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
  materials.push(tireMat);
  const m = new THREE.Matrix4();
  const lods: {
    hi: THREE.InstancedMesh;
    lo: THREE.InstancedMesh;
    center: THREE.Vector3;
    radius: number;
  }[] = [];
  for (const stacks of stackChunks) {
    if (stacks.length === 0) continue;
    const makeWall = (detail: "hi" | "lo") => {
      const tires = new THREE.InstancedMesh(tireStackGeometry(detail), tireMat, stacks.length);
      stacks.forEach((s, i) => {
        m.makeRotationY(hash2(s.x, s.z) * Math.PI);
        m.setPosition(s.x, s.y, s.z);
        tires.setMatrixAt(i, m);
        tires.setColorAt(i, s.color);
      });
      tires.castShadow = true;
      tires.receiveShadow = true;
      tires.computeBoundingSphere();
      group.add(tires);
      return tires;
    };
    const hi = makeWall("hi");
    const lo = makeWall("lo");
    lo.visible = false;
    lods.push({
      hi,
      lo,
      center: hi.boundingSphere!.center.clone(),
      radius: hi.boundingSphere!.radius,
    });
  }

  return {
    group,
    walls,
    lights,
    updateLod: (camera) => {
      for (const l of lods) {
        const near = camera.distanceTo(l.center) - l.radius < TIRE_LOD_DISTANCE;
        l.hi.visible = near;
        l.lo.visible = !near;
      }
    },
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
  wall: { x: number; y: number; z: number }[],
  painted: boolean,
  out: { x: number; y: number; z: number; color: THREE.Color }[],
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
      out.push({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z: a.z + (b.z - a.z) * t,
        color,
      });
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

/** Start/finish dressing: checkered line, grid boxes, light gantry and flags. */
function buildStart(
  piece: PieceData,
  group: THREE.Group,
  lights: THREE.Mesh[],
  geometries: THREE.BufferGeometry[],
  materials: THREE.Material[],
  models: Models | null,
) {
  const root = new THREE.Group();
  const c = toWorld(piece, { x: 0, z: 0 });
  root.position.set(c.x, pieceLevel(piece) * LEVEL_HEIGHT, c.z);
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
  // Checkered flags on both sides of the line (grandstands and pits live in Trackside.ts).
  for (const x of [-WALL_OFFSET - 0.8, WALL_OFFSET + 0.8]) {
    const flag = models.flagCheckers.clone();
    flag.scale.setScalar(3);
    flag.position.set(x, 0, -0.6);
    root.add(flag);
  }
}

/** Cells used by pieces, as a set, for scenery placement. */
export function occupiedCells(track: TrackData): Set<string> {
  const s = new Set<string>();
  for (const p of track.pieces) for (const [x, z] of footprintCells(p)) s.add(cellKey(x, z));
  return s;
}
