"use client";

import dynamic from "next/dynamic";
import { LoadingScreen } from "./LoadingScreen";

// WebGL and the physics engine only exist in the browser: the whole game view is client-only.
const GameView = dynamic(() => import("./GameView").then((m) => m.GameView), {
  ssr: false,
  loading: () => <LoadingScreen progress={0} />,
});

export function GameShell() {
  return <GameView />;
}
