import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createPlayoffBracket } from "@/lib/playoff-service";
import {
  DRAFT_STATUS,
  MATCH_PHASE,
  MATCH_STATUS,
  SEASON_STATUS,
} from "@/lib/constants";
import {
  approveStandinRequest,
  assignStandinGuarded,
  cancelStandinRequest,
  clashesAfterRetime,
  declineStandinRequest,
  removeStandinGuarded,
} from "@/lib/standin-service";
import { STANDIN_MMR_ALLOWANCE } from "@/lib/standin";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import { makeSeason, makeTeam, makeUser } from "./factories";

// Captain self-serve standins: the guards that used to live admin-only now
// gate both paths — with actingCaptainId null (admin) or the captain's id
// (must own the covered team). The reschedule-service testing pattern.

async function setup() {
  const season = await makeSeason({ status: SEASON_STATUS.REGULAR_SEASON });
  const home = await makeTeam(season.id, "Home", 0);
  const away = await makeTeam(season.id, "Away", 1);

  // Rostered players carry a signup, as every drafted player does: its MMR is
  // what the standin MMR rule measures cover against. Level with Sub Sam's,
  // so a captain's booking locks in unless a test moves one of them.
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
    await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: user.id,
        type: "PLAYER",
        status: "ACTIVE",
        mmr: 3200,
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

  // The captain was the one told to line up cover (the OUT ping). When an
  // ADMIN books or cancels it, the captain hears it's handled (or open again);
  // a captain acting on their own team isn't pinged about their own click.
  it("an admin's cover change also mentions the covered team's captain", async () => {
    const { home, homePlayer, sub, match } = await setup();
    await prisma.user.update({
      where: { id: sub.id },
      data: { discordId: "700000000000000003" },
    });
    await prisma.user.update({
      where: { id: home.captainId },
      data: { discordId: "700000000000000004" },
    });
    const admin = await makeUser("League Admin", "ADMIN");

    const assigned = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: sub.id,
      replacingUserId: homePlayer.id,
      actingCaptainId: null,
      actingUserId: admin.id,
    });
    expect(assigned.ok && assigned.mentions).toEqual({
      users: ["700000000000000003", "700000000000000004"],
    });

    const row = await prisma.standinAssignment.findFirstOrThrow({
      where: { matchId: match.id },
    });
    const removed = await removeStandinGuarded({
      assignmentId: row.id,
      actingCaptainId: null,
      actingUserId: admin.id,
    });
    expect(removed.ok && removed.mentions).toEqual({
      users: ["700000000000000003", "700000000000000004"],
    });
    expect(removed.ok && removed.announcement).toMatch(
      /stand down \(an admin cancelled the booking\)\.$/,
    );
  });

  it("a captain's own cover change doesn't ping them, even through the admin override", async () => {
    const { home, homePlayer, sub, match } = await setup();
    await prisma.user.update({
      where: { id: home.captainId },
      data: { discordId: "700000000000000005" },
    });
    // An admin who captains the team uses the override path (actingCaptainId
    // null) but is still the captain acting on their own team.
    const assigned = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: sub.id,
      replacingUserId: homePlayer.id,
      actingCaptainId: null,
      actingUserId: home.captainId,
    });
    expect(assigned.ok && assigned.mentions).toBeUndefined();

    const row = await prisma.standinAssignment.findFirstOrThrow({
      where: { matchId: match.id },
    });
    const removed = await removeStandinGuarded({
      assignmentId: row.id,
      actingCaptainId: home.captainId,
      actingUserId: home.captainId,
    });
    expect(removed.ok && removed.mentions).toBeUndefined();
    expect(removed.ok && removed.announcement).toMatch(
      /stand down \(the team's captain cancelled the booking\)\.$/,
    );
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

    // Rostered player can't stand in. The rostered fixtures carry a real
    // ACTIVE signup (setup), so the call gets past the "no active signup"
    // guard to the roster guard the assertion names — without one it passed
    // with the roster check deleted. Assert the REASON, not just the refusal.
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

    expect(
      await clashesAfterRetime(season.id, [match.id, other.id]),
    ).toHaveLength(1);
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

describe("bulk teardowns stand their standins down", () => {
  // StandinAssignment cascades from Match, so a playoff RESET and a schedule
  // REGENERATE both delete bookings wholesale. Every ordinary removal path
  // sends standinRemovedMessage; these two dropped a live @-mentioned
  // instruction to turn up for a fixture that no longer exists, in silence.
  async function bookedStandin(
    seasonId: string,
    matchId: string,
    teamId: string,
  ) {
    const standin = await makeUser("Doomed Cover");
    await prisma.user.update({
      where: { id: standin.id },
      data: { discordId: "123123123123123123" },
    });
    await prisma.registration.create({
      data: {
        seasonId,
        userId: standin.id,
        type: "STANDIN",
        status: "ACTIVE",
        mmr: 2500,
      },
    });
    await prisma.standinAssignment.create({
      data: {
        matchId,
        teamId,
        standinUserId: standin.id,
        replacingUserId: null,
      },
    });
    return standin;
  }

  it("a playoff reset tells the standins their match is gone", async () => {
    const season = await makeSeason({ status: "PLAYOFFS", teamSize: 3 });
    const a = await makeTeam(season.id, "Alpha", 0);
    const b = await makeTeam(season.id, "Bravo", 1);
    await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 1,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: a.id,
        awayTeamId: b.id,
        status: MATCH_STATUS.COMPLETED,
        homeScore: 2,
        winnerTeamId: a.id,
      },
    });
    const final = await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 5,
        phase: "FINAL",
        homeTeamId: a.id,
        awayTeamId: b.id,
        bracketSlot: "R0M0",
        bestOf: 3,
      },
    });
    const standin = await bookedStandin(season.id, final.id, a.id);

    const { standDowns } = await createPlayoffBracket(season.id);

    expect(standDowns).toHaveLength(1);
    expect(standDowns[0]).toMatchObject({
      standinName: standin.name,
      discordId: "123123123123123123",
      teamId: a.id,
    });
    // The service returns display data only; the ACTION supplies isPlayoff
    // and does the sending, so a webhook failure can't touch the teardown.
    expect(standDowns[0]).not.toHaveProperty("isPlayoff");
    // …and the booking really is gone with its match.
    expect(
      await prisma.standinAssignment.count({
        where: { standinUserId: standin.id },
      }),
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PHASE GATE. Cover is a statement about a SETTLED roster: SIGNUPS and a
// running auction refuse (a booking made there would survive into whatever the
// draft produces — the re-run-auction case, where a stale empty-seat cover
// inflates a freshly drafted side to six), COMPLETE has nothing left to cover,
// and the one DRAFT-phase window that stays open is draft COMPLETE — pool-dry
// short rosters arranging their week-1 cover. Judged AFTER the archived and
// completed-match refusals so the more specific error always wins.
// ---------------------------------------------------------------------------
describe("standin assignment phase gate", () => {
  // Pins the SIGNUPS refusal — and that the error points at running the draft.
  it("refuses during SIGNUPS", async () => {
    const { season, home, homePlayer, sub, match } = await setup();
    await prisma.season.update({
      where: { id: season.id },
      data: { status: SEASON_STATUS.SIGNUPS },
    });
    const res = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: sub.id,
      replacingUserId: homePlayer.id,
      actingCaptainId: home.captainId,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/run the draft/);
    expect(await prisma.standinAssignment.count()).toBe(0);
  });

  // Pins the DRAFT-phase no-draft-row branch: the phase was flipped by hand
  // and no auction exists at all, so there are no drafted rosters to cover.
  it("refuses in DRAFT before any auction exists", async () => {
    const { season, home, homePlayer, sub, match } = await setup();
    await prisma.season.update({
      where: { id: season.id },
      data: { status: SEASON_STATUS.DRAFT },
    });
    const res = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: sub.id,
      replacingUserId: homePlayer.id,
      actingCaptainId: home.captainId,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/auction hasn't run/);
  });

  // Pins the DRAFT-phase draft-row branch: a draft ROW in any status short of
  // COMPLETE refuses — the wording keys on the row's existence, so NOT_STARTED
  // (phase flipped pre-start) and IN_PROGRESS both read as a draft in flight.
  it("refuses while the draft row is NOT_STARTED or IN_PROGRESS", async () => {
    const { season, home, homePlayer, sub, match } = await setup();
    await prisma.season.update({
      where: { id: season.id },
      data: { status: SEASON_STATUS.DRAFT },
    });
    await prisma.draft.create({
      data: { seasonId: season.id, status: DRAFT_STATUS.NOT_STARTED },
    });
    const args = {
      matchId: match.id,
      standinUserId: sub.id,
      replacingUserId: homePlayer.id,
      actingCaptainId: home.captainId,
    };
    // A NOT_STARTED row is the post-abort state — "hasn't run yet", never
    // "still running" (there is no auction to wait out).
    const preStart = await assignStandinGuarded(args);
    expect(preStart.ok).toBe(false);
    if (!preStart.ok) expect(preStart.error).toMatch(/auction hasn't run/);

    await prisma.draft.update({
      where: { seasonId: season.id },
      data: { status: DRAFT_STATUS.IN_PROGRESS },
    });
    const live = await assignStandinGuarded(args);
    expect(live.ok).toBe(false);
    if (!live.ok) expect(live.error).toMatch(/draft is still running/);
    expect(await prisma.standinAssignment.count()).toBe(0);
  });

  // Pins the pool-dry cover window: DRAFT phase with the auction COMPLETE is
  // exactly when a short roster arranges its week-1 cover — it must ALLOW.
  it("allows in DRAFT once the auction is COMPLETE", async () => {
    const { season, home, homePlayer, sub, match } = await setup();
    await prisma.season.update({
      where: { id: season.id },
      data: { status: SEASON_STATUS.DRAFT },
    });
    await prisma.draft.create({
      data: { seasonId: season.id, status: DRAFT_STATUS.COMPLETE },
    });
    const res = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: sub.id,
      replacingUserId: homePlayer.id,
      actingCaptainId: home.captainId,
    });
    expect(res.ok).toBe(true);
    const row = await prisma.standinAssignment.findFirstOrThrow({
      where: { matchId: match.id },
    });
    expect(row.teamId).toBe(home.id);
  });

  // Pins the COMPLETE refusal — the season is over, nothing left to cover.
  it("refuses once the season is COMPLETE", async () => {
    const { season, home, homePlayer, sub, match } = await setup();
    await prisma.season.update({
      where: { id: season.id },
      data: { status: SEASON_STATUS.COMPLETE },
    });
    const res = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: sub.id,
      replacingUserId: homePlayer.id,
      actingCaptainId: home.captainId,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/season is over/);
  });

  // Pins the guard ORDER: the completed-match refusal sits BEFORE the phase
  // gate, so a played match on a finished season blames the match, not the
  // season — the more specific refusal wins.
  it("a played match's refusal wins over the phase gate", async () => {
    const { season, home, homePlayer, sub, match } = await setup();
    await prisma.season.update({
      where: { id: season.id },
      data: { status: SEASON_STATUS.COMPLETE },
    });
    await prisma.match.update({
      where: { id: match.id },
      data: { status: MATCH_STATUS.COMPLETED },
    });
    const res = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: sub.id,
      replacingUserId: homePlayer.id,
      actingCaptainId: home.captainId,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("already played");
      expect(res.error).not.toContain("season is over");
    }
  });

  // Pins the guard ORDER on the archived side: an archived season's match
  // refuses as "archived season" even while the ACTIVE season sits in SIGNUPS
  // — hoisting the phase gate above the archived check would shadow it with
  // the misleading run-the-draft error.
  it("the archived-season refusal wins while the active season is in SIGNUPS", async () => {
    const { season, home, homePlayer, sub, match } = await setup();
    await prisma.season.update({
      where: { id: season.id },
      data: { isActive: false },
    });
    await makeSeason({ name: "Signups Season", status: SEASON_STATUS.SIGNUPS });

    const res = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: sub.id,
      replacingUserId: homePlayer.id,
      actingCaptainId: home.captainId,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("archived season");
      expect(res.error).not.toMatch(/run the draft/);
    }
  });
});

