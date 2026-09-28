import { randomUUID } from "node:crypto";
import { getSetting, SETTING_KEYS } from "./settings";
import { resolveSiteUrl } from "./site-url";
import { MATCH_ANCHOR, matchAnchorPath } from "./match-anchors";
import { splitLinks } from "./linkify";
import { escapeDiscordText } from "./discord-escape";
import {
  DISCORD_CONTENT_MAX,
  isValidDiscordContent,
  materializeAllowedMentions,
  normalizeMentionAllowlist,
  type MentionAllowlist,
} from "./discord-payload";
import {
  deliverLeagueAnnouncements,
  enqueueLeagueAnnouncement,
  hasPendingLeagueAnnouncements,
  LEAGUE_ANNOUNCEMENT_STATUS,
  type LeagueAnnouncementDelivery,
  type LeagueAnnouncementMarker,
  type LeagueSendResult,
} from "./league-announcement-outbox";
import { normalizeDiscordWebhookUrl } from "./discord-webhook.mjs";
import { discordMutationsAllowed } from "./discord-mutation-policy";
import { runAfterResponse } from "./after-response";
import { capacityInfo } from "./capacity";

export { materializeAllowedMentions } from "./discord-payload";
export type { MentionAllowlist } from "./discord-payload";

/**
 * Player and team names are user-controlled (Steam personas, captain-chosen
 * team names) and Discord renders markdown in webhook messages — including
 * masked links, which it suppresses for user-typed messages but NOT for ours.
 * Every interpolation of one goes through here. Admin-authored text (news
 * bodies, season names) deliberately does not — see discord-escape.ts.
 */
const name = escapeDiscordText;

// Push league moments to the community's Discord via an incoming webhook.
// The webhook URL lives in the Setting table (admin panel) with the
// DISCORD_WEBHOOK_URL env var as a fallback. Sending is best-effort: a dead
// webhook must never break a signup or a draft, so failures are swallowed
// (logged in dev) and the caller never sees them.

// ---------------------------------------------------------------------------
// Pure message formatters (unit-tested). Discord markdown: **bold**, [link](url).
//
// EVERY SITE LINK IS WRAPPED IN <angle brackets>. A bare URL makes Discord
// unfurl a full preview card — our own og:image and description — which on a
// one-line "queue is filling" ping is roughly ten times the height of the
// message itself and shoves everything else off screen. Angle brackets keep
// the link clickable and kill the card. The ONE deliberate exception is
// newsMessage's trailing media URL, which is bare precisely so Discord DOES
// embed the GIF (see the normalizeMediaUrl note there).
// ---------------------------------------------------------------------------

/**
 * A new full-player signup. Every one of these is an advert for the season,
 * so it ends with the signup link. The count line uses the site's own ask:
 * short of the minimum, how many more the draft needs; past it (where the
 * league sits for most of signup week, since minTeams is a floor), how many
 * more make another full team. Only the signup that reaches the minimum
 * celebrates it.
 */
export function signupMessage(
  playerName: string,
  signedUp: number,
  season: { teamSize: number; minTeams: number },
  /** Epoch ms of the scheduled draft night, if the admin has set one. */
  draftAtMs?: number | null,
): string {
  const capacity = capacityInfo(season, signedUp);
  let tail: string;
  if (!capacity.canDraft) {
    tail = `${capacity.needed} more to start the draft.`;
  } else if (capacity.perTeam <= 0) {
    tail = "that's enough to start the draft!";
  } else {
    const n = capacity.toNextTeam;
    const next = `${n} more ${n === 1 ? "player" : "players"} makes it ${capacity.teamsFormable + 1} full teams.`;
    tail =
      capacity.extra === 0
        ? `that's enough to start the draft! 🎉 ${next}`
        : next;
  }
  const when = draftAtMs
    ? ` Draft night: <t:${Math.floor(draftAtMs / 1000)}:F>.`
    : "";
  return `📝 **${name(playerName)}** signed up — ${signedUp} player${signedUp === 1 ? "" : "s"} in, ${tail}${when} Join them: <${resolveSiteUrl()}/me>`;
}

/**
 * A new season is open for signups: the first thing the channel hears from a
 * season, so it says what to do (sign up on /me) and, when one is announced,
 * the weekly match night players are signing up for. Mentions nobody: a
 * season opening is news for everyone, not something one person owes.
 */
export function signupsOpenMessage(
  seasonName: string,
  /** The announced weekly night (announcedMatchNight), or null when unset. */
  matchNight: string | null,
): string {
  const night = matchNight ? ` Match night: ${name(matchNight)}.` : "";
  return `📝 **${name(seasonName)} signups are open!**${night} Sign up: <${resolveSiteUrl()}/me>`;
}

export function draftScheduledMessage(
  seasonName: string,
  whenMs: number,
): string {
  return `🗓️ **The ${seasonName} draft is set for <t:${Math.floor(whenMs / 1000)}:F>** — players and captains, confirm you can make it: <${resolveSiteUrl()}/me>`;
}

export function draftRescheduledMessage(
  seasonName: string,
  whenMs: number,
): string {
  return `🔄 **The ${seasonName} draft moved to <t:${Math.floor(whenMs / 1000)}:F>.** Previous confirmations expired — confirm the new time: <${resolveSiteUrl()}/me>`;
}

export function draftCancelledMessage(seasonName: string): string {
  return `⚠️ **The scheduled ${seasonName} draft night was cleared.** The league admin will post a new time — watch the league dashboard for the update: <${resolveSiteUrl()}>`;
}

export function captainAssignedMessage(
  captainName: string,
  teamName: string,
  discordId?: string | null,
  /** The captain being replaced (transferCaptaincy): the same post tells the
   *  channel, and them, that they no longer captain the team. */
  previousCaptain?: DraftReminderPerson | null,
): string {
  const captain = discordId ? `<@${discordId}>` : `**${name(captainName)}**`;
  const handover = previousCaptain
    ? ` ${captainLabel(previousCaptain)} is no longer captain and stays on the roster as a player.`
    : "";
  return `🧭 ${captain}, **you now captain ${name(teamName)}.**${handover} Review your team, draft-night status, and next responsibilities: <${resolveSiteUrl()}/me>`;
}

/**
 * A captain's team was removed before the draft (removeCaptain). The ping
 * that made them captain would otherwise stand uncorrected in the channel.
 * Their signup is untouched, so they go into the player pool, and the link
 * after those words is the pool itself (/players), not the reader's own /me.
 */
export function captainRemovedMessage(
  captain: DraftReminderPerson,
  teamName: string,
): string {
  return `🧭 ${captainLabel(captain)} is no longer captain of **${name(teamName)}**: the team was removed before the draft. Their signup stays, so they go into the player pool: <${resolveSiteUrl()}/players>`;
}

/** `<@id>` for a linked captain, their bold escaped name otherwise. */
function captainLabel(p: DraftReminderPerson): string {
  const id = mentionableId(p);
  return id ? `<@${id}>` : `**${name(p.name)}**`;
}

export type DraftStartedInput = {
  /** Admin-authored, so not escaped (the draftScheduledMessage rule). */
  seasonName: string;
  /** The designated captains, in draft order. */
  captains: DraftReminderPerson[];
};

/**
 * The draft is live. It mentions the captains who linked Discord, and nobody
 * else: a captain who isn't watching the channel misses the start, and the
 * site nominates for them when their nomination clock runs out. Everyone else
 * only needs the link. Captains who haven't linked are named as plain text, so
 * the channel still sees who is on the clock. Packed under Discord's 2,000
 * characters like the draft-night reminder, and the allowlist holds exactly
 * the mentions that made it into the text.
 */
export function draftStartedAnnouncement(
  m: DraftStartedInput,
): DraftReminderAnnouncement {
  const site = resolveSiteUrl();
  const header = `🔨 **The ${m.seasonName} draft is LIVE!** Watch the auction: <${site}/draft>`;
  // The names lead, so the people pinged read that the line is for them (a
  // list AFTER "the site nominates for you" read as the players it would pick).
  const call =
    "you're on the clock. If your nomination timer runs out, the site nominates for you.";
  const render = (shown: number): string =>
    shown > 0
      ? `${header}\nCaptains ${peopleList(m.captains, shown)}: ${call}`
      : `${header}\nCaptains, ${call}`;
  const fits = (content: string) => content.length <= DISCORD_CONTENT_MAX;
  if (!fits(render(0))) {
    // Defensive last resort for an absurd season name or site URL: still
    // deliverable, and it names nobody, so nobody is allowlisted.
    return {
      content: "🔨 **The draft is LIVE!** Captains, join the draft room now.",
      mentionUserIds: [],
    };
  }
  let shown = 0;
  while (shown < m.captains.length && fits(render(shown + 1))) shown += 1;
  return {
    content: render(shown),
    mentionUserIds: mentionIdsOf(m.captains.slice(0, shown)),
  };
}

export type DraftRosterPlayer = DraftReminderPerson & {
  /** What the team paid; 0 prints no price. */
  price: number;
};

export type DraftRosterTeam = {
  name: string;
  captainName: string;
  /** Non-captain roster members, in the order to list them. */
  players: DraftRosterPlayer[];
  /** Seats the draft left empty (a pool that ran dry). */
  openSeats: number;
};

export type DraftCompleteInput = {
  /** Admin-authored, so not escaped (the draftScheduledMessage rule). */
  seasonName: string;
  /** Teams in draft order. */
  teams: DraftRosterTeam[];
  /**
   * The same draft run finishing a second time, after an admin undid a sale
   * on the finished draft. The teams are posted again as an update, with
   * every player named in plain text: they were all pinged the first time.
   */
  again?: boolean;
};

/**
 * The draft is over: one post listing every team, which replaces the old
 * line-per-sale posts. It mentions each drafted player who linked Discord,
 * once, on their team's line, so a player who wasn't watching learns their
 * team and captain from the channel. Captains are named, not pinged: they
 * were in the room. Whole team lines are packed in draft order under
 * Discord's 2,000 characters; teams that don't fit are counted and left to
 * the teams page, and their players are never allowlisted. With `again`, it
 * mentions nobody.
 */
