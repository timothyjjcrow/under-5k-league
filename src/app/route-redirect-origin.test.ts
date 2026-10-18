import { describe, expect, it } from "vitest";
import {
  sourceFiles,
  stripLineComments,
} from "../../test/support/source-files";

/**
 * Route handlers build every redirect on `publicOrigin(req)`
 * (src/lib/public-origin.ts), never on the request's own URL. On the league
 * box `next start` binds 127.0.0.1 behind Caddy, and Next reports that bind
 * address as `https://localhost:<port>` in both `req.url` (which is
 * `req.nextUrl.toString()`) and `req.nextUrl`: a `new URL(path, req.url)`
 * redirect sends every player to `https://localhost:3001/...`. Nothing fails
 * on Vercel, in development or in e2e, where the request URL is the public
 * one, so this reads every route handler's source instead.
 *
 * Refused in `src/app/**\/route.ts`:
 * - `new URL(<anything>, <request>.url | <request>.nextUrl…)`;
 * - `NextResponse.redirect(<request>.url | <request>.nextUrl…)`;
 * - `<request>.nextUrl.origin`, the old same-origin and OAuth base;
 * - binding the request's URL to a local first (`const here = req.url`,
 *   `const { nextUrl } = req`, `const { origin } = req.nextUrl`), which would
 *   carry it past the checks above. Reading `.searchParams`, `.search` or
 *   `.pathname` off it stays allowed.
 */

