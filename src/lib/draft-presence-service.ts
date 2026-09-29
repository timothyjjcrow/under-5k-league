import type { Prisma } from "@prisma/client";
import { DRAFT_PRESENCE, captainInRoom } from "./draft-presence";
import { claimThrottle, draftPresenceKey } from "./settings";

/**
 * Record that a captain has the draft room open, from their room poll. The
 * room polls every second or so; claimThrottle writes only once the stored
 * time is older than DRAFT_PRESENCE.WRITE_SECONDS, so the rest cost a single
 * indexed read. Best-effort: presence is a label on a team card, and a failed
 * write must never cost a captain their poll. The log is a fixed event code
 * (never the database error, which can carry connection details).
 */
export async function recordCaptainPresence(
  seasonId: string,
  userId: string,
  nowMs = Date.now(),
): Promise<void> {
  try {
    await claimThrottle(
      draftPresenceKey(seasonId, userId),
      DRAFT_PRESENCE.WRITE_SECONDS,
      nowMs,
    );
  } catch {
    console.error("[draft-presence] write unavailable");
  }
}

/** Which of these captains have polled the draft room recently enough. */
export async function readCaptainPresence(
  db: Pick<Prisma.TransactionClient, "setting">,
  seasonId: string,
  captainIds: readonly string[],
  nowMs = Date.now(),
): Promise<Set<string>> {
  if (captainIds.length === 0) return new Set();
  const byKey = new Map(
    captainIds.map((id) => [draftPresenceKey(seasonId, id), id]),
  );
  const rows = await db.setting.findMany({
    where: { key: { in: [...byKey.keys()] } },
    select: { key: true, value: true },
  });
  const here = new Set<string>();
  for (const row of rows) {
    const id = byKey.get(row.key);
    if (id && captainInRoom(row.value, nowMs)) here.add(id);
  }
  return here;
}
