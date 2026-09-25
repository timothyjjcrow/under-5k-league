# League systems implementation and release record

Authorized scope: implement the eight recommendations from the September 24
deep code/database audit and release both regional applications after successful
verification. Existing competition outcomes and scoring rules must retain their
meaning. The original checkout is left intact; this branch starts from the
published application commit `9f4544df471bb673d215fc0402668aef753dcf4e`.

## Stages

1. Result reliability (audit item 6): durable candidate progress, independent
   exclusions, current fixture validation, retry classification and regression
   coverage.
2. Database work (item 7): batch reads, coalesce public cache refreshes, preserve
   fresh authorization/writes, bounded diagnostic timings and coverage.
3. Historical participation (item 1): roster tenures, original auction sales,
   actual participants and confirmed lineup snapshots; preserve inferred legacy
   provenance and correct historical consumers.
4. Match cover (item 2): specific availability, requests/offers/acceptance,
   eligibility decisions and reschedule reconfirmation integrated with RSVP.
5. Useful analysis (item 3): hero/role-appropriate metrics, lineup-aware scouting,
   comparable scope, practice goals and review notes with correct visibility.
6. Planning (item 4): private captain draft planning, position feasibility,
   spending previews, explicit future-season format/calendar configuration.
7. Practice (item 5): scheduled inhouse interest and confirmation, outcome
   history, expiring readiness delivery, scrim booking/calendar/RSVP/rescheduling,
   expiry and partial closure with result retries.
8. Side games (item 8): versioned future contest policies, draw pick'em, weekly
   fantasy windows and pre-play lock; retain current contest scoring.

## Verification and release

Each stage needs focused tests and review before the next integration step.
Final checks include lint, types, unit/integration tests, PostgreSQL concurrency
and migration rehearsal, mutation guard, production build, and signup/midseason/
postseason browser suites in both regional configurations. Database changes use
additive migrations and the existing backup, restore, schema attestation and
guarded migration procedure. Scheduler changes require the documented pause,
propagation, quiet-window and lease checks. The only application release path is
`npm run release:both`, followed by canonical-commit and runtime/scheduler checks.
Do not describe a staged or partially verified release as live.

Stage 1 completed locally: bounded durable provider evidence, safe retry/review
states, independent exclusions, fresh transactional fixture/roster checks,
required correction audit, admin retry/ignore with reason and revision guards,
and paginated private progress. Season audit archives include exclusions.
Verification: 194 focused SQLite integration tests plus 15 control tests passed
(provider-specific tests then covered on PostgreSQL); final PostgreSQL run passed
212/212 across nine suites. US and EU each passed all five new browser tests.
Existing unit suite passed except its explicit migration inventory, which was
updated and passed its focused rerun. Types, focused lint, additive migration
validation and PostgreSQL native-object postflight passed. Full final CI remains
required after all stages. PostgreSQL test setup restored SQLite and removed its
disposable database.

Current status: stage 2 implementation beginning. No production changes made.
