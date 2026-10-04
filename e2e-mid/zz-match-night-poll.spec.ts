import { test, expect, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow, trackPageErrors } from "./helpers";

// The match-night poll end to end: an admin opens it from /admin, a player
// ranks slots on Home and sees the live count, the admin closes it, and the
// result shows on Home for everyone. A zz- spec because it writes league-wide
// state Home renders; it deletes its poll at the end.

const QUESTION = "When should match night be? (e2e)";

async function signIn(page: Page, query: string, redirect: string) {
  await page.goto(`/api/auth/dev?${query}&redirect=${encodeURIComponent(redirect)}`);
}

async function openPollSection(page: Page) {
  const section = page.locator("#adm-poll");
  await page
    .getByRole("navigation", { name: "Admin sections" })
    .getByRole("link", { name: "Match night poll", exact: true })
    .click();
  await expect(section).toHaveAttribute("open", "");
  return section;
}

test("players rank match-night slots on Home and see the instant-runoff count", async ({
  page,
}) => {
  test.slow();
  const noErrors = trackPageErrors(page);

  // 1. An admin opens a three-slot poll.
  await signIn(page, "name=Poll+Admin&steamId=76561190000994101&admin=1", "/admin");
  let section = await openPollSection(page);
  await section.getByLabel("Question").fill(QUESTION);
  const days = section.getByRole("combobox", { name: /^Slot \d day$/ });
  const times = section.getByLabel(/^Slot \d time$/);
  const slots: Array<[string, string]> = [
    ["3", "20:00"], // Wednesday
    ["4", "20:00"], // Thursday
    ["0", "18:00"], // Sunday
  ];
  for (const [index, [day, time]] of slots.entries()) {
    await days.nth(index).selectOption(day);
    await times.nth(index).fill(time);
  }
  await section.getByLabel(/Announce it on Discord/).uncheck();
  await section.getByRole("button", { name: "Open the poll" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Poll open on Home with 3 slots" }),
  ).toBeVisible();

  // 2. An account that isn't signed up sees the slots and who votes, but no
  // ballot.
  await signIn(page, "name=Poll+Outsider&steamId=76561190000994102", "/");
  const card = page.locator("#match-night-poll");
  await expect(card.getByText(/Voting is for players signed up for .+, and you aren't signed up\./)).toBeVisible();
  await expect(card.getByRole("link", { name: "My account" })).toHaveAttribute("href", "/me");
  await expect(card.getByRole("button", { name: /^Rank / })).toHaveCount(0);

  // 3. A rostered player (stage.ts pins this steamId to a home-team player)
  // sees the ballot first, not the count.
  await signIn(page, "name=Poll+Voter&steamId=76561190000991003", "/");
  await expect(card.getByRole("heading", { name: QUESTION, level: 2 })).toBeVisible();
  await expect(card.getByText("Voting open", { exact: true })).toBeVisible();
  await expect(card.getByText("Live count", { exact: true })).toHaveCount(0);
  const save = card.getByRole("button", { name: "Save my ranking" });
  await expect(save).toBeDisabled();

  // Rank Sunday, then Wednesday, then swap them.
  await card.getByRole("button", { name: /^Rank Sundays at .+ as your 1st choice$/ }).click();
  await card.getByRole("button", { name: /^Rank Wednesdays at .+ as your 2nd choice$/ }).click();
  await card.getByRole("button", { name: /^Move Wednesdays at .+ up$/ }).click();
  const ranking = card.getByRole("list", { name: "Your ranking" });
  await expect(ranking.getByRole("listitem")).toHaveCount(2);
  await expect(ranking.getByRole("listitem").first()).toContainText("Wednesdays");

  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page, "home poll ballot");
  await page.setViewportSize({ width: 1280, height: 900 });

  await save.click();
  await expect(
    page.getByRole("status").filter({ hasText: /Vote saved: 2 slots ranked, Wednesdays/ }),
  ).toBeVisible();
  await expect(card.getByText("Your vote is in")).toBeVisible();
  await expect(card.getByText("Live count", { exact: true })).toBeVisible();
  await expect(card.getByText(/Wednesdays .+ leads with 1 of the 1 ballot in play/)).toBeVisible();

  // Changing the ranking reopens the editor with the saved order.
  await card.getByRole("button", { name: "Change my ranking" }).click();
  await expect(
    card.getByRole("list", { name: "Your ranking" }).getByRole("listitem").first(),
  ).toContainText("Wednesdays");
  await card.getByRole("button", { name: "Cancel" }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page, "home poll count");
  await page.setViewportSize({ width: 1280, height: 900 });

  // 4. The admin closes voting; Home shows the winner to everyone.
  await signIn(page, "name=Poll+Admin&steamId=76561190000994101&admin=1", "/admin");
  section = await openPollSection(page);
  page.once("dialog", (dialog) => dialog.accept());
  await section.getByRole("button", { name: "Close voting now" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Voting closed with 1 vote" }),
  ).toBeVisible();

  await page.goto("/");
  await expect(card.getByText("Voting closed", { exact: true })).toBeVisible();
  await expect(card.getByText("The league picked", { exact: true })).toBeVisible();
  await expect(card.getByText(/^Wednesdays at .+ time$/)).toBeVisible();

  // 5. Clean up through the typed-confirmation delete.
  await page.goto("/admin");
  section = await openPollSection(page);
  await section.getByRole("button", { name: "Delete poll" }).click();
  const dialog = page.getByRole("dialog");
  const confirm = dialog.getByRole("button", { name: "Delete poll" });
  await expect(confirm).toBeDisabled();
  await dialog.getByRole("textbox").fill(QUESTION);
  await confirm.click();
  await expect(
    page.getByRole("status").filter({ hasText: "Deleted the poll and its 1 vote" }),
  ).toBeVisible();
  await page.goto("/");
  await expect(page.locator("#match-night-poll")).toHaveCount(0);

  noErrors();
});
