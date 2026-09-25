import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), updateTag: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireAdmin: vi.fn() }));

import { revalidatePath, updateTag } from "next/cache";
import { ignoreImportCandidate, retryImportCandidate } from "@/app/actions/import-progress";
import { requireAdmin } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import { AUTOMATION_GATE_TAG } from "@/lib/automation-gate-constants";
import { makeSeason, makeUser, ON_POSTGRES, raceAll, sessionFor } from "./factories";

const MATCH_ID = "9900018804";

function evidence() {
  return JSON.stringify({
    match_id: Number(MATCH_ID),
    start_time: 1_790_000_000,
    duration: 2400,
    radiant_win: true,
    players: Array.from({ length: 10 }, (_, index) => ({ account_id: index + 1 })),
  });
}

async function setup(payload: string | null = null) {
  const season = await makeSeason({ status: "REGULAR_SEASON" });
  const candidate = await prisma.importCandidate.create({
    data: {
      seasonId: season.id,
      dotaMatchId: MATCH_ID,
      status: "NEEDS_REVIEW",
      reason: "PROVIDER_UNAVAILABLE",
      attempts: 8,
      payload,
      fetchedAt: payload ? new Date() : null,
      nextAttemptAt: new Date(Date.now() + 60 * 60_000),
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
    },
  });
  return { season, candidate };
}

function form(candidate: { id: string; seasonId: string; revision: number }, overrides: Record<string, string> = {}) {
  const result = new FormData();
  for (const [key, value] of Object.entries({
    candidateId: candidate.id,
    seasonId: candidate.seasonId,
    expectedRevision: String(candidate.revision),
    ...overrides,
  })) result.set(key, value);
  return result;
}

beforeEach(async () => {
  const admin = await makeUser("Progress administrator", "ADMIN");
  vi.mocked(requireAdmin).mockReset();
  vi.mocked(requireAdmin).mockResolvedValue(sessionFor(admin));
  vi.mocked(revalidatePath).mockClear();
  vi.mocked(updateTag).mockClear();
});

afterEach(() => {
  setRaceHook(null);
  vi.restoreAllMocks();
});

