import { describe, expect, it } from "vitest";
import { validCronBearer } from "./cron-auth";

const SECRET = "C8kP2vR7xM4qT9wL6nH3dF5sJ0yB1zUa";

describe("cron bearer authentication", () => {
  it("accepts only the configured bearer credential", () => {
    expect(validCronBearer(`Bearer ${SECRET}`, SECRET)).toBe(true);
    expect(validCronBearer(`Bearer ${SECRET}x`, SECRET)).toBe(false);
  });

  it.each([
    null,
    "",
    SECRET,
    `Basic ${SECRET}`,
    "Bearer",
    "Bearer ",
    `bearer ${SECRET}`,
    `Bearer ${SECRET} extra`,
    `Bearer ${SECRET}\t`,
  ])("rejects malformed authorization %j", (authorization) => {
    expect(validCronBearer(authorization, SECRET)).toBe(false);
  });

  it("fails closed for missing, short, padded, or implausibly large config", () => {
    expect(validCronBearer(`Bearer ${SECRET}`, undefined)).toBe(false);
    expect(validCronBearer("Bearer short", "short")).toBe(false);
    expect(validCronBearer(`Bearer ${SECRET}`, ` ${SECRET}`)).toBe(false);
    expect(validCronBearer(`Bearer ${SECRET}`, `${SECRET.slice(0, 32)} x`)).toBe(
      false,
    );
    const huge = "x".repeat(513);
    expect(validCronBearer(`Bearer ${huge}`, huge)).toBe(false);
  });
});
