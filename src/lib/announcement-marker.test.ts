import { describe, expect, it } from "vitest";
import {
  announcementMarkerOwnsEvent,
  recoverableAnnouncementMarker,
} from "./announcement-marker";

describe("announcement marker leases", () => {
  it("reclaims only explicit failures and expired v2 claims", () => {
    const event = "11111111-1111-4111-8111-111111111111";
    const owner = "22222222-2222-4222-8222-222222222222";
    expect(recoverableAnnouncementMarker("2026-08-04T00:00:00.000Z", 10)).toBe(
      false,
    );
    expect(recoverableAnnouncementMarker("sent:v2:event:1", 10)).toBe(false);
    expect(recoverableAnnouncementMarker("failed:legacy", 10)).toBe(true);
    expect(
      recoverableAnnouncementMarker(`claim:v2:9:${event}:${owner}`, 10),
    ).toBe(true);
    expect(
      recoverableAnnouncementMarker(`claim:v2:11:${event}:${owner}`, 10),
    ).toBe(false);
    expect(recoverableAnnouncementMarker("claim:v2:bad", 10)).toBe(false);
  });

  it("recognizes one generic or honors event generation across its lifecycle", () => {
    const event = "11111111-1111-4111-8111-111111111111";
    const other = "33333333-3333-4333-8333-333333333333";
    const owner = "22222222-2222-4222-8222-222222222222";
    for (const value of [
      `claim:v2:99:${event}:${owner}`,
      `failed:v2:${event}:99`,
      `sent:v2:${event}:99`,
      `claim:honors:v2:99:${event}:${owner}:initial`,
      `failed:honors:corrected:v2:${event}:99`,
      `sent:honors:v2:${event}:digest:2026-08-04T00:00:00.000Z`,
    ]) {
      expect(announcementMarkerOwnsEvent(value, event)).toBe(true);
      expect(announcementMarkerOwnsEvent(value, other)).toBe(false);
    }
    expect(
      announcementMarkerOwnsEvent("sent:legacy:2026-08-04", event),
    ).toBe(false);
  });
});
