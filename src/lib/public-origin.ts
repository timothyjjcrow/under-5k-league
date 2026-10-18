import { leagueDeployEnv } from "./deploy-env";

type Env = Record<string, string | undefined>;

/** The one part of a request these helpers read: its URL as Next parsed it. */
type RequestWithUrl = { nextUrl: { origin: string } };

/**
 * The league's public origin when this process declares a self-hosted
 * deployment (`LEAGUE_DEPLOY_ENV`, src/lib/deploy-env.ts), else `null`.
 *
 * On the box `next start` binds 127.0.0.1 behind Caddy and the tunnel, so the
 * URL Next builds for a request (`req.url`, `req.nextUrl`) names the bind
 * address, never the hostname the browser used. A declared process therefore
 * takes its origin from `APP_URL` alone, and never from `Host` or
 * `X-Forwarded-Host`, which a request supplies.
 *
 * Declared with `APP_URL` missing or not one canonical http(s) origin (no
 * path, no trailing slash), it THROWS: every redirect and same-origin check
 * then fails with a 500 rather than trusting the bind address. The box's env
 * contract refuses to start such a unit, so this is the last line, not the
 * first.
 */
export function canonicalOrigin(env: Env = process.env): string | null {
  if (leagueDeployEnv(env) === null) return null;
  const raw = env.APP_URL;
  let origin: string | null = null;
  try {
    const url = raw ? new URL(raw) : null;
    if (url && (url.protocol === "https:" || url.protocol === "http:")) {
      origin = url.origin;
    }
  } catch {
    origin = null;
  }
  if (!origin || origin !== raw) {
    throw new Error(
      "LEAGUE_DEPLOY_ENV is set, so APP_URL must be one canonical http(s) " +
        "origin with no path or trailing slash",
    );
  }
  return origin;
}

/**
 * The origin a browser sees for this request: the canonical origin when the
 * deployment is declared, otherwise the request's own origin (Vercel, local
 * development and the tests, exactly as before self-hosting). Route handlers
 * build every redirect on it (`new URL(path, publicOrigin(req))`, never
 * `req.url`; src/app/route-redirect-origin.test.ts) and the same-origin guard
 * compares the browser's `Origin` with it (src/lib/json-mutation.ts).
 */
export function publicOrigin(
  req: RequestWithUrl,
  env: Env = process.env,
): string {
  return canonicalOrigin(env) ?? req.nextUrl.origin;
}

/**
 * The base Steam OpenID (`return_to`, `realm`) and Discord OAuth
 * (`redirect_uri`) send the browser back to. Declared, it is the canonical
 * origin, like `publicOrigin`. Undeclared it keeps the pre-self-hosting rule,
 * `APP_URL` when set and the request's origin otherwise: a Vercel or local
 * request that arrives on another host (a deployment URL, `127.0.0.1` beside
 * a `localhost` APP_URL) still hands the provider the registered callback.
 */
export function providerReturnBase(
  req: RequestWithUrl,
  env: Env = process.env,
): string {
  return canonicalOrigin(env) ?? (env.APP_URL || req.nextUrl.origin);
}
