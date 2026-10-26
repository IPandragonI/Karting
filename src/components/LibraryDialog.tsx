"use client";

import { BookOpen, Flag, Heart, Link2, Loader2, Play, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DESCRIPTION_MAX, TRACK_NAME_MAX } from "@/game/names";
import {
  ApiError,
  getTrack,
  libraryLink,
  likeTrack,
  listTracks,
  reportTrack,
  type LibrarySort,
  type LibraryTrack,
} from "@/game/online";
import { formatTime } from "@/game/RaceManager";
import { TrackThumb } from "./TrackThumb";
import { useGame, useGameState } from "./useGame";

const SORTS: { id: LibrarySort; label: string }[] = [
  { id: "popular", label: "Most popular" },
  { id: "recent", label: "Recently published" },
  { id: "rated", label: "Most liked" },
  { id: "name", label: "A–Z" },
];

type Details = Awaited<ReturnType<typeof getTrack>>;

/** Publish the circuit being driven: a new entry, or a new version of the player's own. */
function PublishPanel({ onPublished }: { onPublished: () => void }) {
  const game = useGame();
  const layout = useGameState((s) => s.layout);
  const library = useGameState((s) => s.library);
  const raceable = useGameState((s) => s.raceable);
  const trackName = useGameState((s) => s.trackName);
  const nickname = useGameState((s) => s.nickname);
  const [name, setName] = useState(trackName);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

  const published = library !== null && library.layout === layout;
  const ownChanged = library?.mine && !published;

  const run = async (task: () => Promise<{ revision: number }>) => {
    setBusy(true);
    try {
      const r = await task();
      setMessage({ text: `Published (version ${r.revision}).`, ok: true });
      onPublished();
    } catch (e) {
      setMessage({ text: e instanceof ApiError ? e.message : String(e), ok: false });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="mt-4 rounded-box border border-base-content/15 p-3"
      aria-labelledby="pub-title"
    >
      <h3 id="pub-title" className="flex items-center gap-2 text-sm font-bold">
        <Upload className="size-4" aria-hidden /> Publish the circuit you are driving
      </h3>
      {!raceable ? (
        <p className="mt-1 text-sm opacity-75">
          Only a complete, valid circuit can be published: fix it in the editor first.
        </p>
      ) : published ? (
        <p className="mt-1 text-sm opacity-75">
          “{library.name}” version {library.revision} is in the library
          {library.creator ? ` (by ${library.creator})` : ""}.
        </p>
      ) : !nickname ? (
        <p className="mt-1 text-sm opacity-75">
          Choose a nickname in the Leaderboard first: published circuits show their creator.
        </p>
      ) : (
        <form
          className="mt-2 grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() =>
              ownChanged
                ? game.publishRevision(description || undefined)
                : game.publishCurrent(name, description),
            );
          }}
        >
          {!ownChanged && (
            <input
              className="input w-full input-sm"
              aria-label="Circuit name"
              value={name}
              maxLength={TRACK_NAME_MAX}
              onChange={(e) => setName(e.target.value)}
              required
            />
          )}
          <textarea
            className="textarea w-full textarea-sm"
            aria-label="Description (optional)"
            placeholder="Description (optional)"
            rows={2}
            maxLength={DESCRIPTION_MAX}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <button
            className="btn btn-primary btn-sm"
            disabled={busy || (!ownChanged && !name.trim())}
          >
            {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {ownChanged
              ? `Publish as version ${library!.revision + 1} of “${library!.name}”`
              : "Publish as a new circuit"}
          </button>
          <p className="text-xs opacity-60">
            Published versions never change: edits become a new version with its own leaderboard.
          </p>
        </form>
      )}
      {message && (
        <p className={`mt-1 text-sm ${message.ok ? "text-success" : "text-error"}`} role="status">
          {message.text}
        </p>
      )}
    </section>
  );
}

