import { test, expect, type Page } from "@playwright/test";
import { trackPageErrors } from "./helpers";

async function acceptNextDialog(page: Page) {
  page.once("dialog", (dialog) => dialog.accept());
}

function resultRowForHref(page: Page, matchHref: string) {
  return page
    .locator(`#main a[href="${matchHref}"]`)
    .locator('xpath=ancestor::div[contains(@class, "space-y-2")][1]');
}

async function reopenRecordedFixture(page: Page, matchHref: string) {
  if (!page.url().endsWith("/admin")) await page.goto("/admin");
  const row = resultRowForHref(page, matchHref);
  const reopen = row.getByRole("button", { name: "Reopen for import" });
  if (!(await reopen.isVisible().catch(() => false))) return false;
  await acceptNextDialog(page);
  await reopen.click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Match reopened — its games can be imported now" }),
  ).toBeVisible();
  return true;
}

test("admin result entry rejects partial play and supports a reversible no-game ruling", async ({
  page,
}) => {
  test.slow();
  const assertNoErrors = trackPageErrors(page);
  await page.goto("/api/auth/dev?name=Result%20Admin&admin=1");
  await page.goto("/admin");
  await expect(
    page.getByRole("heading", { name: "Admin", exact: true }),
  ).toBeVisible();

  // stage.ts makes the first open fixture a LIVE 1–0 Bo2 with one imported
  // game. Imported scores are read-only unless the admin explicitly records a
  // ruling, so the form must name that exceptional action and require its box.
  const liveSave = page.getByRole("button", { name: "Save ruling" }).first();
  const liveForm = liveSave.locator("xpath=ancestor::form[1]");
  const liveScores = liveForm.getByRole("spinbutton");
  await expect(liveScores.nth(0)).toHaveValue("1");
  await expect(liveScores.nth(1)).toHaveValue("0");
  await expect(
    liveForm.getByRole("checkbox", { name: "forfeit / ruling" }),
  ).toHaveAttribute("required", "");
  await expect(liveForm).toContainText(
    "The imported games currently account for 1–0",
  );

  // A no-game SCHEDULED row still accepts a manual score, but the server must
  // reject a partial played series unless the admin explicitly marks a ruling.
  const rulingSave = page
    .getByRole("button", { name: "Save as final" })
    .first();
  const rulingForm = rulingSave.locator("xpath=ancestor::form[1]");
  const rulingScores = rulingForm.getByRole("spinbutton");
  const matchHref = await rulingForm
    .getByRole("link", { name: "Wk 5" })
    .getAttribute("href");
  expect(matchHref).toMatch(/^\/matches\//);
  await rulingScores.nth(0).fill("1");
  await rulingScores.nth(1).fill("0");
  await acceptNextDialog(page);
  await rulingSave.click();
  const playedFinalError = page
    .getByRole("alert")
    .filter({ hasText: "A played best-of-2 is final after 2 games" });
  await expect(playedFinalError).toContainText(
    "mark this as a forfeit/ruling if the series ended early",
  );
  await expect(rulingScores.nth(0)).toHaveValue("1");
  await expect(rulingScores.nth(1)).toHaveValue("0");
  await expect(rulingSave).toBeEnabled();
  await playedFinalError.getByRole("button", { name: "Dismiss" }).click();

  // Explicitly rule that same scheduled row, then restore it through the
  // product's correction control so this shared fixture remains replay-safe.
  let restored = false;
  try {
    await rulingScores.nth(0).fill("1");
    await rulingScores.nth(1).fill("0");
    await rulingForm
      .getByRole("checkbox", { name: "forfeit / ruling" })
      .check();
    await acceptNextDialog(page);
    await rulingSave.click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Result saved · 1–0 (forfeit" }),
    ).toBeVisible();

    const completedRow = resultRowForHref(page, matchHref!);
    await expect(
      completedRow.getByText("final · forfeit", { exact: true }),
    ).toBeVisible();
    await expect(
      completedRow.getByText("Recorded by hand — no games imported."),
    ).toBeVisible();
    await expect(
      completedRow.getByRole("button", { name: "Reopen for import" }),
    ).toBeVisible();

    // Verify the public result representation while the ruling is committed,
    // without navigating the admin tab away from its correction control.
    const detail = await page.context().newPage();
    const assertNoDetailErrors = trackPageErrors(detail);
    try {
      await detail.goto(matchHref!);
      await expect(
        detail.getByText("Series complete", { exact: true }),
      ).toBeVisible();
      await expect(detail.getByText("forfeit", { exact: true })).toBeVisible();
      await expect(
        detail.getByText("Series awarded by forfeit", { exact: true }),
      ).toBeVisible();
      await expect(
        detail.getByText(
          "This is an administrative ruling; no Dota game was recorded for this series.",
        ),
      ).toBeVisible();
      assertNoDetailErrors();
    } finally {
      await detail.close();
    }

    restored = await reopenRecordedFixture(page, matchHref!);
    expect(restored).toBe(true);
    const reopenedRow = resultRowForHref(page, matchHref!);
    const reopenedScores = reopenedRow.getByRole("spinbutton");
    await expect(reopenedScores.nth(0)).toHaveValue("0");
    await expect(reopenedScores.nth(1)).toHaveValue("0");
    await expect(
      reopenedRow.getByRole("textbox", { name: "Dota match ID or URL" }),
    ).toBeVisible();
    await expect(
      reopenedRow.getByRole("button", { name: "Reopen for import" }),
    ).toHaveCount(0);
  } finally {
    // A failed display assertion must not poison the shared midseason fixture
    // for a developer's next focused run. Reopen through the same guarded UI;
    // if the feature itself is broken, the original assertion remains the
    // actionable failure and this best-effort cleanup does not mask it.
    if (!restored && matchHref) {
      await reopenRecordedFixture(page, matchHref).catch(() => false);
    }
  }

  assertNoErrors();
});
