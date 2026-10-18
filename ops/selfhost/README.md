# GGD2L box: condensed runbook

Both leagues (US and Europe) run on one DigitalOcean droplet, `ggd2l-1`, behind
a Cloudflare Tunnel. This page is the short version for whoever operates it.
[docs/RELEASING.md](../../docs/RELEASING.md) and
[docs/PRODUCTION-OPERATIONS.md](../../docs/PRODUCTION-OPERATIONS.md) stay the
source of truth for releases, migrations, approval and incident handling; where
this page and they disagree, they win.

Reach the box as the admin user from the Mac with `ssh ggd2l-1` (an alias in
`~/.ssh/config` that pins the host key). Tooling that connects for you reads the
alias from `GGD2L_BOX_SSH`, default `ggd2l-1`. Every privileged action goes
through the release agent, one verb per call:

```bash
ssh ggd2l-1 sudo -n ggd2l-agent status
```

**Secrets never travel through argv, logs, stdout, commits or chat.** Move them
file to file (`scp -p` into a 0700 folder, then `shred -u` the source); psql
passwords go on stdin; healthchecks ping URLs go to curl on stdin.

## Layout

```
Browser ─> Cloudflare edge ─> tunnel (outbound from the box) ─> cloudflared
  ─> Caddy 127.0.0.1:8080 ─┬─ us.ggd2l.com      ─> 3001 (us@a) | 3002 (us@b)
                           ├─ eu.ggd2l.com      ─> 3011 (eu@a) | 3012 (eu@b)
                           └─ ggd2l.com, www    ─> 302 https://us.ggd2l.com{uri}
PostgreSQL 18 127.0.0.1:5432: ggd2l_us, ggd2l_eu (ld2l_restore_test only during drills)
Lobby bot 127.0.0.1:8090 <─ the sites over loopback once it moves here (the relay Worker until then)
Cloudflare Workers: the minute scheduler ─> https://{us,eu}.ggd2l.com/api/cron/automation
R2 bucket ggd2l-backups: age-encrypted dumps and config archives
```

Ubuntu 24.04, 1 vCPU, 2 GB RAM plus 4 GB swap, ufw open for SSH only, unattended
upgrades with a reboot window at 09:00 UTC, journald capped at 500 MB.

| What | Where |
|---|---|
| Release agent | `/usr/local/sbin/ggd2l-agent` (runs `/usr/local/lib/ggd2l/ggd2l-agent.mjs`) |
| Agent modules, env contract, renderers | `/usr/local/lib/ggd2l/` |
| SQL (parity, grants, scrub, identity) | `/usr/local/lib/ggd2l/sql/<name>.sql` |
| Shell helpers | `/usr/local/lib/ggd2l/{provision-league-db,backup-league,drill-league,heartbeat,config-archive}.sh` |
| Releases, slots, live pointer | `/srv/ggd2l/<lg>/releases/<id>/`, `/srv/ggd2l/<lg>/slots/{a,b}`, `/var/lib/ggd2l/<lg>/live.json` |
| Union static files (14-day prune) | `/srv/ggd2l/<lg>/static/_next/static/` |
| Tools clones (migrate, attest, drill) | `/srv/ggd2l/tools/<sha12>/`, `/srv/ggd2l/tools/current` |
| Settings and secrets (root) | `/etc/ggd2l/` |
| Caddy mode files | `/etc/caddy/ggd2l/{us,eu}-mode.caddy`, `/etc/caddy/ggd2l/allow.caddy` |
| Tunnel | `/etc/cloudflared/config.yml`, `/etc/cloudflared/<uuid>.json` |
| Backups | `/var/backups/ggd2l/<lg>/{local,offsite,state}/`, `/var/backups/ggd2l/config/` |
| Cutover dumps | `/var/backups/ggd2l/cutover/<lg>/` (root, 0700) |
| Logs | journald; Caddy JSON access logs in `/var/log/caddy/{us,eu,apex}.access.json` |

Units: `ggd2l-us@{a,b}.service`, `ggd2l-eu@{a,b}.service` (only the live slot is
enabled), `cloudflared-ggd2l.service`, `ggd2l-backup@<lg>.timer`,
`ggd2l-drill@<lg>.timer`, `ggd2l-heartbeat.timer`, `ggd2l-config-archive.timer`,
`ggd2l-bot.service`.

