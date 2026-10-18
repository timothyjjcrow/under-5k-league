import { describe, expect, it } from "vitest";
import {
  draftToolbarControls,
  hasToolbarControl,
  profileSyncAllowed,
  undoSaleConfirm,
  undoSaleTarget,
  voidLotConfirm,
} from "./draft-admin";
import {
  sourceFile,
  sourceFiles,
  stripLineComments,
} from "../../test/support/source-files";

const base = { seasonStatus: "DRAFT", hasSale: true };

describe("draftToolbarControls", () => {
  it("live lot: Pause only (Undo needs no open lot)", () => {
    expect(
      draftToolbarControls({ ...base, status: "IN_PROGRESS", lotLive: true }),
    ).toEqual({ pause: true, resume: false, voidLot: false, undo: false });
  });

  it("live, between lots: Pause and Undo", () => {
    expect(
      draftToolbarControls({ ...base, status: "IN_PROGRESS", lotLive: false }),
    ).toEqual({ pause: true, resume: false, voidLot: false, undo: true });
  });

  it("paused with a lot open: Resume and Void lot, no Undo", () => {
    expect(
      draftToolbarControls({ ...base, status: "PAUSED", lotLive: true }),
    ).toEqual({ pause: false, resume: true, voidLot: true, undo: false });
  });

  it("paused between lots: Resume and Undo", () => {
    expect(
      draftToolbarControls({ ...base, status: "PAUSED", lotLive: false }),
    ).toEqual({ pause: false, resume: true, voidLot: false, undo: true });
  });

  it("finished auction in the Draft phase: Undo only", () => {
    expect(
      draftToolbarControls({ ...base, status: "COMPLETE", lotLive: false }),
    ).toEqual({ pause: false, resume: false, voidLot: false, undo: true });
  });

  it("offers no Undo when nothing has sold", () => {
    const c = draftToolbarControls({
      ...base,
      hasSale: false,
      status: "COMPLETE",
      lotLive: false,
    });
    expect(c?.undo).toBe(false);
    expect(hasToolbarControl(c)).toBe(false);
  });

  it("has no bar before the auction starts or after the Draft phase", () => {
    expect(
      draftToolbarControls({ ...base, status: "NOT_STARTED", lotLive: false }),
    ).toBeNull();
    expect(
      draftToolbarControls({
        ...base,
        seasonStatus: "REGULAR_SEASON",
        status: "COMPLETE",
        lotLive: false,
      }),
    ).toBeNull();
    expect(hasToolbarControl(null)).toBe(false);
  });
});

describe("undoSaleConfirm", () => {
  const sale = { name: "Player 1", teamName: "Team 4", price: 12 };

  it("warns that undoing a finished auction reopens it on a live clock", () => {
    const text = undoSaleConfirm({ draftComplete: true, sale });
    expect(text).toContain("Player 1 → Team 4, $12");
    expect(text).toContain(
      "reopens the finished auction with a live 90-second nomination clock",
    );
    expect(text).toContain("the draft picks a player for them");
    // No control finishes a draft: say what actually ends it.
    expect(text).toContain(
      "The draft completes again on its own when the open seats are filled or the pool runs out.",
    );
    expect(text).not.toMatch(/finish the draft/i);
  });

  it("keeps the mid-auction confirm short", () => {
    const text = undoSaleConfirm({ draftComplete: false, sale });
    expect(text).toBe(
      "Undo the most recent sale (Player 1 → Team 4, $12)? The player goes back to the pool, and Team 4 gets the money back and nominates next.",
    );
    expect(text).not.toContain("reopens");
  });

  it("reads without a named sale", () => {
    expect(undoSaleConfirm({ draftComplete: true, sale: null })).toMatch(
      /^Undo the most recent auction sale\? This reopens/,
    );
    // Mid-sentence, so lowercase: "and the buying team gets the money back".
    expect(undoSaleConfirm({ draftComplete: false, sale: null })).toContain(
      "and the buying team gets the money back",
    );
    expect(undoSaleConfirm({ draftComplete: true, sale: null })).not.toContain(
      "The buying team",
    );
  });
});

