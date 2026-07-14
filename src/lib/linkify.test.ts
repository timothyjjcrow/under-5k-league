import { describe, expect, it } from "vitest";
import { firstImageUrl, isImageUrl, splitLinks } from "./linkify";

describe("splitLinks", () => {
  it("passes through text with no URLs as one token", () => {
    expect(splitLinks("Playoffs start Friday!")).toEqual([
      { type: "text", value: "Playoffs start Friday!" },
    ]);
  });

  it("tokenizes a URL in the middle of a sentence", () => {
    expect(splitLinks("Bracket at https://ld2l.gg/schedule tonight")).toEqual([
      { type: "text", value: "Bracket at " },
      { type: "link", value: "https://ld2l.gg/schedule" },
      { type: "text", value: " tonight" },
    ]);
  });

  it("trims sentence punctuation off the end of a URL", () => {
    expect(splitLinks("Sign up: https://ld2l.gg/me.")).toEqual([
      { type: "text", value: "Sign up: " },
      { type: "link", value: "https://ld2l.gg/me" },
      { type: "text", value: "." },
    ]);
  });

  it("closes a parenthetical without eating the paren", () => {
    expect(splitLinks("(details: https://ld2l.gg/news)")).toEqual([
      { type: "text", value: "(details: " },
      { type: "link", value: "https://ld2l.gg/news" },
      { type: "text", value: ")" },
    ]);
  });

  it("trims a sentence-closing paren that follows other punctuation", () => {
    expect(splitLinks("See the bracket (https://ld2l.gg/schedule).")).toEqual([
      { type: "text", value: "See the bracket (" },
      { type: "link", value: "https://ld2l.gg/schedule" },
      { type: "text", value: ")." },
    ]);
  });

  it("keeps a balancing paren even when a period follows", () => {
    const url = "https://en.wikipedia.org/wiki/Dota_2_(video_game)";
    expect(splitLinks(`(read ${url}).`)).toEqual([
      { type: "text", value: "(read " },
      { type: "link", value: url },
      { type: "text", value: ")." },
    ]);
  });

  it("keeps a balancing paren that belongs to the URL", () => {
    const url = "https://en.wikipedia.org/wiki/Dota_2_(video_game)";
    expect(splitLinks(`read ${url}.`)).toEqual([
      { type: "text", value: "read " },
      { type: "link", value: url },
      { type: "text", value: "." },
    ]);
  });

  it("handles a URL at the very start and very end", () => {
    expect(splitLinks("https://a.gg and https://b.gg")).toEqual([
      { type: "link", value: "https://a.gg" },
      { type: "text", value: " and " },
      { type: "link", value: "https://b.gg" },
    ]);
  });

  it("handles URLs on separate lines", () => {
    expect(splitLinks("one:\nhttps://a.gg\ntwo")).toEqual([
      { type: "text", value: "one:\n" },
      { type: "link", value: "https://a.gg" },
      { type: "text", value: "\ntwo" },
    ]);
  });

  it("ignores non-http schemes", () => {
    expect(splitLinks("steam://run/570 is not linked")).toEqual([
      { type: "text", value: "steam://run/570 is not linked" },
    ]);
  });

  it("tokenizes a direct GIF URL as an image, not a link", () => {
    expect(
      splitLinks("gg! https://media.giphy.com/media/xyz/giphy.gif"),
    ).toEqual([
      { type: "text", value: "gg! " },
      { type: "image", value: "https://media.giphy.com/media/xyz/giphy.gif" },
    ]);
  });

  it("keeps a Giphy *page* URL (no extension) as a plain link", () => {
    expect(splitLinks("https://giphy.com/gifs/celebrate-abc123")).toEqual([
      { type: "link", value: "https://giphy.com/gifs/celebrate-abc123" },
    ]);
  });
});

describe("isImageUrl", () => {
  it("matches direct image extensions, incl. a trailing query string", () => {
    expect(isImageUrl("https://media.tenor.com/x/foo.gif")).toBe(true);
    expect(isImageUrl("https://ex.com/a.png?cid=1&ct=g")).toBe(true);
    expect(isImageUrl("https://ex.com/pic.JPEG")).toBe(true);
  });

  it("rejects non-image URLs", () => {
    expect(isImageUrl("https://giphy.com/gifs/slug-abc")).toBe(false);
    expect(isImageUrl("https://ld2l.gg/news")).toBe(false);
  });
});

describe("firstImageUrl", () => {
  it("returns the first embeddable image URL in free text", () => {
    expect(
      firstImageUrl("hype https://ex.com/a.gif and https://ex.com/b.gif"),
    ).toBe("https://ex.com/a.gif");
  });

  it("returns null when there's no image (plain link is not an image)", () => {
    expect(firstImageUrl("read https://ld2l.gg/schedule")).toBeNull();
  });
});
