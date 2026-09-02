import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  cancelReschedule,
  proposeReschedule,
  respondReschedule,
} from "@/lib/reschedule-service";
import {
  generateRegularSchedule,
  makeSeason,
  makeTeam,
  makeUser,
  raceAll,
  raceN,
  recordMatch,
} from "./factories";
import {
  DRAFT_STATUS,
  MATCH_STATUS,
  SCRIM_STATUS,
  SEASON_STATUS,
} from "@/lib/constants";

// RELATIVE to now, never a literal date. This was hard-coded to
// 2026-08-01T19:00Z and went off like a time bomb the moment the wall clock
// passed it plus assertSaneProposedTime's one-hour grace: 16 of 19 tests
// started failing on a file nobody had touched. A proposal is inherently a
// future time, so the fixture has to be one too.
const NIGHT = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
const ORIGINAL_NIGHT = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);

/** A two-team season with one scheduled match; returns captains + match. */
async function setupMatch() {
  const season = await makeSeason({ status: SEASON_STATUS.REGULAR_SEASON });
  const home = await makeTeam(season.id, "Home", 0);
  const away = await makeTeam(season.id, "Away", 1);
  const [created] = await generateRegularSchedule(season.id);
  const match = await prisma.match.update({
    where: { id: created.id },
    data: { scheduledAt: ORIGINAL_NIGHT },
  });
  return { season, home, away, match };
}

async function pendingFor(matchId: string) {
  return prisma.rescheduleRequest.findFirst({
    where: { matchId, status: "PENDING" },
  });
}

