import { createDefaultTrack } from "./defaultTrack";
import type { PieceData, TrackData } from "./Track";
import type { PieceType, Rot } from "./pieces";

// Built-in circuits, picked from the Circuits panel. Every one is a closed, valid loop (checked
// by tests/circuits.test.ts) that starts at cell (0, 0) heading +Z, like the default track.

const p = (
  type: PieceType,
  x: number,
  z: number,
  rot: Rot,
  extra: { y?: number; flip?: boolean } = {},
): PieceData => ({ type, x, z, rot, ...extra });

const circuit = (name: string, pieces: PieceData[]): TrackData => ({
  version: 1,
  name,
  pieces,
  props: [],
});

export type CircuitKind = "original" | "historic" | "venue";

export type Circuit = {
  id: string;
  name: string;
  description: string;
  kind: CircuitKind;
  create: () => TrackData;
};

/** "Harbour Oval": long straights, four sweepers and two chicanes on the back straight. */
function harbourOval(): TrackData {
  return circuit("Harbour Oval", [
    p("start", 0, 0, 0),
    p("straight", 0, 1, 0),
    p("straight", 0, 2, 0),
    p("straight", 0, 3, 0),
    p("straight", 0, 4, 0),
    p("straight", 0, 5, 0),
    p("straight", 0, 6, 0),
    p("wideCorner", 0, 7, 0),
    p("wideCorner", 2, 8, 1),
    p("straight", 3, 6, 2),
    p("chicane", 3, 5, 2),
    p("straight", 2, 3, 2),
    p("chicane", 2, 2, 2, { flip: true }),
    p("straight", 3, 0, 2),
    p("wideCorner", 3, -1, 2),
    p("wideCorner", 1, -2, 3),
  ]);
}

/** "Crossover": a figure of eight, the back section climbs onto a bridge over the main straight. */
function crossover(): TrackData {
  return circuit("Crossover", [
    p("start", 0, 0, 0),
    p("straight", 0, 1, 0),
    p("straight", 0, 2, 0),
    p("straight", 0, 3, 0),
    p("straight", 0, 4, 0),
    p("straight", 0, 5, 0),
    p("corner", 0, 6, 0),
    p("corner", 1, 6, 1),
    p("ramp", 1, 5, 2),
    p("straight", 1, 4, 2, { y: 1 }),
    p("corner", 1, 3, 2, { y: 1 }),
    p("straight", 0, 3, 3, { y: 1 }),
    p("straight", -1, 3, 3, { y: 1 }),
    p("corner", -2, 3, 3, { y: 1, flip: true }),
    p("ramp", -2, 2, 0),
    p("straight", -2, 1, 2),
    p("straight", -2, 0, 2),
    p("corner", -2, -1, 2, { flip: true }),
    p("straight", -1, -1, 1),
    p("corner", 0, -1, 1, { flip: true }),
  ]);
}

/** "Snake Valley": three hairpins linked by short straights, a drifting exercise. */
function snakeValley(): TrackData {
  return circuit("Snake Valley", [
    p("start", 0, 0, 0),
    p("straight", 0, 1, 0),
    p("straight", 0, 2, 0),
    p("straight", 0, 3, 0),
    p("hairpin", 0, 4, 0),
    p("straight", 1, 3, 2),
    p("straight", 1, 2, 2),
    p("straight", 1, 1, 2),
    p("hairpin", 1, 0, 2, { flip: true }),
    p("straight", 2, 1, 0),
    p("straight", 2, 2, 0),
    p("straight", 2, 3, 0),
    p("hairpin", 2, 4, 0),
    p("straight", 3, 3, 2),
    p("straight", 3, 2, 2),
    p("straight", 3, 1, 2),
    p("straight", 3, 0, 2),
    p("corner", 3, -1, 2),
    p("straight", 2, -1, 3),
    p("straight", 1, -1, 3),
    p("corner", 0, -1, 3),
  ]);
}

