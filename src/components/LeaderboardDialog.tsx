"use client";

import { CheckCircle2, Info, Loader2, ShieldCheck, Trophy, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Submission } from "@/game/Game";
import { NICKNAME_MAX, normalizeNickname } from "@/game/names";
import { ApiError, fetchLeaderboard, type Leaderboard } from "@/game/online";
import { formatTime } from "@/game/RaceManager";
import { useGame, useGameState } from "./useGame";

function SubmissionLine({ s }: { s: Submission }) {
  switch (s.state) {
    case "idle":
      return null;
    case "submitting":
      return (
        <p className="flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Verifying your{" "}
          {formatTime(s.time)}: the server is replaying your lap…
        </p>
      );
    case "verified":
      return (
        <p className="flex items-center gap-2 text-sm text-success">
          <CheckCircle2 className="size-4" aria-hidden />
          {s.improved
            ? `Verified ${formatTime(s.time)}: rank #${s.rank}`
            : `Verified ${formatTime(s.time)} (your best here is faster: rank #${s.rank})`}
        </p>
      );
    case "rejected":
      return (
        <p className="flex items-center gap-2 text-sm text-error">
          <XCircle className="size-4 shrink-0" aria-hidden /> {formatTime(s.time)} not accepted:{" "}
          {s.message}
        </p>
      );
    case "error":
      return (
        <p className="flex items-center gap-2 text-sm text-warning">
          <Info className="size-4 shrink-0" aria-hidden /> {formatTime(s.time)} not sent yet:{" "}
          {s.message}
        </p>
      );
  }
}

/** Verified best laps of the circuit being driven, and the player's nickname. */
export function LeaderboardDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const game = useGame();
  const layout = useGameState((s) => s.layout);
  const trackName = useGameState((s) => s.trackName);
  const nickname = useGameState((s) => s.nickname);
  const submission = useGameState((s) => s.submission);
  const pending = useGameState((s) => s.pendingSubmit);
  const ref = useRef<HTMLDialogElement>(null);
  const [board, setBoard] = useState<Leaderboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  // Reload when opened, after a submission settles, and when the circuit changes.
  useEffect(() => {
    if (!open || !layout) return;
    let live = true;
    fetchLeaderboard(layout)
      .then((b) => {
        if (!live) return;
        setBoard(b);
        setError(null);
      })
      .catch((e: unknown) => live && setError(e instanceof ApiError ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [open, layout, submission.state]);

  const saveName = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = normalizeNickname(name);
    if (!r.ok) {
      setNameError(r.error);
      return;
    }
    setSaving(true);
    try {
      await game.setPlayerNickname(r.value);
      setName("");
      setNameError(null);
    } catch (err) {
      setNameError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const unpublished = board !== null && board.track === null;

  return (
    <dialog ref={ref} className="modal" onClose={onClose} aria-labelledby="lb-title">
      <div className="modal-box max-w-lg">
        <h2 id="lb-title" className="flex items-center gap-2 text-xl font-extrabold">
          <Trophy className="size-5 text-warning" aria-hidden /> Leaderboard
        </h2>
        <p className="text-sm opacity-70">
          {board?.track ? board.track.name : trackName}
          {board?.track?.official ? " · official circuit" : ""}
        </p>

        <form className="mt-4 flex flex-wrap items-end gap-2" onSubmit={saveName}>
          <label className="flex grow flex-col gap-1 text-xs font-bold tracking-wide uppercase opacity-80">
            Your nickname
            <input
              className="input w-full font-normal tracking-normal normal-case input-sm"
              placeholder={nickname ?? "Pick a name shown on the board"}
              value={name}
              maxLength={NICKNAME_MAX * 2}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={nameError !== null}
              aria-describedby="nick-help"
            />
          </label>
          <button className="btn btn-primary btn-sm" disabled={saving || !name.trim()}>
            {nickname ? "Change" : "Save"}
          </button>
          <p id="nick-help" className="w-full text-xs opacity-70">
            {nameError ? (
              <span className="text-error">{nameError}</span>
            ) : nickname ? (
              <>
                Posting as <strong>{nickname}</strong>. Nicknames are labels: others may use the
                same one.
              </>
            ) : (
              `Up to ${NICKNAME_MAX} characters. Needed to post times; nothing else is collected.`
            )}
          </p>
        </form>

        <div className="mt-3 min-h-6" aria-live="polite">
          <SubmissionLine s={submission} />
          {pending && nickname && (
            <button
              className="btn mt-1 btn-secondary btn-sm"
              onClick={() => void game.submitPending()}
            >
              Submit my best lap of this session
            </button>
          )}
          {pending && !nickname && (
            <p className="text-sm opacity-80">
              Your best lap of this session is waiting: save a nickname to submit it.
            </p>
          )}
        </div>

        {error ? (
          <p className="mt-3 text-sm text-warning">{error}</p>
        ) : unpublished ? (
          <p className="mt-3 text-sm opacity-80">
            This circuit is not in the track library yet, so it has no leaderboard. Publish it from
            the Track library to open one.
          </p>
        ) : board === null ? (
          <p className="mt-3 flex items-center gap-2 text-sm opacity-70">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Loading…
          </p>
        ) : board.entries.length === 0 ? (
          <p className="mt-3 text-sm opacity-80">No verified lap yet: set the first one!</p>
        ) : (
          <div className="mt-2 max-h-72 overflow-y-auto">
            <table className="table table-sm" aria-label="Verified best laps">
              <thead>
                <tr>
                  <th className="w-10">#</th>
                  <th>Driver</th>
                  <th className="text-right">Best lap</th>
                  <th className="text-right max-sm:hidden">Date</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {board.entries.map((e) => (
                  <tr key={`${e.rank}-${e.date}`} className={e.me ? "bg-primary/15 font-bold" : ""}>
                    <td>{e.rank}</td>
                    <td className="max-w-40 truncate">{e.nickname}</td>
                    <td className="text-right">{formatTime(e.time)}</td>
                    <td className="text-right text-xs opacity-70 max-sm:hidden">
                      {new Date(e.date).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {board.me && !board.entries.some((e) => e.me) && (
              <p className="mt-1 text-sm">
                You: #{board.me.rank} · {formatTime(board.me.time)}
              </p>
            )}
          </div>
        )}

        <details className="mt-4 text-xs opacity-80">
          <summary className="flex cursor-pointer items-center gap-1 font-bold">
            <ShieldCheck className="size-4" aria-hidden /> How times are verified
          </summary>
          <p className="mt-1">
            When you beat your best, the game sends the inputs of your session (steering, pedals,
            resets: every physics step), not a time. The server replays them through the same
            deterministic simulation on the published layout and records the time it computes.
            Edited timers or invented times are rejected. This is strong but not cheat-proof: a
            carefully crafted input sequence (a tool-assisted lap) would replay as valid.
          </p>
        </details>

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
