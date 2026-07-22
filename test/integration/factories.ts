import { prisma } from "@/lib/prisma";
import {
  DEFAULTS,
  DRAFT_STATUS,
  MATCH_PHASE,
  MATCH_STATUS,
  SEASON_STATUS,
} from "@/lib/constants";
import { roundRobin } from "@/lib/schedule";
import type { SessionUser } from "@/lib/auth";

// draft-service / playoff-service are imported LAZILY inside the helpers that
// need them: this file is loaded by the setup file (resetDb) BEFORE a test
// file's vi.mock registrations apply, so a static import here would bake the
// real "@/lib/discord" into those services' graphs and silently defeat any
// test that mocks the Discord sender to assert announcements.

/** Wipe every table (children first) so each test starts from empty. */
export async function resetDb() {
  await prisma.inhouseLobbyPlayer.deleteMany();
  await prisma.inhouseLobby.deleteMany();
  await prisma.inhouseQueueEntry.deleteMany();
  await prisma.game.deleteMany();
  await prisma.standinAssignment.deleteMany();
  await prisma.bid.deleteMany();
  await prisma.teamMember.deleteMany();
  await prisma.match.deleteMany();
  await prisma.draft.deleteMany();
  await prisma.team.deleteMany();
  await prisma.registration.deleteMany();
  await prisma.season.deleteMany();
  await prisma.user.deleteMany();
  // Relationless key-value store (webhook, league id, honors markers, session
  // epoch) — reset it too so tests are fully isolated.
  await prisma.setting.deleteMany();
}

let seq = 0;
function uniqueSteamId(): string {
  seq += 1;
  // Above the SteamID64 base so it maps to a real 32-bit account id.
  return (BigInt("76561197960265728") + BigInt(seq)).toString();
}

export async function makeUser(name: string, role = "USER") {
  return prisma.user.create({ data: { steamId: uniqueSteamId(), name, role } });
}

export function sessionFor(user: {
  id: string;
  steamId: string;
  name: string;
  role: string;
}): SessionUser {
  return {
    id: user.id,
    steamId: user.steamId,
    name: user.name,
    avatar: null,
    role: user.role,
  };
}

type SeasonOverrides = Partial<{
  name: string;
  teamSize: number;
  minTeams: number;
  draftBudget: number;
  maxMmr: number;
  status: string;
  isActive: boolean;
  regularBestOf: number;
  playoffBestOf: number;
  finalBestOf: number;
}>;

export async function makeSeason(overrides: SeasonOverrides = {}) {
  return prisma.season.create({
    data: {
      name: "Test Season",
      teamSize: 3,
      minTeams: 2,
      draftBudget: 100,
      maxMmr: 0,
      status: SEASON_STATUS.SIGNUPS,
      isActive: true,
      ...overrides,
    },
  });
}

export async function makePlayer(
  seasonId: string,
  name: string,
  mmr: number,
  extra: { wantsCaptain?: boolean; roles?: string } = {},
) {
  const user = await makeUser(name);
  await prisma.registration.create({
    data: {
      seasonId,
      userId: user.id,
      type: "PLAYER",
      status: "ACTIVE",
      mmr,
      wantsCaptain: extra.wantsCaptain ?? false,
      roles: extra.roles ?? "",
    },
  });
  return user;
}

/** Register a player AND make them a captain (creates their team + roster slot). */
export async function makeCaptain(
  seasonId: string,
  name: string,
  budget: number,
  draftOrder: number,
) {
  const user = await makePlayer(seasonId, name, 3000, { wantsCaptain: true });
  const team = await prisma.team.create({
    data: { seasonId, name: `${name}'s Team`, captainId: user.id, budget, draftOrder },
  });
  await prisma.teamMember.create({
    data: { seasonId, teamId: team.id, userId: user.id, isCaptain: true, price: 0 },
  });
  return { user, team };
}

/** Replicate the non-auth part of the startDraft admin action. */
export async function startDraftState(seasonId: string) {
  const teams = await prisma.team.findMany({
    where: { seasonId },
    orderBy: { draftOrder: "asc" },
  });
  await prisma.season.update({
    where: { id: seasonId },
    data: { status: SEASON_STATUS.DRAFT },
  });
  await prisma.draft.create({
    data: {
      seasonId,
      status: DRAFT_STATUS.IN_PROGRESS,
      nominatorTeamId: teams[0]?.id ?? null,
      nominationIndex: 0,
      nominationEndsAt: new Date(
        Date.now() + DEFAULTS.NOMINATION_TIMER_SECONDS * 1000,
      ),
    },
  });
}

