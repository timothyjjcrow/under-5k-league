import { describe, expect, it, vi } from "vitest";

// The league's stream link on /admin's Match stream card: saved in its
// canonical form, refused for anything but a known streaming host, cleared
// by a blank save, and logged each time. It belongs to the league, so it
// works with no active season.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn(async () => ({ id: "test-admin", name: "Test administrator", role: "ADMIN", steamId: "76561198000000000", avatar: null })),
  requireUser: vi.fn(),
  getSessionUser: vi.fn(async () => null),
}));

import { setLeagueStreamUrl } from "@/app/actions/admin-season";
import { STREAM_HOST_ERROR } from "@/lib/broadcast";
import { prisma } from "@/lib/prisma";
import { getLeagueStream } from "@/lib/queries";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import { makeSeason } from "./factories";

function streamForm(value: string): FormData {
  const f = new FormData();
  f.set("streamUrl", value);
  return f;
}

async function auditLog() {
  return prisma.adminAction.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { action: true, seasonId: true, summary: true },
  });
}

describe("the league stream link", () => {
  it("saves the canonical link, reads it back and logs it", async () => {
    const season = await makeSeason({ status: "PLAYOFFS" });
    const res = await setLeagueStreamUrl(
      {},
      streamForm("  HTTPS://WWW.TWITCH.TV/ggd2l  "),
    );
    expect(res?.error).toBeUndefined();
    expect(res?.message).toBe(
      "Stream link saved: playoff and final matches now link to https://www.twitch.tv/ggd2l, and play it on the site while live",
    );
    expect(await getSetting(SETTING_KEYS.LEAGUE_STREAM_URL)).toBe(
      "https://www.twitch.tv/ggd2l",
    );
    expect(await getLeagueStream()).toEqual({
      url: "https://www.twitch.tv/ggd2l",
      platform: "Twitch",
    });
    expect(await auditLog()).toEqual([
      {
        action: "setLeagueStreamUrl",
        seasonId: season.id,
        summary: "Set the league stream link to https://www.twitch.tv/ggd2l",
      },
    ]);
  });

  it("says when a saved link can only link out", async () => {
    const res = await setLeagueStreamUrl(
      {},
      streamForm("https://www.youtube.com/@ggd2l/live"),
    );
    expect(res?.message).toBe(
      "Stream link saved: playoff and final matches now link to https://www.youtube.com/@ggd2l/live. It can't play on the site: use the live video's link or a youtube.com/channel/UC… link for that",
    );
    expect(
      (await setLeagueStreamUrl({}, streamForm("https://kick.com/browse")))
        ?.message,
    ).toBe(
      "Stream link saved: playoff and final matches now link to https://kick.com/browse. It can't play on the site: use the channel's own link for that",
    );
    expect(
      (await setLeagueStreamUrl({}, streamForm("https://youtu.be/dQw4w9WgXcQ")))
        ?.message,
    ).toBe(
      "Stream link saved: playoff and final matches now link to https://youtu.be/dQw4w9WgXcQ, and play it on the site while live",
    );
  });

  it("refuses a link off the streaming hosts and keeps the saved one", async () => {
    await setLeagueStreamUrl({}, streamForm("https://www.youtube.com/@ggd2l/live"));
    for (const bad of [
      "https://twitch.tv.evil.example/ggd2l",
      "http://www.twitch.tv/ggd2l",
      "https://user:pass@www.twitch.tv/ggd2l",
      "not a link",
    ]) {
      const res = await setLeagueStreamUrl({}, streamForm(bad));
      expect(res?.error, bad).toBeTruthy();
    }
    expect(
      (await setLeagueStreamUrl({}, streamForm("https://evil.example/live")))
        ?.error,
    ).toBe(STREAM_HOST_ERROR);
    expect(await getSetting(SETTING_KEYS.LEAGUE_STREAM_URL)).toBe(
      "https://www.youtube.com/@ggd2l/live",
    );
    // Only the one save is logged.
    expect((await auditLog()).map((row) => row.action)).toEqual([
      "setLeagueStreamUrl",
    ]);
  });

  it("clears with a blank save, with no active season", async () => {
    await setLeagueStreamUrl({}, streamForm("https://kick.com/ggd2l"));
    const res = await setLeagueStreamUrl({}, streamForm(""));
    expect(res?.error).toBeUndefined();
    expect(res?.message).toBe(
      "Stream link removed: matches show no watch links",
    );
    expect(await getSetting(SETTING_KEYS.LEAGUE_STREAM_URL)).toBeNull();
    expect(await getLeagueStream()).toBeNull();
    expect(await auditLog()).toEqual([
      {
        action: "setLeagueStreamUrl",
        seasonId: null,
        summary: "Set the league stream link to https://kick.com/ggd2l",
      },
      {
        action: "setLeagueStreamUrl",
        seasonId: null,
        summary: "Removed the league stream link; matches show no watch links",
      },
    ]);
  });

  it("renders nothing for a stored value that no longer passes the check", async () => {
    await prisma.setting.create({
      data: {
        key: SETTING_KEYS.LEAGUE_STREAM_URL,
        value: "https://evil.example/stream",
      },
    });
    expect(await getLeagueStream()).toBeNull();
  });
});
