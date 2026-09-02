import { describe, expect, it } from "vitest";
import {
  assertNoPrismaDotenvFiles,
  authorizeMigrationRelease,
  MIGRATION_RELEASE_STEPS,
  PRISMA_DOTENV_PATHS,
} from "../../scripts/release-migrations.mjs";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
type Authorization = Parameters<typeof authorizeMigrationRelease>[0];

function authorization(overrides: Partial<Authorization> = {}): Authorization {
  return {
    argv: ["--apply", HEAD],
    env: { NODE_ENV: "production", VERCEL_ENV: "production" },
    headSha: HEAD,
    status: "",
    ...overrides,
  };
}

describe("explicit production migration release authorization", () => {
  it("accepts only exact --apply plus the clean checkout's current HEAD", () => {
    expect(authorizeMigrationRelease(authorization())).toBe(HEAD);
  });

  const malformedArguments = [
    [],
    ["--apply"],
    [HEAD, "--apply"],
    ["--apply", "HEAD"],
    ["--apply", HEAD.toUpperCase()],
    ["--apply", HEAD, "extra"],
  ];

  it.each(malformedArguments.map((argv) => [argv] as const))(
    "rejects malformed writer arguments: %j",
    (argv) => {
      expect(() => authorizeMigrationRelease(authorization({ argv }))).toThrow(
        /usage/i,
      );
    },
  );

  it.each([undefined, "preview", "development", "staging"])(
    "rejects VERCEL_ENV=%j",
    (vercelEnv) => {
      expect(() =>
        authorizeMigrationRelease(
          authorization({
            env:
              vercelEnv === undefined
                ? { NODE_ENV: "production" }
                : { NODE_ENV: "production", VERCEL_ENV: vercelEnv },
          }),
        ),
      ).toThrow(/VERCEL_ENV=production/);
    },
  );

  it("rejects a valid SHA that is not current HEAD", () => {
    expect(() =>
      authorizeMigrationRelease(
        authorization({
          argv: ["--apply", "fedcba9876543210fedcba9876543210fedcba98"],
        }),
      ),
    ).toThrow(/does not match current HEAD/);
  });

  it("rejects every dotenv location Prisma could auto-load", () => {
    expect(PRISMA_DOTENV_PATHS.map(({ label }) => label)).toEqual([
      "root .env",
      "prisma/.env",
    ]);

    for (const location of PRISMA_DOTENV_PATHS) {
      expect(() =>
        assertNoPrismaDotenvFiles((path) => path === location.path),
      ).toThrow(/dotenv files/i);
    }
    expect(() => assertNoPrismaDotenvFiles(() => false)).not.toThrow();
  });

  it.each([" M package.json", "A  migration.sql", "?? untracked.txt"])(
    "rejects a dirty checkout: %s",
    (status) => {
      expect(() =>
        authorizeMigrationRelease(authorization({ status })),
      ).toThrow(/clean checkout/);
    },
  );

  it("pins the guarded release order and invokes migrate deploy exactly once", () => {
    expect(MIGRATION_RELEASE_STEPS.map((step) => step.id)).toEqual([
      "validate-environment",
      "switch-provider",
      "validate-migrations",
      "preflight",
      "deploy",
      "postflight",
    ]);
    expect(
      MIGRATION_RELEASE_STEPS.filter(
        (step) =>
          step.args.join(" ") ===
          "node_modules/prisma/build/index.js migrate deploy",
      ),
    ).toHaveLength(1);
  });
});
