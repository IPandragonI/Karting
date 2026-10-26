import type { TrackPreview } from "@/game/track/preview";

/**
 * Circuit thumbnail from its preview paths: ground level in pale asphalt, raised levels in a warm
 * tint drawn over them with a dark casing, so a bridge reads as passing over the road below.
 */
export function TrackThumb({
  preview,
  size = 72,
  label,
}: {
  preview: TrackPreview | null;
  size?: number;
  label: string;
}) {
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      role="img"
      aria-label={`Layout of ${label}`}
      className="shrink-0 rounded-lg bg-[#2d6a33]"
    >
      {preview?.levels.map(({ level, d }) => (
        <g key={level} fill="none" strokeLinecap="round" strokeLinejoin="round">
          <path d={d} stroke="rgba(0,0,0,0.55)" strokeWidth={7.5} />
          <path d={d} stroke={level > 0 ? "#ffd98a" : "#f1efe8"} strokeWidth={5} />
        </g>
      ))}
    </svg>
  );
}
