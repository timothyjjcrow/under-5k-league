#!/usr/bin/env bash
# Base provisioning for a GGD2L self-host box (Ubuntu 24.04 LTS, x86_64).
#
# Run as root on a fresh droplet:  bash provision-base.sh
# Idempotent: every step checks before it changes, so a re-run is safe.
#
# This installs the operating-system layer only: security updates, swap, the
# firewall, an admin user, Node 22, PostgreSQL 18, Caddy, cloudflared and
# rclone. It creates no league database, service, credential or web route;
# install-kit.sh installs the league layer (see ops/selfhost/README.md).
set -euo pipefail

ADMIN_USER="${ADMIN_USER:-ggd2l}"
NODE_MAJOR=22
PG_MAJOR=18
SWAP_SIZE_GB=4

log() { printf '\n== %s\n' "$*"; }

if [[ "$(id -u)" -ne 0 ]]; then echo "run as root" >&2; exit 1; fi
. /etc/os-release
if [[ "${ID}" != "ubuntu" || "${VERSION_CODENAME}" != "noble" ]]; then
  echo "expected Ubuntu 24.04 (noble), found ${PRETTY_NAME}" >&2; exit 1
fi
export DEBIAN_FRONTEND=noninteractive

log "Packages: update and base tools"
apt-get update -q
apt-get -y -q -o Dpkg::Options::=--force-confold upgrade
apt-get install -y -q ca-certificates curl gnupg ufw unattended-upgrades \
  apt-listchanges rsync jq git age logrotate needrestart rclone

log "Swap: ${SWAP_SIZE_GB} GiB (builds need more than 2 GiB of memory)"
if ! swapon --show=NAME --noheadings | grep -q '^/swapfile$'; then
  if [[ ! -f /swapfile ]]; then
    fallocate -l "${SWAP_SIZE_GB}G" /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile
fi
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
cat > /etc/sysctl.d/90-ggd2l.conf <<'EOF'
# Prefer RAM; swap exists for builds and spikes, not steady state.
vm.swappiness = 10
EOF
sysctl -q --system

log "Journald: cap disk use"
mkdir -p /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/90-ggd2l.conf <<'EOF'
[Journal]
SystemMaxUse=500M
MaxRetentionSec=30day
EOF
systemctl restart systemd-journald

log "Unattended security upgrades, reboot at 09:00 UTC when required"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
cat > /etc/apt/apt.conf.d/52ggd2l-unattended <<'EOF'
// 09:00 UTC is 1-2 AM in the US league's zone and late morning in Europe,
// outside both leagues' match nights.
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "09:00";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
// The runtimes' own repositories too (design D25), matched on the Release
// metadata each one publishes, so a fix to PostgreSQL, Node, Caddy or the
// tunnel lands in the same window. A new major never arrives this way: the
// PostgreSQL major is part of the package name (postgresql-18), NodeSource's
// repository carries one Node major, and 90-ggd2l-majors pins nodejs and caddy.
Unattended-Upgrade::Origins-Pattern {
	"origin=apt.postgresql.org,codename=noble-pgdg";
	"site=deb.nodesource.com,codename=nodistro";
	"origin=cloudsmith/caddy/stable,codename=any-version";
	"origin=cloudflared,codename=any";
};
EOF
cat > /etc/apt/preferences.d/90-ggd2l-majors <<'EOF'
# A runtime's major version changes only by hand. (The PostgreSQL major is in
# its package name, postgresql-18.)
Package: nodejs
Pin: version 22.*
Pin-Priority: 1001

Package: caddy
Pin: version 2.*
Pin-Priority: 1001
EOF
systemctl enable --now unattended-upgrades >/dev/null

log "Admin user ${ADMIN_USER}: key-only sudo login"
if ! id "${ADMIN_USER}" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "${ADMIN_USER}"
fi
usermod -aG sudo "${ADMIN_USER}"
install -d -m 700 -o "${ADMIN_USER}" -g "${ADMIN_USER}" "/home/${ADMIN_USER}/.ssh"
if [[ ! -s "/home/${ADMIN_USER}/.ssh/authorized_keys" ]]; then
  install -m 600 -o "${ADMIN_USER}" -g "${ADMIN_USER}" /root/.ssh/authorized_keys \
    "/home/${ADMIN_USER}/.ssh/authorized_keys"
fi
# The account has no password, so sudo cannot prompt for one.
echo "${ADMIN_USER} ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/90-${ADMIN_USER}"
chmod 440 "/etc/sudoers.d/90-${ADMIN_USER}"
visudo -cq

log "SSH: keys only (root login is closed by harden-ssh.sh once ${ADMIN_USER} works)"
cat > /etc/ssh/sshd_config.d/10-ggd2l.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
X11Forwarding no
MaxAuthTries 3
EOF
# Ubuntu 24.04 starts sshd from a socket, so its runtime folder may not
# exist yet; `sshd -t` needs it to check the configuration.
install -d -m 755 /run/sshd
sshd -t
systemctl try-reload-or-restart ssh.service

