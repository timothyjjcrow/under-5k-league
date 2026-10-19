import { describe, expect, it } from "vitest";
import {
  LEAGUE_FEED_WAIT_MAX_IDS,
  leagueFeedRetryAtMs,
  leagueFeedWaitText,
  parseLeagueFeedWait,
  serializeLeagueFeedWait,
  stillWaitingRows,
} from "./league-feed-wait";

const NOW = Date.parse("2026-10-18T19:30:00.000Z");
const STAMP = new Date(NOW - 30_000).toISOString();

const row = (dotaMatchId: string, status: string, inMs: number | null = null) => ({
  dotaMatchId,
  status,
  nextAttemptAt: inMs === null ? null : new Date(NOW + inMs),
});

describe("the league feed wait record", () => {
  it("round-trips, de-duplicates and flags a list too long to keep", () => {
    expect(
      parseLeagueFeedWait(serializeLeagueFeedWait("s1", NOW - 30_000, ["701", "702", "701"])),
    ).toEqual({ seasonId: "s1", at: STAMP, ids: ["701", "702"], more: false });

    const many = Array.from({ length: LEAGUE_FEED_WAIT_MAX_IDS + 3 }, (_, i) => String(800 + i));
    const parsed = parseLeagueFeedWait(serializeLeagueFeedWait("s1", NOW, many));
    expect(parsed?.ids).toHaveLength(LEAGUE_FEED_WAIT_MAX_IDS);
    expect(parsed?.more).toBe(true);
  });

  it("reads a missing or malformed record as nothing waiting", () => {
    for (const raw of [
      null,
      undefined,
      "",
      "not json",
      "[]",
      JSON.stringify({ seasonId: "s1", at: "yesterday", ids: [], more: false }),
      JSON.stringify({ seasonId: "s1", at: STAMP, ids: ["701; drop"], more: false }),
      JSON.stringify({ seasonId: "s1", at: STAMP, ids: ["701"] }),
    ]) {
      expect(parseLeagueFeedWait(raw)).toBeNull();
    }
  });
});

describe("stillWaitingRows", () => {
  const wait = { seasonId: "s1", at: STAMP, ids: ["701", "702", "703", "704"], more: false };

  it("keeps recorded games still in review or waiting to retry, in recorded order", () => {
    const rows = [
      row("704", "RETRYABLE", 60_000),
      row("702", "READY"), // retried by an admin and fetched since
      row("701", "NEEDS_REVIEW"),
      row("999", "NEEDS_REVIEW"), // not one the feed waited on
    ];
    // 703's row is gone: imported since, so the feed no longer waits on it.
    expect(stillWaitingRows(wait, "s1", rows).map((r) => r.dotaMatchId)).toEqual(["701", "704"]);
  });

  it("names nothing for another season's record", () => {
    expect(stillWaitingRows(wait, "s2", [row("701", "NEEDS_REVIEW")])).toEqual([]);
    expect(stillWaitingRows(null, "s1", [row("701", "NEEDS_REVIEW")])).toEqual([]);
  });
});

describe("leagueFeedRetryAtMs", () => {
  const input = (
    rows: ReturnType<typeof row>[],
    wait: Partial<{ seasonId: string; at: string; ids: string[]; more: boolean }> = {},
    throttleValue: string | undefined = STAMP,
  ) => ({
    wait: { seasonId: "s1", at: STAMP, ids: rows.map((r) => r.dotaMatchId), more: false, ...wait },
    seasonId: "s1",
    throttleValue,
    rows,
    nowMs: NOW,
  });

  it("is the earliest retry while every recorded game is in retry backoff", () => {
    expect(
      leagueFeedRetryAtMs(input([row("701", "RETRYABLE", 16 * 60_000), row("702", "RETRYABLE", 4 * 60_000)])),
    ).toBe(NOW + 4 * 60_000);
  });

  it("is null once any recorded game is in review, due, cleared or missing", () => {
    const backoff = row("701", "RETRYABLE", 16 * 60_000);
    for (const other of [
      row("702", "NEEDS_REVIEW"),
      row("702", "RETRYABLE", 0),
      row("702", "RETRYABLE"),
      row("702", "PENDING"),
      row("702", "READY"),
      // Set aside by the last classification: recordImportDecision gives an
      // IGNORED row a future nextAttemptAt, but it never holds the feed.
      row("702", "IGNORED", 60 * 60_000),
    ]) {
      expect(leagueFeedRetryAtMs(input([backoff, other]))).toBeNull();
    }
    expect(leagueFeedRetryAtMs(input([backoff], { ids: ["701", "702"] }))).toBeNull();
  });

  it("trusts only the pass that still holds the feed claim, in this season", () => {
    const rows = [row("701", "RETRYABLE", 16 * 60_000)];
    // The claim was rolled back (or never stamped): retry at once.
    expect(leagueFeedRetryAtMs({ ...input(rows), throttleValue: undefined })).toBeNull();
    expect(leagueFeedRetryAtMs(input(rows, {}, new Date(NOW).toISOString()))).toBeNull();
    expect(leagueFeedRetryAtMs(input(rows, { seasonId: "s0" }))).toBeNull();
    expect(leagueFeedRetryAtMs(input(rows, { more: true }))).toBeNull();
    expect(leagueFeedRetryAtMs({ ...input(rows), wait: null })).toBeNull();
  });
});

describe("leagueFeedWaitText", () => {
  it("names each waiting game and the controls that clear it", () => {
    expect(leagueFeedWaitText([row("701", "NEEDS_REVIEW")])).toBe(
      "Automatic league-feed imports are waiting on game 701 (review needed): until it clears, " +
        "no fixture imports a game from the league feed. Under Saved import progress, press " +
        "Retry next sync to fetch it again, or open Ignore this game and give a reason.",
    );
    const two = leagueFeedWaitText([row("701", "NEEDS_REVIEW"), row("702", "RETRYABLE", 60_000)]);
    expect(two).toContain("game 701 (review needed) and game 702 (waiting to retry): until they clear");
    expect(two).toContain("A game waiting to retry tries again on its own.");
    expect(leagueFeedWaitText([])).toBe("");
  });
});
