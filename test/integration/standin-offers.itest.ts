import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { MATCH_PHASE, MATCH_STATUS, SEASON_STATUS } from "@/lib/constants";
import {
  approveStandinRequest,
  assignStandinGuarded,
  removeStandinGuarded,
} from "@/lib/standin-service";
import {
  loadStandinBoard,
  loadStandinOfferViewer,
  offerToStandIn,
  standingOn,
  withdrawStandinOffer,
} from "@/lib/standin-offer-service";
import { makeSeason, makeTeam, makeUser } from "./factories";

// Standin offers: a standin says "I can play" for a side that needs someone,
// and that side's captain books from the list. The board, the offer and its
// refusals, and what a booking does to the list.

const HOUR = 3600_000;

async function setup(opts: { teamSize?: number } = {}) {
  // Two full rosters of two by default, so a side needs someone only once a
  // player says they're out.
  const season = await makeSeason({
    status: SEASON_STATUS.REGULAR_SEASON,
    teamSize: opts.teamSize ?? 2,
  });
  const home = await makeTeam(season.id, "Home", 0);
  const away = await makeTeam(season.id, "Away", 1);
  const roster = async (teamId: string, name: string, mmr: number) => {
    const user = await makeUser(name);
    await prisma.teamMember.create({
      data: { seasonId: season.id, teamId, userId: user.id, isCaptain: false, price: 5 },
    });
    await prisma.registration.create({
      data: { seasonId: season.id, userId: user.id, type: "PLAYER", status: "ACTIVE", mmr },
    });
    return user;
  };
  const homeA = await roster(home.id, "Home Carry", 3200);
  const homeB = await roster(home.id, "Home Support", 2400);
  const awayA = await roster(away.id, "Away Mid", 3000);
  const awayB = await roster(away.id, "Away Off", 2600);
  const match = await prisma.match.create({
    data: {
      seasonId: season.id,
      week: 1,
      phase: MATCH_PHASE.REGULAR,
      homeTeamId: home.id,
      awayTeamId: away.id,
      scheduledAt: new Date(Date.now() + 24 * HOUR),
    },
  });
  return { season, home, away, homeA, homeB, awayA, awayB, match };
}

async function standin(seasonId: string, name: string, mmr: number) {
  const user = await makeUser(name);
  await prisma.registration.create({
    data: { seasonId, userId: user.id, type: "STANDIN", status: "ACTIVE", mmr },
  });
  return user;
}

async function sayOut(matchId: string, userId: string, scheduleRevision = 0) {
  await prisma.matchAvailability.create({
    data: { matchId, userId, status: "OUT", scheduleRevision },
  });
}