describe("undoSaleTarget", () => {
  const at = (ms: number) => new Date(Date.UTC(2026, 9, 17, 20, 0, 0, ms));
  const row = (id: string, price: number, ms: number, isCaptain = false) => ({
    id,
    price,
    isCaptain,
    createdAt: at(ms),
  });

  it("picks the newest auction purchase", () => {
    expect(
      undoSaleTarget([row("a", 5, 1), row("b", 12, 3), row("c", 7, 2)])?.id,
    ).toBe("b");
  });

  it("skips $0 free-agent signings and captain rows, even newer ones", () => {
    // A bought player later made captain keeps their price; undo must never
    // take a team's captain. A $0 row is a signing, not a sale.
    expect(
      undoSaleTarget([
        row("sale", 9, 1),
        row("signing", 0, 5),
        row("captain", 57, 6, true),
      ])?.id,
    ).toBe("sale");
  });

  it("breaks a same-millisecond tie on the highest id, like undoLastSale's query", () => {
    expect(undoSaleTarget([row("aa", 3, 4), row("ab", 3, 4)])?.id).toBe("ab");
    expect(undoSaleTarget([row("ab", 3, 4), row("aa", 3, 4)])?.id).toBe("ab");
  });

  it("is null before anything has sold", () => {
    expect(undoSaleTarget([])).toBeNull();
    expect(
      undoSaleTarget([row("cap", 0, 1, true), row("fa", 0, 2)]),
    ).toBeNull();
  });
});

// Undo reverts only the sale its confirm named: the server refuses unless
// `expectedSaleMembershipId` is still the newest auction purchase. A form
// that renders the confirm without posting the id is refused on every click
// (the action reads a missing id as an out-of-date page), and a confirm that
// names a different row than the id it posts is the bug this closed.
describe("every Undo last sale form posts the sale its confirm names", () => {
  const forms = sourceFiles(
    ["src/app/**/*.tsx", "src/components/**/*.tsx"],
    100,
  )
    .map((f) => ({ path: f.path, code: stripLineComments(f.text) }))
    .filter((f) => f.code.includes("undoSaleConfirm("));
  const formCode = (path: string) =>
    forms.find((f) => f.path === path)?.code ?? "";

  it("finds both Undo surfaces (guard is not vacuous)", () => {
    expect(forms.map((f) => f.path).sort()).toEqual([
      "src/app/admin/page.tsx",
      "src/components/draft-room.tsx",
    ]);
  });

  it("/admin names and posts the row undoSaleTarget picks", () => {
    const src = formCode("src/app/admin/page.tsx");
    expect(src).toContain("undoSaleTarget(");
    expect(src).toMatch(
      /expectedSaleMembershipId: lastAuctionSale\.membershipId/,
    );
    expect(src).toMatch(/sale: lastAuctionSale,/);
  });

  it("the room names and posts the poll's undoSale, never a Recent sales row", () => {
    const src = formCode("src/components/draft-room.tsx");
    expect(src).toMatch(/expectedSaleMembershipId: undoSale\.membershipId/);
    expect(src).toMatch(/hasSale: !!state\.undoSale/);
    expect(src).not.toMatch(/recentSales\[0\]/);
    // …and the poll builds undoSale with the same rule as /admin.
    expect(
      stripLineComments(sourceFile("src/lib/draft-service.ts").text),
    ).toMatch(/const undoRow =[\s\S]{0,120}undoSaleTarget\(/);
  });
});

describe("voidLotConfirm", () => {
  it("names the player and the team that keeps the turn", () => {
    expect(
      voidLotConfirm({ playerName: "Pudge", nominatorName: "Team 2" }),
    ).toBe(
      "Void the paused lot for Pudge? Every bid on it is discarded, no sale is recorded, and Team 2 keeps the nomination turn.",
    );
  });

  it("reads without names", () => {
    expect(voidLotConfirm({ playerName: null, nominatorName: null })).toBe(
      "Void the paused lot? Every bid on it is discarded, no sale is recorded, and the same team keeps the nomination turn.",
    );
  });
});

describe("profileSyncAllowed", () => {
  it("is off while the auction is live or paused", () => {
    expect(profileSyncAllowed("IN_PROGRESS")).toBe(false);
    expect(profileSyncAllowed("PAUSED")).toBe(false);
  });

  it("is on before the auction, after it, and with no draft at all", () => {
    expect(profileSyncAllowed("NOT_STARTED")).toBe(true);
    expect(profileSyncAllowed("COMPLETE")).toBe(true);
    expect(profileSyncAllowed(null)).toBe(true);
    expect(profileSyncAllowed(undefined)).toBe(true);
  });
});
