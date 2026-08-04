// Validate a post-login return path. Only same-origin RELATIVE paths pass:
// must start with a single "/" (never "//host" scheme-relative), no
// backslashes (browsers normalize them to slashes, re-opening //), no
// protocols. Anything suspect returns null — callers fall back to "/".
// Never render the raw input anywhere; a validated path in an href/redirect
// is the only use.

const MAX_LEN = 512;

export function safeReturnPath(input: string | null | undefined): string | null {
  if (!input) return null;
  const p = input.trim();
  if (p.length === 0 || p.length > MAX_LEN) return null;
  if (!p.startsWith("/")) return null;
  if (p.startsWith("//")) return null; // scheme-relative → other origin
  if (p.includes("\\")) return null;
  if (p.includes("://")) return null;
  // Control characters (incl. CR/LF header-splitting) never belong in a path.
  if (/[\x00-\x1f]/.test(p)) return null;
  return p;
}

// One-shot httpOnly cookie carrying the validated path across the Steam
// OpenID round-trip (set by /api/auth/steam, consumed by its callback).
export const RETURN_COOKIE = "ld2l_return_to";

// One-shot browser binding for Steam OpenID. Steam signs return_to, while this
// httpOnly value proves the callback completed in the browser that initiated
// the login (prevents login-CSRF/account-confusion).
export const STEAM_STATE_COOKIE = "ld2l_steam_state";
