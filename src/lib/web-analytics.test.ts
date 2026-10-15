import { describe, expect, it } from "vitest";
import { webAnalyticsUrl } from "./web-analytics";
import { LEAGUE_TARGETS, VERCEL_SCOPE } from "../../scripts/league-targets.mjs";
import {
  filesContaining,
  sourceFiles,
  stripLineComments,
} from "../../test/support/source-files";

describe("webAnalyticsUrl", () => {
  it("opens each league's own Vercel project", () => {
    expect(webAnalyticsUrl("us")).toBe(
      "https://vercel.com/timothyjjcrows-projects/under-4.5k-league/analytics",
    );
    expect(webAnalyticsUrl("eu")).toBe(
      "https://vercel.com/timothyjjcrows-projects/ggd2l-europe/analytics",
    );
  });

  it("matches the release scripts' deployment targets", () => {
    for (const target of LEAGUE_TARGETS) {
      expect(webAnalyticsUrl(target.region as "us" | "eu")).toBe(
        `https://vercel.com/${VERCEL_SCOPE}/${target.name}/analytics`,
      );
    }
    expect(LEAGUE_TARGETS.map((t) => t.region).sort()).toEqual(["eu", "us"]);
  });
});

describe("the admin Website traffic link", () => {
  // Every file that renders a link to the dashboard, wherever it moves.
  const callers = filesContaining(
    sourceFiles("src/**/*.tsx", 100).map((f) => ({
      ...f,
      text: stripLineComments(f.text),
    })),
    "webAnalyticsUrl(",
  );

  it("is rendered on /admin", () => {
    expect(callers.map((f) => f.path)).toContain("src/app/admin/page.tsx");
  });

  it("renders only inside a siteAnalyticsEnabled() branch", () => {
    // Only Vercel production sends the dashboard data; the self-hosted box
    // and previews show no link. Each call must sit after the gate's `?` and
    // before that branch closes.
    let calls = 0;
    for (const file of callers) {
      for (const match of file.text.matchAll(/webAnalyticsUrl\(/g)) {
        calls += 1;
        const before = file.text.slice(0, match.index);
        const gate = before.lastIndexOf("siteAnalyticsEnabled() ?");
        expect(gate, file.path).toBeGreaterThanOrEqual(0);
        expect(before.slice(gate), file.path).not.toMatch(/\)\s*:\s*null\s*\}/);
      }
    }
    expect(calls).toBeGreaterThan(0);
  });
});
