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

const NOT_AN_IMAGE_FILE_ERROR =
  "Use a direct link to the image file itself, like https://i.imgur.com/abc.png.";

const SITE_PATH_LOGO_ERROR =
  "A logo stored on this site must be a path to an image file, like /brand/logo.png.";

/**
 * Artwork deployed with the app: a plain path whose last part is an image
 * file. No query string, no "." or ".." parts and no percent-encoding, so the
 * path can't be steered anywhere else once the browser resolves it.
 */
const SITE_IMAGE_PATH =
  /^(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)+\.(?:png|jpe?g|gif|webp|avif|svg)$/i;

/**
 * The app's own endpoints. Every route handler lives under /api, and several
 * act on a GET (starting a Discord link, exporting a season). A logo renders
 * as an <img> on every team surface, and an image request to the site
 * carries the viewer's cookies, so a logo pointing there would run that
 * endpoint as whoever looks at the team.
 *
 * This only sees the address as typed. An outside image URL that redirects
 * here still gets through, so it is a guard against mistakes, not a security
 * boundary: every /api GET must stay harmless when a browser loads it as an
 * image.
 */
function isAppEndpoint(pathname: string): boolean {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A malformed escape can't be routed as /api anyway.
  }
  return /^\/+api(\/|$)/i.test(decoded);
}

/** The image hosts a captain may point their crest at. */
const CAPTAIN_LOGO_HOSTS = new Set(["i.imgur.com"]);

export const CAPTAIN_LOGO_HOST_ERROR =
  "Captains can use an Imgur image link (https://i.imgur.com/…). For another host, ask an admin.";

/**
 * Whether a captain may set this (already normalized) logo. A crest is loaded
 * by every visitor's browser on standings, schedule, team and match pages, so
 * a logo on a server the captain runs would show them every visitor's IP
 * address, and could change what it shows with no new save. Captains get
 * Imgur and the site's own artwork; admins may still use any HTTPS host.
 */
export function isCaptainLogoHost(logoUrl: string): boolean {
  if (logoUrl.startsWith("/") && !logoUrl.startsWith("//")) {
    return SITE_IMAGE_PATH.test(logoUrl);
  }
  try {
    const url = new URL(logoUrl);
    return url.protocol === "https:" && CAPTAIN_LOGO_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Normalize a team logo location typed by an admin or the team's captain.
 *
 * Production pages are HTTPS, so accepting HTTP would create a logo that the
 * browser blocks as mixed content. Root-relative paths remain useful for
 * artwork deployed with the app, but only as a plain path to an image file,
 * never one of the app's own endpoints. Protocol-relative and data URLs are
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
    if (isAppEndpoint(value) || !SITE_IMAGE_PATH.test(value)) {
      return { error: SITE_PATH_LOGO_ERROR };
    }
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
  // The site's own address typed in full is the same request as a path; the
  // host can't be checked here (two leagues, previews), so no host may serve
  // a logo from /api.
  if (isAppEndpoint(url.pathname)) return { error: NOT_AN_IMAGE_FILE_ERROR };
  const canonical = url.toString();
  if (canonical.length > TEAM_LOGO_URL_MAX_LENGTH) {
    return {
      error: `Logo URL must be ${TEAM_LOGO_URL_MAX_LENGTH.toLocaleString("en-US")} characters or fewer`,
    };
  }
  return { logoUrl: canonical };
}
