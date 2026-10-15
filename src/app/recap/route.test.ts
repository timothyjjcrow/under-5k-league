import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: { season: { findUnique: vi.fn(), findFirst: vi.fn() } },
}));
vi.mock("@/lib/season", () => ({ getActiveSeason: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { getActiveSeason } from "@/lib/season";
import { SEASON_STATUS } from "@/lib/constants";
import { GET } from "./route";

const findUnique = vi.mocked(prisma.season.findUnique);
const findFirst = vi.mocked(prisma.season.findFirst);
const active = vi.mocked(getActiveSeason);

beforeEach(() => {
  findUnique.mockReset();
  findFirst.mockReset();
  active.mockReset();
  findUnique.mockResolvedValue({
    id: "season-1",
    isActive: false,
    status: SEASON_STATUS.COMPLETE,
  } as Awaited<ReturnType<typeof prisma.season.findUnique>>);
  findFirst.mockResolvedValue(null);
  active.mockResolvedValue(null);
});
afterEach(() => vi.unstubAllEnvs());

describe("/recap redirect", () => {
  it("sends an old season link to its season page on the request's origin", async () => {
    const res = await GET(
      new NextRequest("https://league.example/recap?season=season-1"),
    );

    expect(res.headers.get("location")).toBe(
      "https://league.example/seasons/season-1",
    );
  });

  it("redirects on the canonical origin when the deployment is declared", async () => {
    vi.stubEnv("LEAGUE_DEPLOY_ENV", "production");
    vi.stubEnv("APP_URL", "https://us.ggd2l.com");

    // Next hands the handler the 127.0.0.1 bind address behind Caddy.
    const linked = await GET(
      new NextRequest("https://127.0.0.1:3001/recap?season=season-1"),
    );
    expect(linked.headers.get("location")).toBe(
      "https://us.ggd2l.com/seasons/season-1",
    );

    const bare = await GET(new NextRequest("https://127.0.0.1:3001/recap"));
    expect(bare.headers.get("location")).toBe("https://us.ggd2l.com/leaders");
  });
});
