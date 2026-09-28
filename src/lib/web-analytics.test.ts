import { describe, expect, it } from "vitest";
import { webAnalyticsUrl } from "./web-analytics";
import { LEAGUE_TARGETS, VERCEL_SCOPE } from "../../scripts/league-targets.mjs";

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
