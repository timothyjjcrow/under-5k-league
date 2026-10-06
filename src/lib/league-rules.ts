// The league's rules on one page (/rules), built from what the site enforces:
// the constants the code checks against, the season's own settings and the
// deployment's LEAGUE_CONFIG. Pure, so the page can't drift from the league it
// describes, and every sentence is unit-tested (league-rules.test.ts). The
// page itself holds no rule numbers; a source guard there checks that.
//
// It never invents a rule. A sentence that states what a function decides is
// only included while that function still decides it (the probes below), and
// anything the code doesn't decide at all (no-show grace, conduct, disputes)
// is left to the closing line. docs/features/pages-and-ui.md lists those gaps.

import { MAX_RESCHEDULE_OPTIONS } from "./reschedule-ready-check";
import {
  AUTO_SYNC,
  DEFAULTS,
  LEAGUE_GAME_MODE,
  MATCH_PHASE,
  MATCH_STATUS,
  SEASON_STATUS,
} from "./constants";
import { BUDGET_FULL_EFFECT_GAP } from "./draft";
import { eligibilityText, resultsCopy } from "./how-it-works";
import { LEAGUE_CONFIG } from "./league-config";
import { matchResultsOpen } from "./league-lifecycle";
import {
  DETECT_WINDOW_AFTER_MS,
  DETECT_WINDOW_BEFORE_MS,
  knownPlayersPerSide,
} from "./league-result-window";
import { seriesLobbyRule } from "./match-hosting";
import {
  FIXTURE_CONFLICT_WINDOW_MS,
  RESCHEDULE_MAX_AHEAD_MS,
  RESCHEDULE_PAST_GRACE_MS,
  pickBracketSize,
  playoffFirstRound,
} from "./schedule";
import { SCRIM_COLLISION_WINDOW_MS } from "./scrim-schedule-conflict";
import {
  carriedSeasonSettings,
  type CarriedSeasonSettings,
} from "./season-handoff";
import { STANDIN_CONFLICT_HOURS, STANDIN_MMR_FLAG_GAP } from "./standin";
import { computeStandings } from "./standings";
import {
  teamWithdrawalLockedReason,
  withdrawalForfeitScore,
} from "./team-withdrawal";
import { TIEBREAKER_RULES, TIEBREAKER_SUMMARY } from "./tiebreaker-format";

/** The page's last line, word for word. */
export const RULES_CLOSING = "Admins rule on anything not written here.";

/** The season the rules quote: its settings, plus enough to name it. */
export type RulesSeason = CarriedSeasonSettings & {
  name: string;
  status: string;
  isActive: boolean;
};

export type LeagueRulesInput = {
  /** The active season, else the latest one; null before the first season. */
  season: RulesSeason | null;
  /**
   * `announcedMatchNight` for the ACTIVE season (between seasons, the
   * deployment default); null when nothing is announced yet.
   */
  matchNight: string | null;
  /** The active season's teams that haven't withdrawn; null when unknown. */
  teamCount: number | null;
  /** The deployment's identity. Tests pass `createLeagueConfig({...})`. */
  config?: Pick<typeof LEAGUE_CONFIG, "name" | "gameServerRegion">;
};

export type RuleSection = {
  /** The section's anchor, as in /rules#forfeits. */
  id: string;
  title: string;
  rules: string[];
};

