import { describe, expect, it } from "vitest";
import {
  NEWS_LIMITS,
  finalDecidedAt,
  newsMediaHint,
  newsPostError,
  unpinnedNewsNote,
} from "./news";

describe("newsPostError", () => {
  it("accepts a normal post", () => {
    expect(newsPostError("Week 3 moved", "Now on Thursday.")).toBeNull();
  });

  it("rejects empty or oversized fields", () => {
    expect(newsPostError("", "body")).toMatch(/title/i);
    expect(newsPostError("   ", "body")).toMatch(/title/i);
    expect(newsPostError("title", "")).toMatch(/body/i);
    expect(
      newsPostError("t".repeat(NEWS_LIMITS.TITLE_MAX + 1), "body"),
    ).toMatch(/title/i);
    expect(
      newsPostError("title", "b".repeat(NEWS_LIMITS.BODY_MAX + 1)),
    ).toMatch(/body/i);
  });
});

describe("newsMediaHint", () => {
  it("warns when a body has a Klipy page link (won't embed)", () => {
    const hint = newsMediaHint(
      "gg\nhttps://klipy.com/gifs/leonardo-dicaprio-cheers-9",
    );
    expect(hint).toMatch(/klipy/i);
    expect(hint).toMatch(/copy image address/i);
  });

  it("says nothing for a Klipy *direct* media URL (that one embeds)", () => {
    expect(
      newsMediaHint("https://static.klipy.com/ii/deadbeef/ab/cd/OXB1QWhn.gif"),
    ).toBeNull();
  });

  it("says nothing for Giphy/Tenor links or plain text (they embed / are fine)", () => {
    expect(newsMediaHint("https://giphy.com/gifs/win-Zz9Yy8Xx7")).toBeNull();
    expect(
      newsMediaHint("https://tenor.com/view/excited-yes-gif-12345678"),
    ).toBeNull();
    expect(newsMediaHint("Just some news, no links.")).toBeNull();
  });
});

describe("finalDecidedAt", () => {
  const kickoff = new Date("2026-09-20T18:00:00Z");
  const stored = new Date("2026-09-20T23:30:00Z");
  const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);

  it("ends at the latest game's end on Valve's clock", () => {
    expect(
      finalDecidedAt({ scheduledAt: kickoff, completedAt: stored }, [
        { startTime: at("2026-09-20T18:05:00Z"), durationSecs: 2400 },
        { startTime: at("2026-09-20T20:10:00Z"), durationSecs: 1800 },
        { startTime: at("2026-09-20T19:00:00Z"), durationSecs: 2000 },
      ]),
    ).toEqual(new Date("2026-09-20T20:40:00Z"));
  });

  it("ignores games with no start time and counts a bad duration as zero", () => {
    expect(
      finalDecidedAt({ scheduledAt: kickoff, completedAt: stored }, [
        { startTime: 0, durationSecs: 2400 },
        { startTime: at("2026-09-20T19:00:00Z"), durationSecs: -5 },
      ]),
    ).toEqual(new Date("2026-09-20T19:00:00Z"));
  });

  it("falls back to when the result was stored, then to the kickoff", () => {
    expect(
      finalDecidedAt({ scheduledAt: kickoff, completedAt: stored }, [
        { startTime: 0, durationSecs: 0 },
      ]),
    ).toEqual(stored);
    expect(finalDecidedAt({ scheduledAt: kickoff, completedAt: null }, [])).toEqual(
      kickoff,
    );
  });

  it("is null when nothing dates the final", () => {
    expect(finalDecidedAt({ scheduledAt: null, completedAt: null }, [])).toBeNull();
  });
});

describe("unpinnedNewsNote", () => {
  it("says nothing when nothing was unpinned", () => {
    expect(unpinnedNewsNote([])).toBeNull();
  });

  it("names one post and how to pin it again", () => {
    expect(unpinnedNewsNote(["Grand final this Sunday"])).toBe(
      "Unpinned last season's news: “Grand final this Sunday”. Pin it again under League news if it still matters.",
    );
  });

  it("names up to three posts, then counts the rest", () => {
    expect(unpinnedNewsNote(["A", "B"])).toBe(
      "Unpinned last season's news: “A” and “B”. Pin any of them again under League news if they still matter.",
    );
    expect(unpinnedNewsNote(["A", "B", "C"])).toMatch(/“A”, “B” and “C”\./);
    expect(unpinnedNewsNote(["A", "B", "C", "D", "E"])).toMatch(
      /“A”, “B”, “C” and 2 more\./,
    );
  });
});
