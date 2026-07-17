import { describe, expect, it } from "vitest";
import { promoteGateError, registrationGate } from "./registration";

// maxMmr 4500 = the 4.5K soft/review limit; the hard ceiling (5000) is what
// actually blocks. maxMmr 0 = no soft limit (the hard ceiling still applies).
const soft = { maxMmr: 4500, status: "SIGNUPS" };
const signups = { maxMmr: 0, status: "SIGNUPS" };
const regular = { maxMmr: 0, status: "REGULAR_SEASON" };

describe("registrationGate — MMR limits", () => {
  it("rejects MMR above the hard ceiling", () => {
    expect(
      registrationGate({ season: soft, type: "PLAYER", mmr: 5001, hasExisting: false }),
    ).toMatch(/over 5000/);
  });
  it("allows MMR exactly at the hard ceiling", () => {
    expect(
      registrationGate({ season: soft, type: "PLAYER", mmr: 5000, hasExisting: false }),
    ).toBeNull();
  });
  it("allows MMR above the soft limit but under the ceiling (reviewed, not blocked)", () => {
    expect(
      registrationGate({ season: soft, type: "PLAYER", mmr: 4800, hasExisting: false }),
    ).toBeNull();
  });
  it("enforces the hard ceiling even when there's no soft limit", () => {
    expect(
      registrationGate({ season: signups, type: "PLAYER", mmr: 9000, hasExisting: false }),
    ).toMatch(/over 5000/);
  });
  it("applies the hard ceiling to standins too", () => {
    expect(
      registrationGate({ season: soft, type: "STANDIN", mmr: 6000, hasExisting: false }),
    ).toMatch(/over 5000/);
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
  it("lets an existing player update after SIGNUPS", () => {
    expect(
      registrationGate({
        season: regular,
        type: "PLAYER",
        mmr: 3000,
        hasExisting: true,
        existingType: "PLAYER",
      }),
    ).toBeNull();
  });
  it("lets a new standin sign up after SIGNUPS", () => {
    expect(
      registrationGate({ season: regular, type: "STANDIN", mmr: 3000, hasExisting: false }),
    ).toBeNull();
  });
  it("blocks a standin upgrading to player after SIGNUPS", () => {
    expect(
      registrationGate({
        season: regular,
        type: "PLAYER",
        mmr: 3000,
        hasExisting: true,
        existingType: "STANDIN",
      }),
    ).toMatch(/signups are closed/);
  });
  it("lets a standin upgrade to player during SIGNUPS", () => {
    expect(
      registrationGate({
        season: signups,
        type: "PLAYER",
        mmr: 3000,
        hasExisting: true,
        existingType: "STANDIN",
      }),
    ).toBeNull();
  });
  it("lets a player downgrade to standin any time", () => {
    expect(
      registrationGate({
        season: regular,
        type: "STANDIN",
        mmr: 3000,
        hasExisting: true,
        existingType: "PLAYER",
      }),
    ).toBeNull();
  });
});

describe("withdrawGateError", () => {
  it("allows withdrawing a plain active signup", async () => {
    const { withdrawGateError } = await import("./registration");
    expect(
      withdrawGateError({ status: "ACTIVE", isCaptain: false, isRostered: false }),
    ).toBeNull();
  });

  it("blocks captains, rostered players, and non-active signups", async () => {
    const { withdrawGateError } = await import("./registration");
    expect(
      withdrawGateError({ status: "ACTIVE", isCaptain: true, isRostered: true }),
    ).toMatch(/captain/i);
    expect(
      withdrawGateError({ status: "ACTIVE", isCaptain: false, isRostered: true }),
    ).toMatch(/roster/i);
    expect(
      withdrawGateError({ status: "WITHDRAWN", isCaptain: false, isRostered: false }),
    ).toMatch(/isn't active/i);
  });
});

describe("registrationGate — unknown MMR", () => {
  it("mmr 0 (blank signup = unknown) is legal and passes the gate", () => {
    expect(
      registrationGate({
        season: { status: "SIGNUPS", maxMmr: 4500 },
        type: "PLAYER",
        mmr: 0,
        hasExisting: false,
      }),
    ).toBeNull();
  });
});

describe("promoteGateError", () => {
  const ok = {
    seasonStatus: "REGULAR_SEASON",
    draftStatus: "COMPLETE",
    registrationStatus: "ACTIVE",
    registrationType: "STANDIN",
    pendingAssignments: 0,
  };

  it("allows promoting an active, unassigned standin mid-season", () => {
    expect(promoteGateError(ok)).toBeNull();
  });

  it("blocks only while the auction is actually running", () => {
    expect(
      promoteGateError({ ...ok, seasonStatus: "DRAFT", draftStatus: "IN_PROGRESS" }),
    ).toMatch(/draft is live/);
    // Pre-start: they simply join the pool and get auctioned normally.
    expect(
      promoteGateError({ ...ok, seasonStatus: "DRAFT", draftStatus: "NOT_STARTED" }),
    ).toBeNull();
    expect(
      promoteGateError({ ...ok, seasonStatus: "DRAFT", draftStatus: "COMPLETE" }),
    ).toBeNull();
  });

  it("rejects the wrong phases, states, and pending assignments", () => {
    expect(promoteGateError({ ...ok, seasonStatus: "SIGNUPS" })).toMatch(/own profile/);
    expect(promoteGateError({ ...ok, seasonStatus: "COMPLETE" })).toMatch(/over/);
    expect(promoteGateError({ ...ok, registrationStatus: "WITHDRAWN" })).toMatch(/isn't active/);
    expect(promoteGateError({ ...ok, registrationType: "PLAYER" })).toMatch(/already a full player/);
    expect(promoteGateError({ ...ok, pendingAssignments: 1 })).toMatch(/remove that assignment/);
  });
});
