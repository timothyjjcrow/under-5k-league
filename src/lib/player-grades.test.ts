import { describe, expect, it } from "vitest";
import game from "../../test/fixtures/opendota-inhouse-game.json";
import type { OpenDotaPlayer } from "./dota";
import { inhouseBoxStats } from "./inhouse-box";
import {
  GRADE,
  GRADE_AWARDS,
  GRADE_LETTERS,
  ROLE_AREAS,
  assignRoles,
  baselineLinesOf,
  gradeGame,
  gradeRule,
  gradeRuleShort,
  letterFor,
  normalizePlayerGrade,
  type BaselineLine,
  type GradeStats,
} from "./player-grades";

// One real inhouse game (OpenDota, parsed replay), names and accounts removed:
// 63 minutes, Radiant win 52–43.
const fixtureLines = (): GradeStats[] =>
  (game.players as unknown as OpenDotaPlayer[]).map((p, i) => ({
    userId: `u${i}`,
    isRadiant: p.isRadiant ?? p.player_slot < 128,
    heroId: p.hero_id,
    kills: p.kills,
    deaths: p.deaths,
    assists: p.assists,
    netWorth: p.net_worth ?? null,
    gpm: p.gold_per_min ?? null,
    lastHits: p.last_hits ?? null,
    ...inhouseBoxStats(p),
  }));

const ctx = (over: Partial<Parameters<typeof gradeGame>[1]> = {}) => ({
  radiantWin: game.radiant_win,
  durationSecs: game.duration,
  mmrByUser: new Map<string, number>(),
  baseline: [] as BaselineLine[],
  ...over,
});

/** A plain line: the fields every payload has, nothing parsed. */
const line = (over: Partial<GradeStats> & { userId: string | null; isRadiant: boolean }): GradeStats => ({
  heroId: 1,
  kills: 5,
  deaths: 5,
  assists: 5,
  netWorth: 15000,
  gpm: 450,
  lastHits: 150,
  heroDamage: 15000,
  towerDamage: 1000,
  heroHealing: 0,
  ...over,
});

const PARSED_KEYS = [
  "damageTaken",
  "stuns",
  "obsPlaced",
  "senPlaced",
  "wardsKilled",
  "campsStacked",
  "laneEfficiency",
] as const;

describe("letterFor", () => {
  it("walks the thresholds best first, with S at the top and D at the floor", () => {
    expect(GRADE_LETTERS.map(([min]) => min)).toEqual(
      [...GRADE_LETTERS.map(([min]) => min)].sort((a, b) => b - a),
    );
    expect(letterFor(100)).toBe("S");
    expect(letterFor(88)).toBe("S");
    expect(letterFor(87)).toBe("A+");
    expect(letterFor(72)).toBe("A-");
    expect(letterFor(61)).toBe("B-");
    expect(letterFor(42)).toBe("C-");
    expect(letterFor(41)).toBe("D");
    expect(letterFor(0)).toBe("D");
  });
});

describe("assignRoles", () => {
  it("makes each side's two lowest net worths the supports", () => {
    const lines = fixtureLines();
    const roles = assignRoles(lines);
    for (const side of [true, false]) {
      const mine = lines
        .map((l, i) => ({ nw: l.netWorth ?? 0, role: roles[i], side: l.isRadiant }))
        .filter((x) => x.side === side)
        .sort((a, b) => a.nw - b.nw);
      expect(mine.map((x) => x.role)).toEqual([
        "support",
        "support",
        "core",
        "core",
        "core",
      ]);
    }
  });

  it("keeps three cores first on a short-handed side", () => {
    const four = [1, 2, 3, 4].map((n) =>
      line({ userId: `r${n}`, isRadiant: true, netWorth: n * 1000 }),
    );
    expect(assignRoles(four)).toEqual(["support", "core", "core", "core"]);
    expect(assignRoles(four.slice(1))).toEqual(["core", "core", "core"]);
  });
});

