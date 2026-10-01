// Link preview pictures (the opengraph-image routes beside the match, team,
// player and season pages): the rules they share. Pure and tested; the file
// and network reads are in og-assets.ts and the drawing in
// src/components/og-card.tsx.

import { MATCH_STATUS } from "./constants";
import { seriesResultText } from "./link-preview";
import {
  championTitles,
  playerCardHonors,
  playerCardRoleText,
  type PlayerCardFacts,
} from "./player-card";

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

/** A medal as a picture draws it: the medallion and its stars as data URIs
 *  (og-assets' loadRankMedal), and the medal's name. */
export type OgMedal = { icon: string; stars: string | null; name: string };

/** What a player's picture shows (OgPlayerCard): their season card. */
export type PlayerCardData = {
  name: string;
  avatar: string | null;
  /** "Season 9 · Captain": the card's season and how they took part. */
  seasonLine: string | null;
  /** Their team that season, from their season history, never a later
   *  roster's. Null for a season spent standing in. */
  team: OgTeam | null;
  medal: OgMedal | null;
  /** Gold chips, newest first: "Season 9 champion", "+2 more titles". */
  titles: string[];
  /** "Grade A", the heroes ("Axe", "Invoker · pubs"), "3 Match MVPs". */
  facts: string[];
};

/** Title chips a picture shows before the rest fold into a count. */
const PICTURE_TITLES = 1;

// The player picture's layout in pixels (OgPlayerCard), for fitting its chips
// in the frame. Measured on rendered pictures and rounded up: Oswald SemiBold
// at 26px runs under 12px a character, a chip adds 40px of padding and border
// and 12px of margin, and a medal 50px more.
const PICTURE = {
  /** The column beside the avatar. */
  columnPx: 756,
  charPx: 12,
  chipPx: 40,
  chipMarginPx: 12,
  medalPx: 50,
  /** One row of chips, with its margin. */
  chipRowPx: 64,
  /** The frame's height between its header and its bottom padding. */
  contentPx: 474,
  chipsTopPx: 22,
  /** The crest row under the name, with its margin. */
  teamRowPx: 74,
} as const;

/** How many rows flex-wrap lays out chips of these widths in. */
function pictureChipRows(widths: readonly number[]): number {
  let rows = 0;
  let line = 0;
  for (const width of widths) {
    const outer = width + PICTURE.chipMarginPx;
    if (rows === 0 || line + outer > PICTURE.columnPx) {
      rows += 1;
      line = outer;
    } else {
      line += outer;
    }
  }
  return rows;
}

/** The name's height: clampStyle at 80px to 20 characters, else 64px, two
 *  lines at most, counting a generous half an em a character. */
function pictureNameHeight(name: string): number {
  const size = name.length > 20 ? 64 : 80;
  const lines = Math.min(2, Math.ceil((name.length * size * 0.5) / 700));
  return Math.max(1, lines) * size * 1.12;
}

/**
 * The facts a player's picture has room for. The titles and the medal always
 * show; the facts follow in their order until the chips would run out of the
 * frame, so a long name with a crowded card drops its honors first, then pub
 * heroes, then league heroes, then the grade.
 */
export function fitPictureFacts(input: {
  name: string;
  hasTeam: boolean;
  titles: readonly string[];
  /** The medal's name, when one is drawn. */
  medal: string | null;
  facts: readonly string[];
}): string[] {
  const width = (text: string, extra = 0) =>
    text.length * PICTURE.charPx + PICTURE.chipPx + extra;
  const room =
    PICTURE.contentPx -
    pictureNameHeight(input.name) -
    (input.hasTeam ? PICTURE.teamRowPx : 0) -
    PICTURE.chipsTopPx;
  const maxRows = Math.max(1, Math.floor(room / PICTURE.chipRowPx));
  const fixed = [
    ...input.titles.map((title) => width(title)),
    ...(input.medal ? [width(input.medal, PICTURE.medalPx)] : []),
  ];
  const facts = [...input.facts];
  while (
    facts.length > 0 &&
    pictureChipRows([...fixed, ...facts.map((fact) => width(fact))]) > maxRows
  ) {
    facts.pop();
  }
  return facts;
}

/**
 * The words on a player's picture, from the same facts as their profile's
 * season card (playerCardFacts). The picture has no name row, so its season
 * line always says how they took part, and it has room for one title chip
 * and a count of the rest. No MMR: a picture travels without its date.
 */
export function playerPictureText(
  card: PlayerCardFacts,
): Pick<PlayerCardData, "seasonLine" | "titles" | "facts"> {
  const role = playerCardRoleText(card);
  const { shown, more } = championTitles(card.titles, PICTURE_TITLES);
  return {
    seasonLine: card.season
      ? role
        ? `${card.season.name} · ${role}`
        : card.season.name
      : null,
    titles: [
      ...shown,
      ...(more.length > 0
        ? [`+${more.length} more title${more.length === 1 ? "" : "s"}`]
        : []),
    ],
    facts: [
      ...(card.grade ? [`Grade ${card.grade.overall}`] : []),
      ...card.heroes.map((h) => (h.pubs ? `${h.name} · pubs` : h.name)),
      ...playerCardHonors(card),
    ],
  };
}

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
