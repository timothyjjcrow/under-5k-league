import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  lockInReschedule,
  proposeReschedule,
  respondReschedule,
  voteReschedule,
} from "@/lib/reschedule-service";
import {
  loadReadyCheckViewById,
  loadRecentLock,
} from "@/lib/reschedule-ready-check-service";
import { SCRIM_STATUS, SEASON_STATUS } from "@/lib/constants";
import { makeCaptain, makeSeason, makeUser, raceAll } from "./factories";

// The reschedule ready check: a captain offers up to three times, everyone
// playing the match answers each one, and the match moves when an option has
// both captains and a full lineup each side, or when a captain locks in a
// time the other captain has said yes to. reschedule.itest.ts covers the
// single-time propose / accept / decline contract this builds on.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// RELATIVE to now: a proposal is a future time (see reschedule.itest.ts).
const ORIGINAL_NIGHT = new Date(Date.now() + 2 * DAY);
const T1 = new Date(Date.now() + 3 * DAY);
const T2 = new Date(Date.now() + 4 * DAY);
const T3 = new Date(Date.now() + 5 * DAY);

/** Two rostered sides of three (the test season's teamSize) and a fixture. */
async function setupReadyCheck() {
  const season = await makeSeason({ status: SEASON_STATUS.REGULAR_SEASON });
  const home = await makeCaptain(season.id, "Home Cap", 100, 0);
  const away = await makeCaptain(season.id, "Away Cap", 100, 1);
  const roster = async (teamId: string, prefix: string) => {
    const players = [];
    for (const n of [1, 2]) {
      const user = await makeUser(`${prefix} ${n}`);
      await prisma.teamMember.create({
        data: { seasonId: season.id, teamId, userId: user.id, price: 10 },
      });
      players.push(user);
    }
    return players;
  };
  const homePlayers = await roster(home.team.id, "Home");
  const awayPlayers = await roster(away.team.id, "Away");
  const match = await prisma.match.create({
    data: {
      seasonId: season.id,
      week: 1,
      phase: "REGULAR",
      homeTeamId: home.team.id,
      awayTeamId: away.team.id,
      scheduledAt: ORIGINAL_NIGHT,
    },
  });
  return {
    season,
    match,
    homeCaptain: home.user,
    awayCaptain: away.user,
    homeTeam: home.team,
    awayTeam: away.team,
    homePlayers,
    awayPlayers,
  };
}

async function openRequest(matchId: string) {
  return prisma.rescheduleRequest.findFirstOrThrow({
    where: { matchId, status: "PENDING" },
  });
}

async function kickoff(matchId: string) {
  return (
    await prisma.match.findUniqueOrThrow({ where: { id: matchId } })
  ).scheduledAt?.getTime();
}

