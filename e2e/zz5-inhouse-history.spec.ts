import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { mkdir } from "node:fs/promises";
import path from "node:path";

// Explicitly pinned to Playwright's disposable database, never an .env URL.
const db = new PrismaClient({
  datasources: { db: { url: `file:${path.resolve("prisma/e2e.db")}` } },
});
const prefix = "e2e-inhouse-history-";
const lobbyId = (index: number) => `${prefix}game-${index}`;

async function invalidateResults() {
  await db.setting.upsert({
    where: { key: "resultChangedAt" },
    create: { key: "resultChangedAt", value: String(Date.now()) },
    update: { value: String(Date.now()) },
  });
}

async function cleanFixture() {
  await db.inhouseLobby.deleteMany({ where: { id: { startsWith: prefix } } });
  await db.user.deleteMany({ where: { id: { startsWith: prefix } } });
  await invalidateResults();
}

test("history retains pagination, shareable box scores, legacy rosters and admin void", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const seasonsBefore = await db.season.findMany({ orderBy: { id: "asc" } });
  await cleanFixture();
  try {
    const names = [
      "Ember",
      "Moonlight",
      "Storm",
      "Phoenix",
      "Oracle",
      "Wisp",
      "Winter",
      "Nova",
      "Echo",
      "Ancient Apparition With A Long Name",
    ];
    const users = [];
    for (const [index, name] of names.entries()) {
      users.push(
        await db.user.create({
          data: {
            id: `${prefix}player-${index}`,
            steamId: `7656119000000880${index}`,
            name,
          },
        }),
      );
    }
    for (let index = 0; index < 102; index++) {
      const createdAt = new Date(
        Date.now() - 7 * 86_400_000 + index * 3_600_000,
      );
      const team = (player: number) =>
        (player + (index % 3)) % 10 < 5 ? 1 : 2;
      const winner = index % 3 === 0 ? 2 : 1;
      const box = users.map((user, player) => ({
        userId: user.id,
        name: user.name,
        team: team(player),
        isRadiant: team(player) === 1,
        heroId: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10][player],
        kills: 12 - player,
        deaths: 3 + (player % 4),
        assists: 14 + player,
        netWorth: 24_000 - player * 1300,
        gpm: 680 - player * 25,
        lastHits: 340 - player * 20,
      }));
      await db.inhouseLobby.create({
        data: {
          id: lobbyId(index),
          status: "COMPLETED",
          winnerTeam: winner,
          radiantTeam: 1,
          dotaMatchId: String(8_990_000_000 + index),
          createdAt,
          startedAt: createdAt,
          completedAt:
            index === 101
              ? new Date()
              : new Date(createdAt.getTime() + 2500_000),
          matchStartTime: createdAt,
          durationSecs: 2500,
          radiantScore: 42,
          direScore: 31,
          boxScore: index === 100 ? "[]" : JSON.stringify(box),
          eloDeltas: JSON.stringify(
            Object.fromEntries(
              users.map((user, player) => [
                user.id,
                team(player) === winner ? 25 : -25,
              ]),
            ),
          ),
          players: {
            create: users.map((user, player) => ({
              userId: user.id,
              team: team(player),
              mmr: 4500 - player * 100,
            })),
          },
        },
      });
    }
    await invalidateResults();
    await page.request.post("/api/test/cache");

    await page.goto("/inhouse/history");
    await expect(page.getByText("Page 1 of 2")).toBeVisible();
    const history = page.getByRole("list", { name: "Completed inhouse games" });
    await expect(history.locator(":scope > li")).toHaveCount(100);
    await expect(
      page.getByRole("button", { name: "void", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("link", { name: "Older games →" }).click();
    await expect(history.locator(":scope > li")).toHaveCount(2);
    await page
      .locator(`#result-${lobbyId(0)}`)
      .getByRole("link", { name: /^Open box score/ })
      .click();
    await expect(page).toHaveURL(new RegExp(`page=2&game=${lobbyId(0)}`));
    await expect(
      page.getByText("Elo changes shown as recorded when this result landed."),
    ).toBeVisible();

    // The same result must stay reachable after new games move it off page 1.
    await page.goto(`/inhouse/history?game=${lobbyId(0)}#result-${lobbyId(0)}`);
    await expect(page.getByText("Linked game", { exact: true })).toBeVisible();
    const expanded = page.locator(`#result-${lobbyId(0)}`);
    await expect(
      expanded.getByRole("link", { name: "Full match on OpenDota ↗" }),
    ).toHaveAttribute("href", "https://www.opendota.com/matches/8990000000");
    await expect(
      expanded.getByRole("link", { name: names[9], exact: true }),
    ).toBeVisible();

    for (const width of [375, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        ),
      ).toBeLessThanOrEqual(0);
      const directory = process.env.INHOUSE_UI_CAPTURE_DIR;
      if (directory) {
        await mkdir(directory, { recursive: true });
        await expanded.screenshot({
          path: path.join(directory, `history-${width}.png`),
        });
      }
    }
    await page.goto(`/inhouse/history?game=${lobbyId(100)}`);
    await expect(
      page.getByText(/The full box score is unavailable/),
    ).toBeVisible();
    await expect(
      page
        .locator(`#result-${lobbyId(100)}`)
        .getByRole("link", { name: names[9], exact: true }),
    ).toBeVisible();

    await page.goto("/inhouse");
    const ladder = page.getByRole("region", { name: "Inhouse ladder" });
    await expect(ladder.getByText("102 games played")).toBeVisible();
    const directory = process.env.INHOUSE_UI_CAPTURE_DIR;
    if (directory)
      await ladder.screenshot({
        path: path.join(directory, "ladder-1440.png"),
      });

    await page.goto(
      `/api/auth/dev?name=History+Admin&steamId=76561190000008899&admin=1&redirect=${encodeURIComponent(`/inhouse/history?game=${lobbyId(0)}`)}`,
    );
    page.on("dialog", (dialog) => dialog.accept());
    await page
      .locator(`#result-${lobbyId(0)}`)
      .getByRole("button", { name: "void", exact: true })
      .click();
    await expect(
      page.getByText(/Result voided — the ladder recalculates/),
    ).toBeVisible();
    await expect(page.locator(`#result-${lobbyId(0)}`)).toHaveCount(0);
    expect(
      (await db.inhouseLobby.findUniqueOrThrow({ where: { id: lobbyId(0) } }))
        .status,
    ).toBe("CANCELLED");
    await page.goto("/inhouse");
    await expect(ladder.getByText("101 games played")).toBeVisible();

    // The room's separate API void must refresh server-rendered standings,
    // even though its active lobby stays null before and after the action.
    await page.goto(
      "/api/auth/dev?name=Ember&steamId=76561190000008800&admin=1&redirect=/inhouse",
    );
    await expect(ladder.getByText("101 games played")).toBeVisible();
    await page
      .getByRole("button", { name: "Admin: void the last result", exact: true })
      .click();
    await expect(
      page.getByText("Result voided — Elo recalculated", { exact: true }),
    ).toBeVisible();
    await expect(ladder.getByText("100 games played")).toBeVisible();
    expect(
      (await db.inhouseLobby.findUniqueOrThrow({ where: { id: lobbyId(101) } }))
        .status,
    ).toBe("CANCELLED");
    expect(await db.season.findMany({ orderBy: { id: "asc" } })).toEqual(
      seasonsBefore,
    );
    expect(errors).toEqual([]);
  } finally {
    await cleanFixture();
    await db.$disconnect();
  }
});
