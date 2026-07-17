import { prisma } from "./prisma";

// Tiny key-value store (the `Setting` model) for league-global config that an
// admin edits at runtime — anything per-season belongs on `Season` instead.

export const SETTING_KEYS = {
  DISCORD_WEBHOOK_URL: "discordWebhookUrl",
  // Epoch ms of the last "queue is almost full" Discord ping (spam throttle).
  INHOUSE_QUEUE_PING_AT: "inhouseQueuePingAt",
} as const;

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
