import { createHash } from "node:crypto";
import { escapeDiscordText } from "./discord-escape";

// The league status card: ONE Discord message, posted by its own webhook in
// the read-only #schedule channel, that the site rewrites in place as the
// season moves. It answers "where is the league right now?" without anyone
// opening the site: signups and the goal, draft night, this week's fixtures
// with their standins and moved kickoffs, the table, the playoffs, the
// champion, and a planned inhouse night.
//
// Everything here is pure — no DB, no fetch — so every phase is a table test.
// The service (league-status-service.ts) owns the message id, the throttle
// and the PATCH; this file only answers "what should the card say, and has
// that changed?".
//
// DESIGN. Discord's Components V2 layout: one container whose colour strip
// carries the phase, a header with the league logo, then short sections split
// by dividers, each with at most one link button beside it. The card is read
// at a glance and mostly on phones, so:
//
//  - One idea per section, the number first ("42 players are in"), detail in
//    grey subtext under it.
//  - Every time is a Discord timestamp, shown on the reader's own clock, and
//    every countdown is <t:…:R>, which keeps counting in every client with no
//    edit from us. Nothing in the card depends on the wall clock, so a quiet
//    league costs no edits at all.
//  - NO EMOJI, the queue board's rule (inhouse-board.ts): this message is on
//    screen for weeks, and decoration on a permanent surface becomes
//    wallpaper. The colour strip and two glyphs (▰ filled, ▱ open) do that
//    job. Where the card needs an image it is a real one: the league logo,
//    the champion's team logo, the player of the week's hero.
//  - Only the facts the site already publishes, by the names it already
//    shows: Steam names, never Discord handles, and no mention ever pings
//    (the service sends allowed_mentions: {parse: []} on every edit).
//
// The DIGEST is a hash of the payload itself. Because the payload carries no
// wall-clock text (only absolute timestamps), an unchanged league renders an
// identical payload and the service makes no request.

/** Components V2 message flag. Once set on a message it cannot be removed. */
export const IS_COMPONENTS_V2 = 1 << 15;

const ACTION_ROW = 1;
const BUTTON = 2;
const SECTION = 9;
const TEXT_DISPLAY = 10;
const THUMBNAIL = 11;
const SEPARATOR = 14;
const CONTAINER = 17;
/** A link button: opens its URL, sends no interaction to the site. */
const BUTTON_LINK = 5;

/** Discord's limits for one Components V2 message. */
export const STATUS_MAX_COMPONENTS = 40;
export const STATUS_MAX_TEXT = 4000;
/** Rows of the code-block table; past this the rest is "N more". */
const TABLE_MAX_ROWS = 12;
/** Team names in the monospace table. A row is 28 characters: a phone's
 *  code block holds about 30 before it wraps, and a wrapped row breaks the
 *  columns. Points only, for that reason; W-D-L is on the site. */
const TABLE_NAME_WIDTH = 20;
/** Fixture lines shown per week before "and N more on the schedule". */
const FIXTURES_MAX = 10;

/**
 * The colour strip per phase. Calm blue while the league fills, amber around
 * the draft, red only while something is LIVE (the queue board's meaning for
 * red), green through the season, coral for the knockout rounds, gold for the
 * champion, grey between seasons.
 */
export const STATUS_ACCENT = {
  OFFSEASON: 0x80848e,
  SIGNUPS: 0x5865f2,
  DRAFT: 0xf0b232,
  DRAFT_LIVE: 0xf23f43,
  REGULAR_SEASON: 0x23a55a,
  PLAYOFFS: 0xf47b67,
  COMPLETE: 0xf1c40f,
} as const;

export type StatusPhase =
  | "OFFSEASON"
  | "SIGNUPS"
  | "DRAFT"
  | "REGULAR_SEASON"
  | "PLAYOFFS"
  | "COMPLETE";

/** When matches are played, as far as the league knows it. */
export type StatusMatchNight =
  /** A player poll is open and deciding it. The count stays hidden while
   *  voting is open (match-night-poll.md: "It never names the leading time"),
   *  so the card shows turnout and the closing time only. */
  | {
      kind: "poll";
      voted: number;
      eligible: number;
      closesAtMs: number;
      voteUrl: string;
    }
  /** Decided: the season's weekly night as the site prints it
   *  (announcedMatchNight), in the league's zone with the zone named. */
  | { kind: "set"; label: string }
  | { kind: "unset" };

