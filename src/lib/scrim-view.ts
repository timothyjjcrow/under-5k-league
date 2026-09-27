// What the scrim pages tell captains to do. Pure: plain values in, copy out.

import { seriesLobbyRule } from "./match-hosting";

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
