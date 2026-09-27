import { captainMmrWarning, unverifiedCaptainMmrsFor } from "./captain-mmr";
import { REGISTRATION_STATUS, REGISTRATION_TYPE } from "./constants";
import { draftReadinessCounts } from "./draft-readiness";
import {
  draftRosterCounts,
  draftSetupOpen,
  startDraftCheck,
  startDraftConfirm,
} from "./draft-setup";
import { prisma } from "./prisma";

export type StartDraftPreflight = {
  /** Start draft's confirm before the Discord line (StartDraftControl adds it). */
  confirm: string;
  canStart: boolean;
  /** Why Start is unavailable, when it is. */
  blocker: string | null;
};

/**
 * What the draft room's waiting room needs to offer an admin the Start draft
 * button: the same checks and confirm text as the Captains & draft card on
 * /admin, built by the same helpers from the same rows (the season's teams
 * and its ACTIVE PLAYER registrations). Null once setup has closed, when
 * there is nothing to start.
 */
export async function loadStartDraftPreflight(season: {
  id: string;
  status: string;
  teamSize: number;
  minTeams: number;
  draftAt: Date | null;
  budgetMmrWeight: number;
  draftRevision: number;
}): Promise<StartDraftPreflight | null> {
  const [draft, teams, players] = await Promise.all([
    prisma.draft.findUnique({
      where: { seasonId: season.id },
      select: { status: true },
    }),
    // Draft order, like /admin's query: the MMR warning names captains in
    // this order, and the two confirms must read the same.
    prisma.team.findMany({
      where: { seasonId: season.id },
      orderBy: { draftOrder: "asc" },
      select: {
        id: true,
        captainId: true,
        captain: { select: { name: true, rankTier: true } },
        members: { select: { userId: true, isCaptain: true } },
      },
    }),
    prisma.registration.findMany({
      where: {
        seasonId: season.id,
        status: REGISTRATION_STATUS.ACTIVE,
        type: REGISTRATION_TYPE.PLAYER,
      },
      select: {
        userId: true,
        mmr: true,
        draftConfirmedRevision: true,
        draftConfirmedAt: true,
      },
    }),
  ]);
  if (!draftSetupOpen(season.status, draft?.status)) return null;
  const { captainCount, boughtCount, poolCount } = draftRosterCounts(
    teams,
    players,
  );
  const { seats, canStart, blocker } = startDraftCheck({
    captainCount,
    teamSize: season.teamSize,
    poolCount,
    boughtCount,
  });
  const confirm = startDraftConfirm({
    captainCount,
    minTeams: season.minTeams,
    teamSize: season.teamSize,
    seats,
    draftScheduled: !!season.draftAt,
    confirmations: draftReadinessCounts(players, season.draftRevision),
    mmrWarning: captainMmrWarning(
      unverifiedCaptainMmrsFor(season, { draft, players, teams }),
    ),
  });
  return { confirm, canStart, blocker };
}
