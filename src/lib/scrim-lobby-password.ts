import { createHmac } from "node:crypto";

// Server only (node:crypto, and the secret). Kept out of scrim-lobby.ts so
// that pure module stays importable anywhere.

/** No i, l, o, 0 or 1: a password read off a phone and typed into Dota. */
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const LENGTH = 6;
const DEV_FALLBACK_SECRET = "insecure-dev-scrim-lobby-secret-0123456789";

/**
 * A booked scrim's lobby password, the same for every reader, so both teams
 * take it from the scrim page instead of waiting for the host to pass it
 * around on Discord. It is an HMAC of the scrim id under the site's
 * AUTH_SECRET with its own label: the id is public (it is in the URL), the
 * secret isn't, so only the people the page shows it to (both teams, their
 * coaches, admins) know it.
 *
 * Null when production has no usable secret: the page then asks the host to
 * choose a password and share it, rather than printing a guessable one.
 */
export function scrimLobbyPassword(scrimId: string): string | null {
  const configured = process.env.AUTH_SECRET;
  const secret =
    configured && configured.length >= 32
      ? configured
      : process.env.NODE_ENV === "production"
        ? null
        : DEV_FALLBACK_SECRET;
  if (!secret) return null;
  const digest = createHmac("sha256", secret)
    .update(`scrim-lobby-password:${scrimId}`)
    .digest();
  let password = "";
  for (let i = 0; i < LENGTH; i++) {
    password += ALPHABET[digest[i]! % ALPHABET.length];
  }
  return password;
}
