# Production operations and launch evidence

This is the executable operating contract for the first production release.
It does not make a deployment safe by itself: the release owner must attach
evidence from the actual hosting, database, DNS, identity, Discord, monitoring,
and backup providers. Never put a secret, connection URL, session cookie,
backup receipt, or bearer header in this record.

## Release stop rule

Do not start a production build until every pre-promotion item below has an
owner and evidence. `npm run build:vercel` applies additive migrations before
the Next.js compilation finishes, so an automatic production build is already
a database change even if Vercel never promotes the resulting application.

Use a manually approved production deployment (or an equivalent protected
deployment check) pinned to the reviewed commit. Disable unreviewed automatic
production builds for the launch window. Preview builds must use a separate
database branch and non-production credentials.

Exactly one one-minute scheduler may be authoritative. Use either the Vercel
Pro/Enterprise cron registered in `vercel.json` or one reviewed external
scheduler—not both. Vercel Hobby is not compatible with this release.

## Required owners

Record names or on-call handles for all three roles. Two people should be able
to access the hosting and database providers with MFA before traffic is opened.

- Release owner: controls the pinned deployment and final go/no-go.
- Database/recovery owner: owns backup, PITR, restore, and cutover decisions.
- Incident/communications owner: owns monitoring acknowledgement and player
  communication through a channel independent of the application and Discord
  bot being recovered.

## Launch evidence record

Copy this section into a private release record and fill it in. Links may point
to access-controlled provider pages; never paste credentials.

```text
Release date/time (UTC):
Reviewed commit SHA:
CI run URL and result:
Previous production deployment ID + commit:
Candidate deployment ID + commit:
Production deployment ID + commit:
Release owner / database owner / communications owner:
Go/no-go approvers:

Hosting plan and Node 22 evidence:
Manual promotion / deployment-check evidence:
Production-vs-preview database isolation evidence:
Authoritative scheduler (exactly one) and one-minute cadence evidence:

Credential-free production database identity:
Database provider protection / spend-limit evidence:
Accepted RPO / RTO:
Configured PITR window and pre-release restore point:
Fresh backup artifact name + SHA-256 (no receipt):
Backup verification result/time:
Disposable restore target + result/time:
Baseline fingerprint / migration preflight / postflight results:
Runtime and direct-connection read/write smoke results:

Canonical domain + HTTPS/certificate result:
Apex/www redirect result:
Steam domain/key/callback login result:
Discord OAuth exact callback result:
Discord bot guild/role hierarchy result:
League/inhouse webhook channel result:
OpenDota profile and real match-import result:
Privacy contact request test result:

live probe result:
ready probe result:
automation probe result:
Two consecutive production cron result timestamps:
Cron/readiness/automation/provider alert-delivery evidence:
Rollback deployment rehearsal result:
Traffic-freeze rehearsal result:
Final smoke-test result:
Residual risks explicitly accepted:
```

## Pre-promotion procedure

1. Select one immutable commit. Require the full CI gate to pass for that exact
   SHA and record the run. Record the previous known-good deployment and commit.
2. Confirm production promotion requires a human approval or protected
   deployment check. Pause the production scheduler during the release window.
3. Confirm Node 22, Vercel Pro/Enterprise (or the reviewed external scheduler),
   database spend/protection limits, and production/preview database isolation.
4. Validate production configuration with no test overrides. The pooled and
   direct PostgreSQL URLs must identify the same project, database, schema, and
   username for this release; only their host form, port, and password may
   differ. Confirm the runtime role can read and write on a disposable restored
   copy—postflight through the direct URL alone is not enough.
5. Create a fresh full production dump through `npm run db:backup`, verify it,
   and record its artifact name and SHA-256. Record a provider PITR point and
   configured restore window. Complete a disposable restore rehearsal. For an
   old `db push` database, use the guarded legacy-baseline rehearsal documented
   in the README before recording the baseline on the live database.
