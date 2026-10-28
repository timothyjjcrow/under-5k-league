// The lobby bot's side of a 1v1 duel, as the duel engine sees it: what the
// bot knows about a duel's lobby, asking it to make one, and letting it go
// when a duel closes. The duel's job key, spec and transport are
// dota-lobby-service.ts's (`duel:<id>:1`, duelLobbySpec, callLobbyBot), so a
// duel's lobby is the same job the panel's buttons address.
//
// Where the engine calls these:
//   - duelBotGameStatus: the worker's bot read (runDuelWorkerSteps: started
//     -> markDuelStartedFromBot, over -> endDuelFromBot, a job released with
//     no game -> cancelDuelFromBot), and finishDuel's unlaunched-lobby check.
//   - createDuelBotLobby: after a join pairs two players (runAfterResponse,
//     after the commit and publish), and the worker's retry for the oldest
//     READY duel with no bot lobby, once per pass.
//   - releaseDuelBotAfterClose: after the commit of every path that closes a
//     duel or ends its game (call off, admin cancel, the give-ups, the bot
//     cancel, "1v1 over", the bot's over read, a result, a void).
// None of them runs inside a transaction or a room poll, and none throws.

import { prisma } from "./prisma";
import { INHOUSE_DUEL_STATUS } from "./constants";
import {
  DUEL_BOT_SAVING_5V5_STATUSES,
  duelBotLobbyMissing,
  duelBotSavedFor5v5,
} from "./inhouse-duel";
import {
  boundedBotStatus,
  callLobbyBot,
  duelLobbySpec,
  freeBotFromClosedInhouseGame,
  inhouseLobbyTicketId,
  LobbyBotBusyError,
  lobbyBotConnection,
  releaseDuelBotLobby,
  type DuelSpecDuel,
} from "./dota-lobby-service";
import { trackBotRelease } from "./lobby-bot-releases";
import type { DotaLobbyStatus } from "./dota-lobby";
import type { OpenDotaFetchOptions } from "./dota";

/** The duel facts the bot's lobby plan needs (one playing account per side). */
export type DuelBotSpec = DuelSpecDuel;

/** The columns a duel's bot spec is built from (with its status). */
export const DUEL_BOT_SPEC_SELECT = {
  id: true,
  status: true,
  radiantUser: {
    select: {
      id: true,
      name: true,
      steamId: true,
      dotaAccountIdV2: true,
      legacyDotaAccountId: true,
    },
  },
  direUser: {
    select: {
      id: true,
      name: true,
      steamId: true,
      dotaAccountIdV2: true,
      legacyDotaAccountId: true,
    },
  },
} as const;

/** Is a lobby bot configured at all? Never throws (a bad config is "no"). */
function botConfigured(): boolean {
  try {
    return lobbyBotConnection() !== null;
  } catch {
    return false;
  }
}

/**
 * What the lobby bot knows about this duel's lobby, or null (no bot, an
 * unreachable one, too little of the caller's deadline left, or a player
 * with no usable Dota account). One status read bounded like the 5v5
 * worker's (inhouseBotGameStatus), never from the cache. Never throws, never
 * creates or changes a lobby.
 */
export async function duelBotGameStatus(
  duel: DuelBotSpec,
  options: OpenDotaFetchOptions = {},
): Promise<DotaLobbyStatus | null> {
  return boundedBotStatus(() => duelLobbySpec(duel), options);
}

/**
 * Fire-and-forget: if the bot holds this duel's lobby, let it go. Called
 * after the commit that closed the duel (or ended its game), never inside a
 * transaction, and never awaited by the caller's response (the 5v5's
 * releaseInhouseBotAfterClose, for the duel's key). A no-op when no bot is
 * configured, before any database read. A release the bot has nothing to
 * leave for (a job it never made, or a game it already left) changes nothing.
 */