describe("gradeGame on a real game", () => {
  const lines = fixtureLines();
  const grades = gradeGame(lines, ctx());

  it("grades every line out of 100 with the letter its score earns", () => {
    expect(grades).toHaveLength(10);
    for (const g of grades) {
      expect(g.score).toBeGreaterThanOrEqual(0);
      expect(g.score).toBeLessThanOrEqual(100);
      expect(g.letter).toBe(letterFor(g.score));
      expect(g.partial).toBe(false);
      // Hero benchmarks are on the payload; no MMR baseline was given.
      expect(g.hero).not.toBeNull();
      expect(g.mmr).toBeNull();
    }
  });

  it("counts the two best role areas, and only the role's own areas", () => {
    grades.forEach((g) => {
      expect(g.counted).toHaveLength(2);
      for (const area of g.counted) expect(ROLE_AREAS[g.role]).toContain(area);
      const roleScores = ROLE_AREAS[g.role]
        .map((a) => g.areas[a])
        .filter((s): s is number => s != null)
        .sort((a, b) => b - a);
      expect(g.counted.map((a) => g.areas[a])).toEqual(roleScores.slice(0, 2));
    });
  });

  it("gives the best role area in each role group full marks", () => {
    for (const role of ["core", "support"] as const) {
      const group = grades.filter((g) => g.role === role);
      for (const area of ROLE_AREAS[role]) {
        const scores = group.map((g) => g.areas[area]).filter((s) => s != null);
        if (scores.length) expect(Math.max(...(scores as number[]))).toBe(100);
      }
    }
  });

  it("names one MVP, the best grade with the win bonus, and the other role's best", () => {
    const mvps = grades.flatMap((g, i) => (g.awards.includes("mvp") ? [i] : []));
    expect(mvps).toHaveLength(1);
    const bonus = (i: number) =>
      grades[i].score + (lines[i].isRadiant === game.radiant_win ? GRADE.MVP_WIN_BONUS : 0);
    const best = Math.max(...grades.map((_, i) => bonus(i)));
    expect(bonus(mvps[0])).toBe(best);

    const award = grades[mvps[0]].role === "core" ? "topSupport" : "topCore";
    const holders = grades.flatMap((g, i) => (g.awards.includes(award) ? [i] : []));
    expect(holders).toHaveLength(1);
    const otherRole = grades[mvps[0]].role === "core" ? "support" : "core";
    expect(grades[holders[0]].role).toBe(otherRole);
    // Nobody gets both role awards.
    expect(grades.some((g) => g.awards.includes("topCore") && g.awards.includes("topSupport"))).toBe(false);
  });

  it("hands out the game's highlights to who earned them", () => {
    const holder = (key: string) =>
      grades.flatMap((g, i) => (g.awards.includes(key as never) ? [i] : []));
    const maxBy = (f: (l: GradeStats) => number) => {
      const best = Math.max(...lines.map(f));
      return lines.flatMap((l, i) => (f(l) === best ? [i] : []));
    };
    expect(holder("mostDamage")).toEqual(maxBy((l) => l.heroDamage ?? 0));
    expect(holder("farmer")).toEqual(maxBy((l) => l.gpm ?? 0));
    expect(holder("firstBlood")).toEqual(
      lines.flatMap((l, i) => (l.firstBlood ? [i] : [])),
    );
    for (const g of grades) {
      for (const a of g.awards) expect(Object.keys(GRADE_AWARDS)).toContain(a);
    }
  });

  it("never moves: the same game grades the same way twice", () => {
    expect(gradeGame(fixtureLines(), ctx())).toEqual(grades);
  });
});

describe("gradeGame before the replay is parsed", () => {
  it("marks the grade partial and leaves the parsed-only areas out", () => {
    const lines = fixtureLines().map((l) => {
      const copy = { ...l } as Record<string, unknown>;
      for (const key of PARSED_KEYS) delete copy[key];
      return copy as GradeStats;
    });
    const grades = gradeGame(lines, ctx());
    for (const g of grades) {
      expect(g.partial).toBe(true);
      for (const area of ["frontline", "control", "laning", "vision", "stacking"] as const) {
        expect(g.areas[area]).toBeUndefined();
      }
    }
    expect(grades.filter((g) => g.awards.includes("mvp"))).toHaveLength(1);
  });
});

