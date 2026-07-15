import { describe, expect, it } from "vitest";
import { NEWS_LIMITS, newsMediaHint, newsPostError, sortNews } from "./news";

describe("sortNews", () => {
  it("puts pinned posts first, newest first within each group", () => {
    const posts = [
      { id: "old", pinned: false, createdAt: 100 },
      { id: "pinned-old", pinned: true, createdAt: 50 },
      { id: "new", pinned: false, createdAt: 200 },
      { id: "pinned-new", pinned: true, createdAt: 150 },
    ];
    expect(sortNews(posts).map((p) => p.id)).toEqual([
      "pinned-new",
      "pinned-old",
      "new",
      "old",
    ]);
  });

  it("does not mutate the input", () => {
    const posts = [
      { id: "a", pinned: false, createdAt: 1 },
      { id: "b", pinned: true, createdAt: 2 },
    ];
    sortNews(posts);
    expect(posts.map((p) => p.id)).toEqual(["a", "b"]);
  });
});

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
    expect(newsPostError("title", "b".repeat(NEWS_LIMITS.BODY_MAX + 1))).toMatch(
      /body/i,
    );
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
