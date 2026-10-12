import type { Season } from "@prisma/client";
import { prisma } from "./prisma";
import { getActiveSeason } from "./season";
import { capacityInfo } from "./capacity";
import { LEAGUE_CONFIG } from "./league-config";
import { resolveSiteUrl } from "./site-url";
import {
  DRAFT_STATUS,
  MATCH_PHASE,
  MATCH_STATUS,
  REGISTRATION_STATUS,
  REGISTRATION_TYPE,
  SEASON_STATUS,
} from "./constants";
import { announcedMatchNight } from "./match-night";
import { loadHomePoll } from "./match-night-poll-service";
import { POLL_ANCHOR } from "./match-night-poll";
import {
  MATCH_LIST_ORDER,
  byKickoff,
  byeTeamsByWeek,
  isRelevantOpenMatch,
  matchNightForWeek,
  nextPlayoffRoundName,
  playoffTotalRounds,
  roundName,
  slotIndex,
  slotRound,
} from "./schedule";
import { leagueProgress } from "./league-progress";
import { projectPlayoffField } from "./playoff-field";
import { getSeasonHonorReadiness } from "./honors-readiness-service";
import { HONOR_WEEK_STATE } from "./honors-readiness";
import { weeklyHonors } from "./honors";
import { heroById, heroPortrait } from "./heroes";
import { parseRescheduleOptions } from "./reschedule-ready-check";
import { resolveChampionPresentation } from "./champion-presentation";
import { championFinalLine } from "./champion-moment";
import { getDefendingChampion } from "./official-champion";
import { readInhouseNight } from "./inhouse-night-service";
import { inhouseNightPhase } from "./inhouse-night";
import { inhouseNightInviteLink, joinLink } from "./discord";
import { getLeagueStream } from "./queries";
import { getSetting, SETTING_KEYS } from "./settings";
import { parseNextSeasonPlan } from "./next-season";
import { weekWrapPath } from "./week-wrap";
import { draftNightSoon, draftRosterCounts } from "./draft-setup";
import type {
  LeagueStatusSnapshot,
  StatusDraft,
  StatusFixture,
  StatusHighlights,
  StatusInhouseNight,
  StatusMatchNight,
  StatusPlayoffs,
  StatusReschedule,
  StatusStandin,
  StatusChampion,
  StatusTable,
  StatusWeek,
} from "./league-status";

// Reads the league into the status card's snapshot (league-status.ts renders
// it). Every number comes from the helper the site already prints it with, so
// the card can never disagree with Home: capacityInfo for the team goal,
// leagueProgress and isRelevantOpenMatch for "this week", projectPlayoffField
// for the table and its cut, the weekly honors readiness for the highlights,
// resolveChampionPresentation for the champion.
//
// READ-ONLY, and cheap enough to run on every repaint check: the service
// calls it after admin and player writes and from the worker. In particular it
// never calls getDraftState, which resolves expired draft clocks (a write),
// and it reads box scores for one finished week at a time, never the season.
//
// Nothing here depends on the wall clock beyond WHICH facts are current (the
// week in focus, whether the inhouse night is on). Times go out as absolute
// timestamps, so an unchanged league renders an unchanged card.

const MATCH_SELECT = {
  id: true,
  week: true,
  phase: true,
  status: true,
  homeTeamId: true,
  awayTeamId: true,
  scheduledAt: true,
  homeScore: true,
  awayScore: true,
  bestOf: true,
  winnerTeamId: true,
  bracketSlot: true,
  forfeit: true,
  createdAt: true,
} as const;

const TEAM_SELECT = {
  id: true,
  name: true,
  logoUrl: true,
  captainId: true,
  withdrawn: true,
  members: {
    select: {
      userId: true,
      isCaptain: true,
      price: true,
      user: { select: { name: true } },
    },
  },
} as const;

type CardMatch = Awaited<
  ReturnType<typeof prisma.match.findMany<{ select: typeof MATCH_SELECT }>>
>[number];
type CardTeam = Awaited<
  ReturnType<typeof prisma.team.findMany<{ select: typeof TEAM_SELECT }>>
