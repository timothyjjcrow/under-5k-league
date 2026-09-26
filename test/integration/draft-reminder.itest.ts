import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(),
  requireAdmin: vi.fn(),
}));
// Keep the formatters real; stub the webhook lookup + the network send.
vi.mock("@/lib/discord", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/discord")>();
  return {
    ...actual,
    getWebhookUrl: vi.fn(async () => "https://discord.test/hook"),
    sendDiscordMessage: vi.fn(async () => true),
  };
});

import { setDraftNight, startDraft } from "@/app/actions/admin";
import { requireAdmin } from "@/lib/auth";
import {
  getWebhookUrl,
  materializeAllowedMentions,
  sendDiscordMessage,
} from "@/lib/discord";
import { DRAFT_STATUS, SEASON_STATUS } from "@/lib/constants";
import { claimAnnouncementMarker } from "@/lib/announcement-marker";
import { onceAt, setRaceHook } from "@/lib/race-hook";
import { prisma } from "@/lib/prisma";
import { maybeAnnounceDraftNight } from "@/lib/reminder-service";
import { runResultSync } from "@/lib/result-sync-service";
import { draftReminderKey } from "@/lib/settings";
import {
  makeCaptain,
  makePlayer,
  makeSeason,
  makeUser,
  sessionFor,
  startDraftState,
} from "./factories";

const mockSend = vi.mocked(sendDiscordMessage);
const mockHook = vi.mocked(getWebhookUrl);
const HOUR = 3_600_000;

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue(true);
  mockHook.mockReset();
  mockHook.mockResolvedValue("https://discord.test/hook");
});
afterEach(() => setRaceHook(null));

const reminderCalls = () =>
  mockSend.mock.calls.filter((call) =>
    String(call[0]).startsWith("⏰ **Draft night reminder"),
  );
const markerCount = (seasonId: string) =>
  prisma.setting.count({
    where: { key: { startsWith: `draftReminder:${seasonId}:` } },
  });
const reload = (id: string) =>
  prisma.season.findUniqueOrThrow({ where: { id } });

function fd(fields: Record<string, string | number>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.set(key, String(value));
  }
  return form;
}

let snowflake = BigInt("900000000000000000");
async function link(userId: string): Promise<string> {
  snowflake += BigInt(1);
  const discordId = snowflake.toString();
  await prisma.user.update({ where: { id: userId }, data: { discordId } });
  return discordId;
}

/**
 * A setup-phase season whose draft is `offsetHours` away, with two captains
 * (one linked), a linked and an unlinked straggler, a linked player who has
 * confirmed THIS revision, a linked player whose confirmation went stale, and
 * the two registrations that must never count: a standin and a withdrawal.
 */
async function setupDraftNight(
  offsetHours: number | null,
  status: string = SEASON_STATUS.SIGNUPS,
) {
  const season = await makeSeason({
    name: "Season 9",
    status,
    draftAt:
      offsetHours === null ? null : new Date(Date.now() + offsetHours * HOUR),
    draftRevision: 1,
  });
  const capA = await makeCaptain(season.id, "Cap A", 100, 0);
  const capB = await makeCaptain(season.id, "Cap B", 100, 1);
  const linkedLate = await makePlayer(season.id, "Linked Late", 3000);
  await makePlayer(season.id, "Unlinked Late", 3000);
  const confirmed = await makePlayer(season.id, "Confirmed", 3000);
  const stale = await makePlayer(season.id, "Stale", 3000);
  await prisma.registration.updateMany({
    where: { seasonId: season.id, userId: confirmed.id },
    data: { draftConfirmedRevision: 1, draftConfirmedAt: new Date() },
  });
  await prisma.registration.updateMany({
    where: { seasonId: season.id, userId: stale.id },
    data: { draftConfirmedRevision: 0, draftConfirmedAt: new Date() },
  });
  const standin = await makeUser("Standin");
  await prisma.registration.create({
    data: {
      seasonId: season.id,
      userId: standin.id,
      type: "STANDIN",
      status: "ACTIVE",
      mmr: 3000,
    },
  });
  const withdrawn = await makePlayer(season.id, "Withdrawn", 3000);
  await prisma.registration.updateMany({
    where: { seasonId: season.id, userId: withdrawn.id },
    data: { status: "WITHDRAWN" },
  });
  const ids = {
    capA: await link(capA.user.id),
    linkedLate: await link(linkedLate.id),
    confirmed: await link(confirmed.id),
    stale: await link(stale.id),
    standin: await link(standin.id),
    withdrawn: await link(withdrawn.id),
  };
  return { season, capA, capB, ids };
}

