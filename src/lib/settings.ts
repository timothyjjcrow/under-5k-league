import { prisma } from "./prisma";

// Tiny key-value store (the `Setting` model) for league-global config that an
// admin edits at runtime — anything per-season belongs on `Season` instead.

export const SETTING_KEYS = {
  DISCORD_WEBHOOK_URL: "discordWebhookUrl",
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
} as const;

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
