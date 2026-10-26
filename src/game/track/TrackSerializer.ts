import {
  CELL,
  MAX_LEVEL,
  PIECE_TYPES,
  PROP_TYPES,
  type PieceType,
  type PropType,
  type Rot,
} from "./pieces";
import { analyzeTrack, GRID_LIMIT, MAX_PIECES, MAX_PROPS, type TrackData } from "./Track";

// Versioned track formats. Only plain track data is ever serialized: piece types, grid cells,
// rotations and prop positions. Nothing executable, no three.js objects.
//
// 1. JSON (export / import, human-readable):
//    { "format": "low-poly-karting", "version": 2, "name": "…",
//      "pieces": [["straight", 0, 1, 0], ["ramp", 0, 2, 0, 1, 1], …],
//      "props": [["cone", 4.5, -2, 0], …] }
//    A piece is [type, x, z, rot, level?, flipped?]; level and flip are omitted when 0.
//
// 2. URL (share links, compact binary → base64url), stored in the URL fragment (#track=…)
//    so it never reaches a server:
//    u8 version | u8 name length | name (UTF-8) | u16 piece count | pieces × 4 bytes
//    (x + 128, z + 128, type << 2 | rot, flip << 7 | level) | u16 prop count | props × 5 bytes
//    (type << 2 | rot, i16 x × 2, i16 z × 2).
//
// Version 1 (no elevation: 3-byte pieces without the last byte) is still read, and still
// written for flat circuits, so their links stay short and unchanged.

export const FORMAT = "low-poly-karting";
export const VERSION = 2;
const MAX_NAME = 32;
/** Above this many characters, sharing suggests the JSON export instead. */
export const MAX_URL_PARAM = 6000;

export type ParseResult = { ok: true; track: TrackData } | { ok: false; error: string };

// ─── Validation ────────────────────────────────────────────────────────────

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function cleanName(v: unknown): string {
  // Strip control characters; names are display-only but must stay tidy.
  const s = typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "").trim() : "";
  return s.slice(0, MAX_NAME) || "Shared circuit";
}

/** Validates untrusted, already-decoded data and builds a TrackData from it. */
export function validateTrack(raw: {
  name: unknown;
  pieces: unknown;
  props: unknown;
}): ParseResult {
  if (!Array.isArray(raw.pieces)) return { ok: false, error: "Missing piece list" };
  const props = raw.props === undefined ? [] : raw.props;
  if (!Array.isArray(props)) return { ok: false, error: "Invalid prop list" };
  if (raw.pieces.length > MAX_PIECES)
    return { ok: false, error: `Too many pieces (max ${MAX_PIECES})` };
  if (props.length > MAX_PROPS) return { ok: false, error: `Too many props (max ${MAX_PROPS})` };

  const track: TrackData = { version: 1, name: cleanName(raw.name), pieces: [], props: [] };
  for (const [i, p] of raw.pieces.entries()) {
    if (!Array.isArray(p) || p.length < 4)
      return { ok: false, error: `Piece ${i + 1} is malformed` };
    const [type, x, z, rot, y = 0, flip = 0] = p as unknown[];
    if (!PIECE_TYPES.includes(type as PieceType))
      return { ok: false, error: `Piece ${i + 1} has an unknown type` };
    if (!isInt(x) || !isInt(z) || Math.abs(x) > GRID_LIMIT || Math.abs(z) > GRID_LIMIT) {
      return { ok: false, error: `Piece ${i + 1} is outside the build area` };
    }
    if (!isInt(rot) || rot < 0 || rot > 3)
      return { ok: false, error: `Piece ${i + 1} has an invalid rotation` };
    if (!isInt(y) || y < 0 || y > MAX_LEVEL)
      return { ok: false, error: `Piece ${i + 1} has an invalid level` };
    if (flip !== 0 && flip !== 1 && flip !== true && flip !== false)
      return { ok: false, error: `Piece ${i + 1} is malformed` };
    const piece: TrackData["pieces"][number] = { type: type as PieceType, x, z, rot: rot as Rot };
    if (y) piece.y = y;
    if (flip) piece.flip = true;
    track.pieces.push(piece);
  }
  const limit = (GRID_LIMIT + 0.5) * CELL;
  for (const [i, p] of props.entries()) {
    if (!Array.isArray(p) || p.length < 3)
      return { ok: false, error: `Prop ${i + 1} is malformed` };
    const [type, x, z, rot = 0] = p as unknown[];
    if (!PROP_TYPES.includes(type as PropType))
      return { ok: false, error: `Prop ${i + 1} has an unknown type` };
    if (!isNum(x) || !isNum(z) || Math.abs(x) > limit || Math.abs(z) > limit) {
      return { ok: false, error: `Prop ${i + 1} is outside the build area` };
    }
    if (!isInt(rot) || rot < 0 || rot > 3)
      return { ok: false, error: `Prop ${i + 1} has an invalid rotation` };
    track.props.push({
      type: type as PropType,
      x: Math.round(x * 2) / 2,
      z: Math.round(z * 2) / 2,
      rot: rot as Rot,
    });
  }
  if (analyzeTrack(track).issues.some((i) => i.message.includes("overlapping"))) {
    return { ok: false, error: "Pieces overlap each other" };
  }
  return { ok: true, track };
}

