import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn(),
  requireUser: vi.fn(),
  getSessionUser: vi.fn(async () => null),
}));
vi.mock("@/lib/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord")>()),
  getWebhookUrl: vi.fn(async () => ""),
  sendDiscordMessage: vi.fn(async () => true),
}));

import {
  addCaptain,
  randomizeDraftOrder,
  removeCaptain,
  setDraftSettings,
  startDraft,
  transferCaptaincy,
  withdrawSignup,
} from "@/app/actions/admin";
import { confirmDraftReadiness } from "@/app/actions/registration";
import { requireAdmin, requireUser } from "@/lib/auth";
import {
  DRAFT_STATUS,
  REGISTRATION_STATUS,
  REGISTRATION_TYPE,
  SEASON_STATUS,
} from "@/lib/constants";
import { prisma } from "@/lib/prisma";
import {
  makeCaptain,
  makePlayer,
  makeSeason,
  makeUser,
  sessionFor,
} from "./factories";

function fd(fields: Record<string, string | number>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.set(key, String(value));
  }
  return form;
}

function setupForm(
  expectedActiveSeasonId: string,
  fields: Record<string, string | number> = {},
): FormData {
  return fd({ expectedActiveSeasonId, ...fields });
}

async function addRosterMember(
  team: { id: string; seasonId: string },
  name: string,
) {
  const user = await makePlayer(team.seasonId, name, 2500);
  const member = await prisma.teamMember.create({
    data: {
      seasonId: team.seasonId,
      teamId: team.id,
      userId: user.id,
      price: 10,
    },
  });
  return { user, member };
}

async function makeNotStartedDraft(seasonId: string) {
  return prisma.draft.create({
    data: { seasonId, status: DRAFT_STATUS.NOT_STARTED },
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  const admin = await makeUser("Draft Admin", "ADMIN");
  vi.mocked(requireAdmin).mockResolvedValue(sessionFor(admin));
});

describe("captain designation setup boundaries", () => {
  it.each([
    ["SIGNUPS without a Draft row", SEASON_STATUS.SIGNUPS, false],
    ["DRAFT without a Draft row", SEASON_STATUS.DRAFT, false],
    ["DRAFT with a NOT_STARTED row", SEASON_STATUS.DRAFT, true],
  ])(
    "adds an eligible captain during %s",
    async (_label, status, withDraft) => {
      const season = await makeSeason({ status });
      if (withDraft) await makeNotStartedDraft(season.id);
      const player = await makePlayer(season.id, "Eligible Captain", 3200, {
        wantsCaptain: true,
      });

      const result = await addCaptain(
        {},
        setupForm(season.id, { userId: player.id }),
      );

      expect(result?.error).toBeUndefined();
      const team = await prisma.team.findUniqueOrThrow({
        where: {
          seasonId_captainId: { seasonId: season.id, captainId: player.id },
        },
        include: { members: true },
      });
      expect(team.members).toEqual([
        expect.objectContaining({ userId: player.id, isCaptain: true }),
      ]);
    },
  );

  it("refuses standins and inactive player registrations", async () => {
    const season = await makeSeason();
    const standin = await makeUser("Standin Volunteer");
    const withdrawn = await makeUser("Withdrawn Player");
    await prisma.registration.createMany({
      data: [
        {
          seasonId: season.id,
          userId: standin.id,
          type: REGISTRATION_TYPE.STANDIN,
          status: REGISTRATION_STATUS.ACTIVE,
          mmr: 2500,
        },
        {
          seasonId: season.id,
          userId: withdrawn.id,
          type: REGISTRATION_TYPE.PLAYER,
          status: REGISTRATION_STATUS.WITHDRAWN,
          mmr: 2500,
        },
      ],
    });

    const standinResult = await addCaptain(
      {},
      setupForm(season.id, { userId: standin.id }),
    );
    const withdrawnResult = await addCaptain(
      {},
      setupForm(season.id, { userId: withdrawn.id }),
    );

    expect(standinResult?.error).toMatch(/active player signup/i);
    expect(withdrawnResult?.error).toMatch(/active player signup/i);
    expect(await prisma.team.count({ where: { seasonId: season.id } })).toBe(0);
  });

  it("turns a duplicate designation into a harmless refusal", async () => {
    const season = await makeSeason();
    const player = await makePlayer(season.id, "One-Time Captain", 3000);
    const form = () => setupForm(season.id, { userId: player.id });

    const first = await addCaptain({}, form());
    const duplicate = await addCaptain({}, form());

    expect(first?.error).toBeUndefined();
    expect(duplicate?.error).toMatch(/already|changed|reload/i);
    expect(await prisma.team.count({ where: { seasonId: season.id } })).toBe(1);
    expect(
      await prisma.teamMember.count({ where: { seasonId: season.id } }),
    ).toBe(1);
  });

  it.each([
    SEASON_STATUS.REGULAR_SEASON,
    SEASON_STATUS.PLAYOFFS,
    SEASON_STATUS.COMPLETE,
  ])("does not add a captain during %s", async (status) => {
    const season = await makeSeason({ status });
    const player = await makePlayer(season.id, "Late Captain", 3000);

    const result = await addCaptain(
      {},
      setupForm(season.id, { userId: player.id }),
    );

    expect(result?.error).toMatch(/locked|not available|season/i);
    expect(await prisma.team.count({ where: { seasonId: season.id } })).toBe(0);
  });

  it.each([
    SEASON_STATUS.REGULAR_SEASON,
    SEASON_STATUS.PLAYOFFS,
    SEASON_STATUS.COMPLETE,
  ])("does not remove a captain during %s", async (status) => {
    const season = await makeSeason({ status });
    const { team } = await makeCaptain(season.id, "Protected Captain", 100, 0);

    const result = await removeCaptain(
      {},
      setupForm(season.id, { teamId: team.id }),
    );

    expect(result?.error).toMatch(/locked|not available|season/i);
    expect(
      await prisma.team.findUnique({ where: { id: team.id } }),
    ).not.toBeNull();
    expect(await prisma.teamMember.count({ where: { teamId: team.id } })).toBe(
      1,
    );
  });

  it("keeps completed-season registrations historical and read-only", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.COMPLETE });
    const player = await makePlayer(season.id, "Historical Signup", 2800);
    const registration = await prisma.registration.findUniqueOrThrow({
      where: { seasonId_userId: { seasonId: season.id, userId: player.id } },
    });

    const result = await withdrawSignup(
      {},
      fd({ registrationId: registration.id }),
    );

    expect(result?.error).toMatch(/complete.*historical/i);
    expect(
      await prisma.registration.findUniqueOrThrow({
        where: { id: registration.id },
      }),
    ).toMatchObject({ status: REGISTRATION_STATUS.ACTIVE });
  });
});