/** "Summit Ring": climbs two levels, sweeps round at the top and comes down through chicanes. */
function summitRing(): TrackData {
  return circuit("Summit Ring", [
    p("start", 0, 0, 0),
    p("straight", 0, 1, 0),
    p("longRamp", 0, 2, 0),
    p("longRamp", 0, 4, 0, { y: 1 }),
    p("straight", 0, 6, 0, { y: 2 }),
    p("straight", 0, 7, 0, { y: 2 }),
    p("wideCorner", 0, 8, 0, { y: 2 }),
    p("wideCorner", 2, 9, 1, { y: 2 }),
    p("longRamp", 3, 6, 0, { y: 1 }),
    p("chicane", 3, 5, 2, { y: 1 }),
    p("chicane", 2, 3, 2, { y: 1, flip: true }),
    p("longRamp", 3, 0, 0),
    p("wideCorner", 3, -1, 2),
    p("wideCorner", 1, -2, 3),
  ]);
}

// ─── Historic circuits ──────────────────────────────────────────────────────
// Real circuits redrawn by hand on the grid, kart-sized: the order and character of their famous
// corners are kept (and their climbs as ramps, a bridge where the track crosses itself), not the
// exact geometry.

/** "Monaco": up the hill to Casino, down through the hairpin, the tunnel, the harbour chicane, the swimming pool and Rascasse. */
function monaco(): TrackData {
  return circuit("Monaco", [
    p("start", 0, 0, 0),
    p("straight", 0, 1, 0),
    p("corner", 0, 2, 0, { flip: true }),
    p("longRamp", -1, 2, 3),
    p("straight", -3, 2, 3, { y: 1 }),
    p("wideCorner", -4, 2, 3, { y: 1 }),
    p("corner", -5, 4, 0, { y: 1, flip: true }),
    p("longRamp", -7, 4, 1),
    p("corner", -8, 4, 3, { flip: true }),
    p("hairpin", -8, 3, 2),
    p("corner", -9, 4, 0, { flip: true }),
    p("corner", -10, 4, 3, { flip: true }),
    p("straight", -10, 3, 2),
    p("straight", -10, 2, 2),
    p("straight", -10, 1, 2),
    p("wideCorner", -10, 0, 2, { flip: true }),
    p("straight", -8, -1, 1),
    p("straight", -7, -1, 1),
    p("chicane", -6, -1, 1),
    p("straight", -4, -2, 1),
    p("corner", -3, -2, 1),
    p("chicane", -3, -3, 2, { flip: true }),
    p("hairpin", -2, -5, 2, { flip: true }),
    p("chicane", -1, -4, 0),
    p("straight", 0, -2, 0),
    p("straight", 0, -1, 0),
  ]);
}

/** "Spa-Francorchamps": La Source, Eau Rouge and the climb along Kemmel, Les Combes, Rivage, the drop to Pouhon, Stavelot, Blanchimont and the Bus Stop. */
function spa(): TrackData {
  return circuit("Spa-Francorchamps", [
    p("start", 0, 0, 0),
    p("straight", 0, 1, 0),
    p("hairpin", 0, 2, 0, { flip: true }),
    p("straight", -1, 1, 2),
    p("chicane", -1, 0, 2),
    p("wideCorner", -2, -2, 2),
    p("longRamp", -4, -3, 3),
    p("straight", -6, -3, 3, { y: 1 }),
    p("straight", -7, -3, 3, { y: 1 }),
    p("longRamp", -8, -3, 3, { y: 1 }),
    p("straight", -10, -3, 3, { y: 2 }),
    p("straight", -11, -3, 3, { y: 2 }),
    p("corner", -12, -3, 3, { y: 2, flip: true }),
    p("corner", -12, -4, 2, { y: 2 }),
    p("corner", -13, -4, 3, { y: 2, flip: true }),
    p("longRamp", -13, -6, 0, { y: 1 }),
    p("hairpin", -13, -7, 2, { y: 1, flip: true }),
    p("corner", -12, -6, 0, { y: 1 }),
    p("longRamp", -10, -6, 3),
    p("wideCorner", -9, -6, 1),
    p("chicane", -8, -8, 2, { flip: true }),
    p("corner", -7, -10, 2, { flip: true }),
    p("straight", -6, -10, 1),
    p("straight", -5, -10, 1),
    p("straight", -4, -10, 1),
    p("straight", -3, -10, 1),
    p("straight", -2, -10, 1),
    p("straight", -1, -10, 1),
    p("straight", 0, -10, 1),
    p("wideCorner", 1, -10, 1, { flip: true }),
    p("straight", 2, -8, 0),
    p("straight", 2, -7, 0),
    p("straight", 2, -6, 0),
    p("chicane", 2, -5, 0, { flip: true }),
    p("straight", 1, -3, 0),
    p("chicane", 1, -2, 0, { flip: true }),
  ]);
}

