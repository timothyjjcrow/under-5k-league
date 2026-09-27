import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every `/login?…` link must use a query parameter the login page actually
 * reads. The scrim page once linked to `/login?returnTo=…`; /login only reads
 * `next`, so a signed-out captain who tapped "Sign in" to claim a scrim came
 * back on the home page instead of the scrim. Nothing errors when that
 * happens, so this reads the accepted names out of the page's own
 * `searchParams` destructure and checks every literal link in src against it.
 */

const SRC = path.resolve(process.cwd(), "src");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

function acceptedLoginParams(): Set<string> {
  const page = readFileSync(path.join(SRC, "app/login/page.tsx"), "utf8");
  const match = page.match(/const\s*\{([^}]*)\}\s*=\s*await\s+searchParams/);
  if (!match) return new Set();
  return new Set(
    match[1]
      .split(",")
      .map((part) => part.split(":")[0].trim())
      .filter(Boolean),
  );
}

describe("links to /login", () => {
  const accepted = acceptedLoginParams();

  it("finds the parameters the login page reads", () => {
    // If this fails the destructure moved; fix the parser, not the links.
    expect(accepted.has("next")).toBe(true);
  });

  it("only use parameters the login page reads", () => {
    const bad: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/\/login\?([A-Za-z_]+)=/g)) {
        if (!accepted.has(m[1])) {
          bad.push(`${path.relative(SRC, file)}: ?${m[1]}=`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