describe("draft order and settings setup boundaries", () => {
  it("requires the active-season token on every captain and draft setup mutation", async () => {
    const season = await makeSeason();
    const a = await makeCaptain(season.id, "Token Captain A", 100, 4);
    await makeCaptain(season.id, "Token Captain B", 100, 9);
    const incoming = await addRosterMember(a.team, "Token Successor");
    const candidate = await makePlayer(season.id, "Token Candidate", 2800);
    await makePlayer(season.id, "Token Pool", 2700);

    const results = [
      await addCaptain({}, fd({ userId: candidate.id })),
      await removeCaptain({}, fd({ teamId: a.team.id })),
      await transferCaptaincy(
        {},
        fd({
          teamId: a.team.id,
          newCaptainUserId: incoming.user.id,
          expectedCaptainUserId: a.user.id,
        }),
      ),
      await randomizeDraftOrder({}, new FormData()),
      await setDraftSettings(
        {},
        fd({
          teamSize: 5,
          minTeams: 8,
          draftBudget: 500,
          budgetMmrWeight: 40,
        }),
      ),
      await startDraft({}, new FormData()),
    ];

    for (const result of results) {
      expect(result?.error).toMatch(/active season.*changed|reload/i);
    }
    expect(
      await prisma.team.findUniqueOrThrow({ where: { id: a.team.id } }),
    ).toMatchObject({ captainId: a.user.id, draftOrder: 4 });
    expect(
      await prisma.team.findUnique({
        where: {
          seasonId_captainId: {
            seasonId: season.id,
            captainId: candidate.id,
          },
        },
      }),
    ).toBeNull();
    expect(
      await prisma.season.findUniqueOrThrow({ where: { id: season.id } }),
    ).toMatchObject({ teamSize: 3, draftBudget: 100 });
    expect(
      await prisma.draft.findUnique({ where: { seasonId: season.id } }),
    ).toBeNull();
  });

  it("requires at least two teams before randomizing", async () => {
    const season = await makeSeason();

    const emptyResult = await randomizeDraftOrder({}, setupForm(season.id));
    await makeCaptain(season.id, "Only Captain", 100, 9);
    const oneResult = await randomizeDraftOrder({}, setupForm(season.id));

    expect(emptyResult?.error).toMatch(/at least 2|two/i);
    expect(oneResult?.error).toMatch(/at least 2|two/i);
  });

  it("writes each order exactly once as a contiguous zero-based permutation", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.DRAFT });
    await makeNotStartedDraft(season.id);
    const captains = await Promise.all([
      makeCaptain(season.id, "Order A", 100, 7),
      makeCaptain(season.id, "Order B", 100, 12),
      makeCaptain(season.id, "Order C", 100, 20),
    ]);

    const result = await randomizeDraftOrder({}, setupForm(season.id));

    expect(result?.error).toBeUndefined();
    const teams = await prisma.team.findMany({
      where: { seasonId: season.id },
      orderBy: { draftOrder: "asc" },
    });
    expect(teams.map((team) => team.draftOrder)).toEqual([0, 1, 2]);
    expect(teams.map((team) => team.id).sort()).toEqual(
      captains.map(({ team }) => team.id).sort(),
    );
  });

  it("saves settings in the DRAFT waiting room", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.DRAFT });
    await makeNotStartedDraft(season.id);

    const result = await setDraftSettings(
      {},
      setupForm(season.id, {
        expectedSeasonUpdatedAt: season.updatedAt.toISOString(),
        teamSize: 4,
        minTeams: 6,
        draftBudget: 150,
        budgetMmrWeight: 25,
      }),
    );

    expect(result?.error).toBeUndefined();
    expect(
      await prisma.season.findUniqueOrThrow({ where: { id: season.id } }),
    ).toMatchObject({
      teamSize: 4,
      minTeams: 6,
      draftBudget: 150,
      budgetMmrWeight: 25,
    });
  });

  it.each([
    SEASON_STATUS.REGULAR_SEASON,
    SEASON_STATUS.PLAYOFFS,
    SEASON_STATUS.COMPLETE,
  ])("does not rewrite draft settings during %s", async (status) => {
    const season = await makeSeason({
      status,
      teamSize: 3,
      draftBudget: 100,
      budgetMmrWeight: 20,
    });

    const result = await setDraftSettings(
      {},
      setupForm(season.id, {
        expectedSeasonUpdatedAt: season.updatedAt.toISOString(),
        teamSize: 5,
        minTeams: 8,
        draftBudget: 500,
        budgetMmrWeight: 40,
      }),
    );

    expect(result?.error).toMatch(/locked|not available|season/i);
    expect(
      await prisma.season.findUniqueOrThrow({ where: { id: season.id } }),
    ).toMatchObject({
      teamSize: 3,
      draftBudget: 100,
      budgetMmrWeight: 20,
    });
  });
});

