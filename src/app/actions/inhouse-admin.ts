"use server";

// Thin auth/parse/toast wrappers for the inhouse admin controls that live
// outside the room's own API: voiding a result (`voidLastResult`), an
// admin's inhouse MMR and medal for a player (`saveInhouseRating`), and
// inhouse bans (`banInhousePlayer`, `liftInhouseBan`, the Discord role). The
// reasoning (the guarded claims, the room publish, the AdminAction record of
// a void, the correction announcement) lives in the services; what belongs
// here is the session, the form, and the toast.
//
// voidInhouseResult exists because the room's void button is gated on
// `state.lastResult`, which is built only for a viewer who PLAYED in the
// completed game and only for 10 minutes after it — so the documented use
// case ("the scan picked up the wrong game", reported by players to an admin
// who wasn't one of the ten, or reported later) had no reachable control
// anywhere. /inhouse/history now renders a per-row Void for admins through
// this action, with the game named in the confirm.

import { revalidatePath, updateTag } from "next/cache";
import { AUTOMATION_GATE_TAG } from "@/lib/automation-gate-constants";
import { logAdminAction } from "@/lib/admin-log";
import { requireAdmin } from "@/lib/auth";
import { str } from "@/lib/form";
import {
  inhouseRatingLogSummary,
  inhouseRatingSavedMessage,
  parseInhouseRatingForm,
} from "@/lib/inhouse-rating";
import { saveInhouseRating } from "@/lib/inhouse-rating-service";
import { voidLastResult } from "@/lib/inhouse-service";
import {
  inhouseBanLiftedMessage,
  inhouseBanLogSummary,
  inhouseBanSavedMessage,
  parseInhouseBanForm,
  type InhouseBanRoleOutcome,
} from "@/lib/inhouse-ban";
import {
  banInhousePlayer,
  giveInhouseBanRole,
  liftInhouseBan,
} from "@/lib/inhouse-ban-service";
import { setSetting, SETTING_KEYS } from "@/lib/settings";
import type { ActionResult } from "@/lib/action-result";
import { adminOrError, refresh } from "./admin-shared";

export async function voidInhouseResult(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  let user;
  try {
    user = await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const lobbyId = str(formData, "lobbyId");
  if (!lobbyId) return { error: "Missing game" };
  const res = await voidLastResult(user, lobbyId);
  if (!res.ok) return { error: res.error };
  updateTag(AUTOMATION_GATE_TAG);
  revalidatePath("/", "layout");
  return {
    message: "Result voided — the ladder recalculates without it",
  };
}

/**
 * Set a player's inhouse MMR and medal from /admin/inhouse-players: any
 * player, signed up for the league or not (Tim, 2026-10-17). The MMR is used
 * by every queue join over their signup's and anything they type; the medal
 * is the site-wide one.
 */
export async function setInhouseRating(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  const parsed = parseInhouseRatingForm(formData);
  if (!parsed.ok) return { error: parsed.error };
  const saved = await saveInhouseRating(parsed.input);
  if (!saved.ok) return { error: saved.error };
  // The medal shows on league pages too.
  refresh();
  await logAdminAction({
    action: "setInhouseRating",
    summary: inhouseRatingLogSummary(saved),
  });
  return { message: inhouseRatingSavedMessage(saved) };
}

/**
 * Ban a player from inhouse games for a length or for good, with a reason
 * players see (Tim, 2026-11-02): no 5v5 or 1v1 queue meanwhile, listed on
 * /inhouse and the Discord board, and the Inhouse Banned role in Discord.
 * The bot's role call goes after the commit and never undoes the ban.
 */
export async function banFromInhouse(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  const parsed = parseInhouseBanForm(formData);
  if (!parsed.ok) return { error: parsed.error };
  const saved = await banInhousePlayer(admin, parsed.input);
  if (!saved.ok) return { error: saved.error };
  let role: InhouseBanRoleOutcome;
  try {
    role = await giveInhouseBanRole(saved.banId, saved.discordId);
  } catch {
    role = "failed";
  }
  // The ban's end and any role to retry are the worker's clock now.
  refresh();
  await logAdminAction({
    action: "banFromInhouse",
    summary: inhouseBanLogSummary({
      name: saved.name,
      endsAt: saved.endsAt,
      reason: parsed.input.reason,
    }),
  });
  return { message: inhouseBanSavedMessage({ ...saved, role }) };
}

/** Lift a running inhouse ban early; the Discord role comes off with it. */
export async function liftBanFromInhouse(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  const lifted = await liftInhouseBan(admin, str(formData, "banId"));
  if (!lifted.ok) return { error: lifted.error };
  refresh();
  await logAdminAction({
    action: "liftBanFromInhouse",
    summary: `Lifted ${lifted.name}'s inhouse ban`,
  });
  return { message: inhouseBanLiftedMessage(lifted.name, lifted.role) };
}

/**
 * Save the Discord role the bot gives a banned player ("Inhouse Banned").
 * Its channel permissions in Discord are what keep them out of the inhouse
 * channels; the site only adds and removes it. Blank turns it off: bans then
 * leave Discord alone.
 */
export async function saveInhouseBanRole(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const admin = await adminOrError();
  if ("error" in admin) return admin;
  // A raw snowflake or a pasted <@&id> mention, as for the ping role.
  const id = str(formData, "inhouseBanRoleId").trim().replace(/^<@&(\d+)>$/, "$1");
  if (id && !/^\d{15,25}$/.test(id)) {
    return {
      error:
        "That doesn't look like a role id. In Discord: Server Settings → Roles → right-click the role → Copy Role ID (needs Developer Mode).",
    };
  }
  await setSetting(SETTING_KEYS.INHOUSE_BAN_ROLE_ID, id);
  await logAdminAction({
    action: "saveInhouseBanRole",
    summary: id
      ? `Set the inhouse ban Discord role to ${id}`
      : "Turned off the inhouse ban Discord role",
  });
  refresh();
  return {
    message: id
      ? "Ban role saved: banned players get it in Discord, and lose it when the ban ends. Bans made before now get it within the hour."
      : "Ban role off: bans leave Discord alone.",
  };
}