export type LeagueRules = {
  /** One line on whose settings the numbers are. */
  basis: string;
  /** No season exists yet: the numbers are the first season's defaults. */
  defaults: boolean;
  sections: RuleSection[];
  closing: string;
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function plural(n: number, unit: string): string {
  return `${n.toLocaleString("en-US")} ${unit}${n === 1 ? "" : "s"}`;
}

/** A duration in the largest whole unit: "an hour", "4 hours", "180 days". */
function span(ms: number): string {
  if (ms % DAY_MS === 0) {
    return ms === DAY_MS ? "a day" : plural(ms / DAY_MS, "day");
  }
  if (ms % HOUR_MS === 0) {
    return ms === HOUR_MS ? "an hour" : plural(ms / HOUR_MS, "hour");
  }
  return plural(Math.round(ms / 60_000), "minute");
}

function money(amount: number): string {
  return `$${amount.toLocaleString("en-US")}`;
}

/**
 * What the table awards a series win, draw and loss, read off
 * `computeStandings` itself: its points are literals inside that function, so
 * asking it is the only way the page can't quote a scoring it doesn't use.
 */
function seriesPoints(): { win: number; draw: number; loss: number } {
  const played = { status: MATCH_STATUS.COMPLETED, phase: MATCH_PHASE.REGULAR };
  const table = computeStandings(
    ["winner", "loser", "home", "away"],
    [
      {
        ...played,
        homeTeamId: "winner",
        awayTeamId: "loser",
        homeScore: 1,
        awayScore: 0,
        winnerTeamId: "winner",
      },
      {
        ...played,
        homeTeamId: "home",
        awayTeamId: "away",
        homeScore: 1,
        awayScore: 1,
        winnerTeamId: null,
      },
    ],
  );
  const points = (teamId: string) =>
    table.find((row) => row.teamId === teamId)?.points ?? 0;
  return { win: points("winner"), draw: points("home"), loss: points("loser") };
}

/**
 * `pickBracketSize` as steps: "2–3 teams send 2, 4–7 send 4, …". Read from
 * the function over every team count up to `maxTeams`, so a new sizing rule
 * changes this line too.
 */
function bracketSteps(maxTeams = 31): string {
  const steps: { size: number; from: number; to: number }[] = [];
  for (let teams = 2; teams <= maxTeams; teams += 1) {
    const size = pickBracketSize(teams);
    const last = steps[steps.length - 1];
    if (last && last.size === size) last.to = teams;
    else steps.push({ size, from: teams, to: teams });
  }
  return steps
    .map(
      (step, index) =>
        `${step.from}–${step.to}${index === 0 ? " teams" : ""} send ${step.size}`,
    )
    .join(", ");
}

/**
 * Round one's pairings, from `playoffFirstRound` over seed numbers. Says the
 * higher seed hosts only while every pairing puts it at home, and describes
 * the general pattern only while every pairing is top-against-bottom.
 */
function firstRoundRule(bracketSize: number | null): string | null {
  const size = bracketSize ?? 8;
  const seeds = Array.from({ length: size }, (_, i) => String(i + 1));
  const pairings = playoffFirstRound(seeds, size).map((pair) => ({
    home: Number(pair.home),
    away: Number(pair.away),
  }));
  const higherHosts = pairings.every((pair) => pair.home < pair.away);
  const hosts = higherHosts ? "; the higher seed hosts" : "";
  if (bracketSize === 2) {
    return `The top two play the grand final${higherHosts ? ", and seed 1 hosts" : ""}.`;
  }
  if (bracketSize) {
    const listed = [...pairings]
      .sort((a, b) => a.home - b.home)
      .map((pair) => `${pair.home} v ${pair.away}`);
    return `Round one: ${listed.join(", ")}${hosts}.`;
  }
  const mirrored = pairings.every((pair) => pair.home + pair.away === size + 1);
  return mirrored
    ? `Round one pairs the top seed with the lowest, the second with the second lowest, and so on${hosts}.`
    : null;
}

function basisLine(
  season: RulesSeason | null,
  leagueName: string,
): string {
  if (!season) {
    return `${leagueName} hasn't started a season yet, so these are the settings a first season starts with. The admins can change them before it does.`;
  }
  if (season.isActive && season.status !== SEASON_STATUS.COMPLETE) {
    return `How ${leagueName} plays ${season.name}.`;
  }
  return `As ${leagueName} played ${season.name}. The next season starts with the same settings unless the admins change them.`;
}

function seriesSection(s: CarriedSeasonSettings): RuleSection {
  const lengths = [
    ...new Set([s.regularBestOf, s.playoffBestOf, s.finalBestOf]),
  ].sort((a, b) => a - b);
  return {
    id: "series",
    title: "Series format",
    rules: [
      `Regular season: best of ${s.regularBestOf}. Playoffs: best of ${s.playoffBestOf}. Grand final: best of ${s.finalBestOf}.`,
      ...lengths.map((bestOf) => `${seriesLobbyRule(bestOf)}.`),
      "If the admins change a series length during the season, only series that haven't kicked off change.",
    ],
  };
}

function standingsSection(s: CarriedSeasonSettings): RuleSection {
  const points = seriesPoints();
  const half = s.regularBestOf / 2;
  const evenDraw =
    s.regularBestOf % 2 === 0
      ? ` (a best of ${s.regularBestOf} that ends ${half}–${half})`
      : "";
  return {
    id: "standings",
    title: "Standings and tiebreakers",
    rules: [
      `A series win is worth ${plural(points.win, "point")}, a draw ${points.draw} and a loss ${points.loss}. Only regular-season series count toward the table.`,
      `A regular-season series that ends level is a draw${evenDraw}. Tiebreaker and playoff series can't end in a draw.`,
      "Teams level on points are split by game difference, then series wins, then head-to-head: points, then game difference, in the series between the tied teams.",
      "Teams still level where it decides a playoff place or seed play tiebreakers before the playoffs start.",
      `Tiebreakers: ${TIEBREAKER_SUMMARY}.`,
      TIEBREAKER_RULES,
    ],
  };
}

function playoffsSection(teamCount: number | null): RuleSection {
  const size =
    teamCount !== null && teamCount >= 2 ? pickBracketSize(teamCount) : null;
  const rules = [
    `The playoffs are a single-elimination bracket of the top teams, as big as the teams that haven't withdrawn allow: ${bracketSteps()}.`,
  ];
  if (size !== null && teamCount !== null) {
    rules.push(
      `This season has ${plural(teamCount, "team")} in it, so the top ${size} make the playoffs.`,
    );
  }
  const firstRound = firstRoundRule(size);
  if (firstRound) rules.push(firstRound);
  rules.push(
    "Winners stay on their side of the bracket: there is no reseeding.",
    "Round one is played on the match night after the regular season and any tiebreakers, and each later round on the next match night once the round before it is done.",
  );
  return { id: "playoffs", title: "Playoffs", rules };
}

function forfeitsSection(s: CarriedSeasonSettings): RuleSection {
  const rules = [
    "Only admins record forfeits. A forfeit is a ruled score: it can end a series early, but it can't hold more games than the series allows or erase games already played.",
    "Ruled scores count in the table like played ones, game difference included.",
  ];
  // Withdrawal is a regular-season ruling (teamWithdrawalLockedReason): say
  // so only while that is the phase the action accepts.
  if (teamWithdrawalLockedReason(SEASON_STATUS.REGULAR_SEASON) === null) {
    const score = withdrawalForfeitScore(s.regularBestOf);
    rules.push(
      `A team that withdraws during the regular season forfeits every series it hasn't finished, one under way included: each opponent wins ${score}–0 in a best of ${s.regularBestOf}, whatever was already played.`,
      "The results it already played still count for everyone else, and it can't enter the playoffs.",
    );
    if (teamWithdrawalLockedReason(SEASON_STATUS.PLAYOFFS) !== null) {
      rules.push("Once the playoffs start, an admin rules each affected series instead.");
    }
  }
  return { id: "forfeits", title: "Forfeits and withdrawals", rules };
}

function rostersSection(s: CarriedSeasonSettings): RuleSection {
  return {
    id: "rosters",
    title: "Rosters and standins",
    rules: [
      `Teams have ${plural(s.teamSize, "player")}, the captain included.`,
      "After the auction, admins can sign undrafted players into open seats and release players, until the season ends.",
      "Anyone with an active signup who isn't on a roster can stand in: standins and undrafted players alike.",
      "Captains book standins for their own team on the match page, and admins can book for any team. One standin per seat.",
      `A standin can't be booked for two matches within ${plural(STANDIN_CONFLICT_HOURS, "hour")} of each other.`,
      "Cover can be booked from the end of the auction until the series is over, and removed until the series' first game is in.",
      `Booking a standin ${STANDIN_MMR_FLAG_GAP.toLocaleString("en-US")} or more MMR above the player they cover shows a warning to check with the other captain. It never blocks the booking.`,
    ],
  };
}

function matchNightSection(matchNight: string | null): RuleSection {
  const fixtures = span(FIXTURE_CONFLICT_WINDOW_MS);
  const scrims = span(SCRIM_COLLISION_WINDOW_MS);
  const clash =
    fixtures === scrims
      ? `within ${fixtures} of either team's other league matches or booked scrims`
      : `within ${fixtures} of either team's other league matches, or ${scrims} of their booked scrims`;
  return {
    id: "match-night",
    title: "Match night and rescheduling",
    rules: [
      matchNight
        ? `Match night: ${matchNight}. Kickoff times show in your own time zone.`
        : "Match night is to be announced. Kickoff times show in your own time zone.",
      `Once your match has a kickoff time, answer its check-in (I'm in, or Can't make it) so your captain can find cover. It stays open until ${plural(AUTO_SYNC.WINDOW_HOURS, "hour")} after kickoff.`,
      `Captains move a match with a ready check: either captain offers up to ${MAX_RESCHEDULE_OPTIONS} times on the match page, everyone playing answers each one, and the match moves itself once both captains and a full lineup on each side can make a time. Either captain can lock in a time the other captain said yes to without waiting for everyone.`,
      "After a ready check, each player's answer to the new time becomes their check-in. Admins can also move a match or a whole week; that clears its check-ins, so everyone answers again.",
      `A proposed time can't be more than ${span(RESCHEDULE_PAST_GRACE_MS)} in the past, more than ${span(RESCHEDULE_MAX_AHEAD_MS)} ahead, or ${clash}.`,
      "A regular-season match has to be played before the playoffs start.",
      "A series that has started can't be moved.",
    ],
  };
}

function hostingSection(
  ticket: boolean | null,
  config: NonNullable<LeagueRulesInput["config"]>,
): RuleSection {
  const rules = [
    "The home team's captain hosts the lobby; the match page names them.",
    `Lobbies are ${LEAGUE_GAME_MODE.name} on ${config.gameServerRegion} servers.`,
  ];
  if (ticket === true) {
    rules.push(
      "In every lobby, set League to the season's league id (the match page shows it), so each result imports by itself.",
    );
  }
  return { id: "hosting", title: "Hosting the lobby", rules };
}

function signupsSection(s: CarriedSeasonSettings): RuleSection {
  return {
    id: "signups",
    title: "Signups and eligibility",
    rules: [
      eligibilityText(s.maxMmr),
      `Signups are uncapped; the season's target is at least ${plural(s.minTeams, "team")}.`,
      "Players sign up while the season is taking signups. After that, new players can sign up as standins until the playoffs end.",
      "You can withdraw your own signup unless you're on a roster or booked to stand in for a match not yet played: an admin has to release you, or the booking has to come off, first.",
    ],
  };
}

function draftSection(s: CarriedSeasonSettings): RuleSection {
  const rules = [
    `Captains are on their own teams and buy their other ${plural(s.teamSize - 1, "player")} in a live auction. Only player signups are in it, not standins.`,
    `Each captain has ${money(s.draftBudget)} to spend.`,
  ];
  if (s.budgetMmrWeight > 0) {
    rules.push(
      `Budgets are weighted by captain MMR: the lowest-rated captain gets up to ${s.budgetMmrWeight}% more and the highest up to ${s.budgetMmrWeight}% less, in full once the captains are ${BUDGET_FULL_EFFECT_GAP.toLocaleString("en-US")} MMR apart.`,
    );
  }
  rules.push(
    "Captains take turns nominating in draft order: a simple rotation, not a snake. Teams that are full, or can't afford the minimum bid, are skipped.",
    `Bids are whole dollars from ${money(DEFAULTS.MIN_BID)}. Each bid resets the clock to ${plural(DEFAULTS.BID_TIMER_SECONDS, "second")}, or ${plural(DEFAULTS.UNCONTESTED_BID_TIMER_SECONDS, "second")} when no other team can top it.`,
    `A bid must leave ${money(DEFAULTS.MIN_BID)} for each seat still to fill, so every team can finish its roster.`,
    `A captain who doesn't nominate within ${plural(DEFAULTS.NOMINATION_TIMER_SECONDS, "second")} has the highest-MMR player left nominated for them at ${money(DEFAULTS.MIN_BID)}.`,
    "If the player pool runs out first, the auction ends and teams still short fill their open seats with standins.",
  );
  return { id: "draft", title: "The auction draft", rules };
}

function resultsSection(
  s: CarriedSeasonSettings,
  ticket: boolean | null,
): RuleSection {
  const perSide = knownPlayersPerSide(s.teamSize);
  const rules = [
    resultsCopy(ticket).faq,
    `A game counts for a match when at least ${perSide} of each team's players (its roster, or standins booked for that match) are on opposite sides, and it started between ${span(DETECT_WINDOW_BEFORE_MS)} before and ${span(DETECT_WINDOW_AFTER_MS)} after the scheduled kickoff. Admins can add a game from outside that window.`,
    "Only admins enter a score by hand.",
  ];
  // matchResultsOpen pairs each result with its own phase; quote that only
  // while it still holds in both directions.
  const ownPhaseOnly =
    matchResultsOpen(SEASON_STATUS.REGULAR_SEASON, MATCH_PHASE.REGULAR) &&
    matchResultsOpen(SEASON_STATUS.REGULAR_SEASON, MATCH_PHASE.TIEBREAKER) &&
    !matchResultsOpen(SEASON_STATUS.PLAYOFFS, MATCH_PHASE.REGULAR) &&
    matchResultsOpen(SEASON_STATUS.PLAYOFFS, MATCH_PHASE.PLAYOFF) &&
    !matchResultsOpen(SEASON_STATUS.REGULAR_SEASON, MATCH_PHASE.PLAYOFF);
  if (ownPhaseOnly) {
    rules.push(
      "Results are corrected only in their own phase: regular-season and tiebreaker results before the playoffs, playoff results during them.",
    );
  }
  return { id: "results", title: "Results and game imports", rules };
}

/**
 * Every section of /rules, in reading order. `season` null quotes the first
 * season's defaults (`carriedSeasonSettings(null)`) and says so.
 */
export function leagueRules({
  season,
  matchNight,
  teamCount,
  config = LEAGUE_CONFIG,
}: LeagueRulesInput): LeagueRules {
  const settings: CarriedSeasonSettings = season ?? carriedSeasonSettings(null);
  // The ticket is the ACTIVE season's (How it works asks the same question);
  // between seasons the next season's ticket isn't known yet.
  const ticket = season?.isActive ? Boolean(season.dotaLeagueId) : null;
  return {
    basis: basisLine(season, config.name),
    defaults: season === null,
    sections: [
      seriesSection(settings),
      standingsSection(settings),
      playoffsSection(season?.isActive ? teamCount : null),
      forfeitsSection(settings),
      rostersSection(settings),
      matchNightSection(matchNight),
      hostingSection(ticket, config),
      signupsSection(settings),
      draftSection(settings),
      resultsSection(settings, ticket),
    ],
    closing: RULES_CLOSING,
  };
}
