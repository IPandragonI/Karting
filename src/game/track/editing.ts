import {
  CELL,
  DIR_VEC,
  MAX_LEVEL,
  PIECES,
  rotateDir,
  type PieceType,
  type PropType,
  type Rot,
} from "./pieces";
import {
  cellKey,
  cloneTrack,
  footprintCells,
  GRID_LIMIT,
  MAX_PIECES,
  MAX_PROPS,
  levelRange,
  levelsClear,
  pieceLevel,
  worldConnectors,
  type PieceData,
  type TrackData,
} from "./Track";

// Pure editing operations used by the editor UI. Each returns a new TrackData (never mutates)
// or a human-readable reason why the edit is not allowed.

export type EditResult =
  { ok: true; track: TrackData; note?: string } | { ok: false; reason: string };

/** Pieces that look the same mirrored: their flip flag means nothing and is kept off. */
const SYMMETRIC = new Set<PieceType>(["straight", "start", "ramp", "longRamp"]);

export type PlaceOptions = {
  /** Elevation level at connector A. */
  y?: number;
  /** Mirrored left ↔ right. */
  flip?: boolean;
};

/** A piece with canonical optional fields (absent when 0 / false), so equal pieces compare equal. */
export function makePiece(
  type: PieceType,
  x: number,
  z: number,
  rot: Rot,
  opts: PlaceOptions = {},
): PieceData {
  const piece: PieceData = { type, x, z, rot };
  if (opts.y) piece.y = opts.y;
  if (opts.flip && !SYMMETRIC.has(type)) piece.flip = true;
  return piece;
}

/** Indices of every piece covering a cell (several where roads pass over each other). */
export function piecesAt(track: TrackData, cx: number, cz: number): number[] {
  const key = cellKey(cx, cz);
  const out: number[] = [];
  track.pieces.forEach((p, i) => {
    if (footprintCells(p).some(([x, z]) => cellKey(x, z) === key)) out.push(i);
  });
  return out;
}

/** How far a piece's levels are from `level` (0 when it spans it). */
function levelDistance(p: PieceData, level: number): number {
  const [lo, hi] = levelRange(p);
  return level < lo ? lo - level : level > hi ? level - hi : 0;
}

/**
 * The piece covering a cell, or −1. Where several share the cell, the one at (or nearest to)
 * `level`, the editor's working level; without it, the top one.
 */
export function pieceAt(track: TrackData, cx: number, cz: number, level?: number): number {
  let best = -1;
  for (const i of piecesAt(track, cx, cz)) {
    const p = track.pieces[i]!;
    if (best < 0) {
      best = i;
      continue;
    }
    const b = track.pieces[best]!;
    if (level === undefined) {
      if (levelRange(p)[1] > levelRange(b)[1]) best = i;
    } else if (levelDistance(p, level) < levelDistance(b, level)) {
      best = i;
    }
  }
  return best;
}

export function checkPiecePlacement(
  track: TrackData,
  piece: PieceData,
): { ok: true; replaces: number | null } | { ok: false; reason: string } {
  const cells = footprintCells(piece);
  if (cells.some(([x, z]) => Math.abs(x) > GRID_LIMIT || Math.abs(z) > GRID_LIMIT)) {
    return { ok: false, reason: "Outside the build area" };
  }
  // Only pieces too close vertically are in the way; a road a full level above or below can
  // share the cells (bridges, overpasses).
  const hit = new Set<number>();
  for (const [x, z] of cells) {
    for (const i of piecesAt(track, x, z)) if (!levelsClear(track.pieces[i]!, piece)) hit.add(i);
  }
  if (hit.size > 1) return { ok: false, reason: "Overlaps several pieces (erase them first)" };
  const level = pieceLevel(piece);
  if (level < 0 || level + PIECES[piece.type].rise > MAX_LEVEL) {
    return { ok: false, reason: `Too high (top level is ${MAX_LEVEL})` };
  }
  const replaces = hit.size === 1 ? [...hit][0]! : null;
  if (replaces !== null) {
    const old = track.pieces[replaces]!;
    if (
      old.type === piece.type &&
      old.rot === piece.rot &&
      old.x === piece.x &&
      old.z === piece.z &&
      pieceLevel(old) === level &&
      !!old.flip === !!piece.flip
    ) {
      return { ok: false, reason: "Same piece already here" };
    }
  }
  if (replaces === null && track.pieces.length >= MAX_PIECES) {
    return { ok: false, reason: `Track is full (${MAX_PIECES} pieces)` };
  }
  return { ok: true, replaces };
}