export function draftCompleteAnnouncement(
  m: DraftCompleteInput,
): DraftReminderAnnouncement {
  const site = resolveSiteUrl();
  const header = m.again
    ? `✅ **The ${m.seasonName} draft is complete again. Here are the updated teams:**`
    : `✅ **The ${m.seasonName} draft is complete! Here are the teams:**`;
  const label = (p: DraftRosterPlayer): string =>
    m.again ? name(p.name) : personLabel(p);
  const anyOpen = m.teams.some((t) => t.openSeats > 0);
  const footer = anyOpen
    ? `Open seats get filled with free agents, and standins cover until then. Every roster: <${site}/teams>`
    : `Every roster: <${site}/teams>`;
  const teamLine = (t: DraftRosterTeam): string => {
    const seats =
      t.openSeats > 0
        ? `, ${t.openSeats} open seat${t.openSeats === 1 ? "" : "s"}`
        : "";
    const roster = t.players.length
      ? t.players
          .map((p) => `${label(p)}${p.price > 0 ? ` $${p.price}` : ""}`)
          .join(", ")
      : "no players bought";
    return `**${name(t.name)}** (captain ${name(t.captainName)}${seats}): ${roster}`;
  };
  const render = (shown: number): string => {
    const hidden = m.teams.length - shown;
    const more =
      hidden > 0
        ? [
            `…and ${hidden} more team${hidden === 1 ? "" : "s"} on the teams page.`,
          ]
        : [];
    return [header, ...m.teams.slice(0, shown).map(teamLine), ...more, footer].join(
      "\n",
    );
  };
  const fits = (content: string) => content.length <= DISCORD_CONTENT_MAX;
  if (!fits(render(0))) {
    // Defensive last resort for an absurd season name or site URL: still
    // deliverable, and it names nobody, so nobody is allowlisted.
    return {
      content:
        "✅ **The draft is complete!** Every roster is on the league site's teams page.",
      mentionUserIds: [],
    };
  }
  let shown = 0;
  while (shown < m.teams.length && fits(render(shown + 1))) shown += 1;
  return {
    content: render(shown),
    mentionUserIds: m.again
      ? []
      : mentionIdsOf(m.teams.slice(0, shown).flatMap((t) => t.players)),
  };
}

/** The most opening fixtures the season-start post lists one per line. */
const OPENING_FIXTURES_SHOWN = 12;

/**
 * The season-start post. The Regular season can only start once fixtures
 * exist, so the post carries the opening week: who plays whom and when, and
 * who has the bye. Without it no player heard their week-1 opponent or
 * kickoff until the reminder a day before.
 */
export function regularSeasonStartedMessage(
  seasonName: string,
  opening?: {
    week: number;
    fixtures: { home: string; away: string; whenMs: number | null }[];
    byes: string[];
  },
): string {
  const head = `⚔️ **The ${name(seasonName)} regular season is live.**`;
  const link = `<${resolveSiteUrl()}/schedule>`;
  if (!opening || opening.fixtures.length === 0) {
    return `${head} Check the schedule, match times, and availability for opening week: ${link}`;
  }
  const shown = opening.fixtures.slice(0, OPENING_FIXTURES_SHOWN);
  const lines = shown.map((f) => {
    const when =
      f.whenMs != null && Number.isFinite(f.whenMs)
        ? ` — <t:${Math.floor(f.whenMs / 1000)}:F>`
        : "";
    return `• ${name(f.home)} vs ${name(f.away)}${when}`;
  });
  const more = opening.fixtures.length - shown.length;
  if (more > 0) lines.push(`• and ${more} more on the schedule`);
  const byes = opening.byes.length
    ? `\nBye: ${opening.byes.map((team) => name(team)).join(", ")}`
    : "";
  return `${head} Week ${opening.week}:\n${lines.join("\n")}${byes}\nCheck in for your match and see the full schedule: ${link}`;
}

export function draftPausedMessage(seasonName: string): string {
  return `⏸️ **The ${seasonName} auction is paused.** Clocks are parked; stay in the draft room for the restart: <${resolveSiteUrl()}/draft>`;
}

export function draftResumedMessage(seasonName: string): string {
  return `▶️ **The ${seasonName} auction has resumed.** A fresh clock is running now: <${resolveSiteUrl()}/draft>`;
}

export function draftLotVoidedMessage(
  seasonName: string,
  playerName: string,
): string {
  return `↩️ **The live lot for ${name(playerName)} was voided by an admin.** No sale was recorded; ${seasonName} remains paused until the admin resumes it.`;
}

export function draftSaleUndoneMessage(
  seasonName: string,
  playerName: string,
  teamName: string,
  price: number,
): string {
  return `↩️ **The ${seasonName} sale of ${name(playerName)} to ${name(teamName)} for $${price} was undone.** The player is back in the pool and the auction must finish again: <${resolveSiteUrl()}/draft>`;
}

export function draftAbortedMessage(
  seasonName: string,
  playersReturned: number,
  matchesRemoved: number,
): string {
  return `🛑 **The ${seasonName} auction was aborted and the season is back in Signups.** ${playersReturned} non-captain roster member(s) returned to the pool${matchesRemoved ? `; ${matchesRemoved} unplayed fixture(s) were cleared` : ""}. Wait for the admin to announce the restart: <${resolveSiteUrl()}>`;
}

/** Draft-night superlatives, posted right after the teams (draftCompleteAnnouncement). */
export function draftRecapMessage(r: {
  biggestSpend: { name: string; teamName: string; price: number } | null;
  bestValue: { name: string; teamName: string; price: number } | null;
  topSpender: { teamName: string; spent: number } | null;
  totalSpent: number;
}): string {
  const lines = [
    `📊 **Draft night in numbers** — $${r.totalSpent} changed hands.`,
  ];
  if (r.biggestSpend) {
    lines.push(
      `💰 Biggest buy: **${name(r.biggestSpend.name)}** to ${name(r.biggestSpend.teamName)} for $${r.biggestSpend.price}`,
    );
  }
  if (r.bestValue) {
    lines.push(
      `🕵️ Steal of the night: **${name(r.bestValue.name)}** to ${name(r.bestValue.teamName)} at $${r.bestValue.price}`,
    );
  }
  if (r.topSpender) {
    lines.push(
      `🏦 Deepest pockets: **${name(r.topSpender.teamName)}** ($${r.topSpender.spent} spent)`,
    );
  }
  return lines.join("\n");
}

/**
 * A season's own page, scrolled to its bracket. Posts link here rather than
 * /schedule, which always shows the CURRENT season: after the handoff an old
 * "playoffs are set" post would open the next season's empty schedule.
 */
function seasonBracketUrl(seasonId: string): string {
  return `${resolveSiteUrl()}/seasons/${encodeURIComponent(seasonId)}#playoffs`;
}

/** "the semifinals", "the grand final", "Round 3" — a round name mid-sentence. */
function roundPhrase(round: string): string {
  return /^Round \d+$/.test(round) ? round : `the ${round.toLowerCase()}`;
}

export function matchResultMessage(m: {
  matchId: string;
  homeName: string;
  awayName: string;
  homeScore: number;
  awayScore: number;
  /** What the site calls this fixture — `matchRoundLabel`: "Week 3",
   *  "Tiebreaker", "Semifinal", "Grand final". */
  label: string;
  /** Ruled/defaulted result — say so, or the channel reads a no-show as a
   *  played sweep. */
  forfeit?: boolean;
  /** Any Game row recorded for this series. A manual score (private match
   *  data, a ticketless lobby, a forfeit) has none, so its page shows no box
   *  score and the link must not promise one. */
  hasGames?: boolean;
  /** Set for a knockout playoff series before the grand final: the winner
   *  moves on to `nextRound` (null when the bracket can't name it) and the
   *  loser is out. The grand final gets no such line — crowning the champion
   *  is the champion post's job. */
  knockout?: { nextRound: string | null };
  /** An all-time player record set in this series (brokenPlayerRecord),
   *  added as one line. Riding the result post means no extra send and no
   *  second once-only marker. */
  record?: {
    emoji: string;
    holderName: string;
    /** "17 kills", with its unit (formatRecordMark). */
    mark: string;
    heroName: string | null;
    /** The mark it beat, same format. */
    previousMark: string;
  } | null;
}): string {
  const home = name(m.homeName);
  const away = name(m.awayName);
  const homeWon = m.homeScore > m.awayScore;
  const winner = homeWon ? home : m.awayScore > m.homeScore ? away : null;
  const loser = homeWon ? away : home;
  const line = `⚔️ **${m.label}:** ${home} ${m.homeScore}–${m.awayScore} ${away}`;
  const byForfeit = m.forfeit ? " by forfeit" : "";
  const tail = !winner
    ? `${line} — a draw!`
    : m.knockout
      ? `${line} — **${winner}** advance${m.knockout.nextRound ? ` to ${roundPhrase(m.knockout.nextRound)}` : ""}${byForfeit}; ${loser} are eliminated.`
      : m.forfeit
        ? `${line} — **${winner}** take the series by forfeit.`
        : `${line} — **${winner}** take the series!`;
  // Only promise a box score when a game was actually imported: a manual
  // score (forfeit or not) opens on "no games recorded".
  const link = `${m.hasGames ? "Box score" : "Match page"}: <${resolveSiteUrl()}/matches/${m.matchId}>`;
  const record = m.record
    ? `\n${m.record.emoji} New league record: **${name(m.record.holderName)}**, ${m.record.mark}${m.record.heroName ? ` on ${m.record.heroName}` : ""} (old mark ${m.record.previousMark})`
    : "";
  return `${tail} ${link}${record}`;
}

/**
 * Automatic import couldn't find a fixture's games (private match data, a
 * lobby without the league ticket), or found part of the series and then
 * nothing for hours. The send mentions the two captains, who can report the
 * games themselves in one click on the match page; nobody else is pinged.
 */
export function resultNudgeMessage(m: {
  matchId: string;
  homeName: string;
  awayName: string;
  /** matchRoundLabel: "Week 3", "Semifinal", "Grand final", "Tiebreaker". */
  label: string;
  homeScore: number;
  awayScore: number;
  /** Games imported so far; 0 = none found at all. */
  gamesFound: number;
}): string {
  const fixture = `**${name(m.homeName)}** vs **${name(m.awayName)}** (${m.label})`;
  const link = `<${resolveSiteUrl()}/matches/${m.matchId}>`;
  if (m.gamesFound === 0) {
    return `📋 We couldn't find the games for ${fixture}. Captains: report them on the match page: ${link}`;
  }
  return `📋 ${fixture} is stuck at ${m.homeScore}–${m.awayScore}: we couldn't find the rest of the series. Captains: report the missing games on the match page: ${link}`;
}

export function playoffsStartedMessage(
  seasonName: string,
  /** The bracket link opens this season's page, so it survives the handoff. */
  seasonId: string,
  pairings: {
    home: string;
    away: string;
    /** Seeds from the first-round pairings (`seedsFromFirstRound`). */
    homeSeed?: number | null;
    awaySeed?: number | null;
    /** Kickoff, epoch ms — rendered in each reader's own timezone. */
    whenMs?: number | null;
  }[],
): string {
  const side = (team: string, seed?: number | null) =>
    seed ? `(${seed}) ${name(team)}` : name(team);
  const lines = pairings
    .map((p) => {
      const when =
        p.whenMs != null && Number.isFinite(p.whenMs)
          ? ` — <t:${Math.floor(p.whenMs / 1000)}:f>`
          : "";
      return `• ${side(p.home, p.homeSeed)} vs ${side(p.away, p.awaySeed)}${when}`;
    })
    .join("\n");
  return `🏁 **${seasonName} playoffs are set!**\n${lines}\nBracket: <${seasonBracketUrl(seasonId)}>`;
}

/**
 * The next playoff round has been built from the last one's winners (the
 * final, in a four-team bracket). The opening bracket and the champion always
 * posted; the rounds between them didn't, so finalists heard about their
 * final from the match-night reminder a day before kickoff. The send mentions
 * the captains of the new fixtures; the times render in each reader's zone.
 */
