# One application, two leagues

US and Europe use the same `main` branch, application components, rules,
standings engine, database schema and migrations. Do not keep regional feature
branches or cherry-pick routine changes between leagues. Make the change once.

`src/lib/league-config.ts` owns public regional configuration. Each Vercel
project retains its own database, Discord credentials and guild, authentication
secret, origin, timezone, match schedule and game-server region. The existing
Steam lobby service supports both regions through the shared regional protocol.
Never copy player data, fixture results, runtime settings or secrets between
leagues. An administrator editing a season edits only that league's data.

## Release both sites

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

Publish both sites together through an authenticated release operator:

```sh
npm run release:both -- --check
npm run release:both -- --apply
```

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
Failure of that gate triggers the same paired recovery. A maintenance release
reports `promoted-awaiting-scheduler-resume` until the operator resumes and
verifies each paused scheduler under the operations procedure.

For a visual review before promotion, use `--stage-only --output <report.json>`,
then `--promote-from <report.json>`. Evidence contains deployment IDs, commits
and outcomes, never credentials. Observe the scheduler and runtime-log gates
in [Production operations](PRODUCTION-OPERATIONS.md) before closing a release.

## Database and scheduler changes

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

The evidence shape is `headSha` and `regions.us`/`regions.eu`. Each affected
region records `baseSha`, `reviewedBy`, and `observedAt` (within six hours).
Database impact requires `backupVerified`, `restoreRehearsed`, and
`migrationReleasePassed`. Scheduler impact requires `zeroTriggers`,
`zeroTriggersAt`, `quietSlotsVerified`, and `noActiveLease`, with the full
propagation and drain interval elapsed. These are attestations to actual
provider evidence required by the operations runbook, not permission to skip
its steps. Keep schedulers paused until their reviewed release is promoted;
then resume and observe two successful scheduled runs.

Each paused Worker also sets `AUTOMATION_PAUSED=true`, so late Cloudflare ticks
cannot dispatch application requests. Verify the deployed flag, active version,
empty trigger list, and actual absence of canonical automation requests under
the operations runbook. The guard does not replace the full propagation, quiet
window, or lease-drain checks. Resume both with the flag set to `false`.

No database migration is introduced by the consolidated tracker UI.

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