describe("the standin board (integration)", () => {
  it("lists nothing while every seat is filled and nobody is out", async () => {
    const { season } = await setup();
    expect(await loadStandinBoard(season, Date.now())).toEqual([]);
  });

  it("lists a side once a player says they're out, judged by their MMR", async () => {
    const { season, home, homeA, match } = await setup();
    await sayOut(match.id, homeA.id);
    const board = await loadStandinBoard(season, Date.now());
    expect(board).toHaveLength(1);
    expect(board[0]).toMatchObject({
      matchId: match.id,
      teamId: home.id,
      teamName: "Home",
      opponentName: "Away",
      seats: 1,
      baselineMmr: 3200,
      roundLabel: "Week 1",
      offerCount: 0,
    });
  });

  it("ignores an OUT answered for an earlier kickoff", async () => {
    const { season, homeA, match } = await setup();
    await sayOut(match.id, homeA.id);
    await prisma.match.update({
      where: { id: match.id },
      data: { scheduleRevision: 1 },
    });
    expect(await loadStandinBoard(season, Date.now())).toEqual([]);
  });

  it("lists a short roster's empty seat against the team's lowest MMR", async () => {
    const { season, home, away } = await setup({ teamSize: 3 });
    const board = await loadStandinBoard(season, Date.now());
    expect(board.map((n) => [n.teamId, n.seats, n.baselineMmr])).toEqual([
      [home.id, 1, 2400],
      [away.id, 1, 2600],
    ]);
  });

  it("drops a side once its seat is booked, and one held by a request", async () => {
    const { season, home, away, homeA, awayA, match } = await setup();
    await sayOut(match.id, homeA.id);
    await sayOut(match.id, awayA.id);
    const fits = await standin(season.id, "Fits", 3200);
    const ringer = await standin(season.id, "Ringer", 4500);
    // Home books within the allowance; Away's pick waits for Home's captain.
    const booked = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: fits.id,
      replacingUserId: homeA.id,
      actingCaptainId: home.captainId,
    });
    expect(booked.ok).toBe(true);
    const asked = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: ringer.id,
      replacingUserId: awayA.id,
      actingCaptainId: away.captainId,
    });
    expect(asked.ok && asked.pending).toBe(true);
    expect(await loadStandinBoard(season, Date.now())).toEqual([]);
  });

  it("leaves out fixtures outside the window, played ones and withdrawn teams", async () => {
    const { season, home, homeA, match } = await setup();
    await sayOut(match.id, homeA.id);
    const at = async (scheduledAt: Date | null) => {
      await prisma.match.update({ where: { id: match.id }, data: { scheduledAt } });
      return (await loadStandinBoard(season, Date.now())).length;
    };
    expect(await at(new Date(Date.now() + 30 * 24 * HOUR))).toBe(0);
    expect(await at(new Date(Date.now() - 12 * HOUR))).toBe(0);
    expect(await at(null)).toBe(0);
    expect(await at(new Date(Date.now() - HOUR))).toBe(1);
    await prisma.team.update({ where: { id: home.id }, data: { withdrawn: true } });
    expect(await at(new Date(Date.now() + HOUR))).toBe(0);
    await prisma.team.update({ where: { id: home.id }, data: { withdrawn: false } });
    await prisma.match.update({
      where: { id: match.id },
      data: { status: MATCH_STATUS.COMPLETED },
    });
    expect(await at(new Date(Date.now() + HOUR))).toBe(0);
  });

  it("is empty before the auction has run and once the season is over", async () => {
    const { season, homeA, match } = await setup();
    await sayOut(match.id, homeA.id);
    for (const status of [SEASON_STATUS.SIGNUPS, SEASON_STATUS.COMPLETE]) {
      expect(
        await loadStandinBoard({ ...season, status }, Date.now()),
      ).toEqual([]);
    }
  });
});

