import { describe, expect, it } from "vitest";
import {
  normalizePrivacyContactEmail,
  normalizePrivacyDataLocations,
} from "./privacy-contact.mjs";

describe("privacy contact email", () => {
  it.each([
    "privacy@league.example",
    "data.requests+league@ggd2l.test",
    "admin-team@subdomain.example.org",
  ])("accepts a plain public mailbox: %s", (value) => {
    expect(normalizePrivacyContactEmail(value)).toBe(value);
  });

  it.each([
    undefined,
    "",
    " privacy@league.example",
    "privacy@league.example ",
    "GGD2L Privacy <privacy@league.example>",
    "privacy@localhost",
    "privacy@@league.example",
    ".privacy@league.example",
    "privacy..team@league.example",
    "privacy@-league.example",
    "privacy@league-.example",
    "privacy@league.example\nBcc: attacker@example.test",
  ])("rejects a value unsafe for the public contact link: %j", (value) => {
    expect(normalizePrivacyContactEmail(value)).toBeNull();
  });
});

describe("privacy data locations", () => {
  it.each([
    "United States",
    "United States, Germany",
    "European Union (Germany) and United States",
  ])("accepts a concrete public location statement: %s", (value) => {
    expect(normalizePrivacyDataLocations(value)).toBe(value);
  });

  it.each([
    undefined,
    "",
    " United States",
    "TBD",
    "Your location",
    "https://provider.example/regions",
    "United States\nGermany",
    "x".repeat(161),
  ])("rejects an unsafe or noncommittal location: %j", (value) => {
    expect(normalizePrivacyDataLocations(value)).toBeNull();
  });
});