/** "Monza": the temple of speed, long straights broken by chicanes, Curva Grande, Lesmo, Ascari and the Parabolica. */
function monza(): TrackData {
  return circuit("Monza", [
    p("start", 0, 0, 0),
    p("straight", 0, 1, 0),
    p("straight", 0, 2, 0),
    p("straight", 0, 3, 0),
    p("straight", 0, 4, 0),
    p("chicane", 0, 5, 0, { flip: true }),
    p("straight", -1, 7, 0),
    p("wideCorner", -1, 8, 0, { flip: true }),
    p("straight", -3, 9, 3),
    p("straight", -4, 9, 3),
    p("chicane", -5, 9, 3),
    p("corner", -7, 10, 3, { flip: true }),
    p("straight", -7, 9, 2),
    p("chicane", -7, 8, 2, { flip: true }),
    p("chicane", -6, 6, 2, { flip: true }),
    p("straight", -5, 4, 2),
    p("straight", -5, 3, 2),
    p("straight", -5, 2, 2),
    p("straight", -5, 1, 2),
    p("straight", -5, 0, 2),
    p("wideCorner", -5, -1, 2, { flip: true }),
    p("straight", -3, -2, 1),
    p("straight", -2, -2, 1),
    p("wideCorner", -1, -2, 1, { flip: true }),
  ]);
}

/** "Suzuka": the figure of eight, the Esses, Dunlop and Degner, the hairpin, Spoon, then the back straight over the bridge to the Casio chicane. */
function suzuka(): TrackData {
  return circuit("Suzuka", [
    p("start", 0, 0, 0),
    p("straight", 0, 1, 0),
    p("straight", 0, 2, 0),
    p("wideCorner", 0, 3, 0, { flip: true }),
    p("chicane", -2, 4, 3),
    p("chicane", -4, 5, 3, { flip: true }),
    p("corner", -6, 4, 3),
    p("corner", -6, 5, 0, { flip: true }),
    p("corner", -7, 5, 3, { flip: true }),
    p("straight", -7, 4, 2),
    p("straight", -7, 3, 2),
    p("straight", -7, 2, 2),
    p("straight", -7, 1, 2),
    p("straight", -7, 0, 2),
    p("straight", -7, -1, 2),
    p("straight", -7, -2, 2),
    p("straight", -7, -3, 2),
    p("straight", -7, -4, 2),
    p("straight", -7, -5, 2),
    p("hairpin", -7, -6, 2),
    p("wideCorner", -8, -5, 0, { flip: true }),
    p("straight", -10, -4, 3),
    p("wideCorner", -11, -4, 3),
    p("straight", -12, -2, 0),
    p("wideCorner", -12, -1, 0),
    p("straight", -10, 0, 1),
    p("longRamp", -9, 0, 1),
    p("straight", -7, 0, 1, { y: 1 }),
    p("longRamp", -5, 0, 3),
    p("straight", -4, 0, 1),
    p("corner", -3, 0, 1),
    p("corner", -3, -1, 2, { flip: true }),
    p("straight", -2, -1, 1),
    p("straight", -1, -1, 1),
    p("corner", 0, -1, 1, { flip: true }),
  ]);
}

// ─── Karting venues ─────────────────────────────────────────────────────────
// Real indoor karting tracks, redrawn from their plans on the grid.

/**
 * "Valence Xtrem" (Valence, France): an indoor track on two levels. Down the pit straight, the wide
 * left-hander and the kink along the south wall, then the long ramp up to the glass-walled deck:
 * a sweeping left at its far end, a hairpin, the long middle section with a hairpin at each end
 * (the west one next to the pit straight), and down the north ramp. Back on the ground the north
 * serpentine (a U-turn, a hairpin under the deck's corner, the long back straight and its kinks)
 * brings you round onto the pit straight.
 */
