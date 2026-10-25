"use client";

import { Pause, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef } from "react";
import { formatTime } from "@/game/RaceManager";
import { Minimap } from "./Minimap";
import { TouchControls } from "./TouchControls";
import { useGame, useGameState } from "./useGame";

/** In-race overlay. Per-frame values are written straight to the DOM, not through React state. */
export function Hud() {
  const game = useGame();
  const mode = useGameState((s) => s.mode);
  const race = useGameState((s) => s.race);
  const countdown = useGameState((s) => s.countdown);
  const toast = useGameState((s) => s.toast);
  const stuck = useGameState((s) => s.stuckHint);
  const wrongWay = useGameState((s) => s.wrongWay);
  const muted = useGameState((s) => s.muted);
  const screen = useGameState((s) => s.screen);
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

  const trial = mode === "trial";
  const best = race.bestLap ?? race.recordLap;

  return (
    <div className="hud-text pointer-events-none absolute inset-0 [padding:max(0.75rem,env(safe-area-inset-top))_max(0.75rem,env(safe-area-inset-right))_max(0.75rem,env(safe-area-inset-bottom))_max(0.75rem,env(safe-area-inset-left))]">
      <div className="relative h-full w-full">
        {trial && (
          <div className="glass-panel absolute top-0 left-0 rounded-box px-4 py-2">
            <div className="text-xs font-bold tracking-widest uppercase opacity-70">
              Lap {race.lap}/{race.totalLaps}
            </div>
            <span ref={lapTimeRef} className="block text-3xl font-extrabold sm:text-4xl">
              0:00.000
            </span>
            <dl className="mt-1 grid grid-cols-[auto_auto] gap-x-3 text-xs sm:text-sm">
              <dt className="opacity-70">Last</dt>
              <dd className="text-right">{formatTime(race.laps.at(-1))}</dd>
              <dt className="opacity-70">Best</dt>
              <dd className="text-right text-secondary">{formatTime(best)}</dd>
            </dl>
          </div>
        )}

        <div className="pointer-events-auto absolute top-0 right-0 flex flex-col items-end gap-2">
          <div className="flex gap-2">
            <button
              className="glass-panel btn btn-circle btn-sm sm:btn-md"
              onClick={() => game.setMuted(!muted)}
              aria-label={muted ? "Unmute sound" : "Mute sound"}
              title={muted ? "Unmute" : "Mute"}
            >
              {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
            </button>
            <button
              className="glass-panel btn btn-circle btn-sm sm:btn-md"
              onClick={() => game.togglePause()}
              aria-label="Pause (Escape)"
              title="Pause (Esc)"
              disabled={screen !== "playing"}
            >
              <Pause className="size-4" />
            </button>
          </div>
          <Minimap />
        </div>

        {countdown !== null && (
          <div
            className="absolute top-[18%] left-1/2 flex -translate-x-1/2 flex-col items-center gap-3"
            role="status"
          >
            <div className="flex gap-2 rounded-full bg-black/60 px-4 py-3">
              {[0, 1, 2, 3, 4].map((i) => (
                <span
                  key={i}
                  className={`size-6 rounded-full border-2 border-black/50 sm:size-8 ${
                    countdown === "go" ? "bg-success" : countdown > i ? "bg-primary" : "bg-neutral"
                  }`}
                />
              ))}
            </div>
            {countdown === "go" && (
              <span className="text-6xl font-extrabold text-success">GO!</span>
            )}
          </div>
        )}

        <div
          className="absolute top-[34%] left-1/2 flex -translate-x-1/2 flex-col items-center gap-2 text-center"
          aria-live="polite"
        >
          {toast && (
            <div
              key={toast.id}
              className={`rounded-full px-4 py-1.5 text-sm font-bold shadow-lg sm:text-base ${
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
            className="rounded-full bg-warning px-4 py-1 text-sm font-bold text-warning-content opacity-0 shadow-lg transition-opacity"
          >
            Off track
          </div>
        </div>

        {stuck && (
          <div className="glass-panel absolute bottom-28 left-1/2 -translate-x-1/2 rounded-full px-4 py-2 text-sm whitespace-nowrap">
            Stuck? Press <kbd className="kbd kbd-sm">R</kbd> to get back on track
          </div>
        )}

        <div className="absolute right-0 bottom-0 text-right [@media(pointer:coarse)]:top-14 [@media(pointer:coarse)]:bottom-auto sm:[@media(pointer:coarse)]:top-16">
          <span ref={speedRef} className="text-5xl leading-none font-extrabold sm:text-6xl">
            0
          </span>
          <span className="ml-1 text-base font-bold opacity-80 sm:text-lg">km/h</span>
        </div>

        <TouchControls />
      </div>
    </div>
  );
}
