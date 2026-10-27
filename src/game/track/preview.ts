import { analyzeTrack, buildRacePath, type TrackData } from "./Track";

// Thumbnails: the circuit's centerline as SVG path data in a 100 × 100 view box, one path per
// elevation level so a bridge can be drawn over the road it crosses. Generated from the same
// race path the game drives (no image, no rendering), a few hundred bytes.

export type TrackPreview = { levels: { level: number; d: string }[] };

export function trackPreview(track: TrackData): TrackPreview {
  const path = buildRacePath(track, analyzeTrack(track));
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of path.pieces)
    for (const pt of p.points) {
      minX = Math.min(minX, pt.x);
      maxX = Math.max(maxX, pt.x);
      minZ = Math.min(minZ, pt.z);
      maxZ = Math.max(maxZ, pt.z);
    }
  if (!Number.isFinite(minX)) return { levels: [] };
  const span = Math.max(maxX - minX, maxZ - minZ, 1);
  const scale = 88 / span;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  // Same orientation as the minimap: X mirrored, so the start straight reads as seen from the kart.
  const map = (x: number, z: number) =>
    `${(50 - (x - cx) * scale).toFixed(1)} ${(50 - (z - cz) * scale).toFixed(1)}`;
  const byLevel = new Map<number, string[]>();
  for (const p of path.pieces) {
    const step = Math.max(1, Math.floor(p.points.length / 6));
    const pts = p.points.filter((_, i) => i % step === 0 || i === p.points.length - 1);
    const d = `M${pts.map((pt) => map(pt.x, pt.z)).join("L")}`;
    const list = byLevel.get(p.level) ?? [];
    list.push(d);
    byLevel.set(p.level, list);
  }
  return {
    levels: [...byLevel.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([level, ds]) => ({ level, d: ds.join("") })),
  };
}
