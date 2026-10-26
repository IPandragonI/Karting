import type { TrackPreview } from "./track/preview";

// Browser side of the game API (src/server/api.ts): the anonymous player identity, leaderboard
// and track library calls. The player token is created by the server the first time it is
// needed and kept in localStorage; it is the only thing that ties records and published circuits
// to this browser (no account, no e-mail).

const PLAYER_KEY = "karting:player";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

type Stored = { id: string; token: string };

function readPlayer(): Stored | null {
  try {
    const v = JSON.parse(localStorage.getItem(PLAYER_KEY) ?? "null") as Partial<Stored> | null;
    return v && typeof v.id === "string" && typeof v.token === "string"
      ? { id: v.id, token: v.token }
      : null;
  } catch {
    return null;
  }
}

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
  token?: string | null,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`/api/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    throw new ApiError(0, "Can't reach the game server (offline?)", "offline");
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok)
    throw new ApiError(
      res.status,
      data.error ?? `Server error (${res.status})`,
      data.code ?? "error",
    );
  return data as T;
}

/** This browser's player token, created on the server the first time it is needed. */
export async function ensurePlayer(): Promise<Stored> {
  const existing = readPlayer();
  if (existing) return existing;
  const p = await call<{ id: string; token: string }>("POST", "players");
  try {
    localStorage.setItem(PLAYER_KEY, JSON.stringify({ id: p.id, token: p.token }));
  } catch {
    // Storage blocked: the identity only lasts for this page.
  }
  return { id: p.id, token: p.token };
}

const token = () => readPlayer()?.token ?? null;

export async function getNickname(): Promise<string | null> {
  if (!readPlayer()) return null;
  try {
    return (await call<{ nickname: string | null }>("GET", "players/me", undefined, token()))
      .nickname;
  } catch (e) {
    // A token the server no longer knows (database reset): start over with a new identity.
    if (e instanceof ApiError && e.status === 401) localStorage.removeItem(PLAYER_KEY);
    return null;
  }
}

export async function setNickname(nickname: string): Promise<string> {
  const p = await ensurePlayer();
  return (await call<{ nickname: string }>("PUT", "players/me", { nickname }, p.token)).nickname;
}

// ─── Leaderboard ────────────────────────────────────────────────────────────

export type LeaderboardEntry = {
  rank: number;
  nickname: string;
  time: number;
  sectors: number[];
  date: number;
  me: boolean;
};

export type Leaderboard = {
  layout: string;
  track: { id: string; revision: number; name: string; official: boolean } | null;
  total: number;
  entries: LeaderboardEntry[];
  me: { rank: number; time: number } | null;
};

export const fetchLeaderboard = (layout: string) =>
  call<Leaderboard>("GET", `leaderboard?layout=${encodeURIComponent(layout)}`, undefined, token());

export type LapResult = {
  status: "verified";
  time: number;
  improved: boolean;
  best: number;
  rank: number;
};

export async function submitLap(lap: {
  layout: string;
  lap: number;
  time: number;
  trace: string;
}): Promise<LapResult> {
  const p = await ensurePlayer();
  return call<LapResult>("POST", "laps", lap, p.token);
}

// ─── Track library ──────────────────────────────────────────────────────────

export type LibraryTrack = {
  id: string;
  name: string;
  description: string;
  creator: string | null;
  official: boolean;
  revision: number;
  layout: string;
  preview: TrackPreview | null;
  likes: number;
  plays: number;
  createdAt: number;
  updatedAt: number;
  best: number | null;
  mine: boolean;
  liked: boolean;
};

export type LibraryVersion = {
  revision: number;
  layout: string;
  data: string;
  createdAt: number;
  best: number | null;
};

export type LibrarySort = "popular" | "recent" | "rated" | "name";

export const listTracks = (sort: LibrarySort, mine = false) =>
  call<{ tracks: LibraryTrack[] }>(
    "GET",
    `tracks?sort=${sort}${mine ? "&mine=1" : ""}`,
    undefined,
    token(),
  ).then((r) => r.tracks);

export const getTrack = (id: string, revision?: number) =>
  call<{
    track: LibraryTrack;
    version: LibraryVersion;
    versions: { revision: number; layout: string; createdAt: number }[];
  }>(
    "GET",
    `tracks/${encodeURIComponent(id)}${revision ? `?rev=${revision}` : ""}`,
    undefined,
    token(),
  );

export async function publishTrack(name: string, description: string, trackJson: string) {
  const p = await ensurePlayer();
  return call<{ id: string; revision: number; layout: string }>(
    "POST",
    "tracks",
    { name, description, track: trackJson },
    p.token,
  );
}

export async function updateTrack(
  id: string,
  changes: { name?: string; description?: string; track?: string },
) {
  const p = await ensurePlayer();
  return call<{ id: string; revision: number; layout: string }>(
    "PUT",
    `tracks/${encodeURIComponent(id)}`,
    changes,
    p.token,
  );
}

export async function likeTrack(id: string) {
  const p = await ensurePlayer();
  return call<{ liked: boolean; likes: number }>(
    "POST",
    `tracks/${encodeURIComponent(id)}/like`,
    {},
    p.token,
  );
}

export async function reportTrack(id: string, reason: string) {
  const p = await ensurePlayer();
  return call<{ reported: boolean }>(
    "POST",
    `tracks/${encodeURIComponent(id)}/report`,
    { reason },
    p.token,
  );
}

export const countPlay = (id: string) =>
  call<{ plays: number }>("POST", `tracks/${encodeURIComponent(id)}/play`, {}).catch(() => null);

/** Shareable link to a published circuit (a specific revision when given). */
export function libraryLink(id: string, revision?: number): string {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = `lib=${id}${revision ? `.${revision}` : ""}`;
  return url.toString();
}

/** `#lib=id` or `#lib=id.rev` in a URL hash. */
export function libraryFromHash(hash: string): { id: string; revision?: number } | null {
  const m = /(?:^#|&)lib=([A-Za-z0-9_-]{1,40})(?:\.(\d{1,6}))?/.exec(hash);
  return m ? { id: m[1]!, revision: m[2] ? Number(m[2]) : undefined } : null;
}
