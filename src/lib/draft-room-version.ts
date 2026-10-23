import {
  bumpDraftRoomGeneration,
  draftRoomGeneration,
  draftRoomPublishMark,
  wakeDraftRoomWaiters,
} from "./draft-room-wait";
import { createRoomVersion } from "./room-version";
import { SETTING_KEYS } from "./settings";

// The draft room's version token (a leaf: nothing here imports the draft
// engine). Each server instance keeps one copy of the room's shared rows
// (draft-room-state.ts), labelled with the token it read BEFORE reading
// them; a tick serves that copy only while the token it has just read is
// still the same. So every writer the room shows must publish:
//
// RULE P (draft): after the commit, before any Discord call and before the
// response, call publishDraftRoomChange(). Never inside a transaction: the
// hot Setting row inside the Serializable bid, sale and undo transactions
// would add P2034 aborts to the auction's own writes.
//
// The engine's writers (draft-service.ts) publish their own commits; every
// other writer of the room's rows publishes after its commit
// (draft-room-publish.test.ts pins the sites). Writers of display-only
// fields (a refreshed name or avatar) don't, and show within the snapshot's
// max age (DRAFT_ROOM.ROOM_SNAPSHOT_MAX_AGE_MS).
//
// The version is also the long-poll's change signal: a tick that sends back
// the version of the reply its client shows is held until it moves
// (draft-room-wait.ts), and a publish wakes the ticks held in this process
// once its statement has run.

const version = createRoomVersion({
  settingKey: () => SETTING_KEYS.DRAFT_ROOM_VERSION,
  logTag: "draft-room-version",
  // This module instance's view of the registry (draft-room-wait.ts).
  wait: {
    generation: draftRoomGeneration,
    bumpGeneration: bumpDraftRoomGeneration,
    publishMark: draftRoomPublishMark,
    wakeWaiters: wakeDraftRoomWaiters,
  },
});

/** This process's publish count: the room snapshot's local fence. */
export function draftRoomLocalGeneration(): number {
  return version.localGeneration();
}

/**
 * The long-poll's fence: it moves when a publish in this process starts its
 * statement or finishes it. The tick route reads it before the version it
 * compares with a request's `since`.
 */
export function draftRoomHoldMark(): number {
  return version.holdMark();
}

/**
 * The version as the client sees it: the opaque token a tick reply carries
 * as `roomVersion` and a held tick sends back as `since` ("none" before the
 * first publish, so a fresh database long-polls too).
 */
export function draftRoomVersionToken(stored: string | null): string {
  return version.token(stored);
}

/** The room's current version, or null when nothing ever published. */
export async function readDraftRoomVersion(): Promise<string | null> {
  return version.read();
}

/** readDraftRoomVersion() as the client sees it: a held tick's reader. */
export async function readDraftRoomVersionToken(): Promise<string> {
  return version.readToken();
}

/**
 * Tell every instance the draft room changed: a new random version, then a
 * re-check for the ticks held in this process. Never throws: the change it
 * announces has already committed, and a lost publish is bounded by the
 * snapshot's max age.
 */
export async function publishDraftRoomChange(): Promise<void> {
  await version.publish();
}
