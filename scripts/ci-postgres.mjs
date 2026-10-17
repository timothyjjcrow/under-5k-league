// CI's PostgreSQL, started by a workflow step rather than a `services:`
// container, from whichever of three registries serves the official image.
//
//   PG_TEST_URL=postgresql://postgres:postgres@localhost:5432/ld2l_test \
//     node scripts/ci-postgres.mjs
//
// Anonymous pulls fail on GitHub's shared runner IPs one registry at a time:
// Docker Hub's per-IP pull limit failed every Postgres job on 2026-10-09, and
// ECR Public's anonymous data cap ("Data limit exceeded") failed six on
// 2026-10-17. A service container pulls from one registry, three times a few
// seconds apart. This tries Google's Docker Hub mirror, then ECR Public, then
// Docker Hub, in three rounds 10 s and then 30 s apart. All three serve the
// same official image (one index digest) to anyone, so it needs no account or
// secret, and a fork's pull request pulls exactly as main does.
//
// It runs the image for the job's PG_TEST_URL (its user, password, database
// and port; localhost and the guards' test names only) and waits until the
// server accepts TCP connections. GitHub Actions only: it binds a Postgres
// port, and on the box that port is production's.
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { assertPostgresTestUrl } from "./test-db-safety.mjs";

export const POSTGRES_MAJOR = "18";
/** Registries that serve Docker's official image, in the order tried. */
export const SOURCES = Object.freeze([
  Object.freeze({ name: "mirror.gcr.io", image: `mirror.gcr.io/library/postgres:${POSTGRES_MAJOR}` }),
  Object.freeze({ name: "ECR Public", image: `public.ecr.aws/docker/library/postgres:${POSTGRES_MAJOR}` }),
  Object.freeze({ name: "Docker Hub", image: `docker.io/library/postgres:${POSTGRES_MAJOR}` }),
]);
/** The waits between rounds of pulls; each round tries every registry once. */
export const ROUND_WAITS_MS = Object.freeze([10_000, 30_000]);
const READY_ATTEMPTS = 90; // a second apart
const CONTAINER = "postgres";

/** The first non-empty line of a command's output. */
function firstLine(text) {
  return String(text ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "no output";
}

/** A GitHub workflow command, its message escaped so it stays one annotation. */
function annotation(level, message) {
  return `::${level}::${message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}`;
}

/**
 * Runs the docker CLI and returns {status, stdout, stderr}; `env` adds
 * variables to its environment (`docker run --env NAME` reads them).
 */
export function runDocker(args, { env = {}, timeout = 120_000 } = {}) {
  const result = spawnSync("docker", args, {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const error = result.error ? `${result.error.message}\n` : "";
  return { status: result.status, stdout: result.stdout ?? "", stderr: error + (result.stderr ?? "") };
}

async function pullFirstAvailable({ docker, wait, log }) {
  const failures = [];
  for (let round = 0; round <= ROUND_WAITS_MS.length; round += 1) {
    if (round > 0) {
      log(`No registry served the image; trying again in ${ROUND_WAITS_MS[round - 1] / 1000} s.`);
      await wait(ROUND_WAITS_MS[round - 1]);
    }
    for (const source of SOURCES) {
      log(`::group::docker pull ${source.image}`);
      const result = docker(["pull", source.image], { timeout: 180_000 });
      for (const output of [result.stdout, result.status === 0 ? "" : result.stderr]) {
        if (output.trim()) log(output.trimEnd());
      }
      log("::endgroup::");
      if (result.status === 0) {
        if (failures.length > 0) {
          log(annotation("warning", `Pulled PostgreSQL ${POSTGRES_MAJOR} from ${source.name} after ${failures.join("; ")}`));
        }
        return source;
      }
      failures.push(`${source.name}: ${firstLine(result.stderr)}`);
    }
  }
  const last = failures.slice(-SOURCES.length).join("; ");
  throw new Error(`Could not pull PostgreSQL ${POSTGRES_MAJOR} in ${ROUND_WAITS_MS.length + 1} rounds: ${last}`);
}

/**
 * Pulls the official PostgreSQL image, runs it for PG_TEST_URL and waits until
 * it accepts connections. Resolves {source, version, digest}; throws on failure.
 */
export async function startCiPostgres({
  env = process.env,
  docker = runDocker,
  wait = sleep,
  log = (line) => console.log(line),
} = {}) {
  if (env.GITHUB_ACTIONS !== "true") {
    throw new Error("scripts/ci-postgres.mjs runs only in GitHub Actions: it binds a Postgres port, and on the box that port is production's.");
  }
  const url = assertPostgresTestUrl(env.PG_TEST_URL);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("PG_TEST_URL must point at localhost, where this starts the container.");
  }
  const database = decodeURIComponent(url.pathname.slice(1));
  const user = decodeURIComponent(url.username) || "postgres";
  const password = decodeURIComponent(url.password);
  if (!password) throw new Error("PG_TEST_URL must carry the password the container starts with.");
  const port = url.port || "5432";

  const source = await pullFirstAvailable({ docker, wait, log });
  const started = docker(
    ["run", "--detach", "--name", CONTAINER, "--publish", `${port}:5432`,
      "--env", "POSTGRES_USER", "--env", "POSTGRES_PASSWORD", "--env", "POSTGRES_DB", source.image],
    { env: { POSTGRES_USER: user, POSTGRES_PASSWORD: password, POSTGRES_DB: database } },
  );
  if (started.status !== 0) throw new Error(`docker run ${source.image} failed: ${firstLine(started.stderr)}`);

  for (let attempt = 1; ; attempt += 1) {
    // Over TCP: the image's first-boot server, which creates the database,
    // listens on its socket only, then restarts.
    const ready = docker(
      ["exec", CONTAINER, "pg_isready", "--host", "127.0.0.1", "--port", "5432", "--username", user, "--dbname", database],
      { timeout: 15_000 },
    );
    if (ready.status === 0) break;
    const running = docker(["inspect", "--format", "{{.State.Running}}", CONTAINER]).stdout.trim() === "true";
    if (!running || attempt >= READY_ATTEMPTS) {
      const logs = docker(["logs", CONTAINER]);
      log(`::group::docker logs ${CONTAINER}`);
      log(`${logs.stdout}${logs.stderr}`.trimEnd());
      log("::endgroup::");
      throw new Error(running
        ? `PostgreSQL did not accept connections within ${READY_ATTEMPTS} s.`
        : "The PostgreSQL container exited before accepting connections; its log is above.");
    }
    await wait(1_000);
  }

  const shown = docker(
    ["exec", CONTAINER, "psql", "--username", user, "--dbname", database, "--no-align", "--tuples-only", "--command", "SHOW server_version"],
    { timeout: 15_000 },
  );
  const version = shown.stdout.trim();
  if (/^\d+/.exec(version)?.[0] !== POSTGRES_MAJOR) {
    throw new Error(`${source.image} runs PostgreSQL ${version || `(unknown: ${firstLine(shown.stderr)})`}, not ${POSTGRES_MAJOR}.`);
  }
  const digest = docker(["image", "inspect", "--format", "{{join .RepoDigests \" \"}}", source.image]).stdout.trim();
  log(`PostgreSQL ${version} from ${source.name} (${digest || source.image}) accepts connections at localhost:${port}/${database}.`);
  return { source, version, digest };
}

async function main() {
  try {
    await startCiPostgres();
  } catch (error) {
    console.log(annotation("error", error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
