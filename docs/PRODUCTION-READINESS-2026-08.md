# Production readiness audit — August 2026

This is the release-focused continuation of
[`PRODUCT-AUDIT-2026-08.md`](./PRODUCT-AUDIT-2026-08.md). Each iteration is a
separate gate. Passing an early gate does **not** authorize deployment while a
later gate remains open.

## Current verdict

**HOLD — repository gates for a reproducible artifact, versioned PostgreSQL
deployment, recovery, and unattended league automation are closed, but
production is not ready yet.** Accurate privacy/data-use disclosures and
public-abuse hardening remain repository blockers. The target-provider restore,
PITR, deployment, scheduler, domain/OAuth, monitoring, credential, and
two-operator proofs remain external launch gates.

## Iteration 1 — immutable release candidate and truthful CI

### Section audited

Runtime selection, dependency installation, production-environment validation,
Vercel build behavior, GitHub Actions, PostgreSQL concurrency testing, mutation
coverage, and release-artifact provenance.

### Current purpose

This gate makes one reviewable Git commit reproducible and prevents a green CI
result from hiding an unbuilt page, an untested league phase, an infrastructure
failure misreported as a test success, or a database write outside the mutation
inventory.

### Actors affected

Every actor is affected because this gate protects the application they all
share. Administrators are additionally affected by deployment and recovery
behavior; maintainers are affected by the stricter CI and mutation workflow.

### Problems found

- Local development, CI, and the intended host did not share one declared Node
  major.
- CI omitted dependency audits, zero-warning linting, a production build, and
  the postseason browser suite.
- The production-shaped CI build could bypass its final schema command through
  a dry-run environment variable.
- GitHub actions used mutable major tags, checkout retained credentials, jobs
  had no explicit least-privilege token policy, and long jobs had no deadline.
- The mutation runner's manually maintained source list omitted five files and
  14 live `updateMany` claims. The prior 106-claim “complete” result was
  therefore incomplete.
- A syntax, import, transform, configuration, timeout, or runner failure could
  be mistaken for a behavioral mutation kill.
- Filtered mutation discovery could not safely prove or replace a closed
  repository-wide baseline.
- A clean macOS checkout inherited `RUST_LOG=warn`, exposing a Prisma 5.22 CLI
  parser defect: `db push` discarded the missing-SQLite diagnostic instead of
  creating the database. Existing fixture files masked the clean-bootstrap
  failure.

### Changes made

- Declared Node 22.x in `package.json`, `package-lock.json`, `.nvmrc`, every CI
  job, and deployment documentation; aligned Node typings with that runtime.
- Made `npm run build:vercel` the one production-shaped pipeline and made
  `vercel.json` call it directly.
- Restricted `BUILD_DB_DRY_RUN=1` to `NODE_ENV=test`; production validation
  rejects the variable whenever it is configured. PostgreSQL CI executes the
  real final schema command against its disposable database.
- Added production/full dependency audits, Prisma validation, zero-warning
  linting, type checking, the SQLite production build, and all three Playwright
  chapters to CI.
- Pinned official GitHub actions to reviewed full commit SHAs, disabled
  checkout credential persistence, limited the workflow token to read-only
  repository contents, added per-job deadlines, and cancel superseded runs.
- Made Playwright start its own server in CI instead of accepting an unrelated
  existing process.
- Made mutation source discovery recursive and fail closed when a claim-bearing
  production file is missing from the owned list.
- Made the mutation baseline an exact, sorted, non-overlapping closed inventory.
  Stale, malformed, duplicate, missing, or unreviewed classifications now fail
  before mutation execution.
- TypeScript-transpile every generated mutant and parse Vitest JSON. Only an
  actual failed test is a kill; runner and infrastructure failures are errors.
- Confirm every newly observed kill twice before promoting it, and prevent
  `--only` probes from rewriting the full baseline.
- Added deterministic tests for news pin compare-and-set behavior, weekly honor
  claims/finalization, inhouse announcement lease ownership, side-game fallback
  claims, and Steam/Dota identity cleanup.
- Added one exact-path, allowlisted SQLite test-database bootstrap and wired it
  into integration tests, all browser-suite server/global-setup paths, and the
  CI build database. It creates only a missing test-owned file, preserves an
  existing fixture, and does not depend on Prisma's logging behavior.

