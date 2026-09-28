import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { MID_DB_URL } from "../playwright.midseason.config";
import { trackPageErrors } from "./helpers";

// Chasing Discord links is a weekly people task: the funnel and its chase post
// live in their own open card, not inside the collapsed Discord settings.
test("Discord reach is its own card, outside the Discord settings", async ({
  page,
}) => {
  const noErrors = trackPageErrors(page);
  // Mid-season fixtures contain rosters but no signups, and the funnel counts
  // signups. Stage one rostered player's signup in this disposable DB, then
  // remove it.
  const db = new PrismaClient({ datasources: { db: { url: MID_DB_URL } } });
  const member = await db.teamMember.findFirstOrThrow({
    where: {
      season: { isActive: true },
      user: { registrations: { none: {} }, discordId: null },
    },
    include: { user: true },
  });
  const registration = await db.registration.create({
    data: {
      userId: member.userId,
      seasonId: member.seasonId,
      mmr: 2500,
      roles: "1",
    },
  });
  try {
    await page.goto(
      "/api/auth/dev?name=Reach+Admin&steamId=76561190000994001&admin=1&redirect=/admin",
    );
    const reach = page.locator("#adm-reach");
    await expect(
      reach.getByRole("heading", { name: "Discord reach", level: 2 }),
    ).toBeVisible();
    await expect(reach).toContainText("registered players have linked Discord");
    await expect(reach).toContainText(member.user.name);
    await expect(page.locator("#adm-discord")).not.toContainText(
      "registered players have linked Discord",
    );
    await expect(
      page
        .getByRole("navigation", { name: "Admin sections" })
        .getByRole("link", { name: "Discord reach", exact: true }),
    ).toHaveAttribute("href", "#adm-reach");
    noErrors();
  } finally {
    await db.registration.delete({ where: { id: registration.id } });
    await db.$disconnect();
  }
});
