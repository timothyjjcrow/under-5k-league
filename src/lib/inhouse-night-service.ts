// Storage and Discord work for the inhouse night (rules: inhouse-night.ts).
//
// The night is one Setting row, written only here and only by
// compare-and-swap on the exact value read: an admin's save names the night
// its page showed (id and revision) and loses to any write since, and the
// Discord event's id is attached by a swap on the exact value the save
// stored. Discord is never called inside a write: the action saves, then
// calls publishInhouseNight, best-effort. The worker posts the start once
// (announceInhouseNightStart, behind a once-only marker).

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { INHOUSE } from "./constants";
import { queuePresentCutoff } from "./inhouse";
import { LEAGUE_CONFIG } from "./league-config";
import { resolveSiteUrl } from "./site-url";
import { raceHook } from "./race-hook";
import { UserFacingError } from "./user-facing-error";
import { SETTING_KEYS, inhouseNightStartKey } from "./settings";
import {
  claimAnnouncementMarker,
  markAnnouncementFailed,
  markAnnouncementSent,
  recordAnnouncementCovered,
  recoverableAnnouncementMarker,
  releaseAnnouncementClaim,
} from "./announcement-marker";
import {
  getInhouseAlertWebhookUrl,
  getInhousePingRoleId,
  inhouseNightCancelledMessage,
  inhouseNightMessage,
  inhouseNightMovedMessage,
  inhouseNightStartMessage,
  sendInhouseDiscordMessage,
} from "./discord";
import { discordMutationsAllowed } from "./discord-mutation-policy";
import {
  createGuildEvent,
  deleteGuildEvent,
  getGuildConfig,
  updateGuildEvent,
} from "./discord-roles";
import {
  INHOUSE_NIGHT_START_POST_WINDOW_MS,
  discordEventUrl,
  inhouseNightChange,
  inhouseNightEvent,
  inhouseNightNote,
  inhouseNightPhase,
  inhouseNightTimeProblem,
  nextInhouseNight,
  parseInhouseNight,
  serializeInhouseNight,
  type InhouseNight,
  type InhouseNightChange,
} from "./inhouse-night";

const KEY = SETTING_KEYS.INHOUSE_NIGHT;

const STALE =
  "The inhouse night changed while this page was open. Reload and try again.";

export type StoredInhouseNight = { raw: string | null; night: InhouseNight | null };

export async function readInhouseNight(): Promise<StoredInhouseNight> {
  const row = await prisma.setting.findUnique({
    where: { key: KEY },
    select: { value: true },
  });
  const raw = row?.value ?? null;
  return { raw, night: parseInhouseNight(raw) };
}

/** The night an admin's page showed: its id and revision, or none at all. */
export type InhouseNightExpectation = { id: string; revision: number } | null;

function shows(night: InhouseNight | null, expected: InhouseNightExpectation): boolean {
  if (!expected) return night === null;
  return night?.id === expected.id && night.revision === expected.revision;
}

/**
 * Replace the stored value only if it is still exactly `expectedRaw` (null:
 * only if there is none). False when another write got there first.
 */
async function swapInhouseNight(
  expectedRaw: string | null,
  nextRaw: string | null,
): Promise<boolean> {
  if (expectedRaw === null) {
    if (nextRaw === null) return true;
    try {
      await prisma.setting.create({ data: { key: KEY, value: nextRaw } });
      return true;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return false;
      }
      throw error;
    }
  }
  if (nextRaw === null) {
    const removed = await prisma.setting.deleteMany({
      where: { key: KEY, value: expectedRaw },
    });
    return removed.count === 1;
  }
  const swapped = await prisma.setting.updateMany({
    where: { key: KEY, value: expectedRaw },
    data: { value: nextRaw },
  });
  return swapped.count === 1;
}

export type InhouseNightSave = {
  night: InhouseNight;
  previous: InhouseNight | null;
  change: InhouseNightChange;
  /** The exact value now stored: the Discord event's attach swaps on it. */
  raw: string;
};

/**
 * Save the admin's night: a new one, a move of the upcoming one, or a new
 * note. Refuses a time in the past or too far out, an over-long note, and a
 * save from a page that showed a different night than the one stored.
 */
