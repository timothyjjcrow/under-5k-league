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
passwords go on stdin; healthchecks ping URLs go to curl on stdin; the Discord
alert webhook reaches only units' environments (`EnvironmentFile=`) and
Wrangler's stdin.

## Layout

```
Browser ─> Cloudflare edge ─> tunnel (outbound from the box) ─> cloudflared
  ─> Caddy 127.0.0.1:8080 ─┬─ us.ggd2l.com      ─> 3001 (us@a) | 3002 (us@b)
                           ├─ eu.ggd2l.com      ─> 3011 (eu@a) | 3012 (eu@b)
                           └─ ggd2l.com, www    ─> 302 https://us.ggd2l.com{uri}
PostgreSQL 18 127.0.0.1:5432: ggd2l_us, ggd2l_eu (ld2l_restore_test only during drills)
Lobby bot 127.0.0.1:8090 <─ the sites over loopback (since 2026-10-18; the relay Worker is the rollback)
Cloudflare Workers: the minute scheduler ─> https://{us,eu}.ggd2l.com/api/cron/automation
R2 bucket ggd2l-backups: age-encrypted dumps and config archives
```

Ubuntu 24.04, 1 vCPU, 2 GB RAM plus 4 GB swap, ufw open for SSH only, unattended
upgrades at 08:00 UTC with a reboot window at 09:00 UTC, journald capped at 500 MB.

| What | Where |
|---|---|
| Release agent | `/usr/local/sbin/ggd2l-agent` (runs `/usr/local/lib/ggd2l/ggd2l-agent.mjs`) |
| Agent modules, env contract, renderers | `/usr/local/lib/ggd2l/` |
| The hourly backup's repo scripts (kit copies) | `/usr/local/lib/ggd2l/app/{scripts,src/lib}/` |
| SQL (parity, grants, scrub, identity) | `/usr/local/lib/ggd2l/sql/<name>.sql` |
| Shell helpers | `/usr/local/lib/ggd2l/{provision-league-db,backup-league,drill-league,heartbeat,config-archive}.sh`, `discord-alert.mjs` |
| Alert state (Discord) | `/var/lib/ggd2l-alerts/` (one JSON file per alert, `ggd2l-ops`) |
| Releases, slots, live pointer | `/srv/ggd2l/<lg>/releases/<id>/`, `/srv/ggd2l/<lg>/slots/{a,b}`, `/var/lib/ggd2l/<lg>/live.json` |
| Union static files (14-day prune) | `/srv/ggd2l/<lg>/static/_next/static/` |
| Tools clones (migrate, attest, drill) | `/srv/ggd2l/tools/<sha12>/`, `/srv/ggd2l/tools/current` |
| Settings and secrets (root) | `/etc/ggd2l/` |
| Caddy mode files | `/etc/caddy/ggd2l/{us,eu}-mode.caddy`, `/etc/caddy/ggd2l/allow.caddy` |
| Tunnel | `/etc/cloudflared/config.yml`, `/etc/cloudflared/<uuid>.json` |
| Caddy's admin API | the socket `/run/caddy/admin.sock` (0600 in a 0700 folder, both `caddy`'s): only caddy and root can open it |
| Lobby bot | code `/srv/ggd2l/bot/current` (`agent bot-deploy <sha>`), settings `/etc/ggd2l/bot.env`, state `/var/lib/ggd2l-bot` (0700 `ggd2l-bot`, in the daily config archive) |
| Backups | `/var/backups/ggd2l/<lg>/{local,offsite,state}/`, `/var/backups/ggd2l/config/` |
| The drill's dump (handed over by the backup) and its own folder | `/var/backups/ggd2l/<lg>/drill/` (group `ggd2l-drill`), `/var/lib/ggd2l-drill/<lg>/` (`last-drill.json`) |
| Cutover dumps | `/var/backups/ggd2l/cutover/<lg>/` (root, 0700) |
| Logs | journald; Caddy JSON access logs in `/var/log/caddy/{us,eu,apex}.access.json` |

Units: `ggd2l-us@{a,b}.service`, `ggd2l-eu@{a,b}.service` (only the live slot is
enabled), `cloudflared-ggd2l.service`, `ggd2l-backup@<lg>.timer`,
`ggd2l-drill@<lg>.timer`, `ggd2l-heartbeat.timer`, `ggd2l-config-archive.timer`,
`ggd2l-bot.service`, `ggd2l-alert@<key>.service` (started by the backup,
drill and config-archive units, never enabled), and the caddy package's
`caddy.service` with the kit's
drop-in `caddy.service.d/10-ggd2l.conf`: the packaged unit never restarts, so
the drop-in adds `Restart=on-failure` (every 2 s, never giving up),
`OOMScoreAdjust=-500` (the kernel kills a build or a slot before Caddy;
PostgreSQL stays at -900) and `RuntimeDirectory=caddy` (0700), the folder of
Caddy's admin API socket. `install-kit.sh` installs it; `Restart=` applies at
once, the rest from Caddy's next start (the next reboot, or
`sudo systemctl restart caddy` in a quiet minute: both sites blink for a
second or a few; `sudo choom -p <pid> -n -500` sets the OOM score on the
running process with no blink). `systemctl show` reports the unit's value at
once, so check the live process:
`cat /proc/$(systemctl show -p MainPID --value caddy)/oom_score_adj`.

