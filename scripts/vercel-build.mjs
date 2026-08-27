import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { productionEnvironmentRequired } from "./vercel-environment.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCHEMA = fileURLToPath(
  new URL("../prisma/schema.prisma", import.meta.url),
);
const PREVIEW_DATABASE_URL =
  "postgresql://preview_build:preview_build@127.0.0.1:1/preview_build";

export const VERCEL_BUILD_STEPS = Object.freeze([
  Object.freeze({
    id: "validate-environment",
    executable: "node",
    args: Object.freeze(["scripts/validate-prod-env.mjs"]),
  }),
  Object.freeze({
    id: "switch-provider",
    executable: "node",
    args: Object.freeze(["scripts/switch-db-provider.mjs", "postgresql"]),
  }),
  Object.freeze({
    id: "validate-migrations",
    executable: "npm",
    args: Object.freeze(["run", "db:migrate:validate"]),
  }),
  Object.freeze({
    id: "generate-client",
    executable: "node",
    args: Object.freeze(["node_modules/prisma/build/index.js", "generate"]),
  }),
  Object.freeze({
    id: "attest-production-schema",
    executable: "node",
    args: Object.freeze(["scripts/production-schema-check.mjs"]),
  }),
  Object.freeze({
    id: "build-application",
    executable: "node",
    args: Object.freeze(["node_modules/next/dist/bin/next", "build"]),
  }),
]);

export function vercelBuildEnvironment(env) {
  if (productionEnvironmentRequired(env)) return env;

  // Prisma validate/generate require syntactically valid datasource URLs even
  // though preview/development builds never connect through the release gate.
  // Preserve separately scoped preview credentials when present; otherwise an
  // inert loopback URL lets code generation proceed without production access.
  const databaseUrl = env.DATABASE_URL || PREVIEW_DATABASE_URL;
  return {
    ...env,
    DATABASE_URL: databaseUrl,
    DIRECT_URL: env.DIRECT_URL || databaseUrl,
  };
}

function executableFor(step) {
  return step.executable === "node" ? process.execPath : step.executable;
}

export function runVercelBuild({
  env = process.env,
  execute = execFileSync,
} = {}) {
  const childEnv = vercelBuildEnvironment(env);
  const originalSchema = readFileSync(SCHEMA, "utf8");

  try {
    for (const step of VERCEL_BUILD_STEPS) {
      console.log(`Vercel build: ${step.id}`);
      execute(executableFor(step), [...step.args], {
        cwd: ROOT,
        env: childEnv,
        stdio: "inherit",
      });
    }
  } finally {
    if (readFileSync(SCHEMA, "utf8") !== originalSchema) {
      writeFileSync(SCHEMA, originalSchema);
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    runVercelBuild();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
