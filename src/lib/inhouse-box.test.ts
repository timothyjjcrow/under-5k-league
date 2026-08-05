import { describe, expect, it } from "vitest";
import { parseInhouseBox, type InhouseBoxPlayer } from "./inhouse-box";

describe("parseInhouseBox", () => {
  it("round-trips a valid box-score array", () => {
    const line: InhouseBoxPlayer = {
      userId: "u1",
      name: "Techies Anonymous",
      team: 1,
      isRadiant: true,
      heroId: 14,
      kills: 7,
      deaths: 2,
      assists: 11,
      netWorth: 18250,
      gpm: 512,
      lastHits: 210,
    };
    const unknown: InhouseBoxPlayer = {
      // buildResult writes nulls for players it couldn't attribute — they must
      // survive the round-trip rather than be filtered.
      userId: null,
      name: null,
      team: null,
      isRadiant: false,
      heroId: 1,
      kills: 0,
      deaths: 5,
      assists: 3,
      netWorth: null,
      gpm: null,
      lastHits: null,
    };
    expect(parseInhouseBox(JSON.stringify([line, unknown]))).toEqual([
      line,
      unknown,
    ]);
  });

  it("an empty array stays an empty array", () => {
    expect(parseInhouseBox("[]")).toEqual([]);
  });

  it("malformed JSON parses to []", () => {
    expect(parseInhouseBox("")).toEqual([]);
    expect(parseInhouseBox("{not json")).toEqual([]);
    expect(parseInhouseBox('[{"truncated":')).toEqual([]);
  });

  it("valid JSON that is not an array parses to []", () => {
    expect(parseInhouseBox("{}")).toEqual([]);
    expect(parseInhouseBox('{"players": []}')).toEqual([]);
    expect(parseInhouseBox('"a string"')).toEqual([]);
    expect(parseInhouseBox("42")).toEqual([]);
    expect(parseInhouseBox("null")).toEqual([]);
    expect(parseInhouseBox("true")).toEqual([]);
  });

  it("drops malformed lines without hiding valid players or crashing readers", () => {
    const valid: InhouseBoxPlayer = {
      userId: "u1",
      name: "Axe Enjoyer",
      team: 2,
      isRadiant: false,
      heroId: 2,
      kills: 4,
      deaths: 6,
      assists: 9,
      netWorth: 14000,
      gpm: 420,
      lastHits: 160,
    };
    expect(
      parseInhouseBox(
        JSON.stringify([
          null,
          valid,
          { ...valid, kills: "four" },
          { ...valid, team: 3 },
          { ...valid, heroId: Number.NaN },
          [],
        ]),
      ),
    ).toEqual([valid]);
  });
});
