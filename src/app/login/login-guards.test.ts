import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PAGE = readFileSync(join(__dirname, "page.tsx"), "utf8");

/**
 * The ?error= copy lookup must be prototype-safe.
 *
 * `LOGIN_ERRORS[error] ?? GENERIC` on a plain object literal resolves
 * inherited keys: `?error=__proto__` returns Object.prototype (truthy, so the
 * `??` never fires) and React throws "Objects are not valid as a React child"
 * — a crash to the global error boundary from a linkable URL. /me's
 * ?discord= mapping documents and guards this exact class; this test keeps
 * /login from losing the same guard. Source guard because the page is an
 * async server component the node-only vitest setup cannot render.
 */
describe("login error-copy lookup", () => {
  it("finds the lookup it is supposed to be guarding", () => {
    expect(PAGE).toContain("LOGIN_ERRORS");
  });

  it("guards the lookup with hasOwnProperty", () => {
    expect(PAGE).toContain("hasOwnProperty.call(LOGIN_ERRORS");
    // The unguarded shape must not come back.
    expect(PAGE).not.toMatch(/LOGIN_ERRORS\[error\]\s*\?\?/);
  });
});
