import { describe, expect, it } from "vitest";
import { splitLinks } from "./linkify";

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
});
