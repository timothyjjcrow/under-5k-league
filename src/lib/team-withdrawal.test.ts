import { describe, expect, it } from "vitest";
import { MATCH_PHASE, MATCH_STATUS, SEASON_STATUS } from "./constants";
import {
  teamWithdrawalLockedReason,
  withdrawalForfeitScore,
  withdrawalKickedOffFixtures,
  type WithdrawalFixture,
} from "./team-withdrawal";

describe("teamWithdrawalLockedReason", () => {
  it("opens only during the regular season", () => {
    expect(teamWithdrawalLockedReason(SEASON_STATUS.REGULAR_SEASON)).toBeNull();
    expect(teamWithdrawalLockedReason(SEASON_STATUS.SIGNUPS)).toMatch(
      /remove the captain/i,
    );
    expect(teamWithdrawalLockedReason(SEASON_STATUS.DRAFT)).toMatch(
      /finish or abort the draft/i,
    );
    expect(teamWithdrawalLockedReason(SEASON_STATUS.PLAYOFFS)).toMatch(
      /Save as final/i,
    );
    expect(teamWithdrawalLockedReason(SEASON_STATUS.COMPLETE)).toMatch(
      /historical and read-only/i,
    );
  });
});

describe("withdrawalForfeitScore", () => {
  it("credits the opponent the series clinch number", () => {
    expect(withdrawalForfeitScore(1)).toBe(1);
    expect(withdrawalForfeitScore(2)).toBe(2);
    expect(withdrawalForfeitScore(3)).toBe(2);
    expect(withdrawalForfeitScore(4)).toBe(3);
    expect(withdrawalForfeitScore(5)).toBe(3);
  });
});

describe("withdrawalKickedOffFixtures", () => {
  const NOW = Date.UTC(2026, 10, 22, 2, 0);
  const HOUR = 3_600_000;
  const fixture = (
    id: string,
    over: Partial<WithdrawalFixture> = {},
  ): WithdrawalFixture & { id: string } => ({
    id,
    phase: MATCH_PHASE.REGULAR,
    status: MATCH_STATUS.SCHEDULED,
    scheduledAt: new Date(NOW - HOUR),
    homeTeamId: "quitter",
    awayTeamId: "rival",
    ...over,
  });
  const ids = (matches: { id: string }[]) => matches.map((m) => m.id);

  it("finds the team's unfinished regular series past kickoff, either side", () => {
    expect(
      ids(
        withdrawalKickedOffFixtures(
          [
            fixture("home"),
            fixture("away", { homeTeamId: "rival", awayTeamId: "quitter" }),
            fixture("exactly-now", { scheduledAt: new Date(NOW) }),
          ],
          "quitter",
          NOW,
        ),
      ),
    ).toEqual(["home", "away", "exactly-now"]);
  });

  it("counts a live series whatever its kickoff says", () => {
    expect(
      ids(
        withdrawalKickedOffFixtures(
          [
            fixture("live-unscheduled", {
              status: MATCH_STATUS.LIVE,
              scheduledAt: null,
            }),
            fixture("live-later", {
              status: MATCH_STATUS.LIVE,
              scheduledAt: new Date(NOW + HOUR),
            }),
          ],
          "quitter",
          NOW,
        ),
      ),
    ).toEqual(["live-unscheduled", "live-later"]);
  });

  it("leaves out what the withdrawal doesn't forfeit or hasn't kicked off", () => {
    expect(
      withdrawalKickedOffFixtures(
        [
          fixture("later", { scheduledAt: new Date(NOW + 1) }),
          fixture("no-kickoff", { scheduledAt: null }),
          fixture("final", { status: MATCH_STATUS.COMPLETED }),
          fixture("tiebreaker", { phase: MATCH_PHASE.TIEBREAKER }),
          fixture("playoff", { phase: MATCH_PHASE.PLAYOFF }),
          fixture("others", { homeTeamId: "a", awayTeamId: "b" }),
        ],
        "quitter",
        NOW,
      ),
    ).toEqual([]);
  });
});
