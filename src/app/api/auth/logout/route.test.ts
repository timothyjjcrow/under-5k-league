import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ destroySession: vi.fn() }));

import { destroySession } from "@/lib/auth";
import { POST } from "./route";

const destroy = vi.mocked(destroySession);

beforeEach(() => destroy.mockReset());

describe("logout", () => {
  it("uses POST, destroys the session, and lands on a confirmation", async () => {
    const res = await POST(
      new NextRequest("https://league.example/api/auth/logout", {
        method: "POST",
        headers: { origin: "https://league.example", host: "league.example" },
      }),
    );

    expect(destroy).toHaveBeenCalledOnce();
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      "https://league.example/login?signedOut=1",
    );
  });

  it("rejects a cross-origin form without changing the session", async () => {
    const res = await POST(
      new NextRequest("https://league.example/api/auth/logout", {
        method: "POST",
        headers: { origin: "https://evil.example", host: "league.example" },
      }),
    );

    expect(res.status).toBe(403);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("treats an opaque or malformed Origin as untrusted instead of throwing", async () => {
    const res = await POST(
      new NextRequest("https://league.example/api/auth/logout", {
        method: "POST",
        headers: { origin: "null", host: "league.example" },
      }),
    );

    expect(res.status).toBe(403);
    expect(destroy).not.toHaveBeenCalled();
  });
});
