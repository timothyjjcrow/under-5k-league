# Production readiness audit — August 2026

This is the release-focused continuation of
[`PRODUCT-AUDIT-2026-08.md`](./PRODUCT-AUDIT-2026-08.md). Each iteration is a
separate gate. Passing an early gate does **not** authorize deployment while a
later gate remains open.

## Current verdict

**HOLD — the release artifact and CI gate are reproducible, but production is
not ready yet.** Versioned PostgreSQL migrations, recoverable automation,
accurate privacy disclosures, an operator runbook, and final clean-room/manual
validation remain release blockers.

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