/** Community and official circuits: browse, preview, play, like, share, report, publish. */
export function LibraryDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const game = useGame();
  const ref = useRef<HTMLDialogElement>(null);
  const [sort, setSort] = useState<LibrarySort>("popular");
  const [mine, setMine] = useState(false);
  const [tracks, setTracks] = useState<LibraryTrack[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [details, setDetails] = useState<Details | null>(null);
  const [reload, setReload] = useState(0);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    listTracks(sort, mine)
      .then((t) => {
        if (!live) return;
        setTracks(t);
        setError(null);
      })
      .catch((e: unknown) => live && setError(e instanceof ApiError ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [open, sort, mine, reload]);

  useEffect(() => {
    if (!selected) return;
    let live = true;
    getTrack(selected)
      .then((d) => live && setDetails(d))
      .catch((e: unknown) => live && setNote(e instanceof ApiError ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [selected, reload]);

  const sel = details && details.track.id === selected ? details : null;

  const act = async (task: () => Promise<string | void>) => {
    try {
      const msg = await task();
      if (msg) setNote(msg);
      setReload((n) => n + 1);
    } catch (e) {
      setNote(e instanceof ApiError ? e.message : String(e));
    }
  };

  return (
    <dialog ref={ref} className="modal" onClose={onClose} aria-labelledby="lib-title">
      <div className="modal-box max-w-3xl">
        <h2 id="lib-title" className="flex items-center gap-2 text-xl font-extrabold">
          <BookOpen className="size-5" aria-hidden /> Track library
        </h2>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select
            className="select w-auto select-sm"
            aria-label="Sort circuits"
            value={sort}
            onChange={(e) => setSort(e.target.value as LibrarySort)}
          >
            {SORTS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="toggle toggle-sm"
              checked={mine}
              onChange={(e) => setMine(e.target.checked)}
            />
            My circuits
          </label>
        </div>

        <div className="mt-3 grid gap-3 md:grid-cols-[1fr_17rem]">
          <ul className="max-h-[50vh] overflow-y-auto pr-1" aria-label="Circuits">
            {error && <li className="text-sm text-warning">{error}</li>}
            {!error && tracks === null && (
              <li className="flex items-center gap-2 text-sm opacity-70">
                <Loader2 className="size-4 animate-spin" aria-hidden /> Loading…
              </li>
            )}
            {tracks?.length === 0 && (
              <li className="text-sm opacity-70">
                {mine ? "You have not published a circuit yet." : "No circuits yet."}
              </li>
            )}
            {tracks?.map((t) => (
              <li key={t.id}>
                <button
                  className={`flex w-full items-center gap-3 rounded-box p-2 text-left hover:bg-base-content/10 ${
                    selected === t.id ? "bg-primary/15" : ""
                  }`}
                  onClick={() => setSelected(t.id)}
                  aria-pressed={selected === t.id}
                >
                  <TrackThumb preview={t.preview} label={t.name} size={56} />
                  <span className="min-w-0 grow">
                    <span className="flex items-center gap-2 font-bold">
                      <span className="truncate">{t.name}</span>
                      {t.official && <span className="badge badge-sm badge-primary">Official</span>}
                    </span>
                    <span className="block truncate text-xs opacity-70">
                      {t.official ? "Low-Poly Karting" : `by ${t.creator ?? "Anonymous"}`} · v
                      {t.revision}
                    </span>
                    <span className="block text-xs tabular-nums opacity-70">
                      Best {formatTime(t.best)} · ♥ {t.likes} · {t.plays} plays
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>

          <aside className="rounded-box border border-base-content/15 p-3" aria-live="polite">
            {!sel ? (
              <p className="text-sm opacity-70">Select a circuit to preview it.</p>
            ) : (
              <>
                <TrackThumb preview={sel.track.preview} label={sel.track.name} size={140} />
                <h3 className="mt-2 font-bold">{sel.track.name}</h3>
                <p className="text-xs opacity-70">
                  {sel.track.official
                    ? "Official circuit"
                    : `by ${sel.track.creator ?? "Anonymous"}`}
                </p>
                {sel.track.description && <p className="mt-1 text-sm">{sel.track.description}</p>}
                <p className="mt-1 text-xs tabular-nums opacity-70">
                  Version {sel.version.revision} · best verified lap {formatTime(sel.version.best)}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => void game.loadLibraryTrack(sel.track.id, sel.version.revision)}
                  >
                    <Play className="size-4" aria-hidden /> Play
                  </button>
                  <button
                    className={`btn btn-sm ${sel.track.liked ? "btn-secondary" : ""}`}
                    aria-pressed={sel.track.liked}
                    onClick={() => void act(async () => void (await likeTrack(sel.track.id)))}
                  >
                    <Heart className="size-4" aria-hidden /> {sel.track.likes}
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={() =>
                      void act(async () => {
                        await navigator.clipboard.writeText(libraryLink(sel.track.id));
                        return "Link copied";
                      })
                    }
                  >
                    <Link2 className="size-4" aria-hidden /> Link
                  </button>
                  {!sel.track.official && !sel.track.mine && (
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() =>
                        void act(async () => {
                          await reportTrack(sel.track.id, "broken or inappropriate");
                          return "Reported, thank you";
                        })
                      }
                    >
                      <Flag className="size-4" aria-hidden /> Report
                    </button>
                  )}
                </div>
                {sel.versions.length > 1 && (
                  <details className="mt-2 text-xs">
                    <summary className="cursor-pointer">Earlier versions</summary>
                    <ul className="mt-1">
                      {sel.versions
                        .filter((v) => v.revision !== sel.version.revision)
                        .map((v) => (
                          <li key={v.revision}>
                            <button
                              className="link"
                              onClick={() => void game.loadLibraryTrack(sel.track.id, v.revision)}
                            >
                              Play version {v.revision}
                            </button>{" "}
                            ({new Date(v.createdAt).toLocaleDateString()})
                          </li>
                        ))}
                    </ul>
                  </details>
                )}
              </>
            )}
            {note && <p className="mt-2 text-xs opacity-80">{note}</p>}
          </aside>
        </div>

        <PublishPanel onPublished={() => setReload((n) => n + 1)} />

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
