#!/usr/bin/env bash
# Install, or re-install, the GGD2L league layer on the box (design §1, §2.6,
# §6.0 P2) from a clone checked out at exactly <sha>. Run as root, after
# provision-base.sh, from root's own clone:
#
#   git clone https://github.com/timothyjjcrow/under-5k-league.git /root/ggd2l-kit
#   git -C /root/ggd2l-kit checkout --detach <sha>
#   bash /root/ggd2l-kit/ops/selfhost/install-kit.sh <sha>
#
# A later kit change runs the same way: `git -C /root/ggd2l-kit fetch origin`,
# check out the new <sha>, run the same line. Kit changes reach the box only
# this way, as their own recorded step, never with an app release.
#
# Never run it from a clone another user owns or can write, such as a tools
# clone the build user made (npm runs package scripts as that user), or from
# anything under /srv/ggd2l: a release or bot release is root's once the agent
# has locked it down, but npm ran package scripts there as the build user
# first. Root would run that user's git config (core.fsmonitor runs on `git
# status`) and install files rewritten behind a clean-looking index. It
# refuses both before it runs git or anything else from the clone.
#
# Idempotent, and safe on a live box. It:
#   - creates the service users and the directory tree with its modes (§1.1-1.2)
#   - installs the agent, the env contract, the SQL files, the shell helpers and
#     the hourly backup's repo scripts (app/) into a fresh folder, then swaps it
#     in as /usr/local/lib/ggd2l (a real directory, never a symlink); the entry
#     point is /usr/local/sbin/ggd2l-agent
#   - installs the systemd units, timers and drop-ins (one gives the packaged
#     caddy.service its restart policy), and NEVER enables, disables, starts,
#     stops or restarts any of them
#   - installs the Caddyfile; a league with no mode file yet gets the
#     maintenance one, and an existing mode file (a live site) is never touched;
#     then reloads Caddy, or, when the running Caddy is not on the admin socket
#     the Caddyfile names, restarts it if no slot or bot runs and otherwise
#     says it NEEDS A RESTART
#   - installs the PostgreSQL settings and pg_hba rules, then creates or
#     re-asserts both league databases and roles (provision-league-db.sh)
#   - renders /etc/cloudflared/config.yml once the tunnel's credentials exist
#   - records the install in /var/lib/ggd2l/kit.json
# Before any of it, it refuses to go on if the live league env files
# (/etc/ggd2l/<lg>.env) break this kit's env contract.
# It writes no secret except the database URLs provision-league-db.sh derives,
# and it holds the agent's lock, so no release runs while files move.
set -euo pipefail
umask 022

ADMIN_USER="${ADMIN_USER:-ggd2l}"
PG_MAJOR=18
LEAGUES="us eu"
REPO_URL="${GGD2L_REPO_URL:-https://github.com/timothyjjcrow/under-5k-league.git}"
LIB=/usr/local/lib/ggd2l
AGENT_BIN=/usr/local/sbin/ggd2l-agent
UNIT_DIR=/etc/systemd/system
PG_ETC="/etc/postgresql/${PG_MAJOR}/main"
# The Caddyfile's admin API (caddy.test.mjs keeps the two equal).
CADDY_ADMIN_SOCKET=/run/caddy/admin.sock

log() { printf '\n== %s\n' "$*"; }
note() { printf '   %s\n' "$*"; }
die() { echo "install-kit: $*" >&2; exit 1; }

# kit_untrusted <dir>: print the first path that someone other than root could
# use to change what root runs from <dir>, or nothing. Every entry under <dir>
# must be root's and writable by no group or other user (a symlink's own mode
# means nothing), and every directory above it root's and not writable by
# others unless sticky, so nobody can swap the clone out. "Root" means root or
# whoever runs this; the script then requires that to be root. The same
# function is in provision-ggd2l.sh.
kit_untrusted() {
  local me dir found
  me="$(id -u)"
  found="$(find "$1" \( \( ! -uid 0 ! -uid "$me" \) -o \( ! -type l \( -perm -020 -o -perm -002 \) \) \) -print -quit)" || return 2
  if [[ -n "$found" ]]; then printf '%s\n' "$found"; return 0; fi
  dir="$1"
  while [[ "$dir" != / ]]; do
    dir="$(dirname "$dir")"
    found="$(find "$dir" -maxdepth 0 \( \( ! -uid 0 ! -uid "$me" \) -o \( ! -perm -1000 \( -perm -020 -o -perm -002 \) \) \) -print)" || return 2
    if [[ -n "$found" ]]; then printf '%s\n' "$found"; return 0; fi
  done
}

