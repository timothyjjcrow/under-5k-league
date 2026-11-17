import { describe, expect, it } from "vitest";
import {
  emptyStandinRoleLedger,
  holdsStandinRole,
  ledgerAfterWrites,
  parseStandinRoleLedger,
  serializeStandinRoleLedger,
  STANDIN_ROLE_AWAY_RETRY_MS,
  standinRoleLiveStep,
  standinRolePlan,
  standinRolePlanEmpty,
  standinRoleSyncMessage,
  standinRoleTargets,
  type StandinRoleSeason,
  type StandinRoleSignup,
} from "./standin-role";

const season = (status: string, draftStatus: string | null = null): StandinRoleSeason => ({
  status,
  draftStatus,
});
const signup = (
  type: "PLAYER" | "STANDIN",
  over: Partial<StandinRoleSignup> = {},
): StandinRoleSignup => ({ type, status: "ACTIVE", rostered: false, ...over });

const ROLE = "152429373869890363";
const A = "100000000000000001";
const B = "100000000000000002";
const C = "100000000000000003";

describe("holdsStandinRole (Tim's rule, 2026-11-17)", () => {
  it("gives it to an ACTIVE standin signup in every phase before the season ends", () => {
    for (const phase of ["SIGNUPS", "DRAFT", "REGULAR_SEASON", "PLAYOFFS"]) {
      expect(holdsStandinRole(season(phase, "IN_PROGRESS"), signup("STANDIN")), phase).toBe(true);
    }
  });

  it("takes it off everyone once the season is COMPLETE", () => {
    expect(holdsStandinRole(season("COMPLETE", "COMPLETE"), signup("STANDIN"))).toBe(false);
    expect(holdsStandinRole(season("COMPLETE", "COMPLETE"), signup("PLAYER"))).toBe(false);
  });

  it("gives nobody the role with no active season", () => {
    expect(holdsStandinRole(null, signup("STANDIN"))).toBe(false);
    expect(holdsStandinRole(season("SIGNUPS"), null)).toBe(false);
  });

  it("never gives it to a withdrawn or removed signup", () => {
    expect(holdsStandinRole(season("SIGNUPS"), signup("STANDIN", { status: "WITHDRAWN" }))).toBe(false);
    expect(holdsStandinRole(season("REGULAR_SEASON"), signup("PLAYER", { status: "REMOVED" }))).toBe(false);
  });

  it("never gives it to anyone on a roster (signed, drafted or captaining)", () => {
    expect(holdsStandinRole(season("REGULAR_SEASON"), signup("STANDIN", { rostered: true }))).toBe(false);
    expect(holdsStandinRole(season("REGULAR_SEASON"), signup("PLAYER", { rostered: true }))).toBe(false);
  });

  it("gives an unrostered PLAYER signup the role only once the auction is done (a free agent)", () => {
    // Before the auction an unrostered player is in the draft pool.
    expect(holdsStandinRole(season("SIGNUPS"), signup("PLAYER"))).toBe(false);
    expect(holdsStandinRole(season("DRAFT", null), signup("PLAYER"))).toBe(false);
    expect(holdsStandinRole(season("DRAFT", "NOT_STARTED"), signup("PLAYER"))).toBe(false);
    expect(holdsStandinRole(season("DRAFT", "IN_PROGRESS"), signup("PLAYER"))).toBe(false);
    expect(holdsStandinRole(season("DRAFT", "PAUSED"), signup("PLAYER"))).toBe(false);
    // After it, unsold and released players can cover.
    expect(holdsStandinRole(season("DRAFT", "COMPLETE"), signup("PLAYER"))).toBe(true);
    expect(holdsStandinRole(season("REGULAR_SEASON", "COMPLETE"), signup("PLAYER"))).toBe(true);
    expect(holdsStandinRole(season("PLAYOFFS", "COMPLETE"), signup("PLAYER"))).toBe(true);
    // A legacy season with no Draft row past the draft (postAuctionWorkOpen).
    expect(holdsStandinRole(season("REGULAR_SEASON", null), signup("PLAYER"))).toBe(true);
  });

  it("ignores a type it doesn't know", () => {
    expect(holdsStandinRole(season("REGULAR_SEASON"), { type: "COACH", status: "ACTIVE", rostered: false })).toBe(false);
  });
});

