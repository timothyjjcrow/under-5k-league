"use server";

// A captain edits their own team's name and logo from the team page (admins
// get the same form there, plus the override on /admin). Thin auth/toast
// wrapper around team-identity-service, which holds the integration-tested
// guards; the activity log and the Discord announcement stay here so a webhook
// failure never touches the write.

import { revalidatePath, updateTag } from "next/cache";
import { AUTOMATION_GATE_TAG } from "@/lib/automation-gate-constants";
import { requireUser } from "@/lib/auth";
import { str } from "@/lib/form";
import {
  saveTeamIdentity,
  type SavedTeamIdentity,
} from "@/lib/team-identity-service";
import {
  TEAM_IDENTITY_PING_THROTTLE_SECONDS,
  TEAM_RENAME_THROTTLE_SECONDS,
  TEAM_RENAME_THROTTLED_ERROR,
  expectedTeamIdentity,
  normalizeTeamName,
  teamIdentityNotPostedMessage,
  teamIdentityPingKey,
  teamIdentityPostIsThrottled,
  teamIdentitySummary,
  teamRenameThrottleKey,
} from "@/lib/team-identity";
import { logAdminAction } from "@/lib/admin-log";
import { claimThrottle } from "@/lib/settings";
import { prisma } from "@/lib/prisma";
import { sendDiscordMessage, teamIdentityChangedMessage } from "@/lib/discord";
import type { ActionResult } from "@/lib/action-result";

// Team names are embedded in the cached all-games scans (record matchups), so
// a rename expires the shared "games" tag as well as the page shell.
function refreshGames() {
  updateTag("games");
  updateTag(AUTOMATION_GATE_TAG);
  revalidatePath("/", "layout");
}

/**
 * Post a change to the league channel. Every rename posts. A captain's
 * logo-only change is throttled per team (an admin's never is); false means
 * this one was held back. A captain's rename still stamps the throttle, so a
 * run of logo tweaks right after it stays quiet. A throttle-store failure
 * posts anyway: the save is committed, and missing the announcement is worse
 * than an occasional extra one.
 */
async function announceIdentityChange(saved: SavedTeamIdentity): Promise<boolean> {
  if (saved.byCaptain) {
    let claimed = true;
    try {
      claimed = await claimThrottle(
        teamIdentityPingKey(saved.teamId),
        TEAM_IDENTITY_PING_THROTTLE_SECONDS,
        Date.now(),
      );
    } catch {
      claimed = true;
    }
    if (!claimed && teamIdentityPostIsThrottled(saved)) return false;
  }
  await sendDiscordMessage(teamIdentityChangedMessage(saved));
  return true;
}

/**
 * Take the per-team rename window before a captain's rename is saved. Only
 * for the team's own captain submitting a different name: a logo-only edit
 * keeps its own path, and anyone else is refused by saveTeamIdentity, so they
 * must not hold the captain's window even for a moment. Null means no claim
 * was needed; the returned row is what to delete to give the window back.
 */
async function claimCaptainRename(
  teamId: string,
  userId: string,
  rawName: string,
): Promise<{ key: string; value: string } | "throttled" | null> {
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    select: { name: true, captainId: true },
  });
  const name = normalizeTeamName(rawName);
  if (!team || team.captainId !== userId || !name || name === team.name) {
    return null;
  }
  const nowMs = Date.now();
  const key = teamRenameThrottleKey(teamId);
  if (!(await claimThrottle(key, TEAM_RENAME_THROTTLE_SECONDS, nowMs))) {
    return "throttled";
  }
  return { key, value: new Date(nowMs).toISOString() };
}

export async function editTeamIdentity(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { error: "Sign in required" };
  }
  const isAdmin = user.role === "ADMIN";
  const teamId = str(formData, "teamId");
  const name = str(formData, "name");
  const renameClaim = isAdmin ? null : await claimCaptainRename(teamId, user.id, name);
  if (renameClaim === "throttled") return { error: TEAM_RENAME_THROTTLED_ERROR };
  let saved: Awaited<ReturnType<typeof saveTeamIdentity>> | undefined;
  try {
    saved = await saveTeamIdentity({
      editor: { userId: user.id, isAdmin },
      teamId,
      name,
      logoUrl: formData.has("logoUrl") ? str(formData, "logoUrl") : undefined,
      expected: expectedTeamIdentity(formData),
    });
  } finally {
    // Give the window back when no rename happened (refused, threw, or the
    // name came out the same), but only the claim this request wrote.
    if (renameClaim && !(saved?.ok && saved.nameChanged)) {
      await prisma.setting.deleteMany({ where: renameClaim });
    }
  }
  if (!saved.ok) return { error: saved.error };
  let posted = true;
  if (saved.nameChanged || saved.logoChanged) {
    // Captain edits land in the same activity log as admin ones, under the
    // same key, so "who renamed this team?" has one answer. Every change is
    // logged, even a logo change the Discord throttle holds back.
    await logAdminAction({
      action: "renameTeam",
      summary: teamIdentitySummary(saved),
      seasonId: saved.seasonId,
      actor: { id: user.id, name: user.name },
    });
    posted = await announceIdentityChange(saved);
  }
  refreshGames();
  return {
    message: posted
      ? `Saved ${saved.name}`
      : teamIdentityNotPostedMessage(saved.name),
  };
}