### Architecture improvements made

- CI now separates SQLite behavior, real-PostgreSQL contention, mutation
  strength, browser chapters, and the exact deployment build into explicit
  gates.
- The mutation ratchet now discovers the production source graph rather than
  trusting a manually complete manifest.
- Mutation execution uses direct child processes rather than a shell and
  distinguishes application-test failures from toolchain failures.
- Runtime, build command, and deployment-environment validation have one source
  of truth instead of host-specific instructions.
- Fresh SQLite test setup now has one fail-closed boundary instead of loose
  filename-pattern guards and one-off setup scripts.

### Tests added or updated

- Mutation-runner closed-inventory, malformed-baseline, filtered-probe,
  syntax-failure, infrastructure-failure, and repeat-kill behavior.
- Focused SQLite and real-PostgreSQL tests for the 14 newly inventoried claims.
- CI coverage for audits, lint, type checking, build, final schema execution,
  and the postseason browser chapter.
- Exact SQLite target rejection, missing-file creation, and existing-fixture
  preservation.

### Commands run

- `npm ci --dry-run --ignore-scripts`
- `npm audit --omit=dev --audit-level=low`
- `npm audit --audit-level=low`
- `npm run lint -- --max-warnings=0`
- `npx tsc --noEmit --pretty false`
- `npm test -- --reporter=default`
- `npm run test:integration -- --reporter=default`
- `npm run pg:up`
- focused PostgreSQL mutation probes for all five omitted modules
- `node scripts/mutation-guard.mjs --discover`
- `node scripts/mutation-guard.mjs --shard 78/78`
- full PostgreSQL integration preflights exercised by the mutation runner
- production-shaped `npm run build:vercel` with non-secret CI values against
  `ld2l_pgtest`
- clean staged-tree export, `npm ci`, fresh allowlisted SQLite creation, Prisma
  validation/generation/push, both dependency audits, lint, type checking,
  unit tests, integration tests, and `DATABASE_URL`-backed production build
- `npm run pg:down`
- `git diff --check`

### Test results

- Dependency audit: zero known vulnerabilities in production or full trees.
- ESLint: zero errors and zero warnings.
- TypeScript: passed with no diagnostics.
- Unit: 125 files, 1,715 passed.
- SQLite integration: 44 files, 1,031 passed and 30 intentional
  PostgreSQL-only skips (1,061 total).
- PostgreSQL integration: 44 files, 1,061 passed.
- Mutation discovery: 120 live claims — 78 protected, 42 reviewed equivalents,
  zero unclassified/unprotected. Every new protection was confirmed twice.
- Settled-tree mutation verification: the selected final protected shard passed
  and the exact closed inventory was accepted.
- Chromium: signup 29/29, regular season 40/40, postseason 10/10 (79/79 total),
  including phone layouts, accessibility/tap targets, restricted states,
  destructive confirmations, live draft/inhouse flows, result corrections, and
  the complete season handoff.
- Production-shaped build: Next.js 16.3.0 compiled, type-checked, generated all
  36 static entries, enumerated every route, and executed the real final Prisma
  schema command successfully against the disposable PostgreSQL database.
- Clean staged-tree rehearsal: a fresh archive installed 413 packages with
  zero vulnerabilities, created both absent SQLite databases despite the
  hostile inherited logging level, then passed validation, generation, schema
  push, lint, type checking, all 1,715 unit tests, all 1,061 integration cases,
  and a database-backed Next production build.
- Cleanup: Prisma schema/client restored to SQLite; `ld2l_pgtest` dropped; no
  mutation, test, Prisma, or build process remained.

### Remaining concerns

- Production still uses `prisma db push` and has no immutable migration history
  or safe existing-database baseline. This is the next blocking iteration.
- The current production schema change for Dota account IDs must be expanded in
  a rollback-compatible way rather than altering the old column in place.
- Database backup bytes can be verified, but restore success is not yet an
  automated release gate.
- Result synchronization and several Discord notifications can still be lost
  across a process crash and do not have authenticated, observable scheduling.
- Login/signup copy does not accurately disclose stored and public data; there
  is no privacy page or request process.
- Host configuration, provider backups/PITR, scheduler credentials, OAuth
  callbacks, and credentialed Steam/Discord/OpenDota staging checks are external
  launch gates that repository tests cannot certify.

