// What a caster's OBS overlay shows for one fixture: both teams with their
// records, the series score and the rotating player cards. Pure and tested;
// stream-overlay-service.ts loads the rows, /api/overlay serves the result and
// the overlay page (src/app/overlay) only draws it.
//
// Every fact here is already public on the match page, and it is built from
// the same rules (standings, seeds, form, the match-night roster, impact
// points). The payload is a broadcast picture, so it follows the link
// pictures' rule: no MMR, no contact detail, no check-in answer.

import { gameMvp } from "./achievements";
import { seedsFromFirstRound } from "./bracket-view";
import { matchNightRoster } from "./availability";
import { MATCH_PHASE, MATCH_STATUS } from "./constants";
import { fantasyPoints } from "./fantasy";
import { heroById, heroPortrait } from "./heroes";
import { isPlayoffPhase } from "./league-lifecycle";
import {
  decodeGamePlayers,
  summarizePlayerGames,
  trustedGamePlayers,
  type PlayerGameLine,
} from "./player-stats";
import { projectPlayoffField } from "./playoff-field";
import { parsePubStats } from "./pub-stats";
import { rankMedalName, rankMedalTier, rankStars } from "./rank";
import { roleLabels } from "./roles";
import { groupPlayoffRounds, matchRoundLabel } from "./schedule";
import type { FormatSource } from "./season-format";
import { bracketSeedLabels, placeInTable, placeOfLabel } from "./season-groups";
import type { MatchLike } from "./standings";
import { crestInk, hashHue, seasonTeamHues } from "./team-hues";
import {
  compareSeriesOrder,
  recentForm,
  seriesRecordText,
  seriesWinStreak,
  WIN_STREAK_MIN,
  type FormResult,
} from "./team-matches";
import { rosterOrder } from "./team-roster";
import { teamInitials } from "./utils";

/** Bumped when the payload's shape changes, so a page from an older deploy
 *  can tell it is reading something it doesn't know. */
export const STREAM_OVERLAY_VERSION = 1;

/** How many heroes a player card shows. */
const CARD_HEROES = 3;
/** How many story lines the matchup's ticker carries at most. */
const MAX_NOTES = 4;

export type OverlaySide = "home" | "away";

export type OverlayTeam = {
  id: string;
  name: string;
  /** The generated crest's two letters, drawn when there is no logo. */
  initials: string;
  /** An https logo, else null (the crest is drawn instead). */
  logoUrl: string | null;
  /** The season's crest hue, the colour every page paints this team in. */
  hue: number;
  /** The crest initials' ink on that hue. */
  ink: string;
  /** "5W 1D 2L": the regular-season record once a series is final. */
  record: string | null;
  /**
   * "1st of 6" in the regular season, "Seed 2" in the knockouts; in a group
   * season the place is the group's ("1st of 5 in Group A") and the seed is
   * named like the bracket's ("Seed A1").
   */
  standing: string | null;
  /** The last five series, newest first. */
  form: FormResult[];
};

export type OverlayMedal = {
  name: string;
  icon: string;
  /** The star overlay, or null (none known, or Immortal). */
  star: string | null;
};

export type OverlayHero = {
  name: string;
  portrait: string;
  games: number;
  wins: number;
};

export type OverlayPlayerSeason = {
  games: number;
  wins: number;
  losses: number;
  kills: number;
  deaths: number;
  assists: number;
  kda: number;
  /** Average impact points per game, rounded. */
  impact: number;
  /** Games they were Match MVP of this season. */
  mvps: number;
};

export type OverlayPlayer = {
  id: string;
  name: string;
  avatar: string | null;
  side: OverlaySide;
  captain: boolean;
  /** Booked as a standin for this match. */
  standin: boolean;
  /** Who the standin covers; null for an empty seat (or not a standin). */
  standinFor: string | null;
  /** Their signup's positions: "Carry", "Mid". */
  roles: string[];
  medal: OverlayMedal | null;
  /** This season's league games, or null before their first. */
  season: OverlayPlayerSeason | null;
  heroes: OverlayHero[];
  /** Where the heroes came from: this season's league games, or their pub
   *  games (OpenDota) before they have any. */
  heroesFrom: "league" | "pubs" | null;
};

export type StreamOverlayPayload = {
  version: typeof STREAM_OVERLAY_VERSION;
  league: string;
  seasonName: string;
  match: {
    id: string;
    /** "Week 4", "Semifinal", "Grand final". */
    round: string;
    bestOf: number;
    status: string;
    homeScore: number;
    awayScore: number;
    winner: OverlaySide | null;
    forfeit: boolean;
    kickoffMs: number | null;
    /** The kickoff on the league's clock with its zone named: a stream is
     *  watched from everywhere, so it says whose clock. */
    kickoffText: string | null;
  };
  home: OverlayTeam;
  away: OverlayTeam;
  /** Short story lines for the matchup's ticker. */
  notes: string[];
  /** Tonight's players: home side then away, captain first, a standin in
   *  the seat of the player they cover. */
  players: OverlayPlayer[];
};