// ---------------------------------------------------------------------------
// THE STANDIN MMR RULE (Tim, 2026-10-21). A captain books a standin up to
// STANDIN_MMR_ALLOWANCE above the seat; past it, or with an unknown MMR, the
// booking becomes a StandinRequest the OTHER captain agrees to or declines.
// The admin panel books over the rule. setup() puts Sub Sam and both rostered
// players at 3200.
// ---------------------------------------------------------------------------
describe("standin MMR rule", () => {
  async function setSubMmr(userId: string, mmr: number) {
    await prisma.registration.updateMany({ where: { userId }, data: { mmr } });
  }

  /** setup(), with Sub Sam over the allowance and both captains linked. */
  async function overTheLine() {
    const fx = await setup();
    await setSubMmr(fx.sub.id, 3200 + STANDIN_MMR_ALLOWANCE + 1);
    await prisma.user.update({
      where: { id: fx.home.captainId },
      data: { discordId: "700000000000000011" },
    });
    await prisma.user.update({
      where: { id: fx.away.captainId },
      data: { discordId: "700000000000000022" },
    });
    await prisma.user.update({
      where: { id: fx.sub.id },
      data: { discordId: "700000000000000033" },
    });
    return fx;
  }

  async function ask(fx: Awaited<ReturnType<typeof overTheLine>>) {
    const res = await assignStandinGuarded({
      matchId: fx.match.id,
      standinUserId: fx.sub.id,
      replacingUserId: fx.homePlayer.id,
      actingCaptainId: fx.home.captainId,
    });
    expect(res.ok && res.pending).toBe(true);
    return prisma.standinRequest.findFirstOrThrow({
      where: { matchId: fx.match.id },
    });
  }

  it("a captain books a standin up to the allowance above straight away", async () => {
    const { home, homePlayer, sub, match } = await setup();
    await setSubMmr(sub.id, 3200 + STANDIN_MMR_ALLOWANCE);
    const res = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: sub.id,
      replacingUserId: homePlayer.id,
      actingCaptainId: home.captainId,
    });
    expect(res.ok && res.pending).toBeFalsy();
    expect(await prisma.standinAssignment.count()).toBe(1);
    expect(await prisma.standinRequest.count()).toBe(0);
  });

  it("past it, the captain's booking waits for the other captain, who alone is pinged", async () => {
    const fx = await overTheLine();
    const res = await assignStandinGuarded({
      matchId: fx.match.id,
      standinUserId: fx.sub.id,
      replacingUserId: fx.homePlayer.id,
      actingCaptainId: fx.home.captainId,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.pending).toBe(true);
    // Nothing is booked: no cover until the other captain agrees.
    expect(await prisma.standinAssignment.count()).toBe(0);
    const request = await prisma.standinRequest.findFirstOrThrow();
    expect(request).toMatchObject({
      status: "PENDING",
      teamId: fx.home.id,
      standinUserId: fx.sub.id,
      replacingUserId: fx.homePlayer.id,
      requestedById: fx.home.captainId,
      standinMmr: 3301,
      baselineMmr: 3200,
    });
    // The other captain must act; the standin isn't booked yet.
    expect(res.mentions).toEqual({ users: ["700000000000000022"] });
    expect(res.reachUserId).toBe(fx.away.captainId);
    expect(res.announcement).toContain("The **Away** captain has to agree first");
    expect(res.announcement).toContain("101 MMR above the player they cover");
    expect(res.message).toContain("Asked Away Captain (the Away captain) to agree");
  });

  it("an admin's booking from the panel books over the rule, and says so", async () => {
    const { homePlayer, sub, match } = await setup();
    await setSubMmr(sub.id, 4900);
    const res = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: sub.id,
      replacingUserId: homePlayer.id,
      actingCaptainId: null,
    });
    expect(res.ok && res.pending).toBeFalsy();
    if (res.ok) {
      expect(res.message).toContain(
        "booked over the standin MMR rule (the standin is 1,700 MMR above the player they cover)",
      );
      expect(res.summary).toContain("without the other captain's OK");
    }
    expect(await prisma.standinAssignment.count()).toBe(1);
  });

  // The captain's card asks even when its captain is an admin (who reaches
  // the service with actingCaptainId null): only the panel rules over it.
  it("overLimit: ask files a request even for an admin", async () => {
    const { home, homePlayer, sub, match } = await setup();
    await setSubMmr(sub.id, 4900);
    const res = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: sub.id,
      replacingUserId: homePlayer.id,
      actingCaptainId: null,
      actingUserId: home.captainId,
      overLimit: "ask",
    });
    expect(res.ok && res.pending).toBe(true);
    expect(await prisma.standinAssignment.count()).toBe(0);
  });

  it("the other captain agrees: the standin is booked and both hear it", async () => {
    const fx = await overTheLine();
    const request = await ask(fx);
    const res = await approveStandinRequest({
      requestId: request.id,
      actingCaptainId: fx.away.captainId,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const booking = await prisma.standinAssignment.findFirstOrThrow();
    expect(booking).toMatchObject({
      teamId: fx.home.id,
      standinUserId: fx.sub.id,
      replacingUserId: fx.homePlayer.id,
    });
    const after = await prisma.standinRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(after.status).toBe("APPROVED");
    expect(after.decidedById).toBe(fx.away.captainId);
    expect(after.decidedAt).not.toBeNull();
    // The standin learns it's their night; the asking captain that it went through.
    expect(res.mentions).toEqual({
      users: ["700000000000000033", "700000000000000011"],
    });
    expect(res.announcement).toContain("**Away Captain** agreed to it.");
  });

  it("only the other team's captain (or an admin) can agree", async () => {
    const fx = await overTheLine();
    const request = await ask(fx);
    for (const actingCaptainId of [fx.home.captainId, fx.sub.id]) {
      const res = await approveStandinRequest({
        requestId: request.id,
        actingCaptainId,
      });
      expect(!res.ok && res.error).toBe(
        "Only the Away captain (or an admin) can agree to this standin",
      );
    }
    expect(await prisma.standinAssignment.count()).toBe(0);
    const admin = await approveStandinRequest({
      requestId: request.id,
      actingCaptainId: null,
    });
    expect(admin.ok).toBe(true);
    if (admin.ok) expect(admin.announcement).toContain("An admin agreed to it.");
    expect(await prisma.standinAssignment.count()).toBe(1);
  });

  it("the other captain declines: nothing is booked and the asking captain is told", async () => {
    const fx = await overTheLine();
    const request = await ask(fx);
    const wrong = await declineStandinRequest({
      requestId: request.id,
      actingCaptainId: fx.home.captainId,
    });
    expect(wrong.ok).toBe(false);
    const res = await declineStandinRequest({
      requestId: request.id,
      actingCaptainId: fx.away.captainId,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.mentions).toEqual({ users: ["700000000000000011"] });
      expect(res.announcement).toContain("**Away Captain** didn't agree to **Sub Sam**");
    }
    expect(await prisma.standinAssignment.count()).toBe(0);
    expect(
      (await prisma.standinRequest.findUniqueOrThrow({ where: { id: request.id } }))
        .status,
    ).toBe("DECLINED");
  });

  it("the asking captain withdraws; the other captain can't, and nobody is pinged", async () => {
    const fx = await overTheLine();
    const request = await ask(fx);
    const wrong = await cancelStandinRequest({
      requestId: request.id,
      actingCaptainId: fx.away.captainId,
    });
    expect(!wrong.ok && wrong.error).toBe(
      "Only the Home captain (or an admin) can withdraw this request",
    );
    const res = await cancelStandinRequest({
      requestId: request.id,
      actingCaptainId: fx.home.captainId,
    });
    expect(res.ok && res.announcement).toBe("");
    expect(
      (await prisma.standinRequest.findUniqueOrThrow({ where: { id: request.id } }))
        .status,
    ).toBe("CANCELLED");
  });

  it("a waiting request holds its seat and its standin until it's answered", async () => {
    const fx = await overTheLine();
    const request = await ask(fx);
    const other = await makeUser("Sub Tara");
    await prisma.registration.create({
      data: {
        seasonId: fx.season.id,
        userId: other.id,
        type: "STANDIN",
        status: "ACTIVE",
        mmr: 3000,
      },
    });
    // Someone within the allowance for the same seat: refused, not booked.
    const sameSeat = await assignStandinGuarded({
      matchId: fx.match.id,
      standinUserId: other.id,
      replacingUserId: fx.homePlayer.id,
      actingCaptainId: fx.home.captainId,
    });
    expect(!sameSeat.ok && sameSeat.error).toBe(
      "Home Carry's seat is waiting for the other captain's OK on Sub Sam — that request has to be answered or cancelled first",
    );
    // The same standin for the other side's seat: refused too (an admin's).
    const sameStandin = await assignStandinGuarded({
      matchId: fx.match.id,
      standinUserId: fx.sub.id,
      replacingUserId: fx.awayPlayer.id,
      actingCaptainId: null,
    });
    expect(!sameStandin.ok && sameStandin.error).toMatch(
      /already waiting for the other captain's OK in this match/,
    );
    expect(await prisma.standinAssignment.count()).toBe(0);
    // Withdrawn, the seat is free again.
    await cancelStandinRequest({
      requestId: request.id,
      actingCaptainId: fx.home.captainId,
    });
    const after = await assignStandinGuarded({
      matchId: fx.match.id,
      standinUserId: other.id,
      replacingUserId: fx.homePlayer.id,
      actingCaptainId: fx.home.captainId,
    });
    expect(after.ok && after.pending).toBeFalsy();
    expect(await prisma.standinAssignment.count()).toBe(1);
  });

  it("an empty seat counts as covering the team's lowest-MMR player", async () => {
    const { season, home, homePlayer, sub, match } = await setup();
    const low = await makeUser("Home Support");
    await prisma.teamMember.create({
      data: { seasonId: season.id, teamId: home.id, userId: low.id, price: 1 },
    });
    await prisma.registration.create({
      data: { seasonId: season.id, userId: low.id, mmr: 2000 },
    });
    expect(homePlayer).toBeTruthy(); // 3200 on the same roster
    await setSubMmr(sub.id, 2000 + STANDIN_MMR_ALLOWANCE);
    const fills = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: sub.id,
      replacingUserId: null,
      teamId: home.id,
      actingCaptainId: home.captainId,
    });
    expect(fills.ok && fills.pending).toBeFalsy();
    await prisma.standinAssignment.deleteMany();
    await setSubMmr(sub.id, 2000 + STANDIN_MMR_ALLOWANCE + 1);
    const asks = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: sub.id,
      replacingUserId: null,
      teamId: home.id,
      actingCaptainId: home.captainId,
    });
    expect(asks.ok && asks.pending).toBe(true);
    expect(await prisma.standinRequest.findFirstOrThrow()).toMatchObject({
      replacingUserId: null,
      baselineMmr: 2000,
    });
  });

  it("an unknown MMR on either side goes to the other captain", async () => {
    const { season, home, homePlayer, sub, match } = await setup();
    await setSubMmr(sub.id, 0);
    const unknownStandin = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: sub.id,
      replacingUserId: homePlayer.id,
      actingCaptainId: home.captainId,
    });
    expect(unknownStandin.ok && unknownStandin.pending).toBe(true);
    if (unknownStandin.ok)
      expect(unknownStandin.announcement).toContain("since the standin's MMR is unknown");
    await prisma.standinRequest.deleteMany();
    await setSubMmr(sub.id, 3200);
    await prisma.registration.update({
      where: { seasonId_userId: { seasonId: season.id, userId: homePlayer.id } },
      data: { mmr: 0 },
    });
    const unknownSeat = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: sub.id,
      replacingUserId: homePlayer.id,
      actingCaptainId: home.captainId,
    });
    expect(unknownSeat.ok && unknownSeat.pending).toBe(true);
    expect(await prisma.standinRequest.findFirstOrThrow()).toMatchObject({
      baselineMmr: null,
    });
  });

  it("agreeing runs every booking check again, and a failure books nothing", async () => {
    const fx = await overTheLine();
    const request = await ask(fx);
    await prisma.match.update({
      where: { id: fx.match.id },
      data: { status: "COMPLETED" },
    });
    const res = await approveStandinRequest({
      requestId: request.id,
      actingCaptainId: fx.away.captainId,
    });
    expect(!res.ok && res.error).toBe("This match is already played");
    expect(await prisma.standinAssignment.count()).toBe(0);
    expect(
      (await prisma.standinRequest.findUniqueOrThrow({ where: { id: request.id } }))
        .status,
    ).toBe("PENDING");
  });

  // Past the claim, a failed re-check must THROW: a resolved callback would
  // commit the APPROVED status with nobody booked. The seam lets the standin
  // withdraw between the read-time checks and the transaction.
  it("a standin who withdraws as it's agreed leaves the request waiting, not approved", async () => {
    const fx = await overTheLine();
    const request = await ask(fx);
    let fired = false;
    setRaceHook(
      onceAt("standin.approveRequest.beforeTx", async () => {
        fired = true;
        await prisma.registration.updateMany({
          where: { userId: fx.sub.id },
          data: { status: "WITHDRAWN" },
        });
      }),
    );
    try {
      const res = await approveStandinRequest({
        requestId: request.id,
        actingCaptainId: fx.away.captainId,
      });
      expect(!res.ok && res.error).toBe(
        "That standin has no active signup this season",
      );
    } finally {
      setRaceHook(null);
    }
    expect(fired).toBe(true);
    expect(await prisma.standinAssignment.count()).toBe(0);
    expect(
      (await prisma.standinRequest.findUniqueOrThrow({ where: { id: request.id } }))
        .status,
    ).toBe("PENDING");
  });

  // The claims. The approve claim sits behind a read-time status check, so
  // the seam closes the request after that check: only the claim's WHERE
  // (status PENDING) can stop the booking then.
  it("an agree that loses to a withdrawal books nobody", async () => {
    const fx = await overTheLine();
    const request = await ask(fx);
    let fired = false;
    setRaceHook(
      onceAt("standin.approveRequest.beforeTx", async () => {
        fired = true;
        const cancelled = await cancelStandinRequest({
          requestId: request.id,
          actingCaptainId: fx.home.captainId,
        });
        expect(cancelled.ok).toBe(true);
      }),
    );
    try {
      const res = await approveStandinRequest({
        requestId: request.id,
        actingCaptainId: fx.away.captainId,
      });
      expect(!res.ok && res.error).toMatch(/just answered or withdrawn/);
    } finally {
      setRaceHook(null);
    }
    expect(fired).toBe(true);
    expect(await prisma.standinAssignment.count()).toBe(0);
    expect(
      (await prisma.standinRequest.findUniqueOrThrow({ where: { id: request.id } }))
        .status,
    ).toBe("CANCELLED");
  });

  // Decline and withdraw read no status before their claim, so a request
  // already answered reaches the WHERE, which alone refuses it.
  it("an answered request can't be declined or withdrawn after all", async () => {
    const fx = await overTheLine();
    const request = await ask(fx);
    expect(
      (
        await approveStandinRequest({
          requestId: request.id,
          actingCaptainId: fx.away.captainId,
        })
      ).ok,
    ).toBe(true);
    const declined = await declineStandinRequest({
      requestId: request.id,
      actingCaptainId: fx.away.captainId,
    });
    expect(!declined.ok && declined.error).toBe(
      "That request was already agreed to — the standin is booked",
    );
    const withdrawn = await cancelStandinRequest({
      requestId: request.id,
      actingCaptainId: fx.home.captainId,
    });
    expect(!withdrawn.ok && withdrawn.error).toBe(
      "That request was already agreed to — the standin is booked",
    );
    const after = await prisma.standinRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(after.status).toBe("APPROVED");
    expect(after.decidedById).toBe(fx.away.captainId);
  });

  it("a declined request can't be withdrawn, agreed to or declined again", async () => {
    const fx = await overTheLine();
    const request = await ask(fx);
    await declineStandinRequest({
      requestId: request.id,
      actingCaptainId: fx.away.captainId,
    });
    const withdrawn = await cancelStandinRequest({
      requestId: request.id,
      actingCaptainId: fx.home.captainId,
    });
    expect(!withdrawn.ok && withdrawn.error).toBe("That request was already declined");
    const again = await declineStandinRequest({
      requestId: request.id,
      actingCaptainId: null,
    });
    expect(!again.ok && again.error).toBe("That request was already declined");
    const agreed = await approveStandinRequest({
      requestId: request.id,
      actingCaptainId: fx.away.captainId,
    });
    expect(!agreed.ok && agreed.error).toBe("That request was already declined");
    expect(await prisma.standinAssignment.count()).toBe(0);
    expect(
      (await prisma.standinRequest.findUniqueOrThrow({ where: { id: request.id } }))
        .status,
    ).toBe("DECLINED");
  });
});

