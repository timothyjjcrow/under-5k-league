import { execFileSync } from "node:child_process";
import {
  chmodSync, closeSync, constants, existsSync, fchmodSync, fstatSync,
  lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

export const LABEL = "com.ggd2l.dota-lobby-bot";
const workerDir = dirname(fileURLToPath(import.meta.url));

function xml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[character]);
}

/** Paths only: credentials remain in the private .env and Steam session files. */
export function renderLaunchAgent({ nodePath, directory, envPath, logDir, keepAwake = false }) {
  const argumentsList = [nodePath, `--env-file=${envPath}`, resolve(directory, "server.mjs")];
  if (keepAwake) argumentsList.unshift("/usr/bin/caffeinate", "-i");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsList.map((argument) => `    <string>${xml(argument)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key><string>${xml(directory)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ExitTimeOut</key><integer>15</integer>
  <key>ProcessType</key><string>Background</string>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>${xml(resolve(logDir, "stdout.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(resolve(logDir, "stderr.log"))}</string>
</dict>
</plist>
`;
}

function privateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const entry = lstatSync(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink())
    throw new Error("The bot state and log directories must be ordinary directories, not symlinks.");
  chmodSync(directory, 0o700);
}

function privateFile(file, flags) {
  const descriptor = openSync(file, flags | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1)
      throw new Error("Bot configuration and log files must be ordinary private files.");
    fchmodSync(descriptor, 0o600);
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function settings() {
  const envPath = resolve(workerDir, ".env");
  if (!existsSync(envPath)) throw new Error("Create ops/dota-lobby-bot/.env before installing the Mac service.");
  const descriptor = privateFile(envPath, constants.O_RDONLY);
  let configuration;
  try { configuration = parseEnv(readFileSync(descriptor, "utf8")); }
  finally { closeSync(descriptor); }
  const stateDir = resolve(workerDir, configuration.DOTA_BOT_STATE_DIR || "./state");
  return {
    nodePath: realpathSync(process.execPath), directory: workerDir, envPath,
    stateDir, logDir: resolve(stateDir, "logs"),
  };
}

function launchctl(args, optional = false) {
  try {
    return execFileSync("/bin/launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });
  } catch {
    // launchctl print can include environment variables. Never display its raw
    // output or error objects; status below extracts only non-sensitive fields.
    if (optional) return null;
    throw new Error(`launchctl ${args[0]} failed. Run this command in your logged-in Mac account; do not use sudo.`);
  }
}

function describeService(service, plistPath) {
  const output = launchctl(["print", service], true);
  console.log(`LaunchAgent: ${existsSync(plistPath) ? "installed" : "not installed"}`);
  console.log(`Loaded: ${output === null ? "no" : "yes"}`);
  if (output !== null) {
    for (const [key, title] of [["state", "State"], ["pid", "PID"], ["last exit code", "Last exit code"]]) {
      const value = output.match(new RegExp(`^\\s*${key} = ([a-z0-9 -]+)$`, "m"))?.[1];
      if (value !== undefined) console.log(`${title}: ${value}`);
    }
  }
}

function assertNoWorkerLock(stateDir) {
  const marker = resolve(stateDir, "worker.lock");
  if (!existsSync(marker)) return;
  try {
    const info = lstatSync(marker);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) throw new Error();
    const saved = JSON.parse(readFileSync(marker, "utf8"));
    if (saved?.protocol !== "kernel-v1" || !Number.isInteger(saved.pid) || saved.pid < 1) throw new Error();
    try { process.kill(saved.pid, 0); }
    catch (error) {
      // A crashed worker's marker is informational. The new worker must still
      // acquire the kernel lock before replacing it; never unlink it here.
      if (error?.code === "ESRCH") return;
      throw error;
    }
  } catch {}
  throw new Error("A worker marker already exists. Stop the running bot before starting the LaunchAgent. For a legacy empty marker, complete the documented one-time migration. This helper will not delete locks.");
}

export function main(args = process.argv.slice(2)) {
  const [command, ...options] = args;
  if (command === "--help" || command === "help") {
    console.log("Usage: node macos-service.mjs install [--keep-awake] | status | stop | start | uninstall");
    console.log("Runs at Mac user login without ChatGPT or a terminal. --keep-awake prevents idle system sleep while the bot runs; it does not keep a closed or shut-down Mac online.");
    return;
  }
  if (!["install", "status", "stop", "start", "uninstall"].includes(command) ||
      options.length > 1 || options.some((option) => option !== "--keep-awake") ||
      (options.length && command !== "install"))
    throw new Error("Usage: node macos-service.mjs install [--keep-awake] | status | stop | start | uninstall");
  if (process.platform !== "darwin") throw new Error("This service helper only supports macOS.");
  if (process.getuid() === 0) throw new Error("Run this helper as your logged-in Mac user, without sudo.");
  const domain = `gui/${process.getuid()}`;
  const service = `${domain}/${LABEL}`;
  const launchAgentsDir = resolve(homedir(), "Library/LaunchAgents");
  const plistPath = resolve(launchAgentsDir, `${LABEL}.plist`);
  if (command === "status") return describeService(service, plistPath);

  if (command === "stop" || command === "uninstall") {
    launchctl(["disable", service]);
    if (launchctl(["print", service], true) !== null) launchctl(["bootout", service]);
    if (command === "uninstall" && existsSync(plistPath)) unlinkSync(plistPath);
    console.log(command === "stop" ? "Bot service stopped and disabled until you run start." : "Mac service removed. Bot configuration, Steam session, and logs are retained.");
    return;
  }

  const loaded = launchctl(["print", service], true) !== null;
  if (command === "start" && loaded) {
    launchctl(["enable", service]);
    launchctl(["kickstart", service]);
    return describeService(service, plistPath);
  }
  if (command === "install" && loaded)
    throw new Error("The Mac service is already loaded. Run stop before reinstalling it with new settings.");
  if (command === "start" && !existsSync(plistPath))
    throw new Error("The Mac service is not installed. Run install first.");

  const configuration = settings();
  assertNoWorkerLock(configuration.stateDir);
  privateDirectory(configuration.stateDir);
  privateDirectory(configuration.logDir);
  for (const name of ["stdout.log", "stderr.log"])
    closeSync(privateFile(resolve(configuration.logDir, name), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND));

  if (command === "install") {
    mkdirSync(launchAgentsDir, { recursive: true });
    const temporary = `${plistPath}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, renderLaunchAgent({ ...configuration, keepAwake: options.includes("--keep-awake") }), { flag: "wx", mode: 0o600 });
      execFileSync("/usr/bin/plutil", ["-lint", temporary], { stdio: "pipe" });
      renameSync(temporary, plistPath);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  launchctl(["enable", service]);
  launchctl(["bootstrap", domain, plistPath]);
  console.log("Mac bot service loaded. It will run at user login and can continue after ChatGPT closes.");
  console.log(`Private logs: ${configuration.logDir}`);
  if (options.includes("--keep-awake")) console.log("Idle system sleep prevention enabled while the bot runs. Keep the Mac powered and its lid open.");
  describeService(service, plistPath);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) {
    console.error(error instanceof Error ? error.message : "Mac service setup failed.");
    process.exitCode = 1;
  }
}
