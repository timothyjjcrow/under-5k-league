import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, trackPageErrors } from "./helpers";

// Read-only: nothing here presses Save, so the staged team names other specs
// rely on stay as they are. The save itself is covered by
// test/integration/team-identity.itest.ts.
test("a captain edits their own team from its page with a live crest preview", async ({
  page,
}) => {
  const noErrors = trackPageErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  // stage.ts gives this identity to a scheduled fixture's home captain.
  await page.goto(
    "/api/auth/dev?name=Identity+Captain&steamId=76561190000991001&redirect=/",
  );
  const dock = page.getByRole("navigation", { name: "Quick navigation" });
  await dock.getByRole("link", { name: "My Team", exact: true }).click();
  await expect(page).toHaveURL(/\/teams\/[^/]+$/);
  const teamName = (
    await page.getByRole("heading", { level: 1 }).textContent()
  )?.trim();
  expect(teamName).toBeTruthy();

  const edit = page.locator("summary", { hasText: "Edit team name and logo" });
  await expect(edit).toBeVisible();
  await edit.click();
  await expect(
    page.getByRole("textbox", { name: `Name for ${teamName}`, exact: true }),
  ).toHaveValue(teamName!);
  const logo = page.getByRole("textbox", {
    name: `Logo URL for ${teamName}`,
    exact: true,
  });
  const save = page.getByRole("button", { name: "Save team", exact: true });

  // An expiring Discord upload is flagged before anyone presses Save.
  await logo.fill(
    "https://cdn.discordapp.com/attachments/1/2/logo.png?ex=66f00000&is=66ee0000&hm=abc&",
  );
  await expect(
    page.getByText(/Discord image links stop working after about a day/),
  ).toBeVisible();
  await expect(save).toBeDisabled();
  await logo.fill("");
  await expect(
    page.getByText(/No logo, so the crest shows the team's initials/),
  ).toBeVisible();
  await expect(save).toBeEnabled();
  await expectNoHorizontalOverflow(page, "/teams/[id] captain edit form");

  // A teammate who isn't the captain sees the same page without the form.
  await page.goto(
    "/api/auth/dev?name=Identity+Teammate&steamId=76561190000991003&redirect=/",
  );
  await dock.getByRole("link", { name: "My Team", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(teamName!);
  await expect(
    page.locator("summary", { hasText: "Edit team name and logo" }),
  ).toHaveCount(0);
  noErrors();
});
