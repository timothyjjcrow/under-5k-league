import { afterEach, describe, expect, it, vi } from "vitest";
import { INHOUSE_STATUS } from "./constants";
import {
  boardStateLabel,
  escapeMarkdown,
  rack,
  renderBoard,
  type BoardLobby,
  type BoardSnapshot,
  type BoardStats,
} from "./inhouse-board";

const T0 = 1_700_000_000_000;

function stats(over: Partial<BoardStats> = {}): BoardStats {
  return {
    lastLobbyId: "lob1",
    lastEndedAtMs: T0 - 2 * 3600_000,
    lastWinnerSide: "Dire",
    lastRadiantScore: 19,
    lastDireScore: 32,
    mvpName: "Miracle",
    mvpHero: "Anti-Mage",
    lobbiesPlayed: 128,
    ladderName: "SumaiL",
    ladderRating: 1218,
    ...over,
  };
}

/** A snapshot; `lobby` is shorthand for one live game. */
function snap(
  over: Partial<BoardSnapshot> & { lobby?: BoardLobby | null } = {},
): BoardSnapshot {
  const { lobby: one, ...rest } = over;
  return {
    presentNames: [],
    awayCount: 0,
    lobbySize: 10,
    lobbies: one ? [one] : [],
    stats: null,
    pingOptIn: false,
    siteUrl: "https://ggd2l.test",
    nowMs: T0,
    ...rest,
  };
}

const lobby = (over: Partial<BoardLobby> = {}): BoardLobby => ({
  slot: 1,
  status: INHOUSE_STATUS.READY_CHECK,
  acceptedCount: 0,
  playerCount: 10,
  startedAtMs: null,
  acceptEndsAtMs: null,
  acceptedNames: [],
  pendingNames: [],
  ...over,
});

const names = (n: number) =>
  Array.from({ length: n }, (_, i) => `player${i + 1}`);

describe("the board carries no emoji", () => {
  // The whole design rests on colour + typography doing the work emoji would
  // otherwise do badly on a permanently-pinned surface.
  const EMOJI = /\p{Extended_Pictographic}/u;

  it("renders every state without a single pictograph", () => {
    const states: BoardSnapshot[] = [
      snap({ stats: stats() }),
      snap({ presentNames: names(6) }),
      snap({ presentNames: names(9) }),
      snap({ lobby: lobby({ acceptedCount: 7 }) }),
      snap({ lobby: lobby({ status: INHOUSE_STATUS.DRAFTING }) }),
      snap({
        lobby: lobby({ status: INHOUSE_STATUS.IN_PROGRESS, startedAtMs: T0 }),
      }),
    ];
    for (const s of states) {
      const { embed } = renderBoard(s);
      const all = [
        embed.title,
        embed.description,
        embed.footer.text,
        ...(embed.fields ?? []).flatMap((f) => [f.name, f.value]),
      ].join(" ");
      expect(all).not.toMatch(EMOJI);
    }
  });

  it("uses geometric block glyphs, which are text and not emoji", () => {
    expect(rack(3, 5)).toBe("▰ ▰ ▰ ▱ ▱");
    expect(rack(0, 3)).toBe("▱ ▱ ▱");
    expect(rack(9, 3)).toBe("▰ ▰ ▰"); // never more filled than there are
    expect(rack(-2, 2)).toBe("▱ ▱");
  });

  it("reminds hosts that the inhouse ticket is required", () => {
    expect(renderBoard(snap()).embed.footer.text).toBe(
      "Private lobby — use the Under 5K In-House League ticket. Results import from player match histories.",
    );
  });
});

