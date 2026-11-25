import { describe, expect, it } from "vitest";
import game from "../../test/fixtures/opendota-inhouse-game.json";
import { gameMvp } from "./achievements";
import type { OpenDotaPlayer } from "./dota";
import {
  inhouseBoxStats,
  inhouseGameMvp,
  inhouseRoleAward,
  isGradedBox,
  parseInhouseBox,
  type InhouseBoxPlayer,
} from "./inhouse-box";
import { gradeGame } from "./player-grades";

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

describe("inhouse box stats and grades", () => {
  const players = game.players as unknown as OpenDotaPlayer[];
  const base = (i: number): InhouseBoxPlayer => {
    const p = players[i];
    return {
      userId: `u${i}`,
      name: `P${i}`,
      team: p.isRadiant ? 1 : 2,
      isRadiant: !!p.isRadiant,
      heroId: p.hero_id,
      kills: p.kills,
      deaths: p.deaths,
      assists: p.assists,
      netWorth: p.net_worth ?? null,
      gpm: p.gold_per_min ?? null,
      lastHits: p.last_hits ?? null,
      ...inhouseBoxStats(p),
    };
  };
  const box = players.map((_, i) => base(i));
  const grades = gradeGame(box, {
    radiantWin: game.radiant_win,
    durationSecs: game.duration,
    mmrByUser: new Map(),
    baseline: [],
  });
  const graded = box.map((l, i) => ({ ...l, grade: grades[i] }));

  it("keeps damage, healing and the parsed stats, with damage taken from heroes only", () => {
    const p = players[0];
    const stats = inhouseBoxStats({
      ...p,
      damage_taken: { npc_dota_hero_axe: 1000, npc_dota_hero_lina: 500, npc_dota_creep_goodguys_melee: 9000 },
      multi_kills: { "2": 3, "4": 1, "5": 0 },
      firstblood_claimed: 1,
      observer_kills: 2,
      sentry_kills: 1,
    });
    expect(stats.heroDamage).toBe(p.hero_damage);
    expect(stats.towerDamage).toBe(p.tower_damage);
    expect(stats.heroHealing).toBe(p.hero_healing);
    expect(stats.damageTaken).toBe(1500);
    expect(stats.bestMultiKill).toBe(4);
    expect(stats.firstBlood).toBe(true);
    expect(stats.wardsKilled).toBe(3);
    expect(stats.obsPlaced).toBe(p.obs_placed);
    expect(stats.benchmarks?.gold_per_min?.pct).toBeGreaterThan(0);
  });

  it("leaves parsed stats absent, not zero, on an unparsed payload", () => {
    const stats = inhouseBoxStats({
      account_id: 1,
      player_slot: 0,
      hero_id: 1,
      kills: 1,
      deaths: 1,
      assists: 1,
      hero_damage: 5000,
    });
    expect(stats.heroDamage).toBe(5000);
    for (const key of ["damageTaken", "stuns", "obsPlaced", "campsStacked", "firstBlood", "bestMultiKill"]) {
      expect(stats).not.toHaveProperty(key);
    }
  });

  it("round-trips a graded line, and a bad extra costs only itself", () => {
    expect(parseInhouseBox(JSON.stringify(graded))).toEqual(graded);
    const [read] = parseInhouseBox(
      JSON.stringify([{ ...graded[0], stuns: "many", grade: { v: 1, score: "S" } }]),
    );
    expect(read.userId).toBe("u0");
    expect(read).not.toHaveProperty("stuns");
    expect(read).not.toHaveProperty("grade");
    expect(read.heroDamage).toBe(graded[0].heroDamage);
  });

  it("takes the MVP from the grades once every linked line has one", () => {
    const mvp = graded.find((l) => l.grade.awards.includes("mvp"))!;
    expect(isGradedBox(graded)).toBe(true);
    expect(inhouseGameMvp(graded, game.radiant_win)).toBe(mvp.userId);
    const role = inhouseRoleAward(graded)!;
    expect(role.line.grade!.awards).toContain(role.award);
  });

  it("keeps a game from before grades on its impact-points MVP", () => {
    expect(isGradedBox(box)).toBe(false);
    expect(inhouseGameMvp(box, game.radiant_win)).toBe(
      gameMvp(box, game.radiant_win),
    );
    expect(inhouseRoleAward(box)).toBeNull();
    // One linked line without a grade is not a graded game either.
    const mixed = graded.map((l, i) => (i === 3 ? box[3] : l));
    expect(isGradedBox(mixed)).toBe(false);
  });
});