describe("standinRoleTargets", () => {
  it("splits linked holders, linked others and unlinked holders", () => {
    const t = standinRoleTargets(season("REGULAR_SEASON", "COMPLETE"), [
      { userId: "u1", discordId: B, ...signup("STANDIN") },
      { userId: "u2", discordId: A, ...signup("PLAYER") }, // free agent
      { userId: "u3", discordId: C, ...signup("PLAYER", { rostered: true }) },
      { userId: "u4", discordId: null, ...signup("STANDIN") },
      { userId: "u5", discordId: null, ...signup("PLAYER", { rostered: true }) },
    ]);
    expect(t.holders).toEqual([A, B]);
    expect(t.others).toEqual([C]);
    expect(t.unlinkedUserIds).toEqual(["u4"]);
    // u1 and u4 are standins; u2 is the free agent.
    expect(t.standins).toBe(2);
  });

  it("lists every signup as an other once the season is over", () => {
    const t = standinRoleTargets(season("COMPLETE", "COMPLETE"), [
      { userId: "u1", discordId: B, ...signup("STANDIN") },
      { userId: "u2", discordId: A, ...signup("PLAYER") },
    ]);
    expect(t.holders).toEqual([]);
    expect(t.others).toEqual([A, B]);
  });
});

describe("the ledger", () => {
  it("round-trips, and starts empty for another role or a damaged row", () => {
    const ledger = { roleId: ROLE, held: [B, A], away: { [C]: 5 } };
    const raw = serializeStandinRoleLedger(ledger);
    expect(parseStandinRoleLedger(raw, ROLE)).toEqual({
      roleId: ROLE,
      held: [A, B],
      away: { [C]: 5 },
    });
    expect(parseStandinRoleLedger(raw, "999999999999999999")).toEqual(
      emptyStandinRoleLedger("999999999999999999"),
    );
    expect(parseStandinRoleLedger("{nope", ROLE)).toEqual(emptyStandinRoleLedger(ROLE));
    expect(parseStandinRoleLedger(null, ROLE)).toEqual(emptyStandinRoleLedger(ROLE));
    expect(
      parseStandinRoleLedger(
        JSON.stringify({ roleId: ROLE, held: [A, "nope", 3], away: { bad: 1, [B]: "x" } }),
        ROLE,
      ),
    ).toEqual({ roleId: ROLE, held: [A], away: {} });
  });
});

describe("standinRolePlan", () => {
  const now = 10 * STANDIN_ROLE_AWAY_RETRY_MS;

  it("writes nothing when the ledger already matches", () => {
    const plan = standinRolePlan([A, B], { roleId: ROLE, held: [B, A], away: {} }, now);
    expect(standinRolePlanEmpty(plan)).toBe(true);
  });

  it("gives the new holders and takes it off the ones the rule dropped", () => {
    const plan = standinRolePlan([A, C], { roleId: ROLE, held: [A, B], away: {} }, now);
    expect(plan).toEqual({ give: [C], take: [B], forget: [] });
  });

  it("waits out an absentee's retry, then tries again", () => {
    const ledger = { roleId: ROLE, held: [], away: { [A]: now - 1000 } };
    expect(standinRolePlan([A], ledger, now).give).toEqual([]);
    expect(standinRolePlanEmpty(standinRolePlan([A], ledger, now))).toBe(true);
    const due = { roleId: ROLE, held: [], away: { [A]: now - STANDIN_ROLE_AWAY_RETRY_MS } };
    expect(standinRolePlan([A], due, now).give).toEqual([A]);
  });

  it("forgets an absentee who no longer needs the role, with no request", () => {
    const plan = standinRolePlan([], { roleId: ROLE, held: [], away: { [A]: now } }, now);
    expect(plan).toEqual({ give: [], take: [], forget: [A] });
  });
});

