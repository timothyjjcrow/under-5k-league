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
});
