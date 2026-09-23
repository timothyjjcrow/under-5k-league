import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { MID_DB_URL } from "../playwright.midseason.config";
import { expectNoHorizontalOverflow, trackPageErrors } from "./helpers";

// This suite writes only to the explicitly configured disposable fixture.
const db = new PrismaClient({ datasources: { db: { url: MID_DB_URL } } });
test.afterAll(async () => {
  await db.$disconnect();
});

test("admin diagnostic routes protect history and game details", async ({
  page,
}) => {
  for (const path of ["/admin/activity", "/admin/data-quality"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login\?next=/);
  }
  await page.goto(
    "/api/auth/dev?name=QoL+Viewer&steamId=76561190000991997&redirect=/admin/activity",
  );
  await expect(
    page.locator('meta[name="robots"][content="noindex"]').first(),
  ).toBeAttached();
  await expect(
    page.getByRole("heading", { name: "Page not found", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Filter activity" }),
  ).toHaveCount(0);
  await page.goto("/admin/data-quality");
  await expect(
    page.locator('meta[name="robots"][content="noindex"]').first(),
  ).toBeAttached();
  await expect(
    page.getByRole("heading", { name: "Page not found", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Imported-game quality" }),
  ).toHaveCount(0);
});

test("schedule selection survives reload and back navigation on a phone", async ({
  page,
}) => {
  const noErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/schedule");
  const longName = page
    .locator("#fixtures")
    .getByRole("link", {
      name: "The Couriers of Catastrophe With Very Long Name",
      exact: true,
    })
    .first();
  await expect(longName).toBeVisible();
  expect(
    await longName.evaluate((link) => link.scrollWidth <= link.clientWidth + 1),
  ).toBe(true);
  const team = page.getByRole("combobox", { name: "Show matches for" });
  await team.selectOption({ label: "Dire Straits" });
  const selectedTeam = await team.inputValue();
  await expect(page).toHaveURL(/team=/);
  const filteredUrl = page.url();
  await page.reload();
  await expect(team).toHaveValue(selectedTeam);
  await team.selectOption({ label: "Dire Straits" });
  await expect(team).toHaveValue(selectedTeam);
  await page.getByRole("button", { name: "All teams", exact: true }).click();
  await expect(page).toHaveURL(/team=all/);
  await page.goBack();
  await expect(page).toHaveURL(filteredUrl);
  await expect(team).toHaveValue(selectedTeam);
  expect((await team.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(
    await page
      .locator("#fixtures")
      .evaluate(
        (node) =>
          node.getBoundingClientRect().top <
          document.getElementById("standings")!.getBoundingClientRect().top,
      ),
  ).toBe(true);
  await expectNoHorizontalOverflow(page, "persistent schedule filter");
  noErrors();
});

test("admin jumps reveal closed sections clear of both sticky bars", async ({
  page,
}) => {
  const noErrors = trackPageErrors(page);
  const hydrationErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /hydrat/i.test(message.text()))
      hydrationErrors.push(message.text());
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    "/api/auth/dev?name=QoL+Admin&steamId=76561190000991999&admin=1&redirect=/admin",
  );
  await page
    .getByRole("navigation", { name: "Admin sections" })
    .getByRole("link", { name: "Discord", exact: true })
    .click();
  await expect(page.locator("#adm-discord")).toHaveAttribute("open", "");
  const bounds = await page.locator("#adm-discord").boundingBox();
  expect(bounds!.y).toBeGreaterThanOrEqual(145);
  expect(bounds!.y).toBeLessThan(250);
  await page.reload();
  await expect(page.locator("#adm-discord")).toHaveAttribute("open", "");
  await page.goto("/admin/data-quality");
  await expect(
    page.getByRole("heading", { name: "Imported-game quality" }),
  ).toBeVisible();
  await expect(page.getByText(/Unknown hero IDs/).first()).toBeVisible();
  await expectNoHorizontalOverflow(page, "game diagnostics");
  expect(hydrationErrors).toEqual([]);
  noErrors();
});

test("hero explorer exposes the full pool and filters without navigating", async ({
  page,
}) => {
  const noErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/meta");
  const initialUrl = page.url();
  const explorer = page.locator("#explore-heroes");
  const cards = explorer.locator("article");
  const status = explorer.getByRole("status");
  const sampleFilters = explorer.getByRole("group", { name: "Hero sample filter" });
  const allHeroes = sampleFilters.getByRole("button", { name: /All heroes/ });
  const poolSize = Number((await allHeroes.innerText()).match(/\d+/)?.[0]);
  expect(poolSize).toBeGreaterThan(12);
  await expect(allHeroes).toHaveAttribute("aria-pressed", "true");
  await expect(status).toContainText(`of ${poolSize} matching heroes`);
  await expect(cards).toHaveCount(12);
  await explorer.getByRole("button", { name: /Show more heroes/ }).click();
  await expect(cards).toHaveCount(24);

  // The leading picked hero opens its per-pick stats without leaving the page.
  await cards.first().getByRole("button").click();
  await expect(cards.first()).toContainText("Kills / pick");

  const search = explorer.getByRole("searchbox", { name: "Find a hero" });
  await search.fill("Axe");
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText("Axe");
  await search.fill("");

  const untouched = sampleFilters.getByRole("button", { name: /Untouched/ });
  await untouched.click();
  await expect(untouched).toHaveAttribute("aria-pressed", "true");
  await expect(cards.first()).toContainText("No recorded picks");
  await search.fill("no-such-hero");
  await expect(cards).toHaveCount(0);
  await expect(explorer.getByText("No heroes match these filters")).toBeVisible();
  await explorer.getByRole("button", { name: "Clear filters" }).click();
  await expect(allHeroes).toHaveAttribute("aria-pressed", "true");
  await expect(status).toContainText(`of ${poolSize} matching heroes`);

  await explorer.getByRole("combobox", { name: "Sort by" }).selectOption("name");
  const names = await cards.evaluateAll((nodes) =>
    nodes.map((node) => node.querySelector("button")?.innerText.split("\n")[0]?.trim() ?? ""),
  );
  expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  expect(page.url()).toBe(initialUrl);
  await expectNoHorizontalOverflow(page, "hero explorer");
  noErrors();
});

test("profile saves optional details with clear dirty state", async ({
  page,
}) => {
  await page.goto(
    "/api/auth/dev?name=QoL+Player&steamId=76561190000991998&redirect=/me",
  );
  await expect(page.getByRole("heading", { name: "Your setup" })).toBeVisible();
  const optional = page
    .locator("details:has(> summary)")
    .filter({
      has: page.locator("summary", { hasText: /^Optional scouting profile$/ }),
    })
    .last();
  await optional.locator("summary").click();
  await page
    .getByLabel("What you want from the league (public)")
    .fill("Practice communication");
  await expect(
    page.getByText("Unsaved changes", { exact: true }),
  ).toBeVisible();
  // Closed details retain successful controls in the form submission.
  await optional.locator("summary").click();
  await page
    .getByRole("button", { name: "Join the season", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Update signup" }),
  ).toBeVisible();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.reload();
  // Returning players see their current participation without the full form.
  const savedSignup = page.locator("#signup-details");
  await expect(savedSignup).not.toHaveAttribute("open", "");
  await expect(
    page.getByRole("button", { name: "Update signup" }),
  ).toBeHidden();
  await savedSignup.locator(":scope > summary").click();
  await expect(
    page.getByRole("button", { name: "Update signup" }),
  ).toBeVisible();
  await optional.locator("summary").click();
  await expect(
    page.getByLabel("What you want from the league (public)"),
  ).toHaveValue("Practice communication");
});

test("news and admin history paginate while old news hashes still resolve", async ({
  page,
}) => {
  const suffix = `${Date.now()}`;
  const newsIds = Array.from(
    { length: 22 },
    (_, index) => `qol-news-${suffix}-${String(index).padStart(2, "0")}`,
  );
  const actionIds = Array.from(
    { length: 43 },
    (_, index) => `qol-action-${suffix}-${String(index).padStart(2, "0")}`,
  );
  try {
    await db.newsPost.createMany({
      data: newsIds.map((id, index) => ({
        id,
        title: `QoL announcement ${index}`,
        body: "Pagination fixture",
        pinned: false,
        createdAt: new Date(2020, 0, 1, 0, 0, index),
      })),
    });
    await db.adminAction.createMany({
      data: actionIds.map((id) => ({
        id,
        actorId: "qol",
        actorName: `QoL ${suffix}`,
        action: "qolPagination",
        summary: "Read-only history fixture",
        createdAt: new Date("2026-09-04T12:00:00Z"),
      })),
    });
    await page.goto("/news");
    await expect(page.locator("#main article")).toHaveCount(20);
    await page.getByRole("link", { name: "Older announcements →" }).click();
    await expect(
      page.getByRole("heading", { name: "QoL announcement 0", exact: true }),
    ).toBeVisible();
    await page.goto(`/news#${newsIds[0]}`);
    await expect(page).toHaveURL(new RegExp(`post=${newsIds[0]}`));
    await expect(
      page.getByRole("heading", { name: "QoL announcement 0", exact: true }),
    ).toBeVisible();
    await page.goto(
      "/api/auth/dev?name=QoL+Admin&steamId=76561190000991999&admin=1&redirect=/admin/activity",
    );
    await page.getByLabel("Actor name contains").fill(`QoL ${suffix}`);
    await page.getByRole("button", { name: "Filter activity" }).click();
    await expect(
      page.getByText("Read-only history fixture", { exact: true }),
    ).toHaveCount(40);
    await page.getByRole("link", { name: "Older actions →" }).click();
    await expect(
      page.getByText("Read-only history fixture", { exact: true }),
    ).toHaveCount(3);
    await page.getByRole("link", { name: "Newest matching actions" }).click();
    await expect(
      page.getByText("Read-only history fixture", { exact: true }),
    ).toHaveCount(40);
  } finally {
    await db.newsPost.deleteMany({ where: { id: { in: newsIds } } });
    await db.adminAction.deleteMany({ where: { id: { in: actionIds } } });
  }
});

test("scrim history pages preserve full team records and invalid season links fail clearly", async ({
  page,
}) => {
  const teams = await db.team.findMany({
    where: { season: { isActive: true } },
    take: 2,
  });
  const ids = Array.from(
    { length: 22 },
    (_, index) => `qol-scrim-${Date.now()}-${index}`,
  );
  const seasonId = teams[0].seasonId;
  try {
    await db.scrim.createMany({
      data: ids.map((id, index) => ({
        id,
        seasonId,
        hostTeamId: teams[0].id,
        opponentTeamId: teams[1].id,
        createdById: teams[0].captainId,
        scheduledAt: new Date(2026, 0, 1, 0, index),
        status: "COMPLETED",
        hostScore: 1,
        awayScore: 0,
        winnerTeamId: teams[0].id,
      })),
    });
    await page.goto(`/scrims?season=${seasonId}`);
    await expect(page.locator('#history a[href^="/scrims/"]')).toHaveCount(20);
    await expect(page.locator("#team-stats")).toContainText("22-0-0");
    await page.getByRole("link", { name: "Older results →" }).click();
    await expect(page.locator('#history a[href^="/scrims/"]')).toHaveCount(2);
    await expect(page.locator("#team-stats")).toContainText("22-0-0");
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/scrims/${ids[0]}`);
      await expect(page.getByRole("heading", { level: 1 })).toContainText(
        teams[0].name,
      );
      await expectNoHorizontalOverflow(page, `scrim details at ${width}px`);
    }
    for (const query of [
      "season=missing",
      `season=${seasonId}&season=missing`,
    ]) {
      await page.goto(`/scrims?${query}`);
      await expect(
        page.locator('meta[name="robots"][content="noindex"]').first(),
      ).toBeAttached();
      await expect(
        page.getByRole("heading", { name: "Page not found", exact: true }),
      ).toBeVisible();
    }
  } finally {
    await db.scrim.deleteMany({ where: { id: { in: ids } } });
  }
});
