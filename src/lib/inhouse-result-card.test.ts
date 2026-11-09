import { describe, expect, it } from "vitest";
import {
  resultCardMvp,
  resultCardRequeued,
  resultCardTeams,
} from "./inhouse-result-card";

const roster = (radiantTeam: 1 | 2 = 1) => ({
  players: [
    { userId: "a2", team: 1, isCaptain: false, name: "A2" },
    { userId: "a1", team: 1, isCaptain: true, name: "A1" },
    { userId: "b1", team: 2, isCaptain: true, name: "B1" },
    { userId: "b2", team: 2, isCaptain: false, name: "B2" },
    // Never drafted onto a side: on neither team's list.
    { userId: "pool", team: null, isCaptain: false, name: "Pool" },
  ],
  radiantTeam,
  winnerTeam: 2,
  eloDeltas: JSON.stringify({ a1: -12, a2: -14, b1: 13, b2: "lots" }),
});

describe("resultCardTeams", () => {
  it("lists Radiant first, captain first, with who won", () => {
    const [radiant, dire] = resultCardTeams(roster(1));
    expect([radiant.isRadiant, radiant.won]).toEqual([true, false]);
    expect([dire.isRadiant, dire.won]).toEqual([false, true]);
    expect(radiant.players.map((p) => p.name)).toEqual(["A1", "A2"]);
    expect(dire.players.map((p) => p.name)).toEqual(["B1", "B2"]);
  });

  it("puts team 2 first when it drew Radiant", () => {
    const [radiant, dire] = resultCardTeams(roster(2));
    expect(radiant.players.map((p) => p.name)).toEqual(["B1", "B2"]);
    expect([radiant.won, dire.won]).toEqual([true, false]);
  });

  it("carries each stored Elo change, and unknown for anything else", () => {
    const [radiant, dire] = resultCardTeams(roster(1));
    expect(radiant.players.map((p) => p.eloDelta)).toEqual([-12, -14]);
    // A value that isn't a number is unknown, never zero.
    expect(dire.players.map((p) => p.eloDelta)).toEqual([13, null]);
    const broken = resultCardTeams({ ...roster(1), eloDeltas: "{nope" });
    expect(broken.flatMap((t) => t.players.map((p) => p.eloDelta))).toEqual([
      null,
      null,
      null,
      null,
    ]);
    const array = resultCardTeams({ ...roster(1), eloDeltas: "[1,2]" });
    expect(array[0].players[0].eloDelta).toBeNull();
  });
});

describe("resultCardMvp", () => {
  const line = (
    userId: string | null,
    isRadiant: boolean,
    kills: number,
    over: Record<string, unknown> = {},
  ) => ({
    userId,
    name: userId ? `Name ${userId}` : null,
    team: isRadiant ? 1 : 2,
    isRadiant,
    heroId: 1,
    kills,
    deaths: 2,
    assists: 5,
    netWorth: 10_000,
    gpm: 400,
    lastHits: 100,
    ...over,
  });

  it("names the best line of a known player, with their hero", () => {
    const boxScore = JSON.stringify([
      line("u1", true, 3),
      line("u2", true, 15),
      line(null, false, 40),
      line("u3", false, 4),
    ]);
    expect(resultCardMvp({ boxScore, radiantWin: true })).toEqual({
      userId: "u2",
      name: "Name u2",
      hero: "Anti-Mage",
    });
  });

  it("is null with no box score, an unreadable one, or no known player", () => {
    expect(resultCardMvp({ boxScore: "[]", radiantWin: true })).toBeNull();
    expect(resultCardMvp({ boxScore: "{broken", radiantWin: true })).toBeNull();
    const strangers = JSON.stringify([line(null, true, 9), line(null, false, 2)]);
    expect(resultCardMvp({ boxScore: strangers, radiantWin: true })).toBeNull();
  });

  it("is null when the MVP's line has no name: never a blank", () => {
    const boxScore = JSON.stringify([line("u1", true, 9, { name: null })]);
    expect(resultCardMvp({ boxScore, radiantWin: true })).toBeNull();
  });
});

describe("resultCardRequeued", () => {
  it("counts the game's own players who are back in the queue, once each", () => {
    const teams = resultCardTeams(roster(1));
    expect(resultCardRequeued(teams, ["a1", "b2", "stranger", "a1"])).toEqual({
      back: 2,
      total: 4,
    });
    expect(resultCardRequeued(teams, [])).toEqual({ back: 0, total: 4 });
  });
});
