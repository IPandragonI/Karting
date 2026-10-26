"use client";

import { useEffect, useRef, useState } from "react";
import { ROAD_HALF } from "@/game/track/pieces";
import { useGame, useGameState } from "./useGame";

/** Map size in CSS pixels for the current viewport (smaller on phones and short screens). */
function mapSize() {
  if (typeof window === "undefined") return 156;
  return window.innerWidth < 640 || window.innerHeight < 520 ? 104 : 156;
}

/**
 * Track outline drawn once per track; the kart (an arrow showing its heading) and the ghost (a
 * hollow marker) are redrawn every frame on a second canvas.
 */
export function Minimap() {
  const game = useGame();
  const trackName = useGameState((s) => s.trackName);
  const raceable = useGameState((s) => s.raceable);
  const issues = useGameState((s) => s.issues);
  const [size, setSize] = useState(mapSize);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const dotRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const onResize = () => setSize(mapSize());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const base = baseRef.current;
    const dot = dotRef.current;
    if (!base || !dot) return;
    const dpr = Math.min(window.devicePixelRatio, 2);
    for (const c of [base, dot]) {
      c.width = size * dpr;
      c.height = size * dpr;
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
    const pad = size * 0.09;
    const span = Math.max(maxX - minX, maxZ - minZ, 1);
    const scale = ((size - pad * 2) / span) * dpr;
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    // Mirror X so the map matches the view from behind the kart at the start (−X is screen right).
    const map = (x: number, z: number): [number, number] => [
      (size * dpr) / 2 - (x - cx) * scale,
      (size * dpr) / 2 - (z - cz) * scale,
    ];

    const ctx = base.getContext("2d")!;
    ctx.clearRect(0, 0, base.width, base.height);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const road = Math.max(ROAD_HALF * 2 * scale, 2.5 * dpr);
    // Lower levels first; each raised piece gets its own dark casing, so where roads cross the
    // upper one visibly passes over the lower one instead of looking like a junction. Raised road
    // is tinted warmer.
    const levels = [...new Set(path.pieces.map((p) => p.level))].sort((a, b) => a - b);
    for (const level of levels) {
      const pieces = path.pieces.filter((p) => p.level === level);
      for (const [width, color] of [
        [road + 3 * dpr, "rgba(0,0,0,0.5)"],
        [road, level > 0 ? "rgba(255,222,140,0.95)" : "rgba(243,241,234,0.9)"],
      ] as const) {
        ctx.lineWidth = width;
        ctx.strokeStyle = color;
        for (const p of pieces) {
          ctx.beginPath();
          p.points.forEach((pt, i) => {
            const [x, y] = map(pt.x, pt.z);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          });
          ctx.stroke();
        }
      }
    }
    const start = path.pieces.find((p) => p.order === 0);
    if (start) {
      const mid = start.points[Math.floor(start.points.length / 2)]!;
      const [x, y] = map(mid.x, mid.z);
      ctx.fillStyle = "#e5483b";
      ctx.beginPath();
      ctx.arc(x, y, 3 * dpr, 0, Math.PI * 2);
      ctx.fill();
    }

    const dctx = dot.getContext("2d")!;
    let last = "";
    return game.onFrame((f) => {
      const [x, y] = map(f.x, f.z);
      const ghost = Number.isFinite(f.ghostX);
      const [gx, gy] = ghost ? map(f.ghostX, f.ghostZ) : [0, 0];
      const key = `${x.toFixed(1)},${y.toFixed(1)},${f.yaw.toFixed(2)},${gx.toFixed(1)},${gy.toFixed(1)},${f.level}`;
      if (key === last) return;
      last = key;
      dctx.clearRect(0, 0, dot.width, dot.height);
      if (ghost) {
        dctx.strokeStyle = "#8fd3ff";
        dctx.lineWidth = 2 * dpr;
        dctx.beginPath();
        dctx.arc(gx, gy, 3.6 * dpr, 0, Math.PI * 2);
        dctx.stroke();
      }
      // Heading on screen: world +X maps to screen −x, world +Z to screen −y.
      const hx = -Math.sin(f.yaw);
      const hy = -Math.cos(f.yaw);
      const r = 6 * dpr;
      // On raised road the arrow turns orange with a white edge (the map is flat: this tells which
      // of two crossing roads the kart is on).
      dctx.fillStyle = f.level > 0 ? "#ff8a3d" : "#f2c14e";
      dctx.strokeStyle = f.level > 0 ? "#ffffff" : "#1f2329";
      dctx.lineWidth = 1.5 * dpr;
      dctx.beginPath();
      dctx.moveTo(x + hx * r, y + hy * r);
      dctx.lineTo(x - hx * r * 0.6 - hy * r * 0.62, y - hy * r * 0.6 + hx * r * 0.62);
      dctx.lineTo(x - hx * r * 0.25, y - hy * r * 0.25);
      dctx.lineTo(x - hx * r * 0.6 + hy * r * 0.62, y - hy * r * 0.6 - hx * r * 0.62);
      dctx.closePath();
      dctx.fill();
      dctx.stroke();
    });
  }, [game, trackName, raceable, issues, size]);

  return (
    <div
      className="glass-panel relative rounded-box [@media(max-height:260px)]:hidden"
      style={{ width: size, height: size }}
      aria-hidden
    >
      <canvas ref={baseRef} className="absolute inset-0 h-full w-full" />
      <canvas ref={dotRef} className="absolute inset-0 h-full w-full" />
    </div>
  );
}
