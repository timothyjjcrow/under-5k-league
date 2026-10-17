// provision-league-db.sh run against fake system tools: what it sends to
// psql, where the passwords travel, which files it writes, and when it
// refuses. The SQL itself was exercised against a scratch PostgreSQL 18; on
// the box install-kit.sh runs the script for real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "provision-league-db.sh");
const HEX64 = /[0-9a-f]{64}/;

// Each fake records what it was asked to do. psql writes its argv (one
// argument per line) and its whole stdin into numbered files.
const FAKES = {
  id: '#!/bin/sh\n[ "$1" = "-u" ] && { echo 0; exit 0; }\nexec /usr/bin/id "$@"\n',
  runuser: '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n',
  chown: "#!/bin/sh\nexit 0\n",
  systemctl: '#!/bin/sh\necho "${FAKE_SLOT_STATE:-inactive}"\n',
  openssl: "#!/bin/sh\nod -An -N32 -tx1 /dev/urandom | tr -d ' \\n'\necho\n",
  psql: [
    "#!/bin/sh",
    'n=$(ls "$FAKE_LOG" | grep -c argv || true)',
    'for a in "$@"; do printf "%s\\n" "$a"; done > "$FAKE_LOG/argv.$n"',
    'cat > "$FAKE_LOG/stdin.$n"',
    "",
  ].join("\n"),
};

function sandbox() {
  const root = mkdtempSync(path.join(tmpdir(), "ggd2l-provision-test-"));
  const bin = path.join(root, "bin");
  const log = path.join(root, "log");
  const etc = path.join(root, "etc");
  for (const dir of [bin, log, etc]) mkdirSync(dir);
  for (const [name, body] of Object.entries(FAKES)) {
    writeFileSync(path.join(bin, name), body);
    chmodSync(path.join(bin, name), 0o755);
  }
  const run = (args, { env = {}, bashFlags = [] } = {}) => spawnSync("bash", [...bashFlags, SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GGD2L_ETC_DIR: etc, FAKE_LOG: log, ...env },
  });
  const calls = () => readdirSync(log).filter((f) => f.startsWith("argv.")).sort().map((f) => ({
    argv: readFileSync(path.join(log, f), "utf8"),
    stdin: readFileSync(path.join(log, f.replace("argv", "stdin")), "utf8"),
  }));
  const file = (relative) => readFileSync(path.join(etc, relative), "utf8");
  const mode = (relative) => statSync(path.join(etc, relative)).mode & 0o777;
  return { root, etc, run, calls, file, mode, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("passwords reach psql on stdin only, never argv, output or an error", (t) => {
  const box = sandbox();
  t.after(box.cleanup);
  const result = box.run(["us"]);
  assert.equal(result.status, 0, result.stderr);
  const [call] = box.calls();
  const passwords = ["us-owner", "us-app", "rehearsal"].map((name) => box.file(`secrets/${name}.pw`).trim());
  for (const pw of passwords) {
    assert.match(pw, /^[0-9a-f]{64}$/);
    assert.ok(call.stdin.includes(pw), "the password is in the stdin script");
    assert.ok(!call.argv.includes(pw), "the password is not in psql's argv");
  }
  assert.doesNotMatch(call.argv, HEX64);
  assert.doesNotMatch(call.argv, /PASSWORD/i);
  assert.doesNotMatch(result.stdout + result.stderr, HEX64);
  // psql (as postgres, through runuser) reads the script from stdin, stops on
  // the first error, and gets only names on its command line.
  assert.equal(call.argv, [
    "-X", "-q", "-v", "ON_ERROR_STOP=1", "-v", "db=ggd2l_us", "-v", "owner=ggd2l_us_owner", "-v", "app=ggd2l_us_app",
    "-v", "rehearsal=ggd2l_rehearsal", "-v", "recreate=0", "-d", "postgres", "-f", "-",
  ].map((arg) => `${arg}\n`).join(""));
  // The session that carries passwords logs no statement, and errors are terse.
  const beforePasswords = call.stdin.indexOf("ALTER ROLE");
  for (const line of ["SET log_statement = 'none';", "SET log_min_error_statement = 'panic';", "\\set VERBOSITY terse"])
    assert.ok(call.stdin.indexOf(line) >= 0 && call.stdin.indexOf(line) < beforePasswords, line);
});

test("tracing the script with bash -x still prints no password", (t) => {
  const box = sandbox();
  t.after(box.cleanup);
  const result = box.run(["eu"], { bashFlags: ["-x"] });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, HEX64);
});

