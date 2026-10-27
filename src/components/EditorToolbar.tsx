"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Eraser,
  Eye,
  EyeOff,
  Flag,
  FlipHorizontal2,
  History,
  Minus,
  MoveVertical,
  Plus,
  Redo2,
  RotateCcw,
  RotateCw,
  Timer,
  Trash2,
  Undo2,
} from "lucide-react";
import { useState } from "react";
import { CIRCUITS } from "@/game/track/circuits";
import { MAX_LEVEL } from "@/game/track/pieces";
import type { EditorTool } from "@/game/TrackEditor";
import { ShareDialog } from "./ShareDialog";
import { useGame, useGameState } from "./useGame";

const TOOLS: { tool: EditorTool; label: string; key: string; icon: React.ReactNode }[] = [
  { tool: "straight", label: "Straight", key: "1", icon: <PieceIcon d="M12 2v20" /> },
  { tool: "start", label: "Start / Finish", key: "2", icon: <StartIcon /> },
  {
    tool: "corner",
    label: "Corner",
    key: "3",
    icon: <PieceIcon d="M7 22v-3a12 12 0 0 1 12-12h3" />,
  },
  {
    tool: "wideCorner",
    label: "Sweeper (2×2)",
    key: "4",
    icon: <PieceIcon d="M4 22v-4A14 14 0 0 1 18 4h4" />,
  },
  {
    tool: "hairpin",
    label: "Hairpin (2 cells)",
    key: "5",
    icon: <PieceIcon d="M5 22V12a7 7 0 0 1 14 0v10" />,
  },
  { tool: "ramp", label: "Ramp: up one level (rotate to go down)", key: "6", icon: <RampIcon /> },
  { tool: "longRamp", label: "Long ramp (2 cells, gentle)", key: "7", icon: <RampIcon long /> },
  {
    tool: "chicane",
    label: "Chicane (2×2, F flips)",
    key: "8",
    icon: <PieceIcon d="M7 22v-4c0-6 10-6 10-12V2" />,
  },
  { tool: "cone", label: "Cone", key: "9", icon: <ConeIcon /> },
  { tool: "tires", label: "Tire stack", key: "0", icon: <TiresIcon /> },
  {
    tool: "level",
    label: "Height: click raises a piece, right-click lowers",
    key: "H",
    icon: <MoveVertical className="size-5" />,
  },
  { tool: "erase", label: "Erase", key: "X", icon: <Eraser className="size-5" /> },
];

