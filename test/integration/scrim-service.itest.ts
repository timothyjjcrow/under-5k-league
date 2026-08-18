import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { SCRIM_STATUS, SEASON_STATUS } from "@/lib/constants";
import {
  addScrimGuest,
  addTeamCoach,
  cancelScrim,
  createScrim,
  joinScrim,
  removeScrimGuest,
  removeTeamCoach,
} from "@/lib/scrim-service";
import {
  makeCaptain,
  makeSeason,
  makeUser,
  raceAll,
} from "./factories";

const NIGHT = () => new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);

async function setupTeams(count = 3) {
  const season = await makeSeason({
    status: SEASON_STATUS.REGULAR_SEASON,
    teamSize: 5,
  });
  const teams = [];
  for (let index = 0; index < count; index += 1) {
    teams.push(
      await makeCaptain(season.id, `Captain ${index + 1}`, 100, index),
    );
  }
  return { season, teams };
}

describe("scrim scheduling service (integration)", () => {
  it("derives captain teams, snapshots both rosters, and cancels overlapping offers on join", async () => {
    const { teams } = await setupTeams();
    const [host, opponent, third] = teams;
    const night = NIGHT();
    const hostAlternate = await createScrim(
      host.user.id,
      new Date(night.getTime() + 2 * 60 * 60 * 1000),
      1,
    );
    const opponentAlternate = await createScrim(
      opponent.user.id,
      new Date(night.getTime() + 30 * 60 * 1000),
      3,
    );
    // Each survivor pins one piece of the broad cleanup claim below: offers
    // outside the collision window, offers owned by neither booked team, and
    // terminal history must not be swept up when this offer is claimed.
    const distantHostOffer = await createScrim(
      host.user.id,
      new Date(night.getTime() + 6 * 60 * 60 * 1000),
      1,
    );
    const nearbyThirdOffer = await createScrim(
      third.user.id,
      new Date(night.getTime() + 60 * 60 * 1000),
      1,
    );
    const completedHistory = await prisma.scrim.create({
      data: {
        seasonId: host.team.seasonId,
        hostTeamId: host.team.id,
        opponentTeamId: third.team.id,
        createdById: host.user.id,
        scheduledAt: new Date(night.getTime() + 60 * 60 * 1000),
        status: SCRIM_STATUS.COMPLETED,
      },
    });
    const offer = await createScrim(host.user.id, night, 3);

    expect(offer).toMatchObject({
      hostTeam: { id: host.team.id },
      opponentTeam: null,
      status: SCRIM_STATUS.OPEN,
      snapshottedParticipants: 1,
    });
    const joined = await joinScrim(opponent.user.id, offer.id);
    expect(joined).toMatchObject({
      status: SCRIM_STATUS.SCHEDULED,
      hostTeam: { id: host.team.id },
      opponentTeam: { id: opponent.team.id },
      snapshottedParticipants: 1,
      cancelledOpenOffers: 2,
    });

    const [claimed, alternates, participants] = await Promise.all([
      prisma.scrim.findUniqueOrThrow({ where: { id: offer.id } }),
      prisma.scrim.findMany({
        where: { id: { in: [hostAlternate.id, opponentAlternate.id] } },
      }),
      prisma.scrimParticipant.findMany({
        where: { scrimId: offer.id },
        orderBy: { teamId: "asc" },
      }),
    ]);
    expect(claimed.opponentTeamId).toBe(opponent.team.id);
    expect(alternates.map((scrim) => scrim.status)).toEqual([
      SCRIM_STATUS.CANCELLED,
      SCRIM_STATUS.CANCELLED,
    ]);
    const survivors = await prisma.scrim.findMany({
      where: {
        id: {
          in: [distantHostOffer.id, nearbyThirdOffer.id, completedHistory.id],
        },
      },
      select: { id: true, status: true },
    });
    expect(new Map(survivors.map((scrim) => [scrim.id, scrim.status]))).toEqual(
      new Map([
        [distantHostOffer.id, SCRIM_STATUS.OPEN],
        [nearbyThirdOffer.id, SCRIM_STATUS.OPEN],
        [completedHistory.id, SCRIM_STATUS.COMPLETED],
      ]),
    );
    expect(participants).toHaveLength(2);
    expect(new Set(participants.map((participant) => participant.teamId))).toEqual(
      new Set([host.team.id, opponent.team.id]),
    );
    expect(participants.every((participant) => !participant.guest)).toBe(true);
  });

  it("allows exactly one opposing captain to claim an offer", async () => {
    const { teams } = await setupTeams();
    const [host, first, second] = teams;
    const offer = await createScrim(host.user.id, NIGHT(), 1);

    const outcomes = await raceAll([
      () => joinScrim(first.user.id, offer.id).then(() => "joined").catch(() => "lost"),
      () =>
        joinScrim(second.user.id, offer.id)
          .then(() => "joined")
          .catch(() => "lost"),
    ]);

    expect(outcomes.sort()).toEqual(["joined", "lost"]);
    const saved = await prisma.scrim.findUniqueOrThrow({
      where: { id: offer.id },
    });
    expect(saved.status).toBe(SCRIM_STATUS.SCHEDULED);
    expect([first.team.id, second.team.id]).toContain(saved.opponentTeamId);
    expect(
      await prisma.scrimParticipant.count({ where: { scrimId: offer.id } }),
    ).toBe(2);
  });

  it("blocks official-match collisions, self-joins, withdrawn teams, and bad scheduling input", async () => {
    const { season, teams } = await setupTeams();
    const [host, opponent, third] = teams;
    const night = NIGHT();

    await expect(createScrim(host.user.id, night, 0)).rejects.toThrow(/1 to 5/);
    await expect(
      createScrim(
        host.user.id,
        new Date(Date.now() + 181 * 24 * 60 * 60 * 1000),
        1,
      ),
    ).rejects.toThrow(/too far out/i);

    const offer = await createScrim(host.user.id, night, 1);
    await expect(joinScrim(host.user.id, offer.id)).rejects.toThrow(/own scrim/i);

    await prisma.match.create({
      data: {
        seasonId: season.id,
        week: 1,
        homeTeamId: opponent.team.id,
        awayTeamId: third.team.id,
        scheduledAt: new Date(night.getTime() + 3 * 60 * 60 * 1000),
        bestOf: 2,
      },
    });
    await expect(joinScrim(opponent.user.id, offer.id)).rejects.toThrow(
      /league match within four hours/i,
    );
    expect(
      (await prisma.scrim.findUniqueOrThrow({ where: { id: offer.id } })).status,
    ).toBe(SCRIM_STATUS.OPEN);

    await prisma.team.update({
      where: { id: third.team.id },
      data: { withdrawn: true },
    });
    await expect(createScrim(third.user.id, NIGHT(), 1)).rejects.toThrow(
      /withdrawn/i,
    );
  });

  it("lets coaches manage account-only guests on their side but not claim or cancel", async () => {
    const { season, teams } = await setupTeams();
    const [host, opponent] = teams;
    const coach = await makeUser("Host Coach");
    const outsider = await makeUser("Outsider");
    const staff = await addTeamCoach(host.user.id, false, coach.steamId);
    const offer = await createScrim(host.user.id, NIGHT(), 3);
    await joinScrim(opponent.user.id, offer.id);

    const guest = await addScrimGuest(
      coach.id,
      false,
      offer.id,
      "  Friday Stand-in  ",
      123_456_789,
    );
    expect(guest).toMatchObject({
      teamId: host.team.id,
      displayName: "Friday Stand-in",
      dotaAccountId: 123_456_789,
    });
    expect(
      await prisma.scrimParticipant.findUniqueOrThrow({
        where: { id: guest.id },
      }),
    ).toMatchObject({ guest: true, userId: null, addedById: coach.id });

    await expect(
      addScrimGuest(
        opponent.user.id,
        false,
        offer.id,
        "Duplicate opponent",
        123_456_789,
      ),
    ).rejects.toThrow(/opposing scrim lineup/i);
    await expect(
      removeScrimGuest(opponent.user.id, false, guest.id),
    ).rejects.toThrow(/own side/i);
    await expect(cancelScrim(coach.id, false, offer.id)).rejects.toThrow(
      /captain or admin/i,
    );
    await expect(joinScrim(coach.id, offer.id)).rejects.toThrow(/captain/i);
    await expect(
      addScrimGuest(outsider.id, false, offer.id, "No access", 223_456_789),
    ).rejects.toThrow(/captain, coach, or admin/i);

    await removeScrimGuest(coach.id, false, guest.id);
    expect(
      await prisma.scrimParticipant.findUnique({ where: { id: guest.id } }),
    ).toBeNull();

    await prisma.scrim.update({
      where: { id: offer.id },
      data: { status: SCRIM_STATUS.LIVE },
    });
    const betweenGames = await addScrimGuest(
      coach.id,
      false,
      offer.id,
      "Game two stand-in",
      323_456_789,
    );
    await removeScrimGuest(coach.id, false, betweenGames.id);
    await expect(cancelScrim(host.user.id, false, offer.id)).rejects.toThrow(
      /live scrim/i,
    );
    const liveScrim = await prisma.scrim.findUniqueOrThrow({
      where: { id: offer.id },
    });
    await expect(
      createScrim(host.user.id, liveScrim.scheduledAt, 1),
    ).rejects.toThrow(/confirmed scrim within four hours/i);

    await prisma.season.update({
      where: { id: season.id },
      data: { isActive: false, status: SEASON_STATUS.COMPLETE },
    });
    const archivedStandin = await addScrimGuest(
      coach.id,
      false,
      offer.id,
      "Archived game stand-in",
      423_456_789,
    );
    await removeScrimGuest(coach.id, false, archivedStandin.id);
    expect(
      await prisma.teamStaff.findUnique({ where: { id: staff.id } }),
    ).not.toBeNull();
  });

  it("enforces the five-guest side limit and supports verified admin coach repair", async () => {
    const { teams } = await setupTeams();
    const [host] = teams;
    const offer = await createScrim(host.user.id, NIGHT(), 1);
    for (let index = 0; index < 5; index += 1) {
      await addScrimGuest(
        host.user.id,
        false,
        offer.id,
        `Guest ${index + 1}`,
        300_000_000 + index,
      );
    }
    await expect(
      addScrimGuest(
        host.user.id,
        false,
        offer.id,
        "Guest 6",
        300_000_006,
      ),
    ).rejects.toThrow(/at most 5 guests/i);

    const admin = await makeUser("Allowlisted admin");
    const coach = await makeUser("Admin-selected coach");
    const previousAdminSteamIds = process.env.ADMIN_STEAM_IDS;
    process.env.ADMIN_STEAM_IDS = admin.steamId;
    try {
      await expect(
        addTeamCoach(admin.id, false, coach.steamId, host.team.id),
      ).rejects.toThrow(/captain or admin/i);
      const staff = await addTeamCoach(
        admin.id,
        true,
        coach.steamId,
        host.team.id,
      );
      expect(staff).toMatchObject({ teamId: host.team.id, userId: coach.id });
      await removeTeamCoach(admin.id, true, staff.id);
    } finally {
      if (previousAdminSteamIds === undefined) {
        delete process.env.ADMIN_STEAM_IDS;
      } else {
        process.env.ADMIN_STEAM_IDS = previousAdminSteamIds;
      }
    }
  });
});
