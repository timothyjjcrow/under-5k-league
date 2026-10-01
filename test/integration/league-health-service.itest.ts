import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { DRAFT_STATUS, SEASON_STATUS } from "@/lib/constants";
import { loadLeagueHealth } from "@/lib/league-health-service";
import { makeSeason, makeTeam, makeUser } from "./factories";

// /admin/health reads one season as counts. These seed the rows each figure
// comes from and check the service against a real database: the relation
// filters (returning players, Discord links, check-ins on the season's
// matches), the archived-season path, and the date window the undated
// Discord posts and accounts are counted in.

const ZONE = "America/Los_Angeles";
const at = (iso: string) => new Date(iso);

async function setCreatedAt(seasonId: string, createdAt: Date) {
  return prisma.season.update({ where: { id: seasonId }, data: { createdAt } });
}

async function signUp(
  seasonId: string,
  userId: string,
  type: "PLAYER" | "STANDIN" = "PLAYER",
  status: "ACTIVE" | "WITHDRAWN" | "REMOVED" = "ACTIVE",
) {
  await prisma.registration.create({ data: { seasonId, userId, type, status } });
}

/** A roster seat with the history the draft tools write for it. */
async function seat(
  seasonId: string,
  team: { id: string; name: string },
  user: { id: string; name: string },
  acquisitionKind: string,
) {
  const member = await prisma.teamMember.create({
    data: { seasonId, teamId: team.id, userId: user.id, isCaptain: acquisitionKind === "CAPTAIN_DESIGNATION" },
  });
  await prisma.rosterTenure.create({
    data: {
      seasonId, teamId: team.id, userId: user.id,
      sourceMembershipId: member.id, openKey: JSON.stringify([seasonId, user.id]),
      joinedAt: member.createdAt, startProvenance: "COMMAND",
      acquisitionKind, acquisitionPrice: 0,
      playerNameSnapshot: user.name, teamNameSnapshot: team.name,
    },
  });
  return member;
}

