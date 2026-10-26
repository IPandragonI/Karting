import { beforeAll, describe, expect, it } from "vitest";
import { createDefaultTrack } from "@/game/track/defaultTrack";
import { mirrorTrack } from "@/game/track/editing";
import { layoutHash } from "@/game/track/layoutHash";
import type { TrackData } from "@/game/track/Track";
import { toJson } from "@/game/track/TrackSerializer";
import { handle } from "@/server/api";
import { resetDb } from "@/server/db";
import { drive } from "./helpers/autopilot";

process.env.KARTING_DB = ":memory:";

let ip = 0;
/** Calls the API like the route does; each call comes from a fresh client address by default. */
async function api(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string; from?: string; raw?: string } = {},
) {
  const headers: Record<string, string> = { "x-forwarded-for": opts.from ?? `10.0.0.${++ip}` };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const body = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  if (body !== undefined) headers["content-type"] = "application/json";
  const url = new URL(`http://test/api/${path}`);
  const res = await handle(
    new Request(url, { method, headers, body }),
    url.pathname.split("/").slice(2),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function newPlayer(nickname?: string) {
  const r = await api("POST", "players");
  const token = r.body.token as string;
  if (nickname) await api("PUT", "players/me", { token, body: { nickname } });
  return token;
}

const official = createDefaultTrack();
const officialLayout = layoutHash(official);
let session: ReturnType<typeof drive>;

beforeAll(() => {
  resetDb();
  session = drive(official, 2);
});

describe("players and nicknames", () => {
  it("creates anonymous players and validates nicknames", async () => {
    const token = await newPlayer();
    expect((await api("GET", "players/me", { token })).body).toMatchObject({ nickname: null });
    for (const bad of ["", "   ", "x".repeat(17), 42])
      expect((await api("PUT", "players/me", { token, body: { nickname: bad } })).status).toBe(422);
    const ok = await api("PUT", "players/me", {
      token,
      body: { nickname: "  Ada​  Lovelace " },
    });
    expect(ok.body.nickname).toBe("Ada Lovelace");
    // Nicknames are labels: two players may share one.
    const other = await newPlayer("Ada Lovelace");
    expect((await api("GET", "players/me", { token: other })).body.nickname).toBe("Ada Lovelace");
  });

  it("refuses unknown or malformed tokens", async () => {
    expect((await api("GET", "players/me")).status).toBe(401);
    expect(
      (await api("GET", "players/me", { token: "abcdefgh.notarealsecretnotarealsecret" })).status,
    ).toBe(401);
    const token = await newPlayer();
    const forged = token.replace(/\.(.)/, (_, c: string) => `.${c === "a" ? "b" : "a"}`);
    expect((await api("GET", "players/me", { token: forged })).status).toBe(401);
  });
});

describe("verified laps", () => {
  it("records a lap only after replaying the inputs, with the server's own time", async () => {
    const token = await newPlayer("Racer");
    const r = await api("POST", "laps", {
      token,
      body: { layout: officialLayout, lap: 2, time: session.times[1], trace: session.trace },
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "verified", improved: true, rank: 1 });
    expect(r.body.time).toBe(session.times[1]);
    const board = await api("GET", `leaderboard?layout=${officialLayout}`, { token });
    expect(board.body.track).toMatchObject({ name: "Pinewood Park", official: true });
    expect(board.body.entries).toHaveLength(1);
    expect(board.body.entries[0]).toMatchObject({ rank: 1, nickname: "Racer", me: true });
    expect(board.body.entries[0].sectors).toHaveLength(3);
    expect(board.body.me).toMatchObject({ rank: 1 });
  });

  it("rejects a modified time, a lap the inputs never drove, and fabricated inputs", async () => {
    const token = await newPlayer("Cheater");
    const tampered = await api("POST", "laps", {
      token,
      body: { layout: officialLayout, lap: 1, time: session.times[0]! - 1, trace: session.trace },
    });
    expect(tampered.status).toBe(422);
    expect(tampered.body.code).toBe("replay_mismatch");
    const noSuchLap = await api("POST", "laps", {
      token,
      body: { layout: officialLayout, lap: 9, time: 15, trace: session.trace },
    });
    expect(noSuchLap.body.code).toBe("replay_mismatch");
    // Invented inputs (20 s of a "driver" that never steers), claiming a superb lap.
    const fake = drive(official, 99, 0, 0, 1200).trace;
    const invented = await api("POST", "laps", {
      token,
      body: { layout: officialLayout, lap: 1, time: 12.5, trace: fake },
    });
    expect(invented.status).toBe(422);
    const garbage = await api("POST", "laps", {
      token,
      body: { layout: officialLayout, lap: 1, time: 12.5, trace: "S1RvdGFsbHkgZmFrZQ==" },
    });
    expect(garbage.status).toBe(400);
    const board = await api("GET", `leaderboard?layout=${officialLayout}`);
    expect(board.body.entries.map((e: { nickname: string }) => e.nickname)).not.toContain(
      "Cheater",
    );
  });

  it("refuses duplicates, unknown circuits, missing nicknames and oversized requests", async () => {
    const token = await newPlayer("Twice");
    const own = drive(official, 1, 0.5);
    const body = { layout: officialLayout, lap: 1, time: own.times[0], trace: own.trace };
    expect((await api("POST", "laps", { token, body })).status).toBe(200);
    expect((await api("POST", "laps", { token, body })).status).toBe(409);
    // A circuit nobody published (edited locally): no leaderboard to post to.
    const local = mirrorTrack(official);
    const localLap = drive(local, 1);
    const unknown = await api("POST", "laps", {
      token,
      body: { layout: layoutHash(local), lap: 1, time: localLap.times[0], trace: localLap.trace },
    });
    expect(unknown.status).toBe(404);
    const anonymous = await newPlayer();
    expect((await api("POST", "laps", { token: anonymous, body })).status).toBe(403);
    expect((await api("POST", "laps", { body })).status).toBe(401);
    expect((await api("POST", "laps", { token, raw: "x".repeat(500_000) })).status).toBe(413);
    expect((await api("GET", "leaderboard?layout=../etc")).status).toBe(400);
  });

  it("rate-limits a client hammering the API", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++)
      statuses.push((await api("POST", "players", { from: "10.1.1.1" })).status);
    expect(statuses).toContain(429);
  });
});

