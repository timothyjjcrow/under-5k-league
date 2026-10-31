import { describe, expect, it } from "vitest";
import { INHOUSE_STATUS } from "./constants";
import { orderCaptains, tallyMethod } from "./inhouse";
import {
  captainsChosenToast,
  draftTurn,
  draftTurnText,
  draftedToast,
  inhousePickOrder,
  inhouseSetupPath,
  lastDraftPick,
  projectedCaptains,
  readyCheckHeading,
  voteProjectionText,
} from "./inhouse-room-view";

const candidate = (
  userId: string,
  mmr: number,
  extra: Partial<{ nominations: number; wins: number; games: number }> = {},
) => ({
  userId,
  name: userId.toUpperCase(),
  mmr,
  joinedAt: 0,
  nominations: extra.nominations ?? 0,
  wins: extra.wins ?? 0,
  games: extra.games ?? 0,
  winRate: extra.games ? (extra.wins ?? 0) / extra.games : 0,
});

describe("readyCheckHeading", () => {
  it("asks only until the viewer accepts, then says who it waits on", () => {
    expect(
      readyCheckHeading({ canAccept: true, hasAccepted: false, waitingOn: 4 }),
    ).toBe("Match found. You in?");
    expect(
      readyCheckHeading({ canAccept: true, hasAccepted: true, waitingOn: 4 }),
    ).toBe("You’re in — waiting on 4");
    expect(
      readyCheckHeading({ canAccept: true, hasAccepted: true, waitingOn: 0 }),
    ).toBe("Everyone’s in");
    expect(
      readyCheckHeading({ canAccept: false, hasAccepted: false, waitingOn: 3 }),
    ).toBe("A match is filling up");
  });
});

describe("projectedCaptains", () => {
  const candidates = [
    candidate("a", 4000, { wins: 1, games: 3 }),
    candidate("b", 4800),
    candidate("c", 4500, { nominations: 2 }),
    candidate("d", 3000, { wins: 3, games: 3 }),
  ];

  it("with no votes, names MMR's default pair", () => {
    const p = projectedCaptains({
      candidates,
      methodTallies: { VOTE: 0, MMR: 0, RECORD: 0 },
    });
    expect(p.method).toBe("MMR");
    expect(p.byDefault).toBe(true);
    expect(p.captains?.map((c) => c.userId)).toEqual(["b", "c"]);
  });

  it("follows tallyMethod's winner and tie order, and orderCaptains' pair", () => {
    for (const tallies of [
      { VOTE: 2, MMR: 3, RECORD: 1 },
      { VOTE: 2, MMR: 2, RECORD: 0 },
      { VOTE: 0, MMR: 1, RECORD: 1 },
      { VOTE: 1, MMR: 0, RECORD: 0 },
    ]) {
      const p = projectedCaptains({ candidates, methodTallies: tallies });
      const ballots = Object.entries(tallies).flatMap(([m, n]) =>
        Array(n).fill(m),
      );
      expect(p.method).toBe(tallyMethod(ballots));
      expect(p.votes).toBe(tallies[p.method]);
      expect(p.byDefault).toBe(false);
      expect(p.captains?.map((c) => c.userId)).toEqual(
        orderCaptains(p.method, candidates)
          .slice(0, 2)
          .map((c) => c.userId),
      );
    }
  });

  it("names no pair when fewer than two players are in the vote", () => {
    expect(
      projectedCaptains({
        candidates: [candidate("a", 1)],
        methodTallies: { VOTE: 0, MMR: 1, RECORD: 0 },
      }).captains,
    ).toBeNull();
  });
});

describe("voteProjectionText", () => {
  const captains: [{ name: string }, { name: string }] = [
    { name: "Ana" },
    { name: "Ceb" },
  ];
  it("says the leader, its votes and the pair with their sides", () => {
    expect(
      voteProjectionText({ method: "MMR", votes: 3, byDefault: false, captains }),
    ).toBe("Highest MMR leads with 3 votes: Ana (Radiant) vs Ceb (Dire).");
    expect(
      voteProjectionText({ method: "VOTE", votes: 1, byDefault: false, captains }),
    ).toBe("Elect captains leads with 1 vote: Ana (Radiant) vs Ceb (Dire).");
  });
  it("says a default is a default", () => {
    expect(
      voteProjectionText({ method: "MMR", votes: 0, byDefault: true, captains }),
    ).toBe("No votes yet, so Highest MMR decides: Ana (Radiant) vs Ceb (Dire).");
    expect(
      voteProjectionText({ method: "MMR", votes: 0, byDefault: true, captains: null }),
    ).toBe("No votes yet, so Highest MMR decides.");
  });
});

