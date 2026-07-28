/**
 * Payload ordering for the two live rooms, as a pure fold.
 *
 * THE RULE: order responses by when their request STARTED, never by when it
 * arrived. Both rooms fire polls and mutations at the same endpoint, and a poll
 * that left BEFORE a mutation can easily land after it — `/api/inhouse` answers
 * mutations with `syncBoard: false`, so the mutation returns fast while the poll
 * behind it may still be blocked on the Discord board edit. Applying that older
 * payload put the drafted player back in the pool, flipped `isOnClock` true
 * again — re-firing the chime and the "(!) Your pick" title — and the captain
 * re-clicked into an error toast while their real 60s clock burned.
 *
 * That re-firing is the second-order damage and the reason this is not
 * cosmetic: both rooms derive their alerts by DIFFING successive payloads and
 * then advancing a `prev` snapshot (see inhouseAlerts / the draft's feed
 * effect). One accepted stale payload therefore paints stale AND writes a bogus
 * "previous" for the next genuine poll to be compared against.
 *
 * Never key the ordering off the payload's own `now`: that is per-instance
 * wall-clock and skews between serverless instances.
 *
 * WHY IT LIVES HERE. Both rooms carried a byte-identical copy of this gate and
 * nothing kept them in step (CLAUDE.md's "the draft room has the same three,
 * keep them in step" was the only thing holding it). The vitest project is
 * `environment: node` with no jsdom, so neither copy could be asserted, and no
 * browser spec can produce the interleaving on purpose — it is timing-
 * dependent, so an accidental one would flake rather than fail.
 *
 * WHAT STAYS IN THE COMPONENT: where the counter is kept. It is a `useRef` per
 * room INSTANCE, resetting with the room's `state` on remount — which is what
 * makes a reset safe (a fresh counter can never meet a payload from the
 * previous mount, because that fetch's closure targets an unmounted tree). This
 * must never become a module-level singleton, a context, or a hook in a .tsx
 * file — that last one would put the rule right back where no test can reach
 * it, which is the trap the extraction exists to avoid.
 */

export type RoomSequence = {
  /** Highest number handed out, at request START. 0 = nothing issued yet. */
  readonly issued: number;
  /** Number of the payload currently painted. 0 = nothing applied yet. */
  readonly applied: number;
};

export const ROOM_SEQUENCE_START: RoomSequence = { issued: 0, applied: 0 };

/**
 * Take the next number, at the moment a request is about to leave.
 *
 * `issued` grows without bound and deliberately never wraps: a modulo would
 * introduce a real ordering bug (a wrapped low number would be rejected
 * forever) in exchange for a hazard that cannot occur — at the fast cadence a
 * tab polls ~40/min, and the counter resets on remount regardless.
 */
export function issueSequence(prev: RoomSequence): {
  seq: number;
  next: RoomSequence;
} {
  const seq = prev.issued + 1;
  return { seq, next: { issued: seq, applied: prev.applied } };
}

/**
 * May this settled response paint? Older-than-applied loses; anything else
 * wins and becomes the new high-water mark.
 *
 * Requests that mint a number and never paint — a 429, a non-ok response, an
 * aborted fetch, the draft's terminal 404, a rejected mutation — simply leave a
 * gap. That is safe, and it is safe BECAUSE of the clamp here: `applied` only
 * ever moves forward, so every later request is issued strictly above it and
 * can never be born already-stale. Do not try to reclaim a burned number.
 */
export function acceptSequence(
  prev: RoomSequence,
  seq: number,
): { accept: boolean; next: RoomSequence } {
  if (seq < prev.applied) return { accept: false, next: prev };
  return { accept: true, next: { issued: prev.issued, applied: seq } };
}

/** How many times a room may fetch before it has ever painted. */
export const COLD_START_ATTEMPTS = 3;

/**
 * Has this room yet to learn anything about its viewer?
 *
 * Both rooms decide whether a HIDDEN tab is worth polling from `hasStake`,
 * which they learn FROM a payload — so before the first one it is `false` for
 * everybody, and a tab that is hidden at load (cmd-clicked, or restored with
 * the session) would skip forever: no keepalive, no tab-title flag, no chime,
 * until the player happened to look at it.
 *
 * Bounded on purpose. "Until a payload lands" would leave an offline hidden
 * tab retrying at the idle rate forever; "one attempt" is defeated by a single
 * 429 from a shared IP, which is exactly the household case this endpoint sees.
 * A handful of tries costs nothing and covers both.
 */
export function isColdStart(
  s: RoomSequence,
  attempts: number = COLD_START_ATTEMPTS,
): boolean {
  return s.applied === 0 && s.issued < attempts;
}
