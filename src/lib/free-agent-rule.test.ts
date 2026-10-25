import { describe, expect, it } from "vitest";
import { sourceFile, stripLineComments } from "../../test/support/source-files";
import {
  FREE_AGENT_OVER_RULE_FIELD,
  FREE_AGENT_OVER_RULE_LABEL,
  freeAgentBaseline,
  freeAgentOverRule,
  freeAgentOverRuleNote,
  freeAgentRuleRefusal,
  freeAgentSeatLabel,
  unrefilledDeparture,
  type TenureFacts,
} from "./free-agent-rule";
import { STANDIN_MMR_ALLOWANCE } from "./standin";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 0, minute));

function tenure(
  id: string,
  joined: number,
  ended: number | null,
  acquisitionMmr: number | null = null,
): TenureFacts {
  return {
    id,
    userId: `u-${id}`,
    name: id.toUpperCase(),
    joinedAt: at(joined),
    endedAt: ended === null ? null : at(ended),
    acquisitionMmr,
  };
}

describe("unrefilledDeparture", () => {
  it("is null when nobody left", () => {
    expect(unrefilledDeparture([tenure("a", 0, null), tenure("b", 1, null)])).toBeNull();
    expect(unrefilledDeparture([])).toBeNull();
  });

  it("is the one player who left and was never replaced", () => {
    expect(unrefilledDeparture([tenure("a", 0, 10), tenure("b", 0, null)])?.id).toBe("a");
  });

  it("is null once a later signing refilled the seat", () => {
    expect(
      unrefilledDeparture([tenure("a", 0, 10), tenure("c", 20, null)]),
    ).toBeNull();
  });

  it("pairs last in, first out: two departures, one signing leaves the earlier one", () => {
    // A leaves, then B; C refills B's seat; the next signing replaces A.
    const tenures = [tenure("a", 0, 10), tenure("b", 0, 20), tenure("c", 30, null)];
    expect(unrefilledDeparture(tenures)?.id).toBe("a");
    // And a second signing refills A's seat too.
    expect(unrefilledDeparture([...tenures, tenure("d", 40, null)])).toBeNull();
  });

  it("never lets an acquisition refill a departure that comes after it", () => {
    // C joined before B left, so B's seat is still open.
    expect(
      unrefilledDeparture([tenure("b", 0, 20), tenure("c", 10, null)])?.id,
    ).toBe("b");
  });

  it("refills with any acquisition, so a captain change leaves no phantom departure", () => {
    // The outgoing captain's seat closes and the incoming one opens in one
    // command, at the same instant: the departure goes first and is refilled.
    expect(
      unrefilledDeparture([tenure("old", 0, 5), tenure("new", 5, null)]),
    ).toBeNull();
  });

  it("puts a tenure's own start before its own end", () => {
    expect(unrefilledDeparture([tenure("a", 5, 5)])?.id).toBe("a");
  });

  it("ignores a legacy closure with no exact end", () => {
    expect(unrefilledDeparture([tenure("a", 0, null)])).toBeNull();
  });

  it("does not depend on the input order", () => {
    const tenures = [tenure("c", 30, null), tenure("b", 0, 20), tenure("a", 0, 10)];
    expect(unrefilledDeparture(tenures)?.id).toBe("a");
  });
});

describe("freeAgentBaseline", () => {
  const signupMmr = new Map([
    ["u-a", 2400],
    ["x", 2600],
    ["y", 2100],
    ["z", 0],
  ]);

  it("uses the departed player's MMR when they joined", () => {
    expect(
      freeAgentBaseline({
        teamName: "T",
        tenures: [tenure("a", 0, 10, 2000)],
        rosterUserIds: ["x"],
        signupMmr,
      }),
    ).toEqual({ kind: "replaced", name: "A", mmr: 2000 });
  });

  it("falls back to their signup MMR when none was recorded", () => {
    expect(
      freeAgentBaseline({
        teamName: "T",
        tenures: [tenure("a", 0, 10, null)],
        rosterUserIds: ["x"],
        signupMmr,
      }),
    ).toEqual({ kind: "replaced", name: "A", mmr: 2400 });
  });

  it("is unknown when neither is known", () => {
    expect(
      freeAgentBaseline({
        teamName: "T",
        tenures: [{ ...tenure("q", 0, 10, 0), userId: null }],
        rosterUserIds: [],
        signupMmr,
      }),
    ).toEqual({ kind: "replaced", name: "Q", mmr: null });
  });

  it("is the team's lowest known MMR with no departure waiting", () => {
    expect(
      freeAgentBaseline({
        teamName: "T",
        tenures: [tenure("a", 0, 10), tenure("c", 20, null)],
        rosterUserIds: ["x", "y", "z"],
        signupMmr,
      }),
    ).toEqual({ kind: "lowest", teamName: "T", mmr: 2100 });
    expect(
      freeAgentBaseline({ teamName: "T", tenures: [], rosterUserIds: ["z"], signupMmr }),
    ).toEqual({ kind: "lowest", teamName: "T", mmr: null });
  });
});

