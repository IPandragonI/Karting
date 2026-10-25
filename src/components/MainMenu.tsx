"use client";

import { Flag, Keyboard, Pencil, Share2, Timer } from "lucide-react";
import { useState } from "react";
import { KART_LIVERY, KART_MODELS } from "@/game/assets";
import { formatTime } from "@/game/RaceManager";
import { HelpPanel } from "./HelpPanel";
import { ShareDialog } from "./ShareDialog";
import { useGame, useGameState } from "./useGame";

export function MainMenu() {
  const game = useGame();
  const trackName = useGameState((s) => s.trackName);
  const raceable = useGameState((s) => s.raceable);
  const record = useGameState((s) => s.race.recordLap);
  const kartModel = useGameState((s) => s.kartModel);
  const [help, setHelp] = useState(false);
  const [share, setShare] = useState(false);
  const toast = useGameState((s) => s.toast);

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-t from-black/40 to-transparent p-4">
      <div className="glass-panel max-h-full w-full max-w-sm overflow-y-auto rounded-box p-6 shadow-2xl [@media(max-height:520px)]:max-w-2xl [@media(max-height:520px)]:p-4">
        <h1 className="text-3xl font-extrabold tracking-tight">
          Low-Poly <span className="text-primary">Karting</span>
        </h1>
        <p className="mt-1 text-sm opacity-70">
          {trackName} · Best lap <span className="tabular-nums">{formatTime(record)}</span>
        </p>

        <div className="[@media(max-height:520px)]:grid [@media(max-height:520px)]:grid-cols-2 [@media(max-height:520px)]:gap-x-6">
          <div className="mt-6 flex flex-col gap-3 [@media(max-height:520px)]:mt-3">
            <button
              className="btn btn-lg btn-primary"
              onClick={() => game.startDriving("trial")}
              disabled={!raceable}
              autoFocus
            >
              <Timer className="size-5" aria-hidden /> Time Trial
            </button>
            {!raceable && (
              <p className="-mt-1 text-xs text-warning">
                Fix the circuit in the editor to race against the clock.
              </p>
            )}
            <button className="btn btn-lg" onClick={() => game.startDriving("free")}>
              <Flag className="size-5" aria-hidden /> Free Drive
            </button>
            <div className="grid grid-cols-2 gap-3">
              <button className="btn" onClick={() => game.openEditor()}>
                <Pencil className="size-4" aria-hidden /> Track editor
              </button>
              <button className="btn" onClick={() => setShare(true)}>
                <Share2 className="size-4" aria-hidden /> Share
              </button>
            </div>
          </div>

          <div>
            <fieldset className="mt-6 [@media(max-height:520px)]:mt-3">
              <legend className="mb-2 text-sm font-bold opacity-80">Driver</legend>
              <div className="flex gap-2" role="radiogroup">
                {KART_MODELS.map((m, i) => (
                  <button
                    key={m}
                    role="radio"
                    aria-checked={kartModel === m}
                    aria-label={`Driver ${i + 1}`}
                    title={`Driver ${i + 1}`}
                    onClick={() => game.setKartModel(m)}
                    className={`size-10 rounded-full border-4 transition-transform ${
                      kartModel === m
                        ? "scale-110 border-primary"
                        : "border-transparent opacity-80 hover:opacity-100"
                    }`}
                    style={{ background: KART_LIVERY[m] }}
                  />
                ))}
              </div>
            </fieldset>

            <button className="btn mt-6 w-full btn-ghost btn-sm" onClick={() => setHelp(true)}>
              <Keyboard className="size-4" aria-hidden /> Controls
            </button>
          </div>
        </div>
      </div>
      <HelpPanel open={help} onClose={() => setHelp(false)} />
      <ShareDialog open={share} onClose={() => setShare(false)} source="menu" />
      {toast && (
        <div
          key={toast.id}
          role="status"
          className={`absolute top-4 left-1/2 -translate-x-1/2 rounded-full px-4 py-1.5 text-sm font-bold shadow-lg ${
            toast.tone === "warning"
              ? "bg-warning text-warning-content"
              : "bg-success text-success-content"
          }`}
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}
