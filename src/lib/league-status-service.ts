import { prisma } from "./prisma";
import {
  deleteWebhookMessage,
  getLeagueStatusWebhookUrl,
  maskWebhookUrl,
  patchWebhookMessage,
  postWebhookMessage,
  webhookIdOf,
} from "./discord";
import {
  renderLeagueStatus,
  statusLabel,
  type LeagueStatusSnapshot,
} from "./league-status";
import { loadLeagueStatusSnapshot } from "./league-status-snapshot";
import { claimThrottle, getSetting, SETTING_KEYS, setSetting } from "./settings";
import { discordMutationsAllowed } from "./discord-mutation-policy";
import { runAfterResponse } from "./after-response";
import { raceHook } from "./race-hook";

// The league status card in #schedule — one message, rewritten in place as the
// season moves. The queue board's machinery (inhouse-board-service.ts), with
// its two rules kept word for word:
//
//  1. THE SETTING ROW IS THE ON/OFF SWITCH. No row = off, and "off" costs one
//     primary-key read. A row with an empty message id is the visible POST
//     reservation, not a second toggle.
//  2. NOTHING HAPPENS UNLESS THE RENDER CHANGED. The digest gate means a quiet
//     league makes no request and no write.
//
// What differs is WHEN it repaints. The board rides the inhouse room's polls;
// this card rides the writes that change what it shows. `refreshLeagueStatus`
// runs after the response of every admin action (admin-shared.ts refresh) and
// of the player actions that move it (signups, votes, reschedules, standins,
// renames, match reports). The worker (syncLeagueStatusFromWorker) looks
// after a pass that imported a game, sold a lot, built a playoff round or
// started an inhouse night, every pass while the draft is live (its sales
// land through the draft room's own requests), and otherwise at most every
// LEAGUE_STATUS_IDLE_CHECK_SECONDS, which is how what only time changes (a
// poll closing, an inhouse night ending, the week rolling over) reaches it:
// within that, or within the hour the automation gate's hard wake guarantees
// when the worker is asleep. Because every repaint compares digests, calling
// it after an unrelated write costs a snapshot read and nothing else.

type CardState = {
  webhookId: string;
  messageId: string;
  /** Digest of what the message currently SAYS. */
  digest: string;
  /** ISO of the last edit Discord ACCEPTED (never the throttle stamp). */
  lastOkAt?: string;
  /** Consecutive failed edits since the last success. */
  failures?: number;
  /** The card shows a live draft: the worker looks every pass. */
  hot?: boolean;
};

type CardReservation = {
  webhookId: string;
  messageId: "";
  digest: string;
  reservedAt: string | null;
};

export const LEAGUE_STATUS_POST_LEASE_MS = 30_000;
/** Spam floor between edits. Longer than the 2.5s edit timeout, so two edits
 *  can never be in flight at once and land out of order. */
export const LEAGUE_STATUS_MIN_SECONDS = 5;
/** How often the worker looks at the card when its pass changed nothing the
 *  card shows: the delay on what only time changes. */
export const LEAGUE_STATUS_IDLE_CHECK_SECONDS = 600;
/** The same while the card shows a live draft: under a minute, so every
 *  one-minute pass looks. */
export const LEAGUE_STATUS_HOT_CHECK_SECONDS = 50;

/** Whether this snapshot is one the worker should re-read every pass. */
function hotSnapshot(snapshot: LeagueStatusSnapshot): boolean {
  return snapshot.phase === "DRAFT" && snapshot.draft?.state === "LIVE";
}

function parseState(raw: string | null): CardState | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<CardState>;
    if (
      typeof v.webhookId === "string" &&
      typeof v.messageId === "string" &&
      // An empty message id is a POSTING RESERVATION: nothing to edit yet.
      v.messageId !== "" &&
      typeof v.digest === "string"
    ) {
      return {
        webhookId: v.webhookId,
        messageId: v.messageId,
        digest: v.digest,
        lastOkAt: typeof v.lastOkAt === "string" ? v.lastOkAt : undefined,
        failures:
          typeof v.failures === "number" && Number.isFinite(v.failures)
            ? Math.max(0, Math.floor(v.failures))
            : 0,
        hot: v.hot === true,
      };
    }
  } catch {
    // Corrupt row — treat as no card rather than failing an action.
  }
  return null;
}

function parseReservation(raw: string | null): CardReservation | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<CardReservation>;
    if (typeof v.webhookId !== "string" || v.messageId !== "") return null;
    return {
      webhookId: v.webhookId,
      messageId: "",
      digest: typeof v.digest === "string" ? v.digest : "posting",
      reservedAt: typeof v.reservedAt === "string" ? v.reservedAt : null,
    };
  } catch {
    return null;
  }
}

