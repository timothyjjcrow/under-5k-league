# Production readiness audit — August 2026

This is the release-focused continuation of
[`PRODUCT-AUDIT-2026-08.md`](./PRODUCT-AUDIT-2026-08.md). Each iteration is a
separate gate. Passing an early gate does **not** authorize deployment while a
later gate remains open.

## Current verdict

**CONDITIONAL RELEASE CANDIDATE — all repository gates closed; DO NOT OPEN
TRAFFIC until the external launch evidence in PRODUCTION-OPERATIONS is
complete.**

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

## Iteration 4 — privacy, public data, terms, and participant requests

### Section audited

Steam sign-in and immediate OpenDota enrichment; signup/profile fields and
their public visibility; Discord linking, contact visibility, guild/role
behavior, and unlink limits; cookies and browser storage; public league
history; retention; participant access/correction/deletion requests; policy
discoverability; production disclosure configuration; and restoration replay.

### Current purpose

This boundary lets a prospective participant understand what signing in and
joining will publish before providing data. It also gives participants a
private request route and gives operators a fail-closed, rehearsable process
for handling corrections or de-identification without corrupting shared league
history or resurrecting old values during disaster recovery.

### Actors affected

- Visitors and prospective players need disclosure before Steam sign-in or a
  public signup submission.
- Players and standins need accurate field-level visibility, retention, and
  Discord-link explanations.
- Captains and active participants need the existing restricted contact data
  without expanding it to every signed-in account.
- Administrators need public-history integrity and safe, reviewable correction
  procedures.
- Operators need a monitored private mailbox, verified storage-country
  disclosure, retention evidence, provider limits, and restoration replay.

### Problems found

- There was no privacy page, terms page, private request contact, storage-country
  disclosure, retention contract, or participant-request runbook.
- Steam copy said sign-in fetched only a name/profile even though it stores a
  stable Steam identity, derives a Dota account, and immediately requests an
  OpenDota medal, public-match state, and scouting snapshot.
- Signup copy did not explain that participation type, MMR/medal estimate,
  roles, favorite heroes, goals, captain interest, and captain note are public.
  The free-text prompt encouraged players to publish specific availability.
- Discord copy said the application only read a username. The real flow stores
  the stable account ID and username, conditionally requests `guilds.join`, and
  lets the bot inspect league-server membership and role IDs. Another line
  incorrectly granted contact visibility to every signed-in account.
- Bot setup documented only Manage Roles, although automatic OAuth joining also
  needs Create Invite. It did not clearly reject Administrator permission.
- Withdrawal and Discord unlink could be mistaken for erasure. There is no
  safe generic `User` deletion: restrictive relations, embedded game JSON,
  denormalized history, Discord deliveries, and a relationless Cred ledger
  require a case-specific plan.
- The operations guide named no privacy owner and did not define verification,
  subject-only export, two-person review, retention truth, provider-source
  limits, or post-restore replay.
- Production could build without a monitored mailbox or the exact countries
  where league-controlled Steam/application copies are stored.

### Changes made

- Added public `/privacy` and `/terms` pages with effective dates, external
  service links, plain-language public/restricted data maps, cookie/local
  storage behavior, no-ad/no-payment statements, retention truth, public
  history, play-money Cred terms, external-data limitations, and request
  instructions.
- Added pre-sign-in acknowledgement, global footer and sitemap links, and
  collection notices on the shared Steam explanation and signup form.
- Labeled every public signup category, removed the availability solicitation,
  and updated the public profile and features copy to match actual visibility.
- Corrected Discord wording to name the ID/username, discarded temporary token,
  conditional server join, visibility policy, and unlink limitations.
- Corrected Discord setup to Manage Roles plus Create Invite for automatic
  joining, explicitly without Administrator permission.
- Added server-only `PRIVACY_CONTACT_EMAIL` and `PRIVACY_DATA_LOCATIONS` values.
  Production validation requires one normalized non-placeholder mailbox and
  exact verified storage countries; errors name the field without echoing it.
  Missing values remain visibly unconfigured outside production.
