import { getSetting, SETTING_KEYS } from "./settings";
import { resolveSiteUrl } from "./site-url";
import { splitLinks } from "./linkify";
import { escapeDiscordText } from "./discord-escape";
import { potTier, tierLabel, type BetOutcome } from "./inhouse-bets";

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

export function signupMessage(
  playerName: string,
  signedUp: number,
  neededToStart: number,
  /** Epoch ms of the scheduled draft night, if the admin has set one. */
  draftAtMs?: number | null,
): string {
  const remaining = Math.max(0, neededToStart - signedUp);
  const tail =
    remaining === 0
      ? "that's enough to start the draft! 🎉"
      : `${remaining} more to start the draft.`;
  const when = draftAtMs
    ? ` Draft night: <t:${Math.floor(draftAtMs / 1000)}:F>.`
    : "";
  return `📝 **${name(playerName)}** signed up — ${signedUp} player${signedUp === 1 ? "" : "s"} in, ${tail}${when}`;
}

export function draftScheduledMessage(
  seasonName: string,
  whenMs: number,
): string {
  return `🗓️ **The ${seasonName} draft is set for <t:${Math.floor(whenMs / 1000)}:F>** — captains and players, be there: <${resolveSiteUrl()}/draft>`;
}

export function draftStartedMessage(seasonName: string): string {
  return `🔨 **The ${seasonName} draft is LIVE!** Captains are on the clock — watch the auction at <${resolveSiteUrl()}/draft>`;
}

export function draftCompleteMessage(seasonName: string): string {
  return `✅ **The ${seasonName} draft is complete!** Rosters are locked — see the teams at <${resolveSiteUrl()}/teams>`;
}

