import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { MAINTENANCE_TEXT, caddyConfigSha256, caddyValidateCommand, renderAllow, renderMode } from "./caddy-modes.mjs";
import { makeBox } from "./harness.test.mjs";

// The reference copies install-kit.sh installs (WP-E2), when this tree has them.
const reference = (mode) => fileURLToPath(new URL(`../caddy/mode-${mode}.caddy`, import.meta.url));
const MODES = ["maintenance", "allowlist", "proxy"];
const haveReferences = MODES.every((mode) => existsSync(reference(mode)));

/** A Caddy block without comments or blank lines: what Caddy actually reads. */
const directives = (text) =>
  text
    .split("\n")
    .filter((line) => line.trim() && !line.trim().startsWith("#"))
    .join("\n");

test("maintenance answers every method with 503 and asks not to be indexed", () => {
  assert.equal(
    directives(renderMode("maintenance")),
    [
      "header Retry-After 600",
      "header Cache-Control no-store",
      'header X-Robots-Tag "noindex, nofollow"',
      "@write not method GET HEAD",
      `respond @write "${MAINTENANCE_TEXT}" 503`,
      "root * /srv/ggd2l/www",
      "rewrite * /maintenance.html",
      "file_server {",
      "\tstatus 503",
      "}",
    ].join("\n"),
  );
  // The allowlist's fallback for everyone else is the same block, one level in.
  const fallback = renderMode("allowlist", { port: 3001 }).split("handle {\n")[1];
  assert.equal(
    directives(fallback).replace(/\n}$/, ""),
    directives(renderMode("maintenance"))
      .split("\n")
      .map((line) => `\t${line}`)
      .join("\n"),
  );
});

test(
  "every mode the agent writes is the reference install-kit.sh installs",
  { skip: haveReferences ? false : "ops/selfhost/caddy is not in this tree (WP-E2)" },
  () => {
    for (const mode of MODES) {
      const expected = directives(readFileSync(reference(mode), "utf8")).replaceAll("__PORT__", "3011");
      assert.equal(directives(renderMode(mode, { port: 3011 })), expected, mode);
    }
  },
);

test("caddy validate runs as caddy with its own HOME, never as root", () => {
  assert.deepEqual(caddyValidateCommand("/etc/caddy/Caddyfile"), [
    "/usr/sbin/runuser",
    ["-u", "caddy", "--", "/usr/bin/env", "HOME=/var/lib/caddy", "/usr/bin/caddy", "validate", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"],
  ]);
});

test("the Caddy config hash covers the Caddyfile, both mode files and allow.caddy", () => {
  const box = makeBox();
  const { layout } = box;
  writeFileSync(layout.modeFile("us"), renderMode("proxy", { port: 3001 }));
  writeFileSync(layout.modeFile("eu"), renderMode("maintenance"));
  writeFileSync(layout.allowFile, renderAllow(["203.0.113.7"]));
  const first = caddyConfigSha256(layout);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(caddyConfigSha256(layout), first, "stable");

  const seen = new Set([first]);
  const change = (file, text) => {
    const before = readFileSync(file, "utf8");
    writeFileSync(file, text);
    const hash = caddyConfigSha256(layout);
    assert.ok(!seen.has(hash), `${file} changed but the hash did not`);
    seen.add(hash);
    writeFileSync(file, before);
    assert.equal(caddyConfigSha256(layout), first);
  };
  change(layout.caddyfile, "# another Caddyfile\n");
  change(layout.modeFile("us"), renderMode("proxy", { port: 3002 }));
  change(layout.modeFile("eu"), renderMode("allowlist", { port: 3011 }));
  change(layout.allowFile, renderAllow(["203.0.113.8"]));

  // The two mode files swapped is a different configuration.
  const us = readFileSync(layout.modeFile("us"));
  const eu = readFileSync(layout.modeFile("eu"));
  writeFileSync(layout.modeFile("us"), eu);
  writeFileSync(layout.modeFile("eu"), us);
  assert.notEqual(caddyConfigSha256(layout), first);
  writeFileSync(layout.modeFile("us"), us);
  writeFileSync(layout.modeFile("eu"), eu);

  // Text moved across the boundary between two files is a different
  // configuration even though the concatenation is the same.
  writeFileSync(layout.modeFile("us"), `${us}# tail\n`);
  writeFileSync(layout.modeFile("eu"), eu);
  const before = caddyConfigSha256(layout);
  writeFileSync(layout.modeFile("us"), us);
  writeFileSync(layout.modeFile("eu"), Buffer.concat([Buffer.from("# tail\n"), eu]));
  assert.notEqual(caddyConfigSha256(layout), before);
  writeFileSync(layout.modeFile("eu"), eu);

  rmSync(layout.allowFile);
  assert.match(caddyConfigSha256(layout), /^[0-9a-f]{64}$/, "no allow file is still a configuration");
  assert.notEqual(caddyConfigSha256(layout), first);
  rmSync(layout.caddyfile);
  assert.equal(caddyConfigSha256(layout), null, "no Caddyfile, no configuration");
});
