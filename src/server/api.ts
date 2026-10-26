import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { cleanText, DESCRIPTION_MAX, normalizeNickname, TRACK_NAME_MAX } from "@/game/names";
import { replay } from "@/game/sim/replay";
import { decodeTrace } from "@/game/sim/trace";
import { layoutHash } from "@/game/track/layoutHash";
import { trackPreview } from "@/game/track/preview";
import { analyzeTrack, isRaceable, type TrackData } from "@/game/track/Track";
import { fromJson, toJson } from "@/game/track/TrackSerializer";
import { getDb } from "./db";

// The game's HTTP API (mounted at /api by app/api/[...path]/route.ts):
//
//   POST /api/players                 new anonymous player → { id, token }
//   GET  /api/players/me              (auth) → { id, nickname }
//   PUT  /api/players/me              (auth) { nickname }
//   GET  /api/leaderboard?layout=…    verified records of a layout, fastest first
//   POST /api/laps                    (auth) { layout, lap, time, trace } → verified record
//   GET  /api/tracks?sort=…&mine=1    library listing
//   POST /api/tracks                  (auth) publish { name, description, track }
//   GET  /api/tracks/:id?rev=…        one circuit (a revision's data, its versions, best lap)
//   PUT  /api/tracks/:id              (auth, owner) update: a layout change is a new revision
//   POST /api/tracks/:id/like|report|play
//
// Lap records are never taken from the client: the submitted input trace is replayed through
// the game's own deterministic simulation (src/game/sim) on the published layout, and the time
// stored is the one the server computes. Players are anonymous: a random id and a secret token
// the browser keeps (only its hash is stored); the nickname is a display label, not an identity.

type Json = Record<string, unknown>;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = "error",
  ) {
    super(message);
  }
}

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const now = () => Date.now();

/** Request body as a JSON object, refusing anything larger than `max` bytes. */
async function readJson(req: Request, max: number): Promise<Json> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > max) throw new HttpError(413, "Request too large", "too_large");
  const text = await req.text();
  if (text.length > max) throw new HttpError(413, "Request too large", "too_large");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Malformed JSON", "bad_request");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new HttpError(400, "Expected a JSON object", "bad_request");
  return body as Json;
}

// ─── Rate limiting (in memory, per process) ─────────────────────────────────

const buckets = new Map<string, { tokens: number; at: number }>();

/** Client address as seen through a proxy (first X-Forwarded-For hop), for rate limits only. */
function clientKey(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || req.headers.get("x-real-ip") || "local";
}

/** Token bucket: `perMinute` requests per minute and key, with that many in reserve. */
function limit(key: string, perMinute: number) {
  const t = now();
  const b = buckets.get(key) ?? { tokens: perMinute, at: t };
  b.tokens = Math.min(perMinute, b.tokens + ((t - b.at) / 60000) * perMinute);
  b.at = t;
  if (b.tokens < 1) throw new HttpError(429, "Too many requests, try again in a moment", "rate");
  b.tokens -= 1;
  buckets.set(key, b);
  if (buckets.size > 20000) {
    for (const [k, v] of buckets) if (t - v.at > 120000) buckets.delete(k);
  }
}

// ─── Players ────────────────────────────────────────────────────────────────

type Player = { id: string; nickname: string | null };

/** Bearer token "id.secret" → the player, compared in constant time. */
function auth(req: Request, required: true): Player;
function auth(req: Request, required: false): Player | null;
function auth(req: Request, required: boolean): Player | null {
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer ([A-Za-z0-9_-]{8,32})\.([A-Za-z0-9_-]{20,64})$/.exec(header);
  if (!m) {
    if (required) throw new HttpError(401, "Sign-in token missing", "auth");
    return null;
  }
  const row = getDb()
    .prepare("SELECT id, token_hash, nickname FROM players WHERE id = ?")
    .get(m[1]!) as { id: string; token_hash: string; nickname: string | null } | undefined;
  const given = Buffer.from(sha256(m[2]!), "hex");
  if (!row || !timingSafeEqual(Buffer.from(row.token_hash, "hex"), given)) {
    if (required) throw new HttpError(401, "Unknown player token", "auth");
    return null;
  }
  return { id: row.id, nickname: row.nickname };
}

