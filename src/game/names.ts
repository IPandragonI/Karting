// Text people type that other players will see: nicknames, circuit names and descriptions.
// Normalized the same way in the browser (immediate feedback) and on the server (authoritative):
// Unicode NFC, no control or invisible formatting characters, whitespace collapsed, trimmed,
// length limits in characters. Display is always as plain text (React escapes it), so no markup
// can get through; this keeps names tidy and unambiguous.

export const NICKNAME_MAX = 16;
export const TRACK_NAME_MAX = 32;
export const DESCRIPTION_MAX = 200;

export type CleanResult = { ok: true; value: string } | { ok: false; error: string };

/** Collapses and strips a free-text value; `max` in characters (code points). */
export function cleanText(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  const s = raw
    .normalize("NFC")
    // Control, format (zero-width, bidi overrides…), private-use and unassigned characters.
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(s).slice(0, max).join("").trim();
}

/**
 * A display nickname: 1–16 characters after cleaning. It is a label only: several players may
 * pick the same one, and it proves nothing about who someone is.
 */
export function normalizeNickname(raw: unknown): CleanResult {
  if (typeof raw !== "string") return { ok: false, error: "Enter a nickname" };
  const value = cleanText(raw, Infinity);
  if (!value) return { ok: false, error: "Enter a nickname" };
  if (Array.from(value).length > NICKNAME_MAX)
    return { ok: false, error: `At most ${NICKNAME_MAX} characters` };
  return { ok: true, value };
}
