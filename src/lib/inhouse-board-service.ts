import { prisma } from "./prisma";
import { INHOUSE, INHOUSE_ACTIVE_STATUSES } from "./constants";
import {
  deleteWebhookMessage,
  getInhouseWebhookUrl,
  maskWebhookUrl,
  patchWebhookMessage,
  postWebhookMessage,
  webhookIdOf,
} from "./discord";
import { queuePresence } from "./inhouse";
import {
  boardStateLabel,
  renderBoard,
  type BoardSnapshot,
} from "./inhouse-board";
import { claimThrottle, getSetting, SETTING_KEYS, setSetting } from "./settings";
import { resolveSiteUrl } from "./site-url";

// The pinned Discord queue board — one message, rewritten in place forever.
//
// Shaped like reminder-service.ts / honors-service.ts: guards and claims in a
// service, the rendering pure next door, the network best-effort and unable to
// throw into a caller. Two rules make it safe to hang off a 1.5s poll:
//
//  1. THE SETTING ROW IS THE ON/OFF SWITCH. No row = feature off, and the cost
//     of "off" is a single primary-key read. There is no separate toggle to
//     drift out of sync with the message that actually exists in Discord.
//  2. NOTHING HAPPENS UNLESS THE RENDER CHANGED. The digest gate means a
//     motionless queue performs zero writes and zero requests, so the common
//     case — nobody queued, all night — is free.

type BoardState = {
  /** Which webhook posted it. An admin swapping channels strands the old
   *  message; we detect that here rather than editing a stranger's channel. */
  webhookId: string;
  messageId: string;
  /** Render digest of what the message currently SAYS. */
  digest: string;
  /** ISO of the last edit Discord actually ACCEPTED. Deliberately not the
   *  throttle timestamp: that one is stamped when the claim is won, i.e.
   *  BEFORE the request, so it keeps looking healthy while every edit fails —
   *  the exact situation the admin card exists to reveal. */
  lastOkAt?: string;
  /** Consecutive failed edits since the last success (AutoSyncHealth's rule:
   *  a silently parked automation must be visible as parked). */
  failures?: number;
};

function parseState(raw: string | null): BoardState | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<BoardState>;
    if (
      typeof v.webhookId === "string" &&
      typeof v.messageId === "string" &&
      typeof v.digest === "string"
    ) {
      return {
        webhookId: v.webhookId,
        messageId: v.messageId,
        digest: v.digest,
        lastOkAt: typeof v.lastOkAt === "string" ? v.lastOkAt : undefined,
        failures: typeof v.failures === "number" ? v.failures : 0,
      };
    }
  } catch {
    // Corrupt row — treat as no board rather than crashing a poll.
  }
  return null;
}

async function clearState(): Promise<void> {
  await setSetting(SETTING_KEYS.INHOUSE_BOARD, "");
}

/**
 * Clear the board row only if it still holds `expected` — the guarded twin of
 * clearState, for the paths that decide to drop the board BEFORE a network
 * round trip and act on it after. An unconditional delete there would throw
 * away a board an admin posted in the meantime.
 */
async function clearStateIf(expected: string): Promise<void> {
  await prisma.setting.deleteMany({
    where: { key: SETTING_KEYS.INHOUSE_BOARD, value: expected },
  });
}

/**
 * Compare-and-swap the board row: write `next` only if the row still holds
 * exactly `expected`. A blind upsert here would RESURRECT a board an admin
 * removed during the (up to 2.5s) PATCH round trip — the row is read before
 * the request and written after it, so this is the repo's standard guarded
 * claim rather than a read-modify-write.
 */
async function swapState(expected: string, next: BoardState): Promise<void> {
  await prisma.setting.updateMany({
    where: { key: SETTING_KEYS.INHOUSE_BOARD, value: expected },
    data: { value: JSON.stringify(next) },
  });
}

/**
 * Read the current queue/lobby into a render snapshot. Only ever called once
 * the board is known to be ON, so an unconfigured league never pays for it.
 */
export async function loadBoardSnapshot(
  nowMs: number = Date.now(),
): Promise<BoardSnapshot> {
  const [queue, lobby] = await Promise.all([
    prisma.inhouseQueueEntry.findMany({
      orderBy: { joinedAt: "asc" },
      select: { lastSeenAt: true, user: { select: { name: true } } },
    }),
    prisma.inhouseLobby.findFirst({
      where: { status: { in: INHOUSE_ACTIVE_STATUSES } },
      select: {
        status: true,
        startedAt: true,
        players: { select: { acceptedAt: true } },
      },
    }),
  ]);
  const present = queue.filter(
    (q) => queuePresence(q.lastSeenAt.getTime(), nowMs) === "present",
  );
  return {
    presentNames: present.map((q) => q.user.name),
    awayCount: queue.length - present.length,
    lobbySize: INHOUSE.LOBBY_SIZE,
    lobby: lobby
      ? {
          status: lobby.status,
          acceptedCount: lobby.players.filter((p) => p.acceptedAt != null)
            .length,
          playerCount: lobby.players.length,
          startedAtMs: lobby.startedAt ? lobby.startedAt.getTime() : null,
        }
      : null,
    siteUrl: resolveSiteUrl(),
    nowMs,
  };
}

