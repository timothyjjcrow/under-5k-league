// What the scrim pages tell captains to do. Pure: plain values in, copy out.

import { SCRIM_STATUS } from "./constants";
import { seriesLobbyRule } from "./match-hosting";
import { SCRIM_PAST_GRACE_MS } from "./scrim-window";

/**
 * The one line on a booked scrim that settles who makes the lobby. The
 * posting team hosts — the same rule the "claimed" ping gives its captain —
 * so neither captain has to ask. Region is LEAGUE_CONFIG.gameServerRegion,
 * never a hard-coded one.
 */
export function scrimHostLine(m: {
  hostTeamName: string;
  hostCaptainName: string;
  opponentCaptainName: string;
  bestOf: number;
  region: string;
}): string {
  return `${m.hostCaptainName} (${m.hostTeamName}) hosts: make the Dota lobby on ${m.region} and send ${m.opponentCaptainName} the lobby name and password on Discord. ${seriesLobbyRule(m.bestOf)}.`;
}

export type ScrimJoinCheck =
  | { canJoin: true; teamName: string }
  | { canJoin: false; reason: string; signIn?: true };

/**
 * Whether the viewer can claim this OPEN scrim time, and if not, why — the
 * open scrim's own page shows the Join button or this one line, so a captain
 * never stares at a page with no control and no explanation. It mirrors
 * joinScrim's refusals in the order a viewer can do something about them;
 * the service still re-checks everything inside its transaction. Null when
 * the scrim is not OPEN (there is nothing to claim).
 */
export function scrimJoinCheck(m: {
  status: string;
  seasonOpen: boolean;
  signedIn: boolean;
  /** The viewer's own team in this season, when they captain one. */
  viewerTeam: { id: string; name: string; withdrawn: boolean } | null;
  hostTeamId: string;
  hostWithdrawn: boolean;
  scheduledAtMs: number;
  nowMs: number;
  /** "the A vs B scrim on …" or "a league match": what the viewer's team
   *  already has within four hours of this time, when it has one. */
  viewerTeamClash?: string | null;
}): ScrimJoinCheck | null {
  if (m.status !== SCRIM_STATUS.OPEN) return null;
  const no = (reason: string): ScrimJoinCheck => ({ canJoin: false, reason });
  if (!m.seasonOpen) {
    return no("This season is over, so its scrim times can't be claimed.");
  }
  if (m.scheduledAtMs < m.nowMs - SCRIM_PAST_GRACE_MS) {
    return no("This time has passed, so it can't be claimed.");
  }
  if (m.hostWithdrawn) {
    return no("The team that posted this time has withdrawn from the league.");
  }
  if (!m.signedIn) {
    return {
      canJoin: false,
      reason: "Sign in as a team captain to claim this time.",
      signIn: true,
    };
  }
  if (!m.viewerTeam) {
    return no("Only a team captain can claim a scrim time.");
  }
  if (m.viewerTeam.id === m.hostTeamId) {
    return no(
      "This is your team's time. A captain from another team can claim it.",
    );
  }
  if (m.viewerTeam.withdrawn) {
    return no("Your team has withdrawn, so it can't book scrims.");
  }
  if (m.viewerTeamClash) {
    return no(
      `${m.viewerTeam.name} already has ${m.viewerTeamClash} within four hours of this time.`,
    );
  }
  return { canJoin: true, teamName: m.viewerTeam.name };
}