// ---------------------------------------------------------------------------
// SWAP WORDING. "Remove that assignment first" is only honest while the
// series hasn't started — once a game imports, removeStandinGuarded refuses
// the removal, so pointing at it would send the captain in a circle.
// ---------------------------------------------------------------------------
describe("seat-taken swap wording", () => {
  /** Home's seat covered by Sub Sam, plus a second standin wanting the seat. */
  async function coveredSeat() {
    const { season, home, homePlayer, sub, match } = await setup();
    const first = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: sub.id,
      replacingUserId: homePlayer.id,
      actingCaptainId: home.captainId,
    });
    expect(first.ok).toBe(true);
    const rival = await makeUser("Sub Tara");
    await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: rival.id,
        type: "STANDIN",
        status: "ACTIVE",
        mmr: 3000,
      },
    });
    return { home, homePlayer, match, rival };
  }

  // Pins the mid-series wording: the seat conflict says the booking can't be
  // swapped, and drops the circular remove-first advice.
  it("mid-series, the booking can't be swapped — and the error says so", async () => {
    const { home, homePlayer, match, rival } = await coveredSeat();
    await prisma.game.create({
      data: {
        matchId: match.id,
        dotaMatchId: "515151",
        radiantWin: true,
        winnerTeamId: home.id,
        players: "[]",
      },
    });
    const res = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: rival.id,
      replacingUserId: homePlayer.id,
      actingCaptainId: home.captainId,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("can't be swapped");
    // Removal refuses once games exist, so this advice would be a dead end.
    expect(res.error).not.toContain("remove that assignment first");
  });

  // Pins the pre-series wording: while nothing is imported, removal is legal
  // and the conflict points straight at it.
  it("without games, the same conflict still points at removal to swap", async () => {
    const { home, homePlayer, match, rival } = await coveredSeat();
    const res = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: rival.id,
      replacingUserId: homePlayer.id,
      actingCaptainId: home.captainId,
    });
    expect(res.ok).toBe(false);
    if (!res.ok)
      expect(res.error).toContain("remove that assignment first to swap");
  });
});

