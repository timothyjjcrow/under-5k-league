#!/usr/bin/env bash
# Close root SSH login. Run as root only AFTER `ssh <admin>@<box> sudo true`
# works from a second terminal, or you can lock yourself out (the DigitalOcean
# web console still works as a last resort).
set -euo pipefail
ADMIN_USER="${ADMIN_USER:-ggd2l}"
if [[ ! -s "/home/${ADMIN_USER}/.ssh/authorized_keys" ]]; then
  echo "${ADMIN_USER} has no authorized_keys; refusing to close root login" >&2
  exit 1
fi
cat > /etc/ssh/sshd_config.d/11-ggd2l-no-root.conf <<'EOF'
PermitRootLogin no
EOF
install -d -m 755 /run/sshd
sshd -t
systemctl try-reload-or-restart ssh.service
echo "root SSH login closed; log in as ${ADMIN_USER}"
