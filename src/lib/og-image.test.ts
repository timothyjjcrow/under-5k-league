import { describe, expect, it } from "vitest";
import {
  capNames,
  fitPictureFacts,
  hueHex,
  matchCardStatus,
  ogImageUrlAllowed,
  playerPictureText,
  sniffImageType,
} from "./og-image";
import type { PlayerCardFacts } from "./player-card";

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

function card(overrides: Partial<PlayerCardFacts> = {}): PlayerCardFacts {
  return {
    season: { id: "s9", name: "Season 9", current: false },
    role: { kind: "drafted", price: 47 },
    team: { id: "t1", name: "Radiant Raccoons", logoUrl: null },
    stoodInFor: null,
    rankTier: 64,
    mmr: 4700,
    heroes: [
      { heroId: 2, name: "Axe", pubs: false },
      { heroId: 74, name: "Invoker", pubs: true },
    ],
    grade: { overall: "A", strength: "Farming" },
    titles: [{ seasonId: "s9", seasonName: "Season 9" }],
    mvps: 3,
    records: 1,
    ...overrides,
  };
}

describe("playerPictureText", () => {
  it("says the season and how they took part, always (no name row here)", () => {
    expect(playerPictureText(card()).seasonLine).toBe(
      "Season 9 · Drafted for $47",
    );
    expect(
      playerPictureText(card({ role: { kind: "captain" } })).seasonLine,
    ).toBe("Season 9 · Captain");
    expect(
      playerPictureText(
        card({ role: { kind: "standin" }, team: null, stoodInFor: "Dire Straits" }),
      ).seasonLine,
    ).toBe("Season 9 · Stood in for Dire Straits");
    expect(playerPictureText(card({ role: null })).seasonLine).toBe("Season 9");
    expect(playerPictureText(card({ season: null })).seasonLine).toBeNull();
  });

  it("shows the newest title and counts the rest", () => {
    const titles = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        seasonId: `s${9 - i}`,
        seasonName: `Season ${9 - i}`,
      }));
    expect(playerPictureText(card({ titles: [] })).titles).toEqual([]);
    expect(playerPictureText(card({ titles: titles(2) })).titles).toEqual([
      "Season 9 champion",
      "+1 more title",
    ]);
    expect(playerPictureText(card({ titles: titles(3) })).titles).toEqual([
      "Season 9 champion",
      "+2 more titles",
    ]);
  });

  it("lists the grade, the heroes (pubs marked) and the honors, never the MMR", () => {
    const text = playerPictureText(card());
    expect(text.facts).toEqual([
      "Career grade A",
      "Axe",
      "Invoker · pubs",
      "3 Match MVPs",
      "1 league record",
    ]);
    expect(JSON.stringify(text)).not.toContain("4700");
    expect(
      playerPictureText(card({ grade: null, heroes: [], mvps: 0, records: 0 }))
        .facts,
    ).toEqual([]);
  });
});

describe("fitPictureFacts", () => {
  const crowded = {
    titles: ["Season 12 (Winter Invitational) champion", "+2 more titles"],
    medal: "Immortal",
    facts: [
      "Career grade S",
      "Keeper of the Light",
      "Outworld Destroyer",
      "Nature's Prophet · pubs",
      "12 Match MVPs",
      "3 league records",
    ],
  };

  it("keeps a typical card whole", () => {
    const facts = playerPictureText(card()).facts;
    expect(
      fitPictureFacts({
        name: "Raccoon King",
        hasTeam: true,
        titles: ["Season 9 champion"],
        medal: "Ancient 4",
        facts,
      }),
    ).toEqual(facts);
  });

  it("drops from the end (honors first) when a long name leaves less room", () => {
    const long = "An Extremely Long Steam Persona Name";
    expect(fitPictureFacts({ name: long, hasTeam: true, ...crowded })).toEqual([
      "Career grade S",
      "Keeper of the Light",
      "Outworld Destroyer",
      "Nature's Prophet · pubs",
    ]);
    // Without a crest row there is room for every chip again.
    expect(fitPictureFacts({ name: long, hasTeam: false, ...crowded })).toEqual(
      crowded.facts,
    );
    // A short name has room too.
    expect(fitPictureFacts({ name: "Zed", hasTeam: true, ...crowded })).toEqual(
      crowded.facts,
    );
  });

  it("never drops a title or the medal, only facts", () => {
    const titles = Array.from({ length: 12 }, (_, i) => `Season ${i} champion`);
    expect(
      fitPictureFacts({ ...crowded, name: "Zed", hasTeam: true, titles }),
    ).toEqual([]);
  });
});
