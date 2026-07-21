"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { getActiveSeason } from "@/lib/season";
import {
  REGISTRATION_TYPE,
  type RegistrationType,
} from "@/lib/constants";
import { registrationGate, withdrawGateError } from "@/lib/registration";
import { normalizeDiscordName } from "@/lib/discord-name";
import { unlinkDiscordAccount } from "@/lib/discord-link-service";
import { bool, clampInt, str } from "@/lib/form";
import {
  parseAccountId,
  steamIdToAccountId,
  fetchPlayerRankTier,
  fetchRankTier,
} from "@/lib/dota";
import { rankMedalName } from "@/lib/rank";
import { serializeRoles } from "@/lib/roles";
import { fetchSteamProfiles } from "@/lib/steam";
import { sendDiscordMessage, signupMessage } from "@/lib/discord";
import type { ActionResult } from "@/lib/action-result";

function refresh() {
  revalidatePath("/", "layout");
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

  const type =
    str(formData, "type") === REGISTRATION_TYPE.STANDIN
      ? REGISTRATION_TYPE.STANDIN
      : REGISTRATION_TYPE.PLAYER;
  const mmr = clampInt(formData, "mmr", 0, 0, 12000);
  const wantsCaptain = bool(formData, "wantsCaptain");
  const roles = serializeRoles(formData.getAll("roles").map(String));
  const favoriteHeroes = str(formData, "favoriteHeroes").slice(0, 200);
  const statement = str(formData, "statement").slice(0, 1000);
  const captainNote = str(formData, "captainNote").slice(0, 1000);

  const existing = await prisma.registration.findUnique({
    where: { seasonId_userId: { seasonId: season.id, userId: user.id } },
  });

  // Hard MMR ceiling (the soft limit doesn't block) + "new full players only
  // during SIGNUPS" (standins any time; existing signups can always be
  // updated). Rules live in registrationGate.
  const gateError = registrationGate({
    season,
    type,
    mmr,
    hasExisting: !!existing,
    existingType: (existing?.type as RegistrationType | undefined) ?? null,
  });
  if (gateError) return { error: gateError };

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

  await prisma.registration.upsert({
    where: { seasonId_userId: { seasonId: season.id, userId: user.id } },
    create: {
      seasonId: season.id,
      userId: user.id,
      type,
      mmr,
      wantsCaptain,
      roles,
      favoriteHeroes,
      statement,
      captainNote,
      status: "ACTIVE",
    },
    update: {
      type,
      mmr,
      wantsCaptain,
      roles,
      favoriteHeroes,
      statement,
      captainNote,
      status: "ACTIVE",
    },
  });

  // Announce brand-new full-player signups (not updates or standins) with a
  // countdown to the draft threshold.
  if (!existing && type === REGISTRATION_TYPE.PLAYER) {
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

  // On a brand-new signup, pull the player's ranked medal from Dota (via
  // OpenDota — the free public API over Valve's match data that Dotabuff-style
  // sites read too; Dotabuff itself has no public API) so captains see a rank
  // without the player manually linking their account first. Best-effort:
  // fetchPlayerRankTier never throws and returns null when the profile is
  // private or unavailable. Only fetch when they don't already have a medal,
  // so we never overwrite a good value with a null and never re-hit the API on
  // signup edits.
  let medalLabel = "";
  if (!existing) {
    const dbUser = await prisma.user.findUnique({
      where: { id: user.id },
      select: { dotaAccountId: true, rankTier: true },
    });
    if (dbUser && dbUser.rankTier == null) {
      const accountId =
        dbUser.dotaAccountId ?? steamIdToAccountId(user.steamId);
      const rankTier = accountId ? await fetchPlayerRankTier(accountId) : null;
      if (rankTier != null) {
        await prisma.user.update({
          where: { id: user.id },
          data: { rankTier },
        });
        medalLabel = ` · ${rankMedalName(rankTier)}`;
      }
    }
  }

  refresh();
  return {
    message: existing
      ? "Signup updated"
      : (type === REGISTRATION_TYPE.STANDIN
          ? "Registered as a standin"
          : "You're signed up!") + medalLabel,
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

  const reg = await prisma.registration.findUnique({
    where: { seasonId_userId: { seasonId: season.id, userId: user.id } },
  });
  if (!reg) return { error: "You're not signed up for this season." };

  const [member, captainTeam] = await Promise.all([
    prisma.teamMember.findUnique({
      where: { seasonId_userId: { seasonId: season.id, userId: user.id } },
    }),
    prisma.team.findFirst({
      where: { seasonId: season.id, captainId: user.id },
    }),
  ]);

  const gateError = withdrawGateError({
    status: reg.status,
    isCaptain: !!captainTeam,
    isRostered: !!member,
  });
  if (gateError) return { error: gateError };

  await prisma.registration.updateMany({
    where: { seasonId: season.id, userId: user.id },
    data: { status: "WITHDRAWN" },
  });
  refresh();
  return { message: "Withdrawn from this season" };
}

/** Link the current user's Dota/Dotabuff account and fetch their ranked medal. */
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

  let accountId: number | null;
  if (!raw) {
    accountId = steamIdToAccountId(user.steamId);
    await prisma.user.update({
      where: { id: user.id },
      data: { dotaAccountId: null },
    });
  } else {
    const parsed = parseAccountId(raw);
    if (!parsed) {
      return {
        error: "Enter an account id, SteamID64, or Dotabuff/OpenDota URL",
      };
    }
    accountId = parsed;
    await prisma.user.update({
      where: { id: user.id },
      data: { dotaAccountId: parsed },
    });
  }

  let medal = "";
  if (accountId) {
    const result = await fetchRankTier(accountId);
    if (result.ok) {
      // OpenDota answered — trust it for the (possibly new) account,
      // INCLUDING the null fhUnavailable case: the flag described the OLD
      // account, so on an account change "OpenDota didn't say" must reset to
      // unknown, or a once-private player keeps the danger banner forever on
      // a fresh public account.
      await prisma.user.update({
        where: { id: user.id },
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
  } else {
    // No derivable account — clear any stale medal (and the private-data
    // flag, which belonged to the unlinked account).
    await prisma.user.update({
      where: { id: user.id },
      data: { rankTier: null, fhUnavailable: null },
    });
  }

  refresh();
  return { message: (raw ? "Account linked" : "Cleared — using Steam") + medal };
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
  const accountId = dbUser?.dotaAccountId ?? steamIdToAccountId(user.steamId);
  if (!accountId) return { error: "Link your account first" };

  const result = await fetchRankTier(accountId);
  if (!result.ok) {
    // Don't wipe a stored medal because OpenDota was momentarily unreachable.
    return {
      error: "Couldn't reach OpenDota (rate limited?) — try again in a moment",
    };
  }
  await prisma.user.update({
    where: { id: user.id },
    data: {
      rankTier: result.rankTier,
      ...(result.fhUnavailable !== null
        ? { fhUnavailable: result.fhUnavailable }
        : {}),
    },
  });
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
      error: "Couldn't reach Steam (is STEAM_API_KEY set and your profile public?)",
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
  await unlinkDiscordAccount(prisma, user.id);
  refresh();
  return { message: "Discord unlinked — your handle was removed from the site" };
}
