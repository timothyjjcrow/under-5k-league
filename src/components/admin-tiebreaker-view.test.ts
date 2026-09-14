import { describe, expect, it } from "vitest";
import type { PlayoffFieldProjection } from "@/lib/playoff-field";
import type { TiebreakerGroup } from "@/lib/tiebreakers";
import { schedulableAdminTiebreakerGroups } from "./admin-tiebreaker-view";

function group(key: string, overrides: Partial<TiebreakerGroup> = {}): TiebreakerGroup {
  return {
    key,
    teamIds: ["a", "b", "c"],
    round: 1,
    status: "needed",
    pairings: [{ home: "a", away: "b" }],
    format: "BO1_DOUBLE_ELIMINATION",
    bestOf: 1,
    stage: 1,
    ...overrides,
  };
}

function state(
  groups: TiebreakerGroup[],
  overrides: Partial<PlayoffFieldProjection["tiebreakers"]> = {},
): PlayoffFieldProjection["tiebreakers"] {
  return { groups, pending: false, needsMatches: true, resolved: false, error: null, ...overrides };
}

describe("schedulableAdminTiebreakerGroups", () => {
  it("allows continuation recovery while an independent tiebreaker is pending", () => {
    const continuation = group("continuation", { stage: 2 });
    const reset = group("reset", { stage: 5 });
    const pending = group("other", { status: "pending" });
    expect(schedulableAdminTiebreakerGroups(state(
      [pending, continuation, reset], { pending: true },
    ))).toEqual([continuation, reset]);
  });

  it("does not start opening games or another BO3 round while a result is pending", () => {
    const opening = group("opening");
    const noStage = group("no-stage", { stage: undefined });
    const round = group("round", {
      format: "BO3_ROUND_ROBIN", bestOf: 3, stage: undefined, round: 2,
    });
    expect(schedulableAdminTiebreakerGroups(state(
      [opening, noStage, round], { pending: true },
    ))).toEqual([]);
  });

  it("offers all needed groups once no scheduled result is outstanding", () => {
    const opening = group("opening");
    const round = group("round", {
      format: "BO3_ROUND_ROBIN", bestOf: 3, stage: undefined, round: 2,
    });
    expect(schedulableAdminTiebreakerGroups(state([
      opening, group("resolved", { status: "resolved" }), round,
    ]))).toEqual([opening, round]);
    expect(schedulableAdminTiebreakerGroups(state([
      group("resolved", { status: "resolved" }),
    ], { needsMatches: false, resolved: true }))).toEqual([]);
  });

  it("offers no scheduling action when the authoritative projection needs review", () => {
    expect(schedulableAdminTiebreakerGroups(state(
      [group("continuation", { stage: 2 })],
      { error: "The fixtures no longer match their preceding results." },
    ))).toEqual([]);
  });
});
