#!/usr/bin/env bash
# Hourly backup of one league database (design §5.1; ops/selfhost/README.md).
#
#   backup-league.sh us|eu
#
# Runs as ggd2l-ops from ggd2l-backup@<lg>.service. The unit supplies DIRECT_URL
# (the league's app role, so a receipt minted from these dumps names the
# database the site runs on) and BACKUP_DIR from /etc/ggd2l/backup-<lg>.env,
# and never BACKUP_RECEIPT_SECRET.
#
#  1. scripts/backup-db.mjs from tools/current writes local/<name>.sql with its
#     .sha256 and .metadata.json sidecars (all 0600).
#  2. scripts/verify-backup.mjs checks the checksum with no receipt secret, so
#     no receipt can reach the journal.
#  3. gzip | age -R backup-recipients.txt writes offsite/<name>.gz.age. The box
#     can encrypt its offsite copies but never decrypt them.
#  4. Prunes local dumps after 48 h (never the newest) and encrypted copies
#     after 14 days (never one that has not reached R2).
#  5. rclone uploads every encrypted copy not yet uploaded to
#     <remote>/<lg>/hourly/<dump date>/, with its checksum and the dump's. The
#     first success at or after 03:00Z each UTC day also goes to daily/<date>/,
#     and the first daily of each month to monthly/<YYYY-MM>/. A failed upload
#     fails the unit. Without rclone.conf the copies wait in offsite/
#     ("offsite-pending"), which passes only within 48 h of the epoch second
#     written in /etc/ggd2l/offsite-pending, and fails after that.
#  6. Writes state/last-backup.json and a copy at <lg>/last-backup.json (the
#     agent's `backup` and `status` report from the record), prints it, and
#     pings HC_PING_BACKUP_<LG> when configured: success, or /fail with the
#     fixed name of the failed step.
#
# The unit runs under ProtectSystem=strict, where only its ReadWritePaths= are
# writable, so everything this script writes, its lock included, stays inside
# the league folder (/var/backups/ggd2l/<lg>).
#
# A file is read from $CREDENTIALS_DIRECTORY when the unit passes it with
# LoadCredential=, else from /etc/ggd2l. Test hooks, never set on the box:
# GGD2L_TOOLS_ROOT, GGD2L_BACKUP_ROOT, GGD2L_ETC, GGD2L_NOW.
set -euo pipefail
umask 077
export LC_ALL=C

usage() { echo "usage: backup-league.sh us|eu" >&2; exit 2; }
[ "$#" -eq 1 ] || usage
lg="$1"
case "${lg}" in us) LG_UPPER=US ;; eu) LG_UPPER=EU ;; *) usage ;; esac

TOOLS_DIR="${GGD2L_TOOLS_ROOT:-/srv/ggd2l/tools}/current"
BACKUP_ROOT="${GGD2L_BACKUP_ROOT:-/var/backups/ggd2l}"
ETC_DIR="${GGD2L_ETC:-/etc/ggd2l}"
OFFSITE_REMOTE="${GGD2L_OFFSITE_REMOTE:-r2:ggd2l-backups}"
LEAGUE_DIR="${BACKUP_ROOT}/${lg}"
LOCAL_DIR="${LEAGUE_DIR}/local"
OFFSITE_DIR="${LEAGUE_DIR}/offsite"
STATE_DIR="${LEAGUE_DIR}/state"
PENDING_LIMIT_SECONDS=172800 # 48 h without R2, then the unit fails
LOCAL_KEEP_MINUTES=2880      # 48 h of plaintext dumps on the box
OFFSITE_KEEP_MINUTES=20160   # 14 days of uploaded encrypted copies

STEP=config
TMP_AGE=""

log() { printf 'backup-%s: %s\n' "${lg}" "$*" >&2; }
fail() { STEP="$1"; shift; log "$*"; exit 1; }

# A file the unit passed with LoadCredential=, else the one in /etc/ggd2l.
conf_file() {
  if [ -n "${CREDENTIALS_DIRECTORY:-}" ] && [ -e "${CREDENTIALS_DIRECTORY}/$1" ]; then
    printf '%s\n' "${CREDENTIALS_DIRECTORY}/$1"
  else
    printf '%s\n' "${ETC_DIR}/$1"
  fi
}