/**
 * Bring the board in line with reality. Safe to call on any hot path — it is
 * a no-op (one PK read) when the board isn't set up, and a second no-op when
 * the rendered state hasn't moved.
 *
 * Pass `snapshot` from a caller that already loaded the queue (getInhouseState
 * has all of it in hand) to avoid re-querying; omit it elsewhere.
 */
export async function syncInhouseBoard(
  snapshot?: BoardSnapshot,
): Promise<void> {
  const raw = await getSetting(SETTING_KEYS.INHOUSE_BOARD);
  const state = parseState(raw);
  if (!state || !raw) return; // off — the cheap exit, taken on almost every call

  const url = await getInhouseWebhookUrl();
  // No webhook configured: leave the row alone. The admin may be mid-rotation,
  // and dropping the board here would silently orphan a live message (same
  // rule as never burning an announcement marker when Discord isn't wired up).
  if (!url) return;
  if (webhookIdOf(url) !== state.webhookId) {
    // Different channel now. The old message is stranded where we can no
    // longer edit it; forget it rather than write into the wrong place.
    await clearStateIf(raw);
    return;
  }

  const snap = snapshot ?? (await loadBoardSnapshot());
  const { digest, embed } = renderBoard(snap);
  if (digest === state.digest) return; // nothing changed — no request, no write

  // Spam floor. Losing the claim is fine and self-correcting: the digest still
  // differs, so the next poll tries again. That retry-on-difference property is
  // what stands in for a debounce timer, which serverless has nowhere to run —
  // three joins in four seconds collapse into one edit now and (at most) one
  // more after the cooldown, converging on the true state instead of dropping
  // the tail of the burst.
  if (
    !(await claimThrottle(
      SETTING_KEYS.INHOUSE_BOARD_AT,
      INHOUSE.BOARD_MIN_SECONDS,
      snap.nowMs,
    ))
  ) {
    return;
  }

  const res = await patchWebhookMessage(url, state.messageId, { embeds: [embed] });
  if (res === "ok") {
    await swapState(raw, {
      ...state,
      digest,
      lastOkAt: new Date(snap.nowMs).toISOString(),
      failures: 0,
    });
  } else if (res === "failed") {
    // Keep the OLD digest so the next poll retries, but record that it broke —
    // otherwise a board whose every edit is failing is indistinguishable from
    // a board with nothing to say.
    await swapState(raw, { ...state, failures: (state.failures ?? 0) + 1 });
  } else if (res === "gone") {
    // Somebody deleted the message (or the webhook died). Deleting the board in
    // Discord is the natural "turn it off" gesture, so we stop rather than
    // re-post — a self-resurrecting message would be exactly the channel spam
    // this feature exists to avoid. The admin card shows it as not posted.
    // Guarded: an admin can post a fresh board during the round trip, and this
    // 404 is about the OLD message, not that one.
    await clearStateIf(raw);
  }
}

/** Admin: post the board for the first time and start tracking it. */
export async function createInhouseBoard(): Promise<{
  ok: boolean;
  error?: string;
}> {
  const url = await getInhouseWebhookUrl();
  if (!url) return { ok: false, error: "Set a Discord webhook first" };
  const webhookId = webhookIdOf(url);
  if (!webhookId) {
    return { ok: false, error: "That webhook URL doesn't look like Discord's" };
  }

  const existing = parseState(await getSetting(SETTING_KEYS.INHOUSE_BOARD));
  if (existing && existing.webhookId === webhookId) {
    return { ok: false, error: "The board is already posted in that channel" };
  }

  const snap = await loadBoardSnapshot();
  const { digest, embed } = renderBoard(snap);
  const posted = await postWebhookMessage(url, { embeds: [embed] });
  if (!posted) {
    return { ok: false, error: "Discord rejected the message — check the webhook" };
  }
  await setSetting(
    SETTING_KEYS.INHOUSE_BOARD,
    JSON.stringify({ webhookId, messageId: posted.id, digest } satisfies BoardState),
  );
  return { ok: true };
}

