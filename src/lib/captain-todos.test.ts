import { describe, expect, it } from "vitest";
import {
  CAPTAIN_TODO_CARD,
  captainTodoCountLine,
  captainTodos,
  type CaptainTodoInput,
} from "./captain-todos";
import type {
  ReadyCheckOptionView,
  ReadyCheckView,
} from "./reschedule-ready-check";

const ME = "team-me";
const THEM = "team-them";

function input(over: Partial<CaptainTodoInput> = {}): CaptainTodoInput {
  return {
    myTeamId: ME,
    seasonStatus: "REGULAR_SEASON",
    draftStatus: "COMPLETE",
    match: { status: "SCHEDULED", coveredUserIds: [], standinRequests: [] },
    roster: [
      { userId: "a", name: "Ana" },
      { userId: "b", name: "Bo" },
      { userId: "c", name: "Cy" },
    ],
    outUserIds: new Set(),
    readyCheck: null,
    ...over,
  };
}

function option(over: Partial<ReadyCheckOptionView>): ReadyCheckOptionView {
  return {
    timeMs: 1_000,
    passed: false,
    myAnswer: null,
    lockRefusal: "The other captain hasn't said yes",
    readyTotal: 6,
    seatTotal: 10,
    ...over,
  } as ReadyCheckOptionView;
}

function readyCheck(
  isProposer: boolean,
  options: ReadyCheckOptionView[],
  open = true,
): ReadyCheckView {
  return {
    proposer: { id: isProposer ? "me" : "them", name: isProposer ? "Me" : "Rival" },
    open,
    viewer: { isProposer },
    options,
  } as unknown as ReadyCheckView;
}

describe("captainTodos", () => {
  it("lists roster players who are out with no cover, out first in roster order", () => {
    const todos = captainTodos(input({ outUserIds: new Set(["c", "a"]) }));
    expect(todos).toEqual([{ kind: "uncovered", names: ["Ana", "Cy"] }]);
  });

  it("drops a player a standin covers, or one a pending request would cover", () => {
    expect(
      captainTodos(
        input({
          outUserIds: new Set(["a", "b"]),
          match: {
            status: "SCHEDULED",
            coveredUserIds: ["a"],
            standinRequests: [
              {
                teamId: ME,
                replacingUserId: "b",
                requestedByName: "Me",
                standinName: "Sub",
              },
            ],
          },
        }),
      ),
    ).toEqual([]);
  });

  it("asks nothing before the auction is done or once the series is played", () => {
    const out = { outUserIds: new Set(["a"]) };
    expect(captainTodos(input({ ...out, seasonStatus: "SIGNUPS" }))).toEqual([]);
    expect(
      captainTodos(input({ ...out, seasonStatus: "DRAFT", draftStatus: "LIVE" })),
    ).toEqual([]);
    expect(
      captainTodos(
        input({
          ...out,
          match: { status: "COMPLETED", coveredUserIds: [], standinRequests: [] },
        }),
      ),
    ).toEqual([]);
  });

  it("asks for an answer to the other captain's standin requests only", () => {
    const request = (teamId: string, standinName: string) => ({
      teamId,
      replacingUserId: null,
      requestedByName: teamId === ME ? "Me" : "Rival",
      standinName,
    });
    const todos = captainTodos(
      input({
        match: {
          status: "LIVE",
          coveredUserIds: [],
          standinRequests: [
            request(ME, "Mine"),
            request(THEM, "Ringer"),
            request(THEM, "Other"),
          ],
        },
      }),
    );
    expect(todos).toEqual([
      {
        kind: "standin-request",
        requesterName: "Rival",
        standinName: "Ringer",
        count: 2,
      },
    ]);
  });

  it("asks for an answer to the other captain's ready check until a yes on a live time", () => {
    const options = [
      option({ timeMs: 1, passed: true }),
      option({ timeMs: 2 }),
      option({ timeMs: 3 }),
    ];
    expect(captainTodos(input({ readyCheck: readyCheck(false, options) }))).toEqual([
      { kind: "answer-ready-check", proposerName: "Rival", times: [2, 3] },
    ]);
    // A yes on a passed time doesn't count; a yes on a live one does.
    const passedYes = [option({ timeMs: 1, passed: true, myAnswer: "ready" }), option({ timeMs: 2 })];
    expect(captainTodos(input({ readyCheck: readyCheck(false, passedYes) }))).toHaveLength(1);
    const liveYes = [option({ timeMs: 2, myAnswer: "ready" })];
    expect(captainTodos(input({ readyCheck: readyCheck(false, liveYes) }))).toEqual([]);
  });

  it("offers Lock it in on the captain's own check from lockOffered", () => {
    const options = [
      option({ timeMs: 5 }),
      option({ timeMs: 6, lockRefusal: null, readyTotal: 8, seatTotal: 10 }),
    ];
    expect(captainTodos(input({ readyCheck: readyCheck(true, options) }))).toEqual([
      { kind: "lock-in", timeMs: 6, readyTotal: 8, seatTotal: 10 },
    ]);
    expect(
      captainTodos(input({ readyCheck: readyCheck(true, [option({ timeMs: 5 })]) })),
    ).toEqual([]);
  });

  it("ignores a ready check that is closed, fully passed, or on a live series", () => {
    const options = [option({ timeMs: 6 })];
    expect(captainTodos(input({ readyCheck: readyCheck(false, options, false) }))).toEqual([]);
    expect(
      captainTodos(
        input({ readyCheck: readyCheck(false, [option({ timeMs: 6, passed: true })]) }),
      ),
    ).toEqual([]);
    expect(
      captainTodos(
        input({
          readyCheck: readyCheck(false, options),
          match: { status: "LIVE", coveredUserIds: [], standinRequests: [] },
        }),
      ),
    ).toEqual([]);
  });

  it("points each kind at the card that answers it", () => {
    expect(CAPTAIN_TODO_CARD).toEqual({
      uncovered: "standins",
      "standin-request": "standins",
      "answer-ready-check": "reschedule",
      "lock-in": "reschedule",
    });
  });
});

describe("captainTodoCountLine", () => {
  it("counts in words", () => {
    expect(captainTodoCountLine(1)).toBe("1 thing needs you");
    expect(captainTodoCountLine(3)).toBe("3 things need you");
  });
});
