#!/usr/bin/env node
// The release smoke both hosts share: CI runs it against the site its
// postgres job just built, and the box's agent (`check`) runs it against a
// candidate slot before any promote. It talks to `next start` the way Caddy
// does: plain HTTP to the slot's address, with the public Host and
// X-Forwarded-Proto: https. So it catches a build that only works on Vercel,
// above all one that judges origins by the bind address (127.0.0.1:<port>)
// instead of the league's public origin.
//
//   node smoke.mjs --base http://127.0.0.1:<port> --host <host>
//     --origin https://<host> --region us|eu --commit <40-hex sha>
//     --expect production|staging --public-dir <dir>
//
// Prints one JSON object ({ok, checks}) and exits 0 when every check passed,
// 1 otherwise (a usage error included). Node 22 standard library only: the
// agent runs it from a release clone, and nothing here may need the app.
import { readdirSync, realpathSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const USAGE =
  "usage: node smoke.mjs --base http://127.0.0.1:<port> --host <host> --origin https://<host> --region us|eu --commit <40-hex sha> --expect production|staging --public-dir <dir>";

const FLAGS = new Map([
  ["--base", "base"],
  ["--host", "host"],
  ["--origin", "origin"],
  ["--region", "region"],
  ["--commit", "commit"],
  ["--expect", "expect"],
  ["--public-dir", "publicDir"],
]);

// Never requested, by any check: both read the cached automation snapshots,
// and a snapshot cached on a candidate before it is live would be served
// stale after the promote (the agent's `check` asserts none was cached).
export const FORBIDDEN_PATHS = Object.freeze([
  "/api/sync",
  "/api/health/automation",
]);

export const REQUEST_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const STEAM_OPENID = "https://steamcommunity.com/openid/login";
const FOREIGN_ORIGIN = "https://evil.example";
const IMAGE_FILE = /\.(?:png|jpe?g|webp|avif|gif)$/i;

export class SmokeUsageError extends Error {}
class CheckFailure extends Error {}

function fail(message) {
  throw new CheckFailure(message);
}

// --- Arguments -------------------------------------------------------------

function httpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function parseBase(value) {
  const url = httpUrl(value);
  if (
    !url ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new SmokeUsageError(
      "--base must be an http(s) origin such as http://127.0.0.1:3001",
    );
  }
  return url.origin;
}

function parseHost(value) {
  const url = httpUrl(`http://${value}`);
  if (!url || url.host !== value || url.pathname !== "/" || url.search) {
    throw new SmokeUsageError(
      "--host must be a lowercase host name, with an optional port",
    );
  }
  return value;
}

function parseOrigin(value, host) {
  const url = httpUrl(value);
  if (!url || url.origin !== value) {
    throw new SmokeUsageError(
      "--origin must be an origin such as https://us.ggd2l.com, with no path or trailing slash",
    );
  }
  if (url.host !== host) {
    throw new SmokeUsageError("--origin must be on the --host host");
  }
  return value;
}

function oneOf(flag, value, pattern, expected) {
  if (!pattern.test(value)) {
    throw new SmokeUsageError(`${flag} must be ${expected}`);
  }
  return value;
}

/** Every flag is required, once; `--flag value` and `--flag=value` both work. */
export function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = equals > 0 ? arg.slice(0, equals) : arg;
    const key = FLAGS.get(flag);
    if (!key) {
      throw new SmokeUsageError(
        `unknown argument ${JSON.stringify(arg.slice(0, 60))}`,
      );
    }
    if (Object.hasOwn(values, key)) {
      throw new SmokeUsageError(`${flag} is given more than once`);
    }
    let value;
    if (equals > 0) {
      value = arg.slice(equals + 1);
    } else {
      value = argv[i + 1];
      i += 1;
      if (value === undefined || value.startsWith("--")) {
        throw new SmokeUsageError(`${flag} needs a value`);
      }
    }
    values[key] = value;
  }
  for (const [flag, key] of FLAGS) {
    if (!Object.hasOwn(values, key)) {
      throw new SmokeUsageError(`${flag} is required`);
    }
  }
  const host = parseHost(values.host);
  if (!values.publicDir) {
    throw new SmokeUsageError("--public-dir must name a directory");
  }
  return {
    base: parseBase(values.base),
    host,
    origin: parseOrigin(values.origin, host),
    region: oneOf("--region", values.region, /^(?:us|eu)$/, "us or eu"),
    commit: oneOf(
      "--commit",
      values.commit,
      /^[0-9a-f]{40}$/,
      "a full 40-character lowercase SHA",
    ),
    expect: oneOf(
      "--expect",
      values.expect,
      /^(?:production|staging)$/,
      "production or staging",
    ),
    publicDir: path.resolve(values.publicDir),
  };
}