/** Force the auction (bid) clock into the past so resolveExpiredNomination fires. */
export async function expireClock(seasonId: string) {
  await prisma.draft.update({
    where: { seasonId },
    data: { bidEndsAt: new Date(Date.now() - 1000) },
  });
}

/** Force the nomination clock into the past so resolveStalledNomination fires. */
export async function expireNominationClock(seasonId: string) {
  await prisma.draft.update({
    where: { seasonId },
    data: { nominationEndsAt: new Date(Date.now() - 1000) },
  });
}

/** A team with a captain user but no drafted roster (enough for standings/playoffs). */
export async function makeTeam(
  seasonId: string,
  name: string,
  draftOrder: number,
  budget = 100,
) {
  const captain = await makeUser(`${name} Captain`);
  return prisma.team.create({
    data: { seasonId, name, captainId: captain.id, budget, draftOrder },
  });
}

/** Generate a regular-season round-robin, like the generateSchedule action. */
export async function generateRegularSchedule(seasonId: string) {
  const [season, teams] = await Promise.all([
    prisma.season.findUniqueOrThrow({ where: { id: seasonId } }),
    prisma.team.findMany({ where: { seasonId }, orderBy: { draftOrder: "asc" } }),
  ]);
  const rounds = roundRobin(teams.map((t) => t.id));
  const rows = rounds.flatMap((round, i) =>
    round.map((p) => ({
      seasonId,
      week: i + 1,
      phase: MATCH_PHASE.REGULAR,
      homeTeamId: p.home,
      awayTeamId: p.away,
      bestOf: season.regularBestOf,
    })),
  );
  await prisma.match.createMany({ data: rows });
  return prisma.match.findMany({ where: { seasonId }, orderBy: { week: "asc" } });
}

/** Auto-run the auction: the team on the clock nominates the top available
 *  player at the minimum bid, unopposed, until every roster is full. */
export async function runDraftToCompletion(seasonId: string) {
  const { getDraftState, nominatePlayer, resolveExpiredNomination } =
    await import("@/lib/draft-service");
  for (let step = 0; step < 500; step++) {
    const state = await getDraftState(seasonId, null);
    if (!state || state.status === DRAFT_STATUS.COMPLETE) return;
    const nominatorTeamId = state.nominatorTeamId;
    const pick = state.available[0];
    if (!nominatorTeamId || !pick) return;
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: nominatorTeamId },
      include: { captain: true },
    });
    await nominatePlayer(seasonId, sessionFor(team.captain), pick.userId, state.minBid);
    await expireClock(seasonId);
    await resolveExpiredNomination(seasonId);
  }
  throw new Error("draft did not complete within the step budget");
}

/** Record a match result the way the recordResult action does. */
export async function recordMatch(
  matchId: string,
  homeScore: number,
  awayScore: number,
) {
  const m = await prisma.match.findUniqueOrThrow({ where: { id: matchId } });
  const winnerTeamId =
    homeScore > awayScore
      ? m.homeTeamId
      : awayScore > homeScore
        ? m.awayTeamId
        : null;
  await prisma.match.update({
    where: { id: matchId },
    data: {
      homeScore,
      awayScore,
      winnerTeamId,
      status: MATCH_STATUS.COMPLETED,
    },
  });
  return winnerTeamId;
}

/** Attach a single imported Game (won by winnerTeamId) to a match. */
export async function addGameToMatch(
  matchId: string,
  dotaMatchId: string,
  winnerTeamId: string,
) {
  return prisma.game.create({
    data: { matchId, dotaMatchId, radiantWin: true, winnerTeamId, players: "[]" },
  });
}

/** Play out every playoff round (home team wins) until a champion is crowned. */
export async function drivePlayoffsToChampion(seasonId: string) {
  const { advancePlayoffBracket } = await import("@/lib/playoff-service");
  for (let guard = 0; guard < 20; guard++) {
    const season = await prisma.season.findUniqueOrThrow({
      where: { id: seasonId },
    });
    if (season.status === SEASON_STATUS.COMPLETE) return season;
    const open = await prisma.match.findMany({
      where: {
        seasonId,
        phase: { in: [MATCH_PHASE.PLAYOFF, MATCH_PHASE.FINAL] },
        status: { not: MATCH_STATUS.COMPLETED },
      },
    });
    if (open.length === 0) break;
    for (const m of open) {
      await recordMatch(m.id, 2, 0);
      await advancePlayoffBracket(seasonId);
    }
  }
  return prisma.season.findUniqueOrThrow({ where: { id: seasonId } });
}
