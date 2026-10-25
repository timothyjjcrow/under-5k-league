/**
 * Waiting standin requests (the standin MMR rule's StandinRequest rows) when
 * the league rules a fixture or tears fixtures down.
 *
 * A no-game forfeit closes its match's PENDING requests in the ruling's own
 * transaction, so "Reopen for import" can't hand the other captain an Agree
 * for a ruled fixture. The teardowns (Generate schedule, Reset playoffs,
 * Return to regular season, the tiebreaker reset, Abort draft) delete their
 * fixtures and the requests go by cascade: each counts the PENDING ones inside
 * its transaction and names them in the toast and the admin log. None of
 * them posts: nobody has to act on a fixture that is gone or ruled.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn(async () => ({
    id: "test-admin",
    name: "Test administrator",
    role: "ADMIN",
    steamId: "76561198000000000",
    avatar: null,
  })),
  requireUser: vi.fn(),
  // logAdminAction resolves its actor from the session; null still writes
  // the row (as "unknown"), which is what these tests read.
  getSessionUser: vi.fn(async () => null),
}));
vi.mock("@/lib/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord")>()),
  getWebhookUrl: vi.fn(async () => ""),
  sendDiscordMessage: vi.fn(async () => true),
}));

import { prisma } from "@/lib/prisma";
import { sendDiscordMessage } from "@/lib/discord";
import {
  approveStandinRequest,
  assignStandinGuarded,
} from "@/lib/standin-service";
import { STANDIN_MMR_ALLOWANCE } from "@/lib/standin";
import {
  generateSchedule,
  recordResult,
  reopenMatch,
  returnToRegularSeasonAction,
  startPlayoffs,
} from "@/app/actions/admin-schedule-results";
import { resetTiebreakerWeek } from "@/app/actions/tiebreakers";
import { abortDraftAction } from "@/app/actions/admin-captains-draft";
import { createPlayoffBracket } from "@/lib/playoff-service";
import { createTiebreakerWeek } from "@/lib/tiebreaker-service";
import { playoffSetupRevision } from "@/lib/playoff-command";
import {
  DRAFT_STATUS,
  MATCH_PHASE,
  SEASON_STATUS,
  STANDIN_REQUEST_STATUS,
} from "@/lib/constants";
import type { ActionResult } from "@/lib/action-result";
import {
  generateRegularSchedule,
  makeCaptain,
  makePlayer,
  makeSeason,
  makeTeam,
  makeUser,
  recordMatch,
  startDraftState,
} from "./factories";

const empty: ActionResult = {};
const fd = (values: Record<string, string>) => {
  const form = new FormData();
  for (const [key, value] of Object.entries(values)) form.set(key, value);
  return form;
};

afterEach(() => {
  vi.mocked(sendDiscordMessage).mockClear();
});

/** The newest admin log summary for one action. */
async function lastLog(action: string): Promise<string> {
  const row = await prisma.adminAction.findFirstOrThrow({
    where: { action },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return row.summary;
}

/** A request row as the ask path files it, in any status. */
let asked = 0;
async function fileRequest(opts: {
  matchId: string;
  teamId: string;
  requestedById: string;
  status?: string;
}) {
  asked += 1;
  const standin = await makeUser(`Asked Standin ${asked}`);
  return prisma.standinRequest.create({
    data: {
      matchId: opts.matchId,
      teamId: opts.teamId,
      standinUserId: standin.id,
      replacingUserId: null,
      requestedById: opts.requestedById,
      standinMmr: 4000,
      baselineMmr: 3200,
      status: opts.status ?? STANDIN_REQUEST_STATUS.PENDING,
      ...(opts.status && opts.status !== STANDIN_REQUEST_STATUS.PENDING
        ? { decidedAt: new Date(), decidedById: opts.requestedById }
        : {}),
    },
  });
}

/** What the playoff and tiebreaker forms post as `expectedRevision`. */
async function revisionOf(seasonId: string) {
  const [season, teams, matches] = await Promise.all([
    prisma.season.findUniqueOrThrow({ where: { id: seasonId } }),
    prisma.team.findMany({ where: { seasonId } }),
    prisma.match.findMany({
      where: { seasonId },
      include: {
        games: { select: { id: true, dotaMatchId: true } },
        availability: { select: { id: true, userId: true, status: true } },
        standins: {
          select: {
            id: true,
            teamId: true,
            standinUserId: true,
            replacingUserId: true,
          },
        },
        predictions: {
          select: { id: true, userId: true, pickedTeamId: true },
        },
        reschedules: {
          select: {
            id: true,
            proposedById: true,
            proposedTime: true,
            status: true,
          },
        },
      },
    }),
  ]);
  return {
    season,
    revision: playoffSetupRevision({ season, teams, matches }),
  };
}

/**
 * Two teams with one rostered player each at 3200, two unrostered standins
 * past the allowance, two unplayed regular fixtures a week apart, and
 * linked captains (so a post that mentions one would show).
 */
async function regularSeasonWithCover() {
  const season = await makeSeason({ status: SEASON_STATUS.REGULAR_SEASON });
  const home = await makeTeam(season.id, "Home", 0);
  const away = await makeTeam(season.id, "Away", 1);
  await prisma.user.update({
    where: { id: home.captainId },
    data: { discordId: "720000000000000001" },
  });
  await prisma.user.update({
    where: { id: away.captainId },
    data: { discordId: "720000000000000002" },
  });
  const rostered = async (teamId: string, name: string) => {
    const user = await makePlayer(season.id, name, 3200);
    await prisma.teamMember.create({
      data: { seasonId: season.id, teamId, userId: user.id, price: 5 },
    });
    return user;
  };
  const homePlayer = await rostered(home.id, "Home Carry");
  const awayPlayer = await rostered(away.id, "Away Mid");
  const standin = async (name: string) => {
    const user = await makeUser(name);
    await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: user.id,
        type: "STANDIN",
        status: "ACTIVE",
        mmr: 3200 + STANDIN_MMR_ALLOWANCE + 1,
      },
    });
    return user;
  };
  const subOne = await standin("Sub One");
  const subTwo = await standin("Sub Two");
  const fixture = (week: number) =>
    prisma.match.create({
      data: {
        seasonId: season.id,
        week,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: home.id,
        awayTeamId: away.id,
        bestOf: 3,
        scheduledAt: new Date(Date.now() + (week - 1) * 7 * 864e5 + 3600_000),
      },
    });
  const weekOne = await fixture(1);
  const weekTwo = await fixture(2);
  return {
    season,
    home,
    away,
    homePlayer,
    awayPlayer,
    subOne,
    subTwo,
    weekOne,
    weekTwo,
  };
}