describe("inhousePickOrder", () => {
  it("walks nextPickTeam's snake: one, then pairs, ending on one", () => {
    expect(inhousePickOrder(5, 2)).toEqual([2, 1, 1, 2, 2, 1, 1, 2]);
    expect(inhousePickOrder(5, 1)).toEqual([1, 2, 2, 1, 1, 2, 2, 1]);
    expect(inhousePickOrder(1, 2)).toEqual([]);
  });
});

describe("draftTurn", () => {
  const order = inhousePickOrder(5, 2); // 2 1 1 2 2 1 1 2

  it("is nobody's for a viewer who isn't a captain", () => {
    expect(
      draftTurn({ order, picksMade: 0, pickTeam: 2, myCaptainTeam: null }),
    ).toBeNull();
  });

  it("counts a captain's picks in a row while they're on the clock", () => {
    expect(
      draftTurn({ order, picksMade: 0, pickTeam: 2, myCaptainTeam: 2 }),
    ).toEqual({ kind: "mine", pick: 1, of: 1 });
    expect(
      draftTurn({ order, picksMade: 1, pickTeam: 1, myCaptainTeam: 1 }),
    ).toEqual({ kind: "mine", pick: 1, of: 2 });
    expect(
      draftTurn({ order, picksMade: 2, pickTeam: 1, myCaptainTeam: 1 }),
    ).toEqual({ kind: "mine", pick: 2, of: 2 });
    expect(
      draftTurn({ order, picksMade: 7, pickTeam: 2, myCaptainTeam: 2 }),
    ).toEqual({ kind: "mine", pick: 1, of: 1 });
  });

  it("says how soon the other captain picks, and how many", () => {
    expect(
      draftTurn({ order, picksMade: 0, pickTeam: 2, myCaptainTeam: 1 }),
    ).toEqual({ kind: "next", picks: 2, wait: 1 });
    expect(
      draftTurn({ order, picksMade: 1, pickTeam: 1, myCaptainTeam: 2 }),
    ).toEqual({ kind: "next", picks: 2, wait: 2 });
    expect(
      draftTurn({ order, picksMade: 6, pickTeam: 1, myCaptainTeam: 2 }),
    ).toEqual({ kind: "next", picks: 1, wait: 1 });
  });

  it("trusts the server's turn over the order, and ends with the side's picks", () => {
    expect(
      draftTurn({ order, picksMade: 0, pickTeam: 1, myCaptainTeam: 1 }),
    ).toEqual({ kind: "mine", pick: 1, of: 1 });
    expect(
      draftTurn({ order, picksMade: 7, pickTeam: 2, myCaptainTeam: 1 }),
    ).toBeNull();
  });
});

describe("draftTurnText", () => {
  it("words each turn", () => {
    expect(draftTurnText({ kind: "mine", pick: 1, of: 1 })).toBe(
      "You’re on the clock",
    );
    expect(draftTurnText({ kind: "mine", pick: 2, of: 2 })).toBe(
      "You’re on the clock — pick 2 of 2",
    );
    expect(draftTurnText({ kind: "next", picks: 2, wait: 1 })).toBe(
      "You’re up next — 2 picks",
    );
    expect(draftTurnText({ kind: "next", picks: 1, wait: 2 })).toBe(
      "You pick again in 2 picks — 1 pick",
    );
    expect(draftTurnText(null)).toBeNull();
  });
});

const player = (userId: string, pickIndex: number | null) => ({
  userId,
  name: userId.toUpperCase(),
  pickIndex,
});
const teams = [
  {
    team: 1,
    isRadiant: true,
    captain: player("cap1", null),
    players: [player("p2", 1), player("p3", 2)],
  },
  {
    team: 2,
    isRadiant: false,
    captain: player("cap2", null),
    players: [player("p1", 0), player("p4", 3)],
  },
];

describe("lastDraftPick", () => {
  it("finds the highest pick index on either side", () => {
    const last = lastDraftPick(teams);
    expect(last?.player.userId).toBe("p4");
    expect(last?.team.team).toBe(2);
  });
  it("is null before the first pick", () => {
    expect(
      lastDraftPick([{ ...teams[0], players: [] }, { ...teams[1], players: [] }]),
    ).toBeNull();
  });
});