function reservationStuck(reservation: CardReservation, nowMs = Date.now()) {
  if (!reservation.reservedAt) return true;
  const at = new Date(reservation.reservedAt).getTime();
  return !Number.isFinite(at) || nowMs - at >= LEAGUE_STATUS_POST_LEASE_MS;
}

/** Clear the row only if it still holds `expected` (a blind delete after a
 *  Discord round trip would drop a card an admin posted meanwhile). */
async function clearStateIf(expected: string): Promise<void> {
  await prisma.setting.deleteMany({
    where: { key: SETTING_KEYS.LEAGUE_STATUS_CARD, value: expected },
  });
}

/**
 * Turn an in-flight POST lease into the visible interrupted-post state, but
 * only while this request still owns it. A POST with no readable id may still
 * have created a message, so the reservation is never simply deleted.
 */
async function markReservationInterrupted(expected: string): Promise<boolean> {
  const reservation = parseReservation(expected);
  if (!reservation) return false;
  const swapped = await prisma.setting.updateMany({
    where: { key: SETTING_KEYS.LEAGUE_STATUS_CARD, value: expected },
    data: {
      value: JSON.stringify({
        ...reservation,
        reservedAt: null,
      } satisfies CardReservation),
    },
  });
  return swapped.count > 0;
}

/**
 * Reserve the row before talking to Discord, so only one "Post status card"
 * can send a message. Returns the placeholder (the CAS token for the real
 * write), or null when someone else holds the row. Taking over is allowed
 * only for a settled card in a DIFFERENT channel; a reservation is never
 * taken, and neither is a card already in this channel.
 */
async function claimCardRow(webhookId: string): Promise<string | null> {
  const placeholder = JSON.stringify({
    webhookId,
    messageId: "",
    digest: `posting:${webhookId}`,
    reservedAt: new Date().toISOString(),
  } satisfies CardReservation);
  try {
    await prisma.setting.create({
      data: { key: SETTING_KEYS.LEAGUE_STATUS_CARD, value: placeholder },
    });
    return placeholder;
  } catch (e) {
    if ((e as { code?: string }).code !== "P2002") throw e;
  }
  const current = await prisma.setting.findUnique({
    where: { key: SETTING_KEYS.LEAGUE_STATUS_CARD },
  });
  if (!current) return null;
  try {
    const raw = JSON.parse(current.value) as Partial<CardState>;
    if (raw.messageId === "") return null;
    if (raw.webhookId === webhookId) return null;
  } catch {
    // Unparseable row — nothing to protect, fall through and take it.
  }
  // Seam: the checks above judge a row read one round trip ago, so the CAS
  // below decides the takeover. The rival that matters is another admin's
  // post COMPLETING in this gap; taking its row over means both of us post.
  // See src/lib/race-hook.ts.
  await raceHook("leagueStatus.claimCardRow.beforeTakeover");
  const swapped = await prisma.setting.updateMany({
    where: { key: SETTING_KEYS.LEAGUE_STATUS_CARD, value: current.value },
    data: { value: placeholder },
  });
  return swapped.count > 0 ? placeholder : null;
}

/** Compare-and-swap the row: write `next` only over exactly `expected`. */
async function swapState(expected: string, next: CardState): Promise<boolean> {
  const swapped = await prisma.setting.updateMany({
    where: { key: SETTING_KEYS.LEAGUE_STATUS_CARD, value: expected },
    data: { value: JSON.stringify(next) },
  });
  return swapped.count > 0;
}

export type LeagueStatusSyncOutcome =
  | "off"
  | "unchanged"
  | "throttled"
  | "edited"
  | "failed"
  | "gone"
  | "stranded";

/**
 * Bring the card in line with the league. Safe to call after any write: one
 * PK read when the card is off, a snapshot read and nothing else when the
 * card already says the right thing.
 */
