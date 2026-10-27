"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Game, type Overlay } from "@/game/Game";
import { CircuitsDialog } from "./CircuitsDialog";
import { EditorToolbar } from "./EditorToolbar";
import { GarageDialog } from "./GarageDialog";
import { GameContext } from "./useGame";
import { Hud } from "./Hud";
import { PerfOverlay } from "./PerfOverlay";
import { LoadingScreen } from "./LoadingScreen";
import { PauseMenu } from "./PauseMenu";
import { SettingsDialog } from "./SettingsDialog";

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
    case "paused":
      return (
        <>
          <Hud />
          {!state.overlay && <PauseMenu />}
          <OverlayPanels game={game} overlay={state.overlay} />
          <PerfOverlay />
        </>
      );
    case "editor":
      return <EditorToolbar />;
    default:
      return (
        <>
          <Hud />
          <PerfOverlay />
        </>
      );
  }
}

/** Panels opened from the HUD over the (paused) game. */
function OverlayPanels({ game, overlay }: { game: Game; overlay: Overlay | null }) {
  const close = () => game.closeOverlay();
  return (
    <>
      <SettingsDialog open={overlay === "settings"} onClose={close} />
      <CircuitsDialog open={overlay === "circuits"} onClose={close} />
      <GarageDialog open={overlay === "garage"} onClose={close} />
    </>
  );
}
