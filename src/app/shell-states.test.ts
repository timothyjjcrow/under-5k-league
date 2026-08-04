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
  });

  it("owns a standalone root-layout failure document", () => {
    const src = read("global-error.tsx");
    expect(src).toContain('"use client"');
    expect(src).toContain("<html");
    expect(src).toContain("<body");
    expect(src).toContain("unstable_retry");
    expect(src).not.toContain("{error.message");
  });

  it("announces loading and not-found states semantically", () => {
    expect(read("loading.tsx")).toContain('role="status"');
    expect(read("not-found.tsx")).toContain("<h1");
  });
});
