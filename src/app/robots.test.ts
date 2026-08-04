import { describe, expect, it } from "vitest";
import robots from "./robots";

describe("robots policy", () => {
  it("allows public policy pages while keeping private application areas out", () => {
    const policy = robots();
    expect(policy.rules).toMatchObject({
      allow: "/",
      disallow: expect.arrayContaining(["/admin", "/api", "/me", "/login"]),
    });
    const disallowed = (policy.rules as { disallow: string[] }).disallow;
    expect(disallowed).not.toContain("/privacy");
    expect(disallowed).not.toContain("/terms");
  });
});
