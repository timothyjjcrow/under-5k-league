#!/usr/bin/env bash
# Base provisioning for a GGD2L self-host box (Ubuntu 24.04 LTS, x86_64).
#
# Run as root on a fresh droplet:  bash provision-base.sh
# Idempotent: every step checks before it changes, so a re-run is safe.
#
# This installs the operating-system layer only: security updates, swap, the
# firewall, an admin user, Node 22, PostgreSQL 18 and Caddy. It creates no
# league database, service, credential or web route; the league layer is
# provisioned separately (see ops/selfhost/README.md).
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
  apt-listchanges rsync jq git age logrotate needrestart

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

apt-get update -q
apt-get install -y -q nodejs "postgresql-${PG_MAJOR}" "postgresql-client-${PG_MAJOR}" caddy

log "PostgreSQL: localhost only"
PG_CONF="/etc/postgresql/${PG_MAJOR}/main/postgresql.conf"
grep -q "^listen_addresses = 'localhost'" "${PG_CONF}" || \
  sed -i "s/^#\?listen_addresses = .*/listen_addresses = 'localhost'/" "${PG_CONF}"
systemctl enable --now "postgresql@${PG_MAJOR}-main" >/dev/null
systemctl restart "postgresql@${PG_MAJOR}-main"

log "Caddy: installed, idle until the web layer is configured"
systemctl enable caddy >/dev/null

log "Versions"
node --version
npm --version
psql --version
caddy version
age --version
swapon --show
free -m
