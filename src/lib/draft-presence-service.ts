import type { Prisma } from "@prisma/client";
import { DRAFT_PRESENCE, captainInRoom } from "./draft-presence";
import { claimThrottle, draftPresenceKey } from "./settings";

/**
 * Record that a captain has the draft room open, from their room poll. The
 * room polls every second or so; claimThrottle writes only once the stored
 * time is older than DRAFT_PRESENCE.WRITE_SECONDS, so the rest cost a single
 * indexed read. Best-effort: presence is a label on a team card, and a failed
 * write must never cost a captain their poll. The log is a fixed event code
 * (never the database error, which can carry connection details). True when
 * this call wrote a new last-seen time.
 */
export async function recordCaptainPresence(
  seasonId: string,
  userId: string,
  nowMs = Date.now(),
): Promise<boolean> {
  try {
    return await claimThrottle(
      draftPresenceKey(seasonId, userId),
      DRAFT_PRESENCE.WRITE_SECONDS,
      nowMs,
    );
  } catch {
    console.error("[draft-presence] write unavailable");
    return false;
  }
}

/**
 * The stored last-seen time (ISO) of each of these captains who has ever
 * polled the draft room, by captain id. The draft room's shared rows keep
 * these, so each reply judges "in the room" on its own clock
 * (captainInRoom).
 */
export async function readCaptainLastSeen(
  db: Pick<Prisma.TransactionClient, "setting">,
  seasonId: string,
  captainIds: readonly string[],
): Promise<Record<string, string>> {
  if (captainIds.length === 0) return {};
  const byKey = new Map(
    captainIds.map((id) => [draftPresenceKey(seasonId, id), id]),
  );
  const rows = await db.setting.findMany({
    where: { key: { in: [...byKey.keys()] } },
    select: { key: true, value: true },
  });
  const lastSeen: Record<string, string> = {};
  for (const row of rows) {
    const id = byKey.get(row.key);
    if (id) lastSeen[id] = row.value;
  }
  return lastSeen;
}

/** Which of these captains have polled the draft room recently enough. */
export async function readCaptainPresence(
  db: Pick<Prisma.TransactionClient, "setting">,
  seasonId: string,
  captainIds: readonly string[],
  nowMs = Date.now(),
): Promise<Set<string>> {
  const lastSeen = await readCaptainLastSeen(db, seasonId, captainIds);
  return new Set(
    captainIds.filter((id) => captainInRoom(lastSeen[id], nowMs)),
  );
}
