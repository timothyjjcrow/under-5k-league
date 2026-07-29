import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { MATCH_PHASE, MATCH_STATUS, SEASON_STATUS } from "@/lib/constants";
import {
  assignStandinGuarded,
  clashesAfterRetime,
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

  // Being told to turn up for a game is the most action-demanding message the
  // league sends. It has to MENTION the standin, not describe them in the
  // third person to a channel they may not be reading.
  it("mentions the standin — and nobody at all when they haven't linked", async () => {
    const { home, homePlayer, sub, match } = await setup();
    const unlinked = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: sub.id,
      replacingUserId: homePlayer.id,
      actingCaptainId: home.captainId,
    });
    expect(unlinked.ok && unlinked.mentions).toBeUndefined();

    await prisma.standinAssignment.deleteMany({ where: { matchId: match.id } });
    await prisma.user.update({
      where: { id: sub.id },
      data: { discordId: "700000000000000001" },
    });

    const linked = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: sub.id,
      replacingUserId: homePlayer.id,
      actingCaptainId: home.captainId,
    });
    expect(linked.ok && linked.mentions).toEqual({
      users: ["700000000000000001"],
    });
  });

  it("stand-down mentions them too — they were told to show up", async () => {
    const { home, homePlayer, sub, match } = await setup();
    await prisma.user.update({
      where: { id: sub.id },
      data: { discordId: "700000000000000002" },
    });
    await assignStandinGuarded({
      matchId: match.id,
      standinUserId: sub.id,
      replacingUserId: homePlayer.id,
      actingCaptainId: home.captainId,
    });
    const assignment = await prisma.standinAssignment.findFirstOrThrow({
      where: { matchId: match.id },
    });

    const res = await removeStandinGuarded({
      assignmentId: assignment.id,
      actingCaptainId: home.captainId,
    });
    expect(res.ok && res.mentions).toEqual({ users: ["700000000000000002"] });
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

    // Rostered player can't stand in. The rostered fixtures are bare Users
    // with no Registration, so without this row the call is rejected by the
    // "no active signup" guard and never reaches the roster guard the
    // assertion names — it passed with the roster check deleted. Give them a
    // real ACTIVE signup and assert the REASON, not just the refusal.
    await prisma.registration.create({
      data: {
        seasonId: match.seasonId,
        userId: awayPlayer.id,
        type: "PLAYER",
        status: "ACTIVE",
        mmr: 3000,
      },
    });
    const rostered = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: awayPlayer.id,
      replacingUserId: homePlayer.id,
      actingCaptainId: cap,
    });
    expect(rostered.ok).toBe(false);
    expect(!rostered.ok && rostered.error).toMatch(/on a roster/i);

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