### Recommended future improvements

Move mutation execution into isolated temporary worktrees so an operating
system kill cannot leave a transient mutant in a developer's working tree. Add
automatic dependency-update pull requests after the launch branch is stable.

### Next section to audit

**PostgreSQL deployment, migration history, upgrade compatibility, and tested
backup restoration.**

## Iteration 2 — versioned PostgreSQL deployment and recovery proof

### Section audited

PostgreSQL migration history, clean installation, adoption of an existing
database created by the former `db push` process, data compatibility, Dota
account-ID evolution, production database identity validation, backup/restore,
schema attestation, and the exact production build order.

### Current purpose

This gate lets a reviewed application commit change the production schema
without inferring destructive SQL at deploy time. It must support both an empty
database and the existing league database, preserve a rollback window for the
previous application, refuse unknown drift or unsafe data, and prove that a
backup can be restored into a coherent database before operators trust it.

### Actors affected

Every player, captain, administrator, and visitor depends on preserved league
history and consistent identity data. Administrators are additionally affected
by active-season/lobby integrity and destructive-action recovery. Maintainers
and operators are affected by migration, backup, restore, and deployment
procedures.

### Problems found

- Production used `prisma db push`, so the repository had no immutable,
  reviewable history and no safe way to distinguish an empty database from the
  untracked existing database.
- Dota account IDs were stored in a PostgreSQL `INTEGER`, which cannot represent
  the full unsigned 32-bit account-ID range. Altering that physical column in
  place would have broken rollback compatibility with the serving release.
- Marking an old database as baselined could have hidden schema drift, extra
  native objects, partial migration history, or release-incompatible data.
- The production build had no read-only preflight or post-deploy proof that the
  exact migration history, Prisma schema, CHECK constraints, partial indexes,
  functions, and triggers were all present.
- “One active season” and “one active inhouse lobby” were application
  assumptions rather than database-enforced invariants.
- Dota metadata writes could race across the legacy/new storage columns, and
  separate unique indexes could not by themselves prevent a stored claim from
  colliding with another user's Steam-derived canonical account.
- Backup verification proved only a digest. It did not prove SQL restoration,
  application-schema discovery, migration checksums, native objects, or fixture
  data. PostgreSQL URLs also needed a credential-safe CLI boundary.
- Production URL validation needed to distinguish pooled and direct endpoints,
  normalize reviewed managed-provider identities, and reject a custom provider
  pair on a different effective port.
- The first combined PostgreSQL run exposed 16 real fixture/compatibility
  failures. In particular, the first Dota compatibility trigger could overwrite
  an explicit new-client v2 write while mirroring the legacy column.
- Exhaustive mutation discovery found two unprotected rank synchronization
  claims: signup and login enrichment could overwrite a newer rank result on
  the same account link without any test noticing.
- Running Playwright immediately after a production Next build exposed a test
  infrastructure defect: its CommonJS global-setup loader transformed an
  imported ESM helper and rejected `import.meta` before browser tests started.

### Changes made

- Added an immutable baseline generated from commit `5520873` and an additive
  `20260804010000_release_readiness` migration. Both use explicit transactions;
  post-baseline destructive SQL is rejected by the migration safety gate.
- Replaced the production schema write with `prisma migrate deploy`. The
  canonical build is now environment validation → PostgreSQL provider switch →
  migration/schema validation → read-only preflight → deploy → read-only
  postflight → Prisma generation → Next production build.
- Added a fail-closed existing-database baseline check and resolver. They pin
  the baseline datamodel digest, compare Prisma-supported schema semantics,
  inventory native public-schema objects, reject any prior/partial migration
  history, repeat the data preflight, require explicit `--apply`, and keep the
  direct database URL out of process arguments.
- Added preflight checks for unknown objects, non-positive legacy Dota IDs,
  cross-user stored/Steam Dota collisions, and multiple active seasons or
  lobbies. Only a truly empty schema takes the fresh-install path.
- Added postflight attestation for the exact two completed migrations and
  checksums, Prisma semantic equivalence, and 12 exact native objects. The
  rehearsal deliberately removes both a normal Prisma index and a native
  trigger and proves that postflight rejects each drift class.
