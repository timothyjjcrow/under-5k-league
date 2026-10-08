"use server";

// Admin actions for captains and the draft: add, remove, change and transfer
// captains, the draft order, draft night, starting the auction and the
// draft-night controls (pause, resume, undo a sale, void a lot, abort), plus
// the "Sync ranks & stats" refresh on the Captains & draft card.

import { updateTag } from "next/cache";
import { AUTOMATION_GATE_TAG } from "@/lib/automation-gate-constants";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { raceHook } from "@/lib/race-hook";
import {
  captureRosterTenure,
  closeRosterTenure,
  recordHistoryAction,
} from "@/lib/roster-history";
import { startDraftRun } from "@/lib/draft-history";
import { getActiveSeason } from "@/lib/season";
import {
  SEASON_STATUS,
  REGISTRATION_TYPE,
  REGISTRATION_STATUS,
  DRAFT_STATUS,
  MATCH_STATUS,
  DOTA_MATCH_KIND,
  DEFAULTS,
  HARD_MMR_CEILING,
} from "@/lib/constants";
import { mmrWeightedBudgets, shuffle } from "@/lib/draft";
import {
  captainTransferOpen,
  draftReminderDue,
  draftSeatPlan,
  draftSetupLockedMessage,
  draftSetupOpen,
} from "@/lib/draft-setup";
import { rankMedalName } from "@/lib/rank";
import {
  abortDraft,
  pauseDraft,
  resumeDraft,
  undoLastSale,
  voidCurrentLot,
} from "@/lib/draft-service";
import { enrichStoredGames } from "@/lib/match-import";
import {
  MANUAL_REFRESH_BUDGET_MS,
  refreshSteamProfiles,
  syncRanksFor,
} from "@/lib/player-data-refresh";
import { profileSyncAllowed } from "@/lib/draft-admin";
import { localDate, str } from "@/lib/form";
import { formatLeagueTime } from "@/lib/zoned-time";
import {
  draftStartedAnnouncement,
  draftAbortedMessage,
  draftLotVoidedMessage,
  draftPausedMessage,
  draftResumedMessage,
  draftSaleUndoneMessage,
  standinRemovedMessage,
  sendDiscordMessage,
  draftCancelledMessage,
  draftRescheduledMessage,
  draftScheduledMessage,
  captainAssignedMessage,
  captainChangedMessage,
  captainRemovedMessage,
  draftLiveAnnouncementGroup,
} from "@/lib/discord";
import {
  expireLeagueAnnouncementGroup,
} from "@/lib/league-announcement-outbox";
import { mentionsOf } from "@/lib/discord-mentions";
import { logAdminAction } from "@/lib/admin-log";
import { draftReminderKey, draftReminderPrefix } from "@/lib/settings";
import {
  invalidatePendingAnnouncementMarkers,
  recordAnnouncementCovered,
} from "@/lib/announcement-marker";
import { medalProvesIneligible } from "@/lib/registration";
import type { ActionResult } from "@/lib/action-result";
import {
  carriedTeamIdentity,
  carriedTeamIdentityNote,
  uniqueDefaultTeamName,
  teamNameAfterCaptainChange,
} from "@/lib/team-identity";
import {
  isSerializationConflict,
  isUniqueViolation,
} from "@/lib/prisma-errors";
import {
  adminOrError,
  ActiveSeasonChangedError,
  ResultsLandedError,
  DraftAlreadyStartedError,
  DraftSetupLockedError,
  CaptainStateChangedError,
  refresh,
  refreshGames,
} from "./admin-shared";

class DraftOrderConflictError extends Error {}

class DraftStartPreflightError extends Error {}

