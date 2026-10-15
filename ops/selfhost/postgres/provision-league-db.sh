#!/usr/bin/env bash
# Create, or re-assert, one league's PostgreSQL database and roles on the box
# (design §1.6, D17). Run as root:
#
#   provision-league-db.sh us|eu [--recreate]
#
# Idempotent: roles and the database are created only when absent, and every
# run re-asserts the role attributes, the passwords, the grants and the env
# files below, so a re-run (or a rebuild with restored /etc/ggd2l) is safe.
#
#   ggd2l_<lg>_owner  owns the database and every object in it. Restores and
#                     migrations only.
#   ggd2l_<lg>_app    the runtime role: DML on the league's tables and nothing
#                     else. Never a member of the owner, never another league.
#   ggd2l_rehearsal   cluster-wide, CREATEDB: the restore drill into
#                     ld2l_restore_test. Shared by both leagues.
#
# Never pg_read_all_data or pg_write_all_data: they would cross leagues.
#
# --recreate drops the league database and creates it empty (the import step
# of the cutover runbook, §6 W8). It refuses while either web slot of the
# league is running.
#
# Passwords come from `openssl rand -hex 32` once, live in
# /etc/ggd2l/secrets/<lg>-owner.pw, <lg>-app.pw and rehearsal.pw (0600), and
# reach psql on stdin only: never argv, a log, stdout or an error message.
#
# Written on every run (0600 root), from the .pw files:
#   /etc/ggd2l/fragments/<lg>-db.env  DATABASE_URL = DIRECT_URL as the app
#                                     role, for the operator to merge into
#                                     /etc/ggd2l/<lg>.env
#   /etc/ggd2l/<lg>-migrate.env       DATABASE_URL = DIRECT_URL as the owner
#   /etc/ggd2l/backup-<lg>.env        DIRECT_URL (app role) and BACKUP_DIR
#   /etc/ggd2l/drill.env              PG_RESTORE_TEST_URL (rehearsal role)

# xtrace would print the passwords this script handles; turn it off silently.
{ set +x; } 2>/dev/null
set -euo pipefail
umask 077

# The box always uses /etc/ggd2l; the test points this at a scratch folder.
ETC_DIR="${GGD2L_ETC_DIR:-/etc/ggd2l}"
URL_PARAMS="schema=public&sslmode=disable&connection_limit=8&pool_timeout=10&connect_timeout=5"

usage() { echo "usage: provision-league-db.sh us|eu [--recreate]" >&2; exit 2; }
die() { echo "provision-league-db: $*" >&2; exit 1; }

[[ $# -ge 1 && $# -le 2 ]] || usage
LG="$1"
case "$LG" in us|eu) ;; *) usage ;; esac
RECREATE=0
if [[ $# -eq 2 ]]; then
  [[ "$2" == "--recreate" ]] || usage
  RECREATE=1
fi
[[ "$(id -u)" -eq 0 ]] || die "run as root"
# psql runs as postgres, which may not be able to read the caller's directory.
cd /

DB="ggd2l_${LG}"
OWNER="ggd2l_${LG}_owner"
APP="ggd2l_${LG}_app"
REHEARSAL="ggd2l_rehearsal"
SECRETS="${ETC_DIR}/secrets"
FRAGMENTS="${ETC_DIR}/fragments"

if [[ "$RECREATE" -eq 1 ]]; then
  # Dropping the database under a running slot would serve errors, or worse,
  # let a write land between the drop and the restore.
  for slot in a b; do
    state="$(systemctl show --property=ActiveState --value "ggd2l-${LG}@${slot}.service")"
    case "$state" in
      inactive|failed) ;;
      *) die "ggd2l-${LG}@${slot} is ${state}; stop both ${LG} slots before --recreate" ;;
    esac
  done
fi

mkdir -p "$SECRETS" "$FRAGMENTS"
chown root:root "$SECRETS" "$FRAGMENTS"
chmod 0700 "$SECRETS" "$FRAGMENTS"

# password <name>: create <name>.pw once, then read it into PASSWORD.
password() {
  local file="${SECRETS}/$1.pw"
  if [[ ! -s "$file" ]]; then
    openssl rand -hex 32 > "${file}.tmp"
    mv -f "${file}.tmp" "$file"
  fi
  chown root:root "$file"
  chmod 0600 "$file"
  PASSWORD="$(< "$file")"
  [[ "$PASSWORD" =~ ^[0-9a-f]{64}$ ]] || die "$file must hold exactly 64 lowercase hex characters"
}
password "${LG}-owner"; OWNER_PW="$PASSWORD"
password "${LG}-app"; APP_PW="$PASSWORD"
password "rehearsal"; REHEARSAL_PW="$PASSWORD"
PASSWORD=""

# The SQL travels on stdin. Role and database names are psql variables
# (not secret); the passwords are \set inside the stdin script by the printf
# builtin, so they never appear in any process's argv.
psql_postgres() {
  runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 \
    -v db="$DB" -v owner="$OWNER" -v app="$APP" -v rehearsal="$REHEARSAL" \
    -v recreate="$RECREATE" -d postgres -f -
}

