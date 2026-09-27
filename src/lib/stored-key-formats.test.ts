import { describe, expect, it, vi } from "vitest";

vi.mock("./prisma", () => ({ prisma: {} }));

import {
  ANNOUNCEMENT_CLAIM_PATTERN,
  ANNOUNCEMENT_CLAIM_PREFIX,
  announcementClaimValue,
  HONORS_CLAIM_PATTERN,
  HONORS_CLAIM_PREFIX,
  HONORS_FAILED_PATTERN,
  HONORS_FAILED_PREFIX,
  HONORS_STALE_PREFIX,
} from "./announcement-marker";
import { outPingPrefix, outPingThrottleKey } from "./availability";
import { honorsClaimValue } from "./honors-service";
import {
  fixtureImportCooldownResource,
  importSkipKey,
  playoffRoundBuiltKey,
  playoffRoundBuiltPrefix,
  providerCooldownKey,
  providerCooldownResourcePrefix,
  seasonSettingScopeWhere,
  tiebreakerDrawKey,
  tiebreakerDrawPrefix,
} from "./settings";

// These strings are stored in production databases (Setting keys and marker
// values). Changing one strands every row written in the old format: a sweep
// stops finding it, or a retry stops recognising a stuck claim. Pin them.

describe("stored Setting key formats", () => {
  it("keeps the season-scoped key strings", () => {
    expect(importSkipKey("s1")).toBe("importSkip:s1");
    expect(playoffRoundBuiltKey("s1", 2)).toBe("playoffRoundBuilt:s1:2");
    expect(playoffRoundBuiltPrefix("s1")).toBe("playoffRoundBuilt:s1:");
    expect(tiebreakerDrawKey("s1", "g")).toBe("tiebreakerDraw:s1:g");
    expect(tiebreakerDrawPrefix("s1")).toBe("tiebreakerDraw:s1:");
    expect(outPingPrefix("m1")).toBe("outPing:m1:");
    expect(outPingThrottleKey("m1", "u1").startsWith(outPingPrefix("m1"))).toBe(
      true,
    );
    const fixture = fixtureImportCooldownResource("m1");
    expect(fixture).toBe("fixture:m1");
    expect(providerCooldownResourcePrefix("open-dota-match-import", fixture)).toBe(
      "providerCooldown:open-dota-match-import:fixture%3Am1:",
    );
    expect(
      providerCooldownKey("open-dota-match-import", "u1", fixture).startsWith(
        providerCooldownResourcePrefix("open-dota-match-import", fixture),
      ),
    ).toBe(true);
  });

  it("sweeps every key its writers build", () => {
    const where = seasonSettingScopeWhere("s1", ["m1"]);
    const clauses = JSON.stringify(where.OR);
    for (const key of [
      importSkipKey("s1"),
      playoffRoundBuiltPrefix("s1"),
      tiebreakerDrawPrefix("s1"),
      outPingPrefix("m1"),
      providerCooldownResourcePrefix("open-dota-match-scan", "m1"),
      providerCooldownResourcePrefix(
        "open-dota-match-import",
        fixtureImportCooldownResource("m1"),
      ),
    ]) {
      expect(clauses).toContain(JSON.stringify(key));
    }
  });
});

describe("stored announcement marker value formats", () => {
  const eventId = "11111111-1111-4111-8111-111111111111";

  it("keeps the generic claim format", () => {
    expect(ANNOUNCEMENT_CLAIM_PREFIX).toBe("claim:v2:");
    const value = announcementClaimValue(1_000, eventId);
    expect(value).toMatch(
      new RegExp(`^claim:v2:\\d+:${eventId}:[0-9a-f-]{36}$`),
    );
    const claim = ANNOUNCEMENT_CLAIM_PATTERN.exec(value);
    expect(Number(claim?.[1])).toBeGreaterThan(1_000);
    expect(claim?.[2]).toBe(eventId);
  });

  it("keeps the honors claim, failed and stale formats", () => {
    expect(HONORS_CLAIM_PREFIX).toBe("claim:honors:");
    expect(HONORS_FAILED_PREFIX).toBe("failed:honors:");
    expect(HONORS_STALE_PREFIX).toBe("stale:");
    const value = honorsClaimValue(1_000, eventId, "corrected");
    expect(value).toMatch(
      new RegExp(`^claim:honors:v2:\\d+:${eventId}:[0-9a-f-]{36}:corrected$`),
    );
    const claim = HONORS_CLAIM_PATTERN.exec(value);
    expect(Number(claim?.[1])).toBeGreaterThan(1_000);
    expect(claim?.[2]).toBe(eventId);
    expect(claim?.[4]).toBe("corrected");
    const failed = HONORS_FAILED_PATTERN.exec(
      `failed:honors:initial:v2:${eventId}:1000`,
    );
    expect(failed?.[1]).toBe("initial");
    expect(failed?.[2]).toBe(eventId);
  });
});
