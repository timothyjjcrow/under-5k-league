// node --test scripts/unused-exports.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findUnusedExports, isTestFile } from "./unused-exports.mjs";

function repo(files) {
  const root = mkdtempSync(path.join(tmpdir(), "unused-exports-"));
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  return root;
}

const byName = (rows) => Object.fromEntries(rows.map((r) => [r.name, r.category]));

test("sorts exports by who imports them", () => {
  const root = repo({
    "src/lib/a.ts": [
      "export function used() { return 1; }",
      "export function dynamicUsed() { return 2; }",
      "export type TypeUsed = { n: number };",
      "export function testOnly() { return 3; }",
      "export function dead() { return 4; }",
      "export const helper = 5;",
      "export function wrapper() { return helper; }",
      "function listed() { return 6; }",
      "export { listed };",
      "// dead is mentioned here, and in a string: 'dead'",
    ].join("\n"),
    "src/lib/a.test.ts": 'import { testOnly, wrapper } from "./a";\n',
    "src/app/page.tsx": [
      'import { used } from "@/lib/a";',
      'type T = import("../lib/a").TypeUsed;',
      "export default async function Page() {",
      '  const { dynamicUsed } = await import("@/lib/a");',
      "  return used() + dynamicUsed();",
      "}",
    ].join("\n"),
    // A build folder is never read, even though it imports `dead`.
    ".next-fixture-x/server/chunk.js": 'import { dead } from "../../src/lib/a";\n',
  });
  try {
    assert.deepEqual(byName(findUnusedExports({ root })), {
      testOnly: "test-only",
      dead: "unused",
      wrapper: "test-only",
      listed: "unused",
    });
    const all = byName(findUnusedExports({ root, includeLocal: true }));
    assert.equal(all.helper, "local-only");
    assert.equal(all.used, undefined);
    assert.equal(all.dynamicUsed, undefined);
    assert.equal(all.TypeUsed, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a re-export uses the original, and is checked on its own", () => {
  const root = repo({
    "src/lib/core.ts": "export const CORE = 1;\nexport const OTHER = 2;\n",
    "src/lib/facade.ts": 'export { CORE } from "./core";\n',
    "src/lib/all.ts": 'export * from "./core";\n',
    "scripts/tool.mjs": 'import { CORE } from "../src/lib/core.ts";\n',
  });
  try {
    const rows = findUnusedExports({ root });
    // OTHER is covered by `export *` in a production file.
    assert.deepEqual(rows.map((r) => `${r.file}:${r.name}`), ["src/lib/facade.ts:CORE"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("classifies test files", () => {
  assert.equal(isTestFile("src/lib/x.test.ts"), true);
  assert.equal(isTestFile("test/integration/x.itest.ts"), true);
  assert.equal(isTestFile("e2e-mid/helpers.ts"), true);
  assert.equal(isTestFile("playwright.midseason.config.ts"), true);
  assert.equal(isTestFile("scripts/seed-fixture.ts"), false);
  assert.equal(isTestFile("src/lib/testing-helpers.ts"), false);
});
