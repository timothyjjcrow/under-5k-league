// The lobby bot's side of a 1v1 duel, as the duel engine sees it: what the
// bot knows about a duel's lobby, and letting it go when a duel closes.
//
// STAGE B fills these in over dota-lobby-service.ts (the duel lobby key, the
// relay, trackBotRelease). Until then the bot knows nothing about duels: the
// status read answers null (the scan falls back to the players' histories)
// and a release is a no-op. The engine already calls both at every point the
// bot matters, so wiring the bot changes no engine code:
//   - duelBotGameStatus: finishDuel's unlaunched-lobby refusal, and the
//     worker's bot read (runDuelWorkerSteps: started -> markDuelStartedFromBot,
//     over -> endDuelFromBot, a launch failure -> cancelDuelFromBot).
//   - releaseDuelBotAfterClose: after the commit of every path that closes a
//     duel or ends its game (call off, admin cancel, the give-ups, the bot
//     cancel, "1v1 over", the bot's over read, a result, a void).

import type { DotaLobbyStatus } from "./dota-lobby";
import type { OpenDotaFetchOptions } from "./dota";

/** The duel facts the bot's lobby plan needs (one Steam64 per side). */
export type DuelBotSpec = {
  id: string;
  radiantUser: { steamId: string };
  direUser: { steamId: string };
};

/**
 * What the lobby bot knows about this duel's lobby, or null (no bot, an
 * unreachable one, or a lobby it never hosted). Never throws, never creates
 * or changes a lobby. Stage B: read the duel key's status, bounded by the
 * caller's deadline, like inhouseBotGameStatus.
 */
export async function duelBotGameStatus(
  duel: DuelBotSpec,
  options: OpenDotaFetchOptions = {},
): Promise<DotaLobbyStatus | null> {
  void duel;
  void options;
  return null;
}

/**
 * Fire-and-forget: if the bot holds this duel's lobby key, let it go. Called
 * after the commit that closed the duel (or ended its game), never inside a
 * transaction, and never awaited by the caller's response. Stage B: the
 * releaseInhouseBotAfterClose pattern (trackBotRelease) for the duel key.
 */
export function releaseDuelBotAfterClose(duelId: string): void {
  void duelId;
}
