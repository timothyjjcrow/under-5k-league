import { describe, expect, it } from "vitest";
import { sourceFile, stripLineComments } from "../../test/support/source-files";
import {
  FREE_AGENT_ACQUISITION,
  FREE_AGENT_OVER_RULE_FIELD,
  FREE_AGENT_OVER_RULE_LABEL,
  RELEASE_END_REASON,
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

/**
 * A seat on the team. By default a free-agent signing, released if it ended:
 * the two roster moves the pairing counts. `kind` and `endReason` set the
 * draft's own churn (an auction buy, a captain, an undone lot).
 */
function tenure(
  id: string,
  joined: number,
  ended: number | null,
  acquisitionMmr: number | null = null,
  opts: { kind?: string; endReason?: string } = {},
): TenureFacts {
  return {
    id,
    userId: `u-${id}`,
    name: id.toUpperCase(),
    joinedAt: at(joined),
    endedAt: ended === null ? null : at(ended),
    endReason: ended === null ? null : (opts.endReason ?? RELEASE_END_REASON),
    acquisitionKind: opts.kind ?? FREE_AGENT_ACQUISITION,
    acquisitionMmr,
  };
}

const bought = (
  id: string,
  joined: number,
  ended: number | null,
  endReason?: string,
) => tenure(id, joined, ended, null, { kind: "AUCTION", endReason });

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

  it("pairs a release made and refilled in one instant: the departure goes first", () => {
    expect(
      unrefilledDeparture([tenure("old", 0, 5), tenure("new", 5, null)]),
    ).toBeNull();
  });

  it("counts no departure for an undone lot, even when nobody re-bought the seat", () => {
    // The team bought U, the lot was undone, and U was re-sold elsewhere: the
    // team is short from the draft, judged by its lowest MMR, not by U.
    expect(
      unrefilledDeparture([
        bought("stays", 0, null),
        bought("undone", 1, 2, "DRAFT_UNDO"),
      ]),
    ).toBeNull();
    // An aborted auction's returned players are no departure either.
    expect(
      unrefilledDeparture([bought("returned", 0, 3, "DRAFT_ABORT")]),
    ).toBeNull();
  });

  it("counts no departure for a pre-draft captain change", () => {
    const captain = (id: string, joined: number, ended: number | null) =>
      tenure(id, joined, ended, null, {
        kind: "CAPTAIN_DESIGNATION",
        endReason: "PRE_DRAFT_CAPTAIN_CHANGED",
      });
    expect(
      unrefilledDeparture([captain("old", 0, 5), captain("new", 5, null)]),
    ).toBeNull();
    // Even with the incoming captain's seat out of the picture.
    expect(unrefilledDeparture([captain("old", 0, 5)])).toBeNull();
    expect(
      unrefilledDeparture([
        tenure("removed", 0, 4, null, {
          kind: "CAPTAIN_DESIGNATION",
          endReason: "PRE_DRAFT_TEAM_REMOVED",
        }),
      ]),
    ).toBeNull();
  });

  it("refills only with a free-agent signing, never with an auction buy", () => {
    // A bought player was released after the draft; an auction tenure that
    // happens to sort later is not a signing and refills nothing.
    expect(
      unrefilledDeparture([
        bought("released", 0, 10, RELEASE_END_REASON),
        bought("late-row", 20, null),
      ])?.id,
    ).toBe("released");
  });

  it("pairs a release with the free-agent signing after it, around the draft's churn", () => {
    const tenures = [
      bought("undone", 0, 1, "DRAFT_UNDO"),
      bought("bob", 2, 10, RELEASE_END_REASON),
      bought("stays", 2, null),
    ];
    expect(unrefilledDeparture(tenures)?.id).toBe("bob");
    expect(unrefilledDeparture([...tenures, tenure("signed", 20, null)])).toBeNull();
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

  it("is the team's lowest MMR when the only seat that ended was an undone lot", () => {
    expect(
      freeAgentBaseline({
        teamName: "T",
        tenures: [
          { ...bought("a", 0, 1, "DRAFT_UNDO"), acquisitionMmr: 1500 },
        ],
        rosterUserIds: ["x", "y"],
        signupMmr,
      }),
    ).toEqual({ kind: "lowest", teamName: "T", mmr: 2100 });
  });
});

describe("the pairing reads the reasons the roster moves write", () => {
  const roster = stripLineComments(
    sourceFile("src/app/actions/admin-roster.ts").text,
  );
  it("releasePlayer closes the seat with the release reason", () => {
    expect(roster).toContain(
      `closeRosterTenure(tx, member, "${RELEASE_END_REASON}"`,
    );
  });
  it("signFreeAgent opens the seat as a free-agent acquisition", () => {
    expect(roster).toContain(`kind: "${FREE_AGENT_ACQUISITION}"`);
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
  it("words each free agent's MMR like the team options, unknown as unknown", () => {
    expect(page).toContain("{p.user.name} ({standinMmrLabel(p.mmr)})");
    // Never the raw number: an unknown read "(0 MMR)" and 4500 lost its comma.
    expect(page).not.toContain("({p.mmr} MMR)");
  });
});
