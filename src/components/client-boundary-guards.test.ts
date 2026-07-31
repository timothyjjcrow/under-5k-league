import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

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
const DIR = __dirname;

// Modules that must never appear in a client bundle. discord-roles is listed
// by name (not just prisma) because it is the one server module whose PURE
// siblings (discord-reach) make the wrong import an easy reflex.
const SERVER_ONLY = ["@/lib/prisma", "@/lib/discord-roles", "@/lib/settings"];

const clientFiles = readdirSync(DIR)
  .filter((f) => f.endsWith(".tsx"))
  .map((f) => ({ name: f, src: readFileSync(join(DIR, f), "utf8") }))
  .filter(({ src }) => /^["']use client["']/m.test(src));

describe("client components stay on their side of the server boundary", () => {
  it("found the client components (guard is not vacuous)", () => {
    expect(clientFiles.length).toBeGreaterThan(5);
    expect(clientFiles.some((f) => f.name === "chase-copy.tsx")).toBe(true);
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
