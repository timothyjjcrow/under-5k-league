import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { MATCH_PHASE, MATCH_STATUS, SEASON_STATUS } from "@/lib/constants";
import {
  assignStandinGuarded,
  removeStandinGuarded,
} from "@/lib/standin-service";
import { makeSeason, makeTeam, makeUser } from "./factories";

// Captain self-serve standins: the guards that used to live admin-only now
// gate both paths — with actingCaptainId null (admin) or the captain's id
// (must own the covered team). The reschedule-service testing pattern.

async function setup() {
  const season = await makeSeason({ status: SEASON_STATUS.REGULAR_SEASON });
  const home = await makeTeam(season.id, "Home", 0);
  const away = await makeTeam(season.id, "Away", 1);

  const roster = async (teamId: string, name: string) => {
    const user = await makeUser(name);
    await prisma.teamMember.create({
      data: {
        seasonId: season.id,
        teamId,
        userId: user.id,
        isCaptain: false,
        price: 5,
      },
    });
    return user;
  };
  const homePlayer = await roster(home.id, "Home Carry");
  const awayPlayer = await roster(away.id, "Away Mid");

  // An unrostered ACTIVE signup — the standin pool.
  const sub = await makeUser("Sub Sam");
  await prisma.registration.create({
    data: {
      seasonId: season.id,
      userId: sub.id,
      type: "STANDIN",
      status: "ACTIVE",
      mmr: 3200,
    },
  });

  const match = await prisma.match.create({
    data: {
      seasonId: season.id,
      week: 1,
      phase: MATCH_PHASE.REGULAR,
      homeTeamId: home.id,
      awayTeamId: away.id,
      scheduledAt: new Date(Date.now() + 3600_000),
    },
  });
  return { season, home, away, homePlayer, awayPlayer, sub, match };
}

describe("captain standin assignment (integration)", () => {
  it("a captain covers their own player; the announcement carries the story", async () => {
    const { home, homePlayer, sub, match } = await setup();
    const res = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: sub.id,
      replacingUserId: homePlayer.id,
      actingCaptainId: home.captainId,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.announcement).toContain("Sub Sam");
    expect(res.announcement).toContain("Home Carry");
    expect(res.announcement).toContain("<t:"); // reader-local kickoff

    const row = await prisma.standinAssignment.findFirstOrThrow({
      where: { matchId: match.id },
    });
    expect(row.teamId).toBe(home.id);
    expect(row.standinUserId).toBe(sub.id);
  });

  it("a captain cannot arrange cover for the OTHER team (admins can)", async () => {
    const { home, awayPlayer, sub, match } = await setup();
    const wrong = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: sub.id,
      replacingUserId: awayPlayer.id,
      actingCaptainId: home.captainId, // home captain touching away's roster
    });
    expect(wrong).toMatchObject({ ok: false });
    expect(await prisma.standinAssignment.count()).toBe(0);

    // Same call as admin override succeeds.
    const admin = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: sub.id,
      replacingUserId: awayPlayer.id,
      actingCaptainId: null,
    });
    expect(admin.ok).toBe(true);
  });

  it("a random member (not the captain) is rejected the same way", async () => {
    const { homePlayer, sub, match } = await setup();
    const rando = await makeUser("Rando");
    const res = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: sub.id,
      replacingUserId: homePlayer.id,
      actingCaptainId: rando.id,
    });
    expect(res.ok).toBe(false);
  });

  it("keeps every roster-integrity guard: rostered subs, dead signups, dupes, self, played matches", async () => {
    const { home, homePlayer, awayPlayer, sub, match } = await setup();
    const cap = home.captainId;

    // Rostered player can't stand in.
    expect(
      (
        await assignStandinGuarded({
          matchId: match.id,
          standinUserId: awayPlayer.id,
          replacingUserId: homePlayer.id,
          actingCaptainId: cap,
        })
      ).ok,
    ).toBe(false);

    // Withdrawn signup can't stand in.
    await prisma.registration.updateMany({
      where: { userId: sub.id },
      data: { status: "WITHDRAWN" },
    });
    expect(
      (
        await assignStandinGuarded({
          matchId: match.id,
          standinUserId: sub.id,
          replacingUserId: homePlayer.id,
          actingCaptainId: cap,
        })
      ).ok,
    ).toBe(false);
    await prisma.registration.updateMany({
      where: { userId: sub.id },
      data: { status: "ACTIVE" },
    });

    // Self-cover can't happen.
    expect(
      (
        await assignStandinGuarded({
          matchId: match.id,
          standinUserId: homePlayer.id,
          replacingUserId: homePlayer.id,
          actingCaptainId: cap,
        })
      ).ok,
    ).toBe(false);

    // First assignment lands; the duplicate is refused.
    expect(
      (
        await assignStandinGuarded({
          matchId: match.id,
          standinUserId: sub.id,
          replacingUserId: homePlayer.id,
          actingCaptainId: cap,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await assignStandinGuarded({
          matchId: match.id,
          standinUserId: sub.id,
          replacingUserId: homePlayer.id,
          actingCaptainId: cap,
        })
      ).ok,
    ).toBe(false);

    // Completed matches are history.
    await prisma.match.update({
      where: { id: match.id },
      data: { status: MATCH_STATUS.COMPLETED },
    });
    const sub2 = await makeUser("Sub Two");
    await prisma.registration.create({
      data: {
        seasonId: match.seasonId,
        userId: sub2.id,
        type: "STANDIN",
        status: "ACTIVE",
        mmr: 3000,
      },
    });
    expect(
      (
        await assignStandinGuarded({
          matchId: match.id,
          standinUserId: sub2.id,
          replacingUserId: homePlayer.id,
          actingCaptainId: cap,
        })
      ).ok,
    ).toBe(false);
  });
});