/** A `new URL` base read off the request: `req.url`, `String(request.nextUrl)`. */
const BASE_FROM_REQUEST = /\.(?:url|nextUrl)\b/;
/** A redirect target that IS the request's URL: `req.nextUrl.clone()`. */
const TARGET_IS_REQUEST =
  /^(?:String\(\s*|`\$\{\s*)?[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*?\??\.(?:url|nextUrl)\b/;
const REQUEST_ORIGIN = /\.nextUrl\??\.origin\b/g;
/** `const here = req.url`, `= String(request.nextUrl)`: an alias of the URL (destructures below). */
const URL_BINDING =
  /(?<![=!<>])(?<!\}\s*)=\s*(?:String\(\s*)?[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*?\??\.(?:url|nextUrl)\b(?!\??\.(?:searchParams|search|pathname)\b)/g;
/** `const { url } = req`, `const { nextUrl: u } = request`. */
const URL_DESTRUCTURE =
  /\{[^{}]*\b(?:url|nextUrl)\b[^{}]*\}\s*=\s*[A-Za-z_$][\w$]*(?:\??\.(?:req|request))?\s*(?:[;,)\n]|$)/g;
/** `const { origin } = req.nextUrl`, `const { href } = request.nextUrl`. */
const ORIGIN_DESTRUCTURE =
  /\{[^{}]*\b(?:origin|href|host)\b[^{}]*\}\s*=\s*[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*?\??\.nextUrl\b/g;

/**
 * The top-level arguments of the call whose `(` is at `open`, or null when it
 * never closes. Strings are skipped, so a comma or parenthesis inside a path
 * literal does not split or end an argument.
 */
function callArguments(text: string, open: number): string[] | null {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        args.push(text.slice(start, i).trim());
        return args.filter((arg) => arg.length > 0);
      }
    } else if (c === "," && depth === 1) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  return null;
}

/** Every call of `callee` in `text`, as its argument list. */
function calls(text: string, callee: RegExp): string[][] {
  const found: string[][] = [];
  for (const match of text.matchAll(new RegExp(callee.source, "g"))) {
    const open = match.index + match[0].length - 1;
    const args = callArguments(text, open);
    if (args) found.push(args);
  }
  return found;
}

const NEW_URL = /\bnew\s+URL\s*\(/;
const REDIRECT = /\.redirect\s*\(/;

/** What `text` does that this guard refuses, one line per finding. */
function violations(text: string): string[] {
  const code = stripLineComments(text);
  const found: string[] = [];
  for (const args of calls(code, NEW_URL)) {
    if (args.length >= 2 && BASE_FROM_REQUEST.test(args[1])) {
      found.push(`new URL(${args.join(", ")})`);
    }
  }
  for (const args of calls(code, REDIRECT)) {
    if (args.length >= 1 && TARGET_IS_REQUEST.test(args[0])) {
      found.push(`redirect(${args.join(", ")})`);
    }
  }
  for (const pattern of [REQUEST_ORIGIN, URL_BINDING, URL_DESTRUCTURE, ORIGIN_DESTRUCTURE]) {
    for (const match of code.matchAll(pattern)) found.push(match[0].trim());
  }
  return found;
}

describe("route-handler redirect origin", () => {
  it("catches every old form and none of the new ones", () => {
    // If this fails the detector broke; fix it before trusting the guard.
    for (const refused of [
      'new URL("/login", req.url)',
      "new URL(destination, request.url)",
      'new URL(heroSearchDestination(read("q") ?? "", read("season")), request.url)',
      'new URL(\n  "/me?discord=error",\n  req.url,\n)',
      "new URL(next, req.nextUrl)",
      "new URL(next, request.nextUrl.href)",
      "new URL(next, String(req.url))",
      "NextResponse.redirect(req.nextUrl.clone())",
      "NextResponse.redirect(request.url, 303)",
      "NextResponse.redirect(ctx.req.url)",
      "new URL(next, ctx.request.url)",
      "const base = process.env.APP_URL || req.nextUrl.origin;",
      "`${process.env.APP_URL || req.nextUrl.origin}/api/auth/discord/callback`",
      "const here = req.url;\nconst target = new URL(\"/login\", here);",
      "const base = String(request.nextUrl);",
      "let u;\nu = ctx.req.nextUrl;",
      "const { nextUrl } = req;\nreturn NextResponse.redirect(new URL(p, nextUrl));",
      "const { url } = request;",
      "const { nextUrl: n, method } = req\n",
      "const { origin } = req.nextUrl;",
      "const { href, pathname } = request.nextUrl;",
    ]) {
      expect(violations(refused), refused).not.toEqual([]);
    }
    for (const allowed of [
      'new URL("/login?signedOut=1", publicOrigin(req))',
      'new URL("/a,(b)", publicOrigin(request))',
      "new URL(req.url).searchParams.get('x')",
      'new URL("/api/auth/steam/callback", base)',
      "NextResponse.redirect(new URL(next, publicOrigin(req)))",
      "NextResponse.redirect(buildSteamLoginUrl(returnTo.toString(), base))",
      "NextResponse.redirect(new URL(req.nextUrl.pathname, publicOrigin(req)))",
      "process.env.APP_URL",
      "// never new URL(path, req.url): that names the bind address",
      'const values = request.nextUrl.searchParams.getAll("season");',
      "const q = req.nextUrl.searchParams;",
      "const path = req.nextUrl.pathname;",
      "if (a === req.url) return;",
      "const { searchParams } = req.nextUrl;",
      "const { pathname, search } = request.nextUrl;",
      "const { id } = await params;",
      "const { url } = await fetchThing();",
      "const { origin } = LEAGUE_CONFIG;",
    ]) {
      expect(violations(allowed), allowed).toEqual([]);
    }
  });

  const routes = sourceFiles("src/app/**/route.{ts,tsx}", 25);

  it("never builds a redirect on the request's own URL", () => {
    const bad = routes.flatMap((file) =>
      violations(file.text).map((v) => `${file.path}: ${v}`),
    );
    expect(bad, "use new URL(path, publicOrigin(req))").toEqual([]);
  });

  it("builds the redirects on publicOrigin", () => {
    // The sites the self-hosting change moved (design A3); a count well
    // below this means a redirect went somewhere this guard cannot see.
    const onPublicOrigin = routes.flatMap((file) =>
      calls(stripLineComments(file.text), NEW_URL).filter(
        (args) => args.length === 2 && /^publicOrigin\(/.test(args[1]),
      ),
    );
    expect(onPublicOrigin.length).toBeGreaterThanOrEqual(11);
  });
});
