import { describe, it, expect } from "vitest";
import { sourceFiles } from "../../test/support/source-files";

/**
 * No "use client" component may import a server-only module.
 *
 * The failure this pins was real and invisible: chase-copy.tsx imported a
 * pure helper via @/lib/discord-roles — whose first line imports prisma —
 * and the build SUCCEEDED, shipping Prisma's browser stub (complete model
 * and column-name maps) in a public /_next/static chunk. tsc was clean,
 * every test passed, and the page even worked, because the stub only throws
 * on first property access. A bundle-content regression has no type error
 * and no behavioural test; parsing the imports is the only cheap tripwire.
 *
 * `server-only` (the package) is the framework-native fix, but it throws in
 * ANY plain-Node context — vitest, tsx scripts, the seeders — so it cannot
 * be added to a repo whose prisma module is imported by all three.
 */
// Modules that must never appear in a client bundle. discord-roles is listed
// by name (not just prisma) because it is the one server module whose PURE
// siblings (discord-reach) make the wrong import an easy reflex.
const SERVER_ONLY = ["@/lib/prisma", "@/lib/discord-roles", "@/lib/settings"];

// Every "use client" file anywhere under src/, not just src/components: a
// client component living beside its page (src/app/**) ships to the browser
// just the same, and a fixed folder would stop seeing one the moment it moved.
const clientFiles = sourceFiles("src/**/*.{ts,tsx}", 300)
  .filter(({ text }) => /^["']use client["']/m.test(text))
  .map(({ path, text }) => ({ name: path, src: text }));

describe("client components stay on their side of the server boundary", () => {
  it("found the client components (guard is not vacuous)", () => {
    // 44 today, three of them outside src/components.
    expect(clientFiles.length).toBeGreaterThanOrEqual(40);
    expect(
      clientFiles.some((f) => f.name === "src/components/chase-copy.tsx"),
    ).toBe(true);
    expect(clientFiles.some((f) => f.name.startsWith("src/app/"))).toBe(true);
  });

  it.each(clientFiles.map(({ name, src }) => [name, src]))(
    "%s imports no server-only module",
    (_name, src) => {
      for (const mod of SERVER_ONLY) {
        expect(
          src.includes(`from "${mod}"`),
          `imports ${mod} — that module reaches prisma, and this file is in the client bundle. Import from a pure sibling (e.g. @/lib/discord-reach) instead.`,
        ).toBe(false);
      }
    },
  );
});