export type StatusSignups = {
  players: number;
  standins: number;
  /** Signups who offered to captain. Teams are captains, so it matters. */
  captainVolunteers: number;
  minTeams: number;
  /** capacityInfo: full teams the signups make right now. */
  teamsFormable: number;
  /** capacityInfo: players still needed to reach the team goal (0 = met). */
  needed: number;
  /** capacityInfo: players to the next full team once the goal is met. */
  toNextTeam: number;
  /** One captain per team: the larger of the goal and the teams formable. */
  teamsNeeded: number;
};

export type StatusDraftState = "NOT_STARTED" | "LIVE" | "PAUSED" | "COMPLETE";

export type StatusDraft = {
  state: StatusDraftState;
  /** Draft night, if the admin has set one. */
  atMs: number | null;
  /** Draft night is close (draftNightSoon): the card links the draft room. */
  soon: boolean;
  captains: number;
  /** Players up for auction: unrostered signups before the draft, the seats
   *  it fills once it runs (no more than the players there are). */
  pool: number;
  sold: number;
  startedAtMs: number | null;
  /** The drafted teams, in draft order, once the draft is over. */
  teams: string[];
  /** Week 1's first kickoff, once the schedule exists. */
  seasonStartsAtMs: number | null;
};

export type StatusStandin = {
  standin: string;
  /** null = filling an empty seat, replacing nobody. */
  replaced: string | null;
  team: string;
};

export type StatusReschedule = {
  proposer: string;
  /** The side that still owes an answer. */
  waitingOn: string;
  options: number;
};

export type StatusFixture = {
  home: string;
  away: string;
  homeScore: number;
  awayScore: number;
  /** UPCOMING: no game yet. LIVE: games recorded, series undecided. FINAL:
   *  decided (a FINAL with no winner is a draw). */
  state: "UPCOMING" | "LIVE" | "FINAL";
  winner: "HOME" | "AWAY" | null;
  forfeit: boolean;
  /** Kickoff, if scheduled. */
  atMs: number | null;
  /** The kickoff was moved off the week's match night. */
  moved: boolean;
  bestOf: number;
  standins: StatusStandin[];
  /** A reschedule offer waiting for an answer. */
  reschedule: StatusReschedule | null;
  /** Playoffs: what the decided series means ("go to the grand final"). */
  outcome: string | null;
};

export type StatusWeek = {
  /** "Week 3 of 9" or "Tiebreaker week". */
  label: string;
  matchNightAtMs: number | null;
  fixtures: StatusFixture[];
  /** Teams sitting the week out (odd team counts rotate a bye). */
  byes: string[];
};

export type StatusTableRow = {
  pos: number;
  team: string;
  points: number;
};

export type StatusTable = {
  rows: StatusTableRow[];
  /** Teams that reach the playoffs; null = unknown, no line drawn. */
  playoffSpots: number | null;
};

export type StatusHighlights = {
  week: number;
  /** Player of the week: the week's impact points, and the hero of their best
   *  game (the weekly honors post's wording, weeklyHonorsMessage). */
  player: { name: string; points: number; hero: string | null } | null;
  team: { name: string; wins: number } | null;
  heroImageUrl: string | null;
  recapUrl: string | null;
};

export type StatusPlayoffs = {
  round: string;
  fixtures: StatusFixture[];
  next: { round: string; bestOf: number; atMs: number | null } | null;
  stream: { platform: string; url: string } | null;
  bracketUrl: string;
};

export type StatusChampion = {
  team: string;
  logoUrl: string | null;
  /** The grand final from the champion's side, when it was played. */
  final: { opponent: string; score: string; forfeit: boolean } | null;
  roster: { name: string; captain: boolean }[];
  recapUrl: string;
};

export type StatusInhouseNight = {
  startsAtMs: number;
  /** UPCOMING until it starts, ON for the night's length after
   *  (inhouseNightPhase, the same window Home and /inhouse use). */
  state: "UPCOMING" | "ON";
  /** The admin's note ("Turbo night"), "" for none. */
  note: string;
  inviteUrl: string;
  joinUrl: string;
};

