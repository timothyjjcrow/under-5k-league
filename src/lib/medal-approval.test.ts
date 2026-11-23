import { describe, expect, it } from "vitest";
import { sourceFile, stripLineComments } from "../../test/support/source-files";
import { MEDAL_APPROVAL_STATUS } from "./constants";
import {
  MEDAL_APPROVAL_MMR_MAX,
  MEDAL_APPROVAL_NOTE_MAX,
  approvedMedalMmr,
  defaultApprovalMmr,
  medalApprovalAskRefusal,
  medalApprovalDecidedDm,
  medalApprovalRequestedDm,
  medalApprovalView,
  medalLimitLine,
  parseApprovalMmr,
  parseMedalApprovalNote,
} from "./medal-approval";
import { sortMedalApprovalRows } from "./medal-approval-service";

const { PENDING, APPROVED, DECLINED } = MEDAL_APPROVAL_STATUS;

describe("approvedMedalMmr — what an approval lets in", () => {
  it("is the admin's number only while the row is APPROVED", () => {
    expect(approvedMedalMmr({ status: APPROVED, mmr: 5020 })).toBe(5020);
    expect(approvedMedalMmr({ status: PENDING, mmr: null })).toBeNull();
    expect(approvedMedalMmr({ status: DECLINED, mmr: 5020 })).toBeNull();
    expect(approvedMedalMmr(null)).toBeNull();
  });

  it("reads a number the admin form could never save as no approval", () => {
    for (const mmr of [null, 0, -1, 4500.5, MEDAL_APPROVAL_MMR_MAX + 1]) {
      expect(approvedMedalMmr({ status: APPROVED, mmr }), String(mmr)).toBeNull();
    }
  });
});

describe("medalApprovalAskRefusal — who may ask", () => {
  it("lets a player over the medal line ask once", () => {
    for (const rankTier of [73, 74, 75, 80]) {
      expect(
        medalApprovalAskRefusal({ rankTier, existingStatus: null }),
        `tier ${rankTier}`,
      ).toBeNull();
    }
  });

  it("refuses a medal under the line, or none: nothing refuses them", () => {
    for (const rankTier of [null, 0, 45, 72]) {
      expect(
        medalApprovalAskRefusal({ rankTier, existingStatus: null }),
      ).toMatch(/nothing to approve/);
    }
  });

  it("answers a second ask from the row it already has", () => {
    expect(
      medalApprovalAskRefusal({ rankTier: 75, existingStatus: PENDING }),
    ).toMatch(/already asked/);
    expect(
      medalApprovalAskRefusal({ rankTier: 75, existingStatus: APPROVED }),
    ).toMatch(/already approved/);
    expect(
      medalApprovalAskRefusal({ rankTier: 75, existingStatus: DECLINED }),
    ).toMatch(/declined/);
  });
});

describe("the forms", () => {
  it("keeps a note single-spaced and short", () => {
    expect(parseMedalApprovalNote("  my medal\n\nis old  ")).toBe("my medal is old");
    expect(parseMedalApprovalNote("x".repeat(500))).toHaveLength(MEDAL_APPROVAL_NOTE_MAX);
  });

  it("takes a whole MMR from 1 to the max", () => {
    expect(parseApprovalMmr(" 5020 ")).toEqual({ ok: true, mmr: 5020 });
    for (const raw of ["", "0", "-5", "4500.5", "abc", String(MEDAL_APPROVAL_MMR_MAX + 1)]) {
      expect(parseApprovalMmr(raw).ok, raw).toBe(false);
    }
  });

  it("starts the Approve box at the medal's exact floor", () => {
    expect(defaultApprovalMmr(73)).toBe(5020);
    expect(defaultApprovalMmr(75)).toBe(5420);
    expect(defaultApprovalMmr(80)).toBe(5620);
    expect(defaultApprovalMmr(null)).toBeNull();
  });
});