- Added an executable privacy-request/retention runbook: primary and deputy
  ownership, independent MFA, private case register, linked-account
  verification without passwords/2FA/API keys/identity documents, complete
  source inventory, subject-only disclosure, reviewed clone rehearsal,
  restoration replay, tabletop scenarios, and release-stop conditions.
- Updated the README and architecture map for the two new pages, real data
  flows, OpenDota persistence limits, production variables, provider evidence,
  and Discord Developer Portal configuration.

### Architecture improvements made

- One small server-only normalization module is shared by public rendering and
  the production environment gate, preventing configuration/render drift and
  unsafe `mailto:` values.
- Privacy policy pages are database-independent and fail visibly in local or
  preview environments while production fails closed before migration/build.
- Existing contact visibility remains centralized in `visibility.ts`; new
  source guards pin its use on both the directory and profile rather than
  duplicating authorization logic in policy UI.
- Manual privacy operations are now a defined release and recovery boundary.
  A restored database is not eligible for promotion until later approved
  corrections/de-identifications are replayed and verified.

### Tests added or updated

- Pure mailbox and storage-country normalization coverage, including display
  names, whitespace, multiple addresses, URLs, control/header injection,
  placeholder domains, vague locations, and length boundaries.
- Production-environment acceptance/rejection and secret-redaction coverage.
- Static render and source guards for privacy/terms content, collection links,
  every public signup category, stale misleading phrases, footer/sitemap/robots
  wiring, and profile contact/private-match visibility.
- Operations source guards for ownership, safe identity verification, complete
  source inventory, subject-only exports, two-person clone rehearsal, restore
  replay, and launch-stop conditions.
- A 360px Chromium journey from login to privacy to terms, including configured
  contact/storage facts, footer discoverability, and horizontal overflow.

### Commands run

- focused Vitest suites for privacy normalization, production environment,
  notices, policy wiring, sitemap, robots, contact visibility, and operations
- `npm test` and `npm run test:integration`
- `npm run lint -- --max-warnings=0`, `npx tsc --noEmit`, and
  `git diff --check`
- schema-current isolated SQLite `npm run build` with configured public privacy
  values
- focused Chromium phone workflow in `e2e/pages.spec.ts`
- manual desktop browser pass through login disclosure, privacy, terms,
  Discord copy, and the signup form in the SIGNUPS phase

### Test results

- Focused privacy/configuration suites: 105/105 plus 5/5 operations guards.
- Unit: 144 files, 1,910/1,910 passed.
- SQLite integration: 45 files passed and one provider-only file skipped;
  1,106 passed and 38 intentional skips (1,144 total).
- Zero-warning ESLint, TypeScript, and `git diff --check` passed.
- The clean isolated build compiled, type-checked, generated all 38 entries,
  and included `/privacy` and `/terms`. An earlier diagnostic build exposed a
  stale local `dev.db`; it was not used as evidence and the user database was
  not mutated.
- Focused Chromium: 1/1 passed at 360px with no horizontal overflow.
- Manual browser inspection confirmed the sign-in acknowledgement, full
  policy hierarchy, configured mailbox/countries, footer links, truthful
  Discord explanation, every public signup label, and SIGNUPS-phase context.

### Remaining concerns

- Repository validation proves configuration shape, not that the mailbox is
  monitored, the published countries are accurate, provider encryption and
  retention settings match the notice, or the deputy can operate the process.
- There is intentionally no self-service account export/deletion in this first
  release. A production removal request remains manual and must follow the
  reviewed runbook; automatic retention/pruning should be a later focused
  migration rather than an untested promise.
- Operator identity, jurisdiction, age/guardian applicability, and final legal
  language require review for the actual launch community. The repository does
  not claim universal legal compliance.
- The canonical PostgreSQL production migration/build and provider restore are
  reserved for the final release gate. Actual Steam, Discord, and OpenDota
  credentials and Discord Developer Portal policy URL still need live evidence.
- Public polling, proxy-aware client identity, request amplification, and
  abuse/rate-limit behavior remain the next repository blocker.

### Recommended future improvements

After launch evidence exists, add an automated retention inventory and focused
cleanup design for optional signup text, delivered outboxes, and operational
history. A future subject-export tool should be requester-specific and redact
other players; it must never expose the multi-user season audit archive. Keep
provider links and policy effective dates current as integrations change.

