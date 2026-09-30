// Link preview pictures (the opengraph-image routes beside the match, team,
// player and season pages): the rules they share. Pure and tested; the file
// and network reads are in og-assets.ts and the drawing in
// src/components/og-card.tsx.

import { MATCH_STATUS } from "./constants";
import { seriesResultText } from "./link-preview";

/** Discord and X show large cards at this shape. */
export const OG_SIZE = { width: 1200, height: 630 } as const;

/**
 * Five minutes at the CDN and in the browser: a match's picture moves from
 * the kickoff to the live score to the result, so it must not be pinned for
 * the year next/og would otherwise give it. Past the five minutes a stale
 * copy may serve once while a fresh one renders.
 */
export const OG_CACHE_CONTROL =
  "public, max-age=300, s-maxage=300, stale-while-revalidate=600";

/**
 * Hosts a preview may fetch a picture from: Imgur (captains' crests) and
 * Steam's avatar CDNs. The server fetches these itself, so anything else an
 * admin typed as a logo (any HTTPS host, or a path on this site) draws the
 * initials instead: the image route never becomes a way to make the server
 * call an arbitrary address.
 */
const OG_IMAGE_HOSTS = new Set([
  "i.imgur.com",
  "avatars.steamstatic.com",
  "avatars.akamai.steamstatic.com",
  "avatars.cloudflare.steamstatic.com",
  "steamcdn-a.akamaihd.net",
]);

export function ogImageUrlAllowed(raw: string | null | undefined): boolean {
  if (!raw) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    OG_IMAGE_HOSTS.has(url.hostname)
  );
}

/**
 * The picture's format from its first bytes, never its headers: PNG and JPEG
 * are the two every renderer draws. Anything else (WebP, GIF, an error page
 * served as an image) gets the initials.
 */
export function sniffImageType(bytes: Uint8Array): "png" | "jpeg" | null {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= png.length && png.every((b, i) => bytes[i] === b)) {
    return "png";
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "jpeg";
  }
  return null;
}

/** The line along the bottom of a match's picture. */
export type MatchCardStatus = {
  /** upcoming: a kickoff. live: under way. final: a result. pending: past
   *  kickoff with no games in. */
  tone: "upcoming" | "live" | "final" | "pending";
  text: string;
};

/**
 * What a match's picture says under the teams: the kickoff before it (on the
 * league's own clock, zone named, since a picture can't adapt to the viewer),
 * that it is live during it, and the result after, in the link text's words
 * (seriesResultText). `formattedKickoff` is formatLeagueTime's text.
 */
export function matchCardStatus(
  match: {
    status: string;
    homeScore: number;
    awayScore: number;
    homeTeamId: string;
    awayTeamId: string;
    winnerTeamId: string | null;
    forfeit: boolean;
    bestOf: number;
    scheduledAt: Date | null;
  },
  names: { home: string; away: string },
  formattedKickoff: string | null,
  nowMs: number,
): MatchCardStatus {
  const series = `Best of ${match.bestOf}`;
  if (match.status === MATCH_STATUS.COMPLETED) {
    return { tone: "final", text: seriesResultText(match, names) };
  }
  if (match.status === MATCH_STATUS.LIVE || match.homeScore + match.awayScore > 0) {
    return { tone: "live", text: `Live now · ${series}` };
  }
  if (match.scheduledAt && match.scheduledAt.getTime() <= nowMs) {
    return { tone: "pending", text: `Awaiting result · ${series}` };
  }
  return {
    tone: "upcoming",
    text: `${formattedKickoff ?? "Kickoff time to be set"} · ${series}`,
  };
}

/** A team as a picture draws it: the crest as a data URI, else initials. */
export type OgTeam = { name: string; hue: number; logo: string | null };

/** What a match's picture shows (OgMatchCard). */
export type MatchCardData = {
  seasonName: string;
  /** matchRoundLabel: "Week 4", "Semifinal", "Grand final". */
  round: string;
  grandFinal: boolean;
  home: OgTeam;
  away: OgTeam;
  /** The series score once a game is in, or a result is recorded. */
  score: { home: number; away: number } | null;
  winner: "home" | "away" | null;
  status: MatchCardStatus;
};

/** What a team's picture shows (OgTeamCard). */
export type TeamCardData = {
  seasonName: string;
  team: OgTeam;
  /** Short facts, most important first: "5W 1D 2L", "2nd of 6". */
  facts: string[];
  /** A fact worn in gold, shown first: "Champion". */
  goldFact: string | null;
  captain: string;
  /** The rest of the roster (capNames). */
  roster: string[];
};

/** What a player's picture shows (OgPlayerCard). */
export type PlayerCardData = {
  name: string;
  avatar: string | null;
  /** The link text's highlights: medal, league record, favourite hero. */
  facts: string[];
  /** Their latest team, and that team's season. */
  team: OgTeam | null;
  teamSeason: string | null;
};

/** What a season's picture shows (OgSeasonCard). */
export type SeasonCardData = {
  seasonName: string;
  /** "Current season" or "Season archive". */
  kicker: string;
  /** "Season complete", "8 teams", "96 games". */
  facts: string[];
  champion: OgTeam | null;
};

/**
 * At most `max` names: past that, the first `max - 1` and a count of the
 * rest ("+3 more"), so a long roster still fits its line.
 */
export function capNames(names: readonly string[], max: number): string[] {
  if (names.length <= max) return [...names];
  const shown = Math.max(0, max - 1);
  return [...names.slice(0, shown), `+${names.length - shown} more`];
}

/**
 * A team hue as a hex colour at the given saturation and lightness (both
 * 0-100), for the picture renderer, which reads plain colours more reliably
 * than CSS hsl() syntax. Same wheel as the site's crests (team-hues.ts).
 */
export function hueHex(hue: number, saturation: number, lightness: number): string {
  const s = saturation / 100;
  const l = lightness / 100;
  const k = (n: number) => (n + hue / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) =>
    Math.round(
      255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))),
    )
      .toString(16)
      .padStart(2, "0");
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}