/** Draft-night superlatives, appended right after the complete message. */
export function draftRecapMessage(r: {
  biggestSpend: { name: string; teamName: string; price: number } | null;
  bestValue: { name: string; teamName: string; price: number } | null;
  topSpender: { teamName: string; spent: number } | null;
  totalSpent: number;
}): string {
  const lines = [`📊 **Draft night in numbers** — $${r.totalSpent} changed hands.`];
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

export function playerSoldMessage(
  playerName: string,
  teamName: string,
  price: number,
): string {
  const tag =
    price >= 50 ? " 💸 big spender!" : price <= 1 ? " — a steal!" : "";
  return `💰 **${name(playerName)}** → **${name(teamName)}** for **$${price}**${tag}`;
}

export function matchResultMessage(m: {
  homeName: string;
  awayName: string;
  homeScore: number;
  awayScore: number;
  week: number;
  isPlayoff: boolean;
  /** Ruled/defaulted result — say so, or the channel reads a no-show as a
   *  played sweep. Optional so every existing call site is unchanged. */
  forfeit?: boolean;
}): string {
  const label = m.isPlayoff ? "Playoffs" : `Week ${m.week}`;
  const home = name(m.homeName);
  const away = name(m.awayName);
  const winner =
    m.homeScore > m.awayScore
      ? home
      : m.awayScore > m.homeScore
        ? away
        : null;
  const line = `⚔️ **${label}:** ${home} ${m.homeScore}–${m.awayScore} ${away}`;
  const tail = winner
    ? m.forfeit
      ? `${line} — **${winner}** take the series by forfeit.`
      : `${line} — **${winner}** take the series!`
    : `${line} — a draw!`;
  return tail;
}

export function playoffsStartedMessage(
  seasonName: string,
  pairings: { home: string; away: string }[],
): string {
  const lines = pairings.map((p) => `• ${name(p.home)} vs ${name(p.away)}`).join("\n");
  return `🏁 **${seasonName} playoffs are set!**\n${lines}\nBracket: <${resolveSiteUrl()}/schedule>`;
}

export function championMessage(
  seasonName: string,
  teamName: string,
): string {
  return `👑 **${name(teamName)}** are the **${seasonName}** champions! GG everyone — recap at <${resolveSiteUrl()}/recap>`;
}

export function freeAgentSignedMessage(
  playerName: string,
  teamName: string,
): string {
  // Ends by naming the signed player's next move — a signing is a season-long
  // obligation (every remaining match night), so the send mentions them and
  // the copy tells them what being signed asks of them, the standin-assign rule.
  return `🖊️ **${name(playerName)}** signs with **${name(teamName)}** as a free agent — roster updated: <${resolveSiteUrl()}/teams>. ${name(playerName)}: their schedule is yours now — check in on your match pages: <${resolveSiteUrl()}/schedule>`;
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
 * Lobby formed — the scarcest event the league produces, on a 45-second clock.
 * Players who linked Discord are mentioned by id so the ping reaches a PHONE;
 * the rest are named as plain text. Queueing thirty seconds ago is the consent
 * here, which is why this needs no opt-in role (don't "fix" that later).
 */
export function inhouseLobbyMessage(
  players: { name: string; discordId: string | null }[],
  roleId?: string | null,
): string {
  const who = players
    .map((p) => (p.discordId ? `<@${p.discordId}>` : name(p.name)))
    .join(", ");
  return `${rolePrefix(roleId)}🚨 **Inhouse match found!** Accept your game before the clock runs out — <${resolveSiteUrl()}/inhouse>\n${who}`;
}

/**
 * One settled wager, as inhouse-service adapts it from `settleBets`: a
 * `SettledBet` plus the player's name, taken off the history scan that function
 * already has in hand rather than a fresh query.
 *
 * Deliberately carries NO team number. A settled slip's side is derivable — a
 * WON bet was on the winning side, a LOST bet on the other — and team 1 is not
 * always Radiant (`radiantTeam` is decided by the game that got played, not by
 * the draft), so a raw team number here would be one more thing to get
 * backwards in the one message that tells ten people where their Cred went.
 * A voided slip has no side worth printing at all: it never entered a pool.
 */
export type InhouseBetSlip = {
  name: string;
  stake: number;
  /** How much of the stake the other side actually covered. */
  matched: number;
  outcome: BetOutcome;
  /** Net Cred. The unmatched remainder is not in here — it was never at risk. */
  delta: number;
};

const VOID_REASON: Record<"VOID_LINEUP" | "VOID_LATE", string> = {
  // Neutral on purpose. A lineup void usually means the played game put them on
  // the other side, but it also fires when we can't tie them to a side at all,
  // and this line is read by the person it names.
  VOID_LINEUP: "lineup changed",
  VOID_LATE: "placed after the game started",
};

function isVoid(
  s: InhouseBetSlip,
): s is InhouseBetSlip & { outcome: "VOID_LINEUP" | "VOID_LATE" } {
  return s.outcome === "VOID_LINEUP" || s.outcome === "VOID_LATE";
}

/** `+43` / `-43` / `0` — the sign carries the whole story, so never drop it. */
function signedCred(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

/** Biggest slip first; the raw (pre-escape) name is the tiebreak, so the same
 *  settlement always reads the same way — the repo's total-order convention. */
function bySlipSize(a: InhouseBetSlip, b: InhouseBetSlip): number {
  return b.stake - a.stake || a.name.localeCompare(b.name);
}

/**
 * Who was in for what, appended to the inhouse result post.
 *
 * OMITTED ENTIRELY when nobody bet. A league that never touches the economy has
 * to get byte-for-byte what it got before the economy existed — that is what
 * makes `slips` safe for the service to pass unconditionally, and there is a
 * test pinning it.
 *
 * No emoji, and no MentionAllowlist: this message names no action anyone can
 * take, and a notification people can't act on is what gets a channel muted.
 */
function betSlipsBlock(
  slips: InhouseBetSlip[],
  winnerSide: "Radiant" | "Dire",
): string {
  const voided = slips.filter(isVoid);
  const live = slips.filter((s) => !isVoid(s));
  const lines: string[] = [];

  if (live.length > 0) {
    // The pot is the SURVIVING stakes only: a voided bet is handed back in
    // full, so counting it here would advertise a pot that partly never
    // existed — and would push the tier label up on a game where the money came
    // home. The room's live panel can't know that yet; this one does.
    const pot = live.reduce((n, s) => n + s.stake, 0);
    // Σ matched over BOTH sides is 2M by construction — each side's matched
    // total is the same M — so this is the Cred that was genuinely in play and
    // `pot - covered` is what was never at risk.
    const covered = live.reduce((n, s) => n + s.matched, 0);
    const label = tierLabel(potTier(pot));
    const coverage =
      covered === 0
        ? // Not a failure state and not phrased as one: even money means the
          // side that thinks it is behind stakes nothing, so an uncovered pot
          // is the ten telling each other the game wasn't close.
          "nobody took the other side — every stake came home"
        : covered === pot
          ? "fully covered"
          : `${covered} covered · ${pot - covered} came home`;
    lines.push(
      [`**Pot ${pot} Cred**`, ...(label ? [label] : []), coverage].join(" · "),
    );

    const loserSide = winnerSide === "Radiant" ? "Dire" : "Radiant";
    const sides = [
      [winnerSide, live.filter((s) => s.outcome === "WON")],
      [loserSide, live.filter((s) => s.outcome === "LOST")],
    ] as const;
    for (const [side, group] of sides) {
      // A side nobody backed prints nothing — never an empty "Radiant:" row.
      if (group.length === 0) continue;
      lines.push(
        `${side}: ${[...group]
          .sort(bySlipSize)
          .map((s) => `${name(s.name)} ${s.stake} → ${signedCred(s.delta)}`)
          .join(" · ")}`,
      );
    }
  }

  if (voided.length > 0) {
    // Subtext, because it is an exception note rather than the result — but it
    // is never dropped: somebody staked and got their Cred back, and finding
    // that out from a balance instead of from here is how a money feature
    // reads as broken.
    lines.push(
      `-# Refunded: ${[...voided]
        .sort(bySlipSize)
        .map((s) => `${name(s.name)} ${s.stake} (${VOID_REASON[s.outcome]})`)
        .join(" · ")}`,
    );
  }

  return lines.length > 0 ? `\n${lines.join("\n")}` : "";
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
  /**
   * Settled wagers, or null/absent when this caller didn't win the settlement
   * claim, when nobody bet, or when the settlement threw and was swallowed —
   * all three render the message exactly as it read before betting existed.
   */
  slips?: InhouseBetSlip[] | null;
}): string {
  const mins = Math.floor(m.durationSecs / 60);
  const secs = String(m.durationSecs % 60).padStart(2, "0");
  const mvp = m.mvpName
    ? ` MVP: **${name(m.mvpName)}**${m.mvpHero ? ` (${m.mvpHero})` : ""}.`
    : "";
  return `🏁 **Inhouse result: ${m.winnerSide} win ${m.radiantScore}–${m.direScore}** in ${mins}:${secs}.${mvp} Box score + ladder: <${resolveSiteUrl()}/inhouse> · <https://www.opendota.com/matches/${m.dotaMatchId}>${betSlipsBlock(m.slips ?? [], m.winnerSide)}`;
}

/**
 * An admin voided a result that had money on it.
 *
 * The correction is only worth sending because the ORIGINAL post is still
 * sitting in the channel stating payouts, slip by slip, that have since been
 * clawed back — and a Discord message that is never edited and never notifies
 * is exactly the surface where a stale number outlives the state it described.
 * Discord edits produce no notification, so amending the old post would leave
 * everyone who already read it believing the old figures; a new line is the
 * only thing anyone sees.
 *
 * The OpenDota link is the anchor, not decoration: the void NULLS the lobby's
 * dotaMatchId, so once this is sent there is nothing left in the database
 * tying the correction to the post it corrects.
 *
 * No MentionAllowlist — it names no action anyone can take, and a notification
 * people can't act on is what gets a channel muted (the betSlipsBlock rule).
 * Nothing here is player-supplied, so there is no name to escape.
 */
export function inhouseResultVoidedMessage(m: {
  betCount: number;
  /** Total confirmed stake on the voided game. */
  staked: number;
  /** Null only in theory — a COMPLETED lobby always came from a real match. */
  dotaMatchId: string | null;
}): string {
  const link = m.dotaMatchId
    ? ` <https://www.opendota.com/matches/${m.dotaMatchId}>`
    : "";
  const slips = `${m.betCount} ${m.betCount === 1 ? "slip" : "slips"}`;
  // Present tense, not "have been": the reversal is the sweeper's, run on the
  // next state read (milliseconds later, from this very request) rather than
  // inside the void itself. This says what the outcome is without claiming a
  // moment it can't promise.
  return `↩️ **That inhouse result has been voided by an admin** — it's off the ladder, and the wagers on it reverse to their pre-game balances: ${slips}, ${m.staked} Cred back where it started. The payouts posted for that game no longer stand.${link}`;
}

export function playerOutMessage(m: {
  playerName: string;
  homeName: string;
  awayName: string;
  week: number;
  isPlayoff: boolean;
  /** Epoch ms of the scheduled kickoff; null = unscheduled (line omitted). */
  whenMs: number | null;
  /** Deep link target — the match page holds the Standins card the message
   *  is pointing the captain at. Optional so hand-built calls stay valid. */
  matchId?: string;
}): string {
  const label = m.isPlayoff ? "playoff match" : `week ${m.week} match`;
  const when =
    m.whenMs != null ? ` (<t:${Math.floor(m.whenMs / 1000)}:F>)` : "";
  // The mentioned captain is by definition NOT on the site — land them on the
  // page with the assign form, not on the front door (the week-reminder shape).
  const link = m.matchId
    ? ` <${resolveSiteUrl()}/matches/${m.matchId}>`
    : "";
  return `🚑 **${name(m.playerName)}** can't make the ${label} — **${name(m.homeName)}** vs **${name(m.awayName)}**${when}. Captains/admin: time to line up a standin.${link}`;
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
  /** Epoch ms of the scheduled kickoff; null = unscheduled (line omitted). */
  whenMs: number | null;
  /** Deep link target — the match page holds the check-in banner. */
  matchId?: string;
}): string {
  const label = m.isPlayoff ? "playoff match" : `week ${m.week} match`;
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
  const link = m.matchId
    ? `: <${resolveSiteUrl()}/matches/${m.matchId}>`
    : ".";
  return `🧩 **${standin}** ${forWhom} — ${label} **${name(m.homeName)}** vs **${name(m.awayName)}**${when}. ${standin}: that's your game night now, check in on the match page${link}`;
}

export function standinRemovedMessage(m: {
  standinName: string;
  teamName: string;
  homeName: string;
  awayName: string;
  week: number;
  isPlayoff: boolean;
}): string {
  const label = m.isPlayoff ? "playoff match" : `week ${m.week} match`;
  return `🧩 **${name(m.standinName)}** is no longer standing in for **${name(m.teamName)}** (${label} **${name(m.homeName)}** vs **${name(m.awayName)}**) — stand down.`;
}

export function rescheduleProposedMessage(m: {
  homeName: string;
  awayName: string;
  week: number;
  isPlayoff: boolean;
  proposerName: string;
  whenMs: number;
}): string {
  const label = m.isPlayoff ? "playoff match" : `week ${m.week} match`;
  return `⏳ **${name(m.proposerName)}** proposed moving the ${label} **${name(m.homeName)}** vs **${name(m.awayName)}** to <t:${Math.floor(m.whenMs / 1000)}:F> — the other captain can respond on the match page.`;
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
  declinerName: string;
  whenMs: number;
}): string {
  const label = m.isPlayoff ? "playoff match" : `week ${m.week} match`;
  return `⏳ **${name(m.declinerName)}** declined moving the ${label} **${name(m.homeName)}** vs **${name(m.awayName)}** to <t:${Math.floor(m.whenMs / 1000)}:F> — the original kickoff stands.`;
}

/** Cap the ping list so one badly-organised team can't produce a wall of
 *  mentions; a captain chasing eleven people needs the match page, not a
 *  longer Discord line. */
const WAITING_SHOWN = 8;

export function weekReminderMessage(m: {
  week: number;
  isPlayoff: boolean;
  fixtures: {
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
  }[];
}): string {
  const site = resolveSiteUrl();
  const label = m.isPlayoff ? "Playoff matches" : `Week ${m.week} matches`;
  const lines = [`⏰ **${label} coming up — check in!**`];
  for (const f of m.fixtures) {
    const t = Math.floor(f.scheduledAt / 1000);
    lines.push(
      `🆚 **${name(f.homeName)}** vs **${name(f.awayName)}** — <t:${t}:R> · check-ins ${f.homeIn}/${f.homeSize} vs ${f.awayIn}/${f.awaySize} · <${site}/matches/${f.matchId}>`,
    );
    if (f.waitingOn.length > 0) {
      const shown = f.waitingOn.slice(0, WAITING_SHOWN);
      const extra = f.waitingOn.length - shown.length;
      const who = shown
        .map((p) => (p.discordId ? `<@${p.discordId}>` : name(p.name)))
        .join(", ");
      lines.push(
        `　Still waiting on: ${who}${extra > 0 ? ` +${extra} more` : ""}`,
      );
    }
  }
  lines.push("RSVP on your match page so captains can plan standins early.");
  return lines.join("\n");
}

export function weeklyHonorsMessage(honors: {
  week: number;
  playerName: string | null;
  playerPoints: number;
  heroName: string | null;
  teamName: string | null;
  teamGameWins: number;
}): string {
  const lines = [`🏅 **Week ${honors.week} honors are in!**`];
  if (honors.playerName) {
    lines.push(
      `⭐ Player of the Week: **${name(honors.playerName)}** — ${honors.playerPoints} fantasy pts${honors.heroName ? ` on ${honors.heroName}` : ""}`,
    );
  }
  if (honors.teamName) {
    lines.push(
      `🛡️ Team of the Week: **${name(honors.teamName)}** (${honors.teamGameWins} game win${honors.teamGameWins === 1 ? "" : "s"})`,
    );
  }
  lines.push(`Full leaderboards: <${resolveSiteUrl()}/leaders>`);
  return lines.join("\n");
}

/** A captain-agreed reschedule — the new time is pre-formatted by the caller. */
export function rescheduleMessage(m: {
  homeName: string;
  awayName: string;
  week: number;
  isPlayoff: boolean;
  /** Epoch ms of the agreed time — rendered via Discord's native timestamp
   *  markup so every reader sees it in their own timezone (a server-formatted
   *  string would be UTC wall-time in prod, wrong hour and often wrong day). */
  whenMs: number;
  /** RSVPs the retime invalidated — the rosters have to hear about this. */
  clearedRsvps?: number;
}): string {
  const label = m.isPlayoff ? "Playoffs" : `Week ${m.week}`;
  const t = `<t:${Math.floor(m.whenMs / 1000)}:F>`;
  // Retiming clears every check-in (an old answer about a night nobody is
  // playing). Saying so is the only notice the roster gets — the site shows
  // them an empty banner with no explanation of why their ✓ vanished.
  const reset = m.clearedRsvps
    ? ` Check-ins were reset (${m.clearedRsvps} cleared) — everyone please RSVP again.`
    : "";
  return `🗓️ **Rescheduled** — ${label}: **${name(m.homeName)}** vs **${name(m.awayName)}** now plays ${t} (both captains agreed).${reset}`;
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
  const snippet = prose.length > 200 ? `${prose.slice(0, 199).trimEnd()}…` : prose;
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

export async function getWebhookUrl(): Promise<string | null> {
  const fromDb = await getSetting(SETTING_KEYS.DISCORD_WEBHOOK_URL);
  return fromDb || process.env.DISCORD_WEBHOOK_URL || null;
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
  return (
    fromDb ||
    process.env.DISCORD_INHOUSE_ALERT_WEBHOOK_URL ||
    (await getInhouseWebhookUrl())
  );
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
 * Where INHOUSE traffic goes: the queue board, "match found", the two-short
 * ping and inhouse results. A Discord webhook is bound to the channel it was
 * created in, so routing these separately is the only way to keep an evening
 * of pick-up games out of the channel carrying league signups and results.
 *
 * FALLS BACK to the league webhook when unset, which is what every league that
 * never configures this keeps getting — one channel, exactly as before.
 */
export async function getInhouseWebhookUrl(): Promise<string | null> {
  const fromDb = await getSetting(SETTING_KEYS.INHOUSE_WEBHOOK_URL);
  return (
    fromDb || process.env.DISCORD_INHOUSE_WEBHOOK_URL || (await getWebhookUrl())
  );
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
  try {
    const res = await fetch(`${webhookApiUrl(url)}?wait=true`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, allowed_mentions: NO_MENTIONS }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { id?: unknown };
    return typeof json.id === "string" ? { id: json.id } : null;
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[discord] webhook post failed:", err);
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
  try {
    const res = await fetch(
      `${webhookApiUrl(url)}/messages/${encodeURIComponent(messageId)}`,
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
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[discord] webhook edit failed:", err);
    }
    return "failed";
  }
}

/** Remove a message this webhook sent (admin "Remove board"). Best-effort. */
export async function deleteWebhookMessage(
  url: string,
  messageId: string,
): Promise<boolean> {
  try {
    const res = await fetch(
      `${webhookApiUrl(url)}/messages/${encodeURIComponent(messageId)}`,
      { method: "DELETE", signal: AbortSignal.timeout(2500) },
    );
    return res.ok || res.status === 404; // already gone is a success
  } catch {
    return false;
  }
}

/**
 * POST a message to the configured webhook. Best-effort: resolves false on
 * any failure (no webhook configured, network error, non-2xx) and never throws.
 */
export async function sendDiscordMessage(
  content: string,
  mentions?: MentionAllowlist,
): Promise<boolean> {
  return sendTo(await getWebhookUrl(), content, mentions);
}

/**
 * Announce to the INHOUSE channel (see getInhouseWebhookUrl). Everything the
 * inhouse mode posts goes through here so a league can keep pick-up traffic
 * out of its league-announcement channel with one setting.
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
export type MentionAllowlist = { roles?: string[]; users?: string[] };

async function sendTo(
  url: string | null,
  content: string,
  mentions?: MentionAllowlist,
): Promise<boolean> {
  if (!url) return false;
  try {
    // webhookApiUrl, not the raw URL: an unversioned /api/webhooks/… routes to
    // Discord's DEFAULT version, still v6 and deprecated. The board's transport
    // has always pinned v10 and these ~28 announcements silently didn't — the
    // same webhook string reaching Discord two different ways.
    const res = await fetch(webhookApiUrl(url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      // allowed_mentions: parse:[] means NO mention ever resolves — a player
      // whose Steam persona is "@everyone" (or a team/news title with @here,
      // <@id>, <@&role>) can't turn an announcement into a mass ping.
      body: JSON.stringify({
        content,
        allowed_mentions: {
          parse: [],
          ...(mentions?.roles?.length ? { roles: mentions.roles } : {}),
          ...(mentions?.users?.length ? { users: mentions.users } : {}),
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[discord] webhook send failed:", err);
    }
    return false;
  }
}
