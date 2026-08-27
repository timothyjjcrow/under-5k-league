import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  VERCEL_BUILD_STEPS,
  vercelBuildEnvironment,
} from "../../scripts/vercel-build.mjs";

describe("Vercel build database boundary", () => {
  it("keeps the production migration gate read-only and attests the full schema after client generation", () => {
    const config = JSON.parse(
      readFileSync(path.resolve(process.cwd(), "vercel.json"), "utf8"),
    ) as { buildCommand: string };
    const manifest = JSON.parse(
      readFileSync(path.resolve(process.cwd(), "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(config.buildCommand).toBe("npm run build:vercel");
    expect(manifest.scripts["build:vercel"]).toBe(
      "node scripts/vercel-build.mjs",
    );
    expect(VERCEL_BUILD_STEPS.map((step) => step.id)).toEqual([
      "validate-environment",
      "switch-provider",
      "validate-migrations",
      "generate-client",
      "attest-production-schema",
      "build-application",
    ]);
  });

  it("contains no migration writer or preflight stage", () => {
    const build = VERCEL_BUILD_STEPS.map((step) => step.args.join(" ")).join(
      "\n",
    );

    expect(build).not.toContain("migrate deploy");
    expect(build).not.toContain("db:push");
    expect(build).not.toContain("db:backup");
    expect(build).not.toContain("db:migrate:preflight");
    expect(build).toContain("production-schema-check.mjs");
    expect(build).not.toContain("scheduler:");
    expect(build).not.toContain("release-migrations");
    expect(build).not.toContain("build-db");
  });

  it("exposes migration writes only through the explicit release command", () => {
    const manifest = JSON.parse(
      readFileSync(path.resolve(process.cwd(), "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(manifest.scripts["db:migrate:release"]).toBe(
      "node scripts/release-migrations.mjs",
    );
    expect(
      Object.entries(manifest.scripts)
        .filter(([name]) => name !== "db:migrate:release")
        .map(([, command]) => command)
        .join("\n"),
    ).not.toContain("release-migrations.mjs");
  });

  it("skips schema attestation for preview builds without opening a database", () => {
    const output = execFileSync(
      process.execPath,
      [path.resolve(process.cwd(), "scripts/production-schema-check.mjs")],
      {
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "production",
          VERCEL_ENV: "preview",
        },
        encoding: "utf8",
      },
    );

    expect(output).toContain("schema attestation skipped");
  });

  it("uses inert loopback datasource values only when a non-production build has none", () => {
    const preview = vercelBuildEnvironment({
      NODE_ENV: "production",
      VERCEL_ENV: "preview",
    });
    expect(preview.DATABASE_URL).toMatch(
      /^postgresql:\/\/preview_build:preview_build@127\.0\.0\.1:1\//,
    );
    expect(preview.DIRECT_URL).toBe(preview.DATABASE_URL);

    const configured = vercelBuildEnvironment({
      NODE_ENV: "production",
      VERCEL_ENV: "preview",
      DATABASE_URL: "postgresql://preview:runtime@preview.example/league",
      DIRECT_URL: "postgresql://preview:direct@preview.example/league",
    });
    expect(configured.DATABASE_URL).toContain("preview.example");
    expect(configured.DIRECT_URL).toContain("preview.example");

    const production: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      VERCEL_ENV: "production",
      DATABASE_URL: "postgresql://production:runtime@prod.example/league",
      DIRECT_URL: "postgresql://production:direct@prod.example/league",
    };
    expect(vercelBuildEnvironment(production)).toBe(production);
  });
});
