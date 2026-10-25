import { describe, expect, it } from "vitest";
import {
  MMR_SELF_EDIT_LOCKED_HINT,
  keepsStoredMmr,
  medalProvesIneligible,
  mmrFrozenDuringDraftLine,
  mmrLockedAfterDraftNote,
  mmrSelfEditLocked,
  promoteGateError,
  registrationGate,
  signupRemovalBlockers,
  withdrawGateError,
} from "./registration";
import {
  sourceFile,
  sourceFiles,
  stripLineComments,
} from "../../test/support/source-files";

// maxMmr 4500 = the 4.5K soft/review limit; the hard ceiling (5000) is what
// actually blocks. maxMmr 0 = no soft limit (the hard ceiling still applies).
const soft = { maxMmr: 4500, status: "SIGNUPS" };
const signups = { maxMmr: 0, status: "SIGNUPS" };
const regular = { maxMmr: 0, status: "REGULAR_SEASON" };
const complete = { maxMmr: 0, status: "COMPLETE" };

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

describe("registrationGate — a kept stored number (mmrKept)", () => {
  const kept = {
    season: regular,
    type: "PLAYER" as const,
    mmr: 5200, // an admin's number over the ceiling
    hasExisting: true,
    existingType: "PLAYER" as const,
    existingStatus: "ACTIVE",
  };

  it("leaves the typed-MMR ceiling to numbers the player entered", () => {
    expect(registrationGate({ ...kept, mmrKept: true })).toBeNull();
    // The same number typed in is still refused, naming what was typed.
    expect(registrationGate(kept)).toBe(
      "This league doesn't take players over 5000 MMR — you entered 5200.",
    );
    expect(registrationGate({ ...kept, mmrKept: false })).toMatch(
      /you entered 5200/,
    );
  });

  it("keeps every other rule", () => {
    // The season is over.
    expect(
      registrationGate({ ...kept, season: complete, mmrKept: true }),
    ).toMatch(/season is complete/);
    // A re-entry is an admission, so the medal still judges it.
    expect(
      registrationGate({
        ...kept,
        existingStatus: "WITHDRAWN",
        rankTier: 80,
        mmrKept: true,
      }),
    ).toMatch(/medal puts you above/);
    // A standin can't make themselves a full player once signups close.
    expect(
      registrationGate({ ...kept, existingType: "STANDIN", mmrKept: true }),
    ).toBe("Player signups are closed for this season");
  });
});