describe("reschedule ready check — proposing options", () => {
  it("stores every option ascending, the note, and names who must answer", async () => {
    const s = await setupReadyCheck();
    const proposed = await proposeReschedule(
      s.homeCaptain.id,
      s.match.id,
      [T3, T1, T2],
      { note: "  Two of us have   exams Sunday " },
    );
    expect(proposed.options.map((t) => t.getTime())).toEqual([
      T1.getTime(),
      T2.getTime(),
      T3.getTime(),
    ]);
    // The earliest is the proposedTime every older reader shows.
    expect(proposed.proposedTime.getTime()).toBe(T1.getTime());
    expect(proposed.note).toBe("Two of us have exams Sunday");
    expect(proposed.notifyUserId).toBe(s.awayCaptain.id);
    // Everyone else on both sides answers too; never the proposer, and the
    // other captain is already the addressee.
    expect(new Set(proposed.readyCheckUserIds)).toEqual(
      new Set([...s.homePlayers, ...s.awayPlayers].map((u) => u.id)),
    );
    const request = await openRequest(s.match.id);
    expect(request.proposedTime.getTime()).toBe(T1.getTime());
    expect(JSON.parse(request.options!)).toEqual([
      T1.getTime(),
      T2.getTime(),
      T3.getTime(),
    ]);
    expect(request.note).toBe("Two of us have exams Sunday");
  });

  it("refuses more than three options and an over-long note, writing nothing", async () => {
    const s = await setupReadyCheck();
    await expect(
      proposeReschedule(s.homeCaptain.id, s.match.id, [
        T1,
        T2,
        T3,
        new Date(T3.getTime() + DAY),
      ]),
    ).rejects.toThrow(/at most 3 times/);
    await expect(
      proposeReschedule(s.homeCaptain.id, s.match.id, [T1], {
        note: "x".repeat(141),
      }),
    ).rejects.toThrow(/under 140 characters/);
    expect(
      await prisma.rescheduleRequest.count({ where: { matchId: s.match.id } }),
    ).toBe(0);
  });

  it("names the option a calendar refusal is about", async () => {
    const s = await setupReadyCheck();
    const practice = await makeCaptain(s.season.id, "Practice", 100, 2);
    await prisma.scrim.create({
      data: {
        seasonId: s.season.id,
        hostTeamId: s.homeTeam.id,
        opponentTeamId: practice.team.id,
        createdById: s.homeCaptain.id,
        scheduledAt: T2,
        status: SCRIM_STATUS.SCHEDULED,
      },
    });
    await expect(
      proposeReschedule(s.homeCaptain.id, s.match.id, [T1, T2]),
    ).rejects.toThrow(/: That time is within four hours of the .* scrim on /);
    expect(
      await prisma.rescheduleRequest.count({ where: { matchId: s.match.id } }),
    ).toBe(0);
  });
});

