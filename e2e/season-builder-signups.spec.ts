import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import path from "node:path";
import { expectNoHorizontalOverflow, trackPageErrors, untilHydrated } from "../e2e-mid/helpers";

// The season builder during signups (season-builder.ts): the Season format
// card sits between Phase and Captains & draft. The admin previews a captain
// count, picks a layout, saves it, sees /rules say the admins choose the
// format, and resets it.
// The season is put back on Recommended at the end, so the specs after this
// one see the season they expect.

// Explicitly pinned to Playwright's disposable database, never an .env URL.
const db = new PrismaClient({
  datasources: { db: { url: `file:${path.resolve("prisma/e2e.db")}` } },
});
const ADMIN_LOGIN = "/api/auth/dev?name=Admin&steamId=76561190000000001&admin=1";

/** A hydration mismatch logs a console error, not a page error. */
function trackHydrationErrors(page: Page): () => void {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /hydrat/i.test(message.text())) errors.push(message.text());
  });
  return () => expect(errors, "hydration errors").toEqual([]);
}

test.afterAll(async () => {
  await db.$disconnect();
});

test("an admin lays out the season during signups and saves it before the auction", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const season = await db.season.findFirstOrThrow({ where: { isActive: true } });
  await db.season.update({ where: { id: season.id }, data: { formatConfig: null } });
  const captains = await db.team.count({ where: { seasonId: season.id } });
  try {
    const assertNoErrors = trackPageErrors(page);
    const assertNoHydrationErrors = trackHydrationErrors(page);
    await page.goto(`${ADMIN_LOGIN}&redirect=${encodeURIComponent("/admin#adm-format")}`);

    const card = page.locator("#adm-format");
    await expect(card.getByRole("heading", { name: "Season format", level: 2 })).toBeVisible();
    const builder = card.getByRole("region", { name: "Season builder" });
    // A click that lands before hydration is lost (the dev server answers first).
    await untilHydrated(page, builder);
    await expect(builder).toContainText(`${captains} captain${captains === 1 ? "" : "s"} so far`);
    // No Generate before the auction: this card only saves.
    await expect(builder.getByRole("button", { name: "Generate schedule" })).toHaveCount(0);

    // Preview thirteen teams, whatever the captain count is today.
    for (let shown = Math.max(captains, 2); shown < 13; shown++) {
      await builder.getByRole("button", { name: "Preview one team more" }).click();
    }
    const preview = builder.getByRole("region", { name: "Season preview" });
    await expect(preview).toContainText(
      "11 weeks in all: 7 group weeks, the tiebreaker week and 3 playoff weeks.",
    );
    await expect(preview).toContainText("Captains can still change; this is the layout for 13 teams.");

    await builder
      .getByRole("region", { name: "Other layouts for 13 teams" })
      .getByRole("button", { name: "Use two groups, winner of each" })
      .click();
    await expect(preview).toContainText(
      "9 weeks in all: 7 group weeks, the tiebreaker week and 1 playoff week.",
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoHorizontalOverflow(page, "/admin Season format card");
    await page.setViewportSize({ width: 1280, height: 900 });

    await builder.getByRole("button", { name: "Save format", exact: true }).click();
    await expect(page.getByText(/^Season format saved · Two groups, winner of each/)).toBeVisible();
    await expect
      .poll(async () => (await db.season.findUniqueOrThrow({ where: { id: season.id } })).formatConfig)
      .toBe('{"v":1,"groups":2,"meet":1,"playoffs":2}');

    await page.goto("/rules");
    await expect(page.locator("#format")).toContainText(
      "The admins choose each season's format before its schedule is made.",
    );

    // Back to Recommended through the card.
    await page.goto("/admin#adm-format");
    const saved = page.locator("#adm-format").getByRole("region", { name: "Season builder" });
    await expect(saved).toContainText("Custom · two groups, winner of each");
    await untilHydrated(page, saved);
    await saved.getByRole("button", { name: "Reset to Recommended" }).click();
    await saved.getByRole("button", { name: "Save format", exact: true }).click();
    await expect(page.getByText(/^Season format saved · Recommended/)).toBeVisible();
    await expect
      .poll(async () => (await db.season.findUniqueOrThrow({ where: { id: season.id } })).formatConfig)
      .toBeNull();
    assertNoErrors();
    assertNoHydrationErrors();
  } finally {
    await db.season.update({ where: { id: season.id }, data: { formatConfig: null } });
  }
});