describe("the MVP", () => {
  const radiant = [1, 2, 3, 4, 5].map((n) =>
    line({ userId: `r${n}`, isRadiant: true, netWorth: 30000 - n * 3000 }),
  );
  const dire = [1, 2, 3, 4, 5].map((n) =>
    line({ userId: `d${n}`, isRadiant: false, netWorth: 30000 - n * 3000 }),
  );

  it("is never an unlinked player, however well they played", () => {
    const star = { ...radiant[0], userId: null, kills: 30, deaths: 0, heroDamage: 90000 };
    const grades = gradeGame([star, ...radiant.slice(1), ...dire], ctx({ radiantWin: true }));
    expect(grades[0].awards).not.toContain("mvp");
    expect(grades[0].awards).toContain("mostDamage");
    expect(grades.filter((g) => g.awards.includes("mvp"))).toHaveLength(1);
  });

  it("goes to the winner when two grades are within the win bonus", () => {
    const loser = { ...dire[0], kills: 12, assists: 6 };
    const winner = { ...radiant[0], kills: 11, assists: 6 };
    const lines = [winner, ...radiant.slice(1), loser, ...dire.slice(1)];
    const grades = gradeGame(lines, ctx({ radiantWin: true }));
    expect(Math.abs(grades[0].score - grades[5].score)).toBeLessThan(GRADE.MVP_WIN_BONUS);
    expect(grades[0].awards).toContain("mvp");
  });

  it("can be a support", () => {
    // The Radiant supports carry the fights: every kill, most of the
    // assists, and all the wards, stacks and healing.
    const parsed = (l: GradeStats, support: boolean): GradeStats => ({
      ...l,
      damageTaken: 10000,
      stuns: support ? 60 : 5,
      obsPlaced: support ? 15 : 0,
      senPlaced: support ? 10 : 0,
      campsStacked: support ? 6 : 0,
      heroHealing: support ? 8000 : 0,
      laneEfficiency: support ? 30 : 70,
    });
    const r = radiant.map((l, i) =>
      parsed(
        i >= 3
          ? { ...l, kills: 10, assists: 25, deaths: 1 }
          : { ...l, kills: 2, assists: 4, deaths: 6 },
        i >= 3,
      ),
    );
    const d = dire.map((l) => parsed({ ...l, kills: 3, deaths: 5 }, false));
    const grades = gradeGame([...r, ...d], ctx({ radiantWin: true }));
    const mvp = grades.findIndex((g) => g.awards.includes("mvp"));
    expect(grades[mvp].role).toBe("support");
    expect(grades.some((g) => g.awards.includes("topCore"))).toBe(true);
  });

  it("breaks an exact tie by kills, then fewer deaths, then user id", () => {
    const twins = [...radiant, ...dire];
    const grades = gradeGame(twins, ctx({ radiantWin: true }));
    const mvp = grades.findIndex((g) => g.awards.includes("mvp"));
    // Every Radiant line is identical but for net worth (which moves the
    // farm area); among equals the lower id wins.
    expect(twins[mvp].isRadiant).toBe(true);
  });
});

describe("highlights", () => {
  it("are shared by two tied players and dropped when more tie", () => {
    const base = [1, 2, 3, 4, 5].flatMap((n) => [
      line({ userId: `r${n}`, isRadiant: true, heroDamage: 10000 }),
      line({ userId: `d${n}`, isRadiant: false, heroDamage: 10000 }),
    ]);
    // Everyone tied: nobody gets "Most damage".
    expect(
      gradeGame(base, ctx()).some((g) => g.awards.includes("mostDamage")),
    ).toBe(false);
    base[0] = { ...base[0], heroDamage: 20000 };
    base[1] = { ...base[1], heroDamage: 20000 };
    const grades = gradeGame(base, ctx());
    expect(grades.flatMap((g, i) => (g.awards.includes("mostDamage") ? [i] : []))).toEqual([0, 1]);
  });

  it("need a real amount: no Healer for 300 healing", () => {
    const lines = [1, 2, 3, 4, 5].flatMap((n) => [
      line({ userId: `r${n}`, isRadiant: true, heroHealing: n === 1 ? 300 : 0 }),
      line({ userId: `d${n}`, isRadiant: false }),
    ]);
    expect(gradeGame(lines, ctx()).some((g) => g.awards.includes("healer"))).toBe(false);
  });
});