describe("starting the draft from a verified setup snapshot", () => {
  async function startableSeason(
    overrides: Parameters<typeof makeSeason>[0] = {},
  ) {
    const season = await makeSeason({ teamSize: 3, ...overrides });
    const a = await makeCaptain(season.id, "Start A", 100, 0);
    const b = await makeCaptain(season.id, "Start B", 100, 1);
    const pool = await makePlayer(season.id, "Draft Pool", 2600);
    return { season, a, b, pool };
  }

  it.each([
    SEASON_STATUS.REGULAR_SEASON,
    SEASON_STATUS.PLAYOFFS,
    SEASON_STATUS.COMPLETE,
  ])("refuses to rewind %s into the draft", async (status) => {
    const { season } = await startableSeason({ status });

    const result = await startDraft({}, setupForm(season.id));

    expect(result?.error).toMatch(/locked|not available|season|phase/i);
    expect(
      await prisma.draft.findUnique({ where: { seasonId: season.id } }),
    ).toBeNull();
    expect(
      (await prisma.season.findUniqueOrThrow({ where: { id: season.id } }))
        .status,
    ).toBe(status);
  });

  it("requires at least two teams", async () => {
    const season = await makeSeason();
    await makeCaptain(season.id, "Solo Captain", 100, 0);
    await makePlayer(season.id, "Solo Pool", 2500);

    const result = await startDraft({}, setupForm(season.id));

    expect(result?.error).toMatch(/at least 2|two captains/i);
    expect(
      await prisma.draft.findUnique({ where: { seasonId: season.id } }),
    ).toBeNull();
  });

  it("requires at least one undrafted full-player signup", async () => {
    const season = await makeSeason();
    await makeCaptain(season.id, "Empty Pool A", 100, 0);
    await makeCaptain(season.id, "Empty Pool B", 100, 1);

    const result = await startDraft({}, setupForm(season.id));

    expect(result?.error).toMatch(/player|pool|draft/i);
    expect(
      await prisma.draft.findUnique({ where: { seasonId: season.id } }),
    ).toBeNull();
  });

  it("does not treat an existing later-season roster as a fresh auction", async () => {
    const { season, a } = await startableSeason();
    const existing = await addRosterMember(a.team, "Existing Teammate");

    const result = await startDraft({}, setupForm(season.id));

    expect(result?.error).toMatch(/non-captain roster|captain-only/i);
    expect(
      await prisma.draft.findUnique({ where: { seasonId: season.id } }),
    ).toBeNull();
    expect(
      await prisma.teamMember.findUnique({ where: { id: existing.member.id } }),
    ).not.toBeNull();
  });

  it("refuses an active-season token from a stale admin page", async () => {
    const staleSeason = await makeSeason({ isActive: false });
    const { season } = await startableSeason();

    const result = await startDraft({}, setupForm(staleSeason.id));

    expect(result?.error).toMatch(/season.*changed|reload|stale/i);
    expect(
      await prisma.draft.findUnique({ where: { seasonId: season.id } }),
    ).toBeNull();
    expect(
      (await prisma.season.findUniqueOrThrow({ where: { id: season.id } }))
        .status,
    ).toBe(SEASON_STATUS.SIGNUPS);
  });

  it("refuses duplicate draft-order slots instead of choosing an ambiguous opener", async () => {
    const season = await makeSeason();
    await makeCaptain(season.id, "Duplicate A", 100, 0);
    await makeCaptain(season.id, "Duplicate B", 100, 0);
    await makePlayer(season.id, "Duplicate Pool", 2500);

    const result = await startDraft({}, setupForm(season.id));

    expect(result?.error).toMatch(/order|duplicate|randomize/i);
    expect(
      await prisma.draft.findUnique({ where: { seasonId: season.id } }),
    ).toBeNull();
  });

  it("persists weighted budgets from the same snapshot and treats MMR 0 as unknown", async () => {
    const season = await makeSeason({
      status: SEASON_STATUS.DRAFT,
      teamSize: 3,
      draftBudget: 100,
      budgetMmrWeight: 20,
    });
    await makeNotStartedDraft(season.id);
    const low = await makeCaptain(season.id, "Low MMR", 999, 0);
    const high = await makeCaptain(season.id, "High MMR", 999, 1);
    const unknown = await makeCaptain(season.id, "Unknown MMR", 999, 2);
    await prisma.registration.update({
      where: {
        seasonId_userId: { seasonId: season.id, userId: low.user.id },
      },
      data: { mmr: 1000 },
    });
    await prisma.registration.update({
      where: {
        seasonId_userId: { seasonId: season.id, userId: high.user.id },
      },
      data: { mmr: 4000 },
    });
    await prisma.registration.update({
      where: {
        seasonId_userId: { seasonId: season.id, userId: unknown.user.id },
      },
      data: { mmr: 0 },
    });
    await makePlayer(season.id, "Weighted Pool", 2700);

    const result = await startDraft({}, setupForm(season.id));

    expect(result?.error).toBeUndefined();
    const teams = await prisma.team.findMany({
      where: { seasonId: season.id },
    });
    const budgets = new Map(teams.map((team) => [team.id, team.budget]));
    expect(budgets.get(low.team.id)).toBe(120);
    expect(budgets.get(high.team.id)).toBe(80);
    expect(budgets.get(unknown.team.id)).toBe(100);
    expect(
      (await prisma.season.findUniqueOrThrow({ where: { id: season.id } }))
        .status,
    ).toBe(SEASON_STATUS.DRAFT);
    expect(
      await prisma.draft.findUniqueOrThrow({ where: { seasonId: season.id } }),
    ).toMatchObject({
      status: DRAFT_STATUS.IN_PROGRESS,
      nominatorTeamId: low.team.id,
      nominationIndex: 0,
    });
  });
});

