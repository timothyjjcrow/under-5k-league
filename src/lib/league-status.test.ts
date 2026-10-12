import { describe, expect, it } from "vitest";
import {
  IS_COMPONENTS_V2,
  STATUS_ACCENT,
  STATUS_MAX_COMPONENTS,
  STATUS_MAX_TEXT,
  countComponents,
  fixtureLines,
  progressBar,
  renderLeagueStatus,
  statusLabel,
  tableBlock,
  totalText,
  type LeagueStatusSnapshot,
  type StatusFixture,
} from "./league-status";

const T0 = 1_800_000_000_000;
const SITE = "https://ggd2l.example";

function snap(over: Partial<LeagueStatusSnapshot> = {}): LeagueStatusSnapshot {
  return {
    leagueName: "GGD2L",
    siteUrl: SITE,
    logoUrl: `${SITE}/brand/ggd2l-logo.png`,
    phase: "SIGNUPS",
    seasonName: "Season 2",
    signups: {
      players: 42,
      standins: 3,
      captainVolunteers: 6,
      minTeams: 10,
      teamsFormable: 8,
      needed: 8,
      toNextTeam: 2,
      teamsNeeded: 10,
    },
    matchNight: {
      kind: "poll",
      voted: 11,
      eligible: 42,
      closesAtMs: T0 + 13 * 86_400_000,
      voteUrl: `${SITE}/#match-night-poll`,
    },
    draft: null,
    week: null,
    table: null,
    highlights: null,
    playoffs: null,
    champion: null,
    lastChampion: null,
    nextSignupsAtMs: null,
    inhouseNight: null,
    urls: {
      signUp: `${SITE}/me`,
      howItWorks: `${SITE}/how-it-works`,
      draft: `${SITE}/draft`,
      players: `${SITE}/players`,
      teams: `${SITE}/teams`,
      schedule: `${SITE}/schedule`,
      hallOfFame: `${SITE}/hall-of-fame`,
      inhouse: `${SITE}/inhouse`,
    },
    ...over,
  };
}

function fixture(over: Partial<StatusFixture> = {}): StatusFixture {
  return {
    home: "Bleeding Hearts",
    away: "Vegan Squadron",
    homeScore: 0,
    awayScore: 0,
    state: "UPCOMING",
    winner: null,
    forfeit: false,
    atMs: T0,
    moved: false,
    bestOf: 2,
    standins: [],
    reschedule: null,
    outcome: null,
    ...over,
  };
}

/** Every text display's content, in order, nested ones included. */
function texts(components: unknown[]): string[] {
  const out: string[] = [];
  for (const c of components) {
    const node = c as {
      content?: string;
      components?: unknown[];
      accessory?: unknown;
    };
    if (typeof node.content === "string") out.push(node.content);
    if (node.components) out.push(...texts(node.components));
  }
  return out;
}

/** Every link button as [label, url]. */
function buttons(components: unknown[]): [string, string][] {
  const out: [string, string][] = [];
  const walk = (list: unknown[]) => {
    for (const c of list) {
      const node = c as {
        type?: number;
        label?: string;
        url?: string;
        components?: unknown[];
        accessory?: unknown;
      };
      if (node.type === 2 && node.label && node.url) out.push([node.label, node.url]);
      if (node.components) walk(node.components);
      if (node.accessory) walk([node.accessory]);
    }
  };
  walk(components);
  return out;
}

function container(s: LeagueStatusSnapshot) {
  const { payload } = renderLeagueStatus(s);
  expect(payload.flags).toBe(IS_COMPONENTS_V2);
  expect(payload.components).toHaveLength(1);
  return payload.components[0] as { accent_color: number; components: unknown[] };
}

const all = (s: LeagueStatusSnapshot) => texts(container(s).components).join("\n");

describe("progressBar", () => {
  it("fills by whole cells and never overflows", () => {
    expect(progressBar(8, 10)).toBe("▰▰▰▰▰▰▰▰▱▱");
    expect(progressBar(0, 10)).toBe("▱▱▱▱▱▱▱▱▱▱");
    expect(progressBar(23, 50)).toBe("▰▰▰▰▱▱▱▱▱▱");
    expect(progressBar(60, 50)).toBe("▰▰▰▰▰▰▰▰▰▰");
    expect(progressBar(5, 0)).toBe("▱▱▱▱▱▱▱▱▱▱");
  });
});