describe("reschedule service (integration)", () => {
  it("captain proposes; a newer proposal supersedes the old one", async () => {
    const { home, away, match } = await setupMatch();
    // The service returns announcement data (the action's Discord ping).
    const proposed = await proposeReschedule(home.captainId, match.id, NIGHT);
    expect(proposed).toMatchObject({
      homeName: "Home",
      awayName: "Away",
      isPlayoff: false,
      proposedTime: NIGHT,
      // A proposal is a question addressed to the OTHER captain — never to the
      // one who just asked it.
      notifyUserId: away.captainId,
    });
    const first = await pendingFor(match.id);
    expect(first?.proposedTime.getTime()).toBe(NIGHT.getTime());

    const later = new Date(NIGHT.getTime() + 3600_000);
    await proposeReschedule(home.captainId, match.id, later);
    const requests = await prisma.rescheduleRequest.findMany({
      where: { matchId: match.id },
      orderBy: { createdAt: "asc" },
    });
    expect(requests.map((r) => r.status).sort()).toEqual([
      "CANCELLED",
      "PENDING",
    ]);
    expect((await pendingFor(match.id))?.proposedTime.getTime()).toBe(
      later.getTime(),
    );
  });

  it("blocks a proposal and acceptance that would collide with a booked scrim", async () => {
    const { season, home, away, match } = await setupMatch();
    const practiceOpponent = await makeTeam(season.id, "Practice", 2);
    const booked = await prisma.scrim.create({
      data: {
        seasonId: season.id,
        hostTeamId: home.id,
        opponentTeamId: practiceOpponent.id,
        createdById: home.captainId,
        scheduledAt: NIGHT,
        status: SCRIM_STATUS.SCHEDULED,
      },
    });

    await expect(
      proposeReschedule(home.captainId, match.id, NIGHT),
    ).rejects.toThrow(/booked scrim within four hours/i);
    expect(await pendingFor(match.id)).toBeNull();

    await prisma.scrim.update({
      where: { id: booked.id },
      data: { status: SCRIM_STATUS.CANCELLED },
    });
    await proposeReschedule(home.captainId, match.id, NIGHT);
    const pending = await pendingFor(match.id);
    await prisma.scrim.update({
      where: { id: booked.id },
      data: { status: SCRIM_STATUS.SCHEDULED },
    });

    await expect(
      respondReschedule(away.captainId, pending!.id, true),
    ).rejects.toThrow(/now has a booked scrim within four hours/i);
    expect(
      (await prisma.match.findUniqueOrThrow({ where: { id: match.id } }))
        .scheduledAt,
    ).toEqual(ORIGINAL_NIGHT);
    expect(
      (
        await prisma.rescheduleRequest.findUniqueOrThrow({
          where: { id: pending!.id },
        })
      ).status,
    ).toBe("PENDING");
  });

  it("rejects proposals from non-captains and on played matches", async () => {
    const { home, away, match } = await setupMatch();
    const rando = await makeUser("Rando");
    await expect(proposeReschedule(rando.id, match.id, NIGHT)).rejects.toThrow(
      /two captains/,
    );

    await recordMatch(match.id, 2, 0);
    await expect(
      proposeReschedule(home.captainId, match.id, NIGHT),
    ).rejects.toThrow(/already played/);
    void away;
  });

  it("rejects a LIVE match — captains negotiate before the series starts", async () => {
    const { home, match } = await setupMatch();
    await prisma.match.update({
      where: { id: match.id },
      data: { status: MATCH_STATUS.LIVE },
    });

    await expect(
      proposeReschedule(home.captainId, match.id, NIGHT),
    ).rejects.toThrow(/already live/i);
    expect(await pendingFor(match.id)).toBeNull();
  });

  it.each([
    [SEASON_STATUS.SIGNUPS, null],
    [SEASON_STATUS.DRAFT, DRAFT_STATUS.IN_PROGRESS],
    [SEASON_STATUS.COMPLETE, null],
  ])("rejects a proposal during %s / %s", async (seasonStatus, draftStatus) => {
    const { season, home, match } = await setupMatch();
    await prisma.season.update({
      where: { id: season.id },
      data: { status: seasonStatus },
    });
    if (draftStatus) {
      await prisma.draft.create({
        data: { seasonId: season.id, status: draftStatus },
      });
    }

    await expect(
      proposeReschedule(home.captainId, match.id, NIGHT),
    ).rejects.toThrow(/not open.*league phase/i);
    expect(await pendingFor(match.id)).toBeNull();
  });

  it("allows a DRAFT-phase proposal only after the auction completes", async () => {
    const { season, home, match } = await setupMatch();
    await prisma.season.update({
      where: { id: season.id },
      data: { status: SEASON_STATUS.DRAFT },
    });
    await prisma.draft.create({
      data: { seasonId: season.id, status: DRAFT_STATUS.COMPLETE },
    });

    await expect(
      proposeReschedule(home.captainId, match.id, NIGHT),
    ).resolves.toMatchObject({ proposedTime: NIGHT });
  });

  it("rejects proposing the kickoff that is already published", async () => {
    const { home, match } = await setupMatch();

    await expect(
      proposeReschedule(home.captainId, match.id, ORIGINAL_NIGHT),
    ).rejects.toThrow(/already this match's kickoff/i);
    expect(await pendingFor(match.id)).toBeNull();
  });

  it("lets an unscheduled fixture receive its first kickoff by agreement", async () => {
    const { home, away, match } = await setupMatch();
    await prisma.match.update({
      where: { id: match.id },
      data: { scheduledAt: null },
    });

    await proposeReschedule(home.captainId, match.id, NIGHT);
    const pending = await pendingFor(match.id);
    const accepted = await respondReschedule(away.captainId, pending!.id, true);

    expect(accepted.accepted).toBe(true);
    expect(
      (
        await prisma.match.findUniqueOrThrow({ where: { id: match.id } })
      ).scheduledAt?.getTime(),
    ).toBe(NIGHT.getTime());
  });

  it("opposing captain accepts → match retimed, request ACCEPTED", async () => {
    const { home, away, match } = await setupMatch();
    await proposeReschedule(home.captainId, match.id, NIGHT);
    const pending = await pendingFor(match.id);

    const accepted = await respondReschedule(away.captainId, pending!.id, true);
    expect(accepted.accepted).toBe(true);
    if (!accepted.accepted) throw new Error("expected an acceptance");
    expect(accepted.newTime.getTime()).toBe(NIGHT.getTime());
    // The answer goes back to whoever asked the question.
    expect(accepted.notifyUserId).toBe(home.captainId);

    const updated = await prisma.match.findUnique({
      where: { id: match.id },
    });
    expect(updated?.scheduledAt?.getTime()).toBe(NIGHT.getTime());
    const request = await prisma.rescheduleRequest.findUnique({
      where: { id: pending!.id },
    });
    expect(request?.status).toBe("ACCEPTED");
  });

  it("rejects a no-op accept if an admin already moved the match there", async () => {
    const { home, away, match } = await setupMatch();
    await proposeReschedule(home.captainId, match.id, NIGHT);
    const pending = await pendingFor(match.id);
    await prisma.match.update({
      where: { id: match.id },
      data: { scheduledAt: NIGHT },
    });
    await prisma.matchAvailability.create({
      data: { matchId: match.id, userId: home.captainId, status: "IN" },
    });

    await expect(
      respondReschedule(away.captainId, pending!.id, true),
    ).rejects.toThrow(/already this match's kickoff/i);
    expect(
      (
        await prisma.rescheduleRequest.findUniqueOrThrow({
          where: { id: pending!.id },
        })
      ).status,
    ).toBe("PENDING");
    expect(
      await prisma.matchAvailability.count({ where: { matchId: match.id } }),
    ).toBe(1);
  });

  it("rechecks phase before ACCEPT but still allows DECLINE cleanup", async () => {
    const { season, home, away, match } = await setupMatch();
    await proposeReschedule(home.captainId, match.id, NIGHT);
    const pending = await pendingFor(match.id);
    await prisma.season.update({
      where: { id: season.id },
      data: { status: SEASON_STATUS.COMPLETE },
    });

    await expect(
      respondReschedule(away.captainId, pending!.id, true),
    ).rejects.toThrow(/not open.*league phase/i);
    expect(
      (
        await prisma.match.findUniqueOrThrow({ where: { id: match.id } })
      ).scheduledAt?.getTime(),
    ).toBe(ORIGINAL_NIGHT.getTime());

    const declined = await respondReschedule(
      away.captainId,
      pending!.id,
      false,
    );
    expect(declined.accepted).toBe(false);
  });

  it("rechecks match status before ACCEPT but still allows DECLINE cleanup", async () => {
    const { home, away, match } = await setupMatch();
    await proposeReschedule(home.captainId, match.id, NIGHT);
    const pending = await pendingFor(match.id);
    await prisma.match.update({
      where: { id: match.id },
      data: { status: MATCH_STATUS.LIVE },
    });

    await expect(
      respondReschedule(away.captainId, pending!.id, true),
    ).rejects.toThrow(/already live/i);
    const declined = await respondReschedule(
      away.captainId,
      pending!.id,
      false,
    );
    expect(declined.accepted).toBe(false);
  });

  it("rechecks the opposing captain inside the response transaction", async () => {
    const { home, away, match } = await setupMatch();
    await proposeReschedule(home.captainId, match.id, NIGHT);
    const pending = await pendingFor(match.id);
    const replacementCaptain = await makeUser("Replacement Away Captain");
    await prisma.team.update({
      where: { id: away.id },
      data: { captainId: replacementCaptain.id },
    });

    await expect(
      respondReschedule(away.captainId, pending!.id, false),
    ).rejects.toThrow(/opposing captain/i);
    await expect(
      respondReschedule(replacementCaptain.id, pending!.id, false),
    ).resolves.toMatchObject({ accepted: false });
  });

  it("proposer cannot accept their own proposal", async () => {
    const { home, match } = await setupMatch();
    await proposeReschedule(home.captainId, match.id, NIGHT);
    const pending = await pendingFor(match.id);
    await expect(
      respondReschedule(home.captainId, pending!.id, true),
    ).rejects.toThrow(/opposing captain/);
  });

  it("decline keeps the current time and closes the request", async () => {
    const { home, away, match } = await setupMatch();
    const before = (await prisma.match.findUnique({ where: { id: match.id } }))
      ?.scheduledAt;
    await proposeReschedule(home.captainId, match.id, NIGHT);
    const pending = await pendingFor(match.id);

    const result = await respondReschedule(away.captainId, pending!.id, false);
    // A decline now carries announcement data too — it used to return null,
    // which is exactly how the action skipped every send and left the
    // proposer waiting on an answer that had already been given.
    expect(result.accepted).toBe(false);
    if (result.accepted) throw new Error("expected a decline");
    expect(result.notifyUserId).toBe(home.captainId);
    expect(result.proposedTime.getTime()).toBe(NIGHT.getTime());
    const after = await prisma.match.findUnique({ where: { id: match.id } });
    expect(after?.scheduledAt?.getTime() ?? null).toBe(
      before?.getTime() ?? null,
    );
    expect(
      (
        await prisma.rescheduleRequest.findUnique({
          where: { id: pending!.id },
        })
      )?.status,
    ).toBe("DECLINED");
  });

  it("only the proposer or an admin can withdraw", async () => {
    const { home, away, match } = await setupMatch();
    await proposeReschedule(home.captainId, match.id, NIGHT);
    const pending = await pendingFor(match.id);

    await expect(
      cancelReschedule(away.captainId, pending!.id, false),
    ).rejects.toThrow(/proposer/);
    await cancelReschedule(away.captainId, pending!.id, true); // admin override
    expect(
      (
        await prisma.rescheduleRequest.findUnique({
          where: { id: pending!.id },
        })
      )?.status,
    ).toBe("CANCELLED");
  });
});

// ---------------------------------------------------------------------------
// Claim guards. Each deletes to a blind write and only contention notices, so
// every one races N callers and requires exactly one to win. Real interleaving
// happens under `npm run test:pg`; the CI mutation guard runs there.
// ---------------------------------------------------------------------------

describe("reschedule — claims fire exactly once under contention", () => {
  it("two captains proposing at once leave exactly ONE open proposal", async () => {
    // There is no unique constraint behind "at most one PENDING per match" —
    // the supersede-then-insert pair inside a SERIALIZABLE transaction is the
    // whole enforcement. A second open proposal is a zombie the other captain
    // can accept days later, retiming the match out from under everyone.
    const { home, away, match } = await setupMatch();
    const res = await raceAll([
      () =>
        proposeReschedule(home.captainId, match.id, NIGHT).catch(() => null),
      () =>
        proposeReschedule(
          away.captainId,
          match.id,
          new Date(NIGHT.getTime() + 3_600_000),
        ).catch(() => null),
    ]);
    expect(res.filter(Boolean).length).toBeGreaterThanOrEqual(1);
    expect(
      await prisma.rescheduleRequest.count({
        where: { matchId: match.id, status: "PENDING" },
      }),
    ).toBe(1);
  });

  it("superseding a proposal touches only the OPEN one", async () => {
    // Deterministic, no race needed: the supersede is scoped to PENDING rows.
    // Without that predicate it rewrites every request this match ever had, so
    // a DECLINED answer becomes CANCELLED and the audit trail lies about
    // whether the opponent ever said no.
    const { home, away, match } = await setupMatch();
    await proposeReschedule(home.captainId, match.id, NIGHT);
    const first = (await pendingFor(match.id))!;
    await respondReschedule(away.captainId, first.id, false); // DECLINED

    await proposeReschedule(
      home.captainId,
      match.id,
      new Date(NIGHT.getTime() + 864e5),
    );

    expect(
      (
        await prisma.rescheduleRequest.findUniqueOrThrow({
          where: { id: first.id },
        })
      ).status,
    ).toBe("DECLINED");
    expect(
      await prisma.rescheduleRequest.count({
        where: { matchId: match.id, status: "PENDING" },
      }),
    ).toBe(1);
  });

  it("an accept racing a RESULT never retimes a match that just completed", async () => {
    // respondReschedule checks "not already played" against a row read before
    // its transaction opens, and auto-sync completes matches from any
    // visitor's page view. Stamping a future kickoff on a finished series also
    // wipes its RSVPs and pushes it outside its own detection window.
    for (let run = 0; run < 6; run++) {
      // Each repetition is a new league fixture; preserve the production
      // invariant instead of accumulating six active test seasons.
      await prisma.season.updateMany({ data: { isActive: false } });
      const { home, away, match } = await setupMatch();
      await proposeReschedule(home.captainId, match.id, NIGHT);
      const open = (await pendingFor(match.id))!;
      const before = (
        await prisma.match.findUniqueOrThrow({ where: { id: match.id } })
      ).scheduledAt;

      // RESULT FIRST in the list: raceAll is sequential on SQLite, and with the
      // accept first that is a legitimate retime-then-play rather than the case
      // under test. This order gives both engines the same scenario — the
      // series finishes, then a stale accept tries to move it.
      await raceAll<unknown>([
        () => recordMatch(match.id, 2, 0),
        () =>
          respondReschedule(away.captainId, open.id, true).catch(() => null),
      ]);

      const after = await prisma.match.findUniqueOrThrow({
        where: { id: match.id },
      });
      if (after.status === "COMPLETED") {
        // A played match keeps the night it was played on.
        expect(after.scheduledAt?.getTime()).toBe(before?.getTime());
      }
    }
  });

  it("only one of N simultaneous ACCEPTs may retime the match", async () => {
    const { home, away, match } = await setupMatch();
    await proposeReschedule(home.captainId, match.id, NIGHT);
    const open = (await pendingFor(match.id))!;

    const res = await raceN(4, () =>
      respondReschedule(away.captainId, open.id, true).catch(() => null),
    );
    expect(res.filter(Boolean)).toHaveLength(1);
    expect(
      (
        await prisma.rescheduleRequest.findUniqueOrThrow({
          where: { id: open.id },
        })
      ).status,
    ).toBe("ACCEPTED");
    expect(
      (
        await prisma.match.findUniqueOrThrow({ where: { id: match.id } })
      ).scheduledAt?.getTime(),
    ).toBe(NIGHT.getTime());
  });

  it("only one of N simultaneous DECLINEs may close the proposal", async () => {
    const { home, away, match } = await setupMatch();
    await proposeReschedule(home.captainId, match.id, NIGHT);
    const open = (await pendingFor(match.id))!;

    const res = await raceN(4, () =>
      respondReschedule(away.captainId, open.id, false)
        .then(() => true)
        .catch(() => null),
    );
    expect(res.filter(Boolean)).toHaveLength(1);
    expect(
      (
        await prisma.rescheduleRequest.findUniqueOrThrow({
          where: { id: open.id },
        })
      ).status,
    ).toBe("DECLINED");
  });

  it("an accept and a withdraw racing cannot BOTH land", async () => {
    // The proposer pulling the ask at the same instant the opponent accepts:
    // one outcome must win outright, or the match is retimed by a proposal its
    // author had already withdrawn.
    const { home, away, match } = await setupMatch();
    await proposeReschedule(home.captainId, match.id, NIGHT);
    const open = (await pendingFor(match.id))!;

    await raceAll<unknown>([
      () => respondReschedule(away.captainId, open.id, true).catch(() => null),
      () => cancelReschedule(home.captainId, open.id, false).catch(() => null),
    ]);

    const after = await prisma.rescheduleRequest.findUniqueOrThrow({
      where: { id: open.id },
    });
    expect(["ACCEPTED", "CANCELLED"]).toContain(after.status);
    const m = await prisma.match.findUniqueOrThrow({ where: { id: match.id } });
    // The match moved if and only if the accept won.
    expect(m.scheduledAt?.getTime() === NIGHT.getTime()).toBe(
      after.status === "ACCEPTED",
    );
  });

  it("only one of N simultaneous withdrawals may cancel the proposal", async () => {
    const { home, match } = await setupMatch();
    await proposeReschedule(home.captainId, match.id, NIGHT);
    const open = (await pendingFor(match.id))!;

    const res = await raceN(4, () =>
      cancelReschedule(home.captainId, open.id, false)
        .then(() => true)
        .catch(() => null),
    );
    expect(res.filter(Boolean)).toHaveLength(1);
  });
});

// Accepting a reschedule DELETES every RSVP for the match (they were answers
// about a night nobody is now playing). That part is deliberate; doing it
// silently was not — eight to ten players each believe they already checked in,
// and the captain sees an unstaffed match with no explanation.
describe("accepting a reschedule reports what it invalidated", () => {
  async function withRsvps(count: number) {
    const { home, away, match, season } = await setupMatch();
    for (let i = 0; i < count; i++) {
      const u = await makeUser(`RSVP ${i}`);
      await prisma.matchAvailability.create({
        data: { matchId: match.id, userId: u.id, status: "IN" },
      });
    }
    return { home, away, match, season };
  }

  it("counts the check-ins it cleared", async () => {
    const { home, away, match } = await withRsvps(3);
    await proposeReschedule(home.captainId, match.id, NIGHT);
    const pending = await pendingFor(match.id);

    const accepted = await respondReschedule(away.captainId, pending!.id, true);

    if (!accepted.accepted) throw new Error("expected an acceptance");
    expect(accepted.clearedRsvps).toBe(3);
    expect(
      await prisma.matchAvailability.count({ where: { matchId: match.id } }),
    ).toBe(0);
  });

  it("reports zero rather than null when there was nothing to clear", async () => {
    const { home, away, match } = await withRsvps(0);
    await proposeReschedule(home.captainId, match.id, NIGHT);
    const pending = await pendingFor(match.id);
    const accepted = await respondReschedule(away.captainId, pending!.id, true);
    if (!accepted.accepted) throw new Error("expected an acceptance");
    expect(accepted.clearedRsvps).toBe(0);
  });

  // The week's reminder already went out quoting the OLD kickoff, and a Discord
  // edit notifies nobody. Dropping the marker lets it re-fire with the new time.
  it("releases the week-reminder marker so it can re-announce the new time", async () => {
    const { home, away, match, season } = await withRsvps(1);
    const key = `weekReminder:${season.id}:${match.week}`;
    await prisma.setting.create({ data: { key, value: "already-sent" } });

    await proposeReschedule(home.captainId, match.id, NIGHT);
    const pending = await pendingFor(match.id);
    await respondReschedule(away.captainId, pending!.id, true);

    expect(await prisma.setting.findUnique({ where: { key } })).toBeNull();
  });

  it("releases only the retimed week's stamped markers", async () => {
    const { home, away, match, season } = await withRsvps(1);
    const weekOneKey = `weekReminder:${season.id}:${match.week}:${match.scheduledAt!.getTime()}`;
    const weekTenKey = `weekReminder:${season.id}:10:${match.scheduledAt!.getTime()}`;
    await prisma.setting.createMany({
      data: [
        { key: weekOneKey, value: "already-sent" },
        { key: weekTenKey, value: "unrelated-week" },
      ],
    });

    await proposeReschedule(home.captainId, match.id, NIGHT);
    const pending = await pendingFor(match.id);
    await respondReschedule(away.captainId, pending!.id, true);

    expect(
      await prisma.setting.findUnique({ where: { key: weekOneKey } }),
    ).toBeNull();
    expect(
      await prisma.setting.findUnique({ where: { key: weekTenKey } }),
    ).not.toBeNull();
  });

  it("leaves the marker alone when the proposal is DECLINED", async () => {
    const { home, away, match, season } = await withRsvps(2);
    const key = `weekReminder:${season.id}:${match.week}`;
    await prisma.setting.create({ data: { key, value: "already-sent" } });

    await proposeReschedule(home.captainId, match.id, NIGHT);
    const pending = await pendingFor(match.id);
    await respondReschedule(away.captainId, pending!.id, false);

    expect(await prisma.setting.findUnique({ where: { key } })).not.toBeNull();
    // ...and the RSVPs survive a decline: nothing about the night changed.
    expect(
      await prisma.matchAvailability.count({ where: { matchId: match.id } }),
    ).toBe(2);
  });
});

describe("reschedule — archived seasons are read-only for captains", () => {
  // An early season turnover (Create-a-new-season mid-run, or Make active
  // again on an old one) leaves unplayed matches behind with their captains
  // intact. Proposing opens a live negotiation over a dead fixture; accepting
  // would RETIME it and wipe its RSVPs. Decline stays legal — cleaning up a
  // proposal stranded by the archival only touches the request row.
  async function archivedMatch() {
    return setupMatch();
  }

  it("refuses a proposal on an archived season's match", async () => {
    const { season, home, match } = await archivedMatch();
    await prisma.season.update({
      where: { id: season.id },
      data: { isActive: false },
    });
    await expect(
      proposeReschedule(home.captainId, match.id, NIGHT),
    ).rejects.toThrow(/archived season/i);
  });

  it("refuses ACCEPT but allows DECLINE on a proposal stranded by archival", async () => {
    const { season, home, away, match } = await archivedMatch();
    await proposeReschedule(home.captainId, match.id, NIGHT);
    const pending = await pendingFor(match.id);
    await prisma.season.update({
      where: { id: season.id },
      data: { isActive: false },
    });

    await expect(
      respondReschedule(away.captainId, pending!.id, true),
    ).rejects.toThrow(/archived season/i);
    // The match was NOT retimed by the refused accept.
    const row = await prisma.match.findUniqueOrThrow({
      where: { id: match.id },
    });
    expect(row.scheduledAt?.getTime() ?? null).not.toBe(NIGHT.getTime());
    // The stranded proposal can still be declined away.
    await respondReschedule(away.captainId, pending!.id, false);
    expect(
      (
        await prisma.rescheduleRequest.findUniqueOrThrow({
          where: { id: pending!.id },
        })
      ).status,
    ).toBe("DECLINED");
  });

  it("allows the proposer to withdraw a proposal stranded by archival", async () => {
    const { season, home, match } = await archivedMatch();
    await proposeReschedule(home.captainId, match.id, NIGHT);
    const pending = await pendingFor(match.id);
    await prisma.season.update({
      where: { id: season.id },
      data: { isActive: false },
    });

    await cancelReschedule(home.captainId, pending!.id, false);
    expect(
      (
        await prisma.rescheduleRequest.findUniqueOrThrow({
          where: { id: pending!.id },
        })
      ).status,
    ).toBe("CANCELLED");
  });
});

describe("reschedule — a decline reaches the person who asked", () => {
  // The proposal is announced to the channel and mentions the opposing
  // captain; the ACCEPT is announced back to the proposer. The DECLINE sent
  // nothing at all, so the proposer waited on an answer that had already been
  // given, and the question hung unanswered in the channel forever.
  it("carries announcement data addressed to the proposer", async () => {
    const { home, away, match } = await setupMatch();
    await proposeReschedule(home.captainId, match.id, NIGHT);
    const pending = await pendingFor(match.id);

    const outcome = await respondReschedule(away.captainId, pending!.id, false);

    expect(outcome.accepted).toBe(false);
    if (outcome.accepted) throw new Error("expected a decline");
    // Addressed to exactly one person — nobody else can act on it.
    expect(outcome.notifyUserId).toBe(home.captainId);
    expect(outcome.homeName).toBe("Home");
    expect(outcome.awayName).toBe("Away");
    expect(outcome.proposedTime.getTime()).toBe(NIGHT.getTime());
    // …and the request really is closed.
    expect(await pendingFor(match.id)).toBeNull();
  });
});

// A booked standin's assignment ping quoted the OLD kickoff, and the
// acceptance broadcast is the one message that carries the new one — so the
// ACCEPTED outcome names the match's standins for the action to mention.
describe("reschedule — the acceptance carries the match's booked standins", () => {
  it("accept → standinUserIds lists exactly the booked standin", async () => {
    const { home, away, match } = await setupMatch();
    const standin = await makeUser("Cover Guy");
    await prisma.standinAssignment.create({
      data: { matchId: match.id, teamId: home.id, standinUserId: standin.id },
    });
    await proposeReschedule(home.captainId, match.id, NIGHT);
    const pending = await pendingFor(match.id);

    const outcome = await respondReschedule(away.captainId, pending!.id, true);

    if (!outcome.accepted) throw new Error("expected an acceptance");
    expect(outcome.standinUserIds).toEqual([standin.id]);
  });

  it("a decline carries no standinUserIds — nothing moved, nobody needs a new time", async () => {
    const { home, away, match } = await setupMatch();
    const standin = await makeUser("Cover Guy");
    await prisma.standinAssignment.create({
      data: { matchId: match.id, teamId: home.id, standinUserId: standin.id },
    });
    await proposeReschedule(home.captainId, match.id, NIGHT);
    const pending = await pendingFor(match.id);

    const outcome = await respondReschedule(away.captainId, pending!.id, false);

    expect(outcome.accepted).toBe(false);
    // The field is AcceptedReschedule-only; leaking it onto the decline would
    // invite the action to @-mention standins about a kickoff that never moved.
    expect(outcome).not.toHaveProperty("standinUserIds");
  });
});
