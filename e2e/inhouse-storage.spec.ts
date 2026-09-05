import { expect, test } from "@playwright/test";
import type { InhouseState } from "../src/lib/inhouse-service";

for (const mode of ["unavailable", "write-blocked"] as const) {
  test(`inhouse stays usable when preference storage is ${mode}`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript((storageMode) => {
      if (storageMode === "unavailable") {
        Object.defineProperty(window, "localStorage", {
          configurable: true,
          get() {
            throw new DOMException(
              "Storage blocked by browser",
              "SecurityError",
            );
          },
        });
      } else {
        const storage = window.localStorage;
        storage.setItem("inhouseSound", "on");
        const originalSet = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key: string, value: string) {
          if (this === storage)
            throw new DOMException(
              "Storage quota exhausted",
              "QuotaExceededError",
            );
          originalSet.call(this, key, value);
        };
      }
    }, mode);

    // Read the real payload contract, then serve a deterministic result banner.
    // No queue/result mutations: these faults concern client preferences alone.
    const response = await page.request.post("/api/inhouse", {
      data: { action: "state" },
      headers: { Origin: "http://localhost:3210" },
    });
    expect(response.ok()).toBe(true);
    const snapshot = (await response.json()) as InhouseState;
    await page.route("**/api/inhouse", async (route) => {
      await route.fulfill({
        json: {
          ...snapshot,
          now: Date.now(),
          lobby: null,
          queue: [],
          needed: snapshot.lobbySize,
          me: {
            ...snapshot.me,
            isLoggedIn: false,
            isAdmin: false,
            inLobby: false,
            inQueue: false,
            canJoin: false,
            canCancel: false,
          },
          lastResult: {
            lobbyId: "storage-fault-result",
            winnerSide: "Radiant",
            radiantScore: 30,
            direScore: 20,
            myTeamWon: true,
            eloDelta: 16,
            credDelta: null,
            credPending: false,
          },
        },
      });
    });

    await page.goto("/inhouse");
    await expect(
      page.getByRole("heading", { name: "Inhouse queue", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Sound on", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Muted", exact: true }),
    ).toHaveAttribute("aria-pressed", "false");
    await page.getByRole("button", { name: "Muted", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Sound on", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Dismiss result banner" }).click();
    await expect(
      page.getByRole("button", { name: "Dismiss result banner" }),
    ).toHaveCount(0);

    const refreshed = page.waitForResponse(
      (res) =>
        res.url().endsWith("/api/inhouse") && res.request().method() === "POST",
    );
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await refreshed;
    await expect(
      page.getByRole("button", { name: "Dismiss result banner" }),
    ).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