/**
 * Admin: delete the board message and stop tracking it.
 *
 * Reports honestly, because the failure here is the worst one this feature
 * has: forget the row while the message still exists and it is orphaned —
 * un-editable, un-deletable, pinned forever at whatever count it last showed,
 * and the next "Post queue board" adds a SECOND board beside it.
 *
 * - Discord confirmed the delete (or it was already gone) → cleared, ok.
 * - Discord refused/timed out → row KEPT so the admin can just retry; the
 *   board carries on updating in the meantime, which beats a frozen orphan.
 * - `force` (the webhook is being changed or removed, so the credential is
 *   about to stop working): always clear, and report `orphaned` so the caller
 *   can tell the admin to delete the message by hand.
 */
export async function removeInhouseBoard(
  opts: { force?: boolean } = {},
): Promise<{ ok: boolean; orphaned?: boolean; error?: string }> {
  const state = parseState(await getSetting(SETTING_KEYS.INHOUSE_BOARD));
  if (!state) return { ok: true };

  // A board posted by a DIFFERENT webhook can't be deleted by this one — the
  // endpoint is scoped to the webhook that sent the message, so the request
  // would 404, which the transport (rightly) reads as "already gone". Don't
  // pretend: clear the row and say it's still in the old channel.
  const url = await getInhouseWebhookUrl();
  const stranded = !url || webhookIdOf(url) !== state.webhookId;

  const deleted = stranded ? false : await deleteWebhookMessage(url, state.messageId);
  if (!deleted && !stranded && !opts.force) {
    return {
      ok: false,
      error:
        "Discord didn't confirm the delete — the board is still live. Try again in a moment.",
    };
  }

  await clearState();
  // Drop the spam floor too, so a board posted again later paints its first
  // real change immediately instead of waiting out a window it never used.
  await setSetting(SETTING_KEYS.INHOUSE_BOARD_AT, "");
  return { ok: true, orphaned: !deleted };
}

/**
 * Admin-card view. Deliberately returns no credential and no full message id —
 * the webhook rule (never render the secret) extends to anything that would
 * help someone find the message from outside.
 */
export type InhouseBoardStatus = {
  posted: boolean;
  messageHint: string;
  /** True when the stored board belongs to a webhook that's no longer the
   *  configured one — it's stranded and needs re-creating. */
  stranded: boolean;
  /** ISO of the last edit Discord ACCEPTED (null = none since it was posted). */
  lastEdit: string | null;
  /** Consecutive failed edits — nonzero means the channel is showing a number
   *  the site already knows is wrong. */
  failures: number;
  /** What the queue actually is right now, e.g. "4/10 queued". */
  liveState: string;
  /** False when the board is rendering something other than `liveState` —
   *  either an edit is pending its throttle window, or edits are failing. */
  inSync: boolean;
  /** True when inhouse has its OWN webhook, i.e. its own Discord channel. */
  separateChannel: boolean;
  /** Masked fingerprint of that webhook — never the credential itself. */
  inhouseMasked: string;
};

export async function getInhouseBoardStatus(): Promise<InhouseBoardStatus> {
  const [state, url, own] = await Promise.all([
    getSetting(SETTING_KEYS.INHOUSE_BOARD).then(parseState),
    getInhouseWebhookUrl(),
    getSetting(SETTING_KEYS.INHOUSE_WEBHOOK_URL),
  ]);
  const separateChannel = !!own || !!process.env.DISCORD_INHOUSE_WEBHOOK_URL;
  // The masked form is all the browser is ever allowed to see (the raw URL is
  // a bearer credential — anyone holding it can post to the channel).
  const inhouseMasked = separateChannel ? maskWebhookUrl(url) : "";
  if (!state) {
    return {
      posted: false,
      messageHint: "",
      stranded: false,
      lastEdit: null,
      failures: 0,
      liveState: "",
      inSync: true,
      separateChannel,
      inhouseMasked,
    };
  }
  // Render the live queue so the card can answer the only question that
  // matters about a board — "is it lying right now?" — instead of just
  // confirming a row exists.
  const snap = await loadBoardSnapshot();
  return {
    posted: true,
    messageHint:
      state.messageId.length > 6
        ? `${state.messageId.slice(0, 4)}…${state.messageId.slice(-2)}`
        : state.messageId,
    stranded: !!url && webhookIdOf(url) !== state.webhookId,
    lastEdit: state.lastOkAt ?? null,
    failures: state.failures ?? 0,
    liveState: boardStateLabel(snap),
    inSync: renderBoard(snap).digest === state.digest,
    separateChannel,
    inhouseMasked,
  };
}