describe("draftedToast", () => {
  const lobby = { id: "L", status: INHOUSE_STATUS.DRAFTING, teams };

  it("tells a drafted player their side, captain and pick", () => {
    expect(
      draftedToast(
        { lobbyId: "L", myTeam: null },
        { myTeam: 1, isCaptain: false, userId: "p3" },
        lobby,
      ),
    ).toBe("You’re on Radiant — drafted by CAP1 (pick 3).");
    // The last pool player lands on the poll that shows teams locked.
    expect(
      draftedToast(
        { lobbyId: "L", myTeam: null },
        { myTeam: 2, isCaptain: false, userId: "p4" },
        { ...lobby, status: INHOUSE_STATUS.READY },
      ),
    ).toBe("You’re on Dire — drafted by CAP2 (pick 4).");
  });

  it("stays quiet on a first poll, for captains, and across games", () => {
    const next = { myTeam: 1, isCaptain: false, userId: "p3" };
    expect(draftedToast(null, next, lobby)).toBeNull();
    expect(
      draftedToast({ lobbyId: "L", myTeam: 1 }, next, lobby),
    ).toBeNull();
    expect(
      draftedToast(
        { lobbyId: "L", myTeam: null },
        { ...next, isCaptain: true },
        lobby,
      ),
    ).toBeNull();
    expect(
      draftedToast({ lobbyId: "OTHER", myTeam: null }, next, lobby),
    ).toBeNull();
    expect(
      draftedToast(
        { lobbyId: "L", myTeam: null },
        next,
        { ...lobby, status: INHOUSE_STATUS.IN_PROGRESS },
      ),
    ).toBeNull();
  });
});

describe("captainsChosenToast", () => {
  const vote = {
    candidates: [
      candidate("cap1", 4800),
      candidate("cap2", 4700),
      candidate("p1", 4000, { nominations: 0 }),
    ],
    methodTallies: { VOTE: 0, MMR: 6, RECORD: 1 },
  };
  const prev = { lobbyId: "L", status: INHOUSE_STATUS.CAPTAIN_VOTE, vote };
  const lobby = { id: "L", status: INHOUSE_STATUS.DRAFTING, teams };

  it("names the method when the last vote seen projects these captains", () => {
    expect(captainsChosenToast(prev, { inLobby: true }, lobby)).toBe(
      "Highest MMR picked the captains: CAP1 (Radiant) and CAP2 (Dire).",
    );
  });

  it("names only the captains when a later ballot may have changed it", () => {
    const swapped = {
      ...prev,
      vote: { ...vote, methodTallies: { VOTE: 3, MMR: 0, RECORD: 0 } },
    };
    swapped.vote.candidates = [
      candidate("cap1", 4800),
      candidate("cap2", 4700),
      candidate("p1", 4000, { nominations: 3 }),
    ];
    expect(captainsChosenToast(swapped, { inLobby: true }, lobby)).toBe(
      "Captains: CAP1 (Radiant) and CAP2 (Dire).",
    );
  });

  it("only for the game's own players, right after its vote", () => {
    expect(captainsChosenToast(prev, { inLobby: false }, lobby)).toBeNull();
    expect(captainsChosenToast(null, { inLobby: true }, lobby)).toBeNull();
    expect(
      captainsChosenToast(
        { ...prev, status: INHOUSE_STATUS.DRAFTING },
        { inLobby: true },
        lobby,
      ),
    ).toBeNull();
    expect(
      captainsChosenToast({ ...prev, lobbyId: "X" }, { inLobby: true }, lobby),
    ).toBeNull();
  });
});

describe("inhouseSetupPath", () => {
  it("waits for the bot's first answer instead of showing the by-hand steps", () => {
    expect(inhouseSetupPath({ bot: "checking", handHosted: false })).toBe(
      "checking",
    );
  });
  it("takes the bot's panel once it answers, the steps when it can't", () => {
    expect(inhouseSetupPath({ bot: "on", handHosted: false })).toBe("bot");
    for (const bot of ["off", "unavailable", "busy"] as const) {
      expect(inhouseSetupPath({ bot, handHosted: false })).toBe("hand");
    }
  });
  it("keeps a game the bot was busy for by hand, even once the bot frees up", () => {
    for (const bot of ["checking", "on", "off", "unavailable", "busy"] as const) {
      expect(inhouseSetupPath({ bot, handHosted: true })).toBe("hand");
    }
  });
});
