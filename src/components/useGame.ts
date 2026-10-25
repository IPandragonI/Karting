"use client";

import { createContext, useContext, useSyncExternalStore } from "react";
import type { Game, UiState } from "@/game/Game";

export const GameContext = createContext<Game | null>(null);

export function useGame(): Game {
  const game = useContext(GameContext);
  if (!game) throw new Error("useGame must be used inside <GameContext>");
  return game;
}

export function useGameState<T>(select: (s: UiState) => T): T {
  const game = useGame();
  return useSyncExternalStore(
    game.store.subscribe,
    () => select(game.store.get()),
    () => select(game.store.get()),
  );
}
