import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ refreshSessionCookie: vi.fn() }));

import { refreshSessionCookie } from "@/lib/auth";
import { POST } from "./route";

const refresh = vi.mocked(refreshSessionCookie);

beforeEach(() => refresh.mockReset().mockResolvedValue(true));

const post = (headers: Record<string, string>) =>
  POST(
    new NextRequest("https://league.example/api/auth/refresh", {
      method: "POST",
      headers,
    }),
  );

describe("session refresh", () => {
  it("re-issues on a same-origin POST and answers an uncacheable 204", async () => {
    const res = await post({
      origin: "https://league.example",
      host: "league.example",
    });
    expect(refresh).toHaveBeenCalledOnce();
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("");
  });

  it("answers the same whether or not a cookie was re-issued", async () => {
    refresh.mockResolvedValue(false);
    const res = await post({
      origin: "https://league.example",
      host: "league.example",
    });
    expect(res.status).toBe(204);
  });

  it.each<Record<string, string>>([
    { origin: "https://evil.example", host: "league.example" },
    { origin: "null", host: "league.example" },
    { host: "league.example" },
    {
      origin: "https://admin.league.example",
      host: "league.example",
      "sec-fetch-site": "same-site",
    },
  ])("refuses a request that isn't same-origin (%j)", async (headers) => {
    const res = await post(headers);
    expect(res.status).toBe(403);
    expect(refresh).not.toHaveBeenCalled();
  });
});