export async function saveInhouseNight(input: {
  startsAtMs: number;
  note: string;
  expected: InhouseNightExpectation;
  nowMs?: number;
}): Promise<InhouseNightSave> {
  const nowMs = input.nowMs ?? Date.now();
  const problem = inhouseNightTimeProblem(input.startsAtMs, nowMs);
  if (problem) throw new UserFacingError(problem);
  const noted = inhouseNightNote(input.note);
  if ("error" in noted) throw new UserFacingError(noted.error);
  const wanted = { startsAtMs: input.startsAtMs, note: noted.note };

  const current = await readInhouseNight();
  if (!shows(current.night, input.expected)) throw new UserFacingError(STALE);
  const change = inhouseNightChange(current.night, wanted, nowMs);
  if (change === "unchanged" && current.night && current.raw) {
    return { night: current.night, previous: current.night, change, raw: current.raw };
  }
  const night = nextInhouseNight(current.night, wanted, nowMs, randomUUID);
  const raw = serializeInhouseNight(night);
  // Test seam: a second admin's save lands between the read and the write.
  await raceHook("inhouseNight.save.beforeSwap");
  if (!(await swapInhouseNight(current.raw, raw))) throw new UserFacingError(STALE);
  return { night, previous: current.night, change, raw };
}

/**
 * Take the night down. Returns the night that was cleared (null when nothing
 * was stored), refusing a page that showed a different night.
 */
export async function clearInhouseNight(input: {
  expected: InhouseNightExpectation;
}): Promise<InhouseNight | null> {
  const current = await readInhouseNight();
  if (!shows(current.night, input.expected)) throw new UserFacingError(STALE);
  if (current.raw === null) return null;
  await raceHook("inhouseNight.clear.beforeSwap");
  if (!(await swapInhouseNight(current.raw, null))) throw new UserFacingError(STALE);
  return current.night;
}

/**
 * Store the Discord event's id on the night a save just wrote. False when the
 * night has changed since: the caller then deletes the event it made, and the
 * later save publishes its own.
 */
export async function attachInhouseNightEvent(
  save: Pick<InhouseNightSave, "night" | "raw">,
  eventId: string,
): Promise<boolean> {
  const raw = serializeInhouseNight({ ...save.night, discordEventId: eventId });
  const attached = await prisma.setting.updateMany({
    where: { key: KEY, value: save.raw },
    data: { value: raw },
  });
  return attached.count === 1;
}

export type InhouseNightPublication = {
  /** The channel post: true sent, false failed, null nothing to post. */
  posted: boolean | null;
  event:
    | "created"
    | "updated"
    | "unchanged"
    | "unconfigured"
    | "forbidden"
    | "failed";
};

function eventFields(night: InhouseNight) {
  return inhouseNightEvent(night, resolveSiteUrl(), LEAGUE_CONFIG.name);
}

/** The event's share link, when the bot made one and the guild is known. */
export function inhouseNightEventUrl(night: InhouseNight): string | null {
  const guildId = getGuildConfig()?.guildId;
  return guildId && night.discordEventId
    ? discordEventUrl(guildId, night.discordEventId)
    : null;
}

/**
 * After a save commits: create or update the night's Discord event, then
 * post in the inhouse channel (a new night pings the inhouse role; a move
 * posts without a ping; a new note posts nothing). Best-effort: the caller
 * reports what happened, and nothing here undoes the save.
 */