export function playoffRoundSetMessage(m: {
  seasonName: string;
  /** The bracket link opens this season's page, so it survives the handoff. */
  seasonId: string;
  /** roundName(): "Grand final", "Semifinals", "Quarterfinals", "Round N". */
  roundName: string;
  fixtures: { home: string; away: string; whenMs: number | null }[];
}): string {
  const lines = m.fixtures.map((f) => {
    const when =
      f.whenMs != null && Number.isFinite(f.whenMs)
        ? ` — <t:${Math.floor(f.whenMs / 1000)}:F> (<t:${Math.floor(f.whenMs / 1000)}:R>)`
        : " — kickoff time still to be set";
    return `• **${name(f.home)}** vs **${name(f.away)}**${when}`;
  });
  // "Semifinals are set", "Grand final is set", "Round 3 is set".
  const verb = /s$/.test(m.roundName) ? "are" : "is";
  return `🏁 **${name(m.seasonName)} ${m.roundName.toLowerCase()} ${verb} set!**\n${lines.join("\n")}\nBracket: <${seasonBracketUrl(m.seasonId)}>`;
}

export function playoffsReturnedToRegularMessage(seasonName: string): string {
  return `↩️ **${name(seasonName)} playoffs have been withdrawn for a standings correction.** The current bracket is void and the league is back in the Regular season phase. A fresh bracket will be posted after the results are corrected: <${resolveSiteUrl()}/schedule>`;
}

/**
 * The season's champions. The roster is congratulated by name, and each
 * player who linked Discord is mentioned: one of the few pings the league
 * sends that praises rather than asks. The caller's allowlist is the linked
 * roster (mentionsOf), which is exactly the mentions this text shows; a
 * roster is one team, so nothing is ever left out for length.
 */
export function championMessage(
  seasonName: string,
  teamName: string,
  seasonId: string,
  /** The champion team's roster, captain first. Empty names nobody. */
  roster: DraftReminderPerson[] = [],
): string {
  // The season's own page holds the champion, bracket and awards. Older posts
  // link /recap?season=, which redirects there.
  const recap = `${resolveSiteUrl()}/seasons/${encodeURIComponent(seasonId)}`;
  const people = roster.map(personLabel);
  const cheers =
    people.length === 0
      ? ""
      : ` Congratulations ${
          people.length === 1
            ? people[0]
            : `${people.slice(0, -1).join(", ")} and ${people[people.length - 1]}`
        }!`;
  return `👑 **${name(teamName)}** are the **${name(seasonName)}** champions!${cheers} GG everyone — season recap at <${recap}>`;
}

export function freeAgentSignedMessage(
  playerName: string,
  teamName: string,
): string {
  // Ends by naming the signed player's next move — a signing is a season-long
  // obligation (every remaining match night), so the send mentions them and
  // the copy tells them what being signed asks of them, the standin-assign rule.
  // It names the team rather than saying "their schedule", which read as the
  // player's own.
  return `🖊️ **${name(playerName)}** signs with **${name(teamName)}** as a free agent — roster updated: <${resolveSiteUrl()}/teams>. ${name(playerName)}: the **${name(teamName)}** match nights are yours now — check in on your match pages: <${resolveSiteUrl()}/schedule>`;
}

export function playerReleasedMessage(
  playerName: string,
  teamName: string,
): string {
  return `📤 **${name(playerName)}** released from **${name(teamName)}** — they're a free agent again.`;
}

/** A team quit mid-season — the league-wide event, so a broadcast (results
 *  of the individual forfeits are visible on /schedule; announcing each would
 *  be N pings about one fact). */
export function teamWithdrewMessage(
  teamName: string,
  forfeited: number,
): string {
  return `🏳️ **${name(teamName)}** have withdrawn from the season — their ${forfeited} remaining fixture(s) are forfeited to the opponents.`;
}

/** A team's captain or an admin changed its name or logo. A broadcast with no
 *  mentions: nobody has to act on it, it keeps the channel's team names in
 *  step with the site. */
export function teamIdentityChangedMessage(m: {
  teamId: string;
  previousName: string;
  name: string;
  nameChanged: boolean;
  logoChanged: boolean;
}): string {
  const link = `<${resolveSiteUrl()}/teams/${encodeURIComponent(m.teamId)}>`;
  if (m.nameChanged) {
    const logo = m.logoChanged ? ", with a new logo" : "";
    return `✏️ **${name(m.previousName)}** is now **${name(m.name)}**${logo}: ${link}`;
  }
  return `🎨 **${name(m.name)}** has a new logo: ${link}`;
}

/** `<@&id>` prefix, or nothing when the league hasn't set a ping role. */
export function rolePrefix(roleId: string | null | undefined): string {
  return roleId ? `<@&${roleId}> ` : "";
}

/** Deep-links straight into the queue: one tap from a phone notification to
 *  actually being in it, instead of link → page → find the button → tap. */
export function joinLink(): string {
  return `${resolveSiteUrl()}/inhouse?join=1`;
}

export function inhouseQueueMessage(
  present: number,
  lobbySize: number,
  roleId?: string | null,
): string {
  const needed = Math.max(0, lobbySize - present);
  return `${rolePrefix(roleId)}**Inhouse queue is filling** — ${present}/${lobbySize} in, ${needed} more ${needed === 1 ? "player" : "players"} and the lobby fires. Jump in: <${joinLink()}>`;
}

/**
 * Lobby formed — the scarcest event the league produces, on a short accept
 * clock. Players who linked Discord are mentioned by id so the ping reaches a
 * PHONE; the rest are named as plain text. Queueing earlier is the consent
 * here, which is why this needs no opt-in role (don't "fix" that later).
 *
 * `acceptEndsAt` is the ready check's own deadline. It renders as Discord
 * timestamps (`<t:…:T>` and `<t:…:R>`), so every reader sees the cutoff in
 * their own time zone and a countdown that keeps moving with no edits: a
 * player coming out of a pub game can tell at a glance whether there is still
 * time to open the site.
 */
export function inhouseLobbyMessage(
  players: { name: string; discordId: string | null }[],
  roleId?: string | null,
  acceptEndsAt?: Date | null,
): string {
  const who = players
    .map((p) => (p.discordId ? `<@${p.discordId}>` : name(p.name)))
    .join(", ");
  const epoch = acceptEndsAt ? Math.floor(acceptEndsAt.getTime() / 1000) : null;
  const deadline =
    epoch != null
      ? `Accept your game by <t:${epoch}:T> (<t:${epoch}:R>) or you lose your spot`
      : "Accept your game before the clock runs out";
  return `${rolePrefix(roleId)}🚨 **Inhouse match found!** ${deadline} — <${resolveSiteUrl()}/inhouse>\n${who}`;
}

export function inhouseResultMessage(m: {
  winnerSide: "Radiant" | "Dire";
  radiantScore: number;
  direScore: number;
  durationSecs: number;
  /** Best line of the game (null when nobody in the box score is a member). */
  mvpName: string | null;
  mvpHero: string | null;
  dotaMatchId: string;
}): string {
  const mins = Math.floor(m.durationSecs / 60);
  const secs = String(m.durationSecs % 60).padStart(2, "0");
  const mvp = m.mvpName
    ? ` MVP: **${name(m.mvpName)}**${m.mvpHero ? ` (${m.mvpHero})` : ""}.`
    : "";
  return `🏁 **Inhouse result: ${m.winnerSide} win ${m.radiantScore}–${m.direScore}** in ${mins}:${secs}.${mvp} Box score + ladder: <${resolveSiteUrl()}/inhouse> · <https://www.opendota.com/matches/${m.dotaMatchId}>`;
}

/**
 * An admin voided a published result.
 *
 * The correction is only worth sending because the ORIGINAL post is still
 * sitting in the channel naming a winner that no longer stands — and a Discord
 * message that is never edited and never notifies is exactly the surface where
 * a stale result outlives the state it described. Discord edits produce no
 * notification, so amending the old post would leave everyone who already read
 * it believing it; a new line is the only thing anyone sees.
 *
 * The OpenDota link is the anchor, not decoration: the void NULLS the lobby's
 * dotaMatchId, so once this is sent there is nothing left in the database
 * tying the correction to the post it corrects.
 *
 * No MentionAllowlist — it names no action anyone can take, and a notification
 * people can't act on is what gets a channel muted.
 * Nothing here is player-supplied, so there is no name to escape.
 */
export function inhouseResultVoidedMessage(m: {
  /** Null only in theory — a COMPLETED lobby always came from a real match. */
  dotaMatchId: string | null;
}): string {
  const link = m.dotaMatchId
    ? ` <https://www.opendota.com/matches/${m.dotaMatchId}>`
    : "";
  return `↩️ **That inhouse result has been voided by an admin** — it's off the ladder, and the result posted for that game no longer stands.${link}`;
}

/**
 * A playoff fixture's round, from the name the site gives it
 * (`matchRoundLabel`): "Semifinal", "Grand final", or "Playoff round 2" in a
 * bracket deep enough to number its rounds. Null when there is no name, or
 * the bracket couldn't place the fixture ("Playoffs"), so the caller keeps
 * its phase-only wording.
 */
function playoffFixtureTitle(roundLabel: string | null | undefined): string | null {
  if (!roundLabel || roundLabel === "Playoffs") return null;
  return /^Round \d+$/.test(roundLabel)
    ? `Playoff ${roundLabel.toLowerCase()}`
    : roundLabel;
}

/**
 * How a post names one fixture mid-sentence: "week 3 match", "tiebreaker
 * match", or a playoff fixture by its round ("semifinal", "grand final").
 * Every post about the same fixture uses this, so the OUT ping, the standin
 * booked in reply and the reschedule thread all call it the same thing.
 */
function fixtureLabel(m: {
  week: number;
  isPlayoff: boolean;
  isTiebreaker?: boolean;
  roundLabel?: string | null;
}): string {
  if (m.isTiebreaker) return "tiebreaker match";
  if (m.isPlayoff) {
    return playoffFixtureTitle(m.roundLabel)?.toLowerCase() ?? "playoff match";
  }
  return `week ${m.week} match`;
}

export function playerOutMessage(m: {
  playerName: string;
  homeName: string;
  awayName: string;
  week: number;
  isPlayoff: boolean;
  isTiebreaker?: boolean;
  /** `matchRoundLabel` for the fixture ("Semifinal"); a playoff fixture is
   *  named by its round instead of "playoff match" when given. */
  roundLabel?: string | null;
  /** Epoch ms of the scheduled kickoff; null = unscheduled (line omitted). */
  whenMs: number | null;
  /** Deep link target — the match page holds the Standins card the message
   *  is pointing the captain at. Optional so hand-built calls stay valid. */
  matchId?: string;
}): string {
  const label = fixtureLabel(m);
  const when =
    m.whenMs != null ? ` (<t:${Math.floor(m.whenMs / 1000)}:F>)` : "";
  // The mentioned captain is by definition NOT on the site — land them on the
  // Standins card itself, not the top of the page or the front door.
  const link = m.matchId
    ? ` <${resolveSiteUrl()}${matchAnchorPath(m.matchId, MATCH_ANCHOR.standins)}>`
    : "";
  return `🚑 **${name(m.playerName)}** can't make the ${label} — **${name(m.homeName)}** vs **${name(m.awayName)}**${when}. Captains/admin: time to line up a standin.${link}`;
}

