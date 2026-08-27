import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCHEMA = fileURLToPath(
  new URL("../prisma/schema.prisma", import.meta.url),
);
export const PRISMA_DOTENV_PATHS = Object.freeze([
  Object.freeze({
    label: "root .env",
    path: fileURLToPath(new URL("../.env", import.meta.url)),
  }),
  Object.freeze({
    label: "prisma/.env",
    path: fileURLToPath(new URL("../prisma/.env", import.meta.url)),
  }),
]);

export const MIGRATION_RELEASE_STEPS = Object.freeze([
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
    id: "preflight",
    executable: "npm",
    args: Object.freeze(["run", "db:migrate:preflight"]),
  }),
  Object.freeze({
    id: "deploy",
    executable: "node",
    args: Object.freeze([
      "node_modules/prisma/build/index.js",
      "migrate",
      "deploy",
    ]),
  }),
  Object.freeze({
    id: "postflight",
    executable: "npm",
    args: Object.freeze(["run", "db:migrate:postflight"]),
  }),
]);

export function authorizeMigrationRelease({ argv, env, headSha, status }) {
  if (
    argv.length !== 2 ||
    argv[0] !== "--apply" ||
    !/^[0-9a-f]{40}$/.test(argv[1] ?? "")
  ) {
    throw new Error(
      "Usage: npm run db:migrate:release -- --apply <40-character-current-HEAD-sha>",
    );
  }
  if (env.VERCEL_ENV !== "production") {
    throw new Error(
      "Migration release requires VERCEL_ENV=production; preview, development, and unset environments are read-only",
    );
  }
  if (!/^[0-9a-f]{40}$/.test(headSha)) {
    throw new Error("Could not resolve the current 40-character Git HEAD SHA");
  }
  if (argv[1] !== headSha) {
    throw new Error(
      `Migration release approval SHA does not match current HEAD ${headSha}`,
    );
  }
  if (status.trim()) {
    throw new Error(
      "Migration release requires a clean checkout with no staged, unstaged, or untracked files",
    );
  }
  return headSha;
}

export function assertNoPrismaDotenvFiles(fileExists = existsSync) {
  const found = PRISMA_DOTENV_PATHS.filter(({ path }) => fileExists(path));
  if (found.length > 0) {
    throw new Error(
      `Migration release refuses Prisma auto-loaded dotenv files (${found
        .map(({ label }) => label)
        .join(", ")}); supply production credentials only through the trusted process environment`,
    );
  }
}

function gitOutput(args) {
  return execFileSync("git", ["-C", ROOT, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function executableFor(step) {
  return step.executable === "node" ? process.execPath : step.executable;
}

export function runMigrationRelease({
  argv = process.argv.slice(2),
  env = process.env,
  execute = execFileSync,
} = {}) {
  let headSha;
  let status;
  try {
    headSha = gitOutput(["rev-parse", "HEAD"]);
    status = gitOutput(["status", "--porcelain=v1", "--untracked-files=all"]);
  } catch {
    throw new Error("Migration release must run from a valid Git checkout");
  }
  const approvedSha = authorizeMigrationRelease({ argv, env, headSha, status });
  assertNoPrismaDotenvFiles();
  const originalSchema = readFileSync(SCHEMA, "utf8");

  try {
    for (const step of MIGRATION_RELEASE_STEPS) {
      console.log(`Migration release: ${step.id}`);
      execute(executableFor(step), [...step.args], {
        cwd: ROOT,
        env,
        stdio: "inherit",
      });
    }
  } finally {
    if (readFileSync(SCHEMA, "utf8") !== originalSchema) {
      writeFileSync(SCHEMA, originalSchema);
    }
  }

  console.log(`Migration release completed for ${approvedSha}.`);
  return approvedSha;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    runMigrationRelease();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
