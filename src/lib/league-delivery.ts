// Pure rules for the league-channel Discord queue: how a webhook refusal is
// handled, when a time-bound post goes stale, and what the admin panel says
// about delivery. The queue itself is league-announcement-outbox.ts; nothing
// here touches the database, so all of it is unit-tested.

/**
 * What one refused webhook POST means for the queue.
 *
 * - `post`: Discord refused THIS message (a malformed or oversized body). It
 *   will be refused every time, so the queue drops it and moves on — keeping
 *   it would block every later post forever.
 * - `webhook`: the webhook itself is gone (deleted, or its token regenerated
 *   or revoked). Every post would fail the same way, so the queue PAUSES
 *   instead of dropping them one by one, and the admin panel says so.
 * - `transient`: rate limits, Discord outages and anything unrecognised. The
 *   post is retried with backoff.
 */
export type DiscordRefusalKind = "post" | "webhook" | "transient";

/**
 * Discord's JSON error codes for a 400 that is about the WEBHOOK'S CHANNEL,
 * not the message: a webhook in a forum (or media) channel gets 220001
 * ("thread_name or thread_id required") on every plain post, and 220002-
 * 220004 are the other forum-webhook refusals. Treated like a dead webhook,
 * so the queue pauses until a working one is saved instead of dropping every
 * queued announcement one by one.
 */
const WEBHOOK_CHANNEL_400_CODES: ReadonlySet<number> = new Set([
  220001, 220002, 220003, 220004,
]);

/**
 * `discordCode` is the `code` field of Discord's JSON error body, when the
 * transport read one (it does for a 400).
 */
export function discordRefusalKind(
  status: number,
  discordCode?: number | null,
): DiscordRefusalKind {
  if (
    status === 400 &&
    discordCode != null &&
    WEBHOOK_CHANNEL_400_CODES.has(discordCode)
  ) {
    return "webhook";
  }
  if (status === 400 || status === 413) return "post";
  if (status === 401 || status === 403 || status === 404) return "webhook";
  return "transient";
}

/**
 * The `lastErrorCode` stored for an HTTP answer from Discord:
 * `DISCORD_<status>`, or `DISCORD_400_<code>` for a channel-level 400, so
 * the admin card can tell a paused queue from a dropped post.
 */
export function discordErrorCode(
  status: number,
  discordCode?: number | null,
): string {
  return status === 400 &&
    discordCode != null &&
    WEBHOOK_CHANNEL_400_CODES.has(discordCode)
    ? `DISCORD_400_${discordCode}`
    : `DISCORD_${status}`;
}

/** The HTTP status (and Discord code) inside a stored code, or null. */
function parseDiscordErrorCode(
  code: string | null | undefined,
): { status: number; discordCode: number | null } | null {
  const match = /^DISCORD_(\d{3})(?:_(\d+))?$/.exec(code ?? "");
  return match
    ? {
        status: Number(match[1]),
        discordCode: match[2] ? Number(match[2]) : null,
      }
    : null;
}

/** The HTTP status inside a `DISCORD_<status>` code, or null. */
function discordStatusOf(
  code: string | null | undefined,
): number | null {
  return parseDiscordErrorCode(code)?.status ?? null;
}

/** True when the stored code means the webhook itself refused the post. */
export function isWebhookRefusalCode(code: string | null | undefined): boolean {
  const parsed = parseDiscordErrorCode(code);
  return (
    parsed !== null &&
    discordRefusalKind(parsed.status, parsed.discordCode) === "webhook"
  );
}

/** Stored when a time-bound post was dropped instead of being sent late. */
export const EXPIRED_ERROR_CODE = "EXPIRED";
/** Stored when an admin discarded waiting posts from the Discord card. */
export const DISCARDED_ERROR_CODE = "DISCARDED";

/**
 * Plain words for a stored error code, for the admin card. Codes only — the
 * webhook URL is a credential and never appears anywhere near this.
 */
export function deliveryErrorLabel(
  code: string | null | undefined,
): string | null {
  if (!code) return null;
  const parsed = parseDiscordErrorCode(code);
  if (parsed !== null) {
    const { status } = parsed;
    if (discordRefusalKind(status, parsed.discordCode) === "webhook" && status === 400) {
      return "webhook is in a forum channel, which needs a thread for every post (400)";
    }
    if (status === 404) return "webhook not found (404)";
    if (status === 401) return "webhook token no longer valid (401)";
    if (status === 403) return "webhook not allowed to post (403)";
    if (status === 400) return "Discord refused the post (400)";
    if (status === 413) return "post too large for Discord (413)";
    if (status === 429) return "rate limited by Discord (429)";
    if (status >= 500) return `Discord unavailable (${status})`;
    return `Discord error (${status})`;
  }
  switch (code) {
    case "TRANSPORT_REJECTED":
      return "couldn't reach Discord";
    case "SOURCE_CHECK_FAILED":
      return "couldn't check the post was still current";
    case EXPIRED_ERROR_CODE:
      return "out of date, dropped";
    case DISCARDED_ERROR_CODE:
      return "discarded by an admin";
    case "STALE_SOURCE":
      return "replaced before it was sent";
    case "INVALID_PAYLOAD":
    case "INVALID_SOURCE":
      return "invalid post, dropped";
    default:
      return code;
  }
}

/**
 * When a match-night reminder goes stale. A reminder queued before kickoff
 * expires AT kickoff: it was built from check-ins that are out of date by then,
 * and a "who hasn't checked in" ping after the game started is only noise. A
 * catch-up reminder queued after kickoff (the service deliberately still posts
 * one for `behindHours`) keeps that same window, so the outbox never drops a
 * post the reminder service itself decided was still worth sending.
 */