describe("medalApprovalView — the player's card", () => {
  it("walks ask, pending, approved, declined", () => {
    expect(medalApprovalView({ rankTier: 75, approval: null })).toEqual({
      kind: "ask",
      medal: "Divine 5",
    });
    expect(
      medalApprovalView({ rankTier: 75, approval: { status: PENDING, mmr: null } }),
    ).toEqual({ kind: "pending", medal: "Divine 5" });
    expect(
      medalApprovalView({ rankTier: 75, approval: { status: APPROVED, mmr: 5420 } }),
    ).toEqual({ kind: "approved", mmr: 5420 });
    expect(
      medalApprovalView({ rankTier: 75, approval: { status: DECLINED, mmr: null } }),
    ).toEqual({ kind: "declined", medal: "Divine 5" });
  });

  it("keeps showing an approval once the medal drops, since it still sets the MMR", () => {
    expect(
      medalApprovalView({ rankTier: 71, approval: { status: APPROVED, mmr: 4800 } }),
    ).toEqual({ kind: "approved", mmr: 4800 });
  });

  it("shows nothing when the medal refuses nobody and nothing was approved", () => {
    expect(medalApprovalView({ rankTier: 72, approval: null })).toEqual({ kind: "none" });
    expect(
      medalApprovalView({ rankTier: 72, approval: { status: DECLINED, mmr: null } }),
    ).toEqual({ kind: "none" });
  });
});

describe("the bot's messages", () => {
  it("escapes the player's name and note, and links the admin section", () => {
    const dm = medalApprovalRequestedDm({
      playerName: "**boss**",
      rankTier: 75,
      note: "[click](https://x.y) @everyone",
      adminUrl: "https://ggd2l.example/admin#adm-medal-approvals",
    });
    expect(dm).not.toContain("**boss**");
    expect(dm).not.toContain("[click](");
    expect(dm).toContain("Divine 5");
    expect(dm).toContain("https://ggd2l.example/admin#adm-medal-approvals");
  });

  it("tells the player the number they were approved at", () => {
    expect(
      medalApprovalDecidedDm({ approved: true, mmr: 5020, meUrl: "https://x/me" }),
    ).toMatch(/at 5,020 MMR/);
    expect(
      medalApprovalDecidedDm({ approved: false, mmr: null, meUrl: "https://x/me" }),
    ).toMatch(/declined/);
  });
});

describe("medalLimitLine — the card's line under its title", () => {
  it("tells a player who isn't signed up that the medal turns them away", () => {
    expect(medalLimitLine("Divine 3", false)).toBe(
      "Your Divine 3 medal is over the league's 5,000 MMR line, so league signups and inhouses turn it away. An admin can approve you anyway, at an MMR they set.",
    );
  });

  it("tells a signed-up player their signup stays and the ask is for inhouses", () => {
    expect(medalLimitLine("Divine 3", true)).toBe(
      "Your Divine 3 medal is over the league's 5,000 MMR line. You're already signed up, so your signup stays, though an admin may ask you about your MMR. Inhouses turn the medal away: ask an admin here if you want to play them.",
    );
  });

  it("is what the card shows, with /me saying whether they're signed up", () => {
    const card = stripLineComments(sourceFile("src/components/medal-approval-card.tsx").text);
    expect(card).toMatch(/medalLimitLine\(view\.medal, signedUp\)/);
    const me = stripLineComments(sourceFile("src/app/me/page.tsx").text);
    expect(me).toMatch(/<MedalApprovalCard view=\{medalView\} signedUp=\{isRegistered\} \/>/);
  });
});

describe("sortMedalApprovalRows — the admin's list", () => {
  it("puts waiting requests first, oldest first, then the newest answers", () => {
    const at = (ms: number) => new Date(ms);
    const rows = sortMedalApprovalRows([
      { id: "a", status: APPROVED, requestedAt: at(1), decidedAt: at(10) },
      { id: "b", status: PENDING, requestedAt: at(5), decidedAt: null },
      { id: "c", status: DECLINED, requestedAt: at(2), decidedAt: at(20) },
      { id: "d", status: PENDING, requestedAt: at(3), decidedAt: null },
    ]);
    expect(rows.map((r) => r.id)).toEqual(["d", "b", "c", "a"]);
  });
});

describe("source guards", () => {
  it("re-reads the approval inside the signup's and the join's transactions", () => {
    const signup = stripLineComments(sourceFile("src/app/actions/registration.ts").text);
    expect(signup).toMatch(/tx\.medalApproval\.findUnique/);
    expect(signup).toMatch(/approvedMedalMmr\(currentApproval\) !== approvedMmr/);
    const join = stripLineComments(sourceFile("src/lib/inhouse-service.ts").text);
    expect(join).toMatch(/tx\.medalApproval\.findUnique/);
  });

  it("DMs only after the commit, never inside a service", () => {
    const service = stripLineComments(sourceFile("src/lib/medal-approval-service.ts").text);
    expect(service).not.toMatch(/sendDirectMessage/);
  });
});
