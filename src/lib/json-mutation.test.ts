import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import {
  guardJsonMutation,
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
});
