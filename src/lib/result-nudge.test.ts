import { describe, expect, it } from "vitest";
import { AUTO_SYNC, MATCH_STATUS } from "./constants";
import {
  RESULT_NUDGE,
  resultNudgeDueAt,
  resultNudgeReason,
  type NudgeFixture,
} from "./result-nudge";

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

describe("resultNudgeDueAt — when the automation gate must wake for a nudge", () => {
  it("names the kickoff floor for a fixture with no games", () => {
    expect(resultNudgeDueAt(fixture(), KICKOFF)).toBe(
      KICKOFF + RESULT_NUDGE.HOURS_AFTER_KICKOFF * HOUR,
    );
  });

  it("names the stall time for a part-played series, never before the floor", () => {
    const early = fixture({ status: MATCH_STATUS.LIVE, games: [game(0, 10)] });
    expect(resultNudgeDueAt(early, KICKOFF)).toBe(
      KICKOFF + RESULT_NUDGE.HOURS_AFTER_KICKOFF * HOUR,
    );
    const late = fixture({ status: MATCH_STATUS.LIVE, games: [game(2)] });
    expect(resultNudgeDueAt(late, KICKOFF)).toBe(
      KICKOFF +
        2 * HOUR +
        40 * 60_000 +
        RESULT_NUDGE.HOURS_SINCE_LAST_GAME * HOUR,
    );
  });

  it("is null once nothing can fall due before the import window closes", () => {
    const end = KICKOFF + AUTO_SYNC.WINDOW_HOURS * HOUR;
    expect(resultNudgeDueAt(fixture(), end + 1)).toBeNull();
    const lastMinute = fixture({
      status: MATCH_STATUS.LIVE,
      games: [game(AUTO_SYNC.WINDOW_HOURS - 1)],
    });
    expect(resultNudgeDueAt(lastMinute, KICKOFF)).toBeNull();
    expect(resultNudgeDueAt(fixture({ scheduledAt: null }), KICKOFF)).toBeNull();
    expect(
      resultNudgeDueAt(fixture({ status: MATCH_STATUS.COMPLETED }), KICKOFF),
    ).toBeNull();
  });

  it("never disagrees with resultNudgeReason", () => {
    // The gate sleeps until the due time; a nudge the worker would send
    // earlier would be late, and a due time the worker would refuse would
    // wake it every minute for nothing.
    const cases = [
      fixture(),
      fixture({ status: MATCH_STATUS.LIVE, games: [game(0)] }),
      fixture({ status: MATCH_STATUS.LIVE, games: [game(3), game(1)] }),
      fixture({ status: MATCH_STATUS.LIVE, games: [game(46)] }),
      fixture({
        status: MATCH_STATUS.LIVE,
        games: [{ startTime: 0, durationSecs: 0, fetchedAt: new Date(KICKOFF + 2 * HOUR) }],
      }),
    ];
    for (const f of cases) {
      for (let minute = -60; minute <= (AUTO_SYNC.WINDOW_HOURS + 1) * 60; minute += 7) {
        const now = KICKOFF + minute * 60_000;
        const dueAt = resultNudgeDueAt(f, now);
        const due = dueAt !== null && now >= dueAt;
        expect(resultNudgeReason(f, now) !== null).toBe(due);
        if (dueAt !== null && dueAt > now) {
          expect(resultNudgeReason(f, dueAt)).not.toBeNull();
          expect(resultNudgeReason(f, dueAt - 1)).toBeNull();
        }
      }
    }
  });
});
