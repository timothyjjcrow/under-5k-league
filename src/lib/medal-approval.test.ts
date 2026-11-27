import { describe, expect, it } from "vitest";
import { sourceFile, stripLineComments } from "../../test/support/source-files";
import { APPROVAL_REASON, MEDAL_APPROVAL_STATUS } from "./constants";
import {
  MEDAL_APPROVAL_MMR_MAX,
  MEDAL_APPROVAL_NOTE_MAX,
  approvalAskPlan,
  approvalCoversMedal,
  approvalStanding,
  approvedMedalLine,
  approvedMedalMmr,
  defaultApprovalMmr,
  medalApprovalDecidedDm,
  medalApprovalRequestedDm,
  medalApprovalView,
  medalApprovedMessage,
  medalLimitLine,
  parseApprovalMmr,
  parseMedalApprovalNote,
  reasonOnApprove,
  smurfCheckLine,
} from "./medal-approval";
import { sortMedalApprovalRows } from "./medal-approval-service";
import type { SmurfSignal } from "./smurf-check";

const { PENDING, APPROVED, DECLINED } = MEDAL_APPROVAL_STATUS;
const { MEDAL, SMURF } = APPROVAL_REASON;
const YOUNG: SmurfSignal = {
  key: "young-account",
  line: "only 190 games on the account, few for a Legend 5 medal",
};

describe("approvedMedalMmr — what an approval lets in", () => {
  it("is the admin's number only while the row is APPROVED", () => {
    expect(approvedMedalMmr({ status: APPROVED, mmr: 5020, reason: MEDAL })).toBe(5020);
    expect(approvedMedalMmr({ status: PENDING, mmr: null, reason: MEDAL })).toBeNull();
    expect(approvedMedalMmr({ status: DECLINED, mmr: 5020, reason: MEDAL })).toBeNull();
    expect(approvedMedalMmr(null)).toBeNull();
  });

  it("reads a number the admin form could never save as no approval", () => {
    for (const mmr of [null, 0, -1, 4500.5, MEDAL_APPROVAL_MMR_MAX + 1]) {
      expect(
        approvedMedalMmr({ status: APPROVED, mmr, reason: MEDAL }),
        String(mmr),
      ).toBeNull();
    }
  });

  it("sets the number for either reason, but only a medal approval lets a medal in", () => {
    const smurf = { status: APPROVED, mmr: 4200, reason: SMURF };
    const medal = { status: APPROVED, mmr: 5020, reason: MEDAL };
    expect(approvedMedalMmr(smurf)).toBe(4200);
    expect(approvalCoversMedal(smurf)).toBe(false);
    expect(approvalCoversMedal(medal)).toBe(true);
    expect(approvalCoversMedal({ ...medal, status: PENDING })).toBe(false);
    // A hand-edited reason is no medal approval.
    expect(approvalCoversMedal({ ...medal, reason: "medal" })).toBe(false);
    expect(approvalStanding(smurf)).toEqual({ mmr: 4200, coversMedal: false });
    expect(approvalStanding(null)).toEqual({ mmr: null, coversMedal: false });
  });
});