describe("regional ticket instructions", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("keeps Europe pending without directing hosts to the US ticket", async () => {
    vi.stubEnv("NEXT_PUBLIC_LEAGUE_REGION", "eu");
    vi.stubEnv("NEXT_PUBLIC_APP_NAME", "GGD2L Europe");
    vi.stubEnv("NEXT_PUBLIC_INHOUSE_LEAGUE_NAME", "");
    vi.resetModules();
    const european = await import("./inhouse-board");
    const pending = european.renderBoard(snap());
    expect(pending.embed.footer.text).toBe(
      "The league administrators will provide the European ticket before tracked inhouse games begin.",
    );
    expect(JSON.stringify(pending.embed)).not.toContain("Under 5K In-House League");
    expect(pending.embed.author.name).toBe("GGD2L Europe Inhouse Matchmaking");

    vi.stubEnv("NEXT_PUBLIC_INHOUSE_LEAGUE_NAME", "GGD2L European Inhouse");
    vi.resetModules();
    const configured = (await import("./inhouse-board")).renderBoard(snap());
    expect(configured.embed.footer.text).toBe(
      "Private lobby — use the GGD2L European Inhouse ticket. Results import from player match histories.",
    );
    // Quiet queues still need to repaint when the deployed ticket is supplied.
    expect(configured.digest).not.toBe(pending.digest);
  });
});

describe("empty state — the 95% surface", () => {
  it("leads with the invitation, not with a zero", () => {
    const { embed } = renderBoard(snap({ stats: stats() }));
    expect(embed.title).toBe("Find Match — 10 slots open");
    expect(embed.description).toContain("## Ten slots open.");
    expect(embed.description).toContain("[Take the first slot →]");
  });

  it("proves the league is alive with recency, a name and a volume", () => {
    const { embed } = renderBoard(snap({ stats: stats() }));
    const f = embed.fields ?? [];
    expect(f.map((x) => x.name)).toEqual(["LAST LOBBY", "MVP", "LADDER #1"]);
    expect(f[0].value).toContain("**Dire** 19 – 32");
    expect(f[1].value).toContain("Miracle");
    expect(f[2].value).toContain("SumaiL");
    expect(embed.description).toContain("128 lobbies played");
  });

  it("never says 'updated N ago' — after a quiet weekend that reads as dead", () => {
    const { embed } = renderBoard(snap({ stats: stats() }));
    expect(embed.description).not.toContain("updated");
    expect(embed.description).not.toContain("queue last moved");
  });

  it("omits any stat it doesn't have rather than faking one", () => {
    const { embed } = renderBoard(
      snap({ stats: stats({ mvpName: null, ladderName: null }) }),
    );
    expect((embed.fields ?? []).map((f) => f.name)).toEqual(["LAST LOBBY"]);
  });

  it("shows nothing but the invitation for a league with no games yet", () => {
    const { embed } = renderBoard(
      snap({
        stats: stats({
          lastLobbyId: null,
          lastEndedAtMs: null,
          mvpName: null,
          ladderName: null,
          lobbiesPlayed: 0,
        }),
      }),
    );
    expect(embed.fields ?? []).toHaveLength(0);
    expect(embed.description).toContain("Start the first inhouse");
    expect(embed.description).not.toContain("lobbies played");
  });

  it("never crowns a side when the sides weren't recorded", () => {
    const { embed } = renderBoard(
      snap({ stats: stats({ lastWinnerSide: null }) }),
    );
    expect(embed.fields![0].value).toContain("**19 – 32**");
    expect(embed.fields![0].value).not.toContain("Radiant");
    expect(embed.fields![0].value).not.toContain("Dire");
  });
});

describe("filling — the slot rack is the call to action", () => {
  it("draws ten rows: taken names, then open slots", () => {
    const { embed } = renderBoard(snap({ presentNames: names(6) }));
    const rows = embed.fields![0].value.split("\n");
    expect(rows).toHaveLength(10);
    expect(rows[0]).toBe("▰ player1");
    expect(rows[6]).toBe("▱ *open*");
    expect(rows[9]).toBe("▱ *open*");
  });

  it("is the same height whether one player or nine is queued", () => {
    const one = renderBoard(snap({ presentNames: names(1) }));
    const nine = renderBoard(snap({ presentNames: names(9) }));
    expect(one.embed.fields![0].value.split("\n")).toHaveLength(10);
    expect(nine.embed.fields![0].value.split("\n")).toHaveLength(10);
  });

  it("spells the count in the header and escalates the colour near the end", () => {
    expect(
      renderBoard(snap({ presentNames: names(6) })).embed.description,
    ).toContain("## Four more.");
    expect(
      renderBoard(snap({ presentNames: names(9) })).embed.description,
    ).toContain("## One slot left.");
    const calm = renderBoard(snap({ presentNames: names(7) })).embed.color;
    const hot = renderBoard(snap({ presentNames: names(8) })).embed.color;
    expect(hot).not.toBe(calm);
  });

  it("changes the call to action for the last slot", () => {
    expect(
      renderBoard(snap({ presentNames: names(9) })).embed.description,
    ).toContain("[Take the last slot →]");
    expect(
      renderBoard(snap({ presentNames: names(4) })).embed.description,
    ).toContain("[Take a slot →]");
  });

  it("reports away players without giving them a headline", () => {
    const { embed } = renderBoard(
      snap({ presentNames: names(4), awayCount: 2 }),
    );
    expect(embed.title).toBe("Searching for Match — 4 / 10");
    expect(embed.fields![0].value).toContain("2 away");
  });
});

