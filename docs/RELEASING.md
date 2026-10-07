# Releasing GGD2L

The US and Europe sites run the same commit from `main`, and every release
ships that commit to both through `npm run release:both`. This first section is
the whole routine release: plan, check the Previews, stage both production
candidates, check them, then promote. The appendices cover database and
scheduler changes, incidents, and the reference material, and link to the
guarded procedures that govern them.

## Routine release

### Before you start

- The commit is on `main` and its CI run passed. The release finds that exact
  run and checks the jobs your change needs, including both browser suites.
- You have a checkout of that commit with no uncommitted changes to tracked
  files.
- You are signed in to the GitHub CLI (`gh`) and to the Vercel CLI with the
  operator login that can publish both projects.

After `main` CI passes, the **Prepare both leagues** workflow rehearses both
Preview deployments on its own. It never publishes production; its
`shared-league-release` artifact lists the Preview addresses.

### 1. Plan

```sh
npm run release:both -- --check
```

This reads the commit each live site runs, classifies the change for each
league with the classifier from that league's live commit, and finds the
passing CI run. It changes nothing on either site. A good plan prints:

```text
{
  "status": "planned",
  "sha": "<the commit you are releasing>",
  "candidates": {}
}
```

The full plan is saved to `output/shared-release.json`. Look at
`classifications.us` and `classifications.eu` in it:

- `needs_db_release` and `needs_scheduler_pause` both `false` for both
  leagues: this is a routine release. Carry on.