[[ $# -eq 1 && "$1" =~ ^[0-9a-f]{40}$ ]] || { echo "usage: install-kit.sh <40-hex commit sha>" >&2; exit 2; }
SHA="$1"
SHA12="${SHA:0:12}"
KIT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SELFHOST="${KIT_ROOT}/ops/selfhost"
# Before git or anything else runs from the clone.
untrusted="$(kit_untrusted "${KIT_ROOT}")" || die "could not inspect the kit clone ${KIT_ROOT}"
[[ -z "$untrusted" ]] \
  || die "${untrusted} is owned or writable by a user other than root; run this only from root's own clone (see the header)"
# The agent locks every release and bot release down to root once the build
# user's npm has run in it, so they pass the check above; what is in them is
# still the build user's work. A tools clone stays the build user's, which
# the check above refuses. The same refusal is in provision-ggd2l.sh.
case "${KIT_ROOT}/" in
  /srv/ggd2l/*) die "${KIT_ROOT} is a clone the build user made; run this only from root's own clone (see the header)" ;;
esac
[[ "$(id -u)" -eq 0 ]] || die "run as root"
. /etc/os-release
[[ "${ID}" == "ubuntu" && "${VERSION_CODENAME}" == "noble" ]] || die "expected Ubuntu 24.04 (noble), found ${PRETTY_NAME}"

# Every path below is absolute. Working from / keeps the service users'
# commands (git, psql, caddy) from failing on a cwd they cannot read.
cd /
# The clone is root's (checked above), so git needs no safe.directory
# exception; it still runs no fsmonitor or hook from the clone's config.
git_kit() { git -c core.fsmonitor=false -c core.hooksPath=/dev/null -C "${KIT_ROOT}" "$@"; }

log "Kit clone ${KIT_ROOT} at ${SHA12}"
head="$(git_kit rev-parse HEAD)"
[[ "$head" == "$SHA" ]] || die "the kit clone is at ${head}, not ${SHA}"
[[ -z "$(git_kit status --porcelain --untracked-files=no)" ]] || die "the kit clone has modified tracked files"
[[ -z "$(git_kit status --porcelain --untracked-files=all -- ops/selfhost)" ]] \
  || die "ops/selfhost in the kit clone has untracked or modified files"

# Everything the installed layout needs, checked before anything changes.
REQUIRED="
agent/ggd2l-agent.mjs
agent/env-contract.mjs
agent/cgroup-report.mjs
backup/backup-league.sh
backup/drill-league.sh
backup/heartbeat.sh
backup/config-archive.sh
backup/discord-alert.mjs
postgres/provision-league-db.sh
postgres/90-ggd2l.conf
postgres/pg_hba.snippet
sql/db-parity.sql
sql/runtime-grants.sql
sql/scrub-rehearsal.sql
sql/identity-us.sql
sql/identity-eu.sql
caddy/Caddyfile
caddy/mode-maintenance.caddy
caddy/maintenance.html
cloudflared/config.yml.template
systemd/ggd2l-us@.service
systemd/ggd2l-eu@.service
systemd/cloudflared-ggd2l.service
systemd/ggd2l-backup@.service
systemd/ggd2l-backup@.timer
systemd/ggd2l-drill@.service
systemd/ggd2l-drill@.timer
systemd/ggd2l-drill@eu.timer.d/10-schedule.conf
systemd/ggd2l-heartbeat.service
systemd/ggd2l-heartbeat.timer
systemd/ggd2l-config-archive.service
systemd/ggd2l-config-archive.timer
systemd/ggd2l-bot.service
systemd/ggd2l-alert@.service
systemd/caddy.service.d/10-ggd2l.conf
"
for f in $REQUIRED; do
  [[ -f "${SELFHOST}/${f}" ]] || die "missing ops/selfhost/${f} in the kit clone"
done
# The hourly backup's repo scripts and everything they import (no packages),
# installed under app/ with their paths: ggd2l-ops, which holds the R2 key,
# runs nothing from a tools clone the build user's npm ci wrote.
# install-kit.test.mjs checks this is exactly what the two scripts import.
BACKUP_APP_FILES="
scripts/backup-db.mjs
scripts/verify-backup.mjs
src/lib/backup-receipt.mjs
src/lib/postgres-cli-env.mjs
src/lib/postgres-identity.mjs
"
for f in $BACKUP_APP_FILES; do
  [[ -f "${KIT_ROOT}/${f}" ]] || die "missing ${f} in the kit clone"
done
cmp -s "${SELFHOST}/systemd/ggd2l-us@.service" "${SELFHOST}/systemd/ggd2l-eu@.service" \
  || die "ggd2l-us@.service and ggd2l-eu@.service must be identical copies"

log "Prerequisites (provision-base.sh)"
for cmd in node npm git psql caddy cloudflared age rclone rsync openssl flock runuser useradd usermod; do
  command -v "$cmd" >/dev/null || die "${cmd} is not installed; run provision-base.sh first"
done
[[ "$(node -p 'process.versions.node.split(".")[0]')" == "22" ]] || die "expected Node 22"
[[ -x "/usr/lib/postgresql/${PG_MAJOR}/bin/postgres" ]] || die "PostgreSQL ${PG_MAJOR} is not installed"
grep -Eq "^include_dir = 'conf.d'" "${PG_ETC}/postgresql.conf" || die "${PG_ETC}/postgresql.conf does not include conf.d"
getent group "${ADMIN_USER}" >/dev/null || die "admin group ${ADMIN_USER} does not exist"
getent passwd caddy >/dev/null || die "the caddy user does not exist; is the caddy package installed?"
# ggd2l-alert@.service reads a failed run's step from the journal; systemd
# refuses to start a unit whose SupplementaryGroups= does not exist.
getent group systemd-journal >/dev/null || die "the systemd-journal group does not exist"
# Refuse to install a kit whose own scripts do not parse.
while IFS= read -r f; do bash -n "$f" || die "${f} does not parse"; done \
  < <(find "${SELFHOST}" -name '*.sh' -type f)
while IFS= read -r f; do node --check "$f" || die "${f} does not parse"; done \
  < <(find "${SELFHOST}/agent" "${SELFHOST}/backup" -name '*.mjs' -type f)
for f in $BACKUP_APP_FILES; do node --check "${KIT_ROOT}/${f}" || die "${f} does not parse"; done
# This kit's env contract must pass each league's live env file before it is
# installed: every slot's ExecStartPre and the agent's builds run it, so a
# rule the kit tightens (such as the production DOTA_LOBBY_BOT_URL rule) would
# otherwise stop a live league at its next restart. Names only, never values.
for lg in $LEAGUES; do
  [[ -f "/etc/ggd2l/${lg}.env" ]] || continue
  node "${SELFHOST}/agent/env-contract.mjs" --league "$lg" --file "/etc/ggd2l/${lg}.env" \
    || die "/etc/ggd2l/${lg}.env breaks this kit's env contract (the names above); fix it first, nothing was changed"
done

# The agent takes this lock for every mutating verb (§2.1).
exec 9>>/run/ggd2l-agent.lock
flock -w 600 9 || die "the release agent has held its lock for 10 minutes; try again later"

ensure_user() { # <name> <home>
  if ! id -u "$1" >/dev/null 2>&1; then
    useradd --system --user-group --home-dir "$2" --no-create-home --shell /usr/sbin/nologin "$1"
    note "created user $1"
  fi
}
# ensure_dir <mode> <owner:group> <path>: a folder whose parent only root can
# change, so nobody else could have put anything at <path>. GNU chown and
# chmod follow a link they are given (re-owning or re-moding its target), so a
# link or file at <path> is refused, and the chown is -h besides. A folder
# inside one a service user owns goes through ensure_user_dir instead.
ensure_dir() {
  local parent
  parent="$(dirname "$3")"
  [[ -z "$(find "$parent" -maxdepth 0 \( \( ! -uid 0 ! -uid "$(id -u)" \) -o -perm -002 \) -print)" ]] \
    || die "${parent} is not root's, or anyone can write it: refusing to change ${3} as root"
  if [[ -L "$3" ]] || { [[ -e "$3" ]] && [[ ! -d "$3" ]]; }; then
    die "${3} is a link or not a folder: refusing to change it as root"
  fi
  mkdir -p "$3"
  chown -h "$2" "$3"
  chmod "$1" "$3"
}
# ensure_user_dir <user> <mode> <path>: a folder inside one <user> owns (the
# build user's npm cache, the backup folders ggd2l-ops writes), made and set by
# <user> itself, so root runs nothing on a path that user could have swapped
# for a link. Nothing of ours leaves a link or file there: one is refused, as
# a sign the user's code was not what it should be (ops/selfhost/README.md,
# Kit changes).
ensure_user_dir() {
  if [[ -L "$3" ]] || { [[ -e "$3" ]] && [[ ! -d "$3" ]]; }; then
    die "${3} is a link or not a folder; ${1} may have been misused, look before removing it"
  fi
  runuser -u "$1" -- mkdir -p "$3"
  runuser -u "$1" -- chmod "$2" "$3"
}
# active_units: the league slots and the bot that are running now.
active_units() {
  systemctl list-units --plain --no-legend --state=active \
    'ggd2l-us@*.service' 'ggd2l-eu@*.service' 'ggd2l-bot.service' | awk '{print $1}'
}
as_build() { runuser -u ggd2l-build -- env HOME=/var/cache/ggd2l-build "$@"; }
# caddy_reload <1 if a Caddy file changed>: make the running Caddy serve the
# installed files. `caddy reload` (the unit's ExecReload) reaches the running
# Caddy at the admin address the NEW Caddyfile names, the socket in /run/caddy.
# A Caddy started before that socket existed (the package's own config, or a
# kit from before 2026-10-19 on localhost) cannot take that reload, and only a
# restart makes the socket and its folder (the drop-in's RuntimeDirectory=):
# done here only while no slot or bot runs, like PostgreSQL's restart below.
caddy_reload() {
  local live
  if systemctl is-active --quiet caddy && [[ ! -S "${CADDY_ADMIN_SOCKET}" ]]; then
    live="$(active_units | tr '\n' ' ')"
    if [[ -z "$live" ]]; then
      systemctl restart caddy
      note "restarted: the admin API is now ${CADDY_ADMIN_SOCKET}"
    else
      note "NEEDS A RESTART: the running Caddy is not on its admin socket ${CADDY_ADMIN_SOCKET}, so every reload fails (the agent's mode switches, so releases, too) until: systemctl restart caddy"
      note "do it now, in a quiet minute: both sites answer 502 for a few seconds (${live}is running)"
    fi
  elif [[ "$1" -eq 1 ]]; then
    systemctl reload-or-restart caddy
    note "reloaded"
  else
    note "unchanged"
  fi
}

log "Users (§1.1)"
# The build user's home is its npm cache folder, as the agent sets HOME.
ensure_user ggd2l-build /var/cache/ggd2l-build
ensure_user ggd2l-us /nonexistent
ensure_user ggd2l-eu /nonexistent
ensure_user ggd2l-ops /var/lib/ggd2l-ops
# The restore drill runs a tools clone (the build user's npm ci wrote it), so
# it gets its own user: it reads only the dump the backup hands it.
ensure_user ggd2l-drill /nonexistent
ensure_user ggd2l-bot /var/lib/ggd2l-bot
ensure_user cloudflared /nonexistent
# The hourly backup hands each new dump to the drill's group, which only a
# member may do (chgrp).
if ! id -nG ggd2l-ops | tr ' ' '\n' | grep -qx ggd2l-drill; then
  usermod -aG ggd2l-drill ggd2l-ops
  note "added ggd2l-ops to the ggd2l-drill group"
fi

log "Directories (§1.2)"
ensure_dir 0750 ggd2l-build:ggd2l-build /var/cache/ggd2l-build
ensure_user_dir ggd2l-build 0750 /var/cache/ggd2l-build/npm
ensure_dir 0750 ggd2l-ops:ggd2l-ops /var/lib/ggd2l-ops
ensure_dir 0700 ggd2l-bot:ggd2l-bot /var/lib/ggd2l-bot
ensure_dir 0755 root:root /srv/ggd2l
ensure_dir 0755 ggd2l-build:ggd2l-build /srv/ggd2l/repo.git
# Where the build user clones and installs. The agent makes each folder here
# as root and only then hands it over (makeBuildDir), so the build user needs
# no write access to these parents: it can neither plant a link at a name the
# agent is about to use nor swap its own folder for one. Tools and bot code
# are readable by all (backups, drills and the bot run from them); a league's
# releases are traverse-only for others, which is all its league user and the
# build user need to reach a release.
ensure_dir 0755 root:root /srv/ggd2l/tools
ensure_dir 0755 root:root /srv/ggd2l/bot
ensure_dir 0755 root:root /srv/ggd2l/bot/releases
ensure_dir 0755 root:root /srv/ggd2l/www
ensure_dir 0755 root:root /var/lib/ggd2l
# The drill's own folders: one per league, and the root its shared lock opens.
ensure_dir 0755 root:root /var/lib/ggd2l-drill
ensure_dir 0750 "root:${ADMIN_USER}" /var/log/ggd2l
ensure_dir 0750 "root:${ADMIN_USER}" /var/log/ggd2l/builds
ensure_dir 0750 caddy:caddy /var/log/caddy
# Others may traverse, never list: the drill reaches its league's drill/.
ensure_dir 0751 root:ggd2l-ops /var/backups/ggd2l
ensure_dir 0700 root:root /var/backups/ggd2l/cutover
# The daily config archive's output (ggd2l-config-archive.service, as root).
ensure_dir 0700 root:root /var/backups/ggd2l/config
# /etc/ggd2l is root's, but ggd2l-ops may traverse it to open the two files
# made for it (rclone.conf 0600 ggd2l-ops, backup-recipients.txt 0644).
ensure_dir 0710 root:ggd2l-ops /etc/ggd2l
ensure_dir 0700 root:root /etc/ggd2l/secrets
ensure_dir 0700 root:root /etc/ggd2l/fragments
ensure_dir 0750 root:cloudflared /etc/cloudflared
ensure_dir 0750 root:caddy /etc/caddy/ggd2l
for lg in $LEAGUES; do
  ensure_dir 0755 root:root "/srv/ggd2l/${lg}"
  ensure_dir 0751 root:root "/srv/ggd2l/${lg}/releases"
  ensure_dir 0750 "root:ggd2l-${lg}" "/srv/ggd2l/${lg}/slots"
  ensure_dir 0755 root:root "/srv/ggd2l/${lg}/static"
  ensure_dir 0755 root:root "/srv/ggd2l/${lg}/static/_next"
  ensure_dir 0755 root:root "/srv/ggd2l/${lg}/static/_next/static"
  ensure_dir 0755 root:root "/var/lib/ggd2l/${lg}"
  # The drill's group may traverse to drill/ (the handoff), never list.
  ensure_dir 0710 ggd2l-ops:ggd2l-drill "/var/backups/ggd2l/${lg}"
  ensure_user_dir ggd2l-ops 0700 "/var/backups/ggd2l/${lg}/local"
  ensure_user_dir ggd2l-ops 0700 "/var/backups/ggd2l/${lg}/offsite"
  ensure_dir 0700 root:root "/var/backups/ggd2l/cutover/${lg}"
  ensure_dir 0700 ggd2l-drill:ggd2l-drill "/var/lib/ggd2l-drill/${lg}"
done

log "Slot ports (§1.3)"
write_slot_env() { # <league> <slot> <port>
  printf 'PORT=%s\n' "$3" > "/etc/ggd2l/$1-slot-$2.env.tmp"
  chmod 0644 "/etc/ggd2l/$1-slot-$2.env.tmp"
  mv -f "/etc/ggd2l/$1-slot-$2.env.tmp" "/etc/ggd2l/$1-slot-$2.env"
}
write_slot_env us a 3001
write_slot_env us b 3002
write_slot_env eu a 3011
write_slot_env eu b 3012

log "Agent and helpers (/usr/local/lib/ggd2l)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
# Staged beside the live folder (same filesystem) so the swap is two renames.
STAGE="$(mktemp -d "${LIB}.stage.XXXXXX")"
trap 'rm -rf "${STAGE}"' EXIT
# The agent's modules keep their relative layout; its tests and fixtures stay
# in the repo.
( cd "${SELFHOST}/agent" && find . -type f ! -name '*.test.mjs' ! -path '*/fixtures/*' ! -path '*/test/*' ) \
  | while IFS= read -r f; do install -D -m 0644 "${SELFHOST}/agent/${f}" "${STAGE}/${f}"; done
for f in "${SELFHOST}"/backup/*; do
  [[ -f "$f" && "$f" != *.test.mjs ]] || continue
  case "$f" in *.sh) mode=0755 ;; *) mode=0644 ;; esac
  install -m "$mode" "$f" "${STAGE}/$(basename "$f")"
done
install -m 0755 "${SELFHOST}/postgres/provision-league-db.sh" "${STAGE}/provision-league-db.sh"
install -d -m 0755 "${STAGE}/sql" "${STAGE}/caddy" "${STAGE}/cloudflared" "${STAGE}/postgres" "${STAGE}/systemd"
install -m 0644 "${SELFHOST}"/sql/*.sql "${STAGE}/sql/"
for f in $BACKUP_APP_FILES; do install -D -m 0644 "${KIT_ROOT}/${f}" "${STAGE}/app/${f}"; done
# Reference copies: the agent's renderers and the operator read these.
install -m 0644 "${SELFHOST}/caddy/Caddyfile" "${SELFHOST}"/caddy/*.caddy "${SELFHOST}/caddy/maintenance.html" "${STAGE}/caddy/"
install -m 0644 "${SELFHOST}/cloudflared/config.yml.template" "${STAGE}/cloudflared/"
install -m 0644 "${SELFHOST}/postgres/90-ggd2l.conf" "${SELFHOST}/postgres/pg_hba.snippet" "${STAGE}/postgres/"
install -m 0644 "${SELFHOST}"/systemd/*.service "${SELFHOST}"/systemd/*.timer "${STAGE}/systemd/"
printf '{"sha":"%s","installedAt":"%s"}\n' "$SHA" "$STAMP" > "${STAGE}/kit.json"
chmod 0644 "${STAGE}/kit.json"
chown -R root:root "${STAGE}"
chmod 0755 "${STAGE}"
# A real directory, not a symlink to a versioned one: Node resolves symlinks
# in import.meta.url but not in process.argv[1], so a module's "am I the main
# module" check fails through a symlink and env-contract.mjs in ExecStartPre
# would exit 0 without checking anything. The swap is two renames under the
# agent's lock; a slot starting in between fails once and restarts.
rm -rf "${LIB}.old"
if [[ -L "${LIB}" ]]; then
  rm -f "${LIB}"
elif [[ -e "${LIB}" ]]; then
  mv -T "${LIB}" "${LIB}.old"
fi
mv -T "${STAGE}" "${LIB}"
trap - EXIT
rm -rf "${LIB}.old"
cat > "${AGENT_BIN}.new" <<'EOF'
#!/bin/sh
# Installed by ops/selfhost/install-kit.sh: the GGD2L release agent.
exec /usr/bin/node /usr/local/lib/ggd2l/ggd2l-agent.mjs "$@"
EOF
chmod 0755 "${AGENT_BIN}.new"
mv -f "${AGENT_BIN}.new" "${AGENT_BIN}"
note "${LIB} now holds the kit at ${SHA12}"

log "Maintenance page"
install -m 0644 "${SELFHOST}/caddy/maintenance.html" /srv/ggd2l/www/maintenance.html.new
mv -f /srv/ggd2l/www/maintenance.html.new /srv/ggd2l/www/maintenance.html

log "systemd units (installed, never enabled or started here)"
# Each <unit>.d folder is a drop-in for that unit, ours or a package's
# (caddy.service.d gives the packaged Caddy a restart policy).
changed_units=""
install_unit_file() { # <source> <destination>
  if ! cmp -s "$1" "$2"; then
    install -D -m 0644 "$1" "$2"
    changed_units="${changed_units} ${2#${UNIT_DIR}/}"
  fi
}
for src in "${SELFHOST}"/systemd/*.service "${SELFHOST}"/systemd/*.timer; do
  install_unit_file "$src" "${UNIT_DIR}/$(basename "$src")"
done
for dropin in "${SELFHOST}"/systemd/*.d; do
  [[ -d "$dropin" ]] || continue
  for src in "$dropin"/*.conf; do
    install_unit_file "$src" "${UNIT_DIR}/$(basename "$dropin")/$(basename "$src")"
  done
done
systemctl daemon-reload
if [[ -n "$changed_units" ]]; then
  note "changed:${changed_units}"
  live="$(active_units | tr '\n' ' ')"
  [[ -z "$live" ]] || note "running units keep their old definition until restarted: ${live}"
  case " ${changed_units} " in
    *" caddy.service.d/"*)
      note "caddy: Restart= applies from now on; OOMScoreAdjust= and RuntimeDirectory= (the admin socket's folder) from its next start" ;;
  esac
else
  note "unchanged"
fi

log "PostgreSQL ${PG_MAJOR}: settings and access rules (§1.6)"
psql_admin() { runuser -u postgres -- psql -X -q -A -t -v ON_ERROR_STOP=1 -d postgres "$@"; }
PG_SAVE="$(mktemp -d)"
cp -p "${PG_ETC}/pg_hba.conf" "${PG_SAVE}/pg_hba.conf"
[[ ! -e "${PG_ETC}/conf.d/90-ggd2l.conf" ]] || cp -p "${PG_ETC}/conf.d/90-ggd2l.conf" "${PG_SAVE}/90-ggd2l.conf"
pg_changed=0
if ! cmp -s "${SELFHOST}/postgres/90-ggd2l.conf" "${PG_ETC}/conf.d/90-ggd2l.conf"; then
  install -m 0644 -o postgres -g postgres "${SELFHOST}/postgres/90-ggd2l.conf" "${PG_ETC}/conf.d/90-ggd2l.conf"
  pg_changed=1
fi
# The managed block goes first, so it is matched before any packaged rule.
{
  echo "# BEGIN ggd2l: managed by ops/selfhost/install-kit.sh from ops/selfhost/postgres/pg_hba.snippet"
  cat "${SELFHOST}/postgres/pg_hba.snippet"
  echo "# END ggd2l"
  awk '/^# BEGIN ggd2l/ { skip = 1 } !skip { print } /^# END ggd2l/ { skip = 0 }' "${PG_SAVE}/pg_hba.conf"
} > "${PG_SAVE}/pg_hba.new"
if ! cmp -s "${PG_SAVE}/pg_hba.new" "${PG_ETC}/pg_hba.conf"; then
  install -m 0640 -o postgres -g postgres "${PG_SAVE}/pg_hba.new" "${PG_ETC}/pg_hba.conf"
  pg_changed=1
fi
if [[ "$pg_changed" -eq 1 ]]; then
  # Check the files on disk before the server reads them. `postgres -C` parses
  # every setting the way a start would (pg_file_settings cannot tell a bad
  # value from one that merely waits for a restart); pg_hba_file_rules re-reads
  # the access rules.
  settings_ok=1
  runuser -u postgres -- "/usr/lib/postgresql/${PG_MAJOR}/bin/postgres" -D "/var/lib/postgresql/${PG_MAJOR}/main" \
    -c "config_file=${PG_ETC}/postgresql.conf" -C max_connections >/dev/null || settings_ok=0
  bad_rules="$(psql_admin -c "SELECT count(*) FROM pg_catalog.pg_hba_file_rules WHERE error IS NOT NULL")"
  if [[ "$settings_ok" -ne 1 || "$bad_rules" != "0" ]]; then
    install -m 0640 -o postgres -g postgres "${PG_SAVE}/pg_hba.conf" "${PG_ETC}/pg_hba.conf"
    if [[ -e "${PG_SAVE}/90-ggd2l.conf" ]]; then
      install -m 0644 -o postgres -g postgres "${PG_SAVE}/90-ggd2l.conf" "${PG_ETC}/conf.d/90-ggd2l.conf"
    else
      rm -f "${PG_ETC}/conf.d/90-ggd2l.conf"
    fi
    die "PostgreSQL rejected the new settings or access rules (${bad_rules} bad rules); the previous files are back"
  fi
  systemctl reload "postgresql@${PG_MAJOR}-main"
  note "reloaded"
fi
rm -rf "${PG_SAVE}"
pending="$(psql_admin -c "SELECT string_agg(name, ', ' ORDER BY name) FROM pg_catalog.pg_settings WHERE pending_restart")"
if [[ -n "$pending" ]]; then
  live="$(active_units | tr '\n' ' ')"
  if [[ -z "$live" ]]; then
    systemctl restart "postgresql@${PG_MAJOR}-main"
    note "restarted for: ${pending}"
  else
    note "NEEDS A RESTART for ${pending}, but ${live}is running: restart postgresql@${PG_MAJOR}-main in a maintenance window"
  fi
fi

log "League databases and roles (§1.6)"
for lg in $LEAGUES; do
  "${LIB}/provision-league-db.sh" "$lg"
done

log "Caddy (§1.7): every new site starts in maintenance"
caddy_changed=0
for lg in $LEAGUES; do
  mode="/etc/caddy/ggd2l/${lg}-mode.caddy"
  if [[ ! -e "$mode" ]]; then
    install -m 0640 -o root -g caddy "${SELFHOST}/caddy/mode-maintenance.caddy" "$mode"
    note "${lg}: maintenance"
    caddy_changed=1
  else
    note "${lg}: mode file kept as it is"
  fi
done
install -m 0644 "${SELFHOST}/caddy/Caddyfile" /etc/caddy/Caddyfile.ggd2l-new
# Validate as caddy, so any file it creates is one caddy can write later.
if ! runuser -u caddy -- env HOME=/var/lib/caddy caddy validate --adapter caddyfile \
    --config /etc/caddy/Caddyfile.ggd2l-new; then
  rm -f /etc/caddy/Caddyfile.ggd2l-new
  die "caddy validate failed; /etc/caddy/Caddyfile is unchanged"
fi
if cmp -s /etc/caddy/Caddyfile.ggd2l-new /etc/caddy/Caddyfile; then
  rm -f /etc/caddy/Caddyfile.ggd2l-new
else
  [[ ! -e /etc/caddy/Caddyfile ]] || cp -p /etc/caddy/Caddyfile /etc/caddy/Caddyfile.prev
  mv -f /etc/caddy/Caddyfile.ggd2l-new /etc/caddy/Caddyfile
  caddy_changed=1
fi
caddy_reload "$caddy_changed"

log "Cloudflare Tunnel (§1.8)"
uuid=""
count=0
for f in /etc/cloudflared/*.json; do
  [[ -e "$f" ]] || continue
  base="$(basename "$f" .json)"
  if [[ "$base" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
    uuid="$base"
    count=$((count + 1))
  fi
done
if [[ "$count" -eq 0 ]]; then
  note "no tunnel credentials in /etc/cloudflared yet: config.yml not written (re-run after 'tunnel create')"
elif [[ "$count" -gt 1 ]]; then
  note "more than one tunnel credentials file in /etc/cloudflared: config.yml not written; keep only the ggd2l tunnel's"
else
  chown cloudflared:cloudflared "/etc/cloudflared/${uuid}.json"
  chmod 0400 "/etc/cloudflared/${uuid}.json"
  sed "s/<TUNNEL_UUID>/${uuid}/g" "${SELFHOST}/cloudflared/config.yml.template" > /etc/cloudflared/config.yml.new
  if grep -q '<TUNNEL_UUID>' /etc/cloudflared/config.yml.new; then
    rm -f /etc/cloudflared/config.yml.new
    die "the tunnel config template did not render"
  fi
  cloudflared tunnel --config /etc/cloudflared/config.yml.new ingress validate >/dev/null \
    || { rm -f /etc/cloudflared/config.yml.new; die "cloudflared rejected the rendered ingress rules"; }
  if cmp -s /etc/cloudflared/config.yml.new /etc/cloudflared/config.yml; then
    rm -f /etc/cloudflared/config.yml.new
    note "config.yml unchanged (tunnel ${uuid})"
  else
    chown cloudflared:cloudflared /etc/cloudflared/config.yml.new
    chmod 0400 /etc/cloudflared/config.yml.new
    mv -f /etc/cloudflared/config.yml.new /etc/cloudflared/config.yml
    note "config.yml written for tunnel ${uuid}"
    if systemctl is-active --quiet cloudflared-ggd2l.service; then
      note "cloudflared-ggd2l is running the old routes until: systemctl restart cloudflared-ggd2l"
    fi
  fi
fi

log "Source mirror /srv/ggd2l/repo.git (public, https, no credentials)"
[[ "$REPO_URL" =~ ^https://[^[:space:]@]+$ ]] || die "GGD2L_REPO_URL must be an https URL without credentials"
if [[ ! -f /srv/ggd2l/repo.git/HEAD ]]; then
  as_build git init --quiet --bare /srv/ggd2l/repo.git
fi
origin="$(as_build git -C /srv/ggd2l/repo.git remote get-url origin 2>/dev/null || true)"
if [[ -z "$origin" ]]; then
  as_build git -C /srv/ggd2l/repo.git remote add origin "$REPO_URL"
elif [[ "$origin" != "$REPO_URL" ]]; then
  as_build git -C /srv/ggd2l/repo.git remote set-url origin "$REPO_URL"
fi
note "origin ${REPO_URL}"

log "Record"
printf '{"sha":"%s","installedAt":"%s"}\n' "$SHA" "$STAMP" > /var/lib/ggd2l/kit.json.new
chmod 0644 /var/lib/ggd2l/kit.json.new
mv -f /var/lib/ggd2l/kit.json.new /var/lib/ggd2l/kit.json
printf '%s %s %s\n' "$STAMP" "$SHA" "${SUDO_USER:-root}" >> /var/log/ggd2l/kit-installs.log
note "kit ${SHA} installed at ${STAMP}"

cat <<EOF

Check (as root):
  systemd-analyze verify ggd2l-us@a.service ggd2l-us@b.service ggd2l-eu@a.service ggd2l-eu@b.service \\
    cloudflared-ggd2l.service ggd2l-bot.service ggd2l-heartbeat.service ggd2l-heartbeat.timer \\
    ggd2l-backup@us.service ggd2l-backup@us.timer ggd2l-backup@eu.timer \\
    ggd2l-drill@us.service ggd2l-drill@us.timer ggd2l-drill@eu.timer \\
    ggd2l-config-archive.service ggd2l-config-archive.timer ggd2l-alert@backup-us.service caddy.service
  systemctl show -p Restart -p OOMScoreAdjust caddy.service   # the unit's settings: Restart=on-failure, OOMScoreAdjust=-500
  cat /proc/\$(systemctl show -p MainPID --value caddy.service)/oom_score_adj   # the running Caddy: -500 only after its next start
  # (choom -p <that pid> -n -500 applies it now, without the blink of a restart)
  runuser -u caddy -- env HOME=/var/lib/caddy caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile
  stat -c '%A %U:%G %n' /run/caddy ${CADDY_ADMIN_SOCKET}   # drwx------ caddy:caddy, then srw------- caddy:caddy
  curl -sS -m 3 http://localhost:2019/config/   # refused: the admin API is only the socket
  ggd2l-agent status
EOF