describe("lobby states", () => {
  it("shows the accept grid during a ready check", () => {
    const { embed } = renderBoard(
      snap({
        lobby: lobby({
          acceptedCount: 2,
          acceptedNames: ["Puppey", "Zai"],
          pendingNames: ["Ana"],
          acceptEndsAtMs: T0 + 30_000,
        }),
      }),
    );
    expect(embed.title).toBe("Match Found — 2 / 10 accepted");
    expect(embed.description).toContain(
      `<t:${Math.floor((T0 + 30_000) / 1000)}:R>`,
    );
    expect(embed.fields![0].name).toBe("ACCEPTED — 2");
    expect(embed.fields![1].name).toBe("WAITING ON — 1");
    expect(embed.fields![1].value).toContain("▱ Ana");
  });

  it("distinguishes vote, draft and ready by header alone", () => {
    const heads = [
      INHOUSE_STATUS.CAPTAIN_VOTE,
      INHOUSE_STATUS.DRAFTING,
      INHOUSE_STATUS.READY,
    ].map(
      (status) =>
        renderBoard(snap({ lobby: lobby({ status }) })).embed.description.split(
          "\n",
        )[0],
    );
    expect(new Set(heads).size).toBe(3);
    expect(heads[1]).toBe("## Captains are drafting.");
  });

  it("never labels a side — Radiant isn't known until the match imports", () => {
    const { embed } = renderBoard(
      snap({
        lobby: lobby({ status: INHOUSE_STATUS.IN_PROGRESS, startedAtMs: T0 }),
      }),
    );
    expect(embed.description).toContain("▰ ▰ ▰ ▰ ▰ │ ▰ ▰ ▰ ▰ ▰");
    expect(embed.description).not.toMatch(/Radiant|Dire/);
  });

  it("converts into the NEXT game once this one is closed", () => {
    const { embed } = renderBoard(
      snap({
        presentNames: names(3),
        lobby: lobby({ status: INHOUSE_STATUS.IN_PROGRESS, startedAtMs: T0 }),
      }),
    );
    expect(embed.description).toContain("[Queue for the next one →]");
    expect(embed.fields![0].name).toBe("IN LINE FOR THE NEXT GAME — 3");
    expect(embed.fields![0].value).toContain("7 more and the next lobby forms");
  });

  it("falls back to the queue view for a finished lobby", () => {
    const { embed } = renderBoard(
      snap({
        presentNames: names(2),
        lobby: lobby({ status: INHOUSE_STATUS.COMPLETED }),
      }),
    );
    expect(embed.title).toBe("Searching for Match — 2 / 10");
  });
});

describe("the LIVE state", () => {
  it("goes straight from the rack to the blurb — no priced line", () => {
    const rows = renderBoard(
      snap({
        lobby: lobby({ status: INHOUSE_STATUS.IN_PROGRESS, startedAtMs: T0 }),
      }),
    ).embed.description.split("\n");
    expect(rows[1]).toBe("▰ ▰ ▰ ▰ ▰ │ ▰ ▰ ▰ ▰ ▰");
    expect(rows[2]).toBe("");
    expect(rows.join("\n")).not.toMatch(/\bcred\b|\bstakes?\b|\bpot\b/i);
  });
});

