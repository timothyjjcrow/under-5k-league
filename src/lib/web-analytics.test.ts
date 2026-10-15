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

/**
 * Whether the text before a call ends inside the true branch of
 * `{siteAnalyticsEnabled() ? (`: the nearest gate is opened by `{` (so not
 * negated), its `?` is followed by `(`, and no `) : …` has closed the branch.
 */
function insideEnabledBranch(before: string): boolean {
  const gate = before.lastIndexOf("siteAnalyticsEnabled()");
  if (gate < 0) return false;
  if (!before.slice(0, gate).trimEnd().endsWith("{")) return false;
  const branch = before.slice(gate);
  if (!/^siteAnalyticsEnabled\(\)\s*\?\s*\(/.test(branch)) return false;
  return !/\)\s*:/.test(branch);
}

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
    // and previews show no link. Each call must sit in the TRUE branch of an
    // un-negated `{siteAnalyticsEnabled() ? (` and before that branch closes.
    let calls = 0;
    for (const file of callers) {
      for (const match of file.text.matchAll(/webAnalyticsUrl\(/g)) {
        calls += 1;
        expect(insideEnabledBranch(file.text.slice(0, match.index)), file.path).toBe(true);
      }
    }
    expect(calls).toBeGreaterThan(0);
  });

  it("the gate check refuses a negated or inverted gate", () => {
    const call = "<p><a href={webAnalyticsUrl(r)}>x</a></p>";
    const before = (jsx: string) => jsx.slice(0, jsx.indexOf("webAnalyticsUrl("));
    expect(insideEnabledBranch(before(`{siteAnalyticsEnabled() ? (\n  ${call}\n) : null}`))).toBe(true);
    for (const refused of [
      `{!siteAnalyticsEnabled() ? (\n  ${call}\n) : null}`,
      `{siteAnalyticsEnabled() ? null : (\n  ${call}\n)}`,
      `{siteAnalyticsEnabled() ? (\n  <p/>\n) : (\n  ${call}\n)}`,
      `{siteAnalyticsEnabled() ? (\n  <p/>\n) : null}\n${call}`,
      `{siteAnalyticsEnabled() || (\n  ${call}\n)}`,
      call,
    ]) {
      expect(insideEnabledBranch(before(refused)), refused).toBe(false);
    }
  });
});