export type LeagueStatusSnapshot = {
  leagueName: string;
  siteUrl: string;
  /** Absolute URL of the league logo (the header thumbnail). */
  logoUrl: string;
  phase: StatusPhase;
  seasonName: string | null;
  signups: StatusSignups | null;
  matchNight: StatusMatchNight;
  draft: StatusDraft | null;
  week: StatusWeek | null;
  table: StatusTable | null;
  highlights: StatusHighlights | null;
  playoffs: StatusPlayoffs | null;
  champion: StatusChampion | null;
  /** Between seasons: the latest champion, for the offseason card. */
  lastChampion: { team: string; seasonName: string } | null;
  /** Season complete: when the next season's signups open, once an admin
   *  has set it on /admin's Season handoff card. */
  nextSignupsAtMs: number | null;
  inhouseNight: StatusInhouseNight | null;
  urls: {
    signUp: string;
    howItWorks: string;
    draft: string;
    players: string;
    teams: string;
    schedule: string;
    hallOfFame: string;
    inhouse: string;
  };
};

export type StatusPayload = {
  flags: number;
  components: unknown[];
};

export type StatusRender = { digest: string; payload: StatusPayload };

// --- Small builders ----------------------------------------------------------

type Component = Record<string, unknown>;

const textDisplay = (content: string): Component => ({
  type: TEXT_DISPLAY,
  content,
});
const divider = (): Component => ({ type: SEPARATOR, divider: true, spacing: 1 });
const linkButton = (label: string, url: string): Component => ({
  type: BUTTON,
  style: BUTTON_LINK,
  label,
  url,
});
const thumbnail = (url: string, description: string): Component => ({
  type: THUMBNAIL,
  media: { url },
  description,
});
/** Text with a thumbnail or a button beside it. Discord requires an
 *  accessory on a section, so a section without one is plain text. */
function section(content: string, accessory: Component | null): Component {
  if (!accessory) return textDisplay(content);
  return { type: SECTION, components: [textDisplay(content)], accessory };
}
function buttonRow(buttons: Component[]): Component | null {
  return buttons.length > 0
    ? { type: ACTION_ROW, components: buttons.slice(0, 5) }
    : null;
}