6. On a production-like candidate backed by a non-production database, verify
   `/api/health/live`, `/api/health/ready`, unauthorized cron = 401, POST
   `/api/sync` = 405, and read-only GET `/api/sync`. Exercise one bounded manual
   Admin maintenance run or a reviewed staging scheduler invocation. Do not
   enable Vercel Cron on a preview—it runs only for production deployments.
7. Complete real credential smoke tests: allowlisted Steam login/profile,
   Discord OAuth, guild membership/role behavior, each configured webhook,
   OpenDota profile lookup, and one known Dota match import. Confirm failure UI
   does not disclose credentials.
8. Verify the privacy/data-use page matches the selected host, database,
   backups, scheduler, logging, and contact process. Send and acknowledge one
   privacy request through the published private contact channel.
9. Configure independent monitors for liveness, readiness, automation freshness,
   cron non-2xx, and database/provider faults. Deliver and acknowledge a test
   alert through a channel that remains available if Discord or this site is
   down.

## Controlled promotion

1. Reconfirm the fresh backup, PITR point, approved commit, previous deployment,
   and paused scheduler. Do not merge or trigger an unrelated production build
   during this window.
2. Trigger exactly one manually approved production build for the pinned SHA.
   Watch the environment gate, migration safety/preflight, `migrate deploy`,
   postflight, client generation, and Next.js build. Stop on any non-zero step;
   never mark a migration applied merely to bypass an error.
3. Confirm the promoted deployment ID and commit. Verify liveness, readiness,
   canonical redirects, Steam login, a public season page, and one authorized
   non-destructive admin read.
4. Enable exactly one one-minute scheduler. Observe two consecutive HTTP 200
   `SUCCEEDED` runs, then require `/api/health/automation` to return HTTP 200.
   Confirm Admin → Automation shows Scheduled cron, a cleared lease, a fresh
   success, and zero consecutive failures.
5. Run the actor/phase smoke checklist for the live league state, verify Discord
   delivery, and confirm the configured monitoring alerts remain green. Only
   then open general traffic and close the release window.

## Traffic freeze and incident triage

The first action in a suspected data-integrity incident is to stop new writes,
not to deploy a speculative fix.

1. Pause the scheduler and confirm no new cron request starts.
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

1. Keep the scheduler paused and traffic frozen; wait for the lease drain.
2. Promote the recorded previous known-good deployment. Leave all migrations
   and expanded database objects in place.
3. Against protected operator access, verify login, the current schedule, one
   database-backed read, and the probes exposed by that release. A pre-release
   `/api/sync` may mutate on GET, so never use it as a generic rollback probe.
4. Deploy the repaired forward release. Re-enable exactly one scheduler,
   observe two successful passes, verify automation freshness, and then lift
   the traffic freeze.

## Data recovery / PITR

Use this when data is corrupt, missing, or of uncertain integrity.

1. Keep traffic frozen and the scheduler paused. Have the database owner record
   the recovery target and accepted data-loss window.
2. Create a provider PITR branch or restore the verified dump into a new,
   disposable database. Never overwrite the original during investigation.
3. Run migration baseline/preflight as appropriate, current postflight, and
   representative counts/invariants for users, seasons, registrations, teams,
   matches, games, draft state, inhouse/Cred ledgers, announcements, and admin
   actions. Start the pinned application against the clone.
4. Test both the direct migration connection and the pooled runtime connection.
   Confirm reads and a disposable transactional write/rollback through the
   runtime role. Exercise the actor/phase smoke checklist.
5. Obtain database-owner and release-owner approval for cutover. Point
   production secrets to the recovered target through a manually approved
   deployment, verify postflight and application health, then enable one
   scheduler and observe two clean passes.
6. Lift the traffic freeze only after monitoring and player-visible state are
   verified. Preserve the original database and incident artifacts according to
   the approved retention policy.

## Secret compromise

- `AUTH_SECRET`: rotate it, redeploy under the traffic freeze, and expect every
  existing session to be invalidated.
- `CRON_SECRET`: pause the scheduler, rotate both application and scheduler
  copies, verify unauthorized = 401 and one authorized scheduled pass, then
  resume. Never put it in a URL or monitor.
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
