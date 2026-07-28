import { describe, it, expect } from "vitest";
import { standinConflict, STANDIN_CONFLICT_HOURS } from "./standin";

const at = (iso: string) => new Date(iso);

describe("standinConflict", () => {
  it("catches the same kickoff — one person, two lobbies", () => {
    expect(
      standinConflict(
        { scheduledAt: at("2026-08-02T18:00:00Z"), week: 3 },
        { scheduledAt: at("2026-08-02T18:00:00Z"), week: 3 },
      ),
    ).toBe(true);
  });

  it("catches a nearby kickoff — a Bo3 runs well past its start", () => {
    expect(
      standinConflict(
        { scheduledAt: at("2026-08-02T18:00:00Z"), week: 3 },
        { scheduledAt: at("2026-08-02T20:00:00Z"), week: 3 },
      ),
    ).toBe(true);
  });

  it("allows genuinely separate nights", () => {
    expect(
      standinConflict(
        { scheduledAt: at("2026-08-02T18:00:00Z"), week: 3 },
        { scheduledAt: at("2026-08-05T18:00:00Z"), week: 3 },
      ),
    ).toBe(false);
  });

  it("is exclusive at the boundary — exactly the window apart is fine", () => {
    const base = at("2026-08-02T18:00:00Z");
    const edge = new Date(
      base.getTime() + STANDIN_CONFLICT_HOURS * 60 * 60 * 1000,
    );
    expect(
      standinConflict({ scheduledAt: base, week: 3 }, { scheduledAt: edge, week: 3 }),
    ).toBe(false);
  });

  it("is symmetric", () => {
    const a = { scheduledAt: at("2026-08-02T18:00:00Z"), week: 3 };
    const b = { scheduledAt: at("2026-08-02T19:00:00Z"), week: 3 };
    expect(standinConflict(a, b)).toBe(standinConflict(b, a));
  });

  // No kickoff to compare, so fall back to the week — the league plays one
  // round a week, so "same week" is the same night until told otherwise.
  it("falls back to the week when a kickoff is missing", () => {
    expect(
      standinConflict(
        { scheduledAt: null, week: 3 },
        { scheduledAt: at("2026-08-02T18:00:00Z"), week: 3 },
      ),
    ).toBe(true);
    expect(
      standinConflict({ scheduledAt: null, week: 3 }, { scheduledAt: null, week: 4 }),
    ).toBe(false);
  });
});
