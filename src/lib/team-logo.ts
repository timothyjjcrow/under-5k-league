export const TEAM_LOGO_URL_MAX_LENGTH = 2048;

export type TeamLogoUrlResult =
  | { logoUrl: string | null }
  | { error: string };

/**
 * Normalize an admin-supplied team logo location.
 *
 * Production pages are HTTPS, so accepting HTTP would create a logo that the
 * browser blocks as mixed content. Root-relative paths remain useful for
 * artwork deployed with the app, while protocol-relative and data URLs are
 * deliberately refused.
 */
export function normalizeTeamLogoUrl(raw: string): TeamLogoUrlResult {
  const value = raw.trim();
  if (!value) return { logoUrl: null };
  if (value.length > TEAM_LOGO_URL_MAX_LENGTH) {
    return {
      error: `Logo URL must be ${TEAM_LOGO_URL_MAX_LENGTH.toLocaleString("en-US")} characters or fewer`,
    };
  }
  if (/[\\\u0000-\u001F\u007F]/.test(value)) {
    return { error: "Enter a valid HTTPS logo URL" };
  }

  if (value.startsWith("/") && !value.startsWith("//")) {
    return { logoUrl: value };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { error: "Enter a valid HTTPS logo URL" };
  }
  if (url.protocol !== "https:") {
    return { error: "Team logos must use HTTPS" };
  }
  if (url.username || url.password) {
    return { error: "Team logo URLs cannot include credentials" };
  }
  const canonical = url.toString();
  if (canonical.length > TEAM_LOGO_URL_MAX_LENGTH) {
    return {
      error: `Logo URL must be ${TEAM_LOGO_URL_MAX_LENGTH.toLocaleString("en-US")} characters or fewer`,
    };
  }
  return { logoUrl: canonical };
}
