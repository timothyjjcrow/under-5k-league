"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { raceHook } from "@/lib/race-hook";
import { getActiveSeason } from "@/lib/season";
import {
  DRAFT_STATUS,
  REGISTRATION_STATUS,
  REGISTRATION_TYPE,
  type RegistrationType,
} from "@/lib/constants";
import { draftSetupOpen } from "@/lib/draft-setup";
import {
  medalProvesIneligible,
  registrationGate,
  registrationSeasonClosedError,
  withdrawGateError,
} from "@/lib/registration";
import { pendingCoverWhere } from "@/lib/standin";
import { normalizeDiscordName } from "@/lib/discord-name";
import { unlinkDiscordAccount } from "@/lib/discord-link-service";
import { getRoleConfig, setPingRole } from "@/lib/discord-roles";
import { bool, clampInt, str } from "@/lib/form";
import {
  parseAccountId,
  steamIdToAccountId,
  fetchPlayerRankTier,
  fetchPubStats,
  fetchRankTier,
} from "@/lib/dota";
import { clampMmrToRank, formatMmrRange, rankMedalName } from "@/lib/rank";
import { clampHeroList } from "@/lib/heroes";
import { serializeRoles } from "@/lib/roles";
import { fetchSteamProfiles } from "@/lib/steam";
import { sendDiscordMessage, signupMessage } from "@/lib/discord";
import type { ActionResult } from "@/lib/action-result";

function refresh() {
  revalidatePath("/", "layout");
}

const clearedDraftConfirmation = {
  draftConfirmedRevision: null,
  draftConfirmedAt: null,
  draftConfirmedFor: null,
} as const;

class DraftConfirmationClosedError extends Error {}
class DraftConfirmationChangedError extends Error {}
class RegistrationLifecycleChangedError extends Error {}
class RegistrationRosterChangedError extends Error {}
class RegistrationIdentityChangedError extends Error {}
class RegistrationStateChangedError extends Error {}

/**
 * A signed-up full player acknowledges the exact draft schedule rendered on
 * /me. Both hidden values are untrusted: identity, registration state and the
 * current schedule are re-read here, and the write also claims the season
 * revision so a stale tab cannot silently confirm a time the player never saw.
 */
export async function confirmDraftReadiness(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { error: "Sign in required" };
  }

  const revisionRaw = str(formData, "draftRevision").trim();
  const draftAtRaw = str(formData, "draftAtTs").trim();
  const expectedActiveSeasonId = str(formData, "expectedActiveSeasonId").trim();
  const expectedRevision = Number(revisionRaw);
  const expectedDraftAt = Number(draftAtRaw);
  if (
    !/^\d+$/.test(revisionRaw) ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0 ||
    !/^\d+$/.test(draftAtRaw) ||
    !Number.isSafeInteger(expectedDraftAt) ||
    expectedDraftAt <= 0
  ) {
    return { error: "Reload the page and review the draft time again." };
  }

  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  if (!expectedActiveSeasonId || expectedActiveSeasonId !== season.id) {
    return {
      error:
        "The active season changed — reload and review the current draft time.",
    };
  }
  if (!season.draftAt) {
    return { error: "The draft night has not been scheduled yet." };
  }
  if (
    season.draftRevision !== expectedRevision ||
    season.draftAt.getTime() !== expectedDraftAt
  ) {
    return {
      error: "The draft time changed — reload and confirm the updated time.",
    };
  }

  await raceHook("registration.confirmDraftReadiness.beforeWrite");
  const confirmedAt = new Date();
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
        if (!currentSeason?.isActive) {
          throw new DraftConfirmationChangedError();
        }
        if (!draftSetupOpen(currentSeason.status, draft?.status)) {
          throw new DraftConfirmationClosedError();
        }
        if (
          currentSeason.draftRevision !== expectedRevision ||
          currentSeason.draftAt?.getTime() !== expectedDraftAt
        ) {
          throw new DraftConfirmationChangedError();
        }
        const confirmed = await tx.registration.updateMany({
          where: {
            seasonId: currentSeason.id,
            userId: user.id,
            status: REGISTRATION_STATUS.ACTIVE,
            type: REGISTRATION_TYPE.PLAYER,
            season: {
              draftRevision: expectedRevision,
              draftAt: new Date(expectedDraftAt),
              status: { in: ["SIGNUPS", "DRAFT"] },
              isActive: true,
            },
          },
          data: {
            draftConfirmedRevision: expectedRevision,
            draftConfirmedAt: confirmedAt,
            draftConfirmedFor: new Date(expectedDraftAt),
          },
        });
        if (confirmed.count === 0) {
          throw new DraftConfirmationChangedError();
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (error instanceof DraftConfirmationClosedError) {
      return { error: "Draft confirmations are closed for this season." };
    }
    if (
      error instanceof DraftConfirmationChangedError ||
      (error as { code?: string }).code === "P2034"
    ) {
      return {
        error:
          "Your signup, season, or draft time just changed — reload and review it again.",
      };
    }
    throw error;
  }

  // A schedule update that lands immediately after the guarded write makes
  // this confirmation honestly stale. Detect it before claiming success; the
  // stored old revision is retained so /me and admin can explain what changed.
  const current = await prisma.season.findUnique({
    where: { id: season.id },
    select: {
      draftRevision: true,
      draftAt: true,
      status: true,
      isActive: true,
    },
  });
  if (
    !current?.isActive ||
    (current.status !== "SIGNUPS" && current.status !== "DRAFT") ||
    current.draftRevision !== expectedRevision ||
    current.draftAt?.getTime() !== expectedDraftAt
  ) {
    refresh();
    return {
      error: "The draft time changed while you confirmed — review it again.",
    };
  }

  refresh();
  return {
    message: "Ready for draft confirmed — thanks for checking in!",
  };
}

