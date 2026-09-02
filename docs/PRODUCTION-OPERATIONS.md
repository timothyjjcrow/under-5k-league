# Production operations and release evidence

This is the executable operating contract for production releases and recovery.
It does not make a deployment safe by itself: the release owner must attach
evidence from the actual hosting, database, DNS, identity, Discord, monitoring,
and backup providers. Never put a secret, connection URL, session cookie,
backup receipt, or bearer header in this record.

## Release stop rule

Do not promote until the release delta has been classified from the commit on
the current canonical production deployment to the candidate commit. The base
must be fetchable and an ancestor of the candidate. Missing metadata, unknown
paths, unexpected Git statuses, and changes to schema, migrations, release
plumbing, server actions, cron, or scheduler code fail closed to the strict
lane. Some allowlisted documentation and test paths are neutral companions;
sensitive-path tests and policy/runbook documents remain strict, and a
neutral-only delta never establishes the UI-only fast path by itself.

The migration gate inside `npm run build:vercel` cannot apply migrations. In
production, `scripts/production-schema-check.mjs` attests the exact migration
ledger, Prisma schema, and required PostgreSQL-native objects read-only before
compiling. The subsequent Next.js build still receives its runtime environment
and must remain side-effect-free.
In Preview and development, the release pipeline performs no production
database gate or migration mutation. A build or running preview that needs data
must use a separately scoped non-production database.

Schema-neutral UI and application releases require neither a fresh backup nor a
scheduler pause. A strict classification requires full CI and review, but does
not alone imply a database release or scheduler pause; the classifier's
`needs_db_release` and `needs_scheduler_pause` flags select those procedures.
Production migration writes occur only through
`npm run db:migrate:release -- --apply <reviewed 40-character HEAD SHA>` from a
clean ephemeral checkout at that exact commit. Both URL variables supplied to
that process must use one DDL-capable username: it must own every existing
application relation and function (or immediately inherit each owning role's
privileges) and have `CREATE` on the application schema. A least-privilege
runtime role may remain deployed only when both DDL URLs are injected into the
trusted release process temporarily and the normal runtime environment is
restored before the application build.

Use a manually approved production deployment (or an equivalent protected
deployment check) pinned to the reviewed commit. Preview runtime data, when
needed, must use a separate database branch and non-production credentials. A
Preview rehearsal is not promotable: promotion uses an exact staged production
candidate built with production configuration but without the canonical domain.

Exactly one one-minute scheduler may be authoritative. Vercel Hobby hosts the
application with no Vercel cron registration; the reviewed Cloudflare Worker in
`ops/cloudflare-automation-worker` owns the only `* * * * *` trigger. Do not add
a second Vercel, monitor, or external schedule.

## Required owners

Record names or on-call handles for all four functions. Two people should be
able to access the hosting and database providers with MFA before traffic is
opened. The data correction owner and deputy must each have independent MFA
access to the private support channel and case register; a shared password is not
continuity.

- Release owner: controls the pinned deployment and final go/no-go.
- Database/recovery owner: owns backup, PITR, restore, and cutover decisions.
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
Previous production deployment ID + commit:
Candidate deployment ID + commit:
Production deployment ID + commit:
Release owner / database owner / communications owner:
Data correction owner / deputy:
Go/no-go approvers:

Hosting plan and Node 22 evidence:
Manual promotion / deployment-check evidence:
Production-vs-preview database isolation evidence:
Authoritative scheduler (exactly one) and one-minute cadence evidence:
Cloudflare Worker deployment/version and sole Cron Trigger evidence:
Cloudflare Free-plan capacity/limits review:
Encrypted `AUTOMATION_SECRET` binding-name evidence (never its value):
Production function region / database region / pool-limit evidence:
Deployment Protection for previews and generated deployment URLs:

