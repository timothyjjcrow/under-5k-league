import { test, expect } from "@playwright/test";
import { trackPageErrors } from "./helpers";

// Chasing Discord links is a weekly people task: the funnel and its chase post
// live in their own open card, not inside the collapsed Discord settings.
test("Discord reach is its own card, outside the Discord settings", async ({
  page,
}) => {
  const noErrors = trackPageErrors(page);
  await page.goto(
    "/api/auth/dev?name=Reach+Admin&steamId=76561190000994001&admin=1&redirect=/admin",
  );
  const reach = page.locator("#adm-reach");
  await expect(
    reach.getByRole("heading", { name: "Discord reach", level: 2 }),
  ).toBeVisible();
  await expect(reach).toContainText("registered players have linked Discord");
  await expect(page.locator("#adm-discord")).not.toContainText(
    "registered players have linked Discord",
  );
  await expect(
    page
      .getByRole("navigation", { name: "Admin sections" })
      .getByRole("link", { name: "Discord reach", exact: true }),
  ).toHaveAttribute("href", "#adm-reach");
  noErrors();
});