describe("signups card", () => {
  it("leads with the count and the team goal, then the poll and draft night", () => {
    const c = container(snap());
    expect(c.accent_color).toBe(STATUS_ACCENT.SIGNUPS);
    const text = texts(c.components).join("\n");
    expect(text).toContain("## Signups are open");
    expect(text).toContain("-# GGD2L · Season 2");
    expect(text).toContain("**42 players** are in");
    expect(text).toContain("`▰▰▰▰▰▰▰▰▱▱` **8 of 10** teams");
    expect(text).toContain("8 more players for 10 teams · 6 of 10 captains so far · 3 standins");
    expect(text).toContain("Players are voting: **11 of 42** so far");
    expect(text).toContain(`Voting closes <t:${Math.floor((T0 + 13 * 86_400_000) / 1000)}:R>`);
    expect(text).toContain("**Draft night**\nDate coming soon");
    expect(buttons(c.components)).toEqual([
      ["Vote", `${SITE}/#match-night-poll`],
      ["Sign up", `${SITE}/me`],
      ["Player pool", `${SITE}/players`],
      ["How it works", `${SITE}/how-it-works`],
    ]);
  });

  it("never names the poll's leading time while voting is open", () => {
    // match-night-poll.md: the count stays hidden from non-voters until the
    // poll closes. The snapshot type cannot even carry a leader; this pins
    // that the card prints nothing that reads like one.
    expect(all(snap())).not.toMatch(/leading|most votes|ahead/i);
  });

  it("says the goal is met and counts toward the next team", () => {
    const text = all(
      snap({
        signups: {
          players: 53,
          standins: 0,
          captainVolunteers: 1,
          minTeams: 10,
          teamsFormable: 10,
          needed: 0,
          toNextTeam: 2,
          teamsNeeded: 10,
        },
      }),
    );
    expect(text).toContain("`▰▰▰▰▰▰▰▰▰▰` Enough for **10 teams**");
    // Short of captains, the count is the ask; no standins, no standin count.
    expect(text).toContain("-# 2 more players for 11 teams · 1 of 10 captains so far\n");
  });

  it("counts captain volunteers once there are enough", () => {
    const text = all(
      snap({ signups: { ...snap().signups!, captainVolunteers: 11 } }),
    );
    expect(text).toContain("· 11 want to captain ·");
  });

  const draftNight = {
    state: "NOT_STARTED" as const,
    atMs: T0 + 86_400_000,
    soon: false,
    captains: 10,
    pool: 40,
    sold: 0,
    startedAtMs: null,
    teams: [],
    seasonStartsAtMs: null,
  };

  it("shows a decided match night and a set draft night on the reader's clock", () => {
    const c = container(
      snap({
        matchNight: { kind: "set", label: "Sundays at 6 PM PT" },
        draft: draftNight,
      }),
    );
    const text = texts(c.components).join("\n");
    expect(text).toContain("**Match night**\nSundays at 6 PM PT");
    const at = Math.floor((T0 + 86_400_000) / 1000);
    expect(text).toContain(`**Draft night**\n<t:${at}:F>\n-# <t:${at}:R>`);
    expect(buttons(c.components).map(([l]) => l)).not.toContain("Draft room");
  });

  it("links the draft room on draft night, as Home does", () => {
    const c = container(snap({ draft: { ...draftNight, soon: true } }));
    expect(buttons(c.components)).toContainEqual(["Draft room", `${SITE}/draft`]);
  });

  it("adds the inhouse night with its own I'm in button, and its on state", () => {
    const upcoming = container(
      snap({
        inhouseNight: {
          startsAtMs: T0,
          state: "UPCOMING",
          note: "Turbo night,\n## all heroes",
          inviteUrl: `${SITE}/inhouse?imin=1`,
          joinUrl: `${SITE}/inhouse?join=1`,
        },
      }),
    );
    // The admin's note rides along on one line: a newline can't start a
    // heading inside the card.
    expect(texts(upcoming.components).join("\n")).toContain(
      `**Inhouse night**\n<t:${T0 / 1000}:F>\nTurbo night, ## all heroes\n-# <t:${T0 / 1000}:R>`,
    );
    expect(buttons(upcoming.components)).toContainEqual([
      "I'm in",
      `${SITE}/inhouse?imin=1`,
    ]);
    const on = container(
      snap({
        inhouseNight: {
          startsAtMs: T0,
          state: "ON",
          note: "",
          inviteUrl: `${SITE}/inhouse?imin=1`,
          joinUrl: `${SITE}/inhouse?join=1`,
        },
      }),
    );
    expect(texts(on.components).join("\n")).toContain("**Inhouse night is on**");
    expect(buttons(on.components)).toContainEqual([
      "Join the queue",
      `${SITE}/inhouse?join=1`,
    ]);
  });
});

