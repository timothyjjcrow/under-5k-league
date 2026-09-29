import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { StatsDataNoticeBody } from "./stats-nav";

// The notice shows while any stored game line is unusable, and it stays until
// an admin repairs the game: nothing re-checks it. "Still being checked… for
// now" promised a delay that clears itself and never did.
describe("stats data notice for players", () => {
  it("says an admin has to fix the games, not that they are being checked", () => {
    const html = renderToStaticMarkup(
      createElement(StatsDataNoticeBody, { invalidLines: 1, malformedGames: 0 }),
    );
    expect(html).toContain("Some imported games are incomplete");
    expect(html).toContain("until an admin fixes them");
    expect(html).not.toMatch(/being checked|for now/);
  });

  it("the meta page's empty state makes the same promise", () => {
    const meta = readFileSync(path.join(__dirname, "../app/meta/page.tsx"), "utf8");
    expect(meta).not.toMatch(/still being checked/);
    expect(meta).toContain("once an admin fixes it.");
  });
});
