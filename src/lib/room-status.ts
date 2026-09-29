// The live rooms' one status line.
//
// Both rooms used to stack a separate strip per condition (offline, connection
// lost, back online and checking, checking after an interrupted action, and in
// the draft also sign-in expired and updates delayed), each with its own
// wording and colour, and two could show at once when a connection dropped
// and came back. This picks ONE, by priority, so the room says the single
// thing that matters most right now. What each condition MEANS (when actions
// lock, what a 429 does, the terminal no-season card) stays with the rooms'
// poll loops; this only decides which sentence to show.

export type RoomConnectivity = "online" | "offline" | "resyncing";

export type RoomStatusKind =
  | "offline"
  | "disconnected"
  | "resyncing"
  | "reconciling"
  | "signed-out"
  | "delayed";

export type RoomStatus = {
  kind: RoomStatusKind;
  tone: "danger" | "warning" | "info";
  text: string;
  /**
   * A few words for a compact bar (the draft's sticky clock), set only while
   * the room's clocks are running on stale state.
   */
  short: string | null;
};

/** Each room's sentences. A room that never raises a condition omits it. */
export type RoomStatusCopy = Record<
  "offline" | "disconnected" | "resyncing" | "reconciling",
  string
> &
  Partial<Record<"signed-out" | "delayed", string>>;

export const DRAFT_ROOM_STATUS_COPY: RoomStatusCopy = {
  offline:
    "⚠️ You're offline — the auction keeps running on the server. Actions are paused until you reconnect and the current lot is confirmed.",
  disconnected:
    "⚠️ Connection lost — reconnecting… The auction keeps running on the server; actions are paused until we're back.",
  resyncing:
    "Connection restored — checking the current lot. Actions remain paused until the latest auction state arrives.",
  reconciling:
    "Checking the current live lot after an interrupted action. Controls will unlock when the server confirms the latest auction state.",
  "signed-out":
    "Your sign-in expired. You are watching as a visitor and cannot nominate, bid, or use admin controls.",
  delayed:
    "Live updates are delayed by traffic — the room is retrying at a slower pace. Check the lot before acting.",
};

export const INHOUSE_ROOM_STATUS_COPY: RoomStatusCopy = {
  offline:
    "⚠️ You're offline — the queue and lobby keep running on the server. Actions are paused until you reconnect and the current room is confirmed.",
  disconnected:
    "⚠️ Connection lost — reconnecting… The lobby keeps running on the server; actions are paused until we're back.",
  resyncing:
    "Connection restored — checking the current queue and lobby. Actions remain paused until the latest room state arrives.",
  reconciling:
    "Checking the current queue and lobby after an interrupted action. Controls will unlock when the server confirms the latest state.",
};

const TONE: Record<RoomStatusKind, RoomStatus["tone"]> = {
  offline: "danger",
  disconnected: "danger",
  resyncing: "info",
  reconciling: "info",
  "signed-out": "danger",
  delayed: "warning",
};

/**
 * The one condition to show, or null when the room is live and healthy.
 *
 * Priority, most important first:
 * 1. offline: nothing else can be fixed until the network is back.
 * 2. disconnected (the poll failed several times in a row): more accurate
 *    than "connection restored" while the polls still fail.
 * 3. resyncing: back online, waiting for a fresh payload.
 * 4. reconciling: an action's outcome is unknown until the next poll.
 * 5. signed-out: the viewer can only watch until they sign in again.
 * 6. delayed (rate limited): the room still works, just slower.
 */
export function roomStatus(
  input: {
    connectivity: RoomConnectivity;
    disconnected: boolean;
    actionReconciling: boolean;
    sessionExpired?: boolean;
    syncDelayed?: boolean;
  },
  copy: RoomStatusCopy,
): RoomStatus | null {
  const kind: RoomStatusKind | null =
    input.connectivity === "offline"
      ? "offline"
      : input.disconnected
        ? "disconnected"
        : input.connectivity === "resyncing"
          ? "resyncing"
          : input.actionReconciling
            ? "reconciling"
            : input.sessionExpired && copy["signed-out"]
              ? "signed-out"
              : input.syncDelayed && copy.delayed
                ? "delayed"
                : null;
  if (!kind) return null;
  return {
    kind,
    tone: TONE[kind],
    text: copy[kind] ?? "",
    short:
      kind === "offline"
        ? "⚠ offline"
        : kind === "disconnected" || kind === "resyncing"
          ? "⚠ reconnecting…"
          : null,
  };
}
