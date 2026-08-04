import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

describe("global response security headers", () => {
  it("applies the hydration-safe CSP and baseline protections to every route", async () => {
    expect(typeof nextConfig.headers).toBe("function");
    const entries = await nextConfig.headers!();
    const global = entries.find((entry) => entry.source === "/:path*");
    const headers = new Map(
      global?.headers.map((header) => [header.key, header.value]),
    );

    expect(headers.get("Content-Security-Policy")).toBe(
      "base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
    );
    expect(headers.get("X-Frame-Options")).toBe("DENY");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(headers.get("Strict-Transport-Security")).toContain(
      "includeSubDomains",
    );
  });
});
