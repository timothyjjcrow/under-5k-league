// Scrim announcements. Pure: they take plain values and return the message.
//
// Every one of these is addressed to the people who must act on it — the
// caller passes a mention allowlist of exactly those captains (mentionsOf /
// mentionUsers) and never broadcasts to the league. Team and player names are
// player-chosen text, so they go through escapeDiscordText like every other
// announcement (a team called "[free mmr](https://evil.test)" must not arrive
// as a live link that reads as league-authored).

import { escapeDiscordText as name } from "./discord-escape";
import { resolveSiteUrl } from "./site-url";

function stamp(ms: number, style: "F" | "f" = "F"): string {
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

function scrimLink(scrimId: string): string {
  return `<${resolveSiteUrl()}/scrims/${scrimId}>`;
}

function matchup(hostTeamName: string, opponentTeamName: string | null): string {
  return opponentTeamName
    ? `**${name(hostTeamName)}** vs **${name(opponentTeamName)}**`
    : `**${name(hostTeamName)}**`;
}

/** To the OTHER captains: a new time they could claim. */
export function scrimPostedMessage(m: {
  scrimId: string;
  hostTeamName: string;
  whenMs: number;
  bestOf: number;
}): string {
  return `🤝 **${name(m.hostTeamName)}** posted a scrim time: ${stamp(m.whenMs)} (best of ${m.bestOf}). Captains, claim it here: ${scrimLink(m.scrimId)}`;
}

/**
 * To the POSTING captain: their time was claimed, who to talk to, and which
 * of their other open times within four hours were withdrawn by the booking
 * (joinScrim cancels them, and nothing else says so).
 */
export function scrimClaimedMessage(m: {
  scrimId: string;
  hostTeamName: string;
  opponentTeamName: string;
  opponentCaptainName: string;
  whenMs: number;
  bestOf: number;
  withdrawnHostOffersMs: number[];
}): string {
  const withdrawn = m.withdrawnHostOffersMs.length
    ? ` Your other open ${m.withdrawnHostOffersMs.length === 1 ? "time" : "times"} within four hours (${m.withdrawnHostOffersMs
        .map((ms) => stamp(ms, "f"))
        .join(", ")}) ${m.withdrawnHostOffersMs.length === 1 ? "was" : "were"} withdrawn.`
    : "";
  return `✅ **${name(m.opponentTeamName)}** claimed your scrim time on ${stamp(m.whenMs)} (best of ${m.bestOf}). You host: make the lobby and send **${name(m.opponentCaptainName)}** the name and password on Discord.${withdrawn} ${scrimLink(m.scrimId)}`;
}

/** To the captain(s) who didn't cancel it: the booking is off. */
export function scrimCancelledMessage(m: {
  hostTeamName: string;
  opponentTeamName: string | null;
  whenMs: number;
  /** Null when an admin who captains neither side cancelled it. */
  cancellerName: string | null;
}): string {
  const who = m.cancellerName ? `**${name(m.cancellerName)}**` : "An admin";
  const what = m.opponentTeamName
    ? `the ${matchup(m.hostTeamName, m.opponentTeamName)} scrim`
    : `${matchup(m.hostTeamName, null)}'s open scrim time`;
  return `❌ ${who} cancelled ${what} on ${stamp(m.whenMs)}. Post or claim another time: <${resolveSiteUrl()}/scrims>`;
}

/**
 * To both captains of a scrim an official fixture overrode. League matches
 * come first, so a booked scrim is cancelled; one already under way is kept
 * but they are told to finish it (or end it at its current score) in time.
 */
export function scrimYieldedMessage(m: {
  scrimId: string;
  hostTeamName: string;
  opponentTeamName: string | null;
  scrimAtMs: number;
  cancelled: boolean;
  /** "the playoff semifinals", "the grand final"… */
  fixtureLabel: string;
  fixtureAtMs: number;
}): string {
  const scrim = `The ${matchup(m.hostTeamName, m.opponentTeamName)} scrim on ${stamp(m.scrimAtMs)}`;
  return m.cancelled
    ? `📅 ${scrim} was cancelled: it clashed with ${m.fixtureLabel} on ${stamp(m.fixtureAtMs)}, and league matches come first. Book another time: <${resolveSiteUrl()}/scrims>`
    : `📅 ${scrim} is still in progress and clashes with ${m.fixtureLabel} on ${stamp(m.fixtureAtMs)}. Finish it before then, or end it at its current score: ${scrimLink(m.scrimId)}`;
}

/** "the playoff semifinals" for a round of `pairs` fixtures. */
export function playoffRoundLabel(pairs: number): string {
  if (pairs === 1) return "the grand final";
  if (pairs === 2) return "the playoff semifinals";
  if (pairs === 4) return "the playoff quarterfinals";
  return "the next playoff round";
}
