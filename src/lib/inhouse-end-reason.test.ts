import { describe, expect, it } from "vitest";
import { INHOUSE, INHOUSE_STATUS } from "./constants";
import {
  abandonedReason,
  adminCancelReason,
  declinedReason,
  failedLobbyReason,
  nameList,
  noShowReason,
  resultVoidedReason,
  type FailedLobbyRow,
} from "./inhouse-end-reason";

describe("nameList", () => {
  it("joins names the way a sentence would", () => {
    expect(nameList([])).toBe("");
    expect(nameList(["A"])).toBe("A");
    expect(nameList(["A", "B"])).toBe("A and B");
    expect(nameList(["A", "B", "C"])).toBe("A, B and C");
  });

  it("names the first few and counts the rest", () => {
    const ten = Array.from({ length: 10 }, (_, i) => `P${i}`);
    expect(nameList(ten)).toBe("P0, P1, P2, P3, P4 and 5 more");
    expect(nameList(ten, 2)).toBe("P0, P1 and 8 more");
  });
});

describe("end reasons", () => {
  it("says who declined", () => {
    expect(declinedReason("Dendi")).toBe("Declined by Dendi");
  });

  it("names the players who didn't accept", () => {
    expect(noShowReason(["X"])).toBe("X didn't accept in time");
    expect(noShowReason(["X", "Y"])).toBe("X and Y didn't accept in time");
    // Never an empty sentence, even if the snapshot saw nobody pending.
    expect(noShowReason([])).toBe("The ready check ran out");
  });

  it("names the window a timed-out lobby had, per phase clock", () => {
    expect(abandonedReason(INHOUSE_STATUS.READY)).toBe(
      `No result ${INHOUSE.ABANDON_READY_HOURS}h after the lobby formed`,
    );
    expect(abandonedReason(INHOUSE_STATUS.IN_PROGRESS)).toBe(
      `No result ${INHOUSE.ABANDON_IN_PROGRESS_HOURS}h after the game started`,
    );
  });

  it("names a game marked over by its own window, from the Game over press", () => {
    expect(abandonedReason(INHOUSE_STATUS.AWAITING_RESULT)).toBe(
      `No result on OpenDota ${INHOUSE.ABANDON_AWAITING_RESULT_HOURS}h after the game ended`,
    );
    // Its own sentence, never the READY fallback ("after the lobby formed").
    expect(abandonedReason(INHOUSE_STATUS.AWAITING_RESULT)).not.toBe(
      abandonedReason(INHOUSE_STATUS.READY),
    );
  });

  it("says an admin gave up on a game marked over while waiting for its result", () => {
    expect(adminCancelReason("Boss", INHOUSE_STATUS.AWAITING_RESULT)).toBe(
      "Cancelled by admin Boss while waiting for the result",
    );
  });

  it("names the phase for every status an admin cancel can claim", () => {
    // The live cancel claims any active phase, and the give-up claims
    // AWAITING_RESULT: none of them may fall back to the bare sentence.
    for (const status of [
      INHOUSE_STATUS.READY_CHECK,
      INHOUSE_STATUS.CAPTAIN_VOTE,
      INHOUSE_STATUS.DRAFTING,
      INHOUSE_STATUS.READY,
      INHOUSE_STATUS.IN_PROGRESS,
      INHOUSE_STATUS.AWAITING_RESULT,
    ]) {
      expect(adminCancelReason("Boss", status), status).not.toBe(
        "Cancelled by admin Boss",
      );
    }
  });

  it("says which admin cancelled, and in which phase", () => {
    expect(adminCancelReason("Boss", INHOUSE_STATUS.READY_CHECK)).toBe(
      "Cancelled by admin Boss during the ready check",
    );
    expect(adminCancelReason("Boss", INHOUSE_STATUS.DRAFTING)).toBe(
      "Cancelled by admin Boss during the draft",
    );
    expect(adminCancelReason("Boss", INHOUSE_STATUS.READY)).toBe(
      "Cancelled by admin Boss after teams locked",
    );
    expect(adminCancelReason("Boss", INHOUSE_STATUS.IN_PROGRESS)).toBe(
      "Cancelled by admin Boss during the game",
    );
    expect(adminCancelReason("Boss", "SOMETHING_ELSE")).toBe(
      "Cancelled by admin Boss",
    );
  });

  it("keeps the voided game's match id, which the void itself clears", () => {
    expect(resultVoidedReason("Boss", "8123456789")).toBe(
      "Result voided by admin Boss (match 8123456789)",
    );
    expect(resultVoidedReason("Boss", null)).toBe(
      "Result voided by admin Boss",
    );
  });
});

describe("failedLobbyReason", () => {
  const player = (
    over: Partial<FailedLobbyRow["players"][number]> = {},
  ): FailedLobbyRow["players"][number] => ({
    acceptedAt: null,
    team: null,
    ...over,
  });
  const row = (over: Partial<FailedLobbyRow> = {}): FailedLobbyRow => ({
    endReason: null,
    startedAt: null,
    completedAt: null,
    players: Array.from({ length: 10 }, () => player()),
    ...over,
  });
  const at = new Date(0);

  it("prefers the stored reason", () => {
    expect(
      failedLobbyReason(
        row({ endReason: "Declined by Dendi", completedAt: at, startedAt: at }),
      ),
    ).toBe("Declined by Dendi");
  });

  // Lobbies that ended before reasons were stored still say how far they got,
  // from facts the rows hold — never a guessed cause.
  it("reads a void from the kept completion time", () => {
    expect(failedLobbyReason(row({ completedAt: at, startedAt: at }))).toBe(
      "Result voided (no reason saved)",
    );
  });

  it("reads a started game", () => {
    expect(failedLobbyReason(row({ startedAt: at }))).toBe(
      "Ended after the game started (no reason saved)",
    );
  });

  it("reads locked teams, a draft, and a vote from the player rows", () => {
    const drafted = Array.from({ length: 10 }, (_, i) =>
      player({ acceptedAt: at, team: (i % 2) + 1 }),
    );
    expect(failedLobbyReason(row({ players: drafted }))).toBe(
      "Ended after teams locked (no reason saved)",
    );
    const drafting = drafted.map((p, i) => (i < 4 ? p : { ...p, team: null }));
    expect(failedLobbyReason(row({ players: drafting }))).toBe(
      "Ended during the draft (no reason saved)",
    );
    const voting = drafted.map((p) => ({ ...p, team: null }));
    expect(failedLobbyReason(row({ players: voting }))).toBe(
      "Ended during the captain vote (no reason saved)",
    );
  });

  it("counts the accepts of a ready check that failed", () => {
    const players = Array.from({ length: 10 }, (_, i) =>
      player({ acceptedAt: i < 7 ? at : null }),
    );
    expect(failedLobbyReason(row({ players }))).toBe(
      "Ended in the ready check, 7 of 10 accepted (no reason saved)",
    );
  });
});