log "Firewall: deny inbound except SSH (web ports open with the web layer)"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
ufw --force enable >/dev/null
ufw status verbose

keyring() { # url dest
  curl -fsSL "$1" | gpg --dearmor --yes -o "$2"
  chmod 644 "$2"
}

log "Node ${NODE_MAJOR} (NodeSource apt repository, signed)"
if [[ ! -f /etc/apt/sources.list.d/nodesource.list ]]; then
  keyring https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key /usr/share/keyrings/nodesource.gpg
  echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
fi

log "PostgreSQL ${PG_MAJOR} (PGDG apt repository, signed)"
if [[ ! -f /etc/apt/sources.list.d/pgdg.list ]]; then
  keyring https://www.postgresql.org/media/keys/ACCC4CF8.asc /usr/share/keyrings/pgdg.gpg
  echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt noble-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list
fi

log "Caddy (official apt repository, signed)"
if [[ ! -f /etc/apt/sources.list.d/caddy-stable.list ]]; then
  keyring https://dl.cloudsmith.io/public/caddy/stable/gpg.key /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" \
    > /etc/apt/sources.list.d/caddy-stable.list
fi

log "cloudflared (Cloudflare apt repository, signed)"
if [[ ! -f /etc/apt/sources.list.d/cloudflared.list ]]; then
  # Cloudflare publishes this keyring already dearmored.
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
  chmod 644 /usr/share/keyrings/cloudflare-main.gpg
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
    > /etc/apt/sources.list.d/cloudflared.list
fi

apt-get update -q
apt-get install -y -q nodejs "postgresql-${PG_MAJOR}" "postgresql-client-${PG_MAJOR}" caddy cloudflared

log "PostgreSQL: localhost only"
PG_CONF="/etc/postgresql/${PG_MAJOR}/main/postgresql.conf"
grep -q "^listen_addresses = 'localhost'" "${PG_CONF}" || \
  sed -i "s/^#\?listen_addresses = .*/listen_addresses = 'localhost'/" "${PG_CONF}"
systemctl enable --now "postgresql@${PG_MAJOR}-main" >/dev/null
systemctl restart "postgresql@${PG_MAJOR}-main"

log "Caddy: installed, idle until the web layer is configured"
systemctl enable caddy >/dev/null

log "Package window: unattended upgrades at 08:00 UTC, before the 09:00 reboot"
# Stock Ubuntu installs them at 06:00-07:00 UTC (apt-daily-upgrade.timer: 6:00
# plus up to an hour), which is late evening in the US league's zone. A
# PostgreSQL update restarts the cluster as it installs, dropping both
# leagues' connections, and needrestart may restart a live slot, the bot or
# the tunnel whose Node or libraries changed: those belong in the quiet window
# with the reboot. 08:00-08:10 leaves the run time to finish before 09:00 (one
# still going at 09:00 would push `shutdown -r 09:00` to the next day). This
# step comes after every apt-get here: a timer whose new time has passed since
# its last run fires at once, and its run would hold the dpkg lock. The box
# that predates it got the same file by hand (ops/selfhost/README.md).
mkdir -p /etc/systemd/system/apt-daily-upgrade.timer.d
cat > /etc/systemd/system/apt-daily-upgrade.timer.d/90-ggd2l.conf <<'EOF'
# GGD2L (ops/selfhost/provision-base.sh): unattended upgrades install at
# 08:00-08:10 UTC, so their restarts land before the 09:00 UTC reboot.
[Timer]
OnCalendar=
OnCalendar=*-*-* 08:00 UTC
RandomizedDelaySec=10m
EOF
systemctl daemon-reload

log "Firmware: no fwupd metadata refresh on a VM"
# Stock Ubuntu's fwupd-refresh.timer fetches firmware metadata from
# cdn.fwupd.org about once an hour, but a droplet has no firmware for fwupd
# to update. When that CDN stopped answering the box (2026-10-21, from 11:00
# UTC) every run failed, and the heartbeat paged the failed unit, then its
# recovery when the next run began, about once an hour. Masked, not just
# disabled: nothing, a package script included, can start a masked unit.
# Masking a waiting timer fails it in the reload ("Unit to trigger
# vanished"), and the heartbeat would page that too, so both units are
# cleared once masked (on ggd2l-1, 2026-10-21 14:42 UTC).
systemctl mask --now fwupd-refresh.timer
for unit in fwupd-refresh.timer fwupd-refresh.service; do
  if systemctl is-failed --quiet "${unit}"; then systemctl reset-failed "${unit}"; fi
done

log "Versions"
node --version
npm --version
psql --version
caddy version
cloudflared --version
rclone --version | sed -n 1p
age --version
swapon --show
free -m
