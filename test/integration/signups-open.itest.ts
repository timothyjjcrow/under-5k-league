import { beforeEach, describe, expect, it, vi } from "vitest";

// Opening a season posts "signups are open" to the league channel once, after
// the create commits, mentioning nobody.
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
  getWebhookUrl: vi.fn(async () => "https://discord.test/hook"),
  sendDiscordMessage: vi.fn(async () => true),
}));

import { createSeason } from "@/app/actions/admin-season";
import { getWebhookUrl, sendDiscordMessage } from "@/lib/discord";
import { announceSignupsOpenOnce } from "@/lib/signups-open-announcement";
import { prisma } from "@/lib/prisma";
import { SEASON_STATUS } from "@/lib/constants";
import { signupsOpenAnnouncedKey } from "@/lib/settings";
import { makeSeason } from "./factories";

const mockSend = vi.mocked(sendDiscordMessage);
const mockHook = vi.mocked(getWebhookUrl);

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue(true);
  mockHook.mockReset();
  mockHook.mockResolvedValue("https://discord.test/hook");
});

function createForm(name: string): FormData {
  const f = new FormData();
  f.set("name", name);
  f.set("teamSize", "5");
  f.set("minTeams", "4");
  f.set("draftBudget", "100");
  f.set("expectedActiveSeasonId", "");
  return f;
}

describe("signups-open announcement", () => {
  it("posts once when an admin opens a season, mentioning nobody", async () => {
    const res = await createSeason({}, createForm("Season 9"));
    expect(res?.error).toBeUndefined();

    expect(mockSend).toHaveBeenCalledTimes(1);
    const [content, mentions, options] = mockSend.mock.calls[0]!;
    expect(content).toContain("**Season 9 signups are open!**");
    expect(content).toMatch(/Sign up: <[^>]+\/me>/);
    expect(mentions).toBeUndefined();
    expect(options?.dedupeKey).toMatch(/^signups:/);

    const season = await prisma.season.findFirstOrThrow({
      where: { isActive: true },
    });
    const marker = await prisma.setting.findUnique({
      where: { key: signupsOpenAnnouncedKey(season.id) },
    });
    expect(marker?.value).toMatch(/^sent:v2:/);
    expect(options?.marker?.key).toBe(signupsOpenAnnouncedKey(season.id));

    // A second call for the same season is a no-op.
    expect(await announceSignupsOpenOnce(season.id)).toBe(false);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("names the admin's match night when the season has one", async () => {
    const season = await makeSeason();
    await prisma.season.update({
      where: { id: season.id },
      data: { matchSchedule: "Wednesdays, 8pm ET." },
    });
    expect(await announceSignupsOpenOnce(season.id)).toBe(true);
    expect(mockSend.mock.calls[0]![0]).toContain(
      "Match night: Wednesdays, 8pm ET.",
    );
  });

  it("burns no marker without a webhook, so a later setup can still post", async () => {
    mockHook.mockResolvedValue("");
    const res = await createSeason({}, createForm("Quiet Season"));
    expect(res?.error).toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
    expect(
      await prisma.setting.count({
        where: { key: { startsWith: "signupsOpenAnnounced:" } },
      }),
    ).toBe(0);
  });

  it("says nothing once the season has left signups, and keeps no marker", async () => {
    const season = await makeSeason({ status: SEASON_STATUS.DRAFT });
    expect(await announceSignupsOpenOnce(season.id)).toBe(false);
    expect(mockSend).not.toHaveBeenCalled();
    expect(
      await prisma.setting.findUnique({
        where: { key: signupsOpenAnnouncedKey(season.id) },
      }),
    ).toBeNull();
  });

  it("releases the claim when the post cannot be queued", async () => {
    const season = await makeSeason();
    mockSend.mockResolvedValue(false);
    expect(await announceSignupsOpenOnce(season.id)).toBe(false);
    expect(
      await prisma.setting.findUnique({
        where: { key: signupsOpenAnnouncedKey(season.id) },
      }),
    ).toBeNull();
    mockSend.mockResolvedValue(true);
    expect(await announceSignupsOpenOnce(season.id)).toBe(true);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });
});
