"use client";

import { Car, Eye, Ghost, Menu, Mountain, Pencil, RotateCcw, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef } from "react";
import { CAMERA_MODES, type CameraMode } from "@/game/Camera";
import type { RaceUi } from "@/game/Game";
import {
  formatDelta,
  formatSplit,
  formatTime,
  type SectorResult,
  type SectorStatus,
} from "@/game/RaceManager";
import { Minimap } from "./Minimap";
import { TouchControls } from "./TouchControls";
import { useGame, useGameState } from "./useGame";

const CAMERA_ICONS: Record<CameraMode, React.ReactNode> = {
  elevated: <Mountain className="size-4" aria-hidden />,
  chase: <Car className="size-4" aria-hidden />,
  first: <Eye className="size-4" aria-hidden />,
};

/** F1 timing colours: personal best, session improvement, slower; neutral on a first run. */
const SECTOR_COLORS: Record<SectorStatus, string> = {
  purple: "#c26bff",
  green: "#3ddc84",
  yellow: "#f5c84c",
  neutral: "#e8edf2",
};

const SECTOR_LABELS: Record<SectorStatus, string> = {
  purple: "personal best",
  green: "faster than your session best",
  yellow: "slower than your best",
  neutral: "first time",
};

/** S1–S3 rows: done sectors with time and delta, the running one marked, the rest empty. */
function Sectors({ race }: { race: RaceUi }) {
  return (
    <ol className="mt-1 grid gap-px border-t border-white/15 pt-1 text-xs tabular-nums">
      {[0, 1, 2].map((i) => {
        const s: SectorResult | undefined = race.splits[i];
        const running = !race.splitsFromLastLap && race.sector === i;
        const color = s ? SECTOR_COLORS[s.status] : undefined;
        return (
          <li
            key={i}
            className="grid grid-cols-[1.6rem_1fr_auto] items-center gap-x-2"
            aria-label={
              s
                ? `Sector ${i + 1}: ${formatSplit(s.time)} seconds, ${SECTOR_LABELS[s.status]}`
                : `Sector ${i + 1}`
            }
          >
            <span className="flex items-center gap-1 font-bold opacity-80">
              <span
                className={`inline-block h-2.5 w-1 rounded-sm ${running ? "animate-pulse bg-white/70" : ""}`}
                style={color ? { background: color } : undefined}
                aria-hidden
              />
              S{i + 1}
            </span>
            <span className="text-right font-bold" style={color ? { color } : { opacity: 0.35 }}>
              {s ? formatSplit(s.time) : running ? "···" : "–"}
            </span>
            <span className="min-w-[3.6rem] text-right text-[11px]" style={{ color }}>
              {s ? formatDelta(s.delta) : ""}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** In-race overlay. Per-frame values are written straight to the DOM, not through React state. */
export function Hud() {
  const game = useGame();
  const race = useGameState((s) => s.race);
  const raceable = useGameState((s) => s.raceable);
  const toast = useGameState((s) => s.toast);
  const stuck = useGameState((s) => s.stuckHint);
  const wrongWay = useGameState((s) => s.wrongWay);
  const muted = useGameState((s) => s.muted);
  const audio = useGameState((s) => s.audio);
  const camera = useGameState((s) => s.camera);
  const screen = useGameState((s) => s.screen);
  const ghost = useGameState((s) => s.ghost);
  const ghostTime = useGameState((s) => s.ghostTime);
  const speedRef = useRef<HTMLSpanElement>(null);
  const lapTimeRef = useRef<HTMLSpanElement>(null);
  const offRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let lastSpeed = -1;
    let lastOff: boolean | null = null;
    let lastTime = "";
    return game.onFrame((f) => {
      const kmh = Math.round(f.speed * 3.6);
      if (kmh !== lastSpeed && speedRef.current) {
        speedRef.current.textContent = String(kmh);
        lastSpeed = kmh;
      }
      if (f.offTrack !== lastOff && offRef.current) {
        offRef.current.style.opacity = f.offTrack ? "1" : "0";
        lastOff = f.offTrack;
      }
      const t = formatTime(f.lapTime);
      if (t !== lastTime && lapTimeRef.current) {
        lapTimeRef.current.textContent = t;
        lastTime = t;
      }
    });
  }, [game]);

  const best = race.bestLap ?? race.recordLap;
  const cameraLabel = CAMERA_MODES.find((c) => c.id === camera)?.label ?? "";
  const playing = screen === "playing";

  return (
    <div className="hud-text pointer-events-none absolute inset-0 [padding:max(0.75rem,env(safe-area-inset-top))_max(0.75rem,env(safe-area-inset-right))_max(0.75rem,env(safe-area-inset-bottom))_max(0.75rem,env(safe-area-inset-left))]">
      <div className="relative h-full w-full">
        {/* Lap card. */}
        <div className="hud-card absolute top-0 left-0 min-w-36 px-3 py-2 sm:min-w-44">
          {!raceable ? (
            <div className="text-xs">
              <div className="font-bold tracking-wide uppercase opacity-80">Free drive</div>
              <div className="opacity-70">Circuit incomplete: no timing</div>
            </div>
          ) : (
            <>
              <div className="flex items-baseline justify-between gap-3 text-[11px] font-bold tracking-widest uppercase opacity-70">
                <span>{race.phase === "timing" ? `Lap ${race.lap}` : "Out lap"}</span>
                {race.laps.length > 0 && <span>{race.laps.length} done</span>}
              </div>
              <span
                ref={lapTimeRef}
                className={`block text-2xl leading-tight font-extrabold tabular-nums sm:text-3xl ${
                  race.phase === "timing" ? "" : "opacity-50"
                }`}
              >
                0:00.000
              </span>
              {race.phase !== "timing" ? (
                <div className="text-[11px] opacity-70">Cross the line to start the clock</div>
              ) : (
                <>
                  <dl className="mt-0.5 grid grid-cols-[auto_1fr] gap-x-3 text-xs tabular-nums">
                    <dt className="opacity-60">Best</dt>
                    <dd className="text-right font-bold text-secondary">{formatTime(best)}</dd>
                    <dt className="opacity-60">Last</dt>
                    <dd className="text-right">{formatTime(race.lastLap)}</dd>
                  </dl>
                  <Sectors race={race} />
                </>
              )}
            </>
          )}
        </div>

        {/* Toolbar. */}
        <div className="pointer-events-auto absolute top-0 right-0 flex flex-col items-end gap-2">
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <button
              className="hud-btn btn gap-1.5 px-3 btn-sm"
              onClick={() => game.openEditor()}
              title="Open the track editor"
            >
              <Pencil className="size-4" aria-hidden />
              <span className="max-[420px]:sr-only">Edit track</span>
            </button>
            <div
              className="hud-card flex items-center gap-0.5 p-0.5"
              role="radiogroup"
              aria-label="Camera"
            >
              {CAMERA_MODES.map((c) => (
                <button
                  key={c.id}
                  role="radio"
                  aria-checked={camera === c.id}
                  aria-label={`${c.label} camera`}
                  title={`${c.label} camera (C to cycle)`}
                  onClick={() => game.setCamera(c.id)}
                  className={`btn btn-square size-7 border-0 btn-xs sm:size-8 ${
                    camera === c.id ? "btn-primary" : "btn-ghost"
                  }`}
                >
                  {CAMERA_ICONS[c.id]}
                </button>
              ))}
              <span className="hidden pr-2 pl-1 text-xs font-bold lg:inline">{cameraLabel}</span>
            </div>
            {raceable && (
              <button
                className={`hud-btn btn btn-square btn-sm ${ghost ? "" : "opacity-60"}`}
                onClick={() => game.setGhost(!ghost)}
                aria-pressed={ghost}
                aria-label="Show best lap ghost (G)"
                title={
                  ghost
                    ? ghostTime === null
                      ? "Best lap ghost: on (appears after your first full lap) · G"
                      : `Best lap ghost: on (${formatTime(ghostTime)}) · G`
                    : "Best lap ghost: off · G"
                }
              >
                <Ghost className={`size-4 ${ghost ? "text-info" : ""}`} />
              </button>
            )}
            <button
              className="hud-btn btn btn-square btn-sm"
              onClick={() => game.resetKart()}
              disabled={!playing}
              aria-label="Reset kart onto the track (R)"
              title="Reset onto the track (R)"
            >
              <RotateCcw className="size-4" />
            </button>
            <button
              className="hud-btn btn btn-square btn-sm"
              onClick={() => game.setMuted(!muted)}
              aria-label={muted ? "Unmute sound" : "Mute sound"}
              title={muted ? "Unmute" : "Mute"}
            >
              {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
            </button>
            <button
              className="hud-btn btn btn-square btn-sm"
              onClick={() => game.togglePause()}
              aria-label="Menu and pause (Esc)"
              title="Menu (Esc)"
            >
              <Menu className="size-4" />
            </button>
          </div>
          <Minimap />
        </div>

        {/* Sound hint while the browser blocks audio. */}
        {audio === "locked" && !muted && playing && (
          <button
            className="hud-card pointer-events-auto absolute top-0 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full px-3 py-1.5 text-xs font-bold whitespace-nowrap max-lg:top-auto max-lg:bottom-2"
            onClick={() => game.enableSound()}
          >
            <VolumeX className="size-4" aria-hidden /> Sound is off · tap or press a key
          </button>
        )}

        <div
          className="absolute top-[30%] left-1/2 flex -translate-x-1/2 flex-col items-center gap-2 text-center"
          aria-live="polite"
        >
          {toast && (
            <div
              key={toast.id}
              className={`rounded-full px-4 py-1.5 text-sm font-bold shadow-lg ${
                toast.tone === "success"
                  ? "bg-success text-success-content"
                  : toast.tone === "warning"
                    ? "bg-warning text-warning-content"
                    : "bg-base-100/80 text-base-content"
              }`}
            >
              {toast.text}
            </div>
          )}
          {wrongWay && (
            <div className="rounded-full bg-error px-4 py-1.5 font-extrabold text-error-content shadow-lg">
              Wrong way!
            </div>
          )}
          <div
            ref={offRef}
            className="rounded-full bg-warning px-3 py-1 text-xs font-bold text-warning-content opacity-0 shadow-lg transition-opacity"
          >
            Off track
          </div>
        </div>

        {stuck && (
          <button
            className="hud-card pointer-events-auto absolute bottom-28 left-1/2 -translate-x-1/2 rounded-full px-4 py-2 text-sm whitespace-nowrap"
            onClick={() => game.resetKart()}
          >
            Stuck? Press <kbd className="kbd kbd-sm">R</kbd> or tap here
          </button>
        )}

        <div className="absolute right-0 bottom-0 text-right [@media(pointer:coarse)]:top-24 [@media(pointer:coarse)]:bottom-auto">
          <span
            ref={speedRef}
            className="text-4xl leading-none font-extrabold tabular-nums sm:text-5xl"
          >
            0
          </span>
          <span className="ml-1 text-sm font-bold opacity-80">km/h</span>
        </div>

        <TouchControls />
      </div>
    </div>
  );
}
