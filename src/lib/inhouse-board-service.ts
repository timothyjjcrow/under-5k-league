import { prisma } from "./prisma";
import {
  INHOUSE,
  INHOUSE_ACTIVE_STATUSES,
  INHOUSE_STATUS,
} from "./constants";
import {
  deleteWebhookMessage,
  getInhouseAlertWebhookUrl,
  getInhousePingRoleId,
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
  type BoardStats,
} from "./inhouse-board";
import { gameMvp } from "./achievements";
import { heroById } from "./heroes";
import { rankInhouse, summarizeInhouse, type FinishedLobby } from "./inhouse-stats";
import { claimThrottle, getSetting, SETTING_KEYS, setSetting } from "./settings";
import { raceHook } from "./race-hook";
import { resolveSiteUrl } from "./site-url";
import { pingOptInAvailable } from "./discord-roles";

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
      // A row with no message id is a POSTING RESERVATION (see claimBoardRow),
      // not a board: there is nothing to edit yet. Treating it as live would
      // send the poll path PATCHing message "", which 404s and is read as
      // "gone" — deleting the claim out from under the request still posting.
      v.messageId !== "" &&
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
/**
 * Reserve the board row before talking to Discord, so only one concurrent
 * "Post queue board" can ever send a message. Returns the placeholder value it
 * wrote (the CAS token for the real write), or null if someone else holds it.
 * A row with an empty messageId is inert everywhere: syncInhouseBoard's
 * parseState requires a non-empty messageId to attempt an edit.
 */
async function claimBoardRow(webhookId: string): Promise<string | null> {
  const placeholder = JSON.stringify({
    webhookId,
    messageId: "",
    digest: `posting:${webhookId}`,
  } satisfies BoardState);
  try {
    await prisma.setting.create({
      data: { key: SETTING_KEYS.INHOUSE_BOARD, value: placeholder },
    });
    return placeholder;
  } catch (e) {
    if ((e as { code?: string }).code !== "P2002") throw e;
  }
  // A row exists. Taking it over is legitimate ONLY when it is a settled board
  // in a different channel (the "move the board" case the caller validated
  // above). If it is another request's RESERVATION — a placeholder with no
  // message id yet — stand down: taking that over means both of us post, and
  // the loser's board is orphaned in Discord, pinned and unreachable forever.
  // That is the worst end state this feature has, and it is precisely what
  // this function exists to prevent.
  const current = await prisma.setting.findUnique({
    where: { key: SETTING_KEYS.INHOUSE_BOARD },
  });
  if (!current) return null;
  try {
    const raw = JSON.parse(current.value) as Partial<BoardState>;
    if (raw.messageId === "") return null; // someone else is mid-post
    // RE-ASSERT the caller's "already posted in that channel" check here. It
    // was evaluated before this request's Discord round trip, so a rival post
    // that COMPLETED in the gap would otherwise be taken over and posted
    // again — two boards in one channel, the second overwriting the first's
    // id and orphaning it.
    if (raw.webhookId === webhookId) return null;
  } catch {
    // Unparseable row — nothing to protect, fall through and take it.
  }
  // Seam: both checks above judge a row read one round trip ago, so the CAS
  // below is what actually decides the takeover. The rival that matters is
  // another admin's post COMPLETING in this gap: the row it leaves behind is
  // either its reservation or its finished board, and taking either over means
  // BOTH of us send a message — the loser's pinned in Discord, un-editable and
  // un-deletable forever, which is the worst end state this feature has.
  // Nothing here is inside a transaction. See src/lib/race-hook.ts.
  await raceHook("inhouseBoard.claimBoardRow.beforeTakeover");
  const swapped = await prisma.setting.updateMany({
    where: { key: SETTING_KEYS.INHOUSE_BOARD, value: current.value },
    data: { value: placeholder },
  });
  return swapped.count > 0 ? placeholder : null;
}

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
): Promise<BoardSnapshotInput> {
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
        acceptEndsAt: true,
        players: {
          select: { acceptedAt: true, user: { select: { name: true } } },
        },
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
    lobby: lobby ? lobbyView(lobby) : null,
    siteUrl: resolveSiteUrl(),
    nowMs,
  };
}