describe("offering to stand in (integration)", () => {
  it("puts a standin on the list once, and posts for that side's captain", async () => {
    const { season, home, homeA, match } = await setup();
    await sayOut(match.id, homeA.id);
    const sub = await standin(season.id, "Sub Sam", 3200);
    await prisma.user.update({
      where: { id: home.captainId },
      data: { discordId: "111" },
    });

    const first = await offerToStandIn({
      matchId: match.id,
      teamId: home.id,
      userId: sub.id,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.message).toContain("the list for Home");
    expect(first.post?.announcement).toContain("Sub Sam");
    expect(first.post?.announcement).toContain("3,200 MMR");
    expect(first.post?.announcement).toContain(`/standins?match=${match.id}`);
    // Only the captain who picks is mentioned.
    expect(first.post?.mentions).toEqual({ users: ["111"] });
    expect(first.post?.throttleKey).toBe(
      `standinOfferPing:${match.id}:${home.id}:0`,
    );

    // A second tap is "already in": one row, no second post.
    const again = await offerToStandIn({
      matchId: match.id,
      teamId: home.id,
      userId: sub.id,
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.message).toContain("already");
    expect(again.post).toBeUndefined();
    expect(await prisma.standinOffer.count()).toBe(1);

    const board = await loadStandinBoard(season, Date.now());
    expect(board[0]).toMatchObject({ offerCount: 1, offerUserIds: [sub.id] });
    const viewer = await loadStandinOfferViewer(season.id, sub.id);
    expect(standingOn(board[0], viewer)).toEqual({
      kind: "offered",
      outcome: "book",
    });
  });

  it("takes an offer over the allowance, and says the other captain decides", async () => {
    const { season, home, homeA, match } = await setup();
    await sayOut(match.id, homeA.id);
    const ringer = await standin(season.id, "Ringer", 4500);
    const res = await offerToStandIn({
      matchId: match.id,
      teamId: home.id,
      userId: ringer.id,
    });
    expect(res.ok).toBe(true);
    const [need] = await loadStandinBoard(season, Date.now());
    expect(
      standingOn(need, await loadStandinOfferViewer(season.id, ringer.id)),
    ).toEqual({ kind: "offered", outcome: "ask" });
  });

  it("refuses a side that needs nobody", async () => {
    const { season, home, away, homeA, match } = await setup();
    await sayOut(match.id, homeA.id);
    const sub = await standin(season.id, "Sub Sam", 3200);
    const res = await offerToStandIn({
      matchId: match.id,
      teamId: away.id,
      userId: sub.id,
    });
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toContain("Away has its cover");
    // …and a team that isn't in the match at all.
    const other = await makeTeam(season.id, "Other", 2);
    expect(
      await offerToStandIn({ matchId: match.id, teamId: other.id, userId: sub.id }),
    ).toMatchObject({ ok: false, error: "That team isn't in this match" });
    expect(await prisma.standinOffer.count()).toBe(0);
    expect(home.id).not.toBe(other.id);
  });

  it("refuses anyone a booking would refuse", async () => {
    const { season, home, homeA, awayB, match } = await setup();
    await sayOut(match.id, homeA.id);
    const offer = (userId: string) =>
      offerToStandIn({ matchId: match.id, teamId: home.id, userId });

    // A rostered player would be in both teams' import sets.
    const rostered = await offer(awayB.id);
    expect(rostered).toMatchObject({ ok: false });
    if (!rostered.ok) expect(rostered.error).toContain("on a roster");

    // No signup, a withdrawn one and a removed one aren't in the pool.
    const stranger = await makeUser("Stranger");
    const noSignup = await offer(stranger.id);
    expect(noSignup).toMatchObject({ ok: false });
    if (!noSignup.ok) expect(noSignup.error).toContain("Register as a standin");
    const gone = await standin(season.id, "Gone", 3000);
    await prisma.registration.updateMany({
      where: { userId: gone.id },
      data: { status: "WITHDRAWN" },
    });
    expect(await offer(gone.id)).toMatchObject({ ok: false });

    // Booked on another fixture the same night.
    const busy = await standin(season.id, "Busy", 3000);
    const c = await makeTeam(season.id, "Gamma", 2);
    const d = await makeTeam(season.id, "Delta", 3);
    const sameNight = await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 1,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: c.id,
        awayTeamId: d.id,
        scheduledAt: match.scheduledAt,
      },
    });
    await prisma.standinAssignment.create({
      data: { matchId: sameNight.id, teamId: c.id, standinUserId: busy.id },
    });
    const clash = await offer(busy.id);
    expect(clash).toMatchObject({ ok: false });
    if (!clash.ok) expect(clash.error).toBe("You're booked for Gamma vs Delta that night.");

    expect(await prisma.standinOffer.count()).toBe(0);
  });

  it("refuses a played match, an archived season and a closed phase", async () => {
    const { season, home, homeA, match } = await setup();
    await sayOut(match.id, homeA.id);
    const sub = await standin(season.id, "Sub Sam", 3200);
    const offer = () =>
      offerToStandIn({ matchId: match.id, teamId: home.id, userId: sub.id });

    await prisma.season.update({
      where: { id: season.id },
      data: { status: SEASON_STATUS.COMPLETE },
    });
    expect(await offer()).toMatchObject({
      ok: false,
      error: "Standins aren't being booked right now",
    });
    await prisma.season.update({
      where: { id: season.id },
      data: { status: SEASON_STATUS.REGULAR_SEASON },
    });
    await prisma.match.update({
      where: { id: match.id },
      data: { status: MATCH_STATUS.COMPLETED },
    });
    expect(await offer()).toMatchObject({
      ok: false,
      error: "This match is already played",
    });
    await prisma.season.update({
      where: { id: season.id },
      data: { isActive: false },
    });
    expect(await offer()).toMatchObject({ ok: false });
    expect(await prisma.standinOffer.count()).toBe(0);
  });

  it("takes an offer back, and a second take-back is not an error", async () => {
    const { season, home, homeA, match } = await setup();
    await sayOut(match.id, homeA.id);
    const sub = await standin(season.id, "Sub Sam", 3200);
    const key = { matchId: match.id, teamId: home.id, userId: sub.id };
    await offerToStandIn(key);
    expect((await withdrawStandinOffer(key)).message).toContain("off the list");
    expect(await prisma.standinOffer.count()).toBe(0);
    expect((await withdrawStandinOffer(key)).message).toContain("weren't on");
  });
});

