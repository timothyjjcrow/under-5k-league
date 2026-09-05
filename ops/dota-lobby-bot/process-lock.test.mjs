import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { lockingCommand } from "./process-lock.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "dota-process-lock-"));
  const script = join(directory, "worker.mjs");
  const stateDir = join(directory, "state");
  const processes = [];
  writeFileSync(script, `
import { runWithProcessLock } from ${JSON.stringify(new URL("./process-lock.mjs", import.meta.url).href)};
try {
  await runWithProcessLock(process.argv[2]);
  process.on("SIGTERM", () => process.exit(0));
  process.send({ ready: true, pid: process.pid });
  setInterval(() => {}, 1000);
} catch (error) {
  process.send({ ready: false, error: error.message });
  process.exit(2);
}
`);
  t.after(() => {
    for (const child of processes) { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    stateDir,
    start: async () => {
      const child = spawn(process.execPath, [script, stateDir], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
      processes.push(child);
      const exited = once(child, "exit");
      const [message] = await once(child, "message");
      return { child, exited, message };
    },
  };
}

test("a second process is rejected and SIGKILL releases the lock without deleting its file", { timeout: 10_000, skip: !["darwin", "linux"].includes(process.platform) }, async (t) => {
  const run = fixture(t);
  const first = await run.start();
  assert.equal(first.message.ready, true);
  const marker = join(run.stateDir, "worker.lock");
  const osLock = join(run.stateDir, "worker.os-lock");
  assert.equal(JSON.parse(readFileSync(marker, "utf8")).pid, first.child.pid);
  const inode = statSync(osLock).ino;
  assert.equal(statSync(run.stateDir).mode & 0o777, 0o700);
  assert.equal(statSync(osLock).mode & 0o777, 0o600);
  assert.equal(statSync(marker).mode & 0o777, 0o600);
  const second = await run.start();
  assert.equal(second.message.ready, false);
  assert.match(second.message.error, /already running/);
  assert.equal((await second.exited)[0], 2);
  first.child.kill("SIGKILL");
  await first.exited;
  assert.equal(existsSync(marker), true);
  const recovered = await run.start();
  assert.equal(recovered.message.ready, true);
  assert.equal(JSON.parse(readFileSync(marker, "utf8")).pid, recovered.child.pid);
  assert.equal(statSync(osLock).ino, inode);
  recovered.child.kill("SIGTERM");
  assert.equal((await recovered.exited)[0], 0);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(osLock), true);
});

test("a legacy empty marker fails closed until an operator completes migration", { timeout: 10_000, skip: !["darwin", "linux"].includes(process.platform) }, async (t) => {
  const run = fixture(t);
  // Obtain and release the new lock once to create the private directory.
  const first = await run.start();
  first.child.kill("SIGTERM");
  await first.exited;
  writeFileSync(join(run.stateDir, "worker.lock"), "", { mode: 0o600 });
  const blocked = await run.start();
  assert.equal(blocked.message.ready, false);
  assert.match(blocked.message.error, /one-time upgrade/);
  assert.equal((await blocked.exited)[0], 2);
  assert.equal(readFileSync(join(run.stateDir, "worker.lock"), "utf8"), "");
});

test("platform commands request exclusive non-blocking inherited-FD locks", () => {
  assert.deepEqual(lockingCommand("darwin"), { command: "/usr/bin/lockf", args: ["-s", "-t", "0", "3"] });
  assert.deepEqual(lockingCommand("linux"), { command: "/usr/bin/flock", args: ["-n", "-E", "75", "3"] });
  assert.throws(() => lockingCommand("win32"), /macOS and Linux/);
});