describe("captaincy handover", () => {
  async function transferableTeam(
    seasonStatus: string = SEASON_STATUS.REGULAR_SEASON,
    draftStatus?: string,
  ) {
    const season = await makeSeason({ status: seasonStatus });
    const captain = await makeCaptain(season.id, "Outgoing Captain", 70, 0);
    const incoming = await addRosterMember(captain.team, "Incoming Captain");
    if (draftStatus) {
      await prisma.draft.create({
        data: { seasonId: season.id, status: draftStatus },
      });
    }
    return { season, captain, incoming };
  }

  it("atomically switches Team.captainId and leaves exactly one captain flag", async () => {
    const { season, captain, incoming } = await transferableTeam();

    const result = await transferCaptaincy(
      {},
      setupForm(season.id, {
        teamId: captain.team.id,
        newCaptainUserId: incoming.user.id,
        expectedCaptainUserId: captain.user.id,
      }),
    );

    expect(result?.error).toBeUndefined();
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: captain.team.id },
      include: { members: true },
    });
    expect(team.captainId).toBe(incoming.user.id);
    expect(team.members.filter((member) => member.isCaptain)).toEqual([
      expect.objectContaining({ userId: incoming.user.id }),
    ]);
    expect(team.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: captain.user.id, isCaptain: false }),
      ]),
    );
  });

  it.each([
    ["a live auction", SEASON_STATUS.DRAFT, DRAFT_STATUS.IN_PROGRESS],
    ["a paused auction", SEASON_STATUS.DRAFT, DRAFT_STATUS.PAUSED],
    ["a complete season", SEASON_STATUS.COMPLETE, undefined],
  ])("blocks handover during %s", async (_label, seasonStatus, draftStatus) => {
    const { season, captain, incoming } = await transferableTeam(
      seasonStatus,
      draftStatus,
    );

    const result = await transferCaptaincy(
      {},
      setupForm(season.id, {
        teamId: captain.team.id,
        newCaptainUserId: incoming.user.id,
        expectedCaptainUserId: captain.user.id,
      }),
    );

    expect(result?.error).toMatch(/live|paused|complete|locked|read-only/i);
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: captain.team.id },
      include: { members: true },
    });
    expect(team.captainId).toBe(captain.user.id);
    expect(team.members.filter((member) => member.isCaptain)).toEqual([
      expect.objectContaining({ userId: captain.user.id }),
    ]);
  });

  it("refuses a stale captain claim without overwriting a newer handover", async () => {
    const { season, captain, incoming } = await transferableTeam();
    const newer = await addRosterMember(captain.team, "Newer Captain");
    const first = await transferCaptaincy(
      {},
      setupForm(season.id, {
        teamId: captain.team.id,
        newCaptainUserId: incoming.user.id,
        expectedCaptainUserId: captain.user.id,
      }),
    );

    const stale = await transferCaptaincy(
      {},
      setupForm(season.id, {
        teamId: captain.team.id,
        newCaptainUserId: newer.user.id,
        expectedCaptainUserId: captain.user.id,
      }),
    );

    expect(first?.error).toBeUndefined();
    expect(stale?.error).toMatch(/captain.*changed|reload|stale/i);
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: captain.team.id },
      include: { members: true },
    });
    expect(team.captainId).toBe(incoming.user.id);
    expect(team.members.filter((member) => member.isCaptain)).toEqual([
      expect.objectContaining({ userId: incoming.user.id }),
    ]);
  });
});

