import { afterEach, describe, expect, it, vi } from "vitest";

// deleteSeason is the single most destructive action in the app — a cascade
// delete of a whole season — and its archived-ness guard had ZERO coverage,
// in a guard shape (deleteMany-with-predicate + throw-in-tx) the mutation
// ratchet structurally cannot see. Per the repo's own doctrine, such guards
// live or die by hand-written tests: these were verified non-vacuous by
// sabotaging the `isActive: false` predicate and the throw and watching them
// go red.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn(),
  requireUser: vi.fn(),
  // logAdminAction resolves the actor itself; an undefined mock would throw
  // inside its try/catch and silently skip the row this suite asserts on.
  getSessionUser: vi.fn(async () => null),
}));
vi.mock("@/lib/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord")>()),
  getWebhookUrl: vi.fn(async () => ""),
  sendDiscordMessage: vi.fn(async () => true),
}));

import {
  archiveCompletedSeasonAction,
  archiveIncompleteSeasonAction,
  createSeason,
  deleteSeason,
  renameSeason,
  setLeagueId,
  setMatchSchedule,
  setMaxMmr,
  setSeriesLengths,
} from "@/app/actions/admin";
import { updateTag } from "next/cache";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import { prisma } from "@/lib/prisma";
import { DRAFT_STATUS, MATCH_PHASE, MATCH_STATUS } from "@/lib/constants";
import { seasonSettingScopeWhere } from "@/lib/settings";
import { createBackupReceipt } from "@/lib/backup-receipt.mjs";
import { postgresDatabaseIdentity } from "@/lib/postgres-identity.mjs";
import { reactivateSeason } from "@/lib/season";
import {
  expireClock,
  makeCaptain,
  makePlayer,
  makeSeason,
  makeTeam,
  makeUser,
  ON_POSTGRES,
  raceAll,
  raceN,
  sessionFor,
  startDraftState,
} from "./factories";
import {
  nominatePlayer,
  resolveExpiredNomination,
  resumeDraft,
} from "@/lib/draft-service";

