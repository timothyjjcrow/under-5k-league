#!/usr/bin/env bash
# Rebuild a GGD2L box from zero (design §5.1 "Recovery from total loss", about
# an hour): the operating-system layer, then the league layer, from a clone at
# the commit the leagues were live on. Run as root on a fresh Ubuntu 24.04
# droplet, from a clone root makes and owns:
#
#   git clone https://github.com/timothyjjcrow/under-5k-league.git /root/ggd2l-kit
#   git -C /root/ggd2l-kit checkout --detach <live sha>
#   bash /root/ggd2l-kit/ops/selfhost/provision-ggd2l.sh <live sha>
#
# It runs provision-base.sh and install-kit.sh <sha>, both idempotent, so it is
# also safe to re-run after a failure. It moves no data and no secret: the
# steps it prints afterwards restore those from Tim's encrypted offsite copies.
set -euo pipefail

die() { echo "provision-ggd2l: $*" >&2; exit 1; }

# kit_untrusted <dir>: print the first path that someone other than root could
# use to change what root runs from <dir>, or nothing. Every entry under <dir>
# must be root's and writable by no group or other user (a symlink's own mode
# means nothing), and every directory above it root's and not writable by
# others unless sticky, so nobody can swap the clone out. "Root" means root or
# whoever runs this; the script then requires that to be root. The same
# function is in install-kit.sh.
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

[[ $# -eq 1 && "$1" =~ ^[0-9a-f]{40}$ ]] || { echo "usage: provision-ggd2l.sh <40-hex commit sha>" >&2; exit 2; }
SHA="$1"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
KIT_ROOT="$(cd "${HERE}/../.." && pwd -P)"

# Check the clone before changing anything; install-kit.sh checks it again.
# Root runs scripts and git from it, so no other user may be able to change it.
untrusted="$(kit_untrusted "${KIT_ROOT}")" || die "could not inspect the clone ${KIT_ROOT}"
[[ -z "$untrusted" ]] \
  || die "${untrusted} is owned or writable by a user other than root; run this only from root's own clone (see the header)"
# The agent locks every release and bot release down to root once the build
# user's npm has run in it, so they pass the check above; what is in them is
# still the build user's work. A tools clone stays the build user's, which
# the check above refuses. The same refusal is in install-kit.sh.
case "${KIT_ROOT}/" in
  /srv/ggd2l/*) die "${KIT_ROOT} is a clone the build user made; run this only from root's own clone (see the header)" ;;
esac
[[ "$(id -u)" -eq 0 ]] || die "run as root"
command -v git >/dev/null || die "git is missing: apt-get install -y git, then re-run"
head="$(git -c core.fsmonitor=false -c core.hooksPath=/dev/null -C "${KIT_ROOT}" rev-parse HEAD)"
[[ "$head" == "$SHA" ]] || die "the clone at ${KIT_ROOT} is at ${head}, not ${SHA}"

printf '\n#### 1/2 Operating system (provision-base.sh)\n'
bash "${HERE}/provision-base.sh"

printf '\n#### 2/2 League layer (install-kit.sh %s)\n' "${SHA:0:12}"
bash "${HERE}/install-kit.sh" "$SHA"

cat <<EOF

The box is provisioned at ${SHA:0:12}: services installed but disabled, every
site in maintenance, empty league databases. To bring the leagues back
(design §5.1; secrets move file to file only, never through chat or argv):

 1. From a second terminal, confirm 'ssh ${ADMIN_USER:-ggd2l}@<box> sudo true' works,
    then close root login: bash ${HERE}/harden-ssh.sh
 2. Point the Mac's ggd2l-1 alias at this box. On the Mac, decrypt the newest
    config archive (R2 config/<date>/config-<stamp>.tar.gz.age) with Tim's
    offline age key and stream it straight in, so no plaintext lands on
    either disk:
      age -d -i <key file> config-<stamp>.tar.gz.age | ssh ggd2l-1 'sudo tar -C / -xzpf -'
    That restores /etc/ggd2l, /etc/cloudflared, /etc/caddy and (in an
    archive from 2026-10-19 on) the lobby bot's state, /var/lib/ggd2l-bot.
 3. Re-run install-kit.sh ${SHA}, so the database roles take the restored
    passwords, owners and modes match the new users, and the tunnel config
    renders.
 4. Decrypt the newest dump of each league on the Mac and copy it with its
    .sha256 into /var/backups/ggd2l/cutover/<lg>/ (root, 0600).
 5. ggd2l-agent prepare ${SHA}, then for us and eu:
    ggd2l-agent import <lg> <dump file>; grants-check <lg>;
    preflight <lg> ${SHA}; build <lg> ${SHA}; start; check --expect production;
    promote. Skip identity: a box dump already carries its markers (the build
    attests them), and identity refuses a database it would not change.
 6. systemctl enable --now cloudflared-ggd2l, then the timers:
    ggd2l-backup@us.timer ggd2l-backup@eu.timer ggd2l-drill@us.timer
    ggd2l-drill@eu.timer ggd2l-heartbeat.timer ggd2l-config-archive.timer.
    Take one backup per league and watch healthchecks go green.
 7. The lobby bot, once the old box's bot is surely stopped (one Steam
    account never runs in two places): ggd2l-agent bot-deploy ${SHA}, then
    systemctl enable --now ggd2l-bot and ggd2l-agent bot-status. With no
    saved session in /var/lib/ggd2l-bot Tim signs it in from his own
    terminal first; if Steam refuses the saved one, stop the unit, Tim signs
    it in, start it (ops/selfhost/README.md, Rebuild from zero, step 7).
EOF
