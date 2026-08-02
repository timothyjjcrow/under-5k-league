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

describe("bulk teardowns stand their standins down", () => {
  // StandinAssignment cascades from Match, so a playoff RESET and a schedule
  // REGENERATE both delete bookings wholesale. Every ordinary removal path
  // sends standinRemovedMessage; these two dropped a live @-mentioned
  // instruction to turn up for a fixture that no longer exists, in silence.
  async function bookedStandin(seasonId: string, matchId: string, teamId: string) {
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
      data: { matchId, teamId, standinUserId: standin.id, replacingUserId: null },
    });
    return standin;
  }

  it("a playoff reset tells the standins their match is gone", async () => {
    const season = await makeSeason({ status: "PLAYOFFS", teamSize: 3 });
    const a = await makeTeam(season.id, "Alpha", 0);
    const b = await makeTeam(season.id, "Bravo", 1);
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
// MMR ADVISORY (standinMmrNote). Warn-and-name, NEVER a block — the maxMmr
// house rule. Named cover compares against the REPLACED player's registration
// MMR (the strength the team was already fielding); an empty seat has no
// baseline, so the season's soft cap is the only yardstick.
// ---------------------------------------------------------------------------
describe("standin MMR advisory", () => {
  it("flags a 4900 standin covering a 1800 seat — and still assigns", async () => {
    const { season, home, homePlayer, sub, match } = await setup();
    await prisma.registration.updateMany({
      where: { userId: sub.id },
      data: { mmr: 4900 },
    });
    // The replaced player's MMR comes from their Registration row — the
    // rostered fixtures are bare Users, so give them one.
    await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: homePlayer.id,
        type: "PLAYER",
        status: "ACTIVE",
        mmr: 1800,
      },
    });
    const res = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: sub.id,
      replacingUserId: homePlayer.id,
      actingCaptainId: home.captainId,
    });
    // Advisory means the assignment LANDS and the message names the gap.
    expect(res.ok).toBe(true);
    if (res.ok)
      expect(res.message).toContain(
        "heads up: a 4900 MMR standin is covering a 1800 MMR player",
      );
    expect(await prisma.standinAssignment.count()).toBe(1);
  });

  it("says nothing under the 500-MMR flag gap", async () => {
    // 2600 covering 2500 — comparable cover is the normal case, no noise.
    const { season, home, homePlayer, sub, match } = await setup();
    await prisma.registration.updateMany({
      where: { userId: sub.id },
      data: { mmr: 2600 },
    });
    await prisma.registration.create({
      data: {
        seasonId: season.id,
        userId: homePlayer.id,
        type: "PLAYER",
        status: "ACTIVE",
        mmr: 2500,
      },
    });
    const res = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: sub.id,
      replacingUserId: homePlayer.id,
      actingCaptainId: home.captainId,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.message).not.toContain("heads up");
  });

  it("an empty-seat fill measures against the season's review threshold", async () => {
    // No replaced player to compare with, so Season.maxMmr is the yardstick.
    const { season, home, sub, match } = await setup();
    await prisma.season.update({
      where: { id: season.id },
      data: { maxMmr: 3500 },
    });
    await prisma.registration.updateMany({
      where: { userId: sub.id },
      data: { mmr: 4000 },
    });
    const res = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: sub.id,
      replacingUserId: null,
      teamId: home.id,
      actingCaptainId: null,
    });
    expect(res.ok).toBe(true);
    if (res.ok)
      expect(res.message).toContain(
        "above this season's 3500 MMR review threshold",
      );
  });

  it("an empty-seat fill with no threshold set stays silent", async () => {
    // maxMmr 0 = no review threshold — there is nothing to measure against.
    const { season, home, sub, match } = await setup();
    await prisma.registration.updateMany({
      where: { userId: sub.id },
      data: { mmr: 4000 },
    });
    const res = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: sub.id,
      replacingUserId: null,
      teamId: home.id,
      actingCaptainId: null,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.message).not.toContain("heads up");
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
