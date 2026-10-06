import { PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { E2E_DB_URL } from "../playwright.config";
import { trackPageErrors } from "../e2e-mid/helpers";

// A translated page must survive React's next update. Chrome's "Translate
// this page" swaps text nodes for <font> elements; when a first signup saved
// and /me re-rendered, React removed a text node that was no longer there,
// the browser threw NotFoundError, and the error page replaced /me for a
// player reading the league in Russian (2026-10-06). The guard in the root
// layout (src/lib/translation-dom-guard.ts) keeps that from crashing.

const db = new PrismaClient({ datasources: { db: { url: E2E_DB_URL } } });
const STEAM_ID = "76561199123459999";

test.afterAll(async () => {
  // Leave the shared suite's signup count as the seed made it.
  const user = await db.user.findUnique({ where: { steamId: STEAM_ID }, select: { id: true } });
  if (user) {
    await db.registration.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } }).catch(() => undefined);
  }
  await db.$disconnect();
});

/** What page translation does: each text node becomes <font><font>…</font></font>. */
function translatePage(): number {
  const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "OPTION"]);
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.nodeValue?.trim() && !skip.has(node.parentNode?.nodeName ?? "")
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT,
  });
  const nodes: Node[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const outer = document.createElement("font");
    outer.style.verticalAlign = "inherit";
    const inner = document.createElement("font");
    inner.style.verticalAlign = "inherit";
    inner.textContent = node.nodeValue;
    outer.appendChild(inner);
    node.parentNode?.replaceChild(outer, node);
  }
  return nodes.length;
}

test("a translated /me survives a first signup", async ({ page }) => {
  const noErrors = trackPageErrors(page);
  const domErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /removeChild|insertBefore|NotFoundError/.test(message.text())) {
      domErrors.push(message.text());
    }
  });
  await page.goto(`/api/auth/dev?name=Translated+Signup&steamId=${STEAM_ID}&redirect=/me`);
  await page.waitForLoadState("networkidle");
  // Translation starts once the page has settled, after hydration.
  await page.waitForTimeout(1500);
  expect(await page.evaluate(translatePage)).toBeGreaterThan(20);

  await page.fill('input[name="mmr"]', "4800");
  for (const role of ["1", "2"]) await page.check(`input[name="roles"][value="${role}"]`);
  await page.getByRole("button", { name: /Join the season/ }).click();

  // The invite ask only renders for a signed-up player: a new element, so it
  // shows whatever the translator did to the old text.
  await expect(page.getByRole("button", { name: "Copy invite link" })).toBeVisible();
  await expect(page.getByText("Something went wrong")).toHaveCount(0);
  expect(domErrors).toEqual([]);
  noErrors();
});
