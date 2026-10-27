"use client";

import { Map as MapIcon, Play } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatTime } from "@/game/RaceManager";
import { CIRCUIT_KINDS, CIRCUITS } from "@/game/track/circuits";
import { trackPreview } from "@/game/track/preview";
import { TrackThumb } from "./TrackThumb";
import { useGame } from "./useGame";

/** Built-in circuits: preview one, see your best lap on it and drive it. */
export function CircuitsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const game = useGame();
  const ref = useRef<HTMLDialogElement>(null);
  const circuits = useMemo(
    () =>
      CIRCUITS.map((c) => {
        const track = c.create();
        return { ...c, track, preview: trackPreview(track) };
      }),
    [],
  );
  const [selected, setSelected] = useState(circuits[0]!.id);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const sel = circuits.find((c) => c.id === selected) ?? circuits[0]!;

  return (
    <dialog ref={ref} className="modal" onClose={onClose} aria-labelledby="circuits-title">
      <div className="modal-box max-w-3xl">
        <h2 id="circuits-title" className="flex items-center gap-2 text-xl font-extrabold">
          <MapIcon className="size-5" aria-hidden /> Circuits
        </h2>

        <div className="mt-3 grid gap-3 md:grid-cols-[1fr_17rem]">
          <div className="max-h-[50vh] overflow-y-auto pr-1">
            {CIRCUIT_KINDS.map(({ kind, label }) => (
              <section key={kind} aria-label={label}>
                <h3 className="mt-2 mb-1 px-2 text-xs font-bold tracking-wide uppercase opacity-60">
                  {label}
                </h3>
                <ul>
                  {circuits
                    .filter((c) => c.kind === kind)
                    .map((c) => (
                      <li key={c.id}>
                        <button
                          className={`flex w-full items-center gap-3 rounded-box p-2 text-left hover:bg-base-content/10 ${
                            selected === c.id ? "bg-primary/15" : ""
                          }`}
                          onClick={() => setSelected(c.id)}
                          aria-pressed={selected === c.id}
                        >
                          <TrackThumb preview={c.preview} label={c.track.name} size={56} />
                          <span className="min-w-0 grow">
                            <span className="flex items-center gap-2 font-bold">
                              <span className="truncate">{c.track.name}</span>
                              {open && game.isCurrentTrack(c.track) && (
                                <span className="badge badge-sm badge-primary">Driving</span>
                              )}
                            </span>
                            <span className="block truncate text-xs opacity-70">
                              {c.description}
                            </span>
                            <span className="block text-xs tabular-nums opacity-70">
                              Best {open ? formatTime(game.bestLapOf(c.track)) : "–"}
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                </ul>
              </section>
            ))}
          </div>

          <aside className="rounded-box border border-base-content/15 p-3" aria-live="polite">
            <TrackThumb preview={sel.preview} label={sel.track.name} size={140} />
            <h3 className="mt-2 font-bold">{sel.track.name}</h3>
            <p className="mt-1 text-sm">{sel.description}</p>
            <p className="mt-1 text-xs tabular-nums opacity-70">
              {sel.track.pieces.length} pieces · your best lap{" "}
              {open ? formatTime(game.bestLapOf(sel.track)) : "–"}
            </p>
            <button
              className="btn mt-2 btn-primary btn-sm"
              onClick={() => game.loadCircuit(sel.create())}
            >
              <Play className="size-4" aria-hidden /> Drive
            </button>
          </aside>
        </div>

        <div className="modal-action">
          <button className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button aria-label="Close">close</button>
      </form>
    </dialog>
  );
}