/**
 * The answer to playerOutMessage: the player who said they couldn't make it
 * now can. setAvailability sends it to the same captain, and only when that
 * OUT was announced, so a captain still hunting for cover hears to stop.
 */
export function playerBackInMessage(
  m: Parameters<typeof playerOutMessage>[0],
): string {
  const label = fixtureLabel(m);
  const when =
    m.whenMs != null ? ` (<t:${Math.floor(m.whenMs / 1000)}:F>)` : "";
  const link = m.matchId ? ` <${resolveSiteUrl()}/matches/${m.matchId}>` : "";
  return `✅ **${name(m.playerName)}** can make the ${label} after all — **${name(m.homeName)}** vs **${name(m.awayName)}**${when}. No need to find cover for them; if you already booked a standin, you can cancel that on the match page.${link}`;
}

/** One fixture of an away range, in playerOutMessage's own shape. */
export type AwayFixtureAnnouncement = Omit<
  Parameters<typeof playerOutMessage>[0],
  "playerName"
>;

/** Room left under Discord's 2,000 for the captain mentions sendDiscordMessage
 *  prepends — a handful of `<@id>` tokens at most. */
const AWAY_MESSAGE_BUDGET = 1_800;

/**
 * ONE announcement for a whole "I'm away" range, however many fixtures it
 * covers: a captain whose player is gone for three weeks needs one buzz with
 * the list, not three. A single fixture is exactly playerOutMessage, so the
 * captain reads the same words whichever way the player said it; more get one
 * line each in that message's terms, each with its reader-local kickoff and
 * the match page that holds the Standins card.
 */
