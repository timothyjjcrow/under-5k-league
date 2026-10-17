// CI's PostgreSQL, started by a workflow step rather than a `services:`
// container, and signed in to Docker Hub when the repository has a token.
//
//   PG_TEST_URL=postgresql://postgres:postgres@localhost:5432/ld2l_test \
//     node scripts/ci-postgres.mjs
//
// Anonymous pulls fail on GitHub's shared runner IPs at both registries that
// carry the official image: Docker Hub's per-IP pull limit failed every
// Postgres job on 2026-10-09, and ECR Public's anonymous data cap ("Data limit
// exceeded") failed six on 2026-10-17. A signed-in pull counts against the
// account instead. A service container can't sign in and still serve a pull
// request from a fork, which gets no secrets: its `image` can't read secrets,
// its `credentials` must be non-empty, and it tries three pulls in about 10 s.
//
// So with the DOCKERHUB_USERNAME variable and the DOCKERHUB_TOKEN secret this
// signs in and pulls from Docker Hub, then ECR Public; without them (a fork),
// from ECR Public, then Docker Hub anonymously. Both serve the same official
// image (identical digest). It tries that list three times, 10 s and then 30 s
// apart, runs the image for the job's PG_TEST_URL (its user, password,
// database and port; localhost and the guards' test names only) and waits
// until the server accepts TCP connections.
//
// The token reaches only `docker login`'s stdin, in a throwaway DOCKER_CONFIG
// deleted once the image is pulled, so no later step can read it. GitHub
// Actions only: it binds a Postgres port, and on the box that is production's.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { assertPostgresTestUrl } from "./test-db-safety.mjs";

export const POSTGRES_MAJOR = "18";
export const DOCKER_HUB = Object.freeze({ name: "Docker Hub", image: `docker.io/library/postgres:${POSTGRES_MAJOR}` });
export const ECR_PUBLIC = Object.freeze({
  name: "ECR Public",
  image: `public.ecr.aws/docker/library/postgres:${POSTGRES_MAJOR}`,
});
/** The waits between rounds of pulls; each round tries every registry once. */
export const ROUND_WAITS_MS = Object.freeze([10_000, 30_000]);
const LOGIN_ATTEMPTS = 2;
const LOGIN_WAIT_MS = 5_000;
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
 * Runs the docker CLI and returns {status, stdout, stderr}. The child never
 * inherits the Docker Hub variables; `input` is its stdin, `config` its
 * DOCKER_CONFIG and `env` extra variables (`docker run --env NAME` reads them).
 */
export function runDocker(args, { input, config, env = {}, timeout = 120_000 } = {}) {
  const childEnv = { ...process.env, ...env };
  delete childEnv.DOCKERHUB_USERNAME;
  delete childEnv.DOCKERHUB_TOKEN;
  if (config) childEnv.DOCKER_CONFIG = config;
  const result = spawnSync("docker", args, {
    input,
    env: childEnv,
    encoding: "utf8",
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  const error = result.error ? `${result.error.message}\n` : "";
  return { status: result.status, stdout: result.stdout ?? "", stderr: error + (result.stderr ?? "") };
}

/** The Docker Hub sign-in from the step's environment, or which half is missing. */
export function dockerHubCredentials(env) {
  const username = env.DOCKERHUB_USERNAME ?? "";
  const token = env.DOCKERHUB_TOKEN ?? "";
  if (username && token) return { username, token };
  const missing = [!username && "the DOCKERHUB_USERNAME variable", !token && "the DOCKERHUB_TOKEN secret"];
  return { missing: missing.filter(Boolean) };
}

/** A pull request from another repository, which GitHub runs without secrets. */
export function fromAnotherRepository(env, read = (file) => readFileSync(file, "utf8")) {
  if (env.GITHUB_EVENT_NAME !== "pull_request" || !env.GITHUB_EVENT_PATH) return false;
  try {
    const pr = JSON.parse(read(env.GITHUB_EVENT_PATH)).pull_request;
    return Boolean(pr) && pr.head?.repo?.full_name !== pr.base?.repo?.full_name;
  } catch {
    return false;
  }
}

async function signIn({ username, token }, { docker, wait, log, config }) {
  for (let attempt = 1; attempt <= LOGIN_ATTEMPTS; attempt += 1) {
    const result = docker(["login", "--username", username, "--password-stdin"], { input: token, config });
    if (result.status === 0) {
      log(`Signed in to Docker Hub as ${username}.`);
      return true;
    }
    log(`docker login failed: ${firstLine(result.stderr)}`);
    if (attempt < LOGIN_ATTEMPTS) await wait(LOGIN_WAIT_MS);
  }
  return false;
}

async function pullFirstAvailable(sources, { docker, wait, log, config }) {
  const failures = [];
  for (let round = 0; round <= ROUND_WAITS_MS.length; round += 1) {
    if (round > 0) {
      log(`No registry served the image; trying again in ${ROUND_WAITS_MS[round - 1] / 1000} s.`);
      await wait(ROUND_WAITS_MS[round - 1]);
    }
    for (const source of sources) {
      log(`::group::docker pull ${source.image}`);
      const result = docker(["pull", source.image], { config, timeout: 180_000 });
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
  const last = failures.slice(-sources.length).join("; ");
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
  readEvent,
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

  const config = mkdtempSync(path.join(env.RUNNER_TEMP || tmpdir(), "docker-config-"));
  let source;
  try {
    let sources = [ECR_PUBLIC, DOCKER_HUB];
    const credentials = dockerHubCredentials(env);
    if (credentials.token) {
      if (await signIn(credentials, { docker, wait, log, config })) sources = [DOCKER_HUB, ECR_PUBLIC];
      else log(annotation("warning", `Could not sign in to Docker Hub as ${credentials.username}, so this pulls anonymously, which shared runner IPs can exhaust. Check the DOCKERHUB_TOKEN secret.`));
    } else if (fromAnotherRepository(env, readEvent)) {
      log("A pull request from a fork gets no secrets, so this pulls anonymously.");
    } else {
      const verb = credentials.missing.length > 1 ? "are" : "is";
      log(annotation("warning", `No Docker Hub sign-in: ${credentials.missing.join(" and ")} ${verb} not set, so this pulls anonymously, which shared runner IPs can exhaust.`));
    }
    source = await pullFirstAvailable(sources, { docker, wait, log, config });
  } finally {
    rmSync(config, { recursive: true, force: true });
  }

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