describe("freeAgentOverRule", () => {
  const bob = { kind: "replaced" as const, name: "Bob", mmr: 2000 };
  it("allows exactly the allowance above", () => {
    expect(freeAgentOverRule(2000 + STANDIN_MMR_ALLOWANCE, bob)).toBe(false);
    expect(freeAgentOverRule(2001 + STANDIN_MMR_ALLOWANCE, bob)).toBe(true);
    expect(freeAgentOverRule(1500, bob)).toBe(false);
  });
  it("counts an unknown on either side as over", () => {
    expect(freeAgentOverRule(0, bob)).toBe(true);
    expect(freeAgentOverRule(2000, { ...bob, mmr: null })).toBe(true);
    expect(
      freeAgentOverRule(2000, { kind: "lowest", teamName: "T", mmr: null }),
    ).toBe(true);
  });
});

describe("the copy", () => {
  const bob = { kind: "replaced" as const, name: "Bob", mmr: 2000 };
  const lowest = { kind: "lowest" as const, teamName: "Team A", mmr: 2100 };

  it("refuses with both MMRs, the gap and the box by its label", () => {
    expect(
      freeAgentRuleRefusal({ playerName: "Free Agent", freeAgentMmr: 4500, baseline: bob }),
    ).toBe(
      "Free Agent (4,500 MMR) is 2,500 above Bob (2,000 MMR), the player they'd replace. Tick “Sign over the 100-MMR rule” to sign them anyway.",
    );
    expect(
      freeAgentRuleRefusal({ playerName: "Free Agent", freeAgentMmr: 4500, baseline: lowest }),
    ).toBe(
      "Free Agent (4,500 MMR) is 2,400 above Team A's lowest MMR (2,100). Tick “Sign over the 100-MMR rule” to sign them anyway.",
    );
  });

  it("says whose MMR is unknown", () => {
    expect(
      freeAgentRuleRefusal({ playerName: "Free Agent", freeAgentMmr: 0, baseline: bob }),
    ).toMatch(/^Free Agent's MMR is unknown, so the 100-MMR rule can't clear them against Bob \(2,000 MMR\)/);
    expect(
      freeAgentRuleRefusal({ playerName: "Free Agent", freeAgentMmr: 4500, baseline: { ...bob, mmr: null } }),
    ).toMatch(/^Bob's MMR is unknown, so the 100-MMR rule can't clear Free Agent \(4,500 MMR\)/);
    expect(
      freeAgentRuleRefusal({ playerName: "Free Agent", freeAgentMmr: 4500, baseline: { ...lowest, mmr: null } }),
    ).toMatch(/^Nobody on Team A has a known MMR/);
  });

  it("records a signing over the rule with both MMRs", () => {
    expect(freeAgentOverRuleNote({ freeAgentMmr: 4500, baseline: bob })).toBe(
      "Signed over the 100-MMR rule: 4,500 MMR, replacing Bob's 2,000.",
    );
    expect(freeAgentOverRuleNote({ freeAgentMmr: 4500, baseline: lowest })).toBe(
      "Signed over the 100-MMR rule: 4,500 MMR, against Team A's lowest MMR of 2,100.",
    );
    expect(freeAgentOverRuleNote({ freeAgentMmr: 0, baseline: { ...bob, mmr: null } })).toBe(
      "Signed over the 100-MMR rule: MMR unknown, replacing Bob, whose MMR is unknown.",
    );
    // Names go through the caller's escape (the Discord post's).
    expect(
      freeAgentOverRuleNote({ freeAgentMmr: 4500, baseline: bob }, (s) => `<${s}>`),
    ).toContain("replacing <Bob>'s 2,000");
  });

  it("labels each team option with its yardstick", () => {
    expect(freeAgentSeatLabel(bob)).toBe("replaces Bob, 2,000 MMR");
    expect(freeAgentSeatLabel({ ...bob, mmr: null })).toBe("replaces Bob, MMR unknown");
    expect(freeAgentSeatLabel(lowest)).toBe("lowest 2,100 MMR");
    expect(freeAgentSeatLabel({ ...lowest, mmr: null })).toBe("lowest MMR unknown");
  });
});

describe("the sign form renders the control the copy names", () => {
  const page = stripLineComments(sourceFile("src/app/admin/page.tsx").text);
  it("has the checkbox, by its field name and its exact label", () => {
    expect(FREE_AGENT_OVER_RULE_LABEL).toBe(
      `Sign over the ${STANDIN_MMR_ALLOWANCE}-MMR rule`,
    );
    expect(page).toContain(`name="${FREE_AGENT_OVER_RULE_FIELD}"`);
    expect(page).toContain(FREE_AGENT_OVER_RULE_LABEL);
  });
  it("labels the team options from the loaded baselines", () => {
    expect(page).toContain("freeAgentSeatLabel(baseline)");
    expect(page).toContain("loadFreeAgentBaselines(");
  });
});