>[number];

const WEEK_PHASES: readonly string[] = [MATCH_PHASE.REGULAR, MATCH_PHASE.TIEBREAKER];
const BRACKET_PHASES: readonly string[] = [MATCH_PHASE.PLAYOFF, MATCH_PHASE.FINAL];
/** Finished weeks tried for highlights before giving up (a forfeit-only week
 *  or one still waiting on box scores has none). */
const HIGHLIGHT_WEEKS_TRIED = 3;

/** Read the league into a status card snapshot. */
export async function loadLeagueStatusSnapshot(
  nowMs: number = Date.now(),
): Promise<LeagueStatusSnapshot> {
  const siteUrl = resolveSiteUrl();
  const [season, inhouseNight] = await Promise.all([
    getActiveSeason(),
    loadInhouseNight(nowMs),
  ]);
  const base: LeagueStatusSnapshot = {
    leagueName: LEAGUE_CONFIG.name,
    siteUrl,
    logoUrl: `${siteUrl}${LEAGUE_CONFIG.branding.logo}`,
    phase: "OFFSEASON",
    seasonName: season?.name ?? null,
    signups: null,
    matchNight: { kind: "unset" },
    draft: null,
    week: null,
    table: null,
    highlights: null,
    playoffs: null,
    champion: null,
    lastChampion: null,
    nextSignupsAtMs: null,
    inhouseNight,
    urls: {
      signUp: `${siteUrl}/me`,
      howItWorks: `${siteUrl}/how-it-works`,
      draft: `${siteUrl}/draft`,
      players: `${siteUrl}/players`,
      teams: `${siteUrl}/teams`,
      schedule: `${siteUrl}/schedule`,
      hallOfFame: `${siteUrl}/hall-of-fame`,
      inhouse: `${siteUrl}/inhouse`,
    },
  };

  if (!season) {
    const [matchNight, champion] = await Promise.all([
      loadMatchNight(null, [], nowMs, siteUrl),
      getDefendingChampion(null),
    ]);
    return {
      ...base,
      matchNight,
      lastChampion: champion
        ? { team: champion.teamName, seasonName: champion.seasonName }
        : null,
    };
  }

  const [matches, teams] = await Promise.all([
    prisma.match.findMany({
      where: { seasonId: season.id },
      select: MATCH_SELECT,
      orderBy: MATCH_LIST_ORDER,
    }),
    prisma.team.findMany({
      where: { seasonId: season.id },
      select: TEAM_SELECT,
      orderBy: [{ draftOrder: "asc" }, { id: "asc" }],
    }),
  ]);
  const withSeason: LeagueStatusSnapshot = {
    ...base,
    matchNight: await loadMatchNight(season, matches, nowMs, siteUrl),
  };

  switch (season.status) {
    case SEASON_STATUS.SIGNUPS:
      return {
        ...withSeason,
        phase: "SIGNUPS",
        ...(await loadSignups(season, teams, nowMs)),
      };
    case SEASON_STATUS.DRAFT:
      return {
        ...withSeason,
        phase: "DRAFT",
        draft: await loadDraft(season, teams, matches),
      };
    case SEASON_STATUS.REGULAR_SEASON:
      return {
        ...withSeason,
        phase: "REGULAR_SEASON",
        ...(await loadRegularSeason(season, teams, matches, nowMs, siteUrl)),
      };
    case SEASON_STATUS.PLAYOFFS:
      return {
        ...withSeason,
        phase: "PLAYOFFS",
        playoffs: await loadPlayoffs(season, teams, matches, nowMs, siteUrl),
      };
    case SEASON_STATUS.COMPLETE:
      return {
        ...withSeason,
        phase: "COMPLETE",
        ...(await loadComplete(season, teams, matches, siteUrl)),
      };
    default:
      return withSeason;
  }
}

// --- Shared ------------------------------------------------------------------

/**
 * An open match-night poll's turnout, else the season's night as every page
 * prints it (announcedMatchNight). The poll's count never leaves here: the
 * view is built for no viewer, so `results` is null while voting is open.
 */
