"use server";

// Admin actions for the Discord integration: the league, inhouse board and
// inhouse alert webhooks, the inhouse ping role, test posts, the pinned
// inhouse queue board, and discarding waiting league posts.

import { requireAdmin } from "@/lib/auth";
import { str } from "@/lib/form";
import {
  sendDiscordMessage,
  testMessage,
  webhookIdOf,
  getInhouseWebhookUrl,
  getInhouseAlertWebhookUrl,
  sendInhouseDiscordMessage,
} from "@/lib/discord";
import {
  discardWaitingLeagueAnnouncements,
  resumeLeagueAnnouncements,
} from "@/lib/league-announcement-outbox";
import { logAdminAction } from "@/lib/admin-log";
import {
  createInhouseBoard,
  removeInhouseBoard,
} from "@/lib/inhouse-board-service";
import { getSetting, setSetting, SETTING_KEYS } from "@/lib/settings";
import type { ActionResult } from "@/lib/action-result";
import { normalizeDiscordWebhookUrl } from "@/lib/discord-webhook.mjs";
import { refresh } from "./admin-shared";

/** Save the Discord webhook used for league announcements. */
export async function setDiscordWebhook(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const value = str(formData, "discordWebhookUrl").trim();
  // The field renders EMPTY on purpose — the saved URL is a secret we never
  // send back to the browser. So a blank submit must be a no-op, not a wipe;
  // turning announcements off is the explicit clearDiscordWebhook action.
  if (!value) {
    return {
      message:
        "No change — paste a new URL to replace it, or press \u201cRemove webhook\u201d to turn announcements off.",
    };
  }
  const webhookUrl = normalizeDiscordWebhookUrl(value);
  if (!webhookUrl) {
    return {
      error:
        "That doesn't look like a Discord webhook URL (https://discord.com/api/webhooks/…)",
    };
  }
  // Moving to a webhook for a DIFFERENT channel strands the queue board: we
  // could no longer edit it, and it would sit in the old channel forever
  // showing a frozen count. Tear it down while the old credential is still the
  // configured one, i.e. before the save below. A regenerated token for the
  // SAME webhook keeps its id, so that case correctly leaves the board alone.
  const prevId = webhookIdOf(await getInhouseWebhookUrl());
  const nextId = webhookIdOf(
    (await getSetting(SETTING_KEYS.INHOUSE_WEBHOOK_URL)) ||
      process.env.DISCORD_INHOUSE_WEBHOOK_URL ||
      webhookUrl,
  );
  // Only tears the board down when the league webhook IS the effective inhouse
  // one (i.e. no separate inhouse webhook is set) — otherwise the board lives
  // in its own channel and this change doesn't touch it.
  const movedChannel = !!prevId && !!nextId && prevId !== nextId;
  // force: the old credential is about to stop being the configured one, so
  // "keep the row and retry later" isn't an option — after the save we could
  // never edit or delete that message again.
  const torndown = movedChannel
    ? await removeInhouseBoard({ force: true })
    : null;

  await setSetting(SETTING_KEYS.DISCORD_WEBHOOK_URL, webhookUrl);
  // Posts held back by the old webhook (deleted, token changed) try the new
  // one on the next run instead of waiting out their slowest retry.
  const waiting = await resumeLeagueAnnouncements().catch(() => 0);
  await logAdminAction({
    action: "setDiscordWebhook",
    summary: `Replaced the league announcement webhook${movedChannel ? (torndown?.orphaned ? "; the old queue board may be orphaned" : "; the old queue board was removed") : ""}`,
  });
  refresh();
  const backlog =
    waiting > 0
      ? ` ${waiting} waiting post${waiting === 1 ? "" : "s"} will go out over the next few minutes, oldest first — discard them on this card if they're out of date.`
      : "";
  return {
    message: !movedChannel
      ? `Webhook saved — announcements are on.${backlog}`
      : torndown?.orphaned
        ? `Webhook saved — announcements are on.${backlog} The old queue board is still in the old channel and can no longer be updated; delete that message by hand, then post a new board below.`
        : `Webhook saved — announcements are on.${backlog} The queue board was removed from the old channel; post a new one below.`,
  };
}