function valenceXtrem(): TrackData {
  return circuit("Valence Xtrem", [
    p("start", 0, 0, 0),
    p("straight", 0, 1, 0),
    p("straight", 0, 2, 0),
    p("straight", 0, 3, 0),
    p("straight", 0, 4, 0),
    p("straight", 0, 5, 0),
    p("straight", 0, 6, 0),
    p("wideCorner", 0, 7, 0),
    p("chicane", 2, 8, 1),
    p("straight", 4, 7, 1),
    p("longRamp", 5, 7, 1),
    p("longRamp", 7, 7, 1, { y: 1 }),
    p("wideCorner", 9, 7, 1, { y: 2 }),
    p("straight", 10, 5, 2, { y: 2 }),
    p("straight", 10, 4, 2, { y: 2 }),
    p("straight", 10, 3, 2, { y: 2 }),
    p("hairpin", 10, 2, 2, { y: 2 }),
    p("straight", 9, 3, 0, { y: 2 }),
    p("straight", 9, 4, 0, { y: 2 }),
    p("corner", 9, 5, 0, { y: 2, flip: true }),
    p("straight", 8, 5, 3, { y: 2 }),
    p("straight", 7, 5, 3, { y: 2 }),
    p("straight", 6, 5, 3, { y: 2 }),
    p("straight", 5, 5, 3, { y: 2 }),
    p("straight", 4, 5, 3, { y: 2 }),
    p("straight", 3, 5, 3, { y: 2 }),
    p("straight", 2, 5, 3, { y: 2 }),
    p("hairpin", 1, 5, 3, { y: 2, flip: true }),
    p("straight", 2, 4, 1, { y: 2 }),
    p("straight", 3, 4, 1, { y: 2 }),
    p("straight", 4, 4, 1, { y: 2 }),
    p("straight", 5, 4, 1, { y: 2 }),
    p("straight", 6, 4, 1, { y: 2 }),
    p("straight", 7, 4, 1, { y: 2 }),
    p("hairpin", 8, 4, 1, { y: 2 }),
    p("longRamp", 6, 3, 1, { y: 1 }),
    p("longRamp", 4, 3, 1),
    p("straight", 3, 3, 3),
    p("hairpin", 2, 3, 3, { flip: true }),
    p("straight", 3, 2, 1),
    p("straight", 4, 2, 1),
    p("straight", 5, 2, 1),
    p("straight", 6, 2, 1),
    p("straight", 7, 2, 1),
    p("hairpin", 8, 2, 1),
    p("straight", 7, 1, 3),
    p("straight", 6, 1, 3),
    p("chicane", 5, 1, 3, { flip: true }),
    p("chicane", 3, 0, 3, { flip: true }),
    p("straight", 1, -1, 3),
    p("corner", 0, -1, 3),
  ]);
}

const def = (
  kind: CircuitKind,
  id: string,
  description: string,
  create: () => TrackData,
): Circuit => ({ id, name: create().name, description, kind, create });

export const CIRCUITS: readonly Circuit[] = [
  def(
    "original",
    "pinewood",
    "The classic: sweepers, a hairpin and tight corners through the pines.",
    createDefaultTrack,
  ),
  def(
    "original",
    "harbour",
    "Flat out on the long straights, then thread the two chicanes.",
    harbourOval,
  ),
  def(
    "original",
    "crossover",
    "A figure of eight: the back section crosses over the start straight.",
    crossover,
  ),
  def("original", "snake", "Three hairpins in a row. Brake late and drift!", snakeValley),
  def(
    "original",
    "summit",
    "Climb two levels, sweep round the top and dive back down.",
    summitRing,
  ),
  def(
    "historic",
    "monaco",
    "Tight and unforgiving: Sainte Dévote, up to Casino, the hairpin, the tunnel, the pool.",
    monaco,
  ),
  def(
    "historic",
    "spa",
    "La Source, Eau Rouge and the long climb along Kemmel, then down to Pouhon and Blanchimont.",
    spa,
  ),
  def(
    "historic",
    "monza",
    "The temple of speed: flat out between the chicanes, then the Parabolica.",
    monza,
  ),
  def(
    "historic",
    "suzuka",
    "The figure of eight: the Esses, Degner, the hairpin, Spoon and back over the bridge.",
    suzuka,
  ),
  def(
    "venue",
    "xtrem",
    "Indoor, on two levels: up the ramp onto the glass-walled deck, hairpins above and below.",
    valenceXtrem,
  ),
];

export const CIRCUIT_KINDS: { kind: CircuitKind; label: string }[] = [
  { kind: "original", label: "Originals" },
  { kind: "historic", label: "Historic (simplified)" },
  { kind: "venue", label: "Karting venues" },
];
