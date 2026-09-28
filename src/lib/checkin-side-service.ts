// Loads the viewer's side for the check-in banner (Home's panel, /schedule
// and the match page read it through here, so the three agree). Read-only:
// one match read, the two rosters, and that side's current check-ins.

import { prisma } from "./prisma";
import { REGISTRATION_STATUS } from "./constants";
import { getViewerRegistration } from "./queries";
import {
  canViewLeagueContact,
  canViewNamedMatchAvailability,
} from "./visibility";
import { checkinSide, type CheckinSideView } from "./checkin-side";

/**
 * The viewer's side in one match, or null when they aren't on its
 * match-night roster. Named answers are included only when the viewer may
 * see them (the two captains and admins) and the caller wants them: the
 * match page passes `names: false` because its Matchup card lists them.
 */
export async function loadCheckinSide(input: {
  matchId: string;
  viewer: { id: string; role: string };
  names?: boolean;
}): Promise<CheckinSideView | null> {
  const { viewer } = input;
  const team = {
    select: {
      id: true,
      name: true,
      captainId: true,
      captain: {
        select: { name: true, discordName: true, discordId: true },
      },
    },
  } as const;
  const match = await prisma.match.findUnique({
    where: { id: input.matchId },
    select: {
      seasonId: true,
      scheduleRevision: true,
      season: { select: { teamSize: true } },
      homeTeam: team,
      awayTeam: team,
      standins: {
        select: {
          teamId: true,
          standinUserId: true,
          replacingUserId: true,
          standin: { select: { name: true } },
          replaced: { select: { name: true } },
        },
      },
    },
  });
  if (!match) return null;

  const members = await prisma.teamMember.findMany({
    where: {
      seasonId: match.seasonId,
      teamId: { in: [match.homeTeam.id, match.awayTeam.id] },
    },
    select: { teamId: true, userId: true, user: { select: { name: true } } },
    // Roster reading order (lib/team-roster): the captain, then by price.
    orderBy: [{ isCaptain: "desc" }, { price: "desc" }, { user: { name: "asc" } }],
  });
  // A booked standin plays for the side that booked them; anyone else for
  // the roster they are on.
  const sideId =
    match.standins.find((s) => s.standinUserId === viewer.id)?.teamId ??
    members.find((m) => m.userId === viewer.id)?.teamId;
  const own =
    sideId === match.homeTeam.id
      ? match.homeTeam
      : sideId === match.awayTeam.id
        ? match.awayTeam
        : null;
  if (!own) return null;

  const roster = members
    .filter((m) => m.teamId === own.id)
    .map((m) => ({ userId: m.userId, name: m.user.name }));
  const bookings = match.standins
    .filter((s) => s.teamId === own.id)
    .map((s) => ({
      standinUserId: s.standinUserId,
      standinName: s.standin.name,
      replacingUserId: s.replacingUserId,
      replacingName: s.replaced?.name ?? null,
    }));
  const rows = await prisma.matchAvailability.findMany({
    where: {
      matchId: input.matchId,
      scheduleRevision: match.scheduleRevision,
      userId: {
        in: [
          ...roster.map((m) => m.userId),
          ...bookings.map((b) => b.standinUserId),
        ],
      },
    },
    select: { userId: true, status: true },
  });

  const side = checkinSide({
    viewerId: viewer.id,
    teamName: own.name,
    captain: { id: own.captainId, name: own.captain.name },
    roster,
    bookings,
    rows,
    teamSize: match.season.teamSize,
    showNames:
      input.names !== false &&
      canViewNamedMatchAvailability(
        viewer,
        match.homeTeam.captainId,
        match.awayTeam.captainId,
      ),
  });
  if (!side) return null;

  // Only a standin is shown their captain's handle: a rostered player
  // already knows who their captain is.
  let captainContact: CheckinSideView["captainContact"] = null;
  if (side.role === "standin" && own.captain.discordName) {
    const reg = await getViewerRegistration(match.seasonId, viewer.id);
    if (
      canViewLeagueContact(
        viewer,
        own.captainId,
        reg?.status === REGISTRATION_STATUS.ACTIVE,
      )
    ) {
      captainContact = {
        discordName: own.captain.discordName,
        discordId: own.captain.discordId,
      };
    }
  }
  return { ...side, captainContact };
}