describe("draft card", () => {
  const draft = {
    state: "NOT_STARTED" as const,
    atMs: T0,
    soon: true,
    captains: 10,
    pool: 50,
    sold: 0,
    startedAtMs: null,
    teams: [] as string[],
    seasonStartsAtMs: null,
  };

  it("before the start: the date, the captains and the pool", () => {
    const c = container(snap({ phase: "DRAFT", draft }));
    expect(c.accent_color).toBe(STATUS_ACCENT.DRAFT);
    const text = texts(c.components).join("\n");
    expect(text).toContain("## Draft night");
    expect(text).toContain(`### <t:${T0 / 1000}:F>`);
    expect(text).toContain("**10 captains** · **50 players** up for auction");
    expect(text).toContain(`-# <t:${T0 / 1000}:R>`);
    // Budgets are MMR-weighted per team, so the card quotes no one figure.
    expect(text).not.toContain("$");
    expect(buttons(c.components).map(([l]) => l)).toEqual([
      "Vote",
      "Watch the draft",
      "Player pool",
    ]);
  });

  it("live: red strip, players sold so far, one button", () => {
    const c = container(
      snap({
        phase: "DRAFT",
        draft: { ...draft, state: "LIVE", sold: 23, startedAtMs: T0 },
      }),
    );
    expect(c.accent_color).toBe(STATUS_ACCENT.DRAFT_LIVE);
    const text = texts(c.components).join("\n");
    expect(text).toContain("## The draft is live");
    expect(text).toContain("`▰▰▰▰▱▱▱▱▱▱` **23 of 50** players drafted");
    expect(text).toContain(`-# Started <t:${T0 / 1000}:R>`);
    expect(buttons(c.components)).toEqual([["Watch live", `${SITE}/draft`]]);
  });

  it("paused and complete read as their own states", () => {
    expect(
      all(snap({ phase: "DRAFT", draft: { ...draft, state: "PAUSED", sold: 5 } })),
    ).toContain("## The draft is paused");
    const done = container(
      snap({
        phase: "DRAFT",
        draft: {
          ...draft,
          state: "COMPLETE",
          captains: 2,
          teams: ["Bad Boys of Dota", "[x](https://evil.test)"],
        },
      }),
    );
    const text = texts(done.components).join("\n");
    expect(text).toContain("## Teams are set");
    expect(text).toContain("**2 teams** drafted\n-# Bad Boys of Dota · ");
    expect(text).not.toContain("](");
    expect(text).toContain("-# The season starts once the schedule is out");
    expect(buttons(done.components)).toContainEqual(["See the teams", `${SITE}/teams`]);
    expect(
      all(
        snap({
          phase: "DRAFT",
          draft: { ...draft, state: "COMPLETE", seasonStartsAtMs: T0 },
        }),
      ),
    ).toContain(`Week 1 kicks off <t:${T0 / 1000}:F>`);
  });
});