# A setting from the environment (the unit's EnvironmentFile=), else from a
# readable healthchecks.env. The file is parsed, never sourced.
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

# A ping URL is a capability: curl reads it from stdin (-K -), never argv. A
# failed ping is logged and ignored; the check's grace period reports silence.
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

now_epoch() { printf '%s\n' "${GGD2L_NOW:-$(date -u +%s)}"; }
fmt_epoch() { date -u -d "@$1" "+$2" 2>/dev/null || date -u -r "$1" "+$2"; }
sha256_of() { sha256sum < "$1" | cut -d' ' -f1; }

state_get() { if [ -f "${STATE_DIR}/$1" ]; then head -n 1 "${STATE_DIR}/$1"; fi; }
state_put() { printf '%s\n' "$2" > "${STATE_DIR}/.$1.tmp" && mv -f "${STATE_DIR}/.$1.tmp" "${STATE_DIR}/$1"; }

newest_dump() {
  local f newest=""
  for f in "${LOCAL_DIR}"/backup-*.sql; do
    if [ -f "${f}" ]; then newest="${f}"; fi
  done
  printf '%s' "${newest}"
}

# The UTC date in a backup-db.mjs name (backup-2026-10-15T14-17-03-123-42.sql).
dump_day() {
  local day="${1:7:10}"
  if [[ "${day}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    printf '%s' "${day}"
  else
    fmt_epoch "$(now_epoch)" %Y-%m-%d
  fi
}

finish() {
  local rc=$?
  if [ -n "${TMP_AGE}" ]; then rm -f -- "${TMP_AGE}"; fi
  if [ "${rc}" -ne 0 ]; then
    log "FAILED at step ${STEP} (exit ${rc})"
    hc_ping "${HC_URL:-}" /fail "backup-${lg} failed: ${STEP}"
  fi
}
trap finish EXIT

HC_URL="$(conf_value "HC_PING_BACKUP_${LG_UPPER}")"

# --- configuration -----------------------------------------------------------
if [ ! -d "${LEAGUE_DIR}" ] || [ ! -w "${LEAGUE_DIR}" ]; then
  fail config "${LEAGUE_DIR} is missing or not writable"
fi
mkdir -p "${LOCAL_DIR}" "${OFFSITE_DIR}" "${STATE_DIR}"
cd "${LEAGUE_DIR}"
# backup-db.mjs and verify-backup.mjs read a .env from their working directory,
# which could load a receipt secret or another database's URL.
[ ! -e .env ] || fail config "refusing to run beside a .env file in ${LEAGUE_DIR}"
unset BACKUP_RECEIPT_SECRET DATABASE_URL
app_url_re="^postgresql://ggd2l_${lg}_app:[^@/]+@127\.0\.0\.1:5432/ggd2l_${lg}(\?.*)?$"
if ! [[ "${DIRECT_URL:-}" =~ ${app_url_re} ]]; then
  fail config "DIRECT_URL must be the ggd2l_${lg}_app role at 127.0.0.1:5432/ggd2l_${lg} (backup-${lg}.env)"
fi
if [ -n "${BACKUP_DIR:-}" ] && [ "${BACKUP_DIR}" != "${LOCAL_DIR}" ]; then
  fail config "BACKUP_DIR must be ${LOCAL_DIR}"
fi
export BACKUP_DIR="${LOCAL_DIR}"
for script in backup-db.mjs verify-backup.mjs; do
  [ -f "${TOOLS_DIR}/scripts/${script}" ] || fail config "missing ${TOOLS_DIR}/scripts/${script}"
done
RECIPIENTS="$(conf_file backup-recipients.txt)"
if [ ! -r "${RECIPIENTS}" ] || ! grep -q '^age1' "${RECIPIENTS}"; then
  fail config "no readable age1 recipient in backup-recipients.txt"
fi

STEP=lock
# In the league folder, never /run/lock: the unit's sandbox mounts /run
# read-only, and a lock there failed every run before a dump was taken.
exec 9>"${STATE_DIR}/.backup.lock"
flock -n 9 || fail lock "another ${lg} backup is running"

# --- 1. dump -----------------------------------------------------------------
STEP=dump
dump_out="$(node "${TOOLS_DIR}/scripts/backup-db.mjs")" || fail dump "backup-db.mjs failed"
printf '%s\n' "${dump_out}" >&2
sql="$(printf '%s\n' "${dump_out}" | sed -n 's/^Postgres backup written: //p' | tail -n 1)"
case "${sql}" in
  "${LOCAL_DIR}"/backup-*.sql) ;;
  *) fail dump "backup-db.mjs reported no Postgres dump in ${LOCAL_DIR}" ;;