export async function syncLeagueStatus(
  nowMs: number = Date.now(),
): Promise<LeagueStatusSyncOutcome> {
  if (!discordMutationsAllowed()) return "off";
  const raw = await getSetting(SETTING_KEYS.LEAGUE_STATUS_CARD);
  const state = parseState(raw);
  if (!state || !raw) return "off";

  const url = await getLeagueStatusWebhookUrl();
  // No webhook: leave the row alone (the admin may be mid-rotation).
  if (!url) return "off";
  if (webhookIdOf(url) !== state.webhookId) {
    // A different channel now. The old message can't be edited from here.
    await clearStateIf(raw);
    return "stranded";
  }

  const snapshot = await loadLeagueStatusSnapshot(nowMs);
  const { digest, payload } = renderLeagueStatus(snapshot);
  if (digest === state.digest) return "unchanged";

  if (
    !(await claimThrottle(
      SETTING_KEYS.LEAGUE_STATUS_AT,
      // Back off on a failing webhook: from the floor up to 5 minutes.
      Math.min(300, LEAGUE_STATUS_MIN_SECONDS * 2 ** Math.min(state.failures ?? 0, 6)),
      nowMs,
    ))
  ) {
    return "throttled";
  }

  const res = await patchWebhookMessage(url, state.messageId, payload);
  if (res === "ok") {
    await swapState(raw, {
      ...state,
      digest,
      lastOkAt: new Date(nowMs).toISOString(),
      failures: 0,
      hot: hotSnapshot(snapshot),
    });
    return "edited";
  }
  if (res === "failed") {
    // Keep the old digest so the next call retries, and record the failure.
    await swapState(raw, { ...state, failures: (state.failures ?? 0) + 1 });
    return "failed";
  }
  // Deleted in Discord (or the webhook died): deleting the card is the
  // natural "turn it off", so stop rather than re-post. Guarded: an admin may
  // have posted a fresh card during the round trip.
  await clearStateIf(raw);
  return "gone";
}

/**
 * The worker's look at the card, once per pass. `changed` says the pass did
 * something the card may show (imported a game, resolved a draft lot, built
 * a playoff round, started an inhouse night): then it always looks. Otherwise
 * it looks at most every LEAGUE_STATUS_IDLE_CHECK_SECONDS (every pass during
 * a live draft), so a busy worker doesn't read the league every minute for a
 * card that can't have moved. Off costs one primary-key read, like the rest.
 */
export async function syncLeagueStatusFromWorker(
  changed: boolean,
  nowMs: number = Date.now(),
): Promise<LeagueStatusSyncOutcome | "idle"> {
  if (!discordMutationsAllowed()) return "off";
  const state = parseState(await getSetting(SETTING_KEYS.LEAGUE_STATUS_CARD));
  if (!state) return "off";
  if (
    !changed &&
    !(await claimThrottle(
      SETTING_KEYS.LEAGUE_STATUS_CHECK_AT,
      state.hot ? LEAGUE_STATUS_HOT_CHECK_SECONDS : LEAGUE_STATUS_IDLE_CHECK_SECONDS,
      nowMs,
    ))
  ) {
    return "idle";
  }
  return syncLeagueStatus(nowMs);
}

/**
 * Repaint after the response of the write that just committed, so nobody
 * waits on Discord. A repaint that loses the spam floor to a concurrent one
 * waits the floor out once and tries again: the winner may have read the
 * league before this write landed, and without the second look the card
 * would hold the older state until the next write or worker pass.
 */
export function refreshLeagueStatus(): Promise<void> {
  return runAfterResponse(async () => {
    const first = await syncLeagueStatus();
    if (first !== "throttled") return;
    await new Promise((resolve) =>
      setTimeout(resolve, LEAGUE_STATUS_MIN_SECONDS * 1000 + 250),
    );
    await syncLeagueStatus();
  });
}

/** Admin: post the card for the first time and start tracking it. */
export async function createLeagueStatusCard(): Promise<{
  ok: boolean;
  error?: string;
}> {
  if (!discordMutationsAllowed()) {
    return {
      ok: false,
      error:
        "Discord posting is disabled in this preview so it cannot alter the live server.",
    };
  }
  const url = await getLeagueStatusWebhookUrl();
  if (!url) return { ok: false, error: "Save the status card webhook first" };
  const webhookId = webhookIdOf(url);
  if (!webhookId) {
    return { ok: false, error: "That webhook URL doesn't look like Discord's" };
  }

  const currentRaw = await getSetting(SETTING_KEYS.LEAGUE_STATUS_CARD);
  const existing = parseState(currentRaw);
  if (existing && existing.webhookId === webhookId) {
    return { ok: false, error: "The card is already posted in that channel" };
  }
  const reservation = parseReservation(currentRaw);
  if (reservation) {
    return {
      ok: false,
      error: reservationStuck(reservation)
        ? "A previous card post was interrupted. Check Discord for an untracked card, then clear the interrupted post here before trying again."
        : "The card is already being posted — reload in a moment to see it",
    };
  }

  const snapshot = await loadLeagueStatusSnapshot();
  const { digest, payload } = renderLeagueStatus(snapshot);
  // Claim the row BEFORE posting: two admins (or a double submit) must never
  // both reach Discord, or one card is orphaned beyond reach.
  const claimed = await claimCardRow(webhookId);
  if (!claimed) {
    return { ok: false, error: "The card is already being posted — reload to see it" };
  }
  const posted = await postWebhookMessage(url, payload);
  const messageId =
    posted && typeof posted.id === "string" && posted.id.trim()
      ? posted.id.trim()
      : null;
  if (!messageId) {
    const retained = await markReservationInterrupted(claimed);
    return {
      ok: false,
      error: retained
        ? "Discord didn't confirm the card's message id. Check the channel for an untracked card, then clear the interrupted post before trying again."
        : "Discord didn't confirm the card's message id, and the card state changed while posting. Check Discord and reload before trying again.",
    };
  }
  const tracked = await swapState(claimed, {
    webhookId,
    messageId,
    digest,
    hot: hotSnapshot(snapshot),
  });
  if (!tracked) {
    // The reservation was cleared during the POST: never leave an untracked
    // card behind. Remove it with the credential that made it.
    const deleted = await deleteWebhookMessage(url, messageId);
    return {
      ok: false,
      error: deleted
        ? "The card post was cancelled before it could be saved. Reload before trying again."
        : "Discord created the card, but it could not be tracked or removed. Delete the newest card message by hand before trying again.",
    };
  }
  return { ok: true };
}