describe("fixture lines", () => {
  it("bolds the winner and puts the score in a pill", () => {
    expect(
      fixtureLines(fixture({ state: "FINAL", homeScore: 2, awayScore: 0, winner: "HOME" })),
    ).toEqual(["**Bleeding Hearts** `2–0` Vegan Squadron"]);
    expect(
      fixtureLines(fixture({ state: "FINAL", homeScore: 1, awayScore: 1 })),
    ).toEqual(["Bleeding Hearts `1–1` Vegan Squadron"]);
    expect(
      fixtureLines(
        fixture({ state: "FINAL", homeScore: 0, awayScore: 2, winner: "AWAY", forfeit: true }),
      ),
    ).toEqual(["Bleeding Hearts `0–2` **Vegan Squadron** · forfeit"]);
  });

  it("gives a moved kickoff its new time and leaves a regular one bare", () => {
    expect(fixtureLines(fixture())).toEqual(["Bleeding Hearts `vs` Vegan Squadron"]);
    expect(fixtureLines(fixture({ moved: true }))).toEqual([
      `Bleeding Hearts \`vs\` Vegan Squadron · moved to <t:${T0 / 1000}:f>`,
    ]);
    expect(fixtureLines(fixture({ atMs: null }))).toEqual([
      "Bleeding Hearts `vs` Vegan Squadron · time to be set",
    ]);
  });

  it("notes standins and a waiting reschedule under an unplayed fixture only", () => {
    const busy = fixture({
      standins: [
        { standin: "Fill_In", replaced: "Carry Kid", team: "Vegan Squadron" },
        { standin: "Spare Sam", replaced: null, team: "Bleeding Hearts" },
      ],
      reschedule: { proposer: "Bleeding Hearts", waitingOn: "Vegan Squadron", options: 3 },
    });
    expect(fixtureLines(busy)).toEqual([
      "Bleeding Hearts `vs` Vegan Squadron",
      "-# ↳ Standin: Fill\\_In for Carry Kid (Vegan Squadron)",
      "-# ↳ Standin: Spare Sam fills a seat for Bleeding Hearts",
      "-# ↳ Bleeding Hearts offered 3 new times · waiting on Vegan Squadron",
    ]);
    expect(
      fixtureLines({ ...busy, state: "FINAL", homeScore: 2, winner: "HOME" }),
    ).toEqual(["**Bleeding Hearts** `2–0` Vegan Squadron"]);
  });

  it("escapes player-chosen names: no masked links, no fake mentions", () => {
    const line = fixtureLines(
      fixture({
        home: "[free mmr](https://evil.test)",
        away: "@everyone",
        standins: [{ standin: "<@123>", replaced: null, team: "x" }],
      }),
    ).join("\n");
    expect(line).not.toContain("](");
    expect(line).not.toMatch(/(^|[^\\])@everyone/);
    expect(line).not.toMatch(/(^|[^\\])<@123>/);
  });
});

