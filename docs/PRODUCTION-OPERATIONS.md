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

Record names or on-call handles for all four functions. Two people should be
able to access the hosting and database providers with MFA before traffic is
opened. The privacy owner and deputy must each have independent MFA access to
the privacy mailbox and private case register; a shared password is not
continuity.

- Release owner: controls the pinned deployment and final go/no-go.
- Database/recovery owner: owns backup, PITR, restore, and cutover decisions.
- Incident/communications owner: owns monitoring acknowledgement and player
  communication through a channel independent of the application and Discord
  bot being recovered.
- Privacy request owner and deputy: own private intake, identity verification,
  request scoping, the case register, reviewed fulfillment, and restoration
  replay. The deputy must be able to continue the process without the primary.

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
Privacy request owner / deputy:
Go/no-go approvers:

Hosting plan and Node 22 evidence:
Manual promotion / deployment-check evidence:
Production-vs-preview database isolation evidence:
Authoritative scheduler (exactly one) and one-minute cadence evidence:
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
Published privacy mailbox and page verification:
Verified hosting/database/backup/log storage countries:
Primary/deputy mailbox MFA and continuity result:
Private case-register storage/access/encryption/retention evidence:
Privacy action/replay register location and access evidence:
Privacy contact test case ID + send/acknowledgement result (no request content):
Privacy request/retention/restore tabletop result:
External-provider and backup limitations verified against the public page:

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
   database spend/protection limits, production/preview database isolation,
   Deployment Protection on previews/generated deployment URLs, a function
   region close to the database, and reviewed runtime/direct connection-pool
   ceilings. Complete the edge/proxy/abuse gate below before opening traffic.
4. Validate production configuration with no test overrides. The pooled and
   direct PostgreSQL URLs must identify the same project, database, schema, and
   username for this release; only their host form, port, and password may
   differ. Confirm the runtime role can read and write on a disposable restored
   copy—postflight through the direct URL alone is not enough.
5. Create a fresh full production dump through `npm run db:backup`, verify it,
   and record its artifact name and SHA-256. Record a provider PITR point and
   configured restore window. Complete a disposable restore rehearsal. For an
   old `db push` database, use the guarded legacy-baseline rehearsal documented
   in the README before recording the baseline on the live database. On the
   production-like candidate, download the largest representative season audit
   archive and record its UTF-8 response size. If it reaches the application's
   4,000,000-byte ceiling and returns 413, approve and rehearse an out-of-band
   audit-export path before allowing that season to be deleted; the full backup
   is required recovery evidence but does not replace this multi-user audit
   artifact.
6. On a production-like candidate backed by a non-production database, verify
   `/api/health/live`, `/api/health/ready`, unauthorized cron = 401, POST
   `/api/sync` = 405, and read-only GET `/api/sync`. Exercise one bounded manual
   Admin maintenance run or a reviewed staging scheduler invocation. Do not
   enable Vercel Cron on a preview—it runs only for production deployments.
7. Complete real credential smoke tests: allowlisted Steam login/profile,
   Discord OAuth, guild membership/role behavior, each configured webhook,
   OpenDota profile lookup, and one known Dota match import. Confirm failure UI
   does not disclose credentials. With temporary/sacrificial provider
   credentials, exercise a rejected request and timeout, inspect host logs and
   outbound traces for Steam/OpenDota query credentials and Discord webhook
   path tokens, then rotate the temporary values. Platform tracing is outside
   application catch blocks; any captured credential is a release stop until
   tracing is redacted/disabled and the credential is rotated.
8. Verify the privacy/data-use page matches the selected host, database,
   backups, scheduler, logging, retention behavior, external-provider limits,
   and contact process. Confirm the privacy primary and deputy can independently
   reach the protected mailbox and case register, send and acknowledge one test
   request, and complete the tabletop below. Record the real provider retention
   windows and enforcement mechanisms; do not rely on an unsupported public
   promise.
9. Configure independent monitors for liveness, readiness, automation freshness,
   cron non-2xx, and database/provider faults. Deliver and acknowledge a test
   alert through a channel that remains available if Discord or this site is
   down.

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

## Privacy requests and retention

This is the manual operating contract for the first release. It is not a
self-service export or deletion feature, does not decide whether a particular
request must be granted, and does not create a universal response deadline. Do
not promise an outcome until the request is verified, scoped, and shown to be
safe with the current data model and provider controls. Escalate any request
outside this runbook rather than improvising against production data.

### Intake, verification, and case handling

1. Accept requests only through the private mailbox published on the
   privacy/data-use page. The mailbox must remain available if the application
   or Discord is unavailable. Never direct private request details to a public
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
   owner and privacy owner must review it, create or reconfirm a recovery point,
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
  Steam, OpenDota, or Discord, are controlled through those providers. The public
  page and case closure must distinguish a local unlink/correction from deletion
  at an external provider. Backups and PITR can retain an older value until their
  configured expiry even after the live database is corrected.
- Maintain a private restoration-replay register for every approved correction
  or de-identification. Store the opaque case ID, stable subject identifiers,
  affected sources, exact reviewed operation or immutable script reference,
  completion time, reviewers, and verification result—never passwords, request
  prose, or exported personal data. Protect it like the case register.
- Before promoting any restored snapshot, compare its recovery time with the
  replay register. Reapply and verify every later approved correction or
  de-identification on the disposable restore, then obtain privacy-owner and
  database-owner approval. A technically healthy restore that resurrects a
  previously corrected value is not safe to promote.
- A future retention cleanup must be a focused, reviewed release with backup,
  dry-run/rehearsal, bounded deletion, observability, and tests. Until then, keep
  the privacy page truthful about the absence of automatic expiry.

### Pre-launch privacy tabletop

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
   mailbox and encrypted case register, acknowledges the test case, and follows
   the same verification rules without a shared credential.

An unverified mailbox, inaccessible deputy path, missing storage/encryption or
retention evidence, unsafe subject extraction, failed rehearsal, or incomplete
restore replay is a release stop, not a residual risk to discover after traffic
opens.

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
5. Compare the restore point with the private restoration-replay register.
   Reapply every later approved privacy correction or de-identification on the
   clone, verify its subject-specific postflight, and obtain privacy-owner and
   database-owner approval that the recovered data will not resurrect it.
6. Obtain database-owner and release-owner approval for cutover. Point
   production secrets to the recovered target through a manually approved
   deployment, verify postflight and application health, then enable one
   scheduler and observe two clean passes.
7. Lift the traffic freeze only after monitoring and player-visible state are
   verified. Preserve the original database and incident artifacts according to
   the recorded provider and case-retention decisions; do not keep them under an
   undefined policy.

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
