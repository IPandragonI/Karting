"use client";

import {
  Car,
  ChevronDown,
  Eye,
  Ghost,
  Map as MapIcon,
  Menu,
  Mountain,
  Pencil,
  RotateCcw,
  Settings,
  Volume2,
  VolumeX,
} from "lucide-react";
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

/** F1 timing colours: personal best, faster than reference, slower; neutral on a first run. */
const SECTOR_STYLE: Record<SectorStatus, { bg: string; fg: string; label: string }> = {
  purple: { bg: "#a54dff", fg: "#ffffff", label: "personal best" },
  green: { bg: "#2fcf73", fg: "#08210f", label: "faster than your session best" },
  yellow: { bg: "#f4c542", fg: "#2a2004", label: "slower than your best" },
  neutral: { bg: "#e8edf2", fg: "#1b1f25", label: "first time" },
};

const AHEAD = "#3ddc84";
const BEHIND = "#ff6b6b";
/** Gap (s) at which the delta bar is full. */
const DELTA_FULL = 1;

/**
 * S1–S3 as three horizontal bars (F1 style). Done sectors are filled with their colour and show
 * the split, with the delta to your best underneath; the sector being driven is outlined and
 * pulses (never filled, so it can't be mistaken for a completed one).
 */
function SectorBars({ race }: { race: RaceUi }) {
  return (
    <ol className="mt-1.5 grid grid-cols-3 gap-1" aria-label="Sector times">
      {[0, 1, 2].map((i) => {
        const s: SectorResult | undefined = race.splits[i];
        const running = !race.splitsFromLastLap && race.sector === i;
        const style = s ? SECTOR_STYLE[s.status] : null;
        return (
          <li
            key={i}
            className="min-w-0"
            aria-label={
              s
                ? `Sector ${i + 1}: ${formatSplit(s.time)} seconds, ${style!.label}${s.delta === null ? "" : `, ${formatDelta(s.delta)}`}`
                : running
                  ? `Sector ${i + 1}: in progress`
                  : `Sector ${i + 1}: not timed yet`
            }
          >
            <div
              className={`flex h-4 items-center justify-center gap-1 rounded-sm px-1.5 text-[11px] leading-none font-bold tabular-nums ${
                s ? "" : "bg-white/12"
              }`}
              style={style ? { background: style.bg, color: style.fg } : undefined}
            >
              <span className="opacity-80">S{i + 1}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Upper-right timing panel: lap, running time, live delta, best lap and the sector bars. */
function TimerCard() {
  const game = useGame();
  const race = useGameState((s) => s.race);
  const raceable = useGameState((s) => s.raceable);
  const lapTimeRef = useRef<HTMLSpanElement>(null);
  const deltaRef = useRef<HTMLSpanElement>(null);
  const deltaFillRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let lastTime = "";
    let lastDelta = "";
    let lastFill = "";
    // The delta box remounts with the lap phase: a new element must be refreshed whatever the cache.
    let deltaEl: HTMLElement | null = null;
    let fillEl: HTMLElement | null = null;
    let shown: number | null = null;
    let last = performance.now();
    let nextText = 0;
    return game.onFrame((f) => {
      const t = formatTime(f.lapTime);
      if (t !== lastTime && lapTimeRef.current) {
        lapTimeRef.current.textContent = t;
        lastTime = t;
      }
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const target = f.delta;
      if (target === null) shown = null;
      else if (shown === null || Math.abs(target - shown) > 0.5) shown = target;
      else shown += (target - shown) * (1 - Math.exp(-dt / 0.12));

      const fill = deltaFillRef.current;
      if (fill !== fillEl) {
        fillEl = fill;
        lastFill = "";
      }
      if (fill) {
        const pct = shown === null ? 0 : Math.min(1, Math.abs(shown) / DELTA_FULL) * 100;
        const ahead = shown !== null && shown < 0;
        const key = `${ahead}${pct.toFixed(1)}`;
        if (key !== lastFill) {
          lastFill = key;
          fill.style.width = `${pct}%`;
          fill.style.left = ahead ? "0" : "auto";
          fill.style.right = ahead ? "auto" : "0";
          fill.style.background = ahead ? AHEAD : BEHIND;
        }
      }

      const el = deltaRef.current;
      if (el !== deltaEl) {
        deltaEl = el;
        lastDelta = "\u0000";
        nextText = 0;
      }
      if (now < nextText && shown !== null) return;
      nextText = now + 100;
      if (!el) return;
      const text = shown === null ? "" : formatDelta(Math.abs(shown) < 0.0005 ? 0 : shown);
      if (text === lastDelta) return;
      lastDelta = text;
      // The number stays in the HUD's text colour: the bar behind it carries green / red.
      el.textContent = text || "—";
    });
  }, [game]);

  const lastLap = race.lastLap ?? race.lastLap;
  // The all-time record, the lap the ghost replays (the session best is never faster).
  const best = race.recordLap;

  return (
    <div className="hud-card pointer-events-auto w-44 px-2.5 py-1.5 sm:w-60 sm:px-3 sm:py-2">
      {!raceable ? (
        <div className="text-xs">
          <div className="font-bold tracking-wide uppercase opacity-80">Free drive</div>
          <div className="opacity-70">Circuit incomplete: no timing</div>
        </div>
      ) : (
        <>
          <div className="flex items-baseline justify-start gap-2">
            <span className="text-[11px] font-bold tracking-widest uppercase opacity-70">
              {race.phase === "timing" ? `Lap ${race.lap}` : "Out lap"}
            </span>
          </div>

          <div className="flex justify-between text-[11px] tabular-nums">
            <span className="opacity-60">Last</span>
            <span className="font-bold">{formatTime(lastLap)}</span>
          </div>
          <div className="flex justify-between text-[11px] tabular-nums">
            <span className="opacity-60">Best</span>
            <span className="font-bold text-secondary">{formatTime(best)}</span>
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
              <SectorBars race={race} />
              {/* Live delta: the number over a horizontal gap bar (filled from the onFrame loop). */}
              <div className="relative mt-1.5 h-5 overflow-hidden rounded-sm bg-white/12">
                <div
                  ref={deltaFillRef}
                  className="absolute inset-y-0 left-0 w-0 opacity-75"
                  aria-hidden
                />
                <span
                  ref={deltaRef}
                  className="relative flex h-full items-center justify-center text-sm font-extrabold tabular-nums"
                  aria-label="Live gap to your best lap"
                >
                  —
                </span>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

/** Upper-left: every setting behind compact buttons (popover for the camera, dialogs for the rest). */
function Controls() {
  const game = useGame();
  const muted = useGameState((s) => s.muted);
  const camera = useGameState((s) => s.camera);
  const ghost = useGameState((s) => s.ghost);
  const ghostTime = useGameState((s) => s.ghostTime);
  const raceable = useGameState((s) => s.raceable);
  const screen = useGameState((s) => s.screen);
  const cameraLabel = CAMERA_MODES.find((c) => c.id === camera)?.label ?? "";
  const btn = "hud-btn btn btn-square btn-sm";

  return (
    <nav
      className="pointer-events-auto flex max-w-[calc(100vw-14.5rem)] flex-wrap items-center gap-1.5 sm:max-w-[calc(100vw-18rem)]"
      aria-label="Game controls"
    >
      <button
        className={btn}
        onClick={() => game.togglePause()}
        aria-label="Menu and pause (Esc)"
        title="Menu (Esc)"
      >
        <Menu className="size-4" />
      </button>
      <button
        className="hud-btn btn gap-1.5 px-2.5 btn-sm"
        onClick={() => game.openEditor()}
        title="Open the track editor"
      >
        <Pencil className="size-4" aria-hidden />
        <span className="max-md:sr-only">Edit track</span>
      </button>
      <div className="dropdown">
        <button
          tabIndex={0}
          className="hud-btn btn gap-1 px-2 btn-sm"
          aria-label={`Camera: ${cameraLabel}. Change camera (C)`}
          title={`Camera: ${cameraLabel} (C to cycle)`}
        >
          {CAMERA_ICONS[camera]}
          <ChevronDown className="size-3 opacity-70" aria-hidden />
        </button>
        <ul
          tabIndex={0}
          className="hud-card menu dropdown-content z-20 mt-1 w-44 rounded-box p-1 shadow-xl"
          role="radiogroup"
          aria-label="Camera"
        >
          {CAMERA_MODES.map((c) => (
            <li key={c.id}>
              <button
                role="radio"
                aria-checked={camera === c.id}
                className={camera === c.id ? "menu-active" : ""}
                onClick={() => {
                  game.setCamera(c.id);
                  (document.activeElement as HTMLElement | null)?.blur();
                }}
              >
                {CAMERA_ICONS[c.id]} {c.label}
              </button>
            </li>
          ))}
        </ul>
      </div>
      {raceable && (
        <button
          className={`${btn} ${ghost ? "" : "opacity-60"}`}
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
        className={btn}
        onClick={() => game.setMuted(!muted)}
        aria-label={muted ? "Unmute sound" : "Mute sound"}
        title={muted ? "Unmute" : "Mute"}
      >
        {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
      </button>
      <button
        className={btn}
        onClick={() => game.openOverlay("settings")}
        aria-label="Settings: view, sound, keys, ghost"
        title="Settings"
      >
        <Settings className="size-4" />
      </button>
      <button
        className={btn}
        onClick={() => game.openOverlay("circuits")}
        aria-label="Circuits"
        title="Circuits"
      >
        <MapIcon className="size-4" />
      </button>
      <button
        className={btn}
        onClick={() => game.resetKart()}
        disabled={screen !== "playing"}
        aria-label="Reset kart onto the track (R)"
        title="Reset onto the track (R)"
      >
        <RotateCcw className="size-4" />
      </button>
    </nav>
  );
}

/** In-race overlay. Per-frame values are written straight to the DOM, not through React state. */
export function Hud() {
  const game = useGame();
  const toast = useGameState((s) => s.toast);
  const stuck = useGameState((s) => s.stuckHint);
  const wrongWay = useGameState((s) => s.wrongWay);
  const muted = useGameState((s) => s.muted);
  const audio = useGameState((s) => s.audio);
  const screen = useGameState((s) => s.screen);
  const speedRef = useRef<HTMLSpanElement>(null);
  const offRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let lastSpeed = -1;
    let lastOff: boolean | null = null;
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
    });
  }, [game]);

  const playing = screen === "playing";

  return (
    <div className="hud-text pointer-events-none absolute inset-0 [padding:max(0.75rem,env(safe-area-inset-top))_max(0.75rem,env(safe-area-inset-right))_max(0.75rem,env(safe-area-inset-bottom))_max(0.75rem,env(safe-area-inset-left))]">
      <div className="relative h-full w-full">
        <div className="absolute top-0 left-0">
          <Controls />
        </div>

        <div className="absolute top-0 right-0">
          <TimerCard />
        </div>

        {/* Map: bottom right; on touch screens above the pedals (portrait) or beside them
            (landscape, where there is no room above). */}
        <div className="absolute right-0 bottom-0 [@media(pointer:coarse)]:bottom-44 [@media(pointer:coarse)_and_(orientation:landscape)]:right-56 [@media(pointer:coarse)_and_(orientation:landscape)]:bottom-0">
          <Minimap />
        </div>

        {/* Sound hint while the browser blocks audio. */}
        {audio === "locked" && !muted && playing && (
          <button
            className="hud-card pointer-events-auto absolute bottom-80 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full px-3 py-1.5 text-xs font-bold whitespace-nowrap sm:top-[22%] sm:bottom-auto"
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

        {/* Speed: bottom centre, clear of the map and the touch pedals. */}
        <div className="absolute bottom-0 left-1/2 -translate-x-1/2 text-center [@media(pointer:coarse)]:bottom-44 [@media(pointer:coarse)]:left-2 [@media(pointer:coarse)]:translate-x-0 [@media(pointer:coarse)_and_(orientation:landscape)]:top-[45%] [@media(pointer:coarse)_and_(orientation:landscape)]:bottom-auto">
          <span
            ref={speedRef}
            className="text-3xl leading-none font-extrabold tabular-nums sm:text-4xl"
          >
            0
          </span>
          <span className="ml-1 text-xs font-bold opacity-80">km/h</span>
        </div>

        <TouchControls />
      </div>
    </div>
  );
}