describe("CTAs deep-link into the queue", () => {
  // The ?join=1 one-tap link has to reach the PINNED BOARD, not just the
  // transient text ping — the board is the surface that's permanently on
  // screen, so it's where most taps come from.
  it("puts ?join=1 on every take-a-slot call to action", () => {
    for (const s of [
      snap({ stats: stats() }),
      snap({ presentNames: names(6) }),
      snap({ presentNames: names(9) }),
    ]) {
      const d = renderBoard(s).embed.description;
      expect(d).toMatch(
        /\[Take [^\]]+→\]\(https:\/\/ggd2l\.test\/inhouse\?join=1\)/,
      );
    }
  });

  it("deep-links 'queue for the next one' during a live game", () => {
    const d = renderBoard(
      snap({
        lobby: lobby({ status: INHOUSE_STATUS.IN_PROGRESS, startedAtMs: T0 }),
      }),
    ).embed.description;
    expect(d).toContain(
      "[Queue for the next one →](https://ggd2l.test/inhouse?join=1)",
    );
  });

  it("leaves the TITLE on the plain url — a heading is not a join button", () => {
    const { embed } = renderBoard(snap({ presentNames: names(3) }));
    expect(embed.url).toBe("https://ggd2l.test/inhouse");
    expect(embed.author.url).toBe("https://ggd2l.test/inhouse");
  });

  it("does not deep-link the accept CTA — that's a different action", () => {
    const d = renderBoard(snap({ lobby: lobby({ acceptedCount: 3 }) })).embed
      .description;
    expect(d).toContain("[Accept your match →](https://ggd2l.test/inhouse)");
  });
});

describe("the opt-in blurb", () => {
  it("is absent until the league can actually grant the role", () => {
    // Advertising a notification that can't fire is worse than not mentioning
    // it — the board must never point at a dead switch.
    const { embed } = renderBoard(snap({ stats: stats() }));
    expect(embed.description).not.toContain("/me");
    expect(embed.description).not.toMatch(/ping/i);
  });

  it("points at the profile toggle once it works", () => {
    const { embed } = renderBoard(snap({ stats: stats(), pingOptIn: true }));
    expect(embed.description).toContain("https://ggd2l.test/me");
    expect(embed.description).toContain("inhouse pings");
  });

  it("only appears on the resting state, not mid-fill", () => {
    const { embed } = renderBoard(
      snap({ presentNames: names(6), pingOptIn: true }),
    );
    expect(embed.description).not.toContain("/me");
  });

  it("repaints the board when the league turns it on", () => {
    expect(renderBoard(snap({ stats: stats() })).digest).not.toBe(
      renderBoard(snap({ stats: stats(), pingOptIn: true })).digest,
    );
  });
});