- Either one `true` for either league: stop. This is a maintenance release;
  follow [Appendix B](#appendix-b-database-and-scheduler-changes) first.
  Each classification's `reasons` names the files behind it. A file the live
  classifier does not know reads `unknown path` and sets both flags even when
  nothing touches the database or scheduler; the README's
  [classifier notes](../README.md#hosting-and-release-setup) say how a path
  becomes known.

`"status": "already-current"` means both sites already run this commit and
passed their health checks, so there is nothing to release.

### 2. Check the change on the Previews

The release checks health and that pages load, not what they look like or
whether a flow still works. That part is yours: the focused checks in
[Every release](PRODUCTION-OPERATIONS.md#every-release) step 3. On the
Previews, check the changed pages on desktop and mobile for a UI change, and
the affected API, sign-in and player, captain or admin flows for an
application change, then scan the error logs. Use the Previews the Prepare
both leagues workflow built, or build them yourself with
`npm run release:both -- --preview-only`, which ends with
`"status": "previews-verified"` and lists their addresses in the report.

### 3. Stage both production candidates

```sh
npm run release:both -- --stage-only --output output/staged-release.json
```

In order, this rehearses both Preview deployments, builds a staged production
candidate for each league from the same commit without touching either live
domain, and checks each candidate: the read-only database attestation in its
build, its release, live, ready and automation health, and that its home and
schedule pages load. The automation probe gets six tries 30 seconds apart:
after the worker sleeps (up to an hour), it answers 503 from the wake until the
next scheduled pass finishes, up to a minute plus the pass. A fault that lasts
still stops the run. Neither live site changes. A good run
prints these lines and ends with `"status": "staged"`:

```text
Rehearsing both isolated Preview deployments.
Building both staged production candidates.
{
  "status": "staged",
  "sha": "<the commit you are releasing>",
  "candidates": {
    "us": { "id": "<deployment id>", "url": "<generated address>", "sha": "<the commit>" },
    "eu": { "id": "<deployment id>", "url": "<generated address>", "sha": "<the commit>" }
  }
}
```

Save the staged report to its own file, as above, not to the default
`output/shared-release.json`. The promote run in step 5 writes its own report
to that default path before it reads the staged one, so a staged report kept
there is overwritten and the promotion refuses.

### 4. Check the candidates

The staging run already repeated the health probes and loaded database-backed
pages on each candidate. The rest of
[Every release](PRODUCTION-OPERATIONS.md#every-release) step 6 is yours, before
either goes live: on each candidate's address from the staged report, scan its
runtime error logs for every release, and for a UI change also check the
changed pages on desktop and mobile. The candidates use the live databases:
look, but don't save anything or run scheduler actions.

### 5. Promote

```sh
npm run release:both -- --promote-from output/staged-release.json
```

This promotes exactly the staged candidates, one league after the other and
without rebuilding, and refuses if either live site changed since staging. It
confirms each site reports the commit and its own league at
`/api/health/release`, reading it until three answers in a row show the new
commit (up to a minute: Vercel's edge serves the previous deployment for a few
seconds after the alias moves, and one stale read rolled back three good
promotions on 2026-10-06), then scans fresh runtime logs and waits for two
successful scheduled automation passes on each site. A good run prints these
lines and ends with `"status": "verified"` and the same candidates:

```text
Observing two scheduled automation passes for us.
Observing two scheduled automation passes for eu.
{
  "status": "verified",
  "sha": "<the commit you are releasing>",
  "candidates": { "us": { ... }, "eu": { ... } }
}
```

`output/shared-release.json` then records the previous and new deployment of
each league, the classifications, the CI run and every promotion. It holds
deployment ids, commits and outcomes, never credentials. Attach it and the
staged report to the private
[release evidence record](PRODUCTION-OPERATIONS.md#release-evidence-record)
that every release fills in.

`npm run release:both -- --apply` runs steps 3 and 5 in one go, with no stop
for step 4: it scans runtime logs only after promotion, and rolls back if it
finds errors. On its own it therefore skips the pre-promotion check that
Every release step 6 asks for, so release in the steps above.

### If it fails

Any failure prints one line saying what failed and exits with an error. The
report's `status` becomes `failed` and its `error` repeats the reason.

- **Before promotion** (plan, CI, a Preview or candidate build, a health or
  page check): neither live site has changed. A build or check failure reads
  "A regional build or smoke check failed. Neither production domain was
  changed." and the report's `buildFailures` names the league. Fix the cause
  and run the release again.
- **"Production changed since the staged review"** or **"production changed
  during staging; re-plan the release"**: someone deployed a site after you
  staged. Run `--check` again, then stage again.
- **"Promotion requires a staged paired release at this exact commit"**: the
  file given to `--promote-from` is not a staged report for the commit you
  have checked out. The staging run failed, the file was overwritten (see
  step 3), or you are on another commit. Stage again to its own file.
- **During or after promotion** (a candidate that will not verify, fresh
  runtime errors, or two scheduled passes not seen): the release puts every
  site it promoted back on that site's previous deployment and says what it
  did, for example "Paired promotion failed. us: previous deployment
  restored". It never overwrites a newer deployment someone else made. If a
  league reads "operator review required" or "rollback needs operator review",
  that site needs you: see
  [Appendix C](#appendix-c-incidents-and-manual-recovery).

### Rolling back a release that finished

The promote run's report, `output/shared-release.json`, records each
league's previous deployment as `bases.us` and `bases.eu`. To undo a finished release, promote that previous deployment for
each affected league in Vercel and follow the
[Application rollback order](../README.md#application-rollback-order). Never
undo a migration: the database stays as it is and the older build keeps
working with it.

- A schema-neutral rollback between releases with the same authenticated
  automation contract needs no backup or scheduler pause: promote, check the
  probes and one database-backed page, and watch the next two scheduled
  passes.
- A rollback that crosses a schema or scheduler boundary, predates the
  authenticated cron route, or has uncertain compatibility uses the strict
  sequence there, which pauses the scheduler first. Its scheduler commands
  are the US ones; for Europe use `npm run scheduler:europe:pause` and
  `npm run scheduler:europe:deploy`.

## Appendix A: One application, two leagues

US and Europe use the same `main` branch, application components, rules,
standings engine, database schema and migrations. Do not keep regional feature
branches or cherry-pick routine changes between leagues. Make the change once.

`src/lib/league-config.ts` owns public regional configuration. Each Vercel
project retains its own database, Discord credentials and guild, authentication
secret, origin, timezone, match schedule and game-server region. The existing
Steam lobby service supports both regions through the shared regional protocol.
Never copy player data, fixture results, runtime settings or secrets between
leagues. An administrator editing a season edits only that league's data.

### How the paired release works

CI runs the complete browser suites for both `us` and `eu`, including signup,
regular season, playoffs and BO1/BO3 tiebreakers. The shared preparation workflow
builds both isolated Previews after successful `main` push CI. It requires dedicated `VERCEL_US_TOKEN`
and `VERCEL_EU_TOKEN` GitHub Actions secrets scoped to the corresponding Vercel
projects. Configure these through the providers; do not commit token values.
Project-scoped credentials use explicit project IDs and project API operations
for protected health checks. The preparation workflow verifies this read-only
access first and never publishes production. Vercel currently rejects runtime
request-log access with project-scoped tokens. Production publishing therefore
uses one operator action through the existing Vercel login, which can complete
the required runtime checks. Do not broaden credential access to work around
this limitation without explicit authorization. Existing automation protection
credentials remain inside the process and never enter release evidence.
Vercel's independent Git deployment is disabled in `vercel.json` so it cannot
publish one league before the paired checks finish.

The release verifies exact-commit CI and both canonical deployment identities,
classifies each delta using that region's trusted production classifier, then
rehearses both isolated Previews. It builds two staged production candidates
from the same commit, using each project's existing production environment.
Remote builds keep sensitive environment values inside Vercel. Both production
builds must pass their read-only migration/schema/native-object attestation and
health checks before either canonical domain changes.

Promotion uses the tested candidates, without rebuilding. Each site must report
the reviewed commit and correct region at `/api/health/release`. Vercel does not
offer a cross-project atomic promotion, so the two aliases change sequentially.
If either promotion or verification fails, the release restores any candidate
it promoted to its recorded previous deployment. It never overwrites a newer
external deployment. Recovery failures require operator review and fail CI.

For routine releases the workflow also checks fresh runtime logs and waits for
two consecutive successful scheduled automation requests on each deployment.
Failure of that gate triggers the same paired recovery. A release that paused
a scheduler reports `promoted-awaiting-scheduler-resume` until the operator
resumes and verifies each paused scheduler under the operations procedure.

Evidence contains deployment IDs, commits and outcomes, never credentials.
Observe the scheduler and runtime-log gates in
[Production operations](PRODUCTION-OPERATIONS.md) before closing a release.

## Appendix B: Database and scheduler changes

One committed Prisma schema and migration history applies to both independent
databases. The release checks both against that same history; schema drift in
either blocks the paired promotion. Builds never run production migrations.

Changes classified as affecting the database or scheduler stop the paired
release before production staging. Complete the existing backup, restore, guarded
migration and/or scheduler procedure for every affected region. Run the same
reviewed migration release against each database with its own temporary DDL
credentials. Record evidence for both; never mark a failed region complete.
Use the guarded operator release with `--maintenance-file <private-json>`.
GitHub Actions cannot accept a maintenance override.

### The order, for each affected league

The linked sections are authoritative; follow each one exactly. A change that
needs a database release always needs the scheduler pause as well.

1. **Pause the scheduler** when `needs_scheduler_pause` is set: US
   `npm run scheduler:pause`, Europe `npm run scheduler:europe:pause`. Then
   complete the propagation, quiet-slot and lease-drain checks in
   [Pause and resume](PRODUCTION-OPERATIONS.md#pause-and-resume). Keep it
   paused until the release is promoted.
2. **Back up, rehearse and migrate** when `needs_db_release` is set: follow
   [Database- or scheduler-impact prerequisites](PRODUCTION-OPERATIONS.md#database--or-scheduler-impact-prerequisites)
   (configuration and DDL role, fresh backup and PITR point, disposable restore
   rehearsal, provider-branch ownership check) and the README's
   [Backups](../README.md#backups). Then, from a clean ephemeral checkout at
   the reviewed commit, run exactly
   `npm run db:migrate:release -- --apply <reviewed 40-character HEAD SHA>`,
   then remove the temporary DDL URLs and restore the normal runtime
   environment before any candidate is built. If it fails, stop and follow
   [Fully rolled-back failed migration](PRODUCTION-OPERATIONS.md#fully-rolled-back-failed-migration).
   When production values cannot be exported, use the hosted migration job
   described below.
3. **Record the evidence** in a private file outside the repository (shape
   below), then release with it. Pass `--maintenance-file <private-json>` to
   every command that builds or promotes production: both the `--stage-only`
   and the `--promote-from` run (and `--apply`, which does both).
4. **Resume the scheduler.** The release ends with
   `"status": "promoted-awaiting-scheduler-resume"`. Resume each paused
   scheduler (US `npm run scheduler:deploy`, Europe
   `npm run scheduler:europe:deploy`) and complete the two-pass health gate in
   [Controlled promotion](PRODUCTION-OPERATIONS.md#controlled-promotion)
   step 5.

### Maintenance evidence

The evidence shape is `headSha` and `regions.us`/`regions.eu`. Each affected
region records `baseSha`, `reviewedBy`, and `observedAt` (within six hours).
Database impact requires `backupVerified`, `restoreRehearsed`, and
`migrationReleasePassed`. Scheduler impact requires `zeroTriggers`,
`zeroTriggersAt`, `quietSlotsVerified`, and `noActiveLease`, with the full
propagation and drain interval elapsed. These are attestations to actual
provider evidence required by the operations runbook, not permission to skip
its steps. Keep schedulers paused until their reviewed release is promoted;
then resume and observe two successful scheduled runs.

`headSha` is the commit you are releasing and each `baseSha` is that league's
live commit, as `bases.<region>.sha` in the `--check` plan. The release refuses
the file until 18.5 minutes have passed since `zeroTriggersAt`. For one
affected league the file looks like this, with every value a real, reviewed
observation:

```json
{
  "headSha": "<the commit you are releasing>",
  "regions": {
    "us": {
      "baseSha": "<that league's live commit>",
      "reviewedBy": "<reviewer>",
      "observedAt": "<ISO 8601 time>",
      "backupVerified": true,
      "restoreRehearsed": true,
      "migrationReleasePassed": true,
      "zeroTriggers": true,
      "zeroTriggersAt": "<ISO 8601 time>",
      "quietSlotsVerified": true,
      "noActiveLease": true
    }
  }
}
```

Each paused Worker also sets `AUTOMATION_PAUSED=true`, so late Cloudflare ticks
cannot dispatch application requests. Verify the deployed flag, active version,
empty trigger list, and actual absence of canonical automation requests under
the operations runbook. The guard does not replace the full propagation, quiet
window, or lease-drain checks. Resume both with the flag set to `false`.

### Hosted migration job

When production environment values are non-exportable, an operator can run
`node scripts/hosted-migration-release.mjs` as a separate, unaliased Vercel build
job with production configuration. Supply `HOSTED_MIGRATION_RELEASE_SHA` and
temporary `HOSTED_MIGRATION_DATABASE_URL`/`HOSTED_MIGRATION_DIRECT_URL` as
build-only inputs. The job clones the reviewed immutable commit and invokes
the existing guarded migration release there. First rehearse on a provider
restore branch preserving ownership, then use the same job for production
after all selected prerequisites pass. The static `migration-only` receipt is
never promotable as an application; remove these temporary job deployments
after recording the result. Production candidates use the ordinary project
configuration and runtime roles.

## Appendix C: Incidents and manual recovery

These procedures live in [Production operations](PRODUCTION-OPERATIONS.md) and
the README. Their scheduler commands are the US ones; for Europe use
`npm run scheduler:europe:pause` and `npm run scheduler:europe:deploy`.

- **The release's own recovery asked for operator review:** compare each
  site's live deployment with the report's `bases` (previous) and `candidates`
  (new) and decide what that site should run. To put a site back, use
  [Code/config rollback](PRODUCTION-OPERATIONS.md#codeconfig-rollback).
- **Suspected data-integrity problem:** stop new writes first with
  [Traffic freeze and incident triage](PRODUCTION-OPERATIONS.md#traffic-freeze-and-incident-triage).
- **Code or configuration fault, data trustworthy:**
  [Code/config rollback](PRODUCTION-OPERATIONS.md#codeconfig-rollback) and the
  README's [Application rollback order](../README.md#application-rollback-order).
- **Corrupt or missing data:**
  [Data recovery / PITR](PRODUCTION-OPERATIONS.md#data-recovery--pitr).
- **A leaked secret:**
  [Secret compromise](PRODUCTION-OPERATIONS.md#secret-compromise).
- **Scheduler Worker fault or a `CRON_SECRET` rotation:**
  [Rotate or roll back](PRODUCTION-OPERATIONS.md#rotate-or-roll-back).
- **A failed migration release:**
  [Fully rolled-back failed migration](PRODUCTION-OPERATIONS.md#fully-rolled-back-failed-migration).

## Appendix D: Reference

- [Release evidence record](PRODUCTION-OPERATIONS.md#release-evidence-record)
  — the private record to fill in for a release.
- [Every release](PRODUCTION-OPERATIONS.md#every-release) — the full
  pre-promotion procedure. `npm run release:both` runs its classification, CI
  check, Preview rehearsal, staged candidates, promotion and two-pass check;
  the focused checks and error-log scans in steps 3 and 6 are yours.
- [Hosting and release setup](../README.md#hosting-and-release-setup) —
  first-time hosting, environment variables, the release classifier, the
  migration commands, legacy baseline adoption and first scheduler deployment.
- [Backups](../README.md#backups) and
  [Health monitoring and scheduler](../README.md#health-monitoring-and-scheduler-required)
  in the README.
- [EUROPE-SETUP.md](EUROPE-SETUP.md) — the Europe project, its scheduler
  commands and its recovery configuration.
- [PRODUCTION-READINESS-2026-08.md](PRODUCTION-READINESS-2026-08.md) — the
  August 2026 launch-readiness audit, kept as history. It is not a runbook.