describe("reschedule ready check — answering", () => {
  it("lets each player answer and change their answer per option", async () => {
    const s = await setupReadyCheck();
    await proposeReschedule(s.homeCaptain.id, s.match.id, [T1, T2]);
    const request = await openRequest(s.match.id);
    const [player] = s.awayPlayers;

    await voteReschedule(player.id, request.id, T1, true);
    await voteReschedule(player.id, request.id, T2, false);
    await voteReschedule(player.id, request.id, T1, false);

    const votes = await prisma.rescheduleVote.findMany({
      where: { requestId: request.id, userId: player.id },
      orderBy: { time: "asc" },
    });
    expect(votes.map((v) => [v.time.getTime(), v.ready])).toEqual([
      [T1.getTime(), false],
      [T2.getTime(), false],
    ]);
    // Nothing moved: nobody near a full lineup.
    expect(await kickoff(s.match.id)).toBe(ORIGINAL_NIGHT.getTime());
  });

  it("refuses outsiders, times that aren't options, and closed proposals", async () => {
    const s = await setupReadyCheck();
    await proposeReschedule(s.homeCaptain.id, s.match.id, [T1]);
    const request = await openRequest(s.match.id);
    const outsider = await makeUser("Spectator");

    await expect(
      voteReschedule(outsider.id, request.id, T1, true),
    ).rejects.toThrow(/Only the players and captains in this match/);
    await expect(
      voteReschedule(s.homePlayers[0].id, request.id, T2, true),
    ).rejects.toThrow(/isn't one of the options/);

    await respondReschedule(s.awayCaptain.id, request.id, false);
    await expect(
      voteReschedule(s.homePlayers[0].id, request.id, T1, true),
    ).rejects.toThrow(/no longer open/);
    expect(
      await prisma.rescheduleVote.count({ where: { requestId: request.id } }),
    ).toBe(0);
  });

  it("lets a booked standin answer for the seat, and not the player they cover", async () => {
    const s = await setupReadyCheck();
    const [covered] = s.homePlayers;
    const standin = await makeUser("Standin");
    await prisma.standinAssignment.create({
      data: {
        matchId: s.match.id,
        teamId: s.homeTeam.id,
        standinUserId: standin.id,
        replacingUserId: covered.id,
      },
    });
    await proposeReschedule(s.awayCaptain.id, s.match.id, [T1]);
    const request = await openRequest(s.match.id);

    await voteReschedule(standin.id, request.id, T1, true);
    await expect(
      voteReschedule(covered.id, request.id, T1, true),
    ).rejects.toThrow(/Only the players and captains/);
  });
});

describe("reschedule ready check — locking in", () => {
  it("moves the match the moment everyone's in, and carries the answers over as check-ins", async () => {
    const s = await setupReadyCheck();
    // An answer about the OLD night, which the move must replace.
    await prisma.matchAvailability.create({
      data: { matchId: s.match.id, userId: s.homePlayers[0].id, status: "OUT" },
    });
    await proposeReschedule(s.homeCaptain.id, s.match.id, [T1, T2]);
    const request = await openRequest(s.match.id);

    // The proposer's yes is implied. Everyone else says yes to T2.
    const others = [
      ...s.homePlayers,
      s.awayCaptain,
      ...s.awayPlayers,
    ];
    const outcomes = [];
    for (const user of others) {
      outcomes.push(await voteReschedule(user.id, request.id, T2, true));
    }
    expect(outcomes.slice(0, -1).every((o) => o.locked === null)).toBe(true);
    const last = outcomes.at(-1)!;
    if (!last.locked) throw new Error("expected the last answer to lock");
    expect(last.locked).toMatchObject({
      matchId: s.match.id,
      notifyUserId: s.homeCaptain.id,
      readyCheck: {
        everyoneIn: true,
        ready: 6,
        seats: 6,
        outNames: [],
        awaitingUserIds: [],
        carriedIn: 6,
        carriedOut: 0,
      },
    });
    expect(last.locked.newTime.getTime()).toBe(T2.getTime());

    const match = await prisma.match.findUniqueOrThrow({
      where: { id: s.match.id },
    });
    expect(match.scheduledAt?.getTime()).toBe(T2.getTime());
    expect(match.scheduleRevision).toBe(s.match.scheduleRevision + 1);
    const accepted = await prisma.rescheduleRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    // ACCEPTED records the time that won, not the earliest option.
    expect(accepted.status).toBe("ACCEPTED");
    expect(accepted.proposedTime.getTime()).toBe(T2.getTime());
    // Everyone is checked in for the new night, the old OUT is gone.
    const checkins = await prisma.matchAvailability.findMany({
      where: { matchId: s.match.id },
    });
    expect(checkins).toHaveLength(6);
    expect(
      checkins.every(
        (c) => c.status === "IN" && c.scheduleRevision === match.scheduleRevision,
      ),
    ).toBe(true);
  });

  it("waits for the other captain even when every player is in", async () => {
    const s = await setupReadyCheck();
    await proposeReschedule(s.homeCaptain.id, s.match.id, [T1]);
    const request = await openRequest(s.match.id);
    for (const user of [...s.homePlayers, ...s.awayPlayers]) {
      expect(
        (await voteReschedule(user.id, request.id, T1, true)).locked,
      ).toBeNull();
    }
    expect(await kickoff(s.match.id)).toBe(ORIGINAL_NIGHT.getTime());

    const outcome = await voteReschedule(s.awayCaptain.id, request.id, T1, true);
    expect(outcome.locked?.newTime.getTime()).toBe(T1.getTime());
    expect(await kickoff(s.match.id)).toBe(T1.getTime());
  });

  it("lets the other captain lock a time early, reporting who can't make it and who hasn't answered", async () => {
    const s = await setupReadyCheck();
    await proposeReschedule(s.homeCaptain.id, s.match.id, [T1, T2]);
    const request = await openRequest(s.match.id);
    const [cant, silent] = s.homePlayers;
    await voteReschedule(cant.id, request.id, T1, false);
    await voteReschedule(s.awayPlayers[0].id, request.id, T1, true);

    const locked = await lockInReschedule(s.awayCaptain.id, request.id, T1);

    expect(locked.newTime.getTime()).toBe(T1.getTime());
    expect(locked.readyCheck).toMatchObject({
      everyoneIn: false,
      outNames: [cant.name],
      carriedOut: 1,
    });
    expect(new Set(locked.readyCheck.awaitingUserIds)).toEqual(
      new Set([silent.id, s.awayPlayers[1].id]),
    );
    const match = await prisma.match.findUniqueOrThrow({
      where: { id: s.match.id },
    });
    const statusOf = async (userId: string) =>
      (
        await prisma.matchAvailability.findUnique({
          where: { matchId_userId: { matchId: s.match.id, userId } },
        })
      )?.status;
    expect(match.scheduledAt?.getTime()).toBe(T1.getTime());
    // "Can't" became an OUT check-in, so the standin flow sees it.
    expect(await statusOf(cant.id)).toBe("OUT");
    expect(await statusOf(silent.id)).toBeUndefined();
    // The locker's own yes is recorded and carried.
    expect(await statusOf(s.awayCaptain.id)).toBe("IN");
    expect(await statusOf(s.homeCaptain.id)).toBe("IN");
  });

  it("keeps a locking captain's own ✗: their team can play the time, they can't", async () => {
    const s = await setupReadyCheck();
    await proposeReschedule(s.homeCaptain.id, s.match.id, [T1, T2]);
    const request = await openRequest(s.match.id);
    // The away captain can't make T1 themselves, but their team can (a
    // standin covers), so they accept and lock it in anyway.
    await voteReschedule(s.awayCaptain.id, request.id, T1, false);

    const locked = await lockInReschedule(s.awayCaptain.id, request.id, T1);

    expect(locked.newTime.getTime()).toBe(T1.getTime());
    expect(locked.readyCheck).toMatchObject({ everyoneIn: false, carriedOut: 1 });
    expect(locked.readyCheck.outNames).toEqual([s.awayCaptain.name]);
    const own = await prisma.matchAvailability.findUnique({
      where: { matchId_userId: { matchId: s.match.id, userId: s.awayCaptain.id } },
    });
    // OUT, so "can't make it and has no cover yet" asks for a standin.
    expect(own?.status).toBe("OUT");
    const vote = await prisma.rescheduleVote.findUniqueOrThrow({
      where: {
        requestId_userId_time: { requestId: request.id, userId: s.awayCaptain.id, time: T1 },
      },
    });
    expect(vote.ready).toBe(false);
  });

  it("makes the proposer wait for the other captain's yes before locking", async () => {
    const s = await setupReadyCheck();
    await proposeReschedule(s.homeCaptain.id, s.match.id, [T1, T2]);
    const request = await openRequest(s.match.id);

    await expect(
      lockInReschedule(s.homeCaptain.id, request.id, T2),
    ).rejects.toThrow(/other captain hasn't said yes/);
    await expect(
      lockInReschedule(s.homePlayers[0].id, request.id, T2),
    ).rejects.toThrow(/Only the two captains/);
    expect(await kickoff(s.match.id)).toBe(ORIGINAL_NIGHT.getTime());

    await voteReschedule(s.awayCaptain.id, request.id, T2, true);
    const locked = await lockInReschedule(s.homeCaptain.id, request.id, T2);
    expect(locked.newTime.getTime()).toBe(T2.getTime());
  });

  it("makes the opposing captain's accept name its option when there's a choice", async () => {
    const s = await setupReadyCheck();
    await proposeReschedule(s.homeCaptain.id, s.match.id, [T1, T2]);
    const request = await openRequest(s.match.id);

    await expect(
      respondReschedule(s.awayCaptain.id, request.id, true),
    ).rejects.toThrow(/Pick which time to accept/);
    const outcome = await respondReschedule(s.awayCaptain.id, request.id, true, {
      optionTime: T2,
    });
    expect(outcome.accepted).toBe(true);
    expect(await kickoff(s.match.id)).toBe(T2.getTime());
  });

  it("keeps the answer but doesn't move a match whose time stopped fitting", async () => {
    const s = await setupReadyCheck();
    await proposeReschedule(s.homeCaptain.id, s.match.id, [T1]);
    const request = await openRequest(s.match.id);
    for (const user of [...s.homePlayers, ...s.awayPlayers]) {
      await voteReschedule(user.id, request.id, T1, true);
    }
    // A scrim gets booked on top of the option while it's open.
    const practice = await makeCaptain(s.season.id, "Practice", 100, 2);
    await prisma.scrim.create({
      data: {
        seasonId: s.season.id,
        hostTeamId: s.awayTeam.id,
        opponentTeamId: practice.team.id,
        createdById: s.awayCaptain.id,
        scheduledAt: new Date(T1.getTime() + HOUR),
        status: SCRIM_STATUS.SCHEDULED,
      },
    });

    const outcome = await voteReschedule(s.awayCaptain.id, request.id, T1, true);
    expect(outcome.locked).toBeNull();
    if (outcome.locked) throw new Error("expected no lock");
    expect(outcome.lockBlocked).toMatch(/now within four hours of/);
    expect(
      await prisma.rescheduleVote.findUnique({
        where: {
          requestId_userId_time: {
            requestId: request.id,
            userId: s.awayCaptain.id,
            time: T1,
          },
        },
      }),
    ).toMatchObject({ ready: true });
    expect(await kickoff(s.match.id)).toBe(ORIGINAL_NIGHT.getTime());
    await expect(
      lockInReschedule(s.awayCaptain.id, request.id, T1),
    ).rejects.toThrow(/now within four hours of/);
    expect((await openRequest(s.match.id)).id).toBe(request.id);
  });

  it("still settles a proposal made before the ready check (no options column)", async () => {
    const s = await setupReadyCheck();
    const legacy = await prisma.rescheduleRequest.create({
      data: {
        matchId: s.match.id,
        proposedById: s.homeCaptain.id,
        proposedTime: T1,
      },
    });
    await voteReschedule(s.homePlayers[0].id, legacy.id, T1, true);
    const outcome = await respondReschedule(s.awayCaptain.id, legacy.id, true);
    expect(outcome.accepted).toBe(true);
    expect(await kickoff(s.match.id)).toBe(T1.getTime());
  });

  it("refuses an answer once a time is locked in", async () => {
    const s = await setupReadyCheck();
    await proposeReschedule(s.homeCaptain.id, s.match.id, [T1, T2]);
    const request = await openRequest(s.match.id);
    await lockInReschedule(s.awayCaptain.id, request.id, T1);
    await expect(
      voteReschedule(s.homePlayers[0].id, request.id, T2, true),
    ).rejects.toThrow(/already locked in/);
  });
});

// ---------------------------------------------------------------------------
// Contention. raceAll is sequential on SQLite; `npm run test:pg` interleaves.
// ---------------------------------------------------------------------------

describe("reschedule ready check — contention", () => {
  it("the last two answers arriving together still move the match exactly once", async () => {
    // Each of the two last answers, alone, sees the option one short. Under
    // SERIALIZABLE one of them aborts and its retry sees the other's yes;
    // without that, both commit, everyone is in, and nothing ever moves.
    for (let run = 0; run < 4; run++) {
      await prisma.season.updateMany({ data: { isActive: false } });
      const s = await setupReadyCheck();
      await proposeReschedule(s.homeCaptain.id, s.match.id, [T1]);
      const request = await openRequest(s.match.id);
      // The proposer's yes is implied; two players are left.
      for (const user of [s.awayCaptain, s.homePlayers[0], s.awayPlayers[0]]) {
        await voteReschedule(user.id, request.id, T1, true);
      }
      const [lastA, lastB] = [s.homePlayers[1], s.awayPlayers[1]];
      const outcomes = await raceAll([
        () => voteReschedule(lastA.id, request.id, T1, true),
        () => voteReschedule(lastB.id, request.id, T1, true),
      ]);
      expect(outcomes.filter((o) => o.locked !== null)).toHaveLength(1);
      expect(await kickoff(s.match.id)).toBe(T1.getTime());
      expect(
        (
          await prisma.rescheduleRequest.findUniqueOrThrow({
            where: { id: request.id },
          })
        ).status,
      ).toBe("ACCEPTED");
      expect(
        await prisma.matchAvailability.count({
          where: { matchId: s.match.id, status: "IN" },
        }),
      ).toBe(6);
    }
  });

  it("two captains locking different times at once leave exactly one", async () => {
    const s = await setupReadyCheck();
    await proposeReschedule(s.homeCaptain.id, s.match.id, [T1, T2]);
    const request = await openRequest(s.match.id);
    await voteReschedule(s.awayCaptain.id, request.id, T2, true);

    const results = await raceAll([
      () => lockInReschedule(s.awayCaptain.id, request.id, T1).catch(() => null),
      () => lockInReschedule(s.homeCaptain.id, request.id, T2).catch(() => null),
    ]);
    const winners = results.filter(Boolean);
    expect(winners).toHaveLength(1);
    const after = await prisma.rescheduleRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(after.status).toBe("ACCEPTED");
    expect(await kickoff(s.match.id)).toBe(after.proposedTime.getTime());
    expect(after.proposedTime.getTime()).toBe(winners[0]!.newTime.getTime());
  });
});

describe("reschedule ready check — what each viewer sees", () => {
  it("names seats for the captains only, and shows a player their own", async () => {
    const s = await setupReadyCheck();
    await proposeReschedule(s.homeCaptain.id, s.match.id, [T1, T2]);
    const request = await openRequest(s.match.id);
    await voteReschedule(s.awayPlayers[0].id, request.id, T1, true);
    await voteReschedule(s.awayPlayers[1].id, request.id, T1, false);

    const asCaptain = await loadReadyCheckViewById(
      s.match.id,
      { id: s.awayCaptain.id, role: "USER" },
      Date.now(),
    );
    expect(asCaptain).toMatchObject({ named: true, open: true });
    expect(asCaptain!.viewer).toMatchObject({ kind: "captain", side: "away" });
    // The captain's own seat comes first, then by name.
    expect(asCaptain!.options[0].away.seats.map((seat) => seat.name)).toEqual([
      s.awayCaptain.name,
      s.awayPlayers[0].name,
      s.awayPlayers[1].name,
    ]);

    const asPlayer = await loadReadyCheckViewById(
      s.match.id,
      { id: s.homePlayers[0].id, role: "USER" },
      Date.now(),
    );
    expect(asPlayer!.named).toBe(false);
    expect(asPlayer!.viewer).toMatchObject({ kind: "player", canAnswer: true });
    const names = asPlayer!.options.flatMap((o) =>
      [...o.home.seats, ...o.away.seats].flatMap((seat) =>
        seat.name ? [seat.name] : [],
      ),
    );
    expect(new Set(names)).toEqual(new Set([s.homePlayers[0].name]));
    expect(asPlayer!.options[0].away).toMatchObject({ ready: 1, out: 1 });

    const asStranger = await loadReadyCheckViewById(s.match.id, null, Date.now());
    expect(asStranger!.viewer).toMatchObject({
      kind: "spectator",
      canAnswer: false,
    });
  });

  it("remembers a lock for the match page, celebrating only while it's fresh", async () => {
    const s = await setupReadyCheck();
    await proposeReschedule(s.homeCaptain.id, s.match.id, [T1]);
    const request = await openRequest(s.match.id);
    expect(await loadRecentLock({ ...s.match }, Date.now())).toBeNull();
    for (const user of [s.awayCaptain, ...s.homePlayers, ...s.awayPlayers]) {
      await voteReschedule(user.id, request.id, T1, true);
    }
    const match = await prisma.match.findUniqueOrThrow({
      where: { id: s.match.id },
    });
    const lock = await loadRecentLock(match, Date.now());
    expect(lock).toMatchObject({
      timeMs: T1.getTime(),
      ready: 6,
      seats: 6,
      burst: true,
    });
    // An hour later it's a calm note; a day later it's gone.
    expect(
      (await loadRecentLock(match, lock!.lockedAtMs + HOUR))?.burst,
    ).toBe(false);
    expect(await loadRecentLock(match, lock!.lockedAtMs + 2 * DAY)).toBeNull();
    // An admin moving the match afterwards makes the note wrong: it hides.
    await prisma.match.update({
      where: { id: match.id },
      data: { scheduledAt: T2 },
    });
    expect(
      await loadRecentLock({ ...match, scheduledAt: T2 }, Date.now()),
    ).toBeNull();
  });
});
