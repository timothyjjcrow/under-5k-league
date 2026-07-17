// Loose validation for a Discord username. Modern handles are 2-32 chars of
// lowercase letters, digits, underscore and period, but legacy "Name#1234"
// tags and mixed case still float around — we normalize whitespace and an
// optional leading @, lowercase modern-style input, and only reject things
// that can't possibly be a handle. This is contact info, not auth — being
// permissive beats bouncing a player who typed their tag from memory.

const LEGACY_TAG = /^[^@#:\s]{2,32}#\d{4}$/; // Name#1234
const MODERN = /^[a-z0-9._]{2,32}$/;

/**
 * Normalize user input into a storable Discord handle, or null when it can't
 * be one. Returns "" for blank input (= clear the field).
 */
export function normalizeDiscordName(input: string): string | null {
  const trimmed = input.trim().replace(/^@/, "");
  if (trimmed === "") return "";
  if (LEGACY_TAG.test(trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  if (MODERN.test(lower)) return lower;
  return null;
}
