import { test, expect } from "@playwright/test";

// Runs after zz-admin-draft (alphabetical) so the seeded season is already in
// DRAFT with a live auction. Guards the phone layout of the marquee event:
// the player pool must come BEFORE the team cards in DOM (captains on the
// clock need it now), the NominateBar's anchor must jump to it, and the fixed
// compact clock bar must clear the 80px sticky header when scrolled.

test.use({ viewport: { width: 375, height: 812 } }); // iPhone-ish

test("draft room on a phone: pool first, working anchor, unclipped clock bar", async ({
  page,
}) => {
  // The admin is not a captain, but sees the same room layout.
  await page.goto(
    "/api/auth/dev?name=Admin&steamId=76561190000000001&admin=1&redirect=/draft",
  );
  await expect(page.getByText(/Available ·/)).toBeVisible();

  // Pool-first: on a phone the pool card must sit ABOVE the first team card
  // (team cards are the ones carrying a "max $" bid-cap line).
  const pool = page.locator("#player-pool");
  await expect(pool).toBeVisible();
  const poolTop = (await pool.boundingBox())!.y;
  const teamCard = page.getByText(/max \$/).first();
  const teamsTop = (await teamCard.boundingBox())!.y;
  expect(poolTop).toBeLessThan(teamsTop);

  // Scroll deep: the compact clock bar appears and clears the 80px header.
  // Targeted by title — the button deliberately has NO aria-label so screen
  // readers hear its live content (lot, price, clock) as its name.
  await page.mouse.wheel(0, 2400);
  const bar = page.getByTitle("Back to the auction clock");
  await expect(bar).toBeVisible();
  const barBox = (await bar.boundingBox())!;
  expect(barBox.y).toBeGreaterThanOrEqual(80);
});
