# Site quality-of-life implementation — September 4, 2026

This release implements the practical UI, administration, and read-efficiency work from [the site audit](SITE-AUDIT-2026-09-04.md). The original audit records the before state. Changes are on `codex/site-quality-of-life`.

## Delivered

| Audit item | Implementation |
| --- | --- |
| U1 / U2 | Home puts phase-specific participation and match content before ordinary news. Pinned announcement links remain prominent. Schedule puts current fixtures before standings, playoff analysis, and the season grid. |
| U3 | Shared action forms keep a focused, persistent error summary and retain entered values. Existing success/error toasts, uncertain-outcome wording, confirmations, and manual action dispatch remain. |
| U4 / U5 | Schedule chips and week toggles have 44px phone targets. Team selection is URL-backed, defaults to the viewer's team, and survives refresh, sharing, and Back. All teams is an explicit reset. Admin jumps reveal their destination below both sticky bars, including direct/reloaded hashes and streamed sections. |
| U6 | Leaders has metric navigation. Hero meta exposes all analyzed heroes with search, sorting, minimum picks, full metrics, and sample sizes. Existing highlights, eligibility, tie ranking, and viewer pinning remain. |
| U7 / E2 | Profile starts with a setup checklist, groups optional scouting fields, and shows dirty/saved feedback. Optional fields stay mounted and are submitted even when collapsed. Live Discord membership and ping-role checks stream separately; the existing membership/callback reconciliation and linking policies remain. |
| U8 | Invalid or repeated explicit Scrims season selections return not-found instead of silently showing a different season. |
| A1 | A read-only needs-attention overview links missing kickoffs, older open results, pending reschedules, and uncovered declared absences to their matches. Match-night controls lead during competition; phase/captain setup leads during signup/draft. All existing controls remain. |
| A2 | An admin-only imported-game diagnostic page identifies affected matches and distinguishes malformed/incomplete scores, unknown hero catalogue IDs, and missing player attribution. It links to existing recovery controls without triggering any retry or import. Existing automation, sync/backoff, and Discord diagnostics remain available. |
| A3 | Admin activity has stable cursor pagination and season, action, actor, and UTC date filters. Historical actor names and best-effort logging semantics remain unchanged. |
| E1 | The main admin match query selects only displayed game ID, Dota ID, winner, and duration. Within admin, player JSON is read only when the diagnostic route is opened. News editing now streams independently and loads 20 posts per page. |
| E3 | Comparison metadata and page rendering share request-scoped decoded full-career data. Home pinned notices and news previews share one request-scoped read. Existing cross-request cache tags, mutation invalidation, scouting behavior, and full-history Elo remain unchanged. |
| E4 | Public/admin news and completed scrim history use bounded pages. New news permalinks resolve a specific post; legacy hash links resolve older posts through a compatibility component. Scrim team/player statistics stream independently and still use all completed results, regardless of the selected history page. |

The isolated 25-game fixture measured **167,194 bytes of serialized full game rows versus 3,136 bytes for the selected fields** (about 98% smaller). This is a server-side row representation comparison, not a measured total-page or production-latency reduction.

## Season safety

No schema migration, season transition, scoring change, draft change, result-policy change, import retry change, authorization change, or production data write is included. Testing uses the repository's isolated SQLite databases with external integration credentials disabled. A branch push is separate from a production deployment.

Existing server mutation guards remain authoritative. UI summaries are advisory and do not create a second set of eligibility or competition rules. A match is only described as having started over two hours ago when its saved kickoff is actually that old; future unresolved fixtures are not treated as overdue.

## Deliberate limits

This is not a production performance benchmark or a rewrite of the admin console. Large career/Elo histories are not truncated. Further cross-request derived-stat caching, splitting every admin setup screen into a separate route, and production query-plan tuning remain follow-up work requiring production workload measurements and explicit cache-invalidation coverage. The current implementation removes demonstrated redundant work and avoids introducing a new stale-results contract during the active season.

Live Discord OAuth, webhook delivery, production scheduler operation, and Postgres concurrency have not been exercised here. The diagnostic pages report data quality; they do not repair or delete games automatically.

## Verification

- `npm run build`: passed, including production compilation, TypeScript, and route generation.
- `npx tsc --noEmit --incremental false`: passed.
- `npm run lint` and `git diff --check`: passed.
- `npm test`: **2,213 tests passed in 170 files**.
- `npm run test:integration`: **1,172 passed, 38 skipped**, across 49 passing files and one skipped file. Uses isolated SQLite; this is not Postgres concurrency coverage.
- Midseason browser coverage: **all 50 unique scenarios covered successfully**. The final broad run passed 48; two newly added assertions were too strict about Next's duplicated streamed `noindex` tags. They now assert the actual not-found page, presence of noindex, and absence of admin controls. All seven quality-of-life scenarios then passed together. The screenshot harness's pre-hydration caret-style mutation was removed; admin hydration warnings are explicitly checked.
- Signup/draft/inhouse browser coverage: **all 35 unique scenarios covered successfully**. The broad run passed 34; the hero-picker test was updated to open its new optional section and passed on its focused rerun, including dirty-state feedback.
- Postseason browser coverage: **10/10 passed**, including guarded recovery, champion consistency, archive, offseason, and new-season handoff.
- Visual inspection: desktop Home and 390px Schedule, Meta, and revealed admin Discord section; screenshots are in `docs/audit-2026-09-04/` with `-after` filenames.

The browser checks exercised real server actions against disposable fixture data: check-ins, reschedules, registration, invalid result feedback, reversible rulings, draft operations, and inhouse recovery. New tests also cover URL persistence, admin authorization, activity cursor paging with tied timestamps, old news hashes, and scrim history/statistics independence.
