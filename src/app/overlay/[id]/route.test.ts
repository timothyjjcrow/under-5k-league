import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GET } from "./route";

const SOURCE = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

const get = (id: string) =>
  GET(new Request(`http://localhost/overlay/${id}`), {
    params: Promise.resolve({ id }),
  });

describe("the overlay page route", () => {
  it("serves the whole page with the drawing code inline, for the CDN to keep", async () => {
    const response = await get("cmatch123");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("vercel-cdn-cache-control")).toBe("public, max-age=86400");
    expect(response.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    const html = await response.text();
    const script = readFileSync(new URL("../overlay-client.js", import.meta.url), "utf8");
    expect(html).toContain(script);
    expect(html).toContain('"matchId":"cmatch123"');
    // The display face is embedded, so OBS needs nothing else.
    expect(html).toContain("@font-face");
  });

  it("answers a malformed id with a short-lived 404", async () => {
    const response = await get("..%2Fadmin");
    expect(response.status).toBe(404);
    expect(response.headers.get("vercel-cdn-cache-control")).toBe("public, max-age=300");
  });

  it("reads files that exist, by literal paths the build's tracing can follow", () => {
    const paths = [...SOURCE.matchAll(/join\(process\.cwd\(\), ((?:"[^"]+",?\s*)+)\)/g)].map(
      (m) => [...m[1].matchAll(/"([^"]+)"/g)].map((part) => part[1]),
    );
    expect(paths).toHaveLength(3);
    for (const parts of paths) {
      expect(existsSync(path.join(process.cwd(), ...parts)), parts.join("/")).toBe(true);
    }
  });

  it("reads nothing from the database", () => {
    expect(SOURCE).not.toMatch(/@\/lib\/prisma|stream-overlay-service|getSessionUser/);
  });
});
