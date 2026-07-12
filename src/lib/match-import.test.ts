import { describe, it, expect } from "vitest";
import {
  buildPlayers,
  classifyGame,
  sanitizeBenchmarks,
} from "./match-import";
import type { OpenDotaMatch, OpenDotaPlayer } from "./dota";

function player(account_id: number, isRadiant: boolean): OpenDotaPlayer {
  return {
    account_id,
    player_slot: isRadiant ? 0 : 128,
    hero_id: 1,
    isRadiant,
    kills: 0,
    deaths: 0,
    assists: 0,
  };
}

function makeMatch(
  radiant: number[],
  dire: number[],
  radiant_win: boolean,
): OpenDotaMatch {
  return {
    match_id: 123,
    radiant_win,
    duration: 2000,
    start_time: 1,
    players: [
      ...radiant.map((a) => player(a, true)),
      ...dire.map((a) => player(a, false)),
    ],
  };
}

const teamA = { teamId: "A", accountIds: new Set([1, 2, 3, 4, 5]) };
const teamB = { teamId: "B", accountIds: new Set([6, 7, 8, 9, 10]) };

describe("classifyGame", () => {
  it("identifies sides and winner (A radiant, radiant wins)", () => {
    const c = classifyGame(makeMatch([1, 2, 3, 4, 5], [6, 7, 8, 9, 10], true), teamA, teamB);
    expect(c.ok).toBe(true);
    expect(c.radiantTeamId).toBe("A");
    expect(c.direTeamId).toBe("B");
    expect(c.winnerTeamId).toBe("A");
  });

  it("assigns the win to dire when radiant_win is false", () => {
    const c = classifyGame(makeMatch([1, 2, 3, 4, 5], [6, 7, 8, 9, 10], false), teamA, teamB);
    expect(c.winnerTeamId).toBe("B");
  });

  it("tolerates a couple of unknown accounts per side (standins/smurfs)", () => {
    const c = classifyGame(
      makeMatch([1, 2, 3, 999, 998], [6, 7, 8, 997, 996], true),
      teamA,
      teamB,
    );
    expect(c.ok).toBe(true);
    expect(c.winnerTeamId).toBe("A");
  });

  it("rejects a game missing one of the teams", () => {
    const c = classifyGame(
      makeMatch([1, 2, 3, 4, 5], [900, 901, 902, 903, 904], true),
      teamA,
      teamB,
    );
    expect(c.ok).toBe(false);
  });

  it("rejects when both teams are on the same side", () => {
    const c = classifyGame(
      makeMatch([1, 2, 3, 6, 7], [900, 901, 902, 903, 904], true),
      teamA,
      teamB,
    );
    expect(c.ok).toBe(false);
  });

  it("rejects when too few rostered players are present", () => {
    const c = classifyGame(
      makeMatch([1, 2, 900, 901, 902], [6, 7, 903, 904, 905], true),
      teamA,
      teamB,
    );
    expect(c.ok).toBe(false);
  });
});

describe("sanitizeBenchmarks", () => {
  it("keeps entries with a finite pct, clamped into 0..1", () => {
    const out = sanitizeBenchmarks({
      gold_per_min: { raw: 512, pct: 0.72 },
      xp_per_min: { raw: 600, pct: 1.4 },
      kills_per_min: { raw: 0.1, pct: -0.2 },
    });
    expect(out).toEqual({
      gold_per_min: { raw: 512, pct: 0.72 },
      xp_per_min: { raw: 600, pct: 1 },
      kills_per_min: { raw: 0.1, pct: 0 },
    });
  });

  it("drops entries with missing/null/NaN pct and nullifies bad raws", () => {
    const out = sanitizeBenchmarks({
      gold_per_min: { raw: 512 },
      xp_per_min: { raw: 600, pct: null },
      hero_damage_per_min: { raw: NaN, pct: 0.5 },
      tower_damage: { pct: NaN },
    });
    expect(out).toEqual({ hero_damage_per_min: { raw: null, pct: 0.5 } });
  });

  it("returns null for absent, non-object, or fully unusable benchmarks", () => {
    expect(sanitizeBenchmarks(undefined)).toBeNull();
    expect(sanitizeBenchmarks(null)).toBeNull();
    expect(sanitizeBenchmarks({ gold_per_min: { raw: 1 } })).toBeNull();
  });
});

describe("buildPlayers report-card fields", () => {
  it("passes the extended stats and benchmarks through onto stored lines", () => {
    const match = makeMatch([1], [6], true);
    match.players[0] = {
      ...match.players[0],
      xp_per_min: 610,
      denies: 12,
      level: 25,
      hero_damage: 24000,
      tower_damage: 5100,
      hero_healing: 0,
      benchmarks: { gold_per_min: { raw: 512, pct: 0.72 } },
    };
    const lines = buildPlayers(match, new Map());
    expect(lines[0]).toMatchObject({
      xpm: 610,
      denies: 12,
      level: 25,
      heroDamage: 24000,
      towerDamage: 5100,
      heroHealing: 0,
      benchmarks: { gold_per_min: { raw: 512, pct: 0.72 } },
    });
  });

  it("tolerates absent fields (legacy-shaped payloads) as nulls", () => {
    const lines = buildPlayers(makeMatch([1], [6], true), new Map());
    expect(lines[0]).toMatchObject({
      xpm: null,
      denies: null,
      level: null,
      heroDamage: null,
      towerDamage: null,
      heroHealing: null,
      benchmarks: null,
    });
  });
});