describe("approvalAskPlan — who may ask, and for what", () => {
  it("lets a player over the medal line ask once, for the medal", () => {
    for (const rankTier of [73, 74, 75, 80]) {
      expect(
        approvalAskPlan({ rankTier, signals: [YOUNG], existing: null }),
        `tier ${rankTier}`,
      ).toEqual({ kind: "create", reason: MEDAL });
    }
  });

  it("lets a player the smurf check flags ask for a smurf check", () => {
    expect(approvalAskPlan({ rankTier: 55, signals: [YOUNG], existing: null })).toEqual({
      kind: "create",
      reason: SMURF,
    });
  });

  it("refuses when neither the medal nor the check refuses them", () => {
    for (const rankTier of [null, 0, 45, 72]) {
      const plan = approvalAskPlan({ rankTier, signals: [], existing: null });
      expect(plan.kind).toBe("refuse");
      expect(plan.kind === "refuse" && plan.error).toMatch(/nothing to approve/);
    }
  });

  it("answers a second ask from the row it already has", () => {
    const error = (status: string, reason: string = MEDAL) => {
      const plan = approvalAskPlan({
        rankTier: 75,
        signals: [],
        existing: { status, reason },
      });
      return plan.kind === "refuse" ? plan.error : plan.kind;
    };
    expect(error(PENDING)).toMatch(/already asked/);
    expect(error(APPROVED)).toMatch(/already approved/);
    expect(error(DECLINED)).toMatch(/declined/);
    expect(error(PENDING, SMURF)).toMatch(/already asked/);
  });

  it("turns a smurf check's approval into a medal request once the medal is over the line", () => {
    expect(
      approvalAskPlan({
        rankTier: 73,
        signals: [],
        existing: { status: APPROVED, reason: SMURF },
      }),
    ).toEqual({ kind: "convert", reason: MEDAL });
    // Under the line the smurf approval still stands.
    expect(
      approvalAskPlan({
        rankTier: 72,
        signals: [YOUNG],
        existing: { status: APPROVED, reason: SMURF },
      }).kind,
    ).toBe("refuse");
  });

  it("records an approval as the medal's when the medal is over the line now", () => {
    expect(reasonOnApprove(SMURF, 73)).toBe(MEDAL);
    expect(reasonOnApprove(SMURF, 72)).toBe(SMURF);
    expect(reasonOnApprove(MEDAL, 50)).toBe(MEDAL);
    expect(reasonOnApprove("garbage", null)).toBe(MEDAL);
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
  const medal = { reason: MEDAL, medal: "Divine 5", signals: [] };
  it("walks ask, pending, approved, declined", () => {
    expect(medalApprovalView({ rankTier: 75, approval: null })).toEqual({
      kind: "ask",
      ...medal,
    });
    expect(
      medalApprovalView({
        rankTier: 75,
        approval: { status: PENDING, mmr: null, reason: MEDAL },
      }),
    ).toEqual({ kind: "pending", ...medal });
    expect(
      medalApprovalView({
        rankTier: 75,
        approval: { status: APPROVED, mmr: 5420, reason: MEDAL },
      }),
    ).toEqual({ kind: "approved", reason: MEDAL, mmr: 5420 });
    expect(
      medalApprovalView({
        rankTier: 75,
        approval: { status: DECLINED, mmr: null, reason: MEDAL },
      }),
    ).toEqual({ kind: "declined", ...medal });
  });

  it("keeps showing an approval once the medal drops, since it still sets the MMR", () => {
    expect(
      medalApprovalView({
        rankTier: 71,
        approval: { status: APPROVED, mmr: 4800, reason: MEDAL },
      }),
    ).toEqual({ kind: "approved", reason: MEDAL, mmr: 4800 });
  });

  it("shows nothing when the medal refuses nobody and nothing was approved", () => {
    expect(medalApprovalView({ rankTier: 72, approval: null })).toEqual({ kind: "none" });
    expect(
      medalApprovalView({
        rankTier: 72,
        approval: { status: DECLINED, mmr: null, reason: MEDAL },
      }),
    ).toEqual({ kind: "none" });
  });

  it("asks for a smurf check only where the check would stop them", () => {
    expect(
      medalApprovalView({ rankTier: 55, approval: null, signals: [YOUNG], smurfMatters: true }),
    ).toEqual({ kind: "ask", reason: SMURF, medal: "Legend 5", signals: [YOUNG] });
    // Already in everywhere: the admin's signup list flags them instead.
    expect(
      medalApprovalView({ rankTier: 55, approval: null, signals: [YOUNG], smurfMatters: false }),
    ).toEqual({ kind: "none" });
    expect(
      medalApprovalView({
        rankTier: 55,
        approval: { status: APPROVED, mmr: 4200, reason: SMURF },
        signals: [YOUNG],
        smurfMatters: true,
      }),
    ).toEqual({ kind: "approved", reason: SMURF, mmr: 4200 });
  });

  it("asks again when a smurf check's approval sits under a medal now over the line", () => {
    expect(
      medalApprovalView({
        rankTier: 73,
        approval: { status: APPROVED, mmr: 4200, reason: SMURF },
      }),
    ).toEqual({ kind: "ask", reason: MEDAL, medal: "Divine 3", signals: [] });
  });
});

describe("the smurf check's words", () => {
  it("names what the check found and where it stops them", () => {
    expect(smurfCheckLine([YOUNG], false)).toBe(
      "The smurf check found: only 190 games on the account, few for a Legend 5 medal. An admin has to look at your account before you sign up or play your first inhouse, and sets the MMR you play at.",
    );
    expect(smurfCheckLine([YOUNG], true)).toMatch(/your signup stays, but your first inhouse waits/);
  });

  it("says which kind of approval it was", () => {
    expect(approvedMedalLine(4200, SMURF)).toMatch(/^An admin checked your account and approved you at 4,200 MMR/);
    expect(approvedMedalLine(5020)).toMatch(/^An admin approved you over the medal limit at 5,020 MMR/);
    expect(medalApprovedMessage("Zai", 4200, SMURF)).toBe(
      "Zai passed the smurf check at 4,200 MMR: they can sign up for the league and join inhouses.",
    );
  });
});

describe("the bot's messages", () => {
  it("escapes the player's name and note, and links the admin section", () => {
    const dm = medalApprovalRequestedDm({
      playerName: "**boss**",
      rankTier: 75,
      note: "[click](https://x.y) @everyone",
      adminUrl: "https://ggd2l.example/admin/people#adm-medal-approvals",
    });
    expect(dm).not.toContain("**boss**");
    expect(dm).not.toContain("[click](");
    expect(dm).toContain("Divine 5");
    expect(dm).toContain("https://ggd2l.example/admin/people#adm-medal-approvals");
  });

  it("tells the admins what the smurf check found", () => {
    const dm = medalApprovalRequestedDm({
      playerName: "Zai",
      rankTier: 55,
      note: "",
      adminUrl: "https://x/admin",
      reason: SMURF,
      signals: [YOUNG],
    });
    expect(dm).toBe(
      "🔎 **Zai** (Legend 5) asks for a smurf check. It found: only 190 games on the account, few for a Legend 5 medal.\nApprove at an MMR you set, or decline: https://x/admin",
    );
  });

  it("tells the player the number they were approved at", () => {
    expect(
      medalApprovalDecidedDm({ approved: true, mmr: 5020, meUrl: "https://x/me" }),
    ).toMatch(/at 5,020 MMR/);
    expect(
      medalApprovalDecidedDm({ approved: false, mmr: null, meUrl: "https://x/me" }),
    ).toMatch(/declined/);
    expect(
      medalApprovalDecidedDm({ approved: true, mmr: 4200, meUrl: "https://x/me", reason: SMURF }),
    ).toMatch(/checked your account and approved you at 4,200 MMR/);
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
    expect(card).toMatch(/smurfCheckLine\(view\.signals, signedUp\)/);
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
    expect(signup).toMatch(/approvalStanding\(currentApproval\)/);
    expect(signup).toMatch(
      /standing\.mmr !== approvedMmr \|\| standing\.coversMedal !== coversMedal/,
    );
    const join = stripLineComments(sourceFile("src/lib/inhouse-service.ts").text);
    expect(join).toMatch(/tx\.medalApproval\.findUnique/);
    expect(join).toMatch(
      /standing\.mmr !== approvedMmr \|\| standing\.coversMedal !== coversMedal/,
    );
  });

  it("DMs only after the commit, never inside a service", () => {
    const service = stripLineComments(sourceFile("src/lib/medal-approval-service.ts").text);
    expect(service).not.toMatch(/sendDirectMessage/);
  });
});