describe("digest — the cost model", () => {
  it("ignores the clock, so a motionless queue never burns an edit", () => {
    const a = renderBoard(snap({ presentNames: names(5), nowMs: T0 }));
    const b = renderBoard(
      snap({ presentNames: names(5), nowMs: T0 + 6 * 3600_000 }),
    );
    expect(a.digest).toBe(b.digest);
    expect(a.embed.description).not.toBe(b.embed.description);
  });

  it("is stable on an idle board even as time passes", () => {
    const a = renderBoard(snap({ stats: stats(), nowMs: T0 }));
    const b = renderBoard(snap({ stats: stats(), nowMs: T0 + 864e5 }));
    expect(a.digest).toBe(b.digest);
  });

  it("ignores join order — a reshuffle is not a state change", () => {
    expect(renderBoard(snap({ presentNames: ["a", "b", "c"] })).digest).toBe(
      renderBoard(snap({ presentNames: ["c", "a", "b"] })).digest,
    );
  });

  it("changes when anyone joins, leaves or goes away", () => {
    const base = renderBoard(snap({ presentNames: names(5) })).digest;
    expect(renderBoard(snap({ presentNames: names(6) })).digest).not.toBe(base);
    expect(renderBoard(snap({ presentNames: names(4) })).digest).not.toBe(base);
    expect(
      renderBoard(snap({ presentNames: names(5), awayCount: 1 })).digest,
    ).not.toBe(base);
  });

  it("cannot collide across queues that share a separator", () => {
    expect(renderBoard(snap({ presentNames: ["ab", "c"] })).digest).not.toBe(
      renderBoard(snap({ presentNames: ["a", "bc"] })).digest,
    );
  });

  it("repaints the idle board when a new result lands", () => {
    const a = renderBoard(snap({ stats: stats() })).digest;
    const b = renderBoard(
      snap({ stats: stats({ lastLobbyId: "lob2", lobbiesPlayed: 129 }) }),
    ).digest;
    expect(a).not.toBe(b);
  });

  it.each([
    { lastEndedAtMs: T0 },
    { lastWinnerSide: "Radiant" },
    { lastRadiantScore: 25 },
    { lastDireScore: 35 },
    { mvpName: "Ame" },
    { mvpHero: "Invoker" },
    { ladderRating: 1300 },
  ])("repaints corrected stats on the same last result: %j", (corrected) => {
    const original = renderBoard(snap({ stats: stats() }));
    const revised = renderBoard(snap({ stats: stats(corrected) }));
    expect(revised.embed).not.toEqual(original.embed);
    expect(revised.digest).not.toBe(original.digest);
  });

  it("repaints a pending player's changed name before they accept", () => {
    const original = renderBoard(
      snap({ lobby: lobby({ pendingNames: ["old name"] }) }),
    );
    const revised = renderBoard(
      snap({ lobby: lobby({ pendingNames: ["new name"] }) }),
    );
    expect(revised.digest).not.toBe(original.digest);
  });

  it("repaints links when the canonical site moves", () => {
    const original = renderBoard(snap({ presentNames: names(5) }));
    const revised = renderBoard(
      snap({ presentNames: names(5), siteUrl: "https://new.ggd2l.test" }),
    );
    expect(revised.digest).not.toBe(original.digest);
  });

  it("repaints when a NEW ready check opens at the same accepted count", () => {
    const a = renderBoard(
      snap({ lobby: lobby({ acceptedCount: 0, acceptEndsAtMs: T0 + 45_000 }) }),
    ).digest;
    const b = renderBoard(
      snap({ lobby: lobby({ acceptedCount: 0, acceptEndsAtMs: T0 + 90_000 }) }),
    ).digest;
    expect(a).not.toBe(b);
  });

  it("keeps the clock out of the LIVE digest", () => {
    // Elapsed time renders as <t:…:R>, which keeps counting in every client;
    // in the digest it would cost one PATCH per BOARD_MIN_SECONDS all game.
    const live = (nowMs: number) =>
      renderBoard(
        snap({
          nowMs,
          lobby: lobby({
            status: INHOUSE_STATUS.IN_PROGRESS,
            startedAtMs: T0,
          }),
        }),
      ).digest;
    expect(live(T0)).toBe(live(T0 + 3600_000));
  });

  it("tracks accepts landing during a check", () => {
    const seen = new Set(
      [0, 1, 9, 10].map(
        (acceptedCount) =>
          renderBoard(snap({ lobby: lobby({ acceptedCount }) })).digest,
      ),
    );
    expect(seen.size).toBe(4);
  });
});

describe("escapeMarkdown — this message is pinned forever", () => {
  it("strips newlines FIRST so a persona cannot forge a slot row", () => {
    // The rack is one player per line; a newline in a name would invent rows
    // and make the board lie about its own count.
    const out = escapeMarkdown("evil\nplayer");
    expect(out).not.toContain("\n");
    const { embed } = renderBoard(snap({ presentNames: ["evil\nplayer"] }));
    expect(embed.fields![0].value.split("\n")).toHaveLength(10);
  });

  it("defuses formatting, links and fake mentions", () => {
    expect(escapeMarkdown("**boss**")).toBe("\\*\\*boss\\*\\*");
    expect(escapeMarkdown("@everyone")).toBe("\\@everyone");
    expect(escapeMarkdown("<t:0:R>")).toBe("\\<t:0:R\\>");
  });

  it("stops a persona that IS a url from becoming a live link", () => {
    const out = escapeMarkdown("https://evil.test/free-mmr");
    expect(out).not.toContain("https://");
    expect(escapeMarkdown("www.evil.test")).not.toContain("www.");
  });

  it("truncates a name that would otherwise dominate the board", () => {
    const out = escapeMarkdown("x".repeat(200));
    expect(out.length).toBeLessThanOrEqual(33);
    expect(out.endsWith("…")).toBe(true);
  });

  it("leaves ordinary names untouched", () => {
    expect(escapeMarkdown("Puppey")).toBe("Puppey");
  });
});

