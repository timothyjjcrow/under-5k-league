import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  assertPinnedPrismaVersion,
  authorizeFailedMigrationResolve,
  directMigrationUrl,
  FAILED_MIGRATION_TARGET,
  PINNED_PRISMA_VERSION,
  runFailedMigrationResolve,
  validateFailedMigrationSnapshot,
  validateResolvedMigrationSnapshot,
  verifyFailedMigrationInspectorGeneration,
  type FailedMigrationSnapshot,
} from "../../scripts/migration-failed-resolve.mjs";
import { MIGRATION_SHA256 } from "../../scripts/migration-safety.mjs";

const HEAD = "0123456789abcdef0123456789abcdef01234567";

function testEnv(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return { NODE_ENV: "production", ...overrides };
}

function snapshot(): FailedMigrationSnapshot {
  return {
    migrations: Object.entries(MIGRATION_SHA256).map(([name, checksum]) => ({
      id: `row-${name}`,
      name,
      checksum,
      finished: name !== FAILED_MIGRATION_TARGET,
      rolledBack: false,
      appliedSteps: 0,
    })),
    catalog: {
      queueTableExists: true,
      idleExpiresAtCount: 0,
      refreshFunctionCount: 0,
      insertTriggerCount: 0,
      deleteTriggerCount: 0,
      canOwnQueueTable: true,
      canCreateInSchema: true,
      canTriggerQueueTable: true,
    },
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe("guarded failed migration recovery", () => {
  it("accepts only the exact target, production environment, clean current HEAD", () => {
    expect(
      authorizeFailedMigrationResolve({
        argv: ["--apply", HEAD, FAILED_MIGRATION_TARGET],
        env: testEnv({ VERCEL_ENV: "production" }),
        headSha: HEAD,
        status: "",
      }),
    ).toEqual({ approvedSha: HEAD, migrationName: FAILED_MIGRATION_TARGET });

    for (const argv of [
      [],
      ["--apply", HEAD],
      ["--apply", "HEAD", FAILED_MIGRATION_TARGET],
      ["--apply", HEAD, "another_migration"],
      [FAILED_MIGRATION_TARGET, "--apply", HEAD],
      ["--apply", HEAD, FAILED_MIGRATION_TARGET, "extra"],
    ]) {
      expect(() =>
        authorizeFailedMigrationResolve({
          argv,
          env: testEnv({ VERCEL_ENV: "production" }),
          headSha: HEAD,
          status: "",
        }),
      ).toThrow(/usage/i);
    }
    expect(() =>
      authorizeFailedMigrationResolve({
        argv: ["--apply", HEAD, FAILED_MIGRATION_TARGET],
        env: testEnv({ VERCEL_ENV: "preview" }),
        headSha: HEAD,
        status: "",
      }),
    ).toThrow(/VERCEL_ENV=production/);
    expect(() =>
      authorizeFailedMigrationResolve({
        argv: ["--apply", HEAD, FAILED_MIGRATION_TARGET],
        env: testEnv({ VERCEL_ENV: "production" }),
        headSha: "fedcba9876543210fedcba9876543210fedcba98",
        status: "",
      }),
    ).toThrow(/does not match current HEAD/);
    expect(() =>
      authorizeFailedMigrationResolve({
        argv: ["--apply", HEAD, FAILED_MIGRATION_TARGET],
        env: testEnv({ VERCEL_ENV: "production" }),
        headSha: HEAD,
        status: "?? unexpected.txt",
      }),
    ).toThrow(/clean checkout/);
  });

  it("requires the pinned Prisma version and a direct PostgreSQL URL", () => {
    expect(() =>
      assertPinnedPrismaVersion(PINNED_PRISMA_VERSION),
    ).not.toThrow();
    expect(() => assertPinnedPrismaVersion("6.0.0")).toThrow(/pinned Prisma/);

    const direct = "postgresql://owner:secret@ep-example.neon.tech/league";
    expect(directMigrationUrl(testEnv({ DIRECT_URL: direct }))).toBe(direct);
    expect(() => directMigrationUrl(testEnv())).toThrow(
      /DIRECT_URL is required/,
    );
    expect(() =>
      directMigrationUrl(testEnv({ DIRECT_URL: "file:./test.db" })),
    ).toThrow(/direct PostgreSQL URL/);
    expect(() =>
      directMigrationUrl(
        testEnv({
          DIRECT_URL:
            "postgresql://owner:secret@ep-example-pooler.neon.tech/league",
        }),
      ),
    ).toThrow(/not a pooler/);
    expect(() =>
      directMigrationUrl(
        testEnv({
          DIRECT_URL:
            "postgresql://owner:secret@db.example/league?pgbouncer=true",
        }),
      ),
    ).toThrow(/not a pooler/);
  });

  it("generates the real isolated Prisma inspector from installed dependencies", () => {
    const directUrl =
      "postgresql://owner:not-used@127.0.0.1:5432/generation_only";
    expect(() =>
      verifyFailedMigrationInspectorGeneration({
        env: testEnv({ DIRECT_URL: directUrl, DATABASE_URL: directUrl }),
        url: directUrl,
      }),
    ).not.toThrow();
  }, 30_000);

  it("surfaces secret-free diagnostics when inspector generation fails", () => {
    const directUrl =
      "postgresql://owner:top%2Fsecret@127.0.0.1:5432/generation_only";
    let failure: unknown;
    try {
      verifyFailedMigrationInspectorGeneration({
        env: testEnv({
          DIRECT_URL: directUrl,
          DATABASE_URL: directUrl,
          NODE_OPTIONS: "--ld2l-invalid-generation-option",
        }),
        url: directUrl,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toMatch(
      /Could not generate the isolated failed-migration inspector/,
    );
    expect(message).toMatch(/NODE_OPTIONS|ld2l-invalid-generation-option/);
    expect(message).not.toContain(directUrl);
    expect(message).not.toContain("top%2Fsecret");
    expect(message).not.toContain("top/secret");
  });

  it("exits nonzero when the CLI guard rejects an invocation", () => {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL(
            "../../scripts/migration-failed-resolve.mjs",
            import.meta.url,
          ),
        ),
      ],
      { encoding: "utf8", env: testEnv() },
    );
    expect(result.status).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/Usage: npm run db:migrate:failed-resolve/);
  });

  it("accepts only one exact zero-step unresolved target with a clean catalog", () => {
    const valid = snapshot();
    const failedId = validateFailedMigrationSnapshot(valid);
    expect(failedId).toBe(`row-${FAILED_MIGRATION_TARGET}`);

    const cases: Array<[RegExp, (value: FailedMigrationSnapshot) => void]> = [
      [
        /exactly one unresolved/,
        (value) => {
          value.migrations.find(
            (row) => row.name === FAILED_MIGRATION_TARGET,
          )!.rolledBack = true;
        },
      ],
      [
        /checksum drift|checksum does not match/,
        (value) => {
          value.migrations.find(
            (row) => row.name === FAILED_MIGRATION_TARGET,
          )!.checksum = "wrong";
        },
      ],
      [
        /zero recorded applied steps/,
        (value) => {
          value.migrations.find(
            (row) => row.name === FAILED_MIGRATION_TARGET,
          )!.appliedSteps = 1;
        },
      ],
      [
        /finished migration row/,
        (value) => {
          value.migrations.find(
            (row) => row.name === FAILED_MIGRATION_TARGET,
          )!.finished = true;
        },
      ],
      [
        /partially applied catalog objects/,
        (value) => {
          value.catalog.idleExpiresAtCount = 1;
        },
      ],
      [
        /partially applied catalog objects/,
        (value) => {
          value.catalog.refreshFunctionCount = 1;
        },
      ],
      [
        /partially applied catalog objects/,
        (value) => {
          value.catalog.insertTriggerCount = 1;
        },
      ],
      [
        /partially applied catalog objects/,
        (value) => {
          value.catalog.deleteTriggerCount = 1;
        },
      ],
      [
        /direct migration role/,
        (value) => {
          value.catalog.canOwnQueueTable = false;
        },
      ],
      [
        /direct migration role/,
        (value) => {
          value.catalog.canCreateInSchema = false;
        },
      ],
      [
        /direct migration role/,
        (value) => {
          value.catalog.canTriggerQueueTable = false;
        },
      ],
    ];
    for (const [message, mutate] of cases) {
      const invalid = clone(valid);
      mutate(invalid);
      expect(() => validateFailedMigrationSnapshot(invalid)).toThrow(message);
    }
  });

  it("verifies that resolve changes only the approved ledger row", () => {
    const before = snapshot();
    const failedId = validateFailedMigrationSnapshot(before);
    const after = clone(before);
    after.migrations.find((row) => row.id === failedId)!.rolledBack = true;
    expect(() =>
      validateResolvedMigrationSnapshot(before, after, failedId),
    ).not.toThrow();

    const inserted = clone(after);
    inserted.migrations.push({ ...inserted.migrations[0], id: "unexpected" });
    expect(() =>
      validateResolvedMigrationSnapshot(before, inserted, failedId),
    ).toThrow(/exactly one completed|row count/);

    const catalogChanged = clone(after);
    catalogChanged.catalog.idleExpiresAtCount = 1;
    expect(() =>
      validateResolvedMigrationSnapshot(before, catalogChanged, failedId),
    ).toThrow(/partially applied catalog objects/);
  });

  it("runs immutable validation before one resolve and verifies afterward", async () => {
    const migrationValidator = vi.fn();
    const database = snapshot();
    const inspect = vi.fn(async () => clone(database));
    const resolve = vi.fn(() => {
      database.migrations.find(
        (row) => row.name === FAILED_MIGRATION_TARGET,
      )!.rolledBack = true;
    });

    await expect(
      runFailedMigrationResolve({
        argv: ["--apply", HEAD, FAILED_MIGRATION_TARGET],
        env: testEnv({
          VERCEL_ENV: "production",
          DIRECT_URL: "postgresql://owner:secret@ep-example.neon.tech/league",
        }),
        headSha: HEAD,
        status: "",
        fileExists: () => false,
        migrationValidator,
        prismaVersion: PINNED_PRISMA_VERSION,
        inspect,
        resolve,
      }),
    ).resolves.toEqual({
      approvedSha: HEAD,
      migrationName: FAILED_MIGRATION_TARGET,
    });
    expect(migrationValidator).toHaveBeenCalledOnce();
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("does not resolve when the read-only proof fails", async () => {
    const invalid = snapshot();
    invalid.catalog.insertTriggerCount = 1;
    const resolve = vi.fn();
    await expect(
      runFailedMigrationResolve({
        argv: ["--apply", HEAD, FAILED_MIGRATION_TARGET],
        env: testEnv({
          VERCEL_ENV: "production",
          DIRECT_URL: "postgresql://owner:secret@ep-example.neon.tech/league",
        }),
        headSha: HEAD,
        status: "",
        fileExists: () => false,
        migrationValidator: vi.fn(),
        prismaVersion: PINNED_PRISMA_VERSION,
        inspect: async () => invalid,
        resolve,
      }),
    ).rejects.toThrow(/partially applied catalog objects/);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("refuses Prisma dotenv files before validation or database access", async () => {
    const migrationValidator = vi.fn();
    const inspect = vi.fn();
    const resolve = vi.fn();
    await expect(
      runFailedMigrationResolve({
        argv: ["--apply", HEAD, FAILED_MIGRATION_TARGET],
        env: testEnv({
          VERCEL_ENV: "production",
          DIRECT_URL: "postgresql://owner:secret@ep-example.neon.tech/league",
        }),
        headSha: HEAD,
        status: "",
        fileExists: () => true,
        migrationValidator,
        prismaVersion: PINNED_PRISMA_VERSION,
        inspect,
        resolve,
      }),
    ).rejects.toThrow(/root \.env|prisma\/\.env/);
    expect(migrationValidator).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("redacts the direct URL and password from database failures", async () => {
    const directUrl =
      "postgresql://owner:top%2Fsecret@ep-example.neon.tech/league";
    const inspect = vi.fn(async () => {
      throw new Error(`connection ${directUrl} rejected top/secret`);
    });
    let failure: unknown;
    try {
      await runFailedMigrationResolve({
        argv: ["--apply", HEAD, FAILED_MIGRATION_TARGET],
        env: testEnv({ VERCEL_ENV: "production", DIRECT_URL: directUrl }),
        headSha: HEAD,
        status: "",
        fileExists: () => false,
        migrationValidator: vi.fn(),
        prismaVersion: PINNED_PRISMA_VERSION,
        inspect,
        resolve: vi.fn(),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain("[database URL]");
    expect(message).toContain("[password]");
    expect(message).not.toContain(directUrl);
    expect(message).not.toContain("top%2Fsecret");
    expect(message).not.toContain("top/secret");
  });
});
