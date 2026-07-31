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

import { createSeason, deleteSeason } from "@/app/actions/admin";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import { prisma } from "@/lib/prisma";
import { MATCH_PHASE, MATCH_STATUS } from "@/lib/constants";
import { makePlayer, makeSeason, makeTeam } from "./factories";

function fd(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
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
  return { season, match };
}

describe("deleteSeason", () => {
  afterEach(() => setRaceHook(null));

  it("deletes an archived season and everything hanging off it", async () => {
    const { season, match } = await archivedSeasonWithHistory();

    const res = await deleteSeason({}, fd({ seasonId: season.id }));

    expect(res?.message).toMatch(/deleted/i);
    expect(
      await prisma.season.findUnique({ where: { id: season.id } }),
    ).toBeNull();
    expect(await prisma.match.count({ where: { seasonId: season.id } })).toBe(0);
    expect(await prisma.game.count({ where: { matchId: match.id } })).toBe(0);
    expect(await prisma.team.count({ where: { seasonId: season.id } })).toBe(0);
    expect(
      await prisma.registration.count({ where: { seasonId: season.id } }),
    ).toBe(0);
    // Honors markers live in the relationless Setting table — explicit cleanup.
    expect(
      await prisma.setting.count({
        where: { key: { startsWith: `honorsAnnounced:${season.id}` } },
      }),
    ).toBe(0);
    // The AdminAction record OUTLIVES the season it describes.
    const log = await prisma.adminAction.findFirst({
      where: { action: "deleteSeason" },
      orderBy: { createdAt: "desc" },
    });
    expect(log?.summary).toContain(season.name);
  });

  it("refuses the ACTIVE season at read time", async () => {
    const season = await makeSeason(); // isActive true
    const res = await deleteSeason({}, fd({ seasonId: season.id }));
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

    const res = await deleteSeason({}, fd({ seasonId: season.id }));

    expect(fired).toBe(true);
    expect(res?.error).toMatch(/just made active again/i);
    // Season intact, and — the part the throw exists for — its matches too.
    expect(
      await prisma.season.findUnique({ where: { id: season.id } }),
    ).not.toBeNull();
    expect(await prisma.match.count({ where: { seasonId: season.id } })).toBe(1);
    expect(await prisma.game.count({ where: { matchId: match.id } })).toBe(1);
  });
});

describe("createSeason", () => {
  it("archives every active season and opens the new one active", async () => {
    const oldSeason = await makeSeason();
    const f = fd({ name: "Season N+1", teamSize: "5", minTeams: "2" });
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
});
