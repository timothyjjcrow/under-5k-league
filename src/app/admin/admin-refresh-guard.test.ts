import { describe, expect, it } from "vitest";
import {
  sourceFiles,
  stripLineComments,
} from "../../../test/support/source-files";

/**
 * A write an admin page shows refreshes the whole admin area.
 *
 * `revalidatePath("/admin")` refreshes that one page only. Next updates the
 * page the admin is looking at after a server action only when it matches the
 * revalidated path, so a button pressed on another admin page (/admin/activity
 * today, and the admin tabs planned next) would look like it did nothing until
 * a reload. `revalidatePath("/admin", "layout")` covers /admin and every page
 * under it.
 */
describe("admin refreshes", () => {
  const files = sourceFiles(
    ["src/app/**/*.{ts,tsx}", "src/lib/**/*.ts", "src/components/**/*.tsx"],
    100,
  );

  it("never refresh a single /admin page", () => {
    const pagePath = /revalidatePath\(\s*["'`]\/admin[^"'`]*["'`]\s*\)/;
    const offenders = files
      .filter((file) => pagePath.test(stripLineComments(file.text)))
      .map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  it("still finds the admin refreshes it guards", () => {
    const layout = /revalidatePath\(\s*["'`]\/admin["'`],\s*["'`]layout["'`]\s*\)/g;
    const calls = files.reduce(
      (sum, file) => sum + (stripLineComments(file.text).match(layout)?.length ?? 0),
      0,
    );
    expect(calls).toBeGreaterThanOrEqual(7);
  });
});
