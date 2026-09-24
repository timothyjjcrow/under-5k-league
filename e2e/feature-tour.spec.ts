import { test, expect } from "@playwright/test";
import { LEAGUE_CONFIG } from "../src/lib/league-config";
import {
  expectNoHorizontalOverflow,
  trackPageErrors,
} from "../e2e-mid/helpers";

test("feature tour shows the whole league without presenting examples as live results", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/features");
  await expect(page).toHaveTitle(`Feature tour · ${LEAGUE_CONFIG.name}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Your team.Your season.Your kind of Dota.",
  );
  await expect(
    page.getByText("Illustrative preview", { exact: true }),
  ).toHaveCount(4);
  await expect(
    page
      .getByRole("navigation", { name: "Feature tour chapters" })
      .getByRole("link"),
  ).toHaveCount(7);
  const directory = page.getByRole("region", {
    name: "Everything the league offers.",
  });
  await expect(directory.getByRole("article")).toHaveCount(32);
  await expect(directory.getByRole("status")).toHaveText("32 of 32 features");
  // The signup fixture has no auction, results, or rosters yet. Describe those
  // features, but do not send a prospective player to an unavailable tool.
  for (const href of [
    "/draft",
    "/schedule",
    "/fantasy",
    "/pickem",
    "/meta",
    "/leaders",
    "/scrims",
    "/recap",
  ]) {
    await expect(page.locator(`main a[href="${href}"]`)).toHaveCount(0);
  }
  await expect(
    directory.getByRole("link", { name: "Inhouse queue" }),
  ).toHaveAttribute("href", "/inhouse");
  await expect(
    page.getByRole("heading", { name: "Signups are open", level: 2 }),
  ).toBeVisible();
  const signup = page.getByRole("link", { name: "Sign up with Steam" }).first();
  await expect(signup).toHaveAttribute("href", "/login?next=/me");
  await signup.click();
  await expect(
    page.getByRole("heading", { name: `Sign in to ${LEAGUE_CONFIG.name}` }),
  ).toBeVisible();
  assertNoErrors();
});

test("feature directory combines category and search and recovers from no results", async ({
  page,
}) => {
  await page.goto("/features#all-features");
  const directory = page.getByRole("region", {
    name: "Everything the league offers.",
  });
  const search = directory.getByRole("searchbox", { name: "Find a feature" });
  await search.fill("  SCRIM  ");
  await expect(directory.getByRole("article")).toHaveCount(2);
  await expect(
    directory.getByRole("heading", { name: "Team scrims", exact: true }),
  ).toBeVisible();
  await directory.getByRole("button", { name: "Stats & scouting" }).click();
  await expect(
    directory.getByRole("heading", { name: "No features found" }),
  ).toBeVisible();
  await expect(directory.getByRole("status")).toHaveText("0 of 32 features");
  await directory.getByRole("button", { name: "Reset filters" }).click();
  await expect(search).toHaveValue("");
  await expect(
    directory.getByRole("button", { name: "All features" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(directory.getByRole("article")).toHaveCount(32);
  await directory.getByRole("button", { name: "History & community" }).click();
  await expect(directory.getByRole("article")).toHaveCount(5);
  await search.fill("record book");
  await expect(directory.getByRole("article")).toHaveCount(1);
  await directory
    .getByRole("link", { name: "Record book", exact: true })
    .click();
  await expect(page).toHaveURL(/\/records$/);
  await expect(
    page.getByRole("heading", { name: "Record book", exact: true, level: 1 }),
  ).toBeVisible();
});

test("joining answers use this region and work from the keyboard", async ({
  page,
}) => {
  await page.goto("/features");
  const region = LEAGUE_CONFIG.region === "eu" ? "Europe" : "United States";
  await expect(
    page.getByText(`${region} · ${LEAGUE_CONFIG.gameServerRegion}`, {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText(LEAGUE_CONFIG.matchSchedule.label, { exact: true }),
  ).toBeVisible();
  const question = page
    .locator("summary")
    .filter({ hasText: "Where and when do we play?" });
  await question.focus();
  await page.keyboard.press("Enter");
  await expect(question.locator("..")).toHaveAttribute("open", "");
  await expect(question.locator("..")).toContainText(
    `This is the ${region} league, using ${LEAGUE_CONFIG.gameServerRegion} servers.`,
  );
  await page.keyboard.press("Enter");
  await expect(question.locator("..")).not.toHaveAttribute("open", "");
  const community = page.getByRole("link", {
    name: "Meet the community",
    exact: true,
  });
  if (LEAGUE_CONFIG.discordInviteUrl) {
    await expect(community).toHaveAttribute(
      "href",
      LEAGUE_CONFIG.discordInviteUrl,
    );
  } else {
    await expect(community).toHaveCount(0);
    await expect(
      page
        .getByRole("region", { name: "Signups are open" })
        .getByRole("link", { name: "League news" }),
    ).toBeVisible();
  }
});

test("tour chapters, directory, and signup fit phones and desktop", async ({
  page,
}) => {
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/features");
    await expectNoHorizontalOverflow(page, `feature tour at ${width}px`);
    await page
      .getByRole("navigation", { name: "Feature tour chapters" })
      .getByRole("link", { name: "All features", exact: true })
      .click();
    await expect(page).toHaveURL(/#all-features$/);
    await expect(
      page.getByRole("searchbox", { name: "Find a feature" }),
    ).toBeInViewport();
    await page.getByRole("searchbox").fill("fantasy");
    await expectNoHorizontalOverflow(page, `filtered tour at ${width}px`);
  }
});

test("signup calls to action distinguish a new account from a registered player", async ({
  page,
}) => {
  await page.goto(
    "/api/auth/dev?name=TourVisitor&steamId=76561190000000432&redirect=/features",
  );
  await expect(
    page.getByRole("heading", { name: "Finish your player signup" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Complete your signup" }).first(),
  ).toHaveAttribute("href", "/me");
  await page.goto("/api/auth/dev?steamId=7656119800001002&redirect=/features");
  await expect(
    page.getByRole("heading", { name: "You're signed up" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Review your signup" }).first(),
  ).toHaveAttribute("href", "/me");
});