- Preserved the old physical `"dotaAccountId"` column for rollback and added a
  double-precision v2 column with an integer/range CHECK covering 1 through
  4,294,967,295. Compatibility triggers mirror legacy-only writes while
  preserving an explicit new-client v2 value; new code compares and writes both
  stored columns.
- Backfilled and constrained queue, completion, fantasy-lock, and Dota rollout
  state; added the durable inhouse announcement table; retained the legacy lobby
  status index; and added partial unique indexes for one active Season and one
  active InhouseLobby.
- Mapped uniqueness/serialization conflicts to actionable application results
  for season and lobby creation/reactivation rather than leaking Prisma errors.
- Centralized effective/stored Dota account semantics, dual-column snapshots,
  collision queries, and stale-claim retirement. All pages, exports, syncs, and
  metadata compare-and-set writes now use that boundary; a stable export still
  exposes one `dotaAccountId` field.
- Hardened production environment validation for advisory locks, obsolete
  overrides, database/schema/project identity, pooling mode, distinct roles,
  managed-provider normalization, and custom-provider effective ports.
- Made PostgreSQL backup commands use dedicated libpq environment fields rather
  than credential-bearing argv. Added private modes, atomic artifact/digest/
  identity publication, signed receipts, exact local restore targeting,
  `template0` recreation, `psql -X` with stop-on-error and one transaction,
  dynamic schema discovery, full postflight, and fixture survival checks.
- Changed all Playwright global setups to invoke the ESM SQLite-target guard
  through its CLI boundary, which remains exact-path validated and works before
  and after a production Next build.
- Added focused same-account rank races so both newly discovered mutation gaps
  preserve the newer synchronization result.

### Architecture improvements made

- Migration SQL, safety policy, data preflight, schema postflight, legacy
  baseline adoption, backup verification, and restore rehearsal now have
  separate, composable boundaries rather than one host-specific schema command.
- Database-native constraints enforce singleton active lifecycle records even
  if a future application path misses an application-level check.
- Dota identity has one typed compatibility layer instead of provider-specific
  field selection scattered across pages and actions.
- Backup receipts bind a credential-free logical database identity; unknown
  providers include the normalized effective port, while only reviewed Neon and
  Supabase pool/direct forms are allowed to normalize across hosts.
- Migration and restore subprocesses receive credentials through private
  environment fields, and temporary datamodel/schema work never mutates the
  committed provider or generated client.
- Browser fixture setup now treats the ESM helper as a CLI, avoiding loader
  coupling between Playwright, Next build output, and the safety module.

### Tests added or updated

- Migration checksum, SQL safety, empty/legacy/unexpected-schema preflight,
  exact-baseline fingerprint, guarded resolver, and postflight native-object
  tests.
- Fresh database, invalid-data rollback, exact untracked baseline, populated
  legacy upgrade, old/new Dota writer compatibility, and deliberate drift
  rehearsal cases.
- PostgreSQL identity, libpq environment, backup metadata/receipt, signed
  restore, custom-schema restore, and restored-fixture checks.
- Unsigned-32-bit Dota boundaries, legacy fallback, canonical ownership,
  cross-column collision, three stale-claim paths, duplicate submit, and stale
  metadata compare-and-set coverage.
- Database uniqueness and application error mapping for active seasons and
  inhouse lobbies.
- Two same-link rank synchronization races that kill the previously surviving
  signup and login mutations.
- All three Playwright global-setup paths after a production build.

### Commands run

- `npm run db:migrate:validate`
- `npm run db:migrate:rehearse`
- `npm run db:migrate:baseline-check`
- guarded dry-run and `--apply` baseline-resolution rehearsals
- `npm run db:backup`, `npm run db:backup:verify`, and signed
  `npm run db:backup:rehearse` drills, including a custom application schema
- repeated `npm run pg:up`, focused PostgreSQL fixture/race tests,
  `PG_TEST_URL=… npm run test:pg`, and `npm run pg:down`
- focused mutation probes for all three Dota cleanup claims and both rank claims
- `PG_TEST_URL=… node scripts/mutation-guard.mjs --discover`
- `PG_TEST_URL=… node scripts/mutation-guard.mjs`
- production-mode `npm run build:vercel` against the migrated scratch database
- every `.mjs` syntax check, `git diff --check`, zero-warning lint, TypeScript,
  unit tests, SQLite integration, both dependency audits, and all three
  Playwright suites

