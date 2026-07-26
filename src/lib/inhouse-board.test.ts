import { describe, expect, it } from "vitest";
import { INHOUSE_STATUS } from "./constants";
import {
  boardStateLabel,
  escapeMarkdown,
  progressBar,
  renderBoard,
  type BoardSnapshot,
} from "./inhouse-board";

const T0 = 1_700_000_000_000;

function snap(over: Partial<BoardSnapshot> = {}): BoardSnapshot {
  return {
    presentNames: [],
    awayCount: 0,
    lobbySize: 10,
    lobby: null,
    siteUrl: "https://ggd2l.test",
    nowMs: T0,
    ...over,
  };
}

const names = (n: number) =>
  Array.from({ length: n }, (_, i) => `player${i + 1}`);

describe("renderBoard — queue states", () => {
  it("reads as an invitation when the queue is empty, not as an error", () => {
    const { embed } = renderBoard(snap());
    expect(embed.title).toContain("queue is empty");
    expect(embed.description).toContain("Be the first in");
    expect(embed.url).toBe("https://ggd2l.test/inhouse");
  });

  it("counts present players and says how many more are needed", () => {
    const { embed } = renderBoard(snap({ presentNames: names(6) }));
    expect(embed.title).toBe("🎮 Inhouse queue — 6/10");
    expect(embed.description).toContain("**4 more** players");
    expect(embed.description).toContain("player1, player2");
  });

  it("uses the singular when exactly one player is missing", () => {
    const { embed } = renderBoard(snap({ presentNames: names(9) }));
    expect(embed.description).toContain("**1 more** player and");
  });

  it("switches to the urgent colour inside the last two slots", () => {
    const calm = renderBoard(snap({ presentNames: names(7) })).embed.color;
    const close = renderBoard(snap({ presentNames: names(8) })).embed.color;
    expect(close).not.toBe(calm);
    // ...and stays urgent as it fills further.
    expect(renderBoard(snap({ presentNames: names(9) })).embed.color).toBe(close);
  });

  it("reports away entries as excluded rather than hiding them", () => {
    const { embed } = renderBoard(snap({ presentNames: names(4), awayCount: 2 }));
    expect(embed.title).toBe("🎮 Inhouse queue — 4/10");
    expect(embed.description).toContain("2 away");
  });

  it("collapses a long name list instead of blowing the embed limit", () => {
    const { embed } = renderBoard(snap({ presentNames: names(30) }));
    expect(embed.description).toContain("+18 more");
    expect(embed.description.length).toBeLessThan(4096);
  });

  it("never draws more filled cells than the bar has", () => {
    expect(progressBar(0, 10)).toBe("░".repeat(10));
    expect(progressBar(10, 10)).toBe("█".repeat(10));
    expect(progressBar(99, 10)).toBe("█".repeat(10));
    expect(progressBar(-5, 10)).toBe("░".repeat(10));
  });
});

describe("renderBoard — lobby states", () => {
  const lobby = (over: Partial<NonNullable<BoardSnapshot["lobby"]>> = {}) => ({
    status: INHOUSE_STATUS.READY_CHECK,
    acceptedCount: 0,
    playerCount: 10,
    startedAtMs: null,
    ...over,
  });

  it("shows accept progress during the ready check", () => {
    const { embed } = renderBoard(
      snap({ lobby: lobby({ acceptedCount: 7 }) }),
    );
    expect(embed.title).toBe("🚨 Match found — 7/10 accepted");
  });

  it("collapses vote/draft/ready into one 'picking teams' state", () => {
    const titles = [
      INHOUSE_STATUS.CAPTAIN_VOTE,
      INHOUSE_STATUS.DRAFTING,
      INHOUSE_STATUS.READY,
    ].map((status) => renderBoard(snap({ lobby: lobby({ status }) })).embed.title);
    expect(new Set(titles).size).toBe(1);
    expect(titles[0]).toContain("Picking teams");
  });

  it("renders game time as Discord's own relative timestamp, so it keeps counting without another edit", () => {
    const startedAtMs = T0 - 24 * 60_000;
    const { embed } = renderBoard(
      snap({
        lobby: lobby({ status: INHOUSE_STATUS.IN_PROGRESS, startedAtMs }),
      }),
    );
    expect(embed.title).toContain("Game in progress");
    expect(embed.description).toContain(`<t:${Math.floor(startedAtMs / 1000)}:R>`);
  });

  it("shows queued players as waiting for the NEXT game, not as part of the count", () => {
    const { embed } = renderBoard(
      snap({
        presentNames: names(3),
        lobby: lobby({ status: INHOUSE_STATUS.IN_PROGRESS, startedAtMs: T0 }),
      }),
    );
    expect(embed.description).toContain("**3** in line for the next game");
    expect(embed.title).not.toContain("3/10");
  });

  it("falls back to the queue view for a finished/cancelled lobby", () => {
    const { embed } = renderBoard(
      snap({
        presentNames: names(2),
        lobby: lobby({ status: INHOUSE_STATUS.COMPLETED }),
      }),
    );
    expect(embed.title).toBe("🎮 Inhouse queue — 2/10");
  });
});

