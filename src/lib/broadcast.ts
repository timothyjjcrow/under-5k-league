import { MATCH_PHASE, MATCH_STATUS } from "./constants";
import { seriesEstimateMinutes } from "./series-lengths";

// The league's match stream: ONE channel for the whole league, which an admin
// sets on /admin (Setting LEAGUE_STREAM_URL; each league has its own database,
// so its own channel). Playoff and final matches link to it: "Streamed on
// Twitch" before kickoff, then "Live now · Watch on Twitch" from 15 minutes
// before kickoff until the series should be over (longer once a game is in).
// While a match is live its page can also play the stream in place, in the
// streaming site's own player (streamEmbed, stream-player.tsx). Nothing of
// that player loads until a visitor presses play: loaded with the page, it
// would hand every visitor's address to the streaming site whether or not
// they watch. The video always comes from the streaming site, never through
// this one. Per-match links and replays need a column on Match, which is a
// database release, so they are not here.

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
  /** Kickoff plus the series estimate (twice it once a game is in): from
   *  here the link is gone. */
  closesAtMs: number;
};

/** How many series estimates a match under way keeps its link for. */
const LIVE_SERIES_ESTIMATES = 2;

/**
 * When a match links the league stream, or null when it never does. Playoff
 * and final matches only (the regular season stays as it was), of the active
 * season, with a kickoff, still to be decided and not ruled a forfeit. The
 * window ends when the series should be over (seriesEstimateMinutes, the
 * calendar's event length), so a series that never gets its result still
 * stops saying it is live. Once a game is in (LIVE), it runs for a second
 * estimate, so a late start doesn't lose its link mid-series. A retime moves
 * the window with the kickoff.
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
  const live = match.status === MATCH_STATUS.LIVE;
  const estimates = live ? LIVE_SERIES_ESTIMATES : 1;
  return {
    // A game is in, so the series is on whatever the listed kickoff says:
    // a series that started early used to read "Streamed on Twitch", with
    // no player, while its scoreboard said LIVE.
    opensAtMs: live ? 0 : kickoff - WATCH_OPENS_BEFORE_KICKOFF_MS,
    closesAtMs:
      kickoff + estimates * seriesEstimateMinutes(match.bestOf) * 60_000,
  };
}

/** A window that has closed: nothing new can start playing (watchState). */
const CLOSED_WINDOW: WatchWindow = { opensAtMs: 0, closesAtMs: 0 };

/**
 * The window a match page's stream player is drawn with. While the link is
 * up it is matchWatchWindow's; once a playoff or final match of the active
 * season is decided it is a closed window rather than none, so the player
 * stays mounted and a visitor who pressed play keeps watching the post-game.
 * Unmounting it at the result (the page refreshes when a game is imported)
 * cut the stream off at the trophy. A closed window starts nothing new:
 * StreamPlayer draws nothing until it has been pressed.
 */
export function streamPlayerWindow(
  match: Parameters<typeof matchWatchWindow>[0],
  seasonIsActive: boolean,
): WatchWindow | null {
  const watch = matchWatchWindow(match, seasonIsActive);
  if (watch) return watch;
  if (!seasonIsActive || match.forfeit) return null;
  if (match.phase !== MATCH_PHASE.PLAYOFF && match.phase !== MATCH_PHASE.FINAL) {
    return null;
  }
  return match.status === MATCH_STATUS.COMPLETED ? CLOSED_WINDOW : null;
}

/** What the streaming site's own player can show for the league's link. */
export type StreamEmbed =
  | { kind: "twitch"; channel: string }
  | { kind: "youtube-video"; videoId: string }
  | { kind: "youtube-channel"; channelId: string }
  | { kind: "kick"; channel: string };

const TWITCH_CHANNEL = /^[A-Za-z0-9_]{1,25}$/;
const KICK_CHANNEL = /^[A-Za-z0-9_-]{1,25}$/;
const YOUTUBE_VIDEO = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_CHANNEL = /^UC[A-Za-z0-9_-]{22}$/;
// Site pages shaped like a channel's address, which no player can show.
const TWITCH_PAGES = new Set([
  "directory",
  "downloads",
  "drops",
  "inventory",
  "jobs",
  "login",
  "p",
  "prime",
  "search",
  "settings",
  "signup",
  "subscriptions",
  "turbo",
  "videos",
  "wallet",
]);
const KICK_PAGES = new Set([
  "browse",
  "categories",
  "category",
  "clips",
  "dashboard",
  "following",
  "search",
  "settings",
  "video",
  "videos",
]);

/**
 * The player for a stored stream link, or null when the link names nothing a
 * player can show: a YouTube @handle (its player needs the channel's UC… id),
 * a Shorts or playlist page, or a site page rather than a channel. Null only
 * drops the player; the link still links out.
 */
export function streamEmbed(stream: LeagueStream): StreamEmbed | null {
  let url: URL;
  try {
    url = new URL(stream.url);
  } catch {
    return null;
  }
  const [first, second] = url.pathname.split("/").filter(Boolean);
  if (!first) return null;
  switch (stream.platform) {
    case "Twitch":
      // Twitch logins are case-blind; its player takes them lower-case.
      return TWITCH_CHANNEL.test(first) && !TWITCH_PAGES.has(first.toLowerCase())
        ? { kind: "twitch", channel: first.toLowerCase() }
        : null;
    case "Kick":
      return KICK_CHANNEL.test(first) && !KICK_PAGES.has(first.toLowerCase())
        ? { kind: "kick", channel: first }
        : null;
    case "YouTube": {
      if (url.hostname === "youtu.be") {
        return YOUTUBE_VIDEO.test(first)
          ? { kind: "youtube-video", videoId: first }
          : null;
      }
      // A channel's live stream: /channel/UC…, or that player's own address
      // (whose "live_stream" would otherwise pass for an 11-character id).
      if (first === "channel" || (first === "embed" && second === "live_stream")) {
        const channelId =
          first === "channel" ? second : url.searchParams.get("channel");
        return channelId && YOUTUBE_CHANNEL.test(channelId)
          ? { kind: "youtube-channel", channelId }
          : null;
      }
      const videoId =
        first === "watch"
          ? url.searchParams.get("v")
          : first === "live" || first === "embed"
            ? second
            : null;
      return videoId && YOUTUBE_VIDEO.test(videoId)
        ? { kind: "youtube-video", videoId }
        : null;
    }
  }
}

/**
 * The player's address. Twitch refuses to play inside a page unless the
 * address names that page's host (`parent`), so the browser passes its own
 * (stream-player.tsx), which also keeps previews and local servers working.
 * Every address asks to start playing: it loads only on a press of play.
 */
export function streamEmbedSrc(embed: StreamEmbed, parentHost: string): string {
  switch (embed.kind) {
    case "twitch":
      return `https://player.twitch.tv/?${new URLSearchParams({
        channel: embed.channel,
        parent: parentHost,
        autoplay: "true",
      })}`;
    case "youtube-video":
      // The privacy-enhanced host: no YouTube cookies until the video plays.
      return `https://www.youtube-nocookie.com/embed/${embed.videoId}?autoplay=1`;
    case "youtube-channel":
      return `https://www.youtube.com/embed/live_stream?channel=${embed.channelId}&autoplay=1`;
    case "kick":
      return `https://player.kick.com/${embed.channel}?autoplay=true`;
  }
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
