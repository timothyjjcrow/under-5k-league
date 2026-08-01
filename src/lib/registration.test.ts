import { describe, expect, it } from "vitest";
import {
  medalProvesIneligible,
  promoteGateError,
  registrationGate,
  withdrawGateError,
} from "./registration";

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

describe("registrationGate — medal floor (the anti-sandbagging line)", () => {
  it("rejects a medal whose exact band floor clears the ceiling, whatever they type", () => {
    // Immortal (5620+) and Divine 3/4/5 (5020+/5220+/5420+ — Divine stars
    // are 200 MMR each) are 5K+ by medal alone — a sandbagged low claim must
    // not walk past the ceiling.
    for (const tier of [73, 74, 75, 80]) {
      expect(
        registrationGate({
          season: signups,
          type: "PLAYER",
          mmr: 3000,
          rankTier: tier,
          hasExisting: false,
        }),
      ).toMatch(/medal puts you above/);
    }
  });

  it("judges the RAW claim, not a clamped one — an overstated lie can't slip under", () => {
    // Ancient 5's window (3696–5389) crosses the ceiling: a 6000 claim is
    // out-of-window, but the gate sees the raw 6000 and rejects it the same
    // as a plausible 5200 — the clamp only ever runs on gate-approved claims.
    expect(
      registrationGate({
        season: signups,
        type: "PLAYER",
        mmr: 6000,
        rankTier: 65,
        hasExisting: false,
      }),
    ).toMatch(/over 5000/);
  });

  it("lets sub-5K medals through on their merits", () => {
    expect(
      registrationGate({
        season: signups,
        type: "PLAYER",
        mmr: 3000,
        rankTier: 72, // Divine 2 — exact floor 4820, under the line
        hasExisting: false,
      }),
    ).toBeNull();
    expect(
      registrationGate({
        season: signups,
        type: "PLAYER",
        mmr: 3000,
        rankTier: 54,
        hasExisting: false,
      }),
    ).toBeNull();
  });

  it("changes nothing when no medal is known", () => {
    expect(
      registrationGate({
        season: signups,
        type: "PLAYER",
        mmr: 4900,
        rankTier: null,
        hasExisting: false,
      }),
    ).toBeNull();
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

describe("withdrawGateError — on the auction block", () => {
  const base = { status: "ACTIVE", isCaptain: false, isRostered: false };

  it("refuses withdrawal while the player is the live lot", () => {
    // Both the admin path and the player's own "Leave the league" button run
    // through here. Only the admin one used to check this, so a player could
    // withdraw mid-auction and leave every captain staring at a headless lot.
    expect(withdrawGateError({ ...base, isOnTheBlock: true })).toMatch(
      /auction block/i,
    );
  });

  it("allows withdrawal when no lot is live", () => {
    expect(withdrawGateError({ ...base, isOnTheBlock: false })).toBeNull();
    expect(withdrawGateError(base)).toBeNull();
  });

  it("still reports the more specific blockers first", () => {
    expect(
      withdrawGateError({ ...base, status: "REMOVED", isOnTheBlock: true }),
    ).toMatch(/isn't active/i);
  });
});

// A medal is often learned AFTER signup: players sign up before linking their
// Dota account, or OpenDota is unreachable at that moment. registrationGate only
// runs on submit and a stored MMR is league-approved by design, so nothing
// re-judges those signups — the admin's "Sync ranks" is the one moment the
// league learns the truth, and it uses this predicate to name them.
describe("medalProvesIneligible — the post-signup ceiling check", () => {
  it("is false when there is no medal to judge by", () => {
    expect(medalProvesIneligible(null)).toBe(false);
    expect(medalProvesIneligible(undefined)).toBe(false);
    expect(medalProvesIneligible(0)).toBe(false);
  });

  it("is false for every medal whose band sits under the ceiling", () => {
    // Herald 1 through Divine 2 (4820 floor) are all legitimately admissible.
    for (const tier of [11, 15, 25, 35, 45, 55, 65, 71, 72]) {
      expect(medalProvesIneligible(tier), `tier ${tier}`).toBe(false);
    }
  });

  it("is true from Divine 3 up — the documented reject band", () => {
    for (const tier of [73, 74, 75, 80, 81, 85]) {
      expect(medalProvesIneligible(tier), `tier ${tier}`).toBe(true);
    }
  });

  it("flips exactly between Divine 2 and Divine 3", () => {
    expect(medalProvesIneligible(72)).toBe(false);
    expect(medalProvesIneligible(73)).toBe(true);
  });

  it("agrees with registrationGate — one rule, not two", () => {
    // Whatever the predicate rejects, the signup gate must also reject, and
    // vice versa. If these ever drift, a sandbagger walks past the ceiling.
    for (const tier of [null, 0, 11, 45, 71, 72, 73, 74, 80]) {
      const gated = registrationGate({
        season: soft,
        type: "PLAYER",
        mmr: 4200,
        rankTier: tier,
        hasExisting: false,
      });
      const blockedByMedal = gated != null && /medal puts you above it/.test(gated);
      expect(blockedByMedal, `tier ${tier}`).toBe(medalProvesIneligible(tier));
    }
  });
});

// The medal is synced behind the player's back and the admin's sync is
// warn-only, so an ADMITTED player must never be re-judged by it — doing so
// turned "the admin kept them" into a permanently unsaveable signup: no role,
// hero, statement or standin-flip edit, ever again, refused by a medal nobody
// had objected to.
describe("registrationGate — the medal rule runs at ADMISSION only", () => {
  const active = {
    season: regular,
    mmr: 3000,
    rankTier: 80, // Immortal — refused for anyone signing up fresh
    hasExisting: true,
    existingStatus: "ACTIVE",
  } as const;

  it("lets an already-ACTIVE registrant keep editing", () => {
    expect(
      registrationGate({ ...active, type: "PLAYER", existingType: "PLAYER" }),
    ).toBeNull();
  });

  it("lets them flip to standin", () => {
    expect(
      registrationGate({ ...active, type: "STANDIN", existingType: "PLAYER" }),
    ).toBeNull();
  });

  it("still refuses a brand-new signup on the same medal", () => {
    expect(
      registrationGate({
        season: signups,
        type: "PLAYER",
        mmr: 3000,
        rankTier: 80,
        hasExisting: false,
      }),
    ).toMatch(/medal puts you above/);
  });

  it("treats WITHDRAWN and REMOVED rows as re-entries, not edits", () => {
    for (const status of ["WITHDRAWN", "REMOVED", null, undefined]) {
      expect(
        registrationGate({
          ...active,
          existingStatus: status,
          type: "PLAYER",
          existingType: "PLAYER",
        }),
        `status ${status}`,
      ).toMatch(/medal puts you above/);
    }
  });

  it("does NOT exempt the typed hard ceiling — that rule is unchanged", () => {
    // The asymmetry, pinned: the medal is out of their hands, the number they
    // type is not. An admitted player still cannot enter 5001.
    expect(
      registrationGate({
        ...active,
        mmr: 5001,
        type: "PLAYER",
        existingType: "PLAYER",
      }),
    ).toMatch(/over 5000/);
  });
});
