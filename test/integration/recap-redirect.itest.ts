import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { SEASON_STATUS } from "@/lib/constants";
import { GET } from "@/app/recap/route";

// /recap is only a redirect now: a finished season's recap lives on its own
// season page. Champion posts already in Discord link /recap?season=<id>, so
// every old link has to land somewhere sensible.

function recap(query = ""): NextRequest {
  return new NextRequest(`http://localhost/recap${query}`);
}

/** Where the redirect points, as a path (the Location header is absolute). */
async function landsOn(query = ""): Promise<string> {
  const res = await GET(recap(query));
  expect(res.status).toBe(307);
  const location = new URL(res.headers.get("location") ?? "");
  return `${location.pathname}${location.search}`;
}

async function seasonAt(
  name: string,
  day: number,
  overrides: { id?: string; isActive?: boolean; status?: string } = {},
) {
  return prisma.season.create({
    data: {
      name,
      isActive: false,
      status: SEASON_STATUS.COMPLETE,
      createdAt: new Date(Date.UTC(2026, 0, day)),
      ...overrides,
    },
  });
}

describe("/recap?season=<id>", () => {
  it("sends an archived season's recap link to that season's page", async () => {
    const old = await seasonAt("Season 1", 1, { id: "season/one" });
    await seasonAt("Season 2", 2, {
      isActive: true,
      status: SEASON_STATUS.REGULAR_SEASON,
    });
    expect(await landsOn(`?season=${encodeURIComponent(old.id)}`)).toBe(
      "/seasons/season%2Fone",
    );
  });

  it("sends the current season to its page once the final is played", async () => {
    const live = await seasonAt("Season 2", 2, { isActive: true });
    expect(await landsOn(`?season=${live.id}`)).toBe(`/seasons/${live.id}`);
  });

  it("sends the current season to Leaders while it is still being played", async () => {
    const live = await seasonAt("Season 2", 2, {
      isActive: true,
      status: SEASON_STATUS.PLAYOFFS,
    });
    expect(await landsOn(`?season=${live.id}`)).toBe("/leaders");
  });

  it("sends an unknown season to its would-be page, which says not found", async () => {
    expect(await landsOn("?season=no-such-season")).toBe(
      "/seasons/no-such-season",
    );
  });

  it("404s a repeated season key instead of picking one", async () => {
    const old = await seasonAt("Season 1", 1);
    const error = await GET(recap(`?season=${old.id}&season=${old.id}`)).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error, "expected a 404").toMatchObject({
      digest: expect.stringContaining("404"),
    });
  });
});

describe("the bare /recap", () => {
  it("opens the current season's page once it is complete", async () => {
    await seasonAt("Season 1", 1);
    const live = await seasonAt("Season 2", 2, { isActive: true });
    expect(await landsOn()).toBe(`/seasons/${live.id}`);
  });

  it("opens Leaders while the season is being played", async () => {
    await seasonAt("Season 1", 1);
    await seasonAt("Season 2", 2, {
      isActive: true,
      status: SEASON_STATUS.REGULAR_SEASON,
    });
    expect(await landsOn()).toBe("/leaders");
  });

  it("opens the most recent archived season between seasons", async () => {
    await seasonAt("Season 1", 1);
    const latest = await seasonAt("Season 2", 5);
    await seasonAt("Season 1.5", 3);
    expect(await landsOn()).toBe(`/seasons/${latest.id}`);
  });

  it("opens Leaders when the league has no seasons yet", async () => {
    expect(await landsOn()).toBe("/leaders");
  });
});
