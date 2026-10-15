#!/usr/bin/env bash
# Daily encrypted archive of the box's configuration (design §5.1;
# ops/selfhost/README.md): /etc/ggd2l (env files, database passwords, rclone
# and healthchecks settings), /etc/cloudflared (the tunnel credentials) and
# /etc/caddy, so a rebuilt box can recover every secret it held.
#
#   config-archive.sh
#
# Runs as root from ggd2l-config-archive.service, because those directories are
# root-only. The plaintext never touches disk: tar | gzip | age -R straight into
# config/config-<UTC stamp>.tar.gz.age, readable only with Tim's offline key.
# The copy goes to <remote>/config/<date>/ through rclone, or waits locally
# under the same 48 h offsite-pending rule as the league backups. Local copies
# are kept 14 days once uploaded. Pings HC_PING_CONFIG when configured.
#
# Test hooks, never set on the box: GGD2L_CONFIG_DIRS, GGD2L_BACKUP_ROOT,
# GGD2L_ETC, GGD2L_NOW.
set -euo pipefail
umask 077
export LC_ALL=C

[ "$#" -eq 0 ] || { echo "usage: config-archive.sh" >&2; exit 2; }

CONFIG_DIRS="${GGD2L_CONFIG_DIRS:-/etc/ggd2l /etc/cloudflared /etc/caddy}"
BACKUP_ROOT="${GGD2L_BACKUP_ROOT:-/var/backups/ggd2l}"
ETC_DIR="${GGD2L_ETC:-/etc/ggd2l}"
OFFSITE_REMOTE="${GGD2L_OFFSITE_REMOTE:-r2:ggd2l-backups}"
OUT_DIR="${BACKUP_ROOT}/config"
PENDING_LIMIT_SECONDS=172800
KEEP_MINUTES=20160

STEP=config
TMP_AGE=""

log() { printf 'config-archive: %s\n' "$*" >&2; }
fail() { STEP="$1"; shift; log "$*"; exit 1; }

conf_file() {
  if [ -n "${CREDENTIALS_DIRECTORY:-}" ] && [ -e "${CREDENTIALS_DIRECTORY}/$1" ]; then
    printf '%s\n' "${CREDENTIALS_DIRECTORY}/$1"
  else
    printf '%s\n' "${ETC_DIR}/$1"
  fi
}

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

now_epoch() { printf '%s\n' "${GGD2L_NOW:-$(date -u +%s)}"; }
fmt_epoch() { date -u -d "@$1" "+$2" 2>/dev/null || date -u -r "$1" "+$2"; }
sha256_of() { sha256sum < "$1" | cut -d' ' -f1; }

finish() {
  local rc=$?
  if [ -n "${TMP_AGE}" ]; then rm -f -- "${TMP_AGE}"; fi
  if [ "${rc}" -ne 0 ]; then
    log "FAILED at step ${STEP} (exit ${rc})"
    hc_ping "${HC_URL:-}" /fail "config-archive failed: ${STEP}"
  fi
}
trap finish EXIT

HC_URL="$(conf_value HC_PING_CONFIG)"

# --- configuration -----------------------------------------------------------
mkdir -p "${OUT_DIR}"
RECIPIENTS="$(conf_file backup-recipients.txt)"
if [ ! -r "${RECIPIENTS}" ] || ! grep -q '^age1' "${RECIPIENTS}"; then
  fail config "no readable age1 recipient in backup-recipients.txt"
