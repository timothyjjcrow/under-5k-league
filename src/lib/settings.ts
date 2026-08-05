import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";

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
// weekReminder:<season>:<week>:<kickoffMs>, honorsAnnounced:<season>:<week>,
// playoffRoundBuilt:<season>:<round>), JSON state blobs
// (playoffGamesArchive:<season>, importSkip:<season>, leagueSyncSkip:<season>)
// and per-pair throttles (outPing:<matchId>:<userId>, providerCooldown:*).
// Multi-file key formats
// are built ONLY through the helpers below — a prefix that drifts between the
// writer and the sweep that startsWith-matches it fails silently, with no
// compile error. Single-file keys (importSkip, playoffRoundBuilt, outPing)
// keep their local builders beside their one call site.
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

/** League-feed ids fetched but not imported — never refetched (JSON array). */
export function leagueSyncSkipKey(seasonId: string): string {
  return `leagueSyncSkip:${seasonId}`;
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
  // Resource precedes user so deleting/exporting a season can select every
  // captain claim for one match without knowing which users made the calls.
  return `${PROVIDER_COOLDOWN_PREFIX}${action}:${encodeURIComponent(resource)}:${encodeURIComponent(user)}`;
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
    { key: { startsWith: weekReminderPrefix(seasonId) } },
    { key: { startsWith: honorsAnnouncedPrefix(seasonId) } },
    { key: playoffGamesArchiveKey(seasonId) },
    { key: leagueSyncSkipKey(seasonId) },
    { key: `importSkip:${seasonId}` },
    { key: { startsWith: `playoffRoundBuilt:${seasonId}:` } },
  ];
  const matchScope = matchIds.flatMap<Prisma.SettingWhereInput>((matchId) => [
    { key: resultAnnouncedKey(matchId) },
    { key: { startsWith: `outPing:${matchId}:` } },
    {
      key: {
        startsWith: `${PROVIDER_COOLDOWN_PREFIX}open-dota-match-scan:${encodeURIComponent(matchId)}:`,
      },
    },
    {
      key: {
        startsWith: `${PROVIDER_COOLDOWN_PREFIX}open-dota-match-import:${encodeURIComponent(`fixture:${matchId}`)}:`,
      },
    },
  ]);
  return { OR: [...seasonScope, ...matchScope] };
}

/**
 * Atomic global throttle (Setting-row claim). ISO timestamps compare
 * lexicographically, so the conditional update below is a valid "only if
 * stale" claim: exactly one caller wins per interval, across every serverless
 * instance, with no lock and no cron. Returns true to the winner only.
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

  // Try the STALE-CLAIM update first. The row exists on every call but the
  // first, so leading with `create` meant a caught-and-ignored P2002 on
  // essentially every hot caller. Before the production log policy was
  // hardened, Prisma emitted that caught conflict directly, burying useful
  // diagnostics under expected-path noise.
  const updated = await prisma.setting.updateMany({
    where: { key, value: { lt: staleBefore } },
    data: { value },
  });
  if (updated.count > 0) return true;

  // Zero rows means either "exists but still fresh" (not our claim) or "row
  // isn't there yet" (first ever call). Claim that first row with the same
  // conflict-skipping primitive used by bootstrap: both supported databases
  // implement this standard form, and a losing first-call race stays an
  // ordinary zero-row result instead of making Prisma print a caught P2002 as
  // an application error.
  const created = await prisma.$executeRaw`
    INSERT INTO "Setting" ("key", "value")
    VALUES (${key}, ${value})
    ON CONFLICT ("key") DO NOTHING
  `;
  return created > 0;
}

/**
 * Bump the league change cursor. Its historical name is retained because most
 * callers are result writers, but lifecycle handoffs use the same parked-tab
 * refresh channel: changing which season is active is at least as important
 * as changing a score. Passing a transaction client keeps that cursor atomic
 * with the mutation that clients must observe.
 */
export async function stampResultChange(
  db: Pick<Prisma.TransactionClient, "setting"> = prisma,
): Promise<void> {
  const value = new Date().toISOString();
  await db.setting.upsert({
    where: { key: SETTING_KEYS.RESULT_CHANGED_AT },
    create: { key: SETTING_KEYS.RESULT_CHANGED_AT, value },
    update: { value },
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
