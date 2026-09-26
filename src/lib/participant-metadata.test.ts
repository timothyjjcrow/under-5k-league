import { describe, expect, it } from "vitest";
import { decodeIndexedGamePlayers, normalizedPlayerStat } from "./player-stats";

const line = { heroId: 1, isRadiant: true, kills: 1, deaths: 2, assists: 3 };

describe("participant metadata", () => {
  it("preserves original offsets and safe optional fractional values", () => {
    const parsed = decodeIndexedGamePlayers(JSON.stringify([null, { ...line, gpm: 425.5, accountId: 4294967295 }]));
    expect(parsed.indexed[0]).toMatchObject({ sourceLineIndex: 1, player: { gpm: 425.5, accountId: 4294967295 } });
    expect(parsed.completeRoster).toBe(false);
  });
  it("leaves legacy metadata properties absent", () => {
    const parsed = normalizedPlayerStat(line)!;
    for (const key of ["providerPlayerSlot", "plannedPosition", "playedPosition", "positionSource", "ratingSnapshot", "ratingSource", "ratingAt"]) expect(parsed).not.toHaveProperty(key);
  });
  it("keeps valid provenance and drops unsafe optional claims", () => {
    expect(normalizedPlayerStat({ ...line, providerPlayerSlot: 128, plannedPosition: 4,
      playedPosition: 1.5, positionSource: "LINEUP_PLANNED", ratingSnapshot: -2,
      ratingSource: "unbounded arbitrary text", ratingAt: "bad" })).toMatchObject({
      providerPlayerSlot: 128, plannedPosition: 4, positionSource: "LINEUP_PLANNED",
    });
    const parsed = normalizedPlayerStat({ ...line, playedPosition: 0, ratingSnapshot: NaN, ratingAt: "bad" })!;
    expect(parsed).not.toHaveProperty("playedPosition");
    expect(parsed).not.toHaveProperty("ratingSnapshot");
    expect(parsed).not.toHaveProperty("ratingAt");
  });
});