describe("saved import progress commands", () => {
  it.each(["UNAUTHORIZED", "FORBIDDEN"])("rejects both commands when authorization fails with %s", async (error) => {
    const { candidate } = await setup();
    vi.mocked(requireAdmin).mockRejectedValue(new Error(error));
    expect(await retryImportCandidate(null, form(candidate))).toEqual({ error: "Not authorized" });
    expect(await ignoreImportCandidate(null, form(candidate, { reason: "Wrong event" }))).toEqual({ error: "Not authorized" });
    expect(await prisma.importCandidate.findUnique({ where: { id: candidate.id } })).toEqual(candidate);
    expect(await prisma.importSuppression.count()).toBe(0);
    expect(await prisma.adminAction.count()).toBe(0);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("validates the candidate, rendered revision, and explicit bounded Ignore reason", async () => {
    const { candidate } = await setup();
    const invalidForms: Record<string, string>[] = [{ candidateId: "bad id" }, { seasonId: "" }, { expectedRevision: "" }, { expectedRevision: "-1" }, { expectedRevision: "1.5" }];
    for (const overrides of invalidForms) {
      expect((await retryImportCandidate(null, form(candidate, overrides)))?.error).toMatch(/invalid/i);
    }
    for (const reason of ["", "   ", "x".repeat(301)]) {
      expect((await ignoreImportCandidate(null, form(candidate, { reason })))?.error).toMatch(/reason/i);
    }
    expect(await prisma.importCandidate.findUnique({ where: { id: candidate.id } })).toEqual(candidate);
    expect(await prisma.importSuppression.count()).toBe(0);
    expect(await prisma.adminAction.count()).toBe(0);
  });

  it.each([null, "not-json", JSON.stringify({ match_id: 42, players: [] })])("queues missing or invalid evidence for a fresh fetch without making a provider request: %s", async (payload) => {
    const { candidate } = await setup(payload);
    const fetch = vi.spyOn(globalThis, "fetch");
    const result = await retryImportCandidate(null, form(candidate));
    expect(result?.error).toBeUndefined();
    expect(result?.message).toMatch(/next league sync/i);
    const saved = await prisma.importCandidate.findUniqueOrThrow({ where: { id: candidate.id } });
    expect(saved).toMatchObject({ status: "PENDING", attempts: 0, payload: null, fetchedAt: null, nextAttemptAt: null, reason: null });
    expect(saved.expiresAt.getTime()).toBeGreaterThan(candidate.expiresAt.getTime());
    expect(saved.revision).toBe(candidate.revision + 1);
    expect(fetch).not.toHaveBeenCalled();
    expect(updateTag).toHaveBeenCalledWith(AUTOMATION_GATE_TAG);
    expect(revalidatePath).toHaveBeenCalledWith("/admin");
    expect(await prisma.adminAction.findFirst()).toMatchObject({ action: "retryImportCandidate", actorName: "Progress administrator", seasonId: candidate.seasonId });
  });

  it("retains valid downloaded details and clears attempts/backoff for the next sync", async () => {
    const { candidate } = await setup(evidence());
    expect((await retryImportCandidate(null, form(candidate)))?.error).toBeUndefined();
    expect(await prisma.importCandidate.findUnique({ where: { id: candidate.id } })).toMatchObject({
      status: "READY", payload: candidate.payload, fetchedAt: candidate.fetchedAt,
      attempts: 0, nextAttemptAt: null, reason: null,
    });
    expect(await prisma.importSuppression.count()).toBe(0);
    expect((await retryImportCandidate(null, form(candidate)))?.error).toMatch(/changed/i);
    expect(await prisma.adminAction.count()).toBe(1);
  });

  it("ignores durably with a reason and actor, independently of the expiring candidate", async () => {
    const { candidate } = await setup(evidence());
    const result = await ignoreImportCandidate(null, form(candidate, { reason: "  Practice lobby outside the fixture  " }));
    expect(result?.error).toBeUndefined();
    const saved = await prisma.importCandidate.findUniqueOrThrow({ where: { id: candidate.id } });
    expect(saved).toMatchObject({ status: "IGNORED", reason: "ADMIN_IGNORED", nextAttemptAt: null });
    expect(await prisma.importSuppression.findFirst()).toMatchObject({
      seasonId: candidate.seasonId, dotaMatchId: MATCH_ID, reason: "Practice lobby outside the fixture",
    });
    expect(await prisma.adminAction.findFirst()).toMatchObject({
      action: "ignoreImportCandidate", actorName: "Progress administrator",
      summary: expect.stringContaining("Practice lobby outside the fixture"),
    });
    expect((await retryImportCandidate(null, form(saved)))?.error).toMatch(/deliberately excluded/i);
    await prisma.importCandidate.delete({ where: { id: saved.id } });
    expect(await prisma.importSuppression.count()).toBe(1);
    expect(await prisma.game.count()).toBe(0);
  });

  it.each(["durable", "legacy"])("Retry preserves %s administrator exclusions", async (kind) => {
    const { candidate } = await setup(evidence());
    if (kind === "durable") {
      await prisma.importSuppression.create({ data: { seasonId: candidate.seasonId, dotaMatchId: MATCH_ID, reason: "Earlier correction" } });
    } else {
      await prisma.setting.create({ data: { key: `importSkip:${candidate.seasonId}`, value: JSON.stringify([MATCH_ID]) } });
    }
    const result = await retryImportCandidate(null, form(candidate));
    expect(result?.error).toMatch(/deliberately excluded.*match page/i);
    expect(await prisma.importCandidate.findUnique({ where: { id: candidate.id } })).toEqual(candidate);
    expect(await prisma.adminAction.count()).toBe(0);
    if (kind === "durable") expect(await prisma.importSuppression.findFirst()).toMatchObject({ reason: "Earlier correction" });
    else expect(await prisma.setting.findUnique({ where: { key: `importSkip:${candidate.seasonId}` } })).toMatchObject({ value: JSON.stringify([MATCH_ID]) });
  });

  it("fails closed on corrupt legacy exclusions without returning internal error details", async () => {
    const { candidate } = await setup();
    await prisma.setting.create({ data: { key: `importSkip:${candidate.seasonId}`, value: "PRIVATE_CORRUPT_DATA" } });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await retryImportCandidate(null, form(candidate));
    expect(result?.error).toMatch(/could not update/i);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_CORRUPT_DATA");
    expect(log).toHaveBeenCalledWith("[server-action:IMPORT_PROGRESS_UPDATE_FAILED] unexpected failure");
    expect(await prisma.importCandidate.findUnique({ where: { id: candidate.id } })).toEqual(candidate);
  });

  it("rejects stale forms, unknown candidates, and candidates outside the active season", async () => {
    const { season, candidate } = await setup();
    expect((await retryImportCandidate(null, form(candidate, { expectedRevision: String(candidate.revision + 1) })))?.error).toMatch(/changed/i);
    expect((await retryImportCandidate(null, form(candidate, { candidateId: "missing" })))?.error).toMatch(/current season/i);
    await prisma.season.update({ where: { id: season.id }, data: { isActive: false } });
    await makeSeason({ status: "SIGNUPS" });
    expect((await ignoreImportCandidate(null, form(candidate, { reason: "Wrong event" })))?.error).toMatch(/current season/i);
    expect(await prisma.importSuppression.count()).toBe(0);
    expect(await prisma.adminAction.count()).toBe(0);
  });

  it("does not change an item that has already been recorded", async () => {
    const { candidate } = await setup();
    await prisma.dotaMatchClaim.create({ data: { dotaMatchId: MATCH_ID, kind: "LEAGUE", contextId: "recorded-fixture" } });
    expect((await ignoreImportCandidate(null, form(candidate, { reason: "Wrong event" })))?.error).toMatch(/already recorded/i);
    expect((await retryImportCandidate(null, form(candidate)))?.error).toMatch(/already recorded/i);
    expect(await prisma.importSuppression.count()).toBe(0);
    expect(await prisma.adminAction.count()).toBe(0);
  });

  it("rolls back the candidate and exclusion if the required audit cannot be stored", async () => {
    const { candidate } = await setup();
    vi.spyOn(console, "error").mockImplementation(() => {});
    setRaceHook(onceAt("importProgress.beforeAudit", async () => { throw new Error("audit storage unavailable"); }));
    expect((await ignoreImportCandidate(null, form(candidate, { reason: "Wrong event" })))?.error).toMatch(/could not update/i);
    expect(await prisma.importCandidate.findUnique({ where: { id: candidate.id } })).toEqual(candidate);
    expect(await prisma.importSuppression.count()).toBe(0);
    expect(await prisma.adminAction.count()).toBe(0);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("serializes Retry and Ignore for one rendered candidate revision", async () => {
    const { candidate } = await setup(evidence());
    const results = await raceAll([
      () => retryImportCandidate(null, form(candidate)),
      () => ignoreImportCandidate(null, form(candidate, { reason: "Wrong event" })),
    ]);
    expect(results.filter((result) => result?.message)).toHaveLength(1);
    expect(results.filter((result) => result?.error)).toHaveLength(1);
    const saved = await prisma.importCandidate.findUniqueOrThrow({ where: { id: candidate.id } });
    expect(["READY", "IGNORED"]).toContain(saved.status);
    expect(await prisma.importSuppression.count()).toBe(saved.status === "IGNORED" ? 1 : 0);
    expect(await prisma.adminAction.count()).toBe(1);
  });

  it.skipIf(!ON_POSTGRES)("rejects a season archived after the initial transaction read", async () => {
    const { season, candidate } = await setup();
    setRaceHook(onceAt("importProgress.beforeClaim", async () => {
      await prisma.season.update({ where: { id: season.id }, data: { isActive: false } });
    }));
    expect((await ignoreImportCandidate(null, form(candidate, { reason: "Wrong event" })))?.error).toMatch(/changed/i);
    expect(await prisma.importSuppression.count()).toBe(0);
    expect(await prisma.importCandidate.findUnique({ where: { id: candidate.id } })).toEqual(candidate);
  });
});
