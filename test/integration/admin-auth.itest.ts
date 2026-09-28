import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
}));

// The REAL auth path runs here: @/lib/auth is not mocked, so every call goes
// through getSessionUser → requireAdmin → adminOrError exactly as a request
// does. The only seam is the cookie store, which only exists inside a real
// request scope (the session.itest.ts jar).
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      jar.has(name) ? { name, value: jar.get(name)! } : undefined,
    set: (name: string, value: string, options: { maxAge?: number }) => {
      if (options.maxAge === 0) jar.delete(name);
      else jar.set(name, value);
    },
    delete: (name: string) => {
      jar.delete(name);
    },
  }),
}));

import * as season from "@/app/actions/admin-season";
import * as captainsDraft from "@/app/actions/admin-captains-draft";
import * as roster from "@/app/actions/admin-roster";
import * as scheduleResults from "@/app/actions/admin-schedule-results";
import * as discord from "@/app/actions/admin-discord";
import { createSession } from "@/lib/auth";
import { getSessionEpoch } from "@/lib/session-epoch";
import { prisma } from "@/lib/prisma";
import type { ActionResult } from "@/lib/action-result";
import { sourceFiles } from "../support/source-files";
import { makeUser } from "./factories";

type AdminAction = (prev: ActionResult, formData: FormData) => Promise<ActionResult>;

const MODULES = {
  "src/app/actions/admin-season.ts": season,
  "src/app/actions/admin-captains-draft.ts": captainsDraft,
  "src/app/actions/admin-roster.ts": roster,
  "src/app/actions/admin-schedule-results.ts": scheduleResults,
  "src/app/actions/admin-discord.ts": discord,
} as const;

/** Every exported action of every admin module, by name. */
const ACTIONS: Array<[string, AdminAction]> = Object.values(MODULES).flatMap(
  (mod) =>
    Object.entries(mod)
      .filter(([, value]) => typeof value === "function")
      .map(([name, fn]) => [name, fn as AdminAction] as [string, AdminAction]),
);

/**
 * The 61 actions src/app/actions/admin.ts exported before it was split by
 * job (2026-09-28). The split kept every name; each must still be exported by
 * exactly one of the admin modules.
 */
const ADMIN_TS_EXPORTS = [
  "abortDraftAction", "addCaptain", "archiveCompletedSeasonAction",
  "archiveIncompleteSeasonAction", "assignStandin", "autoDetectAction",
  "changeCaptain", "clearDiscordWebhook", "clearInhouseAlertWebhook",
  "clearInhouseWebhook", "createSeason", "deleteInhouseBoard", "deleteSeason",
  "discardWaitingDiscordPosts", "generateSchedule", "importGameAction",
  "pauseDraftAction", "postInhouseBoard", "promoteStandinToPlayer",
  "randomizeDraftOrder", "reactivateSeasonAction", "recordResult",
  "refreshPlayerData", "reinstateSignup", "reinstateTeam", "releasePlayer",
  "removeCaptain", "removeGame", "removeStandin", "renameSeason", "renameTeam",
  "reopenMatch", "resumeDraftAction", "returnToRegularSeasonAction",
  "revokeAllSessions", "setDiscordWebhook", "setDraftNight",
  "setDraftSettings", "setInhouseAlertWebhook", "setInhousePingRole",
  "setInhouseWebhook", "setLeagueId", "setMatchSchedule", "setMatchTime",
  "setMaxMmr", "setPlayerRank", "setRegistrationMmr", "setSeasonPhase",
  "setSeriesLengths", "setWeekNight", "signFreeAgent", "startDraft",
  "startPlayoffs", "syncLeagueAction", "testDiscordWebhook",
  "testInhouseWebhook", "transferCaptaincy", "undoLastSaleAction",
  "voidCurrentLotAction", "withdrawSignup", "withdrawTeam",
];

const NOT_AUTHORIZED = { error: "Not authorized" };

async function signInAs(role: "USER" | "ADMIN") {
  const user = await makeUser(role === "ADMIN" ? "League Admin" : "Player", role);
  await createSession(user.id);
  return user;
}

beforeEach(async () => {
  jar.clear();
  // Role comes from the stored row (no allowlist) in these tests.
  vi.stubEnv("ADMIN_STEAM_IDS", "");
  // Nothing past the auth gate may reach Discord, OpenDota or Steam. A
  // request here would mean an action ran for someone it should refuse.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("network is disabled in admin-auth.itest.ts");
    }),
  );
  // session-epoch caches in-process for 30s; a read stamped in the future
  // parks the cache on this database's epoch (0 after the reset).
  await getSessionEpoch(Date.now() + 120_000);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("every admin action refuses anyone who is not an admin", () => {
  it("covers every admin action module", () => {
    // A new "use server" admin-*.ts file must be added to MODULES, or its
    // actions would never be called below.
    const serverModules = sourceFiles("src/app/actions/admin*.ts", 6)
      .filter(({ text }) => /^["']use server["'];/.test(text))
      .map(({ path }) => path);
    expect(serverModules).toEqual(Object.keys(MODULES).sort());
  });

  it("kept every action admin.ts exported, each in exactly one module", () => {
    const names = ACTIONS.map(([name]) => name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of ADMIN_TS_EXPORTS) expect(names).toContain(name);
  });

  it("refuses a signed-out visitor", async () => {
    expect(ACTIONS.length).toBeGreaterThanOrEqual(ADMIN_TS_EXPORTS.length);
    for (const [name, action] of ACTIONS) {
      expect(await action(null, new FormData()), name).toEqual(NOT_AUTHORIZED);
    }
    expect(await prisma.adminAction.count()).toBe(0);
  });

  it("refuses a signed-in player without the admin role", async () => {
    await signInAs("USER");
    for (const [name, action] of ACTIONS) {
      expect(await action(null, new FormData()), name).toEqual(NOT_AUTHORIZED);
    }
    expect(await prisma.adminAction.count()).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("lets an admin past the same gate (so the refusals above are real)", async () => {
    // Positive control: the same jar and session path, with the admin role,
    // must reach the action's own checks. Renaming with a blank form stops at
    // the stale-form check and writes nothing.
    await signInAs("ADMIN");
    const result = await season.renameSeason(null, new FormData());
    expect(result).not.toEqual(NOT_AUTHORIZED);
    expect(result?.error).toMatch(/reload/i);
  });
});