Linux users: `ggd2l` (admin, sudo), `ggd2l-build` (builds; holds no secret),
`ggd2l-us` and `ggd2l-eu` (the web slots), `ggd2l-ops` (backups, drills,
heartbeat), `ggd2l-bot`.

## Rules that are different on the box

- The box's Postgres **is production**. Never run `test:pg`, `pg:up`, the test
  suites or `db:push` there; production database names are never test names.
- **Exactly one clock** runs scheduled work: the Cloudflare Worker. No systemd
  timer or in-process cron may call `/api/cron/automation`.
- Never probe `/api/sync` or `/api/health/automation` on a candidate slot.
- Every unit refuses to start without a valid `LEAGUE_DEPLOY_ENV`; only
  `production` lets the site write to Discord.
- `ggd2l-bot.service` refuses to start on an env that breaks the bot's
  contract (`env-contract.mjs --bot`, names only): `DOTA_BOT_STATE_DIR`
  exactly `/var/lib/ggd2l-bot`, a 32+ character `DOTA_LOBBY_BOT_SECRET`, no
  `STEAM_BOT_PASSWORD`, and `NODE_ENV`, `HOST` and `PORT` in `bot.env` only
  as the unit's own `production`, `127.0.0.1` and `8090` (any other value
  would override the unit's). Check a file before installing it with
  `node /usr/local/lib/ggd2l/env-contract.mjs --bot --file <path>`. Five
  failed starts in ten minutes leave the unit failed instead of restarting
  forever.

## Daily operations

- **Status:** `ssh ggd2l-1 sudo -n ggd2l-agent status` shows units, live SHAs,
  slots, disk, memory, swap, the last backup and drill, a pending reboot and the
  5xx count for the last 24 h.
- **Logs:** `ssh ggd2l-1 sudo journalctl -u ggd2l-us@a -f` (the live slot);
  `sudo -n ggd2l-agent logs us <sinceMs>` returns the 5xx and error rows.
- **Alerts** come from healthchecks.io by email:

  | Check | Means | First look |
  |---|---|---|
  | `box` | A live league's `/api/health/ready` failed through Cloudflare, `/` is 85% full, MemAvailable is under 150 MB, swap use is over 1.5 GB, or a unit has failed. The `/fail` body names which. | `ggd2l-agent status`; `systemctl --failed` |
  | `automation` | No healthy `/api/health/automation` for 30 min | the scheduler Worker; the slot's journal |
  | `backup-us`, `backup-eu` | No successful backup for 2 h, or a `/fail` naming the step | `journalctl -u ggd2l-backup@us` |
  | `drill` | A weekly restore drill failed (the `/fail` body names the league and step), or none passed for 8 days | `journalctl -u ggd2l-drill@us -u ggd2l-drill@eu` |
  | `bot` | `ggd2l-bot` inactive for 20 min | `journalctl -u ggd2l-bot` |
  | `config` | The daily config archive failed or never ran | `journalctl -u ggd2l-config-archive` |

  A failed unit keeps `box` red until it is cleared. After you have fixed the
  cause, run `sudo systemctl reset-failed <unit>`.
- **The 09:00 UTC reboot** brings back exactly the enabled (live) slots. The
  `box` check's 15-minute grace covers it.
- **Maintenance page:** `sudo -n ggd2l-agent mode <lg> maintenance`, and
  `mode <lg> proxy` to reopen. During a planned maintenance window `box` goes
  red for that league; pause the check in healthchecks for the window.
- **During the cutover day** the heartbeat probes only the leagues listed in
  `GGD2L_HEARTBEAT_LEAGUES` (in `healthchecks.env`, default `us eu`). Set it to
  `us` until Europe moves, then remove it.

## Release

Routine release, from a clean `main` checkout on the Mac, inside the release
window (07:00-19:00 UTC, never during a match night, an inhouse night or a
draft):

```bash
npm run release:both -- --apply
```

Plain `npm run release:both` (or `-- --check`) only plans and says so. It runs `scripts/release-box.mjs`: it refuses a SHA whose exact-SHA CI run is
not green, builds both leagues on the box (`agent build`), starts and smoke-tests
each candidate (`start`, `check --expect production`), promotes US then Europe
(`promote`, then the canonical release check through Cloudflare), waits for two
scheduled automation passes in the Caddy log, retires the old slots after 90 s
and prunes. Any failure promotes both leagues back to their base release.