describe("table", () => {
  const rows = [
    { pos: 1, team: "Bad Boys of Dota", points: 9 },
    { pos: 2, team: "Bleeding Hearts", points: 7 },
    { pos: 3, team: "Sisters of the Veil", points: 5 },
    { pos: 4, team: "Vegan Squadron", points: 4 },
    { pos: 5, team: "A team name far too long for a phone", points: 3 },
  ];

  it("aligns columns, clips long names and draws the playoff line", () => {
    const block = tableBlock({ rows, playoffSpots: 4 });
    const lines = block.split("\n");
    expect(lines[0]).toBe("```");
    expect(lines.at(-1)).toBe("```");
    expect(lines[1]).toBe(" # Team                  Pts");
    expect(lines[2]).toBe(" 1 Bad Boys of Dota        9");
    expect(lines[4]).toBe(" 3 Sisters of the Veil     5");
    expect(lines[6]).toBe("   ── playoff line ─────────");
    expect(lines[7]).toBe(" 5 A team name far too…    3");
    // Every row is one width, narrow enough for a phone's code block, so
    // the columns line up without wrapping.
    const widths = new Set([1, 2, 3, 6, 7].map((i) => Array.from(lines[i]).length));
    expect([...widths]).toEqual([28]);
  });

  it("keeps a backtick from closing the code block", () => {
    const block = tableBlock({
      rows: [{ pos: 1, team: "```oops```", points: 0 }],
      playoffSpots: null,
    });
    expect(block.match(/```/g)).toHaveLength(2);
  });
});

describe("regular season card", () => {
  const season = snap({
    phase: "REGULAR_SEASON",
    matchNight: { kind: "set", label: "Sundays at 6 PM PT" },
    week: {
      label: "Week 3 of 9",
      matchNightAtMs: T0,
      fixtures: [
        fixture({ state: "FINAL", homeScore: 2, awayScore: 0, winner: "HOME" }),
        fixture({ home: "Team Five", away: "Team Six" }),
      ],
      byes: ["Team Seven"],
    },
    table: {
      rows: [{ pos: 1, team: "Bad Boys of Dota", points: 9 }],
      playoffSpots: 4,
    },
    highlights: {
      week: 2,
      player: { name: "Mid Mike", points: 167.5, hero: "Drow Ranger" },
      team: { name: "Bad Boys of Dota", wins: 4 },
      heroImageUrl: "https://cdn.example/drow.png",
      recapUrl: `${SITE}/seasons/s2/weeks/2`,
    },
  });

  it("shows the week and its fixtures, then the table, then the highlights", () => {
    const c = container(season);
    expect(c.accent_color).toBe(STATUS_ACCENT.REGULAR_SEASON);
    const text = texts(c.components).join("\n");
    expect(text).toContain("## Week 3 of 9");
    expect(text).toContain(`Match night <t:${T0 / 1000}:F> · <t:${T0 / 1000}:R>`);
    expect(text).toContain("**This week** · 1 of 2 played");
    expect(text).toContain("Team Five `vs` Team Six\n-# Bye: Team Seven");
    // The honors post's wording: the points are the week's, the hero is the
    // best game's.
    expect(text).toContain(
      "Player of the week: **Mid Mike**\n-# 167.5 impact points · best game on Drow Ranger",
    );
    expect(text).toContain("Team of the week: **Bad Boys of Dota**\n-# 4 game wins");
    expect(text.indexOf("**Standings**\n```")).toBeGreaterThan(text.indexOf("This week"));
    expect(text.indexOf("**Week 2 highlights**")).toBeGreaterThan(text.indexOf("**Standings**"));
    expect(buttons(c.components)).toEqual([
      ["Schedule", `${SITE}/schedule`],
      ["Teams", `${SITE}/teams`],
      ["Week 2 recap", `${SITE}/seasons/s2/weeks/2`],
    ]);
  });

  it("uses the hero's picture beside the player of the week", () => {
    const json = JSON.stringify(renderLeagueStatus(season).payload);
    expect(json).toContain("https://cdn.example/drow.png");
  });

  it("says the regular season is done when no week is left", () => {
    expect(all(snap({ phase: "REGULAR_SEASON", week: null }))).toContain(
      "## Regular season done",
    );
  });
});

describe("playoffs card", () => {
  it("lists the round with best-of and the next round, plus the stream", () => {
    const c = container(
      snap({
        phase: "PLAYOFFS",
        matchNight: { kind: "set", label: "Sundays at 6 PM PT" },
        playoffs: {
          round: "Semifinals",
          fixtures: [
            fixture({ home: "Bad Boys of Dota", away: "Sisters of the Veil", bestOf: 3 }),
            fixture({
              state: "FINAL",
              homeScore: 2,
              awayScore: 1,
              winner: "HOME",
              bestOf: 3,
              outcome: "Bleeding Hearts go to the grand final",
            }),
          ],
          next: { round: "Grand final", bestOf: 5, atMs: T0 + 7 * 86_400_000 },
          stream: { platform: "Twitch", url: "https://www.twitch.tv/ggd2l" },
          bracketUrl: `${SITE}/seasons/s2#playoffs`,
        },
      }),
    );
    expect(c.accent_color).toBe(STATUS_ACCENT.PLAYOFFS);
    const text = texts(c.components).join("\n");
    expect(text).toContain("-# GGD2L · Season 2 · Playoffs");
    expect(text).toContain("## Semifinals");
    expect(text).toContain("**Bad Boys of Dota** `vs` **Sisters of the Veil**");
    expect(text).toContain(`-# <t:${T0 / 1000}:F> · best of 3`);
    expect(text).toContain("**Bleeding Hearts** `2–1` Vegan Squadron\n-# Bleeding Hearts go to the grand final");
    expect(text).toContain("**Up next** · Grand final, best of 5");
    expect(buttons(c.components)).toEqual([
      ["Bracket", `${SITE}/seasons/s2#playoffs`],
      ["Watch on Twitch", "https://www.twitch.tv/ggd2l"],
    ]);
  });
});

describe("complete and offseason cards", () => {
  it("crowns the champion with their logo, the final and the roster", () => {
    const { payload } = renderLeagueStatus(
      snap({
        phase: "COMPLETE",
        champion: {
          team: "Bad Boys of Dota",
          logoUrl: `${SITE}/team-logo.png`,
          final: { opponent: "Bleeding Hearts", score: "3–1", forfeit: false },
          roster: [
            { name: "Support Sue", captain: false },
            { name: "Cap Carl", captain: true },
          ],
          recapUrl: `${SITE}/seasons/s2`,
        },
        matchNight: { kind: "unset" },
      }),
    );
    const c = payload.components[0] as { accent_color: number; components: unknown[] };
    expect(c.accent_color).toBe(STATUS_ACCENT.COMPLETE);
    const text = texts(c.components).join("\n");
    expect(text).toContain("-# GGD2L · Season 2 · Champions");
    expect(text).toContain("## Bad Boys of Dota");
    expect(text).toContain("Won the grand final `3–1` over Bleeding Hearts");
    expect(text).toContain("-# Support Sue · Cap Carl (captain)");
    expect(text).toContain("**Next season**\nComing soon");
    expect(JSON.stringify(payload)).toContain(`${SITE}/team-logo.png`);
    expect(buttons(c.components)).toEqual([
      ["Season recap", `${SITE}/seasons/s2`],
      ["Hall of Fame", `${SITE}/hall-of-fame`],
    ]);
  });

  it("names a forfeit final without a scoreline, and the next season's date", () => {
    const text = all(
      snap({
        phase: "COMPLETE",
        champion: {
          team: "Bad Boys of Dota",
          logoUrl: null,
          final: { opponent: "Bleeding Hearts", score: "1–0", forfeit: true },
          roster: [],
          recapUrl: `${SITE}/seasons/s2`,
        },
        matchNight: { kind: "unset" },
        nextSignupsAtMs: T0,
      }),
    );
    expect(text).toContain("Won the grand final over Bleeding Hearts by forfeit");
    expect(text).toContain(`**Next season**\nSignups open <t:${T0 / 1000}:F>`);
  });

  it("shows an open poll for the next season, and only an open one", () => {
    expect(all(snap({ phase: "COMPLETE" }))).toContain("Players are voting");
    expect(
      all(snap({ phase: "COMPLETE", matchNight: { kind: "set", label: "Sundays" } })),
    ).not.toContain("Match night");
  });

  it("between seasons: the last champion and inhouses", () => {
    const c = container(
      snap({
        phase: "OFFSEASON",
        seasonName: null,
        signups: null,
        matchNight: { kind: "unset" },
        lastChampion: { team: "Bad Boys of Dota", seasonName: "Season 2" },
      }),
    );
    expect(c.accent_color).toBe(STATUS_ACCENT.OFFSEASON);
    const text = texts(c.components).join("\n");
    expect(text).toContain("## Between seasons");
    expect(text).toContain("Last champions: **Bad Boys of Dota** (Season 2)");
    expect(buttons(c.components).map(([l]) => l)).toEqual(["Play inhouses", "Hall of Fame"]);
  });
});

describe("the digest and Discord's limits", () => {
  it("is stable for the same league and moves when what the card says moves", () => {
    const a = renderLeagueStatus(snap()).digest;
    expect(renderLeagueStatus(snap()).digest).toBe(a);
    expect(
      renderLeagueStatus(
        snap({ signups: { ...snap().signups!, players: 43 } }),
      ).digest,
    ).not.toBe(a);
  });

  it("stays inside 40 components and 4,000 characters on the busiest week", () => {
    const busy: StatusFixture[] = Array.from({ length: 12 }, (_, i) =>
      fixture({
        home: `Home team number ${i} with a long name`,
        away: `Away team number ${i} with a long name`,
        moved: true,
        standins: Array.from({ length: 5 }, (_, j) => ({
          standin: `Standin player ${i}-${j} with a long persona`,
          replaced: `Rostered player ${i}-${j} with a long persona`,
          team: `Home team number ${i} with a long name`,
        })),
        reschedule: { proposer: "Home", waitingOn: "Away", options: 3 },
      }),
    );
    const { payload } = renderLeagueStatus(
      snap({
        phase: "REGULAR_SEASON",
        week: { label: "Week 9 of 9", matchNightAtMs: T0, fixtures: busy, byes: ["Bye team"] },
        table: {
          rows: Array.from({ length: 20 }, (_, i) => ({
            pos: i + 1,
            team: `Team ${i}`,
            points: 20 - i,
          })),
          playoffSpots: 8,
        },
        inhouseNight: {
          startsAtMs: T0,
          state: "UPCOMING",
          note: "x".repeat(200),
          inviteUrl: `${SITE}/inhouse?imin=1`,
          joinUrl: `${SITE}/inhouse?join=1`,
        },
      }),
    );
    expect(countComponents(payload.components)).toBeLessThanOrEqual(STATUS_MAX_COMPONENTS);
    expect(totalText(payload.components)).toBeLessThanOrEqual(STATUS_MAX_TEXT);
  });

  it("never carries content or embeds beside Components V2", () => {
    const { payload } = renderLeagueStatus(snap());
    expect(payload).not.toHaveProperty("content");
    expect(payload).not.toHaveProperty("embeds");
  });

  it("doesn't repeat the league's name when the season carries it", () => {
    expect(all(snap({ seasonName: "GGD2L Season 2" }))).toContain(
      "-# GGD2L Season 2\n## Signups are open",
    );
  });

  it("labels the admin card's one-line state", () => {
    expect(statusLabel(snap())).toBe("Signups: 42 players");
    expect(statusLabel(snap({ phase: "OFFSEASON" }))).toBe("Between seasons");
  });
});
