import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { MATCH_PHASE, MATCH_STATUS, SEASON_STATUS } from "@/lib/constants";
import {
  loadSeasonChoices,
  resolveSeasonScope,
  seasonScopeMetadata,
} from "@/lib/season-scope";
import { makeTeam, makeUser } from "./factories";

// The shared season scope behind Leaders, Hero meta, Pick'em and Fantasy.

/** notFound() throws Next's 404 fallback error; pin that shape, not a message. */
async function expectNotFound(run: () => Promise<unknown>) {
  const error = await run().then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error, "expected a 404").toMatchObject({
    digest: expect.stringContaining("404"),
  });
}

/** Seasons are ordered by createdAt, so give each a distinct, known one. */
async function seasonAt(
  name: string,
  day: number,
  overrides: { isActive?: boolean; status?: string } = {},
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

async function matchIn(seasonId: string, label: string) {
  const home = await makeTeam(seasonId, `${label} Home`, 0);
  const away = await makeTeam(seasonId, `${label} Away`, 1);
  const match = await prisma.match.create({
    data: {
      seasonId,
      week: 1,
      phase: MATCH_PHASE.REGULAR,
      homeTeamId: home.id,
      awayTeamId: away.id,
      status: MATCH_STATUS.COMPLETED,
    },
  });
  return { match, home };
}

describe("resolveSeasonScope", () => {
  it("shows the season a link names, archived or not", async () => {
    const old = await seasonAt("Old", 1);
    await seasonAt("Live", 2, {
      isActive: true,
      status: SEASON_STATUS.REGULAR_SEASON,
    });
    expect((await resolveSeasonScope(old.id))?.id).toBe(old.id);
  });

  it("404s an unknown season instead of falling back to another one", async () => {
    await seasonAt("Live", 2, { isActive: true });
    await expectNotFound(() => resolveSeasonScope("no-such-season"));
  });

  it("opens the active season when no season is named", async () => {
    await seasonAt("Newer archive", 3);
    const live = await seasonAt("Live", 2, {
      isActive: true,
      status: SEASON_STATUS.REGULAR_SEASON,
    });
    expect((await resolveSeasonScope(undefined))?.id).toBe(live.id);
  });

  it("opens the most recent season between seasons, not an empty screen", async () => {
    await seasonAt("Season 1", 1);
    const latest = await seasonAt("Season 2", 5);
    await seasonAt("Season 1.5", 3);
    expect((await resolveSeasonScope(undefined))?.id).toBe(latest.id);
  });

  it("is null only when the league has no seasons at all", async () => {
    expect(await resolveSeasonScope(undefined)).toBeNull();
  });
});

describe("loadSeasonChoices", () => {
  it("offers only seasons with games (plus the viewed and current ones) for the stat pages", async () => {
    const withGames = await seasonAt("With games", 1);
    await seasonAt("Empty archive", 2);
    const live = await seasonAt("Live", 3, {
      isActive: true,
      status: SEASON_STATUS.SIGNUPS,
    });
    const { match } = await matchIn(withGames.id, "WG");
    await prisma.game.create({
      data: {
        matchId: match.id,
        dotaMatchId: "scope-1",
        radiantWin: true,
        durationSecs: 1800,
        players: "[]",
      },
    });

    const choices = await loadSeasonChoices("games", live.id);
    expect(choices.map((c) => c.name)).toEqual(["Live", "With games"]);
    expect(choices[0].isActive).toBe(true);
  });

  it("counts pick'em predictions and fantasy entries as each page's data", async () => {
    const picked = await seasonAt("Picked", 1);
    const drafted = await seasonAt("Drafted", 2);
    const viewed = await seasonAt("Viewed", 3);
    const fan = await makeUser("Fan");
    const { match, home } = await matchIn(picked.id, "P");
    await prisma.prediction.create({
      data: { matchId: match.id, userId: fan.id, pickedTeamId: home.id },
    });
    await prisma.fantasyRoster.create({
      data: { seasonId: drafted.id, userId: fan.id },
    });

    expect(
      (await loadSeasonChoices("predictions", viewed.id)).map((c) => c.name),
    ).toEqual(["Viewed", "Picked"]);
    expect(
      (await loadSeasonChoices("fantasy", viewed.id)).map((c) => c.name),
    ).toEqual(["Viewed", "Drafted"]);
  });
});

describe("seasonScopeMetadata", () => {
  const page = {
    path: "/leaders",
    title: "Leaders",
    description: "Every board.",
    archived: (name: string) => ({
      title: `${name} leaders`,
      description: `Boards from ${name}.`,
    }),
  };

  it("shares the page's own title on the bare address and for the current season", async () => {
    const live = await seasonAt("Live", 1, { isActive: true });
    for (const raw of [undefined, live.id]) {
      const meta = await seasonScopeMetadata(raw, page);
      expect(meta.title).toBe("Leaders");
      expect(meta.alternates?.canonical).toBe("/leaders");
    }
  });

  it("names an archived season and keeps its ?season= as the canonical link", async () => {
    const old = await seasonAt("Season 1", 1);
    const meta = await seasonScopeMetadata(old.id, page);
    expect(meta.title).toBe("Season 1 leaders");
    expect(meta.description).toBe("Boards from Season 1.");
    expect(meta.alternates?.canonical).toBe(`/leaders?season=${old.id}`);
  });

  it("404s a repeated or unknown season, like the page", async () => {
    await expectNotFound(() => seasonScopeMetadata(["a", "b"], page));
    await expectNotFound(() => seasonScopeMetadata("missing", page));
  });
});
