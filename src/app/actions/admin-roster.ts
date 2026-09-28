"use server";

// Admin actions for players and rosters: signups (withdraw, reinstate, MMR
// and medal corrections), roster moves (sign, release, promote a standin),
// standin bookings, team renames, and a team's withdrawal from the season.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { raceHook } from "@/lib/race-hook";
import { captureRosterTenure, closeRosterTenure } from "@/lib/roster-history";
import { getActiveSeason } from "@/lib/season";
import {
  assignStandinGuarded,
  removeStandinGuarded,
} from "@/lib/standin-service";
import {
  SEASON_STATUS,
  REGISTRATION_TYPE,
  REGISTRATION_STATUS,
  DRAFT_STATUS,
  MATCH_STATUS,
  MATCH_PHASE,
  SCRIM_STATUS,
  HARD_MMR_CEILING,
} from "@/lib/constants";
import {
  isPlayoffPhase,
  tiebreakerInputsLockReason,
} from "@/lib/league-lifecycle";
import { parseSeatTarget, pendingCoverWhere } from "@/lib/standin";
import {
  clampMmrToRank,
  formatMmrRange,
  isEditableRankTier,
  rankMedalName,
} from "@/lib/rank";
import { fetchRankTier } from "@/lib/dota";
import {
  dotaAccountLinkSnapshot,
  effectiveDotaAccountId,
} from "@/lib/dota-account";
import { clampInt, str } from "@/lib/form";
import {
  freeAgentSignedMessage,
  playerReleasedMessage,
  teamWithdrewMessage,
  teamIdentityChangedMessage,
  standinRemovedMessage,
  sendDiscordMessage,
} from "@/lib/discord";
import { reachabilityNote } from "@/lib/discord-roles";
import { mentionsOf } from "@/lib/discord-mentions";
import { logAdminAction } from "@/lib/admin-log";
import {
  resultAnnouncedKey,
  stampResultChange,
  weekReminderKey,
} from "@/lib/settings";
import { maybeAnnounceWeekHonors } from "@/lib/honors-service";
import {
  invalidatePendingAnnouncementMarkers,
  invalidateResultNudges,
} from "@/lib/announcement-marker";
import {
  medalProvesIneligible,
  promoteGateError,
  withdrawGateError,
} from "@/lib/registration";
import type { ActionResult } from "@/lib/action-result";
import { teamWithdrawalLockedReason } from "@/lib/team-withdrawal";
import { saveTeamIdentity } from "@/lib/team-identity-service";
import { teamIdentitySummary } from "@/lib/team-identity";
import {
  isSerializationConflict,
  isUniqueViolation,
} from "@/lib/prisma-errors";
import {
  adminOrError,
  DraftAlreadyStartedError,
  CaptainStateChangedError,
  ResultWriteError,
  refresh,
  refreshGames,
} from "./admin-shared";

class SignupChangedError extends Error {}

class SignupReinstateLockedError extends Error {}

class SignupWithdrawalLockedError extends Error {}

class TeamWithdrawalLifecycleChangedError extends Error {}

class TeamAlreadyWithdrawnError extends Error {}

class TeamNotWithdrawnError extends Error {}

/** Games the winner is credited in a forfeit: the series clinch number. (The
 *  mutation guard anchors claim ids to TOP-LEVEL declarations only, so a
 *  local helper would not rename a claim; module scope is just for reuse.) */
function forfeitScore(bestOf: number): number {
  return Math.floor(bestOf / 2) + 1;
}

/**
 * Claim the exact active Regular-season row before changing Team/Match state.
 * A read is insufficient: archive can write only Season while withdrawal
 * writes only its children, leaving no Serializable cycle. This conditional
 * write supplies the shared row lock and gives every competing lifecycle
 * command a total order. Touching updatedAt also invalidates other settings
 * forms rendered before this league-level ruling.
 */
async function claimTeamWithdrawalSeason(
  tx: Prisma.TransactionClient,
  seasonId: string,
): Promise<boolean> {
  const tiebreakerLock = await tiebreakerInputsLockReason(tx, seasonId);
  if (tiebreakerLock) throw new ResultWriteError(tiebreakerLock);
  const claimed = await tx.season.updateMany({
    where: {
      id: seasonId,
      isActive: true,
      status: SEASON_STATUS.REGULAR_SEASON,
    },
    data: { updatedAt: new Date() },
  });
  return claimed.count === 1;
}

const clearedDraftConfirmation = {
  draftConfirmedRevision: null,
  draftConfirmedAt: null,
  draftConfirmedFor: null,
} as const;

/**
 * Update any team's public identity from /admin. Captains edit their own team
 * from its page (actions/teams.ts); both go through saveTeamIdentity.
 */
export async function renameTeam(
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
        "The active season changed while this page was open — reload before editing a team.",
    };
  }
  const saved = await saveTeamIdentity({
    editor: { userId: actor.id, isAdmin: true },
    teamId: str(formData, "teamId"),
    expectedSeasonId: expectedActiveSeasonId,
    name: str(formData, "name"),
    logoUrl: formData.has("logoUrl") ? str(formData, "logoUrl") : undefined,
  });
  if (!saved.ok) return { error: saved.error };
  if (saved.nameChanged || saved.logoChanged) {
    await logAdminAction({
      action: "renameTeam",
      summary: teamIdentitySummary(saved),
      seasonId: saved.seasonId,
    });
    await sendDiscordMessage(teamIdentityChangedMessage(saved));
  }
  // The record-book cache embeds matchup team identity under the shared games
  // tag, so an edit must expire that dependency as well as the page shell.
  refreshGames();
  return { message: `Saved ${saved.name}` };
}

/**
 * Admin signup moderation — withdraw a bogus/duplicate/ghost signup so it stops
 * counting toward the draft threshold and skewing MMR-weighted budgets. A
 * captain or rostered player must be released/replaced first (withdrawGateError).
 */
