import { describe, expect, it } from "vitest";
import { registrationGate } from "./registration";

const capped = { maxMmr: 5000, status: "SIGNUPS" };
const signups = { maxMmr: 0, status: "SIGNUPS" };
const regular = { maxMmr: 0, status: "REGULAR_SEASON" };

describe("registrationGate — MMR cap", () => {
  it("rejects MMR above the cap", () => {
    expect(
      registrationGate({ season: capped, type: "PLAYER", mmr: 5001, hasExisting: false }),
    ).toMatch(/capped at 5000/);
  });
  it("allows MMR exactly at the cap", () => {
    expect(
      registrationGate({ season: capped, type: "PLAYER", mmr: 5000, hasExisting: false }),
    ).toBeNull();
  });
  it("ignores the cap when maxMmr is 0", () => {
    expect(
      registrationGate({ season: signups, type: "PLAYER", mmr: 9000, hasExisting: false }),
    ).toBeNull();
  });
  it("applies the cap to standins too", () => {
    expect(
      registrationGate({ season: capped, type: "STANDIN", mmr: 6000, hasExisting: false }),
    ).toMatch(/capped at 5000/);
  });
});

describe("registrationGate — phase rules", () => {
  it("lets a new player join during SIGNUPS", () => {
    expect(
      registrationGate({ season: signups, type: "PLAYER", mmr: 3000, hasExisting: false }),
    ).toBeNull();
  });
  it("blocks a brand-new player after SIGNUPS", () => {
    expect(
      registrationGate({ season: regular, type: "PLAYER", mmr: 3000, hasExisting: false }),
    ).toMatch(/signups are closed/);
  });
  it("lets an existing registrant update after SIGNUPS", () => {
    expect(
      registrationGate({ season: regular, type: "PLAYER", mmr: 3000, hasExisting: true }),
    ).toBeNull();
  });
  it("lets a new standin sign up after SIGNUPS", () => {
    expect(
      registrationGate({ season: regular, type: "STANDIN", mmr: 3000, hasExisting: false }),
    ).toBeNull();
  });
});