async function loadMatchNight(
  season: Season | null,
  matches: readonly CardMatch[],
  nowMs: number,
  siteUrl: string,
): Promise<StatusMatchNight> {
  const open = await prisma.matchNightPoll.findFirst({
    where: { closesAt: { gt: new Date(nowMs) } },
    select: { id: true },
  });
  if (open) {
    const view = await loadHomePoll(null, nowMs);
    if (view?.open) {
      return {
        kind: "poll",
        voted: view.ballots,
        eligible: view.electorate?.size ?? 0,
        closesAtMs: view.closesAt,
        voteUrl: `${siteUrl}/#${POLL_ANCHOR}`,
      };
    }
  }
  const label = announcedMatchNight(season, matches);
  return label ? { kind: "set", label } : { kind: "unset" };
}

/** The planned inhouse night until it's over (the window Home shows). */
async function loadInhouseNight(nowMs: number): Promise<StatusInhouseNight | null> {
  const { night } = await readInhouseNight();
  if (!night) return null;
  const phase = inhouseNightPhase(night, nowMs);
  if (phase === "over") return null;
  return {
    startsAtMs: night.startsAtMs,
    state: phase === "on" ? "ON" : "UPCOMING",
    note: night.note,
    inviteUrl: inhouseNightInviteLink(),
    joinUrl: joinLink(),
  };
}

/** A stored logo as a URL Discord can show: absolute, and never an SVG,
 *  which a Discord thumbnail doesn't render. */