Canonical DNS resolves directly to Vercel OR approved Trusted Proxy evidence:
Vercel WAF ruleset version + rule IDs + production-domain scope:
WAF log-mode baseline / shared-NAT test / block-mode result:
Multi-instance abuse test and database/provider QPS plateau result:
`x-vercel-forwarded-for` trust-path evidence (no user-supplied fallback):
`/api/sync` and `/api/calendar` MISS→HIT edge-cache evidence:
Authenticated/personalized response never-HIT evidence:
Production `__Host-` session/OAuth creation and expiration Set-Cookie evidence:
First-release forced reauthentication communication/result:

Credential-free production database identity:
Database provider protection / spend-limit evidence:
Accepted RPO / RTO:
Configured PITR window and pre-release restore point:
Fresh backup artifact name + SHA-256 (no receipt):
Backup verification result/time:
Disposable restore target + result/time:
Baseline fingerprint / migration preflight / postflight results:
Migration username ownership/membership + schema-CREATE evidence (no credential):
Explicit migration-release command/result and bound HEAD SHA (`needs_db_release` only):
Failed-migration guarded resolve result, if applicable:
Release-only database environment removed/runtime environment restored before build:
Runtime and direct-connection read/write smoke results:
Application-log retention and protected-access evidence:
Backup/PITR expiry and deletion-process evidence:

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
Two consecutive production Cloudflare Cron result timestamps:
Cloudflare Cron/readiness/automation/provider alert-delivery evidence:
Rollback deployment rehearsal result:
Traffic-freeze rehearsal result:
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

1. Resolve the immutable full SHA behind the current canonical production
   deployment, fetch it, and confirm it is an ancestor of the candidate `HEAD`.
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

   Both variables must contain provider-verified full lowercase SHAs. Never
   classify a production release from the PR merge base. If the production
   commit has no classifier, extraction fails, or the trusted classifier fails,
   the fallback selects the strict lane and every impact procedure. Do not run
   the candidate classifier to bypass that result.

2. Require the CI gates selected by the classifier to pass for the exact
   candidate SHA. `ui-only` may narrowly skip PostgreSQL and mutation jobs;
   `app` runs standard application CI; `strict` runs every CI gate. Only
   allowlisted documentation/test paths are neutral companions; sensitive-path
   tests and runbook/policy changes remain strict, and a neutral-only delta does
   not earn a fast lane. GitHub's event-base classifier is only a CI
   optimization; it is not release authorization. If the canonical production
   delta is strict, confirm every strict job ran, even if event-based CI skipped
   one. Missing canonical deployment metadata blocks the fast path.
3. Record the previous known-good deployment. First exercise a Preview or
   staging deployment against a separately scoped non-production database. Run
   the liveness/readiness and endpoint contract checks, an appropriate public
   database-backed page, focused desktop/mobile browser verification for UI
   changes, affected API/auth/actor checks for application changes, and an
   error-log scan. This rehearsal may include a bounded Admin or staging
   scheduler invocation, but it is not the artifact that will be promoted.
4. If either `needs_db_release` or `needs_scheduler_pause` is set, complete the
   applicable procedure below. A strict lane with both flags clear needs full CI
   and review but no database backup/release or scheduler pause.
5. Build a staged **production** candidate for the exact reviewed SHA with
   production configuration but without assigning the canonical domain (for
   example, the protected `vercel --prod --skip-domain` workflow). Its migration
   gate must attest the actual production database's migration ledger, Prisma
   schema, and native objects read-only. The Next.js build that follows remains
   responsible for side-effect-free application build code. Any drift stops the
   release.
6. Against the generated production-candidate URL, repeat the read-only probes,
   one public database-backed page, focused UI checks, and an error-log scan. Do
   not run mutation or scheduler actions against live data. Promote that exact
   tested deployment rather than rebuilding it.
7. When `needs_scheduler_pause` is false, leave the sole Cloudflare trigger in
   place and observe at least two consecutive HTTP 200 `SUCCEEDED` passes plus
   `/api/health/automation` = 200 after promotion.

