import { describe, expect, it } from "vitest";
import { shareCancelled, shareMethod, shareUrl } from "./share-link";

describe("shareMethod", () => {
  it("opens the share sheet only on a touch screen that has one", () => {
    expect(shareMethod({ canShare: true, coarsePointer: true })).toBe("sheet");
    expect(shareMethod({ canShare: true, coarsePointer: false })).toBe("copy");
    expect(shareMethod({ canShare: false, coarsePointer: true })).toBe("copy");
    expect(shareMethod({ canShare: false, coarsePointer: false })).toBe("copy");
  });
});

describe("shareUrl", () => {
  it("is the page on the viewer's own host, without query or hash", () => {
    expect(shareUrl("https://ggd2l.vercel.app", "/matches/abc")).toBe(
      "https://ggd2l.vercel.app/matches/abc",
    );
    expect(
      shareUrl("http://localhost:3212", "/players/p1?season=s9#history"),
    ).toBe("http://localhost:3212/players/p1");
  });

  it("never leaves the viewer's host, whatever the path says", () => {
    expect(shareUrl("https://ggd2l.vercel.app", "//evil.example/x")).toBe(
      "https://ggd2l.vercel.app/x",
    );
    expect(shareUrl("https://ggd2l.vercel.app/", "https://evil.example/x")).toBe(
      "https://ggd2l.vercel.app/x",
    );
  });
});

describe("shareCancelled", () => {
  it("tells a closed share sheet from a failure", () => {
    expect(shareCancelled(new DOMException("Share canceled", "AbortError"))).toBe(true);
    expect(shareCancelled(new DOMException("Not allowed", "NotAllowedError"))).toBe(false);
    expect(shareCancelled(new TypeError("x"))).toBe(false);
    expect(shareCancelled(null)).toBe(false);
    expect(shareCancelled("AbortError")).toBe(false);
  });
});
