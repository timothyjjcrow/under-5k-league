import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("production automation configuration", () => {
  it("registers one production minute cron on the authenticated worker path", () => {
    const config = JSON.parse(
      readFileSync(path.resolve(process.cwd(), "vercel.json"), "utf8"),
    ) as { crons?: Array<{ path: string; schedule: string }> };

    expect(config.crons).toEqual([
      { path: "/api/cron/automation", schedule: "* * * * *" },
    ]);
  });

  it("documents the dedicated scheduler credential without making it public", () => {
    const example = readFileSync(
      path.resolve(process.cwd(), ".env.example"),
      "utf8",
    );

    expect(example).toMatch(/^CRON_SECRET=""$/m);
    expect(example).not.toMatch(/^NEXT_PUBLIC_CRON_SECRET=/m);
  });
});
