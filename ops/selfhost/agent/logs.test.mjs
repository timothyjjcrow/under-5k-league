import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { scheduledPasses } from "../../../scripts/release-both.mjs";
import { T0, makeBox } from "./harness.test.mjs";
import { caddyRows, cronRequestCount, leagueLogs, parseCaddyLine, serverErrorCount } from "./logs.mjs";

// The shape Caddy v2 writes with `format json` (http.log.access).
function caddyLine(atMs, uri, status, host = "us.ggd2l.com") {
  return JSON.stringify({
    level: status >= 500 ? "error" : "info",
    ts: atMs / 1000,
    logger: "http.log.access.log0",
    msg: "handled request",
    request: {
      remote_ip: "127.0.0.1",
      remote_port: "51234",
      client_ip: "198.51.100.23",
      proto: "HTTP/1.1",
      method: uri.startsWith("/api/cron") ? "GET" : "GET",
      host,
      uri,
      headers: { "User-Agent": ["ggd2l-automation-scheduler"], Authorization: ["REDACTED"] },
    },
    bytes_read: 0,
    user_id: "",
    duration: 0.0123,
    size: 42,
    status,
    resp_headers: { "Content-Type": ["application/json"] },
  });
}

function fixture() {
  const box = makeBox();
  const dir = box.layout.caddyLogs;
  const rolled = [
    caddyLine(T0 - 3_600_000, "/api/cron/automation", 200),
    caddyLine(T0 - 120_000, "/api/cron/automation", 200),
  ];
  writeFileSync(path.join(dir, "us.access-2026-10-16T14-59-00.000.json.gz"), gzipSync(`${rolled.join("\n")}\n`));
  utimesSync(path.join(dir, "us.access-2026-10-16T14-59-00.000.json.gz"), (T0 - 60_000) / 1000, (T0 - 60_000) / 1000);
  const current = [
    caddyLine(T0 + 1_000, "/api/cron/automation", 200),
    caddyLine(T0 + 2_000, "/inhouse?imin=1", 200),
    caddyLine(T0 + 3_000, "/api/sync", 304),
    "not json at all",
    caddyLine(T0 + 61_000, "/api/cron/automation?attempt=2", 200),
    caddyLine(T0 + 70_000, "/schedule", 502),
    caddyLine(T0 + 80_000, "/api/cron/automation", 200, "eu.ggd2l.com"),
  ];
  writeFileSync(path.join(dir, "us.access.json"), `${current.join("\n")}\n`);
  writeFileSync(path.join(dir, "eu.access.json"), `${caddyLine(T0 + 5_000, "/api/cron/automation", 503, "eu.ggd2l.com")}\n`);
  writeFileSync(path.join(dir, "apex.access.json"), `${caddyLine(T0 + 6_000, "/", 302, "ggd2l.com")}\n`);
  // A live log was last written after its newest line.
  for (const name of ["us.access.json", "eu.access.json", "apex.access.json"])
    utimesSync(path.join(dir, name), (T0 + 200_000) / 1000, (T0 + 200_000) / 1000);
  return { box, current };
}

test("a Caddy access line becomes a release-gate row", () => {
  const line = caddyLine(T0, "/api/cron/automation?x=1", 200);
  assert.deepEqual(parseCaddyLine(line, "us.ggd2l.com"), {
    id: createHash("sha256").update(line).digest("hex"),
    timestamp: T0,
    responseStatusCode: 200,
    requestPath: "/api/cron/automation",
    level: "info",
  });
  assert.equal(parseCaddyLine(caddyLine(T0, "/", 500), "us.ggd2l.com").level, "error");
  assert.equal(parseCaddyLine(line, "eu.ggd2l.com"), null);
  assert.equal(parseCaddyLine("{", "us.ggd2l.com"), null);
});

test("rows come from the current and rolled (gzipped) logs, since the given time", () => {
  const { box } = fixture();
  const all = caddyRows({ layout: box.layout, lg: "us", sinceMs: T0 - 600_000 });
  assert.deepEqual(all.map((row) => row.requestPath), [
    "/api/cron/automation",
    "/api/cron/automation",
    "/inhouse",
    "/api/sync",
    "/api/cron/automation",
    "/schedule",
  ]);
  // A rolled file last written before `since` is not opened at all.
  assert.equal(caddyRows({ layout: box.layout, lg: "us", sinceMs: T0 }).length, 5);
});

test("cron-requests counts scheduler requests for the league's host only", () => {
  const { box } = fixture();
  assert.equal(cronRequestCount({ layout: box.layout, lg: "us", sinceMs: T0 }), 2);
  assert.equal(cronRequestCount({ layout: box.layout, lg: "us", sinceMs: T0 - 600_000 }), 3);
  assert.equal(cronRequestCount({ layout: box.layout, lg: "us", sinceMs: T0 + 100_000 }), 0);
  assert.equal(cronRequestCount({ layout: box.layout, lg: "eu", sinceMs: T0 }), 1);
});

test("logs returns scheduler rows, 5xx rows as errors and journal warnings; release-both reads them", async () => {
  const { box } = fixture();
  const journal = [
    JSON.stringify({ __REALTIME_TIMESTAMP: String((T0 + 65_000) * 1000), MESSAGE: " ⨯ Error: boom at render" }),
    JSON.stringify({ __REALTIME_TIMESTAMP: String((T0 + 66_000) * 1000), MESSAGE: "GET /schedule 200" }),
  ].join("\n");
  box.on((command) => (command.endsWith("/journalctl") ? { stdout: `${journal}\n` } : undefined));
  const rows = await leagueLogs({ layout: box.layout, runner: box.ctx.runner, lg: "us", sinceMs: T0 });
  assert.deepEqual(rows.map((row) => [row.requestPath, row.responseStatusCode, row.level]), [
    ["/api/cron/automation", 200, "info"],
    ["/api/cron/automation", 200, "info"],
    [null, null, "warn"],
    ["/schedule", 502, "error"],
  ]);
  for (const row of rows) assert.deepEqual(Object.keys(row).sort(), ["id", "level", "requestPath", "responseStatusCode", "timestamp"]);
  const journalCall = box.calls.find((call) => call.command.endsWith("/journalctl"));
  assert.ok(journalCall.args.includes(`--since=@${T0 / 1000}`));
  // The 502 fails the release gate; without it the two passes 60 s apart pass.
  assert.throws(() => scheduledPasses(rows, T0), /Fresh runtime errors/);
  const clean = rows.filter((row) => row.level !== "error");
  assert.deepEqual(scheduledPasses(clean, T0), [new Date(T0 + 1_000).toISOString(), new Date(T0 + 61_000).toISOString()]);
});

test("status counts 5xx across both leagues and the apex", () => {
  const { box } = fixture();
  assert.equal(serverErrorCount({ layout: box.layout, sinceMs: T0 - 600_000 }), 2);
});
