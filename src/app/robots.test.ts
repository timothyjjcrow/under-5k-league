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

  it("keeps crawlers off the stream overlay, a tool for OBS", () => {
    expect(robots().rules).toMatchObject({
      disallow: expect.arrayContaining(["/overlay"]),
    });
  });

  it("lets crawlers fetch player profiles, so they see the profiles' noindex", () => {
    const rules = robots().rules;
    const disallow = (Array.isArray(rules) ? rules : [rules]).flatMap((rule) =>
      rule.disallow === undefined ? [] : [rule.disallow].flat(),
    );
    for (const path of disallow) {
      expect("/players/abc".startsWith(path), path).toBe(false);
    }
  });
});