/**
 * Discard the league posts still waiting for Discord — the stale backlog a
 * webhook outage leaves behind. Only posts queued up to the newest one the
 * admin was shown (`upTo`) are discarded, so nothing queued after the page
 * loaded is dropped unseen.
 */
export async function discardWaitingDiscordPosts(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const upToMs = Number(str(formData, "upTo"));
  if (!Number.isSafeInteger(upToMs) || upToMs <= 0) {
    return { error: "Reload the page and try again." };
  }
  const discarded = await discardWaitingLeagueAnnouncements(new Date(upToMs));
  if (discarded > 0) {
    await logAdminAction({
      action: "discardWaitingDiscordPosts",
      summary: `Discarded ${discarded} league Discord post(s) that were waiting to be sent`,
    });
  }
  refresh();
  return {
    message:
      discarded > 0
        ? `Discarded ${discarded} waiting post${discarded === 1 ? "" : "s"} — ${discarded === 1 ? "it" : "they"} won't be posted.`
        : "Nothing was waiting — the posts may have just gone out.",
  };
}

/** Turn off Discord announcements by removing the stored webhook. */
export async function clearDiscordWebhook(
  _prev: ActionResult,
  _fd: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  // Delete the board FIRST — it needs the credential we're about to remove,
  // and a pinned message frozen at a stale count is the worst thing this
  // feature can leave behind.
  // Same rule: only our problem if the league webhook is what the board rides.
  const separate =
    !!(await getSetting(SETTING_KEYS.INHOUSE_WEBHOOK_URL)) ||
    !!process.env.DISCORD_INHOUSE_WEBHOOK_URL;
  const torndown = separate
    ? { orphaned: false }
    : await removeInhouseBoard({ force: true });
  await setSetting(SETTING_KEYS.DISCORD_WEBHOOK_URL, "");
  await logAdminAction({
    action: "clearDiscordWebhook",
    summary: `Removed the league announcement webhook${torndown.orphaned ? "; the old queue board may be orphaned" : ""}`,
  });
  refresh();
  return {
    message: torndown.orphaned
      ? "Webhook removed — announcements are off. Discord didn't confirm deleting the queue board, so delete that message by hand."
      : "Webhook removed — announcements are off",
  };
}

/**
 * Save a SEPARATE webhook for the inhouse channel. A Discord webhook is bound
 * to the channel it was created in, so this is the only way to keep the queue
 * board, lobby pings and inhouse results out of the league-announcement
 * channel. Unset = inhouse keeps riding the league webhook.
 */
export async function setInhouseWebhook(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const value = str(formData, "inhouseWebhookUrl").trim();
  // Same rule as the league field: it renders empty because the saved URL is a
  // secret we never send back, so a blank submit is a no-op, never a wipe.
  if (!value) {
    return {
      message:
        "No change — paste a new URL to replace it, or press \u201cUse the league channel instead\u201d to stop posting inhouse to its own channel.",
    };
  }
  const webhookUrl = normalizeDiscordWebhookUrl(value);
  if (!webhookUrl) {
    return {
      error:
        "That doesn't look like a Discord webhook URL (https://discord.com/api/webhooks/…)",
    };
  }

  // The board lives in whatever channel the inhouse webhook points at, so a
  // change of channel strands it. Tear it down while the OLD credential is
  // still the configured one.
  const prevId = webhookIdOf(await getInhouseWebhookUrl());
  const moved = !!prevId && prevId !== webhookIdOf(webhookUrl);
  const torndown = moved ? await removeInhouseBoard({ force: true }) : null;

  await setSetting(SETTING_KEYS.INHOUSE_WEBHOOK_URL, webhookUrl);
  await logAdminAction({
    action: "setInhouseWebhook",
    summary: `Replaced the inhouse board webhook${moved ? (torndown?.orphaned ? "; the old board may be orphaned" : "; the old board was removed") : ""}`,
  });
  refresh();
  return {
    message: !moved
      ? "Inhouse webhook saved — queue board, lobby pings and inhouse results now post there."
      : torndown?.orphaned
        ? "Inhouse webhook saved. The old queue board couldn't be deleted — remove that message by hand, then post a new board below."
        : "Inhouse webhook saved — the old queue board was removed; post a new one below.",
  };
}