describe("draft readiness in the pre-auction DRAFT waiting room", () => {
  it("accepts the exact active season, schedule revision, and time", async () => {
    const draftAt = new Date("2026-08-15T02:00:00.000Z");
    const season = await makeSeason({
      status: SEASON_STATUS.DRAFT,
      draftAt,
      draftRevision: 4,
    });
    await makeNotStartedDraft(season.id);
    const player = await makePlayer(season.id, "Waiting-Room Player", 3000);
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));

    const result = await confirmDraftReadiness(
      {},
      setupForm(season.id, {
        draftRevision: 4,
        draftAtTs: draftAt.getTime(),
      }),
    );

    expect(result?.error).toBeUndefined();
    expect(result?.message).toMatch(/ready for draft confirmed/i);
    expect(
      await prisma.registration.findUniqueOrThrow({
        where: {
          seasonId_userId: { seasonId: season.id, userId: player.id },
        },
      }),
    ).toMatchObject({
      draftConfirmedRevision: 4,
      draftConfirmedFor: draftAt,
    });
  });

  it("does not let a stale season form confirm a replacement season with the same schedule", async () => {
    const draftAt = new Date("2026-08-15T02:00:00.000Z");
    const staleSeason = await makeSeason({
      isActive: false,
      draftAt,
      draftRevision: 4,
    });
    const season = await makeSeason({
      status: SEASON_STATUS.DRAFT,
      draftAt,
      draftRevision: 4,
    });
    await makeNotStartedDraft(season.id);
    const player = await makePlayer(
      season.id,
      "Replacement-Season Player",
      3000,
    );
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));

    const result = await confirmDraftReadiness(
      {},
      setupForm(staleSeason.id, {
        draftRevision: 4,
        draftAtTs: draftAt.getTime(),
      }),
    );

    expect(result?.error).toMatch(/active season.*changed|reload|stale/i);
    expect(
      await prisma.registration.findUniqueOrThrow({
        where: {
          seasonId_userId: { seasonId: season.id, userId: player.id },
        },
      }),
    ).toMatchObject({
      draftConfirmedRevision: null,
      draftConfirmedAt: null,
      draftConfirmedFor: null,
    });
  });
});
