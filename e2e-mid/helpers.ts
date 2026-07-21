import { expect, type Page } from "@playwright/test";

/**
 * Tripwire for the exact failure class this suite exists to catch: a client
 * component that renders server-side but CRASHES in the browser (hydration
 * mismatch, undefined access in an effect). Attach before navigating; call
 * the returned assert at the end of the test.
 */
export function trackPageErrors(page: Page): () => void {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return () =>
    expect(errors, "uncaught client-side errors on the page").toEqual([]);
}
