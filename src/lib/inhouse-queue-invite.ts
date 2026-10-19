/**
 * The inhouse queue's invite link (Tim, 2026-10-19): one link anyone can
 * paste in Discord or anywhere else, and opening it joins the queue in one
 * tap. It is the room's `?join=1` (autoJoinDecision, inhouse-room.tsx), the
 * link every Discord ping and the night's "Join the queue" already carry.
 * /inhouse's "Copy queue link" under the queue copies it, a signed-out
 * "Sign in to queue" comes back to it, and its preview shows the queue
 * (inhouseQueuePreviewText, and the picture OgInhouseQueueCard draws).
 */
export const INHOUSE_QUEUE_INVITE_PATH = "/inhouse?join=1";

/** Whether /inhouse was opened by the invite link (its `join` query value). */
export function isInhouseQueueInvite(
  join: string | null | undefined,
): boolean {
  return join === "1";
}

/**
 * The invite link's preview text: how full the queue is, whether a game is
 * live, and what opening the link does. "Queued" is the present players,
 * as everywhere the queue is counted (queuePresentCutoff).
 */
export function inhouseQueuePreviewText(input: {
  queued: number;
  lobbySize: number;
  liveGames: number;
}): { title: string; description: string } {
  const { queued, lobbySize, liveGames } = input;
  const needed = Math.max(0, lobbySize - queued);
  const live =
    liveGames > 1 ? `${liveGames} inhouse games are live` : "An inhouse is live";
  const tap = "Open this link to join the queue in one tap";
  if (queued === 0) {
    return liveGames > 0
      ? {
          title: `${live}: queue for the next game`,
          description: `${tap}. Ten in the queue start the next game, and captains draft the teams.`,
        }
      : {
          title: "Join the inhouse queue",
          description: `The queue is open: be the first in. ${tap}. Ten in the queue start a game, and captains draft the teams.`,
        };
  }
  const count = `${queued}/${lobbySize}`;
  const more =
    needed > 0
      ? `${needed} more ${needed === 1 ? "player starts" : "players start"} the ${liveGames > 0 ? "next " : ""}game`
      : "The queue is full: join now for the game after";
  return {
    title:
      liveGames > 0
        ? `${count} queued for the next inhouse`
        : `${count} in the inhouse queue: join them`,
    description: `${liveGames > 0 ? `${live}. ` : ""}${more}. ${tap}.`,
  };
}

/**
 * The picture's address for the invite link's preview. The `v` query is the
 * counts it shows, so a new count is a new address: Discord keeps a picture
 * by its address, and the same address would keep showing an old queue.
 * The route ignores it and draws what it reads.
 */
export function inhouseQueuePicturePath(
  route: "opengraph-image" | "twitter-image",
  counts: { queued: number; liveGames: number },
): string {
  return `/inhouse/queue/${route}?v=${counts.queued}-${counts.liveGames}`;
}
