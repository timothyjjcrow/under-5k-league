// /leaders as one table: every player's season line under every stat the
// page ranks. Pure and DB-free. The page decodes the season's box scores
// once, this module decides each stat's value, its minimum and who may rank,
// and the explorer (leaders-explorer.tsx) only sorts and filters what it is
// handed.
//
// Every stat ranks what the PLAYER did (Tim's decision, 2026-09-27): no wins,
// no win rate. Kills and assists are per game with the flat
// PER_GAME_MIN_GAMES; the other averages cap their floor at the most-played
// count so they aren't empty in a season's first weeks; "Most games" stays as
// the one count.

import { careerReportCard, percentLabel } from "./benchmarks";
import { fantasyPoints } from "./fantasy";
import { killParticipationByPlayer } from "./leader-ranking";
import type { PlayerStat } from "./match-import";
import {
  PER_GAME_MIN_GAMES,
  summarizePlayerGames,
  type PlayerGameLine,
} from "./player-stats";
import { formatNetWorth } from "./utils";

/** Display order: the tiles, the table's columns and a player's stat card. */
export const LEADER_STAT_KEYS = [
  "impact",
  "kda",
  "killsPerGame",
  "assistsPerGame",
  "participation",
  "healing",
  "gpm",
  "netWorth",
  "games",
  "report",
] as const;

export type LeaderStatKey = (typeof LEADER_STAT_KEYS)[number];

export type LeaderStat = {
  key: LeaderStatKey;
  /** The tile and column label. */
  label: string;
  /** The ranking's full name. */
  title: string;
  /** One sentence on what it measures. */
  description: string;
  /** Printed under a value: "kills / game". */
  unit: string;
  /** What a player needs to rank ("Min 3 games"); null for a plain count. */
  minimum: string | null;
  /** Fixed top of the bar's scale; unset compares to the leader. */
  scaleMax?: number;
};

export type LeaderCell = {
  value: number;
  /** The value at the precision shown, so equal labels share a rank. */
  rankValue: number;
  label: string;
  /** The line under a player's name when this stat ranks the table. */
  hint: string;
  /** Breaks equal values: the bigger sample ranks first. */
  sample: number;
  /** Meets the stat's minimum. An unranked value is shown dimmed. */
  ranked: boolean;
};

export type LeaderTableRow = {
  id: string;
  games: number;
  cells: Partial<Record<LeaderStatKey, LeaderCell>>;
  /** Most-played heroes, at most three. */
  heroes: { heroId: number; games: number; wins: number }[];
};

export type LeaderTable = {
  /** The stats with something to rank, in display order. */
  stats: LeaderStat[];
  rows: LeaderTableRow[];
};

export type LeaderGame = {
  radiantWin: boolean;
  /** The game's trusted lines (trustedGamePlayers): complete 5v5 only. */
  lines: PlayerStat[];
};

const HEROES_SHOWN = 3;
const number = new Intl.NumberFormat("en-US");
const plural = (count: number, word: string, many = `${word}s`) =>
  `${number.format(count)} ${count === 1 ? word : many}`;

/**
 * The season MVP's floor (awards.ts): half the most games anyone has played,
 * so the "MVP race" ranking names who the award would crown today.
 */
export function mvpGamesFloor(maxGames: number): number {
  return Math.max(1, Math.ceil(maxGames / 2));
}

/**
 * The floor of the average boards that follow the season: PER_GAME_MIN_GAMES,
 * capped at the most-played count so they fill in from week one.
 */
export function rateGamesFloor(maxGames: number): number {
  return Math.min(PER_GAME_MIN_GAMES, Math.max(1, maxGames));
}