### Test results

- Migration rehearsal passed fresh install, invalid-data rollback, exact
  baseline adoption, populated legacy upgrade, Dota dual-write compatibility,
  and deliberate Prisma/native drift rejection.
- Signed `pg_dump` verification and restoration passed, including full
  migration/native-object postflight, fixture survival, and a non-`public`
  application schema.
- Production environment and database-identity suites passed 58/58 focused
  cases; postflight/restore units passed 36/36 focused cases.
- Dependency audit: zero known vulnerabilities in production and full trees.
- JavaScript module syntax, migration safety, Prisma validation, zero-warning
  ESLint, and TypeScript all passed.
- Unit: 130 files, 1,765/1,765 passed.
- SQLite integration: 44 files, 1,044 passed and 32 intentional PostgreSQL-only
  skips (1,076 total).
- PostgreSQL integration on the settled tree: 44 files, 1,073 passed and three
  intentional provider-only skips (1,076 total). The earlier 16 failures were
  investigated and fixed rather than waived.
- Mutation discovery and independent verification: 115 live claims — 73
  protected, 42 reviewed equivalents, zero unprotected/unclassified. Both new
  rank protections and all three Dota cleanup claims were confirmed twice.
- Chromium: signup/draft 29/29, regular season 40/40, postseason 10/10 (79/79
  total), including mobile layouts, phase locks, draft/inhouse lifecycles,
  destructive confirmations, result correction, offseason, and archives.
- Exact production build passed environment validation, two-migration safety
  and preflight, `migrate deploy`, exact history plus 12-native-object
  postflight, Prisma generation, TypeScript, compilation, and all 36 static
  entries.
- Cleanup passed: schema/client restored to SQLite; `ld2l_pgtest` and
  `ld2l_restore_test` were dropped; synthetic backup artifacts were removed;
  no E2E server remained.

### Remaining concerns

- The actual hosted database has not yet been backed up, fingerprinted,
  baselined, migrated, or restored into a disposable database on its provider.
  Local proof cannot certify provider permissions, extensions, network policy,
  retention, or point-in-time recovery.
- The compatibility columns/triggers are intentionally retained for one
  rollback window. A later reviewed migration should remove them only after the
  previous application can no longer be promoted and the new data has been
  observed in production.
- There is no destructive SQL down migration. Rollback is an application
  promotion using the preserved schema; a forward repair migration owns any
  later database correction.
- Scheduled result synchronization, reminders, several Discord notifications,
  and operational health still depend on traffic or an unauthenticated/public
  sync boundary. Crash recovery, distributed leasing, and operator visibility
  are the next repository blocker.
- Privacy/operator disclosures, the incident runbook, scheduler activation,
  production secrets/domains/OAuth callbacks, and credentialed
  Steam/Discord/OpenDota staging checks remain open launch gates.

### Recommended future improvements

Run the full signed backup → provider-hosted disposable restore → baseline check
→ migration → old/new application compatibility smoke against the actual
target before promotion. Record provider backup retention and PITR evidence.
After the rollback window, remove the legacy Dota column and compatibility
triggers in a separate additive-then-cleanup release. Move mutation execution
to isolated temporary worktrees so an operating-system kill cannot leave a
transient mutant in a developer checkout.

### Next section to audit

**Authenticated scheduled synchronization, durable notifications, automation
health, distributed ownership, bounded work, and operator recovery.**

## Iteration 3 — unattended automation, durable delivery, and operator recovery

### Section audited

Scheduled result import, reminders, league and inhouse Discord delivery,
notification markers, work ownership, runtime budgets, automation health,
administrator recovery, production configuration, database command safety,
historical backup restoration, release promotion, rollback, and incident
operations.

### Current purpose

This gate makes league maintenance independent of visitor traffic. One
authenticated scheduler or administrator may own a bounded pass, durable work
survives process restarts, operators can distinguish healthy, stale, failed,
and actively running states, and a public dead-man probe can alert without
disclosing league or infrastructure details.

### Actors affected

- Players, captains, teams, and visitors depend on current results, standings,
  reminders, and Discord announcements.
- Administrators need safe manual recovery and actionable failure/backlog
  visibility in every league phase.