export function placePiece(
  track: TrackData,
  type: PieceType,
  x: number,
  z: number,
  rot: Rot,
  opts: PlaceOptions = {},
): EditResult {
  const piece = makePiece(type, x, z, rot, opts);
  const check = checkPiecePlacement(track, piece);
  if (!check.ok) return check;
  const next = cloneTrack(track);
  let note: string | undefined;
  if (check.replaces !== null) {
    note = "Replaced a piece";
    next.pieces.splice(check.replaces, 1);
  }
  // Only one start line: placing a new one moves it.
  if (type === "start") {
    const existing = next.pieces.findIndex((p) => p.type === "start");
    if (existing >= 0) {
      next.pieces.splice(existing, 1);
      note = "Start line moved";
    }
  }
  next.pieces.push(piece);
  return { ok: true, track: next, note };
}

export function erasePieceAt(track: TrackData, cx: number, cz: number, level?: number): EditResult {
  const i = pieceAt(track, cx, cz, level);
  if (i < 0) return { ok: false, reason: "Nothing to erase here" };
  const next = cloneTrack(track);
  next.pieces.splice(i, 1);
  return { ok: true, track: next };
}

/**
 * Level at which a new piece joins the road next to it: any neighbour end facing one of its two
 * ends proposes a level; where roads at several levels face it (under and over a bridge), the
 * one closest to `prefer` (the editor's working level) wins. Null when it touches no road (the
 * editor's chosen level applies).
 */
export function autoLevel(track: TrackData, piece: PieceData, prefer = 0): number | null {
  const rise = PIECES[piece.type].rise;
  const own = worldConnectors({ ...piece, y: 0 });
  let best: number | null = null;
  for (const k of [0, 1] as const) {
    const c = own[k];
    const [dx, dz] = DIR_VEC[c.dir];
    const nx = c.cell[0] + dx;
    const nz = c.cell[1] + dz;
    const opposite = rotateDir(c.dir, 2);
    for (const i of piecesAt(track, nx, nz)) {
      for (const o of worldConnectors(track.pieces[i]!)) {
        if (o.cell[0] !== nx || o.cell[1] !== nz || o.dir !== opposite) continue;
        const level = o.level - (k === 1 ? rise : 0);
        if (level < 0 || level + rise > MAX_LEVEL) continue;
        if (best === null || Math.abs(level - prefer) < Math.abs(best - prefer)) best = level;
      }
    }
  }
  return best;
}

/**
 * Raises (delta > 0) or lowers by whole levels the piece covering a cell (the one nearest the
 * editor's working `level` where several share it). It may not move into another piece's
 * levels: a road keeps a full level of clearance from one passing over or under it.
 */
