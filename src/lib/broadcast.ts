import { MATCH_PHASE, MATCH_STATUS } from "./constants";
import { seriesEstimateMinutes } from "./series-lengths";

// The league's match stream: ONE channel for the whole league, which an admin
// sets on /admin (Setting LEAGUE_STREAM_URL; each league has its own database,
// so its own channel). Playoff and final matches link to it: "Streamed on
// Twitch" before kickoff, then "Live now · Watch on Twitch" from 15 minutes
// before kickoff until the series should be over. It is an outbound link,
// never an embedded player: a player would hand every visitor's address to
// the streaming site. Per-match links and replays need a column on Match,
// which is a database release, so they are not here.

export const STREAM_URL_MAX_LENGTH = 2048;

export type StreamPlatform = "Twitch" | "YouTube" | "Kick";

/** The one stored channel, checked again on every read. */
export type LeagueStream = { url: string; platform: StreamPlatform };

// Exact host names only: a suffix or "contains" match would take
// twitch.tv.example.com or example.com/twitch.tv.
const STREAM_HOSTS: ReadonlyMap<string, StreamPlatform> = new Map([
  ["twitch.tv", "Twitch"],
  ["www.twitch.tv", "Twitch"],
  ["m.twitch.tv", "Twitch"],
  ["youtube.com", "YouTube"],
  ["www.youtube.com", "YouTube"],
  ["m.youtube.com", "YouTube"],
  ["youtu.be", "YouTube"],
  ["kick.com", "Kick"],
  ["www.kick.com", "Kick"],
]);

export const STREAM_HOST_ERROR =
  "Use a Twitch, YouTube or Kick link, like https://www.twitch.tv/yourchannel.";
const INVALID_STREAM_URL = "Enter a valid HTTPS stream link.";
const TOO_LONG = `Stream links must be ${STREAM_URL_MAX_LENGTH.toLocaleString("en-US")} characters or fewer.`;

export type StreamUrlResult =
  | { stream: LeagueStream | null }
  | { error: string };

/**
 * Check a stream link an admin typed. Blank clears it. Anything else must be
 * an https link on a known streaming host, with no username, password or
 * port; the stored form is the URL parser's canonical one, which the toast
 * repeats.
 */
export function normalizeStreamUrl(raw: string): StreamUrlResult {
  const value = raw.trim();
  if (!value) return { stream: null };
  if (value.length > STREAM_URL_MAX_LENGTH) return { error: TOO_LONG };
  // Whitespace, control characters and backslashes: browsers repair them
  // differently, so what one visitor opens could differ from what was saved.
  if (/[\\\s\u0000-\u001F\u007F]/.test(value)) {
    return { error: INVALID_STREAM_URL };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { error: INVALID_STREAM_URL };
  }
  if (url.protocol !== "https:") {
    return { error: "Stream links must start with https://." };
  }
  if (url.username || url.password) {
    return { error: "Stream links can't include a username or password." };
  }
  const platform = STREAM_HOSTS.get(url.hostname);
  if (!platform || url.port) return { error: STREAM_HOST_ERROR };
  const canonical = url.toString();
  if (canonical.length > STREAM_URL_MAX_LENGTH) return { error: TOO_LONG };
  return { stream: { url: canonical, platform } };
}

/**
 * The stored setting as a link to render, or null. A stored value that no
 * longer passes the check above (an older save, a host taken off the list)
 * renders nothing rather than an unchecked link.
 */
export function parseStoredStream(raw: string | null): LeagueStream | null {
  if (!raw) return null;
  const result = normalizeStreamUrl(raw);
  return "stream" in result ? result.stream : null;
}

/** How early before kickoff a match starts saying "Live now". */
export const WATCH_OPENS_BEFORE_KICKOFF_MS = 15 * 60_000;

export type WatchWindow = {
  /** Kickoff minus 15 minutes: from here the link says "Live now". */
  opensAtMs: number;
  /** Kickoff plus the series estimate: from here the link is gone. */
  closesAtMs: number;
};

/**
 * When a match links the league stream, or null when it never does. Playoff
 * and final matches only (the regular season stays as it was), of the active
 * season, with a kickoff, still to be decided and not ruled a forfeit. The
 * window ends when the series should be over (seriesEstimateMinutes, the
 * calendar's event length), so a series that never gets its result still
 * stops saying it is live. A retime moves the window with the kickoff.
 */
export function matchWatchWindow(
  match: {
    phase: string;
    status: string;
    forfeit: boolean;
    scheduledAt: Date | null;
    bestOf: number;
  },
  seasonIsActive: boolean,
): WatchWindow | null {
  if (!seasonIsActive) return null;
  if (match.phase !== MATCH_PHASE.PLAYOFF && match.phase !== MATCH_PHASE.FINAL) {
    return null;
  }
  if (match.status === MATCH_STATUS.COMPLETED || match.forfeit) return null;
  if (!match.scheduledAt) return null;
  const kickoff = match.scheduledAt.getTime();
  return {
    opensAtMs: kickoff - WATCH_OPENS_BEFORE_KICKOFF_MS,
    closesAtMs: kickoff + seriesEstimateMinutes(match.bestOf) * 60_000,
  };
}

/**
 * What the link says at `nowMs`: "soon" before the window (where the match
 * will be streamed), "live" inside it, null once it has closed. Decided in
 * the browser (watch-link.tsx), so a tab left open crosses both edges.
 */
export function watchState(
  window: WatchWindow,
  nowMs: number,
): "soon" | "live" | null {
  if (nowMs < window.opensAtMs) return "soon";
  if (nowMs < window.closesAtMs) return "live";
  return null;
}
