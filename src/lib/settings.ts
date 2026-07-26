import { prisma } from "./prisma";

// Tiny key-value store (the `Setting` model) for league-global config that an
// admin edits at runtime — anything per-season belongs on `Season` instead.

export const SETTING_KEYS = {
  DISCORD_WEBHOOK_URL: "discordWebhookUrl",
  // OPTIONAL second webhook, for the inhouse channel only. A Discord webhook
  // is locked to the channel it was created in, so one webhook means one
  // channel for all 27 announcement types — and inhouse traffic (a queue
  // board that repaints all evening, lobby pings, results) belongs in the
  // inhouse channel, not wherever league signups and match results go.
  // Unset = fall back to DISCORD_WEBHOOK_URL, i.e. previous behaviour.
  INHOUSE_WEBHOOK_URL: "inhouseWebhookUrl",
  // Epoch ms of the last "queue is almost full" Discord ping (spam throttle).
  INHOUSE_QUEUE_PING_AT: "inhouseQueuePingAt",
  // ISO timestamp of the last league-id OpenDota sync (result-sync-service's
  // atomic global throttle for the /leagues/{id}/matches path).
  LEAGUE_AUTO_SYNC_AT: "leagueAutoSyncAt",
  // ISO timestamp of the last roster scan on ANY match (global speed bump so
  // concurrent pollers can't each claim a different match in one burst).
  ROSTER_AUTO_SYNC_AT: "rosterAutoSyncAt",
  // Change cursor: bumped whenever ANY result lands (league game import,
  // manual recordResult, inhouse result). /api/sync returns it so every
  // parked client — not just the one whose ping performed the import — can
  // see the league changed and refresh itself.
  RESULT_CHANGED_AT: "resultChangedAt",
  // ISO timestamp of the last failed-announcement retry sweep (throttle).
  ANNOUNCE_RETRY_AT: "announceRetryAt",
  // The pinned Discord inhouse queue board, as JSON
  // `{webhookId, messageId, digest}`. THE ROW'S EXISTENCE IS THE ON/OFF
  // SWITCH — absent means the feature is off and the sync path returns after
  // one PK read. Never write it from anywhere but inhouse-board-service.
  INHOUSE_BOARD: "inhouseBoard",
  // ISO timestamp of the last board edit (claimThrottle spam floor).
  INHOUSE_BOARD_AT: "inhouseBoardAt",
} as const;

/**
 * Atomic global throttle (Setting-row claim). ISO timestamps compare
 * lexicographically, so the conditional update below is a valid "only if
 * stale" claim: exactly one caller wins per interval, across every serverless
 * instance, with no lock and no cron. Returns true to the winner only.
 *
 * Lives here rather than beside its first caller because three unrelated
 * subsystems now need it (result sync, the announcement retry sweep, the
 * inhouse board) and settings.ts is the one module they can all import
 * without a cycle.
 */
export async function claimThrottle(
  key: string,
  intervalSeconds: number,
  nowMs: number,
): Promise<boolean> {
  const value = new Date(nowMs).toISOString();
  const staleBefore = new Date(nowMs - intervalSeconds * 1000).toISOString();

  // Try the STALE-CLAIM update first. The row exists on every call but the
  // first, so leading with `create` meant a caught-and-ignored P2002 on
  // essentially every /api/sync hit — and the Prisma client logs at "error"
  // level in production (src/lib/prisma.ts), so each one wrote a stack trace
  // to the server log before our catch ever ran. /api/sync fires on every page
  // view, so that buried real errors under constant expected-path noise.
  const updated = await prisma.setting.updateMany({
    where: { key, value: { lt: staleBefore } },
    data: { value },
  });
  if (updated.count > 0) return true;

  // Zero rows means either "exists but still fresh" (not our claim) or "row
  // isn't there yet" (first ever call — create it, and let a genuine creation
  // race lose on P2002).
  const existing = await prisma.setting.findUnique({ where: { key } });
  if (existing) return false;
  try {
    await prisma.setting.create({ data: { key, value } });
    return true;
  } catch (e) {
    if ((e as { code?: string }).code !== "P2002") throw e;
    return false; // someone else created it in the same instant
  }
}

/**
 * Bump the result change cursor. Called from every path that changes a
 * recorded result; last-write-wins is exactly right for a freshness cursor.
 */
export async function stampResultChange(): Promise<void> {
  await setSetting(SETTING_KEYS.RESULT_CHANGED_AT, new Date().toISOString());
}

export async function getSetting(key: string): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  if (!value) {
    await prisma.setting.deleteMany({ where: { key } });
    return;
  }
  await prisma.setting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}