describe("the MMR comparison", () => {
  const lines = fixtureLines();
  // A baseline of ordinary games around 3,000 MMR, built the way the service
  // builds it: from finished games' lines and their MMR snapshots.
  const baselineAt = (mmr: number, games: number): BaselineLine[] =>
    Array.from({ length: games }, (_, g) =>
      baselineLinesOf(
        [1, 2, 3, 4, 5].flatMap((n) => [
          { ...line({ userId: `b${g}r${n}`, isRadiant: true, netWorth: 30000 - n * 4000, gpm: 300 + n * 20 + g, obsPlaced: 4, senPlaced: 2 }), mmr },
          { ...line({ userId: `b${g}d${n}`, isRadiant: false, netWorth: 30000 - n * 4000, gpm: 300 + n * 20 + g, obsPlaced: 4, senPlaced: 2 }), mmr },
        ]),
        2400,
      ),
    ).flat();

  it("scores against players in the same role near the player's MMR", () => {
    const mmrByUser = new Map(lines.map((l) => [l.userId!, 3000]));
    const grades = gradeGame(lines, ctx({ mmrByUser, baseline: baselineAt(3100, 10) }));
    for (const g of grades) {
      expect(g.vsMmr).not.toBeNull();
      expect(g.vsMmr!.spread).toBe(GRADE.MMR_SPREAD);
      expect(g.mmr).not.toBeNull();
      // Six metrics per role, each with a percentile and the window's median.
      for (const [pct, typical] of Object.values(g.vsMmr!.metrics)) {
        expect(pct).toBeGreaterThanOrEqual(0);
        expect(pct).toBeLessThanOrEqual(1);
        expect(Number.isFinite(typical)).toBe(true);
      }
    }
  });

  it("widens the window once when the near window is thin, then gives up", () => {
    const mmrByUser = new Map(lines.map((l) => [l.userId!, 3000]));
    const wide = gradeGame(lines, ctx({ mmrByUser, baseline: baselineAt(3600, 10) }));
    expect(wide.every((g) => g.vsMmr?.spread === GRADE.MMR_SPREAD_WIDE)).toBe(true);
    const far = gradeGame(lines, ctx({ mmrByUser, baseline: baselineAt(4500, 10) }));
    expect(far.every((g) => g.vsMmr === null && g.mmr === null)).toBe(true);
  });

  it("needs enough lines per metric and a known MMR", () => {
    const mmrByUser = new Map(lines.map((l) => [l.userId!, 3000]));
    // One game gives each role too few lines for any metric.
    const thin = gradeGame(lines, ctx({ mmrByUser, baseline: baselineAt(3000, 1) }));
    expect(thin.every((g) => g.vsMmr === null)).toBe(true);
    const unknown = gradeGame(lines, ctx({ baseline: baselineAt(3000, 10) }));
    expect(unknown.every((g) => g.vsMmr === null)).toBe(true);
  });

  it("weighs the three parts as GRADE says, rescaling when one is missing", () => {
    const mmrByUser = new Map(lines.map((l) => [l.userId!, 3000]));
    const full = gradeGame(lines, ctx({ mmrByUser, baseline: baselineAt(3000, 10) }));
    for (const g of full) {
      const expected =
        GRADE.WEIGHT_GAME * g.game + GRADE.WEIGHT_HERO * g.hero! + GRADE.WEIGHT_MMR * g.mmr!;
      // Parts are stored rounded, so allow a point of rounding.
      expect(Math.abs(g.score - expected)).toBeLessThanOrEqual(1);
    }
    for (const g of gradeGame(lines, ctx())) {
      const expected =
        (GRADE.WEIGHT_GAME * g.game + GRADE.WEIGHT_HERO * g.hero!) /
        (GRADE.WEIGHT_GAME + GRADE.WEIGHT_HERO);
      expect(Math.abs(g.score - expected)).toBeLessThanOrEqual(1);
    }
  });

  it("skips lines with no MMR or no duration", () => {
    expect(baselineLinesOf([{ ...line({ userId: "x", isRadiant: true }), mmr: 0 }], 2400)).toEqual([]);
    expect(baselineLinesOf([{ ...line({ userId: "x", isRadiant: true }), mmr: 3000 }], null)).toEqual([]);
    expect(baselineLinesOf([{ ...line({ userId: "x", isRadiant: true }), mmr: 3000 }], 2400)).toHaveLength(1);
  });
});

describe("normalizePlayerGrade", () => {
  const grade = gradeGame(fixtureLines(), ctx())[0];

  it("round-trips a stored grade through JSON", () => {
    expect(normalizePlayerGrade(JSON.parse(JSON.stringify(grade)))).toEqual(grade);
  });

  it("keeps the mark of a grade made again with the replay, and nothing else there", () => {
    expect(normalizePlayerGrade({ ...grade, regraded: true })).toEqual({
      ...grade,
      regraded: true,
    });
    expect(normalizePlayerGrade({ ...grade, regraded: "yes" })).not.toHaveProperty(
      "regraded",
    );
    expect(grade).not.toHaveProperty("regraded");
  });

  it("reads a malformed grade as no grade", () => {
    expect(normalizePlayerGrade(null)).toBeNull();
    expect(normalizePlayerGrade([])).toBeNull();
    expect(normalizePlayerGrade({ ...grade, v: 99 })).toBeNull();
    expect(normalizePlayerGrade({ ...grade, score: 140 })).toBeNull();
    expect(normalizePlayerGrade({ ...grade, letter: "Z" })).toBeNull();
    expect(normalizePlayerGrade({ ...grade, role: "carry" })).toBeNull();
  });

  it("drops unknown awards and areas instead of the grade", () => {
    const read = normalizePlayerGrade({
      ...grade,
      awards: [...grade.awards, "<script>"],
      areas: { ...grade.areas, bogus: 50, damage: "lots" },
    })!;
    expect(read.awards).toEqual(grade.awards);
    expect(read.areas).not.toHaveProperty("bogus");
    expect(read.areas).not.toHaveProperty("damage");
  });
});

describe("gradeRule", () => {
  it("quotes the weights GRADE holds", () => {
    expect(gradeRule()).toContain(`${GRADE.WEIGHT_GAME * 100}%`);
    expect(gradeRule()).toContain(`${GRADE.MMR_SPREAD} MMR`);
    expect(gradeRule()).toContain(`adds ${GRADE.MVP_WIN_BONUS}`);
    expect(gradeRuleShort()).toContain(`+${GRADE.MVP_WIN_BONUS} for a win`);
  });
});
