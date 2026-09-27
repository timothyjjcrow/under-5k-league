export const TEAM_LOGO_URL_MAX_LENGTH = 2048;

export type TeamLogoUrlResult =
  | { logoUrl: string | null }
  | { error: string };

const DISCORD_ATTACHMENT_LOGO_ERROR =
  "Discord image links stop working after about a day, and the crest falls back to initials. Upload the logo somewhere permanent (Imgur, for example) and paste that image link instead.";

/**
 * A file uploaded to Discord. Its links are signed and expire (the `ex=`
 * parameter), so a crest pasted from a Discord message quietly turns back into
 * initials a day later. Server icons, avatars and emoji on the same CDN are
 * permanent and stay allowed.
 */
function isDiscordAttachment(url: URL): boolean {
  return (
    /(^|\.)discordapp\.(com|net)$/.test(url.hostname) &&
    /^\/(ephemeral-)?attachments\//.test(url.pathname)
  );
}

/**
 * Normalize an admin-supplied team logo location.
 *
 * Production pages are HTTPS, so accepting HTTP would create a logo that the
 * browser blocks as mixed content. Root-relative paths remain useful for
 * artwork deployed with the app, while protocol-relative and data URLs are
 * deliberately refused, and so are Discord attachment links, which expire.
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
  if (isDiscordAttachment(url)) return { error: DISCORD_ATTACHMENT_LOGO_ERROR };
  const canonical = url.toString();
  if (canonical.length > TEAM_LOGO_URL_MAX_LENGTH) {
    return {
      error: `Logo URL must be ${TEAM_LOGO_URL_MAX_LENGTH.toLocaleString("en-US")} characters or fewer`,
    };
  }
  return { logoUrl: canonical };
}
