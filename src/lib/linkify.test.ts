import { describe, expect, it } from "vitest";
import {
  firstMedia,
  firstMediaUrl,
  mediaKind,
  normalizeMediaUrl,
  splitLinks,
} from "./linkify";

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

  it("normalizes a pasted Giphy *page* URL to a direct GIF image token", () => {
    expect(splitLinks("https://giphy.com/gifs/celebrate-abc123XYZ")).toEqual([
      {
        type: "image",
        value: "https://media.giphy.com/media/abc123XYZ/giphy.gif",
      },
    ]);
  });

  it("renders an .mp4 URL as a video token", () => {
    expect(splitLinks("clip https://static.klipy.com/a/b/c/d.mp4")).toEqual([
      { type: "text", value: "clip " },
      { type: "video", value: "https://static.klipy.com/a/b/c/d.mp4" },
    ]);
  });

  it("upgrades a pasted http:// image link to https (mixed-content guard)", () => {
    expect(splitLinks("http://ex.com/a.gif")).toEqual([
      { type: "image", value: "https://ex.com/a.gif" },
    ]);
  });
});

describe("mediaKind", () => {
  it("classifies image extensions, incl. a trailing query or fragment", () => {
    expect(mediaKind("https://media.tenor.com/x/foo.gif")).toBe("image");
    expect(mediaKind("https://ex.com/a.png?cid=1&ct=g")).toBe("image");
    expect(mediaKind("https://ex.com/pic.JPEG")).toBe("image");
    expect(mediaKind("https://ex.com/a.gif#anchor")).toBe("image");
  });

  it("classifies video extensions", () => {
    expect(mediaKind("https://static.klipy.com/a/b/c/x.mp4")).toBe("video");
    expect(mediaKind("https://ex.com/clip.webm?t=1")).toBe("video");
  });

  it("returns null for non-media URLs", () => {
    expect(mediaKind("https://giphy.com/gifs/slug-abc")).toBeNull();
    expect(mediaKind("https://ld2l.gg/news")).toBeNull();
  });
});

describe("normalizeMediaUrl", () => {
  it("maps a Giphy page/sticker URL to its direct media GIF", () => {
    expect(
      normalizeMediaUrl("https://giphy.com/gifs/happy-dance-Ab9CdEf12"),
    ).toBe("https://media.giphy.com/media/Ab9CdEf12/giphy.gif");
    expect(normalizeMediaUrl("https://giphy.com/stickers/xX9y8Z7w6")).toBe(
      "https://media.giphy.com/media/xX9y8Z7w6/giphy.gif",
    );
  });

  it("appends .gif to a Tenor view URL (browser follows the redirect)", () => {
    expect(
      normalizeMediaUrl("https://tenor.com/view/excited-yes-gif-12345678"),
    ).toBe("https://tenor.com/view/excited-yes-gif-12345678.gif");
  });

  it("leaves a Klipy direct URL and other direct media untouched", () => {
    const klipy = "https://static.klipy.com/ii/deadbeef/ab/cd/OXB1QWhn.gif";
    expect(normalizeMediaUrl(klipy)).toBe(klipy);
  });

  it("upgrades an http image URL to https but leaves http page links alone", () => {
    expect(normalizeMediaUrl("http://ex.com/a.gif")).toBe(
      "https://ex.com/a.gif",
    );
    expect(normalizeMediaUrl("http://ex.com/page")).toBe("http://ex.com/page");
  });

  it("doesn't misfire on a Giphy path with no valid trailing id", () => {
    const u = "https://giphy.com/gifs/-";
    expect(normalizeMediaUrl(u)).toBe(u);
  });
});

describe("firstMediaUrl", () => {
  it("returns the first embeddable media URL (normalized) in free text", () => {
    expect(
      firstMediaUrl("hype https://ex.com/a.gif and https://ex.com/b.gif"),
    ).toBe("https://ex.com/a.gif");
    expect(firstMediaUrl("watch https://giphy.com/gifs/win-Zz9Yy8Xx7")).toBe(
      "https://media.giphy.com/media/Zz9Yy8Xx7/giphy.gif",
    );
  });

  it("returns null when there's no media (plain link is not media)", () => {
    expect(firstMediaUrl("read https://ld2l.gg/schedule")).toBeNull();
  });
});

describe("firstMedia", () => {
  it("returns the normalized URL and its kind (for rendering the embed apart)", () => {
    expect(firstMedia("gg https://static.klipy.com/a/b/c/x.mp4")).toEqual({
      value: "https://static.klipy.com/a/b/c/x.mp4",
      kind: "video",
    });
    expect(firstMedia("watch https://giphy.com/gifs/win-Zz9Yy8Xx7")).toEqual({
      value: "https://media.giphy.com/media/Zz9Yy8Xx7/giphy.gif",
      kind: "image",
    });
  });

  it("returns null when there's no embeddable media", () => {
    expect(firstMedia("just text and https://ld2l.gg/news")).toBeNull();
  });
});