function createPlayer(req: Request) {
  limit(`players:${clientKey(req)}`, 5);
  const id = randomBytes(9).toString("base64url");
  const secret = randomBytes(24).toString("base64url");
  getDb()
    .prepare("INSERT INTO players (id, token_hash, nickname, created_at) VALUES (?, ?, NULL, ?)")
    .run(id, sha256(secret), now());
  return json({ id, token: `${id}.${secret}`, nickname: null }, 201);
}

async function setNickname(req: Request) {
  const player = auth(req, true);
  limit(`nick:${player.id}`, 10);
  const body = await readJson(req, 1000);
  const r = normalizeNickname(body.nickname);
  if (!r.ok) throw new HttpError(422, r.error, "nickname");
  getDb().prepare("UPDATE players SET nickname = ? WHERE id = ?").run(r.value, player.id);
  return json({ id: player.id, nickname: r.value });
}

// ─── Circuits ───────────────────────────────────────────────────────────────

type TrackRow = {
  id: string;
  name: string;
  description: string;
  creator_id: string | null;
  creator: string | null;
  official: number;
  revision: number;
  layout: string;
  preview: string;
  created_at: number;
  updated_at: number;
  likes: number;
  plays: number;
  hidden: number;
};

const TRACK_SELECT = `SELECT t.*, p.nickname AS creator FROM tracks t
  LEFT JOIN players p ON p.id = t.creator_id`;

function bestTime(layout: string): number | null {
  const row = getDb()
    .prepare("SELECT MIN(time) AS best FROM records WHERE layout = ?")
    .get(layout) as { best: number | null } | undefined;
  return row?.best ?? null;
}

function trackSummary(t: TrackRow, player: Player | null) {
  const liked =
    player !== null &&
    !!getDb()
      .prepare("SELECT 1 FROM likes WHERE track_id = ? AND player_id = ?")
      .get(t.id, player.id);
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    creator: t.creator,
    official: t.official === 1,
    revision: t.revision,
    layout: t.layout,
    preview: t.preview ? (JSON.parse(t.preview) as unknown) : null,
    likes: t.likes,
    plays: t.plays,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    best: bestTime(t.layout),
    mine: player !== null && t.creator_id === player.id,
    liked,
  };
}

function getTrackRow(id: string): TrackRow {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw new HttpError(404, "No such circuit", "not_found");
  const row = getDb().prepare(`${TRACK_SELECT} WHERE t.id = ?`).get(id) as TrackRow | undefined;
  if (!row) throw new HttpError(404, "No such circuit", "not_found");
  return row;
}

/**
 * A submitted circuit, validated like an imported file (strict schema, no code, size limits),
 * and required to be a valid closed circuit with a usable start.
 */
function parseCircuit(raw: unknown, name: string): TrackData {
  if (typeof raw !== "string" || raw.length > 200_000)
    throw new HttpError(422, "Missing circuit data", "track");
  const r = fromJson(raw);
  if (!r.ok) throw new HttpError(422, `Invalid circuit: ${r.error}`, "track");
  const track = { ...r.track, name };
  const layout = analyzeTrack(track);
  if (!isRaceable(layout)) {
    const first = layout.issues.find((i) => i.severity === "error");
    throw new HttpError(
      422,
      `The circuit is not raceable${first ? `: ${first.message}` : ""}`,
      "not_raceable",
    );
  }
  return track;
}

