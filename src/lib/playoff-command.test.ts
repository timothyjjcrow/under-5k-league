import { describe, expect, it } from "vitest";
import { playoffSetupRevision } from "./playoff-command";

type RevisionInput = Parameters<typeof playoffSetupRevision>[0];
type RevisionMutation = {
  name: string;
  mutate: (input: RevisionInput) => void;
};

const revisionInput: RevisionInput = {
  season: {
    id: "s1",
    status: "PLAYOFFS",
    playoffBestOf: 3,
    finalBestOf: 5,
    firstMatchNight: new Date("2026-08-01T02:00:00.000Z"),
  },
  teams: [
    { id: "a", withdrawn: false },
    { id: "b", withdrawn: false },
  ],
  matches: [
    {
      id: "m1",
      week: 7,
      phase: "FINAL",
      status: "COMPLETED",
      homeTeamId: "a",
      awayTeamId: "b",
      homeScore: 2,
      awayScore: 0,
      winnerTeamId: "a",
      forfeit: false,
      bracketSlot: "F",
      bestOf: 5,
      scheduledAt: new Date("2026-07-25T02:00:00.000Z"),
      games: [{ id: "g1", dotaMatchId: "123" }],
      availability: [{ id: "a1", userId: "u1", status: "IN" }],
      standins: [
        {
          id: "s1",
          teamId: "a",
          standinUserId: "u2",
          replacingUserId: "u1",
        },
      ],
      predictions: [{ id: "p1", userId: "u3", pickedTeamId: "a" }],
      reschedules: [
        {
          id: "r1",
          proposedById: "u4",
          proposedTime: new Date("2026-08-02T02:00:00.000Z"),
          status: "PENDING",
        },
      ],
    },
  ],
};

const revisionMutations: RevisionMutation[] = [
  { name: "season.id", mutate: (input) => (input.season.id = "s2") },
  {
    name: "season.status",
    mutate: (input) => (input.season.status = "COMPLETE"),
  },
  {
    name: "season.playoffBestOf",
    mutate: (input) => (input.season.playoffBestOf = 5),
  },
  {
    name: "season.finalBestOf",
    mutate: (input) => (input.season.finalBestOf = 7),
  },
  {
    name: "season.firstMatchNight",
    mutate: (input) =>
      (input.season.firstMatchNight = new Date("2026-08-08T02:00:00.000Z")),
  },
  { name: "team.id", mutate: (input) => (input.teams[0].id = "c") },
  {
    name: "team.withdrawn",
    mutate: (input) => (input.teams[0].withdrawn = true),
  },
  { name: "match.id", mutate: (input) => (input.matches[0].id = "m2") },
  { name: "match.week", mutate: (input) => (input.matches[0].week = 8) },
  {
    name: "match.phase",
    mutate: (input) => (input.matches[0].phase = "PLAYOFF"),
  },
  {
    name: "match.status",
    mutate: (input) => (input.matches[0].status = "SCHEDULED"),
  },
  {
    name: "match.homeTeamId",
    mutate: (input) => (input.matches[0].homeTeamId = "b"),
  },
  {
    name: "match.awayTeamId",
    mutate: (input) => (input.matches[0].awayTeamId = "a"),
  },
  {
    name: "match.homeScore",
    mutate: (input) => (input.matches[0].homeScore = 1),
  },
  {
    name: "match.awayScore",
    mutate: (input) => (input.matches[0].awayScore = 1),
  },
  {
    name: "match.winnerTeamId",
    mutate: (input) => (input.matches[0].winnerTeamId = "b"),
  },
  {
    name: "match.forfeit",
    mutate: (input) => (input.matches[0].forfeit = true),
  },
  {
    name: "match.bracketSlot",
    mutate: (input) => (input.matches[0].bracketSlot = "SF1"),
  },
  {
    name: "match.bestOf",
    mutate: (input) => (input.matches[0].bestOf = 3),
  },
  {
    name: "match.scheduledAt",
    mutate: (input) =>
      (input.matches[0].scheduledAt = new Date("2026-07-26T02:00:00.000Z")),
  },
  {
    name: "game.id",
    mutate: (input) => (input.matches[0].games[0].id = "g2"),
  },
  {
    name: "game.dotaMatchId",
    mutate: (input) => (input.matches[0].games[0].dotaMatchId = "456"),
  },
  {
    name: "availability.id",
    mutate: (input) => (input.matches[0].availability[0].id = "a2"),
  },
  {
    name: "availability.userId",
    mutate: (input) => (input.matches[0].availability[0].userId = "u5"),
  },
  {
    name: "availability.status",
    mutate: (input) => (input.matches[0].availability[0].status = "OUT"),
  },
  {
    name: "standin.id",
    mutate: (input) => (input.matches[0].standins[0].id = "s2"),
  },
  {
    name: "standin.teamId",
    mutate: (input) => (input.matches[0].standins[0].teamId = "b"),
  },
  {
    name: "standin.standinUserId",
    mutate: (input) => (input.matches[0].standins[0].standinUserId = "u5"),
  },
  {
    name: "standin.replacingUserId",
    mutate: (input) => (input.matches[0].standins[0].replacingUserId = null),
  },
  {
    name: "prediction.id",
    mutate: (input) => (input.matches[0].predictions[0].id = "p2"),
  },
  {
    name: "prediction.userId",
    mutate: (input) => (input.matches[0].predictions[0].userId = "u5"),
  },
  {
    name: "prediction.pickedTeamId",
    mutate: (input) => (input.matches[0].predictions[0].pickedTeamId = "b"),
  },
  {
    name: "reschedule.id",
    mutate: (input) => (input.matches[0].reschedules[0].id = "r2"),
  },
  {
    name: "reschedule.proposedById",
    mutate: (input) =>
      (input.matches[0].reschedules[0].proposedById = "u5"),
  },
  {
    name: "reschedule.proposedTime",
    mutate: (input) =>
      (input.matches[0].reschedules[0].proposedTime = new Date(
        "2026-08-03T02:00:00.000Z",
      )),
  },
  {
    name: "reschedule.status",
    mutate: (input) => (input.matches[0].reschedules[0].status = "ACCEPTED"),
  },
];

describe("playoffSetupRevision", () => {
  it("is stable across query ordering", () => {
    const a = playoffSetupRevision(revisionInput);
    const b = playoffSetupRevision({
      ...revisionInput,
      teams: [...revisionInput.teams].reverse(),
      matches: revisionInput.matches.map((match) => ({
        ...match,
        games: [...match.games].reverse(),
        availability: [...match.availability].reverse(),
        standins: [...match.standins].reverse(),
        predictions: [...match.predictions].reverse(),
        reschedules: [...match.reschedules].reverse(),
      })),
    });
    expect(a).toBe(b);
  });

  it.each(revisionMutations)("changes when $name changes", ({ mutate }) => {
    const baseline = playoffSetupRevision(revisionInput);
    const changed = structuredClone(revisionInput);
    mutate(changed);

    expect(playoffSetupRevision(changed)).not.toBe(baseline);
  });

  it("tracks the presence of every dependent row a teardown would delete", () => {
    const baseline = playoffSetupRevision(revisionInput);
    for (const dependent of [
      "availability",
      "standins",
      "predictions",
      "reschedules",
    ] as const) {
      const changed = structuredClone(revisionInput);
      changed.matches[0][dependent] = [];
      expect(playoffSetupRevision(changed)).not.toBe(baseline);
    }
  });
});
