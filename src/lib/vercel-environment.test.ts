import { describe, expect, it } from "vitest";
import { productionEnvironmentRequired } from "../../scripts/vercel-environment.mjs";

describe("Vercel environment gate", () => {
  it("requires production gates for Vercel production and local production", () => {
    expect(
      productionEnvironmentRequired({
        NODE_ENV: "production",
        VERCEL_ENV: "production",
      }),
    ).toBe(true);
    expect(productionEnvironmentRequired({ NODE_ENV: "production" })).toBe(
      true,
    );
  });

  it("skips production gates only for exact known non-production values", () => {
    expect(
      productionEnvironmentRequired({
        NODE_ENV: "production",
        VERCEL_ENV: "preview",
      }),
    ).toBe(false);
    expect(
      productionEnvironmentRequired({
        NODE_ENV: "development",
        VERCEL_ENV: "development",
      }),
    ).toBe(false);
    expect(productionEnvironmentRequired({ NODE_ENV: "development" })).toBe(
      false,
    );
  });

  it.each(["", "staging", "Production", " preview "])(
    "fails closed for configured VERCEL_ENV=%j",
    (value) => {
      expect(() =>
        productionEnvironmentRequired({
          NODE_ENV: "production",
          VERCEL_ENV: value,
        }),
      ).toThrow(/VERCEL_ENV must be exactly/);
    },
  );
});