function listTracks(req: Request, url: URL) {
  const player = auth(req, false);
  const sort = url.searchParams.get("sort") ?? "popular";
  const order =
    sort === "recent"
      ? "t.updated_at DESC"
      : sort === "rated"
        ? "t.likes DESC, t.updated_at DESC"
        : sort === "name"
          ? "t.name COLLATE NOCASE ASC"
          : "t.official DESC, (t.likes * 3 + t.plays) DESC, t.updated_at DESC";
  const mine = url.searchParams.get("mine") === "1";
  if (mine && !player) return json({ tracks: [] });
  const rows = getDb()
    .prepare(
      `${TRACK_SELECT} WHERE t.hidden = 0 ${mine ? "AND t.creator_id = ?" : ""} ORDER BY ${order} LIMIT 100`,
    )
    .all(...(mine ? [player!.id] : [])) as TrackRow[];
  return json({ tracks: rows.map((t) => trackSummary(t, player)) });
}

async function publishTrack(req: Request) {
  const player = auth(req, true);
  limit(`publish:${player.id}`, 3);
  if (!player.nickname) throw new HttpError(403, "Choose a nickname first", "nickname");
  const body = await readJson(req, 220_000);
  const name = cleanText(body.name, TRACK_NAME_MAX);
  if (!name) throw new HttpError(422, "Give the circuit a name", "name");
  const description = cleanText(body.description, DESCRIPTION_MAX);
  const track = parseCircuit(body.track, name);
  const layout = layoutHash(track);
  const id = randomBytes(6).toString("base64url");
  const t = now();
  const d = getDb();
  d.prepare(
    `INSERT INTO tracks (id, name, description, creator_id, official, revision, layout, preview, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, 1, ?, ?, ?, ?)`,
  ).run(id, name, description, player.id, layout, JSON.stringify(trackPreview(track)), t, t);
  d.prepare(
    "INSERT INTO track_versions (track_id, revision, layout, data, created_at) VALUES (?, 1, ?, ?, ?)",
  ).run(id, layout, toJson(track), t);
  return json({ id, revision: 1, layout }, 201);
}

function getTrack(req: Request, id: string, url: URL) {
  const player = auth(req, false);
  const t = getTrackRow(id);
  const revParam = url.searchParams.get("rev");
  const rev = revParam === null ? t.revision : Number(revParam);
  if (!Number.isInteger(rev) || rev < 1) throw new HttpError(404, "No such version", "not_found");
  const d = getDb();
  const version = d
    .prepare(
      "SELECT revision, layout, data, created_at FROM track_versions WHERE track_id = ? AND revision = ?",
    )
    .get(t.id, rev) as
    { revision: number; layout: string; data: string; created_at: number } | undefined;
  if (!version) throw new HttpError(404, "No such version", "not_found");
  const versions = d
    .prepare(
      "SELECT revision, layout, created_at FROM track_versions WHERE track_id = ? ORDER BY revision DESC",
    )
    .all(t.id) as { revision: number; layout: string; created_at: number }[];
  return json({
    track: trackSummary(t, player),
    version: {
      revision: version.revision,
      layout: version.layout,
      data: version.data,
      createdAt: version.created_at,
      best: bestTime(version.layout),
    },
    versions: versions.map((v) => ({
      revision: v.revision,
      layout: v.layout,
      createdAt: v.created_at,
    })),
  });
}

/**
 * Owner update. Name and description change in place; a changed layout becomes a new revision
 * and older revisions stay available unchanged, with their own records.
 */
