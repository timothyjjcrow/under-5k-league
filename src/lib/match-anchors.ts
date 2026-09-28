/**
 * In-page targets on /matches/[id]. The page's element ids and every link that
 * lands on one (Discord messages, the dashboard, /schedule) read them from
 * here, so a renamed card can't silently turn a deep link into "top of page".
 */
export const MATCH_ANCHOR = {
  /** The Captain tools section (its heading). */
  tools: "match-tools",
  /** Lobby setup and result reporting, inside Captain tools. */
  report: "match-report",
  /** The Reschedule card (a spectator's pending-time strip too). */
  reschedule: "match-reschedule",
  /** The captain's Standins card. */
  standins: "match-standins",
} as const;

/** `/matches/<id>#<anchor>` — a site-relative link to one card. */
export function matchAnchorPath(
  matchId: string,
  anchor: (typeof MATCH_ANCHOR)[keyof typeof MATCH_ANCHOR],
): string {
  return `/matches/${matchId}#${anchor}`;
}