/**
 * Admin: delete the card message and stop tracking it. Reports honestly: a
 * card forgotten while its message lives on is orphaned, frozen forever.
 * `force` (the webhook is changing or going) always clears and reports
 * `orphaned` when Discord didn't confirm.
 */
export async function removeLeagueStatusCard(
  opts: { force?: boolean } = {},
): Promise<{ ok: boolean; orphaned?: boolean; error?: string }> {
  if (!discordMutationsAllowed()) {
    return {
      ok: false,
      error:
        "Discord deletion is disabled in this preview so it cannot alter the live server.",
    };
  }
  const raw = await getSetting(SETTING_KEYS.LEAGUE_STATUS_CARD);
  const state = parseState(raw);
  if (!state) {
    const reservation = parseReservation(raw);
    if (!reservation || !raw) return { ok: true };
    if (!opts.force && !reservationStuck(reservation)) {
      return {
        ok: false,
        error: "Discord is still posting the card — wait a moment and reload.",
      };
    }
    await clearStateIf(raw);
    await setSetting(SETTING_KEYS.LEAGUE_STATUS_AT, "");
    return { ok: true, orphaned: true };
  }

  const url = await getLeagueStatusWebhookUrl();
  const stranded = !url || webhookIdOf(url) !== state.webhookId;
  const deleted = stranded ? false : await deleteWebhookMessage(url, state.messageId);
  if (!deleted && !stranded && !opts.force) {
    return {
      ok: false,
      error: "Discord didn't confirm the delete — the card is still live. Try again in a moment.",
    };
  }
  await clearStateIf(raw!);
  await setSetting(SETTING_KEYS.LEAGUE_STATUS_AT, "");
  return { ok: true, orphaned: !deleted };
}

/** Admin-card view: no credential, no full message id. */
export type LeagueStatusCardStatus = {
  /** A webhook is saved for the card. */
  configured: boolean;
  masked: string;
  posted: boolean;
  posting: boolean;
  postingStuck: boolean;
  messageHint: string;
  /** The card belongs to a webhook that's no longer the configured one. */
  stranded: boolean;
  lastEdit: string | null;
  failures: number;
  /** What the league is right now, e.g. "Week 3 of 9". */
  liveState: string;
  /** False while the card shows something older than `liveState`. */
  inSync: boolean;
};

export async function getLeagueStatusCardStatus(): Promise<LeagueStatusCardStatus> {
  const [raw, url] = await Promise.all([
    getSetting(SETTING_KEYS.LEAGUE_STATUS_CARD),
    getLeagueStatusWebhookUrl(),
  ]);
  const base = {
    configured: !!url,
    masked: maskWebhookUrl(url),
  };
  const state = parseState(raw);
  const reservation = parseReservation(raw);
  if (!state) {
    return {
      ...base,
      posted: false,
      posting: !!reservation,
      postingStuck: reservation ? reservationStuck(reservation) : false,
      messageHint: "",
      stranded: false,
      lastEdit: null,
      failures: 0,
      liveState: "",
      inSync: true,
    };
  }
  const snapshot = await loadLeagueStatusSnapshot();
  return {
    ...base,
    posted: true,
    posting: false,
    postingStuck: false,
    messageHint:
      state.messageId.length > 6
        ? `${state.messageId.slice(0, 4)}…${state.messageId.slice(-2)}`
        : state.messageId,
    stranded: !!url && webhookIdOf(url) !== state.webhookId,
    lastEdit: state.lastOkAt ?? null,
    failures: state.failures ?? 0,
    liveState: statusLabel(snapshot),
    inSync: renderLeagueStatus(snapshot).digest === state.digest,
  };
}