export function releaseDuelBotAfterClose(duelId: string): void {
  if (!botConfigured()) return;
  trackBotRelease(
    releaseDuelBotLobby(duelId).then(
      () => {},
      () => {},
    ),
  );
}

/** Is the one bot saved for a 5v5 of this league being set up (duelBotSavedFor5v5)? */
export async function duelBotSavedForA5v5(): Promise<boolean> {
  const lobbies = await prisma.inhouseLobby.findMany({
    where: { status: { in: [...DUEL_BOT_SAVING_5V5_STATUSES] } },
    select: { status: true, startedAt: true },
  });
  return duelBotSavedFor5v5(lobbies);
}

/**
 * What createDuelBotLobby did: asked the bot (`created`: it accepted the
 * create), found it hosting another game (`busy`) or saved for a 5v5
 * (`saved`), nothing to do (`skipped`: no bot, no ticket, a duel no longer
 * READY), a duel whose spec can't be built (`unbuildable`: a player with no
 * usable Dota account), or a create that failed otherwise (`failed`).
 */
export type DuelCreateOutcome =
  | "created"
  | "busy"
  | "saved"
  | "skipped"
  | "unbuildable"
  | "failed";

/**
 * Ask the bot to make this duel's lobby (the bot invites both players, as
 * it does for a 5v5). Only for a READY duel, and not while the bot is saved
 * for a 5v5 being set up. A BUSY bot is quiet: the bot is freed from a game
 * the site has closed (Create's self-heal), and the worker retries next
 * pass. If the duel closed while the create was on its way, its lobby is
 * released again. Never inside a transaction or a room poll; never throws.
 */
export async function createDuelBotLobby(
  duelId: string,
  options: { signal?: AbortSignal } = {},
): Promise<DuelCreateOutcome> {
  try {
    if (!botConfigured() || inhouseLobbyTicketId() === null) return "skipped";
    const duel = await prisma.inhouseDuel.findUnique({
      where: { id: duelId },
      select: DUEL_BOT_SPEC_SELECT,
    });
    if (duel?.status !== INHOUSE_DUEL_STATUS.READY) return "skipped";
    if (await duelBotSavedForA5v5()) return "saved";
    let spec;
    try {
      spec = duelLobbySpec(duel);
    } catch {
      return "unbuildable";
    }
    try {
      await callLobbyBot(spec, "create", { signal: options.signal });
    } catch (error) {
      if (error instanceof LobbyBotBusyError) {
        // A closed game's hold: free the bot, so the next pass can create.
        await freeBotFromClosedInhouseGame("duel");
        return "busy";
      }
      return "failed";
    }
    // A call off, cancel or give-up landing meanwhile already sent its
    // release, possibly before this lobby existed: let it go again.
    const after = await prisma.inhouseDuel.findUnique({
      where: { id: duelId },
      select: { status: true },
    });
    if (after?.status !== INHOUSE_DUEL_STATUS.READY) releaseDuelBotAfterClose(duelId);
    return "created";
  } catch {
    return "failed";
  }
}

/**
 * The worker's create retry, once per pass: the oldest READY duel the bot
 * reported no lobby for (`idle`, or `released` before any game:
 * duelBotLobbyMissing), skipping only duels whose spec can't be built. `candidates` come in the worker's order (oldest first) with the
 * status it just read for each; a null status (no bot, unreachable) is never
 * a candidate. Returns the outcome of the one create it asked for, or null.
 */
export async function retryDuelBotCreate(
  candidates: readonly { id: string; status: string; bot: DotaLobbyStatus | null }[],
  options: { signal?: AbortSignal } = {},
): Promise<DuelCreateOutcome | null> {
  for (const c of candidates) {
    if (c.status !== INHOUSE_DUEL_STATUS.READY || !duelBotLobbyMissing(c.bot)) continue;
    const outcome = await createDuelBotLobby(c.id, options);
    if (outcome !== "unbuildable" && outcome !== "skipped") return outcome;
  }
  return null;
}