/** Join the active season (or update your existing signup: MMR, type, captain). */
export async function saveRegistration(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { error: "Sign in required" };
  }
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  const seasonClosed = registrationSeasonClosedError(season.status);
  if (seasonClosed) return { error: seasonClosed };
  // This snapshot is intentionally taken before the optional OpenDota fetch.
  // That network round trip is the widest gap in the action: startDraft can
  // move the season and auction while the player is waiting. The final
  // Serializable write re-asserts both versions before changing the pool.
  const draftSnapshot = await prisma.draft.findUnique({
    where: { seasonId: season.id },
    select: { status: true, updatedAt: true },
  });

  const type =
    str(formData, "type") === REGISTRATION_TYPE.STANDIN
      ? REGISTRATION_TYPE.STANDIN
      : REGISTRATION_TYPE.PLAYER;
  let mmr = clampInt(formData, "mmr", 0, 0, 12000);
  const requestedWantsCaptain = bool(formData, "wantsCaptain");
  const roles = serializeRoles(formData.getAll("roles").map(String));
  // Clamp on whole hero names, not raw characters — a mid-name cut rendered
  // as garbage in the player pool and draft room.
  const favoriteHeroes = clampHeroList(str(formData, "favoriteHeroes"), 200);
  // Trim before storing: a whitespace-only note used to render as an empty
  // pair of smart quotes with a "NOTE FOR CAPTAINS" label above it.
  const statement = str(formData, "statement").trim().slice(0, 1000);
  const captainNote = str(formData, "captainNote").trim().slice(0, 1000);

  const existing = await prisma.registration.findUnique({
    where: { seasonId_userId: { seasonId: season.id, userId: user.id } },
  });
  // Lets the duplicate-submit integration test hold two requests after both
  // observed "no signup" and prove the unique-key loser is truly idempotent.
  await raceHook("registration.saveRegistration.afterExistingRead");
  // Captain volunteering is a signup-phase decision for full players. A
  // disabled checkbox does not submit, so after signups preserve the stored
  // answer rather than silently clearing it; standins never enter the captain
  // candidate pool.
  const wantsCaptain =
    type === REGISTRATION_TYPE.PLAYER
      ? season.status === "SIGNUPS"
        ? requestedWantsCaptain
        : (existing?.wantsCaptain ?? false)
      : false;

  // The player's ranked medal, needed BEFORE the gate: claimed MMR is
  // validated against it. On a brand-new signup with no stored medal, pull it
  // from Dota (via OpenDota — the free public API over Valve's match data
  // that Dotabuff-style sites read too; Dotabuff itself has no public API) so
  // captains see a rank without the player manually linking their account
  // first. Best-effort: fetchPlayerRankTier never throws and returns null
  // when the profile is private or unavailable. Only fetch when they don't
  // already have a medal, so we never overwrite a good value with a null and
  // never re-hit the API on signup edits.
  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: { dotaAccountId: true, rankTier: true },
  });
  let rankTier = dbUser?.rankTier ?? null;
  let medalLabel = "";
  if (!existing && dbUser && dbUser.rankTier == null) {
    const accountId = dbUser.dotaAccountId ?? steamIdToAccountId(user.steamId);
    const fetched = accountId ? await fetchPlayerRankTier(accountId) : null;
    if (fetched != null) {
      // The OpenDota request can take seconds. Another tab may link a
      // different Dota account while it is in flight, so claim both facts we
      // fetched against instead of stamping the old account's medal onto the
      // new link. If the claim loses, use whatever rank is current now.
      await raceHook("registration.saveRegistration.beforeRankWrite");
      const stored = await prisma.user.updateMany({
        where: {
          id: user.id,
          rankTier: null,
          dotaAccountId: dbUser.dotaAccountId,
        },
        data: { rankTier: fetched },
      });
      if (stored.count === 1) {
        rankTier = fetched;
        medalLabel = ` · ${rankMedalName(fetched)}`;
      } else {
        const current = await prisma.user.findUnique({
          where: { id: user.id },
          select: { rankTier: true },
        });
        rankTier = current?.rankTier ?? null;
        medalLabel = rankTier == null ? "" : ` · ${rankMedalName(rankTier)}`;
      }
    }
  }

  // Hard MMR ceiling (the soft limit doesn't block) + "new full players only
  // during SIGNUPS" (standins stay open through PLAYOFFS; COMPLETE freezes
  // every signup). Rules live in registrationGate — judged on the RAW claim plus
  // the medal (never the clamped value: the clamp snaps down to a floor
  // under the ceiling, so gating post-clamp would admit any overstated lie).
  const gateError = registrationGate({
    season,
    type,
    mmr,
    rankTier,
    hasExisting: !!existing,
    existingType: (existing?.type as RegistrationType | undefined) ?? null,
    // The medal half of the ceiling is judged only at ADMISSION — an already
    // ACTIVE registrant keeps editing (the admin's rank sync is warn-only, so
    // a medal it merely flagged must not brick their form). existingStatus is
    // what tells the gate which of the two this submit is.
    existingStatus: existing?.status ?? null,
  });
  if (gateError) return { error: gateError };

  // Draft-night lock: while the auction is LIVE or PAUSED, an existing signup
  // can't change anything the engine is actively selling from. Three doors,
  // each with its own failure mode:
  //  * TYPE: a flip yanks the player out of the pool — nastiest as the player
  //    ON THE BLOCK flipping to standin, which rendered a headless lot that
  //    still charged the team. resolveExpiredNomination voids a non-PLAYER
  //    lot as the write-time backstop; the refusal belongs here, where the
  //    player can read it. (The mirror — STANDIN→PLAYER injecting into a
  //    running pool — is already refused by registrationGate + promoteGate.)
  //  * REVIVAL: a WITHDRAWN player resubmitting sets status ACTIVE below, so
  //    they'd inject themselves into the live pool between lots. The /me UI
  //    disables that tile, but a replayed POST never reads the UI.
  //  * MMR: getDraftState re-reads Registration.mmr on every ~1.2s poll — it
  //    feeds the pool's MMR sort, the nominated panel, and
  //    resolveStalledNomination's top-MMR auto-pick — and the admin's
  //    Edit-MMR forms are deliberately hidden once the draft starts, so a
  //    mid-auction rewrite had no counter. FREEZE the number instead of
  //    refusing the submit (role/hero/note edits are still useful to the
  //    captains bidding), and say so in the toast — never a silent rewrite.
  let lockedMmrNote = "";
  if (existing) {
    const wantsTypeFlip = type !== existing.type;
    // WITHDRAWN only, NOT `!== ACTIVE`: a REMOVED player must fall through to
    // the write-time `{ not: REMOVED }` claim below, whose refusal says the
    // true thing ("an admin removed your signup — message them"). Catching
    // them here instead told a moderated user that rejoining "reopens once
    // the draft finishes" — a promise the claim will never keep.
    const wantsRevival =
      existing.status === REGISTRATION_STATUS.WITHDRAWN &&
      type === REGISTRATION_TYPE.PLAYER;
    // PLAYER rows only: everything the freeze protects (the pool's MMR sort,
    // the nominated panel, resolveStalledNomination's top-MMR auto-pick)
    // filters type PLAYER, so a standin's MMR feeds nothing the auction sells
    // from — and standins REGISTER during draft night, typos included; their
    // corrections must stay live (the admin standin MMR form is un-gated for
    // the same reason).
    const wantsMmrChange =
      existing.type === REGISTRATION_TYPE.PLAYER && mmr !== existing.mmr;
    if (wantsTypeFlip || wantsRevival || wantsMmrChange) {
      if (
        draftSnapshot?.status === DRAFT_STATUS.IN_PROGRESS ||
        draftSnapshot?.status === DRAFT_STATUS.PAUSED
      ) {
        if (wantsTypeFlip) {
          return {
            error:
              "The draft is running — switching between player and standin reopens once it finishes",
          };
        }
        if (wantsRevival) {
          return {
            error:
              "The draft is running — rejoining the player pool reopens once it finishes",
          };
        }
        mmr = existing.mmr;
        lockedMmrNote = ` · MMR is locked while the draft runs — kept ${existing.mmr}`;
      }
    }
  }

  // Medal check: a claim outside the medal's plausible window (blank
  // included) snaps to the window's floor — the conservative estimate. No
  // medal on file = the typed value stands. An UNCHANGED resubmit is never
  // re-clamped: the stored number is already league-approved (clamped at its
  // own save, or set by an admin override — the escape hatch for stale
  // medals, which editing your roles must not silently destroy).
  const untouched = !!existing && mmr === existing.mmr;
  const check = untouched
    ? { mmr, adjusted: false, range: null }
    : clampMmrToRank(mmr, rankTier);

  // A rostered player can't flip themselves to STANDIN: their TeamMember row
  // survives the switch, so they'd sit on a roster AND in the standin pool —
  // assignable to cover the very teams they play against.
  if (type === REGISTRATION_TYPE.STANDIN) {
    const rostered = await prisma.teamMember.findUnique({
      where: { seasonId_userId: { seasonId: season.id, userId: user.id } },
    });
    if (rostered) {
      return {
        error:
          "You're on a roster this season — ask an admin to release you before switching to standin",
      };
    }
  }

  // An admin removed this signup. The upsert below sets status ACTIVE
  // unconditionally, so without a check the player just reloaded /me and put
  // themselves straight back in the pool — there was no way to keep anyone out.
  // A self-withdrawal (status WITHDRAWN) stays freely reversible.
  //
  // That check is THIS `where`, and deliberately nothing else: it used to be
  // duplicated as an `if` on the row read at the top of the request, which read
  // as belt-and-braces but was strictly weaker — the upsert's `update` branch
  // still wrote ACTIVE unconditionally, so an admin removing the signup in the
  // gap was silently undone. Keeping the read-time copy would also have made
  // the guard untestable: every test would stop at the `if` and pass just as
  // happily with the WHERE deleted. One enforcement point, at the write.
  // The medal exemption above is a READ-time judgement about a row fetched
  // several round trips back, so re-assert it in the WHERE. When the medal is
  // ineligible we reached this line ONLY via the already-ACTIVE exemption, so
  // the write may touch an ACTIVE row and nothing else: a self-withdrawal
  // landing in the gap would otherwise be revived straight back to ACTIVE,
  // which for this player is a re-ADMISSION the gate refuses. (WITHDRAWN stays
  // freely reversible for everyone the ceiling doesn't exclude — the
  // `{ not: REMOVED }` branch, unchanged.) The predicate keeps the KEY name
  // `status`, so the ratchet's claim id (saveRegistration::status#1) is
  // untouched and its protecting test still kills the mutant.
  const medalIneligible = medalProvesIneligible(rankTier);
  const statusClaim = medalIneligible
    ? REGISTRATION_STATUS.ACTIVE
    : { not: REGISTRATION_STATUS.REMOVED };
  // A type change or a return from WITHDRAWN is a new season commitment. Keep
  // confirmations through ordinary profile edits, but never let a former
  // standin/rejoined player inherit an old "ready" badge.
  const resetDraftConfirmation =
    !!existing &&
    (existing.type !== type || existing.status !== REGISTRATION_STATUS.ACTIVE);
  const registrationData = {
    type,
    mmr: check.mmr,
    wantsCaptain,
    roles,
    favoriteHeroes,
    statement,
    captainNote,
    status: REGISTRATION_STATUS.ACTIVE,
    ...(resetDraftConfirmation ? clearedDraftConfirmation : {}),
  };

  // Seam: a rival may change the signup or start the auction after every
  // read above. The authoritative lifecycle read and the write below share a
  // SERIALIZABLE transaction. In Postgres that makes startDraft's pool read
  // and this pool write conflict instead of both committing; the copied
  // season/draft versions also make the deterministic pre-snapshot ordering
  // fail cleanly on SQLite.
  await raceHook("registration.saveRegistration.beforeWrite");
  let createdNew = false;
  let saved = false;
  for (let attempt = 0; attempt < 2 && !saved; attempt += 1) {
    try {
      createdNew = await prisma.$transaction(
        async (tx) => {
          const [
            currentSeason,
            currentDraft,
            currentRegistration,
            currentUser,
            seat,
          ] = await Promise.all([
            tx.season.findUnique({
              where: { id: season.id },
              select: { isActive: true, status: true, updatedAt: true },
            }),
            tx.draft.findUnique({
              where: { seasonId: season.id },
              select: { status: true, updatedAt: true },
            }),
            tx.registration.findUnique({
              where: {
                seasonId_userId: { seasonId: season.id, userId: user.id },
              },
              select: { id: true, status: true },
            }),
            tx.user.findUnique({
              where: { id: user.id },
              select: { rankTier: true },
            }),
            type === REGISTRATION_TYPE.STANDIN
              ? tx.teamMember.findUnique({
                  where: {
                    seasonId_userId: {
                      seasonId: season.id,
                      userId: user.id,
                    },
                  },
                  select: { id: true },
                })
              : Promise.resolve(null),
          ]);

          const draftPresenceChanged = !!currentDraft !== !!draftSnapshot;
          const draftVersionChanged =
            !draftPresenceChanged &&
            currentDraft != null &&
            draftSnapshot != null &&
            (currentDraft.status !== draftSnapshot.status ||
              currentDraft.updatedAt.getTime() !==
                draftSnapshot.updatedAt.getTime());
          if (
            !currentSeason?.isActive ||
            currentSeason.status !== season.status ||
            currentSeason.updatedAt.getTime() !== season.updatedAt.getTime() ||
            draftPresenceChanged ||
            draftVersionChanged
          ) {
            throw new RegistrationLifecycleChangedError();
          }
          if (!currentUser || currentUser.rankTier !== rankTier) {
            throw new RegistrationIdentityChangedError();
          }
          if (seat) throw new RegistrationRosterChangedError();

          // Postgres-only seam: startDraft commits after the snapshot above
          // but before this write. SERIALIZABLE must choose one winner.
          await raceHook("registration.saveRegistration.afterLifecycleGate");

          const revived = await tx.registration.updateMany({
            where: {
              seasonId: season.id,
              userId: user.id,
              status: statusClaim,
            },
            data: registrationData,
          });
          if (revived.count === 1) return false;

          // A row that failed the guarded update is REMOVED, or (for an
          // ineligible medal) no longer ACTIVE. Refuse it in this transaction
          // instead of attempting a create and learning through P2002.
          if (currentRegistration) throw new RegistrationStateChangedError();

          await tx.registration.create({
            data: {
              seasonId: season.id,
              userId: user.id,
              ...registrationData,
            },
          });
          return true;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      saved = true;
    } catch (error) {
      if (error instanceof RegistrationLifecycleChangedError) {
        return {
          error:
            "The season or draft changed while you submitted — reload and review your signup before trying again.",
        };
      }
      if (error instanceof RegistrationIdentityChangedError) {
        return {
          error:
            "Your verified Dota details changed while you submitted — reload before trying again.",
        };
      }
      if (error instanceof RegistrationRosterChangedError) {
        return {
          error:
            "You've just joined a roster — ask an admin to release you before switching to standin.",
        };
      }
      if (error instanceof RegistrationStateChangedError) {
        return {
          error: medalIneligible
            ? "Your signup isn't active any more, and your medal is above the league's MMR ceiling — an admin has to put you back in the pool."
            : existing
              ? "An admin removed your signup for this season — message them if you think that's a mistake."
              : "That signup changed while you submitted — reload before trying again.",
        };
      }
      const code = (error as { code?: string }).code;
      if ((code === "P2002" || code === "P2034") && attempt === 0) continue;
      if (code === "P2002" || code === "P2034") {
        return {
          error:
            "That signup, season, or draft changed while you submitted — reload before trying again.",
        };
      }
      throw error;
    }
  }
  if (!saved) {
    return {
      error:
        "That signup, season, or draft changed while you submitted — reload before trying again.",
    };
  }

  // Announce brand-new full-player signups (not updates or standins) with a
  // countdown to the draft threshold.
  if (createdNew && type === REGISTRATION_TYPE.PLAYER) {
    const playerCount = await prisma.registration.count({
      where: { seasonId: season.id, status: "ACTIVE", type: "PLAYER" },
    });
    await sendDiscordMessage(
      signupMessage(
        user.name,
        playerCount,
        season.minTeams * season.teamSize,
        season.draftAt?.getTime() ?? null,
      ),
    );
  }

  // Tell the player what the medal check did to their number — a silent
  // rewrite of a form value they typed would read as a bug.
  let mmrNote = "";
  if (check.adjusted && check.range) {
    const medal = rankMedalName(rankTier);
    const range = formatMmrRange(check.range);
    mmrNote =
      mmr === 0
        ? ` · MMR estimated at ${check.mmr} from your ${medal} medal`
        : check.mmr === 0
          ? ` · MMR left unknown — ${mmr} doesn't fit your ${medal} medal (${range}); captains will judge by the medal`
          : ` · MMR set to ${check.mmr} — your ${medal} medal puts you in the ${range} range`;
  }

  refresh();
  return {
    message:
      (existing
        ? "Signup updated"
        : (type === REGISTRATION_TYPE.STANDIN
            ? "Registered as a standin"
            : "You're signed up!") +
          // The adjustment note already names the medal — don't say it twice.
          (mmrNote ? "" : medalLabel)) +
      mmrNote +
      lockedMmrNote,
  };
}

/**
 * Withdraw from the active season. Rostered players and captains must be
 * released/replaced by an admin first — withdrawing them leaves their
 * TeamMember row in place and orphans the roster (mirrors the standin guard
 * in saveRegistration). Guard shared with the admin flow via withdrawGateError.
 */
export async function leaveLeague(
  _prev: ActionResult,
  _fd: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { error: "Sign in required" };
  }
  const season = await getActiveSeason();
  if (!season) return { error: "No active season" };
  const seasonClosed = registrationSeasonClosedError(season.status);
  if (seasonClosed) return { error: seasonClosed };

  const reg = await prisma.registration.findUnique({
    where: { seasonId_userId: { seasonId: season.id, userId: user.id } },
  });
  if (!reg) return { error: "You're not signed up for this season." };

  const [member, captainTeam, draft, pendingAssignments] = await Promise.all([
    prisma.teamMember.findUnique({
      where: { seasonId_userId: { seasonId: season.id, userId: user.id } },
    }),
    prisma.team.findFirst({
      where: { seasonId: season.id, captainId: user.id },
    }),
    prisma.draft.findUnique({
      where: { seasonId: season.id },
      select: { status: true, nominatedUserId: true },
    }),
    // Standin cover they still owe. Withdrawing over the top of it leaves the
    // covered team looking staffed on match night by someone who has left.
    prisma.standinAssignment.count({
      where: pendingCoverWhere(user.id, season.id),
    }),
  ]);
  const onTheBlock =
    !!draft &&
    (draft.status === DRAFT_STATUS.IN_PROGRESS ||
      draft.status === DRAFT_STATUS.PAUSED) &&
    draft.nominatedUserId === user.id;

  const gateError = withdrawGateError({
    status: reg.status,
    isOnTheBlock: onTheBlock,
    isCaptain: !!captainTeam,
    isRostered: !!member,
    pendingAssignments,
    // This is the player's own Withdraw button — speak to them, and only
    // prescribe actions they can actually take.
    audience: "self",
  });
  if (gateError) return { error: gateError };

  // Seam: an admin REMOVING this signup in the gap between the gate's reads and
  // the write below. Everything above ran on rows read several statements ago,
  // and this is the one rival whose result must NOT be overwritten — see the
  // claim's own note.
  await raceHook("registration.leaveLeague.beforeWithdraw");

  // SERIALIZABLE, not a plain write: the cover count above and the status write
  // here are a write-skew pair with assignStandinGuarded, which reads this
  // registration and writes a StandinAssignment. Under read-committed a captain
  // arranging cover in that window and this withdrawal both commit, leaving a
  // WITHDRAWN standin holding live cover — the exact state the new guard exists
  // to prevent. Re-counting INSIDE the transaction puts the assignments in this
  // transaction's read set so Postgres can spot the cycle (P2034).
  try {
    await prisma.$transaction(
      async (tx) => {
        const [live, currentDraft, currentSeason] = await Promise.all([
          tx.standinAssignment.count({
            where: pendingCoverWhere(user.id, season.id),
          }),
          tx.draft.findUnique({
            where: { seasonId: season.id },
            select: { status: true, nominatedUserId: true },
          }),
          tx.season.findUnique({
            where: { id: season.id },
            select: { isActive: true, status: true },
          }),
        ]);
        if (!currentSeason?.isActive) throw new Error("SEASON_CHANGED");
        if (registrationSeasonClosedError(currentSeason.status)) {
          throw new Error("SEASON_CLOSED");
        }
        if (live > 0) throw new Error("COVER_APPEARED");
        if (
          currentDraft &&
          (currentDraft.status === DRAFT_STATUS.IN_PROGRESS ||
            currentDraft.status === DRAFT_STATUS.PAUSED) &&
          currentDraft.nominatedUserId === user.id
        ) {
          throw new Error("ON_BLOCK");
        }
        // The "you're on a roster — get released first" half of the gate was
        // judged on reads taken outside this transaction, so a draft sale or a
        // free-agent signing landing in the gap let a ROSTERED player withdraw:
        // their seat stays filled by a WITHDRAWN registration, which the
        // capacity math and the standin pool both then misread. Re-checked in
        // here so it is both re-asserted and in this transaction's read set.
        const seat = await tx.teamMember.findUnique({
          where: { seasonId_userId: { seasonId: season.id, userId: user.id } },
          select: { isCaptain: true },
        });
        if (seat)
          throw new Error(seat.isCaptain ? "IS_CAPTAIN" : "IS_ROSTERED");
        // `status: "ACTIVE"` is the whole reason this is an updateMany. The
        // gate above judged a row read before several more round trips, and an
        // admin REMOVAL landing in that gap must survive: without the
        // predicate this writes WITHDRAWN straight over REMOVED, which is the
        // one signup state the player can't clear themselves — they would
        // simply re-register and be back in the pool. Zero rows means we lost
        // that race; THROW rather than return, so the transaction rolls back
        // and the caller can't be told they withdrew when nothing moved.
        const withdrawn = await tx.registration.updateMany({
          where: { seasonId: season.id, userId: user.id, status: "ACTIVE" },
          data: {
            status: "WITHDRAWN",
            ...clearedDraftConfirmation,
          },
        });
        if (withdrawn.count === 0) throw new Error("NOT_ACTIVE");
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (e) {
    if ((e as Error).message === "COVER_APPEARED")
      return {
        error:
          "You've just been assigned to stand in for an unplayed match — that has to be removed first.",
      };
    if ((e as Error).message === "ON_BLOCK")
      return {
        error:
          "You're on the auction block right now — wait for the lot to settle before withdrawing.",
      };
    if ((e as Error).message === "IS_CAPTAIN")
      return {
        error:
          "You're a captain this season — an admin has to hand the team over before you can leave.",
      };
    if ((e as Error).message === "IS_ROSTERED")
      return {
        error:
          "You've just been drafted or signed to a team — ask an admin to release you first.",
      };
    if ((e as Error).message === "NOT_ACTIVE")
      return {
        error:
          "Your signup isn't active any more — reload to see where it stands.",
      };
    if ((e as Error).message === "SEASON_CHANGED")
      return {
        error: "The active season changed — reload before withdrawing.",
      };
    if ((e as Error).message === "SEASON_CLOSED")
      return {
        error: "This season is complete — its signup history is now read-only.",
      };
    if ((e as { code?: string }).code === "P2034")
      return { error: "Your signup just changed — reload and try again." };
    throw e;
  }
  refresh();
  return { message: "Withdrawn from this season" };
}

/** Use the current user's Steam-verified Dota account and fetch their medal. */
export async function updateDotaAccount(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { error: "Sign in required" };
  }
  const raw = str(formData, "dotaAccountId").trim();
  const linkedBefore = await prisma.user.findUnique({
    where: { id: user.id },
    select: { dotaAccountId: true },
  });
  if (!linkedBefore) return { error: "Sign in required" };
  const verifiedAccountId = steamIdToAccountId(user.steamId);

  let accountId: number | null;
  let expectedOverride: number | null;
  if (!raw) {
    accountId = verifiedAccountId;
    expectedOverride = null;
  } else {
    const parsed = parseAccountId(raw);
    if (!parsed) {
      return {
        error: "Enter an account id, SteamID64, or Dotabuff/OpenDota URL",
      };
    }
    // A pasted public profile proves only that the account exists; it proves
    // nothing about who controls it. Steam OpenID is the ownership proof, and
    // the 32-bit Dota id is deterministic from that authenticated SteamID64.
    // Accept that verified id (stored as NULL so every consumer derives it),
    // or an unchanged legacy override solely for backward-compatible refresh.
    // A legacy value can be cleared, but cannot be changed to another
    // unverified account through this self-service action.
    const unchangedLegacyOverride =
      linkedBefore.dotaAccountId != null &&
      parsed === linkedBefore.dotaAccountId &&
      parsed !== verifiedAccountId;
    if (parsed !== verifiedAccountId && !unchangedLegacyOverride) {
      return {
        error:
          "That Dota account does not match the Steam account you signed in with. Sign out and use the Steam account that owns it.",
      };
    }
    accountId = parsed;
    expectedOverride = unchangedLegacyOverride ? parsed : null;
  }

  const previousEffectiveId =
    linkedBefore.dotaAccountId ?? steamIdToAccountId(user.steamId);
  const accountChanged = previousEffectiveId !== accountId;
  try {
    // Claim the account transition against the override we actually read. If
    // another tab committed first, this action stands down rather than
    // silently replacing it. Metadata is cleared only when the EFFECTIVE
    // account changes: a failed OpenDota fetch must preserve valid data for an
    // unchanged link, but must never leave the old account's medal/scouting
    // attached to a new one.
    // Seam: this user's other tab replaces the override after our read but
    // before the CAS; the stale submit must preserve that newer link's data.
    await raceHook("registration.updateDotaAccount.beforeLinkClaim");
    const linked = await prisma.user.updateMany({
      where: { id: user.id, dotaAccountId: linkedBefore.dotaAccountId },
      data: {
        dotaAccountId: expectedOverride,
        ...(accountChanged
          ? {
              rankTier: null,
              fhUnavailable: null,
              pubStats: null,
              pubStatsAt: null,
            }
          : {}),
      },
    });
    if (linked.count === 0) {
      return {
        error:
          "Your Dota account changed in another tab — reload to see the current link.",
      };
    }
  } catch (e) {
    // A legacy explicit override remains unique. Map an unexpected collision
    // to actionable feedback instead of a 500; newly submitted values never
    // reach this point unless Steam proves ownership.
    if ((e as { code?: string }).code === "P2002") {
      return {
        error:
          "That legacy Dota account is already linked elsewhere. Use the Steam account that owns it.",
      };
    }
    throw e;
  }

  let medal = "";
  if (accountId) {
    // The scouting snapshot rides the same moment (in parallel — independent
    // OpenDota calls). Same non-destructive rule as the medal below: a failed
    // fetch leaves the stored snapshot alone; the player can hit Refresh.
    const [result, pubResult] = await Promise.all([
      fetchRankTier(accountId),
      fetchPubStats(accountId),
    ]);
    if (pubResult.ok) {
      // WHERE re-asserts the override this snapshot was fetched under — a
      // second submit racing this one must not land the old account's data.
      await prisma.user.updateMany({
        where: { id: user.id, dotaAccountId: expectedOverride },
        data: {
          pubStats: JSON.stringify(pubResult.stats),
          pubStatsAt: new Date(),
        },
      });
    }
    if (result.ok) {
      // OpenDota answered — trust it for the (possibly new) account,
      // INCLUDING the null fhUnavailable case: the flag described the OLD
      // account, so on an account change "OpenDota didn't say" must reset to
      // unknown, or a once-private player keeps the danger banner forever on
      // a fresh public account.
      await prisma.user.updateMany({
        where: { id: user.id, dotaAccountId: expectedOverride },
        data: {
          rankTier: result.rankTier,
          fhUnavailable: result.fhUnavailable,
        },
      });
      medal = result.rankTier ? ` · ${rankMedalName(result.rankTier)}` : "";
    } else {
      // Couldn't reach OpenDota — leave the stored medal alone rather than
      // wiping it; they can retry with "Refresh medal".
      medal = " · couldn't fetch medal (try Refresh)";
    }
    const current = await prisma.user.findUnique({
      where: { id: user.id },
      select: { dotaAccountId: true },
    });
    if (current?.dotaAccountId !== expectedOverride) {
      refresh();
      return {
        error:
          "Your Dota account changed in another tab — reload to see the current link.",
      };
    }
  } else {
    // No derivable account — clear any stale medal (and the private-data
    // flag + scouting snapshot, which belonged to the unlinked account).
    // A second account-link submit can land after the transition above but
    // before this cleanup. Keep the seam immediately beside the guarded write
    // so the old account's cleanup can never wipe the newer account's data.
    await raceHook("registration.updateDotaAccount.beforeClearMetadata");
    const cleared = await prisma.user.updateMany({
      where: { id: user.id, dotaAccountId: expectedOverride },
      data: {
        rankTier: null,
        fhUnavailable: null,
        pubStats: null,
        pubStatsAt: null,
      },
    });
    if (cleared.count === 0) {
      refresh();
      return {
        error:
          "Your Dota account changed in another tab — reload to see the current link.",
      };
    }
  }

  refresh();
  return {
    message:
      (expectedOverride == null
        ? raw
          ? "Steam account verified"
          : "Cleared — using Steam"
        : "Legacy account refreshed") + medal,
  };
}

/** Re-fetch the current user's ranked medal from OpenDota. */
export async function refreshRank(
  _prev: ActionResult,
  _fd: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { error: "Sign in required" };
  }
  const dbUser = await prisma.user.findUnique({ where: { id: user.id } });
  if (!dbUser) return { error: "Sign in required" };
  const accountId = dbUser?.dotaAccountId ?? steamIdToAccountId(user.steamId);
  if (!accountId) return { error: "Link your account first" };

  // The scouting snapshot refreshes on the same click (independent calls, in
  // parallel; a failed pub fetch never blocks the medal or vice versa).
  const [result, pubResult] = await Promise.all([
    fetchRankTier(accountId),
    fetchPubStats(accountId),
  ]);
  if (pubResult.ok) {
    // WHERE re-asserts the account the snapshot describes (the repo rule) —
    // an account relink committing mid-fetch must not inherit these figures.
    await prisma.user.updateMany({
      where: { id: user.id, dotaAccountId: dbUser.dotaAccountId },
      data: {
        pubStats: JSON.stringify(pubResult.stats),
        pubStatsAt: new Date(),
      },
    });
  }
  if (result.ok) {
    await prisma.user.updateMany({
      where: { id: user.id, dotaAccountId: dbUser.dotaAccountId },
      data: {
        rankTier: result.rankTier,
        ...(result.fhUnavailable !== null
          ? { fhUnavailable: result.fhUnavailable }
          : {}),
      },
    });
  }
  const current = await prisma.user.findUnique({
    where: { id: user.id },
    select: { dotaAccountId: true },
  });
  if (current?.dotaAccountId !== dbUser.dotaAccountId) {
    refresh();
    return {
      error:
        "Your Dota account changed in another tab — reload before refreshing it.",
    };
  }
  if (!result.ok) {
    // Don't wipe a stored medal because OpenDota was momentarily unreachable —
    // and if the pub half DID answer, say what actually happened rather than
    // claiming nothing changed (the admin-panel honesty rule).
    if (pubResult.ok) {
      refresh();
      return {
        message:
          "Scouting stats refreshed · couldn't fetch your medal (rate limited?) — try again in a moment",
      };
    }
    return {
      error: "Couldn't reach OpenDota (rate limited?) — try again in a moment",
    };
  }
  refresh();
  return {
    message: result.rankTier
      ? `Medal: ${rankMedalName(result.rankTier)}`
      : "No medal found — is your match data public?",
  };
}

/** Re-fetch the current user's Steam persona name + avatar. */
export async function refreshSteamProfile(
  _prev: ActionResult,
  _fd: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { error: "Sign in required" };
  }
  const profiles = await fetchSteamProfiles([user.steamId]);
  const p = profiles.get(user.steamId);
  if (!p) {
    return {
      error:
        "Couldn't refresh from Steam right now. Check that your Steam profile is public and try again; ask an admin if it keeps failing.",
    };
  }
  await prisma.user.update({
    where: { id: user.id },
    data: { name: p.name, avatar: p.avatar, profileUrl: p.profileUrl },
  });
  refresh();
  return { message: "Profile refreshed from Steam" };
}

