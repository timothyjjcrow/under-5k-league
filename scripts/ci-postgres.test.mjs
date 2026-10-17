import { test } from "node:test";
import assert from "node:assert/strict";
import { ROUND_WAITS_MS, SOURCES, startCiPostgres } from "./ci-postgres.mjs";

const [GOOGLE, ECR, HUB] = SOURCES.map((source) => source.image);
const THROTTLED = "Error response from daemon: toomanyrequests: Data limit exceeded";
const result = (status, stdout = "", stderr = "") => ({ status, stdout, stderr });

// A docker CLI in memory. `pulls` answers each `docker pull` of an image in
// turn (an unlisted pull fails), `ready` each readiness probe in turn.
function fakeDocker({ pulls = {}, ready = [0], running = "true", version = "18.6 (Debian 18.6-1.pgdg13+1)" }) {
  const calls = [];
  const queues = { ready: [...ready], ...Object.fromEntries(Object.entries(pulls).map(([image, answers]) => [image, [...answers]])) };
  const docker = (args, options = {}) => {
    calls.push({ args, ...options });
    const [command, ...rest] = args;
    if (command === "pull") {
      const status = queues[rest[0]]?.shift() ?? 1;
      return status === 0 ? result(0, `Status: Downloaded newer image for ${rest[0]}\n`) : result(status, "", THROTTLED);
    }
    if (command === "run") return result(0, "c0ffee\n");
    if (command === "exec" && rest[1] === "pg_isready") return result(queues.ready.shift() ?? 0);
    if (command === "exec" && rest[1] === "psql") return result(0, `${version}\n`);
    if (command === "inspect") return result(0, `${running}\n`);
    if (command === "logs") return result(0, "", "FATAL:  could not create shared memory segment\n");
    if (command === "image") return result(0, "mirror.gcr.io/library/postgres@sha256:74935e72241653ca\n");
    throw new Error(`unexpected docker ${args.join(" ")}`);
  };
  return { docker, calls };
}

function scenario({ env = {}, ...answers } = {}) {
  const { docker, calls } = fakeDocker(answers);
  const lines = [];
  const waits = [];
  const run = () => startCiPostgres({
    env: { GITHUB_ACTIONS: "true", PG_TEST_URL: "postgresql://postgres:postgres@localhost:5432/ld2l_test", ...env },
    docker,
    wait: async (ms) => { waits.push(ms); },
    log: (line) => lines.push(line),
  });
  const pulled = () => calls.filter((call) => call.args[0] === "pull").map((call) => call.args[1]);
  const warnings = () => lines.filter((line) => line.startsWith("::warning::"));
  return { run, calls, lines, waits, pulled, warnings };
}

test("it pulls the official image anonymously, Google's mirror first, and runs it the way the services did", async () => {
  const s = scenario({ pulls: { [GOOGLE]: [0] } });
  const { source, version } = await s.run();
  assert.equal(source, SOURCES[0]);
  assert.equal(version, "18.6 (Debian 18.6-1.pgdg13+1)");
  assert.deepEqual(SOURCES.map((registry) => registry.name), ["mirror.gcr.io", "ECR Public", "Docker Hub"]);
  assert.deepEqual(s.pulled(), [GOOGLE]);
  assert.deepEqual(s.calls.map((call) => call.args[0]), ["pull", "run", "exec", "exec", "image"], "no docker login");
  assert.deepEqual(s.warnings(), []);
  // The URL's port, user, password and database, passed by name so no value
  // is in the arguments.
  const run = s.calls.find((call) => call.args[0] === "run");
  assert.deepEqual(run.args, ["run", "--detach", "--name", "postgres", "--publish", "5432:5432",
    "--env", "POSTGRES_USER", "--env", "POSTGRES_PASSWORD", "--env", "POSTGRES_DB", GOOGLE]);
  assert.deepEqual(run.env, { POSTGRES_USER: "postgres", POSTGRES_PASSWORD: "postgres", POSTGRES_DB: "ld2l_test" });
  assert.match(s.lines.at(-1), /^PostgreSQL 18\.6 .* from mirror\.gcr\.io \(mirror\.gcr\.io\/library\/postgres@sha256:74935e72241653ca\) accepts connections at localhost:5432\/ld2l_test\.$/);
});

test("a refused registry falls through to the next at once; a round that all refuse waits 10 s, then 30 s", async () => {
  const s = scenario({ pulls: { [GOOGLE]: [1, 1], [ECR]: [1, 1], [HUB]: [1, 0] } });
  assert.equal((await s.run()).source, SOURCES[2]);
  assert.deepEqual(s.pulled(), [GOOGLE, ECR, HUB, GOOGLE, ECR, HUB]);
  assert.deepEqual(s.waits, [ROUND_WAITS_MS[0]]);
  assert.equal(s.warnings().length, 1);
  assert.match(s.warnings()[0], /^::warning::Pulled PostgreSQL 18 from Docker Hub after mirror\.gcr\.io: .*toomanyrequests.*; ECR Public: /);

  const lost = scenario();
  await assert.rejects(lost.run(), /Could not pull PostgreSQL 18 in 3 rounds: mirror\.gcr\.io: .*toomanyrequests.*; ECR Public: .*; Docker Hub: .*toomanyrequests/);
  assert.equal(lost.pulled().length, 9);
  assert.deepEqual(lost.waits, [10_000, 30_000]);
  assert.ok(!lost.calls.some((call) => call.args[0] === "run"));
});

test("it refuses to run outside GitHub Actions or for any database, host or URL the guards don't accept", async () => {
  for (const env of [
    { GITHUB_ACTIONS: "" },
    { PG_TEST_URL: "postgresql://postgres:postgres@localhost:5432/ggd2l_us" },
    { PG_TEST_URL: "postgresql://postgres:postgres@db.example:5432/ld2l_test" },
    { PG_TEST_URL: "postgresql://postgres@localhost:5432/ld2l_test" },
    { PG_TEST_URL: "" },
  ]) {
    const s = scenario({ env });
    await assert.rejects(s.run());
    assert.deepEqual(s.calls, [], JSON.stringify(env));
  }
});

test("it waits until the server takes TCP connections, and shows the container's log when it exits first", async () => {
  const s = scenario({ pulls: { [GOOGLE]: [0] }, ready: [2, 2, 0], env: { PG_TEST_URL: "postgresql://postgres:postgres@localhost:5432/ld2l_pgtest" } });
  await s.run();
  assert.deepEqual(s.waits, [1_000, 1_000]);
  assert.deepEqual(s.calls.find((call) => call.args[2] === "pg_isready").args,
    ["exec", "postgres", "pg_isready", "--host", "127.0.0.1", "--port", "5432", "--username", "postgres", "--dbname", "ld2l_pgtest"]);

  const exited = scenario({ pulls: { [GOOGLE]: [0] }, ready: [2], running: "false" });
  await assert.rejects(exited.run(), /exited before accepting connections/);
  assert.ok(exited.lines.some((line) => line.includes("could not create shared memory segment")));
});

test("it refuses an image that runs another major", async () => {
  const s = scenario({ pulls: { [GOOGLE]: [0] }, version: "17.6 (Debian 17.6-1.pgdg13+1)" });
  await assert.rejects(s.run(), /runs PostgreSQL 17\.6 .*not 18/);
});