describe("digest — the cost model", () => {
  it("ignores the clock, so a motionless queue never burns an edit", () => {
    const a = renderBoard(snap({ presentNames: names(5), nowMs: T0 }));
    const b = renderBoard(
      snap({ presentNames: names(5), nowMs: T0 + 6 * 3600_000 }),
    );
    expect(a.digest).toBe(b.digest);
    // The rendered text DOES differ (the "updated" stamp moved) — which is
    // exactly why the digest, not the body, has to gate the request.
    expect(a.embed.description).not.toBe(b.embed.description);
  });

  it("ignores join order — a reshuffle is not a state change", () => {
    const a = renderBoard(snap({ presentNames: ["ana", "bo", "cy"] }));
    const b = renderBoard(snap({ presentNames: ["cy", "ana", "bo"] }));
    expect(a.digest).toBe(b.digest);
  });

  it("changes when anyone joins, leaves, or goes away", () => {
    const base = renderBoard(snap({ presentNames: names(5) })).digest;
    expect(renderBoard(snap({ presentNames: names(6) })).digest).not.toBe(base);
    expect(renderBoard(snap({ presentNames: names(4) })).digest).not.toBe(base);
    expect(
      renderBoard(snap({ presentNames: names(5), awayCount: 1 })).digest,
    ).not.toBe(base);
  });

  it("cannot collide across different queues that share a separator", () => {
    const a = renderBoard(snap({ presentNames: ["ab", "c"] })).digest;
    const b = renderBoard(snap({ presentNames: ["a", "bc"] })).digest;
    expect(a).not.toBe(b);
  });

  it("changes when a new game starts in the same phase", () => {
    const l = {
      status: INHOUSE_STATUS.IN_PROGRESS,
      acceptedCount: 10,
      playerCount: 10,
    };
    const first = renderBoard(snap({ lobby: { ...l, startedAtMs: T0 } })).digest;
    const second = renderBoard(
      snap({ lobby: { ...l, startedAtMs: T0 + 90 * 60_000 } }),
    ).digest;
    expect(first).not.toBe(second);
  });

  it("changes as accepts land during a ready check", () => {
    const l = {
      status: INHOUSE_STATUS.READY_CHECK,
      playerCount: 10,
      startedAtMs: null,
    };
    const seen = new Set(
      [0, 1, 9, 10].map(
        (acceptedCount) =>
          renderBoard(snap({ lobby: { ...l, acceptedCount } })).digest,
      ),
    );
    expect(seen.size).toBe(4);
  });
});

describe("escapeMarkdown — this message is pinned forever", () => {
  it("defuses formatting, links and fake mentions in a player's persona", () => {
    expect(escapeMarkdown("**boss**")).toBe("\\*\\*boss\\*\\*");
    // The url inside also gets its scheme broken (see the bare-url test).
    expect(escapeMarkdown("[click](http://evil.test)")).toBe(
      "\\[click\\]\\(http:​//evil.test\\)",
    );
    expect(escapeMarkdown("@everyone")).toBe("\\@everyone");
    expect(escapeMarkdown("<t:0:R>")).toBe("\\<t:0:R\\>");
  });

  it("truncates a name that would otherwise dominate the board", () => {
    const out = escapeMarkdown("x".repeat(200));
    expect(out.length).toBeLessThanOrEqual(33);
    expect(out.endsWith("…")).toBe(true);
  });

  it("leaves ordinary names untouched", () => {
    expect(escapeMarkdown("Puppey")).toBe("Puppey");
    expect(escapeMarkdown("Zai.")).toBe("Zai.");
  });

  it("stops a persona that IS a url from becoming a live link", () => {
    // Escaping brackets only kills [label](url); Discord auto-links bare urls
    // too, and this message is pinned forever.
    const out = escapeMarkdown("https://evil.test/free-mmr");
    expect(out).not.toContain("https://");
    expect(out).toContain("​"); // broken with a zero-width space
    expect(escapeMarkdown("www.evil.test")).not.toContain("www.");
    // Still readable — we break the link, we don't mangle the name.
    expect(out.replace(/​/g, "").replace(/\\/g, "")).toBe(
      "https://evil.test/free-mmr",
    );
  });

  it("escapes personas inside the rendered board", () => {
    const { embed } = renderBoard(snap({ presentNames: ["@everyone", "ok"] }));
    expect(embed.description).toContain("\\@everyone");
    expect(embed.description).not.toMatch(/(^|[^\\])@everyone/);
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

  it("reads a lobby phase in plain words, not a constant", () => {
    expect(
      boardStateLabel(
        snap({
          lobby: {
            status: INHOUSE_STATUS.READY_CHECK,
            acceptedCount: 3,
            playerCount: 10,
            startedAtMs: null,
          },
        }),
      ),
    ).toBe("lobby ready check");
  });

  it("mentions players waiting for the next game", () => {
    expect(
      boardStateLabel(
        snap({
          presentNames: names(2),
          lobby: {
            status: INHOUSE_STATUS.IN_PROGRESS,
            acceptedCount: 10,
            playerCount: 10,
            startedAtMs: T0,
          },
        }),
      ),
    ).toBe("lobby in progress, 2 waiting");
  });
});
