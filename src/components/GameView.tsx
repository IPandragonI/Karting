"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Game } from "@/game/Game";
import { EditorToolbar } from "./EditorToolbar";
import { GameContext } from "./useGame";
import { FinishPanel } from "./FinishPanel";
import { Hud } from "./Hud";
import { LoadingScreen } from "./LoadingScreen";
import { MainMenu } from "./MainMenu";
import { PauseMenu } from "./PauseMenu";

export function GameView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [game, setGame] = useState<Game | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const g = new Game(canvas);
    setGame(g);
    void g.init(g.initialTrack());
    if (process.env.NODE_ENV !== "production") (window as unknown as { __game?: Game }).__game = g;
    return () => {
      g.dispose();
      setGame(null);
    };
  }, []);

  return (
    <div className="absolute inset-0 touch-none">
      <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full outline-none" />
      {game && (
        <GameContext value={game}>
          <Overlays game={game} />
        </GameContext>
      )}
    </div>
  );
}

function Overlays({ game }: { game: Game }) {
  const state = useSyncExternalStore(game.store.subscribe, game.store.get, game.store.get);
  switch (state.screen) {
    case "loading":
      return <LoadingScreen progress={state.loadProgress} />;
    case "error":
      return (
        <div className="absolute inset-0 grid place-items-center bg-base-200 p-6">
          <div role="alert" className="alert max-w-md alert-error">
            {state.error}
          </div>
        </div>
      );
    case "menu":
      return <MainMenu />;
    case "paused":
      return (
        <>
          <Hud />
          <PauseMenu />
        </>
      );
    case "editor":
      return <EditorToolbar />;
    case "finished":
      return (
        <>
          <Hud />
          <FinishPanel />
        </>
      );
    default:
      return <Hud />;
  }
}
