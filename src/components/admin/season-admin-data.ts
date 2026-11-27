import { shortTeams } from "@/lib/admin-attention";
import { getActiveSeason } from "@/lib/season";
import { prisma } from "@/lib/prisma";
import {
  MATCH_PHASE,
  REGISTRATION_STATUS,
  STANDIN_REQUEST_STATUS,
} from "@/lib/constants";
import { STANDIN_REQUEST_VIEW } from "@/lib/standin-service";
import {
  getSetting,
  playoffGamesArchiveKey,
  tiebreakerGamesArchiveKey,
} from "@/lib/settings";
import { loadLeagueFeedWaiting } from "@/lib/league-feed-wait-service";
import { loadFreeAgentBaselines } from "@/lib/free-agent-rule-service";
import { MATCH_LIST_ORDER } from "@/lib/schedule";
import { adminStandinPoolWhere } from "@/components/admin-match-tools";
import { readCaptainPresence } from "@/lib/draft-presence-service";

type ArchivedPlayoffGame = { dotaMatchId: string; slot: string; week: number };

/** Tolerate a corrupt archive rather than 500 the whole admin page over it. */
function parsePlayoffArchive(raw: string | null): ArchivedPlayoffGame[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ArchivedPlayoffGame[]) : [];
  } catch {
    return [];
  }
}

/** A signup row's user, plus the medal approval its "over the medal line"
 *  flag reads (regSignupFlags). Players and the standin pool share it, since
 *  both render through SignupRowMeta. */
const SIGNUP_ROW_INCLUDE = {
  user: {
    include: { medalApproval: { select: { status: true, mmr: true, reason: true } } },
  },
} as const;

