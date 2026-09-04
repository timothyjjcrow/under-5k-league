import { describe, expect, it } from "vitest";
import { profileMatch, profileMatchState } from "./profile-match";

const now = Date.parse("2026-09-04T18:00:00Z");
const fixture = (
  id: string,
  status: string,
  days: number | null,
  week = 1,
) => ({
  id,
  status,
  week,
  phase: "REGULAR",
  scheduledAt: days === null ? null : new Date(now + days * 86400_000),
});

describe("profile match spotlight", () => {
  it("prioritizes live matches, then the nearest relevant fixture", () => {
    const next = fixture("next", "SCHEDULED", 1);
    const later = fixture("later", "SCHEDULED", 4);
    const live = fixture("live", "LIVE", -7);
    expect(profileMatch([later, next, live], now, true)?.id).toBe("live");
    expect(profileMatch([later, next], now, true)?.id).toBe("next");
  });

  it("never promotes old result debt as the next match", () => {
    const old = fixture("old", "SCHEDULED", -7);
    const done = fixture("done", "COMPLETED", -2);
    expect(profileMatch([old, done], now, true)?.id).toBe("done");
    expect(profileMatchState(old, now)).toBe("Awaiting result");
    expect(profileMatchState(fixture("fresh", "SCHEDULED", -0.05), now)).toBe(
      "Awaiting result",
    );
  });

  it("uses the latest completed result for archived teams", () => {
    const latest = fixture("latest", "COMPLETED", -2, 3);
    const earlier = fixture("earlier", "COMPLETED", -8, 2);
    const open = fixture("open", "SCHEDULED", 1, 4);
    expect(profileMatch([earlier, latest, open], now, false)?.id).toBe(
      "latest",
    );
    expect(profileMatch([open], now, false)).toBeNull();
  });

  it("keeps untimed fixtures truthful and does not mutate inputs", () => {
    const matches = [
      fixture("untimed", "SCHEDULED", null),
      fixture("next", "SCHEDULED", 2),
    ];
    expect(profileMatch(matches, now, true)?.id).toBe("next");
    expect(matches[0].id).toBe("untimed");
    expect(profileMatchState(matches[0], now)).toBe("Time TBD");
    expect(profileMatch([], now, true)).toBeNull();
  });
});