esac
if [ ! -s "${sql}" ] || [ ! -s "${sql}.sha256" ]; then
  fail dump "the dump or its checksum is missing"
fi
name="$(basename "${sql}")"
sql_sha="$(cut -d' ' -f1 < "${sql}.sha256")"
[[ "${sql_sha}" =~ ^[0-9a-f]{64}$ ]] || fail dump "unreadable checksum sidecar for ${name}"

# --- 2. verify ---------------------------------------------------------------
STEP=verify
if ! verify_out="$(env -u BACKUP_RECEIPT_SECRET node "${TOOLS_DIR}/scripts/verify-backup.mjs" "${sql}" 2>&1)"; then
  printf '%s\n' "${verify_out}" | grep -v -i 'receipt:' >&2 || true
  fail verify "verify-backup.mjs rejected ${name}"
fi
case "${verify_out}" in
  *"receipt:"*) fail verify "verify-backup.mjs printed a receipt; refusing to log it" ;;
esac
grep -q '^Verified backup: ' <<< "${verify_out}" || fail verify "verify-backup.mjs did not confirm ${name}"
log "verified ${name} (sha256 ${sql_sha})"

# --- 3. encrypt --------------------------------------------------------------
STEP=encrypt
age_name="${name}.gz.age"
age_file="${OFFSITE_DIR}/${age_name}"
TMP_AGE="${OFFSITE_DIR}/.${age_name}.tmp.$$"
gzip -9 -n -c "${sql}" | age -R "${RECIPIENTS}" -o "${TMP_AGE}" || fail encrypt "gzip | age failed"
[ -s "${TMP_AGE}" ] || fail encrypt "age wrote an empty file"
age_sha="$(sha256_of "${TMP_AGE}")"
mv -f -- "${TMP_AGE}" "${age_file}"
TMP_AGE=""
printf '%s  %s\n' "${age_sha}" "${age_name}" > "${age_file}.sha256"
# The dump's own checksum travels with the encrypted copy, so a decrypted
# restore can be checked (sha256sum -c) and imported like a local dump.
cp -- "${sql}.sha256" "${OFFSITE_DIR}/${name}.sha256"

# --- 4. prune ----------------------------------------------------------------
STEP=prune
newest="$(newest_dump)"
find "${LOCAL_DIR}" -maxdepth 1 -type f -name 'backup-*.sql' -mmin "+${LOCAL_KEEP_MINUTES}" |
  while IFS= read -r f; do
    [ "${f}" != "${newest}" ] || continue
    rm -f -- "${f}" "${f}.sha256" "${f}.metadata.json"
    log "pruned local $(basename "${f}")"
  done
find "${OFFSITE_DIR}" -maxdepth 1 -type f -name 'backup-*.sql.gz.age' -mmin "+${OFFSITE_KEEP_MINUTES}" |
  while IFS= read -r f; do
    if [ ! -e "${f}.uploaded" ]; then
      log "keeping $(basename "${f}"): it has not reached R2"
      continue
    fi
    rm -f -- "${f}" "${f}.sha256" "${f}.uploaded" "${f%.gz.age}.sha256"
    log "pruned encrypted $(basename "${f}")"
  done
find "${OFFSITE_DIR}" -maxdepth 1 -type f -name '.*.tmp.*' -mmin +60 -exec rm -f -- {} +

# --- 5. offsite --------------------------------------------------------------
STEP=offsite
OFFSITE=pending
OFFSITE_KEY=""
DAILY=false
MONTHLY=false
RCLONE_CONF="$(conf_file rclone.conf)"
if [ -e "${RCLONE_CONF}" ]; then
  [ -r "${RCLONE_CONF}" ] || fail offsite "rclone.conf exists but is not readable"
  OFFSITE=uploaded
