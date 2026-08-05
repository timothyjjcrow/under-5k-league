import { describe, expect, it } from "vitest";
import { SEASON_STATUS } from "./constants";
import { teamWithdrawalLockedReason } from "./team-withdrawal";

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
