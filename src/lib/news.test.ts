import { describe, expect, it } from "vitest";
import {
  NEWS_DISCORD_POST_STALE_MS,
  NEWS_LIMITS,
  newsDiscordCopy,
  newsDiscordPostingMark,
  newsMediaHint,
  newsPostError,
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
    expect(hint).toMatch(/^Posted — /);
    expect(
      newsMediaHint("https://klipy.com/gifs/cheers-9", "Saved"),
    ).toMatch(/^Saved — /);
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

describe("newsDiscordCopy", () => {
  const now = 1_800_000_000_000;

  it("reads no copy, a posted copy, and a post in flight", () => {
    expect(newsDiscordCopy(null, now)).toEqual({ state: "none" });
    expect(newsDiscordCopy("", now)).toEqual({ state: "none" });
    expect(newsDiscordCopy("1379001234567890123", now)).toEqual({
      state: "posted",
      messageId: "1379001234567890123",
    });
    expect(newsDiscordCopy(newsDiscordPostingMark(now - 5_000), now)).toEqual({
      state: "posting",
      interrupted: false,
    });
  });

  it("calls a mark older than the stale window interrupted", () => {
    const edge = newsDiscordPostingMark(now - NEWS_DISCORD_POST_STALE_MS);
    expect(newsDiscordCopy(edge, now)).toEqual({
      state: "posting",
      interrupted: false,
    });
    const stale = newsDiscordPostingMark(now - NEWS_DISCORD_POST_STALE_MS - 1);
    expect(newsDiscordCopy(stale, now)).toEqual({
      state: "posting",
      interrupted: true,
    });
  });

  it("treats anything unrecognised as no copy rather than an id to edit", () => {
    expect(newsDiscordCopy("posting:soon", now)).toEqual({ state: "none" });
    expect(newsDiscordCopy("abc", now)).toEqual({ state: "none" });
  });
});