// ─── JSON ──────────────────────────────────────────────────────────────────

export function toJson(track: TrackData): string {
  return JSON.stringify(
    {
      format: FORMAT,
      version: VERSION,
      name: track.name,
      pieces: track.pieces.map((p) => {
        const out: (string | number)[] = [p.type, p.x, p.z, p.rot];
        if (p.y || p.flip) out.push(p.y ?? 0);
        if (p.flip) out.push(1);
        return out;
      }),
      props: track.props.map((p) => [p.type, p.x, p.z, p.rot]),
    },
    null,
    1,
  );
}

export function fromJson(text: string): ParseResult {
  if (text.length > 200_000) return { ok: false, error: "File is too large" };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "Not valid JSON" };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data))
    return { ok: false, error: "Not a track file" };
  const o = data as Record<string, unknown>;
  if (o.format !== FORMAT) return { ok: false, error: "Not a Low-Poly Karting track" };
  if (o.version !== 1 && o.version !== VERSION)
    return { ok: false, error: `Unsupported track version ${String(o.version)}` };
  return validateTrack({ name: o.name, pieces: o.pieces, props: o.props });
}

// ─── URL ───────────────────────────────────────────────────────────────────

export function encodeTrack(track: TrackData): string {
  const name = new TextEncoder().encode(track.name.slice(0, MAX_NAME)).slice(0, 96);
  // Flat, unflipped circuits keep the shorter version 1 layout (and their old links).
  const version = track.pieces.some((p) => p.y || p.flip) ? VERSION : 1;
  const pieceBytes = version === 1 ? 3 : 4;
  const size = 2 + name.length + 2 + track.pieces.length * pieceBytes + 2 + track.props.length * 5;
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  let o = 0;
  bytes[o++] = version;
  bytes[o++] = name.length;
  bytes.set(name, o);
  o += name.length;
  view.setUint16(o, track.pieces.length);
  o += 2;
  for (const p of track.pieces) {
    bytes[o++] = p.x + 128;
    bytes[o++] = p.z + 128;
    bytes[o++] = (PIECE_TYPES.indexOf(p.type) << 2) | p.rot;
    if (pieceBytes === 4) bytes[o++] = ((p.flip ? 1 : 0) << 7) | (p.y ?? 0);
  }
  view.setUint16(o, track.props.length);
  o += 2;
  for (const p of track.props) {
    bytes[o++] = (PROP_TYPES.indexOf(p.type) << 2) | p.rot;
    view.setInt16(o, Math.round(p.x * 2));
    view.setInt16(o + 2, Math.round(p.z * 2));
    o += 4;
  }
  return toBase64Url(bytes);
}

export function decodeTrack(param: string): ParseResult {
  if (param.length > MAX_URL_PARAM * 2) return { ok: false, error: "Link is too long" };
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(param);
  } catch {
    return { ok: false, error: "The link is damaged" };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const need = (n: number) => {
    if (o + n > bytes.length) throw new Error("truncated");
  };
  try {
    need(2);
    const version = bytes[o++]!;
    if (version !== 1 && version !== VERSION)
      return { ok: false, error: `Unsupported track version ${version}` };
    const pieceBytes = version === 1 ? 3 : 4;
    const nameLen = bytes[o++]!;
    need(nameLen);
    const name = new TextDecoder().decode(bytes.subarray(o, o + nameLen));
    o += nameLen;
    need(2);
    const pieceCount = view.getUint16(o);
    o += 2;
    if (pieceCount > MAX_PIECES) return { ok: false, error: "Too many pieces" };
    const pieces: unknown[] = [];
    for (let i = 0; i < pieceCount; i++) {
      need(pieceBytes);
      const x = bytes[o++]! - 128;
      const z = bytes[o++]! - 128;
      const packed = bytes[o++]!;
      const extra = pieceBytes === 4 ? bytes[o++]! : 0;
      pieces.push([PIECE_TYPES[packed >> 2] ?? "?", x, z, packed & 3, extra & 0x7f, extra >> 7]);
    }
    need(2);
    const propCount = view.getUint16(o);
    o += 2;
    if (propCount > MAX_PROPS) return { ok: false, error: "Too many props" };
    const props: unknown[] = [];
    for (let i = 0; i < propCount; i++) {
      need(5);
      const packed = bytes[o++]!;
      const x = view.getInt16(o) / 2;
      const z = view.getInt16(o + 2) / 2;
      o += 4;
      props.push([PROP_TYPES[packed >> 2] ?? "?", x, z, packed & 3]);
    }
    return validateTrack({ name, pieces, props });
  } catch {
    return { ok: false, error: "The link is incomplete" };
  }
}

export function shareUrl(track: TrackData, base: string): string {
  const url = new URL(base);
  url.hash = `track=${encodeTrack(track)}`;
  return url.toString();
}

/** Reads `#track=…` from a URL hash, if present. */
export function trackFromHash(hash: string): ParseResult | null {
  const m = /(?:^#|&)track=([A-Za-z0-9_-]+)/.exec(hash);
  return m ? decodeTrack(m[1]!) : null;
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("invalid characters");
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