### Next section to audit

**Public API and polling abuse resistance, trusted-proxy identity, bounded
queries and payloads, request failure behavior, and externally reachable
security surfaces.**

## Iteration 5 — public runtime hardening and repository release gate

### Section audited

Public JSON routes, room polling and maintenance, OAuth/OpenID callbacks,
trusted-proxy client identity, request and query bounds, rate limits, client
outage recovery, CDN cache policy, Discord webhooks, administrator exports,
provider refresh actions, production cookies, server-action limits, exception
and log disclosure, security documentation, and the complete repository release
gate.

### Current purpose

This boundary keeps anonymous traffic read-only and bounded, prevents one
client or forged forwarding header from amplifying provider/database work,
keeps personalized responses out of shared caches, constrains outbound Discord
destinations and large responses, and ensures expected failures are useful
without exposing credentials or internal exceptions. It also establishes the
last repository-owned evidence required before an external candidate
deployment.

### Actors affected

- Visitors and spectators need fast, reliable public boards that cannot mutate
  league state.
- Players, captains, and teams need resilient live polling, safe identity
  refreshes, and understandable failures.
- Administrators need bounded exports, safe configuration, and predictable
  maintenance behavior.
- Operators need trustworthy client identity, cache separation, sanitized
  telemetry, and an explicit handoff from repository proof to host/provider
  launch evidence.

### Problems found

- Anonymous room reads could perform maintenance, draft deadline resolution,
  and provider synchronization; fleet-wide polling could multiply that work.
- JSON routes trusted declared lengths and accepted effectively unbounded,
  malformed, primitive, or invalid-UTF-8 request bodies.
- Client identity could fall back from an invalid attested header to a
  spoofable header, and rate-limit responses lacked retry guidance.
- OAuth/OpenID callbacks, query fields, calendar filters, season exports, and
  server actions lacked sufficiently narrow request or response limits.
- Polling retried outages at a steady cadence, creating avoidable load during a
  prolonged failure; browser offline/online events did not themselves gate
  stale draft and inhouse controls, and a pre-outage response could arrive
  after reconnect and re-enable them.
- Public read responses had no reviewed edge-cache contract, while
  personalized/private responses needed explicit no-store protection.
- Discord webhook configuration could permit an unsafe or malformed outbound
  target, and raw provider/runtime errors could reach logs or user-facing
  action results.
- Provider refresh actions had only process-local or incomplete abuse
  resistance; concurrent instances could bypass it, and changing a pasted Dota
  match ID could fan out exact-match lookups.
- Production cookies retained ordinary names vulnerable to cookie tossing;
  the first hardened deletion path did not explicitly preserve the `Secure`
  attribute required to expire a `__Host-` cookie.
- Unbound OAuth/OpenID callbacks could consume a legitimate browser's one-shot
  flow cookies, Discord transport functions trusted future callers to pass an
  already-validated URL, and an inhouse action's reconciliation poll could be
  swallowed by an older in-flight state poll.
- A timed-out, unreadable, or 5xx live-room mutation released its request-level
  pending flag before authoritative reconciliation. The server may already
  have committed, so briefly re-enabling stale controls invited duplicate
  joins, picks, bids, or votes while the outcome was still unknown.
- The administrator season export could exceed the hosting response limit.

### Changes made

- Made anonymous inhouse and draft reads side-effect free. Authenticated room
  maintenance uses a durable two-second database throttle so at most one
  fleet-wide winner performs the bounded work.
- Added an 8,192-byte streaming JSON-object parser to all five JSON mutation
  routes. It rejects oversized, malformed, primitive, and invalid-UTF-8 bodies
  before authentication or database access, including requests without a
  trustworthy `Content-Length`.
- Prefer validated `x-vercel-forwarded-for`; an invalid attested value maps to
  unknown rather than falling back to a spoofable identity. Added
  `Retry-After` to throttled responses and made logout same-origin validation
  fail closed.
- Bounded Discord OAuth and Steam OpenID callback totals, duplicate fields,
  individual values, verifier/state values, calendar team IDs, and export
  season IDs.
