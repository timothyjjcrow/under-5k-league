import { describe, it, expect } from "vitest";
import { capacityInfo } from "./capacity";

describe("capacityInfo", () => {
  it("computes minimum players, teams formable, and remaining needed", () => {
    const c = capacityInfo({ teamSize: 5, minTeams: 4 }, 17);
    expect(c.minPlayers).toBe(20);
    expect(c.needed).toBe(3);
    expect(c.teamsFormable).toBe(3);
    expect(c.canDraft).toBe(false);
  });

  it("allows drafting once the minimum is reached", () => {
    const c = capacityInfo({ teamSize: 5, minTeams: 4 }, 20);
    expect(c.canDraft).toBe(true);
    expect(c.needed).toBe(0);
    expect(c.teamsFormable).toBe(4);
  });

  it("keeps counting teams beyond the minimum", () => {
    const c = capacityInfo({ teamSize: 5, minTeams: 4 }, 27);
    expect(c.teamsFormable).toBe(5);
    expect(c.canDraft).toBe(true);
  });

  // minTeams is a FLOOR. Nothing refuses the 31st signup on a 6-team season,
  // so none of these figures may saturate at the minimum — the UI reads them
  // to say "still open", and a capped number would make it say "full".
  it("keeps reporting growth past the minimum", () => {
    const c = capacityInfo({ teamSize: 5, minTeams: 6 }, 37);
    expect(c.minPlayers).toBe(30);
    expect(c.canDraft).toBe(true);
    expect(c.needed).toBe(0);
    expect(c.extra).toBe(7);
    expect(c.teamsFormable).toBe(7);
    expect(c.leftover).toBe(2);
    expect(c.toNextTeam).toBe(3);
  });

  it("reports no surplus while short of the minimum", () => {
    const c = capacityInfo({ teamSize: 5, minTeams: 6 }, 22);
    expect(c.extra).toBe(0);
    expect(c.leftover).toBe(2);
    expect(c.toNextTeam).toBe(3);
  });

  // The post-minimum progress bar runs playerCount against this, so its empty
  // slice is exactly `toNextTeam` players wide. The invariant that matters is
  // that the two agree: target - count === toNextTeam, at every count.
  it("scales the next-team target so the gap is the players still needed", () => {
    for (let n = 30; n <= 44; n++) {
      const c = capacityInfo({ teamSize: 5, minTeams: 6 }, n);
      expect(c.nextTeamTarget - n).toBe(c.toNextTeam);
      expect(c.nextTeamTarget % 5).toBe(0);
      // "Fills up, with room for a few more" — never empty, never full.
      const pct = (n / c.nextTeamTarget) * 100;
      expect(pct).toBeGreaterThanOrEqual(85);
      expect(pct).toBeLessThan(100);
    }
  });

  // At an exact multiple the pool seats every player, so "leftover" is 0 — but
  // "how many more for another team" is a whole team, never 0. A 0 here would
  // render as "0 more makes it 7 full teams", which is a lie in the one state
  // the league most often sits in.
  it("asks for a whole team at an exact multiple", () => {
    const c = capacityInfo({ teamSize: 5, minTeams: 6 }, 30);
    expect(c.leftover).toBe(0);
    expect(c.toNextTeam).toBe(5);
    expect(c.extra).toBe(0);
    expect(c.teamsFormable).toBe(6);
    // The state the bar got wrong: scaled on leftover/perTeam this is 0% —
    // an empty bar under "the 6-team minimum is covered".
    expect(c.nextTeamTarget).toBe(35);
  });

  it("survives a zero team size without dividing by it", () => {
    const c = capacityInfo({ teamSize: 0, minTeams: 6 }, 12);
    expect(c.teamsFormable).toBe(0);
    expect(c.leftover).toBe(0);
    expect(c.toNextTeam).toBe(0);
    expect(c.nextTeamTarget).toBe(0);
  });
});