{
  printf '\\set owner_pw %s\n' "$OWNER_PW"
  printf '\\set app_pw %s\n' "$APP_PW"
  printf '\\set rehearsal_pw %s\n' "$REHEARSAL_PW"
  cat <<'SQL'
-- Terse errors carry no statement text, and the server logs none of this
-- session's statements, so a failure cannot echo a password anywhere.
\set VERBOSITY terse
\set SHOW_CONTEXT never
SET log_statement = 'none';
SET log_min_duration_statement = -1;
SET log_min_error_statement = 'panic';

SELECT format('CREATE ROLE %I', r)
FROM unnest(ARRAY[:'owner', :'app', :'rehearsal']::text[]) AS r
WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r)
\gexec
ALTER ROLE :"owner" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'owner_pw';
ALTER ROLE :"app" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'app_pw';
ALTER ROLE :"rehearsal" WITH LOGIN NOSUPERUSER CREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'rehearsal_pw';
\unset owner_pw
\unset app_pw
\unset rehearsal_pw

\if :recreate
DROP DATABASE IF EXISTS :"db" WITH (FORCE);
\endif

-- Builtin C.UTF-8 and UTC: the same collation and clock as Neon.
SELECT format(
  'CREATE DATABASE %I OWNER %I TEMPLATE template0 ENCODING %L LOCALE_PROVIDER builtin BUILTIN_LOCALE %L LC_COLLATE %L LC_CTYPE %L',
  :'db', :'owner', 'UTF8', 'C.UTF-8', 'C.UTF-8', 'C.UTF-8')
WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname = :'db')
\gexec

-- An existing database must already be exactly what CREATE would make.
SELECT set_config('ggd2l.db', :'db', false) AS db,
       set_config('ggd2l.owner', :'owner', false) AS owner
\gset ggd2l_
DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_database AS d
    WHERE d.datname = current_setting('ggd2l.db')
      AND d.datdba = to_regrole(current_setting('ggd2l.owner'))::oid
      AND d.datlocprovider = 'b' AND d.datlocale = 'C.UTF-8'
      AND d.datcollate = 'C.UTF-8' AND d.datctype = 'C.UTF-8'
      AND pg_catalog.pg_encoding_to_char(d.encoding) = 'UTF8'
  ) THEN
    RAISE EXCEPTION 'database % exists with another owner, locale or encoding', current_setting('ggd2l.db');
  END IF;
END
$check$;

REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO :"app";
ALTER DATABASE :"db" SET timezone TO 'UTC';
ALTER DATABASE :"db" SET idle_in_transaction_session_timeout TO '5min';

\connect :db
SET log_statement = 'none';
SET log_min_duration_statement = -1;
SET log_min_error_statement = 'panic';
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO :"app";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO :"app";
-- Re-assert the grants on tables a restore already created (a no-op on an
-- empty database). The app reads the migration ledger but never writes it.
BEGIN;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"app";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :"app";
SELECT format('REVOKE INSERT, UPDATE, DELETE ON public._prisma_migrations FROM %I', :'app')
WHERE to_regclass('public._prisma_migrations') IS NOT NULL
\gexec
COMMIT;
SQL
} | psql_postgres

# write_env <path>: replace a 0600 env file atomically with stdin.
write_env() {
  local tmp="$1.tmp"
  cat > "$tmp"
  chown root:root "$tmp"
  chmod 0600 "$tmp"
  mv -f "$tmp" "$1"
}
app_url="postgresql://${APP}:${APP_PW}@127.0.0.1:5432/${DB}?${URL_PARAMS}"
owner_url="postgresql://${OWNER}:${OWNER_PW}@127.0.0.1:5432/${DB}?${URL_PARAMS}"
drill_url="postgresql://${REHEARSAL}:${REHEARSAL_PW}@127.0.0.1:5432/ld2l_restore_test?sslmode=disable&connect_timeout=5"

printf 'DATABASE_URL=%s\nDIRECT_URL=%s\n' "$app_url" "$app_url" | write_env "${FRAGMENTS}/${LG}-db.env"
printf 'DATABASE_URL=%s\nDIRECT_URL=%s\n' "$owner_url" "$owner_url" | write_env "${ETC_DIR}/${LG}-migrate.env"
printf 'DIRECT_URL=%s\nBACKUP_DIR=/var/backups/ggd2l/%s/local\n' "$app_url" "$LG" | write_env "${ETC_DIR}/backup-${LG}.env"
printf 'PG_RESTORE_TEST_URL=%s\n' "$drill_url" | write_env "${ETC_DIR}/drill.env"

if [[ "$RECREATE" -eq 1 ]]; then
  echo "${DB}: recreated empty; roles ${OWNER}, ${APP} and ${REHEARSAL} ready"
else
  echo "${DB}: ready; roles ${OWNER}, ${APP} and ${REHEARSAL} ready"
fi
echo "wrote ${FRAGMENTS}/${LG}-db.env, ${ETC_DIR}/${LG}-migrate.env, ${ETC_DIR}/backup-${LG}.env, ${ETC_DIR}/drill.env (0600)"