async function retire(seasonId: string) {
  await prisma.season.update({
    where: { id: seasonId },
    data: { isActive: false },
  });
}

describe("draft-night reminder (integration)", () => {
  it("announces once inside the window, even when two runs race", async () => {
    const { season, ids } = await setupDraftNight(4);

    const results = await Promise.all([
      maybeAnnounceDraftNight(season),
      maybeAnnounceDraftNight(season),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(mockSend).toHaveBeenCalledTimes(1);

    const [content, mentions, options] = mockSend.mock.calls[0];
    const seconds = Math.floor(season.draftAt!.getTime() / 1000);
    expect(content).toContain("the Season 9 draft is scheduled for");
    expect(content).toContain(`<t:${seconds}:F>`);
    expect(content).toContain(`<t:${seconds}:R>`);
    // Captains + ACTIVE players only: no standin, no withdrawal.
    expect(content).toContain("**6** players signed up, **2** captains designated.");
    expect(content).toContain("Player signups stay open until the auction starts.");
    expect(content).toMatch(/Draft room: <https?:\/\/[^>]+\/draft>/);
    expect(content).toMatch(/Signup page: <https?:\/\/[^>]+\/me>/);
    expect(content).toContain(`Captains, be in the draft room before the auction starts: <@${ids.capA}>, Cap B`);
    // Linked stragglers first, then the unlinked one by name.
    expect(content).toContain(
      `Still to confirm this draft time (3): <@${ids.linkedLate}>, <@${ids.stale}>, Unlinked Late.`,
    );
    expect(content).not.toContain("—");

    // Exactly the visibly named, linked people may be pinged.
    expect(new Set(mentions?.users)).toEqual(
      new Set([ids.capA, ids.linkedLate, ids.stale]),
    );
    for (const quiet of [ids.confirmed, ids.standin, ids.withdrawn]) {
      expect(content).not.toContain(quiet);
    }
    expect(materializeAllowedMentions(content, mentions)).toBe(content);
    const key = draftReminderKey(season.id, 1);
    expect(options).toMatchObject({
      dedupeKey: expect.stringMatching(/^reminder:/),
      marker: { key },
    });

    // Once only: the marker is finalized and every later run is a no-op.
    expect(
      (await prisma.setting.findUniqueOrThrow({ where: { key } })).value,
    ).toMatch(/^sent:v2:/);
    expect(await maybeAnnounceDraftNight(season)).toBe(false);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("also runs in the DRAFT waiting room, and says player signups are closed", async () => {
    const { season } = await setupDraftNight(4, SEASON_STATUS.DRAFT);
    await prisma.draft.create({
      data: { seasonId: season.id, status: DRAFT_STATUS.NOT_STARTED },
    });

    expect(await maybeAnnounceDraftNight(season)).toBe(true);
    const content = String(mockSend.mock.calls[0][0]);
    expect(content).toContain("Player signups are closed; standins can still sign up.");
  });

  it("stays quiet and burns no marker outside the window, after the auction starts, off-phase, or without a webhook", async () => {
    const quiet = async (season: Parameters<typeof maybeAnnounceDraftNight>[0]) => {
      expect(await maybeAnnounceDraftNight(season)).toBe(false);
      expect(await markerCount(season.id)).toBe(0);
      await retire(season.id);
    };

    await quiet((await setupDraftNight(30)).season); // too far out
    await quiet((await setupDraftNight(-1)).season); // already passed
    await quiet((await setupDraftNight(null)).season); // no draft time
    await quiet(
      (await setupDraftNight(4, SEASON_STATUS.REGULAR_SEASON)).season,
    );

    // The auction started: both the fresh row and a caller's stale SIGNUPS
    // snapshot must see it (the service reads the Draft row itself).
    const started = await setupDraftNight(4);
    await startDraftState(started.season.id);
    expect(await maybeAnnounceDraftNight(started.season)).toBe(false);
    await quiet(await reload(started.season.id));

    // No Discord configured: nothing is claimed, so configuring a webhook
    // later still gets the reminder out.
    const unhooked = await setupDraftNight(4);
    mockHook.mockResolvedValue(null);
    expect(await maybeAnnounceDraftNight(unhooked.season)).toBe(false);
    expect(await markerCount(unhooked.season.id)).toBe(0);
    mockHook.mockResolvedValue("https://discord.test/hook");
    expect(await maybeAnnounceDraftNight(unhooked.season)).toBe(true);

    expect(reminderCalls()).toHaveLength(1);
  });

  it("a move inside the window after a delivered reminder does not ping everyone again", async () => {
    const { season } = await setupDraftNight(4);
    expect(await maybeAnnounceDraftNight(season)).toBe(true);

    const admin = await makeUser("Admin", "ADMIN");
    vi.mocked(requireAdmin).mockResolvedValue(sessionFor(admin));
    const moved = new Date(Date.now() + 6 * HOUR);
    const result = await setDraftNight(
      {},
      fd({
        expectedActiveSeasonId: season.id,
        draftAt: "moved",
        draftAtTs: moved.getTime(),
      }),
    );
    expect(result?.error).toBeUndefined();

    const current = await reload(season.id);
    expect(current.draftRevision).toBe(2);
    // The "Draft rescheduled" post carries the new time; the reminder that
    // pings every captain and straggler is not repeated for it.
    expect(await maybeAnnounceDraftNight(current)).toBe(false);
    expect(reminderCalls()).toHaveLength(1);
    expect(
      mockSend.mock.calls.some((call) => String(call[0]).includes(`<t:${Math.floor(moved.getTime() / 1000)}:`)),
    ).toBe(true);
    // The first reminder's delivered marker is history; the new revision is
    // recorded as covered so the worker never retries it.
    expect(
      (await prisma.setting.findUnique({ where: { key: draftReminderKey(season.id, 1) } }))
        ?.value,
    ).toMatch(/^sent:v2:/);
    expect(
      (await prisma.setting.findUnique({ where: { key: draftReminderKey(season.id, 2) } }))
        ?.value,
    ).toMatch(/^sent:v2:/);
  });

  it("re-arms when the draft moves out of the window, quoting the new time once it is close", async () => {
    const { season } = await setupDraftNight(4);
    expect(await maybeAnnounceDraftNight(season)).toBe(true);

    const admin = await makeUser("Admin", "ADMIN");
    vi.mocked(requireAdmin).mockResolvedValue(sessionFor(admin));
    const result = await setDraftNight(
      {},
      fd({
        expectedActiveSeasonId: season.id,
        draftAt: "next week",
        draftAtTs: Date.now() + 7 * 24 * HOUR,
      }),
    );
    expect(result?.error).toBeUndefined();
    const current = await reload(season.id);
    expect(current.draftRevision).toBe(2);
    expect(await prisma.setting.findUnique({ where: { key: draftReminderKey(season.id, 2) } })).toBeNull();
    expect(await maybeAnnounceDraftNight(current)).toBe(false);

    // A week passes: the same revision is now inside its window.
    const close = new Date(Date.now() + 6 * HOUR);
    const later = await prisma.season.update({ where: { id: season.id }, data: { draftAt: close } });
    expect(await maybeAnnounceDraftNight(later)).toBe(true);
    const reminders = reminderCalls();
    expect(reminders).toHaveLength(2);
    expect(String(reminders[1][0])).toContain(
      `<t:${Math.floor(close.getTime() / 1000)}:F>`,
    );
  });

  it("a first draft time set inside the window still gets its reminder", async () => {
    const { season } = await setupDraftNight(null);
    const admin = await makeUser("Admin", "ADMIN");
    vi.mocked(requireAdmin).mockResolvedValue(sessionFor(admin));
    const when = new Date(Date.now() + 5 * HOUR);
    const result = await setDraftNight(
      {},
      fd({ expectedActiveSeasonId: season.id, draftAt: "tonight", draftAtTs: when.getTime() }),
    );
    expect(result?.error).toBeUndefined();
    expect(await maybeAnnounceDraftNight(await reload(season.id))).toBe(true);
    expect(reminderCalls()).toHaveLength(1);
  });

  it("retries a failed send under the same event instead of eating it", async () => {
    const { season } = await setupDraftNight(4);
    const key = draftReminderKey(season.id, 1);

    mockSend.mockResolvedValue(false);
    expect(await maybeAnnounceDraftNight(season)).toBe(false);
    const failed = await prisma.setting.findUniqueOrThrow({ where: { key } });
    const eventId = /^failed:v2:([^:]+):/.exec(failed.value)?.[1];
    expect(eventId).toBeTruthy();
    const firstDedupeKey = mockSend.mock.calls[0]?.[2]?.dedupeKey;
    expect(firstDedupeKey).toMatch(new RegExp(`${eventId}$`));

    mockSend.mockResolvedValue(true);
    expect(await maybeAnnounceDraftNight(season)).toBe(true);
    expect(mockSend.mock.calls[1]?.[2]?.dedupeKey).toBe(firstDedupeKey);
    expect(
      (await prisma.setting.findUniqueOrThrow({ where: { key } })).value,
    ).toMatch(new RegExp(`^sent:v2:${eventId}:`));
    expect(await maybeAnnounceDraftNight(season)).toBe(false);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("releases its claim when the draft moves mid-call, then announces the new time", async () => {
    const { season } = await setupDraftNight(4);
    const moved = new Date(Date.now() + 8 * HOUR);
    let fired = false;
    setRaceHook(
      onceAt("draftReminder.afterClaim", async () => {
        fired = true;
        await prisma.season.update({
          where: { id: season.id },
          data: { draftAt: moved, draftRevision: { increment: 1 } },
        });
      }),
    );

    expect(await maybeAnnounceDraftNight(season)).toBe(false);
    expect(fired).toBe(true);
    expect(mockSend).not.toHaveBeenCalled();
    expect(await markerCount(season.id)).toBe(0);

    setRaceHook(null);
    expect(await maybeAnnounceDraftNight(await reload(season.id))).toBe(true);
    expect(String(mockSend.mock.calls[0][0])).toContain(
      `<t:${Math.floor(moved.getTime() / 1000)}:F>`,
    );
  });

  it("releases its claim when the auction starts mid-call, and stays quiet", async () => {
    const { season } = await setupDraftNight(4);
    let fired = false;
    setRaceHook(
      onceAt("draftReminder.afterClaim", async () => {
        fired = true;
        await startDraftState(season.id);
      }),
    );

    expect(await maybeAnnounceDraftNight(season)).toBe(false);
    expect(fired).toBe(true);
    expect(await markerCount(season.id)).toBe(0);
    setRaceHook(null);
    expect(await maybeAnnounceDraftNight(season)).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("setDraftNight drops an in-flight reminder for the old time, and only on a real change", async () => {
    const { season } = await setupDraftNight(4);
    const admin = await makeUser("Admin", "ADMIN");
    vi.mocked(requireAdmin).mockResolvedValue(sessionFor(admin));
    const key = draftReminderKey(season.id, 1);
    const claim = await claimAnnouncementMarker(key);
    expect(claim).not.toBeNull();

    // A no-op resubmit of the same time leaves the in-flight claim alone.
    await setDraftNight(
      {},
      fd({
        expectedActiveSeasonId: season.id,
        draftAt: "same",
        draftAtTs: season.draftAt!.getTime(),
      }),
    );
    expect(
      (await prisma.setting.findUnique({ where: { key } }))?.value,
    ).toBe(claim!.value);

    // A real move deletes it, so a queued send for the old time fails its
    // outbox source check instead of posting a stale time.
    await setDraftNight(
      {},
      fd({
        expectedActiveSeasonId: season.id,
        draftAt: "moved",
        draftAtTs: Date.now() + 10 * HOUR,
      }),
    );
    expect(await prisma.setting.findUnique({ where: { key } })).toBeNull();
    expect((await reload(season.id)).draftRevision).toBe(2);
  });

  it("starting the auction drops an in-flight reminder so it can't post afterwards", async () => {
    const { season } = await setupDraftNight(4);
    const admin = await makeUser("Admin", "ADMIN");
    vi.mocked(requireAdmin).mockResolvedValue(sessionFor(admin));
    const key = draftReminderKey(season.id, 1);
    const claim = await claimAnnouncementMarker(key);
    expect(claim).not.toBeNull();

    const started = await startDraft({}, fd({ expectedActiveSeasonId: season.id }));
    expect(started?.error).toBeUndefined();
    expect((await prisma.draft.findUniqueOrThrow({ where: { seasonId: season.id } })).status).toBe(
      DRAFT_STATUS.IN_PROGRESS,
    );
    expect(await prisma.setting.findUnique({ where: { key } })).toBeNull();
  });

  it("is wired into the automation worker", async () => {
    const { season } = await setupDraftNight(4);

    await runResultSync();
    expect(reminderCalls()).toHaveLength(1);
    expect(
      (await prisma.setting.findUniqueOrThrow({
        where: { key: draftReminderKey(season.id, 1) },
      })).value,
    ).toMatch(/^sent:v2:/);

    await runResultSync();
    expect(reminderCalls()).toHaveLength(1);
  });
});