fi
# tar runs from /, so each directory is named relative to it. /etc/ggd2l (the
# first) is required; the others are skipped until they exist (cloudflared
# arrives with the tunnel).
set --
first=1
for dir in ${CONFIG_DIRS}; do
  case "${dir}" in /*) ;; *) fail config "config directories must be absolute: ${dir}" ;; esac
  if [ -d "${dir}" ]; then
    set -- "$@" "${dir#/}"
  elif [ "${first}" -eq 1 ]; then
    fail config "${dir} is missing"
  else
    log "skipping ${dir}: not present"
  fi
  first=0
done

# --- archive and encrypt -----------------------------------------------------
STEP=encrypt
now="$(now_epoch)"
name="config-$(fmt_epoch "${now}" %Y%m%dT%H%M%SZ).tar.gz.age"
file="${OUT_DIR}/${name}"
TMP_AGE="${OUT_DIR}/.${name}.tmp.$$"
# Owners are stored by name, so a rebuilt box whose service users got other
# uids still restores them correctly.
tar -C / -cf - "$@" | gzip -9 -n | age -R "${RECIPIENTS}" -o "${TMP_AGE}" ||
  fail encrypt "tar | gzip | age failed"
[ -s "${TMP_AGE}" ] || fail encrypt "age wrote an empty file"
sha="$(sha256_of "${TMP_AGE}")"
mv -f -- "${TMP_AGE}" "${file}"
TMP_AGE=""
printf '%s  %s\n' "${sha}" "${name}" > "${file}.sha256"
log "archived ${*} into ${name} (sha256 ${sha})"

# --- prune -------------------------------------------------------------------
STEP=prune
find "${OUT_DIR}" -maxdepth 1 -type f -name 'config-*.tar.gz.age' -mmin "+${KEEP_MINUTES}" |
  while IFS= read -r f; do
    [ "${f}" != "${file}" ] || continue
    if [ ! -e "${f}.uploaded" ]; then
      log "keeping $(basename "${f}"): it has not reached R2"
      continue
    fi
    rm -f -- "${f}" "${f}.sha256" "${f}.uploaded"
  done
find "${OUT_DIR}" -maxdepth 1 -type f -name '.*.tmp.*' -mmin +60 -exec rm -f -- {} +

# --- offsite -----------------------------------------------------------------
STEP=offsite
OFFSITE=pending
OFFSITE_KEY=""
RCLONE_CONF="$(conf_file rclone.conf)"
if [ -e "${RCLONE_CONF}" ]; then
  [ -r "${RCLONE_CONF}" ] || fail offsite "rclone.conf exists but is not readable"
  OFFSITE=uploaded
else
  flag="$(conf_file offsite-pending)"
  [ -r "${flag}" ] || fail offsite-not-configured "no rclone.conf and no offsite-pending flag"
  since="$(head -n 1 "${flag}" | tr -d '[:space:]')"
  case "${since}" in
    '' | *[!0-9]*) fail offsite-not-configured "offsite-pending must hold the epoch second R2 was deferred" ;;
  esac
  if [ "${since}" -gt "${now}" ] || [ $((now - since)) -ge "${PENDING_LIMIT_SECONDS}" ]; then
    fail offsite-pending-expired "R2 has been pending for 48 h or more; configure rclone.conf"
  fi
fi

if [ "${OFFSITE}" = uploaded ]; then
  STEP=upload
  command -v rclone > /dev/null || fail upload "rclone is not installed"
  for f in "${OUT_DIR}"/config-*.tar.gz.age; do
    [ -f "${f}" ] || continue
    [ ! -e "${f}.uploaded" ] || continue
    n="$(basename "${f}")"
    stamp="${n#config-}"
    key="config/${stamp:0:4}-${stamp:4:2}-${stamp:6:2}/${n}"
    if ! rclone --config "${RCLONE_CONF}" -q --s3-no-check-bucket copyto "${f}" "${OFFSITE_REMOTE}/${key}" ||
      ! rclone --config "${RCLONE_CONF}" -q --s3-no-check-bucket copyto "${f}.sha256" "${OFFSITE_REMOTE}/${key}.sha256"; then
      fail upload "could not upload ${n}"
    fi
    printf '%s\n' "${OFFSITE_REMOTE}/${key}" > "${f}.uploaded"
    log "uploaded ${n} to ${OFFSITE_REMOTE}/${key}"
  done
  OFFSITE_KEY="$(head -n 1 "${file}.uploaded")"
else
  log "offsite-pending: R2 is not configured; the archive waits in ${OUT_DIR}"
fi

# --- report ------------------------------------------------------------------
STEP=report
if [ -n "${OFFSITE_KEY}" ]; then key_json="\"${OFFSITE_KEY}\""; else key_json=null; fi
result="$(printf '{"ok":true,"file":"%s","sha256":"%s","offsite":"%s","offsiteKey":%s,"finishedAt":"%s"}' \
  "${file}" "${sha}" "${OFFSITE}" "${key_json}" "$(fmt_epoch "$(now_epoch)" %Y-%m-%dT%H:%M:%SZ)")"
printf '%s\n' "${result}" > "${OUT_DIR}/.last-archive.json.tmp"
mv -f "${OUT_DIR}/.last-archive.json.tmp" "${OUT_DIR}/last-archive.json"
printf '%s\n' "${result}"
hc_ping "${HC_URL}" "" "ok ${name} sha256=${sha} offsite-${OFFSITE}"
