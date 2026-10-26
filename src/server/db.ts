import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDefaultTrack } from "@/game/track/defaultTrack";
import { layoutHash } from "@/game/track/layoutHash";
import { trackPreview } from "@/game/track/preview";
import { toJson } from "@/game/track/TrackSerializer";

// Storage for the leaderboard and the track library: SQLite through Node's built-in node:sqlite
// (no extra dependency, one file on disk). The file lives at KARTING_DB, or data/karting.sqlite
// under the working directory; ":memory:" gives a throwaway database (tests).
//
// What is stored, and nothing else: anonymous players (random id, hash of their secret token,
// nickname), circuits and their immutable published versions, verified lap records, and hashes
// of submitted traces (duplicate detection). No IP addresses, e-mails or other personal data.

export const OFFICIAL_TRACK_ID = "pinewood-park";

let db: DatabaseSync | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  nickname TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  creator_id TEXT REFERENCES players(id),
  official INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL,
  layout TEXT NOT NULL,
  preview TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  likes INTEGER NOT NULL DEFAULT 0,
  plays INTEGER NOT NULL DEFAULT 0,
  reports INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS track_versions (
  track_id TEXT NOT NULL REFERENCES tracks(id),
  revision INTEGER NOT NULL,
  layout TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (track_id, revision)
);
CREATE INDEX IF NOT EXISTS track_versions_layout ON track_versions(layout);
CREATE TABLE IF NOT EXISTS records (
  layout TEXT NOT NULL,
  player_id TEXT NOT NULL REFERENCES players(id),
  time REAL NOT NULL,
  sectors TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (layout, player_id)
);
CREATE INDEX IF NOT EXISTS records_rank ON records(layout, time);
CREATE TABLE IF NOT EXISTS submissions (
  trace_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS likes (
  track_id TEXT NOT NULL REFERENCES tracks(id),
  player_id TEXT NOT NULL REFERENCES players(id),
  PRIMARY KEY (track_id, player_id)
);
CREATE TABLE IF NOT EXISTS reports (
  track_id TEXT NOT NULL REFERENCES tracks(id),
  player_id TEXT NOT NULL REFERENCES players(id),
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (track_id, player_id)
);
`;

/** The official circuit every installation starts with (the game's default track). */
function seed(d: DatabaseSync) {
  const exists = d.prepare("SELECT 1 FROM tracks WHERE id = ?").get(OFFICIAL_TRACK_ID);
  if (exists) return;
  const track = createDefaultTrack();
  const layout = layoutHash(track);
  const now = Date.now();
  d.prepare(
    `INSERT INTO tracks (id, name, description, creator_id, official, revision, layout, preview, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 1, 1, ?, ?, ?, ?)`,
  ).run(
    OFFICIAL_TRACK_ID,
    track.name,
    "The home circuit: a flowing lap through the pines.",
    layout,
    JSON.stringify(trackPreview(track)),
    now,
    now,
  );
  d.prepare(
    "INSERT INTO track_versions (track_id, revision, layout, data, created_at) VALUES (?, 1, ?, ?, ?)",
  ).run(OFFICIAL_TRACK_ID, layout, toJson(track), now);
}

export function getDb(): DatabaseSync {
  if (db) return db;
  const file = process.env.KARTING_DB ?? path.join(process.cwd(), "data", "karting.sqlite");
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON;");
  if (file !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  seed(db);
  return db;
}

/** Tests: start again from an empty (in-memory) database. */
export function resetDb() {
  db?.close();
  db = null;
}
