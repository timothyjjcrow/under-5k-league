// The installed layout of the GGD2L box (design §1.2-1.4), the argument
// grammar every verb shares (§2.1), and the fixed error vocabulary.
//
// Every path hangs off one root so the tests can build the whole layout in a
// temporary directory; on the box the root is "/".
import { isIP } from "node:net";
import path from "node:path";

export const LEAGUES = Object.freeze(["us", "eu"]);
export const SLOTS = Object.freeze(["a", "b"]);
export const PORTS = Object.freeze({
  us: Object.freeze({ a: 3001, b: 3002 }),
  eu: Object.freeze({ a: 3011, b: 3012 }),
});
export const PUBLIC_HOST = Object.freeze({ us: "us.ggd2l.com", eu: "eu.ggd2l.com" });

// A release is a clone of one SHA built for one league at one moment.
export const REGION_RE = /^(us|eu)$/;
export const SHA_RE = /^[0-9a-f]{40}$/;
export const ID_RE = /^(us|eu)-\d{8}T\d{6}Z-[0-9a-f]{12}$/;
export const SINCE_RE = /^\d{1,15}$/;
// A cutover dump as backup-db.mjs names it; only a basename, never a path.
export const DUMP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.sql$/;
export const MAX_ALLOWED_IPS = 8;

// The old slot stays warm this long after a promote (design D4): retire and a
// start that would recycle it both wait it out.
export const WARM_OVERLAP_MS = 90_000;
export const READY_TIMEOUT_MS = 90_000;
export const MIN_BUILD_FREE_BYTES = 5 * 1024 ** 3;
export const STATIC_RETENTION_MS = 14 * 24 * 60 * 60_000;
export const TOOLS_KEPT = 2;

// Every folder of a release that `next start` (Next 16.3) writes at runtime:
// .next/cache holds the data cache (fetch-cache) and the image cache, and
// .next/server/route-cache the response cache for prerendered routes (Next
// copies each build seed there on first read and writes every re-render).
// Found in Next's file-system cache and image optimizer, and by booting a
// build and listing what it wrote. The build gives the league user exactly
// these, and the slot unit's ReadWritePaths= names the same list.
export const RELEASE_WRITABLE_DIRS = Object.freeze([".next/cache", ".next/server/route-cache"]);

export const BIN = Object.freeze({
  bash: "/usr/bin/bash",
  caddy: "/usr/bin/caddy",
  chmod: "/usr/bin/chmod",
  chown: "/usr/bin/chown",
  env: "/usr/bin/env",
  flock: "/usr/bin/flock",
  git: "/usr/bin/git",
  install: "/usr/bin/install",
  journalctl: "/usr/bin/journalctl",
  node: "/usr/bin/node",
  npm: "/usr/bin/npm",
  psql: "/usr/bin/psql",
  rm: "/usr/bin/rm",
  rsync: "/usr/bin/rsync",
  runuser: "/usr/sbin/runuser",
  systemctl: "/usr/bin/systemctl",
  systemdRun: "/usr/bin/systemd-run",
  tar: "/usr/bin/tar",
});

export const USERS = Object.freeze({
  build: "ggd2l-build",
  caddy: "caddy",
  ops: "ggd2l-ops",
  // Runs the restore drill: the build user's tools clone, so never as ggd2l-ops.
  drill: "ggd2l-drill",
  bot: "ggd2l-bot",
  league: (lg) => `ggd2l-${lg}`,
});