describe("captain standin removal (integration)", () => {
  it("own team removes (with a stand-down announcement); the other captain can't", async () => {
    const { home, away, homePlayer, sub, match } = await setup();
    await assignStandinGuarded({
      matchId: match.id,
      standinUserId: sub.id,
      replacingUserId: homePlayer.id,
      actingCaptainId: home.captainId,
    });
    const row = await prisma.standinAssignment.findFirstOrThrow({
      where: { matchId: match.id },
    });

    const wrong = await removeStandinGuarded({
      assignmentId: row.id,
      actingCaptainId: away.captainId,
    });
    expect(wrong.ok).toBe(false);

    const res = await removeStandinGuarded({
      assignmentId: row.id,
      actingCaptainId: home.captainId,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.announcement).toContain("no longer standing in");
    expect(await prisma.standinAssignment.count()).toBe(0);
  });

  it("refuses removal once games are imported — the assignment is record", async () => {
    const { home, homePlayer, sub, match } = await setup();
    await assignStandinGuarded({
      matchId: match.id,
      standinUserId: sub.id,
      replacingUserId: homePlayer.id,
      actingCaptainId: home.captainId,
    });
    const row = await prisma.standinAssignment.findFirstOrThrow({
      where: { matchId: match.id },
    });
    await prisma.game.create({
      data: {
        matchId: match.id,
        dotaMatchId: "424242",
        radiantWin: true,
        winnerTeamId: home.id,
        players: "[]",
      },
    });
    const res = await removeStandinGuarded({
      assignmentId: row.id,
      actingCaptainId: home.captainId,
    });
    expect(res.ok).toBe(false);
    expect(await prisma.standinAssignment.count()).toBe(1);
  });
});

describe("standin guard hardening (review findings)", () => {
  it("one seat takes one standin — a second cover for the same player is refused", async () => {
    const { home, homePlayer, sub, match, season } = await setup();
    const subB = await makeUser("Sub Beth");
    await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: subB.id,
        type: "STANDIN",
        status: "ACTIVE",
        mmr: 2900,
      },
    });

    expect(
      (
        await assignStandinGuarded({
          matchId: match.id,
          standinUserId: sub.id,
          replacingUserId: homePlayer.id,
          actingCaptainId: home.captainId,
        })
      ).ok,
    ).toBe(true);

    const double = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: subB.id,
      replacingUserId: homePlayer.id,
      actingCaptainId: home.captainId,
    });
    expect(double.ok).toBe(false);
    if (!double.ok) expect(double.error).toContain("already covered");
    expect(await prisma.standinAssignment.count()).toBe(1);
  });

  it("refuses archived-season matches with a clear reason (not a misleading guard error)", async () => {
    const { home, homePlayer, sub, match, season } = await setup();
    // A new season supersedes the old one mid-flight (fat-finger / turnover).
    await prisma.season.update({
      where: { id: season.id },
      data: { isActive: false },
    });
    await makeSeason({ name: "Newer Season" });

    const res = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: sub.id,
      replacingUserId: homePlayer.id,
      actingCaptainId: home.captainId,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("archived season");
  });
});