/** The home captain asks for an over-the-line standin; nothing is booked. */
async function askForCover(
  fx: Awaited<ReturnType<typeof regularSeasonWithCover>>,
  matchId: string,
  standinUserId: string,
) {
  const asked = await assignStandinGuarded({
    matchId,
    standinUserId,
    replacingUserId: fx.homePlayer.id,
    actingCaptainId: fx.home.captainId,
  });
  expect(asked.ok && asked.pending).toBe(true);
  return prisma.standinRequest.findFirstOrThrow({
    where: { matchId, standinUserId },
  });
}

describe("recordResult — a no-game forfeit closes the match's waiting requests", () => {
  it("cancels the pending request, says so, posts nothing, and Reopen doesn't revive it", async () => {
    const fx = await regularSeasonWithCover();
    const waiting = await askForCover(fx, fx.weekOne.id, fx.subOne.id);
    // Elsewhere: a request the away captain already agreed to, next week.
    const agreedAsk = await askForCover(fx, fx.weekTwo.id, fx.subTwo.id);
    const agreed = await approveStandinRequest({
      requestId: agreedAsk.id,
      actingCaptainId: fx.away.captainId,
    });
    expect(agreed.ok).toBe(true);
    const agreedBefore = await prisma.standinRequest.findUniqueOrThrow({
      where: { id: agreedAsk.id },
    });
    vi.mocked(sendDiscordMessage).mockClear();

    const res = await recordResult(
      empty,
      fd({
        matchId: fx.weekOne.id,
        homeScore: "2",
        awayScore: "0",
        forfeit: "on",
      }),
    );

    expect(res?.error).toBeUndefined();
    expect(res?.message).toBe(
      "Result saved · 2–0 (forfeit / ruling) · 1 standin request(s) cancelled",
    );
    expect(await lastLog("recordResult")).toContain(
      "1 standin request(s) cancelled",
    );
    const closed = await prisma.standinRequest.findUniqueOrThrow({
      where: { id: waiting.id },
    });
    expect(closed).toMatchObject({
      status: STANDIN_REQUEST_STATUS.CANCELLED,
      decidedById: "test-admin",
    });
    expect(closed.decidedAt).not.toBeNull();
    // No post: the ruled fixture leaves nobody anything to do, so no
    // send carries a mention of either captain.
    const mentioned = vi
      .mocked(sendDiscordMessage)
      .mock.calls.flatMap(([, mentions]) => mentions?.users ?? []);
    expect(mentioned).not.toContain("720000000000000001");
    expect(mentioned).not.toContain("720000000000000002");
    // The agreed request on next week's fixture is untouched.
    expect(
      await prisma.standinRequest.findUniqueOrThrow({
        where: { id: agreedAsk.id },
      }),
    ).toEqual(agreedBefore);
    expect(
      await prisma.standinAssignment.count({
        where: { matchId: fx.weekTwo.id },
      }),
    ).toBe(1);

    // "Reopen for import" puts the fixture back to SCHEDULED; the request
    // stays closed, so the other captain has nothing to agree to.
    const reopened = await reopenMatch(empty, fd({ matchId: fx.weekOne.id }));
    expect(reopened?.error).toBeUndefined();
    expect(
      (
        await prisma.standinRequest.findUniqueOrThrow({
          where: { id: waiting.id },
        })
      ).status,
    ).toBe(STANDIN_REQUEST_STATUS.CANCELLED);
    const lateAgree = await approveStandinRequest({
      requestId: waiting.id,
      actingCaptainId: fx.away.captainId,
    });
    expect(lateAgree.ok).toBe(false);
    expect(
      await prisma.standinAssignment.count({
        where: { matchId: fx.weekOne.id },
      }),
    ).toBe(0);
  });

  it("a forfeit with no waiting request reads exactly as before", async () => {
    const fx = await regularSeasonWithCover();

    const res = await recordResult(
      empty,
      fd({
        matchId: fx.weekOne.id,
        homeScore: "2",
        awayScore: "0",
        forfeit: "on",
      }),
    );

    expect(res?.error).toBeUndefined();
    expect(res?.message).toBe("Result saved · 2–0 (forfeit / ruling)");
    expect(await lastLog("recordResult")).not.toMatch(/standin request/);
  });
});