export function EditorToolbar() {
  const game = useGame();
  const editor = useGameState((s) => s.editor);
  const issues = useGameState((s) => s.issues);
  const raceable = useGameState((s) => s.raceable);
  const trackName = useGameState((s) => s.trackName);
  const toast = useGameState((s) => s.toast);
  const [showIssues, setShowIssues] = useState(false);
  const [share, setShare] = useState(false);

  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  const rotatable =
    editor.tool !== "cone" &&
    editor.tool !== "tires" &&
    editor.tool !== "erase" &&
    editor.tool !== "level";

  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col justify-between gap-2 p-2 sm:p-3">
      {/* Top bar: name, status, test drive. */}
      <div className="pointer-events-auto flex flex-wrap items-start gap-2">
        <div className="glass-panel flex items-center gap-2 rounded-box p-1.5">
          <label className="sr-only" htmlFor="track-name">
            Track name
          </label>
          <input
            id="track-name"
            className="input w-36 input-sm sm:w-48"
            value={trackName}
            maxLength={32}
            onChange={(e) => game.editorRename(e.target.value)}
          />
        </div>

        <div className="relative">
          <button
            className={`glass-panel btn h-auto min-h-9 rounded-box btn-sm ${errors.length ? "text-error" : "text-success"}`}
            onClick={() => setShowIssues((v) => !v)}
            aria-expanded={showIssues}
          >
            {errors.length ? (
              <AlertTriangle className="size-4" />
            ) : (
              <CheckCircle2 className="size-4" />
            )}
            {errors.length
              ? `${errors.length} problem${errors.length > 1 ? "s" : ""}`
              : "Ready to race"}
            {warnings.length > 0 && (
              <span className="badge badge-sm badge-warning">{warnings.length}</span>
            )}
          </button>
          {showIssues && issues.length > 0 && (
            <ul className="glass-panel absolute top-full left-0 z-10 mt-2 w-72 rounded-box p-3 text-sm shadow-xl">
              {issues.map((i, k) => (
                <li key={k} className="flex gap-2 py-1">
                  <AlertTriangle
                    className={`mt-0.5 size-4 shrink-0 ${i.severity === "error" ? "text-error" : "text-warning"}`}
                  />
                  {i.message}
                </li>
              ))}
              <li className="mt-1 text-xs opacity-60">
                Red cells and arrows mark the problem spots.
              </li>
            </ul>
          )}
        </div>

        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {editor.dirty && (
            <div className="glass-panel flex items-center gap-1 rounded-box py-1 pr-1 pl-2.5 text-xs font-bold">
              <span className="size-2 rounded-full bg-warning" aria-hidden />
              Unsaved changes
              <button
                className="btn btn-ghost btn-xs"
                onClick={() => game.editorRevert()}
                title="Discard the changes made since opening the editor (undoable)"
              >
                <History className="size-3.5" /> Revert
              </button>
            </div>
          )}
          <button className="glass-panel btn rounded-box btn-sm" onClick={() => setShare(true)}>
            Share
          </button>
          <div className="glass-panel join rounded-box">
            <button
              className="btn join-item btn-primary btn-sm"
              onClick={() => game.closeEditor()}
              title={
                (raceable
                  ? "Back to driving, with lap timing on this circuit"
                  : "Back to driving (free drive: the circuit is not complete)") +
                (editor.dirty ? ". Saves the changes; records restart if the layout changed" : "")
              }
            >
              {raceable ? <Timer className="size-4" /> : <Flag className="size-4" />} Drive
            </button>
          </div>
        </div>
      </div>

      {/* Hint / notes. */}
      <div className="flex flex-1 flex-col items-center justify-end gap-1" aria-live="polite">
        {toast && (
          <div
            key={toast.id}
            className={`rounded-full px-3 py-1 text-sm font-bold shadow ${toast.tone === "warning" ? "bg-warning text-warning-content" : "bg-base-100/85"}`}
          >
            {toast.text}
          </div>
        )}
        {editor.hint && !editor.preview && (
          <div
            className={`glass-panel rounded-full px-3 py-1 text-xs sm:text-sm ${editor.hintOk ? "" : "text-error"}`}
          >
            {editor.hint}
          </div>
        )}
      </div>

      {/* Bottom toolbar. */}
      <div className="flex flex-col gap-1">
        <div className="pointer-events-auto mx-auto flex max-w-full flex-wrap items-center justify-center gap-2">
          <div
            className="glass-panel flex flex-wrap justify-center gap-1 rounded-box p-1.5"
            role="toolbar"
            aria-label="Track pieces"
          >
            {TOOLS.map((t) => (
              <div key={t.tool} className="tooltip tooltip-top" data-tip={`${t.label} (${t.key})`}>
                <button
                  className={`btn btn-square btn-sm sm:btn-md ${editor.tool === t.tool ? "btn-primary" : "btn-ghost"}`}
                  onClick={() => game.editorTool(t.tool)}
                  aria-label={t.label}
                  aria-pressed={editor.tool === t.tool}
                >
                  {t.icon}
                </button>
              </div>
            ))}
          </div>
          <div
            className="glass-panel flex gap-1 rounded-box p-1.5"
            role="toolbar"
            aria-label="Edit actions"
          >
            <div className="tooltip tooltip-top" data-tip="Rotate (R, Shift+R)">
              <button
                className="btn btn-square btn-ghost btn-sm sm:btn-md"
                onClick={() => game.editorRotate(1)}
                disabled={!rotatable}
                aria-label="Rotate piece"
              >
                <RotateCw
                  className="size-5"
                  style={{ transform: `rotate(${editor.rot * 90}deg)` }}
                />
              </button>
            </div>
            <div className="tooltip tooltip-top" data-tip="Flip left ↔ right (F)">
              <button
                className={`btn btn-square btn-sm sm:btn-md ${editor.flip ? "btn-secondary" : "btn-ghost"}`}
                onClick={() => game.editorFlip()}
                disabled={!rotatable}
                aria-label="Flip piece"
                aria-pressed={editor.flip}
              >
                <FlipHorizontal2 className="size-5" />
              </button>
            </div>
            <div
              className="flex items-center rounded-field border border-base-content/15"
              role="group"
              aria-label="Level for new pieces"
            >
              <div className="tooltip tooltip-top" data-tip="Lower (−)">
                <button
                  className="btn btn-square btn-ghost btn-xs sm:btn-sm"
                  onClick={() => game.editorLevel(editor.level - 1)}
                  disabled={editor.level <= 0}
                  aria-label="Lower the level for new pieces"
                >
                  <Minus className="size-4" />
                </button>
              </div>
              <span
                className="min-w-12 text-center text-xs leading-tight font-bold tabular-nums"
                title="Level for new pieces (they join raised road at its level automatically)"
              >
                <span className="block text-[10px] font-normal opacity-60">Level</span>
                {editor.level}
              </span>
              <div className="tooltip tooltip-top" data-tip="Raise (+)">
                <button
                  className="btn btn-square btn-ghost btn-xs sm:btn-sm"
                  onClick={() => game.editorLevel(editor.level + 1)}
                  disabled={editor.level >= MAX_LEVEL}
                  aria-label="Raise the level for new pieces"
                >
                  <Plus className="size-4" />
                </button>
              </div>
            </div>
            <div className="tooltip tooltip-top" data-tip="Undo (Ctrl+Z)">
              <button
                className="btn btn-square btn-ghost btn-sm sm:btn-md"
                onClick={() => game.editorUndo()}
                disabled={!editor.canUndo}
                aria-label="Undo"
              >
                <Undo2 className="size-5" />
              </button>
            </div>
            <div className="tooltip tooltip-top" data-tip="Redo (Ctrl+Y)">
              <button
                className="btn btn-square btn-ghost btn-sm sm:btn-md"
                onClick={() => game.editorRedo()}
                disabled={!editor.canRedo}
                aria-label="Redo"
              >
                <Redo2 className="size-5" />
              </button>
            </div>
            <div
              className="tooltip tooltip-top"
              data-tip={editor.preview ? "Back to editing (P)" : "Preview with scenery (P)"}
            >
              <button
                className={`btn btn-square btn-sm sm:btn-md ${editor.preview ? "btn-secondary" : "btn-ghost"}`}
                onClick={() => game.editorPreview(!editor.preview)}
                aria-label="Preview"
                aria-pressed={editor.preview}
              >
                {editor.preview ? <EyeOff className="size-5" /> : <Eye className="size-5" />}
              </button>
            </div>
            <div className="dropdown dropdown-end dropdown-top">
              <div className="tooltip tooltip-top" data-tip="Reset or clear">
                <button
                  tabIndex={0}
                  className="btn btn-square btn-ghost btn-sm sm:btn-md"
                  aria-label="Reset or clear the circuit"
                >
                  <Trash2 className="size-5" />
                </button>
              </div>
              <ul
                tabIndex={0}
                className="menu dropdown-content z-10 mb-2 w-56 rounded-box bg-base-100 p-2 shadow-xl"
              >
                <li>
                  <button onClick={() => game.editorMirror()}>
                    <FlipHorizontal2 className="size-4" /> Mirror the circuit
                  </button>
                </li>
                <li>
                  <button onClick={() => game.editorRevert()} disabled={!editor.dirty}>
                    <History className="size-4" /> Revert unsaved changes
                  </button>
                </li>
                {CIRCUITS.map((c) => (
                  <li key={c.id}>
                    <button onClick={() => game.editorReplace(c.create())}>
                      <RotateCcw className="size-4" /> Start from “{c.name}”
                    </button>
                  </li>
                ))}
                <li>
                  <button
                    onClick={() =>
                      game.editorReplace({ version: 1, name: "My circuit", pieces: [], props: [] })
                    }
                  >
                    <Trash2 className="size-4" /> Clear everything
                  </button>
                </li>
              </ul>
            </div>
          </div>
        </div>

        <p className="hud-text pointer-events-none hidden text-center text-xs opacity-70 sm:block [@media(pointer:coarse)]:hidden">
          Click to place · Right-click to erase · R rotate · F flip · + / − level · I pick up a
          piece · Drag to pan · Scroll to zoom
        </p>
        <p className="hud-text pointer-events-none hidden text-center text-xs opacity-70 [@media(pointer:coarse)]:block">
          Tap to place · Drag to pan · Pinch to zoom · Use the eraser to remove
        </p>
      </div>
      <ShareDialog open={share} onClose={() => setShare(false)} source="editor" />
    </div>
  );
}

