import { CELL, type PieceType, type PropType, type Rot } from "./pieces";
import {
  cellKey,
  cloneTrack,
  footprintCells,
  GRID_LIMIT,
  MAX_PIECES,
  MAX_PROPS,
  type PieceData,
  type TrackData,
} from "./Track";

// Pure editing operations used by the editor UI. Each returns a new TrackData (never mutates)
// or a human-readable reason why the edit is not allowed.

export type EditResult =
  { ok: true; track: TrackData; note?: string } | { ok: false; reason: string };

/** Index of the piece covering a cell, or −1. */
export function pieceAt(track: TrackData, cx: number, cz: number): number {
  const key = cellKey(cx, cz);
  return track.pieces.findIndex((p) => footprintCells(p).some(([x, z]) => cellKey(x, z) === key));
}

export function checkPiecePlacement(
  track: TrackData,
  piece: PieceData,
): { ok: true; replaces: number | null } | { ok: false; reason: string } {
  const cells = footprintCells(piece);
  if (cells.some(([x, z]) => Math.abs(x) > GRID_LIMIT || Math.abs(z) > GRID_LIMIT)) {
    return { ok: false, reason: "Outside the build area" };
  }
  const hit = new Set<number>();
  for (const [x, z] of cells) {
    const i = pieceAt(track, x, z);
    if (i >= 0) hit.add(i);
  }
  if (hit.size > 1) return { ok: false, reason: "Overlaps several pieces (erase them first)" };
  const replaces = hit.size === 1 ? [...hit][0]! : null;
  if (replaces !== null) {
    const old = track.pieces[replaces]!;
    if (
      old.type === piece.type &&
      old.rot === piece.rot &&
      old.x === piece.x &&
      old.z === piece.z
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
): EditResult {
  const piece: PieceData = { type, x, z, rot };
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

export function erasePieceAt(track: TrackData, cx: number, cz: number): EditResult {
  const i = pieceAt(track, cx, cz);
  if (i < 0) return { ok: false, reason: "Nothing to erase here" };
  const next = cloneTrack(track);
  next.pieces.splice(i, 1);
  return { ok: true, track: next };
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

/** Erases the prop under the point if any, otherwise the piece under it. */
export function eraseAt(track: TrackData, x: number, z: number): EditResult {
  const prop = propNear(track, x, z, 1.2);
  if (prop >= 0) {
    const next = cloneTrack(track);
    next.props.splice(prop, 1);
    return { ok: true, track: next };
  }
  return erasePieceAt(track, Math.round(x / CELL), Math.round(z / CELL));
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
