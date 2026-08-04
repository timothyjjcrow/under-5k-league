import { NextRequest, NextResponse } from "next/server";

type GuardFailure = NextResponse<{ error: string }>;
type JsonObject = Record<string, unknown>;

export const MAX_JSON_BODY_BYTES = 8 * 1024;

export type JsonObjectReadResult =
  | { ok: true; value: JsonObject }
  | { ok: false; response: GuardFailure };

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

function bodyFailure(error: string, status: 400 | 413): JsonObjectReadResult {
  return {
    ok: false,
    response: NextResponse.json({ error }, { status }),
  };
}

/**
 * Read one small JSON object without ever buffering the hosting provider's
 * multi-megabyte request allowance. Every JSON route in this app accepts only
 * a handful of scalar action fields, so a larger body is invalid rather than
 * useful. The streaming count remains authoritative when Content-Length is
 * absent (for example, a chunked request) or dishonest.
 */
export async function readBoundedJsonObject(
  req: NextRequest,
  maxBytes = MAX_JSON_BODY_BYTES,
): Promise<JsonObjectReadResult> {
  const rawLength = req.headers.get("content-length");
  if (rawLength !== null) {
    const normalized = rawLength.trim();
    if (!/^\d+$/.test(normalized)) {
      return bodyFailure("Content-Length must be a non-negative integer", 400);
    }
    const declared = Number(normalized);
    if (!Number.isSafeInteger(declared) || declared > maxBytes) {
      return bodyFailure(
        `Request body exceeds the ${maxBytes}-byte limit`,
        413,
      );
    }
  }

  if (!req.body) {
    return bodyFailure("Request body must be valid JSON", 400);
  }

  const reader = req.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return bodyFailure(
          `Request body exceeds the ${maxBytes}-byte limit`,
          413,
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    return bodyFailure("Request body must be valid UTF-8 JSON", 400);
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return bodyFailure("Request body must be valid JSON", 400);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return bodyFailure("Request body must be a JSON object", 400);
  }
  return { ok: true, value: value as JsonObject };
}
