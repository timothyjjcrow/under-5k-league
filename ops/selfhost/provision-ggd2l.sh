#!/usr/bin/env bash
# Rebuild a GGD2L box from zero (design §5.1 "Recovery from total loss", about
# an hour): the operating-system layer, then the league layer, from a clone at
# the commit the leagues were live on. Run as root on a fresh Ubuntu 24.04
# droplet:
#
#   git clone https://github.com/timothyjjcrow/under-5k-league.git /root/ggd2l-kit
#   git -C /root/ggd2l-kit checkout --detach <live sha>
#   bash /root/ggd2l-kit/ops/selfhost/provision-ggd2l.sh <live sha>
#
# It runs provision-base.sh and install-kit.sh <sha>, both idempotent, so it is
# also safe to re-run after a failure. It moves no data and no secret: the
# steps it prints afterwards restore those from Tim's encrypted offsite copies.
set -euo pipefail

[[ $# -eq 1 && "$1" =~ ^[0-9a-f]{40}$ ]] || { echo "usage: provision-ggd2l.sh <40-hex commit sha>" >&2; exit 2; }
SHA="$1"
[[ "$(id -u)" -eq 0 ]] || { echo "run as root" >&2; exit 1; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
KIT_ROOT="$(cd "${HERE}/../.." && pwd -P)"

# Check the clone before changing anything; install-kit.sh checks it again.
command -v git >/dev/null || { echo "git is missing: apt-get install -y git, then re-run" >&2; exit 1; }
head="$(git -c safe.directory="${KIT_ROOT}" -C "${KIT_ROOT}" rev-parse HEAD)"
[[ "$head" == "$SHA" ]] || { echo "the clone at ${KIT_ROOT} is at ${head}, not ${SHA}" >&2; exit 1; }

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
 2. On the Mac, decrypt the newest config archive and the newest dump of each
    league with Tim's offline age key; scp them to the box (0600).
 3. Restore /etc/ggd2l and /etc/cloudflared from the archive, then re-run
    install-kit.sh ${SHA} so the database roles take the restored passwords
    and the tunnel config renders.
 4. ggd2l-agent prepare ${SHA}, then for us and eu:
    ggd2l-agent import <lg> <dump>; identity <lg> (a box dump already carries
    its markers, so it changes nothing); build <lg> ${SHA}; start;
    check --expect production; promote
 5. systemctl enable --now cloudflared-ggd2l, then the timers:
    ggd2l-backup@us.timer ggd2l-backup@eu.timer ggd2l-drill@us.timer
    ggd2l-drill@eu.timer ggd2l-heartbeat.timer (and ggd2l-bot after §7).
EOF