export async function publishInhouseNight(
  save: InhouseNightSave,
): Promise<InhouseNightPublication> {
  if (save.change === "unchanged") return { posted: null, event: "unchanged" };
  let night = save.night;
  let event: InhouseNightPublication["event"] | null = null;

  if (night.discordEventId) {
    const updated = await updateGuildEvent(night.discordEventId, eventFields(night));
    if (updated.ok) event = "updated";
    else if (updated.reason !== "gone") event = updated.reason;
    // Gone (deleted in Discord): never link it again; make a fresh one below.
    else night = { ...night, discordEventId: null };
  }
  if (event === null) {
    const created = await createGuildEvent(eventFields(night));
    if (!created.ok) {
      event = created.reason === "gone" ? "failed" : created.reason;
    } else if (await attachInhouseNightEvent(save, created.eventId)) {
      night = { ...night, discordEventId: created.eventId };
      event = "created";
    } else {
      // The night changed after this save: its own publish makes its event.
      await deleteGuildEvent(created.eventId);
      event = "failed";
    }
  }

  let posted: boolean | null = null;
  if (save.change === "new") {
    const roleId = await getInhousePingRoleId();
    posted = await sendInhouseDiscordMessage(
      inhouseNightMessage({
        startsAtMs: night.startsAtMs,
        note: night.note,
        roleId,
        eventUrl: inhouseNightEventUrl(night),
      }),
      { roles: roleId ? [roleId] : [] },
    );
  } else if (save.change === "moved") {
    posted = await sendInhouseDiscordMessage(
      inhouseNightMovedMessage({
        startsAtMs: night.startsAtMs,
        eventUrl: inhouseNightEventUrl(night),
      }),
    );
  }
  return { posted, event };
}

/**
 * After a clear commits: an upcoming night's event is deleted and the channel
 * told it's off (no ping). A night already started or over is left to end on
 * its own.
 */
export async function withdrawInhouseNight(
  night: InhouseNight,
  nowMs = Date.now(),
): Promise<{
  posted: boolean | null;
  event: "deleted" | "kept" | "none" | "unconfigured" | "forbidden" | "failed";
}> {
  if (inhouseNightPhase(night, nowMs) !== "upcoming") {
    return { posted: null, event: "kept" };
  }
  const event = night.discordEventId
    ? await deleteGuildEvent(night.discordEventId)
    : "none";
  const posted = await sendInhouseDiscordMessage(
    inhouseNightCancelledMessage({ startsAtMs: night.startsAtMs }),
  );
  return { posted, event: event === "ok" ? "deleted" : event };
}

/**
 * The worker's start post: once per night (and again if it was moved after
 * posting), only in the first half hour after the start, pinging the inhouse
 * role with the queue's count. With nowhere to post (no inhouse or league
 * webhook, or a preview) the marker is recorded as covered, so the worker
 * isn't woken for it again. True when a post went out.
 */
export async function announceInhouseNightStart(nowMs = Date.now()): Promise<boolean> {
  const { night } = await readInhouseNight();
  const due = (candidate: InhouseNight | null, at: number) =>
    !!candidate &&
    at >= candidate.startsAtMs &&
    at < candidate.startsAtMs + INHOUSE_NIGHT_START_POST_WINDOW_MS;
  if (!night || !due(night, nowMs)) return false;

  const key = inhouseNightStartKey(night.id, night.startsAtMs);
  const existing = await prisma.setting.findUnique({
    where: { key },
    select: { value: true },
  });
  if (existing && !recoverableAnnouncementMarker(existing.value, nowMs)) return false;
  if (!discordMutationsAllowed() || !(await getInhouseAlertWebhookUrl())) {
    await recordAnnouncementCovered(prisma, key, nowMs);
    return false;
  }

  const claim = await claimAnnouncementMarker(key, nowMs);
  if (!claim) return false;
  // Test seam: an admin moves or clears the night after the claim.
  await raceHook("inhouseNight.start.afterClaim");
  const { night: current } = await readInhouseNight();
  if (
    current?.id !== night.id ||
    current.startsAtMs !== night.startsAtMs ||
    !due(current, Date.now())
  ) {
    // Release rather than burn: a moved night has its own key, and a cleared
    // or late one never passes the check above again.
    await releaseAnnouncementClaim(claim);
    return false;
  }

  const [present, roleId] = await Promise.all([
    prisma.inhouseQueueEntry.count({
      where: { lastSeenAt: { gte: queuePresentCutoff(Date.now()) } },
    }),
    getInhousePingRoleId(),
  ]);
  const sent = await sendInhouseDiscordMessage(
    inhouseNightStartMessage({ present, lobbySize: INHOUSE.LOBBY_SIZE, roleId }),
    { roles: roleId ? [roleId] : [] },
  );
  if (!sent) {
    // A failed marker is retried by later runs inside the window.
    await markAnnouncementFailed(claim);
    return false;
  }
  await markAnnouncementSent(claim);
  return true;
}
