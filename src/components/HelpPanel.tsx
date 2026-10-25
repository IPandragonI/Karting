"use client";

import { useEffect, useRef } from "react";

const CONTROLS: [string[], string][] = [
  [["W", "↑"], "Accelerate"],
  [["S", "↓"], "Brake / reverse"],
  [["A", "←"], "Steer left"],
  [["D", "→"], "Steer right"],
  [["Space"], "Handbrake / drift (hold while steering)"],
  [["R"], "Reset to the track"],
  [["Esc"], "Pause / menu"],
];

/** Controls reference as a native modal dialog (focus trap and Escape handled by the browser). */
export function HelpPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog ref={ref} className="modal" onClose={onClose} aria-labelledby="help-title">
      <div className="modal-box max-w-md">
        <h2 id="help-title" className="text-xl font-extrabold">
          Controls
        </h2>
        <table className="table mt-3 table-sm">
          <tbody>
            {CONTROLS.map(([keys, action]) => (
              <tr key={action}>
                <td className="whitespace-nowrap">
                  {keys.map((k, i) => (
                    <span key={k}>
                      {i > 0 && <span className="mx-1 opacity-50">/</span>}
                      <kbd className="kbd kbd-sm">{k}</kbd>
                    </span>
                  ))}
                </td>
                <td>{action}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-sm opacity-75">
          Drift: hold <kbd className="kbd kbd-xs">Space</kbd> while turning at speed. Steer into the
          drift to tighten the line, counter-steer to open it. On touch screens use the on-screen
          pedals and arrows. Gamepads work too.
        </p>
        <div className="modal-action">
          <button className="btn btn-primary" onClick={onClose}>
            Got it
          </button>
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button aria-label="Close">close</button>
      </form>
    </dialog>
  );
}
