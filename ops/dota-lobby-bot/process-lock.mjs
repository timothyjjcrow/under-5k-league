import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync,
  mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

const heldLocks = new Map();
const PROTOCOL = "kernel-v1";

export function lockingCommand(platform = process.platform) {
  if (platform === "darwin") return { command: "/usr/bin/lockf", args: ["-s", "-t", "0", "3"] };
  if (platform === "linux") return { command: "/usr/bin/flock", args: ["-n", "-E", "75", "3"] };
  throw new Error("The bot's background process locking supports macOS and Linux. Run the bot on either platform.");
}

async function lockDescriptor(descriptor) {
  const { command, args } = lockingCommand();
  return new Promise((accept, reject) => {
    // Descriptor 3 in the utility is the same open-file description that Node
    // retains. The lock remains held after the short-lived utility exits.
    const child = spawn(command, args, {
      stdio: ["ignore", "ignore", "ignore", descriptor], timeout: 10_000,
    });
    child.once("error", () => reject(new Error("OS locking utility is unavailable. macOS requires lockf; Linux requires util-linux flock.")));
    child.once("close", (code) => {
      if (code === 0) accept();
      else if (code === 75) reject(new Error("The bot or a Steam sign-in is already running with this state directory. Stop it before starting another."));
      else reject(new Error("Could not acquire the bot's OS process lock. Check the private state directory and local filesystem."));
    });
  });
}

function readMarker(marker) {
  let descriptor;
  try {
    descriptor = openSync(marker, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1 || info.size > 1024) throw new Error();
    return JSON.parse(readFileSync(descriptor, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error("A legacy or invalid worker.lock exists. For the one-time upgrade, stop the old bot and sign-in processes, then remove worker.lock. Do not remove worker.os-lock.");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/**
 * Hold a kernel advisory lock until this process exits. A crash or reboot
 * releases it automatically; worker.os-lock itself must never be removed.
 * Both the login helper and worker call this before reading or changing auth.
 *
 * lockf(1) and flock(1) both document this inherited-file-descriptor mode.
 * No wrapper, re-exec, environment marker, or special signal handler is needed.
 */
export async function runWithProcessLock(stateDirectory) {
  if (!["darwin", "linux"].includes(process.platform))
    throw new Error("The bot's background process locking supports macOS and Linux. Run the bot on either platform.");
  const stateDir = resolve(stateDirectory);
  if (heldLocks.has(stateDir)) throw new Error("This process already holds the bot state lock.");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const directory = lstatSync(stateDir);
  if (!directory.isDirectory() || directory.isSymbolicLink())
    throw new Error("The bot state directory must be an ordinary private directory.");
  chmodSync(stateDir, 0o700);
  const marker = resolve(stateDir, "worker.lock");
  const token = randomUUID();
  let descriptor;
  try {
    descriptor = openSync(resolve(stateDir, "worker.os-lock"), constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1) throw new Error("The bot OS lock must be an ordinary private file.");
    fchmodSync(descriptor, 0o600);
    await lockDescriptor(descriptor);
    const previous = readMarker(marker);
    if (previous !== null) {
      if (previous.protocol !== PROTOCOL || !Number.isInteger(previous.pid) || typeof previous.token !== "string")
        throw new Error("An older worker.lock exists. Stop the old bot before removing that marker for the one-time upgrade. Do not remove worker.os-lock.");
      // Only a holder of the kernel lock may replace a marker left by a crash.
      unlinkSync(marker);
    }
    writeFileSync(marker, `${JSON.stringify({ protocol: PROTOCOL, pid: process.pid, token })}\n`, { flag: "wx", mode: 0o600 });
    heldLocks.set(stateDir, descriptor);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    throw error;
  }
  process.once("exit", () => {
    try {
      if (readMarker(marker)?.token === token) unlinkSync(marker);
    } catch {}
    // Remove our informational marker before releasing the actual lock.
    closeSync(descriptor);
    heldLocks.delete(stateDir);
  });
}
