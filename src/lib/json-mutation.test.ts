import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import {
  guardJsonMutation,
  MAX_JSON_BODY_BYTES,
  readBoundedJsonObject,
  requireJsonContentType,
  requireSameOrigin,
} from "./json-mutation";

function request(headers: Record<string, string> = {}) {
  return new NextRequest("https://league.example/api/draft/bid", {
    method: "POST",
    headers,
    body: "{}",
  });
}

describe("JSON mutation request boundary", () => {
  it("accepts canonical same-origin application/json", () => {
    expect(
      guardJsonMutation(
        request({
          origin: "https://league.example",
          "content-type": "application/json; charset=utf-8",
          "sec-fetch-site": "same-origin",
        }),
      ),
    ).toBeNull();
  });

  it.each([undefined, "text/plain", "application/x-www-form-urlencoded"])(
    "rejects media type %s before JSON parsing",
    async (contentType) => {
      const headers: Record<string, string> = {
        origin: "https://league.example",
      };
      if (contentType) headers["content-type"] = contentType;
      const response = requireJsonContentType(request(headers));
      expect(response?.status).toBe(415);
      expect((await response?.json()).error).toMatch(/application\/json/i);
    },
  );

  it.each([
    [undefined, undefined],
    ["null", undefined],
    ["not a URL", undefined],
    ["https://evil.example", "cross-site"],
    ["https://sibling.example", "same-site"],
    ["https://league.example/with-a-path", "same-origin"],
  ])("rejects unproven origin %s (%s)", async (origin, fetchSite) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (origin) headers.origin = origin;
    if (fetchSite) headers["sec-fetch-site"] = fetchSite;
    const response = requireSameOrigin(request(headers));
    expect(response?.status).toBe(403);
    expect((await response?.json()).error).toMatch(/same-origin/i);
  });

  it("reads one small JSON object", async () => {
    const parsed = await readBoundedJsonObject(
      request({ "content-type": "application/json" }),
    );
    expect(parsed).toEqual({ ok: true, value: {} });
  });

  it.each([
    ["", /valid JSON/i],
    ["{not-json", /valid JSON/i],
    ["null", /JSON object/i],
    ["[]", /JSON object/i],
    ["\"action\"", /JSON object/i],
  ])("rejects an invalid JSON-object body %j", async (body, message) => {
    const parsed = await readBoundedJsonObject(
      new NextRequest("https://league.example/api/inhouse", {
        method: "POST",
        body,
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.response.status).toBe(400);
    expect((await parsed.response.json()).error).toMatch(message);
  });

  it("rejects invalid UTF-8", async () => {
    const parsed = await readBoundedJsonObject(
      new NextRequest("https://league.example/api/inhouse", {
        method: "POST",
        body: new Uint8Array([0xff]),
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.response.status).toBe(400);
    expect((await parsed.response.json()).error).toMatch(/UTF-8/i);
  });

  it("rejects a declared oversized body before reading it", async () => {
    const parsed = await readBoundedJsonObject(
      new NextRequest("https://league.example/api/inhouse", {
        method: "POST",
        headers: { "content-length": String(MAX_JSON_BODY_BYTES + 1) },
        body: "{}",
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.response.status).toBe(413);
  });

  it("enforces the byte limit when Content-Length is absent", async () => {
    const parsed = await readBoundedJsonObject(
      new NextRequest("https://league.example/api/inhouse", {
        method: "POST",
        body: JSON.stringify({ value: "x".repeat(MAX_JSON_BODY_BYTES) }),
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.response.status).toBe(413);
  });

  it("enforces the streamed byte count when Content-Length understates it", async () => {
    const parsed = await readBoundedJsonObject(
      new NextRequest("https://league.example/api/inhouse", {
        method: "POST",
        headers: { "content-length": "2" },
        body: JSON.stringify({ value: "x".repeat(MAX_JSON_BODY_BYTES) }),
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.response.status).toBe(413);
  });
});
