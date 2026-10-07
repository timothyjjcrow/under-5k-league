import { readdirSync, utimesSync } from "node:fs";
import path from "node:path";

// Wait until a suite's `next dev` server routes the app before any spec runs.
//
// The dev router matches requests against a table that its file watcher
// builds asynchronously (Next 16, server/lib/router-utils/setup-dev-bundler).
// The server starts answering once the watcher has delivered its first batch
// of files. On a busy runner that batch can be a fraction of src/app, and
// overlapping rebuilds can finish out of order, leaving an older, partial
// list of dynamic routes in place. A route missing from the table gets the
// global 404 page in about 0.1s, with no compile. CI hit this twice on
// 2026-10-06, on POST /api/test/cache and on /seasons/[id]/weeks/[week], two
// of the deepest routes, which the watcher reaches last. A page that calls
// notFound() answers 200 here, because the root loading.tsx streams the shell
// first, so a 404 status means the router didn't match.
//
// Probed: every route handler, with OPTIONS (Next answers it from the
// exported methods, so no handler code runs), and every dynamic page, as a
// document with a placeholder param. Static pages need only the file list,
// which every rebuild refills and which is whole once the scan reaches the
// deepest folders, as these probes do. They aren't fetched because every
// compiled page slows the HMR exchange each later page load makes (all 31
// took it from about 10ms to 80ms). Compiling them all up front made
// e2e-mid/schedule.spec.ts lose its check-in click or time out under CPU load
// in 4 runs of 9, against none of 8 without the warm-up.
//
// A 404 is retried. A route still missing after a few seconds has its file's
// mtime touched, which makes the watcher rebuild the whole table; Turbopack
// sees the same content and recompiles nothing. A route that never matches
// fails the run with its name, so a genuinely broken route still fails.

const PAGE_FILE = /^page\.[jt]sx?$/;
const ROUTE_FILE = /^route\.[jt]s$/;
// Any value works for a dynamic segment: the page answers not-found under a
// 200, which still proves the router matched it.
const PLACEHOLDER = "warm-up";
const CONCURRENCY = 4;
const RETRY_MS = 1_000;
const REBUILD_AFTER_MS = 5_000;
const GIVE_UP_AFTER_MS = 60_000;
// A first compile on a CI runner can take a while; Playwright gives the
// server itself 120s to start.
const REQUEST_TIMEOUT_MS = 120_000;

type DevRoute = {
  /** The page or route handler, relative to the repo root. */
  file: string;
  /** A request path that reaches it. */
  path: string;
  method: "GET" | "OPTIONS";
};

const isDynamic = (segment: string) => /^\[.+\]$/.test(segment);

function segmentsToPath(segments: readonly string[]): string {
  const parts = segments.flatMap((segment) => {
    if (/^\(.+\)$/.test(segment)) return []; // a route group
    if (/^\[\[\.\.\..+\]\]$/.test(segment)) return []; // optional catch-all
    if (isDynamic(segment)) return [PLACEHOLDER];
    return [segment];
  });
  return `/${parts.join("/")}`;
}

/** Every route handler and every page under a dynamic segment. */
function routesToProbe(appDir: string): DevRoute[] {
  const routes: DevRoute[] = [];
  const walk = (dir: string, segments: string[]) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = entry.name;
      if (entry.isDirectory()) {
        // Private folders, parallel-route slots and intercepting routes have
        // no URL of their own.
        if (/^[_@.]/.test(name) || /^\(\.{1,3}\)/.test(name)) continue;
        walk(path.join(dir, name), [...segments, name]);
        continue;
      }
      const method = ROUTE_FILE.test(name)
        ? "OPTIONS"
        : PAGE_FILE.test(name) && segments.some(isDynamic)
          ? "GET"
          : null;
      if (!method) continue;
      routes.push({
        file: path.relative(process.cwd(), path.join(dir, name)),
        path: segmentsToPath(segments),
        method,
      });
    }
  };
  walk(appDir, []);
  return routes;
}

/** "matched", or why the route isn't routed yet. */
async function probe(origin: string, route: DevRoute): Promise<string> {
  const res = await fetch(origin + route.path, {
    method: route.method,
    headers: { accept: "text/html" },
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch((error: unknown) =>
    error instanceof Error ? error.message : String(error),
  );
  if (typeof res === "string") return `no response: ${res}`;
  // Read the whole body: a page renders as it streams, and dropping the
  // connection early makes the dev server log a closed-stream error.
  await res.arrayBuffer().catch(() => undefined);
  return res.status === 404 ? "404" : "matched";
}

async function probeAll(
  origin: string,
  routes: readonly DevRoute[],
): Promise<string[]> {
  const results: string[] = new Array(routes.length);
  let next = 0;
  const worker = async () => {
    while (next < routes.length) {
      const index = next++;
      results[index] = await probe(origin, routes[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, routes.length) }, worker),
  );
  return results;
}

const describe = (route: DevRoute) => `${route.method} ${route.path}`;

function listed(names: readonly string[], limit = 8): string {
  const shown = names.slice(0, limit).join(", ");
  return names.length > limit
    ? `${shown} and ${names.length - limit} more`
    : shown;
}

export async function waitForDevRoutes(origin: string, label: string) {
  const appDir = path.join(process.cwd(), "src", "app");
  const routes = routesToProbe(appDir);
  if (routes.length === 0) {
    throw new Error(`Found no route handlers or dynamic pages under ${appDir}`);
  }
  const started = Date.now();
  const firstMiss = new Map<DevRoute, number>();
  let lastRebuild = 0;
  let rebuilds = 0;
  let pending: readonly DevRoute[] = routes;
  for (;;) {
    const results = await probeAll(origin, pending);
    const now = Date.now();
    const missing = new Map<DevRoute, string>();
    pending.forEach((route, index) => {
      if (results[index] === "matched") return;
      missing.set(route, results[index]);
      if (!firstMiss.has(route)) firstMiss.set(route, now);
    });
    if (missing.size === 0) break;
    const missingFor = (route: DevRoute) => now - (firstMiss.get(route) ?? now);
    const stuck = [...missing.keys()].filter(
      (route) => missingFor(route) > GIVE_UP_AFTER_MS,
    );
    if (stuck.length > 0) {
      throw new Error(
        `The ${label} dev server at ${origin} never routed ${listed(
          stuck.map((route) => `${describe(route)} (${route.file}: ${missing.get(route)})`),
        )}`,
      );
    }
    const overdue = [...missing.keys()].some(
      (route) => missingFor(route) >= REBUILD_AFTER_MS,
    );
    if (overdue && now - lastRebuild >= REBUILD_AFTER_MS) {
      const touched = new Date();
      for (const route of missing.keys()) {
        utimesSync(route.file, touched, touched);
      }
      lastRebuild = now;
      rebuilds += 1;
    }
    pending = [...missing.keys()];
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
  const seconds = ((Date.now() - started) / 1_000).toFixed(1);
  const late = [...firstMiss.keys()].map(describe);
  const recovered =
    late.length === 0
      ? ""
      : `; ${late.length} weren't routed at first: ${listed(late)}` +
        (rebuilds > 0 ? `; touched to rebuild the route table ${rebuilds}x` : "");
  console.log(
    `The ${label} dev server routes all ${routes.length} route handlers and dynamic pages (${seconds}s${recovered})`,
  );
}
