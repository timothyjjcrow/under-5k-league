import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DOCKER_HUB, ECR_PUBLIC, ROUND_WAITS_MS, fromAnotherRepository, startCiPostgres } from "./ci-postgres.mjs";

const TOKEN = "dckr_pat_fixture-0123456789abcdef";
const SIGNED_IN = { DOCKERHUB_USERNAME: "ggd2l", DOCKERHUB_TOKEN: TOKEN };
const THROTTLED = "Error response from daemon: toomanyrequests: Data limit exceeded";
const result = (status, stdout = "", stderr = "") => ({ status, stdout, stderr });
const pullRequest = (head) => ({
  pull_request: { head: { repo: { full_name: head } }, base: { repo: { full_name: "timothyjjcrow/under-5k-league" } } },
});

// A docker CLI in memory. `pulls` answers each `docker pull` of an image in
// turn (an unlisted pull fails), `login` and `ready` each attempt in turn.
function fakeDocker({ login = [0], pulls = {}, ready = [0], running = "true", version = "18.6 (Debian 18.6-1.pgdg13+1)" }) {
  const calls = [];
  const queues = { login: [...login], ready: [...ready], ...Object.fromEntries(Object.entries(pulls).map(([image, answers]) => [image, [...answers]])) };
  const docker = (args, options = {}) => {
    calls.push({ args, ...options });
    const [command, ...rest] = args;
    if (command === "login") return result(queues.login.shift() ?? 0, "", "unauthorized: incorrect username or password");
    if (command === "pull") {
      const status = queues[rest[0]]?.shift() ?? 1;
      return status === 0 ? result(0, `Status: Downloaded newer image for ${rest[0]}\n`) : result(status, "", THROTTLED);
    }
    if (command === "run") return result(0, "c0ffee\n");
    if (command === "exec" && rest[1] === "pg_isready") return result(queues.ready.shift() ?? 0);
    if (command === "exec" && rest[1] === "psql") return result(0, `${version}\n`);
    if (command === "inspect") return result(0, `${running}\n`);
    if (command === "logs") return result(0, "", "FATAL:  could not create shared memory segment\n");
    if (command === "image") return result(0, "postgres@sha256:74935e72241653ca\n");
    throw new Error(`unexpected docker ${args.join(" ")}`);
  };
  return { docker, calls };
}

function scenario(t, { env = {}, event, ...answers } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "ci-postgres-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runnerTemp = path.join(dir, "runner");
  mkdirSync(runnerTemp);
  const eventPath = path.join(dir, "event.json");
  if (event) writeFileSync(eventPath, JSON.stringify(event));
  const { docker, calls } = fakeDocker(answers);
  const lines = [];
  const waits = [];
  const run = () => startCiPostgres({
    env: {
      GITHUB_ACTIONS: "true",
      RUNNER_TEMP: runnerTemp,
      PG_TEST_URL: "postgresql://postgres:postgres@localhost:5432/ld2l_test",
      GITHUB_EVENT_NAME: event ? "pull_request" : "push",
      GITHUB_EVENT_PATH: event ? eventPath : "",
      ...env,
    },
    docker,
    wait: async (ms) => { waits.push(ms); },
    log: (line) => lines.push(line),
  });
  const pulled = () => calls.filter((call) => call.args[0] === "pull").map((call) => call.args[1]);
  const warnings = () => lines.filter((line) => line.startsWith("::warning::"));
  return { run, calls, lines, waits, runnerTemp, pulled, warnings };
}

test("signed in, it pulls from Docker Hub, the token only on docker login's stdin, then deletes that config", async (t) => {
  const s = scenario(t, { env: SIGNED_IN, pulls: { [DOCKER_HUB.image]: [0] } });
  const { source, version } = await s.run();
  assert.equal(source, DOCKER_HUB);
  assert.equal(version, "18.6 (Debian 18.6-1.pgdg13+1)");
  const [login, pull] = s.calls;
  assert.deepEqual(login.args, ["login", "--username", "ggd2l", "--password-stdin"]);
  assert.equal(login.input, TOKEN);
  assert.deepEqual(pull.args, ["pull", DOCKER_HUB.image]);
  assert.ok(login.config.startsWith(s.runnerTemp) && pull.config === login.config);
  assert.deepEqual(readdirSync(s.runnerTemp), [], "the throwaway DOCKER_CONFIG is gone");
  for (const call of s.calls.slice(2)) assert.equal(call.config, undefined, "nothing after the pull sees the sign-in");
  for (const call of s.calls) assert.ok(!JSON.stringify(call.args).includes(TOKEN) && (call === login || call.input === undefined));
  assert.ok(!s.lines.join("\n").includes(TOKEN));
  assert.deepEqual(s.warnings(), []);
  // The services' container: the URL's port, user, password and database,
  // passed by name so no value is in the arguments.
  const run = s.calls.find((call) => call.args[0] === "run");
  assert.deepEqual(run.args, ["run", "--detach", "--name", "postgres", "--publish", "5432:5432",
    "--env", "POSTGRES_USER", "--env", "POSTGRES_PASSWORD", "--env", "POSTGRES_DB", DOCKER_HUB.image]);
  assert.deepEqual(run.env, { POSTGRES_USER: "postgres", POSTGRES_PASSWORD: "postgres", POSTGRES_DB: "ld2l_test" });
});

test("a fork's pull request, which gets no secrets, pulls anonymously from ECR Public without a warning", async (t) => {
  const s = scenario(t, { event: pullRequest("someone/under-5k-league"), pulls: { [ECR_PUBLIC.image]: [0] } });
  assert.equal((await s.run()).source, ECR_PUBLIC);
  assert.ok(!s.calls.some((call) => call.args[0] === "login"));
  assert.deepEqual(s.pulled(), [ECR_PUBLIC.image]);
  assert.deepEqual(s.warnings(), []);
  assert.ok(s.lines.includes("A pull request from a fork gets no secrets, so this pulls anonymously."));
});

