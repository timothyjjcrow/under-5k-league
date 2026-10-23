import { randomUUID } from "node:crypto";
import { prisma } from "./prisma";
import type { RoomWait } from "./room-wait";

// A live room's version token, for any room (the inhouse room's binding is
// inhouse-room-version.ts, the draft room's draft-room-version.ts). Each
// server instance keeps one copy of the room's shared rows (createRoomCache,
// inhouse-room-cache.ts), labelled with the token it read BEFORE reading
// them; a poll serves that copy only while the token it has just read is
// still the same. So every writer the room shows must publish, after its
// commit and never inside a transaction (each binding states its rule P).
//
// A missing row means "uncached": every poll builds fresh and stores nothing.
// Polls only read it, so an anonymous poll never writes.
//
// The version is also the long-poll's change signal: a state request that
// sends back the version of the reply its client shows is held until it
// moves (room-wait.ts), and a publish wakes the requests held in this
// process once its statement has run.

/** No version row yet: what a reply carries and a client sends back. */
const NO_ROOM_VERSION = "none";

export type RoomVersion = {
  /**
   * This process's publish count (the cache's local fence), bumped by every
   * publish before its statement runs. A snapshot load that started before a
   * local publish is never stored, and a stored one stops serving at once,
   * without waiting for the database. Process-wide, on globalThis
   * (room-wait.ts): a server action's publish fences the route handlers'
   * snapshot too.
   */
  localGeneration(): number;
  /**
   * The long-poll's fence: it moves when a publish in this process starts
   * its statement or finishes it. The route reads it before the version it
   * compares with a request's `since`, so a publish racing that read
   * re-checks the hold instead of waiting for the watch.
   */
  holdMark(): number;
  /**
   * The version as the client sees it: the opaque token a state reply
   * carries as `roomVersion` and a held request sends back as `since`. A
   * missing row (nothing ever published) has a token too, so a fresh
   * database long-polls and its first publish moves it.
   */
  token(version: string | null): string;
  /** The room's current version, or null when nothing ever published. */
  read(): Promise<string | null>;
  /** read(), as the client sees it (token): a held request's reader. */
  readToken(): Promise<string>;
  /**
   * Tell every instance the room changed: a new random version. One portable
   * statement (claimThrottle's INSERT … ON CONFLICT shape), so a missing row
   * is created and a present one replaced on SQLite and Postgres alike.
   * Retries once, logs, and never throws: the change it announces has
   * already committed, and a lost publish is bounded by the snapshot's max
   * age. After the statement, landed or not, the requests held in this
   * process re-check the version (the commit happened either way).
   */
  publish(): Promise<void>;
};

/**
 * The version of the room stored in the Setting row `settingKey()`, waking
 * the holds in `wait`. `logTag` names the room in the one log line a failed
 * publish writes (its error code only, never the database's message). The
 * key is read at each use, inside publish's own try, so nothing at import
 * reads it and a publish never throws, whatever the settings module holds.
 */
export function createRoomVersion(o: {
  settingKey: () => string;
  logTag: string;
  /** The room's registry (its binding's exports, room-wait.ts). */
  wait: Pick<RoomWait, "generation" | "bumpGeneration" | "publishMark" | "wakeWaiters">;
}): RoomVersion {
  const token = (version: string | null) => version ?? NO_ROOM_VERSION;
  async function read(): Promise<string | null> {
    const row = await prisma.setting.findUnique({
      where: { key: o.settingKey() },
      select: { value: true },
    });
    return row?.value ?? null;
  }
  return {
    localGeneration: () => o.wait.generation(),
    holdMark: () => o.wait.publishMark(),
    token,
    read,
    readToken: async () => token(await read()),
    async publish() {
      o.wait.bumpGeneration();
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            await prisma.$executeRaw`
              INSERT INTO "Setting" ("key", "value")
              VALUES (${o.settingKey()}, ${randomUUID()})
              ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value"
            `;
            return;
          } catch (error) {
            if (attempt === 1) {
              const code = (error as { code?: unknown } | null)?.code;
              console.error(
                `[${o.logTag}] publish failed (${
                  typeof code === "string" ? code : "unknown"
                })`,
              );
            }
          }
        }
      } finally {
        o.wait.wakeWaiters();
      }
    },
  };
}