/** Save (or clear) the player's Discord handle — how captains reach them. */
export async function updateDiscordName(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { error: "Sign in required" };
  }
  const normalized = normalizeDiscordName(str(formData, "discordName"));
  if (normalized === null) {
    return {
      error:
        "That doesn't look like a Discord username — copy the handle from your Discord profile (e.g. dendi_official)",
    };
  }
  // A linked account's handle is Discord's word, not the player's. The guard
  // must be ATOMIC with the write (updateMany conditioned on discordId null,
  // the Match.autoSyncedAt claim pattern) — a separate read-then-write would
  // let a concurrent OAuth callback land between the check and the update,
  // leaving a hand-typed handle wearing the verified ✓.
  const updated = await prisma.user.updateMany({
    where: { id: user.id, discordId: null },
    data: { discordName: normalized },
  });
  if (updated.count === 0) {
    return {
      error:
        "Your Discord is linked, so the handle comes from Discord — unlink it first to edit manually.",
    };
  }
  refresh();
  return {
    message: normalized
      ? `Discord handle saved — ${normalized}`
      : "Discord handle cleared",
  };
}

/** Remove the OAuth-verified Discord link (and the handle it set). */
export async function unlinkDiscord(
  _prev: ActionResult,
  _formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { error: "Sign in required" };
  }
  // Read the snowflake BEFORE clearing it — unlinking has to take the ping
  // role with it. Leaving the role behind is the worst outcome this action
  // has: the player still gets pinged, and the toggle that turns it off is
  // rendered only for LINKED players, so they've just thrown away their own
  // off switch. That is precisely the un-opt-out-able ping the whole ping
  // design refuses to ship.
  const before = await prisma.user.findUnique({
    where: { id: user.id },
    select: { discordId: true },
  });
  await unlinkDiscordAccount(prisma, user.id);

  let roleLeft = false;
  if (before?.discordId) {
    const cfg = await getRoleConfig();
    if (cfg) {
      // Best-effort, and it must not fail the unlink — the site half is done
      // either way. "not-a-member" means they'd already left the server, which
      // is a success for our purposes: nothing left to strip.
      const res = await setPingRole(before.discordId, false, cfg);
      roleLeft = res === "failed" || res === "forbidden";
    }
  }

  refresh();
  return {
    message:
      "Discord unlinked — your handle was removed from the site" +
      (roleLeft
        ? ". We couldn't remove your inhouse ping role in Discord — take it off there, or the pings continue."
        : ""),
  };
}