function imageUrl(siteUrl: string, raw: string | null | undefined): string | null {
  if (!raw) return null;
  const url = raw.startsWith("/") && !raw.startsWith("//") ? `${siteUrl}${raw}` : raw;
  if (!/^https?:\/\//i.test(url)) return null;
  if (/\.svg($|[?#])/i.test(url)) return null;
  return url;
}

/** "the semifinals", "Round 3": a round name mid-sentence. */
function roundPhrase(round: string): string {
  return /^Round \d+$/.test(round) ? round : `the ${round.toLowerCase()}`;
}

type MatchNotes = {
  standins: Map<string, StatusStandin[]>;
  reschedules: Map<string, StatusReschedule>;
};

/**
 * Standin bookings and waiting reschedule offers for the fixtures still to
 * play. A booking that covers somebody no longer on the roster is skipped
 * (matchNightRoster's rule), and an offer whose every time has passed is
 * dead weight nobody can accept any more.
 */
async function loadMatchNotes(
  open: readonly CardMatch[],
  teams: readonly CardTeam[],
  nowMs: number,
): Promise<MatchNotes> {
  const notes: MatchNotes = { standins: new Map(), reschedules: new Map() };
  if (open.length === 0) return notes;
  const ids = open.map((m) => m.id);
  const [standins, offers] = await Promise.all([
    prisma.standinAssignment.findMany({
      where: { matchId: { in: ids } },
      select: {
        matchId: true,
        teamId: true,
        replacingUserId: true,
        standin: { select: { name: true } },
        replaced: { select: { name: true } },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    prisma.rescheduleRequest.findMany({
      where: { matchId: { in: ids }, status: "PENDING" },
      select: {
        matchId: true,
        proposedById: true,
        proposedTime: true,
        options: true,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
  ]);
  const byId = new Map(teams.map((t) => [t.id, t]));
  const nameOf = (teamId: string) => byId.get(teamId)?.name ?? "";
  for (const row of standins) {
    const roster = byId.get(row.teamId)?.members ?? [];
    if (
      row.replacingUserId &&
      !roster.some((m) => m.userId === row.replacingUserId)
    ) {
      continue;
    }
    const list = notes.standins.get(row.matchId) ?? [];
    list.push({
      standin: row.standin.name,
      replaced: row.replaced?.name ?? null,
      team: nameOf(row.teamId),
    });
    notes.standins.set(row.matchId, list);
  }
  const matchOf = new Map(open.map((m) => [m.id, m]));
  for (const offer of offers) {
    // Newest first: one open offer per fixture is the rule, and if a stale
    // row survives the newest is the one that counts.
    if (notes.reschedules.has(offer.matchId)) continue;
    const match = matchOf.get(offer.matchId);
    if (!match) continue;
    const times = parseRescheduleOptions(offer.options, offer.proposedTime);
    const live = times.filter((t) => t > nowMs).length;
    if (live === 0) continue;
    // The proposer is one of the two captains (proposeReschedule asserts
    // it), so the other side owes the answer.
    const home = byId.get(match.homeTeamId);
    const away = byId.get(match.awayTeamId);
    const fromHome = home?.captainId === offer.proposedById;
    if (!fromHome && away?.captainId !== offer.proposedById) continue;
    notes.reschedules.set(offer.matchId, {
      proposer: nameOf(fromHome ? match.homeTeamId : match.awayTeamId),
      waitingOn: nameOf(fromHome ? match.awayTeamId : match.homeTeamId),
      options: live,
    });
  }
  return notes;
}

function fixtureOf(
  match: CardMatch,
  teamName: ReadonlyMap<string, string>,
  notes: MatchNotes,
  opts: { weekNightMs?: number | null; outcome?: string | null } = {},
): StatusFixture {
  const final = match.status === MATCH_STATUS.COMPLETED;
  const live =
    !final &&
    (match.status === MATCH_STATUS.LIVE || match.homeScore + match.awayScore > 0);
  const atMs = match.scheduledAt?.getTime() ?? null;
  return {
    home: teamName.get(match.homeTeamId) ?? "",
    away: teamName.get(match.awayTeamId) ?? "",
    homeScore: match.homeScore,
    awayScore: match.awayScore,
    state: final ? "FINAL" : live ? "LIVE" : "UPCOMING",
    winner: !final
      ? null
      : match.winnerTeamId === match.homeTeamId
        ? "HOME"
        : match.winnerTeamId === match.awayTeamId
          ? "AWAY"
          : null,
    forfeit: match.forfeit,
    atMs,
    moved:
      atMs !== null &&
      opts.weekNightMs !== undefined &&
      opts.weekNightMs !== null &&
      atMs !== opts.weekNightMs,
    bestOf: match.bestOf,
    standins: final ? [] : (notes.standins.get(match.id) ?? []),
    reschedule: final ? null : (notes.reschedules.get(match.id) ?? null),
    outcome: opts.outcome ?? null,
  };
}

// --- Signups and the draft -------------------------------------------------------

async function loadSignups(
  season: Season,
  teams: readonly CardTeam[],
  nowMs: number,
): Promise<Pick<LeagueStatusSnapshot, "signups" | "draft">> {
  const [players, standins] = await Promise.all([
    prisma.registration.findMany({
      where: {
        seasonId: season.id,
        status: REGISTRATION_STATUS.ACTIVE,
        type: REGISTRATION_TYPE.PLAYER,
      },
      select: { userId: true, wantsCaptain: true },
    }),
    prisma.registration.count({
      where: {
        seasonId: season.id,
        status: REGISTRATION_STATUS.ACTIVE,
        type: REGISTRATION_TYPE.STANDIN,
      },
    }),
  ]);
  const capacity = capacityInfo(season, players.length);
  // Home's count (signups-view.tsx WhoIsIn): volunteers plus the captains an
  // admin already named, each person once.
  const captainVolunteers = new Set([
    ...players.filter((p) => p.wantsCaptain).map((p) => p.userId),
    ...teams.map((t) => t.captainId),
  ]).size;
  const draftAtMs = season.draftAt?.getTime() ?? null;
  return {
    signups: {
      players: players.length,
      standins,
      captainVolunteers,
      minTeams: season.minTeams,
      teamsFormable: capacity.teamsFormable,
      needed: capacity.needed,
      toNextTeam: capacity.toNextTeam,
      teamsNeeded: Math.max(season.minTeams, capacity.teamsFormable),
    },
    draft: {
      state: "NOT_STARTED",
      atMs: draftAtMs,
      soon: draftNightSoon(season.status, draftAtMs, nowMs),
      captains: teams.length,
      pool: draftRosterCounts(teams, players).poolCount,
      sold: 0,
      startedAtMs: null,
      teams: [],
      seasonStartsAtMs: null,
    },
  };
}

async function loadDraft(
  season: Season,
  teams: readonly CardTeam[],
  matches: readonly CardMatch[],
): Promise<StatusDraft> {
  const [draft, players] = await Promise.all([
    prisma.draft.findUnique({
      where: { seasonId: season.id },
      select: { status: true, activeRun: { select: { startedAt: true } } },
    }),
    prisma.registration.findMany({
      where: {
        seasonId: season.id,
        status: REGISTRATION_STATUS.ACTIVE,
        type: REGISTRATION_TYPE.PLAYER,
      },
      select: { userId: true },
    }),
  ]);
  const state: StatusDraft["state"] =
    draft?.status === DRAFT_STATUS.IN_PROGRESS
      ? "LIVE"
      : draft?.status === DRAFT_STATUS.PAUSED
        ? "PAUSED"
        : draft?.status === DRAFT_STATUS.COMPLETE
          ? "COMPLETE"
          : "NOT_STARTED";
  const active = teams.filter((t) => !t.withdrawn);
  const counts = draftRosterCounts(teams, players);
  // Once it runs, the bar fills toward the seats the draft fills, not the
  // whole pool: leftover signups are never sold, and a bar that can't reach
  // the end reads as a draft that stopped early.
  const seats = active.length * Math.max(0, season.teamSize - 1);
  const pool =
    state === "NOT_STARTED"
      ? counts.poolCount
      : Math.min(seats, counts.boughtCount + counts.poolCount);
  const kickoffs = matches
    .filter((m) => m.phase === MATCH_PHASE.REGULAR && m.scheduledAt)
    .map((m) => m.scheduledAt!.getTime());
  return {
    state,
    atMs: season.draftAt?.getTime() ?? null,
    soon: false,
    captains: active.length,
    pool,
    sold: counts.boughtCount,
    startedAtMs: draft?.activeRun?.startedAt?.getTime() ?? null,
    teams: state === "COMPLETE" ? active.map((t) => t.name) : [],
    seasonStartsAtMs: kickoffs.length > 0 ? Math.min(...kickoffs) : null,
  };
}

// --- The regular season ----------------------------------------------------------

/**
 * The night a week is played: the planned one (week 1's night plus whole
 * weeks on the league's clock) while any fixture is on it, else the time
 * most of the week's fixtures share, for a week an admin moved as a whole.
 * A fixture off that night is a moved one.
 */
function weekNightMs(
  season: Season,
  week: number,
  fixtures: readonly CardMatch[],
): number | null {
  const planned = season.firstMatchNight
    ? matchNightForWeek(season.firstMatchNight, week).getTime()
    : null;
  const times = fixtures.flatMap((m) =>
    m.scheduledAt ? [m.scheduledAt.getTime()] : [],
  );
  if (times.length === 0) return planned;
  if (planned !== null && times.includes(planned)) return planned;
  const counts = new Map<number, number>();
  for (const t of times) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
}

async function loadRegularSeason(
  season: Season,
  teams: readonly CardTeam[],
  matches: readonly CardMatch[],
  nowMs: number,
  siteUrl: string,
): Promise<Pick<LeagueStatusSnapshot, "week" | "table" | "highlights">> {
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const weekRows = matches.filter((m) => WEEK_PHASES.includes(m.phase));
  const open = weekRows.filter((m) => m.status !== MATCH_STATUS.COMPLETED);
  // The week Home and /schedule call current (focusSlate): the earliest one
  // with an unplayed fixture still in its window. A week whose fixtures are
  // all past it is results debt; it is the focus only when nothing later is.
  const current = open.filter((m) => isRelevantOpenMatch(m, nowMs));
  const focus =
    current.length > 0
      ? Math.min(...current.map((m) => m.week))
      : open.length > 0
        ? Math.min(...open.map((m) => m.week))
        : null;

  let week: StatusWeek | null = null;
  if (focus !== null) {
    const fixtures = weekRows.filter((m) => m.week === focus).sort(byKickoff);
    const tiebreaker = fixtures.every((m) => m.phase === MATCH_PHASE.TIEBREAKER);
    const night = weekNightMs(season, focus, fixtures);
    const notes = await loadMatchNotes(
      fixtures.filter((m) => m.status !== MATCH_STATUS.COMPLETED),
      teams,
      nowMs,
    );
    const progress = leagueProgress([...matches], nowMs);
    const playing = teams.filter((t) => !t.withdrawn).map((t) => t.id);
    week = {
      label: tiebreaker
        ? "Tiebreaker week"
        : `Week ${focus} of ${progress.totalWeeks}`,
      matchNightAtMs: night,
      fixtures: fixtures.map((m) =>
        fixtureOf(m, teamName, notes, { weekNightMs: night }),
      ),
      byes: tiebreaker
        ? []
        : (byeTeamsByWeek([...matches], playing).get(focus) ?? []).map(
            (id) => teamName.get(id) ?? "",
          ),
    };
  }

  const field = projectPlayoffField(
    teams.map((t) => ({ id: t.id, withdrawn: t.withdrawn })),
    [...matches],
  );
  const table: StatusTable = {
    rows: field.standings.map((row, i) => ({
      pos: i + 1,
      team: teamName.get(row.teamId) ?? "",
      points: row.points,
    })),
    playoffSpots: field.bracketSize > 0 ? field.bracketSize : null,
  };

  return {
    week,
    table,
    highlights: await loadHighlights(season, teams, matches, siteUrl),
  };
}

/**
 * The latest week's honors as Home shows them (WeeklyHonorsLine): the newest
 * READY week that has games. Only weeks whose every fixture is final can be
 * READY, so those are read one at a time, newest first.
 */
async function loadHighlights(
  season: Season,
  teams: readonly CardTeam[],
  matches: readonly CardMatch[],
  siteUrl: string,
): Promise<StatusHighlights | null> {
  const regular = matches.filter((m) => m.phase === MATCH_PHASE.REGULAR);
  const finished = [...new Set(regular.map((m) => m.week))]
    .filter((w) =>
      regular
        .filter((m) => m.week === w)
        .every((m) => m.status === MATCH_STATUS.COMPLETED),
    )
    .sort((a, b) => b - a)
    .slice(0, HIGHLIGHT_WEEKS_TRIED);
  for (const week of finished) {
    const [row] = await getSeasonHonorReadiness(season.id, week);
    if (!row || row.state !== HONOR_WEEK_STATE.READY || row.games.length === 0) {
      continue;
    }
    const teamOf = new Map(
      teams.flatMap((t) => t.members.map((m) => [m.userId, t.id] as const)),
    );
    const honors = weeklyHonors(row.games, teamOf);
    const player = honors.player
      ? await prisma.user.findUnique({
          where: { id: honors.player.userId },
          select: { name: true },
        })
      : null;
    const hero =
      honors.player?.heroId != null ? heroById(honors.player.heroId) : null;
    const team = honors.team
      ? teams.find((t) => t.id === honors.team!.teamId)
      : undefined;
    if (!player && !team) return null;
    return {
      week,
      player:
        player && honors.player
          ? { name: player.name, points: honors.player.points, hero: hero?.name ?? null }
          : null,
      team: team && honors.team ? { name: team.name, wins: honors.team.gameWins } : null,
      heroImageUrl: player && hero ? heroPortrait(hero) : null,
      recapUrl: `${siteUrl}${weekWrapPath(season.id, week)}`,
    };
  }
  return null;
}

// --- The playoffs ------------------------------------------------------------------

async function loadPlayoffs(
  season: Season,
  teams: readonly CardTeam[],
  matches: readonly CardMatch[],
  nowMs: number,
  siteUrl: string,
): Promise<StatusPlayoffs> {
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const bracketUrl = `${siteUrl}/seasons/${encodeURIComponent(season.id)}#playoffs`;
  const stream = await getLeagueStream();
  const bracket = matches.filter((m) => BRACKET_PHASES.includes(m.phase));
  const total = playoffTotalRounds([...matches]);
  // The earliest round with a series still to finish; once every series is
  // in (the moment before the champion is crowned), the last round played.
  const open = bracket.filter((m) => m.status !== MATCH_STATUS.COMPLETED);
  const round =
    open.length > 0
      ? Math.min(...open.map((m) => slotRound(m.bracketSlot)))
      : Math.max(0, ...bracket.map((m) => slotRound(m.bracketSlot)));
  const inRound = bracket
    .filter((m) => slotRound(m.bracketSlot) === round)
    .sort(
      (a, b) =>
        (slotIndex(a.bracketSlot) ?? 0) - (slotIndex(b.bracketSlot) ?? 0) ||
        a.id.localeCompare(b.id),
    );
  const notes = await loadMatchNotes(
    inRound.filter((m) => m.status !== MATCH_STATUS.COMPLETED),
    teams,
    nowMs,
  );
  const fixtures = inRound.map((m) => {
    const next = nextPlayoffRoundName(m, total);
    const winner = m.winnerTeamId ? teamName.get(m.winnerTeamId) : undefined;
    const outcome =
      m.status === MATCH_STATUS.COMPLETED && winner && next
        ? `${winner} advance to ${roundPhrase(next)}`
        : null;
    return fixtureOf(m, teamName, notes, { outcome });
  });
  const lastWeek = Math.max(0, ...inRound.map((m) => m.week));
  const nextRound =
    total > 0 && round + 1 < total
      ? {
          round: roundName(round + 1, total),
          bestOf: round + 1 === total - 1 ? season.finalBestOf : season.playoffBestOf,
          // Playoff rounds keep counting league weeks (firstMatchNight).
          atMs:
            season.firstMatchNight && lastWeek > 0
              ? matchNightForWeek(season.firstMatchNight, lastWeek + 1).getTime()
              : null,
        }
      : null;
  return {
    round: total > 0 ? roundName(round, total) : "Playoffs",
    fixtures,
    next: nextRound,
    stream: stream ? { platform: stream.platform, url: stream.url } : null,
    bracketUrl,
  };
}

// --- Season complete -----------------------------------------------------------------

async function loadComplete(
  season: Season,
  teams: readonly CardTeam[],
  matches: readonly CardMatch[],
  siteUrl: string,
): Promise<Pick<LeagueStatusSnapshot, "champion" | "nextSignupsAtMs">> {
  const plan = parseNextSeasonPlan(
    await getSetting(SETTING_KEYS.NEXT_SEASON_PLAN),
    season.id,
  );
  const nextSignupsAtMs = plan?.signupsAtMs ?? null;
  const presentation = resolveChampionPresentation(season, [...matches]);
  const team = presentation.championTeamId
    ? teams.find((t) => t.id === presentation.championTeamId)
    : undefined;
  // A title that needs review shows no champion, as Home doesn't.
  if (!team) return { champion: null, nextSignupsAtMs };
  const final = presentation.authoritativeFinalId
    ? matches.find((m) => m.id === presentation.authoritativeFinalId)
    : undefined;
  const line = championFinalLine(final, team.id);
  const opponent = line
    ? teams.find((t) => t.id === line.opponentTeamId)?.name
    : undefined;
  const champion: StatusChampion = {
    team: team.name,
    logoUrl: imageUrl(siteUrl, team.logoUrl),
    final:
      line && opponent !== undefined
        ? { opponent, score: line.score, forfeit: line.forfeit }
        : null,
    roster: [...team.members]
      .sort(
        (a, b) =>
          Number(b.isCaptain) - Number(a.isCaptain) ||
          b.price - a.price ||
          a.user.name.localeCompare(b.user.name),
      )
      .map((m) => ({ name: m.user.name, captain: m.isCaptain })),
    recapUrl: `${siteUrl}/seasons/${encodeURIComponent(season.id)}`,
  };
  return { champion, nextSignupsAtMs };
}