- Operators need an authenticated scheduler contract, machine-readable health,
  deployment evidence, rollback controls, and a rehearsed restore path.

### Problems found

- Public page traffic and a public `/api/sync` request performed league writes.
  Quiet periods could stall maintenance, while arbitrary traffic could trigger
  it unpredictably.
- There was no global lease, fencing token, execution budget, durable run
  status, failure streak, dead-man probe, or administrator recovery control.
- Result imports and Discord sends had crash windows. A restart could lose a
  pending announcement, replay a marker, or publish a stale payload after a
  result correction.
- Match completion history had no durable completion timestamp, so enabling a
  scheduler risked replaying historical completed matches.
- Application-clock comparisons and concurrent imports could hide new work,
  race a correction, or surface PostgreSQL serialization errors.
- The production validator did not fully match runtime cron/Steam/Discord
  requirements, allowed a Discord API-base override, and allowed separate
  migration/runtime database users that the first-release restore procedure
  could not safely prove.
- `db:push` was not guarded, and the local-database refusal path could echo
  credential-bearing database URLs.
- Restore rehearsal only handled already-migrated backups. It did not prove the
  exact untracked historical schema that an existing first deployment may
  contain.
- Deployment notes lacked an executable promotion stop rule, traffic freeze,
  scheduler ownership, monitoring, rollback, PITR, credential-rotation, and
  evidence record.

### Changes made

- Replaced traffic-driven writes with an authenticated `GET
  /api/cron/automation` route. `/api/sync` is now read-only, and the removed
  page/week reminder pings are replaced by the scheduled worker.
- Added one database-owned, token-fenced 90-second lease and a 45-second work
  budget shared by cron and the administrator's **Run maintenance now**
  control. An active owner cannot be forced, cleared, or overlapped.
- Persisted attempt, success, source, duration, failure streak, lease, bounded
  issue codes, deferred work, and delivery backlog signals. The admin card
  explains cadence, locks, recovery, and what operators should do next.
- Added public `GET /api/health/automation`. It returns only a bounded status
  and HTTP 200/503: healthy for a fresh clean pass (or a valid active lease
  backed by a fresh clean success), and unavailable for never-run, stale,
  failed, degraded, expired, or database-unavailable states.
- Added durable league and inhouse announcement outboxes with ordered retry,
  exponential backoff, marker generations, correction cancellation, and
  in-flight payload fencing. Work is committed before delivery and survives a
  process restart.
- Added database-maintained `Match.completedAt` state and migration sentinels so
  existing completed history is not mistaken for new work.
- Centralized database time. PostgreSQL and SQLite now compare against their
  own clocks; SQLite uses fractional-second precision so just-created work is
  immediately eligible.
- Added bounded retry for PostgreSQL serialization conflicts during match
  import and explicit concurrency seams for correction, withdrawal, marker,
  and delivery races.
- Tightened production validation: cron secrets must match runtime length and
  whitespace rules; Steam is required; half-configured Discord OAuth and bot
  pairs fail; `DISCORD_API_BASE` is forbidden; and migration/runtime URLs must
  use one database principal for this release.
- Guarded `db:push` with the exact local-target assertion and redacted all
  credential, path, query, and fragment data from refusal messages.
- Added explicit `--legacy-baseline` restore rehearsal. It accepts only the
  immutable, migration-free historical schema in the dedicated local scratch
  database, resolves the baseline there, deploys current migrations, runs the
  normal postflight, and proves fixtures plus exact migration history.
- Added `docs/PRODUCTION-OPERATIONS.md` with named owners, immutable commit
  approval, one-scheduler policy, evidence template, pre-promotion stop rule,
  controlled promotion, provider traffic freeze, rollback, PITR recovery, and
  secret rotation. README, architecture, CI, environment examples, and stale
  operator notes now match those controls.

### Architecture improvements made

- Cron is a thin authenticated adapter over one reusable leased worker rather
  than a second synchronization implementation.
- Database outboxes and generation-fenced markers separate league state commits
  from external delivery while keeping retry state observable.
- Database time, completion state, issue codes, and health projection are
  shared typed boundaries rather than route-specific conventions.
- The public probe exposes a stable low-information contract; detailed timing,
  failures, leases, and backlogs remain restricted to administrators.
