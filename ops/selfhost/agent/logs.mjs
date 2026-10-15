// Release evidence from the box's own logs, replacing `vercel logs`:
//
//   logs <lg> <sinceMs>           rows for scheduledPasses (release-both.mjs)
//   cron-requests <lg> <sinceMs>  the quiet-window proof (design §2.5)
//
// Caddy writes one JSON object per request to /var/log/caddy/<lg>.access.json
// and rolls it into <lg>.access-<time>.json[.gz]. A row's id is the sha256 of
// its line, so the same request read twice counts once.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { BIN, PUBLIC_HOST } from "./layout.mjs";

export const CRON_PATH = "/api/cron/automation";
// What a crashed render or route looks like in `next start` output.
const NEXT_ERROR_MARKERS = [/⨯/, /\bError:/, /unhandledRejection/, /uncaughtException/, /\bFATAL\b/];

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function logFilesFor(dir, name, sinceMs) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const base = new RegExp(`^${name}\\.access(-[0-9A-Za-z.:_-]+)?\\.json(\\.gz)?$`);
  const files = [];
  for (const entry of entries) {
    if (!base.test(entry)) continue;
    const file = path.join(dir, entry);
    try {
      // A rolled file was last written when it rolled; nothing newer is in it.
      if (statSync(file).mtimeMs < sinceMs) continue;
    } catch {
      continue;
    }
    files.push(file);
  }
  return files.sort();
}

function readLines(file) {
  try {
    const raw = readFileSync(file);
    const text = file.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
    return text.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** Parse one Caddy access-log line into a request row, or null. */
export function parseCaddyLine(line, host) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  const request = entry?.request;
  if (!request || typeof request.uri !== "string" || !Number.isFinite(entry.ts)) return null;
  if (host && request.host && request.host.toLowerCase() !== host) return null;
  const status = Number(entry.status);
  const requestPath = request.uri.split("?")[0];
  return {
    id: sha256(line),
    timestamp: Math.round(entry.ts * 1000),
    responseStatusCode: Number.isFinite(status) ? status : 0,
    requestPath,
    level: status >= 500 ? "error" : "info",
  };
}

/** Every request row for the league's host since sinceMs, oldest first. */
export function caddyRows({ layout, lg, sinceMs, name = lg }) {
  const host = PUBLIC_HOST[lg] ?? null;
  const rows = new Map();
  for (const file of logFilesFor(layout.caddyLogs, name, sinceMs)) {
    for (const line of readLines(file)) {
      const row = parseCaddyLine(line, host);
      if (row && row.timestamp >= sinceMs) rows.set(row.id, row);
    }
  }
  return [...rows.values()].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
}

/** Journal lines from the league's slots that look like a Next error. */
export async function journalWarnings({ runner, lg, sinceMs }) {
  const result = await runner.run(BIN.journalctl, [
    "--no-pager",
    "--output=json",
    `--since=@${Math.floor(sinceMs / 1000)}`,
    "-u",
    `ggd2l-${lg}@a.service`,
    "-u",
    `ggd2l-${lg}@b.service`,
  ]);
  if (result.code !== 0) return [];
  const rows = [];
  for (const line of result.stdout.split("\n")) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const message = typeof entry.MESSAGE === "string" ? entry.MESSAGE : "";
    if (!NEXT_ERROR_MARKERS.some((marker) => marker.test(message))) continue;
    const timestamp = Math.floor(Number(entry.__REALTIME_TIMESTAMP) / 1000);
    if (!Number.isFinite(timestamp) || timestamp < sinceMs) continue;
    // The message itself stays on the box: it is application output.
    rows.push({ id: sha256(line), timestamp, responseStatusCode: null, requestPath: null, level: "warn" });
  }
  return rows;
}

/**
 * `logs`: the rows a release gate reads. Server errors (level "error"), every
 * scheduler request, and journal warnings (reported, not gating). Ordinary
 * page traffic is left out; the gate never reads it and an hour of polls is
 * thousands of rows.
 */
export async function leagueLogs({ layout, runner, lg, sinceMs }) {
  const requests = caddyRows({ layout, lg, sinceMs }).filter(
    (row) => row.level === "error" || row.requestPath === CRON_PATH,
  );
  const warnings = await journalWarnings({ runner, lg, sinceMs });
  return [...requests, ...warnings].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
}

export function cronRequestCount({ layout, lg, sinceMs }) {
  return caddyRows({ layout, lg, sinceMs }).filter((row) => row.requestPath === CRON_PATH).length;
}

/** 5xx answers in a window across both leagues and the apex redirect host. */
export function serverErrorCount({ layout, sinceMs }) {
  let count = 0;
  for (const lg of ["us", "eu"]) count += caddyRows({ layout, lg, sinceMs }).filter((row) => row.level === "error").length;
  count += caddyRows({ layout, lg: "apex", name: "apex", sinceMs }).filter((row) => row.level === "error").length;
  return count;
}