- Added fast initial poll recovery followed by jittered capped backoff. Offline
  events immediately pause every live-room action; reconnect remains in a
  visible resynchronizing state until a post-transition authoritative payload
  arrives. Connectivity generations reject held pre-outage responses, and a
  queued-rerun latch preserves post-action reconciliation behind an in-flight
  poll. Unknown mutation outcomes now keep every affected control locked until
  a state poll that started after the action successfully applies; the room
  explains that it is reconciling instead of inviting a duplicate click.
- Added explicit browser revalidation plus short Vercel-only microcaches for
  public sync and calendar reads; private and error responses remain no-store.
- Restricted Discord webhooks to canonical HTTPS Discord webhook URLs with
  exact host, path, credential, port, query, fragment, whitespace, and length
  rules. Environment, database, administrator-save, and final network-sink
  paths share the same validator; an invalid sink target performs no fetch.
- Capped season exports at 4,000,000 UTF-8 bytes and return an administrator-only
  413 with out-of-band audit guidance before emitting an oversized body.
- Added typed user-facing errors and stable fallback/event codes so expected
  errors remain actionable while unexpected exceptions and secret-looking
  values are not disclosed.
- Added database-backed, fail-closed provider cooldowns for rank, Steam/Dota
  account, Steam profile, captain auto-detection, and exact-ID league/inhouse
  imports after authorization, phase, fixture/lobby, duplicate, and local input
  checks. Exact-ID keys bind the authenticated actor to the trusted
  fixture/lobby—not attacker-controlled submitted IDs.
- Adopted production `__Host-` session and OAuth state/return cookies, secure
  host-only path policy, explicit secure expiration, and legacy-cookie cleanup.
  OAuth/OpenID callbacks consume flow cookies only after binding the callback
  to the initiating browser/user. The first hardened release intentionally
  requires users to authenticate again.
- Disabled direct Prisma stdout logging outside development, constrained
  operational exception codes to approved semantic codes or `Pdddd`, and made
  production UI error boundaries log stable events only.
- Set the Next.js server-action body limit to `64kb` and documented the host,
  proxy, cache, WAF, cookie, export, credential, database, and operator evidence
  required before opening traffic.

### Architecture improvements made

- Public projection, authenticated maintenance, and provider synchronization
  are separate boundaries instead of hidden side effects of a read.
- Shared parsers, webhook policy, error types, operational-code policy, cookie
  policy, export response construction, and durable cooldown keys replace
  route-specific conventions.
- Live-room network state now has explicit online/offline/resynchronizing and
  request-generation boundaries rather than inferring safety from a fetch
  merely returning. Provider work is claimed through one database-backed
  actor/resource policy shared by manual league and inhouse imports.
- Cacheability is explicit per route and limited to low-TTL public projections;
  authentication and failure paths remain private.
- The operations guide is now the authoritative handoff between repository
  completion and provider-specific launch approval.

### Tests added or updated

- Anonymous/read-only room behavior, durable throttle ownership, request-body
  streaming and UTF-8 limits, attested-IP handling, callback/query bounds,
  retry headers, same-origin logout, polling backoff, and cache headers.
- Webhook URL and sink validation, production-cookie creation/expiration and
  legacy cleanup, bound OAuth/OpenID flow consumption, provider cooldown
  concurrency/failure/different-ID behavior, typed action errors, log/code
  sanitization, export byte boundaries, server-action configuration, and
  production-environment rejection.
- SQLite and PostgreSQL integration coverage for connected room, provider,
  playoff, export, and authorization workflows; Chromium coverage for phone,
  signup/draft, regular-season, inhouse, offline/resynchronizing states, held
  pre-outage responses, action/poll overlap, unknown-action lock/reconciliation,
  and outage behavior. The draft resilience file can now run independently by
  arranging its live fixture through the real admin workflow rather than test
  ordering or direct database writes.

### Commands run

- `npm audit --omit=dev --audit-level=low` and
  `npm audit --audit-level=low`
- `npm run lint -- --max-warnings=0`, `npx tsc --noEmit --pretty false`, and
  `npm test -- --reporter=default`
