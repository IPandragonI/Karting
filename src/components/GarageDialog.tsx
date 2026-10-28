"use client";

import { Check, ChevronLeft, ChevronRight, Warehouse } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { LIVERIES, VEHICLES, type VehicleId } from "@/game/assets";
import { ENGINES } from "@/game/audio/engineDsp";
import { GaragePreview } from "@/game/GaragePreview";
import { useGame, useGameState } from "./useGame";

/** Garage: browse the vehicles on a turntable and confirm one. */
export function GarageDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const game = useGame();
  const current = useGameState((s) => s.vehicle);
  const liveryId = useGameState((s) => s.livery);
  const ref = useRef<HTMLDialogElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<GaragePreview | null>(null);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  // The preview (its own WebGL context) only exists while the garage is open.
  useEffect(() => {
    const models = game.getModels();
    const stage = stageRef.current;
    if (!open || !models || !stage) return;
    const livery = LIVERIES.find((l) => l.id === liveryId) ?? LIVERIES[0];
    const preview = new GaragePreview(stage, models, livery.color);
    previewRef.current = preview;
    preview.start();
    return () => {
      preview.dispose();
      previewRef.current = null;
    };
  }, [open, game, liveryId]);

  // Opening the garage starts on the vehicle being driven (adjusted while rendering, only on the
  // opening itself: browsing must not snap back when the selection changes).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open)
      setIndex(
        Math.max(
          0,
          VEHICLES.findIndex((v) => v.id === current),
        ),
      );
  }

  const vehicle = VEHICLES[index]!;
  useEffect(() => {
    if (open) previewRef.current?.show(vehicle.id);
  }, [open, vehicle.id, liveryId]);

  const browse = (step: number) => setIndex((i) => (i + step + VEHICLES.length) % VEHICLES.length);
  const select = (id: VehicleId) => {
    game.setVehicle(id);
    onClose();
  };
  const engine = ENGINES[vehicle.engine];
  const selected = vehicle.id === current;

  return (
    <dialog
      ref={ref}
      className="modal"
      onClose={onClose}
      aria-labelledby="garage-title"
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") browse(-1);
        else if (e.key === "ArrowRight") browse(1);
        else return;
        e.preventDefault();
      }}
    >
      <div className="modal-box max-w-3xl overflow-hidden p-0">
        <div className="flex items-center justify-between px-5 pt-4">
          <h2 id="garage-title" className="flex items-center gap-2 text-xl font-extrabold">
            <Warehouse className="size-5" aria-hidden /> Garage
          </h2>
          <span className="text-xs tabular-nums opacity-60">
            {index + 1} / {VEHICLES.length}
          </span>
        </div>

        <div className="relative mt-2 bg-[radial-gradient(ellipse_at_50%_35%,#3a4150_0%,#1b1e24_70%)]">
          <div
            ref={stageRef}
            className="aspect-[16/10] max-h-[52vh] w-full cursor-grab touch-none active:cursor-grabbing"
            aria-label={`${vehicle.label}, rotating preview (drag to turn)`}
            role="img"
          />
          <button
            className="btn absolute top-1/2 left-3 btn-circle -translate-y-1/2 bg-black/30 btn-ghost text-white hover:bg-black/50"
            onClick={() => browse(-1)}
            aria-label="Previous vehicle"
          >
            <ChevronLeft className="size-6" />
          </button>
          <button
            className="btn absolute top-1/2 right-3 btn-circle -translate-y-1/2 bg-black/30 btn-ghost text-white hover:bg-black/50"
            onClick={() => browse(1)}
            aria-label="Next vehicle"
          >
            <ChevronRight className="size-6" />
          </button>
          <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 gap-1.5" role="tablist">
            {VEHICLES.map((v, i) => (
              <button
                key={v.id}
                role="tab"
                aria-selected={i === index}
                aria-label={v.label}
                className={`h-2 rounded-full transition-all ${
                  i === index ? "w-6 bg-primary" : "w-2 bg-white/40 hover:bg-white/70"
                }`}
                onClick={() => setIndex(i)}
              />
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-3 px-5 pt-3 pb-5">
          <div className="min-w-0 grow" aria-live="polite">
            <h3 className="flex items-center gap-2 text-lg font-extrabold">
              {vehicle.label}
              {selected && <span className="badge badge-sm badge-primary">Driving</span>}
            </h3>
            <p className="text-sm opacity-80">{vehicle.description}</p>
            <p className="mt-1 text-xs tabular-nums opacity-60">
              {engine.cylinders} cylinders ·{" "}
              {engine.gears.length > 1 ? `${engine.gears.length}-speed` : "no gearbox"} · redline{" "}
              {engine.redline.toLocaleString("en")} rpm · same handling for every vehicle
            </p>
          </div>
          <div className="flex gap-2">
            <button className="btn" onClick={onClose}>
              Close
            </button>
            <button
              className="btn btn-primary"
              onClick={() => select(vehicle.id)}
              disabled={selected}
              autoFocus
            >
              <Check className="size-4" aria-hidden /> {selected ? "Selected" : "Select"}
            </button>
          </div>
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button aria-label="Close">close</button>
      </form>
    </dialog>
  );
}
