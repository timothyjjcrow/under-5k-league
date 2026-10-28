import { test, expect } from "@playwright/test";
import {
  expectNoHorizontalOverflow,
  trackPageErrors,
} from "../e2e-mid/helpers";

// Runs after zz-admin-draft (alphabetical) so the seeded season is already in
// DRAFT with a live auction. Guards the phone layout of the marquee event:
// the player pool must come BEFORE the team cards in DOM (captains on the
// clock need it now), the NominateBar's anchor must jump to it, and the fixed
// compact clock bar must clear the 64px sticky header when scrolled.

test.use({ viewport: { width: 375, height: 812 } }); // iPhone-ish

test("draft room on a phone: pool first, working anchor, unclipped clock bar", async ({
  page,
}) => {
  const assertNoErrors = trackPageErrors(page);
  // The admin is not a captain, but sees the same room layout.
  await page.goto(
    "/api/auth/dev?name=Admin&steamId=76561190000000001&admin=1&redirect=/draft",
  );
  await expect(page.getByText(/Available ·/)).toBeVisible();

  // Pool-first: on a phone the pool card must sit ABOVE the team cards. The
  // cards are located by their labelled section, not by a "max $" line: that
  // bid cap only renders while a lot is live, and whether one is live when
  // this spec runs depends on how far the previous spec's clock has run.
  const pool = page.locator("#player-pool");
  await expect(pool).toBeVisible();
  const poolTop = (await pool.boundingBox())!.y;
  const teams = page.getByRole("region", { name: "Team rosters" });
  await expect(teams).toBeVisible();
  const teamsTop = (await teams.boundingBox())!.y;
  expect(poolTop).toBeLessThan(teamsTop);

  // A tapped pool row opens that player's scouting under it, and the card
  // fits the phone. What the tap means for the admin depends on the clock
  // the previous spec left running: during a lot it opens the card, between
  // lots it lines the player up for the team on the clock, which opens the
  // same card. A lot that closes mid-check flips one mode to the other and
  // shuts the card, so tap again until it is open (Dendi's scouting is
  // seeded by e2e/seed-draft-scouting.ts).
  const dendiRow = pool.getByRole("button", { name: /Dendi/ });
  await expect(dendiRow).toHaveCount(1, { timeout: 15_000 });
  const dendiCard = pool.getByRole("group", { name: "Scouting: Dendi" });
  await expect(async () => {
    if (!(await dendiCard.isVisible())) await dendiRow.click();
    await expect(dendiCard).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await expect(dendiCard).toContainText("Recent pubs");
  // Compact on a phone: the segmented strip in a short card, so the
  // pool around it stays in reach. The tiles are one tap away (opened in
  // zz-admin-draft.spec.ts, where no running clock can shut the card).
  await expect(
    dendiCard.getByRole("list", { name: "Scouting at a glance" }),
  ).toContainText("Role");
  await expect(
    dendiCard.getByRole("button", { name: "Full scouting" }),
  ).toBeVisible();
  expect((await dendiCard.boundingBox())!.height).toBeLessThan(260);
  await expectNoHorizontalOverflow(
    page,
    "Draft room at 375px with a pool card open",
  );

  // Scroll deep: the compact clock bar appears and clears the 64px header.
  // Targeted by title — the button deliberately has NO aria-label so screen
  // readers hear its live content (lot, price, clock) as its name.
  await page.mouse.wheel(0, 2400);
  const bar = page.getByTitle("Back to the auction clock");
  await expect(bar).toBeVisible();
  const barBox = (await bar.boundingBox())!;
  expect(barBox.y).toBeGreaterThanOrEqual(64);
  assertNoErrors();
});
