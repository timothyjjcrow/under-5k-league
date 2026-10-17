#!/usr/bin/env bash
# Compose /etc/ggd2l/<lg>.env on the box (design §1.4, §6 P4/W9/E6). Run as
# root:  bash compose-env.sh us|eu [--keep-secrets]
#
# Inputs, all root-only:
#   /etc/ggd2l/inputs/<lg>.partial    from env-partial.mjs on the Mac (piped
#                                     over ssh into `install -m 0600 /dev/stdin`)
#   /etc/ggd2l/fragments/<lg>-db.env  DATABASE_URL = DIRECT_URL for the app
#                                     role (provision-league-db.sh)
# It generates AUTH_SECRET, CRON_SECRET and BACKUP_RECEIPT_SECRET fresh
# (Vercel's are Sensitive and unreadable; everyone signs in again on the new
# origin anyway), and keeps NEXT_SERVER_ACTIONS_ENCRYPTION_KEY from the current
# env file when there is one, so a rehearsal build and the production runtime
# agree and open forms survive releases. --keep-secrets keeps all four from the
# current file instead: a later pass that only adds a value (the US bot token
# after the site opens) must not sign everyone out or break the scheduler.
#
# The new file is checked by the env contract before it replaces the old one;
# nothing is printed but key names and the contract's verdict. The partial is
# shredded afterwards.
set -euo pipefail
umask 077

lg="${1:-}"
keep="${2:-}"
[[ "$lg" == "us" || "$lg" == "eu" ]] || { echo "usage: compose-env.sh us|eu [--keep-secrets]" >&2; exit 2; }
[[ -z "$keep" || "$keep" == "--keep-secrets" ]] || { echo "usage: compose-env.sh us|eu [--keep-secrets]" >&2; exit 2; }
[[ "$(id -u)" -eq 0 ]] || { echo "compose-env: run as root" >&2; exit 1; }

ETC=/etc/ggd2l
PARTIAL="${ETC}/inputs/${lg}.partial"
FRAGMENT="${ETC}/fragments/${lg}-db.env"
TARGET="${ETC}/${lg}.env"
NEW="${TARGET}.new"
CONTRACT=/usr/local/lib/ggd2l/env-contract.mjs

[[ -s "$PARTIAL" ]] || { echo "compose-env: ${PARTIAL} is missing or empty" >&2; exit 1; }
[[ -s "$FRAGMENT" ]] || { echo "compose-env: ${FRAGMENT} is missing; run provision-league-db.sh ${lg}" >&2; exit 1; }

key_of() { sed -n "s/^$1=//p" "$2" | head -n 1; }

action_key=""
[[ -s "$TARGET" ]] && action_key="$(key_of NEXT_SERVER_ACTIONS_ENCRYPTION_KEY "$TARGET")"
[[ -n "$action_key" ]] || action_key="$(openssl rand -base64 32)"

secret() { # name: the current file's value with --keep-secrets, else a fresh one
  local value=""
  if [[ -n "$keep" ]]; then
    [[ -s "$TARGET" ]] && value="$(key_of "$1" "$TARGET")"
    [[ -n "$value" ]] || { echo "compose-env: --keep-secrets but ${TARGET} has no $1" >&2; exit 1; }
  else
    value="$(openssl rand -hex 32)"
  fi
  printf '%s=%s\n' "$1" "$value"
}

{
  # The partial must not carry what this script owns.
  grep -Ev '^(DATABASE_URL|DIRECT_URL|AUTH_SECRET|CRON_SECRET|BACKUP_RECEIPT_SECRET|NEXT_SERVER_ACTIONS_ENCRYPTION_KEY)=' "$PARTIAL"
  grep -E '^(DATABASE_URL|DIRECT_URL)=' "$FRAGMENT"
  secret AUTH_SECRET
  secret CRON_SECRET
  secret BACKUP_RECEIPT_SECRET
  printf 'NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=%s\n' "$action_key"
} > "$NEW"
chown root:root "$NEW"
chmod 0600 "$NEW"

if ! node "$CONTRACT" --league "$lg" --file "$NEW"; then
  rm -f "$NEW"
  echo "compose-env: the env contract refused the new ${lg}.env; the old file is unchanged" >&2
  exit 1
fi
mv -f "$NEW" "$TARGET"
shred -u "$PARTIAL"
echo "compose-env: ${TARGET} written ($(sed -n 's/^\([A-Z0-9_]*\)=.*/\1/p' "$TARGET" | wc -l) keys); the partial is shredded"
