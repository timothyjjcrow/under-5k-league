import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...parts: string[]) =>
  readFileSync(join(__dirname, ...parts), "utf8");

describe("application shell fallback states", () => {
  it("uses the Next 16 refetching retry contract for route errors", () => {
    const src = read("error.tsx");
    expect(src).toContain("unstable_retry");
    expect(src).not.toContain("onClick={reset}");
    expect(src).not.toContain("{error.message");
    expect(src).toContain('[ui-error] route render failed');
  });

  it("owns a standalone root-layout failure document", () => {
    const src = read("global-error.tsx");
    expect(src).toContain('"use client"');
    expect(src).toContain("<html");
    expect(src).toContain("<body");
    expect(src).toContain("unstable_retry");
    expect(src).not.toContain("{error.message");
    expect(src).toContain('[ui-error] root layout failed');
  });

  it("announces loading and not-found states semantically", () => {
    expect(read("loading.tsx")).toContain('role="status"');
    expect(read("not-found.tsx")).toContain("<h1");
    // The tab used to read just the league name on a missing page.
    expect(read("not-found.tsx")).toContain(
      'export const metadata: Metadata = { title: "Page not found" }',
    );
  });

  it.each(["not-found.tsx", "error.tsx", "global-error.tsx"])(
    "%s points to Home, the schedule and the league Discord",
    (file) => {
      const src = read(file);
      expect(src).toMatch(/href="\/"/);
      expect(src).toContain('href="/schedule"');
      // DiscordButton reads the invite; the standalone document reads it
      // itself because it cannot rely on the app's components.
      expect(src).toMatch(
        /<DiscordButton label="Ask on Discord"|href=\{LEAGUE_CONFIG\.discordInviteUrl\}/,
      );
    },
  );
});
