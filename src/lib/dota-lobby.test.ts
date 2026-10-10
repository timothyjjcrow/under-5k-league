import { describe, expect, it } from "vitest";
import { botHoldsUnlaunchedLobby, type DotaLobbyStatus } from "./dota-lobby";

describe("botHoldsUnlaunchedLobby", () => {
  // Every state the bot reports, each with its answer. `satisfies` makes a new
  // state a compile error here until someone decides whether it blocks
  // "Game over".
  const HOLDS = {
    idle: false,
    creating: true,
    ready: true,
    starting: true,
    started: false,
    // Also what an offline bot reports; its Release can't work then either.
    blocked: false,
    released: false,
  } as const satisfies Record<DotaLobbyStatus["state"], boolean>;

  it("blocks Game over while the bot holds a lobby it has not launched", () => {
    for (const [state, holds] of Object.entries(HOLDS)) {
      expect(
        botHoldsUnlaunchedLobby({ state: state as DotaLobbyStatus["state"] }),
        state,
      ).toBe(holds);
    }
  });

  it("lets a launched game through: the bot has already let the lobby go", () => {
    expect(
      botHoldsUnlaunchedLobby({
        state: "started",
        lobbyId: "123",
        matchId: "8123456789",
      }),
    ).toBe(false);
  });

  it("never blocks on an unknown answer (no bot, unreachable, not its game)", () => {
    expect(botHoldsUnlaunchedLobby(null)).toBe(false);
  });

  it("reads only the state, never the message", () => {
    expect(
      botHoldsUnlaunchedLobby({ state: "idle", message: "creating" }),
    ).toBe(false);
    expect(
      botHoldsUnlaunchedLobby({ state: "ready", message: "released" }),
    ).toBe(true);
  });
});