// --- Requests --------------------------------------------------------------

// Next decodes a path before routing, so an escaped spelling counts too.
function forbidden(pathname) {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A malformed escape cannot route to either path; judge it as written.
  }
  return [pathname, decoded].some((candidate) =>
    FORBIDDEN_PATHS.some(
      (prefix) => candidate === prefix || candidate.startsWith(`${prefix}/`),
    ),
  );
}

/**
 * One request to the slot, as Caddy would forward it: the public Host,
 * X-Forwarded-Proto: https, no cookie, no compression, no redirect following.
 * Resolves with {status, headers, body}; never leaves the base origin.
 */
export function smokeRequest(
  target,
  { method = "GET", path: requestPath, headers = {}, body } = {},
) {
  const url = new URL(requestPath, target.base);
  if (url.origin !== target.base) {
    return Promise.reject(
      new CheckFailure(`refused to leave ${target.base} for ${url.origin}`),
    );
  }
  if (forbidden(url.pathname)) {
    return Promise.reject(
      new CheckFailure(`refused to request ${url.pathname}`),
    );
  }
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request(
      url,
      {
        method,
        agent: false,
        signal: AbortSignal.timeout(target.timeoutMs ?? REQUEST_TIMEOUT_MS),
        headers: {
          "user-agent": "ggd2l-smoke",
          "accept-encoding": "identity",
          ...headers,
          host: target.host,
          "x-forwarded-proto": "https",
          ...(body === undefined
            ? {}
            : { "content-length": Buffer.byteLength(body) }),
        },
      },
      (response) => {
        const chunks = [];
        let size = 0;
        let ended = false;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            response.destroy(
              new CheckFailure(`${url.pathname} answered over 16 MiB`),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          ended = true;
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
        response.on("error", reject);
        response.on("close", () => {
          if (!ended) {
            reject(new CheckFailure(`${url.pathname} closed its response early`));
          }
        });
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

// Fixed wording only: a check reports statuses, origins and paths, never a
// response body or a full redirect query.
function failureText(error, timeoutMs) {
  if (error instanceof CheckFailure) return error.message;
  if (error?.name === "TimeoutError" || error?.name === "AbortError") {
    return `request timed out after ${timeoutMs} ms`;
  }
  if (typeof error?.code === "string") return `request failed (${error.code})`;
  return `check stopped (${error?.name ?? "unknown error"})`;
}

function shown(value) {
  if (value === undefined) return "missing";
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

/** Origin and path of a Location, without its query (a sign-in state). */
function where(location) {
  try {
    const url = new URL(location);
    return `${url.origin}${url.pathname}`;
  } catch {
    return `${shown(location.split("?", 1)[0])} (not absolute)`;
  }
}

function mediaType(response) {
  return String(response.headers["content-type"] ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
}

function expectStatus(response, label, status) {
  if (response.status !== status) {
    fail(`${label} answered ${response.status}, expected ${status}`);
  }
}

function expectRedirect(response, label) {
  if (response.status < 300 || response.status > 399) {
    fail(`${label} answered ${response.status}, expected a redirect`);
  }
  const location = response.headers.location;
  if (!location) fail(`${label} redirected without a Location`);
  return location;
}

function decodeEntities(text) {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * The content of the first <meta property|name="<key>"> anywhere in the
 * document: Next streams a page's generated metadata into <body>.
 */
export function metaContent(html, key) {
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = {};
    for (const match of tag.matchAll(
      /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
    )) {
      attributes[match[1].toLowerCase()] = match[2] ?? match[3];
    }
    if (
      (attributes.property === key || attributes.name === key) &&
      attributes.content !== undefined
    ) {
      return decodeEntities(attributes.content);
    }
  }
  return null;
}

// --- Checks ----------------------------------------------------------------

async function health({ get }) {
  for (const route of ["/api/health/live", "/api/health/ready"]) {
    expectStatus(await get(route), route, 200);
  }
  return "live and ready answer 200";
}

async function releaseIdentity({ get }, options) {
  const response = await get("/api/health/release");
  expectStatus(response, "/api/health/release", 200);
  let release;
  try {
    release = JSON.parse(response.body.toString("utf8"));
  } catch {
    fail("/api/health/release did not answer JSON");
  }
  const expected = {
    commit: options.commit,
    region: options.region,
    site: options.origin,
    deployEnv: options.expect,
  };
  const wrong = Object.entries(expected)
    .filter(([field, value]) => release?.[field] !== value)
    .map(
      ([field, value]) =>
        `${field} is ${shown(release?.[field])}, expected ${shown(value)}`,
    );
  if (wrong.length > 0) fail(`/api/health/release: ${wrong.join("; ")}`);
  return `commit ${options.commit.slice(0, 12)}, region ${options.region}, site ${options.origin}, deployEnv ${options.expect}`;
}

async function pages({ get }, options) {
  const fetched = new Set();
  for (const page of ["/", "/schedule"]) {
    const response = await get(page, { accept: "text/html" });
    expectStatus(response, page, 200);
    const html = response.body.toString("utf8");
    if (!html.includes("GGD2L")) fail(`${page} does not name GGD2L`);

    const image = metaContent(html, "og:image");
    if (!image) fail(`${page} has no og:image`);
    let imageUrl;
    try {
      imageUrl = new URL(image, options.origin);
    } catch {
      fail(`${page} has an unparsable og:image`);
    }
    if (imageUrl.origin !== options.origin) {
      fail(`${page}'s og:image is on ${imageUrl.origin}, expected ${options.origin}`);
    }
    const imagePath = `${imageUrl.pathname}${imageUrl.search}`;
    if (!fetched.has(imagePath)) {
      fetched.add(imagePath);
      const picture = await get(imagePath);
      expectStatus(picture, `${page}'s og:image ${imageUrl.pathname}`, 200);
      if (mediaType(picture) !== "image/png") {
        fail(`${page}'s og:image is ${shown(mediaType(picture))}, expected image/png`);
      }
    }

    const asset = /\/_next\/static\/[^"'\\\s<>?#)]+/.exec(html)?.[0];
    if (!asset) fail(`${page} references no /_next/static/ asset`);
    if (!fetched.has(asset)) {
      fetched.add(asset);
      expectStatus(await get(asset), `${page}'s static asset ${asset}`, 200);
    }
  }
  return "/ and /schedule render with their og:image and static assets";
}

async function sameOriginGuard({ post }, options) {
  // A mutation action, so the origin guard runs (the read-only `state` poll
  // skips it). Nothing can change: there is no cookie, and the action does
  // not exist, so a signed-out request stops at "Sign in required".
  const send = (origin) =>
    post("/api/inhouse", {
      headers: {
        "content-type": "application/json",
        origin,
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ action: "smoke" }),
    });
  const own = await send(options.origin);
  if (own.status === 403) {
    fail(`POST /api/inhouse from ${options.origin} was refused as cross-origin (403)`);
  }
  if (own.status >= 500) {
    fail(`POST /api/inhouse from ${options.origin} answered ${own.status}`);
  }
  const foreign = await send(FOREIGN_ORIGIN);
  if (foreign.status !== 403) {
    fail(`POST /api/inhouse from ${FOREIGN_ORIGIN} answered ${foreign.status}, expected 403`);
  }
  return `own origin answered ${own.status}, a foreign one 403`;
}

async function logoutRedirect({ post }, options) {
  const response = await post("/api/auth/logout", {
    headers: { origin: options.origin, "sec-fetch-site": "same-origin" },
    body: "",
  });
  const location = expectRedirect(response, "POST /api/auth/logout");
  const expected = `${options.origin}/login?signedOut=1`;
  if (location !== expected) {
    fail(`POST /api/auth/logout redirects to ${where(location)}, expected ${expected}`);
  }
  return `redirects to ${expected}`;
}

async function redirectOrigin({ get }, options) {
  for (const route of ["/api/auth/steam/callback", "/recap"]) {
    const location = expectRedirect(await get(route), `GET ${route}`);
    if (!location.startsWith(`${options.origin}/`)) {
      fail(`GET ${route} redirects to ${where(location)}, expected ${options.origin}/...`);
    }
  }
  return `both redirect within ${options.origin}`;
}

async function steamReturnTo({ get }, options) {
  const location = expectRedirect(
    await get("/api/auth/steam"),
    "GET /api/auth/steam",
  );
  let steam;
  try {
    steam = new URL(location);
  } catch {
    fail(`GET /api/auth/steam redirects to ${where(location)}, expected Steam`);
  }
  if (`${steam.origin}${steam.pathname}` !== STEAM_OPENID) {
    fail(`GET /api/auth/steam redirects to ${where(location)}, expected ${STEAM_OPENID}`);
  }
  const callback = `${options.origin}/api/auth/steam/callback`;
  let returnTo;
  try {
    returnTo = new URL(steam.searchParams.get("openid.return_to") ?? "");
  } catch {
    fail("the Steam redirect has no openid.return_to");
  }
  if (`${returnTo.origin}${returnTo.pathname}` !== callback) {
    fail(`openid.return_to is ${where(returnTo.href)}, expected ${callback}`);
  }
  return `openid.return_to is ${callback}`;
}

async function imageOptimizer({ get }, options) {
  const dir = path.join(options.publicDir, "merch", "jerseys");
  let files;
  try {
    files = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && IMAGE_FILE.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    fail(`cannot read ${dir}`);
  }
  if (files.length === 0) fail(`${dir} holds no image`);
  const source = `/merch/jerseys/${files[0]}`;
  const query = new URLSearchParams({ url: source, w: "256", q: "75" });
  const response = await get(`/_next/image?${query}`, {
    accept: "image/webp,image/*,*/*;q=0.8",
  });
  expectStatus(response, `/_next/image for ${source}`, 200);
  const type = mediaType(response);
  if (!type.startsWith("image/")) {
    fail(`/_next/image for ${source} is ${shown(type)}, expected an image`);
  }
  return `${source} at w=256 as ${type}`;
}

async function overlayFiles({ get }) {
  const response = await get("/overlay/does-not-exist");
  if (response.status >= 500) {
    fail(`/overlay/does-not-exist answered ${response.status}: the overlay's files did not load`);
  }
  return `answered ${response.status}`;
}

const CHECKS = [
  ["health", health],
  ["release-identity", releaseIdentity],
  ["pages", pages],
  ["same-origin-guard", sameOriginGuard],
  ["logout-redirect", logoutRedirect],
  ["redirect-origin", redirectOrigin],
  ["steam-return-to", steamReturnTo],
  ["image-optimizer", imageOptimizer],
  ["overlay-files", overlayFiles],
];
export const CHECK_NAMES = Object.freeze(CHECKS.map(([name]) => name));

/** Runs every check, in order, even after one fails. */
export async function runSmoke(options, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const target = { base: options.base, host: options.host, timeoutMs };
  const client = {
    get: (route, headers = {}) => smokeRequest(target, { path: route, headers }),
    post: (route, { headers = {}, body = "" } = {}) =>
      smokeRequest(target, { method: "POST", path: route, headers, body }),
  };
  const checks = [];
  for (const [name, run] of CHECKS) {
    const started = Date.now();
    try {
      const detail = await run(client, options);
      checks.push({ name, ok: true, ms: Date.now() - started, detail });
    } catch (error) {
      checks.push({
        name,
        ok: false,
        ms: Date.now() - started,
        error: failureText(error, timeoutMs),
      });
    }
  }
  return { ok: checks.every((check) => check.ok), checks };
}

/** Resolves with the exit code; prints exactly one JSON object on stdout. */
export async function main(argv = process.argv.slice(2), io = process) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof SmokeUsageError)) throw error;
    io.stdout.write(
      `${JSON.stringify({ ok: false, error: "usage", message: error.message }, null, 2)}\n`,
    );
    io.stderr.write(`${USAGE}\n`);
    return 1;
  }
  const result = await runSmoke(options);
  io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.ok ? 0 : 1;
}

// realpath: the agent runs this through a slot symlink, and Node reports the
// resolved path as import.meta.url. A mismatch here would exit 0 having
// checked nothing.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: "internal" })}\n`,
      );
      process.exitCode = 1;
    },
  );
}