describe("keepsStoredMmr — when a save stores the signup's own number", () => {
  it("keeps it under the post-draft lock, whatever was typed", () => {
    expect(
      keepsStoredMmr({ hasExisting: true, locked: true, mmrSubmitted: true }),
    ).toBe(true);
    expect(
      keepsStoredMmr({ hasExisting: true, locked: true, mmrSubmitted: false }),
    ).toBe(true);
  });

  it("reads a missing field on an existing signup as unchanged in every phase", () => {
    // A disabled box posts nothing; the lock may have lifted since the page
    // rendered (an aborted draft), and that must not clear the number.
    expect(
      keepsStoredMmr({ hasExisting: true, locked: false, mmrSubmitted: false }),
    ).toBe(true);
  });

  it("judges a submitted box, blank included, while unlocked, and every new signup", () => {
    expect(
      keepsStoredMmr({ hasExisting: true, locked: false, mmrSubmitted: true }),
    ).toBe(false);
    expect(
      keepsStoredMmr({ hasExisting: false, locked: false, mmrSubmitted: false }),
    ).toBe(false);
    expect(
      keepsStoredMmr({ hasExisting: false, locked: true, mmrSubmitted: true }),
    ).toBe(false);
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
  it("lets a player downgrade to standin after signups while the season is running", () => {
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
  it("freezes both new signups and existing registration edits when the season is complete", () => {
    expect(
      registrationGate({
        season: complete,
        type: "STANDIN",
        mmr: 3000,
        hasExisting: false,
      }),
    ).toMatch(/season is complete.*closed/i);
    expect(
      registrationGate({
        season: complete,
        type: "PLAYER",
        mmr: 3000,
        hasExisting: true,
        existingType: "PLAYER",
        existingStatus: "ACTIVE",
      }),
    ).toMatch(/season is complete.*closed/i);
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

  // The audience param's compatibility contract: the DEFAULT (no audience) is
  // byte-identical to the original third-person strings — every pre-existing
  // caller gets it implicitly, so any drift silently rewrites admin toasts.
  it("default audience returns the exact original third-person strings", async () => {
    const { withdrawGateError } = await import("./registration");
    const base = { status: "ACTIVE", isCaptain: false, isRostered: false };
    expect(withdrawGateError({ ...base, pendingAssignments: 1 })).toBe(
      "They're standing in for an unplayed match — remove that assignment first.",
    );
    expect(withdrawGateError({ ...base, isCaptain: true })).toBe(
      "They captain a team — replace the captain first.",
    );
    expect(withdrawGateError({ ...base, isRostered: true })).toBe(
      "They're on a roster — release them from the team first.",
    );
    expect(withdrawGateError({ ...base, isOnTheBlock: true })).toBe(
      "They're on the auction block right now — wait for the lot to settle.",
    );
  });

  // audience "self" speaks TO the player and prescribes only actions they can
  // take: the standin pressing Withdraw on /me was told "They're standing in …
  // remove that assignment first" — third person, pointing at a control only
  // the covered team's captain or an admin has.
  it('audience "self" speaks second-person and names reachable controls', async () => {
    const { withdrawGateError } = await import("./registration");
    const self = {
      status: "ACTIVE",
      isCaptain: false,
      isRostered: false,
      audience: "self" as const,
    };
    const pending = withdrawGateError({ ...self, pendingAssignments: 1 });
    expect(pending).toMatch(/You're booked to stand in/);
    expect(pending).toMatch(/captain or an admin/);
    expect(withdrawGateError({ ...self, isRostered: true })).toMatch(
      /You're on a roster/,
    );
    expect(withdrawGateError({ ...self, isCaptain: true })).toMatch(/You captain/);
    expect(withdrawGateError({ ...self, isOnTheBlock: true })).toMatch(
      /You're on the auction block/,
    );
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
    // This pins the PURE gate's branch, which the player's own "Leave the
    // league" path runs through. The admin withdrawSignup path does NOT pass
    // isOnTheBlock here — its on-the-block refusal is a separate inline check
    // in the action, pinned by its own integration test in
    // admin-flow-audit.itest.ts ("never the player currently ON THE BLOCK").
    // An earlier version of this comment claimed both paths ran through this
    // branch, which quietly misattributed the admin path's coverage to a test
    // that never exercised it.
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
// re-judges those signups — the admin's "Refresh player data now" names them
// with this predicate (the hourly refresh fills medals in without a toast).
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

describe("signupRemovalBlockers", () => {
  const teams = [
    { name: "Radiant Rejects", members: [{ userId: "cap" }, { userId: "drafted" }] },
    { name: "Dire Straits", members: [{ userId: "cap2" }] },
  ];
  const matches = [
    { id: "m-open", status: "SCHEDULED" },
    { id: "m-live", status: "LIVE" },
    { id: "m-done", status: "COMPLETED" },
  ];

  it("hides remove on every rostered player, naming their team", () => {
    const blockers = signupRemovalBlockers({ teams, assignments: [], matches });
    expect(blockers.get("drafted")?.note).toBe("on Radiant Rejects");
    expect(blockers.get("cap2")?.note).toBe("on Dire Straits");
    expect(blockers.get("drafted")?.fix).toMatch(/Roster moves/);
    // withdrawGateError agrees: a rostered row can only be refused.
    expect(
      withdrawGateError({ status: "ACTIVE", isCaptain: false, isRostered: true }),
    ).not.toBeNull();
  });

  it("hides remove on anyone owing cover on an unplayed match (pendingCoverWhere)", () => {
    const blockers = signupRemovalBlockers({
      teams,
      assignments: [
        { standinUserId: "sub-open", matchId: "m-open" },
        { standinUserId: "sub-live", matchId: "m-live" },
      ],
      matches,
    });
    expect(blockers.get("sub-open")?.note).toBe("covering a match");
    expect(blockers.get("sub-open")?.fix).toMatch(/remove that assignment first/i);
    expect(blockers.get("sub-live")?.note).toBe("covering a match");
  });

  it("keeps remove for a free signup and for cover that is already history", () => {
    const blockers = signupRemovalBlockers({
      teams,
      assignments: [{ standinUserId: "sub-done", matchId: "m-done" }],
      matches,
    });
    expect(blockers.has("free-agent")).toBe(false);
    expect(blockers.has("sub-done")).toBe(false);
    expect(
      withdrawGateError({
        status: "ACTIVE",
        isCaptain: false,
        isRostered: false,
        pendingAssignments: 0,
      }),
    ).toBeNull();
  });

  it("names the roster first when a player is both rostered and owing cover", () => {
    const blockers = signupRemovalBlockers({
      teams,
      assignments: [{ standinUserId: "drafted", matchId: "m-open" }],
      matches,
    });
    expect(blockers.get("drafted")?.note).toBe("on Radiant Rejects");
  });
});

describe("mmrSelfEditLocked — a player's own MMR after the draft", () => {
  it("stays editable through signups and draft setup", () => {
    expect(mmrSelfEditLocked("SIGNUPS", null)).toBe(false);
    // A reset draft can leave a row behind; signups are still signups.
    expect(mmrSelfEditLocked("SIGNUPS", "COMPLETE")).toBe(false);
    expect(mmrSelfEditLocked("DRAFT", null)).toBe(false);
    expect(mmrSelfEditLocked("DRAFT", undefined)).toBe(false);
    expect(mmrSelfEditLocked("DRAFT", "NOT_STARTED")).toBe(false);
  });

  it("leaves a live auction to the draft-night freeze", () => {
    // saveRegistration's own PLAYER-only freeze covers these; standins
    // registering on draft night still fix their typos.
    expect(mmrSelfEditLocked("DRAFT", "IN_PROGRESS")).toBe(false);
    expect(mmrSelfEditLocked("DRAFT", "PAUSED")).toBe(false);
  });

  it("locks once the auction is done, for the rest of the season", () => {
    expect(mmrSelfEditLocked("DRAFT", "COMPLETE")).toBe(true);
    expect(mmrSelfEditLocked("REGULAR_SEASON", "COMPLETE")).toBe(true);
    // A season moved on without a Draft row is past the draft all the same.
    expect(mmrSelfEditLocked("REGULAR_SEASON", null)).toBe(true);
    expect(mmrSelfEditLocked("PLAYOFFS", "COMPLETE")).toBe(true);
    expect(mmrSelfEditLocked("COMPLETE", "COMPLETE")).toBe(true);
  });

  it("says what was kept and who can change it, in en-US digits", () => {
    expect(mmrLockedAfterDraftNote(4200)).toBe(
      " · MMR is locked after the draft — kept 4,200. Ask a league admin to change it.",
    );
    expect(mmrLockedAfterDraftNote(0)).toBe(
      " · MMR is locked after the draft — it stays unknown. Ask a league admin to change it.",
    );
  });

  it("words the draft-night freeze without promising an edit window after it", () => {
    // The post-draft lock follows the auction, so "until it ends" would
    // promise self-editing that never opens.
    expect(mmrFrozenDuringDraftLine(4200)).toBe(
      "The draft is running, so you stay listed at 4,200 MMR. After the draft only a league admin can change it.",
    );
    expect(mmrFrozenDuringDraftLine(0)).toBe(
      "The draft is running, so you stay listed at an unknown MMR. After the draft only a league admin can change it.",
    );
  });

  it("is the one rule saveRegistration and the /me form both apply", () => {
    // The action keeps the stored number on the rule's say, and only after
    // reading the signup it is about to keep.
    const action = stripLineComments(
      sourceFile("src/app/actions/registration.ts").text,
    );
    const save = action.slice(
      action.indexOf("export async function saveRegistration("),
      action.indexOf("export async function leaveLeague("),
    );
    expect(save).toMatch(
      /existing && mmrSelfEditLocked\(season\.status, draftSnapshot\?\.status\)/,
    );
    expect(save).toMatch(/mmrLockedAfterDraftNote\(existing\.mmr\)/);
    expect(save).toMatch(/mmr = existing\.mmr;/);
    // A missing field keeps the number in every phase, and the gate is told
    // the number was kept, not entered.
    expect(save).toMatch(/mmrSubmitted: formData\.has\("mmr"\)/);
    expect(save).toMatch(/^\s*mmrKept,$/m);
    // …and decides it before the gate judges the number.
    expect(save.indexOf("mmrSelfEditLocked(")).toBeLessThan(
      save.indexOf("const gateFacts"),
    );
    expect(save.indexOf("keepsStoredMmr(")).toBeLessThan(
      save.indexOf("const gateFacts"),
    );
    // The draft-night freeze's toast is the shared sentence.
    expect(save).toMatch(/mmrFrozenDuringDraftLine\(existing\.mmr\)/);

    // /me: the page computes the lock from the same facts and hands it to
    // the one MMR box, which disables itself and shows the hint.
    const me = sourceFiles("src/app/me/**/*.tsx", 1);
    const page = stripLineComments(me.map((f) => f.text).join("\n"));
    expect(page).toMatch(
      /!!reg && mmrSelfEditLocked\(season\.status, draft\?\.status\)/,
    );
    expect(page).toMatch(/locked=\{mmrLocked\}/);
    const field = sourceFile("src/components/mmr-field.tsx").text;
    expect(field).toMatch(/disabled=\{locked\}/);
    expect(field).toMatch(/MMR_SELF_EDIT_LOCKED_HINT/);
    expect(MMR_SELF_EDIT_LOCKED_HINT).toMatch(/league admin/);
  });
});
