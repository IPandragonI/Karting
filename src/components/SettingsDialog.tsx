"use client";

import { AlertTriangle, Keyboard, RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { defaultFov, FOV_RANGE } from "@/game/Camera";
import {
  assignKey,
  BINDABLE_ACTIONS,
  keyLabel,
  RESERVED_KEYS,
  type BindableAction,
} from "@/game/InputManager";
import { useGame, useGameState } from "./useGame";

type Capture = { action: BindableAction; slot: 0 | 1 } | null;

const ESSENTIAL: BindableAction[] = ["accelerate", "brake", "left", "right"];

/** Browsers that expose the keyboard layout (Chromium) show the real key caps, e.g. "Z" on AZERTY. */
function useLayoutMap() {
  const [map, setMap] = useState<Map<string, string> | null>(null);
  useEffect(() => {
    const kb = (navigator as { keyboard?: { getLayoutMap?: () => Promise<Map<string, string>> } })
      .keyboard;
    kb?.getLayoutMap?.()
      .then((m) => setMap(new Map(m)))
      .catch(() => {});
  }, []);
  return map;
}

/**
 * Comfort settings as a native modal dialog: camera fields of view, volume, ghost, and key
 * remapping. Every change applies immediately and is saved; nothing to confirm.
 */
export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const game = useGame();
  const fov = useGameState((s) => s.fov);
  const volume = useGameState((s) => s.volume);
  const muted = useGameState((s) => s.muted);
  const ghost = useGameState((s) => s.ghost);
  const bindings = useGameState((s) => s.bindings);
  const layout = useLayoutMap();
  const ref = useRef<HTMLDialogElement>(null);
  const [capture, setCapture] = useState<Capture>(null);
  const [notice, setNotice] = useState<{ text: string; warn: boolean } | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  // Never leave the keyboard captured when the dialog goes away.
  useEffect(() => {
    if (!open) game.cancelCapture();
    return () => game.cancelCapture();
  }, [open, game]);

  const close = () => {
    game.cancelCapture();
    setCapture(null);
    setNotice(null);
    onClose();
  };

  const label = (id: BindableAction) => BINDABLE_ACTIONS.find((a) => a.id === id)!.label;

  const startCapture = (action: BindableAction, slot: 0 | 1) => {
    setCapture({ action, slot });
    setNotice(null);
    game.captureKey((code) => {
      setCapture(null);
      if (code === null) return; // Escape: cancelled.
      if (RESERVED_KEYS.has(code)) {
        setNotice({
          text: `${keyLabel(code, layout)} is reserved and can't be bound.`,
          warn: true,
        });
        return;
      }
      const result = assignKey(game.store.get().bindings, action, slot, code);
      game.setBindings(result.bindings);
      setNotice(
        result.displaced
          ? {
              text: `${keyLabel(code, layout)} was used for “${label(result.displaced)}”; it now does “${label(action)}” only.`,
              warn: true,
            }
          : { text: `${label(action)}: ${keyLabel(code, layout)}`, warn: false },
      );
    });
  };

  const clearSlot = (action: BindableAction, slot: 0 | 1) => {
    game.setBindings(assignKey(bindings, action, slot, null).bindings);
    setNotice(null);
  };

  const unbound = ESSENTIAL.filter((a) => !bindings[a][0] && !bindings[a][1]);

  return (
    <dialog
      ref={ref}
      className="modal"
      onClose={close}
      onCancel={(e) => {
        // Escape while waiting for a key cancels the capture, not the dialog.
        if (capture) e.preventDefault();
      }}
      aria-labelledby="settings-title"
    >
      <div className="modal-box max-w-lg">
        <h2 id="settings-title" className="text-xl font-extrabold">
          Settings
        </h2>

        <section className="mt-4" aria-labelledby="settings-view">
          <h3 id="settings-view" className="text-xs font-bold tracking-wide uppercase opacity-70">
            Camera field of view
          </h3>
          {(
            [
              ["chase", "Chase"],
              ["first", "First person"],
            ] as const
          ).map(([mode, name]) => (
            <label key={mode} className="mt-2 grid grid-cols-[7rem_1fr_3.2rem] items-center gap-3">
              <span className="text-sm">{name}</span>
              <input
                type="range"
                className="range range-primary range-xs"
                min={FOV_RANGE.min}
                max={FOV_RANGE.max}
                step={1}
                value={fov[mode]}
                onChange={(e) => game.setFov(mode, Number(e.target.value))}
                aria-valuetext={`${fov[mode]} degrees`}
              />
              <span className="text-right text-sm tabular-nums">
                {fov[mode]}°
                {fov[mode] === defaultFov(mode) && <span className="sr-only"> (default)</span>}
              </span>
            </label>
          ))}
          <p className="mt-1 text-[11px] opacity-60">
            Wider shows more around the kart and feels faster. The elevated camera keeps its own
            framing.
          </p>
        </section>

        <section className="mt-5" aria-labelledby="settings-sound">
          <h3 id="settings-sound" className="text-xs font-bold tracking-wide uppercase opacity-70">
            Sound
          </h3>
          <label className="mt-2 grid grid-cols-[7rem_1fr_3.2rem] items-center gap-3">
            <span className="text-sm">Master volume</span>
            <input
              type="range"
              className="range range-primary range-xs"
              min={0}
              max={100}
              step={1}
              value={Math.round(volume * 100)}
              onChange={(e) => game.setVolume(Number(e.target.value) / 100)}
              disabled={muted}
              aria-valuetext={`${Math.round(volume * 100)} percent`}
            />
            <span className="text-right text-sm tabular-nums">{Math.round(volume * 100)}%</span>
          </label>
          <label className="mt-2 flex cursor-pointer items-center gap-3 text-sm">
            <input
              type="checkbox"
              className="toggle toggle-sm"
              checked={muted}
              onChange={(e) => game.setMuted(e.target.checked)}
            />
            Mute
          </label>
        </section>

        <section className="mt-5" aria-labelledby="settings-race">
          <h3 id="settings-race" className="text-xs font-bold tracking-wide uppercase opacity-70">
            Time trial
          </h3>
          <label className="mt-2 flex cursor-pointer items-center gap-3 text-sm">
            <input
              type="checkbox"
              className="toggle toggle-info toggle-sm"
              checked={ghost}
              onChange={(e) => game.setGhost(e.target.checked)}
            />
            Show best lap ghost
          </label>
        </section>

        <section className="mt-5" aria-labelledby="settings-keys">
          <h3
            id="settings-keys"
            className="flex items-center gap-2 text-xs font-bold tracking-wide uppercase opacity-70"
          >
            <Keyboard className="size-4" aria-hidden /> Keyboard
          </h3>
          <table className="table mt-1 table-sm">
            <tbody>
              {BINDABLE_ACTIONS.map(({ id, label: name }) => (
                <tr key={id}>
                  <td className="w-full py-1 text-sm">{name}</td>
                  {([0, 1] as const).map((slot) => {
                    const waiting = capture?.action === id && capture.slot === slot;
                    const code = bindings[id][slot];
                    return (
                      <td key={slot} className="py-1">
                        <div className="join">
                          <button
                            className={`btn join-item min-w-20 btn-sm ${waiting ? "animate-pulse btn-primary" : ""}`}
                            onClick={() => startCapture(id, slot)}
                            aria-label={`${name}, ${slot === 0 ? "main" : "second"} key: ${keyLabel(code, layout)}. Press to change.`}
                          >
                            {waiting ? "Press a key…" : keyLabel(code, layout)}
                          </button>
                          {code && !waiting && (
                            <button
                              className="btn join-item btn-ghost px-1.5 btn-sm"
                              onClick={() => clearSlot(id, slot)}
                              aria-label={`Clear ${name} ${slot === 0 ? "main" : "second"} key`}
                            >
                              <X className="size-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 min-h-5 text-xs" aria-live="polite">
            {capture ? (
              <span className="opacity-75">
                Press the new key for “{label(capture.action)}” · Esc cancels
              </span>
            ) : notice ? (
              <span className={notice.warn ? "text-warning" : "opacity-75"}>{notice.text}</span>
            ) : unbound.length > 0 ? (
              <span className="flex items-center gap-1 text-warning">
                <AlertTriangle className="size-3.5" aria-hidden />
                No key for: {unbound.map(label).join(", ")}
              </span>
            ) : (
              <span className="opacity-60">
                Esc (menu) and F3 (performance overlay) are fixed. Gamepads and touch controls are
                not affected.
              </span>
            )}
          </p>
        </section>

        <div className="modal-action justify-between">
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => {
              game.resetSettings();
              setNotice({ text: "Settings restored to their defaults.", warn: false });
            }}
          >
            <RotateCcw className="size-4" aria-hidden /> Restore defaults
          </button>
          <button className="btn btn-primary" onClick={close}>
            Done
          </button>
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button aria-label="Close">close</button>
      </form>
    </dialog>
  );
}
