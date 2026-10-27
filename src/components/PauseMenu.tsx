"use client";

import { Flag, Keyboard, Pencil, Play, Settings, Share2 } from "lucide-react";
import Image from "next/image";
import { useState } from "react";
import { LIVERIES } from "@/game/assets";
import { CAMERA_MODES } from "@/game/Camera";
import { formatTime } from "@/game/RaceManager";
import { HelpPanel } from "./HelpPanel";
import { ShareDialog } from "./ShareDialog";
import { useGame, useGameState } from "./useGame";

/** Pause overlay doubling as the settings menu: kart colour, camera, controls, sharing. */
export function PauseMenu() {
  const game = useGame();
  const livery = useGameState((s) => s.livery);
  const camera = useGameState((s) => s.camera);
  const quality = useGameState((s) => s.quality);
  const qualityActive = useGameState((s) => s.qualityActive);
  const trackName = useGameState((s) => s.trackName);
  const record = useGameState((s) => s.race.recordLap);
  const [help, setHelp] = useState(false);
  const [share, setShare] = useState(false);

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/35 p-4">
      <div
        className="hud-card max-h-full w-full max-w-sm overflow-y-auto p-5 shadow-2xl"
        role="dialog"
        aria-label="Paused"
      >
        <div className="flex items-center gap-3">
          <Image src="/logo.png" alt="" width={44} height={44} className="rounded-xl" />
          <div>
            <h2 className="text-xl font-extrabold">Paused</h2>
            <p className="text-xs opacity-70">
              {trackName} · Record <span className="tabular-nums">{formatTime(record)}</span>
            </p>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2">
          <button className="btn col-span-2 btn-primary" onClick={() => game.resume()} autoFocus>
            <Play className="size-4" aria-hidden /> Resume
          </button>
          <button className="btn btn-sm" onClick={() => game.restartLap()}>
            <Flag className="size-4" aria-hidden /> Restart lap
          </button>
          <button className="btn btn-sm" onClick={() => game.openEditor()}>
            <Pencil className="size-4" aria-hidden /> Edit track
          </button>
          <button className="btn btn-sm" onClick={() => setShare(true)}>
            <Share2 className="size-4" aria-hidden /> Share
          </button>
          <button className="btn btn-sm" onClick={() => setHelp(true)}>
            <Keyboard className="size-4" aria-hidden /> Controls
          </button>
          <button className="btn col-span-2 btn-sm" onClick={() => game.openOverlay("settings")}>
            <Settings className="size-4" aria-hidden /> Settings: view, sound, keys, ghost
          </button>
        </div>

        <fieldset className="mt-5">
          <legend className="mb-2 text-xs font-bold tracking-wide uppercase opacity-70">
            Camera
          </legend>
          <div className="join w-full" role="radiogroup">
            {CAMERA_MODES.map((c) => (
              <button
                key={c.id}
                role="radio"
                aria-checked={camera === c.id}
                className={`btn join-item flex-1 btn-sm ${camera === c.id ? "btn-primary" : ""}`}
                onClick={() => game.setCamera(c.id)}
              >
                {c.label}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset className="mt-4">
          <legend className="mb-2 text-xs font-bold tracking-wide uppercase opacity-70">
            Graphics
          </legend>
          <div className="join w-full" role="radiogroup">
            {(
              [
                ["auto", "Auto"],
                ["high", "High"],
                ["performance", "Performance"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                role="radio"
                aria-checked={quality === id}
                className={`btn join-item flex-1 btn-sm ${quality === id ? "btn-primary" : ""}`}
                onClick={() => game.setQuality(id)}
              >
                {label}
              </button>
            ))}
          </div>
          {quality === "auto" && (
            <p className="mt-1 text-[11px] opacity-60">
              Currently{" "}
              {qualityActive === "high" ? "high" : "performance (switched for frame rate)"}.
            </p>
          )}
        </fieldset>

        <fieldset className="mt-4">
          <legend className="mb-2 text-xs font-bold tracking-wide uppercase opacity-70">
            Kart colour
          </legend>
          <div className="flex gap-2" role="radiogroup">
            {LIVERIES.map((l) => (
              <button
                key={l.id}
                role="radio"
                aria-checked={livery === l.id}
                aria-label={l.label}
                title={l.label}
                onClick={() => game.setLivery(l.id)}
                className={`size-9 rounded-full border-4 transition-transform ${
                  livery === l.id
                    ? "scale-110 border-primary"
                    : "border-white/20 hover:border-white/50"
                }`}
                style={{ background: l.color }}
              />
            ))}
          </div>
        </fieldset>
      </div>
      <HelpPanel open={help} onClose={() => setHelp(false)} />
      <ShareDialog open={share} onClose={() => setShare(false)} source="game" />
    </div>
  );
}
