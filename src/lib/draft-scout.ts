// What the draft room shows about a player: on the block, and in the pool
// when anyone taps a row. Pure and client-safe. The facts are the ones
// /players already shows every visitor for an ACTIVE signup (last league
// season, inhouse record, pub scouting, favorite heroes, the about text),
// phrased by the same helpers, so a fact reads the same on both pages.
//
// The map is built once per /draft render (draft-scout-service.ts), never in
// the poll: every tick reply goes to every tab in the room, and the auction
// can't change any of this (pub refreshes are off while it runs). MMR, medal
// and roles always come from the live tick row, so an admin's correction
// shows at once.
import { aboutText } from "./about-you";
import { DRAFT_STATUS } from "./constants";
import {
  inhouseTitle,
  inhouseToken,
  lastSeasonTitle,
  lastSeasonToken,
  PUB_QUIET_TITLE,
  pubQuietToken,
  pubTitle,
  pubToken,
  type PoolInhouseRecord,
  type PoolLastSeason,
  type PoolPubRecord,
} from "./player-pool";
import {
  pubScoutCaption,
  scoutingRowParts,
  scoutingSentences,
  scoutingTiles,
  scoutingTitle,
  type PubScout,
  type ScoutContext,
  type ScoutPart,
  type ScoutTile,
} from "./pub-scout";
import {
  pubCheckedAgo,
  pubHasWindow,
  pubLastPlayed,
  poolPubRecord,
  type PubHero,
} from "./pub-stats";
import { hasText } from "./utils";

/** One pool player's scouting facts. Every field is optional and present
 *  only with data, so an entry of `{}` means "in the map, nothing on file".
 *  It never holds contact (Discord), account ids or a lifetime games total. */
export type DraftScout = {
  pub?: PoolPubRecord;
  inhouse?: PoolInhouseRecord;
  lastSeason?: PoolLastSeason;
  favoriteHeroes?: string;
  /** The about text joined for one line, clipped to DRAFT_ABOUT_CLIP. */
  about?: string;
};

/** userId → facts, for the season's ACTIVE PLAYER signups minus captains. */
export type DraftScoutInfo = Record<string, DraftScout>;

/** The pool card shows two lines of the about text and the profile has the
 *  rest, so the page never ships a 2,000-character box per player. */
export const DRAFT_ABOUT_CLIP = 300;

/** The compact card shows one line of the about text; past about this many
 *  characters it may not fit, so the full card has the rest. */
export const DRAFT_ABOUT_COMPACT_CHARS = 90;

/** How many recent pub heroes each card shows, compact and full. */
export const DRAFT_CARD_HEROES = {
  lot: { compact: 5, full: 6 },
  pool: { compact: 4, full: 4 },
} as const;

/** The toggle between the compact card and the full one, in both states. */
export const DRAFT_SCOUT_TOGGLE = {
  more: "Full scouting",
  less: "Less scouting",
} as const;

export const DRAFT_SCOUT_NOTHING_ON_FILE =
  "Nothing on file yet from pubs, inhouses or past seasons.";

/** The map is loaded only while the auction runs: the waiting room and the
 *  finished room show no pool to scout. */
export function draftScoutWanted(
  draftStatus: string | null | undefined,
): boolean {
  return (
    draftStatus === DRAFT_STATUS.IN_PROGRESS ||
    draftStatus === DRAFT_STATUS.PAUSED
  );
}

