import { randomUUID } from "node:crypto";
import {
  bumpInhouseRoomGeneration,
  inhouseRoomGeneration,
  wakeInhouseRoomWaiters,
} from "./inhouse-room-wait";
import { prisma } from "./prisma";
import { SETTING_KEYS } from "./settings";

// The inhouse room's version token (a leaf: nothing here imports the inhouse
// engine). Each server instance keeps one copy of the room's shared rows
// (inhouse-room-cache.ts), labelled with the token it read BEFORE reading
// them; a poll serves that copy only while the token it has just read is
// still the same. So every writer the room shows must publish:
//
// RULE P: after the commit, before any Discord or OpenDota call and before
// the response, call publishInhouseRoomChange(). Never inside a transaction:
// a hot Setting row inside the Serializable joinQueue and formOneLobby would
// add P2034 aborts, and formOneLobby takes those as "someone else formed", so
// formation would silently slip.
//
// A missing row means "uncached": every poll builds fresh and stores nothing.
// Polls only read it, so an anonymous poll never writes.
//
// The version is also the long-poll's change signal: a state request that
// sends back the version of the reply its client shows is held until it
// moves (inhouse-room-wait.ts), and a publish wakes the requests held in this
// process once its statement has run.

/**
 * This process's publish count (the cache's local fence), bumped by every
 * publish before its statement runs. A snapshot load that started before a
 * local publish is never stored, and a stored one stops serving at once,
 * without waiting for the database. Process-wide, on globalThis
 * (inhouse-room-wait.ts): a server action's publish fences the route
 * handlers' snapshot too.
 */
export function inhouseRoomLocalGeneration(): number {
  return inhouseRoomGeneration();
}

/** No version row yet: what a reply carries and a client sends back. */
const NO_ROOM_VERSION = "none";

/**
 * The version as the client sees it: the opaque token a state reply carries
 * as `roomVersion` and a held request sends back as `since`. A missing row
 * (nothing ever published) has a token too, so a fresh database long-polls
 * and its first publish moves it.
 */
export function inhouseRoomVersionToken(version: string | null): string {
  return version ?? NO_ROOM_VERSION;
}

/** The room's current version, or null when nothing ever published. */
export async function readInhouseRoomVersion(): Promise<string | null> {
  const row = await prisma.setting.findUnique({
    where: { key: SETTING_KEYS.INHOUSE_ROOM_VERSION },
    select: { value: true },
  });
  return row?.value ?? null;
}

/**
 * Tell every instance the room changed: a new random version. One portable
 * statement (claimThrottle's INSERT … ON CONFLICT shape), so a missing row is
 * created and a present one replaced on SQLite and Postgres alike. Retries
 * once, logs, and never throws: the change it announces has already
 * committed, and a lost publish is bounded by the snapshot's max age. After
 * the statement, landed or not, the requests held in this process re-check
 * the version (the commit happened either way).
 */
export async function publishInhouseRoomChange(): Promise<void> {
  bumpInhouseRoomGeneration();
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await prisma.$executeRaw`
          INSERT INTO "Setting" ("key", "value")
          VALUES (${SETTING_KEYS.INHOUSE_ROOM_VERSION}, ${randomUUID()})
          ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value"
        `;
        return;
      } catch (error) {
        if (attempt === 1) {
          const code = (error as { code?: unknown } | null)?.code;
          console.error(
            `[inhouse-room-version] publish failed (${
              typeof code === "string" ? code : "unknown"
            })`,
          );
        }
      }
    }
  } finally {
    wakeInhouseRoomWaiters();
  }
}
