import { describe, expect, it, vi } from "vitest";
vi.mock("./roster-history", () => ({ captureRosterTenure: vi.fn(), recordHistoryAction: vi.fn() }));
import { readAcceptedBids } from "./draft-history";
import { parseDraftLotExpectation } from "./draft-http";

describe("durable draft request and receipt formats", () => {
  const expectation = { draftVersion: 1000, nominatedUserId: "player", currentBid: 2,
    currentBidTeamId: "team", bidEndsAt: 2000 };

  it("retains the supplied exact lot identity and allows only explicit legacy absence", () => {
    const currentLotId = "7c213690-a025-47f3-bd40-cd6ef3f891a0";
    expect(parseDraftLotExpectation({ ...expectation, currentLotId })).toEqual({
      ok: true, value: { ...expectation, currentLotId },
    });
    expect(parseDraftLotExpectation(expectation)).toEqual({ ok: true, value: expectation });
    expect(parseDraftLotExpectation({ ...expectation, currentLotId: null })).toEqual({ ok: true, value: expectation });
    for (const currentLotId of ["", 42, {}, []]) {
      expect(parseDraftLotExpectation({ ...expectation, currentLotId }).ok).toBe(false);
    }
    // Whether absence is permitted is decided from persisted run provenance
    // in the service, not from any untrusted request's legacy flag.
    expect(parseDraftLotExpectation({ ...expectation, legacy: true })).toEqual({ ok: true, value: expectation });
  });

  it("retains all accepted receipts and rejects malformed durable snapshots", () => {
    const bids = Array.from({ length: 20 }, (_, n) => ({ bidId: `bid-${n}`, teamId: "team",
      teamName: "Team", amount: n + 1, at: "2026-09-24T00:00:00.000Z" }));
    expect(readAcceptedBids(JSON.stringify({ version: 1, provenance: "COMMAND", bids })).bids).toEqual(bids);
    expect(readAcceptedBids(JSON.stringify({ version: 1, provenance: "LEGACY_UNPARTITIONED", bids })).provenance)
      .toBe("LEGACY_UNPARTITIONED");
    for (const raw of ["[]", "{}", JSON.stringify({ version: 2, provenance: "COMMAND", bids }),
      JSON.stringify({ version: 1, provenance: "COMMAND", bids: [{ ...bids[0], amount: -1 }] }),
      JSON.stringify({ version: 1, provenance: "COMMAND", bids: [{ ...bids[0], at: "unknown" }] })]) {
      expect(() => readAcceptedBids(raw)).toThrow();
    }
  });
});
