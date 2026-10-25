"use client";

import { RotateCcw, Trophy } from "lucide-react";
import { formatTime } from "@/game/RaceManager";
import { useGame, useGameState } from "./useGame";

export function FinishPanel() {
  const game = useGame();
  const finish = useGameState((s) => s.finish);
  const fromEditor = useGameState((s) => s.fromEditor);
  if (!finish) return null;
  const best = Math.min(...finish.laps);
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/40 p-4">
      <div
        className="glass-panel w-full max-w-sm rounded-box p-6 shadow-2xl"
        role="dialog"
        aria-label="Race results"
      >
        <div className="flex items-center gap-3">
          <Trophy className="size-8 text-secondary" aria-hidden />
          <h2 className="text-2xl font-extrabold">Finished!</h2>
        </div>
        {finish.newRecord && (
          <div className="mt-3 rounded-field bg-success px-3 py-1.5 text-sm font-bold text-success-content">
            New track record: {formatTime(finish.bestLap)}
          </div>
        )}
        <table className="table mt-4 table-sm">
          <tbody>
            {finish.laps.map((t, i) => (
              <tr key={i}>
                <td className="opacity-70">Lap {i + 1}</td>
                <td
                  className={`text-right tabular-nums ${t === best ? "font-bold text-secondary" : ""}`}
                >
                  {formatTime(t)}
                </td>
              </tr>
            ))}
            <tr>
              <td className="font-bold">Total</td>
              <td className="text-right font-bold tabular-nums">{formatTime(finish.total)}</td>
            </tr>
          </tbody>
        </table>
        <div className="mt-5 flex flex-col gap-3">
          <button className="btn btn-primary" onClick={() => game.restart()} autoFocus>
            <RotateCcw className="size-4" aria-hidden /> Race again
          </button>
          {fromEditor && (
            <button className="btn" onClick={() => game.openEditor()}>
              Back to editor
            </button>
          )}
          <button className="btn" onClick={() => game.quitToMenu()}>
            Main menu
          </button>
        </div>
      </div>
    </div>
  );
}
