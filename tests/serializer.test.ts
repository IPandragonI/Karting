import { describe, expect, it } from "vitest";
import { createDefaultTrack } from "@/game/track/defaultTrack";
import {
  decodeTrack,
  encodeTrack,
  fromJson,
  shareUrl,
  toJson,
  trackFromHash,
} from "@/game/track/TrackSerializer";

describe("TrackSerializer", () => {
  it("round-trips the default track through JSON", () => {
    const t = createDefaultTrack();
    const r = fromJson(toJson(t));
    expect(r).toEqual({ ok: true, track: t });
  });

  it("round-trips through a compact URL, including a Unicode name", () => {
    const t = { ...createDefaultTrack(), name: "Pistes d'été 🏁" };
    const param = encodeTrack(t);
    expect(param).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(param.length).toBeLessThan(200);
    expect(decodeTrack(param)).toEqual({ ok: true, track: t });
  });

  it("builds and reads share links from the URL fragment", () => {
    const t = createDefaultTrack();
    const url = shareUrl(t, "https://example.test/play?x=1");
    expect(url.startsWith("https://example.test/play?x=1#track=")).toBe(true);
    expect(trackFromHash(new URL(url).hash)).toEqual({ ok: true, track: t });
    expect(trackFromHash("#other=1")).toBeNull();
  });

  it("rejects malformed and hostile JSON with a readable error", () => {
    expect(fromJson("{")).toEqual({ ok: false, error: "Not valid JSON" });
    expect(fromJson("[]")).toEqual({ ok: false, error: "Not a track file" });
    expect(fromJson(JSON.stringify({ format: "other" }))).toMatchObject({ ok: false });
    const base = { format: "low-poly-karting", version: 1, name: "x" };
    expect(fromJson(JSON.stringify({ ...base, version: 9, pieces: [] }))).toEqual({
      ok: false,
      error: "Unsupported track version 9",
    });
    expect(fromJson(JSON.stringify({ ...base, pieces: [["rocket", 0, 0, 0]] }))).toEqual({
      ok: false,
      error: "Piece 1 has an unknown type",
    });
    expect(fromJson(JSON.stringify({ ...base, pieces: [["straight", 0.5, 0, 0]] }))).toMatchObject({
      ok: false,
    });
    expect(fromJson(JSON.stringify({ ...base, pieces: [["straight", 0, 0, 7]] }))).toMatchObject({
      ok: false,
    });
    expect(fromJson(JSON.stringify({ ...base, pieces: [["straight", 999, 0, 0]] }))).toMatchObject({
      ok: false,
    });
    expect(
      fromJson(
        JSON.stringify({
          ...base,
          pieces: [
            ["straight", 0, 0, 0],
            ["corner", 0, 0, 1],
          ],
        }),
      ),
    ).toEqual({ ok: false, error: "Pieces overlap each other" });
    expect(
      fromJson(JSON.stringify({ ...base, pieces: new Array(1000).fill(["straight", 0, 0, 0]) })),
    ).toMatchObject({
      ok: false,
    });
  });

  it("sanitizes names", () => {
    const r = fromJson(
      JSON.stringify({
        format: "low-poly-karting",
        version: 1,
        name: "\u0007<b>" + "x".repeat(80),
        pieces: [],
      }),
    );
    expect(r.ok && r.track.name).toBe(("<b>" + "x".repeat(80)).slice(0, 32));
    const unnamed = fromJson(
      JSON.stringify({ format: "low-poly-karting", version: 1, name: 42, pieces: [] }),
    );
    expect(unnamed.ok && unnamed.track.name).toBe("Shared circuit");
  });

  it("rejects damaged or truncated links", () => {
    const param = encodeTrack(createDefaultTrack());
    expect(decodeTrack(param.slice(0, 20))).toMatchObject({ ok: false });
    expect(decodeTrack("not*base64")).toEqual({ ok: false, error: "The link is damaged" });
    expect(decodeTrack("")).toMatchObject({ ok: false });
  });
});