/** Send inhouse traffic back to the league webhook. */
export async function clearInhouseWebhook(
  _prev: ActionResult,
  _fd: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  // Clearing this MOVES the inhouse channel back to the league webhook, so the
  // board would be stranded in the old channel. Take it down first.
  const torndown = await removeInhouseBoard({ force: true });
  await setSetting(SETTING_KEYS.INHOUSE_WEBHOOK_URL, "");
  await logAdminAction({
    action: "clearInhouseWebhook",
    summary: `Removed the separate inhouse webhook${torndown.orphaned ? "; the old board may be orphaned" : ""}`,
  });
  refresh();
  return {
    message: torndown.orphaned
      ? "Inhouse webhook removed — inhouse posts to the league channel again. Delete the old queue board message by hand."
      : "Inhouse webhook removed — inhouse posts to the league channel again.",
  };
}

/**
 * Save a SEPARATE webhook for inhouse ALERTS — the queue ping, "match found"
 * and results — so the queue board can have a channel to itself.
 *
 * The board is read at a glance from the bottom of its channel; one alert
 * posted under it pushes it out of view, which defeats the whole design.
 */
export async function setInhouseAlertWebhook(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const value = str(formData, "inhouseAlertWebhookUrl").trim();
  if (!value) {
    return {
      message:
        "No change — paste a new URL to replace it, or press \u201cSend alerts to the board channel instead\u201d to stop using a separate alerts channel.",
    };
  }
  const webhookUrl = normalizeDiscordWebhookUrl(value);
  if (!webhookUrl) {
    return {
      error:
        "That doesn't look like a Discord webhook URL (https://discord.com/api/webhooks/…)",
    };
  }
  await setSetting(SETTING_KEYS.INHOUSE_ALERT_WEBHOOK_URL, webhookUrl);
  await logAdminAction({
    action: "setInhouseAlertWebhook",
    summary: "Replaced the separate inhouse alert webhook",
  });
  refresh();
  return {
    message:
      "Saved — queue pings, match-found and results now post there. The board channel keeps only the board.",
  };
}

/** Send inhouse alerts back to the board's channel. */
export async function clearInhouseAlertWebhook(
  _prev: ActionResult,
  _fd: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  await setSetting(SETTING_KEYS.INHOUSE_ALERT_WEBHOOK_URL, "");
  await logAdminAction({
    action: "clearInhouseAlertWebhook",
    summary:
      "Removed the separate inhouse alert webhook; alerts use the board channel",
  });
  refresh();
  return { message: "Alerts will post in the board's channel again" };
}

/**
 * Save the Discord ROLE the two interrupting inhouse messages may ping.
 *
 * This is the only thing in the whole integration that can reach a phone —
 * board edits notify nobody by design, and every other send suppresses
 * mentions. The role must be SELF-ASSIGNABLE in Discord (Server Settings →
 * Onboarding, or a Channels & Roles picker): a ping people can't opt out of
 * gets the channel muted, which is permanently worse than silence.
 */