async function updateTrack(req: Request, id: string) {
  const player = auth(req, true);
  limit(`publish:${player.id}`, 3);
  const t = getTrackRow(id);
  if (t.creator_id !== player.id || t.official === 1)
    throw new HttpError(403, "Only its creator can update this circuit", "forbidden");
  const body = await readJson(req, 220_000);
  const name = body.name === undefined ? t.name : cleanText(body.name, TRACK_NAME_MAX);
  if (!name) throw new HttpError(422, "Give the circuit a name", "name");
  const description =
    body.description === undefined ? t.description : cleanText(body.description, DESCRIPTION_MAX);
  const d = getDb();
  const time = now();
  let revision = t.revision;
  let layout = t.layout;
  let preview = t.preview;
  if (body.track !== undefined) {
    const track = parseCircuit(body.track, name);
    const next = layoutHash(track);
    if (next !== t.layout) {
      revision = t.revision + 1;
      layout = next;
      preview = JSON.stringify(trackPreview(track));
      d.prepare(
        "INSERT INTO track_versions (track_id, revision, layout, data, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(t.id, revision, layout, toJson(track), time);
    }
  }
  d.prepare(
    "UPDATE tracks SET name = ?, description = ?, revision = ?, layout = ?, preview = ?, updated_at = ? WHERE id = ?",
  ).run(name, description, revision, layout, preview, time, t.id);
  return json({ id: t.id, revision, layout });
}

function likeTrack(req: Request, id: string) {
  const player = auth(req, true);
  limit(`like:${player.id}`, 30);
  const t = getTrackRow(id);
  const d = getDb();
  const had = d
    .prepare("SELECT 1 FROM likes WHERE track_id = ? AND player_id = ?")
    .get(t.id, player.id);
  if (had) d.prepare("DELETE FROM likes WHERE track_id = ? AND player_id = ?").run(t.id, player.id);
  else d.prepare("INSERT INTO likes (track_id, player_id) VALUES (?, ?)").run(t.id, player.id);
  d.prepare(
    "UPDATE tracks SET likes = (SELECT COUNT(*) FROM likes WHERE track_id = ?) WHERE id = ?",
  ).run(t.id, t.id);
  const likes = (d.prepare("SELECT likes FROM tracks WHERE id = ?").get(t.id) as { likes: number })
    .likes;
  return json({ liked: !had, likes });
}

/** Reports hide a community circuit from listings after five different players flag it. */
async function reportTrack(req: Request, id: string) {
  const player = auth(req, true);
  limit(`report:${player.id}`, 5);
  const t = getTrackRow(id);
  const body = await readJson(req, 2000);
  const reason = cleanText(body.reason, 200) || "unspecified";
  const d = getDb();
  d.prepare(
    "INSERT OR IGNORE INTO reports (track_id, player_id, reason, created_at) VALUES (?, ?, ?, ?)",
  ).run(t.id, player.id, reason, now());
  d.prepare(
    `UPDATE tracks SET reports = (SELECT COUNT(*) FROM reports WHERE track_id = ?),
       hidden = CASE WHEN official = 0 AND (SELECT COUNT(*) FROM reports WHERE track_id = ?) >= 5 THEN 1 ELSE hidden END
     WHERE id = ?`,
  ).run(t.id, t.id, t.id);
  return json({ reported: true });
}

function playTrack(req: Request, id: string) {
  const t = getTrackRow(id);
  // Once a minute per client and circuit: a counter, not a precise metric.
  try {
    limit(`play:${clientKey(req)}:${t.id}`, 1);
  } catch {
    return json({ plays: t.plays });
  }
  getDb().prepare("UPDATE tracks SET plays = plays + 1 WHERE id = ?").run(t.id);
  return json({ plays: t.plays + 1 });
}

// ─── Leaderboard ────────────────────────────────────────────────────────────

const LAYOUT_RE = /^[0-9a-f]{24}$/;

/** The circuit a layout belongs to (official first, then the earliest publication). */
function layoutTrack(layout: string) {
  const row = getDb()
    .prepare(
      `SELECT v.track_id, v.revision, v.data, t.name, t.official FROM track_versions v
       JOIN tracks t ON t.id = v.track_id WHERE v.layout = ?
       ORDER BY t.official DESC, v.created_at ASC LIMIT 1`,
    )
    .get(layout) as
    | { track_id: string; revision: number; data: string; name: string; official: number }
    | undefined;
  return row ?? null;
}

function leaderboard(req: Request, url: URL) {
  const player = auth(req, false);
  const layout = url.searchParams.get("layout") ?? "";
  if (!LAYOUT_RE.test(layout)) throw new HttpError(400, "Unknown circuit", "bad_request");
  const lim = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
  const owner = layoutTrack(layout);
  const d = getDb();
  const rows = d
    .prepare(
      `SELECT r.player_id, r.time, r.sectors, r.created_at, p.nickname FROM records r
       JOIN players p ON p.id = r.player_id WHERE r.layout = ? ORDER BY r.time ASC, r.created_at ASC LIMIT ?`,
    )
    .all(layout, lim) as {
    player_id: string;
    time: number;
    sectors: string;
    created_at: number;
    nickname: string | null;
  }[];
  const total = (
    d.prepare("SELECT COUNT(*) AS n FROM records WHERE layout = ?").get(layout) as {
      n: number;
    }
  ).n;
  let me: { rank: number; time: number } | null = null;
  if (player) {
    const mine = d
      .prepare("SELECT time, created_at FROM records WHERE layout = ? AND player_id = ?")
      .get(layout, player.id) as { time: number; created_at: number } | undefined;
    if (mine) me = { rank: rankOf(layout, mine.time, mine.created_at), time: mine.time };
  }
  return json({
    layout,
    track: owner
      ? {
          id: owner.track_id,
          revision: owner.revision,
          name: owner.name,
          official: owner.official === 1,
        }
      : null,
    total,
    entries: rows.map((r, i) => ({
      rank: i + 1,
      nickname: r.nickname ?? "Anonymous",
      time: r.time,
      sectors: JSON.parse(r.sectors) as number[],
      date: r.created_at,
      me: player !== null && r.player_id === player.id,
    })),
    me,
  });
}

function rankOf(layout: string, time: number, createdAt: number): number {
  const row = getDb()
    .prepare(
      "SELECT COUNT(*) AS n FROM records WHERE layout = ? AND (time < ? OR (time = ? AND created_at < ?))",
    )
    .get(layout, time, time, createdAt) as { n: number };
  return row.n + 1;
}

/** Replays running at once (each takes up to a few seconds of CPU for a 10-minute session). */
let activeReplays = 0;
const MAX_REPLAYS = 2;
/** Largest gap between the client's lap time and the server's replay of it. */
const TIME_TOLERANCE = 0.0005;

async function submitLap(req: Request) {
  limit(`laps:${clientKey(req)}`, 20);
  const player = auth(req, true);
  limit(`laps:${player.id}`, 10);
  if (!player.nickname) throw new HttpError(403, "Choose a nickname first", "nickname");
  const body = await readJson(req, 450_000);
  const { layout, lap, time, trace } = body;
  if (typeof layout !== "string" || !LAYOUT_RE.test(layout))
    throw new HttpError(400, "Unknown circuit", "bad_request");
  if (typeof lap !== "number" || !Number.isInteger(lap) || lap < 1 || lap > 500)
    throw new HttpError(400, "Invalid lap number", "bad_request");
  if (typeof time !== "number" || !Number.isFinite(time) || time <= 0 || time > 600)
    throw new HttpError(400, "Invalid lap time", "bad_request");
  if (typeof trace !== "string") throw new HttpError(400, "Missing input trace", "bad_request");

  const owner = layoutTrack(layout);
  if (!owner)
    throw new HttpError(
      404,
      "This circuit is not in the library: publish it to get a leaderboard",
      "unknown_layout",
    );
  const parsed = fromJson(owner.data);
  if (!parsed.ok || layoutHash(parsed.track) !== layout)
    throw new HttpError(500, "Stored circuit is damaged", "server");

  const traceHash = sha256(`${layout}|${lap}|${trace}`);
  const d = getDb();
  if (d.prepare("SELECT 1 FROM submissions WHERE trace_hash = ?").get(traceHash))
    throw new HttpError(409, "This lap was already submitted", "duplicate");

  let inputs;
  try {
    inputs = decodeTrace(trace);
  } catch (e) {
    throw new HttpError(400, `Unreadable input trace (${(e as Error).message})`, "bad_trace");
  }

  if (activeReplays >= MAX_REPLAYS)
    throw new HttpError(503, "The server is busy verifying laps, try again shortly", "busy");
  activeReplays++;
  let result;
  try {
    result = replay(parsed.track, inputs, lap);
  } finally {
    activeReplays--;
  }
  d.prepare("INSERT OR IGNORE INTO submissions (trace_hash, created_at) VALUES (?, ?)").run(
    traceHash,
    now(),
  );
  const replayed = result.laps.find((l) => l.lap === lap);
  if (!result.raceable || !replayed)
    throw new HttpError(
      422,
      "Rejected: replaying your inputs on this circuit does not complete that lap",
      "replay_mismatch",
    );
  if (Math.abs(replayed.time - time) > TIME_TOLERANCE)
    throw new HttpError(
      422,
      `Rejected: replaying your inputs gives ${replayed.time.toFixed(3)} s, not ${time.toFixed(3)} s`,
      "replay_mismatch",
    );
  if (replayed.sectors.length !== 3 || replayed.time < 2)
    throw new HttpError(422, "Rejected: the lap is not consistent with the timing rules", "rules");

  // The server's own time is what gets recorded.
  const verified = replayed.time;
  const created = now();
  const previous = d
    .prepare("SELECT time FROM records WHERE layout = ? AND player_id = ?")
    .get(layout, player.id) as { time: number } | undefined;
  const improved = !previous || verified < previous.time;
  if (improved) {
    d.prepare(
      `INSERT INTO records (layout, player_id, time, sectors, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(layout, player_id) DO UPDATE SET time = excluded.time, sectors = excluded.sectors, created_at = excluded.created_at`,
    ).run(layout, player.id, verified, JSON.stringify(replayed.sectors), created);
  }
  const best = improved ? verified : previous!.time;
  const bestAt = improved
    ? created
    : (
        d
          .prepare("SELECT created_at FROM records WHERE layout = ? AND player_id = ?")
          .get(layout, player.id) as {
          created_at: number;
        }
      ).created_at;
  return json({
    status: "verified",
    time: verified,
    improved,
    best,
    rank: rankOf(layout, best, bestAt),
  });
}

// ─── Router ─────────────────────────────────────────────────────────────────

export async function handle(req: Request, segments: string[]): Promise<Response> {
  const url = new URL(req.url);
  const [a, b, c] = segments;
  const method = req.method;
  try {
    if (a === "players" && !b && method === "POST") return createPlayer(req);
    if (a === "players" && b === "me" && method === "GET") {
      const p = auth(req, true);
      return json({ id: p.id, nickname: p.nickname });
    }
    if (a === "players" && b === "me" && method === "PUT") return await setNickname(req);
    if (a === "leaderboard" && method === "GET") return leaderboard(req, url);
    if (a === "laps" && method === "POST") return await submitLap(req);
    if (a === "tracks" && !b && method === "GET") return listTracks(req, url);
    if (a === "tracks" && !b && method === "POST") return await publishTrack(req);
    if (a === "tracks" && b && !c && method === "GET") return getTrack(req, b, url);
    if (a === "tracks" && b && !c && method === "PUT") return await updateTrack(req, b);
    if (a === "tracks" && b && c === "like" && method === "POST") return likeTrack(req, b);
    if (a === "tracks" && b && c === "report" && method === "POST")
      return await reportTrack(req, b);
    if (a === "tracks" && b && c === "play" && method === "POST") return playTrack(req, b);
    return json({ error: "Not found", code: "not_found" }, 404);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
    console.error("[api]", e);
    return json({ error: "Server error", code: "server" }, 500);
  }
}