export function playerAwayMessage(
  playerName: string,
  fixtures: AwayFixtureAnnouncement[],
): string {
  if (fixtures.length === 0) return "";
  if (fixtures.length === 1) {
    return playerOutMessage({ playerName, ...fixtures[0] });
  }
  const head = `🚑 **${name(playerName)}** is away and can't make ${fixtures.length} matches:`;
  const tail = "Captains/admin: time to line up standins.";
  const lines: string[] = [];
  let used = head.length + tail.length + 2;
  for (const [i, f] of fixtures.entries()) {
    const label = f.isTiebreaker
      ? "Tiebreaker match"
      : f.isPlayoff
        ? (playoffFixtureTitle(f.roundLabel) ?? "Playoff match")
        : `Week ${f.week} match`;
    const when = f.whenMs != null ? ` (<t:${Math.floor(f.whenMs / 1000)}:F>)` : "";
    const link = f.matchId
      ? ` <${resolveSiteUrl()}${matchAnchorPath(f.matchId, MATCH_ANCHOR.standins)}>`
      : "";
    const line = `• ${label}: **${name(f.homeName)}** vs **${name(f.awayName)}**${when}${link}`;
    const rest = fixtures.length - i;
    // Leave room for the "and N more" line whenever anything could follow.
    if (used + line.length + 1 + (rest > 1 ? 24 : 0) > AWAY_MESSAGE_BUDGET) {
      lines.push(`• …and ${rest} more`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return [head, ...lines, tail].join("\n");
}

export function standinAssignedMessage(m: {
  standinName: string;
  /** null = filling an EMPTY seat on a short roster, replacing nobody. */
  replacedName: string | null;
  teamName: string;
  homeName: string;
  awayName: string;
  week: number;
  isPlayoff: boolean;
  isTiebreaker?: boolean;
  /** `matchRoundLabel` for the fixture ("Semifinal"); a playoff fixture is
   *  named by its round instead of "playoff match" when given. */
  roundLabel?: string | null;
  /** Epoch ms of the scheduled kickoff; null = unscheduled (line omitted). */
  whenMs: number | null;
  /** Deep link target — the match page holds the check-in banner. */
  matchId?: string;
}): string {
  const label = fixtureLabel(m);
  const when =
    m.whenMs != null ? ` (<t:${Math.floor(m.whenMs / 1000)}:F>)` : "";
  const standin = name(m.standinName);
  // "stands in for nobody" would be nonsense — a short roster is filling a seat
  // that has no player behind it, which is a different (and more urgent) thing
  // to tell a standin than covering for a named team-mate.
  const forWhom = m.replacedName
    ? `stands in for **${name(m.replacedName)}** on **${name(m.teamName)}**`
    : `fills an open roster seat for **${name(m.teamName)}**`;
  // "check in on the match page" without the page is a scavenger hunt for
  // someone who arrived from a phone ping — link the page (week-reminder shape).
  const link = m.matchId ? `: <${resolveSiteUrl()}/matches/${m.matchId}>` : ".";
  return `🧩 **${standin}** ${forWhom} — ${label} **${name(m.homeName)}** vs **${name(m.awayName)}**${when}. ${standin}: that's your game night now, check in on the match page${link}`;
}

/**
 * Why a booking ended, in a few plain words. A fixed list rather than free
 * text: every path that cancels cover picks one, and nothing player-typed can
 * reach the post through it.
 */
const STAND_DOWN_REASON = {
  CAPTAIN_CANCELLED: "the team's captain cancelled the booking",
  ADMIN_CANCELLED: "an admin cancelled the booking",
  SEAT_FILLED: "the team signed a player for that seat",
  PLAYER_RELEASED: "the covered player was released",
  TEAM_WITHDREW: "a team withdrew from the season",
  FORFEIT: "the match was ruled a forfeit",
  SCHEDULE_REGENERATED: "the schedule was redone",
  BRACKET_REBUILT: "the playoff bracket was redone",
  BRACKET_WITHDRAWN: "the playoff bracket was withdrawn to fix the standings",
  TIEBREAKER_RESET: "the tiebreaker week was reset",
  DRAFT_RESET: "the draft was reset",
} as const;

type StandDownReason = keyof typeof STAND_DOWN_REASON;

export function standinRemovedMessage(m: {
  standinName: string;
  teamName: string;
  homeName: string;
  awayName: string;
  week: number;
  isPlayoff: boolean;
  isTiebreaker?: boolean;
  /** `matchRoundLabel` for the fixture ("Semifinal"); a playoff fixture is
   *  named by its round instead of "playoff match" when given. */
  roundLabel?: string | null;
  /** Why the booking ended; omitted, the post just says to stand down. */
  reason?: StandDownReason;
}): string {
  const label = fixtureLabel(m);
  const why = m.reason ? ` (${STAND_DOWN_REASON[m.reason]})` : "";
  return `🧩 **${name(m.standinName)}** is no longer standing in for **${name(m.teamName)}** (${label} **${name(m.homeName)}** vs **${name(m.awayName)}**) — stand down${why}.`;
}

export function rescheduleProposedMessage(m: {
  homeName: string;
  awayName: string;
  week: number;
  isPlayoff: boolean;
  isTiebreaker?: boolean;
  /** `matchRoundLabel` for the fixture ("Semifinal"); a playoff fixture is
   *  named by its round instead of "playoff match" when given. */
  roundLabel?: string | null;
  proposerName: string;
  whenMs: number;
  /** Deep link to the Reschedule card, where the other captain answers.
   *  Optional so hand-built calls stay valid. */
  matchId?: string;
}): string {
  const label = fixtureLabel(m);
  const where = m.matchId
    ? `on the match page: <${resolveSiteUrl()}${matchAnchorPath(m.matchId, MATCH_ANCHOR.reschedule)}>`
    : "on the match page.";
  return `⏳ **${name(m.proposerName)}** proposed moving the ${label} **${name(m.homeName)}** vs **${name(m.awayName)}** to <t:${Math.floor(m.whenMs / 1000)}:F> — the other captain can respond ${where}`;
}

/**
 * The ANSWER to a proposal this channel already announced. Addressed to the
 * proposer, who asked and has been waiting — never a broadcast, since nobody
 * else can act on it. Without this the question hung in the channel forever
 * and the proposer learned only by revisiting the match page.
 */
export function rescheduleDeclinedMessage(m: {
  homeName: string;
  awayName: string;
  week: number;
  isPlayoff: boolean;
  isTiebreaker?: boolean;
  /** `matchRoundLabel` for the fixture ("Semifinal"); a playoff fixture is
   *  named by its round instead of "playoff match" when given. */
  roundLabel?: string | null;
  declinerName: string;
  whenMs: number;
  /** Deep link to the Reschedule card, where the proposer can try another
   *  time. Optional so hand-built calls stay valid. */
  matchId?: string;
}): string {
  const label = fixtureLabel(m);
  const link = m.matchId
    ? ` <${resolveSiteUrl()}${matchAnchorPath(m.matchId, MATCH_ANCHOR.reschedule)}>`
    : "";
  return `⏳ **${name(m.declinerName)}** declined moving the ${label} **${name(m.homeName)}** vs **${name(m.awayName)}** to <t:${Math.floor(m.whenMs / 1000)}:F> — the original kickoff stands.${link}`;
}

/** Cap the ping list so one badly-organised team can't produce a wall of
 *  mentions; a captain chasing eleven people needs the match page, not a
 *  longer Discord line. */
const WAITING_SHOWN = 8;

export type WeekReminderFixture = {
  matchId: string;
  homeName: string;
  awayName: string;
  /** Epoch ms — rendered as <t:…> so every reader sees their own zone. */
  scheduledAt: number;
  homeIn: number;
  homeSize: number;
  awayIn: number;
  awaySize: number;
  /** Roster members with no RSVP yet. Linked players are mentioned by id so
   *  their phone actually buzzes; the rest are named so a captain still
   *  knows who to chase. */
  waitingOn: { name: string; discordId: string | null }[];
};

export type WeekReminderInput = {
  week: number;
  isPlayoff: boolean;
  isTiebreaker?: boolean;
  fixtures: WeekReminderFixture[];
  /** Pick'em is still open on at least one of these fixtures. */
  pickemOpen?: boolean;
  /** Teams with no regular fixture this week (an odd number of teams). */
  byeTeamNames?: string[];
  /** The playoff round these fixtures make up, as `roundGroupLabel` names it
   *  ("Semifinals", "Grand final", "Round 2"). Anything it can't name — a
   *  bracket it couldn't place, or a mix of rounds — keeps "Playoff matches". */
  roundLabel?: string | null;
};

export type WeekReminderAnnouncement = {
  content: string;
  /** Exact linked users visibly named in `content`. Passing anything else to
   *  allowed_mentions makes Discord prepend a hidden waiter to the message. */
  mentionUserIds: string[];
};

/** Reader-local day and clock time plus the countdown: "Sunday, 4 October
 *  2026 20:00 (in 23 hours)". The countdown alone left nobody able to say
 *  what time the games actually are. */
function kickoffStamp(ms: number): string {
  const t = Math.floor(ms / 1000);
  return `<t:${t}:F> (<t:${t}:R>)`;
}

/** Header for a playoff reminder: the round's own name where the bracket
 *  gives one, "Playoff matches" when it doesn't. */
function playoffReminderHeading(roundLabel: string | null | undefined): string {
  const label = roundLabel?.trim() ?? "";
  const numbered = /^Round (\d+)$/.exec(label);
  if (numbered) return `Playoff round ${numbered[1]} matches`;
  // "Playoffs" means the bracket couldn't place these fixtures, and "Week N"
  // means they span rounds; neither names anything a player would recognise.
  if (!label || label === "Playoffs" || /^Week \d+$/.test(label)) {
    return "Playoff matches";
  }
  return label;
}

function reminderFixtureBlock(
  f: WeekReminderFixture,
  site: string,
  /** The header already carries the shared kickoff, so the row skips it. */
  showKickoff: boolean,
): {
  lines: string[];
  mentionUserIds: string[];
} {
  const when = showKickoff ? ` — ${kickoffStamp(f.scheduledAt)}` : "";
  const lines = [
    `🆚 **${name(f.homeName)}** vs **${name(f.awayName)}**${when} · check-ins ${f.homeIn}/${f.homeSize} vs ${f.awayIn}/${f.awaySize} · <${site}/matches/${f.matchId}>`,
  ];
  if (f.waitingOn.length === 0) return { lines, mentionUserIds: [] };

  const shown = f.waitingOn.slice(0, WAITING_SHOWN);
  const validIds = new Set(
    normalizeMentionAllowlist({
      users: shown.flatMap((p) => (p.discordId ? [p.discordId] : [])),
    })?.users ?? [],
  );
  const mentionUserIds: string[] = [];
  const who = shown
    .map((p) => {
      const id = p.discordId?.trim();
      if (id && validIds.has(id)) {
        mentionUserIds.push(id);
        return `<@${id}>`;
      }
      return name(p.name);
    })
    .join(", ");
  const extra = f.waitingOn.length - shown.length;
  lines.push(`　Still waiting on: ${who}${extra > 0 ? ` +${extra} more` : ""}`);
  return { lines, mentionUserIds };
}

function reminderFixtureSummary(
  omitted: number,
  shown: number,
  withLink: boolean,
  site: string,
): string {
  const count = `${omitted} more fixture${omitted === 1 ? "" : "s"}`;
  const lead =
    shown > 0
      ? `…and ${count} at this kickoff.`
      : `${omitted} fixture${omitted === 1 ? " is" : "s are"} scheduled at this kickoff.`;
  return withLink
    ? `${lead} Full slate: <${site}/schedule>`
    : `${lead} View the full schedule on the league site.`;
}

/**
 * Build the reminder body and its mention allowlist together.
 *
 * Discord rejects webhook content above 2,000 characters. A 32-team league
 * can put 16 fixtures (and scores of unanswered players) at one kickoff, so a
 * formatter that simply maps every row can poison the durable queue forever.
 * Keep complete fixture blocks in their stable input order while they fit,
 * then account for every remaining fixture in one actionable summary. Because
 * the allowlist is derived only from blocks that survived packing, the
 * transport never materializes an invisible/omitted player's mention.
 */
export function weekReminderAnnouncement(
  m: WeekReminderInput,
): WeekReminderAnnouncement {
  const site = resolveSiteUrl();
  const label = m.isTiebreaker
    ? `Tiebreaker week ${m.week} matches`
    : m.isPlayoff
      ? playoffReminderHeading(m.roundLabel)
      : `Week ${m.week} matches`;
  // With an odd number of teams one rests each week. The reminder is the one
  // post that reaches players who don't open the site, so it names them too:
  // otherwise the resting team watches everyone else check in and wonders.
  const byes = m.isPlayoff || m.isTiebreaker ? [] : (m.byeTeamNames ?? []);
  const byeLine = byes.length
    ? `💤 Bye: ${byes.map((team) => `**${name(team)}**`).join(", ")} — no match this week.\n`
    : "";
  const footer =
    byeLine +
    "RSVP on your match page so captains can plan standins early." +
    // The reminder is the one weekly post everyone sees; pick'em otherwise
    // relies on people remembering to visit the page before kickoff.
    (m.pickemOpen ? ` Pick'em closes at kickoff: <${site}/pickem>` : "");
  // One reminder covers one kickoff, so the time goes once under the header
  // rather than repeating the same date on every row. Rows only carry their
  // own time if a caller ever mixes kickoffs.
  const kickoffs = new Set(
    m.fixtures.map((f) => Math.floor(f.scheduledAt / 1000)),
  );
  const sharedKickoff = kickoffs.size === 1 ? m.fixtures[0].scheduledAt : null;
  const lines = [`⏰ **${label} coming up — check in!**`];
  if (sharedKickoff != null) lines.push(`Kickoff: ${kickoffStamp(sharedKickoff)}`);
  const includedMentions: string[] = [];
  let shownFixtures = 0;

  const packedContent = (
    body: string[],
    omitted: number,
    shown: number,
  ): string | null => {
    const summaries =
      omitted > 0
        ? [
            reminderFixtureSummary(omitted, shown, true, site),
            reminderFixtureSummary(omitted, shown, false, site),
          ]
        : [null];
    for (const summary of summaries) {
      const content = [...body, ...(summary ? [summary] : []), footer].join(
        "\n",
      );
      if (content.length <= DISCORD_CONTENT_MAX) return content;
    }
    return null;
  };

  for (let index = 0; index < m.fixtures.length; index += 1) {
    const block = reminderFixtureBlock(
      m.fixtures[index],
      site,
      sharedKickoff == null,
    );
    const candidate = [...lines, ...block.lines];
    const omitted = m.fixtures.length - index - 1;
    if (!packedContent(candidate, omitted, index + 1)) break;
    lines.push(...block.lines);
    includedMentions.push(...block.mentionUserIds);
    shownFixtures += 1;
  }

  const omitted = m.fixtures.length - shownFixtures;
  const content = packedContent(lines, omitted, shownFixtures);
  if (!content) {
    // Defensive last resort for corrupted/unbounded input (for example an
    // absurd environment URL). Keep the reminder deliverable and explicit;
    // no user is allowlisted because this compact form displays no user.
    return {
      content:
        "⏰ **Match night is coming up — check in!**\n" +
        `${m.fixtures.length} fixture${m.fixtures.length === 1 ? " is" : "s are"} scheduled. View the full schedule on the league site.\n` +
        footer,
      mentionUserIds: [],
    };
  }

  const mentionUserIds = [...new Set(includedMentions)].filter((id) =>
    content.includes(`<@${id}>`),
  );
  return { content, mentionUserIds };
}

/** Backward-compatible pure formatter for surfaces/tests that need only text. */
export function weekReminderMessage(m: WeekReminderInput): string {
  return weekReminderAnnouncement(m).content;
}

export type CheckinNudgeInput = {
  captainName: string;
  teamName: string;
  homeName: string;
  awayName: string;
  week: number;
  isPlayoff: boolean;
  isTiebreaker?: boolean;
  /** `matchRoundLabel` for the fixture ("Semifinal"), so a playoff match is
   *  named by its round like every other post about it. */
  roundLabel?: string | null;
  /** Epoch ms of the kickoff; null = unscheduled (the time is left out). */
  whenMs: number | null;
  matchId: string;
  /** The captain's own players with no answer yet. Linked players are
   *  mentioned; the rest are named so they can still be chased. */
  waitingOn: { name: string; discordId: string | null }[];
};

/**
 * A captain's "please check in" for their OWN team's unanswered players, one
 * post with the match link. Only the players named here are allowlisted, so
 * nobody else on either team is pinged.
 */
export function checkinNudgeAnnouncement(m: CheckinNudgeInput): {
  content: string;
  /** Exact linked users visibly named in `content`. */
  mentionUserIds: string[];
} {
  const label = fixtureLabel(m);
  const t = m.whenMs != null ? Math.floor(m.whenMs / 1000) : null;
  const when = t != null ? ` (<t:${t}:F>, <t:${t}:R>)` : "";
  const shown = Math.min(m.waitingOn.length, WAITING_SHOWN);
  const content =
    `📋 **${name(m.captainName)}** needs check-ins for **${name(m.teamName)}**'s ${label} **${name(m.homeName)}** vs **${name(m.awayName)}**${when}.\n` +
    `Still waiting on: ${peopleList(m.waitingOn, shown)}. Tap ✓ or ✗ on the match page: <${resolveSiteUrl()}/matches/${m.matchId}>`;
  return {
    content,
    mentionUserIds: mentionIdsOf(m.waitingOn.slice(0, shown)),
  };
}

/**
 * Name at most this many unconfirmed players in the draft-night reminder.
 * The post goes to the whole league channel, and one that is mostly a column
 * of pings reads as spam and gets the channel muted, which costs every later
 * announcement too (the WAITING_SHOWN argument). Twenty still covers every
 * straggler in a typical 4-6 team pool, where most players have already
 * confirmed; past it the line states how many more, and the admin card lists
 * every one of them for a personal chase. The service orders linked players
 * first, so the capped slots go to people a mention can actually reach.
 */
const DRAFT_UNCONFIRMED_SHOWN = 20;

export type DraftReminderPerson = { name: string; discordId: string | null };

export type DraftReminderInput = {
  /** Admin-authored, so not escaped (the draftScheduledMessage rule). */
  seasonName: string;
  /** Epoch ms of Season.draftAt; rendered as <t:…> so readers see their zone. */
  draftAtMs: number;
  /** Season still in SIGNUPS: new PLAYER signups close when the auction starts
   *  (startDraft moves the season to DRAFT; registrationGate then refuses). */
  playerSignupsOpen: boolean;
  /** ACTIVE PLAYER registrations, captains included. */
  playerCount: number;
  /** Designated captains in draft order. Always mentioned where linked: they
   *  are the people the auction cannot run without. */
  captains: DraftReminderPerson[];
  /** Non-captain ACTIVE players who haven't confirmed the CURRENT draftAt
   *  revision, in the order they should be shown. */
  unconfirmed: DraftReminderPerson[];
};

export type DraftReminderAnnouncement = {
  content: string;
  /** Exact linked users visibly named in `content` (see WeekReminderAnnouncement). */
  mentionUserIds: string[];
};

/**
 * The draft-night reminder, with its mention allowlist built from exactly the
 * names that survived packing into Discord's 2,000-character limit. Captains
 * are packed first (the draft needs them), then unconfirmed players up to
 * DRAFT_UNCONFIRMED_SHOWN; anyone who doesn't fit is counted, never pinged.
 */
export function draftReminderAnnouncement(
  m: DraftReminderInput,
): DraftReminderAnnouncement {
  const site = resolveSiteUrl();
  const t = Math.floor(m.draftAtMs / 1000);
  const captainCount = m.captains.length;
  const unconfirmedCount = m.unconfirmed.length;
  const header = `⏰ **Draft night reminder: the ${m.seasonName} draft is scheduled for <t:${t}:F> (<t:${t}:R>).**`;
  const counts =
    `**${m.playerCount}** player${m.playerCount === 1 ? "" : "s"} signed up, ` +
    `**${captainCount}** captain${captainCount === 1 ? "" : "s"} designated. ` +
    (m.playerSignupsOpen
      ? "Player signups stay open until the auction starts."
      : "Player signups are closed; standins can still sign up.");
  const footer = `Draft room: <${site}/draft> · Signup page: <${site}/me>`;

  const who = peopleList;
  const render = (captainsShown: number, unconfirmedShown: number): string => {
    const lines = [header, counts];
    if (captainCount > 0) {
      lines.push(
        captainsShown > 0
          ? `Captains, be in the draft room before the auction starts: ${who(m.captains, captainsShown)}`
          : "Captains, be in the draft room before the auction starts.",
      );
    }
    if (unconfirmedCount > 0) {
      lines.push(
        unconfirmedShown > 0
          ? `Still to confirm this draft time (${unconfirmedCount}): ${who(m.unconfirmed, unconfirmedShown)}. Confirm on the signup page.`
          : `${unconfirmedCount} player${unconfirmedCount === 1 ? " is" : "s are"} still to confirm this draft time. Confirm on the signup page.`,
      );
    }
    lines.push(footer);
    return lines.join("\n");
  };
  const fits = (content: string) => content.length <= DISCORD_CONTENT_MAX;

  if (!fits(render(0, 0))) {
    // Defensive last resort for corrupted/unbounded input (an absurd season
    // name or site URL). Deliverable and explicit, and it names nobody, so
    // nobody is allowlisted.
    return {
      content: `⏰ **Draft night reminder: the draft is scheduled for <t:${t}:F> (<t:${t}:R>).** Captains and players, check the league site for the draft room and signups.`,
      mentionUserIds: [],
    };
  }
  let captainsShown = 0;
  while (
    captainsShown < captainCount &&
    fits(render(captainsShown + 1, 0))
  ) {
    captainsShown += 1;
  }
  const unconfirmedLimit = Math.min(unconfirmedCount, DRAFT_UNCONFIRMED_SHOWN);
  let unconfirmedShown = 0;
  while (
    unconfirmedShown < unconfirmedLimit &&
    fits(render(captainsShown, unconfirmedShown + 1))
  ) {
    unconfirmedShown += 1;
  }

  const content = render(captainsShown, unconfirmedShown);
  const mentionUserIds = mentionIdsOf([
    ...m.captains.slice(0, captainsShown),
    ...m.unconfirmed.slice(0, unconfirmedShown),
  ]);
  return { content, mentionUserIds };
}

/** A person's snowflake when it is a real one a mention can reach, else null. */
function mentionableId(p: DraftReminderPerson): string | null {
  const id = p.discordId?.trim();
  return id && normalizeMentionAllowlist({ users: [id] }) ? id : null;
}

/** `<@id>` for a linked person, their escaped site name otherwise. */
function personLabel(p: DraftReminderPerson): string {
  const id = mentionableId(p);
  return id ? `<@${id}>` : name(p.name);
}

/** The first `shown` people, comma-separated, plus "+N more" for the rest. */
function peopleList(people: DraftReminderPerson[], shown: number): string {
  const names = people.slice(0, shown).map(personLabel).join(", ");
  const extra = people.length - shown;
  return `${names}${extra > 0 ? ` +${extra} more` : ""}`;
}

/** The distinct mentionable ids among `people`, in order. */
function mentionIdsOf(people: DraftReminderPerson[]): string[] {
  return [
    ...new Set(
      people.flatMap((p) => {
        const id = mentionableId(p);
        return id ? [id] : [];
      }),
    ),
  ];
}

/** Oracle-of-the-week names shown before "and N more". */
const ORACLE_NAMES_SHOWN = 5;

export function weeklyHonorsMessage(honors: {
  /** The leaderboards link opens this season's boards (/leaders?season=),
   *  so the post still shows these honors after the next season starts. */
  seasonId: string;
  week: number;
  playerName: string | null;
  /** The Player of the Week's linked Discord id. On the first post it
   *  replaces the name with a mention (the send allowlists the same id); a
   *  correction never mentions anyone, so it can't ping twice. */
  playerDiscordId?: string | null;
  playerPoints: number;
  heroName: string | null;
  teamName: string | null;
  teamGameWins: number;
  /** A prior award was retracted by a result/box-score correction. */
  corrected?: boolean;
  /** Pick'em's best record that week (everyone tied on it); omitted when
   *  nobody called a match right. */
  oracle?: { names: string[]; correct: number; graded: number } | null;
}): string {
  const lines = [
    honors.corrected
      ? `🏅 **Correction: Week ${honors.week} honors have been updated.**`
      : `🏅 **Week ${honors.week} honors are in!**`,
  ];
  if (honors.playerName) {
    const player = { name: honors.playerName, discordId: honors.playerDiscordId ?? null };
    const who =
      !honors.corrected && mentionableId(player)
        ? personLabel(player)
        : `**${name(honors.playerName)}**`;
    lines.push(
      `⭐ Player of the Week: ${who} — ${honors.playerPoints} impact points${honors.heroName ? ` on ${honors.heroName}` : ""}`,
    );
  }
  if (honors.teamName) {
    lines.push(
      `🛡️ Team of the Week: **${name(honors.teamName)}** (${honors.teamGameWins} game win${honors.teamGameWins === 1 ? "" : "s"})`,
    );
  }
  if (honors.oracle && honors.oracle.names.length > 0) {
    const { names, correct, graded } = honors.oracle;
    const shown = names
      .slice(0, ORACLE_NAMES_SHOWN)
      .map((n) => `**${name(n)}**`);
    const more = names.length - shown.length;
    const list =
      more > 0
        ? `${shown.join(", ")} and ${more} more`
        : shown.length > 1
          ? `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`
          : shown[0];
    lines.push(
      `🔮 Pick'em Oracle${names.length === 1 ? "" : "s"} of the Week: ${list} (${correct} of ${graded} picks right${names.length === 1 ? "" : " each"})`,
    );
  }
  if (honors.corrected && !honors.playerName && !honors.teamName) {
    lines.push(
      "The previous honors are withdrawn; no eligible box-score award remains for this week.",
    );
  }
  lines.push(
    `Full leaderboards: <${resolveSiteUrl()}/leaders?season=${encodeURIComponent(honors.seasonId)}>`,
  );
  return lines.join("\n");
}

/** A captain-agreed reschedule — the new time is pre-formatted by the caller. */
export function rescheduleMessage(m: {
  homeName: string;
  awayName: string;
  week: number;
  isPlayoff: boolean;
  isTiebreaker?: boolean;
  /** Epoch ms of the agreed time — rendered via Discord's native timestamp
   *  markup so every reader sees it in their own timezone (a server-formatted
   *  string would be UTC wall-time in prod, wrong hour and often wrong day). */
  whenMs: number;
  /** RSVPs the retime invalidated — the rosters have to hear about this. */
  clearedRsvps?: number;
  /** `matchRoundLabel` ("Semifinal"): names a playoff fixture's round. */
  roundLabel?: string | null;
  /** Deep link to the match page, where players check in again (the admin
   *  retime's shape). Optional so hand-built calls stay valid. */
  matchId?: string;
}): string {
  const label = m.isTiebreaker
    ? `Tiebreaker week ${m.week}`
    : m.isPlayoff
      ? (playoffFixtureTitle(m.roundLabel) ?? "Playoffs")
      : `Week ${m.week}`;
  const t = `<t:${Math.floor(m.whenMs / 1000)}:F>`;
  // Retiming clears every check-in (an old answer about a night nobody is
  // playing). Saying so is the only notice the roster gets — the site shows
  // them an empty banner with no explanation of why their ✓ vanished.
  const reset = m.clearedRsvps
    ? ` Check-ins were reset (${m.clearedRsvps} cleared) — everyone please RSVP again.`
    : "";
  const link = m.matchId
    ? ` <${resolveSiteUrl()}/matches/${m.matchId}>`
    : "";
  return `🗓️ **Rescheduled** — ${label}: **${name(m.homeName)}** vs **${name(m.awayName)}** now plays ${t} (both captains agreed).${reset}${link}`;
}

export type AdminRetimeMove = {
  matchId: string;
  homeName: string;
  awayName: string;
  week: number;
  isPlayoff: boolean;
  isTiebreaker?: boolean;
  /** Epoch ms of the new kickoff; null when the admin CLEARED the time. */
  whenMs: number | null;
  /** The fixture had no kickoff before this change, so its time is SET, not
   *  moved: calling a first-ever time a move sends players looking for an
   *  earlier time they never had. */
  firstTime?: boolean;
  /** `matchRoundLabel` ("Semifinal"): names a playoff fixture's round. */
  roundLabel?: string | null;
};

const ADMIN_RETIME_MAX_LINES = 10;

/**
 * An admin retime (Set time, or the week mover). Captain-agreed reschedules
 * always announced; admin moves said nothing, so the only sign a fixture had
 * moved was an empty check-in banner. Kickoffs render as `<t:…:F>`. A fixture
 * getting its first time (fixtures generated without times, then a match
 * night set) reads "Kickoff set"; "moved" is kept for a time that existed.
 */
export function adminRetimeMessage(m: {
  moves: AdminRetimeMove[];
  clearedRsvps: number;
}): string {
  const label = (move: AdminRetimeMove) =>
    move.isTiebreaker
      ? `Tiebreaker week ${move.week}`
      : move.isPlayoff
        ? (playoffFixtureTitle(move.roundLabel) ?? "Playoffs")
        : `Week ${move.week}`;
  const when = (move: AdminRetimeMove) =>
    move.whenMs == null
      ? "unscheduled for now"
      : `<t:${Math.floor(move.whenMs / 1000)}:F>`;
  const reset = m.clearedRsvps
    ? ` Check-ins were reset (${m.clearedRsvps} cleared) — everyone please RSVP again.`
    : "";
  const site = resolveSiteUrl();
  // Clearing a time is never a first time: there was one to clear.
  const isSet = (move: AdminRetimeMove) =>
    !!move.firstTime && move.whenMs != null;
  if (m.moves.length === 1) {
    const [move] = m.moves;
    if (isSet(move)) {
      return `🗓️ **Kickoff set** — ${label(move)}: **${name(move.homeName)}** vs **${name(move.awayName)}** plays ${when(move)} (set by an admin).${reset} <${site}/matches/${move.matchId}>`;
    }
    const what = move.whenMs == null ? "is" : "now plays";
    return `🗓️ **Kickoff moved** — ${label(move)}: **${name(move.homeName)}** vs **${name(move.awayName)}** ${what} ${when(move)} (set by an admin).${reset} <${site}/matches/${move.matchId}>`;
  }
  const setCount = m.moves.filter(isSet).length;
  const movedCount = m.moves.length - setCount;
  const mixed = setCount > 0 && movedCount > 0;
  const shown = m.moves.slice(0, ADMIN_RETIME_MAX_LINES);
  const lines = shown.map(
    (move) =>
      `• ${label(move)}: **${name(move.homeName)}** vs **${name(move.awayName)}** — ${when(move)}${
        // Only a mixed post needs to say which lines moved; in the others
        // the header already says it for every line.
        mixed && !isSet(move) && move.whenMs != null ? " (moved)" : ""
      }`,
  );
  const more = m.moves.length - shown.length;
  if (more > 0) lines.push(`• …and ${more} more`);
  const header =
    movedCount === 0
      ? `🗓️ **Kickoffs set** by an admin — ${setCount} matches now have kickoff times:`
      : setCount === 0
        ? `🗓️ **Schedule moved** by an admin — ${m.moves.length} matches have new kickoffs:`
        : `🗓️ **Schedule updated** by an admin — ${setCount} new kickoff${setCount === 1 ? "" : "s"} and ${movedCount} moved:`;
  return `${header}\n${lines.join("\n")}\n${reset.trim() ? `${reset.trim()} ` : ""}Full schedule: <${site}/schedule>`;
}

export function testMessage(): string {
  return `👋 Webhook test from **${process.env.NEXT_PUBLIC_APP_NAME || "the league site"}** — notifications are wired up.`;
}

/**
 * League news post → announcement with a body snippet and a link to /news.
 * Given the post id, the link deep-links to that specific post (/news#id).
 */
export function newsMessage(title: string, body: string, id?: string): string {
  // Pull the first GIF/image/video out of the body so it's never lost to the
  // 200-char snippet truncation, and append the *normalized* direct URL on its
  // own trailing line where Discord reliably auto-embeds it (a pasted Giphy/
  // Tenor page link is rewritten to its direct media URL — see normalizeMediaUrl).
  const tokens = splitLinks(body);
  const media = tokens.find((t) => t.type === "image" || t.type === "video");
  const prose = tokens
    .filter((t) => t !== media)
    .map((t) => t.value)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  const snippet =
    prose.length > 200 ? `${prose.slice(0, 199).trimEnd()}…` : prose;
  const link = `${resolveSiteUrl()}/news${id ? `#${id}` : ""}`;
  const lines = [`📣 **${title}**`];
  if (snippet) lines.push(snippet);
  lines.push(`More: <${link}>`);
  if (media) lines.push(media.value);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

function runtimeWebhookUrl(value: string | null | undefined): string | null {
  const normalized = normalizeDiscordWebhookUrl(value);
  if (normalized) return normalized;
  // The transport integration suite uses a loopback HTTP server to inspect
  // the exact webhook wire format. Never widen the production validator for a
  // test stand-in; keep the exception both environment- and host-pinned here.
  if (process.env.NODE_ENV === "test" && value) {
    try {
      const url = new URL(value);
      if (
        url.protocol === "http:" &&
        url.hostname === "127.0.0.1" &&
        /^\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+$/.test(url.pathname) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      ) {
        return value;
      }
    } catch {
      // Invalid test input remains disabled.
    }
  }
  return null;
}

export async function getWebhookUrl(): Promise<string | null> {
  const fromDb = await getSetting(SETTING_KEYS.DISCORD_WEBHOOK_URL);
  return (
    runtimeWebhookUrl(fromDb) ??
    runtimeWebhookUrl(process.env.DISCORD_WEBHOOK_URL)
  );
}

/**
 * Where inhouse ALERTS go — the queue ping, "match found", and results.
 *
 * Separate from getInhouseWebhookUrl (the QUEUE BOARD's channel) because the
 * board is a message that lives at the bottom of its channel and is read at a
 * glance: a single alert posted under it pushes it out of view, which defeats
 * the entire design. Unset = alerts share the board's channel, i.e. the
 * previous behaviour.
 */
export async function getInhouseAlertWebhookUrl(): Promise<string | null> {
  const fromDb = await getSetting(SETTING_KEYS.INHOUSE_ALERT_WEBHOOK_URL);
  const configured =
    runtimeWebhookUrl(fromDb) ??
    runtimeWebhookUrl(process.env.DISCORD_INHOUSE_ALERT_WEBHOOK_URL);
  return configured || (await getInhouseWebhookUrl());
}

/**
 * The role the two interrupting inhouse messages may ping. Null = nobody gets
 * notified, which is exactly what the league had before this existed.
 */
export async function getInhousePingRoleId(): Promise<string | null> {
  return (
    (await getSetting(SETTING_KEYS.INHOUSE_PING_ROLE_ID)) ||
    process.env.DISCORD_INHOUSE_ROLE_ID ||
    null
  );
}

/**
 * Where the persistent INHOUSE BOARD goes. Alerts have their own resolver
 * (`getInhouseAlertWebhookUrl`) and fall back here when no alert channel is
 * configured. A Discord webhook is bound to the channel it was created in, so
 * this separation can keep a quiet board-only channel even on a busy night.
 *
 * FALLS BACK to the league webhook when unset, which is what every league that
 * never configures this keeps getting — one channel, exactly as before.
 */
export async function getInhouseWebhookUrl(): Promise<string | null> {
  const fromDb = await getSetting(SETTING_KEYS.INHOUSE_WEBHOOK_URL);
  const configured =
    runtimeWebhookUrl(fromDb) ??
    runtimeWebhookUrl(process.env.DISCORD_INHOUSE_WEBHOOK_URL);
  return configured || (await getWebhookUrl());
}

/**
 * A safe, display-only fingerprint of a webhook URL. The full URL is a bearer
 * credential (anyone holding it can post to the channel — prime phishing bait),
 * so it must NEVER be sent to the browser. This keeps a short piece of the id
 * (a Discord webhook is `…/webhooks/<id>/<secret-token>`) and hides the token
 * entirely — enough for an admin to confirm one is set, useless to an attacker.
 * Pure so it can be unit-tested.
 */
export function maskWebhookUrl(url: string | null | undefined): string {
  if (!url) return "";
  const m = url.match(/\/webhooks\/(\d+)\/(.+)$/);
  if (!m) return "configured";
  const id = m[1];
  const idHint = id.length > 6 ? `${id.slice(0, 4)}…${id.slice(-2)}` : id;
  return `discord.com/api/webhooks/${idHint}/••••••••`;
}

/**
 * The webhook id out of a webhook URL (`…/webhooks/<id>/<token>`). Used to
 * detect that an admin swapped in a webhook for a DIFFERENT channel, which
 * strands any message we were editing. Regenerating a token keeps the same id,
 * so that case correctly survives. Pure.
 */
export function webhookIdOf(url: string | null | undefined): string | null {
  const m = url?.match(/\/webhooks\/(\d+)\//);
  return m ? m[1] : null;
}

/**
 * Pin the webhook URL to API v10. An unversioned `/api/webhooks/…` routes to
 * Discord's DEFAULT version, which is still v6 and marked deprecated; only v10
 * and v9 are listed as available. It works today, but the message-edit
 * endpoints this file now depends on should not ride a deprecated default.
 * Idempotent — a URL that already carries a version is rewritten to v10. Pure.
 */
export function webhookApiUrl(url: string): string {
  return url.replace(/\/api\/(v\d+\/)?webhooks\//, "/api/v10/webhooks/");
}

/** What a webhook message can carry. Embeds keep the queue board off the
 *  plain-text path so it reads as a panel rather than a chat line. */
export type WebhookPayload = { content?: string; embeds?: unknown[] };

/** Always sent on every POST *and* PATCH — see patchWebhookMessage. */
const NO_MENTIONS = { parse: [] as string[] };

/**
 * POST a message and return its id, via `?wait=true`.
 *
 * `wait` defaults to false, which answers 204 with no body — and there is no
 * endpoint to look the id up afterwards, so a message sent without it can
 * never be edited again. Anything we intend to rewrite in place MUST go
 * through here. Best-effort: null on any failure, never throws.
 */
export async function postWebhookMessage(
  url: string,
  payload: WebhookPayload,
): Promise<{ id: string } | null> {
  return postKeepingId(url, payload, NO_MENTIONS);
}

async function postKeepingId(
  url: string,
  payload: WebhookPayload,
  allowedMentions: { parse: string[] },
): Promise<{ id: string } | null> {
  const target = runtimeWebhookUrl(url);
  if (!target) return null;
  if (!discordMutationsAllowed()) return null;
  try {
    const res = await fetch(`${webhookApiUrl(target)}?wait=true`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, allowed_mentions: allowedMentions }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { id?: unknown };
    return typeof json.id === "string" ? { id: json.id } : null;
  } catch {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[discord] webhook post failed");
    }
    return null;
  }
}

/** `gone` = the message or webhook no longer exists; stop trying forever. */
export type WebhookEditResult = "ok" | "gone" | "failed";

/**
 * Rewrite a message this webhook sent earlier, in place.
 *
 * Editing does not notify anyone, does not mark the channel unread and does
 * not bump it — that silence is the entire point of the queue board. But the
 * silence is CONDITIONAL: Discord rebuilds a message's mention list from
 * scratch on every edit and parses it with DEFAULT allowances, ignoring
 * whatever the original send specified. So `allowed_mentions` has to be
 * repeated on each PATCH or a Steam persona of "@everyone" turns a permanently
 * pinned message into a permanent mass ping. It is not optional.
 *
 * Shorter timeout than an announcement (2.5s vs 5s): the board is cosmetic and
 * rides the inhouse poll path, so it must never be what makes a room feel slow.
 */
export async function patchWebhookMessage(
  url: string,
  messageId: string,
  payload: WebhookPayload,
): Promise<WebhookEditResult> {
  const target = runtimeWebhookUrl(url);
  if (!target) return "failed";
  if (!discordMutationsAllowed()) return "failed";
  try {
    const res = await fetch(
      `${webhookApiUrl(target)}/messages/${encodeURIComponent(messageId)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, allowed_mentions: NO_MENTIONS }),
        signal: AbortSignal.timeout(2500),
      },
    );
    if (res.ok) return "ok";
    // 404 = message deleted (10008) or webhook deleted (10015). 401/403 = the
    // token was regenerated or revoked. All four are permanent for this
    // message: retrying every 10s forever would just accumulate invalid
    // requests, which is what Discord IP-bans on (10,000 per 10 minutes).
    // Anything else (5xx, 429) is transient — "failed" leaves the stored
    // digest untouched so the next tick naturally retries.
    if (res.status === 404 || res.status === 401 || res.status === 403) {
      return "gone";
    }
    return "failed";
  } catch {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[discord] webhook edit failed");
    }
    return "failed";
  }
}

/**
 * How a webhook message DELETE went. "gone" is Discord's 404: this webhook
 * has no such message. That is either a message already deleted in the
 * channel or one a DIFFERENT webhook sent (message routes are scoped to the
 * webhook that sent them), so it is not proof the message is off the channel.
 */
type WebhookDeleteResult = "deleted" | "gone" | "failed";

async function deleteWebhookMessageResult(
  url: string,
  messageId: string,
): Promise<WebhookDeleteResult> {
  const target = runtimeWebhookUrl(url);
  if (!target) return "failed";
  if (!discordMutationsAllowed()) return "failed";
  try {
    const res = await fetch(
      `${webhookApiUrl(target)}/messages/${encodeURIComponent(messageId)}`,
      { method: "DELETE", signal: AbortSignal.timeout(2500) },
    );
    if (res.ok) return "deleted";
    return res.status === 404 ? "gone" : "failed";
  } catch {
    return "failed";
  }
}

/** Remove a message this webhook sent (admin "Remove board"). Best-effort. */
export async function deleteWebhookMessage(
  url: string,
  messageId: string,
): Promise<boolean> {
  // Already gone counts as success here: the board stores the id of the
  // webhook that posted it and never deletes a stranded board through this
  // route (see inhouse-board-service), so its 404 really is "deleted".
  return (await deleteWebhookMessageResult(url, messageId)) !== "failed";
}

/** How a news post's trip to Discord went. */
export type NewsDiscordPost =
  | { ok: true; id: string }
  | { ok: false; reason: "no-webhook" | "failed" };

/**
 * Post a league news announcement to the league channel and keep its message
 * id, so an edit can rewrite this copy and a delete can remove it. News goes
 * straight to the webhook rather than through the announcement queue because
 * the queue's sender cannot hand back an id; the admin sees the outcome in the
 * toast and can post again from the edit form.
 *
 * `pingEveryone` is the admin's explicit tick on the form. Only then does the
 * message open with @everyone and only then does `allowed_mentions` let it
 * ping; every other news post parses no mentions at all, like the rest of the
 * league's announcements.
 */
export async function postNewsToDiscord(
  content: string,
  pingEveryone: boolean,
): Promise<NewsDiscordPost> {
  const body = pingEveryone ? `@everyone\n${content}` : content;
  if (!isValidDiscordContent(body)) return { ok: false, reason: "failed" };
  let url: string | null;
  try {
    url = await getWebhookUrl();
  } catch {
    return { ok: false, reason: "failed" };
  }
  if (!url) return { ok: false, reason: "no-webhook" };
  const sent = await postKeepingId(
    url,
    { content: body },
    pingEveryone ? { parse: ["everyone"] } : NO_MENTIONS,
  );
  return sent ? { ok: true, id: sent.id } : { ok: false, reason: "failed" };
}

/**
 * Rewrite a news post's Discord copy after an edit. The edit never pings: the
 * PATCH parses no mentions, so an @everyone the original carried is not
 * re-sent (Discord rebuilds mentions on every edit). "gone" means the copy was
 * deleted in the channel or the webhook changed.
 */
export async function editNewsOnDiscord(
  messageId: string,
  content: string,
): Promise<WebhookEditResult | "no-webhook"> {
  let url: string | null;
  try {
    url = await getWebhookUrl();
  } catch {
    return "failed";
  }
  if (!url) return "no-webhook";
  return patchWebhookMessage(url, messageId, { content });
}

/**
 * Remove a deleted news post's Discord copy through the CURRENT league
 * webhook. "deleted" is the only confirmed removal. "gone" (a 404) means the
 * copy was already deleted in the channel OR was sent by a webhook that has
 * since been replaced, which cannot delete it; "failed" covers no webhook
 * and every other error. Both leave the copy possibly still up.
 */
export async function deleteNewsFromDiscord(
  messageId: string,
): Promise<WebhookDeleteResult> {
  let url: string | null;
  try {
    url = await getWebhookUrl();
  } catch {
    return "failed";
  }
  if (!url) return "failed";
  return deleteWebhookMessageResult(url, messageId);
}

export type DiscordSendOptions = {
  /** Stable domain-event identity. Ignored for explicit direct sends. */
  dedupeKey?: string;
  /** Setting marker generation that must still own this queued payload. */
  marker?: LeagueAnnouncementMarker;
  /** False is reserved for webhook health checks and transport tests. */
  durable?: boolean;
  /**
   * Time-bound posts are dropped instead of sent once this passes, so a
   * webhook outage can't deliver a reminder for a match already played.
   */
  expiresAt?: Date;
  /**
   * For posts that go stale on an event rather than at a known time: every
   * post still waiting in this group is dropped by
   * expireLeagueAnnouncementGroup (the live draft's posts once the draft
   * ends — draftLiveAnnouncementGroup). Rides the dedupe key, so it replaces
   * `dedupeKey` for these one-off posts.
   */
  expiryGroup?: string;
  /**
   * Queue now, but make the immediate delivery attempt after the HTTP response
   * is sent (runAfterResponse), so the request that triggered the post never
   * waits on Discord. For hot paths such as the live draft, where the captain
   * whose poll or bid closed the last lot would otherwise sit frozen for up to
   * 5s per post. If that attempt is lost, the minute worker drains the row.
   */
  afterResponse?: boolean;
};

/**
 * How many queued rows one after-response attempt may deliver. More than one
 * on purpose: two posts queued by one request (the draft's teams post, then
 * its recap) each schedule an attempt, and after() runs them concurrently. The
 * queue delivers strictly in order, so the second attempt finds the first
 * row mid-send and gives up; the first attempt then carries on to the next
 * row instead of leaving it for the minute worker.
 */
const AFTER_RESPONSE_DELIVERY_LIMIT = 4;

/**
 * Persist a league announcement before webhook I/O. `true` means the work is
 * durably accepted (not necessarily delivered yet); the leased queue owns a
 * temporary Discord failure from that point onward. With `durable: false`,
 * preserve the old direct transport result for admin webhook health checks.
 */
export async function sendDiscordMessage(
  content: string,
  mentions?: MentionAllowlist,
  options: DiscordSendOptions = {},
): Promise<boolean> {
  // Do not even enqueue from a preview: a successful return would claim an
  // external notification was accepted when the preview is intentionally
  // forbidden from delivering it.
  if (!discordMutationsAllowed()) return false;
  const allowed = normalizeMentionAllowlist(mentions);
  if (
    !content.trim() ||
    !isValidDiscordContent(materializeAllowedMentions(content, allowed))
  ) {
    return false;
  }

  let url: string | null;
  try {
    url = await getWebhookUrl();
  } catch {
    return false;
  }
  if (!url) return false;
  if (options.durable === false) return sendTo(url, content, allowed);

  let event: Awaited<ReturnType<typeof enqueueLeagueAnnouncement>>;
  try {
    event = await enqueueLeagueAnnouncement({
      content,
      mentions: allowed,
      dedupeKey: options.expiryGroup
        ? `${options.expiryGroup}${options.dedupeKey ?? randomUUID()}`
        : options.dedupeKey,
      marker: options.marker,
      expiresAt: options.expiresAt ?? null,
    });
  } catch {
    return false;
  }

  // Persistence is the success boundary. Make one best-effort attempt for the
  // immediate UX, but a DB/Discord failure after enqueue belongs to the cron
  // drain and must not make the domain action believe its notification vanished.
  if (event.status !== LEAGUE_ANNOUNCEMENT_STATUS.SENT) {
    const attempt = (limit: number) =>
      deliverLeagueAnnouncements({
        limit,
        send: (queuedContent, queuedMentions) =>
          postTo(url, queuedContent, queuedMentions),
      });
    if (options.afterResponse) {
      await runAfterResponse(() => attempt(AFTER_RESPONSE_DELIVERY_LIMIT));
    } else {
      try {
        await attempt(1);
      } catch {
        // Durable row remains pending; the worker retries it.
      }
    }
  }
  return true;
}

export type PendingLeagueAnnouncementDeliveryOptions = {
  now?: Date;
  limit?: number;
};

/** Bounded production drain for the unattended maintenance worker. */
export async function deliverPendingLeagueAnnouncements(
  options: PendingLeagueAnnouncementDeliveryOptions = {},
): Promise<LeagueAnnouncementDelivery> {
  if (!discordMutationsAllowed()) {
    const pending = await hasPendingLeagueAnnouncements();
    return {
      attempted: 0,
      delivered: 0,
      pending,
      ...(pending
        ? { blocked: "DISCORD_MUTATIONS_DISABLED" as const }
        : {}),
    };
  }
  const url = await getWebhookUrl();
  if (!url) {
    const pending = await hasPendingLeagueAnnouncements();
    return {
      attempted: 0,
      delivered: 0,
      pending,
      ...(pending ? { blocked: "WEBHOOK_UNAVAILABLE" as const } : {}),
    };
  }
  return deliverLeagueAnnouncements({
    now: options.now,
    limit: options.limit ?? 1,
    send: (content, mentions) => postTo(url, content, mentions),
  });
}

/**
 * The expiry group for one season's live-draft posts ("the draft is LIVE",
 * paused, resumed, a voided lot, an undone sale). They are news only while
 * the auction runs, so the draft's end drops any still waiting.
 */
export function draftLiveAnnouncementGroup(seasonId: string): string {
  return `draft-live:${seasonId}:`;
}

/**
 * Announce an inhouse EVENT through the alerts resolver. Queue/match/result
 * alerts can live apart from the persistent board; when unset they fall back
 * to the board channel, then ultimately the league channel.
 */
export async function sendInhouseDiscordMessage(
  content: string,
  mentions?: MentionAllowlist,
): Promise<boolean> {
  return sendTo(await getInhouseAlertWebhookUrl(), content, mentions);
}

/**
 * Who this ONE message is allowed to notify, by id. Everything else stays
 * suppressed.
 *
 * The blanket `parse: []` on every send exists so that a player-controlled
 * Steam persona of "@everyone" can never become a mass ping. An ID allowlist
 * preserves that exactly: `parse: []` still refuses @everyone/@here and any
 * role or user NOT named here, so untrusted text in the same message stays
 * inert. Only ids the SERVER chose can ring a phone.
 *
 * Note the shape Discord rejects is `parse` CONTAINING "roles"/"users"
 * alongside a `roles`/`users` array — an empty parse with an allowlist is the
 * documented way to say "these and nothing else".
 */
async function sendTo(
  url: string | null,
  content: string,
  mentions?: MentionAllowlist,
): Promise<boolean> {
  return (await postTo(url, content, mentions)) === true;
}

/**
 * sendTo, keeping Discord's answer: `true` when accepted, `{ status }` when
 * Discord answered with an error, `false` when there was no answer at all.
 * The league queue needs the status to tell a refused post (drop it) from a
 * dead webhook (pause and tell the admin).
 */
async function postTo(
  url: string | null,
  content: string,
  mentions?: MentionAllowlist,
): Promise<LeagueSendResult> {
  const target = runtimeWebhookUrl(url);
  if (!target) return false;
  if (!discordMutationsAllowed()) return false;
  try {
    const allowed = normalizeMentionAllowlist(mentions);
    const renderedContent = materializeAllowedMentions(content, allowed);
    if (!isValidDiscordContent(renderedContent)) return false;
    // webhookApiUrl, not the raw URL: an unversioned /api/webhooks/… routes to
    // Discord's DEFAULT version, still v6 and deprecated. The board's transport
    // has always pinned v10 and these ~28 announcements silently didn't — the
    // same webhook string reaching Discord two different ways.
    const res = await fetch(webhookApiUrl(target), {
      method: "POST",
      headers: { "content-type": "application/json" },
      // parse:[] disables every automatic mention. Only the normalized ids we
      // explicitly materialized above may resolve, so a player whose Steam
      // persona is "@everyone" (or a team/news title with @here, <@id>,
      // <@&role>) cannot turn an announcement into an unrelated mass ping.
      body: JSON.stringify({
        content: renderedContent,
        allowed_mentions: {
          parse: [],
          ...(allowed?.roles?.length ? { roles: allowed.roles } : {}),
          ...(allowed?.users?.length ? { users: allowed.users } : {}),
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok ? true : { status: res.status };
  } catch {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[discord] webhook send failed");
    }
    return false;
  }
}
