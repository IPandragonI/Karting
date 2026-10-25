"use client";

import { ChevronLeft, ChevronRight, ChevronsDown, ChevronsUp, Wind } from "lucide-react";
import { useEffect, useState } from "react";
import type { TouchControl } from "@/game/InputManager";
import { useGame } from "./useGame";

/** Large on-screen buttons for touch devices. Multi-touch: each button tracks its own pointer. */
export function TouchControls() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const coarse = window.matchMedia("(pointer: coarse)");
    // Reading a media query is an external subscription; sync it once on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVisible(coarse.matches);
    const onTouch = () => setVisible(true);
    window.addEventListener("touchstart", onTouch, { once: true, passive: true });
    return () => window.removeEventListener("touchstart", onTouch);
  }, []);

  if (!visible) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-4">
      <div className="flex gap-3">
        <Pad control="left" label="Steer left">
          <ChevronLeft className="size-10" />
        </Pad>
        <Pad control="right" label="Steer right">
          <ChevronRight className="size-10" />
        </Pad>
      </div>
      <div className="flex items-end gap-3">
        <Pad control="drift" label="Drift" small>
          <Wind className="size-7" />
        </Pad>
        <div className="flex flex-col gap-3">
          <Pad control="gas" label="Accelerate" tone="primary">
            <ChevronsUp className="size-10" />
          </Pad>
          <Pad control="brake" label="Brake / reverse" small>
            <ChevronsDown className="size-7" />
          </Pad>
        </div>
      </div>
    </div>
  );
}

function Pad({
  control,
  label,
  children,
  small,
  tone,
}: {
  control: TouchControl;
  label: string;
  children: React.ReactNode;
  small?: boolean;
  tone?: "primary";
}) {
  const game = useGame();
  const [pressed, setPressed] = useState(false);
  const set = (v: boolean) => {
    setPressed(v);
    game.input.setTouch(control, v);
  };
  return (
    <button
      type="button"
      aria-label={label}
      className={`pointer-events-auto grid touch-none place-items-center rounded-full border-2 border-white/25 shadow-lg backdrop-blur-sm transition-transform select-none ${
        small ? "size-16" : "size-20"
      } ${tone === "primary" ? "bg-primary/70" : "bg-black/35"} ${pressed ? "scale-95 brightness-125" : ""}`}
      onPointerDown={(e) => {
        set(true);
        // Capture keeps the press alive when the finger slides off; best effort only.
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // Pointer already gone (cancelled touch): the press still registers.
        }
      }}
      onPointerUp={() => set(false)}
      onPointerCancel={() => set(false)}
      onLostPointerCapture={() => set(false)}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </button>
  );
}
