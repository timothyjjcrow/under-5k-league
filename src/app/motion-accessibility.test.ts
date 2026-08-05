import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("global reduced-motion fallback", () => {
  it("neutralizes future component animations and transitions", () => {
    const css = readFileSync(
      path.resolve(process.cwd(), "src/app/globals.css"),
      "utf8",
    );
    expect(css).toMatch(
      /prefers-reduced-motion:\s*reduce[\s\S]*?animation-duration:\s*0\.01ms\s*!important/,
    );
    expect(css).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
  });
});