function fd(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

function deleteFd(season: {
  id: string;
  name: string;
  updatedAt: Date;
}): FormData {
  return fd({
    seasonId: season.id,
    confirmationName: season.name,
    expectedSeasonUpdatedAt: season.updatedAt.toISOString(),
  });
}

async function completedSeason(name = "Completed Season") {
  const season = await makeSeason({ name, status: "PLAYOFFS" });
  const home = await makeTeam(season.id, `${name} Alpha`, 0);
  const away = await makeTeam(season.id, `${name} Bravo`, 1);
  await prisma.match.create({
    data: {
      seasonId: season.id,
      week: 3,
      phase: MATCH_PHASE.FINAL,
      bracketSlot: "R2M0",
      homeTeamId: home.id,
      awayTeamId: away.id,
      status: MATCH_STATUS.COMPLETED,
      homeScore: 3,
      awayScore: 1,
      winnerTeamId: home.id,
    },
  });
  return prisma.season.update({
    where: { id: season.id },
    data: { status: "COMPLETE", championTeamId: home.id },
  });
}

/** An ARCHIVED season carrying every kind of child row the delete claims. */
async function archivedSeasonWithHistory() {
  const season = await makeSeason({ isActive: false });
  const a = await makeTeam(season.id, "Alpha", 0);
  const b = await makeTeam(season.id, "Bravo", 1);
  await makePlayer(season.id, "Some Player", 3000);
  const match = await prisma.match.create({
    data: {
      seasonId: season.id,
      week: 1,
      phase: MATCH_PHASE.REGULAR,
      homeTeamId: a.id,
      awayTeamId: b.id,
      status: MATCH_STATUS.COMPLETED,
      homeScore: 2,
      awayScore: 0,
      winnerTeamId: a.id,
    },
  });
  await prisma.game.create({
    data: {
      matchId: match.id,
      dotaMatchId: "8555000001",
      radiantWin: true,
      winnerTeamId: a.id,
      players: "[]",
    },
  });
  await prisma.setting.create({
    data: { key: `honorsAnnounced:${season.id}:1`, value: "sent" },
  });
  await prisma.setting.createMany({
    data: [
      { key: `championAnnounced:${season.id}`, value: "sent" },
      { key: `weekReminder:${season.id}:1:123`, value: "sent" },
      { key: `playoffRoundBuilt:${season.id}:2`, value: "done" },
      { key: `playoffGamesArchive:${season.id}`, value: "[]" },
      { key: `importSkip:${season.id}`, value: "[]" },
      { key: `leagueSyncSkip:${season.id}`, value: "[]" },
      { key: `resultAnnounced:${match.id}`, value: "sent" },
      { key: `outPing:${match.id}:player-1`, value: "sent" },
      { key: "discordWebhookUrl", value: "global-setting-survives" },
    ],
  });
  return { season, match };
}

describe("deleteSeason", () => {
  afterEach(() => {
    setRaceHook(null);
    vi.unstubAllEnvs();
  });

  it("deletes an archived season and everything hanging off it", async () => {
    vi.mocked(updateTag).mockClear();
    const { season, match } = await archivedSeasonWithHistory();

    const res = await deleteSeason({}, deleteFd(season));

    expect(res?.message).toMatch(/deleted/i);
    expect(
      await prisma.season.findUnique({ where: { id: season.id } }),
    ).toBeNull();
    expect(await prisma.match.count({ where: { seasonId: season.id } })).toBe(
      0,
    );
    expect(await prisma.game.count({ where: { matchId: match.id } })).toBe(0);
    expect(await prisma.team.count({ where: { seasonId: season.id } })).toBe(0);
    expect(
      await prisma.registration.count({ where: { seasonId: season.id } }),
    ).toBe(0);
    // Every season- and match-scoped operational marker is explicit cleanup.
    expect(
      await prisma.setting.count({
        where: seasonSettingScopeWhere(season.id, [match.id]),
      }),
    ).toBe(0);
    expect(
      await prisma.setting.findUnique({ where: { key: "discordWebhookUrl" } }),
    ).toMatchObject({ value: "global-setting-survives" });
    // The AdminAction record OUTLIVES the season it describes.
    const log = await prisma.adminAction.findFirst({
      where: { action: "deleteSeason" },
      orderBy: { createdAt: "desc" },
    });
    expect(log?.summary).toContain(season.name);
    expect(updateTag).toHaveBeenCalledWith("games");
  });

  it("refuses the ACTIVE season at read time", async () => {
    const season = await makeSeason(); // isActive true
    const res = await deleteSeason({}, deleteFd(season));
    expect(res?.error).toMatch(/active season/i);
    expect(
      await prisma.season.findUnique({ where: { id: season.id } }),
    ).not.toBeNull();
  });

  it("a reactivation landing mid-delete rolls EVERYTHING back — matches included", async () => {
    // The race the code comment names: /seasons offers "Make active again"
    // right beside Delete. The archived-ness is re-asserted in the season
    // deleteMany's WHERE; count 0 throws so the match deleteMany (which runs
    // FIRST — Match→Team is RESTRICT) rolls back instead of leaving a live
    // season silently stripped of its schedule.
    const { season, match } = await archivedSeasonWithHistory();
    let fired = false;
    setRaceHook(
      onceAt("admin.deleteSeason.beforeTx", async () => {
        fired = true;
        await prisma.season.update({
          where: { id: season.id },
          data: { isActive: true },
        });
      }),
    );

    const res = await deleteSeason({}, deleteFd(season));

    expect(fired).toBe(true);
    expect(res?.error).toMatch(/activated or changed/i);
    // Season intact, and — the part the throw exists for — its matches too.
    expect(
      await prisma.season.findUnique({ where: { id: season.id } }),
    ).not.toBeNull();
    expect(await prisma.match.count({ where: { seasonId: season.id } })).toBe(
      1,
    );
    expect(await prisma.game.count({ where: { matchId: match.id } })).toBe(1);
  });

  it("requires the typed name and a fresh server-side confirmation", async () => {
    const { season } = await archivedSeasonWithHistory();

    const missingName = await deleteSeason(
      {},
      fd({
        seasonId: season.id,
        expectedSeasonUpdatedAt: season.updatedAt.toISOString(),
      }),
    );
    expect(missingName?.error).toMatch(/exact season name/i);

    const stale = deleteFd(season);
    await prisma.season.update({
      where: { id: season.id },
      data: { name: `${season.name} corrected` },
    });
    const staleResult = await deleteSeason({}, stale);
    expect(staleResult?.error).toMatch(/exact season name|stale|changed/i);
    expect(
      await prisma.season.findUnique({ where: { id: season.id } }),
    ).not.toBeNull();
  });

  it("requires a recent database-bound full-backup receipt in production", async () => {
    const { season } = await archivedSeasonWithHistory();
    const databaseUrl =
      "postgresql://league:password@ep-league.us-west-2.aws.neon.tech/ld2l";
    const secret = "production-backup-receipt-secret-with-32-characters";
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("DATABASE_URL", databaseUrl);
    vi.stubEnv("DIRECT_URL", databaseUrl);
    vi.stubEnv("BACKUP_RECEIPT_SECRET", secret);

    const refused = await deleteSeason({}, deleteFd(season));
    expect(refused?.error).toMatch(/backup verification receipt is required/i);
    expect(
      await prisma.season.findUnique({ where: { id: season.id } }),
    ).not.toBeNull();

    const form = deleteFd(season);
    form.set(
      "backupReceipt",
      createBackupReceipt(
        {
          formatVersion: 1,
          artifactType: "postgres-full-database",
          artifactSha256: "b".repeat(64),
          databaseIdentity: postgresDatabaseIdentity(databaseUrl)!,
          createdAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
          verifiedAt: new Date(Date.now() - 60 * 1000).toISOString(),
        },
        secret,
      ),
    );
    const deleted = await deleteSeason({}, form);
    expect(deleted?.message).toMatch(/deleted/i);
    expect(
      await prisma.season.findUnique({ where: { id: season.id } }),
    ).toBeNull();
  });
});

describe("createSeason", () => {
  it("archives an authoritatively completed season and opens the new one active", async () => {
    const oldSeason = await completedSeason();
    const f = fd({
      name: "Season N+1",
      teamSize: "5",
      minTeams: "2",
      expectedActiveSeasonId: oldSeason.id,
    });
    f.set("draftBudget", "100");

    const res = await createSeason({}, f);

    expect(res?.error).toBeUndefined();
    const archived = await prisma.season.findUniqueOrThrow({
      where: { id: oldSeason.id },
    });
    expect(archived.isActive).toBe(false);
    const actives = await prisma.season.findMany({ where: { isActive: true } });
    expect(actives).toHaveLength(1);
    expect(actives[0].name).toBe("Season N+1");
    // Season N's children are untouched by the archival.
  });

  it("refuses a replayed create form instead of archiving the season it just made", async () => {
    const oldSeason = await completedSeason();
    const fields = {
      name: "Season N+1",
      teamSize: "5",
      minTeams: "4",
      draftBudget: "100",
      expectedActiveSeasonId: oldSeason.id,
    };

    const first = await createSeason({}, fd(fields));
    const replay = await createSeason({}, fd(fields));

    expect(first?.error).toBeUndefined();
    expect(replay?.error).toMatch(/active season changed.*reload/i);
    const actives = await prisma.season.findMany({ where: { isActive: true } });
    expect(actives).toHaveLength(1);
    expect(actives[0].name).toBe("Season N+1");
    expect(await prisma.season.count()).toBe(2);
  });

  it("serializes concurrent handoffs so exactly one next season opens", async () => {
    const oldSeason = await completedSeason("Concurrent Complete");
    const results = await raceN(2, () =>
      createSeason(
        {},
        fd({
          name: "Only One Next Season",
          expectedActiveSeasonId: oldSeason.id,
        }),
      ),
    );

    expect(results.filter((result) => !result?.error)).toHaveLength(1);
    expect(await prisma.season.count({ where: { isActive: true } })).toBe(1);
    expect(await prisma.season.count()).toBe(2);
    expect(
      await prisma.season.findUniqueOrThrow({ where: { id: oldSeason.id } }),
    ).toMatchObject({ isActive: false, status: "COMPLETE" });
  });

  it("rejects a blank name and keeps the current season active", async () => {
    const current = await makeSeason();
    const result = await createSeason(
      {},
      fd({ name: "   ", expectedActiveSeasonId: current.id }),
    );

    expect(result?.error).toMatch(/season name/i);
    expect(
      (await prisma.season.findUniqueOrThrow({ where: { id: current.id } }))
        .isActive,
    ).toBe(true);
    expect(await prisma.season.count()).toBe(1);
  });

  it.each(["SIGNUPS", "DRAFT", "REGULAR_SEASON", "PLAYOFFS"])(
    "refuses to hide an unfinished %s season behind the normal handoff",
    async (status) => {
      const current = await makeSeason({ status });
      const result = await createSeason(
        {},
        fd({
          name: "Too Soon",
          expectedActiveSeasonId: current.id,
        }),
      );

      expect(result?.error).toMatch(/finish.*season|grand final/i);
      expect(
        (await prisma.season.findUniqueOrThrow({ where: { id: current.id } }))
          .isActive,
      ).toBe(true);
      expect(await prisma.season.count()).toBe(1);
    },
  );

  it("keeps unfinished cancellation available as an explicit reversible step", async () => {
    const current = await makeSeason({
      name: "Cancelled Season",
      status: "REGULAR_SEASON",
    });
    const cancelled = await archiveIncompleteSeasonAction(
      {},
      fd({
        expectedActiveSeasonId: current.id,
        expectedSeasonUpdatedAt: current.updatedAt.toISOString(),
      }),
    );
    expect(cancelled?.message).toMatch(/cancelled.*archived/i);
    expect(
      await prisma.season.findUniqueOrThrow({ where: { id: current.id } }),
    ).toMatchObject({ isActive: false, status: "REGULAR_SEASON" });

    const next = await createSeason(
      {},
      fd({ name: "Replacement Season", expectedActiveSeasonId: "" }),
    );
    expect(next?.message).toMatch(/Replacement Season/);
    expect(await prisma.season.count({ where: { isActive: true } })).toBe(1);
  });

  it("parks an expired live auction without losing its lot, bids, or budget", async () => {
    const season = await makeSeason({
      name: "Cancelled Draft",
      status: "DRAFT",
      teamSize: 3,
      draftBudget: 100,
    });
    const captain = await makeCaptain(season.id, "Cancel Captain A", 100, 0);
    await makeCaptain(season.id, "Cancel Captain B", 100, 1);
    const player = await makePlayer(season.id, "Preserved Lot", 4100);
    await startDraftState(season.id);
    expect(
      (
        await nominatePlayer(
          season.id,
          sessionFor(captain.user),
          player.id,
          9,
        )
      ).ok,
    ).toBe(true);
    await expireClock(season.id);
    const renderedSeason = await prisma.season.findUniqueOrThrow({
      where: { id: season.id },
    });

    const cancelled = await archiveIncompleteSeasonAction(
      {},
      fd({
        expectedActiveSeasonId: season.id,
        expectedSeasonUpdatedAt: renderedSeason.updatedAt.toISOString(),
      }),
    );

    expect(cancelled?.message).toMatch(/auction is paused/i);
    expect(
      await prisma.season.findUniqueOrThrow({ where: { id: season.id } }),
    ).toMatchObject({ isActive: false, status: "DRAFT" });
    expect(
      await prisma.draft.findUniqueOrThrow({ where: { seasonId: season.id } }),
    ).toMatchObject({
      status: "PAUSED",
      nominatedUserId: player.id,
      currentBidTeamId: captain.team.id,
      currentBid: 9,
      bidEndsAt: null,
      nominationEndsAt: null,
    });
    expect(await prisma.bid.count({ where: { seasonId: season.id } })).toBe(1);
    expect(await resolveExpiredNomination(season.id)).toBe(false);
    expect(
      await prisma.teamMember.count({
        where: { seasonId: season.id, userId: player.id },
      }),
    ).toBe(0);
    expect(
      (await prisma.team.findUniqueOrThrow({ where: { id: captain.team.id } }))
        .budget,
    ).toBe(100);
  });

  it.each([DRAFT_STATUS.NOT_STARTED, DRAFT_STATUS.COMPLETE])(
    "does not rewrite a %s draft while cancelling its season",
    async (draftStatus) => {
      const season = await makeSeason({
        name: `Cancelled ${draftStatus} draft`,
        status: "DRAFT",
      });
      await prisma.draft.create({
        data: { seasonId: season.id, status: draftStatus },
      });

      const cancelled = await archiveIncompleteSeasonAction(
        {},
        fd({
          expectedActiveSeasonId: season.id,
          expectedSeasonUpdatedAt: season.updatedAt.toISOString(),
        }),
      );

      expect(cancelled?.message).toMatch(/cancelled.*archived/i);
      expect(cancelled?.message).not.toMatch(/auction is paused/i);
      expect(
        await prisma.draft.findUniqueOrThrow({
          where: { seasonId: season.id },
        }),
      ).toMatchObject({
        status: draftStatus,
        bidEndsAt: null,
        nominationEndsAt: null,
      });
    },
  );

  it("refuses Complete without an authoritative same-season champion", async () => {
    const current = await makeSeason({ status: "COMPLETE" });
    const result = await createSeason(
      {},
      fd({ name: "Too Soon", expectedActiveSeasonId: current.id }),
    );
    expect(result?.error).toMatch(/without an authoritative champion/i);
    expect(await prisma.season.count()).toBe(1);
  });

  it("creates from a real offseason without claiming an unrelated archive", async () => {
    const archived = await makeSeason({ isActive: false });
    const result = await createSeason(
      {},
      fd({ name: "Season After Break", expectedActiveSeasonId: "" }),
    );

    expect(result?.error).toBeUndefined();
    expect(
      await prisma.season.findUniqueOrThrow({ where: { id: archived.id } }),
    ).toMatchObject({ isActive: false });
    expect(await prisma.season.count({ where: { isActive: true } })).toBe(1);
  });

  it("serializes opening a new season against restoring an archive", async () => {
    const archived = await makeSeason({
      name: "Possible Restore",
      isActive: false,
    });

    const outcomes = await raceAll<{ ok: boolean }>([
      async () => ({
        ok: !(
          await createSeason(
            {},
            fd({ name: "Possible New Season", expectedActiveSeasonId: "" }),
          )
        )?.error,
      }),
      async () => ({
        ok: (await reactivateSeason(archived.id, archived.updatedAt)).ok,
      }),
    ]);

    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(await prisma.season.count({ where: { isActive: true } })).toBe(1);
  });

  it("can deliberately archive a completed season into an offseason", async () => {
    const current = await completedSeason("Season Before Break");
    const result = await archiveCompletedSeasonAction(
      {},
      fd({ expectedActiveSeasonId: current.id }),
    );

    expect(result?.message).toMatch(/offseason/i);
    expect(await prisma.season.count({ where: { isActive: true } })).toBe(0);
    expect(
      await prisma.season.findUniqueOrThrow({ where: { id: current.id } }),
    ).toMatchObject({ status: "COMPLETE", isActive: false });
    expect(
      await prisma.setting.findUnique({ where: { key: "resultChangedAt" } }),
    ).not.toBeNull();
  });
});

describe.skipIf(!ON_POSTGRES)("season cancellation versus draft resume", () => {
  afterEach(() => setRaceHook(null));

  it("a stale Resume cannot restart clocks after cancellation archives the season", async () => {
    const season = await makeSeason({
      name: "Paused cancellation race",
      status: "DRAFT",
    });
    await prisma.draft.create({
      data: {
        seasonId: season.id,
        status: "PAUSED",
        nominatorTeamId: "preserved-nominator",
        nominatedUserId: "preserved-player",
        currentBid: 13,
        currentBidTeamId: "preserved-bidder",
      },
    });
    const rendered = await prisma.season.findUniqueOrThrow({
      where: { id: season.id },
    });
    const admin = sessionFor(await makeUser("Cancel Race Admin", "ADMIN"));
    let cancellation: Awaited<
      ReturnType<typeof archiveIncompleteSeasonAction>
    > = {};

    setRaceHook(
      onceAt("draft.resume.beforeClaim", async () => {
        cancellation = await archiveIncompleteSeasonAction(
          {},
          fd({
            expectedActiveSeasonId: season.id,
            expectedSeasonUpdatedAt: rendered.updatedAt.toISOString(),
          }),
        );
      }),
    );

    const resumed = await resumeDraft(season.id, admin);

    expect(cancellation?.message).toMatch(/cancelled.*archived/i);
    expect(resumed.ok).toBe(false);
    expect(
      await prisma.season.findUniqueOrThrow({ where: { id: season.id } }),
    ).toMatchObject({ isActive: false, status: "DRAFT" });
    expect(
      await prisma.draft.findUniqueOrThrow({ where: { seasonId: season.id } }),
    ).toMatchObject({
      status: "PAUSED",
      nominatedUserId: "preserved-player",
      currentBid: 13,
      bidEndsAt: null,
      nominationEndsAt: null,
    });
  });
});

describe("rendered season setting claims", () => {
  afterEach(() => setRaceHook(null));

  it("never copies values from a parked Season A form into newly active Season B", async () => {
    const a = await makeSeason({ name: "Season A", isActive: true });
    const staleBase = {
      expectedActiveSeasonId: a.id,
      expectedSeasonUpdatedAt: a.updatedAt.toISOString(),
    };
    await prisma.season.update({
      where: { id: a.id },
      data: { isActive: false },
    });
    const b = await makeSeason({
      name: "Season B",
      isActive: true,
      maxMmr: 1111,
      regularBestOf: 2,
      playoffBestOf: 3,
      finalBestOf: 5,
    });

    const attempts = [
      renameSeason({}, fd({ ...staleBase, name: "Wrong name" })),
      setMaxMmr({}, fd({ ...staleBase, maxMmr: "4999" })),
      setMatchSchedule(
        {},
        fd({ ...staleBase, matchSchedule: "Wrong night" }),
      ),
      setSeriesLengths(
        {},
        fd({
          ...staleBase,
          regularBestOf: "1",
          playoffBestOf: "7",
          finalBestOf: "7",
        }),
      ),
      setLeagueId({}, fd({ ...staleBase, dotaLeagueId: "17119" })),
    ];
    const results = await Promise.all(attempts);
    for (const result of results) {
      expect(result?.error).toMatch(/active season changed/i);
    }
    expect(
      await prisma.season.findUniqueOrThrow({ where: { id: b.id } }),
    ).toMatchObject({
      name: "Season B",
      maxMmr: 1111,
      matchSchedule: null,
      regularBestOf: 2,
      playoffBestOf: 3,
      finalBestOf: 5,
      dotaLeagueId: null,
    });
  });

  it("refuses a season switch that lands after the settings claim was read", async () => {
    const a = await makeSeason({ name: "Rendered Season A", isActive: true });
    let fired = false;
    let bId = "";
    setRaceHook(
      onceAt("admin.updateRenderedSeason.beforeWrite", async () => {
        fired = true;
        await prisma.season.update({
          where: { id: a.id },
          data: { isActive: false },
        });
        const b = await makeSeason({ name: "Fresh Season B", isActive: true });
        bId = b.id;
      }),
    );

    const result = await renameSeason(
      {},
      fd({
        expectedActiveSeasonId: a.id,
        expectedSeasonUpdatedAt: a.updatedAt.toISOString(),
        name: "Stale overwrite",
      }),
    );

    expect(fired).toBe(true);
    expect(result?.error).toMatch(/season changed.*reload/i);
    expect(
      await prisma.season.findUniqueOrThrow({ where: { id: a.id } }),
    ).toMatchObject({ name: "Rendered Season A", isActive: false });
    expect(
      await prisma.season.findUniqueOrThrow({ where: { id: bId } }),
    ).toMatchObject({ name: "Fresh Season B", isActive: true });
  });
});

describe("signup-facing season settings", () => {
  it("returns visible feedback and never lets a soft limit exceed the hard ceiling", async () => {
    const season = await makeSeason({ maxMmr: 0 });

    const result = await setMaxMmr(
      {},
      fd({
        maxMmr: "9999",
        expectedActiveSeasonId: season.id,
        expectedSeasonUpdatedAt: season.updatedAt.toISOString(),
      }),
    );

    expect(result?.message).toMatch(/5000/);
    expect(
      (await prisma.season.findUniqueOrThrow({ where: { id: season.id } }))
        .maxMmr,
    ).toBe(5000);
  });

  it("saves the schedule prospects see and confirms exactly what changed", async () => {
    const season = await makeSeason();

    const result = await setMatchSchedule(
      {},
      fd({
        matchSchedule: "  Tuesdays, 8pm ET  ",
        expectedActiveSeasonId: season.id,
        expectedSeasonUpdatedAt: season.updatedAt.toISOString(),
      }),
    );

    expect(result?.message).toContain("Tuesdays, 8pm ET");
    expect(
      (await prisma.season.findUniqueOrThrow({ where: { id: season.id } }))
        .matchSchedule,
    ).toBe("Tuesdays, 8pm ET");
  });
});
