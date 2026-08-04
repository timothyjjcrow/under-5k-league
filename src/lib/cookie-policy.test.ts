import { NextResponse } from "next/server";
import { describe, expect, it } from "vitest";
import {
  deploymentCookieName,
  expireHttpOnlyCookie,
} from "./cookie-policy";

describe("deploymentCookieName", () => {
  it("keeps local HTTP cookie names usable outside production", () => {
    expect(deploymentCookieName("ld2l_session", false)).toBe("ld2l_session");
  });

  it("uses a browser-enforced host-only name in production", () => {
    expect(deploymentCookieName("ld2l_session", true)).toBe(
      "__Host-ld2l_session",
    );
  });

  it("emits a browser-acceptable production deletion for __Host- cookies", () => {
    const response = NextResponse.next();
    expireHttpOnlyCookie(
      response.cookies,
      deploymentCookieName("ld2l_session", true),
      true,
    );

    const header = response.headers.get("set-cookie");
    expect(header).toContain("__Host-ld2l_session=");
    expect(header).toContain("Path=/");
    expect(header).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    expect(header).toContain("Max-Age=0");
    expect(header).toContain("Secure");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=lax");
    expect(header).not.toContain("Domain=");
  });
});