/**
 * Self-serve opt-in to the inhouse ping role.
 *
 * Discord has no native self-assignable-role toggle — Onboarding is the only
 * built-in mechanism, and it's a whole server configuration to obtain one
 * checkbox. So the site grants the role itself, which it can do honestly
 * because `discordId` is OAuth-PROVEN: we are acting on an account the player
 * demonstrated they own, never on a typed handle.
 */
export async function setInhousePingOptIn(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { error: "Sign in required" };
  }
  const on = str(formData, "on") === "1";

  const me = await prisma.user.findUnique({
    where: { id: user.id },
    select: { discordId: true },
  });
  if (!me?.discordId) {
    return { error: "Link your Discord account first — then you can opt in." };
  }
  const cfg = await getRoleConfig();
  if (!cfg) {
    return { error: "Inhouse pings aren't set up yet — ask an admin." };
  }

  const res = await setPingRole(me.discordId, on, cfg);
  revalidatePath("/me");
  if (res === "ok") {
    return {
      message: on
        ? "You'll get pinged when an inhouse queue is filling up."
        : "Pings off — you won't be notified about inhouse queues.",
    };
  }
  if (res === "not-a-member") {
    return {
      error:
        "You're not in the league's Discord server — join it first, then try again.",
    };
  }
  if (res === "forbidden") {
    // The bot's role sits below the ping role, so Discord refuses. Retrying
    // never fixes this; say what's actually wrong so an admin can move it.
    return {
      error:
        "Discord wouldn't let us change that role. An admin needs to move the bot's role above the ping role.",
    };
  }
  return { error: "Discord didn't respond — try again in a moment." };
}