/** Cut at the last word boundary within `max` characters, marked "…". */
export function clipAbout(text: string, max = DRAFT_ABOUT_CLIP): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(0, max - 1);
  const space = cut.search(/\s\S*$/);
  return `${(space > 0 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export type DraftScoutRegistration = {
  userId: string;
  favoriteHeroes: string;
  captainNote: string;
  statement: string;
  pubStats: string | null;
  pubStatsAt: Date | null;
};

/** One entry per registration, `{}` when there is nothing to show. */
export function buildDraftScoutInfo(input: {
  registrations: readonly DraftScoutRegistration[];
  inhouse: Readonly<Record<string, PoolInhouseRecord>>;
  lastSeasons: Readonly<Record<string, PoolLastSeason>>;
}): DraftScoutInfo {
  const out: DraftScoutInfo = {};
  for (const r of input.registrations) {
    const entry: DraftScout = {};
    const pub = poolPubRecord(r.pubStats, r.pubStatsAt);
    if (pub) entry.pub = pub;
    const inhouse = input.inhouse[r.userId];
    if (inhouse) entry.inhouse = inhouse;
    const lastSeason = input.lastSeasons[r.userId];
    if (lastSeason) entry.lastSeason = lastSeason;
    if (hasText(r.favoriteHeroes)) entry.favoriteHeroes = r.favoriteHeroes;
    const about = aboutText(
      { captainNote: r.captainNote, statement: r.statement },
      " · ",
    );
    if (about) entry.about = clipAbout(about);
    out[r.userId] = entry;
  }
  return out;
}

/** A league or pub fact on the card's record line, with its hover. */
export type DraftRecordToken = {
  key: "lastSeason" | "inhouse" | "pubs" | "quiet";
  text: string;
  title: string;
  /** Worth a second look: tinted. */
  warn: boolean;
};

export type DraftCardView = {
  /** The map has an entry for this player (it may be empty). */
  known: boolean;
  record: DraftRecordToken[];
  /** The compact card's pub line, the /players pool row's own words:
   *  "plays Pos 2 · in Legend games · solo · US East". Empty without tiles. */
  summary: ScoutPart[];
  /** Every finding as a sentence, the summary's hover. */
  summaryTitle: string;
  /** What the tiles and recent heroes rest on (the window, and the
   *  snapshot's age when no Pubs token says it); null without either. */
  caption: string | null;
  tiles: ScoutTile[];
  heroes:
    | { kind: "recent"; scout: PubScout }
    | { kind: "mostPlayed"; heroes: PubHero[] }
    | null;
  favoriteHeroes: string;
  about: string;
  /** Every finding in full, for the "More scouting" list. */
  findings: string[];
  /** The snapshot behind the findings, for the role averages under More. */
  moreScout: PubScout | null;
  /** In the map with nothing to show: say so, rather than a blank card. */
  nothingOnFile: boolean;
  /** The full card shows more than the compact one: the tiles and findings,
   *  or an about text too long for one line. Without it there is no toggle. */
  hasMore: boolean;
};

/**
 * What one card shows, in order. `player` is the live tick row (MMR, medal
 * and roles set the tiles' context); `live` is the nominee's favorites and
 * about text from the tick, which win over the map's copy even when blank
 * (the tick reads them fresh). `nowMs` is the server's clock (`state.now`).
 */
export function draftCardView(input: {
  player: { mmr: number; rankTier: number | null; roles: string };
  scout: DraftScout | undefined;
  live?: { favoriteHeroes: string; about: string };
  league: ScoutContext["league"];
  nowMs: number;
}): DraftCardView {
  const { player, scout, nowMs } = input;
  const pub = scout?.pub;
  const record: DraftRecordToken[] = [];
  if (scout?.lastSeason) {
    record.push({
      key: "lastSeason",
      text: lastSeasonToken(scout.lastSeason),
      title: lastSeasonTitle(scout.lastSeason),
      warn: false,
    });
  }
  if (scout?.inhouse) {
    record.push({
      key: "inhouse",
      text: inhouseToken(scout.inhouse),
      title: inhouseTitle(scout.inhouse),
      warn: false,
    });
  }
  const pubsShown = !!pub && pubHasWindow(pub);
  if (pub && pubsShown) {
    record.push({
      key: "pubs",
      text: pubToken(pub, nowMs),
      title: pubTitle(pub, nowMs),
      warn: false,
    });
  }
  const activity = pub ? pubLastPlayed(pub, nowMs) : null;
  if (activity?.quiet) {
    record.push({
      key: "quiet",
      text: pubQuietToken(activity),
      title: PUB_QUIET_TITLE,
      warn: true,
    });
  }

  const ctx: ScoutContext = {
    roles: player.roles,
    signupMmr: player.mmr,
    rankTier: player.rankTier,
    league: input.league,
  };
  const scoutCounts = pub?.scout ?? null;
  const tiles = scoutCounts ? scoutingTiles(scoutCounts, ctx) : [];
  const heroes: DraftCardView["heroes"] =
    scoutCounts && scoutCounts.heroes.length > 0
      ? { kind: "recent", scout: scoutCounts }
      : pub && pub.topHeroes.length > 0
        ? { kind: "mostPlayed", heroes: pub.topHeroes }
        : null;
  // Anything read from the window names it, even a few Turbo games' heroes
  // with no tile to show. The snapshot's age is said once: by the Pubs
  // token when it shows.
  const caption =
    scoutCounts && (tiles.length > 0 || heroes?.kind === "recent")
      ? pubScoutCaption(
          scoutCounts.games,
          pubsShown ? null : pubCheckedAgo(pub?.checkedAt ?? null, nowMs),
        )
      : null;
  const findings =
    scoutCounts && tiles.length > 0 ? scoutingSentences(scoutCounts, ctx) : [];
  const about = input.live ? input.live.about : (scout?.about ?? "");

  return {
    known: scout !== undefined,
    record,
    summary:
      scoutCounts && tiles.length > 0 ? scoutingRowParts(scoutCounts, ctx) : [],
    summaryTitle:
      scoutCounts && tiles.length > 0 ? scoutingTitle(scoutCounts, ctx) : "",
    caption,
    tiles,
    heroes,
    favoriteHeroes: input.live
      ? input.live.favoriteHeroes
      : (scout?.favoriteHeroes ?? ""),
    about,
    findings,
    moreScout: findings.length > 0 ? scoutCounts : null,
    nothingOnFile:
      scout !== undefined &&
      record.length === 0 &&
      tiles.length === 0 &&
      heroes === null,
    hasMore: caption !== null || about.length > DRAFT_ABOUT_COMPACT_CHARS,
  };
}

// --- The pool's one open card --------------------------------------------------

/** Whose card is open under the pool. A captain lining up a pick sees the
 *  lined-up player's; everyone else the row they last tapped open. */
export function poolPanelOpenId(s: {
  canPick: boolean;
  selected: string | null;
  inspected: string | null;
}): string | null {
  return s.canPick ? s.selected : s.inspected;
}

/** A tap opens a row's card, and a second tap on it closes it. */
export function toggleInspected(
  current: string | null,
  userId: string,
): string | null {
  return current === userId ? null : userId;
}

/** What the room's state was when a viewer's opened card was last judged. */
export type PoolCardMoment = { onBlockId: string | null; canPick: boolean };

/**
 * The opened row after the room moved. A viewer who starts or stops lining
 * up picks (a captain's turn coming round, an admin's nomination phase)
 * starts with no card open, or the card they opened before their turn would
 * pop back open after it. Once a player goes on the block the lot card shows
 * them, so their pool card closes; any other open card stays.
 */
export function inspectedAfterChange(
  inspected: string | null,
  before: PoolCardMoment,
  after: PoolCardMoment,
): string | null {
  if (before.canPick !== after.canPick) return null;
  if (before.onBlockId === after.onBlockId) return inspected;
  return inspected !== null && inspected === after.onBlockId ? null : inspected;
}

/** The line under the pool's filters, once there are cards to open. */
export function poolTapHint(canPick: boolean): string {
  return canPick
    ? "Tap a player to line them up and see their scouting."
    : "Tap a player to see their scouting.";
}
