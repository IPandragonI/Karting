"use client";

import { Keyboard, Pencil, Play, RotateCcw } from "lucide-react";
import { useState } from "react";
import { HelpPanel } from "./HelpPanel";
import { useGame, useGameState } from "./useGame";

export function PauseMenu() {
  const game = useGame();
  const mode = useGameState((s) => s.mode);
  const fromEditor = useGameState((s) => s.fromEditor);
  const [help, setHelp] = useState(false);
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/40 p-4">
      <div
        className="glass-panel w-full max-w-xs rounded-box p-6 shadow-2xl"
        role="dialog"
        aria-label="Paused"
      >
        <h2 className="text-2xl font-extrabold">Paused</h2>
        <div className="mt-5 flex flex-col gap-3">
          <button className="btn btn-primary" onClick={() => game.resume()} autoFocus>
            <Play className="size-4" aria-hidden /> Resume
          </button>
          <button className="btn" onClick={() => game.restart()}>
            <RotateCcw className="size-4" aria-hidden />{" "}
            {mode === "trial" ? "Restart race" : "Back to the grid"}
          </button>
          {fromEditor && (
            <button className="btn" onClick={() => game.openEditor()}>
              <Pencil className="size-4" aria-hidden /> Back to editor
            </button>
          )}
          <button className="btn" onClick={() => setHelp(true)}>
            <Keyboard className="size-4" aria-hidden /> Controls
          </button>
          <button className="btn btn-ghost" onClick={() => game.quitToMenu()}>
            Main menu
          </button>
        </div>
      </div>
      <HelpPanel open={help} onClose={() => setHelp(false)} />
    </div>
  );
}
