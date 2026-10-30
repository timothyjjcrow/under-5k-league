// The league's rules on one page (/rules), built from what the site enforces:
// the constants the code checks against, the season's own settings and the
// deployment's LEAGUE_CONFIG. Pure, so the page can't drift from the league it
// describes, and every sentence is unit-tested (league-rules.test.ts). The
// page itself holds no rule numbers; a source guard there checks that.
//
// It never invents a rule. A sentence that states what a function decides is
// only included while that function still decides it (the probes below). The
// rules admins enforce by hand (lateness, pauses, remakes, fair play,
// conduct) are Tim's written policy, approved 2026-10-25: their numbers are
// the WRITTEN_RULES constants below, and their sections say admins rule on
// them. Anything else is left to the closing line;
// docs/features/pages-and-ui.md lists those gaps.

import { MAX_RESCHEDULE_OPTIONS } from "./reschedule-ready-check";
import {
  AUTO_SYNC,
  DEFAULTS,
  LEAGUE_GAME_MODE,
  MATCH_PHASE,
  MATCH_STATUS,
  SEASON_STATUS,
} from "./constants";
import { BUDGET_FULL_EFFECT_GAP, draftClocks } from "./draft";
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
  playoffFirstRound,
} from "./schedule";
import {
  SEASON_GROUP_KEYS,
  describeSeasonFormat,
  formatSteps,
  formatBracketSize,
  parseFormatConfig,
  plannedSeasonFormat,
  playoffEntrantsPhrase,
  playoffSteps,
  recommendedKnobs,
  resolveSeasonFormat,
  seasonLengthPhrase,
  withBracket,
  type FormatSource,
  type SeasonFormat,
} from "./season-format";
import { formatProblems } from "./season-builder";
import { SCRIM_COLLISION_WINDOW_MS } from "./scrim-schedule-conflict";
import { MATCH_NIGHT_POLL_LABEL } from "./season-copy";
import {
  carriedSeasonSettings,
  type CarriedSeasonSettings,
} from "./season-handoff";
import { STANDIN_CONFLICT_HOURS, STANDIN_MMR_ALLOWANCE } from "./standin";
import { computeStandings } from "./standings";
import {
  teamWithdrawalLockedReason,
  withdrawalForfeitScore,
} from "./team-withdrawal";
import { TIEBREAKER_RULES, TIEBREAKER_SUMMARY } from "./tiebreaker-format";

/**
 * The numbers in the rules admins enforce by hand. No code checks them: an
 * admin rules on a claim (and records any forfeit with `recordResult`).
 */
export const WRITTEN_RULES = {
  /** Minutes before kickoff players are asked to be there. */
  ARRIVE_EARLY_MINUTES: 15,
  /** Minutes past kickoff a team not ready loses game 1. */
  LATE_GAME_FORFEIT_MINUTES: 15,
  /** Minutes past kickoff a team not ready forfeits the series. */
  LATE_SERIES_FORFEIT_MINUTES: 30,
  /** Minutes after a game for the series' next game to start. */
  NEXT_GAME_MINUTES: 15,
  /** Pause minutes each team gets per game. */
  PAUSE_MINUTES_PER_TEAM: 15,
  /** Minimum delay on a player's own stream, in minutes. */
  STREAM_DELAY_MINUTES: 2,
  /** Match nights a player may expect to miss before they shouldn't sign up. */
  MAX_MISSED_NIGHTS: 3,
} as const;

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
  /**
   * An open match-night poll is choosing the night (`pollDecidesMatchNight`
   * for the active season), so the night is quoted as being decided in it
   * instead of `matchNight`. Omitted, no poll is deciding it.
   */
  matchNightPoll?: boolean;
  /** The active season's teams that haven't withdrawn; null when unknown. */
  teamCount: number | null;
  /**
   * The active season's format (`resolveSeasonFormat` over every team,
   * withdrawn ones included). Omitted, the Recommended format for
   * `teamCount` teams.
   */
  format?: SeasonFormat | null;
  /**
   * The active season's regular-season schedule exists, so its format is
   * settled. Omitted, the format reads as a plan the admins can change.
   */
  formatFinal?: boolean;
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
 * Round one's pairings for a bracket of `bracketSize`, from
 * `playoffFirstRound` over seed numbers (or, crossing two groups, over their
 * seed names A1, B1, A2…). Says the higher seed hosts only while every pairing
 * puts it at home, and describes the general pattern only while every pairing
 * is top-against-bottom.
 */
