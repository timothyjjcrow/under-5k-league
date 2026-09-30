import { describe, expect, it } from "vitest";
import {
  capNames,
  hueHex,
  matchCardStatus,
  ogImageUrlAllowed,
  sniffImageType,
} from "./og-image";

describe("ogImageUrlAllowed", () => {
  it("accepts Imgur crests and Steam avatars over HTTPS", () => {
    for (const url of [
      "https://i.imgur.com/abc123.png",
      "https://avatars.steamstatic.com/0123abcd_full.jpg",
      "https://avatars.akamai.steamstatic.com/0123abcd_full.jpg",
      "https://avatars.cloudflare.steamstatic.com/0123abcd_full.jpg",
      "https://steamcdn-a.akamaihd.net/steamcommunity/public/images/avatars/01/0123_full.jpg",
    ]) {
      expect(ogImageUrlAllowed(url), url).toBe(true);
    }
  });

  it("refuses every other address the server would otherwise fetch", () => {
    for (const url of [
      null,
      undefined,
      "",
      "not a url",
      // Plain HTTP, another port, credentials, or a look-alike host.
      "http://i.imgur.com/abc.png",
      "https://i.imgur.com:8443/abc.png",
      "https://user:pass@i.imgur.com/abc.png",
      "https://i.imgur.com.evil.example/abc.png",
      "https://imgur.com/gallery/abc",
      // A path on this site, and addresses inside the network.
      "/brand/logo.png",
      "https://localhost/logo.png",
      "https://169.254.169.254/latest/meta-data",
      "https://127.0.0.1/logo.png",
    ]) {
      expect(ogImageUrlAllowed(url), String(url)).toBe(false);
    }
  });
});

describe("sniffImageType", () => {
  it("reads PNG and JPEG from their first bytes", () => {
    expect(
      sniffImageType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])),
    ).toBe("png");
    expect(sniffImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
  });

  it("refuses anything else, whatever the headers said", () => {
    const text = (s: string) => Uint8Array.from(Buffer.from(s));
    expect(sniffImageType(text("GIF89a"))).toBeNull();
    expect(sniffImageType(text("RIFF\0\0\0\0WEBP"))).toBeNull();
    expect(sniffImageType(text("<!doctype html>"))).toBeNull();
    expect(sniffImageType(Uint8Array.from([0x89, 0x50]))).toBeNull();
    expect(sniffImageType(new Uint8Array())).toBeNull();
  });
});

describe("matchCardStatus", () => {
  const names = { home: "Dire Straits", away: "Mid or Feed" };
  const kickoff = new Date("2026-10-04T01:00:00Z");
  const NOW = kickoff.getTime() - 3_600_000;
  function match(overrides: Partial<Parameters<typeof matchCardStatus>[0]> = {}) {
    return {
      status: "SCHEDULED",
      homeScore: 0,
      awayScore: 0,
      homeTeamId: "h",
      awayTeamId: "a",
      winnerTeamId: null,
      forfeit: false,
      bestOf: 3,
      scheduledAt: kickoff,
      ...overrides,
    };
  }

  it("gives the kickoff and series length before the match", () => {
    expect(matchCardStatus(match(), names, "Sat, Oct 3, 6:00 PM Pacific time", NOW)).toEqual({
      tone: "upcoming",
      text: "Sat, Oct 3, 6:00 PM Pacific time · Best of 3",
    });
    expect(
      matchCardStatus(match({ scheduledAt: null }), names, null, NOW),
    ).toEqual({ tone: "upcoming", text: "Kickoff time to be set · Best of 3" });
  });

  it("is live once a game is in, even before the status catches up", () => {
    expect(matchCardStatus(match({ status: "LIVE" }), names, "x", NOW)).toEqual({
      tone: "live",
      text: "Live now · Best of 3",
    });
    expect(matchCardStatus(match({ awayScore: 1 }), names, "x", NOW).tone).toBe("live");
  });

  it("awaits the result once kickoff has passed with nothing in", () => {
    expect(
      matchCardStatus(match({ bestOf: 2 }), names, "x", kickoff.getTime()),
    ).toEqual({ tone: "pending", text: "Awaiting result · Best of 2" });
  });

  it("gives the result in the link text's words", () => {
    expect(
      matchCardStatus(
        match({ status: "COMPLETED", homeScore: 1, awayScore: 2, winnerTeamId: "a" }),
        names,
        "x",
        NOW,
      ),
    ).toEqual({ tone: "final", text: "Mid or Feed won 2–1" });
    expect(
      matchCardStatus(
        match({ status: "COMPLETED", homeScore: 1, awayScore: 1, bestOf: 2 }),
        names,
        "x",
        NOW,
      ).text,
    ).toBe("Drawn 1–1");
    expect(
      matchCardStatus(
        match({ status: "COMPLETED", homeScore: 2, winnerTeamId: "h", forfeit: true }),
        names,
        "x",
        NOW,
      ).text,
    ).toBe("Dire Straits won 2–0 (ruled result)");
  });
});

describe("capNames", () => {
  it("keeps a short list and counts the rest of a long one", () => {
    expect(capNames(["a", "b"], 3)).toEqual(["a", "b"]);
    expect(capNames(["a", "b", "c"], 3)).toEqual(["a", "b", "c"]);
    expect(capNames(["a", "b", "c", "d", "e"], 3)).toEqual(["a", "b", "+3 more"]);
  });
});

describe("hueHex", () => {
  it("matches CSS hsl() on the same wheel", () => {
    expect(hueHex(0, 100, 50)).toBe("#ff0000");
    expect(hueHex(120, 100, 50)).toBe("#00ff00");
    expect(hueHex(240, 100, 50)).toBe("#0000ff");
    expect(hueHex(0, 0, 50)).toBe("#808080");
    // hsl(210 70% 52%), the tale of the tape's bar colour: rgb(47 133 218).
    expect(hueHex(210, 70, 52)).toBe("#2f85da");
  });
});