describe("boardStateLabel — the admin's 'is it lying?' line", () => {
  it("states the live queue, away players included", () => {
    expect(boardStateLabel(snap({ presentNames: names(4) }))).toBe(
      "4/10 queued",
    );
    expect(
      boardStateLabel(snap({ presentNames: names(4), awayCount: 2 })),
    ).toBe("4/10 queued (+2 away)");
  });

  it("reads a lobby phase in plain words", () => {
    expect(boardStateLabel(snap({ lobby: lobby() }))).toBe("lobby ready check");
    expect(
      boardStateLabel(
        snap({
          presentNames: names(2),
          lobby: lobby({ status: INHOUSE_STATUS.IN_PROGRESS }),
        }),
      ),
    ).toBe("lobby in progress, 2 waiting");
  });
});

describe("two live games", () => {
  const drafting = lobby({ slot: 1, status: INHOUSE_STATUS.DRAFTING });
  const checking = lobby({ slot: 2, acceptedCount: 4 });

  it("leads with the game that needs the channel most and lists the other", () => {
    const { embed } = renderBoard(snap({ lobbies: [drafting, checking] }));
    // The ready check is ten people on a clock; the draft gets one line.
    expect(embed.title).toBe("Game 2 · Match Found — 4 / 10 accepted");
    expect(embed.fields?.find((f) => f.name === "ALSO LIVE")?.value).toBe(
      "**Game 1** · captains drafting",
    );
    // Equal urgency: the lower game number leads.
    const both = renderBoard(
      snap({
        lobbies: [
          lobby({ slot: 1, status: INHOUSE_STATUS.IN_PROGRESS, startedAtMs: T0 }),
          lobby({ slot: 2, status: INHOUSE_STATUS.IN_PROGRESS, startedAtMs: T0 }),
        ],
      }),
    ).embed;
    expect(both.title).toBe("Game 1 · Match in Progress");
    expect(both.fields?.find((f) => f.name === "ALSO LIVE")?.value).toBe(
      `**Game 2** · live, started <t:${T0 / 1000}:R>`,
    );
  });

  it("keeps a lone game 1 exactly as one game always looked", () => {
    const { embed } = renderBoard(snap({ lobby: drafting }));
    expect(embed.title).toBe("Preparing Your Match");
    expect(embed.fields?.some((f) => f.name === "ALSO LIVE")).toBe(false);
  });

  it("says the next lobby waits for a game to finish once every slot is taken", () => {
    const value = (lobbies: BoardLobby[]) =>
      renderBoard(snap({ lobbies, presentNames: names(3) })).embed.fields?.find(
        (f) => f.name.startsWith("IN LINE FOR THE NEXT GAME"),
      )?.value;
    const playing = lobby({
      slot: 2,
      status: INHOUSE_STATUS.IN_PROGRESS,
      startedAtMs: T0,
    });
    expect(value([drafting])).toContain("7 more and the next lobby forms.");
    expect(value([drafting, playing])).toContain(
      "The next lobby forms when a game finishes.",
    );
  });

  it("repaints when the other game moves, never for the clock", () => {
    const digest = (other: BoardLobby, nowMs = T0) =>
      renderBoard(snap({ lobbies: [checking, other], nowMs })).digest;
    const vote = lobby({ slot: 1, status: INHOUSE_STATUS.CAPTAIN_VOTE });
    expect(digest(vote)).not.toBe(digest(drafting));
    expect(digest(drafting, T0 + 60_000)).toBe(digest(drafting));
  });

  it("names both games on the admin's state line", () => {
    expect(
      boardStateLabel(snap({ lobbies: [drafting, checking], presentNames: names(2) })),
    ).toBe("game 1 drafting, game 2 ready check, 2 waiting");
    // A lone game 2 is still called by its number.
    expect(boardStateLabel(snap({ lobby: checking }))).toBe("game 2 ready check");
  });
});