test("anywhere else a missing sign-in warns which setting is missing, then pulls anonymously", async (t) => {
  for (const [env, missing] of [
    [{}, "the DOCKERHUB_USERNAME variable and the DOCKERHUB_TOKEN secret are not set"],
    [{ DOCKERHUB_USERNAME: "ggd2l" }, "the DOCKERHUB_TOKEN secret is not set"],
    [{ DOCKERHUB_TOKEN: TOKEN }, "the DOCKERHUB_USERNAME variable is not set"],
  ]) {
    const s = scenario(t, { env, pulls: { [ECR_PUBLIC.image]: [0] } });
    assert.equal((await s.run()).source, ECR_PUBLIC);
    assert.ok(!s.calls.some((call) => call.args[0] === "login"));
    assert.equal(s.warnings().length, 1);
    assert.ok(s.warnings()[0].includes(`No Docker Hub sign-in: ${missing}`), s.warnings()[0]);
    assert.ok(!s.lines.join("\n").includes(TOKEN));
  }
  // A pull request from one of this repository's own branches has secrets.
  const own = scenario(t, { event: pullRequest("timothyjjcrow/under-5k-league"), pulls: { [ECR_PUBLIC.image]: [0] } });
  await own.run();
  assert.equal(own.warnings().length, 1);
  assert.equal(fromAnotherRepository({ GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: "event.json" }, () => "not json"), false);
});

test("a refused registry falls through to the other at once; a round that both refuse waits 10 s, then 30 s", async (t) => {
  const s = scenario(t, { env: SIGNED_IN, pulls: { [DOCKER_HUB.image]: [1, 1], [ECR_PUBLIC.image]: [1, 0] } });
  assert.equal((await s.run()).source, ECR_PUBLIC);
  assert.deepEqual(s.pulled(), [DOCKER_HUB.image, ECR_PUBLIC.image, DOCKER_HUB.image, ECR_PUBLIC.image]);
  assert.deepEqual(s.waits, [ROUND_WAITS_MS[0]]);
  assert.equal(s.warnings().length, 1);
  assert.match(s.warnings()[0], /^::warning::Pulled PostgreSQL 18 from ECR Public after Docker Hub: .*toomanyrequests/);

  const lost = scenario(t, { env: SIGNED_IN });
  await assert.rejects(lost.run(), /Could not pull PostgreSQL 18 in 3 rounds: Docker Hub: .*toomanyrequests.*; ECR Public: .*toomanyrequests/);
  assert.equal(lost.pulled().length, 6);
  assert.deepEqual(lost.waits, [10_000, 30_000]);
  assert.deepEqual(readdirSync(lost.runnerTemp), [], "a failed pull still deletes the sign-in");
  assert.ok(!lost.calls.some((call) => call.args[0] === "run"));
});

test("a sign-in Docker Hub refuses is tried twice, then it pulls anonymously, ECR Public first, with a warning", async (t) => {
  const s = scenario(t, { env: SIGNED_IN, login: [1, 1], pulls: { [ECR_PUBLIC.image]: [0] } });
  assert.equal((await s.run()).source, ECR_PUBLIC);
  assert.equal(s.calls.filter((call) => call.args[0] === "login").length, 2);
  assert.deepEqual(s.waits, [5_000]);
  assert.deepEqual(s.pulled(), [ECR_PUBLIC.image]);
  assert.match(s.warnings()[0], /^::warning::Could not sign in to Docker Hub as ggd2l, .*DOCKERHUB_TOKEN/);
});

test("it refuses to run outside GitHub Actions or for any database, host or URL the guards don't accept", async (t) => {
  for (const env of [
    { GITHUB_ACTIONS: "" },
    { PG_TEST_URL: "postgresql://postgres:postgres@localhost:5432/ggd2l_us" },
    { PG_TEST_URL: "postgresql://postgres:postgres@db.example:5432/ld2l_test" },
    { PG_TEST_URL: "postgresql://postgres@localhost:5432/ld2l_test" },
    { PG_TEST_URL: "" },
  ]) {
    const s = scenario(t, { env: { ...SIGNED_IN, ...env } });
    await assert.rejects(s.run());
    assert.deepEqual(s.calls, [], JSON.stringify(env));
  }
});

test("it waits until the server takes TCP connections, and shows the container's log when it exits first", async (t) => {
  const s = scenario(t, { env: SIGNED_IN, pulls: { [DOCKER_HUB.image]: [0] }, ready: [2, 2, 0] });
  await s.run();
  assert.deepEqual(s.waits, [1_000, 1_000]);
  assert.deepEqual(s.calls.find((call) => call.args[2] === "pg_isready").args,
    ["exec", "postgres", "pg_isready", "--host", "127.0.0.1", "--port", "5432", "--username", "postgres", "--dbname", "ld2l_test"]);

  const exited = scenario(t, { env: SIGNED_IN, pulls: { [DOCKER_HUB.image]: [0] }, ready: [2], running: "false" });
  await assert.rejects(exited.run(), /exited before accepting connections/);
  assert.ok(exited.lines.some((line) => line.includes("could not create shared memory segment")));
});

test("it refuses an image that runs another major", async (t) => {
  const s = scenario(t, { env: SIGNED_IN, pulls: { [DOCKER_HUB.image]: [0] }, version: "17.6 (Debian 17.6-1.pgdg13+1)" });
  await assert.rejects(s.run(), /runs PostgreSQL 17\.6 .*not 18/);
});