### Database- or scheduler-impact prerequisites

Complete only the branches selected by `needs_db_release` and
`needs_scheduler_pause`. A `strict` lane by itself does not select either branch.

1. Confirm production promotion still requires a human approval or protected
   deployment check and that full CI passed for the exact SHA.
2. When `needs_scheduler_pause` is true, run `npm run scheduler:pause`, verify
   zero Cloudflare Cron Triggers, wait the full 15-minute propagation bound,
   prove no Scheduled cron attempt lands across two further expected minute
   slots, then wait at least 90 seconds after the last possible attempt and
   prove no active lease remains.
3. When `needs_db_release` is true, validate production configuration with no
   test overrides. The pooled and direct PostgreSQL URLs must identify
   the same project, database, schema, and username; only their host form, port,
   and password may differ. For the release process, that shared username must
   own every existing application relation and function or immediately inherit
   each owning role's privileges, have `CREATE` on the application schema, and
   have any required `TRIGGER` privilege. Ordinary
   `SELECT`/`INSERT`/`UPDATE`/`DELETE` grants do not authorize `ALTER TABLE`.
   The read-only migration preflight inventories these ownership rights before
   its data checks; any reported object is a release stop.

   The application may use a different least-privilege runtime username. If it
   does, retrieve a pooled and direct URL for the DDL-capable role through the
   approved secret channel and inject **both** only into the migration process.
   Do not combine one runtime URL with one migration URL. Record the
   credential-free role/capability result, then restore or unset the temporary
   release variables before the staged production application build. Confirm
   the restored runtime role can read and write on a disposable copy;
   postflight through the DDL direct URL alone is not enough.

4. Still when `needs_db_release` is true, create a fresh full production dump
   through `npm run db:backup`, verify it, record its SHA-256 and a provider PITR
   point, and complete a disposable restore rehearsal. The dump uses
   `--no-owner --no-privileges`, so the local restore role owns the restored
   objects; that pass can mask a production ownership or grant failure. Also
   exercise the exact DDL release username read-only and then through the
   guarded release path on a provider PITR/restore branch that preserves object
   ownership. For an old `db push` database, complete the guarded legacy
   baseline procedure in the README first.
5. When `needs_db_release` is true, use a clean ephemeral checkout at the
   reviewed commit, verify its full 40-character `HEAD` SHA, supply production
   credentials through the trusted environment, and run exactly:

   ```text
   npm run db:migrate:release -- --apply <reviewed 40-character HEAD SHA>
   ```

   This is the only production migration writer. It enforces technical
   environment, immutable-checkout, reviewed-SHA, migration-safety, preflight,
   deploy, and postflight gates, and refuses root or `prisma/` `.env` files that
   Prisma could auto-load after validation. It does **not** prove human
   approval, CI,
   provider backup/restore, scheduler propagation, or lease-drain evidence; the
   release owner must verify and record those prerequisites before invoking it.
   Stop on any non-zero result; never invoke
   `prisma migrate deploy`, mark a migration applied, or use an
   abbreviated/different SHA to bypass the wrapper. Remove the temporary DDL
   URLs and restore the normal runtime environment before building the staged
   production candidate.

6. When `needs_scheduler_pause` is true, validate the active and paused Worker
   artifacts and confirm the reviewed `AUTOMATION_URL` and encrypted binding
   name. Keep the scheduler paused through candidate verification and promotion,
   then deploy the reviewed active configuration, allow for propagation, and
   require the two-pass health gate before closing the window.

Build the staged production candidate after postflight succeeds when a database
release ran; otherwise build it after the required strict CI and review. A
scheduler-only change does not invent a database postflight prerequisite.

### Fully rolled-back failed migration

A failed `db:migrate:release` is a release stop, not permission to rerun Prisma.
Preserve the first PostgreSQL/Prisma error, the reviewed SHA and migration name,
the provider timestamp, and credential-free ledger/catalog evidence. Use a new
provider PITR branch from immediately before the attempt to reproduce the
failure with the exact DDL release username. Do not diagnose privileges from a
local dump alone: `--no-owner --no-privileges` makes the local restore role own
the restored objects and can hide the production ownership failure.