describe("league health service", () => {
  it("counts a season's signups, seats, drafting, returning players and Discord links", async () => {
    const earlier = await setCreatedAt(
      (
        await makeSeason({
          name: "Season 8",
          status: SEASON_STATUS.COMPLETE,
          isActive: false,
        })
      ).id,
      at("2026-01-05T08:00:00Z"),
    );
    const season = await setCreatedAt(
      (
        await makeSeason({
          name: "Season 9",
          status: SEASON_STATUS.REGULAR_SEASON,
          teamSize: 2,
          minTeams: 2,
        })
      ).id,
      at("2026-06-01T07:00:00Z"),
    );

    const veteran = await makeUser("Veteran");
    const rookie = await makeUser("Rookie");
    const unsold = await makeUser("Unsold");
    const undone = await makeUser("Undone");
    const quitter = await makeUser("Quitter");
    const removed = await makeUser("Removed");
    const removedVeteran = await makeUser("Removed veteran");
    const standin = await makeUser("Standin");
    const formerStandin = await makeUser("Former standin");
    await prisma.user.update({ where: { id: veteran.id }, data: { discordId: "1001" } });
    // A typed name is not a link.
    await prisma.user.update({ where: { id: rookie.id }, data: { discordName: "rookie" } });

    await signUp(earlier.id, veteran.id);
    await signUp(earlier.id, removedVeteran.id, "STANDIN");
    for (const user of [veteran, rookie, unsold, undone]) await signUp(season.id, user.id);
    await signUp(season.id, quitter.id, "PLAYER", "WITHDRAWN");
    await signUp(season.id, removed.id, "PLAYER", "REMOVED");
    await signUp(season.id, removedVeteran.id, "PLAYER", "REMOVED");
    await signUp(season.id, standin.id, "STANDIN");
    await signUp(season.id, formerStandin.id, "STANDIN", "WITHDRAWN");

    const alpha = await prisma.team.create({
      data: { seasonId: season.id, name: "Alpha", captainId: veteran.id },
    });
    const bravo = await prisma.team.create({
      data: { seasonId: season.id, name: "Bravo", captainId: rookie.id },
    });
    const gone = await makeTeam(season.id, "Gone", 2);
    await prisma.team.update({ where: { id: gone.id }, data: { withdrawn: true } });
    await prisma.draft.create({
      data: { seasonId: season.id, status: DRAFT_STATUS.COMPLETE },
    });
    await seat(season.id, alpha, veteran, "CAPTAIN_DESIGNATION");
    await seat(season.id, bravo, rookie, "CAPTAIN_DESIGNATION");
    // Bought, then the sale was undone: the seat is gone and the tenure void.
    await prisma.rosterTenure.create({
      data: {
        seasonId: season.id, teamId: alpha.id, userId: undone.id,
        sourceMembershipId: "deleted-membership", openKey: null,
        joinedAt: at("2026-06-10T03:00:00Z"), endedAt: at("2026-06-10T03:05:00Z"),
        closedAt: at("2026-06-10T03:05:00Z"), startProvenance: "COMMAND",
        endProvenance: "COMMAND", endReason: "DRAFT_UNDO",
        acquisitionKind: "AUCTION", acquisitionPrice: 12,
        playerNameSnapshot: undone.name, teamNameSnapshot: alpha.name,
      },
    });

    const { seasons, health } = await loadLeagueHealth(season, { timeZone: ZONE });
    expect(seasons).toEqual([
      { id: season.id, name: "Season 9", isActive: true },
      { id: earlier.id, name: "Season 8", isActive: false },
    ]);
    expect(health.signups).toEqual({
      players: { active: 4, withdrawn: 1, removed: 2 },
      standins: { active: 1, withdrawn: 1, removed: 0 },
      teams: 3,
      withdrawnTeams: 1,
      seats: 6,
      targetTeams: 2,
      targetSeats: 4,
      // Unsold, and Undone, whose only sale was undone.
      neverDrafted: { state: "counted", count: 2 },
      // Veteran; the removed veteran isn't an active signup.
      returning: 1,
    });
    expect(health.discord).toMatchObject({ rostered: 2, linked: 1 });

    // A seat with no history makes never-drafted unknown, not a guess.
    const late = await makeUser("Late");
    await prisma.teamMember.create({
      data: { seasonId: season.id, teamId: bravo.id, userId: late.id },
    });
    const after = await loadLeagueHealth(season, { timeZone: ZONE });
    expect(after.health.signups.neverDrafted).toEqual({
      state: "unknown",
      reason: "partial-history",
    });
    expect(after.health.discord).toMatchObject({ rostered: 3, linked: 1 });

    // The archived season reads its own rows, and has no auction on record.
    const archived = await loadLeagueHealth(earlier, { timeZone: ZONE });
    expect(archived.health.signups).toMatchObject({
      players: { active: 1, withdrawn: 0, removed: 0 },
      standins: { active: 1, withdrawn: 0, removed: 0 },
      seats: 0,
      neverDrafted: { state: "unknown", reason: "no-auction" },
      returning: 0,
    });
    expect(archived.health.window.next).toEqual({ name: "Season 9" });
  });

  it("counts check-ins and standin bookings against each series' current kickoff", async () => {
    const now = new Date();
    const season = await makeSeason({
      status: SEASON_STATUS.REGULAR_SEASON,
      teamSize: 2,
    });
    const home = await makeTeam(season.id, "Home", 0);
    const away = await makeTeam(season.id, "Away", 1);
    const fixture = (data: { scheduledAt: Date | null; scheduleRevision?: number; forfeit?: boolean }) =>
      prisma.match.create({
        data: { seasonId: season.id, week: 1, homeTeamId: home.id, awayTeamId: away.id, bestOf: 2, ...data },
      });
    const played = await fixture({
      scheduledAt: new Date(now.getTime() - 24 * 3600_000),
      scheduleRevision: 1,
    });
    const forfeited = await fixture({
      scheduledAt: new Date(now.getTime() - 48 * 3600_000),
      forfeit: true,
    });
    const upcoming = await fixture({ scheduledAt: new Date(now.getTime() + 2 * 3600_000) });
    const unscheduled = await fixture({ scheduledAt: null });

    const people = await Promise.all(
      Array.from({ length: 8 }, (_, i) => makeUser(`Player ${i + 1}`)),
    );
    const answer = (matchId: string, userId: string, status: string, scheduleRevision: number) =>
      prisma.matchAvailability.create({ data: { matchId, userId, status, scheduleRevision } });
    await answer(played.id, people[0].id, "IN", 1);
    await answer(played.id, people[1].id, "IN", 1);
    await answer(played.id, people[2].id, "IN", 1);
    await answer(played.id, people[3].id, "OUT", 1);
    // Answered the kickoff before the match moved: not counted.
    await answer(played.id, people[4].id, "IN", 0);
    await answer(forfeited.id, people[5].id, "IN", 0);
    await answer(upcoming.id, people[6].id, "IN", 0);

    const book = (matchId: string, createdAt: Date) =>
      prisma.standinAssignment.create({
        data: { matchId, teamId: home.id, standinUserId: people[7].id, createdAt },
      });
    // Two days before the played series' kickoff.
    await book(played.id, new Date(played.scheduledAt!.getTime() - 2 * 24 * 3600_000));
    await book(upcoming.id, now);
    await book(unscheduled.id, now);

    const { health } = await loadLeagueHealth(season, { now, timeZone: ZONE });
    expect(health.checkins).toEqual({
      matches: 1,
      // Two sides of two, plus the standin booked on it.
      seats: 5,
      answered: 4,
      in: 3,
      out: 1,
    });
    expect(health.bookings.total).toBe(3);
    expect(
      health.bookings.lead
        .filter((row) => row.count > 0)
        .map(({ key, count }) => [key, count]),
    ).toEqual([
      ["1d", 1],
      ["1h", 1],
      ["none", 1],
    ]);
  });

  it("counts posts and new accounts in each season's own date window", async () => {
    const earlier = await setCreatedAt(
      (
        await makeSeason({
          name: "Season 8",
          status: SEASON_STATUS.COMPLETE,
          isActive: false,
        })
      ).id,
      at("2026-01-05T08:00:00Z"), // Mon 5 Jan, 00:00 PST
    );
    const current = await setCreatedAt(
      (await makeSeason({ name: "Season 9", status: SEASON_STATUS.SIGNUPS })).id,
      at("2026-01-26T08:00:00Z"), // Mon 26 Jan, 00:00 PST
    );
    const now = at("2026-02-09T08:00:00Z");

    const post = (data: { status: string; sentAt?: Date | null; dedupeKey?: string | null }) =>
      prisma.leagueAnnouncement.create({ data: { content: "Post", ...data } });
    await post({ status: "SENT", sentAt: at("2026-01-06T03:00:00Z"), dedupeKey: "series:a:1" });
    await post({ status: "SENT", sentAt: at("2026-01-07T03:00:00Z"), dedupeKey: null });
    await post({ status: "SENT", sentAt: at("2026-01-08T03:00:00Z"), dedupeKey: "checkin-nudge:m1:x" });
    // Never sent: waiting, and dropped.
    await post({ status: "PENDING", dedupeKey: "series:b:2" });
    await post({ status: "CANCELLED", dedupeKey: "series:c:3" });
    // The last moment of the archived season's window, then the first of the next.
    await post({ status: "SENT", sentAt: at("2026-01-26T07:59:59Z"), dedupeKey: "reminder:d:4" });
    await post({ status: "SENT", sentAt: at("2026-01-26T08:00:00Z"), dedupeKey: "draft-live:s:5" });
    // After "now": outside the open season's window too.
    await post({ status: "SENT", sentAt: at("2026-02-10T08:00:00Z"), dedupeKey: "series:e:6" });

    for (const [name, createdAt] of [
      ["Before both", "2025-12-01T20:00:00Z"],
      ["Week one", "2026-01-06T20:00:00Z"],
      ["Week two", "2026-01-13T20:00:00Z"],
      ["Week two again", "2026-01-14T20:00:00Z"],
      ["Next season", "2026-01-27T20:00:00Z"],
    ] as const) {
      const user = await makeUser(name);
      await prisma.user.update({ where: { id: user.id }, data: { createdAt: at(createdAt) } });
    }

    const archived = await loadLeagueHealth(earlier, { now, timeZone: ZONE });
    expect(archived.health.window).toEqual({
      start: at("2026-01-05T08:00:00Z"),
      end: at("2026-01-26T08:00:00Z"),
      next: { name: "Season 9" },
    });
    expect(
      archived.health.discord.posts.map(({ key, count }) => [key, count]),
    ).toEqual([
      ["series", 1],
      ["reminder", 1],
      ["checkin-nudge", 1],
      ["other", 1],
    ]);
    expect(archived.health.discord.postsTotal).toBe(4);
    expect(archived.health.accounts).toEqual({
      total: 3,
      weeks: [
        { weekOf: "2026-01-05", count: 1 },
        { weekOf: "2026-01-12", count: 2 },
        { weekOf: "2026-01-19", count: 0 },
      ],
      earlier: null,
    });

    const open = await loadLeagueHealth(current, { now, timeZone: ZONE });
    expect(open.health.window).toEqual({
      start: at("2026-01-26T08:00:00Z"),
      end: now,
      next: null,
    });
    expect(open.health.discord.posts.map(({ key, count }) => [key, count])).toEqual([
      ["draft-live", 1],
    ]);
    expect(open.health.accounts).toEqual({
      total: 1,
      weeks: [
        { weekOf: "2026-01-26", count: 1 },
        { weekOf: "2026-02-02", count: 0 },
      ],
      earlier: null,
    });
  });
});
