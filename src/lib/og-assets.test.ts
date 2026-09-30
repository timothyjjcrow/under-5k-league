import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fallbackOgImage, fetchOgImage, renderOgImage } from "./og-assets";
import { OG_CACHE_CONTROL } from "./og-image";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const CREST = "https://i.imgur.com/crest.png";

function stubFetch(response: Response | Error) {
  const fetch = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchOgImage", () => {
  it("never calls an address off the allowlist", async () => {
    const fetch = stubFetch(new Response(PNG));
    expect(await fetchOgImage("https://example.com/crest.png")).toBeNull();
    expect(await fetchOgImage("/brand/logo.png")).toBeNull();
    expect(await fetchOgImage(null)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns an allowed picture as a data URI, refusing redirects, with a timeout", async () => {
    const fetch = stubFetch(new Response(PNG));
    expect(await fetchOgImage(CREST)).toBe(
      `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`,
    );
    expect(fetch).toHaveBeenCalledWith(
      CREST,
      expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }),
    );
  });

  it("draws initials for anything that isn't a PNG or JPEG", async () => {
    stubFetch(
      new Response("<!doctype html><title>removed</title>", {
        headers: { "content-type": "image/png" },
      }),
    );
    expect(await fetchOgImage(CREST)).toBeNull();
  });

  it("gives up on an error status, a network failure or a timeout", async () => {
    stubFetch(new Response(PNG, { status: 404 }));
    expect(await fetchOgImage(CREST)).toBeNull();
    stubFetch(new TypeError("fetch failed"));
    expect(await fetchOgImage(CREST)).toBeNull();
    stubFetch(new DOMException("The operation timed out.", "TimeoutError"));
    expect(await fetchOgImage(CREST)).toBeNull();
  });

  it("refuses a picture over the size cap, declared or streamed", async () => {
    stubFetch(new Response(PNG, { headers: { "content-length": "2000000" } }));
    expect(await fetchOgImage(CREST)).toBeNull();
    // No length header: the stream is counted as it arrives.
    const big = new Uint8Array(1_600_000);
    big.set(PNG);
    stubFetch(new Response(new Blob([big]).stream()));
    expect(await fetchOgImage(CREST)).toBeNull();
  });
});

describe("renderOgImage", () => {
  it("draws the picture with a five-minute cache", async () => {
    const res = await renderOgImage(
      createElement(
        "div",
        { style: { display: "flex", width: 1200, height: 630, background: "#0b0f17" } },
        "GGD2L",
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe(OG_CACHE_CONTROL);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.slice(0, 4)).toEqual(PNG.slice(0, 4));
  });

  it("sends the league's own picture when the drawing fails", async () => {
    // Satori refuses a <div> with two children and no display: flex.
    const res = await renderOgImage(
      createElement(
        "div",
        { style: { width: 1200, height: 630 } },
        createElement("span", null, "a"),
        createElement("span", null, "b"),
      ),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      fallbackOgImage().headers.get("location"),
    );
    expect(res.headers.get("location")).toMatch(/^\/.*\.png$/);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