An error such as `must be owner of table InhouseQueueEntry` on the first
`ALTER TABLE`, even when ordinary DML works, means the supplied release role
does not own or immediately inherit the table owner's privileges. Correct and
prove the DDL credential or role membership on the provider branch before any
ledger recovery. Do not transfer objects or add broad grants ad hoc during the
failed release.

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

From the same clean reviewed checkout, run exactly:

```text
npm run db:migrate:failed-resolve -- --apply <reviewed 40-character HEAD SHA> <migration-name>
```

The migration argument is not free-form. It must be the exact reviewed target
printed by the command's usage message; every other name is refused.

The command only changes that proven failed row to rolled back and re-attests
the unchanged catalog and ledger shape. It does not mark the migration applied
and does not execute its SQL. After it succeeds:

1. Create and verify a **new** production backup and record a new provider PITR
   point.
2. Repeat the disposable restore rehearsal and the exact-role test on a
   provider branch that preserves ownership.
3. Run the complete guarded
   `npm run db:migrate:release -- --apply <reviewed 40-character HEAD SHA>`
   workflow with both temporary URLs on the DDL-capable username.
4. Require postflight, remove the temporary DDL environment, restore the
   least-privilege runtime environment, and only then build the production
   candidate.

Never use `migrate resolve --applied`, run `prisma migrate resolve` directly,
edit `_prisma_migrations` with manual SQL, mark an unapplied migration finished,
or blindly retry `migrate deploy`. Those shortcuts can make the ledger claim a
schema state the catalog never reached.

### Initial launch and affected-subsystem evidence

Re-run the broader platform checks when first launching or when their subsystem
changes: Node 22 and hosting plan; production/preview database isolation;
Deployment Protection; function/database regions and pool limits; Cloudflare
capacity; WAF/proxy/cache behavior; Steam, Discord, webhook, and OpenDota
credentials; largest season-audit export; support/case-register continuity;
retention and restore-replay controls; and independent alert delivery. A
schema-neutral footer edit does not require repeating unrelated provider or
data-handling rehearsals. The detailed gates below remain authoritative for the
subsystem they cover.

## Cloudflare scheduler runbook

`vercel.json` must have no `crons` entry. The only production clock is
`ggd2l-automation-scheduler`, defined by
`ops/cloudflare-automation-worker/wrangler.jsonc`: `workers.dev` is disabled,
the reviewed non-secret `AUTOMATION_URL` is pinned to the exact Vercel production
route, and one `* * * * *` Cron Trigger invokes its `scheduled()` handler. The
sibling `wrangler.paused.jsonc` has the same reviewed settings and an empty
`crons` array; it is the only supported pause configuration.
`AUTOMATION_SECRET` is its only encrypted secret binding and must be
byte-for-byte identical to Vercel's `CRON_SECRET`. Never expose that value in a
command argument, URL, source, `.dev.vars`, launch record, log, screenshot,
issue, or chat.

Cloudflare Workers Free currently permits 100,000 requests/day, five Cron
Triggers/account, 50 external subrequests/invocation, 10 ms CPU per Cron
Trigger, and 15 minutes wall time. This Worker uses about 1,440 invocations/day,
one trigger, one outbound request per invocation, a 65-second timeout, and a
bounded 2 KiB response parse. Before initial launch and before a scheduler or
account-capacity change, verify that other account work has not consumed those
shared limits and re-check the current
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/).
An exceeded quota or CPU limit is a failed scheduler event, not an accepted
residual risk.

### Provision and roll out

Deploy only after the pinned Vercel production release exposes a healthy
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
must not run until the production route is healthy and Vercel's `CRON_SECRET`
matches the encrypted binding.