**A migration or scheduler change** is a maintenance release (RELEASING
Appendix B): pause the scheduler and prove the quiet window
(`agent cron-requests`, `agent lease`), take a fresh dump (`agent backup <lg>`),
`agent prepare <sha>` and `agent drill <lg> <sha>`, then `agent migrate <lg> <sha>`,
then `npm run release:both -- --apply --maintenance-file <file>`, then resume the
scheduler and wait for two passes. The evidence's "PITR point" is the dump's
sha256 and its R2 key (`state/last-backup.json`).

**Kit changes** (anything in `ops/selfhost/`) never ride an app release. They
reach the box only through `install-kit.sh <sha>` run from root's own clone
(`sudo git -C /root/ggd2l-kit fetch origin`, check out `<sha>`, then
`sudo bash /root/ggd2l-kit/ops/selfhost/install-kit.sh <sha>`), as a separate,
recorded operation. Never run it from a tools clone: it refuses any clone, or
folder above it, that a user other than root could change. Before it changes
anything it checks both live `/etc/ggd2l/<lg>.env` files with the new kit's
env contract (names only) and stops on a problem, since every slot's
ExecStartPre would run that contract at its next start; fix the file, then run
it again. The first install after 2026-10-18 brings the production
`DOTA_LOBBY_BOT_URL` rule (unset, `http://127.0.0.1:8090`, or exactly
`https://ggd2l-dota-lobby-relay.ggd2l.workers.dev`): record that check's
output in the install's evidence.

## Rollback

- **App:** `ssh ggd2l-1 sudo -n ggd2l-agent rollback us`, then the same for
  `eu`, so both leagues stay on one commit. Rollback promotes the previous
  release with a clean restart. The old slot stays warm for at least 90 s
  after any promote, and `retire` refuses until then.
- **A bad migration:** follow "Fully rolled-back failed migration" in
  PRODUCTION-OPERATIONS; the restore point is the dump taken just before it
  (see Restore below).
- **Back to Vercel during the cutover** (up to the moment the site opens to
  everyone): promote the recorded base deployment and reset Neon's
  `default_transaction_read_only`. That works only because nothing has been
  written to the box yet and the base deployment still holds its own env
  snapshot (Vercel never applies env changes to an existing deployment). For
  the same reason the US Discord bot token is reset only after the site opens:
  a reset earlier would leave the promoted base with a dead token.
- **After the site has opened, there is no promote back to Vercel.** A promoted
  base deployment would serve the frozen, read-only Neon copy, and a fresh
  Vercel build fails the identity attestation against a database the box has
  marked for its new origin. If the box is unusable, follow "Rebuild from zero"
  below (about an hour, from the R2 dumps and the config archive). Returning to
  Vercel would instead mean: maintenance; dump the box; restore it into a new
  Neon branch as the owner and grant the runtime role; reset the identity
  markers for the Vercel origin (US: delete `deploymentRegion` and
  `deploymentOrigin`; Europe: set `deploymentOrigin` back to
  `https://ggd2l-europe.vercel.app`); re-add every production env var the
  post-cutover scrub removed, pointing at the new branch; run a NEW production
  build of the live SHA; promote it. The box dump already holds every write.
- **Never use "Instant Rollback" on a GGD2L Vercel project:** it would put the
  old app back in front of players.

## Backups

| Timer | Runs | Does |
|---|---|---|
| `ggd2l-backup@us`, `@eu` | hourly at :17 | `backup-league.sh <lg>` |
| `ggd2l-drill@us`, `@eu` | Sunday 10:30Z (us), 11:30Z (eu) | `drill-league.sh <lg>` |
| `ggd2l-heartbeat` | every 5 min | `heartbeat.sh` |
| `ggd2l-config-archive` | daily | `config-archive.sh` (as root) |

