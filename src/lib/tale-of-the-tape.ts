// The "tale of the tape" on an upcoming match page: both teams' season
// numbers side by side, fight-night style, so a visitor sizes up the matchup
// before kickoff. Pure and DB-free: the card loads the season's matches and
// the two teams' games, and every number comes from here.

import { MATCH_STATUS } from "./constants";
import { decodeGamePlayers, trustedGamePlayers } from "./player-stats";
import { computeStandings, type MatchLike } from "./standings";
import { seriesRecordSpoken, seriesRecordText } from "./team-matches";

/** A recorded game, as the card reads it from the Game row. */
export type TapeGame = {
  radiantTeamId: string | null;
  direTeamId: string | null;
  radiantWin: boolean;
  durationSecs: number;
  /** Game.players, the stored box score JSON. */
  players: string;
};

/** One team's box-score totals over the games it played this season. */
export type TeamGameTotals = {
  /** Games with the team's side known and a complete box score. */
  games: number;
  kills: number;
  deaths: number;
  assists: number;
  /** Sum of each game's side-average GPM, over `gpmGames` games. */
  gpmSum: number;
  gpmGames: number;
  /** Sum of game lengths, over `durationGames` games with a length. */
  durationSecs: number;
  durationGames: number;
};

/**
 * Add up `teamId`'s side of every game it played. A game counts only when its
 * sides are recorded (radiantTeamId and direTeamId, two different teams, one
 * of them this team) and its box score is complete; the side's five lines are
 * the ones on that team's side of the map.
 */
export function teamGameTotals(
  teamId: string,
  games: readonly TapeGame[],
): TeamGameTotals {
  const totals: TeamGameTotals = {
    games: 0,
    kills: 0,
    deaths: 0,
    assists: 0,
    gpmSum: 0,
    gpmGames: 0,
    durationSecs: 0,
    durationGames: 0,
  };
  for (const game of games) {
    if (
      !game.radiantTeamId ||
      !game.direTeamId ||
      game.radiantTeamId === game.direTeamId
    ) {
      continue;
    }
    const radiant =
      game.radiantTeamId === teamId
        ? true
        : game.direTeamId === teamId
          ? false
          : null;
    if (radiant === null) continue;
    const side = trustedGamePlayers(decodeGamePlayers(game.players)).filter(
      (line) => line.isRadiant === radiant,
    );
    if (side.length === 0) continue;
    totals.games++;
    for (const line of side) {
      totals.kills += line.kills;
      totals.deaths += line.deaths;
      totals.assists += line.assists;
    }
    const gpms = side.flatMap((line) => (line.gpm == null ? [] : [line.gpm]));
    if (gpms.length > 0) {
      totals.gpmSum += gpms.reduce((sum, gpm) => sum + gpm, 0) / gpms.length;
      totals.gpmGames++;
    }
    if (game.durationSecs > 0) {
      totals.durationSecs += game.durationSecs;
      totals.durationGames++;
    }
  }
  return totals;
}

/**
 * A side's cell: what it prints, a line under it when there is one, and the
 * words a screen reader says instead when the printed form reads badly
 * ("5W 1D 2L" is "5 won, 1 drawn, 2 lost").
 */
export type TapeValue = { text: string; sub: string | null; spoken?: string };

export type TapeRow = {
  key: "record" | "games" | "mmr" | "kills" | "kda" | "gpm" | "length";
  label: string;
  home: TapeValue;
  away: TapeValue;
  /** The side the number favours; null when level, or for a neutral row. */
  edge: "home" | "away" | null;
  /**
   * Each side's bar as a share of the larger value (the leader's is 1), or
   * null for a row with no bars (a neutral row, or nothing to compare).
   */
  bars: { home: number; away: number } | null;
};

export type TaleOfTheTapeInput = {
  homeTeamId: string;
  awayTeamId: string;
  /** Every match of the season, any phase. */
  matches: readonly (MatchLike & { id: string })[];
  /** The two teams' games this season. */
  games: readonly TapeGame[];
  /** Each roster's known MMRs (unknown ones, stored as 0, are dropped). */
  mmrs: { home: readonly number[]; away: readonly number[] };
  /** "2nd" in the table, "Seed 1" in the playoffs; null when not known. */
  standing: { home: string | null; away: string | null };
  /** A playoff or grand final: the record row says "Regular season". */
  postseason: boolean;
};

const oneDecimal = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** Round to what the row prints, so a lead the eye can't see isn't shown. */
const round1 = (n: number) => Math.round(n * 10) / 10;