// One person cannot play two lobbies at once. The per-MATCH duplicate check
// only ever asked "is this standin already in THIS match", so the same person
// could be booked for two fixtures kicking off at the same minute — which is
// what happens the first time a captain and an admin both go looking for cover
// on the same league night.
describe("a standin can't cover two matches the same night", () => {
  async function twoNights() {
    const base = await setup();
    const other = await prisma.match.create({
      data: {
        seasonId: base.season.id,
        week: 1,
        phase: MATCH_PHASE.REGULAR,
        // Reversed fixture, same kickoff — a real double round-robin week.
        homeTeamId: base.away.id,
        awayTeamId: base.home.id,
        scheduledAt: base.match.scheduledAt,
      },
    });
    return { ...base, other };
  }

  it("refuses the second booking and names the clash", async () => {
    const { home, away, homePlayer, awayPlayer, sub, match, other } =
      await twoNights();

    const first = await assignStandinGuarded({
      matchId: other.id,
      standinUserId: sub.id,
      replacingUserId: awayPlayer.id,
      actingCaptainId: away.captainId,
    });
    expect(first.ok).toBe(true);

    const second = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: sub.id,
      replacingUserId: homePlayer.id,
      actingCaptainId: home.captainId,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toContain("Sub Sam");
    expect(second.error).toMatch(/can't play both/);
    // And nothing was written.
    expect(
      await prisma.standinAssignment.count({ where: { matchId: match.id } }),
    ).toBe(0);
  });

  it("allows cover on a genuinely different night", async () => {
    const { home, away, homePlayer, awayPlayer, sub, match, other } =
      await twoNights();
    await prisma.match.update({
      where: { id: other.id },
      data: {
        week: 2,
        scheduledAt: new Date(match.scheduledAt!.getTime() + 7 * 86_400_000),
      },
    });

    await assignStandinGuarded({
      matchId: other.id,
      standinUserId: sub.id,
      replacingUserId: awayPlayer.id,
      actingCaptainId: away.captainId,
    });
    const second = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: sub.id,
      replacingUserId: homePlayer.id,
      actingCaptainId: home.captainId,
    });
    expect(second.ok).toBe(true);
  });

  it("ignores cover on a match that's already been played", async () => {
    const { home, away, homePlayer, awayPlayer, sub, match, other } =
      await twoNights();
    await assignStandinGuarded({
      matchId: other.id,
      standinUserId: sub.id,
      replacingUserId: awayPlayer.id,
      actingCaptainId: away.captainId,
    });
    await prisma.match.update({
      where: { id: other.id },
      data: { status: MATCH_STATUS.COMPLETED },
    });

    const second = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: sub.id,
      replacingUserId: homePlayer.id,
      actingCaptainId: home.captainId,
    });
    expect(second.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// EMPTY-SEAT COVER. `matchNightRoster` has always kept a null-replacement
// assignment (it adds a player without removing one) and CLAUDE.md documented
// it as working — but nothing could ever CREATE one, because replacingUserId
// was typed `string` and refused empty. So the roster state that most needs
// cover, a team a player short, was the one state with no way to arrange it.
// ---------------------------------------------------------------------------
describe("a standin can fill an EMPTY seat on a short roster", () => {
  it("assigns with no replaced player and stores a null replacingUserId", async () => {
    // teamSize 3, Home has 1 rostered player → 2 open seats.
    const { season, home, sub, match } = await setup();
    await prisma.season.update({
      where: { id: season.id },
      data: { teamSize: 3 },
    });

    const res = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: sub.id,
      replacingUserId: null,
      teamId: home.id,
      actingCaptainId: null,
    });

    expect(res.ok).toBe(true);
    const row = await prisma.standinAssignment.findFirstOrThrow({
      where: { matchId: match.id },
    });
    expect(row.replacingUserId).toBeNull();
    expect(row.teamId).toBe(home.id);
    // The announcement must not read "stands in for nobody".
    expect(res.ok && res.announcement).toMatch(/fills an open roster seat/i);
  });

  it("refuses when the roster is already full — that seat is imaginary", async () => {
    // Nobody is removed to make room for an empty-seat standin, so filling a
    // full roster's seat puts SIX players on the side and feeds straight into
    // /schedule, the dashboard strip and the import account sets.
    const { season, home, sub, match } = await setup();
    await prisma.season.update({
      where: { id: season.id },
      data: { teamSize: 1 },
    });

    const res = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: sub.id,
      replacingUserId: null,
      teamId: home.id,
      actingCaptainId: null,
    });

    expect(res).toMatchObject({ ok: false });
    expect(!res.ok && res.error).toMatch(/full roster/i);
  });

  it("allows only as many empty-seat standins as there are open seats", async () => {
    const { season, home, sub, match } = await setup();
    await prisma.season.update({
      where: { id: season.id },
      data: { teamSize: 2 }, // Home has 1 → exactly 1 open seat
    });
    const second = await makeUser("Sub Two");
    await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: second.id,
        type: "STANDIN",
        status: "ACTIVE",
        mmr: 3000,
      },
    });

    const first = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: sub.id,
      replacingUserId: null,
      teamId: home.id,
      actingCaptainId: null,
    });
    const overflow = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: second.id,
      replacingUserId: null,
      teamId: home.id,
      actingCaptainId: null,
    });

    expect(first.ok).toBe(true);
    expect(overflow).toMatchObject({ ok: false });
    expect(!overflow.ok && overflow.error).toMatch(/already covered/i);
    expect(
      await prisma.standinAssignment.count({ where: { matchId: match.id } }),
    ).toBe(1);
  });

  it("refuses a team that isn't in this match", async () => {
    const { season, sub, match } = await setup();
    const stranger = await makeTeam(season.id, "Stranger", 2);
    await prisma.season.update({
      where: { id: season.id },
      data: { teamSize: 5 },
    });

    const res = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: sub.id,
      replacingUserId: null,
      teamId: stranger.id,
      actingCaptainId: null,
    });

    expect(res).toMatchObject({ ok: false });
    expect(!res.ok && res.error).toMatch(/isn't in this match/i);
  });

  it("still enforces the captain-owns-the-team rule with no replaced player", async () => {
    // With no replaced player there is no roster to infer ownership from, so
    // the teamId is caller-supplied — the check has to hold on it directly.
    const { season, home, away, sub, match } = await setup();
    await prisma.season.update({
      where: { id: season.id },
      data: { teamSize: 3 },
    });
    const awayTeam = await prisma.team.findUniqueOrThrow({
      where: { id: away.id },
    });

    const res = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: sub.id,
      replacingUserId: null,
      teamId: home.id,
      actingCaptainId: awayTeam.captainId, // the OTHER team's captain
    });

    expect(res).toMatchObject({ ok: false });
    expect(!res.ok && res.error).toMatch(/captain/i);
  });

  it("needs either a covered player or a team — not neither", async () => {
    const { sub, match } = await setup();
    const res = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: sub.id,
      replacingUserId: null,
      actingCaptainId: null,
    });
    expect(res).toMatchObject({ ok: false });
    expect(!res.ok && res.error).toMatch(/team whose seat/i);
  });
});