/** The board snapshot minus `stats`, which only the empty render needs and
 *  which syncInhouseBoard loads for itself (see resolveSnapshot). */
export type BoardSnapshotInput = Omit<BoardSnapshot, "stats" | "pingOptIn">;

type LobbyRow = {
  status: string;
  startedAt: Date | null;
  acceptEndsAt: Date | null;
  players: { acceptedAt: Date | null; user: { name: string } }[];
};

/** Shared by loadBoardSnapshot and getInhouseState so the two can never drift
 *  into describing the same lobby differently. */
export function lobbyView(l: LobbyRow): NonNullable<BoardSnapshot["lobby"]> {
  return {
    status: l.status,
    acceptedCount: l.players.filter((p) => p.acceptedAt != null).length,
    playerCount: l.players.length,
    startedAtMs: l.startedAt ? l.startedAt.getTime() : null,
    acceptEndsAtMs: l.acceptEndsAt ? l.acceptEndsAt.getTime() : null,
    acceptedNames: l.players
      .filter((p) => p.acceptedAt != null)
      .map((p) => p.user.name),
    pendingNames: l.players
      .filter((p) => p.acceptedAt == null)
      .map((p) => p.user.name),
  };
}

// --- Proof-of-life for the empty state --------------------------------------
// Only the EMPTY render uses these, and that render is ~95% of polls, so the
// read is memoised in-process on a TTL (the session-epoch.ts pattern) rather
// than run per poll. The ladder in particular must scan ALL completed lobbies
// because Elo accumulates over full history. 60s of staleness is invisible
// here: every figure is either all-time or a finished result, and the board
// repaints on the live→empty transition anyway.
const STATS_TTL_MS = 60_000;
let statsCache: { at: number; value: BoardStats } | null = null;

export async function loadBoardStats(
  nowMs: number = Date.now(),
): Promise<BoardStats> {
  if (statsCache && nowMs - statsCache.at < STATS_TTL_MS) return statsCache.value;

  const [last, lobbiesPlayed, ladderRows] = await Promise.all([
    prisma.inhouseLobby.findFirst({
      where: { status: INHOUSE_STATUS.COMPLETED },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        winnerTeam: true,
        radiantTeam: true,
        radiantScore: true,
        direScore: true,
        updatedAt: true,
        boxScore: true,
      },
    }),
    prisma.inhouseLobby.count({ where: { status: INHOUSE_STATUS.COMPLETED } }),
    prisma.inhouseLobby.findMany({
      where: { status: INHOUSE_STATUS.COMPLETED },
      select: {
        id: true,
        winnerTeam: true,
        createdAt: true,
        players: {
          select: { userId: true, team: true, user: { select: { name: true } } },
        },
      },
    }),
  ]);

  let mvpName: string | null = null;
  let mvpHero: string | null = null;
  if (last?.boxScore) {
    try {
      // Mirrors BoxScorePlayer in inhouse-service (the shape applyResult stores).
      const box = JSON.parse(last.boxScore) as {
        userId: string | null;
        name: string | null;
        isRadiant: boolean;
        heroId: number;
        kills: number;
        deaths: number;
        assists: number;
        netWorth: number | null;
      }[];
      const radiantWin = last.winnerTeam === last.radiantTeam;
      const id = gameMvp(box, radiantWin);
      const line = id ? box.find((b) => b.userId === id) : null;
      mvpName = line?.name ?? null;
      mvpHero = line ? (heroById(line.heroId)?.name ?? null) : null;
    } catch {
      // Malformed box score — show the result without an MVP, never a guess.
    }
  }

  const finished: FinishedLobby[] = ladderRows.map((l) => ({
    id: l.id,
    winnerTeam: l.winnerTeam,
    createdAt: l.createdAt,
    players: l.players.map((p) => ({
      userId: p.userId,
      name: p.user.name,
      avatar: null,
      team: p.team,
    })),
  }));
  // rankInhouse drops provisionals — never crown someone with <5 games.
  const top = rankInhouse(summarizeInhouse(finished)).ranked[0] ?? null;

  const value: BoardStats = {
    lastLobbyId: last?.id ?? null,
    lastEndedAtMs: last ? last.updatedAt.getTime() : null,
    // Label the winning side from what was STORED, never inferred.
    lastWinnerSide:
      last && last.winnerTeam != null && last.radiantTeam != null
        ? last.winnerTeam === last.radiantTeam
          ? "Radiant"
          : "Dire"
        : null,
    lastRadiantScore: last?.radiantScore ?? null,
    lastDireScore: last?.direScore ?? null,
    mvpName,
    mvpHero,
    lobbiesPlayed,
    ladderName: top?.name ?? null,
    ladderRating: top ? Math.round(top.rating) : null,
  };
  statsCache = { at: nowMs, value };
  return value;
}

