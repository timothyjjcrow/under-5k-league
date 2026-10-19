// The hourly backup runs scripts/backup-db.mjs and scripts/verify-backup.mjs
// from a tools clone as ggd2l-ops, which holds the R2 credentials
// (rclone.conf: Object Read & Write, delete included). The agent locks every
// tools clone to root after its npm ci (agent/tools.mjs), so the build user's
// npm can't rewrite them; that holds only while nothing they load comes from
// node_modules, which the build user's install scripts wrote first. The drill
// does run Prisma's CLI from the clone, and so never sees rclone.conf
// (systemd/units.test.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ENTRY_POINTS = ["scripts/backup-db.mjs", "scripts/verify-backup.mjs"];

/** Every module specifier a file names: static, re-export, bare and dynamic imports. */
function specifiers(text) {
  const code = text.replace(/^\s*\/\/.*$/gm, "");
  return [
    ...code.matchAll(/\b(?:import|export)\s[^;]*?\bfrom\s*["']([^"']+)["']/g),
    ...code.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
    ...code.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
  ].map((match) => match[1]);
}

test("the backup's scripts load only Node's built-ins and first-party files, never node_modules", () => {
  const seen = new Set();
  const pending = [...ENTRY_POINTS];
  while (pending.length) {
    const relative = pending.pop();
    if (seen.has(relative)) continue;
    seen.add(relative);
    const text = readFileSync(path.join(REPO, relative), "utf8");
    // A computed import() could load anything; none may hide one.
    assert.doesNotMatch(text.replace(/^\s*\/\/.*$/gm, ""), /\bimport\s*\(\s*[^"'\s)]/, `${relative}: an import() with a computed specifier`);
    assert.doesNotMatch(text, /\brequire\s*\(/, `${relative}: require()`);
    for (const specifier of specifiers(text)) {
      if (specifier.startsWith("node:")) continue;
      assert.ok(specifier.startsWith("./") || specifier.startsWith("../"), `${relative} imports ${specifier}`);
      const target = path.relative(REPO, path.resolve(REPO, path.dirname(relative), specifier));
      assert.ok(!target.split(path.sep).includes("node_modules"), `${relative} imports ${specifier}`);
      pending.push(target);
    }
  }
  // The graph the box runs: both scripts and the src/lib files they import.
  assert.ok(seen.has("src/lib/postgres-cli-env.mjs") && seen.has("src/lib/backup-receipt.mjs"), [...seen].join(", "));
});