/** Designate a registered player as a team captain (creates their team). */
export async function addCaptain(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const actor = await adminOrError();
  if ("error" in actor) return actor;
  const userId = str(formData, "userId");
  const expectedActiveSeasonId = str(formData, "expectedActiveSeasonId").trim();
  const season = await getActiveSeason();
  if (
    !season ||
    !expectedActiveSeasonId ||
    expectedActiveSeasonId !== season.id
  ) {
    return {
      error:
        "The active season changed while this page was open — reload before designating a captain.",
    };
  }

  await raceHook("admin.addCaptain.beforeTx");
  let added: {
    name: string;
    teamName: string;
    discordId: string | null;
    carriedNote: string;
  };
  try {
    added = await prisma.$transaction(
      async (tx) => {
        const [
          currentSeason,
          draft,
          user,
          reg,
          existing,
          highest,
          previousTeam,
          seasonTeams,
        ] = await Promise.all([
            tx.season.findUnique({ where: { id: expectedActiveSeasonId } }),
            tx.draft.findUnique({
              where: { seasonId: expectedActiveSeasonId },
              select: { status: true },
            }),
            tx.user.findUnique({ where: { id: userId } }),
            tx.registration.findUnique({
              where: {
                seasonId_userId: {
                  seasonId: expectedActiveSeasonId,
                  userId,
                },
              },
            }),
            tx.team.findUnique({
              where: {
                seasonId_captainId: {
                  seasonId: expectedActiveSeasonId,
                  captainId: userId,
                },
              },
            }),
            // NOT team.count(): a legacy gap must not reuse an occupied order.
            tx.team.findFirst({
              where: { seasonId: expectedActiveSeasonId },
              orderBy: { draftOrder: "desc" },
              select: { draftOrder: true },
            }),
            // A returning captain's last team, by THIS account as captain only:
            // a different captain never inherits another team's identity.
            tx.team.findFirst({
              where: {
                captainId: userId,
                seasonId: { not: expectedActiveSeasonId },
              },
              orderBy: [{ season: { createdAt: "desc" } }, { createdAt: "desc" }],
              select: { name: true, logoUrl: true },
            }),
            tx.team.findMany({
              where: { seasonId: expectedActiveSeasonId },
              select: { name: true },
            }),
          ]);
        if (!currentSeason?.isActive) throw new ActiveSeasonChangedError();
        if (!draftSetupOpen(currentSeason.status, draft?.status)) {
          throw new DraftSetupLockedError(
            draftSetupLockedMessage(currentSeason.status, draft?.status),
          );
        }
        if (!user) throw new CaptainStateChangedError("Unknown user");
        if (
          !reg ||
          reg.status !== REGISTRATION_STATUS.ACTIVE ||
          reg.type !== REGISTRATION_TYPE.PLAYER
        ) {
          throw new CaptainStateChangedError(
            `${user.name} isn't an active player signup this season`,
          );
        }
        if (existing) {
          throw new CaptainStateChangedError(
            `${user.name} already captains a team`,
          );
        }

        const order = highest ? highest.draftOrder + 1 : 0;
        // Keep last time's name and logo so a returning captain's identity
        // (and the champions' name) survives the season change.
        const carried = carriedTeamIdentity(
          previousTeam,
          seasonTeams.map((team) => team.name),
        );
        // The default is numbered past a name another team already took
        // (a captain may have renamed their team to "<this captain>'s Team").
        const teamName =
          carried.name ??
          uniqueDefaultTeamName(
            user.name,
            seasonTeams.map((team) => team.name),
          );
        const team = await tx.team.create({
          data: {
            seasonId: currentSeason.id,
            name: teamName,
            logoUrl: carried.logoUrl,
            captainId: user.id,
            budget: currentSeason.draftBudget,
            draftOrder: order,
          },
        });
        const member = await tx.teamMember.create({
          data: {
            seasonId: currentSeason.id,
            teamId: team.id,
            userId: user.id,
            isCaptain: true,
            price: 0,
          },
        });
        await captureRosterTenure(tx, member, { kind: "CAPTAIN_DESIGNATION", mmr: reg.mmr || null, roles: reg.roles, actorId: actor.id });
        return {
          name: user.name,
          teamName,
          discordId: user.discordId,
          carriedNote: carriedTeamIdentityNote(carried),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (
      error instanceof ActiveSeasonChangedError ||
      isSerializationConflict(error)
    ) {
      return {
        error:
          "The season or captain list just changed — reload and try again.",
      };
    }
    if (error instanceof DraftSetupLockedError) {
      return { error: error.message };
    }
    if (error instanceof CaptainStateChangedError) {
      return { error: error.message };
    }
    if (isUniqueViolation(error)) {
      return {
        error:
          "That player was just designated as a captain — reload to see the team.",
      };
    }
    throw error;
  }
  await logAdminAction({
    action: "addCaptain",
    summary: `Designated ${added.name} as captain of "${added.teamName}"${added.carriedNote ? " (kept from their last team)" : ""}`,
    seasonId: season.id,
  });
  await sendDiscordMessage(
    captainAssignedMessage(added.name, added.teamName, added.discordId),
    mentionsOf([added.discordId]),
  );
  refresh();
  return {
    message: added.carriedNote
      ? `${added.name} is now a captain. ${added.carriedNote}`
      : `${added.name} is now a captain`,
  };
}

/** Undo captain designation (only allowed before the draft starts). */
export async function removeCaptain(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const actor = await adminOrError();
  if ("error" in actor) return actor;
  const teamId = str(formData, "teamId");
  const expectedActiveSeasonId = str(formData, "expectedActiveSeasonId").trim();
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  if (!expectedActiveSeasonId || expectedActiveSeasonId !== season.id) {
    return {
      error:
        "The active season changed while this page was open — reload before removing a captain.",
    };
  }

  // Match→Team is RESTRICT (prisma/schema.prisma), so a bare team.delete throws
  // P2003 the moment a schedule exists — and because nothing caught it, the
  // error escaped the action and ActionForm rendered it as "Couldn't reach the
  // server", sending admins after a phantom network fault. Worse, it was a dead
  // end: regenerating the schedule just recreates matches for the same teams.
  // Removing a team invalidates the round robin anyway, so clear the fixtures
  // in the same transaction and tell the admin to regenerate.
  //
  // The RESULTS COUNTS below are what make that delete safe — NOT the draft
  // guard above, as this comment used to claim. That claim holds only while a
  // Draft row exists: `createSeason` never creates one, and legacy seasons may
  // already have reached REGULAR_SEASON without ever pressing Start draft (or
  // may be recovering from abortDraft, which leaves the draft NOT_STARTED).
  // The current phase policy blocks that new jump, but this destructive action
  // still has to defend old and repaired data. Removing a captain-only team ran a
  // season-wide match deleteMany — every Game, RSVP, prediction, standin
  // booking and reschedule record gone by cascade, with no undo. Same pair
  // generateSchedule and abortDraft check.
  // Seam: the rival is an auto-sync import completing a match between the
  // admin's click and the authoritative transaction below.
  await raceHook("admin.removeCaptain.beforeTx");
  let removed: {
    captainName: string;
    captainDiscordId: string | null;
    teamName: string;
    fixtures: number;
  };
  try {
    removed = await prisma.$transaction(
      async (tx) => {
        const [currentSeason, draft, team, playedNow, gamesNow, fixtures] =
          await Promise.all([
            tx.season.findUnique({ where: { id: expectedActiveSeasonId } }),
            tx.draft.findUnique({
              where: { seasonId: expectedActiveSeasonId },
              select: { status: true },
            }),
            tx.team.findUnique({
              where: { id: teamId },
              include: { members: true, captain: true },
            }),
            tx.match.count({
              where: {
                seasonId: expectedActiveSeasonId,
                status: MATCH_STATUS.COMPLETED,
              },
            }),
            tx.game.count({
              where: { match: { seasonId: expectedActiveSeasonId } },
            }),
            tx.match.count({
              where: {
                seasonId: expectedActiveSeasonId,
                OR: [{ homeTeamId: teamId }, { awayTeamId: teamId }],
              },
            }),
          ]);
        if (!currentSeason?.isActive) throw new ActiveSeasonChangedError();
        if (!draftSetupOpen(currentSeason.status, draft?.status)) {
          throw new DraftSetupLockedError(
            draftSetupLockedMessage(currentSeason.status, draft?.status),
          );
        }
        if (!team || team.seasonId !== currentSeason.id) {
          throw new CaptainStateChangedError("Unknown team");
        }
        if (team.members.some((m) => !m.isCaptain)) {
          throw new CaptainStateChangedError(
            `${team.name} already has players on its roster`,
          );
        }
        if (playedNow > 0 || gamesNow > 0) throw new ResultsLandedError();

        // Scrims cascade through Team, while their polymorphic ownership
        // claims deliberately have no FK. Gather and clear those claims in
        // this same transaction so removing a pre-draft captain cannot leave
        // a Valve match id permanently reserved by a deleted scrim.
        const scrimDotaIds = (
          await tx.scrimGame.findMany({
            where: {
              scrim: {
                OR: [{ hostTeamId: team.id }, { opponentTeamId: team.id }],
              },
            },
            select: { dotaMatchId: true },
          })
        ).map((game) => game.dotaMatchId);
        if (scrimDotaIds.length > 0) {
          await tx.dotaMatchClaim.deleteMany({
            where: {
              dotaMatchId: { in: scrimDotaIds },
              kind: DOTA_MATCH_KIND.SCRIM,
            },
          });
        }

        if (fixtures > 0) {
          await tx.match.deleteMany({ where: { seasonId: currentSeason.id } });
        }
        const historyAt = new Date();
        for (const member of team.members) await closeRosterTenure(tx, member, "PRE_DRAFT_TEAM_REMOVED", actor.id, historyAt);
        const gone = await tx.team.deleteMany({
          where: {
            id: team.id,
            seasonId: currentSeason.id,
            captainId: team.captainId,
          },
        });
        if (gone.count === 0) throw new CaptainStateChangedError();

        // Keep the visible rotation a contiguous 1..N after a removal. Legacy
        // gaps are harmless to the engine but look like a missing captain.
        const remaining = await tx.team.findMany({
          where: { seasonId: currentSeason.id },
          orderBy: { draftOrder: "asc" },
          select: { id: true },
        });
        await Promise.all(
          remaining.map((candidate, index) =>
            tx.team.updateMany({
              where: { id: candidate.id, seasonId: currentSeason.id },
              data: { draftOrder: index },
            }),
          ),
        );
        return {
          captainName: team.captain.name,
          captainDiscordId: team.captain.discordId,
          teamName: team.name,
          fixtures,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (e) {
    if (e instanceof ResultsLandedError) {
      return {
        error:
          "A result landed while you were removing that team — nothing was changed. Reload and check the schedule.",
      };
    }
    if (e instanceof DraftSetupLockedError) return { error: e.message };
    if (e instanceof CaptainStateChangedError) {
      return {
        error:
          e.message ||
          "That team or captain just changed — reload before removing it.",
      };
    }
    if (
      e instanceof ActiveSeasonChangedError ||
      isSerializationConflict(e)
    ) {
      return {
        error:
          "The season, draft, or captain list just changed — reload and try again.",
      };
    }
    throw e;
  }
  await logAdminAction({
    action: "removeCaptain",
    summary:
      `Removed ${removed.captainName} as captain and deleted team "${removed.teamName}"` +
      (removed.fixtures
        ? " — the season's whole schedule was cleared with it"
        : ""),
    seasonId: season.id,
  });
  // addCaptain pinged them "you now captain X"; correct that in the channel.
  await sendDiscordMessage(
    captainRemovedMessage(
      { name: removed.captainName, discordId: removed.captainDiscordId },
      removed.teamName,
    ),
    mentionsOf([removed.captainDiscordId]),
  );
  refresh();
  return {
    message: removed.fixtures
      ? `${removed.captainName} is no longer a captain — the schedule was cleared, regenerate it once captains are final`
      : `${removed.captainName} is no longer a captain`,
  };
}

/**
 * Before the draft, hand a team to a different signup without deleting it.
 *
 * Remove captain + make captain used to be the only way, and it threw away the
 * team row: its name, logo and draft-order slot, with a fresh "<name>'s Team"
 * in their place. This keeps the team and swaps only who captains it. The
 * outgoing captain drops back into the player pool as an ordinary signup (a
 * pre-draft roster is the captain alone), and the incoming one takes the
 * captain's roster seat at $0, exactly as addCaptain would have seated them.
 *
 * Same lock as the rest of captain setup (draftSetupOpen), judged again at
 * the WRITE: the Team claim re-asserts the captain it read, that the season is
 * still active in SIGNUPS/DRAFT, and that the auction has not started. A Start
 * draft racing this click therefore sees either the old captain or the new
 * one, never a team whose captain changed after the auction began.
 */
export async function changeCaptain(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const actor = await adminOrError();
  if ("error" in actor) return actor;
  const teamId = str(formData, "teamId");
  const newCaptainUserId = str(formData, "newCaptainUserId").trim();
  const expectedActiveSeasonId = str(formData, "expectedActiveSeasonId").trim();
  const expectedCaptainUserId = str(formData, "expectedCaptainUserId").trim();
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  if (!expectedActiveSeasonId || expectedActiveSeasonId !== season.id) {
    return {
      error:
        "The active season changed while this page was open — reload before changing a captain.",
    };
  }
  if (!expectedCaptainUserId) {
    return { error: "Reload the team before changing its captain." };
  }
  if (!newCaptainUserId) return { error: "Pick the new captain." };

  // Seam: the rival is a Start draft (or another admin's captain change)
  // committing between this click and the transaction below.
  await raceHook("admin.changeCaptain.beforeTx");
  let changed: {
    teamName: string;
    renamedFrom: string | null;
    incomingName: string;
    outgoingName: string;
    incomingDiscordId: string | null;
    outgoingDiscordId: string | null;
  };
  try {
    changed = await prisma.$transaction(
      async (tx) => {
        const [
          currentSeason,
          draft,
          team,
          incomingUser,
          incomingReg,
          incomingSeat,
          outgoingCover,
          otherTeams,
        ] = await Promise.all([
          tx.season.findUnique({ where: { id: expectedActiveSeasonId } }),
          tx.draft.findUnique({
            where: { seasonId: expectedActiveSeasonId },
            select: { status: true },
          }),
          tx.team.findUnique({
            where: { id: teamId },
            include: { members: true, captain: true },
          }),
          tx.user.findUnique({ where: { id: newCaptainUserId } }),
          tx.registration.findUnique({
            where: {
              seasonId_userId: {
                seasonId: expectedActiveSeasonId,
                userId: newCaptainUserId,
              },
            },
          }),
          // Captains hold a roster seat, so one lookup answers both "already
          // captains a team" and "already on a roster".
          tx.teamMember.findUnique({
            where: {
              seasonId_userId: {
                seasonId: expectedActiveSeasonId,
                userId: newCaptainUserId,
              },
            },
          }),
          // Cover booked for the outgoing captain would point at someone no
          // longer on the team (withdrawGateError's refuse-don't-cancel rule).
          tx.standinAssignment.count({
            where: {
              replacingUserId: expectedCaptainUserId,
              teamId,
              match: {
                seasonId: expectedActiveSeasonId,
                status: { not: MATCH_STATUS.COMPLETED },
              },
            },
          }),
          tx.team.findMany({
            where: { seasonId: expectedActiveSeasonId, id: { not: teamId } },
            select: { name: true },
          }),
        ]);
        if (!currentSeason?.isActive) throw new ActiveSeasonChangedError();
        if (!draftSetupOpen(currentSeason.status, draft?.status)) {
          throw new DraftSetupLockedError(
            draftSetupLockedMessage(currentSeason.status, draft?.status),
          );
        }
        if (!team || team.seasonId !== currentSeason.id) {
          throw new CaptainStateChangedError("Unknown team");
        }
        if (team.captainId !== expectedCaptainUserId) {
          throw new CaptainStateChangedError(
            `${team.name}'s captain already changed — reload and try again.`,
          );
        }
        if (team.captainId === newCaptainUserId) {
          throw new CaptainStateChangedError(
            `${team.captain.name} already captains ${team.name}`,
          );
        }
        if (team.members.some((m) => !m.isCaptain)) {
          throw new CaptainStateChangedError(
            `${team.name} already has players on its roster`,
          );
        }
        const outgoing = team.members.find(
          (m) => m.userId === expectedCaptainUserId && m.isCaptain,
        );
        if (!outgoing) {
          throw new CaptainStateChangedError(
            "The current captain's roster spot is missing — reload and try again.",
          );
        }
        if (!incomingUser) throw new CaptainStateChangedError("Unknown player");
        if (
          !incomingReg ||
          incomingReg.status !== REGISTRATION_STATUS.ACTIVE ||
          incomingReg.type !== REGISTRATION_TYPE.PLAYER
        ) {
          throw new CaptainStateChangedError(
            `${incomingUser.name} isn't an active player signup this season`,
          );
        }
        if (incomingSeat) {
          throw new CaptainStateChangedError(
            `${incomingUser.name} already captains a team`,
          );
        }
        if (outgoingCover > 0) {
          throw new CaptainStateChangedError(
            `${team.captain.name} has standin cover booked on an unplayed match — remove that booking first.`,
          );
        }

        const teamName = teamNameAfterCaptainChange(
          team.name,
          team.captain.name,
          incomingUser.name,
          otherTeams.map((other) => other.name),
        );
        // THE claim: the captain this request judged, and the setup window it
        // judged it in, re-asserted at the write. Losing it throws, so nothing
        // below commits.
        const claimed = await tx.team.updateMany({
          where: {
            id: team.id,
            seasonId: currentSeason.id,
            captainId: expectedCaptainUserId,
            season: {
              isActive: true,
              status: { in: [SEASON_STATUS.SIGNUPS, SEASON_STATUS.DRAFT] },
              OR: [
                { draft: { is: null } },
                { draft: { is: { status: DRAFT_STATUS.NOT_STARTED } } },
              ],
            },
          },
          data: { captainId: incomingUser.id, name: teamName },
        });
        if (claimed.count === 0) throw new CaptainStateChangedError();

        const historyAt = new Date();
        await closeRosterTenure(
          tx,
          outgoing,
          "PRE_DRAFT_CAPTAIN_CHANGED",
          actor.id,
          historyAt,
        );
        const vacated = await tx.teamMember.deleteMany({
          where: {
            id: outgoing.id,
            teamId: team.id,
            userId: expectedCaptainUserId,
            isCaptain: true,
          },
        });
        if (vacated.count === 0) throw new CaptainStateChangedError();
        const seat = await tx.teamMember.create({
          data: {
            seasonId: currentSeason.id,
            teamId: team.id,
            userId: incomingUser.id,
            isCaptain: true,
            price: 0,
          },
        });
        await captureRosterTenure(
          tx,
          seat,
          {
            kind: "CAPTAIN_DESIGNATION",
            mmr: incomingReg.mmr || null,
            roles: incomingReg.roles,
            actorId: actor.id,
          },
          historyAt,
        );
        return {
          teamName,
          renamedFrom: teamName === team.name ? null : team.name,
          incomingName: incomingUser.name,
          outgoingName: team.captain.name,
          incomingDiscordId: incomingUser.discordId,
          outgoingDiscordId: team.captain.discordId,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (error instanceof DraftSetupLockedError) return { error: error.message };
    if (error instanceof CaptainStateChangedError) {
      return {
        error:
          error.message ||
          "That team or captain just changed — reload and try again.",
      };
    }
    if (
      error instanceof ActiveSeasonChangedError ||
      isSerializationConflict(error)
    ) {
      return {
        error:
          "The season, draft, or captain list just changed — reload and try again.",
      };
    }
    if (isUniqueViolation(error)) {
      return {
        error:
          "That player was just made a captain elsewhere — reload and try again.",
      };
    }
    throw error;
  }
  await logAdminAction({
    action: "changeCaptain",
    summary:
      `Changed the captain of "${changed.teamName}" from ${changed.outgoingName} to ${changed.incomingName}` +
      (changed.renamedFrom ? ` (renamed from "${changed.renamedFrom}")` : ""),
    seasonId: season.id,
  });
  // One post for both: the outgoing captain's own "you now captain" ping
  // would otherwise stand uncorrected (the removeCaptain rule).
  await sendDiscordMessage(
    captainChangedMessage(
      { name: changed.incomingName, discordId: changed.incomingDiscordId },
      { name: changed.outgoingName, discordId: changed.outgoingDiscordId },
      changed.teamName,
      changed.renamedFrom,
    ),
    mentionsOf([changed.incomingDiscordId, changed.outgoingDiscordId]),
  );
  refresh();
  return {
    message: `${changed.incomingName} now captains ${changed.teamName}${
      changed.renamedFrom ? ` (renamed from ${changed.renamedFrom})` : ""
    }. ${changed.outgoingName} is back in the player pool.`,
  };
}

/**
 * Hand a team's captaincy to one of its own rostered players.
 *
 * Before this existed, `Team.captainId` was written in exactly one place —
 * `addCaptain`'s team.create — and every exit was closed once the draft
 * started: removeCaptain and releasePlayer both refuse, and withdrawGateError
 * literally tells the admin to "replace the captain first", an operation the
 * codebase never implemented. A captain going inactive mid-season therefore
 * cost that team its self-serve reschedule/standin/result-reporting powers
 * AND left their roster seat permanently occupied (signFreeAgent counts it),
 * recoverable only by hand-editing the database.
 *
 * Deliberately narrow: promote an existing team member. The outgoing captain
 * stays on the roster as a normal player, which is what makes them releasable
 * afterwards — so "replace the captain, then free the seat" is now two
 * supported clicks.
 */
export async function transferCaptaincy(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const actor = await adminOrError();
  if ("error" in actor) return actor;
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };

  const teamId = str(formData, "teamId");
  const newCaptainUserId = str(formData, "newCaptainUserId");
  const expectedActiveSeasonId = str(formData, "expectedActiveSeasonId").trim();
  const expectedCaptainUserId = str(formData, "expectedCaptainUserId").trim();
  if (!expectedActiveSeasonId || expectedActiveSeasonId !== season.id) {
    return {
      error:
        "The active season changed while this page was open — reload before handing over captaincy.",
    };
  }
  if (!expectedCaptainUserId) {
    return { error: "Reload the team before handing over captaincy." };
  }

  await raceHook("admin.transferCaptaincy.beforeTx");
  let transferred: {
    teamName: string;
    incomingName: string;
    outgoingName: string;
    incomingDiscordId: string | null;
    outgoingDiscordId: string | null;
  };
  try {
    transferred = await prisma.$transaction(
      async (tx) => {
        const [currentSeason, draftRow, team, alreadyCaptains, incomingReg] =
          await Promise.all([
            tx.season.findUnique({ where: { id: expectedActiveSeasonId } }),
            tx.draft.findUnique({
              where: { seasonId: expectedActiveSeasonId },
              select: { status: true },
            }),
            tx.team.findUnique({
              where: { id: teamId },
              include: { members: { include: { user: true } }, captain: true },
            }),
            tx.team.findUnique({
              where: {
                seasonId_captainId: {
                  seasonId: expectedActiveSeasonId,
                  captainId: newCaptainUserId,
                },
              },
            }),
            tx.registration.findUnique({
              where: {
                seasonId_userId: {
                  seasonId: expectedActiveSeasonId,
                  userId: newCaptainUserId,
                },
              },
            }),
          ]);
        if (!currentSeason?.isActive) throw new ActiveSeasonChangedError();
        if (!captainTransferOpen(currentSeason.status, draftRow?.status)) {
          if (currentSeason.status === SEASON_STATUS.COMPLETE) {
            throw new DraftSetupLockedError(
              "The season is complete — captaincy is historical and read-only.",
            );
          }
          throw new DraftSetupLockedError(
            draftRow?.status === DRAFT_STATUS.PAUSED
              ? "The auction is paused, not finished — resume and let it complete, or use Abort draft, before swapping captains."
              : "The auction is live — let it complete, or use Abort draft, before swapping captains.",
          );
        }
        if (!team || team.seasonId !== currentSeason.id) {
          throw new CaptainStateChangedError("Unknown team");
        }
        if (team.captainId !== expectedCaptainUserId) {
          throw new CaptainStateChangedError(
            `${team.name}'s captain already changed — reload before another handover.`,
          );
        }
        if (team.captainId === newCaptainUserId) {
          throw new CaptainStateChangedError(
            `${team.captain.name} already captains ${team.name}`,
          );
        }
        const incoming = team.members.find(
          (member) => member.userId === newCaptainUserId,
        );
        const outgoing = team.members.find(
          (member) => member.userId === expectedCaptainUserId,
        );
        if (!incoming) {
          throw new CaptainStateChangedError(
            "Pick someone who is still on that team's roster.",
          );
        }
        if (!outgoing || !outgoing.isCaptain) {
          throw new CaptainStateChangedError(
            "The current captain roster spot is inconsistent — reload and repair the roster before a handover.",
          );
        }
        if (
          !incomingReg ||
          incomingReg.status !== REGISTRATION_STATUS.ACTIVE ||
          incomingReg.type !== REGISTRATION_TYPE.PLAYER
        ) {
          throw new CaptainStateChangedError(
            `${incoming.user.name} is not an active full-player signup.`,
          );
        }
        if (alreadyCaptains) {
          throw new CaptainStateChangedError(
            `${incoming.user.name} already captains another team`,
          );
        }

        // Team.captainId is the authoritative CAS. Two stale handovers can both
        // read the old captain; only one may claim that exact old value.
        const claimed = await tx.team.updateMany({
          where: {
            id: team.id,
            seasonId: currentSeason.id,
            captainId: expectedCaptainUserId,
          },
          data: { captainId: newCaptainUserId },
        });
        if (claimed.count === 0) throw new CaptainStateChangedError();

        // Normalize the denormalized flags, repairing any legacy duplicate on
        // this team while the authoritative captain change is atomic.
        await tx.teamMember.updateMany({
          where: {
            teamId: team.id,
            seasonId: currentSeason.id,
            isCaptain: true,
          },
          data: { isCaptain: false },
        });
        const promoted = await tx.teamMember.updateMany({
          where: {
            id: incoming.id,
            teamId: team.id,
            seasonId: currentSeason.id,
            userId: newCaptainUserId,
            isCaptain: false,
          },
          data: { isCaptain: true },
        });
        if (promoted.count === 0) throw new CaptainStateChangedError();
        // Authority changed, not membership or its acquisition price.
        const historyAt = new Date();
        await captureRosterTenure(tx, incoming, undefined, historyAt);
        await captureRosterTenure(tx, outgoing, undefined, historyAt);
        await recordHistoryAction(tx, actor, currentSeason.id, "captainTransferHistory",
          `Transferred captaincy of ${team.name} from ${team.captain.name} to ${incoming.user.name}`,
          { teamId: team.id, outgoingUserId: outgoing.userId, incomingUserId: incoming.userId, effectiveAt: historyAt.toISOString() });
        return {
          teamName: team.name,
          incomingName: incoming.user.name,
          outgoingName: team.captain.name,
          incomingDiscordId: incoming.user.discordId,
          outgoingDiscordId: team.captain.discordId,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (error instanceof DraftSetupLockedError) {
      return { error: error.message };
    }
    if (error instanceof CaptainStateChangedError) {
      return {
        error:
          error.message ||
          "Captaincy changed while you were saving — reload and try again.",
      };
    }
    if (
      error instanceof ActiveSeasonChangedError ||
      isSerializationConflict(error)
    ) {
      return {
        error:
          "The season or roster changed while you were saving — reload and try again.",
      };
    }
    if (isUniqueViolation(error)) {
      return {
        error:
          "That player was just made captain elsewhere — reload and try again.",
      };
    }
    throw error;
  }
  await logAdminAction({
    action: "transferCaptaincy",
    summary: `Transferred "${transferred.teamName}" from ${transferred.outgoingName} to ${transferred.incomingName}`,
    seasonId: season.id,
  });
  await sendDiscordMessage(
    captainAssignedMessage(
      transferred.incomingName,
      transferred.teamName,
      transferred.incomingDiscordId,
      { name: transferred.outgoingName, discordId: transferred.outgoingDiscordId },
    ),
    // Both captains: the outgoing one was told "you now captain X" once, and
    // this post is what says that no longer holds.
    mentionsOf([transferred.incomingDiscordId, transferred.outgoingDiscordId]),
  );
  refresh();
  return {
    message: `${transferred.incomingName} now captains ${transferred.teamName} (${transferred.outgoingName} stays on the roster)`,
  };
}

/** Randomize the nomination/draft order of teams. */
export async function randomizeDraftOrder(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  const expectedActiveSeasonId = str(formData, "expectedActiveSeasonId").trim();
  if (!expectedActiveSeasonId || expectedActiveSeasonId !== season.id) {
    return {
      error:
        "The active season changed while this page was open — reload before changing the order.",
    };
  }
  await raceHook("admin.randomizeDraftOrder.beforeTx");
  let count = 0;
  try {
    count = await prisma.$transaction(
      async (tx) => {
        const [currentSeason, draft, teams] = await Promise.all([
          tx.season.findUnique({ where: { id: expectedActiveSeasonId } }),
          tx.draft.findUnique({
            where: { seasonId: expectedActiveSeasonId },
            select: { status: true },
          }),
          tx.team.findMany({ where: { seasonId: expectedActiveSeasonId } }),
        ]);
        if (!currentSeason?.isActive) throw new ActiveSeasonChangedError();
        if (!draftSetupOpen(currentSeason.status, draft?.status)) {
          throw new DraftSetupLockedError(
            draftSetupLockedMessage(currentSeason.status, draft?.status),
          );
        }
        if (teams.length < 2) {
          throw new DraftStartPreflightError(
            "Designate at least 2 captains before randomizing their order.",
          );
        }
        const shuffled = shuffle(teams);
        const changed = await Promise.all(
          shuffled.map((team, index) =>
            tx.team.updateMany({
              where: {
                id: team.id,
                seasonId: currentSeason.id,
                draftOrder: team.draftOrder,
              },
              data: { draftOrder: index },
            }),
          ),
        );
        if (changed.some((result) => result.count === 0)) {
          throw new CaptainStateChangedError();
        }
        return teams.length;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (
      error instanceof DraftSetupLockedError ||
      error instanceof DraftStartPreflightError
    ) {
      return { error: error.message };
    }
    if (error instanceof CaptainStateChangedError) {
      return {
        error: "The captain order just changed — reload and randomize again.",
      };
    }
    if (
      error instanceof ActiveSeasonChangedError ||
      isSerializationConflict(error)
    ) {
      return {
        error:
          "The season, draft, or captain order just changed — reload and try again.",
      };
    }
    throw error;
  }
  await logAdminAction({
    action: "randomizeDraftOrder",
    summary: `Randomized the draft order for ${count} teams`,
    seasonId: season.id,
  });
  refresh();
  // Say the order it landed on, not just that it moved.
  const order = await prisma.team.findMany({
    where: { seasonId: season.id },
    orderBy: [{ draftOrder: "asc" }, { id: "asc" }],
    select: { name: true },
  });
  return {
    message: `Draft order shuffled: ${order.map((team, index) => `${index + 1}. ${team.name}`).join(", ")}`,
  };
}

/** Begin the live auction draft. Sets the season to DRAFT and seeds Draft state. */
export async function startDraft(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const actor = await adminOrError();
  if ("error" in actor) return actor;
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  const expectedActiveSeasonId = str(formData, "expectedActiveSeasonId").trim();
  if (!expectedActiveSeasonId || expectedActiveSeasonId !== season.id) {
    return {
      error:
        "The active season changed while this page was open — reload and review the draft preflight before starting.",
    };
  }

  await raceHook("admin.startDraft.beforeTx");
  let started: {
    seasonName: string;
    budgets: Map<string, number>;
    poolCount: number;
    openSeats: number;
    shortfall: number;
  };
  try {
    started = await prisma.$transaction(
      async (tx) => {
        const [
          currentSeason,
          existingDraft,
          teams,
          regs,
          existingMembers,
          playedNow,
          gamesNow,
        ] = await Promise.all([
          tx.season.findUnique({ where: { id: expectedActiveSeasonId } }),
          tx.draft.findUnique({
            where: { seasonId: expectedActiveSeasonId },
            select: { status: true },
          }),
          tx.team.findMany({
            where: { seasonId: expectedActiveSeasonId },
            orderBy: [
              { draftOrder: "asc" },
              { createdAt: "asc" },
              { id: "asc" },
            ],
          }),
          tx.registration.findMany({
            where: {
              seasonId: expectedActiveSeasonId,
              status: REGISTRATION_STATUS.ACTIVE,
              type: REGISTRATION_TYPE.PLAYER,
            },
            select: { userId: true, mmr: true, roles: true },
          }),
          tx.teamMember.findMany({
            where: { seasonId: expectedActiveSeasonId },
            select: { id: true, teamId: true, userId: true, isCaptain: true },
          }),
          tx.match.count({
            where: {
              seasonId: expectedActiveSeasonId,
              status: MATCH_STATUS.COMPLETED,
            },
          }),
          tx.game.count({
            where: { match: { seasonId: expectedActiveSeasonId } },
          }),
        ]);
        if (!currentSeason?.isActive) throw new ActiveSeasonChangedError();
        if (!draftSetupOpen(currentSeason.status, existingDraft?.status)) {
          if (
            currentSeason.status === SEASON_STATUS.DRAFT &&
            existingDraft?.status !== DRAFT_STATUS.NOT_STARTED
          ) {
            throw new DraftAlreadyStartedError();
          }
          throw new DraftSetupLockedError(
            draftSetupLockedMessage(
              currentSeason.status,
              existingDraft?.status,
            ),
          );
        }
        if (playedNow > 0 || gamesNow > 0) throw new ResultsLandedError();
        if (teams.length < 2) {
          throw new DraftStartPreflightError(
            "Need at least 2 captains to start the draft.",
          );
        }
        if (
          new Set(teams.map((team) => team.draftOrder)).size !== teams.length
        ) {
          throw new DraftOrderConflictError();
        }

        const regByUser = new Map(regs.map((reg) => [reg.userId, reg]));
        for (const team of teams) {
          const captainSeats = existingMembers.filter(
            (member) => member.teamId === team.id && member.isCaptain,
          );
          if (
            captainSeats.length !== 1 ||
            captainSeats[0].userId !== team.captainId ||
            !regByUser.has(team.captainId)
          ) {
            throw new CaptainStateChangedError();
          }
        }
        const existingRosterCount = existingMembers.filter(
          (member) => !member.isCaptain,
        ).length;
        if (existingRosterCount > 0) {
          throw new DraftStartPreflightError(
            `${existingRosterCount} non-captain roster member${existingRosterCount === 1 ? " is" : "s are"} already assigned. Start requires captain-only teams so a later-season roster cannot be mistaken for a fresh auction.`,
          );
        }

        const draftedIds = new Set(
          existingMembers.map((member) => member.userId),
        );
        const poolCount = regs.filter(
          (reg) => !draftedIds.has(reg.userId),
        ).length;
        const seats = draftSeatPlan(
          teams.length,
          currentSeason.teamSize,
          poolCount,
        );
        if (!seats.canStart) {
          throw new DraftStartPreflightError(
            seats.blocker ?? "The draft is not ready to start.",
          );
        }

        const budgets = mmrWeightedBudgets(
          currentSeason.draftBudget,
          currentSeason.budgetMmrWeight,
          teams.map((team) => ({
            teamId: team.id,
            // A stored 0 is unknown, not a minimum-MMR budget boost.
            mmr: regByUser.get(team.captainId)?.mmr || null,
          })),
          (currentSeason.teamSize - 1) * DEFAULTS.MIN_BID,
        );
        const nominationEndsAt = new Date(
          Date.now() + DEFAULTS.NOMINATION_TIMER_SECONDS * 1000,
        );

        // The singleton Draft row is the one-shot claim. Every later failure
        // throws, rolling it back together with budgets and phase.
        if (existingDraft) {
          const claimed = await tx.draft.updateMany({
            where: {
              seasonId: currentSeason.id,
              status: DRAFT_STATUS.NOT_STARTED,
            },
            data: {
              status: DRAFT_STATUS.IN_PROGRESS,
              nominatorTeamId: teams[0].id,
              nominationIndex: 0,
              nominatedUserId: null,
              currentBid: 0,
              currentBidTeamId: null,
              bidEndsAt: null,
              nominationEndsAt,
            },
          });
          if (claimed.count === 0) throw new DraftAlreadyStartedError();
        } else {
          try {
            await tx.draft.create({
              data: {
                seasonId: currentSeason.id,
                status: DRAFT_STATUS.IN_PROGRESS,
                nominatorTeamId: teams[0].id,
                nominationIndex: 0,
                nominationEndsAt,
              },
            });
          } catch (error) {
            if (isUniqueViolation(error)) {
              throw new DraftAlreadyStartedError();
            }
            throw error;
          }
        }

        const budgetWrites = await Promise.all(
          teams.map((team) =>
            tx.team.updateMany({
              where: {
                id: team.id,
                seasonId: currentSeason.id,
                captainId: team.captainId,
                draftOrder: team.draftOrder,
              },
              data: {
                budget: budgets.get(team.id) ?? currentSeason.draftBudget,
              },
            }),
          ),
        );
        if (budgetWrites.some((write) => write.count === 0)) {
          throw new CaptainStateChangedError();
        }
        const phaseClaim = await tx.season.updateMany({
          where: {
            id: currentSeason.id,
            isActive: true,
            status: currentSeason.status,
          },
          data: { status: SEASON_STATUS.DRAFT },
        });
        if (phaseClaim.count === 0) throw new ActiveSeasonChangedError();
        // A draft-night reminder still queued ("be there before the auction
        // starts") must not post once it has started.
        await invalidatePendingAnnouncementMarkers(
          tx,
          draftReminderPrefix(currentSeason.id),
          { prefix: true },
        );
        await startDraftRun(tx, {
          seasonId: currentSeason.id, actor, rules: {
            teamSize: currentSeason.teamSize, draftBudget: currentSeason.draftBudget,
            budgetMmrWeight: currentSeason.budgetMmrWeight,
          }, teams, registrations: regs, budgets,
        });

        return {
          seasonName: currentSeason.name,
          budgets,
          poolCount,
          openSeats: seats.openSeats,
          shortfall: seats.shortfall,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (e) {
    if (e instanceof ResultsLandedError) {
      return {
        error:
          "A result landed while you were starting the draft — nothing was changed. Reload and check the schedule.",
      };
    }
    if (e instanceof DraftAlreadyStartedError) {
      return {
        error:
          "The draft has already run or another Start just beat this one — use Abort draft to return to Signups and re-run it (allowed until a result is recorded).",
      };
    }
    if (e instanceof DraftSetupLockedError) return { error: e.message };
    if (e instanceof DraftStartPreflightError) return { error: e.message };
    if (e instanceof DraftOrderConflictError) {
      return {
        error:
          "Two captains share the same draft order — randomize the order once, then start again.",
      };
    }
    if (e instanceof CaptainStateChangedError) {
      return {
        error:
          "Captain roster data changed or is inconsistent — reload and verify every team has exactly one designated captain.",
      };
    }
    if (
      e instanceof ActiveSeasonChangedError ||
      isSerializationConflict(e)
    ) {
      return {
        error:
          "The season, captain list, order, settings, or player pool changed while starting — nothing was armed. Reload and review the preflight.",
      };
    }
    if (isUniqueViolation(e)) {
      return {
        error:
          "Another Start just beat this one — the draft is already live. Nothing was changed twice.",
      };
    }
    throw e;
  }
  // Mention the captains (linked ones only): an absent captain's nomination
  // clock runs out and the site nominates for them. Read after the commit,
  // outside the Serializable start, and best-effort: a failed read only
  // costs the names, never the announcement or the started draft.
  const captains = await prisma.team
    .findMany({
      where: { seasonId: season.id },
      orderBy: [{ draftOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: { captain: { select: { name: true, discordId: true } } },
    })
    .then((teams) => teams.map((team) => team.captain))
    .catch(() => []);
  const liveAnnouncement = draftStartedAnnouncement({
    seasonName: started.seasonName,
    captains,
  });
  await sendDiscordMessage(
    liveAnnouncement.content,
    mentionsOf(liveAnnouncement.mentionUserIds),
    { expiryGroup: draftLiveAnnouncementGroup(season.id) },
  );
  await logAdminAction({
    action: "startDraft",
    summary: `Started the live auction with ${started.budgets.size} teams and ${started.poolCount} draftable players`,
    seasonId: season.id,
  });
  refresh();
  const budgetVals = [...started.budgets.values()];
  const budgetNote =
    Math.max(...budgetVals) !== Math.min(...budgetVals)
      ? ` · MMR-weighted budgets $${Math.min(...budgetVals)}–$${Math.max(...budgetVals)}`
      : "";
  return {
    message:
      started.shortfall > 0
        ? `Draft started — heads up: ${started.poolCount} players for ${started.openSeats} seats, so ${started.shortfall} seat(s) will go unfilled${budgetNote}`
        : `Draft started — the auction is live${budgetNote}`,
  };
}

/** Admin: revert the most recent auction sale (mis-click / dispute recovery). */
export async function undoLastSaleAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  const expectedActiveSeasonId = str(formData, "expectedActiveSeasonId").trim();
  if (!expectedActiveSeasonId || expectedActiveSeasonId !== season.id) {
    return {
      error:
        "The active season changed while this draft control was open — reload before undoing a sale.",
    };
  }
  // Draft phase only. Undo re-opens the auction (Draft.status → IN_PROGRESS)
  // and deletes the newest non-captain TeamMember — which, once the season has
  // moved on, is a free-agent signing, not an auction sale. Worse, a live
  // auction inside REGULAR_SEASON means the next visitor to /draft triggers
  // the stalled-nomination resolver and a random unrostered signup gets
  // auto-drafted onto that team mid-season. Roster fixes after the draft are
  // Release / Sign free agent.
  if (season.status !== SEASON_STATUS.DRAFT) {
    return {
      error:
        "The season has moved on — use Release / Sign free agent for roster corrections.",
    };
  }
  const res = await undoLastSale(season.id, admin);
  if (!res.ok) return { error: res.error };
  refresh();
  // Name the purchase. Undo targets the newest AUCTION sale, so when free-agent
  // signings sit on top of it the row reverted is not the newest roster addition
  // — saying who and for how much is what stops that being a surprise.
  await logAdminAction({
    action: "undoLastSale",
    summary: `Undid the sale of ${res.player} to ${res.team} ($${res.price})`,
    seasonId: season.id,
  });
  await sendDiscordMessage(
    draftSaleUndoneMessage(season.name, res.player, res.team, res.price),
    undefined,
    { expiryGroup: draftLiveAnnouncementGroup(season.id) },
  );
  // The durable send may have enqueued work after the earlier refresh. Expire
  // once more so a snapshot rebuilt during Discord I/O cannot miss the row.
  updateTag(AUTOMATION_GATE_TAG);
  return {
    message: `Undid ${res.player} → ${res.team} ($${res.price}) — they're back in the pool, ${res.team} has the money and the next nomination.${
      res.paused ? " The auction is still paused; press Resume when ready." : ""
    }`,
  };
}

/**
 * Admin: ABORT the draft — the way back from a premature "Start draft".
 *
 * Deliberately NOT phase-gated the way undoLastSaleAction is: the whole point is
 * to recover a season whose phase already moved, and abortDraft's own guard (no
 * recorded results, no imported games) is the safety line that matters. It puts
 * the season back to SIGNUPS so captains can be fixed and late players can
 * register.
 */
export async function abortDraftAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  const expectedActiveSeasonId = str(formData, "expectedActiveSeasonId").trim();
  if (!expectedActiveSeasonId || expectedActiveSeasonId !== season.id) {
    return {
      error:
        "The active season changed while this draft control was open — reload before aborting.",
    };
  }
  const res = await abortDraft(season.id, admin);
  if (!res.ok) return { error: res.error };
  await logAdminAction({
    action: "abortDraft",
    summary: `Aborted the draft — ${res.playersReturned} non-captain roster member(s) returned, $${res.budgetRestored} refunded, ${res.matchesRemoved} unplayed fixture(s), ${res.checkInsCleared} check-in(s), ${res.predictionsCleared} pick(s), ${res.reschedulesCleared} reschedule(s) and ${res.fantasyRostersCleared} fantasy roster(s) cleared; ${res.teams} captain(s) kept`,
    seasonId: season.id,
  });
  // Stand down the standins whose bookings died with the rosters — post-commit
  // and best-effort, one per deleted booking (the generateSchedule shape). A
  // booking that survived into the re-run would inflate a freshly drafted
  // side to six; the human holding it deserves better than silence either way.
  for (const a of res.coverStandDowns) {
    await sendDiscordMessage(
      standinRemovedMessage({
        standinName: a.standinName,
        teamName: a.teamName,
        homeName: a.homeName,
        awayName: a.awayName,
        week: a.week,
        isPlayoff: a.isPlayoff,
        reason: "DRAFT_RESET",
      }),
      mentionsOf([a.discordId]),
    );
  }
  // The live-draft posts still waiting (a webhook outage) are stale now.
  await expireLeagueAnnouncementGroup(
    draftLiveAnnouncementGroup(season.id),
  ).catch(() => 0);
  await sendDiscordMessage(
    draftAbortedMessage(season.name, res.playersReturned, res.matchesRemoved),
  );
  refresh();
  const bits = [
    `Draft aborted — season back to Signups with ${res.teams} captain(s) intact`,
  ];
  if (res.playersReturned > 0) {
    bits.push(
      `${res.playersReturned} non-captain roster member(s) returned to the pool and $${res.budgetRestored} refunded`,
    );
  }
  if (res.coverStandDowns.length > 0) {
    bits.push(
      `${res.coverStandDowns.length} standin booking(s) on the old rosters cancelled and stood down`,
    );
  }
  const cleared = [
    res.matchesRemoved ? `${res.matchesRemoved} unplayed fixture(s)` : null,
    res.checkInsCleared ? `${res.checkInsCleared} check-in(s)` : null,
    res.predictionsCleared ? `${res.predictionsCleared} pick'em pick(s)` : null,
    res.reschedulesCleared ? `${res.reschedulesCleared} reschedule(s)` : null,
    res.fantasyRostersCleared
      ? `${res.fantasyRostersCleared} fantasy roster(s)`
      : null,
  ].filter(Boolean);
  if (cleared.length > 0) {
    bits.push(`cleared ${cleared.join(", ")} tied to the old rosters`);
  }
  bits.push("fix the captains, then start the draft again");
  bits.push("Discord was notified that the auction stopped");
  return { message: `${bits.join(" · ")}.` };
}

/** Admin: pause the live auction (clocks park; nothing can sell). */
export async function pauseDraftAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  const expectedActiveSeasonId = str(formData, "expectedActiveSeasonId").trim();
  if (!expectedActiveSeasonId || expectedActiveSeasonId !== season.id) {
    return {
      error:
        "The active season changed while this draft control was open — reload before pausing.",
    };
  }
  const res = await pauseDraft(season.id, admin);
  // pauseDraft may first resolve an expired auction clock even when its final
  // pause claim loses. Rebuild the deadline proof after every dispatched call.
  updateTag(AUTOMATION_GATE_TAG);
  if (!res.ok) return { error: res.error };
  await logAdminAction({
    action: "pauseDraft",
    summary: "Paused the live auction and parked its clock",
    seasonId: season.id,
  });
  await sendDiscordMessage(draftPausedMessage(season.name), undefined, {
    expiryGroup: draftLiveAnnouncementGroup(season.id),
  });
  refresh();
  return { message: "Auction paused — clocks are parked until you resume." };
}

/** Admin: resume a paused auction with a fresh clock. */
export async function resumeDraftAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  const expectedActiveSeasonId = str(formData, "expectedActiveSeasonId").trim();
  if (!expectedActiveSeasonId || expectedActiveSeasonId !== season.id) {
    return {
      error:
        "The active season changed while this draft control was open — reload before resuming.",
    };
  }
  const res = await resumeDraft(season.id, admin);
  if (!res.ok) return { error: res.error };
  await logAdminAction({
    action: "resumeDraft",
    summary: "Resumed the auction with a fresh clock",
    seasonId: season.id,
  });
  await sendDiscordMessage(draftResumedMessage(season.name), undefined, {
    expiryGroup: draftLiveAnnouncementGroup(season.id),
  });
  refresh();
  return { message: "Auction resumed — the clock is running again." };
}

/** Admin: cancel a mistaken live lot after pausing, keeping the same turn. */
export async function voidCurrentLotAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  const expectedActiveSeasonId = str(formData, "expectedActiveSeasonId").trim();
  if (!expectedActiveSeasonId || expectedActiveSeasonId !== season.id) {
    return {
      error:
        "The active season changed while this draft control was open — reload before voiding the lot.",
    };
  }
  const res = await voidCurrentLot(season.id, admin);
  if (!res.ok) return { error: res.error };
  await logAdminAction({
    action: "voidCurrentLot",
    summary: `Voided the paused live lot for ${res.player}; ${res.nominator} keeps the nomination turn`,
    seasonId: season.id,
  });
  await sendDiscordMessage(
    draftLotVoidedMessage(season.name, res.player),
    undefined,
    { expiryGroup: draftLiveAnnouncementGroup(season.id) },
  );
  refresh();
  return {
    message: `Voided ${res.player}'s lot — no sale recorded. ${res.nominator} keeps the turn; Resume when ready.`,
  };
}

const OPENDOTA_OUTAGE_MSG =
  "OpenDota isn't responding right now — no medals were changed. Try again in a few minutes.";

/** "N couldn't be reached" suffix with a re-run / API-key hint, or "". */
function unreachableTail(unreachable: number): string {
  return unreachable
    ? ` · ${unreachable} couldn't be reached (rate limit? run it again${process.env.OPENDOTA_API_KEY ? "" : " — an OPENDOTA_API_KEY raises the limit"})`
    : "";
}

/** " · N skipped" suffix when the time budget cut the run short, or "". */
function skippedTail(skipped: number): string {
  return skipped ? ` · ${skipped} skipped (time limit — run again)` : "";
}

/** Older stored games given report-card stats per press (1 OpenDota call
 *  each). The automatic refresh keeps working through the rest. */
const MANUAL_ENRICH_GAMES = 3;

/** Time one game fetch needs before it is started. */
const MANUAL_ENRICH_START_MS = 13_000;

/**
 * "Refresh player data now": the on-demand version of the automation
 * worker's hourly refresh, for right before a draft. Every active signup's
 * medal (and the private-match-data flag), the stalest few scouting
 * snapshots, every Steam name and avatar, and a few older games' report-card
 * stats, within one time budget.
 */
export async function refreshPlayerData(
  _prev: ActionResult,
  _fd: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  const season = await getActiveSeason();
  const draft = season
    ? await prisma.draft.findUnique({
        where: { seasonId: season.id },
        select: { status: true },
      })
    : null;
  // Captains are reading these medals and names in the auction room.
  if (!profileSyncAllowed(draft?.status)) {
    return {
      error:
        "The auction is live or paused, so player data stays as it is until the draft finishes.",
    };
  }
  const deadlineMs = Date.now() + MANUAL_REFRESH_BUDGET_MS;

  const steam = await refreshSteamProfiles(deadlineMs);
  // Persona names are part of the pinned board digest.
  if (steam.updated > 0) updateTag(AUTOMATION_GATE_TAG);

  const regs = season
    ? await prisma.registration.findMany({
        where: { seasonId: season.id, status: "ACTIVE" },
        include: { user: true },
      })
    : [];
  const { ranked, unreachable, skipped, outage, stats, deferred } =
    await syncRanksFor(
      regs.map((r) => r.user),
      deadlineMs,
    );
  const steamPart = steam.updated
    ? ` · ${steam.updated} Steam name${steam.updated === 1 ? "" : "s"} or avatar${steam.updated === 1 ? "" : "s"} updated`
    : "";
  if (outage) {
    if (steam.updated) refresh();
    return { error: `${OPENDOTA_OUTAGE_MSG}${steamPart}` };
  }

  // Only start on stored games while OpenDota is answering and time is left.
  const enrich =
    unreachable === 0 && deadlineMs - Date.now() >= MANUAL_ENRICH_START_MS
      ? await enrichStoredGames(MANUAL_ENRICH_GAMES, {
          deadlineMs,
          minStartMs: MANUAL_ENRICH_START_MS,
          stopOnFailure: true,
        })
      : null;

  // A medal learned AFTER signup can prove someone ineligible, and nothing else
  // ever re-checks: registrationGate only runs on submit, and a stored MMR is
  // league-approved by design. Anyone who signed up before linking their Dota
  // account (or while OpenDota was down) therefore sits in the pool with a
  // ceiling-breaking medal and an admitted low number. Name them here — this is
  // the one moment the league actually learns the truth. Never auto-remove:
  // who plays is the operator's call (withdraw/reinstate, or setRegistrationMmr).
  // Re-read rather than reusing `regs`: that snapshot predates the sync, so its
  // user.rankTier is exactly the null we just filled in.
  const flagged = season
    ? await prisma.registration.findMany({
        where: { seasonId: season.id, status: "ACTIVE" },
        include: { user: { select: { name: true, rankTier: true } } },
      })
    : [];
  const overCeiling = flagged.filter((r) =>
    medalProvesIneligible(r.user.rankTier),
  );
  const warning = overCeiling.length
    ? ` ⚠️ ${overCeiling.length} signup(s) now have a medal above the ${HARD_MMR_CEILING} ceiling: ${overCeiling
        .slice(0, 5)
        .map(
          (r) =>
            `${r.user.name} (${rankMedalName(r.user.rankTier)}, entered ${r.mmr})`,
        )
        .join(
          ", ",
        )}${overCeiling.length > 5 ? `, +${overCeiling.length - 5} more` : ""} — review before the draft.`
    : "";

  const gamesPart =
    enrich && (enrich.enriched > 0 || enrich.remaining > 0)
      ? ` · ${enrich.enriched} older game${enrich.enriched === 1 ? "" : "s"} given report-card stats and items${enrich.remaining ? ` (${enrich.remaining} to go)` : ""}`
      : "";
  const summary = `${regs.length} signup${regs.length === 1 ? "" : "s"} checked · ${ranked} ranked${stats > 0 ? ` · ${stats} scouting profile${stats === 1 ? "" : "s"}` : ""}${deferred > 0 ? ` (${deferred} more in the hourly refresh)` : ""}${steamPart}${gamesPart}`;
  await logAdminAction({
    action: "refreshPlayerData",
    summary: `Refreshed player data: ${summary}`,
    seasonId: season?.id ?? null,
  });
  refresh();
  if (enrich && enrich.enriched > 0) refreshGames();
  return {
    message: `Refreshed player data · ${summary}${unreachableTail(unreachable)}${skippedTail(skipped)}${warning}`,
  };
}

/** Set (or clear) the draft night — announced with countdowns during signups. */
export async function setDraftNight(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  const expectedActiveSeasonId = str(formData, "expectedActiveSeasonId").trim();
  if (!expectedActiveSeasonId || expectedActiveSeasonId !== season.id) {
    return {
      error:
        "The active season changed while this page was open — reload before changing draft night.",
    };
  }

  const raw = str(formData, "draftAt").trim();
  const when = localDate(formData, "draftAt", "draftAtTs");
  if (raw && !when) return { error: "Invalid draft night" };

  // A no-op resubmit (same timestamp) must neither re-announce to Discord nor
  // invalidate confirmations. A real change bumps the revision instead of
  // deleting acknowledgements, so both /me and admin can identify stale rows.
  // The form disappears when the auction starts, but Server Actions are still
  // callable directly: enforce that lock in the same serializable transaction
  // as the schedule update so a start-draft request cannot cross in the gap.
  let changed = false;
  let replacedExistingTime = false;
  await raceHook("admin.setDraftNight.beforeTx");
  try {
    await prisma.$transaction(
      async (tx) => {
        const [currentSeason, draft] = await Promise.all([
          tx.season.findUnique({ where: { id: expectedActiveSeasonId } }),
          tx.draft.findUnique({
            where: { seasonId: expectedActiveSeasonId },
            select: { status: true },
          }),
        ]);
        if (!currentSeason?.isActive) throw new ActiveSeasonChangedError();
        if (!draftSetupOpen(currentSeason.status, draft?.status)) {
          throw new DraftSetupLockedError(
            draftSetupLockedMessage(currentSeason.status, draft?.status),
          );
        }
        changed =
          (when?.getTime() ?? null) !==
          (currentSeason.draftAt?.getTime() ?? null);
        replacedExistingTime = changed && currentSeason.draftAt != null;
        const updated = await tx.season.updateMany({
          where: {
            id: expectedActiveSeasonId,
            isActive: true,
            status: currentSeason.status,
          },
          data: changed
            ? { draftAt: when, draftRevision: { increment: 1 } }
            : { draftAt: when },
        });
        if (updated.count === 0) throw new ActiveSeasonChangedError();
        if (changed) {
          // A draft-night reminder claimed or queued for the OLD time must
          // not post it. Dropping the old revisions' in-flight markers makes
          // any queued send fail its outbox source check; a reminder already
          // delivered stays recorded, and the new revision re-arms under its
          // own key (maybeAnnounceDraftNight) — except in the case below,
          // where no second reminder is posted.
          await invalidatePendingAnnouncementMarkers(
            tx,
            draftReminderPrefix(expectedActiveSeasonId),
            { prefix: true },
          );
          // Only DELIVERED (or covered) reminders survive the line above. If
          // the reminder for the time being replaced was delivered, that time
          // is still ahead, and the new time is inside the reminder window,
          // the new revision is recorded as covered, so it does NOT re-arm:
          // the "draft rescheduled" post below carries the change. Without
          // this, every tweak on draft day would ping every captain again.
          // Only the REPLACED revision counts: a reminder for an older time,
          // or for a night that already slipped past, says nothing about the
          // new one, whose reminder must still ping the captains. A same-day
          // chain of tweaks stays quiet, since each covered revision is the
          // replaced one for the next move.
          const nowMs = Date.now();
          const replacedAtMs = currentSeason.draftAt?.getTime() ?? null;
          if (
            when &&
            replacedAtMs != null &&
            replacedAtMs > nowMs &&
            draftReminderDue(currentSeason.status, draft?.status, when.getTime(), nowMs) &&
            (await tx.setting.findUnique({
              where: { key: draftReminderKey(expectedActiveSeasonId, currentSeason.draftRevision) },
              select: { key: true },
            }))
          ) {
            await recordAnnouncementCovered(
              tx,
              draftReminderKey(expectedActiveSeasonId, currentSeason.draftRevision + 1),
              nowMs,
            );
          }
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (error instanceof DraftSetupLockedError) return { error: error.message };
    if (
      error instanceof ActiveSeasonChangedError ||
      isSerializationConflict(error)
    ) {
      return {
        error:
          "The season or draft changed while you saved — reload and try again.",
      };
    }
    throw error;
  }
  // Best-effort announcement — the countdown surfaces update either way.
  if (changed) {
    if (when) {
      await sendDiscordMessage(
        replacedExistingTime
          ? draftRescheduledMessage(season.name, when.getTime())
          : draftScheduledMessage(season.name, when.getTime()),
        undefined,
        // Stuck behind a webhook outage, "the draft is set for <time>" is
        // dropped once that time has passed rather than posted after it.
        { expiresAt: when },
      );
    } else {
      await sendDiscordMessage(draftCancelledMessage(season.name));
    }
  }
  if (changed) {
    await logAdminAction({
      action: "setDraftNight",
      summary: when
        ? `${replacedExistingTime ? "Rescheduled" : "Scheduled"} the draft for ${when.toISOString()}`
        : "Cleared the scheduled draft night",
      seasonId: season.id,
    });
  }
  refresh();
  return {
    // League time, named: the admin's own clock is what hid a mis-entered
    // night before the form read the league's.
    message: when
      ? replacedExistingTime
        ? `Draft night moved to ${formatLeagueTime(when)} — players need to confirm the new time`
        : `Draft night set for ${formatLeagueTime(when)} 🗓️`
      : "Draft night cleared",
  };
}