**Each hourly backup** (as `ggd2l-ops`, with only `/etc/ggd2l/backup-<lg>.env`:
the app role's `DIRECT_URL` and `BACKUP_DIR`):

1. `scripts/backup-db.mjs` from `tools/current` writes
   `local/backup-<stamp>-<pid>.sql` with its `.sha256` and `.metadata.json`.
2. `scripts/verify-backup.mjs` checks the checksum. No receipt secret is ever
   present, so no receipt reaches the journal; receipts for a season delete are
   minted by hand in a private terminal.
3. `gzip | age -R /etc/ggd2l/backup-recipients.txt` writes
   `offsite/<name>.gz.age`. The box holds only Tim's public key: it cannot read
   its own offsite copies.
4. Plaintext dumps are kept 48 h on the box (never the newest), encrypted
   copies 14 days once uploaded (never one still waiting).
5. rclone uploads to R2, with the `.age` file's checksum and the dump's own
   checksum beside it:
   - `ggd2l-backups/<lg>/hourly/<date>/` every hour;
   - `ggd2l-backups/<lg>/daily/<date>/` for the first success at or after
     03:00Z each day;
   - `ggd2l-backups/<lg>/monthly/<YYYY-MM>/` for the first daily of each month.
6. `state/last-backup.json` records the file, both sha256 values and the R2
   key, with a copy at `/var/backups/ggd2l/<lg>/last-backup.json`;
   `agent backup` and `agent status` report from it. healthchecks gets a ping,
   or `/fail` with the step that failed.

The units run sandboxed (`ProtectSystem=strict`), so the backup and the drill
write only inside their league folder, their locks included (the drills share
one lock, a read-only hold on `/var/backups/ggd2l`). After installing or
changing the kit, start each unit once and check it, so a sandbox gap shows up
now and not at the next hour:

```bash
sudo systemctl start ggd2l-backup@us    # first: the drill restores the newest dump
sudo systemctl start ggd2l-drill@us
systemctl show -p Result ggd2l-backup@us ggd2l-drill@us   # Result=success for both
```

**The daily config archive** (`config-archive.sh`, as root) streams
`/etc/ggd2l`, `/etc/cloudflared` and `/etc/caddy` through tar, gzip and
`age -R` into `/var/backups/ggd2l/config/`, so no plaintext touches disk, and
uploads it to `ggd2l-backups/config/<date>/` (or queues it under the same 48 h
`offsite-pending` rule). After changing anything in those folders, run it at
once rather than waiting for the timer:
`sudo systemctl start ggd2l-config-archive`.

R2 lifecycle rules (bucket `ggd2l-backups`): delete `us/hourly/` and
`eu/hourly/` after 7 days, `us/daily/` and `eu/daily/` after 35, `us/monthly/`
and `eu/monthly/` after 400, and `config/` after 35. DigitalOcean's weekly
droplet backups sit on top. The recovery point is one hour or better, plus a
fresh dump before every migration.

**Before R2 exists,** record when the deferral started, and remove the flag
once `rclone.conf` is in place:

```bash
date -u +%s | sudo tee /etc/ggd2l/offsite-pending > /dev/null
sudo chmod 0644 /etc/ggd2l/offsite-pending
```

For 48 h from that second, backups pass as `offsite-pending` and queue their
encrypted copies locally; after that they fail until R2 is configured. Once
`rclone.conf` exists the next run uploads the queue, oldest first.

`/etc/ggd2l/rclone.conf` (0600, owned by `ggd2l-ops`) is assembled file to file
from Tim's `~/ggd2l-secrets/r2-*` files, never pasted:

```ini
[r2]
type = s3
provider = Cloudflare
access_key_id = <from r2-access-key-id>
secret_access_key = <from r2-secret-access-key>
endpoint = <from r2-endpoint>
acl = private
no_check_bucket = true
```

The token is limited to Object Read & Write on the one bucket, so rclone must
not try to create it (`no_check_bucket`; the scripts also pass
`--s3-no-check-bucket`).

`/etc/ggd2l/healthchecks.env` (0600) holds one ping URL per check:
`HC_PING_BOX`, `HC_PING_AUTOMATION`, `HC_PING_BOT`, `HC_PING_BACKUP_US`,
`HC_PING_BACKUP_EU`, `HC_PING_DRILL` (both leagues' drills ping the one
`drill` check) and `HC_PING_CONFIG`, plus the optional
`GGD2L_HEARTBEAT_LEAGUES`. A check without a URL is simply not pinged. The units
load it with `EnvironmentFile=-`; the scripts also read it directly when they
can.

The scripts running as `ggd2l-ops` read `rclone.conf`, `backup-recipients.txt`
and `offsite-pending` from `$CREDENTIALS_DIRECTORY` when the unit passes them
with `LoadCredential=`, otherwise from `/etc/ggd2l/`, which must then let
`ggd2l-ops` reach those three files.

**On demand:** `sudo -n ggd2l-agent backup <lg>` (or
`sudo systemctl start ggd2l-backup@<lg>`), then read
`/var/backups/ggd2l/<lg>/state/last-backup.json`.

## Restore

**The weekly drill** (`drill-league.sh`, or `sudo -n ggd2l-agent drill <lg> [sha]`
before a migration) restores the newest local dump into the scratch database
`ld2l_restore_test` as `ggd2l_rehearsal` (URL in `/etc/ggd2l/drill.env`), using
`scripts/rehearse-backup-restore.mjs` from `tools/current`, or with a SHA from
`tools/<sha12>` (the agent passes the SHA as the second argument and the
same folder as `GGD2L_TOOLS_DIR`, which must agree; `tools/current` still
points at the live commit until `migrate` moves it).
That verifies the checksum, restores in one transaction, applies the commit's
migrations and attests the full schema. The scratch database is dropped
afterwards, pass or fail. The result is in `state/last-drill.json`.

**Tim's quarterly decrypt drill** (about 15 min, on the Mac): download one
`daily/` object with its two `.sha256` files into an empty folder, then:

```bash
umask 077
# A browser download is world-readable; the rehearsal refuses such a sidecar.
chmod 600 backup-<stamp>.sql.gz.age backup-<stamp>.sql.gz.age.sha256 backup-<stamp>.sql.sha256
shasum -a 256 -c backup-<stamp>.sql.gz.age.sha256
age -d -i <key file from the password manager> backup-<stamp>.sql.gz.age | gunzip > backup-<stamp>.sql
shasum -a 256 -c backup-<stamp>.sql.sha256
PG_RESTORE_TEST_URL="postgresql://${USER}@localhost:5432/ld2l_restore_test" \
  npm run db:backup:rehearse -- backup-<stamp>.sql
```

Then delete the plaintext dump and the key file.

**Restoring production on the box** (data loss or corruption; everything
written after the dump is lost, so say so in the incident record):

1. `sudo -n ggd2l-agent mode <lg> maintenance`.
2. Choose the dump and put it, with its `.sha256`, in
   `/var/backups/ggd2l/cutover/<lg>/` (root's folder; the files stay 0600):
   `agent import` reads only that folder. A local dump is copied there:
   `sudo cp -p /var/backups/ggd2l/<lg>/local/<name>.sql{,.sha256} /var/backups/ggd2l/cutover/<lg>/`.
   An offsite one is decrypted on the Mac as above and copied there.
3. `sudo -n ggd2l-agent import <lg> <name>.sql`: checks the sidecar, stops both
   slots, recreates the database, restores as the owner role, grants the app
   role and runs `ANALYZE`.
4. `sudo -n ggd2l-agent grants-check <lg>` (0 problems) and
   `sudo -n ggd2l-agent preflight <lg> <live sha>`.
5. Bring the live release back up (`start`, `check`, then
   `promote <lg> <live id> --mode allowlist`), check it yourself, then
   `mode <lg> proxy`.

## Rebuild from zero (about 1 hour)

1. New droplet: Ubuntu 24.04 x86_64, NYC3, 2 GB, the Mac's SSH key. Point the
   `ggd2l-1` alias (and its pinned host key) at it.
2. As root: `provision-base.sh`; check `ssh ggd2l@<ip> sudo true` from a second
   terminal, then `harden-ssh.sh`.
3. From root's own clone at the live SHA (`sudo git clone` into `/root/ggd2l-kit`):
   `sudo bash /root/ggd2l-kit/ops/selfhost/install-kit.sh <live sha>`.
4. Tim decrypts the newest `config/` archive on the Mac and streams it straight
   in, so no plaintext lands on either disk:
   `age -d -i <key file> config-<stamp>.tar.gz.age | ssh ggd2l-1 'sudo tar -C / -xzpf -'`.
   That restores `/etc/ggd2l` (env files, passwords, rclone and healthchecks
   settings), `/etc/cloudflared` (the tunnel's credentials) and `/etc/caddy`.
   Re-run `install-kit.sh` so modes and owners match the new users.
5. The restored Caddy mode files are the old box's (usually `proxy`), and
   `agent import` runs only in maintenance: first `agent mode <lg> maintenance`
   for each league. Tim decrypts the newest dump per league; copy each into
   `/var/backups/ggd2l/cutover/<lg>/` and run `agent import <lg> <file>`, then
   `grants-check` and `preflight`. Skip `identity`: a box dump already carries
   the markers.
6. `agent prepare <live sha>`, then per league `agent build`, `start`, `check`
   and `promote` at the live SHA.
7. `sudo systemctl enable --now cloudflared-ggd2l`. The tunnel id and DNS are
   unchanged, so traffic returns once it connects.
8. Enable the backup, drill, heartbeat and config-archive timers, start one
   backup and then one drill per league and check `Result=success` (see
   Backups), and watch healthchecks go green.

## Origin CA fallback (if the tunnel cannot be used)

The tunnel is the design (nothing listens publicly but SSH). If it must be
replaced, serve Cloudflare directly over HTTPS:

1. **Certificate** (Tim): Cloudflare → ggd2l.com → SSL/TLS → Origin Server →
   Create Certificate, for `ggd2l.com` and `*.ggd2l.com`. Save the certificate
   and key with `pbpaste` into two 0600 files in `~/ggd2l-secrets/`, then move
   them file to file to `/etc/caddy/ggd2l/origin.pem` and `origin.key` (0640,
   `root:caddy`).
2. **Only Cloudflare may connect:** turn on SSL/TLS → Origin Server →
   Authenticated Origin Pulls, save Cloudflare's origin-pull CA certificate as
   `/etc/caddy/ggd2l/origin-pull-ca.pem`, and open 443 in ufw only for the
   ranges at `https://www.cloudflare.com/ips-v4` and `/ips-v6`.
3. **Caddy:** each site listens on `https://<host>:443` instead of
   `http://<host>:8080`, with
   ```caddyfile
   tls /etc/caddy/ggd2l/origin.pem /etc/caddy/ggd2l/origin.key {
   	client_auth {
   		mode require_and_verify
   		trust_pool file /etc/caddy/ggd2l/origin-pull-ca.pem
   	}
   }
   ```
   and the global `trusted_proxies static <the same Cloudflare ranges>`, so
   `CF-Connecting-IP` is believed only from Cloudflare. The app keeps
   `CLIENT_IP_HEADER=cf-connecting-ip`.
4. **DNS** (with Tim's yes): replace the four tunnel CNAMEs with proxied A
   records to the droplet's IP. SSL/TLS mode stays Full (strict).
5. Stop and disable `cloudflared-ggd2l`.

What it costs: the Cloudflare range list can drift (re-check it in the monthly
hour), and the client-IP header is trustworthy only while ufw and Authenticated
Origin Pulls hold.

## Cutover helpers

**`cutover/neon-dump.mjs`** dumps a league's Neon database on the Mac (P5, W8,
E5). It needs `pg_dump` 18 in `/opt/homebrew/opt/postgresql@18/bin` (or
`--pg-bin <dir>`) and, for the US, a `neonctl` login (`npx neonctl@6.2.3 auth`):

```bash
node ops/selfhost/cutover/neon-dump.mjs us --dry-run   # login, URL shape, pg_dump; writes nothing
node ops/selfhost/cutover/neon-dump.mjs us             # dump + verify into ~/ggd2l-cutover/us/
node ops/selfhost/cutover/neon-dump.mjs eu             # URL read in-process from ~/.config/ggd2l-europe/europe-production.env
```

The connection string stays in memory and in `backup-db.mjs`'s environment;
output is JSON with only paths, sizes and sha256. `--source neonctl` skips
Europe's env file (use it if that URL is stale), and `--env-file <file>` reads a
fresh 0600 copy instead. Copy the dump and its sidecars with `scp -p` into a
0700 staging folder on the box, then into `/var/backups/ggd2l/cutover/<lg>/`
for `agent import`. After the import and parity check, encrypt the Mac's
plaintext copy to Tim's age key (`age -R <recipients file> -o <dump>.age <dump>`)
and delete the plaintext.

**`cutover/env-partial.mjs` and `cutover/compose-env.sh`** build a league's
`/etc/ggd2l/<lg>.env` file to file. On the Mac,
`GGD2L_REPO=<main checkout> node ops/selfhost/cutover/env-partial.mjs <lg> staging|production [--without-bot] [--webhooks] [--bot-via-relay]`
reads the local secret files and installs the partial on the box through ssh's
stdin (it prints only key names). A production partial points the site at the
lobby bot on the box (`DOTA_LOBBY_BOT_URL=http://127.0.0.1:8090`);
`--bot-via-relay` keeps the relay's URL while the bot still runs on the Mac.
The env contract accepts only those two in production. Then on the box,
`sudo bash /root/ggd2l-kit/ops/selfhost/cutover/compose-env.sh <lg> [--keep-secrets]`
adds the app-role database URL and fresh AUTH, CRON and BACKUP_RECEIPT secrets
(or, with `--keep-secrets`, the current ones), keeps the server-action key, and
replaces the file only if the env contract passes. Staging carries no Discord
credential, webhook or lobby bot. The US production env is built twice: first
`--without-bot` (W9), then, after the site opens and Tim resets the bot token
into `~/ggd2l-secrets/us-discord-bot-token`, again with the token and
`--keep-secrets`, followed by `start` and `promote` of the same release on the
idle slot (the live slot is never restarted in place). Europe's production env
needs `--webhooks`: its webhook URLs live in its env, not in its database.

**`cutover/neon-parity.mjs <lg>`** runs `sql/db-parity.sql` on Neon from the
Mac (owner URL in memory, libpq fields only) and `agent parity <lg>` on the box,
and prints which tables differ. Exit 0 only when identical. During a rehearsal
Neon is live, so busy tables (the inhouse queue, `Setting`) differ; after the
freeze any difference stops the cutover.

**First opening on a fresh box:** `agent mode <lg> allowlist` needs a live
release, so the first opening is `agent promote <lg> <id> --mode allowlist`.

**`ops/vercel-redirect/{us,eu}`** are the old origins' replacement: no functions,
no build, one 307 redirect from every path to `https://<lg>.ggd2l.com`, keeping
the path. Vercel passes the query string through to the destination unless the
destination sets one, and normalizes `//` with its own 308 first. Each step
needs Tim's yes:

- **Stage (P8),** from the folder, with the project ids from
  `scripts/league-targets.mjs` in the environment so the CLI never links or
  creates a project:
  `VERCEL_ORG_ID=<team id> VERCEL_PROJECT_ID=<project id> npx --yes vercel@59.11.7 deploy --prod --skip-domain`.
  Record each project's current production deployment as the base. Check the
  staged URL with `vercel curl -I '/inhouse?imin=1' --deployment <url>` (and
  `/overlay/x`, `/api/calendar?team=y`, `/api/cron/automation`): 307 with
  exactly `https://<lg>.ggd2l.com/<path>?<query>`. `vercel inspect <url>` must
  show no functions.
- **Freeze (W4, E2):** `vercel promote <redirect deployment>`; to undo,
  `vercel promote <base>`.
- **After 14 days:** set `"permanent": true` (308), stage, check and promote the
  same way.

## Tim's monthly hour

- Read the healthchecks dashboard; every check green, no silent one.
- `ssh ggd2l-1 sudo -n ggd2l-agent status`: live SHAs match
  `https://{us,eu}.ggd2l.com/api/health/release`, no failed unit, no pending
  reboot stuck for days.
- `ssh ggd2l-1 df -h /`: comfortably under the 85% alert line. A release takes
  about 1.2 GB and two days of dumps sit beside it.
- OpenDota rate limits: both leagues now share one IP. The app treats a 429 as
  "unreachable" and does not log it, so look for result imports that lag rather
  than for journal lines.
- `ssh ggd2l-1 cat .ssh/authorized_keys`: only keys you recognize. `last -n 20`
  for logins.
- Spot-check R2: the newest `daily/` object for each league is from today.
- Quarterly: the decrypt drill above.
