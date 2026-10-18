# Production operations and release evidence

This is the executable operating contract for production releases and recovery.
It does not make a deployment safe by itself: the release owner must attach
evidence from the actual box, DNS, identity, Discord, monitoring and backup
providers. Never put a secret, connection URL, session cookie, backup receipt,
or bearer header in this record.

> **Status: planned.** Production is one self-hosted box (`ggd2l-1`): both
> leagues' Next slots, their PostgreSQL 18 databases and the lobby bot, behind
> a Cloudflare Tunnel and Caddy. Both leagues move there from Vercel and Neon
> on the cutover day ([DECISIONS](DECISIONS.md#hosting)); until then they run
> on Vercel and Neon as before and nothing is released. The procedure this
> page replaced is at `git show 33a1f348:docs/PRODUCTION-OPERATIONS.md`.
> **Until a league has moved, run its scheduler pause, resume and rollback
> deploys from a checkout of 33a1f348.** The `wrangler*.jsonc` on `main`
> already point the Workers at `https://us.ggd2l.com` and
> `https://eu.ggd2l.com`; deployed for a league still on Vercel, they would aim
> its only clock at an origin that answers only the maintenance page (or
> doesn't resolve yet), and its automation would stop.

The agent calls below use the helper from [RELEASING](RELEASING.md#how-the-box-serves-a-league):
`box_agent <verb> <args>` runs `/usr/local/sbin/ggd2l-agent` on the box over
SSH and prints one JSON object. Every verb and its arguments are in the
agent's `VERBS` table (`ops/selfhost/agent/ggd2l-agent.mjs`); any other verb
exits 2, and a refusal is `{ok:false, code, message}`.

## Release stop rule

Do not promote until the release delta has been classified from the commit
each league's live release runs to the candidate commit. The base
must be fetchable and an ancestor of the candidate. Missing metadata, unknown
paths, unexpected Git statuses, and changes to schema, migrations, release
plumbing, server actions, cron, or scheduler code fail closed to the strict
lane. Some allowlisted documentation and test paths are neutral companions;
sensitive-path tests and policy/runbook documents remain strict, and a
neutral-only delta never establishes the UI-only fast path by itself.

The migration gate inside the box's build (`scripts/vercel-build.mjs`, the
script behind `npm run build:vercel`, run with `NODE_ENV=production`) cannot
apply migrations. It runs `scripts/production-schema-check.mjs`, which attests
the exact migration ledger, Prisma schema, and required PostgreSQL-native
objects read-only before compiling. The subsequent Next.js build still
receives its runtime environment and must remain side-effect-free. Without
`NODE_ENV=production` both gates skip silently, which is why the agent
requires their pass lines in the build output.
In development the build performs no database gate or migration mutation. The
box has no Previews: staging is the on-demand slot on a scrubbed copy of the
database ([DECISIONS](DECISIONS.md#hosting)), which is designed but not yet
built (no unit or agent verb runs it).

Schema-neutral UI and application releases require neither a fresh backup nor a
scheduler pause. A strict classification requires full CI and review, but does
not alone imply a database release or scheduler pause; the classifier's
`needs_db_release` and `needs_scheduler_pause` flags select those procedures.
Production migration writes occur only through the guarded migration release
(`scripts/release-migrations.mjs --apply <reviewed 40-character HEAD SHA>`,
the script behind `npm run db:migrate:release`), which `box_agent migrate`
runs from a clean tools clone at that exact commit. Both URL variables
supplied to that process are the league's **owner** role
(`/etc/ggd2l/<lg>-migrate.env`): it owns every application relation and
function and has `CREATE` on the schema. The running app uses the non-owner
**app** role, which can only read and write rows; the owner URL reaches only
the agent's migration, preflight and grant checks, never a slot or a build.

A release runs only when an operator runs `npm run release:both -- --apply`
at the reviewed commit. The candidate is built with production configuration
in the league's idle slot, reachable only on 127.0.0.1, checked, and promoted
without rebuilding.

Exactly one one-minute scheduler may be authoritative. The reviewed
Cloudflare Worker in `ops/cloudflare-automation-worker` owns the only
`* * * * *` trigger. Do not add a second Worker, monitor, Vercel cron, systemd
timer or in-process schedule that calls `/api/cron/automation`.

## Required owners

Record names or on-call handles for all four functions. Two people should be
able to reach the box (their own SSH key) and the Cloudflare, DigitalOcean
and backup accounts with MFA before traffic is opened. The data correction owner and deputy must each have independent MFA
access to the private support channel and case register; a shared password is not
continuity.

- Release owner: runs the release at the pinned commit and makes the final
  go/no-go.
- Database/recovery owner: owns backup, restore, drill, and cutover decisions.
- Incident/communications owner: owns monitoring acknowledgement and player
  communication through a channel independent of the application and Discord
  bot being recovered.
- Data correction owner and deputy: own private intake, identity verification,
  request scoping, the case register, reviewed fulfillment, and restoration
  replay. The deputy must be able to continue the process without the primary.

## Release evidence record

Copy this section into a private release record and fill it in. Links may point
to access-controlled provider pages; never paste credentials.

```text
Release date/time (UTC):
Reviewed commit SHA:
Canonical production base SHA:
Classifier lane, reasons, and exact changed-file inventory:
CI run URL and result:
Previous release id + commit (each league):
Candidate release id + commit (each league):
Promoted release id + commit and slot (each league):
Release evidence folder (backups/release-<date>/) and box manifest:
Release owner / database owner / communications owner:
Data correction owner / deputy:
Go/no-go approvers:

Box, Node 22 and pending-reboot evidence (`agent status`):
Operator-run release (exact command and commit):
League database isolation (each app role refused by the other database):
Authoritative scheduler (exactly one) and one-minute cadence evidence:
No box timer or process calls /api/cron/automation:
Cloudflare Worker deployment/version and sole Cron Trigger evidence:
Cloudflare Free-plan capacity/limits review:
Encrypted `AUTOMATION_SECRET` binding-name evidence (never its value):
PostgreSQL connection limits (max_connections, per-league connection_limit):
Candidate slots on 127.0.0.1 only; Caddy mode file names the live slot:

Canonical DNS: proxied CNAMEs to the tunnel; ufw allows SSH only:
Cloudflare zone settings (SSL Full (strict), Always Use HTTPS, Rocket Loader off, Email Obfuscation off, Bot Fight Mode off, no Cache Rules, the Browser Integrity Check skip rule for `/api/cron/automation`):
Scheduler-style probe of each league's `/api/cron/automation` (the app's own 401, no `cf-mitigated: challenge`):
Caddy header contract (stripped and set headers) evidence:
`CLIENT_IP_HEADER=cf-connecting-ip` trust-path evidence (forged headers ignored):
Abuse test and database plateau result:
Dynamic routes `cf-cache-status` never HIT evidence:
Production `__Host-` session/OAuth creation and expiration Set-Cookie evidence:
First-release forced reauthentication communication/result:

Credential-free production database identity (`deploymentRegion`, `deploymentOrigin`):
DigitalOcean weekly backups enabled:
Accepted RPO / RTO:
Pre-release dump SHA-256 + R2 object key (no receipt):
Backup verification result/time:
Restore drill (`agent drill`) result/time:
Baseline fingerprint / migration preflight / postflight results:
Owner-role ownership + schema-CREATE evidence and runtime grants check (no credential):
Migration release (`agent migrate`) result and bound HEAD SHA (`needs_db_release` only):
Failed-migration guarded resolve result, if applicable:
App-role read/write smoke results:
Log retention (journald cap, Caddy roll size) and root-only access evidence:
Backup expiry (local 48 h, R2 7/35/400 days) and deletion-process evidence:

Canonical domain + HTTPS/certificate result:
Apex/www redirect result:
Steam domain/key/callback login result:
Discord OAuth exact callback result:
Discord bot guild/role hierarchy result:
League/inhouse webhook channel result:
OpenDota profile and real match-import result:
Temporary credential failure/timeout log-trace inspection + rotation result:
Largest representative season archive byte size / 413 rehearsal result:
Private support contact test and continuity result:
Primary/deputy contact-channel MFA result:
Private case-register storage/access/encryption/retention evidence:
Data-correction replay register location and access evidence:
Support test case ID + send/acknowledgement result (no request content):
Data-correction/retention/restore tabletop result:

live probe result:
ready probe result:
automation probe result:
Two consecutive production Cloudflare Cron result timestamps (Caddy log):
Discord alert-delivery evidence (each Worker's and the box's hello, `ggd2l-alert@test` and its recovery):
Slot rollback rehearsal result:
Traffic freeze (`agent mode <lg> maintenance`) rehearsal result:
Final smoke-test result:
Residual risks explicitly accepted:
```

When the classifier reports neither `needs_db_release` nor
`needs_scheduler_pause`, mark the corresponding backup, restore, migration,
scheduler-pause, and lease-drain fields
`not required — no affected subsystem` and attach the classifier evidence. Do
not fabricate or refresh recovery artifacts merely to fill those fields.
Complete every field selected by an impact flag before changing that subsystem.

## Pre-promotion procedure

### Every release

1. Resolve the immutable full SHA of each league's live release
   (`box_agent live <lg>`, which must match the public
   `/api/health/release`), fetch it, and confirm it is an ancestor of the
   candidate `HEAD`. `npm run release:both` does this step and the next.
   Extract the classifier from that trusted production commit, run it across
   the exact delta, and record its lane, reasons, and changed-file inventory.
   Never let the candidate's copy classify itself:

   ```bash
   release_classifier_dir="$(mktemp -d)"
   release_classifier_path="$release_classifier_dir/classify-release.mjs"
   trap 'rm -f -- "$release_classifier_path"; rmdir -- "$release_classifier_dir"' EXIT
   if git show \
       "$production_release_sha:scripts/classify-release.mjs" \
       > "$release_classifier_path" 2>/dev/null \
     && node "$release_classifier_path" \
       --base "$production_release_sha" \
       --head "$candidate_release_sha" \
       --format json; then
     :
   else
     printf '%s\n' '{"lane":"strict","needs_postgres":true,"needs_mutation":true,"needs_e2e":true,"needs_db_release":true,"needs_scheduler_pause":true,"reasons":["trusted production classifier unavailable"]}'
   fi
   rm -f -- "$release_classifier_path"
   rmdir -- "$release_classifier_dir"
   trap - EXIT
   ```

   Both variables must contain verified full lowercase SHAs. Never
   classify a production release from the PR merge base. If the production
   commit has no classifier, extraction fails, or the trusted classifier fails,
   the fallback selects the strict lane and every impact procedure. Do not run
   the candidate classifier to bypass that result.

2. Require the CI gates selected by the classifier to pass for the exact
   candidate SHA. `ui-only` may narrowly skip PostgreSQL and mutation jobs;
   `app` runs standard application CI; `strict` runs every CI gate. In any
   lane the mutation shards may be skipped only when the trusted
   classification reports `needs_mutation: false`, or when `release:both`
   finds the four shards passing on an earlier `main` commit whose delta to the
   candidate every changed region's trusted classifier calls mutation-neutral.
   When it finds none, follow the recovery in the README's "Hosting and release
   setup" (a forced CI run on `main`). Only
   allowlisted documentation/test paths are neutral companions; sensitive-path
   tests and runbook/policy changes remain strict, and a neutral-only delta does
   not earn a fast lane. GitHub's event-base classifier is only a CI
   optimization; it is not release authorization. If the canonical production
   delta is strict, confirm every strict job ran, even if event-based CI skipped
   one. A live release that can't be identified blocks the fast path.
3. Record each league's previous known-good release. First exercise the change
   away from production: on a fixture server (`npm run fixture:*`) or the
   on-demand staging slot (a scrubbed copy of the database reached through
   `ssh -L`; [DECISIONS](DECISIONS.md#hosting), designed but not yet built).
   Check the probes and endpoint
   contracts, an appropriate database-backed page, focused desktop/mobile
   browser verification for UI changes, affected API/auth/actor checks for
   application changes, and the error output. This rehearsal may include a
   bounded Admin maintenance run on the staging slot, but it is not the
   artifact that will be promoted.
4. If either `needs_db_release` or `needs_scheduler_pause` is set, complete the
   applicable procedure below. A strict lane with both flags clear needs full CI
   and review but no database backup/release or scheduler pause.
5. Build a **production** candidate for the exact reviewed SHA on the box
   (`box_agent build <lg> <sha>`, which `release:both` runs for both leagues)
   with the league's production configuration. Its migration gate must attest
   the actual production database's migration ledger, Prisma schema, and
   native objects read-only. The Next.js build that follows remains
   responsible for side-effect-free application build code. Any drift stops the
   release.
6. Start the candidate in the league's idle slot and run the shared smoke
   against it on 127.0.0.1 (`box_agent start`, then
   `box_agent check <lg> <id> --expect production`): the read-only probes, the
   release identity, public database-backed pages, the same-origin guard, the
   sign-in redirects, image resizing and the overlay. Never call `/api/sync`
   or `/api/health/automation` on a candidate, and run no mutation or
   scheduler action against live data. Promote that exact tested release
   rather than rebuilding it. After promotion, check the pages you changed on
   the live site and scan its error rows (`box_agent logs <lg> <epoch ms>`).
7. When `needs_scheduler_pause` is false, leave the sole Cloudflare trigger in
   place and observe at least two consecutive HTTP 200 `SUCCEEDED` passes plus
   `/api/health/automation` = 200 after promotion.

### Database- or scheduler-impact prerequisites

Complete only the branches selected by `needs_db_release` and
`needs_scheduler_pause`. A `strict` lane by itself does not select either branch.

1. Confirm that full CI passed for the exact SHA and that the release owner
   approves the release.
2. When `needs_scheduler_pause` is true, run `npm run scheduler:pause` (and
   `scheduler:europe:pause` for Europe), verify zero Cloudflare Cron Triggers
   and `AUTOMATION_PAUSED=true` on the deployed Worker, wait the full
   15-minute propagation bound, prove no automation request lands across two
   further expected minute slots (`box_agent cron-requests <lg> <epoch ms>`
   counts them in the Caddy log and must answer 0), then wait at least 90
   seconds after the last possible attempt and prove no active lease remains
   (`box_agent lease <lg>` answers `null` for both fields).
3. When `needs_db_release` is true, validate production configuration with no
   test overrides (`box_agent envcheck <lg>` reports names only). The migration
   runs with the league's owner role: the agent loads `/etc/ggd2l/<lg>.env`
   (which must pass the env contract, because the migration first validates
   the full production environment) and then `/etc/ggd2l/<lg>-migrate.env`,
   whose `DATABASE_URL` and `DIRECT_URL` are the same owner URL and replace the
   app role's. That role owns every
   application relation and function and has `CREATE` on the schema, because
   every restore onto the box runs as the owner. Ordinary
   `SELECT`/`INSERT`/`UPDATE`/`DELETE` grants do not authorize `ALTER TABLE`.
   The read-only migration preflight inventories these ownership rights before
   its data checks (`box_agent preflight <lg> <sha>`, as the owner); any
   reported object is a release stop.

   The running app keeps the non-owner app role (`ggd2l_<lg>_app`). The agent
   gives the owner URL only to the migration process and its checks, never to
   a slot or a build, so there is nothing to restore afterwards. After the
   migration, `box_agent grants-check <lg>` must report no problems: the app
   role can read and write every table, can't create in the schema, owns
   nothing and can read the migration ledger. A new table it can't write is a
   release stop.

4. Still when `needs_db_release` is true, take a fresh full dump with
   `box_agent backup <lg>`, which verifies it and copies it offsite; record its
   SHA-256 and R2 object key. Then rehearse with `box_agent prepare <sha>` and
   `box_agent drill <lg> <sha>`, which restores the newest dump into the scratch
   `ld2l_restore_test` and migrates it with the reviewed commit's tools. The
   dump uses `--no-owner --no-privileges`, so the drill's restore role owns
   what it restores; the ownership proof is the preflight in step 3, not the
   drill. For an old `db push` database, complete the guarded legacy baseline
   procedure in the README first.
5. When `needs_db_release` is true, run the migration through the agent:

   ```text
   box_agent migrate <lg> <reviewed 40-character HEAD SHA>
   ```

   It runs `scripts/release-migrations.mjs --apply <sha>` (the script behind
   `npm run db:migrate:release`) from a clean tools clone at that commit, with
   the league env file and then the migrate env file (so only the database
   URLs become the owner's) and `VERCEL_ENV=production` set only in that
   process, then the grants check. Its output, redacted, is in
   `/var/log/ggd2l/tools/migrate-<lg>-<stamp>-<sha12>.log`. This is the only production
   migration writer. It enforces technical environment, immutable-checkout,
   reviewed-SHA, migration-safety, preflight, deploy, and postflight gates, and
   refuses root or `prisma/` `.env` files that Prisma could auto-load after
   validation. It does **not** prove human approval, CI, backup and drill,
   scheduler propagation, or lease-drain evidence; the release owner must
   verify and record those prerequisites before invoking it. Stop on any
   failure; never invoke `prisma migrate deploy`, mark a migration applied, or
   use an abbreviated/different SHA to bypass the wrapper.

6. When `needs_scheduler_pause` is true, validate the active and paused Worker
   artifacts and confirm the reviewed `AUTOMATION_URL` and encrypted binding
   name. Keep the scheduler paused through candidate verification and promotion,
   then deploy the reviewed active configuration, allow for propagation, and
   require the two-pass health gate before closing the window.

Build the production candidate after postflight succeeds when a database
release ran; otherwise build it after the required strict CI and review. A
scheduler-only change does not invent a database postflight prerequisite.

### Fully rolled-back failed migration

A failed migration release is a release stop, not permission to rerun Prisma.
Preserve the first PostgreSQL/Prisma error, the reviewed SHA and migration name,
the time, and credential-free ledger/catalog evidence. Reproduce the failure
on a scratch restore of the pre-release dump (`box_agent drill <lg> <sha>`)
before touching the live ledger. Do not diagnose privileges from that restore
alone: `--no-owner --no-privileges` makes the scratch restore role own the
restored objects and can hide the production ownership failure. Check the
live ownership with `box_agent preflight <lg> <sha>` and
`box_agent grants-check <lg>` instead.

An error such as `must be owner of table InhouseQueueEntry` on the first
`ALTER TABLE`, even when ordinary DML works, means the object isn't owned by
the league's owner role. Find out how (a restore that ran as another role, a
hand-made table) and correct it deliberately before any ledger recovery. Do
not transfer objects or add broad grants ad hoc during the failed release.

The narrow resolver below is allowed only for one exact, atomic, fully rolled-
back attempt. Its guard requires a clean checkout at the reviewed full SHA,
`VERCEL_ENV=production`, a direct non-pooled DDL connection, the immutable
migration inventory, the repository-pinned Prisma version, no Prisma dotenv
files, a valid completed prior ledger, one unresolved target row with the
reviewed checksum, zero applied steps and no finished target row. It also
requires every catalog object that migration would create to be absent and the
current role to own or immediately inherit ownership of the affected table,
with the required schema/trigger privileges. If any condition is uncertain or
the guard rejects it, stop and prepare a reviewed forward-recovery or restore
plan; do not weaken the check.

The agent has no verb for it. On the box, run it the way the agent runs its
tools: from the same tools clone the migration used
(`/srv/ggd2l/tools/<sha12>`), as `ggd2l-build`, with the league's migrate env
loaded by systemd and `VERCEL_ENV=production` set for that process only,
never a URL in argv:

```text
sudo systemd-run --pipe --wait --collect -p User=ggd2l-build \
  -p WorkingDirectory=/srv/ggd2l/tools/<sha12> \
  -p EnvironmentFile=/etc/ggd2l/<lg>-migrate.env \
  -E VERCEL_ENV=production \
  /usr/bin/node scripts/migration-failed-resolve.mjs --apply <reviewed 40-character HEAD SHA> <migration-name>
```

That is the script behind
`npm run db:migrate:failed-resolve -- --apply <sha> <migration-name>`. The
migration argument is not free-form. It must be the exact reviewed target
printed by the command's usage message; every other name is refused.

The command only changes that proven failed row to rolled back and re-attests
the unchanged catalog and ledger shape. It does not mark the migration applied
and does not execute its SQL. After it succeeds:

1. Take and verify a **new** dump (`box_agent backup <lg>`) and record its
   SHA-256 and R2 object key.
2. Repeat the drill (`box_agent drill <lg> <sha>`) and the owner-role
   preflight (`box_agent preflight <lg> <sha>`).
3. Run the complete guarded migration again: `box_agent migrate <lg> <sha>`.
4. Require postflight and a clean `grants-check`, and only then build the
   production candidate.

Never use `migrate resolve --applied`, run `prisma migrate resolve` directly,
edit `_prisma_migrations` with manual SQL, mark an unapplied migration finished,
or blindly retry `migrate deploy`. Those shortcuts can make the ledger claim a
schema state the catalog never reached.

### Initial launch and affected-subsystem evidence

Re-run the broader platform checks when first launching or when their subsystem
changes: Node 22 and the box; league database isolation; candidate slots on
localhost only; PostgreSQL connection limits; Cloudflare capacity; tunnel,
Caddy header and cache behavior; Steam, Discord, webhook, and OpenDota
credentials; largest season-audit export; support/case-register continuity;
retention and restore-replay controls; and independent alert delivery. A
schema-neutral footer edit does not require repeating unrelated provider or
data-handling rehearsals. The detailed gates below remain authoritative for the
subsystem they cover.

## Cloudflare scheduler runbook

No systemd timer, in-process cron, monitor or `vercel.json` `crons` entry may
call the automation route. The only production clock for the US is
`ggd2l-automation-scheduler`, defined by
`ops/cloudflare-automation-worker/wrangler.jsonc` (Europe's is
`ggd2l-europe-automation-scheduler` in `wrangler.europe.jsonc`, with the same
rules): `workers.dev` is disabled, the reviewed non-secret `AUTOMATION_URL`
is pinned to the league's canonical route
(`https://us.ggd2l.com/api/cron/automation`,
`https://eu.ggd2l.com/api/cron/automation`), it sends
`user-agent: ggd2l-automation-scheduler` so Cloudflare never sees an empty
one, and one `* * * * *` Cron Trigger invokes its `scheduled()` handler. The
sibling `wrangler.paused.jsonc` removes all triggers and sets
`AUTOMATION_PAUSED=true`; it is the only supported pause configuration. The
active configuration sets this flag to `false`. A paused Worker logs only
`AUTOMATION_PAUSED` and returns before making any HTTP request, including when
Cloudflare delivers a late scheduled event. All other settings stay identical.
`AUTOMATION_SECRET` is its only encrypted secret binding and must be
byte-for-byte identical to the league's `CRON_SECRET` in `/etc/ggd2l/<lg>.env`.
Never expose that value in a command argument, URL, source, `.dev.vars`,
launch record, log, screenshot, issue, or chat; move it file to file and into
Wrangler through stdin only.

Cloudflare Workers Free currently permits 100,000 requests/day, five Cron
Triggers/account, 50 external subrequests/invocation, 10 ms CPU per Cron
Trigger, and 15 minutes wall time. This Worker uses about 1,440 invocations/day,
one trigger, one outbound request per invocation, a 65-second timeout, and a
bounded 2 KiB response parse; with alerts on, also one Durable Object request
per unpaused invocation and a Discord post only when an alert changes (below). Before initial launch and before a scheduler or
account-capacity change, verify that other account work has not consumed those
shared limits and re-check the current
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/).
An exceeded quota or CPU limit is a failed scheduler event, not an accepted
residual risk.

### Provision and roll out

Deploy only after the league's live slot on the box serves a healthy
`/api/cron/automation` route. Use the exact reviewed Wrangler version. On a
brand-new account, `wrangler secret put` fails because the Worker does not yet
exist. Bootstrap it with the paused config and a private, short-lived secrets
file, then verify the binding before enabling the trigger. `secret list` should
reveal its name and type, never its value.

```bash
npx wrangler@4.118.0 login
umask 077
task_secrets_file="$(mktemp)"
trap 'rm -f -- "$task_secrets_file"' EXIT
printf 'AUTOMATION_SECRET: ' >&2
IFS= read -r -s task_scheduler_secret
printf '\n' >&2
printf 'AUTOMATION_SECRET=%s\n' "$task_scheduler_secret" > "$task_secrets_file"
unset task_scheduler_secret
npx wrangler@4.118.0 deploy \
  --config ops/cloudflare-automation-worker/wrangler.paused.jsonc \
  --secrets-file "$task_secrets_file"
rm -f -- "$task_secrets_file"
trap - EXIT
npx wrangler@4.118.0 secret list --cwd ops/cloudflare-automation-worker
npm run scheduler:deploy
npx wrangler@4.118.0 deployments status --cwd ops/cloudflare-automation-worker
```

The temporary file must be mode 0600, must remain outside the repository, and
must be removed immediately after the paused bootstrap. The active deployment
must not run until the production route is healthy and the league's
`CRON_SECRET` matches the encrypted binding. To replace the binding on an
existing Worker without a prompt, pipe it from a 0600 file:
`npx wrangler@4.118.0 secret put AUTOMATION_SECRET --config <paused config> < <file>`,
then shred the file.

Confirm the deployed `AUTOMATION_URL` matches the reviewed config, Cloudflare
shows exactly one `* * * * *` trigger, and nothing on the box calls the route.
Adding, changing,
or deleting a Cloudflare
[Cron Trigger](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
can take up to 15 minutes to propagate.
After propagation, require two consecutive one-minute HTTP 200 `SUCCEEDED`
passes, `/api/health/automation` = 200, a cleared lease, and zero consecutive
failures before opening traffic.

### Discord alerts from the Workers

Each Worker is also the leagues' dead-man alarm
(`ops/cloudflare-automation-worker/src/alerts.ts`; the rules are in
[DECISIONS](DECISIONS.md#hosting) and the box runbook's Alerts). After every
unpaused pass it hands the outcome to one SQLite Durable Object
(`SchedulerAlertState`, bound as `ALERT_STATE`, migration `v1`), which posts
to the admin channel when 3 passes in a row fail (10 between 09:00 and 09:15
UTC), a reminder each day, and the recovery after 2 clean passes; the first
pass that sees a new webhook posts a 👋 hello. A healthy minute costs one
Durable Object request and one row read, and writes nothing (Workers Free:
100,000 requests, 5 million rows read and 100,000 rows written a day, account
wide; both leagues use about 2,900 requests). The alert never changes the
pass: a failing Durable Object or Discord logs `ALERT_STATE_UNAVAILABLE` or
`ALERT_POST_FAILED` and the cron event succeeds or fails exactly as before.
Only the two canonical routes alert, and the posted text names a failure's
kind, never its message.

Two optional secrets turn it on, the same values for both Workers:
`ALERT_DISCORD_WEBHOOK_URL` (the webhook, a credential) and
`ALERT_PING_USER_ID` (the one Discord user a failure pings; leave it unset to
ping nobody). Neither is in `secrets.required`, so a pause always deploys.
Each `secret put` deploys a new version of the Worker's current code at once,
so put them while the reviewed code is live, from 0600 files, through stdin:

```bash
npx wrangler@4.118.0 secret put ALERT_DISCORD_WEBHOOK_URL --config ops/cloudflare-automation-worker/wrangler.jsonc < <0600 file>
npx wrangler@4.118.0 secret put ALERT_DISCORD_WEBHOOK_URL --config ops/cloudflare-automation-worker/wrangler.europe.jsonc < <0600 file>
npx wrangler@4.118.0 secret list --cwd ops/cloudflare-automation-worker
```

The next pass posts each Worker's hello. To stop alerts, `secret delete` the
webhook; the state stays and the next hello comes with the next webhook.

### Pause and resume

To pause, deploy the reviewed guarded, empty-trigger configuration and record the
successful deployment:

```bash
npm run scheduler:pause
npx wrangler@4.118.0 deployments status --cwd ops/cloudflare-automation-worker
```

Verify Cloudflare shows zero Cron Triggers and the deployed Worker has
`AUTOMATION_PAUSED=true`. Record its active version and canonical target. Wait
the full 15-minute propagation bound, then prove the league's origin receives
no `/api/cron/automation` request across two further expected minute slots:
`box_agent cron-requests <lg> <epoch ms>` counts them in the Caddy log and must
answer 0, alongside the database's last cron attempt. Observe Worker
logs throughout those slots: a late scheduled event is allowed only if it logs
`AUTOMATION_PAUSED` and makes no outbound request. A flag or empty trigger list
alone is not proof of a quiet application. Restart the quiet window after any
observation gap. Wait another
90 seconds after the last possible attempt and prove no active lease remains
(`box_agent lease <lg>` answers `null` for both fields).
A trigger removal is not immediate, disabling a monitor does not pause the
Worker, and dashboard-only deletion creates drift from Wrangler's source of
truth.

To resume the reviewed current release, run:

```bash
npm run scheduler:deploy
npx wrangler@4.118.0 deployments status --cwd ops/cloudflare-automation-worker
```

The committed config clears `AUTOMATION_PAUSED` to `false` and reattaches exactly
one trigger. Verify both deployed settings. Allow for propagation and
repeat the two-pass health gate (two 200 passes in the Caddy log through
`box_agent logs <lg> <epoch ms>`). Stop if anything else calls the route or a
second Cloudflare/external schedule exists.

### Rotate or roll back

For `CRON_SECRET` rotation, pause first and drain the lease. Generate one new
value on the box into a root-only file, write it into the league's
`CRON_SECRET` in `/etc/ggd2l/<lg>.env` file to file, and restart the league's
live slot so it reads the file (`sudo systemctl restart ggd2l-<lg>@<slot>`,
with `<slot>` from `box_agent live <lg>`; about 15 seconds of errors, so do it
in the quiet window). Copy the value to the Mac as a 0600 file (`scp -p`), then
replace the Worker's encrypted binding from it through stdin and shred it:

```bash
npx wrangler@4.118.0 secret put AUTOMATION_SECRET --config ops/cloudflare-automation-worker/wrangler.paused.jsonc < <0600 file>
npx wrangler@4.118.0 secret list --cwd ops/cloudflare-automation-worker
```

Europe uses `wrangler.europe.paused.jsonc`. Resume and require two clean passes
before deleting the old value. Never overlap old/new schedulers to bridge the
credential change.
`AUTOMATION_URL` is committed non-secret configuration: changing it requires a
code review and Worker deployment, not an ad-hoc dashboard variable.

For a Worker-code incident, pause and drain first, then select the recorded
known-good version and roll back it explicitly:

```bash
npx wrangler@4.118.0 deployments list --cwd ops/cloudflare-automation-worker
npx wrangler@4.118.0 rollback "REVIEWED_VERSION_ID" --message "scheduler rollback" --cwd ops/cloudflare-automation-worker
npx wrangler@4.118.0 deployments status --cwd ops/cloudflare-automation-worker
```

Cloudflare resource bindings are not restored by a code rollback. Confirm the
reviewed `AUTOMATION_URL`, encrypted `AUTOMATION_SECRET` binding name, and paused
trigger state separately. Re-enable exactly one trigger only after the rolled
back Worker and target application are verified, then repeat the two-pass gate.

## Edge, tunnel, cache, and abuse-control gate

**The path in.** `us.ggd2l.com`, `eu.ggd2l.com`, `ggd2l.com` and
`www.ggd2l.com` are proxied CNAMEs to the Cloudflare Tunnel. The box's
`cloudflared-ggd2l.service` holds the tunnel open outbound (it needs outbound
port 7844) and hands every request to Caddy on 127.0.0.1:8080, which routes
by host to the league's live slot, serves `/_next/static/*` from the league's
union directory and redirects the apex and `www` to `https://us.ggd2l.com`
(302, path and query kept). Nothing listens publicly but SSH: ufw allows SSH
only, and the slots, Caddy, Postgres (5432) and the bot (8090) bind to
127.0.0.1. Record the DNS records, `ufw status` and the tunnel's connections
(`cloudflared tunnel info ggd2l`) as evidence.

**The header contract.** Caddy trusts `CF-Connecting-IP` only from 127.0.0.1
(cloudflared), removes `X-Vercel-Forwarded-For`, `X-Real-IP` and
`X-Middleware-Subrequest` before the app sees a request, sets
`X-Forwarded-Proto: https` and `X-Forwarded-For` to the client IP, and passes
`Host` through with a matching `X-Forwarded-Host`, which Next's server-action
CSRF check needs. Each slot runs with `CLIENT_IP_HEADER=cf-connecting-ip`, so
the rate limiter keys on that header alone; a forged `X-Forwarded-For` or
`x-vercel-forwarded-for` is ignored and a missing header falls into the shared
`unknown` bucket. With `LEAGUE_DEPLOY_ENV` declared, `publicOrigin(req)`
answers `APP_URL`, so the same-origin guard accepts only the canonical origin
and redirects never point at the local bind address, and
`providerReturnBase(req)` hands Steam and Discord the same origin. Caddy's JSON access log redacts
`Authorization` and `Cookie`, so the cron bearer never reaches a log. Verify
on the live site that a forged header doesn't move a request out of its
bucket, and record the result; do not infer client identity from a header sent
straight to local development.

**The limiter.** `src/lib/rate-limit.ts` keeps its buckets in each process.
On the box one process serves a league (two during a release's 90-second
overlap), so the limits hold league-wide, and Cloudflare's own DDoS protection
sits in front. That limiter covers only the JSON route handlers, so page renders
had no throttle: about 3 to 5 heavy pages a second from one client pin the one
vCPU both leagues share (audit, 2026-10-17).

**The zone's one rate-limiting rule** (Free plan: one rule, matched on the URI
path only, counted per IP, a 10-second period and a 10-second block). Since
2026-10-18 it reads "Page loads per IP (both leagues)". It counts every request
to any zone host whose path is not under `/api/`, `/_next/`, `/brand/`,
`/ranks/` or `/merch/` and is not one of the root static files: `/favicon.ico`,
`/icon.svg`, `/apple-icon.png`, `/apple-touch-icon.png`,
`/apple-touch-icon-precomposed.png`, `/opengraph-image.png`,
`/twitter-image.png`, `/manifest.webmanifest`, `/robots.txt`, `/sitemap.xml`
and `/hero-loop.mp4`. Above 40 such requests in 10 seconds from one IP, it
blocks that IP's matching requests (429) for 10 seconds. Everything under
`/api/` stays out of it: the cron path, the OAuth callbacks, the health probes,
and the draft and inhouse rooms' polls and actions. That leaves those to the
in-process limiter.

Its test, on 2026-10-18 from Tim's Mac:
- 60 quick requests to `/recap`: 44 answered 307, then 16 answered 429.
  Cloudflare's counters lag by a few seconds, so a burst gets a little past 40.
- A page during the block: 429. `/api/health/live` meanwhile: 200.
- 15 seconds later: 200 on both leagues.

To change it: Security, then Security rules, then Rate limiting rules on the
`ggd2l.com` zone. Keep `/api/` excluded, never put the cron path or an OAuth
callback under a rule, and retest normal room cadence, duplicate tabs and a
controlled burst after any change. Any further exception or bypass must have an
owner, an expiry and a monitor. Break-glass during an attack: turn on Under
Attack mode for the zone, which challenges every visitor's page load. The cron
path also sees the challenge, so watch the schedulers' passes and turn it off
again as soon as you can.

**The zone.** SSL/TLS Full (strict); Always Use HTTPS on; Automatic HTTPS
Rewrites, Rocket Loader and Email Address Obfuscation off (they rewrite pages);
Bot Fight Mode off and "Remove visitor IP headers" off. Keep health probes and
the bearer-authenticated cron path free of browser challenges. The scheduler's
user agent (`ggd2l-automation-scheduler`) only names its passes in the logs:
Browser Integrity Check also challenges a non-standard user agent, so the zone
carries one WAF custom rule with action Skip, Browser Integrity Check, on
`http.request.uri.path eq "/api/cron/automation" and http.host in
{"us.ggd2l.com" "eu.ggd2l.com"}`. The application keeps its constant-time
bearer check and the independent non-2xx alert. Before a league's point of no
return, prove the rule from the allowlisted Mac:
`curl -sS -o /dev/null -w '%{http_code} %header{cf-mitigated}\n' -A ggd2l-automation-scheduler -H 'accept: application/json' https://us.ggd2l.com/api/cron/automation`
(and the same for `eu.ggd2l.com`) must print the app's own `401` with an
empty `cf-mitigated`, never `challenge`. Checked on 2026-10-18: the dashboard
listed no custom rules at all (0/5), yet this check printed `401` with an empty
`cf-mitigated` on both leagues, and the schedulers' passes answer 200. Browser
Integrity Check does not challenge the scheduler today. Create the skip rule
above if the check ever shows `challenge`.

**No edge cache for dynamic routes.** The zone has **no Cache Rules** and
never "Cache Everything". The `vercel-cdn-cache-control` headers in the code
stay and do nothing here; the box answers `/api/sync`, the calendar and the
overlay itself. Static files (`/_next/static/*`, images under `public/`) may
read `cf-cache-status: HIT`. Every dynamic response, signed in or not, must
read anything but `HIT` (`DYNAMIC` normally): repeat `/api/sync`, a
representative `/api/calendar` URL, a page and a signed-in room response and
record their `cf-cache-status`. A dynamic or personalized HIT is a release
stop. Confirm the browser-facing `Cache-Control` still requires revalidation.

Finally, inspect production `Set-Cookie` headers after Steam login and Discord
link kickoff, then inspect logout plus successful, cancelled, and failed
callback expiration responses. Session, Steam state/return, and Discord state
cookies must use `__Host-` names with `Secure`, `Path=/`, no `Domain`,
`HttpOnly`, and `SameSite=Lax`; expiration headers must retain those attributes
while setting an empty value, `Max-Age=0`, and an epoch `Expires`. The hardened
name intentionally invalidates sessions from the previous release; announce and
verify the one-time sign-in requirement rather than adding a legacy-cookie
fallback that restores sibling-domain cookie tossing.

## Data correction and retention

This is the manual operating contract for the first release. It is not a
self-service export or deletion feature, does not decide whether a particular
request must be granted, and does not create a universal response deadline. Do
not promise an outcome until the request is verified, scoped, and shown to be
safe with the current data model and provider controls. Escalate any request
outside this runbook rather than improvising against production data.

### Intake, verification, and case handling

1. Accept requests only through the private support contact chosen by league
   operators. The contact channel must remain available if the application or
   Discord is unavailable. Never direct private request details to a public
   Discord channel, repository issue, ordinary support log, or an application
   `AdminAction` summary.
2. Reply with an opaque case ID and open a record in the access-controlled case
   register. Record only what is needed to operate the request: received time,
   request category, claimed account identifiers, verification state, assigned
   owner, affected systems, status, decisions, completed actions, and closure
   evidence. Keep request text and identity evidence out of launch records and
   ordinary application logs.
3. The application does not use an email address as account identity, so control
   of the sender mailbox does not prove control of a league account. Verify the
   requester with a single-use, non-sensitive case nonce through the exact
   Discord account already linked to the site, or through temporary proof of
   control of the linked Steam profile. Remove temporary proof after checking
   it. Never request a Steam or Discord password, Steam Guard or other 2FA code,
   API key, session cookie, backup receipt, or government identity document.
   Do not disclose non-public data before verification succeeds.
4. If verification is disputed, unavailable, or would expose another person,
   stop fulfillment, preserve the minimal case record, and escalate it. Do not
   weaken verification because a deadline or launch window is approaching.

### Scope and fulfillment

1. Build a case-specific source inventory before changing or disclosing data.
   Check the live `User` identity/profile/link fields; registrations, rosters,
   captaincy, bids, stand-ins, availability, reschedules, predictions and fantasy
   data; inhouse night "I'm in" rows (current night only); game and inhouse JSON; the retained Cred balances and relationless
   ledger (Cred betting was removed on 2026-09-27, but its rows remain); news,
   admin actions and announcement outboxes; the box's application logs
   (journald) and Caddy access logs, which hold player IP addresses; database
   backups (local
   dumps, the R2 copies and DigitalOcean's droplet backups); delivered Discord
   messages and roles; and source
   copies held by Steam, OpenDota, or Discord. Mark each source as found, not
   applicable, externally controlled, or pending review.
2. For an access request, assemble a read-only, subject-specific collection and
   review it with two people before delivery through an agreed private channel.
   Remove credentials, internal security material, and other players' private
   information. The Admin season JSON is a multi-user audit archive and must
   never be sent as a personal-data export. If there is no tested way to extract
   a source safely, record the gap and escalate it instead of claiming the
   request is complete.
3. Prefer existing, tested controls for corrections: profile edits, provider
   refresh, Discord unlink, registration editing, and season withdrawal. State
   their actual effects—withdrawal retains the registration record, and Discord
   unlink removes the local link/handle but cannot retract messages already
   delivered to Discord. Data sourced from Steam, OpenDota, or Discord may need
   correction at that provider before the next local refresh.
4. A database correction or de-identification that is not an existing tested
   application action requires a written, row-scoped change plan. The database
   owner and data correction owner must review it, create or reconfirm a recovery point,
   rehearse it against a disposable clone, record credential-free before/after
   counts and invariants, run it in a controlled traffic-free window, and verify
   connected league pages and workflows afterward. Never use an unreviewed
   `user.delete`, ad-hoc live SQL, a destructive Prisma command, or a season
   deletion as a shortcut.
5. There is no first-release self-service account deletion. For a removal
   request, identify which live values can be deleted or de-identified, which
   league/audit history would remain, which provider copies are outside this
   application's control, and which backups expire only through their configured
   lifecycle. Do not describe the request as fulfilled until the approved plan
   has run and its postflight checks pass. If the requested outcome cannot be
   performed safely, keep it open or escalate it and communicate the limitation
   without claiming deletion occurred.
6. Close a case with a concise record of the verified subject, systems checked,
   live changes made, retained categories and reason, external-provider limits,
   applicable backup/log expiry behavior, reviewers, and verification result.
   Send the requester the same factual boundaries without exposing internal
   credentials, other players, or provider administration details.

### Retention and restoration replay

- The current application has no general automatic expiry for accounts, season
  participation, game/inhouse history, admin actions, retained Cred ledger
  entries, or delivered announcement rows. Season withdrawal preserves its
  registration.
  Do not publish or repeat a fixed deletion period for any of these categories
  unless a tested application job or provider lifecycle actually enforces it.
- Before launch, inventory each stored category, its purpose and visibility,
  storage/provider, current retention behavior, deletion or de-identification
  mechanism, and owner. Separately record the real backup retention (local
  dumps 48 hours; R2 hourly copies 7 days, daily 35, monthly 400; DigitalOcean's
  weekly droplet backups), log retention (journald capped at 500 MB; each
  host's Caddy access log rolled at 50 MiB, ten kept), mailbox, and
  case-register retention settings. Verify and
  record the providers' encryption and protected-access controls; do not infer
  them from marketing language or leave them as an undocumented assumption.
- Discord messages and roles already delivered, and source records held by
  Steam, OpenDota, or Discord, are controlled through those providers. The case
  closure must distinguish a local unlink/correction from deletion at an external
  provider. Backups can retain an older value until their configured expiry
  (a monthly R2 copy for 400 days) even after the live database is corrected.
- Maintain a private restoration-replay register for every approved correction
  or de-identification. Store the opaque case ID, stable subject identifiers,
  affected sources, exact reviewed operation or immutable script reference,
  completion time, reviewers, and verification result—never passwords, request
  prose, or exported personal data. Protect it like the case register.
- Before promoting any restored snapshot, compare its recovery time with the
  replay register. Reapply and verify every later approved correction or
  de-identification on the disposable restore, then obtain data-correction-owner and
  database-owner approval. A technically healthy restore that resurrects a
  previously corrected value is not safe to promote.
- A future retention cleanup must be a focused, reviewed release with backup,
  dry-run/rehearsal, bounded deletion, observability, and tests. Until then,
  keep the private operator inventory accurate about the absence of automatic
  expiry.

### Pre-launch data-handling tabletop

Run all five scenarios with fixture-only request content and record the opaque
case IDs, operators, outcomes, and unresolved gaps in the private launch record:

1. The primary receives and verifies a subject-access request, inventories every
   source, rejects the multi-user season archive, and produces a reviewed
   subject-only response.
2. A player asks to correct provider data, unlink Discord, and withdraw. The
   operator explains which change is local, which must happen at the provider,
   and which season history remains.
3. A verified player requests removal. The operators identify restrictive
   relations, embedded/denormalized history, delivered Discord content and
   backups, then rehearse a reviewed de-identification plan on a disposable
   clone without touching production.
4. A disposable restore predating that correction is created. The operators
   find the later action in the replay register, reapply it, and verify it before
   declaring the restore eligible for promotion.
5. The primary is unavailable. The deputy independently accesses the MFA-backed
   contact channel and encrypted case register, acknowledges the test case, and follows
   the same verification rules without a shared credential.

An unverified contact channel, inaccessible deputy path, missing storage/encryption or
retention evidence, unsafe subject extraction, failed rehearsal, or incomplete
restore replay is a release stop, not a residual risk to discover after traffic
opens.

## Controlled promotion

`npm run release:both -- --apply` runs steps 3 to 5 for both leagues; these
are what it checks and what you confirm in the record.

1. Reconfirm the classifier result, approved full candidate SHA, exact green CI
   run, each league's previous release, and the tested candidate release. Do
   not rebuild during promotion.
2. Reconfirm the fresh dump, the drill, and the successful reviewed-SHA
   migration release only when `needs_db_release` was true; reconfirm the
   paused/drained scheduler only when `needs_scheduler_pause` was true. A
   strict lane with neither impact flag deliberately has none of those subsystem
   prerequisites.
3. Confirm the candidate production build passed client generation, then its
   read-only migration, schema, and native-object attestation, and finally the
   Next.js build, and that the candidate passed the shared smoke. Promote that
   release (`box_agent promote <lg> <id>`) and confirm through Cloudflare that
   `/api/health/release` reports its commit, region, origin and
   `deployEnv: "production"`.
4. Verify liveness, readiness, the apex redirect, a public season page, and
   the checks selected for the changed surface. Scan fresh errors
   (`box_agent logs <lg> <epoch ms>`).
5. If the Worker/scheduler was unchanged, leave its sole trigger attached and
   observe two consecutive HTTP 200 `SUCCEEDED` runs after promotion. If it was
   paused or changed because `needs_scheduler_pause` was true, deploy the
   reviewed active Worker, confirm nothing else calls the route, allow for
   propagation, and require the same two-pass gate. In both cases require
   `/api/health/automation` = 200, a cleared lease, a fresh success, and zero
   consecutive failures before closing the release window.

## Traffic freeze and incident triage

The first action in a suspected data-integrity incident is to stop new writes,
not to deploy a speculative fix.

1. Run `npm run scheduler:pause`, verify zero Cloudflare Cron Triggers and
   `AUTOMATION_PAUSED=true`, wait the full 15-minute propagation bound, and
   complete the quiet-request verification in **Pause and resume** across two
   further expected minute slots.
2. Put the league in maintenance: `box_agent mode <lg> maintenance`. Caddy
   then answers every request for that host, OAuth callbacks and the cron
   route included, with the 503 maintenance page; nothing reaches the app. A
   method-only rule would be insufficient because several authentication
   callbacks legitimately write on GET. Operational access stays SSH. To let
   only yourself in while you check, `box_agent allow <your IP>` and
   `box_agent mode <lg> allowlist`. Record when the freeze became effective.
3. Wait at least 90 seconds for the automation lease to drain. Do not delete or
   overwrite a live lease row.
4. Preserve logs (`journalctl -u ggd2l-<lg>@<slot>`, the Caddy access log) and
   record the first known bad time, last known good time, affected
   users/workflows, the live release, and the newest good dumps.
5. Decide whether this is a code/config incident or data corruption. Do not run
   down migrations, `db push`, ad-hoc repair SQL, or a restore over the live
   database.

The freeze must be rehearsed before launch (the rehearsal's `maintenance` and
`allowlist` modes are that rehearsal). Its evidence belongs in the private
launch record, not in the repository. **A promote writes the mode file too**,
`proxy` unless given `--mode`, so a bare promote lifts a freeze. `rollback`
refuses while the league is in `maintenance` and otherwise keeps its current
mode. While frozen, put a release back with
`box_agent promote <lg> <id> --mode allowlist`.

## Code/config rollback

Use this only when the data is trustworthy and the previous application is
compatible with the additive schema already applied.

A schema-neutral rollback between releases that preserve the authenticated cron
contract may roll back without pausing the scheduler (`box_agent rollback <lg>`
for each league, which promotes the previous release and restarts it clean);
verify the normal probes and observe two scheduled successes. If the
rollback crosses a schema or scheduler boundary, predates that contract, or has
uncertain compatibility, use the strict sequence below.

1. Keep the scheduler paused and traffic frozen; wait for the lease drain.
2. Promote the recorded previous known-good release behind the freeze:
   `box_agent promote <lg> <id> --mode allowlist`, which lets only your
   allowed IP in. The box keeps the live, previous and newest releases; an
   older one must be built again (`box_agent build <lg> <sha>`). Leave all
   migrations and expanded database objects in place.
3. From your allowed IP, verify login, the current schedule, one
   database-backed read, and the probes exposed by that release. A pre-release
   `/api/sync` may mutate on GET, so never use it as a generic rollback probe.
4. Release the repaired forward commit and deploy the reviewed Worker
   configuration. Confirm Cloudflare has exactly one trigger and nothing else
   calls the route, observe two successful passes, verify automation
   freshness, and then lift the traffic freeze (`box_agent mode <lg> proxy`).

## Data recovery

Use this when data is corrupt, missing, or of uncertain integrity. There is no
point-in-time restore: recovery is to a dump, with up to an hour of writes
lost unless they can be carried over by hand.

1. Keep traffic frozen and the scheduler paused. Have the database owner record
   the recovery target (which dump) and the accepted data-loss window. Take a
   dump of the current state first (`box_agent backup <lg>`) and keep it as
   incident evidence.
2. Restore the chosen dump into a scratch database that persists, never over
   the original. The box's drill can't host an investigation:
   `box_agent drill <lg>` restores only the newest local dump, and
   `ld2l_restore_test` is dropped when it exits, pass or fail. Restore into a
   scratch PostgreSQL 18 on the Mac instead (the box's major: its dumps may
   not load into an older server), as in Tim's quarterly decrypt drill
   (`ops/selfhost/README.md`, Restore): copy a local dump from
   `/var/backups/ggd2l/<lg>/local/` file to file, or decrypt an offsite one on
   the Mac with Tim's offline key (the box can't decrypt its own offsite
   copies), check it against its `.sha256`, then run
   `npm run db:backup:rehearse -- <file>` with `PG_RESTORE_TEST_URL` on the
   Mac's `ld2l_restore_test`. That database stays until the next rehearsal
   replaces it.
3. On the clone, run migration baseline as appropriate, migration preflight,
   isolated migration deploy, current postflight, and representative
   counts/invariants for users, seasons, registrations, teams, matches, games,
   draft state, inhouse history, the retained Cred ledger, announcements, and
   admin actions, and confirm reads and a disposable transactional
   write/rollback.
4. Compare the restore point with the private restoration-replay register.
   Reapply every later approved data correction or de-identification on the
   clone, verify its subject-specific postflight, and obtain
   data-correction-owner and database-owner approval that the recovered data
   will not resurrect it.
5. Dump the corrected clone, so the corrections travel with it: on the Mac,
   `DIRECT_URL=<the scratch URL> BACKUP_DIR=<a 0700 folder> npm run db:backup`
   writes `backup-<stamp>.sql` with its `.sha256`. Copy both file to file
   into `/var/backups/ggd2l/cutover/<lg>/` on the box: `box_agent import`
   reads only a `.sql` file in that folder, beside its `.sha256` sidecar.
   Importing the chosen dump itself instead would bring back everything the
   register removed; if you must, reapply every register entry to the
   restored database behind the freeze and verify each postflight before
   step 7.
6. Obtain database-owner and release-owner approval for cutover. Put the
   league in maintenance (`box_agent mode <lg> maintenance`): `import`
   refuses in any other mode, `allowlist` included. Then
   `box_agent import <lg> <file>`: it checks the dump against its SHA-256
   sidecar, stops both slots, drops and recreates the league's database,
   restores as the owner role, grants the app role and analyzes. Run
   `box_agent preflight <lg> <live sha>` and `box_agent grants-check <lg>`
   (0 problems: the app role's grants), start and check the live release
   (`box_agent start`, `box_agent check`), promote it with `--mode allowlist`,
   and from your allowed IP verify a database-backed read, the actor/phase
   smoke checklist and the register's postflights. Then deploy the sole
   Cloudflare trigger and observe two clean passes.
7. Lift the traffic freeze (`box_agent mode <lg> proxy`) only after monitoring
   and player-visible state are verified. Preserve the incident dump and
   artifacts according to the recorded case-retention decisions; do not keep
   them under an undefined policy.

## Secret compromise

Every production secret lives in a root-only file under `/etc/ggd2l/` (0700).
Change a value file to file (a 0600 file, `scp -p`, `shred -u` the copy),
never through argv, a log or chat; `box_agent envcheck <lg>` reports names
only. A slot reads its env file when it starts, so restart the league's live
slot afterwards (`sudo systemctl restart ggd2l-<lg>@<slot>`, about 15 seconds
of errors) or release again.

- `AUTH_SECRET`: rotate it under the traffic freeze and expect every existing
  session to be invalidated.
- `CRON_SECRET`: run the league's scheduler pause, wait the full propagation
  bound and lease drain, rotate the league's value and the Worker's encrypted
  `AUTOMATION_SECRET` to the same new value ([Rotate or roll back](#rotate-or-roll-back)),
  verify unauthorized = 401, then resume and require two authorized scheduled
  passes. Never put it in a URL, command argument, monitor, log, or launch
  record.
- Database credentials: set a new password for the role over `psql` stdin as
  the `postgres` superuser (never `-c` or argv), write it into every file that
  carries that role's URL (`<lg>.env` and `backup-<lg>.env` for the app role,
  `<lg>-migrate.env` for the owner, and its `secrets/` file), restart, then
  rerun readiness and an app-role read/write test.
- `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`: rotate only on compromise. The next
  build and start need it, and every form open in a browser breaks once.
- Discord bot token or webhook: revoke/rotate at Discord first, replace the
  production secret or admin setting, test the intended channel and role, and
  inspect for orphaned board messages.
- Steam/OpenDota credentials: rotate at the provider, update production, and
  rerun the corresponding real profile/import smoke test.
- The tunnel's credentials (`/etc/cloudflared/<uuid>.json`), the R2 key
  (`rclone.conf`) or the healthchecks ping URLs: replace them at Cloudflare or
  healthchecks first.
- The Discord alert webhook: delete it in the channel's Integrations, make a
  new one, then put it in both Workers' `ALERT_DISCORD_WEBHOOK_URL` and the
  box's `/etc/ggd2l/alerts.env` ([Discord alerts from the Workers](#discord-alerts-from-the-workers)).
  Each says hello on the new webhook. A new tunnel needs Tim to authorize `cloudflared tunnel
  login` again.
- An SSH key: remove it from `~ggd2l/.ssh/authorized_keys` on the box.

For every compromise, review provider and SSH access logs, revoke leaked
copies, check backups (the daily config archive in R2 holds copies of
`/etc/ggd2l`, so a leaked value stays in archives up to 35 days old) and CI artifacts, communicate impact through the incident owner, and record only
timestamps/credential identifiers—not values.

## Box operations

What runs on the box, and the upkeep it needs. `ops/selfhost/README.md` is the
kit's condensed runbook: the layout, daily operations, backups, restore, a
rebuild from zero (the install), the Origin CA fallback for the tunnel and the
cutover helpers. The agent's verbs are its `VERBS` table
(`ops/selfhost/agent/ggd2l-agent.mjs`).

**What runs.** `ggd2l-1` is a DigitalOcean droplet (NYC3, Ubuntu 24.04, 1
vCPU, 2 GB RAM plus 4 GB swap, 50 GB disk). Its units:

| Unit | What |
| --- | --- |
| `ggd2l-us@a`, `ggd2l-us@b`, `ggd2l-eu@a`, `ggd2l-eu@b` | The leagues' Next slots; only each league's live slot is enabled |
| `cloudflared-ggd2l.service` | The Cloudflare Tunnel, outbound only |
| `caddy` | Host routing, the union static files, the mode files in `/etc/caddy/ggd2l/`. The package's unit plus the kit's drop-in `caddy.service.d/10-ggd2l.conf`: restart on failure (2 s, never giving up) and `OOMScoreAdjust=-500`, since the packaged unit never restarts and both leagues go through it |
| `postgresql@18-main` | Both leagues' databases on 127.0.0.1:5432 |
| `ggd2l-backup@us.timer`, `ggd2l-backup@eu.timer` | Hourly dumps at :17 |
| `ggd2l-drill@us.timer`, `ggd2l-drill@eu.timer` | Weekly restore drills, Sundays 10:30 and 11:30 UTC |
| `ggd2l-heartbeat.timer` | The box's Discord alerts (and any healthchecks pings), every 5 minutes |
| `ggd2l-alert@<key>.service` | A Discord alert for one backup, drill or config-archive run, started by that unit's `OnFailure=` and `OnSuccess=` |
| `ggd2l-config-archive.timer` | The daily encrypted config archive, 04:47 UTC, as root |
| `ggd2l-bot.service` | The lobby bot, on 127.0.0.1:8090 ([DOTA-LOBBY-BOT](DOTA-LOBBY-BOT.md)) |

`box_agent status` reports the units (the config archive's included), each
league's live release and slots, disk, memory, swap, the last backup, the last
drill (the later of the drill unit's last run and `state/last-drill.json`,
which every passing drill writes, the agent's `drill <lg> <sha>` included), a
pending reboot, and two counts for the last 24 hours: real 5xx
(`serverErrors24h`) and the maintenance page's own 503s
(`maintenance503s24h`). Every unit refuses to start without a valid
environment (the env contract: `LEAGUE_DEPLOY_ENV`, the league's region, the
canonical origin `https://<lg>.ggd2l.com` in production and staging alike, the
app role's local URL, no Vercel or Neon keys).

**Slots.** A slot runs `next start` as `ggd2l-<lg>`, which can write only the
release's `.next/cache` and `.next/server/route-cache` (`RELEASE_WRITABLE_DIRS`;
the build creates both). Each slot process holds one Prisma pool of
`connection_limit=8`, so the four processes of a release overlap use 32 of
PostgreSQL's 47 usable connections; a release built before 2026-10-17 holds
two pools per process.

**The 09:00 UTC reboot.** Unattended upgrades install security updates, plus
PostgreSQL, cloudflared, Node and Caddy updates within their pinned majors, and
reboot at 09:00 UTC when an update needs it. Only live slots are enabled, so
exactly they come back; the scheduler Workers wait for 10 failed passes in a
row before alerting until 09:15 UTC, which covers the gap.
Before a release near 09:00 UTC, check `pending reboot` in `box_agent status`
and don't run one across it.

**Alerts.** Discord, in the admin channel ([DECISIONS](DECISIONS.md#hosting)):

| From | Posts when | Clears when |
| --- | --- | --- |
| Each scheduler Worker, outside the box | 3 passes in a row fail (10 until 09:15 UTC) | 2 pass in a row |
| `ggd2l-alert@<key>` (backups, drills, the config archive) | A run fails, naming the step | The next run passes |
| The heartbeat (`discord-alert.mjs heartbeat`) | Disk 85% full; MemAvailable under 150 MB or swap over 1.5 GB for 3 beats; a unit failed for 2; a league whose site answers has stale passes for 3; an enabled bot down for 4 | The check is good again (2 beats for memory, swap, passes and the bot) |

Settings, the hello and the test post are in `ops/selfhost/README.md`
(Alerts, Discord alerts). healthchecks.io's `box`, `automation`, `backup-us`,
`backup-eu`, `drill`, `bot` and `config` checks still get their pings if
`/etc/ggd2l/healthchecks.env` is ever written.

**Memory and disk.** Steady state measured about 0.7 GB used on 2026-10-17
after both leagues opened (both slots, Postgres, cloudflared and Caddy; the bot
is not on the box yet). Measure again once the bot moves. A release briefly
adds a candidate, which swap absorbs. A build runs with a 3 GB
Node heap (`NODE_OPTIONS=--max-old-space-size=3072`) under the unit limits in
`agent/build.mjs`: `MemoryHigh=1200M` holds it near 1.1 GiB and pushes the
rest, 0.7-0.8 GB, into swap; `MemoryMax=1800M` stays above the 1.54 GB the
2026-10-15 trial build peaked at outside those limits. Never cap a build's
memory below that, or the kernel kills it. Each build's real peak is the
release record's Peak RSS MB (`peakRssMb`): its unit's cgroup `memory.peak`,
read as the unit stops. systemd-run's own `Memory peak:` line in the build
log is only what systemd 255 last read while the unit ran, often as it
started (2.4M for the c5de9952 builds). A build needs 5
GB free; each release takes about 1.2 GB and `box_agent prune <lg>` keeps the
live, previous and newest. Check `df -h` monthly.

**Logs.** App output goes to journald (capped at 500 MB):
`journalctl -u ggd2l-us@<slot>` for the live slot, which `box_agent status`
names (`leagues.<lg>.live.slot`; each release flips it). Caddy writes a JSON access log per host under
`/var/log/caddy/` (rolled at 50 MiB, ten kept); it holds player IP addresses,
so treat it as personal data. Build logs are in `/var/log/ggd2l/builds/`
(the line npm ci and the build each print as they stop, `ggd2l cgroup: …`,
holds that unit's real memory and swap peak, limits and memory events, and
the agent's `==` line after systemd-run's summary gives the peaks in MB), and
the output of `attest`, `preflight`, `migrate` and `drill <lg> <sha>` in
`/var/log/ggd2l/tools/<verb>-<lg>-<stamp>-<sha12>.log` (0640 `root:ggd2l`),
with every environment value redacted.

**SSH.** Key-only login as `ggd2l`, the only account with a shell and sudo;
everything else runs as its own user with no login. The Mac's `~/.ssh/config`
alias `ggd2l-1` pins the host key. Review `authorized_keys` monthly.

**Backups and drills.** Each league is dumped hourly as the app role,
verified, gzipped, age-encrypted to Tim's offline key and copied to R2
(`ggd2l-backups`). Daily at 04:47 UTC, `ggd2l-config-archive.timer` runs
`config-archive.sh` as root: an age-encrypted archive of `/etc/ggd2l`,
`/etc/cloudflared` and `/etc/caddy` to R2 (`config/`), so a rebuild can
recover the secrets. After changing anything in those folders (an env file, a
secret, the tunnel, or an `install-kit.sh` run, which rewrites files in all
three), run `sudo systemctl start ggd2l-config-archive` right away rather
than waiting up to a day for the timer. The uploads pass rclone
`--s3-no-check-bucket` (the token may not create the bucket) and
`--s3-no-head` (the box's rclone 1.60.1 would HEAD each fresh upload with a
versionId R2 refuses; the kit README's Backups section has the detail and a
diagnosis command). The weekly drill restores the newest dump on the box. Quarterly,
about 15 minutes: Tim decrypts one daily offsite copy on the Mac, checks its
SHA-256 and runs the same restore rehearsal against the Mac's scratch Postgres.

**Cutover cleanup.** Once the 14 days are over (the old origins on 308 and
both Neon databases deleted), shred the plaintext Neon dumps left in
`/var/backups/ggd2l/cutover/<lg>/` (keep the folders: `box_agent import` reads
them), remove the admin user's `~/buildtest` and `~/.npm` (the 2026-10-15
trial build and its npm cache), and check that the cutover's scp staging
folder holds no leftover dump. The commands are in the kit README's Cutover helpers.

**Tim's monthly hour.** Scroll the admin channel for a 🔴 without its 🟢, and
read `box_agent status`; check `df -h`; watch for OpenDota rate limits (both leagues
share one IP now; the app treats a 429 as unreachable and does not log it, so
look for result imports that lag, not for journal lines); review
`authorized_keys`. Quarterly, the offsite
decrypt drill.

**Rebuild from zero (about an hour).** Create a new droplet, run
`ops/selfhost/provision-base.sh` and then `install-kit.sh <live sha>` from
root's own clone (for example `/root/ggd2l-kit`; the script refuses a clone any
other user could change). Tim decrypts the newest dumps on the Mac, and they are
copied with their `.sha256` into `/var/backups/ggd2l/cutover/<lg>/`. Restore
`/etc/ggd2l`, `/etc/cloudflared` and `/etc/caddy` from the newest config
archive (Tim decrypts it on the Mac and streams it in, as the kit README's
"Rebuild from zero" shows); if none exists, regenerate or supply again every
file in them, a new tunnel included (Tim's `cloudflared tunnel login`). Then
`box_agent import` each league (a fresh install leaves every site in
maintenance, which `import` requires; run `box_agent identity <lg>` only if
a dump predates the cutover's identity markers), build, start and promote
each league at the live commit, and start the tunnel.