// ---------------------------------------------------------------------------
// RETIME CLASHES. standinConflict was consulted only when cover was arranged.
// Every retime path then moved a fixture onto a night the standin was already
// booked for, and nothing re-checked or displayed it — so the same person was
// silently booked for two games at the same minute, invisible on every surface
// right up to kickoff. Reported rather than refused: the retime is legitimate.
// ---------------------------------------------------------------------------
describe("clashesAfterRetime", () => {
  /** Two matches on different nights, the same standin covering both. */
  async function doubleBooked() {
    const { season, home, away, homePlayer, awayPlayer, sub, match } =
      await setup();
    const other = await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 2,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: away.id,
        awayTeamId: home.id,
        // A week later — no clash at assign time.
        scheduledAt: new Date(Date.now() + 7 * 864e5),
      },
    });
    await prisma.standinAssignment.create({
      data: {
        matchId: match.id,
        teamId: home.id,
        standinUserId: sub.id,
        replacingUserId: homePlayer.id,
      },
    });
    await prisma.standinAssignment.create({
      data: {
        matchId: other.id,
        teamId: away.id,
        standinUserId: sub.id,
        replacingUserId: awayPlayer.id,
      },
    });
    return { season, match, other };
  }

  it("reports nothing while the two matches are on different nights", async () => {
    const { season, other } = await doubleBooked();
    expect(await clashesAfterRetime(season.id, [other.id])).toEqual([]);
  });

  it("names the standin once the retime puts both games the same night", async () => {
    const { season, match, other } = await doubleBooked();
    // Move the second match onto the first one's night — the exact thing no
    // path re-checked.
    await prisma.match.update({
      where: { id: other.id },
      data: { scheduledAt: match.scheduledAt },
    });

    const clashes = await clashesAfterRetime(season.id, [other.id]);

    expect(clashes).toHaveLength(1);
    expect(clashes[0]).toContain("Sub Sam");
    expect(clashes[0]).toMatch(/covers both/i);
  });

  it("reports one line per clashing pair, not one per direction", async () => {
    // Passing BOTH retimed matches must not double-report the same conflict.
    const { season, match, other } = await doubleBooked();
    await prisma.match.update({
      where: { id: other.id },
      data: { scheduledAt: match.scheduledAt },
    });

    expect(await clashesAfterRetime(season.id, [match.id, other.id])).toHaveLength(1);
  });

  it("ignores cover on a match that has already been played", async () => {
    // That cover is history — findClashingCover excludes COMPLETED.
    const { season, match, other } = await doubleBooked();
    await prisma.match.update({
      where: { id: other.id },
      data: { scheduledAt: match.scheduledAt, status: MATCH_STATUS.COMPLETED },
    });

    expect(await clashesAfterRetime(season.id, [match.id])).toEqual([]);
  });

  it("is a no-op for an empty match list", async () => {
    const { season } = await doubleBooked();
    expect(await clashesAfterRetime(season.id, [])).toEqual([]);
  });
});