export function weekReminderExpiresAt(
  kickoffMs: number,
  nowMs: number,
  behindHours: number,
): Date {
  return new Date(
    nowMs < kickoffMs ? kickoffMs : kickoffMs + behindHours * 3_600_000,
  );
}

/** A league post waiting longer than this is flagged on the admin panel. */
export const DELIVERY_ATTENTION_MS = 15 * 60_000;
/** How far back the admin card counts refused and dropped posts. */
export const DELIVERY_RECENT_MS = 24 * 3_600_000;

/** What the admin panel knows about the league-channel queue (DB only). */
export type LeagueDeliveryHealth = {
  /** When these figures were read. */
  checkedAt: Date;
  /** Posts queued or mid-send. */
  waiting: number;
  /** When the oldest waiting post was queued — it is the one blocking. */
  oldestWaitingAt: Date | null;
  /** When the newest waiting post was queued: the bound for Discard. */
  newestWaitingAt: Date | null;
  /** Why the oldest waiting post has not gone out, if it was tried. */
  headErrorCode: string | null;
  /** When the oldest waiting post is next tried. */
  headRetryAt: Date | null;
  lastDeliveredAt: Date | null;
  /** Posts Discord refused (and the queue dropped) in DELIVERY_RECENT_MS. */
  refusedRecently: number;
  lastRefusedCode: string | null;
  /** How the newest refused post started (refusedPostPreview), or null. */
  lastRefusedPreview: string | null;
  /** Time-bound posts dropped as out of date in DELIVERY_RECENT_MS. */
  expiredRecently: number;
};

/**
 * True once the oldest waiting post has waited past DELIVERY_ATTENTION_MS:
 * Discord (or the runner) is not taking posts, and the admin panel says so
 * and offers to discard the backlog.
 */
export function deliveryBacklogStuck(health: LeagueDeliveryHealth): boolean {
  return (
    health.waiting > 0 &&
    health.oldestWaitingAt !== null &&
    health.checkedAt.getTime() - health.oldestWaitingAt.getTime() >
      DELIVERY_ATTENTION_MS
  );
}

/**
 * True while a refused webhook holds the queue: the oldest post was refused
 * by the webhook itself and is waiting out its slow retry. Saving a new
 * webhook makes it due at once, which ends the pause.
 */
export function deliveryPaused(health: LeagueDeliveryHealth): boolean {
  return (
    health.waiting > 0 &&
    isWebhookRefusalCode(health.headErrorCode) &&
    health.headRetryAt !== null &&
    health.headRetryAt.getTime() > health.checkedAt.getTime()
  );
}

/**
 * Lines for the admin panel's "Needs attention" card, or [] when delivery is
 * healthy. A post waiting 15+ minutes means Discord (or the runner) is not
 * taking posts, and the admin can act on it.
 *
 * A post Discord refused is NOT listed here: the queue already dropped it and
 * nothing on the panel brings it back, so one refused post would otherwise
 * keep the card at "needs attention" for a whole day. The Discord card still
 * counts refused posts and shows how the newest one started
 * (refusedPostsSentence), so an admin can post it by hand.
 */
export function leagueDeliveryAttention(
  health: LeagueDeliveryHealth,
): string[] {
  const lines: string[] = [];
  if (deliveryBacklogStuck(health) && health.oldestWaitingAt) {
    const minutes = Math.floor(
      (health.checkedAt.getTime() - health.oldestWaitingAt.getTime()) / 60_000,
    );
    const waited =
      minutes >= 120
        ? `${Math.floor(minutes / 60)} hours`
        : `${minutes} minutes`;
    const waiting =
      health.waiting === 1
        ? `1 league Discord post has been waiting ${waited}`
        : `${health.waiting} league Discord posts are waiting, the oldest for ${waited}`;
    const reason = deliveryErrorLabel(health.headErrorCode);
    lines.push(
      deliveryPaused(health)
        ? `${waiting}. Discord says: ${reason}. Posting is paused until you save a working webhook.`
        : `${waiting}${reason ? ` — last error: ${reason}` : ""}.`,
    );
  }
  return lines;
}

/** Longest preview of a refused post the admin card shows. */
const REFUSED_PREVIEW_CHARS = 140;

/**
 * The first non-blank line of a post, cut to REFUSED_PREVIEW_CHARS: enough
 * for an admin to tell which post Discord refused. Null for an empty post.
 */
export function refusedPostPreview(
  content: string | null | undefined,
): string | null {
  const line = (content ?? "")
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (!line) return null;
  const chars = Array.from(line);
  return chars.length > REFUSED_PREVIEW_CHARS
    ? `${chars.slice(0, REFUSED_PREVIEW_CHARS - 1).join("").trimEnd()}…`
    : line;
}

/**
 * "Discord refused 2 league posts in the last day (error 400), so they were
 * skipped. The latest one started: “…”". Says which post, so an admin can
 * post it by hand if it still matters.
 */
export function refusedPostsSentence(health: LeagueDeliveryHealth): string {
  const n = health.refusedRecently;
  const status = discordStatusOf(health.lastRefusedCode);
  const counted = `Discord refused ${n} league post${n === 1 ? "" : "s"} in the last day${status ? ` (error ${status})` : ""}, so ${n === 1 ? "it was" : "they were"} skipped.`;
  const preview = health.lastRefusedPreview;
  if (!preview) return counted;
  return `${counted} ${n === 1 ? "It" : "The latest one"} started: “${preview}”`;
}