function firstRoundRule(bracketSize: number | null, groups = false): string | null {
  const size = bracketSize ?? 8;
  const seeds = Array.from({ length: size }, (_, i) => String(i + 1));
  const pairings = playoffFirstRound(seeds, size).map((pair) => ({
    home: Number(pair.home),
    away: Number(pair.away),
  }));
  const higherHosts = pairings.every((pair) => pair.home < pair.away);
  const hosts = higherHosts ? "; the higher seed hosts" : "";
  if (groups && bracketSize === 2) {
    // A1 and B1 (seedGroups): group A is seeded first.
    return `The two group winners play the grand final${higherHosts ? ", and Group A's winner hosts" : ""}.`;
  }
  if (groups && bracketSize && bracketSize >= 4) {
    // Seeds alternate between the groups place by place (seedGroups).
    const name = (seed: number) =>
      `${SEASON_GROUP_KEYS[(seed - 1) % 2]}${Math.floor((seed - 1) / 2) + 1}`;
    const listed = pairings.map((pair) => `${name(pair.home)} v ${name(pair.away)}`);
    return `Round one crosses the groups: ${listed.join(", ")}, so the two group winners can only meet in the final${hosts}.`;
  }
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

/**
 * The active season's format for /rules (`resolveSeasonFormat`): its stored
 * format, every team, withdrawn ones included, and whether its regular-season
 * fixtures exist.
 */
export function rulesSeasonFormat(
  season: FormatSource,
  teams: readonly { groupKey: string | null }[],
  fixtures: readonly { phase: string }[],
): SeasonFormat | null {
  const scheduled = regularScheduleMade(fixtures);
  // A saved layout today's captains can't fill isn't a plan yet: say
  // nothing about this season rather than print one that can't be built.
  const stored = parseFormatConfig(season.formatConfig);
  if (
    !scheduled &&
    stored.kind === "CUSTOM" &&
    formatProblems(stored.knobs, teams.length).errors.length > 0
  ) {
    return null;
  }
  return resolveSeasonFormat(season, teams, scheduled);
}

/** The regular-season schedule exists, so the format is settled. */
export function regularScheduleMade(fixtures: readonly { phase: string }[]): boolean {
  return fixtures.some((fixture) => fixture.phase === MATCH_PHASE.REGULAR);
}

/**
 * The season's structure: who chooses it, what the team count makes it
 * unless they choose otherwise (season-format.ts), how groups are drawn, and
 * the reserved tiebreaker week. `format` is the active season's, from its
 * whole field, withdrawn teams included; until its schedule exists
 * (`final`) it is a plan.
 */
function formatSection(format: SeasonFormat | null, final: boolean): RuleSection {
  const rules = [
    `The admins choose each season's format before its schedule is made. Unless they choose otherwise, the number of teams sets it: ${formatSteps()}.`,
    "Groups are drawn when the schedule is made: teams are ranked by their roster's average signup MMR and dealt A, B, B, A, A, B… so both groups get the same spread. An admin can swap one team from each group before the first result.",
    "In a group season each group's table counts only its own matches, and ties are played off inside the group.",
    "The week after the regular season is kept for tiebreakers, so the playoff dates are set the day the schedule is made. If no tie needs it, that week is off.",
  ];
  if (format) {
    const described = describeSeasonFormat(format);
    rules.push(
      `This season has ${plural(format.teamCount, "team")}: ${described.charAt(0).toLowerCase()}${described.slice(1)} That's ${seasonLengthPhrase(format)}.${
        final ? "" : " It's the plan until the schedule is made, so the admins can still change it."
      }`,
    );
  }
  return { id: "format", title: "Season format", rules };
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

function playoffsSection(
  teamCount: number | null,
  format: SeasonFormat | null,
): RuleSection {
  const groups = format?.kind === "GROUPS";
  const size =
    teamCount !== null && teamCount >= 2 && format
      ? formatBracketSize(format, teamCount)
      : null;
  const rules = [
    `The playoffs are a single-elimination bracket. Unless the admins choose otherwise, they take ${playoffSteps()}. Withdrawals shrink the bracket to what the teams left can fill, and a group short of teams hands its spot to the other group's next team.`,
  ];
  if (size !== null && teamCount !== null && format) {
    // "So" only where the team count decided it: Recommended's own cut, or
    // a bracket withdrawals shrank. An admin's chosen cut is just stated.
    const recommended = recommendedKnobs(format.teamCount);
    const byCount =
      recommended !== null &&
      recommended.groups === format.groupSizes.length &&
      recommended.playoffs === format.playoffSpots;
    rules.push(
      groups && size === format.playoffSpots
        ? `This season plays two groups, ${byCount ? "so" : "and"} ${playoffEntrantsPhrase(format)} make the playoffs.`
        : byCount || size < format.playoffSpots
          ? `This season has ${plural(teamCount, "team")} in it, so the top ${size} make the playoffs.`
          : `This season's top ${size} make the playoffs.`,
    );
  }
  const firstRound = firstRoundRule(size, groups);
  if (firstRound) rules.push(firstRound);
  rules.push(
    "Winners stay on their side of the bracket: there is no reseeding.",
    "Round one is played on the match night after the tiebreaker week, and each later round on the next match night once the round before it is done.",
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
      `A signed player can be at most ${STANDIN_MMR_ALLOWANCE.toLocaleString("en-US")} MMR above the player they replace (the latest player released from that team whose seat is still open), or the team's lowest MMR when no released player is waiting to be replaced. When the site doesn't know one of the two MMRs, it counts as over. An admin can sign them over that, and the announcement shows both MMRs.`,
      "Anyone with an active signup who isn't on a roster can stand in: standins and undrafted players alike.",
      "Captains book standins for their own team on the match page, and admins can book for any team. One standin per seat.",
      `A standin can't be booked for two matches within ${plural(STANDIN_CONFLICT_HOURS, "hour")} of each other.`,
      "Cover can be booked from the end of the auction until the series is over, and removed until the series' first game is in.",
      `A standin can be at most ${STANDIN_MMR_ALLOWANCE.toLocaleString("en-US")} MMR above the player they cover, by signup MMR. A captain books a standin within that straight away.`,
      `A standin more than ${STANDIN_MMR_ALLOWANCE.toLocaleString("en-US")} MMR above needs the other captain to agree on the match page. The standin isn't booked until they do, and the seat waits until they answer or the request is withdrawn.`,
      "An empty roster seat counts as covering the team's lowest-MMR player. When the site doesn't know one of the two MMRs, the other captain decides.",
      "If a teammate with a lower MMR has said they can't make the match and has no cover yet, the standin is measured against them instead of the player they cover.",
      "Once a standin is declined for a team, that team's captain can't book or ask for them again for the same match.",
      "Admins can book any standin themselves, and can agree, decline or withdraw a request in a captain's place.",
      "An admin can't agree to a request from a team they captain or that they made themselves.",
    ],
  };
}

function matchNightSection(
  matchNight: string | null,
  poll: boolean,
): RuleSection {
  const fixtures = span(FIXTURE_CONFLICT_WINDOW_MS);
  const scrims = span(SCRIM_COLLISION_WINDOW_MS);
  const clash =
    fixtures === scrims
      ? `within ${fixtures} of either team's other league matches or booked scrims`
      : `within ${fixtures} of either team's other league matches, or ${scrims} of their booked scrims`;
  // While a poll is choosing the night, say so in Home's words rather than
  // quote a time the vote may change.
  const night = poll ? MATCH_NIGHT_POLL_LABEL : matchNight;
  return {
    id: "match-night",
    title: "Match night and rescheduling",
    rules: [
      night
        ? `Match night: ${night}. Kickoff times show in your own time zone.`
        : "Match night is to be announced. Kickoff times show in your own time zone.",
      `Once your match has a kickoff time, answer its check-in (I'm in, or Can't make it) so your captain can find cover. It stays open until ${plural(AUTO_SYNC.WINDOW_HOURS, "hour")} after kickoff.`,
      `Captains move a match with a ready check: either captain offers up to ${MAX_RESCHEDULE_OPTIONS} times on the match page, everyone playing answers each one, and the match moves itself once both captains and a full lineup on each side can make a time. Either captain can lock in a time the other captain said yes to without waiting for everyone.`,
      "After a ready check, each player's answer to the new time becomes their check-in. Admins can also move a match or a whole week; that clears its check-ins, so everyone answers again.",
      `A proposed time can't be more than ${span(RESCHEDULE_PAST_GRACE_MS)} in the past, more than ${span(RESCHEDULE_MAX_AHEAD_MS)} ahead, or ${clash}.`,
      "A regular-season match has to be played before the tiebreaker week, the week ahead of the playoffs.",
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

function matchDaySection(): RuleSection {
  const w = WRITTEN_RULES;
  return {
    id: "match-day",
    title: "Being on time",
    rules: [
      `Be in the lobby at kickoff. Aim to be there ${plural(w.ARRIVE_EARLY_MINUTES, "minute")} early, so there's time to find a standin.`,
      `A team that isn't ready ${plural(w.LATE_GAME_FORFEIT_MINUTES, "minute")} after kickoff loses game 1. At ${plural(w.LATE_SERIES_FORFEIT_MINUTES, "minute")} it forfeits the series.`,
      `If neither team is ready ${plural(w.LATE_SERIES_FORFEIT_MINUTES, "minute")} after kickoff, an admin rules on the series.`,
      "To claim a forfeit, post a screenshot of your full lineup seated in the lobby in the league Discord and tag an admin. Only admins record forfeits.",
      `Each game after the first starts within ${plural(w.NEXT_GAME_MINUTES, "minute")} of the one before it ending.`,
    ],
  };
}

function pausesSection(): RuleSection {
  return {
    id: "pauses",
    title: "Pauses and remakes",
    rules: [
      `Each team gets ${plural(WRITTEN_RULES.PAUSE_MINUTES_PER_TEAM, "minute")} of pause time per game, or more if both teams agree.`,
      "In the hero draft, pause only when a drafter disconnects.",
      "Pausing to reach an admin doesn't count toward your pause time. Pause spam is not allowed.",
      "If a player doesn't make it back in time, the team plays on without them or forfeits the game.",
      "A game can be remade for a major problem if both captains agree, before the first bounty runes. Picking the wrong hero isn't a major problem.",
    ],
  };
}

function fairPlaySection(): RuleSection {
  return {
    id: "fair-play",
    title: "Accounts and fair play",
    rules: [
      "Play on the account you signed up with. Using another account needs an admin's OK, and the other captain must be told before the match.",
      "Keep your Dota match data public, or your games can't import.",
      "No coaches or other outsiders in the game or the hero draft.",
      "No cheating tools and no exploiting bugs.",
      `No stream sniping. If you stream your own game, use at least ${plural(WRITTEN_RULES.STREAM_DELAY_MINUTES, "minute")} of delay.`,
    ],
  };
}

function conductSection(): RuleSection {
  return {
    id: "conduct",
    title: "Conduct and commitment",
    rules: [
      "No hate speech, personal attacks, harassment or doxxing, in games, in the Discord or in inhouses. Report it to an admin in a private message.",
      `Don't sign up if you expect to miss more than about ${plural(WRITTEN_RULES.MAX_MISSED_NIGHTS, "match night")} in the season.`,
      "Leaving your team mid-season without telling the admins can get you banned for the next season.",
    ],
  };
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
  const clocks = draftClocks(s);
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
    `Bids are whole dollars from ${money(DEFAULTS.MIN_BID)}. Each bid resets the clock to ${plural(clocks.bidSeconds, "second")}, or ${plural(clocks.uncontestedBidSeconds, "second")} when no other team can top it.`,
    `A bid must leave ${money(DEFAULTS.MIN_BID)} for each seat still to fill, so every team can finish its roster.`,
    `A captain who doesn't nominate within ${plural(clocks.nominationSeconds, "second")} has the highest-MMR player left nominated for them at ${money(DEFAULTS.MIN_BID)}.`,
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
  matchNightPoll = false,
  teamCount,
  format,
  formatFinal = false,
  config = LEAGUE_CONFIG,
}: LeagueRulesInput): LeagueRules {
  const activeTeams = season?.isActive ? teamCount : null;
  const plannedFormat =
    teamCount !== null ? plannedSeasonFormat({ formatConfig: null }, teamCount) : null;
  const activeFormat = season?.isActive ? (format === undefined ? plannedFormat : format) : null;
  const settings: CarriedSeasonSettings = season ?? carriedSeasonSettings(null);
  // The ticket is the ACTIVE season's (How it works asks the same question);
  // between seasons the next season's ticket isn't known yet.
  const ticket = season?.isActive ? Boolean(season.dotaLeagueId) : null;
  return {
    basis: basisLine(season, config.name),
    defaults: season === null,
    sections: [
      // Withdrawals can shrink the bracket below the format's: the length
      // and rounds printed are the ones Start playoffs will build.
      formatSection(
        activeFormat && activeTeams !== null
          ? withBracket(activeFormat, formatBracketSize(activeFormat, activeTeams))
          : activeFormat,
        formatFinal,
      ),
      seriesSection(settings),
      standingsSection(settings),
      playoffsSection(activeTeams, activeFormat),
      forfeitsSection(settings),
      rostersSection(settings),
      matchNightSection(matchNight, matchNightPoll),
      hostingSection(ticket, config),
      matchDaySection(),
      pausesSection(),
      signupsSection(settings),
      draftSection(settings),
      resultsSection(settings, ticket),
      fairPlaySection(),
      conductSection(),
    ],
    closing: RULES_CLOSING,
  };
}
