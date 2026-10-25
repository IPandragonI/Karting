import type { PieceData, PropData, TrackData } from "./Track";
import type { PieceType, Rot } from "./pieces";

const p = (type: PieceType, x: number, z: number, rot: Rot): PieceData => ({ type, x, z, rot });
const cone = (x: number, z: number): PropData => ({ type: "cone", x, z, rot: 0 });
const tires = (x: number, z: number): PropData => ({ type: "tires", x, z, rot: 0 });

/** "Pinewood Park": the circuit that loads when no shared track is given. */
export function createDefaultTrack(): TrackData {
  return {
    version: 1,
    name: "Pinewood Park",
    pieces: [
      p("start", 0, 0, 0),
      p("straight", 0, 1, 0),
      p("straight", 0, 2, 0),
      p("wideCorner", 0, 3, 0),
      p("straight", 2, 4, 1),
      p("corner", 3, 4, 2),
      p("corner", 3, 5, 0),
      p("straight", 4, 5, 1),
      p("hairpin", 5, 6, 1),
      p("straight", 4, 6, 1),
      p("straight", 3, 6, 1),
      p("straight", 2, 6, 1),
      p("straight", 1, 6, 1),
      p("straight", 0, 6, 1),
      p("straight", -1, 6, 1),
      p("wideCorner", -3, 5, 0),
      p("straight", -3, 4, 0),
      p("corner", -3, 3, 2),
      p("corner", -4, 3, 0),
      p("straight", -4, 2, 0),
      p("straight", -4, 1, 0),
      p("corner", -4, 0, 3),
      p("corner", -3, 0, 1),
      p("corner", -3, -1, 3),
      p("straight", -2, -1, 1),
      p("straight", -1, -1, 1),
      p("corner", 0, -1, 2),
    ],
    props: [
      // Tire stacks on the infield.
      tires(18, 30),
      tires(19, 31.5),
      tires(-30, 18),
      // Cones along the start straight's infield.
      cone(-8, 14),
      cone(-8, 20),
      cone(-8, 26),
    ],
  };
}
