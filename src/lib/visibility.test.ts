import { describe, expect, it } from "vitest";
import {
  canViewAvailabilitySummary,
  canViewLeagueContact,
  canViewLeagueDirectoryContact,
  canViewNamedMatchAvailability,
  hasActiveLeagueParticipation,
} from "./visibility";

const visitor = null;
const account = { id: "account", role: "USER" };
const player = { id: "player", role: "USER" };
const captain = { id: "home-captain", role: "USER" };
const admin = { id: "admin", role: "ADMIN" };

describe("league contact visibility", () => {
  it("opens the directory only to active participants and admins", () => {
    expect(canViewLeagueDirectoryContact(visitor, false)).toBe(false);
    expect(canViewLeagueDirectoryContact(account, false)).toBe(false);
    expect(canViewLeagueDirectoryContact(player, true)).toBe(true);
    expect(canViewLeagueDirectoryContact(admin, false)).toBe(true);
  });

  it("allows self, an active league participant, and an admin", () => {
    expect(canViewLeagueContact(player, "player", false)).toBe(true);
    expect(canViewLeagueContact(player, "other", true)).toBe(true);
    expect(canViewLeagueContact(admin, "other", false)).toBe(true);
  });

  it("blocks visitors and signed-in accounts with no active registration", () => {
    expect(canViewLeagueContact(visitor, "player", false)).toBe(false);
    expect(canViewLeagueContact(account, "player", false)).toBe(false);
  });
});

describe("match availability visibility", () => {
  it("limits named answers to either captain or an admin", () => {
    expect(
      canViewNamedMatchAvailability(captain, captain.id, "away-captain"),
    ).toBe(true);
    expect(
      canViewNamedMatchAvailability(
        { id: "away-captain", role: "USER" },
        captain.id,
        "away-captain",
      ),
    ).toBe(true);
    expect(
      canViewNamedMatchAvailability(admin, captain.id, "away-captain"),
    ).toBe(true);
    expect(
      canViewNamedMatchAvailability(player, captain.id, "away-captain"),
    ).toBe(false);
    expect(
      canViewNamedMatchAvailability(visitor, captain.id, "away-captain"),
    ).toBe(false);
  });

  it("shows aggregate readiness only to active participants and admins", () => {
    expect(canViewAvailabilitySummary(player, true)).toBe(true);
    expect(canViewAvailabilitySummary(admin, false)).toBe(true);
    expect(canViewAvailabilitySummary(account, false)).toBe(false);
    expect(canViewAvailabilitySummary(visitor, false)).toBe(false);
  });

  it("treats either an active signup or a current team role as participation", () => {
    expect(hasActiveLeagueParticipation(true, false)).toBe(true);
    expect(hasActiveLeagueParticipation(false, true)).toBe(true);
    expect(hasActiveLeagueParticipation(true, true)).toBe(true);
    expect(hasActiveLeagueParticipation(false, false)).toBe(false);
  });
});