describe("booking from the list (integration)", () => {
  it("a booking answers the standin's offers in that match, for both sides", async () => {
    const { season, home, away, homeA, awayA, match } = await setup();
    await sayOut(match.id, homeA.id);
    await sayOut(match.id, awayA.id);
    const sub = await standin(season.id, "Sub Sam", 3000);
    const other = await standin(season.id, "Other Olly", 3000);
    for (const teamId of [home.id, away.id]) {
      await offerToStandIn({ matchId: match.id, teamId, userId: sub.id });
      await offerToStandIn({ matchId: match.id, teamId, userId: other.id });
    }
    expect(await prisma.standinOffer.count()).toBe(4);

    const booked = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: sub.id,
      replacingUserId: homeA.id,
      actingCaptainId: home.captainId,
    });
    expect(booked.ok).toBe(true);
    // Sub Sam's two offers are gone; Other Olly's stay, for Away to pick.
    const left = await prisma.standinOffer.findMany({ select: { userId: true } });
    expect(left.map((o) => o.userId)).toEqual([other.id, other.id]);

    // Removing the booking doesn't bring the offer back: the captain took
    // them off, so they aren't listed as still offering.
    const row = await prisma.standinAssignment.findFirstOrThrow({
      where: { matchId: match.id },
    });
    const removed = await removeStandinGuarded({
      assignmentId: row.id,
      actingCaptainId: home.captainId,
    });
    expect(removed.ok).toBe(true);
    const board = await loadStandinBoard(season, Date.now());
    expect(board.find((n) => n.teamId === home.id)?.offerUserIds).toEqual([
      other.id,
    ]);
  });

  it("an offer waits through a request, and goes when the other captain agrees", async () => {
    const { season, home, away, homeA, match } = await setup();
    await sayOut(match.id, homeA.id);
    const ringer = await standin(season.id, "Ringer", 4500);
    await offerToStandIn({ matchId: match.id, teamId: home.id, userId: ringer.id });

    const asked = await assignStandinGuarded({
      matchId: match.id,
      standinUserId: ringer.id,
      replacingUserId: homeA.id,
      actingCaptainId: home.captainId,
    });
    expect(asked.ok && asked.pending).toBe(true);
    // A request is not a booking: the offer is still theirs to take back.
    expect(await prisma.standinOffer.count()).toBe(1);

    const request = await prisma.standinRequest.findFirstOrThrow({
      where: { matchId: match.id },
    });
    const agreed = await approveStandinRequest({
      requestId: request.id,
      actingCaptainId: away.captainId,
      actingUserId: away.captainId,
    });
    expect(agreed.ok).toBe(true);
    expect(await prisma.standinOffer.count()).toBe(0);
  });

  it("stops counting an offerer who got booked elsewhere that night", async () => {
    const { season, home, homeA, match } = await setup();
    await sayOut(match.id, homeA.id);
    const sub = await standin(season.id, "Sub Sam", 3200);
    await offerToStandIn({ matchId: match.id, teamId: home.id, userId: sub.id });
    const c = await makeTeam(season.id, "Gamma", 2);
    const d = await makeTeam(season.id, "Delta", 3);
    const sameNight = await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 1,
        phase: MATCH_PHASE.REGULAR,
        homeTeamId: c.id,
        awayTeamId: d.id,
        scheduledAt: match.scheduledAt,
      },
    });
    await prisma.standinAssignment.create({
      data: { matchId: sameNight.id, teamId: c.id, standinUserId: sub.id },
    });
    const board = await loadStandinBoard(season, Date.now());
    expect(board.find((n) => n.teamId === home.id)).toMatchObject({
      offerCount: 0,
      offerUserIds: [],
    });
  });
});