export function changeLevel(
  track: TrackData,
  cx: number,
  cz: number,
  delta: number,
  level?: number,
): EditResult {
  const i = pieceAt(track, cx, cz, level);
  if (i < 0) return { ok: false, reason: "No piece here" };
  const p = track.pieces[i]!;
  const target = pieceLevel(p) + delta;
  if (target < 0) return { ok: false, reason: "Already on the ground" };
  if (target + PIECES[p.type].rise > MAX_LEVEL)
    return { ok: false, reason: `Already at the top level (${MAX_LEVEL})` };
  const moved = makePiece(p.type, p.x, p.z, p.rot, { y: target, flip: p.flip });
  const blocking = footprintCells(moved).some(([x, z]) =>
    piecesAt(track, x, z).some((j) => j !== i && !levelsClear(track.pieces[j]!, moved)),
  );
  if (blocking)
    return {
      ok: false,
      reason: delta > 0 ? "A road passes just above" : "A road passes just below",
    };
  const next = cloneTrack(track);
  next.pieces[i] = moved;
  return { ok: true, track: next, note: `Level ${target}` };
}

/**
 * Mirror image of the whole circuit (left turns become right turns), across the X = 0 axis.
 * World mirroring turns a piece's rotation r into −r and toggles its flip, and moves its anchor
 * cell to −x; the race keeps running through the start line the same way relative to it.
 */
export function mirrorTrack(track: TrackData): TrackData {
  const next = cloneTrack(track);
  next.pieces = track.pieces.map((p) =>
    makePiece(p.type, -p.x, p.z, ((4 - p.rot) % 4) as Rot, { y: p.y, flip: !p.flip }),
  );
  next.props = track.props.map((p) => ({ ...p, x: p.x === 0 ? 0 : -p.x }));
  return next;
}

/** Props snap to a half-unit grid. */
export const snapProp = (v: number) => Math.round(v * 2) / 2;

export function propNear(track: TrackData, x: number, z: number, radius: number): number {
  let best = -1;
  let bestD = radius;
  track.props.forEach((p, i) => {
    const d = Math.hypot(p.x - x, p.z - z);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

export function checkPropPlacement(
  track: TrackData,
  x: number,
  z: number,
): { ok: true } | { ok: false; reason: string } {
  const limit = (GRID_LIMIT + 0.5) * CELL;
  if (Math.abs(x) > limit || Math.abs(z) > limit)
    return { ok: false, reason: "Outside the build area" };
  if (propNear(track, x, z, 0.9) >= 0) return { ok: false, reason: "Too close to another prop" };
  if (track.props.length >= MAX_PROPS)
    return { ok: false, reason: `Too many props (max ${MAX_PROPS})` };
  return { ok: true };
}

export function placeProp(track: TrackData, type: PropType, x: number, z: number): EditResult {
  const sx = snapProp(x);
  const sz = snapProp(z);
  const check = checkPropPlacement(track, sx, sz);
  if (!check.ok) return check;
  const next = cloneTrack(track);
  next.props.push({ type, x: sx, z: sz, rot: 0 });
  return { ok: true, track: next };
}

/**
 * Erases the prop under the point if any, otherwise the piece under it (at or nearest to the
 * editor's working `level` where roads cross).
 */
export function eraseAt(track: TrackData, x: number, z: number, level?: number): EditResult {
  const prop = propNear(track, x, z, 1.2);
  if (prop >= 0) {
    const next = cloneTrack(track);
    next.props.splice(prop, 1);
    return { ok: true, track: next };
  }
  return erasePieceAt(track, Math.round(x / CELL), Math.round(z / CELL), level);
}

/** Snapshot-based undo history. Tracks are small, so whole copies are simplest and safest. */
export class History {
  private past: TrackData[] = [];
  private future: TrackData[] = [];
  constructor(private readonly limit = 200) {}

  push(previous: TrackData) {
    this.past.push(cloneTrack(previous));
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }

  undo(current: TrackData): TrackData | null {
    const prev = this.past.pop();
    if (!prev) return null;
    this.future.push(cloneTrack(current));
    return prev;
  }

  redo(current: TrackData): TrackData | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(cloneTrack(current));
    return next;
  }

  get canUndo() {
    return this.past.length > 0;
  }

  get canRedo() {
    return this.future.length > 0;
  }

  clear() {
    this.past = [];
    this.future = [];
  }
}
