#!/usr/bin/env bash
# Five-minute heartbeat (design §5.2; ops/selfhost/README.md). Runs as
# ggd2l-ops from ggd2l-heartbeat.service.
#
#   box         Every live league answers /api/health/ready with 200 through
#               Cloudflare (tunnel, Caddy, app and database); / is under 85%
#               full; MemAvailable is over 150 MB; swap in use is under 1.5 GB;
#               `systemctl --failed` is empty. Pings HC_PING_BOX, otherwise
#               HC_PING_BOX/fail with the names of the failed checks.
#   automation  Every live league's /api/health/automation answers 200: pings
#               HC_PING_AUTOMATION. Otherwise no ping, so the check's 30-minute
#               grace absorbs a scheduler resume and silence past it alerts.
#   bot         ggd2l-bot.service is active: pings HC_PING_BOT (configured once
#               the lobby bot runs on the box). Otherwise no ping, as above.
#
# Live leagues are GGD2L_HEARTBEAT_LEAGUES (default "us eu"); during the cutover
# day it is "us" until Europe moves. Every setting comes from the environment
# (EnvironmentFile=-/etc/ggd2l/healthchecks.env) or, failing that, from that
# file when readable. With nothing configured the heartbeat only logs. It exits
# 0 once it has reported, so its own unit never shows as failed.
#
# Test hooks, never set on the box: GGD2L_ETC, GGD2L_MEMINFO.
set -euo pipefail
export LC_ALL=C

ETC_DIR="${GGD2L_ETC:-/etc/ggd2l}"
MEMINFO="${GGD2L_MEMINFO:-/proc/meminfo}"
DISK_LIMIT_PERCENT=85
MEM_FLOOR_KB=153600    # 150 MB
SWAP_LIMIT_KB=1572864  # 1.5 GB
USER_AGENT="ggd2l-heartbeat"

log() { printf 'heartbeat: %s\n' "$*" >&2; }

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

# 200 or not. Retries ride out a blip (curl retries timeouts and 5xx).
http_ok() {
  local code
  code="$(curl -sS -o /dev/null -m 10 --retry 2 --retry-delay 5 --retry-connrefused \
    -A "${USER_AGENT}" -w '%{http_code}' "$1" 2> /dev/null || true)"
  [ "${code}" = 200 ]
}

meminfo_kb() {
  awk -v key="$1:" '$1 == key { print $2; found = 1 } END { if (!found) print -1 }' "${MEMINFO}" 2> /dev/null || echo -1
}

LEAGUES="$(conf_value GGD2L_HEARTBEAT_LEAGUES)"
LEAGUES="${LEAGUES:-us eu}"
for lg in ${LEAGUES}; do
  case "${lg}" in us | eu) ;; *) log "GGD2L_HEARTBEAT_LEAGUES may list only us and eu"; exit 1 ;; esac
done

# --- box ---------------------------------------------------------------------
problems=""
for lg in ${LEAGUES}; do
  http_ok "https://${lg}.ggd2l.com/api/health/ready" || problems="${problems} ready-${lg}"
done

disk="$(df -P / 2> /dev/null | awk 'NR == 2 { sub(/%$/, "", $5); print $5 }' || true)"
case "${disk}" in '' | *[!0-9]*) disk=100 ;; esac
[ "${disk}" -lt "${DISK_LIMIT_PERCENT}" ] || problems="${problems} disk"

mem_available="$(meminfo_kb MemAvailable)"
swap_total="$(meminfo_kb SwapTotal)"
swap_free="$(meminfo_kb SwapFree)"
[ "${mem_available}" -gt "${MEM_FLOOR_KB}" ] || problems="${problems} memory"
if [ "${swap_total}" -lt 0 ] || [ "${swap_free}" -lt 0 ]; then
  problems="${problems} swap"
  swap_used=-1
else
  swap_used=$((swap_total - swap_free))
  [ "${swap_used}" -lt "${SWAP_LIMIT_KB}" ] || problems="${problems} swap"
fi

failed_units="$(systemctl list-units --state=failed --plain --no-legend --no-pager 2> /dev/null | awk '{ print $1 }' | tr '\n' ' ' || true)"
failed_units="${failed_units% }"
if [ -n "${failed_units}" ]; then problems="${problems} failed-units"; fi

summary="disk=${disk}% memAvailableMb=$((mem_available / 1024)) swapUsedMb=$((swap_used / 1024))"
if [ -z "${problems}" ]; then
  log "box ok: ${summary}"
  hc_ping "$(conf_value HC_PING_BOX)" "" "ok ${summary}"
else
  log "box FAILED:${problems} (${summary})${failed_units:+ failed: ${failed_units}}"
  hc_ping "$(conf_value HC_PING_BOX)" /fail "fail:${problems} ${summary}${failed_units:+ failed: ${failed_units}}"
fi

# --- automation --------------------------------------------------------------
automation_down=""
for lg in ${LEAGUES}; do
  http_ok "https://${lg}.ggd2l.com/api/health/automation" || automation_down="${automation_down} ${lg}"
done
if [ -z "${automation_down}" ]; then
  hc_ping "$(conf_value HC_PING_AUTOMATION)" "" "ok ${LEAGUES}"
else
  log "automation not healthy:${automation_down} (no ping; the check's grace decides)"
fi

# --- bot ---------------------------------------------------------------------
bot_url="$(conf_value HC_PING_BOT)"
if [ -n "${bot_url}" ]; then
  if systemctl is-active --quiet ggd2l-bot.service; then
    hc_ping "${bot_url}" "" "ok"
  else
    log "ggd2l-bot.service is not active (no ping; the check's grace decides)"
  fi
fi
exit 0