- `npm run test:integration -- --reporter=default`
- `npm run pg:up`, `PG_TEST_URL=… npm run test:pg`, and `npm run pg:down`
- full mutation inventory discovery and verification for all protected claims
- production-shaped `npm run build:vercel` against disposable PostgreSQL
- `npm run test:e2e`, `npm run test:e2e:mid`, and
  `npm run test:e2e:postseason`
- in-app desktop and 360×800 browser inspection of home, inhouse, login, and
  signed-in administrator pages

### Test results

- Dependency audits: zero known vulnerabilities in production and full trees.
- Zero-warning ESLint and TypeScript passed.
- Unit: 152 files, 2,004/2,004 passed.
- SQLite integration: 46 files passed and one intentional provider-only file
  skipped; 1,123 passed and 38 intentional skips (1,161 total).
- PostgreSQL integration: 47 files; 1,158 passed and three intentional
  provider-only skips (1,161 total).
- Mutation inventory: 133 total claims — 85 protected, 48 reviewed
  equivalents, zero unprotected. Every one of the 85 protected claims was
  killed, with no infrastructure errors.
- Chromium chapter 1: 35/35 passed. Midseason: 40/40 passed. Postseason: 10/10
  passed (85/85 total). Manual desktop/phone inspection found clear hierarchy,
  restricted-access messaging, and no horizontal overflow at 360px.
- The exact production build passed environment validation, migration safety,
  preflight, deployment, and postflight for all three migrations and 14 native
  objects, then compiled, type-checked, generated 38 static entries, and
  enumerated all routes.
- The first PostgreSQL command omitted the exported `PG_TEST_URL` and failed at
  startup; the guarded local URL was then supplied explicitly and the complete
  suite passed. This was an invocation/configuration omission, not an
  application failure.
- Four SQLite fixture failures used fake Discord webhook IDs/tokens that no
  longer satisfied the production URL policy. The inert fixtures were changed
  to valid-shaped values and the focused and complete SQLite suites passed.
- The first final PostgreSQL run exposed one stale recovery-test assumption:
  it expected an immediate retry after OpenDota had already been called but a
  later transaction rolled back. The test now verifies the intentional
  one-minute provider throttle and successful retry after expiry; the focused
  and complete PostgreSQL suites then passed.

### Remaining concerns

The repository is complete, but the following are external hard launch gates
and must be recorded in `PRODUCTION-OPERATIONS.md` before traffic is opened:

- Vercel WAF rule IDs, log-mode/shared-NAT review, and block-mode evidence.
- Direct DNS or Trusted Proxy configuration and deployed client-IP trust proof.
- Deployed `x-vercel-cache` MISS-to-HIT evidence for public projections and
  never-HIT evidence for personalized/private responses.
- Deployed `__Host-` `Set-Cookie` attributes and the planned forced-reauthentication
  observation.
- Production database/provider region, pool, protection, preview isolation,
  deployment protection, backup/PITR, restore, and actual migration evidence.
- Credentialed Steam, Discord, and OpenDota smoke tests plus a sacrificial
  failure trace/log inspection and immediate credential rotation.
- A largest-representative-season export rehearsal below the enforced limit.
- A monitored privacy mailbox, accurate storage-country/provider disclosures,
  reviewed legal/process evidence, and deputy-operation proof.
- Monitoring and alert routing, exactly one scheduler, traffic freeze and
  rollback rehearsal, and two named operator approvals.

### Recommended future improvements

After launch evidence is complete, observe throttle/cache effectiveness and
provider latency under real league traffic before changing limits. Add
automated retention for old cooldown and operational records in a separately
reviewed migration, make internal room snapshot helpers side-effect-free by
default (production anonymous routes already pass explicit safe options), and
consider stronger Discord delivery deduplication if the provider exposes an
idempotency primitive. A response that began before a newer action may still
paint briefly while that action is pending; controls remain disabled and
server-side version/CAS guards protect integrity, but a future client data layer
could make that transient presentation impossible too.

### Next section to audit

**External candidate deployment and evidence collection only: provider restore
and migration, edge/WAF/cache/cookie proofs, credentialed integration smoke,
monitoring, rollback, privacy operations, and two-operator launch approval.**
