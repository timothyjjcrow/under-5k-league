import { describe, it, expect } from "vitest";
import {
  standinConflict,
  standinMmrNote,
  STANDIN_CONFLICT_HOURS,
  STANDIN_MMR_FLAG_GAP,
} from "./standin";

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

// Advisory, never a block (the maxMmr house rule): the assigner just gets told
// what they're doing. Named cover judges against the REPLACED player — the
// strength the team was already fielding; only an empty seat, which has no
// baseline, falls back to the season's soft cap.
describe("standinMmrNote", () => {
  // Pins the named-cover flag itself — and that the line NAMES both numbers,
  // because "heads up" with no figures is not something a captain can act on.
  it("flags a standin towering over the player they cover, naming both MMRs", () => {
    const note = standinMmrNote({ standinMmr: 4900, replacedMmr: 1800, maxMmr: 0 });
    expect(note).toMatch(/4900/);
    expect(note).toMatch(/1800/);
  });

  // Pins the gap threshold: comparable cover is silent, or every routine
  // assignment toasts a warning and the real ones drown.
  it("stays silent on comparable named cover", () => {
    expect(
      standinMmrNote({ standinMmr: 2600, replacedMmr: 2500, maxMmr: 0 }),
    ).toBeNull();
  });

  // Pins the >= boundary — exactly the flag gap up is already a flag.
  it("is inclusive at the boundary: exactly the gap up gets flagged", () => {
    expect(
      standinMmrNote({
        standinMmr: 2500 + STANDIN_MMR_FLAG_GAP,
        replacedMmr: 2500,
        maxMmr: 0,
      }),
    ).not.toBeNull();
  });

  // Pins the unknown rule: 0 must not dress up as "fine" OR as "too strong" —
  // an absolute-gap comparison would flag an unknown covering a known player.
  it("never flags an unknown standin MMR, even against known cover", () => {
    expect(
      standinMmrNote({ standinMmr: 0, replacedMmr: 1800, maxMmr: 3500 }),
    ).toBeNull();
  });

  // Pins the empty-seat fallback: no replaced player, so the season's review
  // threshold is the only yardstick — null and 0 both mean "no baseline".
  it("empty seat: measures against the season's review threshold", () => {
    expect(
      standinMmrNote({ standinMmr: 4000, replacedMmr: null, maxMmr: 3500 }),
    ).toMatch(/review threshold/);
    expect(
      standinMmrNote({ standinMmr: 4000, replacedMmr: 0, maxMmr: 3500 }),
    ).toMatch(/review threshold/);
  });

  // Pins that maxMmr 0 = no threshold set, never "a threshold of zero".
  it("empty seat with no cap set is silent — nothing to measure against", () => {
    expect(
      standinMmrNote({ standinMmr: 4000, replacedMmr: null, maxMmr: 0 }),
    ).toBeNull();
  });

  // Pins the branch ORDER: a known replaced player IS the baseline, so a small
  // gap stays silent even in a capped season with the standin above the cap —
  // the team was already fielding that strength.
  it("named-cover baseline beats the cap: small gap above maxMmr is silent", () => {
    expect(
      standinMmrNote({ standinMmr: 4000, replacedMmr: 3900, maxMmr: 3500 }),
    ).toBeNull();
  });
});