export async function withdrawSignup(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  if (season.status === SEASON_STATUS.COMPLETE) {
    return {
      error:
        "The season is complete — registrations are historical and cannot be removed.",
    };
  }
  const registrationId = str(formData, "registrationId");
  const reg = await prisma.registration.findUnique({
    where: { id: registrationId },
    include: { user: true },
  });
  if (!reg || reg.seasonId !== season.id) return { error: "Unknown signup" };

  const [captainTeam, membership, pendingAssignments] = await Promise.all([
    prisma.team.findUnique({
      where: {
        seasonId_captainId: { seasonId: season.id, captainId: reg.userId },
      },
    }),
    prisma.teamMember.findUnique({
      where: { seasonId_userId: { seasonId: season.id, userId: reg.userId } },
    }),
    // Same hole as the self-serve path: removing a standin who still owes cover
    // leaves the covered team looking staffed by someone no longer in the league.
    prisma.standinAssignment.count({
      where: pendingCoverWhere(reg.userId, season.id),
    }),
  ]);
  const gate = withdrawGateError({
    status: reg.status,
    isCaptain: !!captainTeam,
    isRostered: !!membership,
    pendingAssignments,
  });
  if (gate) return { error: gate };

  // Never withdraw the player who is ON THE BLOCK: every room would render a
  // headless auction, and the expiring lot would charge a team for a
  // withdrawn player (the resolver also voids such lots, belt-and-braces).
  const draft = await prisma.draft.findUnique({
    where: { seasonId: season.id },
    select: { status: true, nominatedUserId: true },
  });
  if (
    draft &&
    (draft.status === DRAFT_STATUS.IN_PROGRESS ||
      draft.status === DRAFT_STATUS.PAUSED) &&
    draft.nominatedUserId === reg.userId
  ) {
    return {
      error: `${reg.user.name} is on the auction block right now — wait for the lot to settle.`,
    };
  }

  // SERIALIZABLE for the same reason as the self-serve path in
  // actions/registration.ts: the cover count above and this status write form a
  // write-skew pair with assignStandinGuarded (which reads the registration and
  // writes a StandinAssignment). Under read-committed a captain arranging cover
  // in that window and this removal both commit, leaving a REMOVED standin
  // holding live cover. Re-counting inside the transaction is what lets Postgres
  // see the cycle.
  // Test seam: the gap between the gate reads above and the transaction below
  // — fires BEFORE the tx (the leaveLeague placement) so the rival commits
  // before the snapshot and the test runs on SQLite too.
  await raceHook("admin.withdrawSignup.beforeTx");
  try {
    await prisma.$transaction(
      async (tx) => {
        const [currentSeason, live, currentDraft] = await Promise.all([
          tx.season.findUnique({
            where: { id: season.id },
            select: { isActive: true, status: true },
          }),
          tx.standinAssignment.count({
            where: pendingCoverWhere(reg.userId, season.id),
          }),
          tx.draft.findUnique({
            where: { seasonId: season.id },
            select: { status: true, nominatedUserId: true },
          }),
        ]);
        if (!currentSeason?.isActive) throw new SignupChangedError();
        if (currentSeason.status === SEASON_STATUS.COMPLETE) {
          throw new SignupWithdrawalLockedError();
        }
        if (live > 0) throw new Error("COVER_APPEARED");
        if (
          currentDraft &&
          (currentDraft.status === DRAFT_STATUS.IN_PROGRESS ||
            currentDraft.status === DRAFT_STATUS.PAUSED) &&
          currentDraft.nominatedUserId === reg.userId
        ) {
          throw new Error("ON_BLOCK");
        }
        // Re-check the roster seat too — leaveLeague's comment records that a
        // draft sale or free-agent signing in this gap "let a ROSTERED player
        // withdraw". TeamMember is a table this tx otherwise never reads, so
        // the Serializable pairing argued above cannot see that cycle without
        // this read.
        const seated = await tx.teamMember.findUnique({
          where: {
            seasonId_userId: { seasonId: season.id, userId: reg.userId },
          },
        });
        if (seated) {
          throw new Error(seated.isCaptain ? "IS_CAPTAIN" : "IS_ROSTERED");
        }
        // Status carried in the WHERE (rule 1): a blind update stamped
        // REMOVED over a concurrent self-withdrawal or reinstate.
        const claimed = await tx.registration.updateMany({
          where: { id: reg.id, status: REGISTRATION_STATUS.ACTIVE },
          data: {
            status: REGISTRATION_STATUS.REMOVED,
            ...clearedDraftConfirmation,
          },
        });
        if (claimed.count === 0) throw new Error("STATUS_CHANGED");
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (e) {
    if (e instanceof SignupWithdrawalLockedError) {
      return {
        error:
          "The season is complete — registrations are historical and cannot be removed.",
      };
    }
    if (e instanceof SignupChangedError) {
      return { error: "The active season changed — reload and try again." };
    }
    const msg = (e as Error).message;
    if (msg === "COVER_APPEARED")
      return {
        error: `${reg.user.name} was just assigned to stand in for an unplayed match — remove that assignment first.`,
      };
    if (msg === "ON_BLOCK")
      return {
        error: `${reg.user.name} is on the auction block right now — wait for the lot to settle.`,
      };
    if (msg === "IS_CAPTAIN")
      return {
        error: `${reg.user.name} captains a team — transfer the captaincy first.`,
      };
    if (msg === "IS_ROSTERED")
      return {
        error: `${reg.user.name} is on a roster — release them from the team first.`,
      };
    if (msg === "STATUS_CHANGED")
      return { error: "That signup just changed — reload and try again." };
    if (isSerializationConflict(e))
      return { error: "That signup just changed — reload and try again." };
    throw e;
  }
  await logAdminAction({
    action: "withdrawSignup",
    summary: `Removed ${reg.user.name}'s ${reg.type.toLowerCase()} signup`,
    seasonId: season.id,
  });
  refresh();
  return {
    message: `Removed ${reg.user.name}'s signup — they can't re-add themselves; use Reinstate to undo`,
  };
}

/**
 * Undo an admin removal, putting the signup back in the pool.
 *
 * Needed because `withdrawSignup` is now sticky (REMOVED blocks self-re-signup
 * — otherwise the player just reloaded /me and undid it). Without this, removal
 * would be irreversible, which is a worse bug than the one it fixes.
 */
export async function reinstateSignup(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  if (season.status === SEASON_STATUS.COMPLETE) {
    return {
      error:
        "The season is complete — registrations are historical and cannot be reinstated.",
    };
  }
  const registrationId = str(formData, "registrationId");
  const reg = await prisma.registration.findUnique({
    where: { id: registrationId },
    include: { user: true },
  });
  if (!reg || reg.seasonId !== season.id) return { error: "Unknown signup" };
  if (reg.status === REGISTRATION_STATUS.ACTIVE) {
    return { error: `${reg.user.name} is already signed up` };
  }
  await raceHook("admin.reinstateSignup.beforeWrite");
  try {
    await prisma.$transaction(
      async (tx) => {
        const [currentSeason, currentReg] = await Promise.all([
          tx.season.findUnique({
            where: { id: season.id },
            select: { isActive: true, status: true },
          }),
          tx.registration.findUnique({
            where: { id: reg.id },
            select: { seasonId: true, status: true, type: true },
          }),
        ]);
        if (!currentSeason?.isActive || !currentReg) {
          throw new SignupChangedError();
        }
        if (currentSeason.status === SEASON_STATUS.COMPLETE) {
          throw new SignupReinstateLockedError("season-complete");
        }
        if (
          currentReg.seasonId !== season.id ||
          currentReg.status !== reg.status ||
          currentReg.type !== reg.type
        ) {
          throw new SignupChangedError();
        }
        if (currentReg.type === REGISTRATION_TYPE.PLAYER) {
          const draft = await tx.draft.findUnique({
            where: { seasonId: season.id },
            select: { status: true },
          });
          if (
            draft?.status === DRAFT_STATUS.IN_PROGRESS ||
            draft?.status === DRAFT_STATUS.PAUSED
          ) {
            throw new SignupReinstateLockedError("draft-live");
          }
        }
        const changed = await tx.registration.updateMany({
          where: {
            id: reg.id,
            seasonId: season.id,
            status: reg.status,
            type: reg.type,
          },
          data: {
            status: REGISTRATION_STATUS.ACTIVE,
            ...clearedDraftConfirmation,
          },
        });
        if (changed.count === 0) throw new SignupChangedError();
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (error instanceof SignupReinstateLockedError) {
      return {
        error:
          error.message === "draft-live"
            ? "The live draft is using this player pool — wait until the auction finishes before reinstating this player."
            : "The season is complete — registrations are historical and cannot be reinstated.",
      };
    }
    if (
      error instanceof SignupChangedError ||
      isSerializationConflict(error)
    ) {
      return { error: "That signup just changed — reload and try again." };
    }
    throw error;
  }
  refresh();
  // Advisory only, never a gate (the operator's-call stance): the flag flow
  // is one-way — refreshPlayerData names over-ceiling signups in ITS toast and
  // nothing warned when the same admin later reinstated one.
  const warn = medalProvesIneligible(reg.user.rankTier)
    ? ` ⚠️ their medal (${rankMedalName(reg.user.rankTier)}) is above the ${HARD_MMR_CEILING} ceiling — review before the draft.`
    : "";
  await logAdminAction({
    action: "reinstateSignup",
    summary: `Reinstated ${reg.user.name}'s ${reg.type.toLowerCase()} signup`,
    seasonId: season.id,
  });
  return { message: `${reg.user.name} is back in the pool${warn}` };
}

/**
 * Admin correction for a fat-fingered self-reported MMR — clamped 0..12000
 * (players set it on /me; admin can fix it without asking them to re-file).
 */
export async function setRegistrationMmr(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  if (season.status === SEASON_STATUS.COMPLETE) {
    return { error: "The season is complete — signup MMR is read-only." };
  }
  const registrationId = str(formData, "registrationId");
  const mmr = clampInt(formData, "mmr", 0, 0, 12000);
  const reg = await prisma.registration.findUnique({
    where: { id: registrationId },
    include: { user: true },
  });
  if (!reg || reg.seasonId !== season.id) return { error: "Unknown signup" };
  if (reg.status !== REGISTRATION_STATUS.ACTIVE) {
    return {
      error: "That signup is not active — reinstate it before editing MMR.",
    };
  }
  await raceHook("admin.setRegistrationMmr.beforeWrite");
  try {
    await prisma.$transaction(
      async (tx) => {
        const [currentSeason, currentReg, draft] = await Promise.all([
          tx.season.findUnique({
            where: { id: season.id },
            select: { isActive: true, status: true },
          }),
          tx.registration.findUnique({
            where: { id: reg.id },
            select: { seasonId: true, status: true, type: true },
          }),
          tx.draft.findUnique({
            where: { seasonId: season.id },
            select: { status: true },
          }),
        ]);
        if (
          !currentSeason?.isActive ||
          currentSeason.status === SEASON_STATUS.COMPLETE ||
          !currentReg ||
          currentReg.seasonId !== season.id ||
          currentReg.status !== REGISTRATION_STATUS.ACTIVE ||
          currentReg.type !== reg.type
        ) {
          throw new SignupChangedError();
        }
        if (
          currentReg.type === REGISTRATION_TYPE.PLAYER &&
          (draft?.status === DRAFT_STATUS.IN_PROGRESS ||
            draft?.status === DRAFT_STATUS.PAUSED)
        ) {
          throw new DraftAlreadyStartedError();
        }
        const changed = await tx.registration.updateMany({
          where: {
            id: reg.id,
            seasonId: season.id,
            status: REGISTRATION_STATUS.ACTIVE,
            type: reg.type,
          },
          data: { mmr },
        });
        if (changed.count === 0) throw new SignupChangedError();
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (error instanceof DraftAlreadyStartedError) {
      return {
        error:
          "The auction is live — full-player MMR is locked until it finishes.",
      };
    }
    if (
      error instanceof SignupChangedError ||
      isSerializationConflict(error)
    ) {
      return { error: "That signup just changed — reload and try again." };
    }
    throw error;
  }
  refresh();
  // The admin override is the escape hatch when the medal check is wrong
  // (stale medal, recalibration) — never clamped, but flag a mismatch so a
  // fat-fingered correction doesn't slip by unnoticed.
  const check = clampMmrToRank(mmr, reg.user.rankTier);
  const rangeNote =
    check.adjusted && check.range
      ? ` (heads up: their ${rankMedalName(reg.user.rankTier)} medal suggests ${formatMmrRange(check.range)})`
      : "";
  await logAdminAction({
    action: "setRegistrationMmr",
    summary: `Set ${reg.user.name}'s signup MMR to ${mmr}`,
    seasonId: season.id,
  });
  return { message: `${reg.user.name}'s MMR set to ${mmr}${rangeNote}` };
}

/** Correct the current signup and the player's public medal together. */
export async function setPlayerRank(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  const integer = (key: string): number => {
    const raw = formData.get(key);
    return typeof raw === "string" && /^\d+$/.test(raw.trim())
      ? Number(raw)
      : NaN;
  };
  const mmr = integer("mmr");
  const expectedMmr = integer("expectedMmr");
  const expectedRankTier = integer("expectedRankTier");
  const expectedManual = str(formData, "expectedRankTierManual");
  const mode = str(formData, "medalMode");
  const manualRank = integer("rankTier");
  if (!Number.isInteger(mmr) || mmr < 0 || mmr > 12000) {
    return { error: "Enter a whole-number MMR from 0 to 12000." };
  }
  if (mode !== "manual" && mode !== "automatic") {
    return { error: "Choose a medal source." };
  }
  if (mode === "manual" && !isEditableRankTier(manualRank)) {
    return { error: "Choose a valid medal and star level." };
  }
  if (
    !Number.isInteger(expectedMmr) || expectedMmr < 0 ||
    !Number.isInteger(expectedRankTier) || expectedRankTier < 0 ||
    (expectedManual !== "0" && expectedManual !== "1")
  ) {
    return { error: "Reload the player editor and try again." };
  }
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  if (season.status === SEASON_STATUS.COMPLETE) {
    return { error: "The season is complete — player medal and MMR are read-only." };
  }
  const reg = await prisma.registration.findUnique({
    where: { id: str(formData, "registrationId") },
    include: { user: true },
  });
  if (!reg || reg.seasonId !== season.id) return { error: "Unknown signup" };
  if (reg.status !== REGISTRATION_STATUS.ACTIVE) {
    return { error: "That signup is not active — reinstate it before editing medal or MMR." };
  }
  const staleError = "This player's medal or MMR just changed — reload and try again.";
  if (
    reg.mmr !== expectedMmr || (reg.user.rankTier ?? 0) !== expectedRankTier ||
    reg.user.rankTierManual !== (expectedManual === "1")
  ) return { error: staleError };

  let rankTier = mode === "manual" ? manualRank || null : reg.user.rankTier;
  if (mode === "automatic" && reg.user.rankTierManual) {
    const accountId = effectiveDotaAccountId(reg.user);
    if (!accountId) return { error: "This player has no linked Dota account to fetch a medal from." };
    const result = await fetchRankTier(accountId);
    if (!result.ok) {
      return { error: "OpenDota couldn't be reached. Nothing was changed — try again later." };
    }
    rankTier = result.rankTier;
  }
  await raceHook("admin.setPlayerRank.beforeWrite");
  try {
    await prisma.$transaction(async (tx) => {
      const [currentSeason, draft] = await Promise.all([
        tx.season.findUnique({ where: { id: season.id }, select: { isActive: true, status: true } }),
        tx.draft.findUnique({ where: { seasonId: season.id }, select: { status: true } }),
      ]);
      if (!currentSeason?.isActive || currentSeason.status === SEASON_STATUS.COMPLETE) {
        throw new SignupChangedError();
      }
      if (
        reg.type === REGISTRATION_TYPE.PLAYER && mmr !== expectedMmr &&
        (draft?.status === DRAFT_STATUS.IN_PROGRESS || draft?.status === DRAFT_STATUS.PAUSED)
      ) throw new DraftAlreadyStartedError();
      const changed = await tx.registration.updateMany({
        where: {
          id: reg.id, userId: reg.userId, seasonId: season.id,
          status: REGISTRATION_STATUS.ACTIVE, type: reg.type, mmr: expectedMmr,
        },
        data: { mmr },
      });
      if (changed.count !== 1) throw new SignupChangedError();
      const userChanged = await tx.user.updateMany({
        where: {
          id: reg.userId,
          ...dotaAccountLinkSnapshot(reg.user),
          rankTier: reg.user.rankTier,
          rankTierManual: expectedManual === "1",
        },
        data: { rankTier, rankTierManual: mode === "manual" },
      });
      if (userChanged.count !== 1) throw new SignupChangedError();
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof DraftAlreadyStartedError) {
      return { error: "The auction is live or paused — full-player MMR is locked until it finishes. You can still edit their medal." };
    }
    if (error instanceof SignupChangedError || isSerializationConflict(error)) {
      return { error: staleError };
    }
    throw error;
  }
  refresh();
  await logAdminAction({
    action: "setPlayerRank",
    summary: `Updated ${reg.user.name}: MMR ${reg.mmr} → ${mmr}; medal ${rankMedalName(reg.user.rankTier)} → ${rankMedalName(rankTier)} (${mode === "manual" ? "manual" : "OpenDota"})`,
    seasonId: season.id,
  });
  return { message: `${reg.user.name}'s medal and MMR saved · ${rankMedalName(rankTier)} · ${mmr} MMR` };
}

/**
 * Permanently add an undrafted (or late-registered) player to a team with an
 * open roster seat — how short teams get topped up after the draft.
 */
export async function signFreeAgent(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const actor = await adminOrError();
  if ("error" in actor) return actor;
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  if (season.status === SEASON_STATUS.SIGNUPS) {
    return { error: "Run the draft first — signings are for after it" };
  }
  if (season.status === SEASON_STATUS.COMPLETE) {
    return { error: "The season is over" };
  }
  // While the auction is LIVE, roster writes belong to the draft engine
  // alone — signing the nominated player wedges every draft poll on a
  // unique-constraint throw. The pool-dry top-up window is Draft COMPLETE.
  if (season.status === SEASON_STATUS.DRAFT) {
    const draftRow = await prisma.draft.findUnique({
      where: { seasonId: season.id },
    });
    // `draftRow?.status !== COMPLETE`, NOT `draftRow && …`. A season only gets
    // a Draft row when Start draft is pressed, and setSeasonPhase enforces no
    // adjacency — so an admin who clicks the "Draft" phase button first sits in
    // DRAFT with a NULL draft row, and the old `draftRow &&` guard fell straight
    // through. That offered AND accepted $0 free-agent signings out of the
    // un-auctioned pool: the auction could be bypassed entirely, one player at a
    // time, before it ever started.
    if (draftRow?.status !== DRAFT_STATUS.COMPLETE) {
      return {
        error: draftRow
          ? "The draft is still running — top up rosters after it"
          : "The auction hasn't run yet — press Start draft, or move the season back to Signups",
      };
    }
  }

  const teamId = str(formData, "teamId");
  const userId = str(formData, "userId");

  const [team, registration, existingSeat, memberCount, pendingAssignments] =
    await Promise.all([
      prisma.team.findFirst({
        where: { id: teamId, seasonId: season.id },
        include: { captain: true },
      }),
      prisma.registration.findUnique({
        where: { seasonId_userId: { seasonId: season.id, userId } },
        include: { user: true },
      }),
      prisma.teamMember.findFirst({
        where: { seasonId: season.id, userId },
      }),
      prisma.teamMember.count({ where: { teamId } }),
      // Same guard promoteStandinToPlayer already applies: an outstanding
      // standin assignment on an unplayed match would put this account in BOTH
      // teams' account sets for that match, so classifyGame sees the same
      // player on each side and every import path for it fails.
      prisma.standinAssignment.count({
        where: {
          standinUserId: userId,
          match: {
            seasonId: season.id,
            status: { not: MATCH_STATUS.COMPLETED },
          },
        },
      }),
    ]);
  if (!team) return { error: "Unknown team" };
  // A withdrawn team's fixtures are all forfeited — signing onto it parks the
  // player on a dead roster (and rostered players can't stand in), for zero
  // benefit until the team is reinstated. Read-time is enough: withdrawal is
  // a slow admin act, and a mis-click here is losslessly undone by Release.
  if (team.withdrawn) {
    return {
      error: `${team.name} has withdrawn from the season — reinstate them first if they're coming back`,
    };
  }
  if (!registration || registration.status !== "ACTIVE") {
    return { error: "That player isn't registered for this season" };
  }
  // Standins fill single matches, not roster seats — signing one would leave
  // them straddling both worlds (in the standin pool AND on a roster).
  if (registration.type !== REGISTRATION_TYPE.PLAYER) {
    return {
      error: "That signup is a standin — only full players can be signed",
    };
  }
  if (existingSeat) return { error: "That player is already on a team" };
  if (pendingAssignments > 0) {
    return {
      error: `${registration.user.name} is standing in on an upcoming match — remove that assignment first, then sign them`,
    };
  }
  if (memberCount >= season.teamSize) {
    return { error: `${team.name} has no open roster seats` };
  }

  // SERIALIZABLE, not a plain transaction: on Postgres a plain one reads at
  // read-committed, so this count locks nothing and two concurrent signs into
  // a team's last seat BOTH see room and both insert — a 6-player roster in a
  // 5-a-side league. (SQLite serializes writers, which is why the old comment
  // read as if the re-check alone was enough.) The loser now aborts with
  // P2034 and is reported as the seat being taken.
  let coverCleanup: {
    cancelled: number;
    kept: number;
    standDowns: {
      standinUserId: string;
      standin: { name: string; discordId: string | null };
      match: {
        week: number;
        phase: string;
        homeTeam: { name: string };
        awayTeam: { name: string };
      };
    }[];
    /** Per-match "bookings now exceed the open seats" notes — a PARTIAL
     *  refill shrinks the seat count the assign-time budget was judged
     *  against, and nothing re-audits existing bookings. Reported, never
     *  auto-cancelled: which booking dies is the captain's call (the
     *  withdrawGateError refuse-don't-auto-cancel precedent). */
    overbooked: string[];
  } = { cancelled: 0, kept: 0, standDowns: [], overbooked: [] };
  try {
    coverCleanup = await prisma.$transaction(
      async (tx) => {
        const [currentSeason, currentDraft, currentTeam, currentRegistration] =
          await Promise.all([
            tx.season.findUnique({ where: { id: season.id } }),
            tx.draft.findUnique({ where: { seasonId: season.id } }),
            tx.team.findFirst({ where: { id: teamId, seasonId: season.id } }),
            tx.registration.findUnique({
              where: {
                seasonId_userId: { seasonId: season.id, userId },
              },
            }),
          ]);
        if (
          !currentSeason?.isActive ||
          currentSeason.status === SEASON_STATUS.SIGNUPS ||
          currentSeason.status === SEASON_STATUS.COMPLETE ||
          (currentSeason.status === SEASON_STATUS.DRAFT &&
            currentDraft?.status !== DRAFT_STATUS.COMPLETE)
        ) {
          throw new Error("ROSTER_LIFECYCLE_CHANGED");
        }
        if (!currentTeam || currentTeam.withdrawn) {
          throw new Error("TEAM_CHANGED");
        }
        if (
          !currentRegistration ||
          currentRegistration.status !== REGISTRATION_STATUS.ACTIVE ||
          currentRegistration.type !== REGISTRATION_TYPE.PLAYER
        ) {
          throw new Error("SIGNUP_CHANGED");
        }
        const seats = await tx.teamMember.count({ where: { teamId } });
        if (seats >= season.teamSize) throw new Error("SEAT_TAKEN");
        // The standin count is re-read HERE, inside the serializable
        // transaction, for the same reason assignStandinGuarded re-reads its
        // roster check inside its own: this and an assign are a write-skew
        // pair (sign reads assignments + writes TeamMember; assign reads the
        // roster + writes StandinAssignment), and SSI can only spot the cycle
        // if BOTH sides put the other's table in their read set. Re-checking
        // outside, as this did, left a single rw-edge and no cycle — so a
        // player could end up rostered AND holding live cover, which puts one
        // account in both teams' import sets and fails every classifyGame.
        const stillCovering = await tx.standinAssignment.count({
          where: {
            standinUserId: userId,
            match: {
              seasonId: season.id,
              status: { not: MATCH_STATUS.COMPLETED },
            },
          },
        });
        if (stillCovering > 0) throw new Error("STANDIN_COVER");
        const member = await tx.teamMember.create({
          data: {
            seasonId: season.id,
            teamId,
            userId,
            price: 0,
            isCaptain: false,
          },
        });
        await captureRosterTenure(tx, member, { kind: "FREE_AGENT", mmr: currentRegistration.mmr || null,
          roles: currentRegistration.roles, actorId: actor.id });
        // The reverse of releasePlayer's stale-cover rule: an EMPTY-SEAT
        // assignment (replacingUserId null) is permanently "live" to
        // matchNightRoster, so once this signing fills the team's LAST seat
        // every such booking on an unplayed match is redundant — left behind,
        // the refilled side computes as teamSize+1 on /schedule, the dashboard,
        // the week reminder AND gatherTeamAccounts' import set, while the
        // standin keeps a live @-mentioned instruction to show up. Cancel them
        // here, under the same started-series rule as release: once a game is
        // imported the assignment is load-bearing for the rest of the series,
        // so it is kept and reported instead.
        if (seats + 1 >= season.teamSize) {
          const emptySeatCovers = await tx.standinAssignment.findMany({
            where: {
              teamId,
              replacingUserId: null,
              match: {
                seasonId: season.id,
                status: { not: MATCH_STATUS.COMPLETED },
              },
            },
            select: {
              id: true,
              standinUserId: true,
              standin: { select: { name: true, discordId: true } },
              match: {
                select: {
                  games: { select: { id: true }, take: 1 },
                  week: true,
                  phase: true,
                  homeTeam: { select: { name: true } },
                  awayTeam: { select: { name: true } },
                },
              },
            },
          });
          const removable = emptySeatCovers.filter(
            (a) => a.match.games.length === 0,
          );
          let cancelled = 0;
          if (removable.length) {
            // "No games yet" rides in the WHERE, not just the JS filter — a
            // series can acquire its first game between the findMany and this
            // delete (the releasePlayer pattern).
            ({ count: cancelled } = await tx.standinAssignment.deleteMany({
              where: {
                id: { in: removable.map((s) => s.id) },
                match: { games: { none: {} } },
              },
            }));
          }
          return {
            cancelled,
            kept: emptySeatCovers.length - cancelled,
            // Announce only if the DELETE really took them all — telling a
            // standin to stand down from a game they are still booked for is
            // worse than silence.
            standDowns: cancelled === removable.length ? removable : [],
            overbooked: [],
          };
        }
        // PARTIAL refill — the team is still short, so open-seat cover stays
        // legitimate, but the seat count every booking was budgeted against
        // just shrank by one. Surplus is a PER-MATCH fact (bookings live on
        // matches, seats on the roster): a 3-of-5 team with two bookings on
        // week 4 AND two on week 5 goes surplus-by-one on both. Left silent,
        // each surplus rides matchNightRoster into /schedule, the week
        // reminder and the import account set as a six-player side.
        const newOpen = season.teamSize - (seats + 1);
        const stillBooked = await tx.standinAssignment.findMany({
          where: {
            teamId,
            replacingUserId: null,
            match: {
              seasonId: season.id,
              status: { not: MATCH_STATUS.COMPLETED },
            },
          },
          select: {
            matchId: true,
            match: {
              select: {
                week: true,
                homeTeam: { select: { name: true } },
                awayTeam: { select: { name: true } },
              },
            },
          },
        });
        const perMatch = new Map<string, { label: string; count: number }>();
        for (const b of stillBooked) {
          const cur = perMatch.get(b.matchId);
          if (cur) cur.count += 1;
          else
            perMatch.set(b.matchId, {
              label: `week ${b.match.week} ${b.match.homeTeam.name} vs ${b.match.awayTeam.name}`,
              count: 1,
            });
        }
        const overbooked = [...perMatch.values()]
          .filter((m) => m.count > newOpen)
          .map(
            (m) =>
              `${m.count} open-seat booking(s) on ${m.label} now exceed the team's ${newOpen} open seat(s) — remove the extra on the match page`,
          );
        return { cancelled: 0, kept: 0, standDowns: [], overbooked };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (e) {
    if ((e as Error).message === "ROSTER_LIFECYCLE_CHANGED") {
      return {
        error:
          "The season or auction just changed — roster signings are locked until the auction is complete.",
      };
    }
    if ((e as Error).message === "TEAM_CHANGED") {
      return { error: `${team.name} is no longer available for signings` };
    }
    if ((e as Error).message === "SIGNUP_CHANGED") {
      return {
        error: "That player's signup just changed — reload and try again",
      };
    }
    if (isSerializationConflict(e)) {
      return {
        error:
          "The auction, roster, or signup just changed — reload and try again.",
      };
    }
    if ((e as Error).message === "SEAT_TAKEN") {
      return { error: `${team.name} has no open roster seats` };
    }
    if ((e as Error).message === "STANDIN_COVER") {
      return {
        error: `${registration.user.name} is standing in on an upcoming match — remove that assignment first, then sign them`,
      };
    }
    if (isUniqueViolation(e)) {
      return { error: "That player was just signed elsewhere" };
    }
    throw e;
  }
  await logAdminAction({
    action: "signFreeAgent",
    summary: `Signed ${registration.user.name} to ${team.name}; cancelled ${coverCleanup.cancelled} redundant open-seat cover booking(s)`,
    seasonId: season.id,
  });
  await sendDiscordMessage(
    freeAgentSignedMessage(registration.user.name, team.name),
    // @-mention the signed player: a signing is a season-long obligation —
    // every remaining match night is now theirs — and this was a bare
    // broadcast while the one-night standin assign has always mentioned its
    // subject. The message ends by naming their next move (check in).
    mentionsOf([registration.user.discordId]),
  );
  // Post-commit, best-effort, one stand-down per cancelled empty-seat booking —
  // the same shape releasePlayer and both removeStandin paths send, so a
  // standin is never left holding an instruction for a seat that just filled.
  for (const a of coverCleanup.standDowns) {
    await sendDiscordMessage(
      standinRemovedMessage({
        standinName: a.standin.name,
        teamName: team.name,
        homeName: a.match.homeTeam.name,
        awayName: a.match.awayTeam.name,
        week: a.match.week,
        isPlayoff: isPlayoffPhase(a.match.phase),
        isTiebreaker: a.match.phase === MATCH_PHASE.TIEBREAKER,
        reason: "SEAT_FILLED",
      }),
      mentionsOf([a.standin.discordId]),
    );
  }
  refresh();
  const coverNotes = [
    coverCleanup.cancelled > 0
      ? `${coverCleanup.cancelled} now-redundant open-seat standin booking(s) cancelled and stood down`
      : null,
    coverCleanup.kept > 0
      ? `${coverCleanup.kept} open-seat booking(s) on an already-started series were LEFT in place (removing a standin mid-series breaks the remaining imports)`
      : null,
    ...coverCleanup.overbooked,
  ].filter(Boolean);
  return {
    message:
      `${registration.user.name} signed to ${team.name}` +
      (coverNotes.length ? ` · ${coverNotes.join(" · ")}` : "") +
      // A permanent signing that structurally can't be reached on Discord is
      // discovered on match night — the assign-standin garnish, same reason.
      (await reachabilityNote(userId)),
  };
}

/**
 * Release a non-captain from their roster — they go back to the free-agent
 * pool (their registration stays ACTIVE) and can be signed elsewhere.
 */
export async function releasePlayer(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const actor = await adminOrError();
  if ("error" in actor) return actor;
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  if (season.status === SEASON_STATUS.SIGNUPS) {
    return { error: "There are no rosters before the draft" };
  }
  if (season.status === SEASON_STATUS.COMPLETE) {
    return { error: "The season is over" };
  }
  // A LIVE auction owns the rosters: releasing a just-sold player deletes
  // the seat without refunding the budget and re-lists them for a second
  // auction. Releases wait for the draft to finish.
  if (season.status === SEASON_STATUS.DRAFT) {
    const draftRow = await prisma.draft.findUnique({
      where: { seasonId: season.id },
    });
    // Same missing-Draft-row hole as signFreeAgent above.
    if (draftRow?.status !== DRAFT_STATUS.COMPLETE) {
      return {
        error: draftRow
          ? "The draft is still running — release players after it"
          : "The auction hasn't run yet — there is nothing drafted to release",
      };
    }
  }

  const memberId = str(formData, "memberId");
  const member = await prisma.teamMember.findFirst({
    where: { id: memberId, seasonId: season.id },
    include: { user: true, team: true },
  });
  if (!member) return { error: "Unknown roster spot" };
  if (member.isCaptain) {
    return { error: "Captains can't be released — the team is theirs" };
  }

  // Release is three things, not one — do them atomically.
  //
  // 1. REFUND the price. The whole auction rests on `budget >= need * MIN_BID`
  //    (maintained by maxBid on every purchase). Deleting the seat raises `need`
  //    while leaving `budget` alone, so a team that spent out ended at
  //    need=1/budget=$0 — and resolveStalledNomination (the one nomination path
  //    with no affordability check) would then open a $1 lot it can't pay for and
  //    drive the budget negative. Refunding also makes the post-draft budget
  //    figure honest instead of counting a player who has gone.
  // 2. CANCEL cover for the seat. StandinAssignment rows keyed to this player as
  //    `replacingUserId` outlive them, and matchNightRoster removes the covered
  //    player from the base roster before appending the standin — so once the
  //    covered player is gone the filter removes nobody and the side is computed
  //    one too large (five plus a standin in a 5v5). That inflated number feeds
  //    /schedule, the dashboard strip and the Discord week reminder, and the
  //    admin's uncovered-OUT alert can't catch it because it only looks at
  //    current roster members.
  // 3. Announce the release, as before.
  let releaseResult: {
    cancelled: number;
    kept: number;
    standDowns: {
      id: string;
      standinUserId: string;
      standin: { name: string; discordId: string | null };
      match: {
        games: { id: string }[];
        week: number;
        phase: string;
        homeTeam: { name: string };
        awayTeam: { name: string };
      };
    }[];
    teamName: string;
  };
  try {
    releaseResult = await prisma.$transaction(
      async (tx) => {
        const [currentSeason, currentDraft] = await Promise.all([
          tx.season.findUnique({ where: { id: season.id } }),
          tx.draft.findUnique({ where: { seasonId: season.id } }),
        ]);
        if (
          !currentSeason?.isActive ||
          currentSeason.status === SEASON_STATUS.SIGNUPS ||
          currentSeason.status === SEASON_STATUS.COMPLETE ||
          (currentSeason.status === SEASON_STATUS.DRAFT &&
            currentDraft?.status !== DRAFT_STATUS.COMPLETE)
        ) {
          throw new Error("ROSTER_LIFECYCLE_CHANGED");
        }
        // THE claim, and the FIRST write — a deleteMany re-asserting the row still
        // exists, never a raw delete: two releases racing (second tab, second
        // admin) made the loser die on an unhandled P2025 (the undoLastSale
        // lesson), and a `return` here after later writes would COMMIT them, so
        // the zero-count case THROWS and rolls the transaction back whole.
        const gone = await tx.teamMember.deleteMany({
          where: {
            id: member.id,
            seasonId: season.id,
            isCaptain: false,
            // Team.captainId is authoritative. A transfer that promoted this row
            // after the page rendered must beat the stale Release instead of being
            // left pointing at a roster seat this transaction deleted.
            team: { captainId: { not: member.userId } },
          },
        });
        if (gone.count === 0) {
          const current = await tx.teamMember.findUnique({
            where: { id: member.id },
            select: { isCaptain: true, team: { select: { captainId: true } } },
          });
          if (current?.isCaptain || current?.team.captainId === member.userId) {
            throw new Error("CAPTAINCY_CHANGED");
          }
          throw new Error("ALREADY_RELEASED");
        }
        await closeRosterTenure(tx, member, "RELEASE", actor.id);
        // Only cover on a series that hasn't started. Once a game is imported the
        // assignment is load-bearing for the REST of that series: gatherTeamAccounts
        // re-reads StandinAssignment on every import, so deleting it mid-Bo3 drops
        // the standin from the team's account set for games 2 and 3 — their lines get
        // stored with a null teamId, and if the side falls under classifyGame's
        // recognizable-account floor the later games stop importing altogether. This
        // is exactly the deletion removeStandinGuarded refuses ("would strip them
        // from the rest of the series"); do not let release do it by the back door.
        const covering = await tx.standinAssignment.findMany({
          where: {
            replacingUserId: member.userId,
            match: {
              seasonId: season.id,
              status: { not: MATCH_STATUS.COMPLETED },
            },
          },
          // The standin + fixture fields are carried so the STAND-DOWN can be
          // announced below. Being told to turn up for a game is the most
          // action-demanding message this league sends, and release was the one
          // path that cancelled such a booking in silence — the standin kept a
          // live Discord instruction (with an @mention) for a match they had been
          // removed from, and nothing ever corrected it. Both removeStandin and
          // captainRemoveStandin have always sent this.
          select: {
            id: true,
            standinUserId: true,
            standin: { select: { name: true, discordId: true } },
            match: {
              select: {
                games: { select: { id: true }, take: 1 },
                week: true,
                phase: true,
                homeTeam: { select: { name: true } },
                awayTeam: { select: { name: true } },
              },
            },
          },
        });
        const removable = covering.filter((a) => a.match.games.length === 0);
        let cancelled = 0;
        if (removable.length) {
          // The "no games imported yet" condition rides in the WHERE, not just in
          // the JS filter above: on Postgres READ COMMITTED a series can acquire
          // its first game between the findMany and this delete, and dropping
          // cover mid-series is precisely what removeStandinGuarded refuses.
          // The toast counts what the DELETE actually matched, so it can never
          // claim a cancellation the predicate refused.
          ({ count: cancelled } = await tx.standinAssignment.deleteMany({
            where: {
              id: { in: removable.map((s) => s.id) },
              match: { games: { none: {} } },
            },
          }));
        }
        if (member.price > 0) {
          await tx.team.update({
            where: { id: member.teamId },
            data: { budget: { increment: member.price } },
          });
        }
        return {
          // What the DELETE actually matched — never what the JS filter hoped.
          cancelled,
          kept: covering.length - cancelled,
          // Only announce if the DELETE really took them all; if the predicate
          // refused some row we cannot tell which, and telling a standin to stand
          // down from a game they are still booked for is worse than silence.
          standDowns: cancelled === removable.length ? removable : [],
          teamName: member.team.name,
        };
      },
      // SERIALIZABLE — release and assignStandinGuarded are a write-skew pair
      // (release reads the assignments and deletes the TeamMember; assign
      // reads the TeamMember and creates an assignment), and SSI only spots
      // the cycle when EVERY participant is serializable. At read-committed
      // both commit and the cover-cancel misses the assignment landing in the
      // gap: a stale row matchNightRoster counts as a SIXTH player, whose
      // stand-down announcement structurally never fired.
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (e) {
    if ((e as Error).message === "ROSTER_LIFECYCLE_CHANGED") {
      return {
        error:
          "The season or auction just changed — releases are locked until the auction is complete.",
      };
    }
    if ((e as Error).message === "CAPTAINCY_CHANGED") {
      return {
        error: `${member.user.name} was just made captain — reload before changing this roster.`,
      };
    }
    if ((e as Error).message === "ALREADY_RELEASED") {
      return {
        error: `${member.user.name} was already released — reload to see the roster`,
      };
    }
    if (isSerializationConflict(e)) {
      return {
        error:
          "The roster changed while you were releasing — reload and try again",
      };
    }
    throw e;
  }
  const { cancelled, kept, standDowns, teamName } = releaseResult;

  await logAdminAction({
    action: "releasePlayer",
    summary: `Released ${member.user.name} from ${member.team.name}; refunded $${member.price} and cancelled ${cancelled} standin assignment(s)`,
    seasonId: season.id,
  });

  await sendDiscordMessage(
    playerReleasedMessage(member.user.name, member.team.name),
    // @-mention the released player. This was a bare broadcast while the
    // stand-down loop right below it — and signFreeAgent, and both
    // removeStandin paths — all mention their subject. Release is the most
    // personal roster event the league produces, and the person it happens to
    // was the one participant not told: they found out when the "Your team"
    // block vanished from /me. `member` is loaded with its user, so the
    // snowflake is already in hand.
    mentionsOf([member.user.discordId]),
  );
  // Post-commit, best-effort, one per cancelled booking — same shape and same
  // formatter the two removeStandin paths use, so a standin can never be left
  // holding an instruction for a match they were quietly dropped from.
  for (const a of standDowns) {
    await sendDiscordMessage(
      standinRemovedMessage({
        standinName: a.standin.name,
        teamName,
        homeName: a.match.homeTeam.name,
        awayName: a.match.awayTeam.name,
        week: a.match.week,
        isPlayoff: isPlayoffPhase(a.match.phase),
        isTiebreaker: a.match.phase === MATCH_PHASE.TIEBREAKER,
        reason: "PLAYER_RELEASED",
      }),
      mentionsOf([a.standin.discordId]),
    );
  }
  refresh();
  const extra = [
    member.price > 0
      ? `$${member.price} refunded to ${member.team.name}`
      : null,
    cancelled > 0
      ? `${cancelled} standin assignment(s) covering them cancelled — re-cover those matches`
      : null,
    // Left in place on purpose; the admin still needs to know it's there.
    // NOT "remove by hand": removeStandinGuarded refuses once games are
    // imported, so that advice sent the admin in a circle — the truthful
    // statement is that the booking is settled for the rest of the series.
    kept > 0
      ? `${kept} assignment(s) on an already-started series stay in place — the remaining games record whoever actually plays`
      : null,
    // Release deliberately keeps the registration ACTIVE (release + sign =
    // trade), so a true QUITTER is now the league's phantom free agent —
    // offered in every standin dropdown and counted by the capacity math —
    // unless the admin also runs the remove step, which nothing else at this
    // point of use mentions.
    "if they've left the league entirely, also remove their signup (Captains & draft) so they drop out of the free-agent and standin pools",
  ].filter(Boolean);
  return {
    message:
      `${member.user.name} released from ${member.team.name}` +
      (extra.length ? ` · ${extra.join(" · ")}` : ""),
  };
}

/**
 * A whole TEAM quits mid-season — the most common amateur-league disaster,
 * which used to be an unassisted grind: hand-typing a forfeit score for every
 * remaining fixture, week after week, while the dead team stayed in the
 * standings math, pick'em, the reminders, and — because seeding never asked —
 * got seeded into the playoff bracket on its banked points.
 *
 * One action: every unplayed REGULAR fixture is forfeited 0-N to the opponent
 * (forfeit=true, so the official 0-N score counts in standings while the
 * performance-only power rankings skip it), open reschedule proposals on them
 * are cancelled, and the team is flagged `withdrawn` — which is what excludes
 * it from playoff seeding (createPlayoffBracket filters the flag; standings
 * could not do that job, since a team that banked points before dying can
 * out-rank the cut).
 * Rosters, results and history are KEPT: the games happened.
 *
 * Recovery: reinstateTeam flips the flag back, and each forfeited fixture is
 * individually reversible via "Reopen for import" (forfeits have no games).
 */
export async function withdrawTeam(
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
        "The active season changed while this team-withdrawal control was open — reload before changing a team.",
    };
  }
  const lockedReason = teamWithdrawalLockedReason(season.status);
  if (lockedReason) return { error: lockedReason };
  const teamId = str(formData, "teamId");

  // This first read is presentation-only: it lets the success message say a
  // fixture completed for real while the admin was clicking. The transaction
  // below re-reads every authoritative row after claiming the Season.
  const observedOpen = await prisma.match.findMany({
    where: {
      seasonId: season.id,
      phase: MATCH_PHASE.REGULAR,
      status: { not: MATCH_STATUS.COMPLETED },
      OR: [{ homeTeamId: teamId }, { awayTeamId: teamId }],
    },
    select: { id: true },
  });

  // Seam: the rival must COMMIT before the transaction below opens, which is
  // exactly the auto-sync or lifecycle-switch case (a separate request that
  // already finished). The transaction's fresh reads decide the mutation.
  await raceHook("admin.withdrawTeam.beforeTx");
  let withdrawal;
  try {
    withdrawal = await prisma.$transaction(
      async (tx) => {
        // This is the cross-aggregate enforcement point. Claiming Season
        // BEFORE Team/Match gives archive, phase, schedule, result, and team
        // operations one ordering row; a plain season read would not conflict
        // with an archive that only writes Season.
        if (!(await claimTeamWithdrawalSeason(tx, expectedActiveSeasonId))) {
          throw new TeamWithdrawalLifecycleChangedError();
        }

        const [team, open, observedNow] = await Promise.all([
          tx.team.findFirst({
            where: { id: teamId, seasonId: expectedActiveSeasonId },
          }),
          tx.match.findMany({
            where: {
              seasonId: expectedActiveSeasonId,
              phase: MATCH_PHASE.REGULAR,
              status: { not: MATCH_STATUS.COMPLETED },
              OR: [{ homeTeamId: teamId }, { awayTeamId: teamId }],
            },
            select: {
              id: true,
              week: true,
              status: true,
              scheduledAt: true,
              bestOf: true,
              homeTeamId: true,
              awayTeamId: true,
            },
          }),
          tx.match.findMany({
            where: { id: { in: observedOpen.map((match) => match.id) } },
            select: { id: true, status: true },
          }),
        ]);
        if (!team) throw new CaptainStateChangedError();

        // THE enforcement point for "not already withdrawn". Throwing here
        // rolls back the Season claim too; the former array transaction ran
        // all forfeit writes even when this count was zero, then merely
        // returned an error after commit.
        const flagged = await tx.team.updateMany({
          where: {
            id: teamId,
            seasonId: expectedActiveSeasonId,
            withdrawn: false,
          },
          data: { withdrawn: true },
        });
        if (flagged.count === 0) {
          throw new TeamAlreadyWithdrawnError(team.name);
        }
        const cancelledScrims = await tx.scrim.updateMany({
          where: {
            seasonId: expectedActiveSeasonId,
            status: { in: [SCRIM_STATUS.OPEN, SCRIM_STATUS.SCHEDULED] },
            OR: [{ hostTeamId: teamId }, { opponentTeamId: teamId }],
          },
          data: { status: SCRIM_STATUS.CANCELLED },
        });

        // Standins booked on the doomed fixtures become inert history when
        // those matches are ruled. Carry the rows out so the post-commit path
        // can stand each person down by name.
        const mootCover = await tx.standinAssignment.findMany({
          where: { matchId: { in: open.map((match) => match.id) } },
          select: {
            matchId: true,
            teamId: true,
            standin: { select: { name: true, discordId: true } },
            match: {
              select: {
                week: true,
                phase: true,
                homeTeam: { select: { name: true } },
                awayTeam: { select: { name: true } },
              },
            },
          },
        });

        const matchClaims: { count: number }[] = [];
        for (const match of open) {
          const matchClaim = await tx.match.updateMany({
            where: {
              id: match.id,
              status: { not: MATCH_STATUS.COMPLETED },
            },
            data: {
              status: MATCH_STATUS.COMPLETED,
              forfeit: true,
              completedAt: new Date(),
              homeScore:
                match.homeTeamId === teamId ? 0 : forfeitScore(match.bestOf),
              awayScore:
                match.awayTeamId === teamId ? 0 : forfeitScore(match.bestOf),
              winnerTeamId:
                match.homeTeamId === teamId
                  ? match.awayTeamId
                  : match.homeTeamId,
            },
          });
          matchClaims.push(matchClaim);
          if (matchClaim.count === 1) {
            if (match.status === MATCH_STATUS.SCHEDULED && match.scheduledAt) {
              await invalidatePendingAnnouncementMarkers(
                tx,
                weekReminderKey(
                  expectedActiveSeasonId,
                  match.week,
                  match.scheduledAt.getTime(),
                ),
              );
            }
            await invalidateResultNudges(tx, match.id);
            // The single team-withdrawal broadcast replaces noisy per-series
            // result posts. Persist that decision with the result so generic
            // completedAt crash recovery cannot replay these ruled fixtures;
            // updating also invalidates any impossible stale queued source.
            const value = `suppressed:team-withdrawal:${new Date().toISOString()}`;
            await tx.setting.upsert({
              where: { key: resultAnnouncedKey(match.id) },
              create: { key: resultAnnouncedKey(match.id), value },
              update: { value },
            });
          }
        }
        await tx.rescheduleRequest.updateMany({
          where: {
            matchId: { in: open.map((match) => match.id) },
            status: "PENDING",
          },
          data: { status: "CANCELLED" },
        });
        await stampResultChange(tx);

        return {
          team,
          open,
          mootCover,
          matchClaims,
          cancelledScrims: cancelledScrims.count,
          // Matches that completed after the presentation read but before the
          // transaction are not in `open`; retain the old truthful toast note.
          completedBeforeClaim: observedNow.filter(
            (match) => match.status === MATCH_STATUS.COMPLETED,
          ).length,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (error instanceof ResultWriteError) return { error: error.message };
    if (error instanceof CaptainStateChangedError) {
      return { error: "Unknown team" };
    }
    if (error instanceof TeamAlreadyWithdrawnError) {
      return { error: `${error.message} has already withdrawn` };
    }
    if (
      error instanceof TeamWithdrawalLifecycleChangedError ||
      isSerializationConflict(error)
    ) {
      return {
        error:
          "The active season or its phase changed while this withdrawal was open — reload before changing the team.",
      };
    }
    throw error;
  }

  const {
    team,
    open,
    mootCover,
    matchClaims,
    cancelledScrims,
    completedBeforeClaim,
  } = withdrawal;
  const forfeited = matchClaims.reduce((n, r) => n + r.count, 0);
  const raced = open.length - forfeited + completedBeforeClaim;

  // Forfeits can close out whole weeks — honors are idempotent and quiet for
  // weeks with nothing imported, so firing per affected week is safe.
  for (const week of [...new Set(open.map((m) => m.week))]) {
    await maybeAnnounceWeekHonors(season.id, week);
  }
  // Stand the booked standins down BEFORE the broadcast, so the personal
  // correction lands ahead of the news. Post-commit and best-effort (the
  // house shape). Only bookings on fixtures whose forfeit claim actually WON:
  // matchClaims is index-aligned with `open`, so a fixture that completed for
  // real mid-click (count 0) keeps its booking un-stood-down — that series
  // happened, and its standin may well have played it.
  const forfeitedIds = new Set(
    open.filter((_, i) => matchClaims[i].count > 0).map((m) => m.id),
  );
  const teamNameOf = new Map<string, string>();
  for (const t of await prisma.team.findMany({
    where: { seasonId: season.id },
    select: { id: true, name: true },
  })) {
    teamNameOf.set(t.id, t.name);
  }
  const stoodDown = mootCover.filter((a) => forfeitedIds.has(a.matchId));
  for (const a of stoodDown) {
    await sendDiscordMessage(
      standinRemovedMessage({
        standinName: a.standin.name,
        teamName: teamNameOf.get(a.teamId) ?? "their team",
        homeName: a.match.homeTeam.name,
        awayName: a.match.awayTeam.name,
        week: a.match.week,
        isPlayoff: isPlayoffPhase(a.match.phase),
        isTiebreaker: a.match.phase === MATCH_PHASE.TIEBREAKER,
        reason: "TEAM_WITHDREW",
      }),
      mentionsOf([a.standin.discordId]),
    );
  }
  await sendDiscordMessage(teamWithdrewMessage(team.name, forfeited));
  await logAdminAction({
    action: "withdrawTeam",
    summary: `Withdrew ${team.name} — ${forfeited} remaining fixture(s) forfeited to the opponents and ${cancelledScrims} unplayed scrim(s) cancelled${raced ? ` (${raced} completed for real mid-flight and kept their result)` : ""}`,
    seasonId: season.id,
  });
  refresh();
  const notes = [
    `${forfeited} fixture(s) forfeited to the opponents`,
    raced
      ? `${raced} completed for real while you clicked and kept their result`
      : null,
    stoodDown.length
      ? `${stoodDown.length} standin booking(s) on those fixtures stood down`
      : null,
    cancelledScrims
      ? `${cancelledScrims} unplayed scrim(s) cancelled`
      : null,
    "excluded from playoff seeding · rosters and played results are kept",
    // The withdrawn team's players are the league's most natural standin pool
    // — but rostered players can't stand in, and nothing else at the point of
    // use says release is the unlock.
    "release their players (Roster moves) to free them for standin duty or signing elsewhere",
  ].filter(Boolean);
  return { message: `${team.name} withdrawn · ${notes.join(" · ")}` };
}

/** The undo for the flag half of withdrawTeam. The forfeited fixtures are
 *  reversed individually ("Reopen for import" — forfeits carry no games). */
export async function reinstateTeam(
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
        "The active season changed while this reinstatement control was open — reload before changing a team.",
    };
  }
  const lockedReason = teamWithdrawalLockedReason(season.status);
  if (lockedReason) return { error: lockedReason };
  const teamId = str(formData, "teamId");
  await raceHook("admin.reinstateTeam.beforeTx");
  let teamName: string;
  try {
    teamName = await prisma.$transaction(
      async (tx) => {
        if (!(await claimTeamWithdrawalSeason(tx, expectedActiveSeasonId))) {
          throw new TeamWithdrawalLifecycleChangedError();
        }
        const team = await tx.team.findFirst({
          where: { id: teamId, seasonId: expectedActiveSeasonId },
          select: { name: true },
        });
        if (!team) throw new CaptainStateChangedError();
        const flipped = await tx.team.updateMany({
          where: {
            id: teamId,
            seasonId: expectedActiveSeasonId,
            withdrawn: true,
          },
          data: { withdrawn: false },
        });
        if (flipped.count === 0) throw new TeamNotWithdrawnError();
        return team.name;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (error instanceof ResultWriteError) return { error: error.message };
    if (error instanceof CaptainStateChangedError) {
      return { error: "Unknown team" };
    }
    if (error instanceof TeamNotWithdrawnError) {
      return { error: "That team isn't withdrawn" };
    }
    if (
      error instanceof TeamWithdrawalLifecycleChangedError ||
      isSerializationConflict(error)
    ) {
      return {
        error:
          "The active season or its phase changed while this reinstatement was open — reload before changing the team.",
      };
    }
    throw error;
  }
  await logAdminAction({
    action: "reinstateTeam",
    summary: `Reinstated ${teamName} — back in playoff-seeding contention`,
    seasonId: season.id,
  });
  refresh();
  return {
    message: `${teamName} reinstated — reverse any forfeits you want undone with "Reopen for import" on each fixture`,
  };
}

/** Assign a standin to fill in for a rostered player in a specific match.
 *  Guards live in standin-service (shared with the captain self-serve path). */
export async function assignStandin(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  // One select carries both cases: a userId covers that player, `seat:<teamId>`
  // fills an EMPTY seat on a short roster (replacing nobody).
  const target = str(formData, "replacingUserId");
  const seat = parseSeatTarget(target);
  const res = await assignStandinGuarded({
    matchId: str(formData, "matchId"),
    standinUserId: str(formData, "standinUserId"),
    replacingUserId: seat ? null : target,
    teamId: seat ?? undefined,
    actingCaptainId: null, // admin override — either team
    actingUserId: admin.id,
  });
  if (!res.ok) return { error: res.error };
  // The standin must HEAR about their game night — best-effort, never blocks.
  await sendDiscordMessage(res.announcement, res.mentions);
  await logAdminAction({ action: "assignStandin", summary: res.summary });
  refresh();
  // If the announcement structurally can't reach them (unlinked, not in the
  // server, stuck behind the rules screen), the person arranging the cover
  // finds out NOW, not on match night. "" when reachable or unknowable.
  return {
    message:
      res.message + (await reachabilityNote(str(formData, "standinUserId"))),
  };
}

/** Remove a standin assignment. */
export async function removeStandin(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  const res = await removeStandinGuarded({
    assignmentId: str(formData, "assignmentId"),
    actingCaptainId: null,
    actingUserId: admin.id,
  });
  if (!res.ok) return { error: res.error };
  await sendDiscordMessage(res.announcement, res.mentions);
  await logAdminAction({ action: "removeStandin", summary: res.summary });
  refresh();
  return { message: res.message };
}

/**
 * Promote an ACTIVE standin registration to a full PLAYER — the mid-season
 * roster refill. Self-serve PLAYER signups close after SIGNUPS
 * (registrationGate) and signFreeAgent refuses standins, so without this the
 * only path to fill an abandoned seat was flipping the whole season back to
 * SIGNUPS. Flow: late joiner registers as standin on /me → admin promotes →
 * signs them via the free-agent form (which does the Discord announcement).
 */
export async function promoteStandinToPlayer(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  const userId = str(formData, "userId");
  // Deterministic SQLite seam: a rival can commit immediately before the
  // authoritative snapshot without trying to open a second writer while this
  // transaction is live (SQLite pins interactive transactions to one writer).
  await raceHook("admin.promoteStandin.beforeTx");

  let candidateName: string | null = null;
  let outcome:
    { ok: true; seasonId: string; name: string } | { ok: false; error: string };
  try {
    outcome = await prisma.$transaction(
      async (tx) => {
        // Season, Draft, Registration, and pending cover are one decision. In
        // particular, startDraft is Serializable too and reads the PLAYER
        // pool before writing Season/Draft; PostgreSQL SSI therefore orders
        // that command against this Registration write instead of allowing a
        // standin to materialise in an already-snapshotted live auction.
        const activeSeasons = await tx.season.findMany({
          where: { isActive: true },
          orderBy: { createdAt: "desc" },
          take: 2,
        });
        if (activeSeasons.length === 0) {
          return { ok: false as const, error: "No active season" };
        }
        if (activeSeasons.length > 1) {
          return {
            ok: false as const,
            error:
              "More than one season is marked active — resolve that data integrity issue before promoting players",
          };
        }
        const season = activeSeasons[0];
        const [registration, draftRow, pendingAssignments] = await Promise.all([
          tx.registration.findUnique({
            where: {
              seasonId_userId: { seasonId: season.id, userId },
            },
            include: { user: true },
          }),
          tx.draft.findUnique({ where: { seasonId: season.id } }),
          tx.standinAssignment.count({
            where: pendingCoverWhere(userId, season.id),
          }),
        ]);
        if (!registration) {
          return {
            ok: false as const,
            error: "That person isn't registered for this season",
          };
        }
        candidateName = registration.user.name;
        const gateError = promoteGateError({
          seasonStatus: season.status,
          draftStatus: draftRow?.status ?? null,
          registrationStatus: registration.status,
          registrationType: registration.type,
          pendingAssignments,
        });
        if (gateError) return { ok: false as const, error: gateError };

        // PostgreSQL-only deterministic seam: startDraft can commit after all
        // gate reads but before this claim. The two Serializable commands form
        // a read/write cycle, so this command must abort rather than promote a
        // player into a draft whose pool snapshot is already live.
        await raceHook("admin.promoteStandin.afterGate");

        // Keep the row predicate as a second line of defence against withdraw,
        // remove, or duplicate-promote rivals. The enclosing Serializable
        // snapshot is what additionally protects the Season/Draft decision.
        const promoted = await tx.registration.updateMany({
          where: {
            id: registration.id,
            seasonId: season.id,
            userId,
            status: REGISTRATION_STATUS.ACTIVE,
            type: REGISTRATION_TYPE.STANDIN,
          },
          data: {
            type: REGISTRATION_TYPE.PLAYER,
            ...clearedDraftConfirmation,
          },
        });
        if (promoted.count === 0) {
          return {
            ok: false as const,
            error: `${registration.user.name}'s signup just changed — reload and check it before promoting`,
          };
        }
        return {
          ok: true as const,
          seasonId: season.id,
          name: registration.user.name,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (isSerializationConflict(error)) {
      return {
        error: candidateName
          ? `${candidateName}'s signup just changed — reload and check it before promoting`
          : "The season, draft, or signup just changed — reload and check it before promoting",
      };
    }
    throw error;
  }
  if (!outcome.ok) return { error: outcome.error };

  await logAdminAction({
    action: "promoteStandinToPlayer",
    summary: `Promoted ${outcome.name} from standin to full player`,
    seasonId: outcome.seasonId,
  });
  refresh();
  return {
    message: `${outcome.name} is now a full player — sign them onto a team in Roster moves`,
  };
}