test("each run writes the four 0600 env files from the stored passwords", (t) => {
  const box = sandbox();
  t.after(box.cleanup);
  assert.equal(box.run(["us"]).status, 0);
  const app = box.file("secrets/us-app.pw").trim();
  const owner = box.file("secrets/us-owner.pw").trim();
  const rehearsal = box.file("secrets/rehearsal.pw").trim();
  const params = "schema=public&sslmode=disable&connection_limit=4&pool_timeout=10&connect_timeout=5";
  const appUrl = `postgresql://ggd2l_us_app:${app}@127.0.0.1:5432/ggd2l_us?${params}`;
  const ownerUrl = `postgresql://ggd2l_us_owner:${owner}@127.0.0.1:5432/ggd2l_us?${params}`;
  assert.equal(box.file("fragments/us-db.env"), `DATABASE_URL=${appUrl}\nDIRECT_URL=${appUrl}\n`);
  assert.equal(box.file("us-migrate.env"), `DATABASE_URL=${ownerUrl}\nDIRECT_URL=${ownerUrl}\n`);
  assert.equal(box.file("backup-us.env"), `DIRECT_URL=${appUrl}\nBACKUP_DIR=/var/backups/ggd2l/us/local\n`);
  assert.equal(box.file("drill.env"),
    `PG_RESTORE_TEST_URL=postgresql://ggd2l_rehearsal:${rehearsal}@127.0.0.1:5432/ld2l_restore_test?sslmode=disable&connect_timeout=5\n`);
  for (const file of ["fragments/us-db.env", "us-migrate.env", "backup-us.env", "drill.env",
    "secrets/us-app.pw", "secrets/us-owner.pw", "secrets/rehearsal.pw"])
    assert.equal(box.mode(file), 0o600, file);
  assert.equal(box.mode("secrets"), 0o700);
  assert.equal(box.mode("fragments"), 0o700);
  // No temporary file is left beside them.
  assert.deepEqual(readdirSync(box.etc).filter((f) => f.endsWith(".tmp")), []);
});

test("a re-run keeps every password and rewrites identical files", (t) => {
  const box = sandbox();
  t.after(box.cleanup);
  assert.equal(box.run(["us"]).status, 0);
  const first = ["secrets/us-app.pw", "secrets/us-owner.pw", "secrets/rehearsal.pw", "fragments/us-db.env"].map(box.file);
  assert.equal(box.run(["us"]).status, 0);
  assert.deepEqual(["secrets/us-app.pw", "secrets/us-owner.pw", "secrets/rehearsal.pw", "fragments/us-db.env"].map(box.file), first);
  // Europe shares the drill role's password, never a US role.
  assert.equal(box.run(["eu"]).status, 0);
  assert.equal(box.file("secrets/rehearsal.pw"), first[2]);
  const europe = box.calls().at(-1);
  assert.doesNotMatch(europe.argv + europe.stdin, /ggd2l_us/);
});

test("a stored password that is not 64 hex characters stops the run before psql", (t) => {
  const box = sandbox();
  t.after(box.cleanup);
  mkdirSync(path.join(box.etc, "secrets"));
  writeFileSync(path.join(box.etc, "secrets/us-app.pw"), "short'; DROP ROLE x; --\n");
  const result = box.run(["us"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must hold exactly 64 lowercase hex characters/);
  assert.deepEqual(box.calls(), []);
});

test("--recreate drops the database only while both of the league's slots are stopped", (t) => {
  const box = sandbox();
  t.after(box.cleanup);
  for (const state of ["active", "activating", "deactivating", "reloading"]) {
    const refused = box.run(["us", "--recreate"], { env: { FAKE_SLOT_STATE: state } });
    assert.equal(refused.status, 1, state);
    assert.match(refused.stderr, /stop both us slots before --recreate/);
  }
  assert.deepEqual(box.calls(), [], "psql never ran");
  assert.ok(!existsSync(path.join(box.etc, "secrets")), "nothing was written");
  const allowed = box.run(["us", "--recreate"], { env: { FAKE_SLOT_STATE: "failed" } });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(box.calls()[0].argv, /\nrecreate=1\n/);
  assert.match(box.calls()[0].stdin, /\\if :recreate\nDROP DATABASE IF EXISTS :"db" WITH \(FORCE\);\n\\endif/);
});

test("arguments are validated before anything happens", (t) => {
  const box = sandbox();
  t.after(box.cleanup);
  for (const args of [[], ["xx"], ["US"], ["us", "--force"], ["us", "--recreate", "extra"], ["--recreate", "us"]]) {
    const result = box.run(args);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.match(result.stderr, /usage: provision-league-db\.sh us\|eu \[--recreate\]/);
  }
  assert.deepEqual(box.calls(), []);
  assert.deepEqual(readdirSync(box.etc), []);
});

test("the SQL never reaches for the cluster-wide data roles and keeps the app off the ledger", (t) => {
  const box = sandbox();
  t.after(box.cleanup);
  assert.equal(box.run(["eu"]).status, 0);
  const { stdin } = box.calls()[0];
  assert.doesNotMatch(stdin, /pg_(read|write)_all_data/);
  assert.match(stdin, /GRANT CONNECT ON DATABASE :"db" TO :"app";/);
  assert.match(stdin, /REVOKE ALL ON DATABASE :"db" FROM PUBLIC;/);
  assert.match(stdin, /REVOKE ALL ON SCHEMA public FROM PUBLIC;/);
  assert.match(stdin, /ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public\n\s+GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app";/);
  assert.match(stdin, /REVOKE INSERT, UPDATE, DELETE ON public\._prisma_migrations FROM %I/);
  assert.match(stdin, /ALTER ROLE :"app" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'app_pw';/);
  assert.match(stdin, /LOCALE_PROVIDER builtin BUILTIN_LOCALE %L/);
});