describe("ledgerAfterWrites", () => {
  const now = 1_000;

  it("records what worked and leaves failures for the next pass", () => {
    const next = ledgerAfterWrites(
      { roleId: ROLE, held: [B], away: {} },
      [
        { discordId: A, on: true, outcome: "ok" },
        { discordId: C, on: true, outcome: "failed" },
        { discordId: B, on: false, outcome: "ok" },
      ],
      [],
      now,
    );
    expect(next).toEqual({ roleId: ROLE, held: [A], away: {} });
  });

  it("marks a holder who isn't in the server as away, and a removal from one as done", () => {
    const next = ledgerAfterWrites(
      { roleId: ROLE, held: [B], away: {} },
      [
        { discordId: A, on: true, outcome: "not-a-member" },
        { discordId: B, on: false, outcome: "not-a-member" },
      ],
      [],
      now,
    );
    expect(next).toEqual({ roleId: ROLE, held: [], away: { [A]: now } });
  });

  it("keeps a forbidden write's entry so the fix is retried", () => {
    const next = ledgerAfterWrites(
      { roleId: ROLE, held: [B], away: { [C]: 5 } },
      [{ discordId: B, on: false, outcome: "forbidden" }],
      [C],
      now,
    );
    expect(next).toEqual({ roleId: ROLE, held: [B], away: {} });
  });
});

describe("standinRoleLiveStep (the admin sync)", () => {
  it("gives the role to a holder who lacks it, and writes anyway when Discord didn't say", () => {
    expect(standinRoleLiveStep(true, "lacks")).toBe("give");
    expect(standinRoleLiveStep(true, null)).toBe("give");
    expect(standinRoleLiveStep(true, "has")).toBe("keep");
    expect(standinRoleLiveStep(true, "not-member")).toBe("absent");
  });

  it("takes it off someone the rule doesn't cover", () => {
    expect(standinRoleLiveStep(false, "has")).toBe("take");
    expect(standinRoleLiveStep(false, null)).toBe("take");
    expect(standinRoleLiveStep(false, "lacks")).toBe("keep");
    expect(standinRoleLiveStep(false, "not-member")).toBe("keep");
  });
});

describe("standinRoleSyncMessage", () => {
  const base = {
    holders: 41,
    standins: 38,
    unlinked: 0,
    given: 0,
    taken: 0,
    unchanged: 60,
    notInServer: 0,
    failed: 0,
    forbidden: false,
  };

  it("says who should have it and that nothing changed", () => {
    expect(standinRoleSyncMessage(base)).toBe(
      "41 players should have the Standin role (38 standins, 3 free agents): nothing needed changing.",
    );
  });

  it("counts what it changed and what needs a hand", () => {
    expect(
      standinRoleSyncMessage({
        ...base,
        given: 2,
        taken: 1,
        notInServer: 1,
        unlinked: 2,
        failed: 3,
      }),
    ).toBe(
      "41 players should have the Standin role (38 standins, 3 free agents): gave it to 2 and took it off 1. " +
        "1 of them isn't in the Discord server, so they get it within a few hours of joining. " +
        "2 signups have no linked Discord, so the site can't give them the role. " +
        "Discord didn't answer for 3; press Sync again in a minute.",
    );
  });

  it("names the hierarchy fix when Discord refuses", () => {
    expect(standinRoleSyncMessage({ ...base, forbidden: true, failed: 4 })).toContain(
      "the bot's role must sit above Standin",
    );
  });

  it("reads right when nobody should have it", () => {
    expect(standinRoleSyncMessage({ ...base, holders: 0, standins: 0, taken: 5 })).toBe(
      "Nobody should have the Standin role right now: took it off 5.",
    );
  });
});
