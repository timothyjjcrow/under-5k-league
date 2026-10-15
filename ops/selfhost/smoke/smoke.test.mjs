import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHECK_NAMES,
  FORBIDDEN_PATHS,
  SmokeUsageError,
  USAGE,
  metaContent,
  parseArgs,
  runSmoke,
  smokeRequest,
} from "./smoke.mjs";

const SCRIPT = fileURLToPath(new URL("./smoke.mjs", import.meta.url));
const CI_WORKFLOW = new URL("../../../.github/workflows/ci.yml", import.meta.url);
const SHA = "0123456789abcdef0123456789abcdef01234567";
const HOST = "ci.ld2l.invalid";
const ORIGIN = `https://${HOST}`;
// What `next start` reports as its own origin behind Caddy when nothing pins
// the canonical one: the bind address, with the forwarded protocol.
const BIND = "https://127.0.0.1:3100";
const FIRST_JERSEY = "/merch/jerseys/alpha-front.png";
const HANG = Symbol("hang");

// --- A fake `next start` ---------------------------------------------------

const json = (status, value) => ({
  status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
});
const html = (status, body) => ({
  status,
  headers: { "content-type": "text/html; charset=utf-8" },
  body,
});
const redirect = (status, location) => ({
  status,
  headers: { location },
  body: "",
});
const file = (type, body) => ({ status: 200, headers: { "content-type": type }, body });

// Next streams generated metadata into <body>; og:image:width must not be
// mistaken for og:image.
function page(title, { league = "GGD2L", ogImage = `${ORIGIN}/opengraph-image.png` } = {}) {
  const image = ogImage === null ? "" : `<meta property="og:image" content="${ogImage}"/>`;
  return `<!DOCTYPE html><html><head><title>${title}</title><link rel="stylesheet" href="/_next/static/css/app.css" data-precedence="next"/></head><body><header>${league}</header><main>${title}</main><meta property="og:image:width" content="1200"/>${image}<script src="/_next/static/chunks/main.js" async=""></script></body></html>`;
}

function steamLogin(returnTo) {
  const query = new URLSearchParams({
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "checkid_setup",
    "openid.return_to": returnTo,
    "openid.realm": ORIGIN,
  });
  return `https://steamcommunity.com/openid/login?${query}`;
}

const sameOrigin = (req) =>
  req.headers.origin === ORIGIN && req.headers["sec-fetch-site"] === "same-origin";

function release(patch = {}) {
  return () =>
    json(200, { ok: true, region: "us", commit: SHA, site: ORIGIN, deployEnv: "staging", ...patch });
}

/** A site that does everything right, as the box should serve it. */
function healthyApp() {
  return {
    "GET /api/health/live": () => json(200, { ok: true, status: "live" }),
    "GET /api/health/ready": () => json(200, { ok: true, status: "ready" }),
    "GET /api/health/release": release(),
    "GET /": () => html(200, page("Home")),
    "GET /schedule": () => html(200, page("Schedule")),
    "GET /opengraph-image.png": () => file("image/png", Buffer.from("89504e470d0a1a0a", "hex")),
    "GET /_next/static/css/app.css": () => file("text/css; charset=utf-8", "body{}"),
    "POST /api/inhouse": (req) =>
      sameOrigin(req)
        ? json(401, { error: "Sign in required" })
        : json(403, { error: "Same-origin request required" }),
    "POST /api/auth/logout": (req) =>
      sameOrigin(req)
        ? redirect(303, `${ORIGIN}/login?signedOut=1`)
        : json(403, { error: "Same-origin request required" }),
    "GET /api/auth/steam/callback": () => redirect(307, `${ORIGIN}/login?error=steam`),
    "GET /recap": () => redirect(307, `${ORIGIN}/seasons/s1`),
    "GET /api/auth/steam": () =>
      redirect(307, steamLogin(`${ORIGIN}/api/auth/steam/callback?state=one-shot`)),
    "GET /_next/image": (_req, url) =>
      url.searchParams.get("url") === FIRST_JERSEY &&
      url.searchParams.get("w") === "256" &&
      url.searchParams.get("q") === "75"
        ? file("image/webp", "RIFF")
        : json(400, { error: "wrong image" }),
    "GET /overlay/does-not-exist": () => html(200, "<!DOCTYPE html><title>overlay</title>"),
  };
}

