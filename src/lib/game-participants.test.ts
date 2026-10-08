import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { buildParticipantProjection } from "./game-participants";

const COLUMNS = new Set<string>(Object.values(Prisma.GameParticipantScalarFieldEnum));

/** A modern line: report card, provenance and end-of-game items. */
function line(index: number) {
  return {
    accountId: 100 + index,
    heroId: index + 1,
    isRadiant: index < 5,
    kills: 1,
    deaths: 2,
    assists: 3,
    personaname: `p${index}`,
    netWorth: 10_000,
    gpm: 400,
    lastHits: 100,
    xpm: 500,
    denies: 5,
    level: 20,
    heroDamage: 10_000,
    towerDamage: 1_000,
    heroHealing: 0,
    benchmarks: { gold_per_min: { raw: 400, pct: 0.5 } },
    providerPlayerSlot: index < 5 ? index : 123 + index,
    items: [1, 63, 0, 0, 0, 0],
    backpack: [36, 0, 0],
    neutral: 359,
    neutralEnchantment: 1583,
    userId: `user-${index}`,
    teamId: index < 5 ? "home" : "away",
  };
}

describe("buildParticipantProjection", () => {
  it("writes only GameParticipant columns, whatever else a box-score line stores", () => {
    const projection = buildParticipantProjection(
      JSON.stringify(Array.from({ length: 10 }, (_, index) => line(index))),
    );
    expect(projection.complete).toBe(true);
    expect(projection.rows).toHaveLength(10);
    for (const row of projection.rows) {
      // createMany refuses an unknown field, which would fail every import.
      for (const key of Object.keys(row)) expect(COLUMNS).toContain(key);
      expect(row).not.toHaveProperty("items");
    }
  });
});