function PieceIcon({ d }: { d: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-5"
      fill="none"
      stroke="currentColor"
      strokeWidth={4}
      strokeLinecap="butt"
      aria-hidden
    >
      <path d={d} />
    </svg>
  );
}

function StartIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" aria-hidden>
      <path d="M12 2v20" stroke="currentColor" strokeWidth={4} />
      {[0, 1, 2, 3].map((i) => (
        <rect key={i} x={4 + i * 4} y={i % 2 ? 9 : 11} width={4} height={2} fill="currentColor" />
      ))}
      <path d="M12 2l-4 5h8z" fill="currentColor" />
    </svg>
  );
}

function RampIcon({ long = false }: { long?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="size-5" aria-hidden>
      <path
        d={long ? "M2 20h3L19 9h3" : "M4 20h3l10-12h3"}
        fill="none"
        stroke="currentColor"
        strokeWidth={3.5}
      />
      <path d="M2 22h20" stroke="currentColor" strokeWidth={1.5} opacity={0.5} />
    </svg>
  );
}

function ConeIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="currentColor" aria-hidden>
      <path d="M10 4h4l4 14H6z" />
      <rect x={4} y={18} width={16} height={2.5} rx={1} />
    </svg>
  );
}

function TiresIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-5"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      aria-hidden
    >
      <ellipse cx={12} cy={7} rx={7} ry={3} />
      <ellipse cx={12} cy={12} rx={7} ry={3} />
      <ellipse cx={12} cy={17} rx={7} ry={3} />
    </svg>
  );
}
