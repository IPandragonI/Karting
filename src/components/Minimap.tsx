"use client";

import { useEffect, useRef } from "react";
import { ROAD_HALF } from "@/game/track/pieces";
import { useGame, useGameState } from "./useGame";

const SIZE = 132;

/** Track outline drawn once per track; the kart dot is redrawn every frame on a second canvas. */
export function Minimap() {
  const game = useGame();
  const trackName = useGameState((s) => s.trackName);
  const raceable = useGameState((s) => s.raceable);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const dotRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const base = baseRef.current;
    const dot = dotRef.current;
    if (!base || !dot) return;
    const dpr = Math.min(window.devicePixelRatio, 2);
    for (const c of [base, dot]) {
      c.width = SIZE * dpr;
      c.height = SIZE * dpr;
    }
    const path = game.getRacePath();
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of path.pieces) {
      for (const pt of p.points) {
        minX = Math.min(minX, pt.x);
        maxX = Math.max(maxX, pt.x);
        minZ = Math.min(minZ, pt.z);
        maxZ = Math.max(maxZ, pt.z);
      }
    }
    const pad = 12;
    const span = Math.max(maxX - minX, maxZ - minZ, 1);
    const scale = ((SIZE - pad * 2) / span) * dpr;
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    // Mirror X so the map matches the view from behind the kart at the start (−X is screen right).
    const map = (x: number, z: number): [number, number] => [
      (SIZE * dpr) / 2 - (x - cx) * scale,
      (SIZE * dpr) / 2 - (z - cz) * scale,
    ];

    const ctx = base.getContext("2d")!;
    ctx.clearRect(0, 0, base.width, base.height);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const [width, color] of [
      [ROAD_HALF * 2 * scale + 3 * dpr, "rgba(0,0,0,0.45)"],
      [ROAD_HALF * 2 * scale, "rgba(243,241,234,0.9)"],
    ] as const) {
      ctx.lineWidth = width;
      ctx.strokeStyle = color;
      for (const p of path.pieces) {
        ctx.beginPath();
        p.points.forEach((pt, i) => {
          const [x, y] = map(pt.x, pt.z);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
      }
    }
    const start = path.pieces.find((p) => p.order === 0);
    if (start) {
      const mid = start.points[Math.floor(start.points.length / 2)]!;
      const [x, y] = map(mid.x, mid.z);
      ctx.fillStyle = "#e5483b";
      ctx.beginPath();
      ctx.arc(x, y, 3.5 * dpr, 0, Math.PI * 2);
      ctx.fill();
    }

    const dctx = dot.getContext("2d")!;
    let lastX = NaN;
    let lastY = NaN;
    return game.onFrame((f) => {
      const [x, y] = map(f.x, f.z);
      if (Math.abs(x - lastX) < 0.5 && Math.abs(y - lastY) < 0.5) return;
      lastX = x;
      lastY = y;
      dctx.clearRect(0, 0, dot.width, dot.height);
      dctx.fillStyle = "#f2c14e";
      dctx.strokeStyle = "#1f2329";
      dctx.lineWidth = 2 * dpr;
      dctx.beginPath();
      dctx.arc(x, y, 4.5 * dpr, 0, Math.PI * 2);
      dctx.fill();
      dctx.stroke();
    });
  }, [game, trackName, raceable]);

  return (
    <div
      className="glass-panel relative rounded-box max-sm:hidden [@media(max-height:520px)]:hidden"
      style={{ width: SIZE, height: SIZE }}
      aria-hidden
    >
      <canvas ref={baseRef} className="absolute inset-0 h-full w-full" />
      <canvas ref={dotRef} className="absolute inset-0 h-full w-full" />
    </div>
  );
}