export type OverlaySeasonTeam = {
  id: string;
  name: string;
  withdrawn: boolean;
  /** "A", "B" in a group season (places and seeds are the group's), else null. */
  groupKey: string | null;
  /** Creation time in epoch ms: the order crest hues are handed out in. */
  createdAtMs: number;
};

export type OverlaySeasonMatch = MatchLike & {
  id: string;
  week: number;
  phase: string;
  bracketSlot: string | null;
  bestOf: number;
  scheduledAt: Date | null;
  forfeit: boolean;
};

export type OverlayUser = {
  id: string;
  name: string;
  avatar: string | null;
  rankTier: number | null;
  pubStats: string | null;
};

export type OverlayRosterRow = {
  teamId: string;
  isCaptain: boolean;
  price: number;
  user: OverlayUser;
};

export type OverlayStandinRow = {
  teamId: string;
  standin: OverlayUser;
  replaced: { id: string; name: string } | null;
};

export type StreamOverlayInput = {
  leagueName: string;
  /** The season's id: the crest hues start the colour wheel from it. */
  seasonId: string;
  seasonName: string;
  /** The season's stored format: it sets the playoff places. */
  season: FormatSource;
  /** The fixture; it is also one of `seasonMatches`. */
  match: OverlaySeasonMatch & {
    homeTeam: { name: string; logoUrl: string | null };
    awayTeam: { name: string; logoUrl: string | null };
  };
  kickoffText: string | null;
  teams: readonly OverlaySeasonTeam[];
  seasonMatches: readonly OverlaySeasonMatch[];
  /** Both teams' roster rows. */
  roster: readonly OverlayRosterRow[];
  /** This match's standin bookings. */
  standins: readonly OverlayStandinRow[];
  /** Signup positions by user id (the stored "1,3" string). */
  roles: ReadonlyMap<string, string>;
  /** The season's games: box score JSON and the winner. */
  seasonGames: readonly { players: string; radiantWin: boolean }[];
};

/** An image the overlay may load: https only. Anything else draws the
 *  fallback (initials), as a broken or odd scheme would on stream. */
