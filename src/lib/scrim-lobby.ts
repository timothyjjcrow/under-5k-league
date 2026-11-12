// How a booked scrim's Dota lobby is set up so its games record, and what
// each viewer of a scrim should do next. Pure: plain values in, copy out.
// The scrim page, /scrims, the Captains page and the claim ping all read
// these, so the steps can't drift between them.
//
// Why the steps exist: Valve publishes a private lobby's game only when the
// lobby carries a league ticket. Scrims hosted without one never reached
// OpenDota, so not one of US Season 2's first booked scrims was recorded.
// With this season's ticket the game also lands in the league feed, which
// records it on the scrim by itself (`recordScrimGamesFromFeed`).

import { SCRIM_STATUS } from "./constants";
import { seriesLobbyRule } from "./match-hosting";

/**
 * "4821": a short code from the scrim id, stable for the scrim's life, so
 * its lobby has a name players can type into Dota's Custom Lobbies search.
 * FNV-1a over the id; four digits, never a leading zero.
 */
export function scrimLobbyCode(scrimId: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < scrimId.length; i++) {
    hash ^= scrimId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return String(1000 + (hash % 9000));
}

/** The lobby's name: the league's name, "Scrim" and the scrim's code. */
export function scrimLobbyName(leagueName: string, scrimId: string): string {
  return `${leagueName} Scrim ${scrimLobbyCode(scrimId)}`;
}

/** Where the host makes the lobby, in the client's own words. */
export const SCRIM_LOBBY_PATH = "Dota 2 → Play Dota → Custom Lobbies → Create";
/** Where the host sets the ticket. */
export const SCRIM_TICKET_PATH = "Lobby Settings → League";
/** Where everyone else finds the lobby. */
export const SCRIM_JOIN_PATH = "Dota 2 → Play Dota → Custom Lobbies";

/**
 * The ticket step's explanation. With a ticket: pick it (by its id), and not
 * the in-house one a captain may also admin (US Season 1's final went in
 * under the in-house ticket and only an admin's scan found it). Without one:
 * say plainly that the games can't record, never "make your match history
 * public", which doesn't help a private lobby.
 */
export function scrimTicketNote(m: {
  leagueId: string | null;
  /**
   * LEAGUE_CONFIG.inhouseLeagueName, the ticket NOT to pick, or null while
   * the league has no in-house ticket (Europe's placeholder is not a name).
   */
  inhouseTicketName: string | null;
}): string {
  if (!m.leagueId) {
    return "This season has no Dota league ticket yet, so scrim games can't be recorded: Valve keeps a private lobby without a ticket off OpenDota. Play for practice until the league has its ticket.";
  }
  const notInhouse = m.inhouseTicketName ? `, not ${m.inhouseTicketName}` : "";
  return `Pick this season's league (ticket ${m.leagueId})${notInhouse}. Without this season's ticket the game is never recorded here: Valve keeps a private lobby without a ticket off OpenDota.`;
}

/**
 * Who hosts, and who takes over when the host can't pick the ticket. Only
 * the league's ticket admins see a ticket in Dota's League list.
 */
export function scrimHostNote(m: {
  hostCaptainName: string;
  hostTeamName: string;
  backupCaptainName: string;
}): { host: string; backup: string } {
  return {
    host: `${m.hostCaptainName} (${m.hostTeamName}) hosts`,
    backup: `Only the league's ticket admins can pick the ticket. If it isn't in your League list, ${m.backupCaptainName} hosts instead, or ask an admin to add you.`,
  };
}

/** Server, mode and how many lobbies, as one line. */
export function scrimMatchSettings(m: {
  region: string;
  mode: string;
  bestOf: number;
}): string {
  return `Server ${m.region} · ${m.mode} · ${seriesLobbyRule(m.bestOf)}`;
}

/**
 * How results reach a scrim, for its results card. Ticketed: each game shows
 * up by itself a few minutes after it ends (the league feed). Ticketless:
 * nothing records by itself.
 */
export function scrimRecordingLine(m: {
  hasTicket: boolean;
  status: string;
  gamesRecorded: number;
  kickoffPassed: boolean;
}): string {
  if (!m.hasTicket) {
    return "This season has no league ticket yet, so games don't record by themselves. If OpenDota has a game anyway, add it by its match ID.";
  }
  if (m.status === SCRIM_STATUS.LIVE) {
    return `${m.gamesRecorded === 1 ? "1 game" : `${m.gamesRecorded} games`} recorded. The next game shows up here by itself a few minutes after it ends, if its lobby had the ticket.`;
  }
  return m.kickoffPassed
    ? "Waiting for the first game. Games played with this season's ticket show up here by themselves, a few minutes after they end."
    : "Games played with this season's ticket show up here by themselves, a few minutes after they end. Nobody needs to press anything.";
}

export type ScrimViewerRole =
  | "host-captain"
  | "away-captain"
  | "member"
  | "other";

/**
 * The one line under a scrim's header that tells THIS viewer what to do now.
 * Null when there is nothing for them to do (a visitor, a finished or
 * cancelled scrim, a booking listed as not played).
 */
export function scrimNextStep(m: {
  role: ScrimViewerRole;
  status: string;
  notPlayed: boolean;
  hasTicket: boolean;
  hostCaptainName: string;
  gamesRecorded: number;
}): string | null {
  if (m.notPlayed || m.role === "other") return null;
  if (m.status === SCRIM_STATUS.OPEN) {
    if (m.role === "host-captain") {
      return "Waiting for another team to claim this time. You'll get a Discord ping when one does.";
    }
    return m.role === "member"
      ? "Your team posted this time. It's booked once another team's captain claims it."
      : null;
  }
  if (m.status !== SCRIM_STATUS.SCHEDULED && m.status !== SCRIM_STATUS.LIVE) {
    return null;
  }
  // A live series' next game is a new lobby, set up the same way.
  const live = m.status === SCRIM_STATUS.LIVE;
  const game = `Game ${m.gamesRecorded + 1} next.`;
  const noTicket = m.hasTicket
    ? ""
    : " This season has no league ticket yet, so the games won't record.";
  const ticketCheck = m.hasTicket
    ? " and check that its League is this season's ticket before the game starts"
    : "";
  if (m.role === "host-captain") {
    return `${live ? `${game} Make a new lobby` : "You host. Make the lobby"} with the settings below${m.hasTicket ? ": the league ticket is what records the games." : "."}${noTicket}`;
  }
  if (m.role === "away-captain") {
    return live
      ? `${game} ${m.hostCaptainName} hosts a new lobby: join it${ticketCheck}.${noTicket}`
      : `${m.hostCaptainName} hosts. Join the lobby below${ticketCheck}.${noTicket}`;
  }
  return live
    ? `${game} Join the new lobby below when it starts.`
    : "Your team plays this scrim. Join the lobby below when it starts.";
}