**Caddy's admin API** can replace the whole live configuration, so it is the
socket `/run/caddy/admin.sock` (0600) in that 0700 folder, which only caddy
and root can open. Until 2026-10-19 it listened on `localhost:2019` with no
authentication, where any local user (either league's slot, the bot, a build)
could reroute both leagues. Nothing calls it but `caddy reload`, the unit's
`ExecReload`, which reads the socket from the Caddyfile: the agent and
`install-kit.sh` reload through `systemctl`. Read the live configuration as
root with `sudo curl -sS --unix-socket /run/caddy/admin.sock http://localhost/config/`.

Linux users: `ggd2l` (admin, sudo), `ggd2l-build` (builds; holds no secret),
`ggd2l-us` and `ggd2l-eu` (the web slots), `ggd2l-ops` (backups, heartbeat,
alerts; holds the R2 key), `ggd2l-drill` (restore drills; reads only the dump
the backup hands it), `ggd2l-bot`.

## Rules that are different on the box

- The box's Postgres **is production**. Never run `test:pg`, `pg:up`, the test
  suites or `db:push` there; production database names are never test names.
- **Exactly one clock** runs scheduled work: the Cloudflare Worker. No systemd
  timer or in-process cron may call `/api/cron/automation`.
- Never probe `/api/sync` or `/api/health/automation` on a candidate slot.
- Every unit refuses to start without a valid `LEAGUE_DEPLOY_ENV`; only
  `production` lets the site write to Discord.
- **An edit of `/etc/ggd2l/<lg>.env` takes effect at the next start of a
  slot, with no build:** a restart, the 09:00 UTC reboot, a rollback. A
  slot's start checks only the env contract, so after every edit, before any
  restart, run `sudo -n ggd2l-agent envcheck <lg>` and stop on anything but
  `{"ok":true,...}`. It runs the contract, then the live release's own
  `scripts/validate-prod-env.mjs` (the gate every build runs: the secrets,
  `ADMIN_STEAM_IDS`, `STEAM_API_KEY`, the Discord pairs), as the league user,
  and names keys only; the rule each broke is in
  `/var/log/ggd2l/tools/envcheck-<lg>-<stamp>-<sha12>.log`.
- `ggd2l-bot.service` refuses to start on an env that breaks the bot's
  contract (`env-contract.mjs --bot`, names only): `DOTA_BOT_STATE_DIR`
  exactly `/var/lib/ggd2l-bot`, a 32+ character `DOTA_LOBBY_BOT_SECRET`, no
  `STEAM_BOT_PASSWORD`, and `NODE_ENV`, `HOST` and `PORT` in `bot.env` only
  as the unit's own `production`, `127.0.0.1` and `8090` (any other value
  would override the unit's). Check a file before installing it with
  `node /usr/local/lib/ggd2l/env-contract.mjs --bot --file <path>`. Five
  failed starts in ten minutes leave the unit failed instead of restarting
  forever.
- A slot can write only the release folders `next start` writes at runtime,
  `RELEASE_WRITABLE_DIRS` in `agent/layout.mjs` (`.next/cache`, and
  `.next/server/route-cache` for Next's response cache). The build creates
  them for the league user and the unit's `ReadWritePaths=` names them; the
  rest of the release is read-only. CI's boot step fails a build that writes
  anywhere else.
- **Root never works through a link a service user could have left.** GNU
  `install -d`, `chown` and `chmod`, given a link, change its target. The
  build user runs third-party install scripts, so it can leave a link
  anywhere it can write, and so can any user that runs code it wrote. So
  the agent and `install-kit.sh` change, as root, only
  folders in a parent no service user can write. The agent makes each
  folder the build user clones or unpacks into itself, with a plain `mkdir`
  in a root-only parent (`tools/`, `bot/releases/`, `<lg>/releases/`), and
  hands it over with `chown -h`. It takes a tree back
  (`chown -R -P -h`, then requires a real, root-owned folder) before it
  reads, chmods or writes through it. It deletes such trees with GNU `rm`,
  never Node's `rmSync`. A folder inside a service user's own folder (the
  npm cache, the backups' `local/` and `offsite/`) is made by that user. A
  link or file where one of these folders goes stops the agent
  (`unsafe_path`) or the install: treat that as an incident (see Kit
  changes).
- **`ggd2l-ops` runs only the kit's own code.** It holds the R2 key and the
  backups, while the tools clone is whatever the build user's `npm ci`
  wrote. So the hourly backup runs the kit's copies of `scripts/backup-db.mjs`,
  `scripts/verify-backup.mjs` and what they import
  (`/usr/local/lib/ggd2l/app/`, from root's clone): a change to those files
  reaches the box with `install-kit.sh`, not with an app release
  (`install-kit.test.mjs` keeps the list equal to their imports). The
  restore drill needs the tools clone (Prisma, the commit's migrations), so
  it runs as `ggd2l-drill`, which cannot read `rclone.conf` or write the
  backups, from a private copy of the one dump each backup hands it in
  `drill/`.
- Each slot process holds one Prisma pool of `connection_limit=8`
  (`provision-league-db.sh`), so four processes in a release overlap use 32 of
  PostgreSQL's 47 usable connections. A release built before 2026-10-17's fix
  holds two pools per process.

## Daily operations

- **Status:** `ssh ggd2l-1 sudo -n ggd2l-agent status` shows units (the config
  archive's included), live SHAs and slots, disk, memory, swap, the last backup,
  the last drill, a pending reboot and two counts for the last 24 h:
  `serverErrors24h`, the real 5xx, and `maintenance503s24h`, the maintenance
  page's own 503s (a league held in maintenance answers everything with one).
  `lastDrill` is the later of the drill unit's last run (the weekly timer,
  failures included) and `/var/lib/ggd2l-drill/<lg>/last-drill.json`, which
  every passing drill writes (before 2026-10-19, `state/last-drill.json` in
  the backups, still read), so a `drill <lg> <sha>` before a migration
  counts too.
- **Logs:** `ssh ggd2l-1 sudo journalctl -u ggd2l-us@<slot> -f` for the live
  slot (`status` names it under `leagues.<lg>.live.slot`; a release flips it).
  `sudo -n ggd2l-agent logs us <sinceMs>` is the release gate's evidence, not a
  log reader: one JSON row per scheduler request (`/api/cron/automation`) and
  per 5xx in Caddy's log, plus a bare `warn` row for each slot journal line
  that looks like a Next error, with no message text. Read the text itself in
  the journal.
- **Alerts** post to Discord, into the admin channel through one webhook, and
  ping nobody unless `ALERT_PING_USER_ID` is set. Each problem posts once, a
  reminder each day it lasts, and once more when it clears (🔴, then 🟢):

  | Posted by | When | First look |
  |---|---|---|
  | Each league's scheduler Worker, from Cloudflare | 3 scheduled passes in a row failed (10 between 09:00 and 09:15 UTC, the reboot window): the box, the tunnel, Caddy, the slot or the database is down, or the pass itself fails. Clears after 2 passes in a row. The message names the kind of failure (`HTTP 530: the tunnel to the box is down`). | `ggd2l-agent status`; the live slot's journal; the Worker's logs in Cloudflare |
  | `ggd2l-alert@backup-<lg>` | A backup run failed, with the step (`at step upload (exit 1)`) or how it was killed. Clears at the next good run. | `journalctl -u ggd2l-backup@<lg>` |
  | `ggd2l-alert@drill-<lg>` | A weekly restore drill failed, with the step | `journalctl -u ggd2l-drill@<lg>` |
  | `ggd2l-alert@config-archive` | The daily config archive failed, with the step | `journalctl -u ggd2l-config-archive` |
  | The heartbeat | `/` is 85% full (at once); MemAvailable under 150 MB or swap use over 1.5 GB for three beats; a unit failed for two beats (a backup, drill or config archive only when its own alert didn't get out); a league's site answers but `/api/health/automation` has said stale for three beats (the Worker isn't firing); an enabled `ggd2l-bot` inactive for four beats. One beat's posts share a message. | `ggd2l-agent status`; `systemctl --failed` |

  A league the box can't reach through Cloudflare is the Worker's to report,
  so one outage posts once. A failed unit stays failed until it runs again or
  you clear it: after fixing the cause, `sudo systemctl reset-failed <unit>`.
  Each Worker and the box post a 👋 hello the first time they see a webhook;
  `sudo systemctl start ggd2l-alert@test` posts a test alert and its recovery
  through the box's path. Settings: [Discord alerts](#discord-alerts) below.

  healthchecks.io pings still go out where `healthchecks.env` names a check
  (below), as they always did: `box`, `automation`, `backup-us`, `backup-eu`,
  `drill`, `bot` and `config`.
- **Package updates** install at 08:00-08:10 UTC, from `provision-base.sh`'s
  drop-in for `apt-daily-upgrade.timer` (stock Ubuntu runs them at
  06:00-07:00 UTC, late evening in the US league's zone). A PostgreSQL update
  restarts the cluster as it installs, and needrestart may restart a live slot,
  the bot or the tunnel whose Node or libraries changed, so a pass or two can
  fail then; an alert needs 3. `systemctl list-timers apt-daily-upgrade.timer`
  shows the next run.
- **The 09:00 UTC reboot** (when an update needs one) brings back exactly the
  enabled (live) slots. The Workers' reboot window (10 failed passes before an
  alert until 09:15 UTC) covers it. Keep releases clear of 08:00-08:15 UTC and
  of a pending reboot.
- **Maintenance page:** `sudo -n ggd2l-agent mode <lg> maintenance`, and
  `mode <lg> proxy` to reopen. The page answers the scheduler with a 503, so
  a maintenance window with the scheduler running posts that league as
  failing after 3 minutes and back after the reopening; pause the scheduler
  first when that isn't wanted (a migration does anyway).
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
output in the install's evidence. It rewrites files
under `/etc/caddy`, `/etc/cloudflared` and `/etc/ggd2l`, so finish with one
config archive (`sudo systemctl start ggd2l-config-archive`, see Backups).

<a id="kit-2026-10-19"></a>**The first install after 2026-10-19, once:** the install itself (step 2)
closes a root escalation from the build user and takes the build user's code
away from `ggd2l-ops`; step 1 checks that nothing was exploited before it and
steps 4-5 check the result. The rest moves Caddy's admin API to its socket
(step 3), moves the package window to 08:00 (step 7) and adds the bot's
state to the config archive (step 8). Its agent also runs the production validation in `envcheck` (step
6) and refuses a second `rollback` (Rollback below). Do it all in one
sitting between 07:20 and 08:10 UTC, with no release, match night, inhouse
night or draft on. Each bound has a reason: step 3 restarts Caddy (both
sites blink), which belongs inside the release window and straight after
step 2; step 5's drills must not overlap an hourly backup at :17, whose
handoff replaces the dump in `drill/` and deletes the old one, failing a
drill still copying it (`no-dump`), so start after the 07:17 backups and
keep step 5 clear of 08:17; and step 7 must run between 07:10 and 08:30. As
the admin user on the box:

1. **Check that nothing was handed over, before installing.** Until now the
   agent ran `install -d -o ggd2l-build` as root on the npm cache inside the
   build user's own home, and on clone folders in parents the build user
   could write; `install-kit.sh` did the same on the backups' `local/` and
   `offsite/` inside `ggd2l-ops`'s folder. A link left there would have
   handed its target (the agent's own code, say) to that user. `-xdev` stays
   on `/`, the box's only filesystem:

   ```bash
   sudo find / -xdev \( -user ggd2l-build -o -user ggd2l-ops \) ! -path '/srv/ggd2l/*' \
     ! -path '/var/cache/ggd2l-build' ! -path '/var/cache/ggd2l-build/*' ! -path '/var/backups/ggd2l/*' \
     ! -path '/var/lib/ggd2l-ops' ! -path '/var/lib/ggd2l-ops/*' ! -path '/var/lib/ggd2l-alerts' \
     ! -path '/var/lib/ggd2l-alerts/*' ! -path '/etc/ggd2l/rclone.conf' ! -path '/tmp/*' ! -path '/var/tmp/*' -print
   sudo stat -c '%F %U:%G %a %n' /var/cache/ggd2l-build/npm /var/backups/ggd2l/{us,eu}/{local,offsite}
   sudo find /srv/ggd2l -maxdepth 3 -type l -printf '%p -> %l\n'
   sudo find /srv/ggd2l/{us,eu}/releases -mindepth 1 -maxdepth 1 ! -user root -print
   ```

   The first `find` prints nothing, and `stat` says `directory`, owned by
   `ggd2l-build` or `ggd2l-ops`, for all five. The folders under `/srv/ggd2l`
   were the build user's to write until now, so a link planted there could
   also have re-owned a release: the link `find` lists only
   `/srv/ggd2l/{us,eu}/slots/{a,b}`, `/srv/ggd2l/tools/current` and
   `/srv/ggd2l/bot/current`, each pointing at a release, a tools clone or a
   bot release under `/srv/ggd2l`, and the last `find` lists nothing, or only
   releases whose build failed (the build log under `/var/log/ggd2l/builds`
   says so); a live or warm release listed there is the incident below. Anything else (a symbolic link
   there, or something of root's, such as `/usr/local/lib/ggd2l`, now owned
   by one of those users) means root may already have run that user's code:
   stop, install nothing, leave the box as it is, and handle it as an
   incident (PRODUCTION-OPERATIONS). Record both outputs in the install's
   evidence.
2. **Install** as above. An install that stops at "is a link or not a
   folder" is the same incident as step 1's `find` printing something. Among
   its notes it prints `NEEDS A RESTART` for Caddy (step 3).
3. **Restart Caddy, straight after the install.** `install-kit.sh` installs
   the new agent, Caddyfile and drop-in together, then finds the running
   Caddy still on `localhost:2019`: it skips the reload (`caddy reload`
   would dial the socket the new Caddyfile names, which nothing listens on
   yet) and prints `NEEDS A RESTART`. Until Caddy restarts, every reload
   fails, the agent's mode switches and so every release included (each
   puts its file back and reports `caddy_reload_failed`), so restart it
   before any `agent mode` or release, and never before the install (the old
   Caddyfile has no socket):

   ```bash
   sudo systemctl restart caddy   # both sites answer 502 for a few seconds; at most one scheduler pass fails
   sudo stat -c '%A %U:%G %n' /run/caddy /run/caddy/admin.sock   # drwx------ caddy:caddy, srw------- caddy:caddy
   curl -sS -m 3 http://localhost:2019/config/   # refused
   sudo systemctl reload caddy && sudo -n ggd2l-agent status   # the reload path works; units and live slots as before
   ```

   The restart also gives Caddy its `OOMScoreAdjust=-500`.
4. **Check the new modes:**
   `stat -c '%a %U:%G %n' /srv/ggd2l/tools /srv/ggd2l/bot/releases /srv/ggd2l/{us,eu}/releases`
   prints `755`, `755`, `751` and `751`, each `root:root`. The next
   release's `agent build` is the first run of the new folder handling; an
   `unsafe_path` refusal from the agent, then or at any later verb, is step
   1's incident too.
5. **One backup, then one drill, per league.** The install added the
   `ggd2l-drill` user and put `ggd2l-ops` in its group, installed the hourly
   backup's scripts under `/usr/local/lib/ggd2l/app/`, and moved the drill
   onto `ggd2l-drill`. First `systemctl is-active ggd2l-backup@us ggd2l-backup@eu`
   must show neither `activating` (wait for the 07:17 runs to end). Then, in
   this order, since each drill restores the dump its league's backup has
   just handed over:

   ```bash
   sudo systemctl start ggd2l-backup@us
   sudo systemctl start ggd2l-drill@us
   sudo systemctl start ggd2l-backup@eu
   sudo systemctl start ggd2l-drill@eu
   systemctl show -p Result ggd2l-backup@us ggd2l-drill@us ggd2l-backup@eu ggd2l-drill@eu   # Result=success four times
   sudo ls -l /var/backups/ggd2l/{us,eu}/drill/
   ```

   Each `drill/` holds one dump with its `.sha256` and `.metadata.json`,
   `-rw-r----- ggd2l-ops ggd2l-drill`. A backup uploads to R2 before it hands
   the drill its copy, so even a backup that fails `at step drill-handoff`
   has its offsite copy.
6. **envcheck both leagues:** `sudo -n ggd2l-agent envcheck us` and
   `envcheck eu` each answer `{"ok":true,"problems":[]}`. If one names a
   key, the live file already fails the production validation: fix it
   before anything restarts that league (Rules above), and don't wait for
   the reboot. This comes before step 7, whose package run can restart a
   live slot (needrestart). If the fix runs past 08:30, leave step 7 for
   another day's 07:10-08:30 window: the stock 06:00 timer stays until then.
7. **Move the package window** on the box that predates `provision-base.sh`'s
   drop-in. Do it between 07:10 and 08:30 UTC. systemd counts the next run
   from the last one (today's stock run, 06:00-07:00): before 08:00 the first
   new run is today's 08:00, and after it the reload starts one within 10
   minutes, still inside the window. At any other hour the reload would start
   a run at once, a PostgreSQL restart included.

   ```bash
   sudo install -d -m 0755 /etc/systemd/system/apt-daily-upgrade.timer.d
   sudo tee /etc/systemd/system/apt-daily-upgrade.timer.d/90-ggd2l.conf > /dev/null <<'EOF'
   # GGD2L (ops/selfhost/provision-base.sh): unattended upgrades install at
   # 08:00-08:10 UTC, so their restarts land before the 09:00 UTC reboot.
   [Timer]
   OnCalendar=
   OnCalendar=*-*-* 08:00 UTC
   RandomizedDelaySec=10m
   EOF
   sudo systemctl daemon-reload
   systemctl list-timers apt-daily-upgrade.timer   # NEXT: 08:00-08:10 UTC
   ```

   If `NEXT` still shows a 06:xx time, `sudo systemctl restart apt-daily-upgrade.timer`
   in the same window.
8. **One config archive**, as after every install; this one also adds the
   bot's state. Run it
   (`sudo systemctl start ggd2l-config-archive`, `Result=success` in
   `systemctl show -p Result ggd2l-config-archive`): from then on a rebuild
   gets the bot's Steam session back. Only Tim's key reads it; on the Mac,
   `age -d -i <key file> config-<stamp>.tar.gz.age | tar -tzf - | grep ggd2l-bot`
   lists `steam-auth.json`, `lobbies.json` and `steam/`, and no lock or log.

If a check in step 5 fails, installing the previous kit SHA the same way
puts the backup and the drill back as they were. That kit's Caddyfile puts
the admin API back on `localhost:2019`, which the Caddy step 3 restarted (on
the socket) can't reload into, so that install stops at its Caddy reload:
`sudo systemctl restart caddy`, then run it again.

## Rollback

- **App:** `ssh ggd2l-1 sudo -n ggd2l-agent rollback us`, then the same for
  `eu`, so both leagues stay on one commit. Rollback promotes the previous
  release with a clean restart. The old slot stays warm for at least 90 s
  after any promote, and `retire` refuses until then. Run each rollback once:
  it can sit silent for two minutes, and if its answer is lost or says it
  failed, read `ggd2l-agent live us` first. While live came from a rollback
  (`live.json`'s and `status`'s `rolledBackFrom`), a second one refuses with
  `rolled_back` instead of putting back the release it left; going back on
  purpose is `ggd2l-agent promote us <rolledBackFrom>`.
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

1. `scripts/backup-db.mjs` (the kit's copy in `/usr/local/lib/ggd2l/app`)
   writes `local/backup-<stamp>-<pid>.sql` with its `.sha256` and
   `.metadata.json`, all private to `ggd2l-ops`.
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
6. The dump and both sidecars are copied to `drill/` (0640, group
   `ggd2l-drill`), replacing the last copy: all the drill can read. A failed
   copy fails the run (`at step drill-handoff`) after the upload, so the
   offsite copy is never lost to it, but no record is written.
7. `state/last-backup.json` records the file, both sha256 values and the R2
   key, with a copy at `/var/backups/ggd2l/<lg>/last-backup.json`;
   `agent backup` and `agent status` report from it. healthchecks gets a ping,
   or `/fail` with the step that failed.

The units run sandboxed (`ProtectSystem=strict`), so the backup writes only
inside its league folder and the drill only inside
`/var/lib/ggd2l-drill/<lg>`, their locks included (the drills share one lock,
a read-only hold on `/var/lib/ggd2l-drill`). After installing or
changing the kit, start each unit once and check it, so a sandbox gap shows up
now and not at the next hour:

```bash
sudo systemctl start ggd2l-backup@us    # first: it hands the drill the dump it restores
sudo systemctl start ggd2l-drill@us
systemctl show -p Result ggd2l-backup@us ggd2l-drill@us   # Result=success for both
```

**The daily config archive** (`config-archive.sh`, as root) streams
`/etc/ggd2l`, `/etc/cloudflared`, `/etc/caddy` and the lobby bot's state in
`/var/lib/ggd2l-bot` through tar, gzip and `age -R` into
`/var/backups/ggd2l/config/`, so no plaintext touches disk, and uploads it to
`ggd2l-backups/config/<date>/` (or queues it under the same 48 h
`offsite-pending` rule). Of the bot's state it keeps what
[DOTA-LOBBY-BOT](../../docs/DOTA-LOBBY-BOT.md#on-the-box) says to retain
(`steam-auth.json`, `steam/`, `lobbies.json`) and leaves out its locks
(`worker.lock`, `worker.os-lock`), its logs, a sign-in's `steam-login.png` and
`*.tmp` files. The bot writes while the archive runs; when tar says a file
changed as it read it, the archive is made again (three tries). After
changing anything in those folders, run it at once rather than waiting for
the timer: `sudo systemctl start ggd2l-config-archive`. Never extract an
archive over a running bot: stop it first, or leave its state out
(`tar --exclude=var/lib/ggd2l-bot`).

R2 lifecycle rules (bucket `ggd2l-backups`): delete `us/hourly/` and
`eu/hourly/` after 7 days, `us/daily/` and `eu/daily/` after 35, `us/monthly/`
and `eu/monthly/` after 400, and `config/` after 35. DigitalOcean's weekly
droplet backups sit on top. The recovery point is one hour or better, plus a
fresh dump before every migration.

**Who can delete the offsite history.** The R2 token in `rclone.conf` is
Object Read & Write, and on R2 that includes delete: whatever runs as
`ggd2l-ops` with that file could wipe every offsite copy along with the local
dumps it owns. The box keeps code it did not install away from it:
`ggd2l-ops` runs only the kit's own code (Rules above: the hourly backup runs
the kit's copies of `backup-db.mjs`, `verify-backup.mjs` and the `src/lib`
files they import, with no packages), and the drill, which runs Prisma's CLI
from a tools clone the build user's `npm ci` wrote, runs as `ggd2l-drill`,
which cannot read `rclone.conf` (0600 `ggd2l-ops`). That still leaves the
offsite history to anything that runs as `ggd2l-ops` or root, a kit bug or a
stolen admin login among them. **The remaining protection is Tim's to set in
the Cloudflare dashboard (not done yet):** an R2 bucket lock on `ggd2l-backups`
(the bucket's settings, bucket lock rules; or `wrangler r2 bucket lock add`
from the Mac with Tim's own login), one rule per prefix,
retaining objects as long as its lifecycle rule keeps them or less
(`us/hourly/` and `eu/hourly/` 7 days, `us/daily/` and `eu/daily/` 35,
`us/monthly/` and `eu/monthly/` 400, `config/` 35), so no credential on the
box can delete or overwrite an object before then; the box's token can't
change bucket settings. The scripts only ever upload new keys
(`rclone copyto`), so a lock breaks nothing they do.

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

The scripts also pass `--s3-no-head`. Until they did, every upload logged
`Failed to copy: NotImplemented: Not Implemented` and `Attempt 1/3 failed`,
then passed on rclone's retry. The box's rclone is Ubuntu's 1.60.1, which
HEADs every object it has just uploaded with the `versionId` the PUT returned
(rclone 1.61 stopped: "Ignore versionIDs from uploads"), and R2 has no object
versions. That HEAD is the only request after a PUT that landed (the retry
found the object already there and skipped it), and a bare 501 with no error
text is what a HEAD gets back. Without the HEAD, rclone still checks a
single-part upload end to end: it sends the file's MD5 as `Content-MD5`, which
R2 verifies, and compares the ETag R2 returns with it. After installing the
kit, the next hourly backup's journal
(`journalctl -u ggd2l-backup@us --since "1 hour ago"`) should show no
`Attempt 1/3 failed`. If it still does, find the refused request with one
upload by hand, with the scripts' own flags (`--dump headers` leaves out the
Authorization header; keep the output on the box, it names the account's
endpoint):

```bash
sudo -u ggd2l-ops sh -c 'f=$(mktemp) && echo diag > "$f" && rclone --config /etc/ggd2l/rclone.conf --s3-no-check-bucket --s3-no-head --retries 1 -vv --dump headers copyto "$f" "r2:ggd2l-backups/us/hourly/$(date -u +%F)/diag-$(date -u +%s).txt"; rm -f "$f"'
```

(`us/hourly/` expires after 7 days, so the test object needs no cleanup.)

<a id="discord-alerts"></a>**Discord alerts.** `/etc/ggd2l/alerts.env` (root, 0600; the units read it
through `EnvironmentFile=-`, so no script needs to open it) holds:

```ini
ALERT_DEPLOY_ENV=production
ALERT_DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/<id>/<token>
# optional: the one Discord user a failure pings
ALERT_PING_USER_ID=<user id>
```

Anything but exactly `production` posts nothing, so a copy of the box
restored for testing must say `staging` or lose the file. Install it file to
file, never pasted: `ssh ggd2l-1 'sudo install -m 0600 -o root -g root
/dev/stdin /etc/ggd2l/alerts.env' < <0600 file>`, then run the config archive.
The same webhook is each scheduler Worker's `ALERT_DISCORD_WEBHOOK_URL`
secret (and `ALERT_PING_USER_ID`, if set), put through stdin
([PRODUCTION-OPERATIONS](../../docs/PRODUCTION-OPERATIONS.md#discord-alerts-from-the-workers)).
`discord-alert.mjs` keeps its state in `/var/lib/ggd2l-alerts` (the units'
`StateDirectory=`); deleting a file there forgets that alert, and deleting
`hello.json` makes the next heartbeat say hello again.

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
before a migration) runs as `ggd2l-drill`. It copies the dump the newest
backup handed it (`/var/backups/ggd2l/<lg>/drill/`) into its own folder, as
`verify-backup.mjs` accepts only private files, and restores that copy into
the scratch database `ld2l_restore_test` as `ggd2l_rehearsal` (URL in
`/etc/ggd2l/drill.env`), using
`scripts/rehearse-backup-restore.mjs` from `tools/current`, or with a SHA from
`tools/<sha12>` (the agent passes the SHA as the second argument and the
same folder as `GGD2L_TOOLS_DIR`, which must agree; `tools/current` still
points at the live commit until `migrate` moves it).
That verifies the checksum, restores in one transaction, applies the commit's
migrations and attests the full schema. The scratch database is dropped
afterwards, pass or fail, and so is the drill's copy of the dump. The result
is in `/var/lib/ggd2l-drill/<lg>/last-drill.json`.

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
   That restores `/etc/ggd2l` (env files, `bot.env`, passwords, rclone and
   healthchecks settings), `/etc/cloudflared` (the tunnel's credentials),
   `/etc/caddy` and, in an archive from 2026-10-19 on, the lobby bot's state in
   `/var/lib/ggd2l-bot` (the bot is installed disabled, so nothing runs it yet).
   Re-run `install-kit.sh` so modes and owners match the new users.
5. The restored Caddy mode files are the old box's (usually `proxy`), and
   `agent import` runs only in maintenance: first `agent mode <lg> maintenance`
   for each league. Tim decrypts the newest dump per league; copy each into
   `/var/backups/ggd2l/cutover/<lg>/` and run `agent import <lg> <file>`, then
   `grants-check` and `preflight`. Skip `identity`: a box dump already carries
   the markers.
6. `agent prepare <live sha>`, then per league `agent build`, `start`, `check`
   and `promote` at the live SHA.
7. **The lobby bot,** once the old box's bot is surely stopped (a lost droplet;
   otherwise `sudo systemctl disable --now ggd2l-bot` there first): one Steam
   account never runs in two places. `agent bot-deploy <live sha>` installs
   its code. If `sudo test -s /var/lib/ggd2l-bot/steam-auth.json` fails (no
   saved session: an archive from before 2026-10-19), Tim signs it in first
   (below). Then `sudo systemctl enable --now ggd2l-bot`, watch
   `sudo journalctl -u ggd2l-bot -f` for "Control service listening" and
   "Game Coordinator connected", and check `agent bot-status`: `active`,
   `enabled`, the release, and `lobby` null. A `set` lobby is a claim from the
   archive's day: release it from the admin controls on `/inhouse`. If Steam
   refuses the saved session (the journal shows
   `Steam login/connection failed`, the unit still active),
   `sudo systemctl stop ggd2l-bot`, sign in, then
   `sudo systemctl start ggd2l-bot`.
   **Signing in** is Tim's, in his own terminal, and nobody else sees any part
   of it: the bot's `npm run login` helper, run as the bot's user with its
   environment, showing a QR code to approve with the bot account's Steam
   Guard (append `--password` for its credentials and an email code instead):
   `ssh -t ggd2l-1 'sudo systemd-run --pty --wait -p User=ggd2l-bot -p EnvironmentFile=/etc/ggd2l/bot.env -p WorkingDirectory=/srv/ggd2l/bot/current/ops/dota-lobby-bot /usr/bin/node login.mjs'`
   ([DOTA-LOBBY-BOT](../../docs/DOTA-LOBBY-BOT.md#on-the-box), step 7).
8. `sudo systemctl enable --now cloudflared-ggd2l`. The tunnel id and DNS are
   unchanged, so traffic returns once it connects.
9. Enable the backup, drill, heartbeat and config-archive timers, start one
   backup and then one drill per league and check `Result=success` (see
   Backups), and watch the admin channel for the box's 👋 hello (the first
   heartbeat after the restored `alerts.env`), then
   `sudo systemctl start ggd2l-alert@test`.

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
`--bot-via-relay` writes the relay's URL instead (the rollback, or a bot back on the Mac).
The env contract accepts only those two in production. Then on the box,
`sudo bash /root/ggd2l-kit/ops/selfhost/cutover/compose-env.sh <lg> [--keep-secrets]`
adds the app-role database URL and fresh AUTH, CRON and BACKUP_RECEIPT secrets
(or, with `--keep-secrets`, the current ones), keeps the server-action key, and
replaces the file only if the env contract passes. Then
`sudo -n ggd2l-agent envcheck <lg>` runs the production validation on it;
start, promote or restart nothing on the file until it answers ok (before
the first release, with no live release to run it from, the build runs the
same validation and refuses the file instead). Staging carries no Discord
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

**Cutover cleanup, once the 14 days are over** (the redirects on 308 and both
Neon databases deleted, per DECISIONS' Hosting row): remove what the cutover
left on the box. The plaintext Neon dumps in `/var/backups/ggd2l/cutover/<lg>/`
fall under no 48 h rule; the box's own hourly copies in R2 and Tim's encrypted
copies on the Mac remain. Check that no `agent import` is staged there (the
folder is also the restore path), then, as the admin user:

```bash
sudo sh -c 'ls -la /var/backups/ggd2l/cutover/us /var/backups/ggd2l/cutover/eu'   # only the cutover's dumps and sidecars
sudo sh -c 'shred -u /var/backups/ggd2l/cutover/us/* /var/backups/ggd2l/cutover/eu/*'   # the folders stay
du -sh ~/buildtest ~/.npm; rm -rf ~/buildtest ~/.npm   # the 2026-10-15 trial build and its npm cache
```

Also check that the 0700 staging folder the dumps were copied into with
`scp -p` (see `neon-dump.mjs` above) is empty or gone: under the file-to-file
rule at the top it was shredded at the import, so a dump still there is a
leftover plaintext copy to `shred -u`.

## Tim's monthly hour

- Scroll the admin channel: every 🔴 has its 🟢, or you know why not.
- `ssh ggd2l-1 sudo -n ggd2l-agent status`: live SHAs match
  `https://{us,eu}.ggd2l.com/api/health/release`, no failed unit, no pending
  reboot stuck for days, `serverErrors24h` near 0 (`maintenance503s24h` counts
  only the maintenance page), and a `lastDrill` from this week.
- `ssh ggd2l-1 df -h /`: comfortably under the 85% alert line. A release takes
  about 1.2 GB and two days of dumps sit beside it.
- OpenDota rate limits: both leagues now share one IP. The app treats a 429 as
  "unreachable" and does not log it, so look for result imports that lag rather
  than for journal lines.
- `ssh ggd2l-1 cat .ssh/authorized_keys`: only keys you recognize. `last -n 20`
  for logins.
- Spot-check R2: the newest `daily/` object for each league is from today.
- Quarterly: the decrypt drill above.