/** "34:07": a Dota game clock. */
export function gameClock(totalSecs: number): string {
  const secs = Math.round(totalSecs);
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

function compare(
  home: number,
  away: number,
): Pick<TapeRow, "edge" | "bars"> {
  const top = Math.max(home, away);
  return {
    edge: home > away ? "home" : away > home ? "away" : null,
    bars: top > 0 ? { home: home / top, away: away / top } : null,
  };
}

/**
 * The rows, in the order the card prints them. A row appears only when both
 * sides have something to show, so an early-season preview simply has fewer
 * rows (none at all before a series is played and with no MMR on file).
 *
 * - Record: the regular season's series W-D-L (the standings' own count),
 *   ranked by points, with the table place or playoff seed under it.
 * - Games won: every completed series this season, playoffs included, ranked
 *   by the share of games won.
 * - Avg MMR: the rosters' known signup MMRs.
 * - Kills per game, KDA ((kills + assists) / deaths) and GPM: from the box
 *   scores of the games each team played.
 * - Avg game length: neutral, no edge, no bars.
 */
export function taleOfTheTape(input: TaleOfTheTapeInput): TapeRow[] {
  const { homeTeamId, awayTeamId } = input;
  const rows: TapeRow[] = [];

  // computeStandings counts a match only when both of its teams are in the
  // table, so hand it every team the season's fixtures name.
  const teamIds = [
    ...new Set(input.matches.flatMap((m) => [m.homeTeamId, m.awayTeamId])),
  ];
  const table = computeStandings(teamIds, [...input.matches]);
  const homeRow = table.find((r) => r.teamId === homeTeamId);
  const awayRow = table.find((r) => r.teamId === awayTeamId);
  if (homeRow && awayRow && homeRow.played + awayRow.played > 0) {
    const label = input.postseason ? "Regular season" : "Record";
    rows.push({
      key: "record",
      label,
      home: {
        text: seriesRecordText(homeRow),
        sub: input.standing.home,
        spoken: seriesRecordSpoken(homeRow),
      },
      away: {
        text: seriesRecordText(awayRow),
        sub: input.standing.away,
        spoken: seriesRecordSpoken(awayRow),
      },
      ...compare(homeRow.points, awayRow.points),
    });
  }

  const gameTally = (teamId: string) => {
    let won = 0;
    let lost = 0;
    for (const m of input.matches) {
      if (m.status !== MATCH_STATUS.COMPLETED) continue;
      if (m.homeTeamId === teamId) {
        won += m.homeScore;
        lost += m.awayScore;
      } else if (m.awayTeamId === teamId) {
        won += m.awayScore;
        lost += m.homeScore;
      }
    }
    return { won, lost, share: won + lost > 0 ? won / (won + lost) : null };
  };
  const homeGames = gameTally(homeTeamId);
  const awayGames = gameTally(awayTeamId);
  if (homeGames.share !== null && awayGames.share !== null) {
    const cell = (t: { won: number; lost: number; share: number }) => ({
      text: `${t.won}–${t.lost}`,
      sub: `${Math.round(t.share * 100)}%`,
      spoken: `${t.won} won, ${t.lost} lost`,
    });
    rows.push({
      key: "games",
      label: "Games won",
      home: cell({ ...homeGames, share: homeGames.share }),
      away: cell({ ...awayGames, share: awayGames.share }),
      ...compare(
        Math.round(homeGames.share * 100),
        Math.round(awayGames.share * 100),
      ),
    });
  }

  const meanMmr = (mmrs: readonly number[]) => {
    const known = mmrs.filter((mmr) => mmr > 0);
    return known.length > 0
      ? Math.round(known.reduce((sum, mmr) => sum + mmr, 0) / known.length)
      : null;
  };
  const homeMmr = meanMmr(input.mmrs.home);
  const awayMmr = meanMmr(input.mmrs.away);
  if (homeMmr !== null && awayMmr !== null) {
    rows.push({
      key: "mmr",
      label: "Avg MMR",
      home: { text: whole.format(homeMmr), sub: null },
      away: { text: whole.format(awayMmr), sub: null },
      ...compare(homeMmr, awayMmr),
    });
  }

  const home = teamGameTotals(homeTeamId, input.games);
  const away = teamGameTotals(awayTeamId, input.games);
  if (home.games > 0 && away.games > 0) {
    const kills = (t: TeamGameTotals) => round1(t.kills / t.games);
    rows.push({
      key: "kills",
      label: "Kills per game",
      home: { text: oneDecimal.format(kills(home)), sub: null },
      away: { text: oneDecimal.format(kills(away)), sub: null },
      ...compare(kills(home), kills(away)),
    });
    const kda = (t: TeamGameTotals) =>
      round1((t.kills + t.assists) / Math.max(1, t.deaths));
    rows.push({
      key: "kda",
      label: "KDA",
      home: { text: oneDecimal.format(kda(home)), sub: null },
      away: { text: oneDecimal.format(kda(away)), sub: null },
      ...compare(kda(home), kda(away)),
    });
  }
  if (home.gpmGames > 0 && away.gpmGames > 0) {
    const gpm = (t: TeamGameTotals) => Math.round(t.gpmSum / t.gpmGames);
    rows.push({
      key: "gpm",
      label: "Gold per min",
      home: { text: whole.format(gpm(home)), sub: null },
      away: { text: whole.format(gpm(away)), sub: null },
      ...compare(gpm(home), gpm(away)),
    });
  }
  if (home.durationGames > 0 && away.durationGames > 0) {
    const length = (t: TeamGameTotals) => t.durationSecs / t.durationGames;
    rows.push({
      key: "length",
      label: "Avg game",
      home: { text: gameClock(length(home)), sub: null },
      away: { text: gameClock(length(away)), sub: null },
      edge: null,
      bars: null,
    });
  }
  return rows;
}

/** "1st", "2nd", "3rd", "11th": a place in the table. */
export function ordinalPlace(n: number): string {
  const mod100 = n % 100;
  const mod10 = n % 10;
  const suffix =
    mod100 >= 11 && mod100 <= 13
      ? "th"
      : mod10 === 1
        ? "st"
        : mod10 === 2
          ? "nd"
          : mod10 === 3
            ? "rd"
            : "th";
  return `${n}${suffix}`;
}
