import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { SEASON_STATUS } from "@/lib/constants";
import { loadCheckinSide } from "@/lib/checkin-side-service";
import {
  generateRegularSchedule,
  makeCaptain,
  makePlayer,
  makeSeason,
  makeUser,
} from "./factories";

// The check-in banner's side line (Home, /schedule, the match page). It is
// read-only, but it carries the privacy split: every participant gets their
// side's count, only the two captains and admins get the names, and only a
// member standin gets their captain's Discord handle.

async function setup() {
  const season = await makeSeason({
    name: "Check-in Season",
    teamSize: 3,
    status: SEASON_STATUS.REGULAR_SEASON,
  });
  const home = await makeCaptain(season.id, "Rosh", 100, 0);
  const away = await makeCaptain(season.id, "Aegis", 100, 1);
  const ana = await makePlayer(season.id, "Ana", 3000);
  const bo = await makePlayer(season.id, "Bo", 3000);
  const cy = await makePlayer(season.id, "Cy", 3000);
  for (const [user, team] of [
    [ana, home.team],
    [bo, home.team],
    [cy, away.team],
  ] as const) {
    await prisma.teamMember.create({
      data: { seasonId: season.id, teamId: team.id, userId: user.id, isCaptain: false, price: 5 },
    });
  }
  await prisma.user.update({
    where: { id: home.user.id },
    data: { discordName: "rosh_cap", discordId: "111" },
  });
  const [created] = await generateRegularSchedule(season.id);
  const match = await prisma.match.update({
    where: { id: created.id },
    data: {
      scheduledAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
      scheduleRevision: 2,
    },
  });
  // Either team may be at home; the tests read Rosh's side.
  return { season, match, home, away, ana, bo, cy };
}

async function answer(
  match: { id: string; scheduleRevision: number },
  userId: string,
  status: string,
  scheduleRevision = match.scheduleRevision,
) {
  await prisma.matchAvailability.create({
    data: { matchId: match.id, userId, status, scheduleRevision },
  });
}

const viewerOf = (user: { id: string; role: string }) => ({
  id: user.id,
  role: user.role,
});

describe("loadCheckinSide", () => {
  it("gives the captain their side's count and the names behind it", async () => {
    const { match, home, ana, bo, cy } = await setup();
    await answer(match, home.user.id, "IN");
    await answer(match, ana.id, "OUT");
    // An answer for an old kickoff is no answer, and the other side's row
    // counts for nothing here.
    await answer(match, bo.id, "IN", match.scheduleRevision - 1);
    await answer(match, cy.id, "IN");

    const side = await loadCheckinSide({ matchId: match.id, viewer: viewerOf(home.user) });
    expect(side).toMatchObject({
      role: "captain",
      teamName: home.team.name,
      captainName: null,
      captainContact: null,
      counts: { in: 1, out: 1, noReply: 1, openSeats: 0, of: 3 },
      names: { in: ["you"], out: ["Ana"], covered: [], noReply: ["Bo"] },
    });
  });

  it("gives a player the count and their captain, but no names", async () => {
    const { match, home, ana, bo } = await setup();
    await answer(match, home.user.id, "IN");
    await answer(match, bo.id, "OUT");

    const side = await loadCheckinSide({ matchId: match.id, viewer: viewerOf(ana) });
    expect(side).toMatchObject({
      role: "player",
      teamName: home.team.name,
      captainName: "Rosh",
      // A rostered player already knows their captain.
      captainContact: null,
      counts: { in: 1, out: 1, noReply: 1, openSeats: 0, of: 3 },
      names: null,
    });
  });

  it("names every answer for an admin who plays, but not when the page lists them", async () => {
    const { match, ana } = await setup();
    await prisma.user.update({ where: { id: ana.id }, data: { role: "ADMIN" } });
    const admin = { id: ana.id, role: "ADMIN" };

    const named = await loadCheckinSide({ matchId: match.id, viewer: admin });
    expect(named?.names?.noReply).toEqual(expect.arrayContaining(["you", "Rosh", "Bo"]));

    const counted = await loadCheckinSide({ matchId: match.id, viewer: admin, names: false });
    expect(counted?.names).toBeNull();
    expect(counted?.counts.noReply).toBe(3);
  });

  it("tells a standin whose seat they fill and gives a member their captain's handle", async () => {
    const { season, match, home, bo } = await setup();
    const sub = await makeUser("Sub");
    await prisma.registration.create({
      data: { seasonId: season.id, userId: sub.id, type: "STANDIN", status: "ACTIVE", mmr: 2500 },
    });
    await prisma.standinAssignment.create({
      data: { matchId: match.id, teamId: home.team.id, standinUserId: sub.id, replacingUserId: bo.id },
    });
    await answer(match, sub.id, "IN");
    await answer(match, bo.id, "OUT");

    const side = await loadCheckinSide({ matchId: match.id, viewer: viewerOf(sub) });
    expect(side).toMatchObject({
      role: "standin",
      teamName: home.team.name,
      standinFor: "Bo",
      captainName: "Rosh",
      captainContact: { discordName: "rosh_cap", discordId: "111" },
      // Bo's seat is Sub's for this match, so Bo's OUT is no gap.
      counts: { in: 1, out: 0, noReply: 2, openSeats: 0, of: 3 },
      names: null,
    });

    // The captain sees who covers whom.
    const captain = await loadCheckinSide({ matchId: match.id, viewer: viewerOf(home.user) });
    expect(captain?.names).toEqual({
      in: ["Sub (standin)"],
      out: [],
      covered: [{ name: "Bo", by: "Sub" }],
      noReply: ["you", "Ana"],
    });

    // The covered player isn't playing this match, so there's no side to show.
    expect(await loadCheckinSide({ matchId: match.id, viewer: viewerOf(bo) })).toBeNull();
  });

  it("keeps the captain's handle from a standin who isn't a league member", async () => {
    const { match, home } = await setup();
    const walkIn = await makeUser("Walk-in");
    await prisma.standinAssignment.create({
      data: { matchId: match.id, teamId: home.team.id, standinUserId: walkIn.id, replacingUserId: null },
    });

    const side = await loadCheckinSide({ matchId: match.id, viewer: viewerOf(walkIn) });
    expect(side).toMatchObject({
      role: "standin",
      standinFor: null,
      captainName: "Rosh",
      captainContact: null,
      // An open seat filled: the side reads four of three expected.
      counts: { of: 4, openSeats: 0 },
    });
  });

  it("has no side for someone who isn't playing", async () => {
    const { match } = await setup();
    const stranger = await makeUser("Stranger");
    expect(await loadCheckinSide({ matchId: match.id, viewer: viewerOf(stranger) })).toBeNull();
    expect(await loadCheckinSide({ matchId: "missing", viewer: viewerOf(stranger) })).toBeNull();
  });
});
