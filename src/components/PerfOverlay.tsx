"use client";

import { useEffect, useState } from "react";
import type { PerfStats } from "@/game/Game";
import { useGame } from "./useGame";

/**
 * Diagnostics: FPS, frame times, CPU time spent in physics and rendering, draw calls. Hidden by
 * default; open with `?perf` in the URL or toggle with F3. Polled twice a second from stats the
 * game loop already aggregates, so it costs nothing per frame.
 */
export function PerfOverlay() {
  const game = useGame();
  const [visible, setVisible] = useState(false);
  const [stats, setStats] = useState<PerfStats | null>(null);

  useEffect(() => {
    // Reading the URL is an external input; sync it once on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVisible(new URLSearchParams(window.location.search).has("perf"));
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "F3") {
        e.preventDefault();
        setVisible((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!visible) return;
    const id = window.setInterval(() => setStats({ ...game.getPerfStats() }), 500);
    return () => window.clearInterval(id);
  }, [visible, game]);

  if (!visible || !stats) return null;
  const row = (label: string, value: string, warn = false) => (
    <div className="flex justify-between gap-4">
      <span className="opacity-60">{label}</span>
      <span className={warn ? "text-warning" : ""}>{value}</span>
    </div>
  );
  return (
    <div className="hud-card pointer-events-none absolute bottom-20 left-3 z-20 w-48 px-3 py-2 font-mono text-[11px] leading-snug">
      {row("FPS", stats.fps.toFixed(0), stats.fps < 50)}
      {row("frame", `${stats.frameMs.toFixed(1)} ms`)}
      {row("worst", `${stats.worstFrameMs.toFixed(1)} ms`, stats.worstFrameMs > 33)}
      {row("physics", `${stats.physicsMs.toFixed(2)} ms`)}
      {row("render (CPU)", `${stats.renderMs.toFixed(2)} ms`)}
      {row("draw calls", String(stats.calls))}
      {row("triangles", `${(stats.triangles / 1000).toFixed(0)}k`)}
      {row("pixel ratio", stats.pixelRatio.toFixed(2))}
      {row("shadow map", String(stats.shadowMap))}
    </div>
  );
}
