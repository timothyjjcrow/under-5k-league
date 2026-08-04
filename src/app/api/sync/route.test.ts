import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));
vi.mock("@/lib/result-sync-service", () => ({ runResultSync: vi.fn() }));
vi.mock("@/lib/season", () => ({ getActiveSeason: vi.fn() }));
vi.mock("@/lib/reminder-service", () => ({
  maybeAnnounceUpcomingWeek: vi.fn(),
}));
vi.mock("@/lib/rate-limit", () => ({
  clientIp: vi.fn(() => "test-ip"),
  rateLimit: vi.fn(() => ({ allowed: true, retryAfterMs: 0 })),
}));

import { runResultSync } from "@/lib/result-sync-service";
import { getActiveSeason } from "@/lib/season";
import { maybeAnnounceUpcomingWeek } from "@/lib/reminder-service";
import { revalidatePath, revalidateTag } from "next/cache";
import { POST } from "./route";

const sync = vi.mocked(runResultSync);
const activeSeason = vi.mocked(getActiveSeason);
const remind = vi.mocked(maybeAnnounceUpcomingWeek);

beforeEach(() => {
  sync.mockReset();
  activeSeason.mockReset();
  remind.mockReset();
  vi.mocked(revalidatePath).mockReset();
  vi.mocked(revalidateTag).mockReset();
  activeSeason.mockResolvedValue(null);
});

const request = () =>
  new NextRequest("https://league.example/api/sync", { method: "POST" });

describe("sitewide sync route", () => {
  it("expires game statistics before the first read after an import", async () => {
    sync.mockResolvedValue({
      imported: 2,
      inhouse: false,
      draft: false,
      playoff: false,
      watch: false,
      cursor: "2026-08-03T12:00:00.000Z",
    });

    await POST(request());

    expect(revalidateTag).toHaveBeenCalledWith("games", { expire: 0 });
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("does not churn the game cache when no league game was imported", async () => {
    sync.mockResolvedValue({
      imported: 0,
      inhouse: true,
      draft: false,
      playoff: false,
      watch: false,
      cursor: null,
    });

    await POST(request());

    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("reports updated when this heartbeat advances a draft clock", async () => {
    sync.mockResolvedValue({
      imported: 0,
      inhouse: false,
      draft: true,
      playoff: false,
      watch: false,
      cursor: null,
    });

    const res = await POST(request());

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      updated: true,
      watch: false,
      cursor: null,
    });
  });

  it("reports updated when this heartbeat repairs the playoff bracket", async () => {
    sync.mockResolvedValue({
      imported: 0,
      inhouse: false,
      draft: false,
      playoff: true,
      watch: false,
      cursor: "2026-08-03T12:00:00.000Z",
    });

    const res = await POST(request());

    expect(await res.json()).toEqual({
      updated: true,
      watch: false,
      cursor: "2026-08-03T12:00:00.000Z",
    });
  });

  it("keeps the exact response quiet when a live draft has no due clock", async () => {
    sync.mockResolvedValue({
      imported: 0,
      inhouse: false,
      draft: false,
      playoff: false,
      watch: true,
      cursor: null,
    });

    const res = await POST(request());

    expect(await res.json()).toEqual({
      updated: false,
      watch: true,
      cursor: null,
    });
  });

  it("runs the match-night reminder from the externally pingable heartbeat", async () => {
    sync.mockResolvedValue({
      imported: 0,
      inhouse: false,
      draft: false,
      playoff: false,
      watch: false,
      cursor: null,
    });
    const season = {
      id: "season-1",
      status: "REGULAR_SEASON",
      teamSize: 5,
    };
    activeSeason.mockResolvedValue(season as never);
    remind.mockResolvedValue(true);

    const res = await POST(request());

    expect(res.status).toBe(200);
    expect(remind).toHaveBeenCalledWith(season);
  });

  it("keeps sync healthy when the reminder backstop fails", async () => {
    sync.mockResolvedValue({
      imported: 0,
      inhouse: false,
      draft: false,
      playoff: false,
      watch: false,
      cursor: null,
    });
    activeSeason.mockResolvedValue({
      id: "season-1",
      status: "REGULAR_SEASON",
      teamSize: 5,
    } as never);
    remind.mockRejectedValue(new Error("Discord unavailable"));

    const res = await POST(request());

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ updated: false });
  });
});
