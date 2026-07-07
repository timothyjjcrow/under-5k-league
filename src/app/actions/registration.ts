"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { getActiveSeason } from "@/lib/season";
import { REGISTRATION_TYPE } from "@/lib/constants";
import { registrationGate } from "@/lib/registration";
import { bool, clampInt, str } from "@/lib/form";
import {
  parseAccountId,
  steamIdToAccountId,
  fetchPlayerRankTier,
} from "@/lib/dota";
import { rankMedalName } from "@/lib/rank";
import { serializeRoles } from "@/lib/roles";
import { fetchSteamProfiles } from "@/lib/steam";
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

  // MMR cap + "new full players only during SIGNUPS" (standins any time;
  // existing signups can always be updated). Rules live in registrationGate.
  const gateError = registrationGate({
    season,
    type,
    mmr,
    hasExisting: !!existing,
  });
  if (gateError) return { error: gateError };

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

  refresh();
  return {
    message: existing
      ? "Signup updated"
      : type === REGISTRATION_TYPE.STANDIN
        ? "Registered as a standin"
        : "You're signed up!",
  };
}

/** Withdraw from the active season. */
export async function leaveLeague() {
  const user = await requireUser();
  const season = await getActiveSeason();
  if (!season) return;
  await prisma.registration.updateMany({
    where: { seasonId: season.id, userId: user.id },
    data: { status: "WITHDRAWN" },
  });
  refresh();
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

  const rankTier = accountId ? await fetchPlayerRankTier(accountId) : null;
  await prisma.user.update({ where: { id: user.id }, data: { rankTier } });

  refresh();
  const medal = rankTier ? ` · ${rankMedalName(rankTier)}` : "";
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

  const rankTier = await fetchPlayerRankTier(accountId);
  await prisma.user.update({ where: { id: user.id }, data: { rankTier } });
  refresh();
  return {
    message: rankTier
      ? `Medal: ${rankMedalName(rankTier)}`
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
