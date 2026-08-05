import { describe, expect, it } from "vitest";
import robots from "./robots";

describe("robots policy", () => {
  it("keeps private application areas out of public crawling", () => {
    const policy = robots();
    expect(policy.rules).toMatchObject({
      allow: "/",
      disallow: expect.arrayContaining(["/admin", "/api", "/me", "/login"]),
    });
  });
});