export function overlayImageUrl(url: string | null | undefined): string | null {
  const value = url?.trim();
  if (!value) return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

/** The medal pictures the site's `RankMedal` draws (the full-size copies:
 *  a card shows them larger than the 72px set covers). */
export function overlayMedal(rankTier: number | null): OverlayMedal | null {
  const tier = rankMedalTier(rankTier);
  if (tier === 0) return null;
  const stars = rankStars(rankTier);
  return {
    name: rankMedalName(rankTier),
    icon: `/ranks/rank_icon_${tier}.png`,
    star: tier < 8 && stars > 0 ? `/ranks/rank_star_${stars}.png` : null,
  };
}

type Seat = { user: OverlayUser; captain: boolean; standinFor: string | null; standin: boolean };

/**
 * One side's players for tonight in reading order. Who plays is exactly
 * `matchNightRoster`'s answer (the rule every check-in count uses), so a
 * stale booking for someone no longer on the roster adds nobody; this only
 * orders them: the roster captain first (rosterOrder), a booked standin in
 * the seat of the player they cover, and a standin for an empty seat last.
 */
export function overlaySeats(
  teamId: string,
  roster: readonly OverlayRosterRow[],
  standins: readonly OverlayStandinRow[],
): Seat[] {
  const members = rosterOrder(roster.filter((row) => row.teamId === teamId));
  const bookings = standins.filter((row) => row.teamId === teamId);
  const playing = new Set(
    matchNightRoster(
      members.map((row) => row.user.id),
      bookings.map((row) => ({
        standinUserId: row.standin.id,
        replacingUserId: row.replaced?.id ?? null,
      })),
    ),
  );
  const seats: Seat[] = [];
  const seated = new Set<string>();
  const sit = (seat: Seat) => {
    if (seated.has(seat.user.id) || !playing.has(seat.user.id)) return;
    seated.add(seat.user.id);
    seats.push(seat);
  };
  for (const member of members) {
    sit({
      user: member.user,
      captain: member.isCaptain,
      standin: false,
      standinFor: null,
    });
    // Covered tonight: whoever stands in takes this seat.
    for (const row of bookings) {
      if (row.replaced?.id === member.user.id) {
        sit({ user: row.standin, captain: false, standin: true, standinFor: member.user.name });
      }
    }
  }
  // Standins filling an empty seat, and anything else tonight's roster holds.
  for (const row of bookings) {
    sit({
      user: row.standin,
      captain: false,
      standin: true,
      standinFor: row.replaced?.name ?? null,
    });
  }
  return seats;
}

type SeasonLines = {
  lines: PlayerGameLine[];
  impact: number;
  mvps: number;
};

/**
 * Each wanted player's lines from the season's complete box scores (the
 * public stats' rule: an incomplete or malformed game counts for nobody),
 * with their impact points and Match MVPs.
 */
export function seasonLinesFor(
  userIds: ReadonlySet<string>,
  games: readonly { players: string; radiantWin: boolean }[],
): Map<string, SeasonLines> {
  const out = new Map<string, SeasonLines>();
  for (const game of games) {
    const players = trustedGamePlayers(decodeGamePlayers(game.players));
    if (players.length === 0) continue;
    const mvp = gameMvp(players, game.radiantWin);
    for (const line of players) {
      if (!line.userId || !userIds.has(line.userId)) continue;
      const won = line.isRadiant === game.radiantWin;
      const entry = out.get(line.userId) ?? { lines: [], impact: 0, mvps: 0 };
      entry.lines.push({
        isRadiant: line.isRadiant,
        radiantWin: game.radiantWin,
        kills: line.kills,
        deaths: line.deaths,
        assists: line.assists,
        heroId: line.heroId,
        netWorth: line.netWorth,
        gpm: line.gpm,
      });
      entry.impact += fantasyPoints(line, won);
      if (mvp === line.userId) entry.mvps += 1;
      out.set(line.userId, entry);
    }
  }
  return out;
}

function playerCard(
  seat: Seat,
  side: OverlaySide,
  roles: string | undefined,
  season: SeasonLines | undefined,
): OverlayPlayer {
  const summary = season ? summarizePlayerGames(season.lines) : null;
  let heroes: OverlayHero[] = [];
  let heroesFrom: OverlayPlayer["heroesFrom"] = null;
  if (summary && summary.games > 0) {
    heroes = summary.topHeroes.flatMap((tally) => {
      const hero = heroById(tally.heroId);
      return hero
        ? [{ name: hero.name, portrait: heroPortrait(hero), games: tally.games, wins: tally.wins }]
        : [];
    });
    heroesFrom = heroes.length > 0 ? "league" : null;
  } else {
    // Before their first league game, what they play in pubs is the only
    // hint a caster has, and it says so on the card.
    heroes = (parsePubStats(seat.user.pubStats)?.topHeroes ?? []).flatMap((tally) => {
      const hero = heroById(tally.heroId);
      return hero
        ? [{ name: hero.name, portrait: heroPortrait(hero), games: tally.games, wins: tally.wins }]
        : [];
    });
    heroesFrom = heroes.length > 0 ? "pubs" : null;
  }
  return {
    id: seat.user.id,
    name: seat.user.name,
    avatar: overlayImageUrl(seat.user.avatar),
    side,
    captain: seat.captain,
    standin: seat.standin,
    standinFor: seat.standinFor,
    roles: roleLabels(roles),
    medal: overlayMedal(seat.user.rankTier),
    season:
      summary && season && summary.games > 0
        ? {
            games: summary.games,
            wins: summary.wins,
            losses: summary.losses,
            kills: summary.avgKills,
            deaths: summary.avgDeaths,
            assists: summary.avgAssists,
            kda: summary.kda,
            impact: Math.round(season.impact / summary.games),
            mvps: season.mvps,
          }
        : null,
    heroes: heroes.slice(0, CARD_HEROES),
    heroesFrom,
  };
}

/** "Week 2: Raccoons beat Straits 2–0", the meetings before this one. */
function meetingNote(
  meeting: OverlaySeasonMatch,
  names: ReadonlyMap<string, string>,
  roundOf: (m: OverlaySeasonMatch) => string,
): string {
  const home = names.get(meeting.homeTeamId) ?? "?";
  const away = names.get(meeting.awayTeamId) ?? "?";
  const round = roundOf(meeting);
  if (meeting.winnerTeamId === null) {
    return `${round}: ${home} and ${away} drew ${meeting.homeScore}–${meeting.awayScore}`;
  }
  const homeWon = meeting.winnerTeamId === meeting.homeTeamId;
  const winner = homeWon ? home : away;
  const loser = homeWon ? away : home;
  const high = Math.max(meeting.homeScore, meeting.awayScore);
  const low = Math.min(meeting.homeScore, meeting.awayScore);
  return `${round}: ${winner} beat ${loser} ${high}–${low}`;
}

/** Build the overlay's whole payload from the loaded rows. */
export function buildStreamOverlay(input: StreamOverlayInput): StreamOverlayPayload {
  const { match } = input;
  // The colours every page paints these teams in (the root layout's
  // stylesheet spaces each season's teams round the wheel the same way).
  const hues = seasonTeamHues(
    input.teams.map((team) => ({
      id: team.id,
      seasonId: input.seasonId,
      createdAtMs: team.createdAtMs,
    })),
  );
  const ordered = [...input.seasonMatches].sort(compareSeriesOrder);
  const playoffMatches = input.seasonMatches.filter((m) => isPlayoffPhase(m.phase));
  const totalRounds = groupPlayoffRounds(playoffMatches).totalRounds;
  const postseason = isPlayoffPhase(match.phase);
  const regularPlayed = input.seasonMatches.some(
    (m) => m.phase === MATCH_PHASE.REGULAR && m.status === MATCH_STATUS.COMPLETED,
  );
  const field = projectPlayoffField([...input.teams], [...input.seasonMatches], input.season);
  // The bracket's names for its seeds: "A1", "B4" in a group season.
  const seeds = postseason
    ? bracketSeedLabels(seedsFromFirstRound(playoffMatches), input.teams)
    : new Map<string, string>();

  const team = (
    teamId: string,
    name: string,
    logoUrl: string | null,
  ): OverlayTeam => {
    const hue = hues.get(teamId) ?? hashHue(teamId);
    const row = field.standings.find((r) => r.teamId === teamId) ?? null;
    // Its place in its own table: its group's in a group season.
    const place = placeInTable(field, teamId);
    const seed = seeds.get(teamId);
    return {
      id: teamId,
      name,
      initials: teamInitials(name),
      logoUrl: overlayImageUrl(logoUrl),
      hue,
      ink: crestInk(hue),
      record: row && row.played > 0 ? seriesRecordText(row) : null,
      standing: postseason
        ? seed
          ? `Seed ${seed}`
          : null
        : regularPlayed && place
          ? placeOfLabel(place)
          : null,
      form: recentForm(
        teamId,
        ordered.filter((m) => m.homeTeamId === teamId || m.awayTeamId === teamId),
      ),
    };
  };

  const home = team(match.homeTeamId, match.homeTeam.name, match.homeTeam.logoUrl);
  const away = team(match.awayTeamId, match.awayTeam.name, match.awayTeam.logoUrl);

  const names = new Map(input.teams.map((t) => [t.id, t.name]));
  names.set(match.homeTeamId, match.homeTeam.name);
  names.set(match.awayTeamId, match.awayTeam.name);
  const roundOf = (m: OverlaySeasonMatch) => matchRoundLabel(m, totalRounds);
  const thisMatchAt = ordered.findIndex((m) => m.id === match.id);
  const before = thisMatchAt >= 0 ? ordered.slice(0, thisMatchAt) : ordered;
  const meetings = before
    .filter(
      (m) =>
        m.status === MATCH_STATUS.COMPLETED &&
        ((m.homeTeamId === match.homeTeamId && m.awayTeamId === match.awayTeamId) ||
          (m.homeTeamId === match.awayTeamId && m.awayTeamId === match.homeTeamId)),
    )
    .reverse();
  const notes: string[] = [];
  for (const meeting of meetings) notes.push(meetingNote(meeting, names, roundOf));
  // A streak is news going into the match, so it counts only the series
  // before this one, and a decided match drops it: the form strip already
  // tells how it ended.
  if (match.status !== MATCH_STATUS.COMPLETED) {
    for (const side of [home, away]) {
      const streak = seriesWinStreak(side.id, before);
      if (streak >= WIN_STREAK_MIN) {
        notes.push(`${side.name} have won ${streak} series in a row`);
      }
    }
  }
  if (meetings.length === 0) notes.push("First meeting this season");

  const seats = {
    home: overlaySeats(match.homeTeamId, input.roster, input.standins),
    away: overlaySeats(match.awayTeamId, input.roster, input.standins),
  };
  const wanted = new Set([...seats.home, ...seats.away].map((seat) => seat.user.id));
  const lines = seasonLinesFor(wanted, input.seasonGames);
  const players = (["home", "away"] as const).flatMap((side) =>
    seats[side].map((seat) =>
      playerCard(seat, side, input.roles.get(seat.user.id), lines.get(seat.user.id)),
    ),
  );

  return {
    version: STREAM_OVERLAY_VERSION,
    league: input.leagueName,
    seasonName: input.seasonName,
    match: {
      id: match.id,
      round: roundOf(match),
      bestOf: match.bestOf,
      status: match.status,
      homeScore: match.homeScore,
      awayScore: match.awayScore,
      winner:
        match.winnerTeamId === match.homeTeamId
          ? "home"
          : match.winnerTeamId === match.awayTeamId
            ? "away"
            : null,
      forfeit: match.forfeit,
      kickoffMs: match.scheduledAt?.getTime() ?? null,
      kickoffText: input.kickoffText,
    },
    home,
    away,
    notes: notes.slice(0, MAX_NOTES),
    players,
  };
}
