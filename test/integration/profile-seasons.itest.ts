import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { SEASON_STATUS } from "@/lib/constants";
import { getRosterHistory } from "@/lib/player-roster-history";
import { profileSeasonNote, profileSeasonRows } from "@/lib/profile-seasons";
import { makeSeason, makeTeam, makeUser } from "./factories";

// The profile's Seasons card reads roster history (captured tenures plus the
// live-roster fallback) and says "Captain" / "Drafted for $X" in plain words.
// The captain flag is the part that lives in the database: older captured
// tenures record no captain status, so the live roster row has to supply it.
async function seasonRows(userId: string) {
  const tenures = await getRosterHistory(userId);
  const seasons = await prisma.season.findMany();
  return profileSeasonRows({
    seasons: new Map(seasons.map((s) => [s.id, s])),
    appearances: [],
    tenures,
    covers: [],
    teamNames: new Map(),
    champions: new Map(),
  });
}

describe("profile Seasons card roster facts", () => {
  it("names a captain from the live roster, captured or not", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.REGULAR_SEASON });
    const team = await makeTeam(season.id, "Alpha", 0);
    const uncaptured = await makeUser("Uncaptured captain");
    const captured = await makeUser("Captured captain");
    await prisma.teamMember.create({
      data: { seasonId: season.id, teamId: team.id, userId: uncaptured.id, isCaptain: true },
    });
    const member = await prisma.teamMember.create({
      data: { seasonId: season.id, teamId: team.id, userId: captured.id, isCaptain: true },
    });
    // What the admin backfill writes for a surviving membership: no
    // acquisition facts and no captain flag.
    await prisma.rosterTenure.create({
      data: {
        seasonId: season.id, teamId: team.id, userId: captured.id,
        sourceMembershipId: member.id, openKey: JSON.stringify([season.id, captured.id]),
        joinedAt: member.createdAt, startProvenance: "LEGACY_ROW",
        acquisitionKind: "LEGACY_CAPTURE", acquisitionPrice: 0,
        playerNameSnapshot: captured.name, teamNameSnapshot: team.name,
      },
    });

    for (const user of [uncaptured, captured]) {
      const rows = await seasonRows(user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ teamName: "Alpha", role: { kind: "captain" } });
      expect(profileSeasonNote(rows[0])).toBeNull();
    }
  });

  it("keeps a released player's original price and a departed captain's join record", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.COMPLETE, isActive: false });
    const team = await makeTeam(season.id, "Bravo", 0);
    const released = await makeUser("Released");
    const departedCaptain = await makeUser("Departed captain");
    const base = {
      seasonId: season.id, teamId: team.id, joinedAt: new Date("2026-02-01"),
      endedAt: new Date("2026-03-01"), closedAt: new Date("2026-03-01"),
      startProvenance: "COMMAND", endProvenance: "COMMAND", teamNameSnapshot: team.name,
    };
    // Both memberships are gone; only the tenure remains.
    await prisma.rosterTenure.createMany({
      data: [
        {
          ...base, userId: released.id, sourceMembershipId: "gone-1",
          acquisitionKind: "AUCTION", acquisitionPrice: 23, isCaptainAtJoin: false,
          endReason: "RELEASE", playerNameSnapshot: released.name,
        },
        {
          ...base, userId: departedCaptain.id, sourceMembershipId: "gone-2",
          acquisitionKind: "CAPTAIN_DESIGNATION", acquisitionPrice: 0, isCaptainAtJoin: true,
          playerNameSnapshot: departedCaptain.name,
        },
      ],
    });

    const [releasedRow] = await seasonRows(released.id);
    expect(profileSeasonNote(releasedRow)).toBe("Drafted for $23");
    const [captainRow] = await seasonRows(departedCaptain.id);
    expect(captainRow.role).toEqual({ kind: "captain" });
  });
});
