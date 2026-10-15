#!/usr/bin/env bash
# Restore drill for one league (design §5.1; ops/selfhost/README.md).
#
#   drill-league.sh us|eu [<40-hex sha>]
#
# Runs as ggd2l-ops: weekly from ggd2l-drill@<lg>.service (Sunday 10:30Z us,
# 11:30Z eu), and from `ggd2l-agent drill <lg> <sha>` before a migration. The
# unit supplies PG_RESTORE_TEST_URL, the ggd2l_rehearsal role on
# 127.0.0.1:5432/ld2l_restore_test, from /etc/ggd2l/drill.env.
#
# It restores the newest local dump with scripts/rehearse-backup-restore.mjs
# from tools/current, or from tools/<sha12> when a SHA is given. That script
# checks the dump against its sidecar, recreates the scratch database, restores
# in one transaction, applies that commit's migrations and attests the full
# schema. The scratch database is dropped afterwards, pass or fail, so no copy
# of league data outlives the drill. The drills share one scratch database, so
# a lock serializes them.
#
# Writes state/last-drill.json, prints it, and pings HC_PING_DRILL_<LG> (or the
# shared HC_PING_DRILL) when configured: success, or /fail with the failed step.
#
# Test hooks, never set on the box: GGD2L_TOOLS_ROOT, GGD2L_BACKUP_ROOT,
# GGD2L_ETC, GGD2L_LOCK_DIR.
set -euo pipefail
umask 077
export LC_ALL=C

usage() { echo "usage: drill-league.sh us|eu [<40-hex sha>]" >&2; exit 2; }
[ "$#" -ge 1 ] && [ "$#" -le 2 ] || usage
lg="$1"
case "${lg}" in us) LG_UPPER=US ;; eu) LG_UPPER=EU ;; *) usage ;; esac
sha="${2:-}"
TOOLS_ROOT="${GGD2L_TOOLS_ROOT:-/srv/ggd2l/tools}"
if [ -z "${sha}" ]; then
  TOOLS_DIR="${TOOLS_ROOT}/current"
elif [[ "${sha}" =~ ^[0-9a-f]{40}$ ]]; then
  TOOLS_DIR="${TOOLS_ROOT}/${sha:0:12}"
else
  usage
fi
BACKUP_ROOT="${GGD2L_BACKUP_ROOT:-/var/backups/ggd2l}"
ETC_DIR="${GGD2L_ETC:-/etc/ggd2l}"
LOCK_DIR="${GGD2L_LOCK_DIR:-/run/lock}"
LEAGUE_DIR="${BACKUP_ROOT}/${lg}"
LOCAL_DIR="${LEAGUE_DIR}/local"
STATE_DIR="${LEAGUE_DIR}/state"

STEP=config
DROP_PENDING=0
OUTPUT_FILE=""

log() { printf 'drill-%s: %s\n' "${lg}" "$*" >&2; }
fail() { STEP="$1"; shift; log "$*"; exit 1; }

conf_file() {
  if [ -n "${CREDENTIALS_DIRECTORY:-}" ] && [ -e "${CREDENTIALS_DIRECTORY}/$1" ]; then
    printf '%s\n' "${CREDENTIALS_DIRECTORY}/$1"
  else
    printf '%s\n' "${ETC_DIR}/$1"
  fi
}

# Environment first (EnvironmentFile=), else a readable healthchecks.env,
# parsed and never sourced.
conf_value() {
  local key="$1" value file line
  value="${!key:-}"
  if [ -z "${value}" ]; then
    file="$(conf_file healthchecks.env)"
    if [ -r "${file}" ]; then
      line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "${file}" | tail -n 1 || true)"
      value="${line#*=}"
      value="${value%$'\r'}"
      case "${value}" in
        \"*\") value="${value#\"}"; value="${value%\"}" ;;
        \'*\') value="${value#\'}"; value="${value%\'}" ;;
      esac
    fi
  fi
  printf '%s' "${value}"
}

# The ping URL goes to curl on stdin (-K -), never argv.
hc_ping() { # url suffix body
  local url="$1" suffix="$2" body="$3"
  [ -n "${url}" ] || return 0
  case "${url}" in
    https://*) ;;
    *) log "healthchecks: the ping URL is not https; not pinging"; return 0 ;;
  esac
  case "${url}" in
    *\"*|*\\*|*[[:space:]]*) log "healthchecks: malformed ping URL; not pinging"; return 0 ;;
  esac
  if ! printf 'url = "%s%s"\n' "${url}" "${suffix}" |
    curl -fsS -m 10 --retry 3 -o /dev/null --data-binary "${body}" -K -; then
    log "healthchecks ping failed"
  fi
}