describe("track library", () => {
  const circuit = (t: TrackData) => toJson(t);

  it("publishes valid circuits only, lists them, and serves the exact data", async () => {
    const token = await newPlayer("Builder");
    const broken = { ...official, pieces: official.pieces.slice(0, 5) };
    const bad = await api("POST", "tracks", {
      token,
      body: { name: "Broken", track: circuit(broken) },
    });
    expect(bad.status).toBe(422);
    const unnamed = await api("POST", "tracks", {
      token,
      body: { name: "  ", track: circuit(official) },
    });
    expect(unnamed.status).toBe(422);
    const mirrored = mirrorTrack(official);
    const pub = await api("POST", "tracks", {
      token,
      body: {
        name: "Mirror Park",
        description: "Pinewood, the other way round",
        track: circuit(mirrored),
      },
    });
    expect(pub.status).toBe(201);
    expect(pub.body.layout).toBe(layoutHash(mirrored));
    const list = await api("GET", "tracks?sort=recent", { token });
    const mine = list.body.tracks.find((t: { id: string }) => t.id === pub.body.id);
    expect(mine).toMatchObject({
      name: "Mirror Park",
      creator: "Builder",
      official: false,
      mine: true,
    });
    const home = list.body.tracks.find((t: { official: boolean }) => t.official);
    expect(home.name).toBe("Pinewood Park");
    const got = await api("GET", `tracks/${pub.body.id}`);
    expect(got.body.version.layout).toBe(layoutHash(mirrored));
    expect(JSON.parse(got.body.version.data).pieces).toHaveLength(mirrored.pieces.length);
    expect((await api("GET", "tracks/nope")).status).toBe(404);
  });

  it("versions layout changes, keeping older revisions and their records intact", async () => {
    const token = await newPlayer("Versioner");
    const v1 = mirrorTrack(official);
    const pub = await api("POST", "tracks", {
      token,
      body: { name: "Evolving", track: circuit(v1) },
    });
    const id = pub.body.id as string;
    // A lap on revision 1.
    const lap = drive(v1, 1);
    const rec = await api("POST", "laps", {
      token,
      body: { layout: pub.body.layout, lap: 1, time: lap.times[0], trace: lap.trace },
    });
    expect(rec.status).toBe(200);
    // Only its creator may update it.
    const stranger = await newPlayer("Stranger");
    const hijack = await api("PUT", `tracks/${id}`, {
      token: stranger,
      body: { name: "Mine now" },
    });
    expect(hijack.status).toBe(403);
    // Revision 2: a different layout.
    const upd = await api("PUT", `tracks/${id}`, { token, body: { track: circuit(official) } });
    expect(upd.body).toMatchObject({ revision: 2, layout: officialLayout });
    // A metadata-only change keeps the revision.
    const meta = await api("PUT", `tracks/${id}`, {
      token,
      body: { description: "Now both ways" },
    });
    expect(meta.body.revision).toBe(2);
    const r1 = await api("GET", `tracks/${id}?rev=1`);
    expect(r1.body.version.layout).toBe(layoutHash(v1));
    expect(r1.body.version.best).toBe(lap.times[0]);
    expect(r1.body.versions.map((v: { revision: number }) => v.revision)).toEqual([2, 1]);
  });

  it("toggles likes and hides a circuit after five reports", async () => {
    const owner = await newPlayer("Owner");
    const pub = await api("POST", "tracks", {
      token: owner,
      body: { name: "Flagged", track: circuit(mirrorTrack(official)) },
    });
    const id = pub.body.id as string;
    const fan = await newPlayer("Fan");
    expect((await api("POST", `tracks/${id}/like`, { token: fan })).body).toEqual({
      liked: true,
      likes: 1,
    });
    expect((await api("POST", `tracks/${id}/like`, { token: fan })).body).toEqual({
      liked: false,
      likes: 0,
    });
    for (let i = 0; i < 5; i++) {
      const t = await newPlayer(`Reporter${i}`);
      await api("POST", `tracks/${id}/report`, { token: t, body: { reason: "broken" } });
    }
    const list = await api("GET", "tracks?sort=recent");
    expect(list.body.tracks.some((t: { id: string }) => t.id === id)).toBe(false);
  });
});