Confirm the deployed `AUTOMATION_URL` matches the reviewed config, Cloudflare
shows exactly one `* * * * *` trigger, and Vercel shows none. Adding, changing,
or deleting a Cloudflare
[Cron Trigger](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
can take up to 15 minutes to propagate.
After propagation, require two consecutive one-minute HTTP 200 `SUCCEEDED`
passes, `/api/health/automation` = 200, a cleared lease, and zero consecutive
failures before opening traffic.

### Pause and resume

To pause, deploy the reviewed empty-trigger configuration and record the
successful deployment:

```bash
npm run scheduler:pause
npx wrangler@4.118.0 deployments status --cwd ops/cloudflare-automation-worker
```

Verify the Cloudflare dashboard shows zero Cron Triggers. Wait the full
15-minute propagation bound, then confirm Admin → Automation shows no new
Scheduled cron attempt across two further expected minute slots. Wait another
90 seconds after the last possible attempt and prove no active lease remains.
A trigger removal is not immediate, disabling a monitor does not pause the
Worker, and dashboard-only deletion creates drift from Wrangler's source of
truth.

To resume the reviewed current release, run:

```bash
npm run scheduler:deploy
npx wrangler@4.118.0 deployments status --cwd ops/cloudflare-automation-worker
```

The committed config reattaches exactly one trigger. Allow for propagation and
repeat the two-pass health gate. Stop if Vercel has acquired any cron or a second
Cloudflare/external schedule exists.

### Rotate or roll back

For `CRON_SECRET` rotation, pause first and drain the lease. Generate one new
value in the approved password manager, update Vercel's production
`CRON_SECRET`, promote the reviewed Vercel deployment, then replace the
Worker's encrypted binding through the hidden prompt:

```bash
npx wrangler@4.118.0 secret put AUTOMATION_SECRET --cwd ops/cloudflare-automation-worker
npx wrangler@4.118.0 secret list --cwd ops/cloudflare-automation-worker
```

Resume and require two clean passes before retiring the old password-manager
entry. Never overlap old/new schedulers to bridge the credential change.
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

## Edge, proxy, cache, and abuse-control gate

The application limiter is intentionally per warm process. It is defense in
depth, not a fleet-wide boundary. Before public DNS opens, configure
[Vercel WAF rate limits](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting)
on the production project and capture the versioned ruleset plus rule IDs. Use
these conservative starting points, scoped by method and path, then tune from a
closed candidate's measured shared-NAT traffic:

- `POST /api/inhouse` and `POST /api/draft/tick`: 1,200 requests/minute/IP.
  One venue can contain all players, spectators, and multiple tabs; a lower
  untested limit can break a live draft or inhouse night.
- `POST /api/draft/bid`, `/api/draft/nominate`, and
  `/api/draft/admin-nominate`: 120 requests/minute/IP.
- `GET /api/sync`: 300 requests/minute/IP; `GET /api/calendar`: 60/minute/IP.
- Steam/Discord OAuth kickoff: 60/minute/IP; each callback: 20/minute/IP;
  logout: 60/minute/IP. Do not attach a browser challenge to callbacks.
- `GET /api/admin/season-export`: five requests per ten minutes/IP. App auth
  remains authoritative; a WAF rule is not an administrator permission.
- Keep health probes and the bearer-authenticated cron path free of browser
  challenges. Allow the reviewed scheduler path, while retaining the
  application's constant-time bearer check and independent non-2xx monitor.

Run the rules in Log mode during a closed shared-NAT rehearsal, inspect allowed
and would-block events, then switch the reviewed version to Block before public
traffic. Test normal room cadence, duplicate tabs, invalid bodies, callbacks,
and a controlled flood across multiple function instances. Evidence must show
that origin database/provider QPS plateaus and legitimate venue traffic remains
usable. Any exception or bypass must have an owner, expiry, and monitor.

The canonical domain must resolve directly to Vercel. If another CDN or proxy
sits in front, stop unless the reviewed plan supports and enables Vercel Trusted
Proxy and the end-to-end client-address behavior is tested. At direct Vercel
ingress, the platform overwrites forwarding headers; the application prefers
`x-vercel-forwarded-for` and deliberately refuses to fall through when that
provider-owned value is malformed. Record DNS, proxy, and WAF event evidence;
do not infer client identity from a header sent straight to local development.

Verify the two viewer-independent microcaches on the deployed candidate:
repeat `/api/sync` and one representative `/api/calendar` URL until
`x-vercel-cache` demonstrates MISS→HIT within their five-/thirty-second edge
windows. Confirm the browser-facing `Cache-Control` still requires
revalidation. In a separate signed-in test, prove session-tailored pages and
room responses never return `x-vercel-cache: HIT`. A personalized HIT is a
release stop.

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
   data; game and inhouse JSON; the Cred balance and relationless ledger; news,
   admin actions and announcement outboxes; hosted application logs; database
   replicas, backups and PITR; delivered Discord messages and roles; and source
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
  participation, game/inhouse history, admin actions, Cred ledger entries, or
  delivered announcement rows. Season withdrawal preserves its registration.
  Do not publish or repeat a fixed deletion period for any of these categories
  unless a tested application job or provider lifecycle actually enforces it.
- Before launch, inventory each stored category, its purpose and visibility,
  storage/provider, current retention behavior, deletion or de-identification
  mechanism, and owner. Separately record the real database backup/PITR,
  application-log, mailbox, and case-register retention settings. Verify and
  record the providers' encryption and protected-access controls; do not infer
  them from marketing language or leave them as an undocumented assumption.
- Discord messages and roles already delivered, and source records held by
  Steam, OpenDota, or Discord, are controlled through those providers. The case
  closure must distinguish a local unlink/correction from deletion at an external
  provider. Backups and PITR can retain an older value until their
  configured expiry even after the live database is corrected.
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

1. Reconfirm the classifier result, approved full candidate SHA, exact green CI
   run, previous deployment, and tested candidate deployment. Do not rebuild
   during promotion.
2. Reconfirm fresh backup, PITR, restore, and the successful reviewed-SHA
   `db:migrate:release` result only when `needs_db_release` was true; reconfirm
   the paused/drained scheduler only when `needs_scheduler_pause` was true. A
   strict lane with neither impact flag deliberately has none of those subsystem
   prerequisites.
3. Confirm the candidate production build passed client generation, then its
   read-only migration, schema, and native-object attestation, and finally the
   Next.js build. Promote that deployment and confirm its ID and commit.
4. Verify liveness, readiness, canonical redirects, a public season page, and
   the smoke checks selected for the changed surface. Scan fresh runtime errors.
5. If the Worker/scheduler was unchanged, leave its sole trigger attached and
   observe two consecutive HTTP 200 `SUCCEEDED` runs after promotion. If it was
   paused or changed because `needs_scheduler_pause` was true, deploy the
   reviewed active Worker, confirm Vercel still has no cron, allow for
   propagation, and require the same two-pass gate. In both cases require
   `/api/health/automation` = 200, a cleared lease, a fresh success, and zero
   consecutive failures before closing the release window.

## Traffic freeze and incident triage

The first action in a suspected data-integrity incident is to stop new writes,
not to deploy a speculative fix.

1. Run `npm run scheduler:pause`, verify zero Cloudflare Cron Triggers, wait the
   full 15-minute propagation bound, and confirm no new Scheduled cron request
   starts across two further expected minute slots.
2. Enable the rehearsed hosting-provider maintenance/firewall rule that blocks
   all public traffic to the deployment, including OAuth callbacks and the cron
   route. A method-only rule is insufficient because several authentication
   callbacks legitimately write on GET. Keep only dependency-free operational
   access that was explicitly tested. Record when the freeze became effective.
3. Wait at least 90 seconds for the automation lease to drain. Do not delete or
   overwrite a live lease row.
4. Preserve logs and record the first known bad time, last known good time,
   affected users/workflows, current deployment, and database restore points.
5. Decide whether this is a code/config incident or data corruption. Do not run
   down migrations, `db push`, ad-hoc repair SQL, or a restore over the live
   database.

The traffic-freeze rule must be configured and rehearsed before launch. Its
provider rule ID and test evidence belong in the private launch record, not in
the repository.

## Code/config rollback

Use this only when the data is trustworthy and the previous application is
compatible with the additive schema already applied.

A schema-neutral rollback between releases that preserve the authenticated cron
contract may promote the recorded known-good deployment without pausing the
scheduler; verify the normal probes and observe two scheduled successes. If the
rollback crosses a schema or scheduler boundary, predates that contract, or has
uncertain compatibility, use the strict sequence below.

1. Keep the scheduler paused and traffic frozen; wait for the lease drain.
2. Promote the recorded previous known-good deployment. Leave all migrations
   and expanded database objects in place.
3. Against protected operator access, verify login, the current schedule, one
   database-backed read, and the probes exposed by that release. A pre-release
   `/api/sync` may mutate on GET, so never use it as a generic rollback probe.
4. Deploy the repaired forward release and reviewed Worker configuration.
   Confirm Vercel still has no cron and Cloudflare has exactly one trigger,
   observe two successful passes, verify automation freshness, and then lift
   the traffic freeze.

## Data recovery / PITR

Use this when data is corrupt, missing, or of uncertain integrity.

1. Keep traffic frozen and the scheduler paused. Have the database owner record
   the recovery target and accepted data-loss window.
2. Create a provider PITR branch or restore the verified dump into a new,
   disposable database. Never overwrite the original during investigation.
3. Run migration baseline as appropriate, migration preflight, isolated
   migration deploy, current postflight, and representative counts/invariants
   for users, seasons, registrations, teams, matches, games, draft state,
   inhouse/Cred ledgers, announcements, and admin actions. Start the pinned
   application against the clone.
4. Test both the direct migration connection and the pooled runtime connection.
   Confirm reads and a disposable transactional write/rollback through the
   runtime role. Exercise the actor/phase smoke checklist.
5. Compare the restore point with the private restoration-replay register.
   Reapply every later approved data correction or de-identification on the
   clone, verify its subject-specific postflight, and obtain data-correction-owner and
   database-owner approval that the recovered data will not resurrect it.
6. Obtain database-owner and release-owner approval for cutover. Point
   production secrets to the recovered target through a manually approved
   deployment, verify postflight and application health, then deploy the sole
   Cloudflare trigger and observe two clean passes.
7. Lift the traffic freeze only after monitoring and player-visible state are
   verified. Preserve the original database and incident artifacts according to
   the recorded provider and case-retention decisions; do not keep them under an
   undefined policy.

## Secret compromise

- `AUTH_SECRET`: rotate it, redeploy under the traffic freeze, and expect every
  existing session to be invalidated.
- `CRON_SECRET`: run `npm run scheduler:pause`, wait the full propagation bound
  and lease drain, rotate Vercel's production value and the Worker's encrypted
  `AUTOMATION_SECRET` to the same new value, verify unauthorized = 401, then
  resume and require two authorized scheduled passes. Never put it in a URL,
  command argument, monitor, log, or launch record.
- Database credentials: rotate the shared username's pooled/direct passwords,
  update production only, then rerun readiness plus direct/runtime tests.
- Discord bot token or webhook: revoke/rotate at Discord first, replace the
  production secret or admin setting, test the intended channel and role, and
  inspect for orphaned board messages.
- Steam/OpenDota credentials: rotate at the provider, update production, and
  rerun the corresponding real profile/import smoke test.

For every compromise, review provider access logs, revoke leaked copies, check
backups and CI artifacts, communicate impact through the incident owner, and
record only timestamps/credential identifiers—not values.
