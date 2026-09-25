import { describe, expect, it } from "vitest";
import { decodeIndexedGamePlayers, normalizedPlayerStat } from "./player-stats";
import { applyImportLineups, type ImportLineup } from "./import-lineups";

const line = { heroId: 1, isRadiant: true, kills: 1, deaths: 2, assists: 3 };
const match = { id: "match", homeTeamId: "home", awayTeamId: "away" };
function lineup(overrides: Partial<ImportLineup> = {}): ImportLineup {
  return { matchId: "match", teamId: "home", revision: 1,
    confirmedAt: new Date(1_000), supersededAt: new Date(9_000),
    seats: [{ userId: "former", userNameSnapshot: "Former", accountId: 4294967295,
      position: 4, mmr: 2400, mmrSource: "REGISTRATION", ratingAt: new Date(1_000) }],
    ...overrides };
}
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

describe("historical confirmed import lineups", () => {
  const current = () => ({ homeSet: new Set([1]), awaySet: new Set([2]),
    accountMap: new Map([[1, { userId: "new", name: "New", teamId: "home" }]]) });
  it("uses the pre-game snapshot even after supersession, with planned role only", () => {
    const result = applyImportLineups(current(), match, [lineup()], 5);
    expect([...result.homeSet]).toEqual([4294967295]);
    expect(result.accountMap.get(4294967295)).toEqual({ userId: "former", name: "Former", teamId: "home",
      plannedPosition: 4, positionSource: "LINEUP_PLANNED", ratingSnapshot: 2400,
      ratingSource: "REGISTRATION", ratingAt: new Date(1_000).toISOString() });
    expect(result.accountMap.get(4294967295)).not.toHaveProperty("playedPosition");
    expect(current().homeSet).toEqual(new Set([1]));
  });
  it("honors interval edges and never uses a later confirmation", () => {
    expect(applyImportLineups(current(), match, [lineup()], 9).homeSet).toEqual(new Set([1]));
    expect(applyImportLineups(current(), match, [lineup()], 0).homeSet).toEqual(new Set([1]));
    expect(applyImportLineups(current(), match, [lineup()], 1).homeSet).toEqual(new Set([4294967295]));
  });
  it("never attaches a rating observed after game start", () => {
    const saved = lineup(); saved.seats[0].ratingAt = new Date(8_000);
    const identity = applyImportLineups(current(), match, [saved], 5).accountMap.get(4294967295)!;
    expect(identity).not.toHaveProperty("ratingSnapshot");
    expect(identity).toHaveProperty("plannedPosition", 4);
  });
});
