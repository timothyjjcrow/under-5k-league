import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { POSTSEASON_DB_URL } from "../playwright.postseason.config";
import { expectNoHorizontalOverflow, trackPageErrors, untilHydrated } from "../e2e-mid/helpers";

// The season builder after the auction (season-builder.ts): thirteen teams,
// no schedule yet. The admin picks a layout, the preview says what it makes,
// Generate builds exactly that, and a playoff-places change afterwards keeps
// every fixture.

const db = new PrismaClient({ datasources: { db: { url: POSTSEASON_DB_URL } } });
const ADMIN_LOGIN = "/api/auth/dev?name=Builder%20Admin&admin=1";

async function seedDrafted(page: Page) {
  execFileSync(process.execPath, ["--import", "tsx", "e2e-postseason/seed.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: POSTSEASON_DB_URL,
      FIXTURE_MODE: "drafted",
      FIXTURE_TEAMS: "13",
    },
    stdio: "pipe",
  });
  expect((await page.request.post("/api/test/cache")).ok()).toBe(true);
}

/** A hydration mismatch logs a console error, not a page error. */
function trackHydrationErrors(page: Page): () => void {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /hydrat/i.test(message.text())) errors.push(message.text());
  });
  return () => expect(errors, "hydration errors").toEqual([]);
}

/** A first match night three weeks out, as the box reads it. */
function firstNightValue(): string {
  const night = new Date(Date.now() + 21 * 864e5);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${night.getUTCFullYear()}-${pad(night.getUTCMonth() + 1)}-${pad(night.getUTCDate())}T18:00`;
}

test.afterAll(async () => {
  await db.$disconnect();
});

test("an admin lays out a thirteen-team season, generates it and moves only the playoff places", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await seedDrafted(page);
  const assertNoErrors = trackPageErrors(page);
  const assertNoHydrationErrors = trackHydrationErrors(page);
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto(`${ADMIN_LOGIN}&redirect=${encodeURIComponent("/admin#adm-schedule")}`);

  const builder = page.getByRole("region", { name: "Season builder" });
  await expect(builder.getByRole("heading", { name: "Season builder · 13 teams" })).toBeVisible();
  // A click that lands before hydration is lost (the dev server answers first).
  await untilHydrated(page, builder);
  const preview = builder.getByRole("region", { name: "Season preview" });
  // Recommended for 13: groups of 7 and 6, the top 4 of each.
  await expect(preview).toContainText(
    "11 weeks in all: 7 group weeks, the tiebreaker week and 3 playoff weeks.",
  );
  const others = builder.getByRole("region", { name: "Other layouts for 13 teams" });
  await expect(others.getByRole("listitem")).toHaveCount(6);

  // The night goes in first: the preview dates follow the box.
  const night = builder.getByLabel("First match night");
  await night.fill(firstNightValue());
  const planned = preview.getByRole("list", { name: "Previewed season plan" });
  await expect(planned.getByRole("listitem").filter({ hasText: "Grand final" })).toContainText(
    "Week 11",
  );
  // Typing the night puts dates on the plan ("Sat, Nov 14 – …").
  await expect(planned.getByRole("listitem").filter({ hasText: "Group stage" })).toContainText(
    /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun), [A-Z][a-z]{2} \d{1,2}/,
  );

  // Twice is ruled out for a group of 7: Generate is disabled, not gone,
  // and the night typed survives the detour.
  await builder.getByRole("radio", { name: "Twice" }).check();
  await expect(preview).toContainText(
    "Playing twice needs groups of 6 teams or fewer; the largest has 7, which would take 14 weeks of group games.",
  );
  await expect(builder.getByRole("button", { name: "Generate schedule" })).toBeDisabled();
  await builder.getByRole("radio", { name: "Once" }).check();
  await expect(night).toHaveValue(firstNightValue());

  await others.getByRole("button", { name: "Use two groups, top 2 of each" }).click();
  await expect(builder).toContainText("Custom · two groups, top 2 of each");
  await expect(preview).toContainText(
    "10 weeks in all: 7 group weeks, the tiebreaker week and 2 playoff weeks.",
  );
  await expect(planned.getByRole("listitem").filter({ hasText: "Grand final" })).toContainText(
    "Week 10",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page, "/admin season builder");
  await page.setViewportSize({ width: 1280, height: 900 });

  await builder.getByRole("button", { name: "Generate schedule" }).click();
  await expect(page.getByText(/Two groups of 7 and 6, drawn by roster MMR/)).toBeVisible();
  const season = await db.season.findFirstOrThrow({ where: { isActive: true } });
  expect(season.formatConfig).toBe('{"v":1,"groups":2,"meet":1,"playoffs":4}');
  const fixtureIds = async () =>
    (await db.match.findMany({ where: { seasonId: season.id }, orderBy: { id: "asc" } })).map(
      (match) => match.id,
    );
  const built = await fixtureIds();
  expect(built).toHaveLength(36);

  // The format box shows what was built, week for week as previewed.
  const box = page.getByRole("region", { name: "Season format" });
  await expect(
    box.getByRole("list", { name: "Season plan" }).getByRole("listitem").filter({ hasText: "Grand final" }),
  ).toContainText("Week 10");

  // Built, no result yet: the playoff places change in place. The top 4 of
  // each is Recommended for 13 teams, so that is what saves.
  const rebuilt = page.getByRole("region", { name: "Season builder" });
  await rebuilt
    .getByRole("region", { name: "Other layouts for 13 teams" })
    .getByRole("button", { name: "Use two groups, top 4 of each" })
    .click();
  await expect(rebuilt).toContainText("Recommended · two groups, top 4 of each");
  await rebuilt.getByRole("button", { name: "Save format (the fixtures stay)" }).click();
  await expect(
    page.getByText(/the fixtures stay as they are; only the playoff places changed/),
  ).toBeVisible();
  await expect
    .poll(async () => (await db.season.findUniqueOrThrow({ where: { id: season.id } })).formatConfig)
    .toBeNull();
  expect(await fixtureIds()).toEqual(built);

  await page.goto("/rules");
  await expect(page.locator("#format")).toContainText(
    "This season has 13 teams: two groups of 7 and 6.",
  );
  await expect(page.locator("#format")).not.toContainText("the plan until the schedule is made");
  assertNoErrors();
  assertNoHydrationErrors();
});