export function buildLeaderTable(games: readonly LeaderGame[]): LeaderTable {
  const linesByUser = new Map<string, PlayerGameLine[]>();
  const rawByUser = new Map<string, PlayerStat[]>();
  // Summed per-game impact points in whole tenths (fantasyPoints is rounded
  // to 0.1), so equal averages compare equal, as the MVP award counts them.
  const pointsTenths = new Map<string, number>();
  for (const game of games) {
    for (const line of game.lines) {
      if (!line.userId) continue;
      const lines = linesByUser.get(line.userId) ?? [];
      lines.push({
        isRadiant: line.isRadiant,
        radiantWin: game.radiantWin,
        kills: line.kills,
        deaths: line.deaths,
        assists: line.assists,
        heroId: line.heroId,
        netWorth: line.netWorth,
        gpm: line.gpm,
      });
      linesByUser.set(line.userId, lines);
      const raw = rawByUser.get(line.userId) ?? [];
      raw.push(line);
      rawByUser.set(line.userId, raw);
      pointsTenths.set(
        line.userId,
        (pointsTenths.get(line.userId) ?? 0) +
          Math.round(
            fantasyPoints(line, line.isRadiant === game.radiantWin) * 10,
          ),
      );
    }
  }

  const summaries = [...linesByUser].map(([id, lines]) => ({
    id,
    summary: summarizePlayerGames(lines),
  }));
  const maxGames = Math.max(1, ...summaries.map((row) => row.summary.games));
  const rateFloor = rateGamesFloor(maxGames);
  const mvpFloor = mvpGamesFloor(maxGames);
  const participation = killParticipationByPlayer([...games]);

  const rows: LeaderTableRow[] = summaries.map(({ id, summary }) => {
    const cells: LeaderTableRow["cells"] = {};
    const put = (key: LeaderStatKey, cell: LeaderCell) => {
      // A zero is no performance to rank (the boards never listed one).
      if (cell.value > 0) cells[key] = cell;
    };

    const tenths = pointsTenths.get(id) ?? 0;
    const impact = tenths / summary.games / 10;
    put("impact", {
      value: impact,
      rankValue: Math.round(impact * 10),
      label: impact.toFixed(1),
      hint: `${number.format(Math.round(tenths / 10))} points in ${plural(summary.games, "game")}`,
      sample: summary.games,
      ranked: summary.games >= mvpFloor,
    });
    put("kda", {
      value: summary.kda,
      rankValue: summary.kda,
      label: summary.kda.toFixed(1),
      hint: `${summary.avgKills}/${summary.avgDeaths}/${summary.avgAssists}`,
      sample: summary.games,
      ranked: summary.games >= rateFloor,
    });
    put("killsPerGame", {
      value: summary.avgKills,
      rankValue: summary.avgKills,
      label: summary.avgKills.toFixed(1),
      hint: `${plural(summary.kills, "kill")} in ${plural(summary.games, "game")}`,
      sample: summary.games,
      ranked: summary.games >= PER_GAME_MIN_GAMES,
    });
    put("assistsPerGame", {
      value: summary.avgAssists,
      rankValue: summary.avgAssists,
      label: summary.avgAssists.toFixed(1),
      hint: `${plural(summary.assists, "assist")} in ${plural(summary.games, "game")}`,
      sample: summary.games,
      ranked: summary.games >= PER_GAME_MIN_GAMES,
    });
    put("games", {
      value: summary.games,
      rankValue: summary.games,
      label: `${summary.games}`,
      // Words, not a bare "8–0": a score beside a games count read as one.
      hint: `${plural(summary.wins, "win")}, ${plural(summary.losses, "loss", "losses")}`,
      sample: summary.games,
      ranked: true,
    });
    if (summary.avgGpm != null) {
      put("gpm", {
        value: summary.avgGpm,
        rankValue: summary.avgGpm,
        label: `${summary.avgGpm}`,
        hint: plural(summary.gpmGames, "reported game"),
        sample: summary.games,
        ranked: summary.gpmGames >= rateFloor,
      });
    }
    if (summary.avgNetWorth != null) {
      put("netWorth", {
        value: summary.avgNetWorth,
        rankValue: Math.round(summary.avgNetWorth / 100),
        label: formatNetWorth(summary.avgNetWorth),
        hint: plural(summary.netWorthGames, "reported game"),
        sample: summary.games,
        ranked: summary.netWorthGames >= rateFloor,
      });
    }

    const shared = participation.get(id);
    if (shared) {
      put("participation", {
        value: shared.rate,
        rankValue: Math.round(shared.rate),
        label: `${Math.round(shared.rate)}%`,
        hint: `${number.format(shared.involved)} of ${number.format(shared.teamKills)} team kills · ${plural(shared.scoredGames, "scored game")}`,
        sample: shared.scoredGames,
        ranked: shared.scoredGames >= rateFloor,
      });
    }

    // Healing is an optional provider field: a missing value is never a zero.
    const raw = rawByUser.get(id) ?? [];
    const healing = raw.flatMap((line) =>
      line.heroHealing == null ? [] : [line.heroHealing],
    );
    if (healing.length > 0) {
      const total = healing.reduce((sum, value) => sum + value, 0);
      const average = total / healing.length;
      put("healing", {
        value: average,
        rankValue: Math.round(average),
        label: number.format(Math.round(average)),
        hint: `${number.format(Math.round(total))} total · ${plural(healing.length, "reported game")}`,
        sample: healing.length,
        ranked: healing.length >= rateFloor,
      });
    }

    const report = careerReportCard(raw);
    if (report.avgPct != null) {
      put("report", {
        value: report.avgPct,
        rankValue: Math.round(report.avgPct * 100),
        label: percentLabel(report.avgPct).replace(" percentile", ""),
        hint: `${plural(report.graded, "graded game")}${report.best ? ` · best: ${report.best.label.toLowerCase()}` : ""}`,
        sample: report.graded,
        ranked: report.graded >= rateFloor,
      });
    }

    return {
      id,
      games: summary.games,
      cells,
      heroes: summary.topHeroes.slice(0, HEROES_SHOWN),
    };
  });

  const games_ = (count: number) => plural(count, "game");
  const catalogue: Record<LeaderStatKey, LeaderStat> = {
    impact: {
      key: "impact",
      label: "Impact",
      title: "MVP race",
      description:
        "Impact points per game, the Player of the Week score. The season MVP is whoever leads this when the season ends.",
      unit: "points / game",
      minimum: `Min ${games_(mvpFloor)}: half the most anyone has played`,
    },
    kda: {
      key: "kda",
      label: "KDA",
      title: "Best KDA",
      description: "Kills plus assists for each death.",
      unit: "KDA ratio",
      minimum: `Min ${games_(rateFloor)}`,
    },
    killsPerGame: {
      key: "killsPerGame",
      label: "Kills",
      title: "Kills per game",
      description: "Enemy heroes taken down, averaged over games played.",
      unit: "kills / game",
      minimum: `Min ${games_(PER_GAME_MIN_GAMES)}`,
    },
    assistsPerGame: {
      key: "assistsPerGame",
      label: "Assists",
      title: "Assists per game",
      description: "Kills set up for teammates, averaged over games played.",
      unit: "assists / game",
      minimum: `Min ${games_(PER_GAME_MIN_GAMES)}`,
    },
    participation: {
      key: "participation",
      label: "Kill share",
      title: "Kill involvement",
      description: "The share of team kills each player scored or assisted.",
      unit: "of team kills",
      minimum: `Min ${plural(rateFloor, "scored game")}`,
      scaleMax: 100,
    },
    healing: {
      key: "healing",
      label: "Healing",
      title: "Team sustain",
      description:
        "Hero healing per reported game; box scores without it are left out.",
      unit: "healing / game",
      minimum: `Min ${plural(rateFloor, "reported game")}`,
    },
    gpm: {
      key: "gpm",
      label: "GPM",
      title: "Best avg GPM",
      description: "Gold earned per minute, averaged over reported games.",
      unit: "gold / min",
      minimum: `Min ${plural(rateFloor, "reported game")}`,
    },
    netWorth: {
      key: "netWorth",
      label: "Net worth",
      title: "Richest (avg net worth)",
      description: "Final net worth averaged over reported games.",
      unit: "avg net worth",
      minimum: `Min ${plural(rateFloor, "reported game")}`,
    },
    games: {
      key: "games",
      label: "Games",
      title: "Most games",
      description: "Players who showed up most often.",
      unit: "games played",
      minimum: null,
    },
    report: {
      key: "report",
      label: "Report card",
      title: "Best report card",
      description:
        "Each performance graded against worldwide Dota benchmarks, as an average percentile.",
      unit: "percentile",
      minimum: `Min ${plural(rateFloor, "graded game")}`,
      scaleMax: 1,
    },
  };
  // These three depend on optional data: a ranking nobody is on is left out
  // (the boards were). The rest always show, and say who qualifies.
  const optional = new Set<LeaderStatKey>(["participation", "healing", "report"]);
  const stats = LEADER_STAT_KEYS.filter(
    (key) => !optional.has(key) || rows.some((row) => row.cells[key]?.ranked),
  ).map((key) => catalogue[key]);

  return { stats, rows };
}
