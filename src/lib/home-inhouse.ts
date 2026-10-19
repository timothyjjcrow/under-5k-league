/**
 * Whether Home's inhouse queue line (src/components/home/inhouse-strip.tsx)
 * leads the page, right under the inhouse night's bar, instead of keeping its
 * usual place after the phase's sections (a side-game tile mid-season).
 *
 * It leads while anyone is queued: players looking for a game is the one
 * inhouse fact a visitor can act on now, and its usual place is below the
 * news on a phone. An empty queue keeps that place. While the planned night
 * is on, the night's bar at the top already prints the queue count and "Join
 * the queue", so the line stays put rather than saying it twice.
 */
export function inhouseQueueLeadsHome(line: {
  queued: number;
  nightOn: boolean;
}): boolean {
  return line.queued > 0 && !line.nightOn;
}
