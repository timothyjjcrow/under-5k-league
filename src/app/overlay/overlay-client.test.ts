import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OVERLAY_REVISION } from "@/lib/stream-overlay-page";
import type { OverlayPlayer, StreamOverlayPayload } from "@/lib/stream-overlay";
import {
  CARD_SECONDS,
  REFRESH_BUCKET_MS,
  SYNC_POLL_MS,
  cardQueue,
  countdownText,
  matchStatus,
  overlayOptions,
  overlayRevision,
  playerTags,
  resumeIndex,
  safeImageUrl,
} from "./overlay-client.js";

const SOURCE = readFileSync(new URL("./overlay-client.js", import.meta.url), "utf8");
/** The code without its comments, for the source rules below. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

type Match = StreamOverlayPayload["match"];
const match = (over: Partial<Match> = {}): Match => ({
  id: "m1",
  round: "Week 4",
  bestOf: 3,
  status: "SCHEDULED",
  homeScore: 0,
  awayScore: 0,
  winner: null,
  forfeit: false,
  kickoffMs: null,
  kickoffText: null,
  ...over,
});

const player = (over: Partial<OverlayPlayer>): OverlayPlayer => ({
  id: "p",
  name: "Player",
  avatar: null,
  side: "home",
  captain: false,
  standin: false,
  standinFor: null,
  roles: [],
  medal: null,
  season: null,
  heroes: [],
  heroesFrom: null,
  ...over,
});

describe("overlayOptions", () => {
  it("defaults to both layouts, both sides and the usual card time", () => {
    expect(overlayOptions("")).toEqual({
      widget: "both",
      side: "both",
      seconds: CARD_SECONDS.fallback,
      preview: false,
      notes: true,
    });
  });

  it("reads each option, ignoring case and spaces", () => {
    expect(
      overlayOptions("?widget=Players&side=away&seconds=12&preview=1&notes=0"),
    ).toEqual({ widget: "players", side: "away", seconds: 12, preview: true, notes: false });
  });

  it("treats a repeated or unknown value as unset", () => {
    expect(overlayOptions("?widget=matchup&widget=players").widget).toBe("both");
    expect(overlayOptions("?side=left").side).toBe("both");
    expect(overlayOptions("?seconds=abc").seconds).toBe(CARD_SECONDS.fallback);
  });

  it("keeps the card time within its bounds", () => {
    expect(overlayOptions("?seconds=1").seconds).toBe(CARD_SECONDS.min);
    expect(overlayOptions("?seconds=999").seconds).toBe(CARD_SECONDS.max);
    expect(overlayOptions("?seconds=7.6").seconds).toBe(8);
  });
});

describe("overlayRevision", () => {
  const cursor = "2026-10-11T03:00:00.000Z";
  const now = Date.parse("2026-10-11T03:04:00.000Z");

  it("is always a version the data route accepts", () => {
    for (const value of [
      overlayRevision(cursor, now, false),
      overlayRevision(cursor, now, true),
      overlayRevision(null, now, false),
      overlayRevision("garbage", now, false),
    ]) {
      expect(OVERLAY_REVISION.test(value), value).toBe(true);
    }
  });

  it("moves with the result cursor", () => {
    expect(overlayRevision(cursor, now, false)).not.toBe(
      overlayRevision("2026-10-11T03:01:00.000Z", now, false),
    );
  });

  it("moves every refresh bucket until the series is decided, then only with a result", () => {
    const later = now + REFRESH_BUCKET_MS;
    expect(overlayRevision(cursor, now, false)).not.toBe(overlayRevision(cursor, later, false));
    expect(overlayRevision(cursor, now, true)).toBe(overlayRevision(cursor, later, true));
    expect(overlayRevision(cursor, now, true).endsWith(".f")).toBe(true);
  });

  it("is the same for everyone in one bucket, so the CDN answers all but the first", () => {
    const bucketStart = Math.floor(now / REFRESH_BUCKET_MS) * REFRESH_BUCKET_MS;
    expect(overlayRevision(cursor, bucketStart, false)).toBe(
      overlayRevision(cursor, bucketStart + REFRESH_BUCKET_MS - 1, false),
    );
  });
});

describe("countdownText", () => {
  it("counts minutes and seconds, then hours", () => {
    expect(countdownText(0)).toBe("0:00");
    expect(countdownText(-5_000)).toBe("0:00");
    expect(countdownText(65_000)).toBe("1:05");
    expect(countdownText(59 * 60_000 + 59_500)).toBe("1:00:00");
    expect(countdownText(3_723_000)).toBe("1:02:03");
  });
});

describe("matchStatus", () => {
  const kickoff = Date.parse("2026-10-11T01:00:00Z");

  it("names the kickoff while it is more than an hour away", () => {
    expect(
      matchStatus(match({ kickoffMs: kickoff, kickoffText: "Sat 6:00 PM Pacific" }), kickoff - 2 * 3_600_000),
    ).toEqual({ text: "Sat 6:00 PM Pacific", live: false, started: false });
    expect(matchStatus(match(), kickoff).text).toBe("Best of 3");
  });

  it("counts down over the last hour", () => {
    expect(matchStatus(match({ kickoffMs: kickoff }), kickoff - 754_000)).toEqual({
      text: "Starts in 12:34",
      live: false,
      started: false,
    });
  });

  it("is live from kickoff, on the next game to play", () => {
    expect(matchStatus(match({ kickoffMs: kickoff }), kickoff + 1)).toEqual({
      text: "Game 1 · Bo3",
      live: true,
      started: true,
    });
    expect(
      matchStatus(match({ status: "LIVE", homeScore: 1, awayScore: 1, kickoffMs: kickoff }), kickoff),
    ).toEqual({ text: "Game 3 · Bo3", live: true, started: true });
    // An early start: a game is in before the listed kickoff.
    expect(
      matchStatus(match({ status: "LIVE", homeScore: 1, kickoffMs: kickoff }), kickoff - 600_000).live,
    ).toBe(true);
  });

  it("never names a game past the series length", () => {
    expect(
      matchStatus(match({ status: "LIVE", bestOf: 2, homeScore: 1, awayScore: 1 }), 0).text,
    ).toBe("Game 2 · Bo2");
  });

  it("stops saying live once a fixture is long overdue with nothing recorded", () => {
    expect(matchStatus(match({ kickoffMs: kickoff }), kickoff + 12 * 3_600_000)).toEqual({
      text: "Awaiting result",
      live: false,
      started: true,
    });
  });

  it("says final, and forfeit when it was ruled", () => {
    expect(matchStatus(match({ status: "COMPLETED", homeScore: 2 }), 0).text).toBe("Final");
    expect(matchStatus(match({ status: "COMPLETED", forfeit: true }), 0).text).toBe(
      "Final · forfeit",
    );
  });
});

describe("player cards", () => {
  const players = [
    player({ id: "a", side: "home" }),
    player({ id: "b", side: "away" }),
    player({ id: "c", side: "home" }),
  ];

  it("rotates one side's players, or both", () => {
    expect(cardQueue(players, "both").map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(cardQueue(players, "home").map((p) => p.id)).toEqual(["a", "c"]);
    expect(cardQueue(players, "away").map((p) => p.id)).toEqual(["b"]);
  });

  it("resumes on the same player after new data, else the same place", () => {
    expect(resumeIndex(players, "c", 0)).toBe(2);
    expect(resumeIndex(players, "gone", 1)).toBe(1);
    expect(resumeIndex(players, "gone", 9)).toBe(2);
    expect(resumeIndex([], "a", 3)).toBe(0);
  });

  it("tags a captain, a standin and their positions", () => {
    expect(playerTags(player({ captain: true, roles: ["Carry", "Mid"] }))).toEqual([
      "Captain",
      "Carry · Mid",
    ]);
    expect(playerTags(player({ standin: true, standinFor: "Kestrel" }))).toEqual([
      "Standin for Kestrel",
    ]);
    expect(playerTags(player({ standin: true }))).toEqual(["Standin"]);
  });

  it("loads only https images and the site's own medal and brand files", () => {
    expect(safeImageUrl("https://avatars.steamstatic.com/a.jpg")).toBe(true);
    expect(safeImageUrl("/ranks/rank_icon_5.png")).toBe(true);
    expect(safeImageUrl("/brand/ggd2l-nav.png")).toBe(true);
    expect(safeImageUrl("http://example.com/a.png")).toBe(false);
    expect(safeImageUrl("javascript:alert(1)")).toBe(false);
    expect(safeImageUrl("/api/admin/season-export")).toBe(false);
    expect(safeImageUrl(null)).toBe(false);
  });
});

describe("the overlay's code", () => {
  it("never writes markup from data: names are typed by players", () => {
    for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"]) {
      expect(CODE, sink).not.toContain(sink);
    }
  });

  it("only ever reads the result status and its own data, never writes", () => {
    // Every call's address, as written: the helper's own definition aside.
    const fetched = [...CODE.matchAll(/getJson\(\s*(["`][^"`]*["`])/g)].map((m) => m[1]);
    expect(fetched).toEqual([
      '"/api/sync"',
      "`/api/overlay/${encodeURIComponent(config.matchId)}/${revision}`",
    ]);
    expect(CODE.match(/getJson\(/g)).toHaveLength(2);
    expect(CODE).not.toMatch(/method\s*:/);
    expect(CODE.match(/\bfetch\(/g)).toHaveLength(1);
  });

  it("gives its one request a timeout, so a dead connection can't stall the polls", () => {
    expect(CODE).toMatch(/fetch\(url, \{ signal: controller\.signal/);
    expect(CODE).toMatch(/setTimeout\(\(\) => controller\.abort\(\), FETCH_TIMEOUT_MS\)/);
  });

  it("polls no faster than the result status refreshes", () => {
    // /api/sync's CDN copy lasts 30 seconds (src/app/api/sync/route.ts).
    expect(SYNC_POLL_MS).toBeGreaterThanOrEqual(30_000);
    expect(REFRESH_BUCKET_MS).toBeGreaterThanOrEqual(10 * 60_000);
  });
});