/** Discord timestamp markup, shown on each reader's own clock. */
export function ts(ms: number, style: "t" | "f" | "F" | "D" | "R"): string {
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

/** A player- or team-chosen name in a markdown line. */
const n = (raw: string, maxLen?: number) => escapeDiscordText(raw, maxLen);

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** ▰▰▰▱▱ bar, ten cells, rounded down so "full" means full. */
export function progressBar(done: number, total: number, cells = 10): string {
  if (total <= 0) return "▱".repeat(cells);
  const filled = Math.max(
    0,
    Math.min(cells, Math.floor((done / total) * cells)),
  );
  return `${"▰".repeat(filled)}${"▱".repeat(cells - filled)}`;
}

// --- Sections shared by several phases ---------------------------------------

/** The card's first block: league and season over the headline, logo right. */
function header(
  s: LeagueStatusSnapshot,
  context: string,
  headline: string,
  body: string[],
  image: { url: string; description: string } | null = {
    url: s.logoUrl,
    description: `${s.leagueName} logo`,
  },
): Component {
  const lines = [`-# ${context}`, `## ${headline}`, ...body];
  return section(
    lines.join("\n"),
    image ? thumbnail(image.url, image.description) : null,
  );
}

/** "GGD2L · Season 2 · Playoffs". The season name is admin-written, so it is
 *  NOT escaped (discord-escape.ts: an admin writing **bold** means it). A
 *  season named "GGD2L Season 2" doesn't repeat the league's name. */
function seasonContext(s: LeagueStatusSnapshot, suffix?: string): string {
  const named =
    s.seasonName !== null &&
    s.seasonName.toLowerCase().includes(s.leagueName.toLowerCase());
  return [named ? null : s.leagueName, s.seasonName, suffix]
    .filter(Boolean)
    .join(" · ");
}

/** "Match night": the poll while it decides, the night once it's set. */
function matchNightSection(s: LeagueStatusSnapshot): Component {
  const m = s.matchNight;
  if (m.kind === "poll") {
    const turnout =
      m.eligible > 0
        ? `**${m.voted} of ${m.eligible}** so far`
        : `**${m.voted}** so far`;
    return section(
      [
        "**Match night**",
        `Players are voting: ${turnout}`,
        `-# Voting closes ${ts(m.closesAtMs, "R")}`,
      ].join("\n"),
      linkButton("Vote", m.voteUrl),
    );
  }
  // The label is the site's own wording or the admin's, never a player's.
  if (m.kind === "set") return textDisplay(`**Match night**\n${m.label}`);
  return textDisplay("**Match night**\nTo be announced");
}

/** The admin's note on one line: a newline in it would start a heading or
 *  a list inside the card. Admin text, so otherwise as written. */
function noteLine(note: string): string[] {
  const flat = note.replace(/\s+/g, " ").trim();
  return flat ? [flat] : [];
}

/** A planned inhouse night, in every phase, with its own "I'm in". */
function inhouseNightSection(s: LeagueStatusSnapshot): Component | null {
  const night = s.inhouseNight;
  if (!night) return null;
  if (night.state === "ON") {
    return section(
      [
        "**Inhouse night is on**",
        ...noteLine(night.note),
        `-# Started ${ts(night.startsAtMs, "R")} · open to everyone`,
      ].join("\n"),
      linkButton("Join the queue", night.joinUrl),
    );
  }
  return section(
    [
      "**Inhouse night**",
      ts(night.startsAtMs, "F"),
      ...noteLine(night.note),
      `-# ${ts(night.startsAtMs, "R")} · open to everyone, no season signup needed`,
    ].join("\n"),
    linkButton("I'm in", night.inviteUrl),
  );
}

/** One fixture as a line, plus its standin and reschedule notes. */
export function fixtureLines(
  f: StatusFixture,
  opts: { showBestOf?: boolean } = {},
): string[] {
  const home = n(f.home, 40);
  const away = n(f.away, 40);
  const lines: string[] = [];
  if (f.state === "FINAL") {
    const score = `\`${f.homeScore}–${f.awayScore}\``;
    const h = f.winner === "HOME" ? `**${home}**` : home;
    const a = f.winner === "AWAY" ? `**${away}**` : away;
    lines.push(`${h} ${score} ${a}${f.forfeit ? " · forfeit" : ""}`);
    if (f.outcome) lines.push(`-# ${f.outcome}`);
  } else if (f.state === "LIVE") {
    lines.push(
      `**${home}** \`${f.homeScore}–${f.awayScore}\` **${away}** · live`,
    );
  } else {
    // A kickoff on the week's match night needs no time of its own: the
    // header already says when, and five repeats of "6:00 PM" are noise.
    const when =
      opts.showBestOf
        ? ""
        : f.atMs === null
          ? " · time to be set"
          : f.moved
            ? ` · moved to ${ts(f.atMs, "f")}`
            : "";
    lines.push(
      opts.showBestOf
        ? `**${home}** \`vs\` **${away}**`
        : `${home} \`vs\` ${away}${when}`,
    );
    if (opts.showBestOf) {
      const at = f.atMs === null ? "Time to be set" : ts(f.atMs, "F");
      lines.push(`-# ${at} · best of ${f.bestOf}`);
    }
  }
  if (f.state !== "FINAL") {
    for (const sub of f.standins) {
      lines.push(
        sub.replaced
          ? `-# ↳ Standin: ${n(sub.standin, 32)} for ${n(sub.replaced, 32)} (${n(sub.team, 32)})`
          : `-# ↳ Standin: ${n(sub.standin, 32)} fills a seat for ${n(sub.team, 32)}`,
      );
    }
    if (f.reschedule) {
      lines.push(
        `-# ↳ ${n(f.reschedule.proposer, 32)} offered ${plural(f.reschedule.options, "new time")} · waiting on ${n(f.reschedule.waitingOn, 32)}`,
      );
    }
  }
  return lines;
}

/** Sanitise a name for the monospace table: no backticks (they would end
 *  the code block), no newlines, fixed width. */
function tableName(raw: string): string {
  const flat = Array.from(raw.replace(/[\r\n\t`]+/g, " ").trim());
  const clipped =
    flat.length > TABLE_NAME_WIDTH
      ? [...flat.slice(0, TABLE_NAME_WIDTH - 1), "…"]
      : flat;
  return clipped.join("").padEnd(TABLE_NAME_WIDTH, " ");
}

/** The table as an aligned code block, with the playoff line drawn in. */
export function tableBlock(table: StatusTable): string {
  const rows = table.rows.slice(0, TABLE_MAX_ROWS);
  const lines = [` # ${"Team".padEnd(TABLE_NAME_WIDTH)}  Pts`];
  rows.forEach((r, i) => {
    lines.push(
      `${String(r.pos).padStart(2)} ${tableName(r.team)}  ${String(r.points).padStart(3)}`,
    );
    const spots = table.playoffSpots;
    if (
      spots !== null &&
      spots > 0 &&
      i === spots - 1 &&
      i < rows.length - 1
    ) {
      // Ends under the points, the same width as a row.
      lines.push(`   ${"── playoff line ".padEnd(TABLE_NAME_WIDTH + 5, "─")}`);
    }
  });
  if (table.rows.length > rows.length) {
    lines.push(`   + ${table.rows.length - rows.length} more`);
  }
  return ["```", ...lines, "```"].join("\n");
}

// --- Phases --------------------------------------------------------------------

function signupsCard(s: LeagueStatusSnapshot): Component[] {
  const g = s.signups;
  const body: string[] = [];
  if (g) {
    body.push(`**${plural(g.players, "player")}** ${g.players === 1 ? "is" : "are"} in`);
    const subtext: string[] = [];
    if (g.needed > 0) {
      body.push(
        `\`${progressBar(g.teamsFormable, g.minTeams)}\` **${g.teamsFormable} of ${g.minTeams}** teams`,
      );
      subtext.push(`${plural(g.needed, "more player")} for ${g.minTeams} teams`);
    } else {
      // The goal is a floor, never a cap (capacity.ts): past it the ask is
      // the next team, so the 31st player still has a reason to join.
      body.push(
        `\`${progressBar(1, 1)}\` Enough for **${plural(g.teamsFormable, "team")}**`,
      );
      subtext.push(
        `${plural(g.toNextTeam, "more player")} for ${g.teamsFormable + 1} teams`,
      );
    }
    // Teams are captains: short of volunteers, the count is the ask.
    subtext.push(
      g.captainVolunteers < g.teamsNeeded
        ? `${g.captainVolunteers} of ${g.teamsNeeded} captains so far`
        : `${g.captainVolunteers} ${g.captainVolunteers === 1 ? "wants" : "want"} to captain`,
    );
    if (g.standins > 0) subtext.push(plural(g.standins, "standin"));
    body.push(`-# ${subtext.join(" · ")}`);
  }
  const blocks: (Component | null)[] = [
    header(s, seasonContext(s), "Signups are open", body),
    divider(),
    matchNightSection(s),
    divider(),
    draftNightSection(s),
  ];
  pushNight(blocks, s);
  blocks.push(
    divider(),
    buttonRow([
      linkButton("Sign up", s.urls.signUp),
      linkButton("Player pool", s.urls.players),
      linkButton("How it works", s.urls.howItWorks),
    ]),
  );
  return blocks.filter((b): b is Component => b !== null);
}

/** Draft night during signups, with the draft room once it's close. */
function draftNightSection(s: LeagueStatusSnapshot): Component {
  const d = s.draft;
  if (!d || d.atMs === null) {
    return textDisplay("**Draft night**\nDate coming soon");
  }
  return section(
    `**Draft night**\n${ts(d.atMs, "F")}\n-# ${ts(d.atMs, "R")}`,
    d.soon ? linkButton("Draft room", s.urls.draft) : null,
  );
}

function draftCard(s: LeagueStatusSnapshot): {
  accent: number;
  blocks: Component[];
} {
  const d = s.draft;
  const blocks: (Component | null)[] = [];
  let accent: number = STATUS_ACCENT.DRAFT;
  if (!d || d.state === "NOT_STARTED") {
    const at = d?.atMs ?? null;
    const body = [
      at === null ? "### Date coming soon" : `### ${ts(at, "F")}`,
      d
        ? `**${plural(d.captains, "captain")}** · **${plural(d.pool, "player")}** up for auction`
        : null,
      at === null ? null : `-# ${ts(at, "R")}`,
    ].filter((l): l is string => l !== null);
    blocks.push(header(s, seasonContext(s), "Draft night", body));
    blocks.push(divider(), matchNightSection(s));
    pushNight(blocks, s);
    blocks.push(
      divider(),
      buttonRow([
        linkButton("Watch the draft", s.urls.draft),
        linkButton("Player pool", s.urls.players),
      ]),
    );
  } else if (d.state === "LIVE" || d.state === "PAUSED") {
    const live = d.state === "LIVE";
    accent = live ? STATUS_ACCENT.DRAFT_LIVE : STATUS_ACCENT.DRAFT;
    const body = [
      `\`${progressBar(d.sold, d.pool)}\` **${d.sold} of ${d.pool}** players drafted`,
      live
        ? d.startedAtMs !== null
          ? `-# Started ${ts(d.startedAtMs, "R")}`
          : null
        : "-# Paused for now. It picks up where it left off.",
    ].filter((l): l is string => l !== null);
    blocks.push(
      header(
        s,
        seasonContext(s),
        live ? "The draft is live" : "The draft is paused",
        body,
      ),
    );
    pushNight(blocks, s);
    blocks.push(
      divider(),
      buttonRow([linkButton(live ? "Watch live" : "Draft room", s.urls.draft)]),
    );
  } else {
    const body = [`**${plural(d.captains, "team")}** drafted`];
    if (d.teams.length > 0) {
      body.push(`-# ${d.teams.map((t) => n(t, 40)).join(" · ")}`);
    }
    body.push(
      d.seasonStartsAtMs !== null
        ? `Week 1 kicks off ${ts(d.seasonStartsAtMs, "F")}`
        : "-# The season starts once the schedule is out",
    );
    blocks.push(
      header(s, seasonContext(s), "Teams are set", body),
      divider(),
      matchNightSection(s),
    );
    pushNight(blocks, s);
    blocks.push(divider(), buttonRow([linkButton("See the teams", s.urls.teams)]));
  }
  return {
    accent,
    blocks: blocks.filter((b): b is Component => b !== null),
  };
}

function pushNight(blocks: (Component | null)[], s: LeagueStatusSnapshot) {
  const night = inhouseNightSection(s);
  if (night) blocks.push(divider(), night);
}

/** An open poll in a phase whose card doesn't otherwise show match night. */
function pushPoll(blocks: (Component | null)[], s: LeagueStatusSnapshot) {
  if (s.matchNight.kind === "poll") blocks.push(divider(), matchNightSection(s));
}

function fixturesBlock(
  heading: string,
  fixtures: StatusFixture[],
  opts: { showBestOf?: boolean } = {},
  byes: string[] = [],
): Component {
  const shown = fixtures.slice(0, FIXTURES_MAX);
  const lines = heading ? [heading] : [];
  for (const f of shown) lines.push(...fixtureLines(f, opts));
  if (fixtures.length > shown.length) {
    lines.push(`-# and ${fixtures.length - shown.length} more on the schedule`);
  }
  if (byes.length > 0) {
    lines.push(`-# ${byes.length === 1 ? "Bye" : "Byes"}: ${byes.map((t) => n(t, 40)).join(", ")}`);
  }
  return textDisplay(lines.join("\n"));
}

const POINTS = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

function highlightsSection(s: LeagueStatusSnapshot): Component | null {
  const h = s.highlights;
  if (!h || (!h.player && !h.team)) return null;
  const lines = [`**Week ${h.week} highlights**`];
  if (h.player) {
    // The points are the week's total and the hero is their best game, as
    // the honors post words it: "167 impact points on Dark Willow" read as
    // one game's score.
    lines.push(
      `Player of the week: **${n(h.player.name, 40)}**`,
      `-# ${POINTS.format(h.player.points)} impact points${h.player.hero ? ` · best game on ${n(h.player.hero)}` : ""}`,
    );
  }
  if (h.team) {
    lines.push(
      `Team of the week: **${n(h.team.name, 40)}**`,
      `-# ${plural(h.team.wins, "game win")}`,
    );
  }
  return section(
    lines.join("\n"),
    h.heroImageUrl && h.player?.hero
      ? thumbnail(h.heroImageUrl, h.player.hero)
      : null,
  );
}

function seasonCard(s: LeagueStatusSnapshot): Component[] {
  const week = s.week;
  const blocks: (Component | null)[] = [];
  if (week && week.fixtures.length > 0) {
    const played = week.fixtures.filter((f) => f.state === "FINAL").length;
    blocks.push(
      header(
        s,
        seasonContext(s),
        week.label,
        week.matchNightAtMs !== null
          ? [`Match night ${ts(week.matchNightAtMs, "F")} · ${ts(week.matchNightAtMs, "R")}`]
          : [],
      ),
      divider(),
      fixturesBlock(
        `**This week** · ${played} of ${week.fixtures.length} played`,
        week.fixtures,
        {},
        week.byes,
      ),
    );
  } else {
    blocks.push(
      header(s, seasonContext(s), "Regular season done", [
        "-# The playoffs are next",
      ]),
    );
  }
  // The race before last week's awards: the table changes every result,
  // the highlights once a week.
  if (s.table && s.table.rows.length > 0) {
    blocks.push(divider(), textDisplay(`**Standings**\n${tableBlock(s.table)}`));
  }
  const highlights = highlightsSection(s);
  if (highlights) blocks.push(divider(), highlights);
  pushPoll(blocks, s);
  pushNight(blocks, s);
  const buttons = [
    linkButton("Schedule", s.urls.schedule),
    linkButton("Teams", s.urls.teams),
  ];
  if (s.highlights?.recapUrl) {
    buttons.push(linkButton(`Week ${s.highlights.week} recap`, s.highlights.recapUrl));
  }
  blocks.push(divider(), buttonRow(buttons));
  return blocks.filter((b): b is Component => b !== null);
}

function playoffsCard(s: LeagueStatusSnapshot): Component[] {
  const p = s.playoffs;
  const blocks: (Component | null)[] = [];
  if (!p) {
    blocks.push(header(s, seasonContext(s, "Playoffs"), "Playoffs", []));
  } else {
    blocks.push(header(s, seasonContext(s, "Playoffs"), p.round, []));
    if (p.fixtures.length > 0) {
      blocks.push(divider(), fixturesBlock("", p.fixtures, { showBestOf: true }));
    }
    if (p.next) {
      const at = p.next.atMs === null ? "" : ` · ${ts(p.next.atMs, "D")}`;
      blocks.push(
        divider(),
        textDisplay(
          `**Up next** · ${p.next.round}, best of ${p.next.bestOf}${at}`,
        ),
      );
    }
  }
  pushPoll(blocks, s);
  pushNight(blocks, s);
  const buttons = p ? [linkButton("Bracket", p.bracketUrl)] : [];
  if (p?.stream) {
    buttons.push(linkButton(`Watch on ${p.stream.platform}`, p.stream.url));
  }
  blocks.push(divider(), buttonRow(buttons));
  return blocks.filter((b): b is Component => b !== null);
}

/** When the next season opens, once an admin has said. */
function nextSeasonSection(s: LeagueStatusSnapshot): Component {
  const at = s.nextSignupsAtMs;
  return textDisplay(
    at === null
      ? "**Next season**\nComing soon\n-# This card switches to signups when they open"
      : `**Next season**\nSignups open ${ts(at, "F")}\n-# ${ts(at, "R")}`,
  );
}

function completeCard(s: LeagueStatusSnapshot): Component[] {
  const c = s.champion;
  const blocks: (Component | null)[] = [];
  if (c) {
    const body: string[] = [];
    if (c.final) {
      const opponent = n(c.final.opponent, 40);
      body.push(
        c.final.forfeit
          ? `Won the grand final over ${opponent} by forfeit`
          : `Won the grand final \`${c.final.score}\` over ${opponent}`,
      );
    }
    if (c.roster.length > 0) {
      body.push(
        `-# ${c.roster
          .map((p) => (p.captain ? `${n(p.name, 32)} (captain)` : n(p.name, 32)))
          .join(" · ")}`,
      );
    }
    blocks.push(
      header(
        s,
        seasonContext(s, "Champions"),
        n(c.team, 60),
        body,
        c.logoUrl
          ? { url: c.logoUrl, description: `${c.team} logo` }
          : { url: s.logoUrl, description: `${s.leagueName} logo` },
      ),
    );
  } else {
    blocks.push(header(s, seasonContext(s), "Season complete", []));
  }
  pushPoll(blocks, s);
  blocks.push(divider(), nextSeasonSection(s));
  pushNight(blocks, s);
  const buttons: Component[] = [];
  if (c) buttons.push(linkButton("Season recap", c.recapUrl));
  buttons.push(linkButton("Hall of Fame", s.urls.hallOfFame));
  blocks.push(divider(), buttonRow(buttons));
  return blocks.filter((b): b is Component => b !== null);
}

function offseasonCard(s: LeagueStatusSnapshot): Component[] {
  const body = s.lastChampion
    ? [
        `Last champions: **${n(s.lastChampion.team, 60)}** (${s.lastChampion.seasonName})`,
      ]
    : [];
  const blocks: (Component | null)[] = [
    header(s, s.leagueName, "Between seasons", [
      ...body,
      "-# Inhouses run all year",
    ]),
  ];
  pushPoll(blocks, s);
  pushNight(blocks, s);
  blocks.push(
    divider(),
    buttonRow([
      linkButton("Play inhouses", s.urls.inhouse),
      linkButton("Hall of Fame", s.urls.hallOfFame),
    ]),
  );
  return blocks.filter((b): b is Component => b !== null);
}

// --- Limits ----------------------------------------------------------------------

/** Every component in the tree, nested ones included. */
export function countComponents(components: unknown[]): number {
  let total = 0;
  for (const c of components) {
    total += 1;
    const node = c as { components?: unknown[]; accessory?: unknown };
    if (Array.isArray(node.components)) total += countComponents(node.components);
    if (node.accessory) total += 1;
  }
  return total;
}

/** All the text Discord counts toward the message's character limit. */
export function totalText(components: unknown[]): number {
  let total = 0;
  for (const c of components) {
    const node = c as {
      content?: unknown;
      label?: unknown;
      components?: unknown[];
      accessory?: unknown;
    };
    if (typeof node.content === "string") total += node.content.length;
    if (typeof node.label === "string") total += node.label.length;
    if (Array.isArray(node.components)) total += totalText(node.components);
    if (node.accessory) total += totalText([node.accessory]);
  }
  return total;
}

/**
 * Keep a busy card inside Discord's limits: an over-limit edit is refused
 * whole, and a refused edit leaves the card stale. Drops the least important
 * blocks first (highlights, the inhouse line), then trims the longest text.
 */
function fitToLimits(blocks: Component[]): Component[] {
  const fits = (b: Component[]) =>
    countComponents(b) + 1 <= STATUS_MAX_COMPONENTS &&
    totalText(b) <= STATUS_MAX_TEXT;
  if (fits(blocks)) return blocks;
  const out = [...blocks];
  const longest = () => {
    let at = -1;
    let len = 0;
    out.forEach((b, i) => {
      if (typeof b.content === "string" && b.content.length > len) {
        len = b.content.length;
        at = i;
      }
    });
    return at;
  };
  while (!fits(out)) {
    const at = longest();
    if (at < 0) break;
    const content = out[at].content as string;
    const cut = content.slice(0, Math.max(0, content.length - 400));
    const keep = cut.slice(0, Math.max(0, cut.lastIndexOf("\n")));
    out[at] = { ...out[at], content: `${keep}\n-# More on the site` };
    if (keep.length === 0) break;
  }
  return out;
}

// --- Render ------------------------------------------------------------------------

export function renderLeagueStatus(s: LeagueStatusSnapshot): StatusRender {
  let accent: number;
  let blocks: Component[];
  switch (s.phase) {
    case "SIGNUPS":
      accent = STATUS_ACCENT.SIGNUPS;
      blocks = signupsCard(s);
      break;
    case "DRAFT": {
      const draft = draftCard(s);
      accent = draft.accent;
      blocks = draft.blocks;
      break;
    }
    case "REGULAR_SEASON":
      accent = STATUS_ACCENT.REGULAR_SEASON;
      blocks = seasonCard(s);
      break;
    case "PLAYOFFS":
      accent = STATUS_ACCENT.PLAYOFFS;
      blocks = playoffsCard(s);
      break;
    case "COMPLETE":
      accent = STATUS_ACCENT.COMPLETE;
      blocks = completeCard(s);
      break;
    default:
      accent = STATUS_ACCENT.OFFSEASON;
      blocks = offseasonCard(s);
  }
  const payload: StatusPayload = {
    flags: IS_COMPONENTS_V2,
    components: [
      { type: CONTAINER, accent_color: accent, components: fitToLimits(blocks) },
    ],
  };
  const digest = createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("base64url")
    .slice(0, 24);
  return { digest, payload };
}

/** One line for the admin card: what the status card is showing right now. */
export function statusLabel(s: LeagueStatusSnapshot): string {
  switch (s.phase) {
    case "SIGNUPS":
      return s.signups
        ? `Signups: ${plural(s.signups.players, "player")}`
        : "Signups";
    case "DRAFT":
      return s.draft?.state === "LIVE"
        ? `Draft live: ${s.draft.sold} of ${s.draft.pool} sold`
        : s.draft?.state === "PAUSED"
          ? "Draft paused"
          : s.draft?.state === "COMPLETE"
            ? "Teams are set"
            : "Draft night";
    case "REGULAR_SEASON":
      return s.week?.label ?? "Regular season";
    case "PLAYOFFS":
      return s.playoffs?.round ?? "Playoffs";
    case "COMPLETE":
      return s.champion ? `Champions: ${s.champion.team}` : "Season complete";
    default:
      return "Between seasons";
  }
}
