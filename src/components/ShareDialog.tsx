"use client";

import { Check, ClipboardCopy, Download, Link2, Upload } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import {
  fromJson,
  MAX_URL_PARAM,
  encodeTrack,
  shareUrl,
  toJson,
} from "@/game/track/TrackSerializer";
import type { TrackData } from "@/game/track/Track";
import { useGame } from "./useGame";

/**
 * Share / export / import. From the editor, imports replace the circuit being edited (undoable);
 * from the menu they load straight into the game.
 */
export function ShareDialog({
  open,
  onClose,
  source,
}: {
  open: boolean;
  onClose: () => void;
  source: "editor" | "menu";
}) {
  const game = useGame();
  const ref = useRef<HTMLDialogElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const [track, setTrack] = useState<TrackData | null>(null);
  const [copied, setCopied] = useState<"link" | "json" | null>(null);
  const [importText, setImportText] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      // Snapshot the track when the dialog opens; it cannot change while the modal is up.
      setTrack(source === "editor" ? game.getEditorTrack() : game.getTrack());
      setCopied(null);
      setError(null);
      setImportText("");
      d.showModal();
    }
    if (!open && d.open) d.close();
  }, [open, source, game]);

  const json = track ? toJson(track) : "";
  const param = track ? encodeTrack(track) : "";
  const tooLong = param.length > MAX_URL_PARAM;
  const link =
    track && !tooLong && typeof window !== "undefined" ? shareUrl(track, window.location.href) : "";

  const copy = async (text: string, what: "link" | "json") => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied((c) => (c === what ? null : c)), 2000);
    } catch {
      setError("Could not access the clipboard. Select the text and copy it manually.");
    }
  };

  const download = () => {
    if (!track) return;
    const blob = new Blob([json], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${track.name.replace(/[^\w-]+/g, "-").toLowerCase() || "circuit"}.karting.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importTrack = (text: string) => {
    const r = fromJson(text);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    if (source === "editor") game.editorReplace(r.track);
    else game.loadTrack(r.track);
    onClose();
  };

  return (
    <dialog ref={ref} className="modal" onClose={onClose} aria-labelledby={titleId}>
      <div className="modal-box max-w-lg">
        <h2 id={titleId} className="text-xl font-extrabold">
          Share “{track?.name}”
        </h2>

        <section className="mt-4">
          <h3 className="mb-2 flex items-center gap-2 text-sm font-bold">
            <Link2 className="size-4" aria-hidden /> Link
          </h3>
          {tooLong ? (
            <p className="text-sm text-warning">
              This circuit is too big for a link. Use the JSON export below.
            </p>
          ) : (
            <div className="join w-full">
              <input
                className="input join-item w-full font-mono text-xs input-sm"
                readOnly
                value={link}
                aria-label="Share link"
                onFocus={(e) => e.currentTarget.select()}
              />
              <button
                className={`btn join-item btn-sm ${copied === "link" ? "btn-success" : "btn-primary"}`}
                onClick={() => copy(link, "link")}
              >
                {copied === "link" ? (
                  <Check className="size-4" />
                ) : (
                  <ClipboardCopy className="size-4" />
                )}
                {copied === "link" ? "Copied!" : "Copy link"}
              </button>
            </div>
          )}
          <p className="mt-1 text-xs opacity-60">
            Anyone opening the link plays this exact circuit. Nothing is uploaded.
          </p>
        </section>

        <section className="mt-5">
          <h3 className="mb-2 flex items-center gap-2 text-sm font-bold">
            <Download className="size-4" aria-hidden /> Export JSON
          </h3>
          <div className="flex gap-2">
            <button className="btn btn-sm" onClick={download}>
              <Download className="size-4" /> Download file
            </button>
            <button
              className={`btn btn-sm ${copied === "json" ? "btn-success" : ""}`}
              onClick={() => copy(json, "json")}
            >
              {copied === "json" ? (
                <Check className="size-4" />
              ) : (
                <ClipboardCopy className="size-4" />
              )}
              {copied === "json" ? "Copied!" : "Copy JSON"}
            </button>
          </div>
        </section>

        <section className="mt-5">
          <h3 className="mb-2 flex items-center gap-2 text-sm font-bold">
            <Upload className="size-4" aria-hidden /> Import
          </h3>
          <textarea
            className="textarea w-full font-mono text-xs"
            rows={4}
            placeholder="Paste track JSON here…"
            value={importText}
            onChange={(e) => {
              setImportText(e.target.value);
              setError(null);
            }}
            aria-label="Track JSON to import"
          />
          <div className="mt-2 flex gap-2">
            <button
              className="btn btn-primary btn-sm"
              disabled={!importText.trim()}
              onClick={() => importTrack(importText)}
            >
              Import
            </button>
            <button className="btn btn-sm" onClick={() => fileRef.current?.click()}>
              <Upload className="size-4" /> Open file…
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (!f) return;
                if (f.size > 200_000) {
                  setError("File is too large");
                  return;
                }
                importTrack(await f.text());
              }}
            />
          </div>
          {error && (
            <div role="alert" className="mt-3 alert py-2 text-sm alert-error">
              {error}
            </div>
          )}
        </section>

        <div className="modal-action">
          <button className="btn" onClick={onClose}>
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