export async function loadSeasonAdminData(seasonId: string, teamSize: number) {
  const [
    players,
    standins,
    removed,
    teams,
    matches,
    draft,
    assignments,
    standinRequests,
  ] =
    await Promise.all([
      prisma.registration.findMany({
        where: { seasonId, status: "ACTIVE", type: "PLAYER" },
        include: SIGNUP_ROW_INCLUDE,
        orderBy: [{ wantsCaptain: "desc" }, { mmr: "desc" }],
      }),
      // Registered standins PLUS undrafted full players — the same pool the
      // match page's Admin tools offer (adminStandinPoolWhere).
      prisma.registration.findMany({
        where: adminStandinPoolWhere(seasonId),
        include: SIGNUP_ROW_INCLUDE,
        orderBy: { mmr: "desc" },
      }),
      // Admin-removed signups: listed so the removal stays reversible (the
      // player can no longer re-add themselves from /me).
      prisma.registration.findMany({
        where: { seasonId, status: REGISTRATION_STATUS.REMOVED },
        include: { user: true },
        orderBy: { mmr: "desc" },
      }),
      prisma.team.findMany({
        where: { seasonId },
        orderBy: { draftOrder: "asc" },
        include: { captain: true, members: { include: { user: true } } },
      }),
      prisma.match.findMany({
        where: { seasonId },
        orderBy: MATCH_LIST_ORDER,
        include: {
          games: { select: { id: true, dotaMatchId: true, winnerTeamId: true, durationSecs: true } },
          availability: { select: { id: true, userId: true, status: true, scheduleRevision: true } },
          standins: {
            select: {
              id: true,
              teamId: true,
              standinUserId: true,
              replacingUserId: true,
            },
          },
          predictions: {
            select: { id: true, userId: true, pickedTeamId: true },
          },
          reschedules: {
            select: {
              id: true,
              proposedById: true,
              proposedTime: true,
              status: true,
            },
          },
        },
      }),
      prisma.draft.findUnique({ where: { seasonId } }),
      prisma.standinAssignment.findMany({
        where: { match: { seasonId } },
        include: { standin: true, replaced: true },
      }),
      // Captains' standin requests waiting for the other captain's OK (the
      // MMR rule), for the Standin assignments card's Agree and Decline.
      prisma.standinRequest.findMany({
        where: {
          status: STANDIN_REQUEST_STATUS.PENDING,
          match: { seasonId, status: { not: "COMPLETED" } },
        },
        include: STANDIN_REQUEST_VIEW,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
    ]);
  const outRsvps = await prisma.matchAvailability.findMany({
    where: { match: { seasonId }, status: "OUT" },
    include: { user: true },
  });
  // Captains with the draft room open as this page renders, for the
  // Start-draft confirm (the draft room itself shows it live).
  const captainsInRoom = await readCaptainPresence(
    prisma,
    seasonId,
    teams.map((t) => t.captainId),
  );
  // OpenDota ids of playoff games a bracket reset deleted. Archived by
  // createPlayoffBracket so the postseason can be re-imported by hand — without
  // them the ids were simply gone, which is what made "recreate the bracket"
  // (the only correction path past an advanced round) irreversible.
  const [playoffArchive, tiebreakerArchive] = await Promise.all([
    getSetting(playoffGamesArchiveKey(seasonId)),
    getSetting(tiebreakerGamesArchiveKey(seasonId)),
  ]);
  // What a schedule REGENERATE would destroy. These rows hang off a fixture id
  // and cascade with it, and none of them is archived anywhere — so the confirm
  // has to be able to state them BEFORE the click, not just the toast after.
  const regularWhere = { match: { seasonId, phase: MATCH_PHASE.REGULAR } };
  // ALL ACTIVE registrations, standins included — deliberately the same
  // population as getDiscordReachFunnel's, because the next-step banner quotes
  // this number and then points at that card ("names them"); counting only
  // data.players (type PLAYER) made the two disagree whenever an unlinked
  // standin existed. DB-only, so the blocking path stays Discord-free.
  const [rsvps, picks, covers, proposals, unlinkedDiscord, importsNeedingReview, feedWaiting, freeAgentBaselines] = await Promise.all([
    prisma.matchAvailability.count({ where: regularWhere }),
    prisma.prediction.count({ where: regularWhere }),
    prisma.standinAssignment.count({ where: regularWhere }),
    prisma.rescheduleRequest.count({
      where: { ...regularWhere, status: "PENDING" },
    }),
    prisma.registration.count({
      where: {
        seasonId,
        status: REGISTRATION_STATUS.ACTIVE,
        user: { discordId: null },
      },
    }),
    // Imports the automatic sync could not place on its own (Auto-sync card).
    prisma.importCandidate.count({
      where: { seasonId, status: "NEEDS_REVIEW" },
    }),
    // Feed games the last automatic league-feed pass stopped on.
    loadLeagueFeedWaiting(seasonId),
    // Who a signing onto each short team would replace, for the sign form's
    // team options (Roster moves). Short teams only, all in one batch.
    loadFreeAgentBaselines(
      prisma,
      seasonId,
      shortTeams(teams, teamSize).map(({ team }) => ({
        id: team.id,
        name: team.name,
        memberUserIds: team.members.map((m) => m.userId),
      })),
    ),
  ]);
  // The waiting standin requests a regenerate cascades away with the regular
  // fixtures (replaceRegularSchedule counts them in its toast and log), from
  // the requests already loaded. Those skip COMPLETED matches, which can't
  // matter here: any regular-season result locks the regenerate.
  const regularMatchIds = new Set(
    matches
      .filter((match) => match.phase === MATCH_PHASE.REGULAR)
      .map((match) => match.id),
  );
  const requests = standinRequests.filter((request) =>
    regularMatchIds.has(request.matchId),
  ).length;
  return {
    players,
    standins,
    removed,
    teams,
    matches: matches.map((match) => ({ ...match, availability: match.availability.filter((rsvp) => rsvp.scheduleRevision === match.scheduleRevision) })),
    draft,
    assignments,
    standinRequests,
    outRsvps: outRsvps.filter((rsvp) => rsvp.scheduleRevision === matches.find((match) => match.id === rsvp.matchId)?.scheduleRevision),
    playoffArchive: parsePlayoffArchive(playoffArchive),
    tiebreakerArchive: parsePlayoffArchive(tiebreakerArchive),
    collateral: { rsvps, picks, covers, proposals, requests },
    unlinkedDiscord,
    importsNeedingReview,
    feedWaiting,
    captainsInRoom,
    freeAgentBaselines,
  };
}

export type AdminData = Awaited<ReturnType<typeof loadSeasonAdminData>>;

export type Season = NonNullable<Awaited<ReturnType<typeof getActiveSeason>>>;