export async function setInhousePingRole(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  // Accept a raw snowflake or a pasted <@&id> mention — both are what an admin
  // actually has to hand (right-click → Copy Role ID, or typing \@role).
  const raw = str(formData, "inhousePingRoleId").trim();
  const id = raw.replace(/^<@&(\d+)>$/, "$1");
  if (!id) {
    await setSetting(SETTING_KEYS.INHOUSE_PING_ROLE_ID, "");
    await logAdminAction({
      action: "setInhousePingRole",
      summary: "Disabled the inhouse Discord role ping",
    });
    refresh();
    return { message: "Role ping off — inhouse messages won't notify anyone" };
  }
  if (!/^\d{15,25}$/.test(id)) {
    return {
      error:
        "That doesn't look like a role id. In Discord: Server Settings → Roles → right-click the role → Copy Role ID (needs Developer Mode).",
    };
  }
  await setSetting(SETTING_KEYS.INHOUSE_PING_ROLE_ID, id);
  await logAdminAction({
    action: "setInhousePingRole",
    summary: `Set the inhouse Discord ping role to ${id}`,
  });
  refresh();
  return {
    message:
      "Role saved — the queue-filling and match-found messages will ping it. Make sure members can self-assign it.",
  };
}

/** Post a test message to whichever channel inhouse currently uses. */
export async function testInhouseWebhook(
  _prev: ActionResult,
  _fd: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  // Gate on the ALERT resolver — the one the send below actually rides
  // (alerts fall back alert → board → league). Gating on the board resolver
  // refused alert-webhook-only leagues a test their send would deliver.
  if (!(await getInhouseAlertWebhookUrl())) {
    return { error: "Set a webhook first" };
  }
  const ok = await sendInhouseDiscordMessage(testMessage());
  return ok
    ? {
        message:
          "Test message sent — check the channel your inhouse alerts post to",
      }
    : { error: "Discord rejected the message — double-check the URL" };
}

/**
 * Post the live inhouse queue board — ONE message the site rewrites in place
 * as players join and leave, so the channel gets a live count without a new
 * message per join.
 */
export async function postInhouseBoard(
  _prev: ActionResult,
  _fd: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const res = await createInhouseBoard();
  refresh();
  return res.ok
    ? {
        message:
          "Board posted — right-click it in Discord and Pin it so it never scrolls away.",
      }
    : { error: res.error ?? "Could not post the board" };
}

/** Delete the queue board message and stop updating it. */
export async function deleteInhouseBoard(
  _prev: ActionResult,
  _fd: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const res = await removeInhouseBoard();
  refresh();
  if (!res.ok) return { error: res.error ?? "Could not remove the board" };
  // Never claim a message was deleted when it wasn't — an orphaned board is
  // pinned forever at a frozen count and nothing here can touch it again.
  return {
    message: res.orphaned
      ? "Cleared the board record — Discord may still have an untracked message. Check the channel and delete it by hand before posting again."
      : "Queue board removed",
  };
}

/** Post a test message so the admin can confirm the webhook works. */
export async function testDiscordWebhook(
  _prev: ActionResult,
  _fd: FormData,
): Promise<ActionResult> {
  try {
    await requireAdmin();
  } catch {
    return { error: "Not authorized" };
  }
  const configured =
    (await getSetting(SETTING_KEYS.DISCORD_WEBHOOK_URL)) ||
    process.env.DISCORD_WEBHOOK_URL;
  if (!configured) return { error: "Set a webhook URL first" };
  // A webhook check must report this exact network attempt. Ordinary league
  // announcements are durably queued, where `true` means accepted by the
  // outbox rather than necessarily accepted by Discord already.
  const ok = await sendDiscordMessage(testMessage(), undefined, {
    durable: false,
  });
  if (!ok) {
    return { error: "Discord rejected the message — double-check the URL" };
  }
  // The webhook works, so posts paused behind an earlier refusal try again
  // on the next run.
  if ((await resumeLeagueAnnouncements().catch(() => 0)) > 0) refresh();
  return { message: "Test message sent — check your Discord" };
}
