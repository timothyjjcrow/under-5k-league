import { describe, expect, it } from "vitest";
import { zoneLabel, zoneName } from "./zone-label";

describe("zoneName", () => {
  it("names a zone the way players say it", () => {
    expect(zoneName("Europe/Berlin")).toBe("Berlin");
    expect(zoneName("America/Los_Angeles")).toBe("Pacific");
    expect(zoneName("America/Argentina/Buenos_Aires")).toBe("Buenos Aires");
  });

  it("spells a renamed city as it is today, whatever id the browser reports", () => {
    // Chrome and Node report the old ids (ICU's canonical names).
    expect(zoneName("Europe/Kiev")).toBe("Kyiv");
    expect(zoneName("Europe/Kyiv")).toBe("Kyiv");
    expect(zoneName("Asia/Calcutta")).toBe("Kolkata");
    expect(zoneName("Asia/Kolkata")).toBe("Kolkata");
    expect(zoneName("Asia/Saigon")).toBe("Ho Chi Minh City");
  });

  it("keeps an id with no city as it is", () => {
    expect(zoneName("UTC")).toBe("UTC");
    expect(zoneName("Etc/GMT-1")).toBe("Etc/GMT-1");
  });

  it("is what zoneLabel says before 'time'", () => {
    for (const zone of ["Europe/London", "America/New_York", "UTC"]) {
      expect(zoneLabel(zone)).toBe(`${zoneName(zone)} time`);
    }
  });
});