export function createLayout(root = "/") {
  const at = (...parts) => path.join(root, ...parts);
  const lib = at("usr/local/lib/ggd2l");
  return Object.freeze({
    root,
    lib,
    sql: (name) => path.join(lib, "sql", `${name}.sql`),
    helper: (name) => path.join(lib, name),
    envDir: at("etc/ggd2l"),
    leagueEnv: (lg) => at("etc/ggd2l", `${lg}.env`),
    migrateEnv: (lg) => at("etc/ggd2l", `${lg}-migrate.env`),
    drillEnv: at("etc/ggd2l/drill.env"),
    caddyfile: at("etc/caddy/Caddyfile"),
    modeFile: (lg) => at("etc/caddy/ggd2l", `${lg}-mode.caddy`),
    allowFile: at("etc/caddy/ggd2l/allow.caddy"),
    repo: at("srv/ggd2l/repo.git"),
    leagueDir: (lg) => at("srv/ggd2l", lg),
    releases: (lg) => at("srv/ggd2l", lg, "releases"),
    release: (id) => at("srv/ggd2l", id.slice(0, 2), "releases", id),
    slot: (lg, slot) => at("srv/ggd2l", lg, "slots", slot),
    staticDir: (lg) => at("srv/ggd2l", lg, "static/_next/static"),
    tools: at("srv/ggd2l/tools"),
    toolsDir: (sha) => at("srv/ggd2l/tools", sha.slice(0, 12)),
    toolsCurrent: at("srv/ggd2l/tools/current"),
    botReleases: at("srv/ggd2l/bot/releases"),
    botCurrent: at("srv/ggd2l/bot/current"),
    botState: at("var/lib/ggd2l-bot"),
    stateDir: (lg) => at("var/lib/ggd2l", lg),
    liveJson: (lg) => at("var/lib/ggd2l", lg, "live.json"),
    buildLogs: at("var/log/ggd2l/builds"),
    buildLog: (id) => at("var/log/ggd2l/builds", `${id}.log`),
    // One redacted log per attest, preflight, migrate or sha drill run.
    toolLog: (name) => at("var/log/ggd2l/tools", `${name}.log`),
    caddyLogs: at("var/log/caddy"),
    backupDir: (lg) => at("var/backups/ggd2l", lg),
    // The drill's own folder: its record and its private copy of the dump.
    drillState: (lg) => at("var/lib/ggd2l-drill", lg),
    cutoverDir: (lg) => at("var/backups/ggd2l/cutover", lg),
    buildHome: at("var/cache/ggd2l-build"),
    npmCache: at("var/cache/ggd2l-build/npm"),
    lock: at("run/ggd2l-agent.lock"),
    rebootRequired: at("var/run/reboot-required"),
    srv: at("srv/ggd2l"),
  });
}

export const unitName = (lg, slot) => `ggd2l-${lg}@${slot}.service`;
export const otherSlot = (slot) => (slot === "a" ? "b" : "a");

