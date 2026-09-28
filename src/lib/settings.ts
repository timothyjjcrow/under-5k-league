import type { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { prisma } from "./prisma";
import { checkinNudgePrefix, outPingPrefix } from "./availability";

// Tiny key-value store (the `Setting` model) for league-global config that an
// admin edits at runtime — anything per-season belongs on `Season` instead.

export const SETTING_KEYS = {
  // Immutable winner of zero-config admin bootstrap. The atomic upsert is the
  // concurrency guard: two simultaneous first Steam logins can both observe
  // an empty User table, but only the SteamID stored here becomes admin.
  BOOTSTRAP_ADMIN_STEAM_ID: "bootstrapAdminSteamId",
  DISCORD_WEBHOOK_URL: "discordWebhookUrl",
  // OPTIONAL second webhook, for the inhouse channel only. A Discord webhook
  // is locked to the channel it was created in, so one webhook means one
  // channel for all 27 announcement types — and inhouse traffic (a queue
  // board that repaints all evening, lobby pings, results) belongs in the
  // inhouse channel, not wherever league signups and match results go.
  // Unset = fall back to DISCORD_WEBHOOK_URL, i.e. previous behaviour.
  INHOUSE_WEBHOOK_URL: "inhouseWebhookUrl",
  // OPTIONAL third webhook, for inhouse ALERTS — the queue-filling ping,
  // "match found", and results. Splitting these off the inhouse webhook lets
  // the queue BOARD have a channel to itself, which is the whole point of a
  // message that lives at the bottom of the channel and is read at a glance:
  // one alert pushes it out of view. Unset = alerts share the board's channel.
  INHOUSE_ALERT_WEBHOOK_URL: "inhouseAlertWebhookUrl",
  // Epoch ms of the last "queue is almost full" Discord ping (spam throttle).
  INHOUSE_QUEUE_PING_AT: "inhouseQueuePingAt",
  // Fleet-wide short throttle for the authenticated inhouse room's resolver
  // chain. Ten active players poll far faster than state transitions need;
  // one winner every two seconds advances clocks while the rest only read.
  INHOUSE_ROOM_MAINTENANCE_AT: "inhouseRoomMaintenanceAt",
  // Same boundary for draft deadline recovery. The key is global because the
  // data model permits exactly one active season/draft at a time.
  DRAFT_ROOM_MAINTENANCE_AT: "draftRoomMaintenanceAt",
  // ISO timestamp of the last league-id OpenDota sync (result-sync-service's
  // atomic global throttle for the /leagues/{id}/matchIds path).
  LEAGUE_AUTO_SYNC_AT: "leagueAutoSyncAt",
  // ISO timestamp of the last roster scan on ANY match (global speed bump so
  // concurrent pollers can't each claim a different match in one burst).
  ROSTER_AUTO_SYNC_AT: "rosterAutoSyncAt",
  // Change cursor: bumped whenever ANY result lands (league game import,
  // manual recordResult, inhouse result). /api/sync returns it so every
  // parked client — not just the one whose ping performed the import — can
  // see the league changed and refresh itself.
  RESULT_CHANGED_AT: "resultChangedAt",
  // Opaque generation for public game caches. Unlike the display timestamp,
  // two mutations in the same millisecond must never share this identity.
  PUBLIC_GAME_REVISION: "publicGameRevision",
  // ISO timestamp of the last failed-announcement retry sweep (throttle).
  ANNOUNCE_RETRY_AT: "announceRetryAt",
  // The pinned Discord inhouse queue board, as JSON. A live row is
  // `{webhookId, messageId, digest, ...health}`; creation first stores a
  // short-lived `{webhookId, messageId:"", digest, reservedAt}` reservation.
  // THE ROW'S EXISTENCE IS THE ON/OFF SWITCH — absent means the feature is off
  // and the sync path returns after one PK read. Never write it from anywhere
  // but inhouse-board-service.
  INHOUSE_BOARD: "inhouseBoard",
  // ISO timestamp of the last board edit (claimThrottle spam floor).
  INHOUSE_BOARD_AT: "inhouseBoardAt",
  // Discord role id pinged by the two inhouse messages that are SUPPOSED to
  // interrupt someone (queue filling, match found). Unset = no ping, which is
  // the pre-existing behaviour. The role must be SELF-ASSIGNABLE in Discord:
  // a ping people can't opt out of gets the whole channel muted, which is
  // permanently worse than silence.
  INHOUSE_PING_ROLE_ID: "inhousePingRoleId",
} as const;

// ---------------------------------------------------------------------------
// The DYNAMIC keyspace. Beyond the fixed keys above, the Setting table hosts
// per-entity rows: exactly-once markers (resultAnnounced:<matchId>,
// resultNudge:<matchId>:<scheduleRevision>,
// weekReminder:<season>:<week>:<kickoffMs>, draftReminder:<season>:<revision>,
// honorsAnnounced:<season>:<week>, playoffRoundBuilt:<season>:<round>,
// playoffRoundAnnounced:<season>:<round>, signupsOpenAnnounced:<season>), JSON
// state blobs (playoffGamesArchive:<season>, importSkip:<season>,
// leagueSyncSkip:<season>) and per-pair throttles
// (outPing:<matchId>:<userId>, providerCooldown:*), plus tiebreakerDraw:
// <season>:<group> opening draws.
// Every key format is built ONLY through the helpers below — a prefix that
// drifts between the writer and the sweep that startsWith-matches it fails
// silently, with no compile error. seasonSettingScopeWhere sweeps every
// season-scoped key, so each has at least two users and no writer keeps a
// private copy. The one exception is outPing, whose builder lives in the pure
// availability.ts (a client component imports it) and is imported here. The
// key strings are stored in production databases: never change one without
// migrating the rows.
// ---------------------------------------------------------------------------

/**
 * Stamped over a marker's value when its Discord send FAILED, so the retry
 * sweep can re-claim exactly those and nothing else.
 *
 * It lives HERE, with the keys it qualifies, and not in match-import:
 * playoff-service needs it for the champion marker, match-import already
 * imports advancePlayoffBracket from playoff-service, and importing it back
 * the other way makes a require cycle. That cycle is not a style problem — it
 * left a partially-initialised module under Turbopack and HUNG the /admin RSC
 * stream (an empty <main>, the navigation never finishing), which reads as a
 * layout regression in the e2e tripwire and is nothing of the kind.
 */
export const ANNOUNCE_FAILED_PREFIX = "failed:";

/** Exactly-once marker for a decided series' Discord announcement. */
export const RESULT_ANNOUNCED_PREFIX = "resultAnnounced:";

export function resultAnnouncedKey(matchId: string): string {
  return `${RESULT_ANNOUNCED_PREFIX}${matchId}`;
}

/**
 * Exactly-once marker for the "we couldn't find your games" nudge to a
 * fixture's captains (result-nudge-service), one per kickoff: the schedule
 * revision is part of the key, so a fixture moved to a new night can be
 * nudged again for that night.
 */
export function resultNudgeKey(matchId: string, scheduleRevision: number): string {
  return `${resultNudgePrefix(matchId)}${scheduleRevision}`;
}

export function resultNudgePrefix(matchId: string): string {
  return `resultNudge:${matchId}:`;
}

/**
 * Exactly-once marker for the champion announcement. The crowning has exactly
 * ONE natural trigger, ever — advancePlayoffBracket early-returns unless the
 * season is PLAYOFFS and the crowning claim has just set it COMPLETE — so
 * without a retryable marker a single failed send ate the message of the
 * season permanently. Released by a bracket reset, which un-crowns.
 */
export const CHAMPION_ANNOUNCED_PREFIX = "championAnnounced:";

export function championAnnouncedKey(seasonId: string): string {
  return `${CHAMPION_ANNOUNCED_PREFIX}${seasonId}`;
}

/**
 * Exactly-once marker for "signups are open" — posted once when an admin
 * creates the season (announceSignupsOpenOnce).
 */
export function signupsOpenAnnouncedKey(seasonId: string): string {
  return `signupsOpenAnnounced:${seasonId}`;
}

/**
 * Exactly-once marker for one kickoff cluster inside a numbered week.
 * Without the optional suffix this is the cleanup prefix: admin/captain
 * retimes must release every cluster marker that quoted that week.
 */
export function weekReminderKey(
  seasonId: string,
  week: number,
  kickoffMs?: number,
): string {
  const base = `weekReminder:${seasonId}:${week}`;
  return kickoffMs == null ? base : `${base}:${kickoffMs}`;
}

export function weekReminderPrefix(seasonId: string): string {
  return `weekReminder:${seasonId}:`;
}

/**
 * Exactly-once marker for the draft-night reminder, one per draftAt REVISION.
 * The revision (not the timestamp) is the identity: it bumps on every real
 * change, including change-away-then-back, which is exactly when the old
 * confirmations went stale and the league needs a fresh reminder.
 */
export function draftReminderKey(seasonId: string, revision: number): string {
  return `${draftReminderPrefix(seasonId)}${revision}`;
}

export function draftReminderPrefix(seasonId: string): string {
  return `draftReminder:${seasonId}:`;
}

/**
 * When a captain last polled the draft room (ISO time): the "in room" marker
 * on team cards and in the Start-draft confirm. Written through claimThrottle,
 * so a room polling every second costs one write per throttle window.
 */
export function draftPresenceKey(seasonId: string, userId: string): string {
  return `${draftPresencePrefix(seasonId)}${userId}`;
}

export function draftPresencePrefix(seasonId: string): string {
  return `draftPresence:${seasonId}:`;
}

/**
 * One per draft RUN: the draft-complete teams post that mentioned the drafted
 * players went out. Undo can reopen a finished auction; when it completes
 * again, the updated teams post names people instead of pinging them all a
 * second time. An abort starts a new run on restart, which pings again.
 */
export function draftTeamsPingKey(seasonId: string, runId: string): string {
  return `${draftTeamsPingPrefix(seasonId)}${runId}`;
}

export function draftTeamsPingPrefix(seasonId: string): string {
  return `draftTeamsPing:${seasonId}:`;
}

/**
 * Exactly-once marker for a completed week's honors announcement. Its value
 * is a small state machine owned by honors-service (claim/failed/sent/stale),
 * because reopening a result needs one explicit corrected announcement rather
 * than deleting history and pretending the old Discord post never happened.
 */
export const HONORS_ANNOUNCED_PREFIX = "honorsAnnounced:";

export function honorsAnnouncedKey(seasonId: string, week: number): string {
  return `${HONORS_ANNOUNCED_PREFIX}${seasonId}:${week}`;
}

export function honorsAnnouncedPrefix(seasonId: string): string {
  return `${HONORS_ANNOUNCED_PREFIX}${seasonId}:`;
}

/** Merge-only archive of deleted playoff games' dotaMatchIds (JSON array). */
export function playoffGamesArchiveKey(seasonId: string): string {
  return `playoffGamesArchive:${seasonId}`;
}

export function tiebreakerGamesArchiveKey(seasonId: string): string {
  return `tiebreakerGamesArchive:${seasonId}`;
}

/** League-feed ids fetched but not imported — never refetched (JSON array). */
export function leagueSyncSkipKey(seasonId: string): string {
  return `leagueSyncSkip:${seasonId}`;
}

/**
 * Legacy per-season memory of removed games (JSON array). ImportSuppression
 * rows replaced it; import-candidates still honours an old row and season
 * delete/export still sweeps it.
 */
export function importSkipKey(seasonId: string): string {
  return `importSkip:${seasonId}`;
}

/**
 * Exactly-once marker for "round N of this season's bracket has been built".
 * Cleared by createPlayoffBracket so Reset playoffs can rebuild from scratch.
 */
export function playoffRoundBuiltKey(seasonId: string, round: number): string {
  return `${playoffRoundBuiltPrefix(seasonId)}${round}`;
}

export function playoffRoundBuiltPrefix(seasonId: string): string {
  return `playoffRoundBuilt:${seasonId}:`;
}

/**
 * Exactly-once marker for the "next playoff round is set" post
 * (announcePlayoffRoundOnce). A bracket reset deletes these with the round
 * markers above, which cancels a still-queued post for a round that no longer
 * exists and lets the rebuilt round announce itself afresh.
 */
export const PLAYOFF_ROUND_ANNOUNCED_PREFIX = "playoffRoundAnnounced:";

export function playoffRoundAnnouncedKey(
  seasonId: string,
  round: number,
): string {
  return `${playoffRoundAnnouncedPrefix(seasonId)}${round}`;
}

export function playoffRoundAnnouncedPrefix(seasonId: string): string {
  return `${PLAYOFF_ROUND_ANNOUNCED_PREFIX}${seasonId}:`;
}

/** The season and round a playoffRoundAnnouncedKey names (for the retry sweep). */
export function parsePlayoffRoundAnnouncedKey(
  key: string,
): { seasonId: string; round: number } | null {
  if (!key.startsWith(PLAYOFF_ROUND_ANNOUNCED_PREFIX)) return null;
  const match = /^(.+):(\d{1,4})$/.exec(
    key.slice(PLAYOFF_ROUND_ANNOUNCED_PREFIX.length),
  );
  return match ? { seasonId: match[1], round: Number(match[2]) } : null;
}

/** The saved opening draw of one tiebreaker group (JSON array of team ids). */
export function tiebreakerDrawKey(seasonId: string, groupKey: string): string {
  return `${tiebreakerDrawPrefix(seasonId)}${groupKey}`;
}

export function tiebreakerDrawPrefix(seasonId: string): string {
  return `tiebreakerDraw:${seasonId}:`;
}

/** Dynamic Setting rows that bound authenticated, user-triggered API work. */
export const PROVIDER_COOLDOWN_PREFIX = "providerCooldown:";

export const PROVIDER_COOLDOWN_SECONDS = {
  // A profile refresh fans out to medal + scouting endpoints in parallel.
  "open-dota-profile": 60,
  // A match scan can read recent games for every player on both rosters and
  // then fetch several candidate games. Its worst-case work is much longer.
  "open-dota-match-scan": 180,
  // A pasted exact ID is one provider call. Key it to the actor plus the
  // league fixture/lobby, never the submitted ID an attacker can vary.
  "open-dota-match-import": 60,
  "steam-profile": 60,
} as const;

export type ProviderCooldownAction = keyof typeof PROVIDER_COOLDOWN_SECONDS;

export type ProviderCooldownClaim = "claimed" | "cooldown" | "unavailable";

/**
 * One unambiguous, bounded row per authenticated user and provider resource.
 * The inputs have already been read from trusted database/session state; the
 * explicit length check prevents a corrupt legacy identifier from turning a
 * cheap safety claim into an unbounded Setting key.
 */
export function providerCooldownKey(
  action: ProviderCooldownAction,
  userId: string,
  resourceId: string | number,
): string {
  const user = String(userId);
  const resource = String(resourceId);
  if (
    user.length === 0 ||
    user.length > 128 ||
    resource.length === 0 ||
    resource.length > 128
  ) {
    throw new Error("Invalid provider cooldown identity");
  }
  return `${providerCooldownResourcePrefix(action, resource)}${encodeURIComponent(user)}`;
}

/**
 * The cooldown resource for a pasted match-id import on one league fixture.
 * Keyed to the fixture, never the submitted id, which the caller can vary.
 */
export function fixtureImportCooldownResource(matchId: string): string {
  return `fixture:${matchId}`;
}

/**
 * Every user's cooldown row for one provider resource. Resource precedes user
 * so deleting/exporting a season can select every captain claim for one match
 * without knowing which users made the calls.
 */
export function providerCooldownResourcePrefix(
  action: ProviderCooldownAction,
  resourceId: string | number,
): string {
  return `${PROVIDER_COOLDOWN_PREFIX}${action}:${encodeURIComponent(String(resourceId))}:`;
}

/**
 * Fail closed when the durable claim cannot be recorded: provider calls must
 * never become the fallback for a database outage. The log is intentionally
 * a fixed event code, not the caught database error, so credentials embedded
 * in a driver exception cannot reach production logs or an action response.
 */
export async function claimProviderCooldown(
  action: ProviderCooldownAction,
  userId: string,
  resourceId: string | number,
  nowMs = Date.now(),
): Promise<ProviderCooldownClaim> {
  try {
    return (await claimThrottle(
      providerCooldownKey(action, userId, resourceId),
      PROVIDER_COOLDOWN_SECONDS[action],
      nowMs,
    ))
      ? "claimed"
      : "cooldown";
  } catch {
    console.error(`[provider-cooldown] claim unavailable (${action})`);
    return "unavailable";
  }
}

/**
 * Every relationless Setting row owned by one season.
 *
 * Most season data has a foreign key and therefore follows Season on delete.
 * These operational markers do not: several are keyed by season id and two
 * families are keyed by match id. Keep the scope in one place so archive
 * exports and permanent deletion cannot silently disagree about what belongs
 * to a season.
 */
export function seasonSettingScopeWhere(
  seasonId: string,
  matchIds: string[],
): Prisma.SettingWhereInput {
  const seasonScope: Prisma.SettingWhereInput[] = [
    { key: championAnnouncedKey(seasonId) },
    { key: signupsOpenAnnouncedKey(seasonId) },
    { key: { startsWith: weekReminderPrefix(seasonId) } },
    { key: { startsWith: draftReminderPrefix(seasonId) } },
    { key: { startsWith: draftPresencePrefix(seasonId) } },
    { key: { startsWith: draftTeamsPingPrefix(seasonId) } },
    { key: { startsWith: honorsAnnouncedPrefix(seasonId) } },
    { key: playoffGamesArchiveKey(seasonId) },
    { key: tiebreakerGamesArchiveKey(seasonId) },
    { key: { startsWith: tiebreakerDrawPrefix(seasonId) } },
    { key: leagueSyncSkipKey(seasonId) },
    { key: importSkipKey(seasonId) },
    { key: { startsWith: playoffRoundBuiltPrefix(seasonId) } },
    { key: { startsWith: playoffRoundAnnouncedPrefix(seasonId) } },
  ];
  const matchScope = matchIds.flatMap<Prisma.SettingWhereInput>((matchId) => [
    { key: resultAnnouncedKey(matchId) },
    { key: { startsWith: resultNudgePrefix(matchId) } },
    { key: { startsWith: outPingPrefix(matchId) } },
    { key: { startsWith: checkinNudgePrefix(matchId) } },
    {
      key: {
        startsWith: providerCooldownResourcePrefix("open-dota-match-scan", matchId),
      },
    },
    {
      key: {
        startsWith: providerCooldownResourcePrefix(
          "open-dota-match-import",
          fixtureImportCooldownResource(matchId),
        ),
      },
    },
  ]);
  return { OR: [...seasonScope, ...matchScope] };
}

/**
 * Atomic global throttle (Setting-row claim). ISO timestamps compare
 * lexicographically, so the conditional update below is a valid "only if
 * stale" claim: exactly one caller wins per interval, across every serverless
 * instance, without a process-local lock or cron. Returns true to the winner only.
 *
 * Lives here rather than beside its first caller because unrelated subsystems
 * now need it (result sync, announcement retries, room maintenance, provider
 * cooldowns, and the inhouse board), and settings.ts is the one module they
 * can all import without a cycle.
 */
export async function claimThrottle(
  key: string,
  intervalSeconds: number,
  nowMs: number,
): Promise<boolean> {
  const value = new Date(nowMs).toISOString();
  const staleBefore = new Date(nowMs - intervalSeconds * 1000).toISOString();

  // One statement handles initial creation and stale claims on both SQLite
  // and Postgres. Most callers lose to an existing fresh claim: the indexed
  // NOT EXISTS read skips the insert before conflict handling, avoiding both
  // the old second query and Postgres's row lock for a rejected DO UPDATE.
  // A concurrent first/stale claim can still pass that read; the conditional
  // conflict update is the atomic final guard that elects exactly one winner.
  const claimed = await prisma.$executeRaw`
    INSERT INTO "Setting" ("key", "value")
    SELECT ${key}, ${value}
    WHERE NOT EXISTS (
      SELECT 1 FROM "Setting"
      WHERE "key" = ${key} AND "value" >= ${staleBefore}
    )
    ON CONFLICT ("key") DO UPDATE SET "value" = excluded."value"
    WHERE "Setting"."value" < ${staleBefore}
  `;
  return claimed > 0;
}

/**
 * Claim the right to ANSWER an earlier throttled announcement, such as "can
 * make it after all" after an OUT ping. Only an announcement whose throttle
 * row still exists can be answered, and a successful claim deletes that row
 * (value-scoped), so the next real announcement goes out again. The answer has
 * its own throttle at `answerKey`, claimed FIRST: losing that race never
 * removes the announcement row without an answer being sent, and someone
 * flipping back and forth gets at most one answer per interval.
 */
export async function claimThrottleAnswer(
  announcedKey: string,
  answerKey: string,
  intervalSeconds: number,
  nowMs: number,
): Promise<boolean> {
  const announced = await prisma.setting.findUnique({
    where: { key: announcedKey },
    select: { value: true },
  });
  if (!announced) return false;
  if (!(await claimThrottle(answerKey, intervalSeconds, nowMs))) return false;
  const consumed = await prisma.setting.deleteMany({
    where: { key: announcedKey, value: announced.value },
  });
  if (consumed.count === 1) return true;
  // The announcement was re-stamped (or answered) after our read: it is news
  // again, so say nothing and hand the answer throttle back for next time.
  await prisma.setting.deleteMany({
    where: { key: answerKey, value: new Date(nowMs).toISOString() },
  });
  return false;
}

/**
 * Bump the league change cursor. Its historical name is retained because most
 * callers are result writers, but lifecycle handoffs use the same parked-tab
 * refresh channel: changing which season is active is at least as important
 * as changing a score. Passing a transaction client keeps that cursor atomic
 * with the mutation that clients must observe.
 */
export async function stampResultChange(
  db?: Pick<Prisma.TransactionClient, "setting">,
): Promise<void> {
  if (!db) {
    await prisma.$transaction((tx) => stampResultChange(tx));
    return;
  }
  const value = new Date().toISOString();
  await db.setting.upsert({
    where: { key: SETTING_KEYS.RESULT_CHANGED_AT },
    create: { key: SETTING_KEYS.RESULT_CHANGED_AT, value },
    update: { value },
  });
  const revision = randomUUID();
  await db.setting.upsert({
    where: { key: SETTING_KEYS.PUBLIC_GAME_REVISION },
    create: { key: SETTING_KEYS.PUBLIC_GAME_REVISION, value: revision },
    update: { value: revision },
  });
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
