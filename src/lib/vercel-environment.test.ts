import { describe, expect, it } from "vitest";
import {
  INERT_BUILD_DATABASE_URL,
  previewDatabaseAttestationRequired,
  productionEnvironmentRequired,
} from "../../scripts/vercel-environment.mjs";

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

describe("Preview database attestation", () => {
  const preview: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    VERCEL_ENV: "preview",
  };
  const database = "postgresql://preview:secret@preview.example/league";

  it("attests a Preview that has a database of its own", () => {
    expect(
      previewDatabaseAttestationRequired({ ...preview, DATABASE_URL: database }),
    ).toBe(true);
    expect(
      previewDatabaseAttestationRequired({ ...preview, DIRECT_URL: database }),
    ).toBe(true);
    expect(
      previewDatabaseAttestationRequired({
        ...preview,
        DATABASE_URL: INERT_BUILD_DATABASE_URL,
        DIRECT_URL: database,
      }),
    ).toBe(true);
  });

  it("skips a Preview with no database or only the inert build URL", () => {
    expect(previewDatabaseAttestationRequired(preview)).toBe(false);
    expect(
      previewDatabaseAttestationRequired({
        ...preview,
        DATABASE_URL: INERT_BUILD_DATABASE_URL,
        DIRECT_URL: INERT_BUILD_DATABASE_URL,
      }),
    ).toBe(false);
  });

  it("leaves production and development to their own gates", () => {
    const others: NodeJS.ProcessEnv[] = [
      { NODE_ENV: "production", VERCEL_ENV: "production" },
      { NODE_ENV: "production" },
      { NODE_ENV: "development", VERCEL_ENV: "development" },
      { NODE_ENV: "development" },
    ];
    for (const env of others) {
      expect(
        previewDatabaseAttestationRequired({ ...env, DATABASE_URL: database }),
      ).toBe(false);
    }
  });

  it("fails closed for a misspelled VERCEL_ENV", () => {
    expect(() =>
      previewDatabaseAttestationRequired({
        NODE_ENV: "production",
        VERCEL_ENV: "Preview",
        DATABASE_URL: database,
      }),
    ).toThrow(/VERCEL_ENV must be exactly/);
  });
});