/** Test seam — the TTL cache is module state. */
export function resetBoardStatsCache(): void {
  statsCache = null;
}

/** Stats are loaded ONLY for the empty render, so an active queue never pays
 *  for them and a board that is off never reaches here at all. */
async function resolveSnapshot(
  base: BoardSnapshotInput,
): Promise<BoardSnapshot> {
  const empty = !base.lobby && base.presentNames.length === 0;
  // Both extras are only consulted for the EMPTY render — the state that has
  // room for them and the one people actually read.
  const [stats, pingOptIn] = await Promise.all([
    empty ? loadBoardStats(base.nowMs) : Promise.resolve(null),
    empty ? pingOptInAvailable() : Promise.resolve(false),
  ]);
  return { ...base, stats, pingOptIn };
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
  snapshot?: BoardSnapshotInput,
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

  const snap = await resolveSnapshot(snapshot ?? (await loadBoardSnapshot()));
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

  const snap = await resolveSnapshot(await loadBoardSnapshot());
  const { digest, embed } = renderBoard(snap);
  // CLAIM THE ROW BEFORE POSTING, not after. The "already posted" check above
  // sits a multi-second Discord round trip away from the write, so a double
  // submit (or two admins) posted TWO boards and the second setSetting
  // silently overwrote the first's messageId — orphaning a pinned board that
  // can never be edited or deleted again, which is the worst end state this
  // feature has. Claiming first means the loser never reaches Discord.
  const claimed = await claimBoardRow(webhookId);
  if (!claimed) {
    return { ok: false, error: "A board is already being posted — reload to see it" };
  }
  const posted = await postWebhookMessage(url, { embeds: [embed] });
  if (!posted) {
    // Release the placeholder so a retry isn't locked out by our own claim.
    await prisma.setting.deleteMany({
      where: { key: SETTING_KEYS.INHOUSE_BOARD, value: claimed },
    });
    return { ok: false, error: "Discord rejected the message — check the webhook" };
  }
  await swapState(
    claimed,
    { webhookId, messageId: posted.id, digest } satisfies BoardState,
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
  /** True when alerts have their OWN channel, so the board's channel holds
   *  nothing but the board. */
  alertsSeparate: boolean;
  alertsMasked: string;
  /** Role pinged by the two interrupting inhouse messages; null = nothing
   *  in the integration notifies anyone. Not a secret — a role id is public
   *  to anyone in the server. */
  pingRoleId: string | null;
};

export async function getInhouseBoardStatus(): Promise<InhouseBoardStatus> {
  const [state, url, own, pingRoleId, alertOwn, alertUrl] = await Promise.all([
    getSetting(SETTING_KEYS.INHOUSE_BOARD).then(parseState),
    getInhouseWebhookUrl(),
    getSetting(SETTING_KEYS.INHOUSE_WEBHOOK_URL),
    getInhousePingRoleId(),
    getSetting(SETTING_KEYS.INHOUSE_ALERT_WEBHOOK_URL),
    getInhouseAlertWebhookUrl(),
  ]);
  const alertsSeparate =
    !!alertOwn || !!process.env.DISCORD_INHOUSE_ALERT_WEBHOOK_URL;
  const alertsMasked = alertsSeparate ? maskWebhookUrl(alertUrl) : "";
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
      alertsSeparate,
      alertsMasked,
      pingRoleId,
    };
  }
  // Render the live queue so the card can answer the only question that
  // matters about a board — "is it lying right now?" — instead of just
  // confirming a row exists.
  const snap = await resolveSnapshot(await loadBoardSnapshot());
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
    alertsSeparate,
    alertsMasked,
    pingRoleId,
  };
}