else
  flag="$(conf_file offsite-pending)"
  [ -r "${flag}" ] || fail offsite-not-configured "no rclone.conf and no offsite-pending flag"
  since="$(head -n 1 "${flag}" | tr -d '[:space:]')"
  now="$(now_epoch)"
  case "${since}" in
    '' | *[!0-9]*) fail offsite-not-configured "offsite-pending must hold the epoch second R2 was deferred" ;;
  esac
  if [ "${since}" -gt "${now}" ] || [ $((now - since)) -ge "${PENDING_LIMIT_SECONDS}" ]; then
    fail offsite-pending-expired "R2 has been pending for 48 h or more; configure rclone.conf"
  fi
fi

rclone_copy() { # local file, key under the remote
  rclone --config "${RCLONE_CONF}" -q --s3-no-check-bucket copyto "$1" "${OFFSITE_REMOTE}/$2"
}
# One encrypted copy with its checksum and the dump's checksum.
upload_set() { # .age file, key for it
  rclone_copy "$1" "$2" &&
    rclone_copy "$1.sha256" "$2.sha256" &&
    { [ ! -f "${1%.gz.age}.sha256" ] || rclone_copy "${1%.gz.age}.sha256" "${2%.gz.age}.sha256"; }
}

if [ "${OFFSITE}" = uploaded ]; then
  STEP=upload
  command -v rclone > /dev/null || fail upload "rclone is not installed"
  # Oldest first, including copies queued while R2 was pending.
  for f in "${OFFSITE_DIR}"/backup-*.sql.gz.age; do
    [ -f "${f}" ] || continue
    [ ! -e "${f}.uploaded" ] || continue
    n="$(basename "${f}")"
    key="${lg}/hourly/$(dump_day "${n}")/${n}"
    upload_set "${f}" "${key}" || fail upload "could not upload ${n}"
    printf '%s\n' "${OFFSITE_REMOTE}/${key}" > "${f}.uploaded"
    log "uploaded ${n} to ${OFFSITE_REMOTE}/${key}"
  done
  OFFSITE_KEY="$(head -n 1 "${age_file}.uploaded")"
  now="$(now_epoch)"
  today="$(fmt_epoch "${now}" %Y-%m-%d)"
  hour="$(fmt_epoch "${now}" %H)"
  if [ $((10#${hour})) -ge 3 ] && [ "$(state_get daily-uploaded)" != "${today}" ]; then
    upload_set "${age_file}" "${lg}/daily/${today}/${age_name}" || fail upload "could not upload the daily copy"
    state_put daily-uploaded "${today}"
    DAILY=true
    if [ "$(state_get monthly-uploaded)" != "${today:0:7}" ]; then
      upload_set "${age_file}" "${lg}/monthly/${today:0:7}/${age_name}" || fail upload "could not upload the monthly copy"
      state_put monthly-uploaded "${today:0:7}"
      MONTHLY=true
    fi
  fi
else
  queued=0
  for f in "${OFFSITE_DIR}"/backup-*.sql.gz.age; do
    if [ -f "${f}" ] && [ ! -e "${f}.uploaded" ]; then queued=$((queued + 1)); fi
  done
  log "offsite-pending: R2 is not configured; ${queued} encrypted copies wait in ${OFFSITE_DIR}"
fi

# --- 6. report ---------------------------------------------------------------
STEP=report
finished="$(fmt_epoch "$(now_epoch)" %Y-%m-%dT%H:%M:%SZ)"
if [ -n "${OFFSITE_KEY}" ]; then key_json="\"${OFFSITE_KEY}\""; else key_json=null; fi
result="$(printf '{"ok":true,"league":"%s","file":"%s","sha256":"%s","ageFile":"%s","ageSha256":"%s","offsite":"%s","offsiteKey":%s,"daily":%s,"monthly":%s,"finishedAt":"%s"}' \
  "${lg}" "${sql}" "${sql_sha}" "${age_file}" "${age_sha}" "${OFFSITE}" "${key_json}" "${DAILY}" "${MONTHLY}" "${finished}")"
# The record, then its copy in the league folder (the agent's backupDir(lg)).
for record_dir in "${STATE_DIR}" "${LEAGUE_DIR}"; do
  printf '%s\n' "${result}" > "${record_dir}/.last-backup.json.tmp"
  mv -f "${record_dir}/.last-backup.json.tmp" "${record_dir}/last-backup.json"
done
printf '%s\n' "${result}"
hc_ping "${HC_URL}" "" "ok ${name} sha256=${sql_sha} offsite-${OFFSITE}"