describe("fixture teardowns report the waiting standin requests they remove", () => {
  it("Generate schedule counts only the PENDING requests on the replaced fixtures", async () => {
    const fx = await regularSeasonWithCover();
    await askForCover(fx, fx.weekOne.id, fx.subOne.id);
    // Agreed and declined requests are answered already: not counted.
    const agreedAsk = await askForCover(fx, fx.weekTwo.id, fx.subTwo.id);
    expect(
      (
        await approveStandinRequest({
          requestId: agreedAsk.id,
          actingCaptainId: fx.away.captainId,
        })
      ).ok,
    ).toBe(true);
    await fileRequest({
      matchId: fx.weekTwo.id,
      teamId: fx.away.id,
      requestedById: fx.away.captainId,
      status: STANDIN_REQUEST_STATUS.DECLINED,
    });
    vi.mocked(sendDiscordMessage).mockClear();
    const first = new Date(Date.now() + 7 * 864e5);

    const res = await generateSchedule(
      empty,
      fd({
        expectedActiveSeasonId: fx.season.id,
        firstNight: "2026-11-01T20:00",
        firstNightTs: String(first.getTime()),
      }),
    );

    expect(res?.error).toBeUndefined();
    expect(res?.message).toContain("1 standin request(s) cancelled");
    expect(await lastLog("generateSchedule")).toContain(
      "1 standin request(s) cancelled",
    );
    // The old fixtures and every request on them are gone by cascade.
    expect(await prisma.standinRequest.count()).toBe(0);
    // The only post is the booked standin's stand-down; no captain is
    // told about the request.
    const mentioned = vi
      .mocked(sendDiscordMessage)
      .mock.calls.flatMap(([, mentions]) => mentions?.users ?? []);
    expect(mentioned).not.toContain("720000000000000001");
    expect(mentioned).not.toContain("720000000000000002");
  });

  it("Generate schedule with no waiting request says nothing about requests", async () => {
    const fx = await regularSeasonWithCover();
    const first = new Date(Date.now() + 7 * 864e5);

    const res = await generateSchedule(
      empty,
      fd({
        expectedActiveSeasonId: fx.season.id,
        firstNight: "2026-11-01T20:00",
        firstNightTs: String(first.getTime()),
      }),
    );

    expect(res?.error).toBeUndefined();
    expect(res?.message).not.toMatch(/standin request/);
    expect(await lastLog("generateSchedule")).not.toMatch(/standin request/);
  });

  /** Two teams, a played regular season, and a final with a waiting request. */
  async function finalWithRequests() {
    const season = await makeSeason({
      status: SEASON_STATUS.REGULAR_SEASON,
      minTeams: 2,
    });
    const teamA = await makeTeam(season.id, "Team A", 0);
    const teamB = await makeTeam(season.id, "Team B", 1);
    const regular = await generateRegularSchedule(season.id);
    for (const match of regular) {
      await recordMatch(
        match.id,
        match.homeTeamId === teamA.id ? 2 : 0,
        match.homeTeamId === teamA.id ? 0 : 2,
      );
    }
    await createPlayoffBracket(season.id);
    const final = await prisma.match.findFirstOrThrow({
      where: { seasonId: season.id, phase: MATCH_PHASE.FINAL },
    });
    const waiting = await fileRequest({
      matchId: final.id,
      teamId: final.homeTeamId,
      requestedById: teamA.captainId,
    });
    await fileRequest({
      matchId: final.id,
      teamId: final.awayTeamId,
      requestedById: teamB.captainId,
      status: STANDIN_REQUEST_STATUS.DECLINED,
    });
    // Elsewhere: an agreed request on a regular fixture, which survives.
    const kept = await fileRequest({
      matchId: regular[0].id,
      teamId: regular[0].homeTeamId,
      requestedById: teamA.captainId,
      status: STANDIN_REQUEST_STATUS.APPROVED,
    });
    return { season, final, waiting, kept };
  }

  it("Reset playoffs counts the waiting request on the old bracket", async () => {
    const { season, waiting, kept } = await finalWithRequests();
    const { season: fresh, revision } = await revisionOf(season.id);

    const res = await startPlayoffs(
      empty,
      fd({
        expectedActiveSeasonId: season.id,
        expectedSeasonStatus: fresh.status,
        expectedRevision: revision,
        intent: "reset",
      }),
    );

    expect(res?.error).toBeUndefined();
    expect(res?.message).toBe(
      "Playoff bracket reset and reseeded · 1 standin request(s) cancelled",
    );
    expect(await lastLog("startPlayoffs")).toContain(
      "1 standin request(s) cancelled",
    );
    expect(
      await prisma.standinRequest.findUnique({ where: { id: waiting.id } }),
    ).toBeNull();
    expect(
      await prisma.standinRequest.findUniqueOrThrow({ where: { id: kept.id } }),
    ).toMatchObject({ status: STANDIN_REQUEST_STATUS.APPROVED });
  });

  it("Return to regular season counts the waiting request on the withdrawn bracket", async () => {
    const { season, waiting, kept } = await finalWithRequests();
    const { season: fresh, revision } = await revisionOf(season.id);

    const res = await returnToRegularSeasonAction(
      empty,
      fd({
        expectedActiveSeasonId: season.id,
        expectedSeasonStatus: fresh.status,
        expectedRevision: revision,
      }),
    );

    expect(res?.error).toBeUndefined();
    expect(res?.message).toBe(
      "Returned to the regular season — correct the table, then start a fresh playoff bracket · 1 standin request(s) cancelled",
    );
    expect(await lastLog("returnToRegularSeason")).toContain(
      "1 standin request(s) cancelled",
    );
    expect(
      await prisma.standinRequest.findUnique({ where: { id: waiting.id } }),
    ).toBeNull();
    expect(
      await prisma.standinRequest.findUniqueOrThrow({ where: { id: kept.id } }),
    ).toMatchObject({ status: STANDIN_REQUEST_STATUS.APPROVED });
  });

  it("the tiebreaker reset counts the waiting request on its slate", async () => {
    // Five teams with the last two places level: one tiebreaker fixture.
    const season = await makeSeason({ status: SEASON_STATUS.REGULAR_SEASON });
    const teams = [];
    for (let i = 0; i < 5; i++) {
      teams.push(await makeTeam(season.id, `Team ${i}`, i));
    }
    const strength = new Map(teams.map((team, index) => [team.id, index]));
    const regular = await generateRegularSchedule(season.id);
    for (const match of regular) {
      const home = strength.get(match.homeTeamId)!;
      const away = strength.get(match.awayTeamId)!;
      if (Math.min(home, away) === 3) await recordMatch(match.id, 1, 1);
      else await recordMatch(match.id, home < away ? 2 : 0, home < away ? 0 : 2);
    }
    await createTiebreakerWeek(season.id);
    const tiebreaker = await prisma.match.findFirstOrThrow({
      where: { seasonId: season.id, phase: MATCH_PHASE.TIEBREAKER },
    });
    const captainOf = new Map(teams.map((team) => [team.id, team.captainId]));
    const waiting = await fileRequest({
      matchId: tiebreaker.id,
      teamId: tiebreaker.homeTeamId,
      requestedById: captainOf.get(tiebreaker.homeTeamId)!,
    });
    await fileRequest({
      matchId: tiebreaker.id,
      teamId: tiebreaker.awayTeamId,
      requestedById: captainOf.get(tiebreaker.awayTeamId)!,
      status: STANDIN_REQUEST_STATUS.DECLINED,
    });
    const kept = await fileRequest({
      matchId: regular[0].id,
      teamId: regular[0].homeTeamId,
      requestedById: captainOf.get(regular[0].homeTeamId)!,
      status: STANDIN_REQUEST_STATUS.APPROVED,
    });
    const { revision } = await revisionOf(season.id);

    const res = await resetTiebreakerWeek(
      null,
      fd({ seasonId: season.id, expectedRevision: revision }),
    );

    expect(res?.error).toBeUndefined();
    expect(res?.message).toBe(
      "Tiebreaker week reset. 1 standin request(s) cancelled. Review the regular results, then schedule any ties again.",
    );
    expect(await lastLog("resetTiebreakerWeek")).toContain(
      "1 standin request(s) cancelled",
    );
    expect(
      await prisma.standinRequest.findUnique({ where: { id: waiting.id } }),
    ).toBeNull();
    expect(
      await prisma.standinRequest.findUniqueOrThrow({ where: { id: kept.id } }),
    ).toMatchObject({ status: STANDIN_REQUEST_STATUS.APPROVED });
  });

  it("Abort draft counts the waiting requests on the season's fixtures, and no other season's", async () => {
    const season = await makeSeason({
      teamSize: 3,
      minTeams: 6,
      status: SEASON_STATUS.SIGNUPS,
    });
    const a = await makeCaptain(season.id, "Captain A", 100, 0);
    const b = await makeCaptain(season.id, "Captain B", 100, 1);
    await startDraftState(season.id);
    await prisma.draft.update({
      where: { seasonId: season.id },
      data: {
        status: DRAFT_STATUS.COMPLETE,
        nominatedUserId: null,
        bidEndsAt: null,
        nominationEndsAt: null,
      },
    });
    const match = await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 1,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: a.team.id,
        awayTeamId: b.team.id,
        bestOf: 3,
      },
    });
    const waiting = await fileRequest({
      matchId: match.id,
      teamId: a.team.id,
      requestedById: a.user.id,
    });
    await fileRequest({
      matchId: match.id,
      teamId: b.team.id,
      requestedById: b.user.id,
      status: STANDIN_REQUEST_STATUS.DECLINED,
    });
    // An archived season's waiting request is not this abort's to count.
    const older = await makeSeason({
      name: "Older Season",
      isActive: false,
      status: SEASON_STATUS.COMPLETE,
    });
    const olderHome = await makeTeam(older.id, "Old Home", 0);
    const olderAway = await makeTeam(older.id, "Old Away", 1);
    const olderMatch = await prisma.match.create({
      data: {
        seasonId: older.id,
        week: 1,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: olderHome.id,
        awayTeamId: olderAway.id,
      },
    });
    const elsewhere = await fileRequest({
      matchId: olderMatch.id,
      teamId: olderHome.id,
      requestedById: olderHome.captainId,
    });

    const res = await abortDraftAction(
      empty,
      fd({ expectedActiveSeasonId: season.id }),
    );

    expect(res?.error).toBeUndefined();
    expect(res?.message).toContain("1 standin request(s) cancelled");
    expect(await lastLog("abortDraft")).toContain(
      "1 standin request(s) cancelled",
    );
    expect(
      await prisma.standinRequest.findUnique({ where: { id: waiting.id } }),
    ).toBeNull();
    expect(
      await prisma.standinRequest.findUniqueOrThrow({
        where: { id: elsewhere.id },
      }),
    ).toMatchObject({ status: STANDIN_REQUEST_STATUS.PENDING });
  });
});
