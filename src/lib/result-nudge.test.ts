import { describe, expect, it } from "vitest";
import { AUTO_SYNC, MATCH_STATUS } from "./constants";
import { RESULT_NUDGE, resultNudgeReason, type NudgeFixture } from "./result-nudge";

const HOUR = 3_600_000;
const KICKOFF = Date.UTC(2026, 8, 20, 18, 0, 0);

function fixture(over: Partial<NudgeFixture> = {}): NudgeFixture {
  return {
    status: MATCH_STATUS.SCHEDULED,
    scheduledAt: new Date(KICKOFF),
    games: [],
    ...over,
  };
}

/** A game that started `startHoursAfterKickoff` in and ran `minutes`. */
function game(startHoursAfterKickoff: number, minutes = 40) {
  const startMs = KICKOFF + startHoursAfterKickoff * HOUR;
  return {
    startTime: Math.floor(startMs / 1000),
    durationSecs: minutes * 60,
    fetchedAt: new Date(startMs + minutes * 60_000 + 10 * 60_000),
  };
}

describe("resultNudgeReason", () => {
  it("asks about a fixture with no games only once HOURS_AFTER_KICKOFF have passed", () => {
    const due = KICKOFF + RESULT_NUDGE.HOURS_AFTER_KICKOFF * HOUR;
    expect(resultNudgeReason(fixture(), due - 1)).toBeNull();
    expect(resultNudgeReason(fixture(), due)).toBe("missing");
  });

  it("stops at the edge of the automatic import's own window", () => {
    const end = KICKOFF + AUTO_SYNC.WINDOW_HOURS * HOUR;
    expect(resultNudgeReason(fixture(), end)).toBe("missing");
    expect(resultNudgeReason(fixture(), end + 1)).toBeNull();
  });

  it("never nudges an unscheduled or completed fixture", () => {
    const late = KICKOFF + 10 * HOUR;
    expect(resultNudgeReason(fixture({ scheduledAt: null }), late)).toBeNull();
    expect(
      resultNudgeReason(fixture({ status: MATCH_STATUS.COMPLETED }), late),
    ).toBeNull();
    expect(
      resultNudgeReason(fixture({ scheduledAt: new Date(Number.NaN) }), late),
    ).toBeNull();
  });

  it("calls a part-played series stalled once its newest game ended HOURS_SINCE_LAST_GAME ago", () => {
    // Bo3 at 1-0: game 1 started an hour late and ran 40 minutes.
    const oneZero = fixture({ status: MATCH_STATUS.LIVE, games: [game(1)] });
    const lastEnded = KICKOFF + HOUR + 40 * 60_000;
    const stalledAt = lastEnded + RESULT_NUDGE.HOURS_SINCE_LAST_GAME * HOUR;
    // Past the kickoff floor but the last game is still recent enough.
    expect(
      resultNudgeReason(
        fixture({ status: MATCH_STATUS.LIVE, games: [game(2)] }),
        KICKOFF + RESULT_NUDGE.HOURS_AFTER_KICKOFF * HOUR,
      ),
    ).toBeNull();
    expect(resultNudgeReason(oneZero, stalledAt - 1)).toBeNull();
    expect(resultNudgeReason(oneZero, stalledAt)).toBe("stalled");
  });

  it("judges a stall by the NEWEST game, whatever order the games arrive in", () => {
    const late = fixture({
      status: MATCH_STATUS.LIVE,
      games: [game(3), game(0)],
    });
    const now = KICKOFF + 5 * HOUR;
    // Game 2 ended 3h40m in, so only 1h20m of quiet: not stalled yet.
    expect(resultNudgeReason(late, now)).toBeNull();
  });

  it("falls back to the import time when a game's start time is unknown", () => {
    const unknownStart = {
      startTime: 0,
      durationSecs: 0,
      fetchedAt: new Date(KICKOFF + 2 * HOUR),
    };
    const f = fixture({ status: MATCH_STATUS.LIVE, games: [unknownStart] });
    expect(resultNudgeReason(f, KICKOFF + 4.5 * HOUR)).toBeNull();
    expect(resultNudgeReason(f, KICKOFF + 5 * HOUR)).toBe("stalled");
  });

  it("keeps the expiry longer than the gap between worker passes", () => {
    // A nudge dropped before the next pass could even try it would be lost.
    expect(RESULT_NUDGE.EXPIRES_AFTER_HOURS).toBeGreaterThan(1);
    expect(RESULT_NUDGE.HOURS_AFTER_KICKOFF).toBeLessThan(
      AUTO_SYNC.WINDOW_HOURS,
    );
  });
});