// Fixed messages: an error never carries child output, a path or a value.
export const ERRORS = Object.freeze({
  usage: "wrong number of arguments for this verb",
  unknown_verb: "verb is not in the agent's allowlist",
  bad_region: "league must be us or eu",
  bad_sha: "sha must be 40 lowercase hex characters",
  bad_id: "release id is malformed",
  bad_since: "since must be epoch milliseconds",
  bad_ip: "every address must be a plain IPv4 or IPv6 address",
  bad_mode: "mode must be one of the listed modes",
  bad_flag: "unknown, repeated or invalid flag",
  bad_file: "dump must be a .sql file in the league's cutover folder",
  not_root: "the agent runs as root through sudo -n",
  busy: "another mutating agent verb holds the lock",
  argv_secret: "refused to place a secret in a command line",
  env_contract: "the league env file breaks the env contract",
  env_invalid: "the league env file fails the production validation (scripts/validate-prod-env.mjs)",
  env_missing: "an env file the verb needs is missing",
  disk_low: "less than 5 GB free under /srv/ggd2l",
  fetch_failed: "git fetch of origin/main failed",
  not_on_main: "the sha is not on origin/main",
  clone_failed: "cloning the release failed",
  clone_mismatch: "the clone is not at the requested sha",
  dirty_checkout: "the checkout has changed or untracked files",
  dotenv_present: "the checkout contains a dotenv file Next or Prisma would load",
  install_failed: "npm ci failed",
  build_failed: "the build unit failed",
  gate_line_missing: "the build output lacks a production gate line",
  artifact_missing: "the built release lacks a required file",
  lockdown_failed: "locking down the release failed",
  link_escapes: "a symlink in the release points outside it",
  unsafe_path: "refused a link or unexpected file where the agent works as root",
  publish_failed: "publishing static files failed",
  release_missing: "no such release on the box",
  release_not_built: "the release did not finish building",
  wrong_league: "the release belongs to the other league",
  not_started: "the release is on no slot; start it first",
  start_failed: "systemd could not start the slot",
  start_timeout: "the slot did not answer /api/health/live in time",
  ready_timeout: "the slot did not answer live and ready in time",
  too_soon: "the previous slot is inside its 90 s warm overlap",
  no_live: "the league has no live release",
  no_previous: "the league has no previous release to roll back to",
  rolled_back:
    "live is already a rollback (rolledBackFrom); to put back the release it replaced, run promote <lg> <rolledBackFrom>",
  is_live: "refused: that release is live",
  mode_is_maintenance: "the league is in maintenance; promote with an explicit --mode",
  live_mismatch: "live.json, the Caddy mode file and the slot symlink disagree",
  caddy_write_failed: "could not write the new Caddy file",
  caddy_invalid: "caddy validate rejected the new configuration; the old file is restored",
  caddy_reload_failed: "caddy reload failed; the old file is restored",
  systemctl_failed: "a systemctl call failed",
  smoke_failed: "the smoke run failed or printed no verdict",
  fetch_cache_tagged: "the candidate's fetch cache holds a gate or result-sync entry",
  tools_missing: "prepare the tools clone for this sha first",
  attest_failed: "attestation failed or printed no pass line",
  preflight_failed: "migration preflight failed",
  migrate_failed: "the migration release failed",
  grant_problems: "the app role's grants are wrong",
  psql_failed: "a database query failed",
  checksum_mismatch: "the dump does not match its sha256 sidecar",
  not_maintenance: "import needs the league in maintenance mode",
  provision_failed: "provision-league-db.sh failed",
  restore_failed: "the restore failed",
  ownership: "a public relation is not owned by the owner role",
  identity_unexpected_rows: "the identity change did not touch the expected rows",
  backup_failed: "the backup unit failed",
  drill_failed: "the restore drill failed",
  bot_deploy_failed: "deploying the lobby bot failed",
  prune_failed: "removing an old release or tools clone failed",
  internal: "the agent hit an unexpected error",
});

export class AgentError extends Error {
  constructor(code, extra = {}) {
    super(ERRORS[code] ?? ERRORS.internal);
    this.code = Object.hasOwn(ERRORS, code) ? code : "internal";
    this.extra = extra;
  }
}

export class UsageError extends AgentError {}

export function region(value) {
  if (typeof value !== "string" || !REGION_RE.test(value)) throw new UsageError("bad_region");
  return value;
}

export function sha(value) {
  if (typeof value !== "string" || !SHA_RE.test(value)) throw new UsageError("bad_sha");
  return value;
}

export function releaseId(value) {
  if (typeof value !== "string" || !ID_RE.test(value)) throw new UsageError("bad_id");
  return value;
}

export function since(value) {
  if (typeof value !== "string" || !SINCE_RE.test(value)) throw new UsageError("bad_since");
  const ms = Number(value);
  if (!Number.isSafeInteger(ms)) throw new UsageError("bad_since");
  return ms;
}

export function ipAddress(value) {
  // net.isIP refuses CIDR, ports, zone ids and anything with whitespace.
  if (typeof value !== "string" || isIP(value) === 0) throw new UsageError("bad_ip");
  return value;
}

/** 2026-10-16T15:00:00.123Z -> 20261016T150000Z */
export function compactStamp(at) {
  return new Date(at).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function makeReleaseId(lg, commit, at) {
  return releaseId(`${lg}-${compactStamp(at)}-${commit.slice(0, 12)}`);
}