# dropdb with libpq fields built from PG_RESTORE_TEST_URL in the child's
# environment, so the password never reaches argv.
drop_scratch() {
  GGD2L_PG_CLI_ENV="${TOOLS_DIR}/src/lib/postgres-cli-env.mjs" node --input-type=module -e '
    import { spawnSync } from "node:child_process";
    import { pathToFileURL } from "node:url";
    const { postgresCliEnv } = await import(pathToFileURL(process.env.GGD2L_PG_CLI_ENV).href);
    const env = postgresCliEnv(process.env.PG_RESTORE_TEST_URL, { database: "postgres" });
    const result = spawnSync("dropdb", ["--if-exists", "--force", "ld2l_restore_test"], { env, stdio: "inherit" });
    process.exit(result.status ?? 1);
  '
}

finish() {
  local rc=$?
  if [ "${DROP_PENDING}" -eq 1 ]; then
    drop_scratch || log "could not drop ld2l_restore_test; drop it by hand"
  fi
  if [ -n "${OUTPUT_FILE}" ]; then rm -f -- "${OUTPUT_FILE}"; fi
  if [ "${rc}" -ne 0 ]; then
    log "FAILED at step ${STEP} (exit ${rc})"
    hc_ping "${HC_URL:-}" /fail "drill-${lg} failed: ${STEP}"
  fi
}
trap finish EXIT

HC_URL="$(conf_value "HC_PING_DRILL_${LG_UPPER}")"
if [ -z "${HC_URL}" ]; then HC_URL="$(conf_value HC_PING_DRILL)"; fi

# --- configuration -----------------------------------------------------------
if [ ! -d "${LEAGUE_DIR}" ] || [ ! -w "${LEAGUE_DIR}" ]; then
  fail config "${LEAGUE_DIR} is missing or not writable"
fi
mkdir -p "${STATE_DIR}"
cd "${LEAGUE_DIR}"
# verify-backup.mjs, which the rehearsal runs, reads a .env from its working
# directory; a receipt secret there would print a receipt into the journal.
[ ! -e .env ] || fail config "refusing to run beside a .env file in ${LEAGUE_DIR}"
unset BACKUP_RECEIPT_SECRET DATABASE_URL DIRECT_URL
restore_url_re='^postgresql://ggd2l_rehearsal:[^@/]+@127\.0\.0\.1:5432/ld2l_restore_test(\?.*)?$'
if ! [[ "${PG_RESTORE_TEST_URL:-}" =~ ${restore_url_re} ]]; then
  fail config "PG_RESTORE_TEST_URL must be ggd2l_rehearsal at 127.0.0.1:5432/ld2l_restore_test (drill.env)"
fi
for file in scripts/rehearse-backup-restore.mjs src/lib/postgres-cli-env.mjs; do
  [ -f "${TOOLS_DIR}/${file}" ] || fail config "missing ${TOOLS_DIR}/${file}"
done

STEP=no-dump
dump=""
for f in "${LOCAL_DIR}"/backup-*.sql; do
  if [ -f "${f}" ]; then dump="${f}"; fi
done
[ -n "${dump}" ] || fail no-dump "no local dump in ${LOCAL_DIR}"
name="$(basename "${dump}")"
[ -s "${dump}.sha256" ] || fail no-dump "${name} has no checksum sidecar"
dump_sha="$(cut -d' ' -f1 < "${dump}.sha256")"

STEP=lock
exec 9>"${LOCK_DIR}/ggd2l-drill.lock"
flock -w 3600 9 || fail lock "another drill held the scratch database for an hour"

# --- restore, migrate and attest ---------------------------------------------
STEP=restore
log "restoring ${name} with ${TOOLS_DIR}"
OUTPUT_FILE="$(mktemp "${STATE_DIR}/.drill-output.XXXXXX")"
DROP_PENDING=1
rc=0
env -u BACKUP_RECEIPT_SECRET CHECKPOINT_DISABLE=1 PRISMA_HIDE_UPDATE_MESSAGE=1 \
  node "${TOOLS_DIR}/scripts/rehearse-backup-restore.mjs" "${dump}" > "${OUTPUT_FILE}" 2>&1 || rc=$?
# psql echoes a command tag per restored object; the tail carries the result.
grep -v -i 'receipt:' "${OUTPUT_FILE}" | tail -n 30 >&2 || true
[ "${rc}" -eq 0 ] || fail restore "rehearse-backup-restore.mjs exited ${rc}"
grep -q '^Restore rehearsal passed: ' "${OUTPUT_FILE}" || fail restore "the rehearsal did not report a pass"

STEP=cleanup
DROP_PENDING=0
drop_scratch || fail cleanup "could not drop ld2l_restore_test after a passing drill"

# --- report ------------------------------------------------------------------
STEP=report
finished="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
result="$(printf '{"ok":true,"league":"%s","dump":"%s","dumpSha256":"%s","tools":"%s","finishedAt":"%s"}' \
  "${lg}" "${dump}" "${dump_sha}" "${TOOLS_DIR}" "${finished}")"
printf '%s\n' "${result}" > "${STATE_DIR}/.last-drill.json.tmp"
mv -f "${STATE_DIR}/.last-drill.json.tmp" "${STATE_DIR}/last-drill.json"
printf '%s\n' "${result}"
hc_ping "${HC_URL}" "" "ok ${name} sha256=${dump_sha}"
