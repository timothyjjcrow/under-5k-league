import { NextRequest, NextResponse } from "next/server";

type GuardFailure = NextResponse<{ error: string }>;

/**
 * Route-handler JSON mutations do not receive Next server actions' built-in
 * origin checks. Require the media type before parsing so a browser cannot
 * submit a credentialed `text/plain` body without a CORS preflight.
 */
export function requireJsonContentType(req: NextRequest): GuardFailure | null {
  const mediaType = (req.headers.get("content-type") ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (mediaType === "application/json") return null;
  return NextResponse.json(
    { error: "Content-Type must be application/json" },
    { status: 415 },
  );
}

/**
 * Require a browser-proven same-origin mutation. `same-site` is deliberately
 * insufficient: an unrelated sibling subdomain must not be able to act with
 * the league session cookie. Missing/opaque/malformed origins fail closed.
 */
export function requireSameOrigin(req: NextRequest): GuardFailure | null {
  const rawOrigin = req.headers.get("origin");
  if (!rawOrigin || rawOrigin === "null") {
    return NextResponse.json(
      { error: "Same-origin request required" },
      { status: 403 },
    );
  }

  let origin: string;
  try {
    const parsed = new URL(rawOrigin);
    if (parsed.origin !== rawOrigin) throw new Error("non-canonical origin");
    origin = parsed.origin;
  } catch {
    return NextResponse.json(
      { error: "Same-origin request required" },
      { status: 403 },
    );
  }

  const fetchSite = req.headers.get("sec-fetch-site");
  if (
    origin !== req.nextUrl.origin ||
    (fetchSite && fetchSite !== "same-origin")
  ) {
    return NextResponse.json(
      { error: "Same-origin request required" },
      { status: 403 },
    );
  }
  return null;
}

export function guardJsonMutation(req: NextRequest): GuardFailure | null {
  return requireJsonContentType(req) ?? requireSameOrigin(req);
}
