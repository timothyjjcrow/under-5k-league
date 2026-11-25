import { describe, expect, it } from "vitest";
import game from "../../test/fixtures/opendota-inhouse-game.json";
import type { OpenDotaPlayer } from "./dota";
import { inhouseBoxStats, type InhouseBoxPlayer } from "./inhouse-box";
import { compactNumber, gradeView, inhouseStatBits } from "./inhouse-grade-view";
import { baselineLinesOf, gradeGame, letterFor } from "./player-grades";

const players = game.players as unknown as OpenDotaPlayer[];
const box: InhouseBoxPlayer[] = players.map((p, i) => ({
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
}));
// A baseline at the players' MMR, so every part of the grade is present.
const baseline = Array.from({ length: 8 }, () =>
  baselineLinesOf(
    box.map((l) => ({ ...l, mmr: 3000 })),
    game.duration,
  ),
).flat();
const grades = gradeGame(box, {
  radiantWin: game.radiant_win,
  durationSecs: game.duration,
  mmrByUser: new Map(box.map((l) => [l.userId!, 3000])),
  baseline,
});
const graded = box.map((l, i) => ({ ...l, grade: grades[i] }));

describe("gradeView", () => {
  it("is null for a line without a grade", () => {
    expect(gradeView(box[0], box, { durationSecs: game.duration, heroName: null })).toBeNull();
  });

  it("shows the three parts with their weights and the letter each earns", () => {
    const view = gradeView(graded[0], graded, { durationSecs: game.duration, heroName: "Grimstroke" })!;
    expect(view.letter).toBe(grades[0].letter);
    expect(view.parts.map((p) => [p.key, p.weight])).toEqual([
      ["game", "50%"],
      ["hero", "25%"],
      ["mmr", "25%"],
    ]);
    expect(view.parts[1].label).toBe("On Grimstroke");
    expect(view.parts[2].label).toBe("For 3,000 MMR");
    expect(view.parts[2].note).toMatch(/GGD2L inhouse (cores|supports) at 2,600–3,400 MMR/);
    for (const p of view.parts) expect(p.letter).toBe(letterFor(p.score!));
  });

  it("lists fighting and survival first, then the role's areas, marking the two that counted", () => {
    const view = gradeView(graded[0], graded, { durationSecs: game.duration, heroName: null })!;
    expect(view.areas.slice(0, 2).map((a) => a.key)).toEqual(["fighting", "survival"]);
    expect(view.areas.filter((a) => a.counted).map((a) => a.key).sort()).toEqual(
      [...grades[0].counted].sort(),
    );
    const fighting = view.areas[0];
    expect(fighting.value).toMatch(/^\d+% of team kills$/);
    expect(view.areas[1].value).toBe(`${box[0].deaths} deaths`);
  });

  it("explains the hero and MMR comparisons in numbers", () => {
    const view = gradeView(graded[0], graded, { durationSecs: game.duration, heroName: null })!;
    expect(view.hero.length).toBeGreaterThanOrEqual(3);
    for (const h of view.hero) expect(h.beats).toMatch(/^beats \d+%$/);
    expect(view.mmr.length).toBeGreaterThanOrEqual(3);
    for (const m of view.mmr) {
      expect(m.beats).toMatch(/^beats \d+%$/);
      expect(m.typical).not.toBe("");
    }
  });

  it("names the awards", () => {
    const mvp = graded.find((l) => l.grade.awards.includes("mvp"))!;
    const view = gradeView(mvp, graded, { durationSecs: game.duration, heroName: null })!;
    expect(view.awards[0]).toMatchObject({ key: "mvp", label: "MVP" });
  });
});

describe("inhouseStatBits", () => {
  it("shows only the numbers a line has", () => {
    expect(
      inhouseStatBits({
        ...box[0],
        heroDamage: 24100,
        towerDamage: 0,
        damageTaken: 18300,
        heroHealing: 4100,
        obsPlaced: 8,
        senPlaced: 4,
        stuns: 31.4,
      }),
    ).toEqual(["24.1k dmg", "18.3k taken", "4.1k heal", "12 wards", "31s stun"]);
    const legacy: InhouseBoxPlayer = {
      userId: "x",
      name: "X",
      team: 1,
      isRadiant: true,
      heroId: 1,
      kills: 1,
      deaths: 1,
      assists: 1,
      netWorth: 1000,
      gpm: 300,
      lastHits: 50,
    };
    expect(inhouseStatBits(legacy)).toEqual([]);
  });
});

describe("compactNumber", () => {
  it("shortens thousands", () => {
    expect(compactNumber(999)).toBe("999");
    expect(compactNumber(24130)).toBe("24.1k");
  });
});