describe("assignment announcement deep link", () => {
  // Pins the match-page link in standinAssignedMessage: the check-in banner
  // lives on /matches/[id], and a standin arriving from a phone ping needs
  // the page, not a scavenger hunt.
  it("the announcement links the match page", async () => {
    const { home, homePlayer, sub, match } = await setup();
    const res = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: sub.id,
      replacingUserId: homePlayer.id,
      actingCaptainId: home.captainId,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.announcement).toContain(`/matches/${match.id}`);
  });
});

describe("playoff standin posts name the round", () => {
  // The OUT ping names a semifinal by its round; the booking made in reply
  // and its stand-down must call it the same thing, not "playoff match".
  it("assign and remove both say semifinal", async () => {
    const { season, home, away, homePlayer, sub, match } = await setup();
    await prisma.season.update({
      where: { id: season.id },
      data: { status: SEASON_STATUS.PLAYOFFS },
    });
    // A 4-team bracket: its two first-round slots are the semifinals.
    await prisma.match.update({
      where: { id: match.id },
      data: { phase: MATCH_PHASE.PLAYOFF, bracketSlot: "R0M0" },
    });
    await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 1,
        phase: MATCH_PHASE.PLAYOFF,
        bracketSlot: "R0M1",
        homeTeamId: away.id,
        awayTeamId: home.id,
      },
    });

    const res = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: sub.id,
      replacingUserId: homePlayer.id,
      actingCaptainId: home.captainId,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.announcement).toContain("— semifinal **Home** vs **Away**");

    const booking = await prisma.standinAssignment.findFirstOrThrow({
      where: { matchId: match.id },
    });
    const removed = await removeStandinGuarded({
      assignmentId: booking.id,
      actingCaptainId: home.captainId,
    });
    expect(removed.ok).toBe(true);
    if (removed.ok) {
      expect(removed.announcement).toContain("(semifinal **Home** vs **Away**)");
    }
  });
});