async function serve(t, routes = healthyApp()) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url, "http://fake.invalid");
      seen.push({
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const handler = routes[`${req.method} ${url.pathname}`];
      const reply = handler ? handler(req, url) : json(404, { error: "not found" });
      if (reply === HANG) return;
      res.writeHead(reply.status, reply.headers);
      res.end(reply.body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return { base: `http://127.0.0.1:${server.address().port}`, seen };
}

function publicDir(t, { jerseys = ["zulu-back.png", "alpha-front.png", "aaa-notes.txt"] } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "ggd2l-smoke-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (jerseys) {
    const folder = path.join(dir, "merch", "jerseys");
    mkdirSync(folder, { recursive: true });
    // A directory sorts first and is no image.
    mkdirSync(path.join(folder, "aaa-folder.png"));
    for (const name of jerseys) writeFileSync(path.join(folder, name), "x");
  }
  return dir;
}

const optionsFor = (base, dir) => ({
  base,
  host: HOST,
  origin: ORIGIN,
  region: "us",
  commit: SHA,
  expect: "staging",
  publicDir: dir,
});

async function smokeAgainst(t, patch, { dir } = {}) {
  const routes = healthyApp();
  patch?.(routes);
  const { base, seen } = await serve(t, routes);
  const result = await runSmoke(optionsFor(base, dir ?? publicDir(t)));
  return { result, seen };
}

const failed = (result) => result.checks.filter((check) => !check.ok).map((check) => check.name);

// --- The run ---------------------------------------------------------------

test("a healthy site passes every check, in order", async (t) => {
  const { result } = await smokeAgainst(t);
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.deepEqual(CHECK_NAMES, [
    "health",
    "release-identity",
    "pages",
    "same-origin-guard",
    "logout-redirect",
    "redirect-origin",
    "steam-return-to",
    "image-optimizer",
    "overlay-files",
  ]);
  assert.deepEqual(result.checks.map((check) => check.name), CHECK_NAMES);
  for (const check of result.checks) {
    assert.equal(check.ok, true);
    assert.equal(typeof check.detail, "string");
    assert.equal(typeof check.ms, "number");
  }
});

test("every request goes to the slot as Caddy forwards it, and never to /api/sync or the automation probe", async (t) => {
  const { seen } = await smokeAgainst(t);
  assert.deepEqual(
    seen.map((request) => `${request.method} ${request.path}`),
    [
      "GET /api/health/live",
      "GET /api/health/ready",
      "GET /api/health/release",
      "GET /",
      "GET /opengraph-image.png",
      "GET /_next/static/css/app.css",
      "GET /schedule",
      "POST /api/inhouse",
      "POST /api/inhouse",
      "POST /api/auth/logout",
      "GET /api/auth/steam/callback",
      "GET /recap",
      "GET /api/auth/steam",
      `GET /_next/image?url=${encodeURIComponent(FIRST_JERSEY)}&w=256&q=75`,
      "GET /overlay/does-not-exist",
    ],
  );
  for (const request of seen) {
    assert.equal(request.headers.host, HOST);
    assert.equal(request.headers["x-forwarded-proto"], "https");
    assert.equal(request.headers.cookie, undefined);
    for (const prefix of FORBIDDEN_PATHS) assert.ok(!request.path.startsWith(prefix));
  }
  // The guard probe: a JSON mutation from the league's origin, then the same
  // request from a foreign one.
  const posts = seen.filter((request) => request.path === "/api/inhouse");
  assert.deepEqual(
    posts.map((request) => [request.headers.origin, request.headers["sec-fetch-site"], request.headers["content-type"], request.body]),
    [
      [ORIGIN, "same-origin", "application/json", '{"action":"smoke"}'],
      ["https://evil.example", "same-origin", "application/json", '{"action":"smoke"}'],
    ],
  );
  const logout = seen.find((request) => request.path === "/api/auth/logout");
  assert.equal(logout.headers.origin, ORIGIN);
  assert.equal(logout.headers["sec-fetch-site"], "same-origin");
});

test("the request helper refuses the forbidden paths and other origins without sending anything", async (t) => {
  const { base, seen } = await serve(t);
  const target = { base, host: HOST };
  for (const route of [
    "/api/sync",
    "/api/sync/",
    "/api/sync?cursor=1",
    "/api/health/automation",
    "/api/health/automation?probe=1",
    "/api/health/./automation",
    "/api/%73ync",
    "/api/health%2Fautomation",
  ]) {
    await assert.rejects(smokeRequest(target, { path: route }), /refused to request \/api\//);
  }
  for (const route of ["//evil.example/x", "https://evil.example/", "http://127.0.0.1:1/"]) {
    await assert.rejects(smokeRequest(target, { path: route }), /refused to leave/);
  }
  assert.deepEqual(seen, []);
  // A neighbour of a forbidden path is an ordinary request.
  assert.equal((await smokeRequest(target, { path: "/api/syncs" })).status, 404);
});

// --- Each check fails on its own -------------------------------------------

const FAILURES = [
  ["health", "live answers 500", (r) => { r["GET /api/health/live"] = () => json(500, {}); }, /\/api\/health\/live answered 500, expected 200/],
  ["health", "ready answers 503 without its database", (r) => { r["GET /api/health/ready"] = () => json(503, {}); }, /ready answered 503/],
  ["release-identity", "another commit is serving", (r) => { r["GET /api/health/release"] = release({ commit: "f".repeat(40) }); }, /commit is "f{40}", expected "0123/],
  ["release-identity", "a build without site and deployEnv", (r) => { r["GET /api/health/release"] = release({ site: undefined, deployEnv: undefined }); }, /site is missing, expected "https:\/\/ci\.ld2l\.invalid"; deployEnv is missing, expected "staging"/],
  ["release-identity", "a production env answers a staging check", (r) => { r["GET /api/health/release"] = release({ deployEnv: "production" }); }, /deployEnv is "production", expected "staging"/],
  ["release-identity", "an undeclared marker", (r) => { r["GET /api/health/release"] = release({ deployEnv: null }); }, /deployEnv is null/],
  ["release-identity", "the other league's build", (r) => { r["GET /api/health/release"] = release({ region: "eu" }); }, /region is "eu", expected "us"/],
  ["release-identity", "a build baked with the old origin", (r) => { r["GET /api/health/release"] = release({ site: "https://ggd2l.vercel.app" }); }, /site is "https:\/\/ggd2l\.vercel\.app"/],
  ["release-identity", "an answer that is not JSON", (r) => { r["GET /api/health/release"] = () => html(200, "<html>"); }, /did not answer JSON/],
  ["pages", "Home answers 500", (r) => { r["GET /"] = () => html(500, "boom"); }, /^\/ answered 500, expected 200$/],
  ["pages", "/schedule does not name the league", (r) => { r["GET /schedule"] = () => html(200, page("Schedule", { league: "LD2L" })); }, /\/schedule does not name GGD2L/],
  ["pages", "/schedule has no og:image", (r) => { r["GET /schedule"] = () => html(200, page("Schedule", { ogImage: null })); }, /\/schedule has no og:image/],
  ["pages", "og:image was baked with the bind address", (r) => { r["GET /"] = () => html(200, page("Home", { ogImage: `${BIND}/opengraph-image.png` })); }, /og:image is on https:\/\/127\.0\.0\.1:3100/],
  ["pages", "the og:image file is missing", (r) => { delete r["GET /opengraph-image.png"]; }, /og:image \/opengraph-image\.png answered 404/],
  ["pages", "og:image is not a PNG", (r) => { r["GET /opengraph-image.png"] = () => html(200, "<html>"); }, /og:image is "text\/html", expected image\/png/],
  ["pages", "a static chunk is missing", (r) => { delete r["GET /_next/static/css/app.css"]; }, /static asset \/_next\/static\/css\/app\.css answered 404/],
  ["pages", "a page references no static asset", (r) => { r["GET /schedule"] = () => html(200, `<html><body>GGD2L<meta property="og:image" content="${ORIGIN}/opengraph-image.png"/></body></html>`); }, /\/schedule references no \/_next\/static\/ asset/],
  ["same-origin-guard", "the league's own origin is refused (the bind-address blocker)", (r) => { r["POST /api/inhouse"] = () => json(403, {}); }, /from https:\/\/ci\.ld2l\.invalid was refused as cross-origin \(403\)/],
  ["same-origin-guard", "a foreign origin is accepted", (r) => { r["POST /api/inhouse"] = () => json(401, {}); }, /from https:\/\/evil\.example answered 401, expected 403/],
  ["same-origin-guard", "the route crashes", (r) => { r["POST /api/inhouse"] = (req) => (sameOrigin(req) ? json(500, {}) : json(403, {})); }, /answered 500/],
  ["logout-redirect", "logout is refused as cross-origin", (r) => { r["POST /api/auth/logout"] = () => json(403, {}); }, /POST \/api\/auth\/logout answered 403, expected a redirect/],
  ["logout-redirect", "logout redirects to the bind address", (r) => { r["POST /api/auth/logout"] = () => redirect(303, `${BIND}/login?signedOut=1`); }, /redirects to https:\/\/127\.0\.0\.1:3100\/login, expected https:\/\/ci\.ld2l\.invalid\/login\?signedOut=1/],
  ["logout-redirect", "logout loses the signed-out notice", (r) => { r["POST /api/auth/logout"] = () => redirect(303, `${ORIGIN}/login`); }, /expected https:\/\/ci\.ld2l\.invalid\/login\?signedOut=1/],
  ["logout-redirect", "a redirect without a Location", (r) => { r["POST /api/auth/logout"] = () => ({ status: 303, headers: {}, body: "" }); }, /without a Location/],
  ["redirect-origin", "the Steam callback redirects to the bind address", (r) => { r["GET /api/auth/steam/callback"] = () => redirect(307, `${BIND}/login?error=steam`); }, /GET \/api\/auth\/steam\/callback redirects to https:\/\/127\.0\.0\.1:3100\/login, expected/],
  ["redirect-origin", "recap redirects to the bind address", (r) => { r["GET /recap"] = () => redirect(307, `${BIND}/seasons/s1`); }, /GET \/recap redirects to https:\/\/127\.0\.0\.1:3100\/seasons\/s1/],
  ["redirect-origin", "recap answers a relative Location", (r) => { r["GET /recap"] = () => redirect(307, "/seasons/s1"); }, /"\/seasons\/s1" \(not absolute\)/],
  ["redirect-origin", "recap does not redirect", (r) => { r["GET /recap"] = () => html(404, "missing"); }, /GET \/recap answered 404, expected a redirect/],
  ["steam-return-to", "openid.return_to names the bind address", (r) => { r["GET /api/auth/steam"] = () => redirect(307, steamLogin(`${BIND}/api/auth/steam/callback?state=x`)); }, /openid\.return_to is https:\/\/127\.0\.0\.1:3100\/api\/auth\/steam\/callback, expected https:\/\/ci\.ld2l\.invalid\/api\/auth\/steam\/callback/],
  ["steam-return-to", "openid.return_to names another path", (r) => { r["GET /api/auth/steam"] = () => redirect(307, steamLogin(`${ORIGIN}/api/auth/steam/callbackx`)); }, /openid\.return_to is https:\/\/ci\.ld2l\.invalid\/api\/auth\/steam\/callbackx/],
  ["steam-return-to", "the redirect is not to Steam", (r) => { r["GET /api/auth/steam"] = () => redirect(307, `${ORIGIN}/login?error=steam`); }, /redirects to https:\/\/ci\.ld2l\.invalid\/login, expected https:\/\/steamcommunity\.com\/openid\/login/],
  ["steam-return-to", "the Steam redirect has no openid.return_to", (r) => { r["GET /api/auth/steam"] = () => redirect(307, "https://steamcommunity.com/openid/login?openid.mode=checkid_setup"); }, /has no openid\.return_to/],
  ["image-optimizer", "sharp is missing", (r) => { r["GET /_next/image"] = () => html(500, "Internal Server Error"); }, /\/_next\/image for \/merch\/jerseys\/alpha-front\.png answered 500, expected 200/],
  ["image-optimizer", "the optimizer answers something other than an image", (r) => { r["GET /_next/image"] = () => file("text/plain", "nope"); }, /is "text\/plain", expected an image/],
  ["overlay-files", "the overlay's files did not load", (r) => { r["GET /overlay/does-not-exist"] = () => html(503, "unavailable"); }, /answered 503: the overlay's files did not load/],
  ["overlay-files", "the overlay route crashes", (r) => { r["GET /overlay/does-not-exist"] = () => html(500, "boom"); }, /answered 500/],
];

for (const [check, why, patch, message] of FAILURES) {
  test(`${check} fails, alone, when ${why}`, async (t) => {
    const { result } = await smokeAgainst(t, patch);
    assert.equal(result.ok, false);
    assert.deepEqual(failed(result), [check], JSON.stringify(result, null, 2));
    const failure = result.checks.find((entry) => entry.name === check);
    assert.match(failure.error, message);
    assert.equal(failure.detail, undefined);
  });
}

test("image-optimizer fails when the public dir has no jersey to resize", async (t) => {
  for (const dir of [publicDir(t, { jerseys: ["readme.txt"] }), publicDir(t, { jerseys: null })]) {
    const { result, seen } = await smokeAgainst(t, undefined, { dir });
    assert.deepEqual(failed(result), ["image-optimizer"]);
    assert.match(result.checks[7].error, /holds no image|cannot read/);
    assert.ok(!seen.some((request) => request.path.startsWith("/_next/image")));
  }
});

test("the statuses the checks allow still pass", async (t) => {
  const { result } = await smokeAgainst(t, (r) => {
    r["GET /overlay/does-not-exist"] = () => html(404, "not found");
    r["POST /api/inhouse"] = (req) => (sameOrigin(req) ? json(429, {}) : json(403, {}));
    r["POST /api/auth/logout"] = (req) => (sameOrigin(req) ? redirect(302, `${ORIGIN}/login?signedOut=1`) : json(403, {}));
    r["GET /recap"] = () => redirect(308, `${ORIGIN}/`);
    r["GET /_next/image"] = (_req, url) => (url.searchParams.get("url") === FIRST_JERSEY ? file("image/png", "png") : json(400, {}));
  });
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
});

test("a slot that is down fails every check with the connection error", async (t) => {
  const { base } = await serve(t);
  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const port = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  assert.notEqual(`http://127.0.0.1:${port}`, base);
  const result = await runSmoke(optionsFor(`http://127.0.0.1:${port}`, publicDir(t)));
  assert.equal(result.ok, false);
  assert.deepEqual(failed(result), CHECK_NAMES);
  for (const check of result.checks) assert.equal(check.error, "request failed (ECONNREFUSED)");
});

test("a request that never answers times out instead of hanging the release", async (t) => {
  const routes = healthyApp();
  routes["GET /api/health/ready"] = () => HANG;
  const { base } = await serve(t, routes);
  const result = await runSmoke(optionsFor(base, publicDir(t)), { timeoutMs: 200 });
  assert.deepEqual(failed(result), ["health"]);
  assert.equal(result.checks[0].error, "request timed out after 200 ms");
});

test("og:image is read wherever Next puts it, in any attribute order", () => {
  assert.equal(metaContent('<head><meta property="og:image" content="https://a.example/x.png"/></head>', "og:image"), "https://a.example/x.png");
  assert.equal(metaContent("<body><meta content='/y.png?a=1&amp;b=2' property='og:image'></body>", "og:image"), "/y.png?a=1&b=2");
  assert.equal(metaContent('<meta property="og:image:width" content="1200"/><meta property="og:image" content="/z.png"/>', "og:image"), "/z.png");
  assert.equal(metaContent('<meta name="og:image" content="/n.png">', "og:image"), "/n.png");
  assert.equal(metaContent('<meta property="og:title" content="GGD2L"/>', "og:image"), null);
  assert.equal(metaContent('<meta property="og:image"/>', "og:image"), null);
});

// --- Arguments -------------------------------------------------------------

const ARGS = [
  "--base", "http://127.0.0.1:3001",
  "--host", "us.ggd2l.com",
  "--origin", "https://us.ggd2l.com",
  "--region", "us",
  "--commit", SHA,
  "--expect", "production",
  "--public-dir", "public",
];

function withArg(flag, value) {
  const args = [...ARGS];
  args[args.indexOf(flag) + 1] = value;
  return args;
}

function withoutArg(flag) {
  const args = [...ARGS];
  args.splice(args.indexOf(flag), 2);
  return args;
}

test("parseArgs reads the exact CLI, in either flag form", () => {
  const expected = {
    base: "http://127.0.0.1:3001",
    host: "us.ggd2l.com",
    origin: "https://us.ggd2l.com",
    region: "us",
    commit: SHA,
    expect: "production",
    publicDir: path.resolve("public"),
  };
  assert.deepEqual(parseArgs(ARGS), expected);
  const joined = [];
  for (let i = 0; i < ARGS.length; i += 2) joined.push(`${ARGS[i]}=${ARGS[i + 1]}`);
  assert.deepEqual(parseArgs(joined.reverse()), expected);
  // A trailing slash on the base is the same origin.
  assert.equal(parseArgs(withArg("--base", "http://127.0.0.1:3001/")).base, "http://127.0.0.1:3001");
  // The on-demand staging slot: a plain-http origin with a port.
  const staging = parseArgs([
    ...withArg("--host", "localhost:3190").slice(0, 4),
    "--origin", "http://localhost:3190",
    ...ARGS.slice(6),
  ]);
  assert.equal(staging.origin, "http://localhost:3190");
  assert.equal(parseArgs(withArg("--expect", "staging")).expect, "staging");
  assert.equal(parseArgs(withArg("--region", "eu")).region, "eu");
});

test("parseArgs refuses anything else", () => {
  const refused = [
    [[], /--base is required/],
    [withoutArg("--public-dir"), /--public-dir is required/],
    [withoutArg("--expect"), /--expect is required/],
    [[...ARGS, "--region", "eu"], /--region is given more than once/],
    [[...ARGS, "--force"], /unknown argument "--force"/],
    [[...ARGS, "extra"], /unknown argument "extra"/],
    [[...ARGS.slice(0, -1)], /--public-dir needs a value/],
    [["--base", "--host", ...ARGS.slice(2)], /--base needs a value/],
    [withArg("--base", "127.0.0.1:3001"), /--base must be/],
    [withArg("--base", "ftp://127.0.0.1:3001"), /--base must be/],
    [withArg("--base", "http://127.0.0.1:3001/api"), /--base must be/],
    [withArg("--base", "http://127.0.0.1:3001?x=1"), /--base must be/],
    [withArg("--base", "http://user:pw@127.0.0.1:3001"), /--base must be/],
    [withArg("--host", "US.ggd2l.com"), /--host must be/],
    [withArg("--host", "us.ggd2l.com/x"), /--host must be/],
    [withArg("--host", "user@us.ggd2l.com"), /--host must be/],
    [withArg("--host", ""), /--host must be/],
    [withArg("--origin", "https://us.ggd2l.com/"), /--origin must be an origin/],
    [withArg("--origin", "https://us.ggd2l.com/login"), /--origin must be an origin/],
    [withArg("--origin", "us.ggd2l.com"), /--origin must be an origin/],
    [withArg("--origin", "https://eu.ggd2l.com"), /--origin must be on the --host host/],
    [withArg("--region", "US"), /--region must be us or eu/],
    [withArg("--commit", SHA.toUpperCase()), /--commit must be a full 40-character/],
    [withArg("--commit", SHA.slice(1)), /--commit must be a full 40-character/],
    [withArg("--expect", "preview"), /--expect must be production or staging/],
    [withArg("--public-dir", ""), /--public-dir must name a directory/],
  ];
  for (const [argv, message] of refused) {
    assert.throws(() => parseArgs(argv), (error) => error instanceof SmokeUsageError && message.test(error.message), argv.join(" "));
  }
});

// --- The command line ------------------------------------------------------

function runCli(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function cliArgs(base, dir) {
  return ["--base", base, "--host", HOST, "--origin", ORIGIN, "--region", "us", "--commit", SHA, "--expect", "staging", "--public-dir", dir];
}

test("the CLI prints one JSON object and exits 0 only when every check passed", async (t) => {
  const dir = publicDir(t);
  const healthy = await serve(t);
  const pass = await runCli(SCRIPT, cliArgs(healthy.base, dir));
  assert.equal(pass.code, 0, pass.stdout + pass.stderr);
  const passed = JSON.parse(pass.stdout);
  assert.equal(passed.ok, true);
  assert.deepEqual(passed.checks.map((check) => check.name), CHECK_NAMES);

  const routes = healthyApp();
  routes["POST /api/inhouse"] = () => json(403, {});
  const blocked = await serve(t, routes);
  const fail = await runCli(SCRIPT, cliArgs(blocked.base, dir));
  assert.equal(fail.code, 1);
  const failedRun = JSON.parse(fail.stdout);
  assert.equal(failedRun.ok, false);
  assert.deepEqual(failed(failedRun), ["same-origin-guard"]);
});

test("the CLI reports a usage error as JSON, with the usage on stderr, and exits 1", async () => {
  const run = await runCli(SCRIPT, ["--base", "http://127.0.0.1:3001"]);
  assert.equal(run.code, 1);
  assert.deepEqual(JSON.parse(run.stdout), { ok: false, error: "usage", message: "--host is required" });
  assert.equal(run.stderr, `${USAGE}\n`);
});

// The agent runs the smoke from a release through its slot symlink, and Node
// reports the resolved path as import.meta.url: a naive main check would
// exit 0 having checked nothing.
test("the CLI still runs when started through a symlinked release folder", async (t) => {
  const dir = publicDir(t);
  const links = mkdtempSync(path.join(tmpdir(), "ggd2l-smoke-slot-"));
  t.after(() => rmSync(links, { recursive: true, force: true }));
  symlinkSync(path.dirname(SCRIPT), path.join(links, "a"));
  const routes = healthyApp();
  routes["GET /api/health/live"] = () => json(500, {});
  const { base } = await serve(t, routes);
  const run = await runCli(path.join(links, "a", "smoke.mjs"), cliArgs(base, dir));
  assert.equal(run.code, 1, run.stdout + run.stderr);
  assert.deepEqual(failed(JSON.parse(run.stdout)), ["health"]);
});

// --- The CI step that runs it ----------------------------------------------

test("CI boots the built site like the box and runs this smoke with --expect staging", () => {
  const ci = readFileSync(CI_WORKFLOW, "utf8");
  const job = /\n {2}postgres:\n([\s\S]*?)\n {2}mutation:\n/.exec(ci)?.[1];
  assert.ok(job, "ci.yml has the postgres job before the mutation job");
  const steps = job.split(/\n(?= {6}- )/);
  const build = steps.findIndex((text) =>
    text.startsWith("      - name: Exercise the exact Vercel migration and build pipeline\n"));
  assert.ok(build > 0, "the postgres job exercises the Vercel build");
  const step = steps[build + 1] ?? "";
  assert.ok(
    step.startsWith("      - name: Boot the built site the way the box runs it\n"),
    "the boot step comes right after the Vercel build step",
  );

  const env = Object.fromEntries(
    [...step.matchAll(/^ {10}([A-Z_]+): "?(.*?)"?$/gm)].map((match) => [match[1], match[2]]),
  );
  assert.equal(env.VERCEL_ENV, undefined);
  assert.equal(env.LEAGUE_DEPLOY_ENV, "staging");
  assert.equal(env.CLIENT_IP_HEADER, "cf-connecting-ip");
  assert.equal(env.LEAGUE_RELEASE_SHA, "${{ github.sha }}");
  assert.equal(env.DATABASE_URL, "${{ env.PG_TEST_URL }}");
  assert.doesNotMatch(step, /^ +image:/m);

  assert.match(step, /\n {10}node node_modules\/next\/dist\/bin\/next start -H 127\.0\.0\.1 -p 3100 \\\n/);
  const command = /\n {10}node ops\/selfhost\/smoke\/smoke\.mjs ([\s\S]*?) \|\| smoke=\$\?\n/.exec(step)?.[1];
  assert.ok(command, "the step runs the smoke");
  const argv = command
    .replace(/\\\n\s*/g, " ")
    .split(/\s+/)
    .map((word) => word.replace(/^"\$\{GITHUB_SHA\}"$/, SHA));
  const options = parseArgs(argv);
  assert.equal(options.base, "http://127.0.0.1:3100");
  assert.equal(options.expect, "staging");
  assert.equal(options.commit, SHA);
  assert.equal(env.APP_URL, options.origin);
  assert.equal(env.NEXT_PUBLIC_SITE_URL, options.origin);
  assert.match(step, /if \[ "\$\{status\}" != 143 \]; then/);
  assert.match(step, /\n {12}sleep 15 &\n[\s\S]*\n {12}kill -KILL "\$\{server\}"\n {10}\) > \/dev\/null 2>&1 &\n/);
});
