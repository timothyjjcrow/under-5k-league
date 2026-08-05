import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("production automation configuration", () => {
  it("does not register an unsupported Vercel Hobby cron", () => {
    const config = JSON.parse(
      readFileSync(path.resolve(process.cwd(), "vercel.json"), "utf8"),
    ) as { crons?: Array<{ path: string; schedule: string }> };

    expect(config.crons).toBeUndefined();
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