- Historical-baseline adoption, current restore rehearsal, deployment
  migration, and postflight use the same fail-closed migration boundaries.
- Operational evidence is now part of the release contract instead of an
  informal hosting checklist.

### Tests added or updated

- Cron authentication, lease acquisition/recovery/token fencing, deadline,
  worker status, admin action, and public health-state unit coverage.
- SQLite and PostgreSQL integration coverage for parallel lease election,
  expired-owner recovery, stale-owner completion, deferred work, independent
  failure capture, database-unavailable health, and phase-independent operation.
- Result and announcement coverage for crash recovery, duplicate passes,
  correction/withdrawal races, marker replay, historical sentinels, retry
  ordering, stale payloads, Discord transport failure, and PostgreSQL
  serialization retry.
- Production-environment, redacted local-database guard, migration/native
  object, legacy restore, and CI workflow coverage.
- A phone-width browser assertion now requires the automation card and manual
  recovery control to be visible with no horizontal page overflow.

### Commands run

- Focused Vitest suites for automation, production environment, database
  targeting, backup restoration, result synchronization, Discord transport,
  reminders, markers, and both announcement outboxes
- `npm test`, `npm run test:integration`, and serial PostgreSQL runs through
  `npm run pg:up`, `PG_TEST_URL=… npm run test:pg`, and `npm run pg:down`
- authoritative `PG_TEST_URL=… npm run test:mutation:discover`
- `npm run db:migrate:validate`, fresh/invalid/populated
  `npm run db:migrate:rehearse`, and real legacy-dump
  `npm run db:backup:rehearse -- --legacy-baseline …`
- production-shaped `npm run build:vercel`
- `npm run lint -- --max-warnings=0`, `npx tsc --noEmit`, and `git diff --check`
- focused Chromium phone test for the admin automation card
- manual desktop browser pass through dev authentication, administrator
  recovery, persisted health refresh, success feedback, and console inspection

### Test results

- Unit: 140 files, 1,859/1,859 passed.
- SQLite integration: 45 files passed and one provider-only file skipped;
  1,106 passed and 38 intentional skips (1,144 total).
- PostgreSQL integration: 46 files; 1,141 passed and three intentional
  provider-only skips (1,144 total). The latest focused result/outbox rerun was
  44/44.
- Mutation discovery: 133 live write claims — 85 protected, 48 reviewed
  equivalents, zero unprotected or unclassified.
- Focused production environment: 54/54; local database guard: 12/12; mocked
  backup/restore: 31/31; automation health/route: 24/24.
- Fresh, invalid, populated-legacy, deliberate-drift, current-backup, and real
  historical-dump rehearsals passed. The historical fixture survived with one
  user, one season, and all three current migrations attested.
- The exact production build passed validation, migration pre/postflight,
  Prisma generation, TypeScript, compilation, and route generation, including
  the new automation endpoint.
- Zero-warning ESLint, TypeScript, `git diff --check`, and the focused 360–375px
  Chromium layout/visibility test passed.
- Manual browser recovery changed the card from **Never run** to **Healthy**,
  recorded **Admin manual run** and a duration, showed success feedback, left
  no backlog or lease, emitted no browser errors, and the server recorded HTTP
  200 for `/api/health/automation`.

### Remaining concerns

- Discord delivery is intentionally at-least-once. A process failure after
  Discord accepts a request but before `SENT` is committed can produce a
  duplicate message; correctness no longer depends on losing the message.
- Privacy/data-use disclosures, public-field labels, retention/request
  handling, and a real request contact are still missing and are the next
  repository blocker.
- Public polling and proxy-aware abuse controls still need a focused audit.
- Actual provider backup/PITR/restore evidence, manual production approval,
  exactly one scheduler, alert routing, credentials, custom domains, Steam and
  Discord callbacks, MFA, and two named operators cannot be proved from this
  repository and remain hard launch gates.

### Recommended future improvements

If Discord offers an idempotency or application-level deduplication primitive,
bind it to the outbox id. After production behavior is observed, consider a
separate cleanup release for delivered-outbox retention and archived automation
history. Keep the public probe contract small; send detailed diagnostics only
to authenticated operator tooling.

### Next section to audit

**Privacy, data use, public-field disclosure, retention, and the participant
request channel across login, signup, profile, footer, and league pages.**
