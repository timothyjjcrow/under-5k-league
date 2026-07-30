# Refactoring plan — 2026-07 architecture pass

> **Outcome (2026-07-30):** every stage below landed on
> `refactor/2026-07-architecture-pass` (~26 commits). Final matrix: tsc clean;
> unit 1091; integration 570 (SQLite) and **570/570 on Postgres**; full
> mutation `--discover` re-baseline **54/54 gradeable claims protected**
> (59 total, 5 equivalent — one claim moved from
> `inhouse-service::claimQueuePingThrottle` to the shared
> `settings::claimThrottle`, one new `admin::withdrawSignup::status#1` added
> and immediately protected); both Playwright suites green. Every new guard
> and test was sabotage-verified red before being trusted. The Deferred and
> Rejected sections below remain binding until re-argued with new evidence.

The record of the 2026-07-30 architecture audit: what was changed, in what
order, and — equally important — what was **deliberately not changed** and why.
Read `docs/ARCHITECTURE.md` for the system map this audit was built on.

## Method

Thirteen mapping agents deep-read every subsystem (146 evidence-backed
observations), six auditors turned those into candidates, and every candidate
was verified against the repo's tripwires before being accepted:

- **The mutation ratchet** (`scripts/mutation-guard.mjs` +
  `test/mutation-baseline.json`): claim ids are textual —
  `file::enclosingFunction::sortedStateKeys#ordinal` — so renaming a function,
  moving a claim between files, extracting an `updateMany` into a helper, or
  even inserting a `const x = (`-shaped declaration between a function's
  declaration and its claim re-anchors the id and fails CI with GONE until a
  full `--discover` re-baseline is committed.
- **Source-guard tests** that parse specific files as text:
  `room-source-guards.test.ts` (both rooms), `admin-copy-guard.test.ts`
  (5 admin sources + byte-exact strings in three lib files),
  `dashboard-guards.test.ts` (page.tsx), `danger-submit.test.ts` (pins local
  variable names), and the `[source]` slice of `applyFloor` in
  `inhouse-bets.itest.ts`.
- **e2e couplings**: `zz3` imports room timeout constants; `e2e-mid/stage.ts`
  depends on `AUTO_SYNC` backoff semantics; `scripts/seed-fixture.ts` imports
  `test/integration/factories.ts`, so factory signatures are a shared API.

Hard constraints: preserve behavior, UI, APIs, and schema; no large rewrites;
no unnecessary abstractions or file renames; smallest change with long-term
value. Bug fixes are separated from refactors and each names its observable
change.

## Validation protocol

Every stage ends green on `npx tsc --noEmit` + `npm test`; stages touching
services also run `npm run test:integration`. The pass ends with the full
matrix: unit, integration, `npm run test:pg`, a full mutation `--discover`
re-baseline (required by R38/R39), and both Playwright suites.

---

## Stage A — documentation truth (zero runtime effect)

| id | change | why |
|----|--------|-----|
| R1 | `docs/ARCHITECTURE.md` (new) | the Phase-1 system map |
| R2 | Doc-drift corrections: `schema.prisma:81` maxMmr comment states the **opposite** of the code (this exact lie was believed and propagated once before — CLAUDE.md records it); `schema.prisma:116` missing `REMOVED`; ghost `activeSeasonId` example; stale "Nineteen other models"; `prisma/seed.ts:18` repeats the maxMmr lie; `README.md:21` repeats it too; `site-header.tsx:280` stale `lg` comment; `seed-fixture.ts:6-8` dead header referencing a deleted file; `queries.ts:6` claims consumers it no longer has; CLAUDE.md's stale ratchet numbers (46/46 → baseline is authoritative: 59 claims / 5 equivalent / 54 protected, own 4-shard CI job) | two of these are actively dangerous; the rest are the drift class the repo's own copy guard exists to kill |
| R3 | Re-attach two detached JSDoc blocks (`registration.ts:27-36` describes `registrationGate` but sits on `WithdrawGateInput`; `inhouse-board-service.ts:106-112` CAS rationale sits on `claimBoardRow` instead of `swapState`) | hover/tooling shows the wrong prose; board-service edit must not insert declaration-shaped text near tracked claims |
| R4 | Comment-only: note the `AVAILABILITY` union exception in `constants.ts`'s header; fix `site-footer.tsx:43` overclaiming label parity with the header | both comments assert things that aren't true |

Risk: none. Behavior: none.

## Stage B — type-level and dead code (zero runtime effect)

| id | change | why |
|----|--------|-----|
| R5 | Rename `draft-service.ts`'s local `ActionResult` → `DraftActionResult`; same for `inhouse-service.ts`'s → `InhouseActionResult` (updates one import in `inhouse-bet-service.ts`) | three distinct shapes share one name; readers must check import paths to know which contract applies. Type aliases don't match the ratchet's enclosing-function regexes — verified safe |
| R6 | `BoxScorePlayer = InhouseBoxPlayer` type alias | the writer/reader contract for `InhouseLobby.boxScore` is currently "maintained by comment"; this makes the compiler enforce it |
| R7 | Delete `NominateBar`'s dead `setSelected` prop | threaded through but never consumed |
| R8 | Un-export `DiscordIcon`/`CalendarIcon` in `ui.tsx` | internal-only; narrows the kit's public surface |

Risk: none (tsc proves it). Behavior: none.

## Stage C — pure consolidations (behavior-identical, verified)

| id | change | why |
|----|--------|-----|
| R9 | `honors-service.ts` private `parsePlayers` → `parseGamePlayers` | the parser that "had drifted into eleven byte-identical copies" kept a twelfth |
| R10 | Four private date-format helpers (`fmtWhen` ×2, `fmtWhenShort`, `fmtDate`) delegate to `formatMatchTime`; **plus new `match-time.test.ts`** | these are `LocalTime` hydration snapshots — drift against the client's `formatMatchTime` causes hydration flicker; the module had no test |
| R11 | Extract `ChampionBanner` component (2 byte-identical ~27-line JSX sites) | copy edits can't reach both |
| R12 | Hoist the Discord-webhook regex to one const in `admin.ts` (3 verbatim copies) | drift between them silently splits validation |
| R13 | `discord-roles.ts` uses `getInhousePingRoleId` (2 inline re-resolutions removed; no import cycle — verified) | three hand-copies of Setting-then-env resolution |
| R14 | `toFinishedLobby` mapper beside the type in `inhouse-stats.ts` (3 hand-written mapping sites; queries stay separate — they differ deliberately) | a `FinishedLobby` field addition currently needs three synchronized edits |
| R15 | `schedule/page.tsx` myNextMatch uses `byKickoff` | proven identical output given the query's orderBy + sort stability |
| R16 | `placeholderPersona`/`steamProfileUrl` helpers in `steam.ts` (6 sites) | the create-path fallback matches the fetch-path only by coincidence of copies |
| R17 | `SEAT_PREFIX`/`seatValue`/`parseSeatTarget` in `standin.ts` (2 builders + 2 byte-identical parsers) | builder/parser drift would silently turn an empty-seat fill into bogus player-cover |
| R18 | `pendingCoverWhere` builder in `standin.ts` for the 5-verbatim standin-cover predicate — **the in-tx re-reads stay in place** (they are deliberate Serializable re-asserts; only the WHERE object literal is shared, with a comment saying exactly that) | five sites can drift on what "unplayed" means |
| R19 | Two byte-identical `PHASE_LABEL` pairs single-sourced in `season-copy.ts` (seasons pages pair; admin page/actions pair). The dashboard/header/footer maps are **deliberately divergent per-surface copy and are not touched**. The shared consts cannot live in `actions/admin.ts` (`"use server"` modules may only export async functions) | byte-identical pairs only; zero UI string changes |
| R20 | Setting key-builder registry in `settings.ts` (`resultAnnouncedKey`, `weekReminderKey`, `honorsAnnouncedKey`, `playoffGamesArchiveKey`, `leagueSyncSkipKey` + prefix consts), and `admin.ts:1559`'s hand-written `failed:` → `ANNOUNCE_FAILED_PREFIX` import | ~20 hand-templated key sites across 7 files; the `failed:` literal drifting from the constant would silently exempt admin results from the retry sweep. Ratchet-verified: `key` is an IDENTITY key, no claim signature changes; builders are added away from any claim's enclosing-function span |
| R21 | Repoint 2 `capacityInfo` importers at `@/lib/capacity`, drop `season.ts`'s re-export shim | the season module's public surface includes math it doesn't own |
| R22 | Week reminder's hand-built mention allowlist → `mentionsOf` (wire-identical; itest tolerant of both shapes — verified). The inhouse literal is NOT converted (roles aren't in `mentionsOf`'s model — see rejects) | the helper exists to prevent exactly this hand-build |

Risk: low. Behavior: none. Each lands with tsc + unit + targeted itest runs.

## Stage D — data-fetch and perf (server-side, no observable change)

| id | change | why |
|----|--------|-----|
| R23 | Wrap `getSessionUser` and `getActiveSeason` in React `cache()` | layout + page + snapshot re-run the same JWT verify/user read and season read per request; `cache()` passes through outside a render (verified on React 19.2.4), so actions/route handlers are byte-identical |
| R24 | `schedule/page.tsx`: compute `rsvpFor(m)` once (was 3× per match; each call scans the whole assignment list twice) | O(matches × assignments) redundancy |
| R25 | `/leaders`: parse each game's players JSON once, reuse for boards + honors (the dashboard already does this) | W extra full-JSON parses per request |
| R26 | `enrichStoredGames`: `count()` + `take: limit` instead of loading every un-enriched game's JSON to slice 12 | one admin click reads the whole Game table on a legacy DB |
| R27 | `gatherTeamAccounts`: select-narrow its three `include:{user:true}` queries (4 fields consumed) | runs on every import and roster scan |
| R28 | `/recap`'s inline all-games scan moves into a `cached-queries.ts` wrapper + equivalence itest case (the nested-Suspense footgun does NOT apply — verified call position) | the one roll-up violating the repo's own cached-queries rule |

Risk: low. R23 is the only one with subtle semantics; its verification steps
(header updates after profile refresh / phase change) are in the audit record.

## Stage E — status-literal hygiene (mechanical)

| id | change | why |
|----|--------|-----|
| R29 | Normalize 24 raw `"COMPLETED"`-class literals in `src/lib` to `MATCH_STATUS.*`/`MATCH_PHASE.*` (test files keep literals — they double as an independent pin of the values) | same strings, compile-checked references, `grep MATCH_STATUS.X` becomes exhaustive. The `src/app` sweep (~45 more sites) is **deferred** — triple the churn in display code where a wrong literal is visibly wrong |

## Stage F — new tests and guards (test-only additions + 2 tiny extractions)

| id | change | why |
|----|--------|-----|
| R30 | Extract `syncPingStep` (pure) from `result-sync-ping.tsx` into `result-sync.ts` + unit tests; add `AbortSignal.timeout` to its fetch (the one client poll loop without the signal CLAUDE.md mandates) and extend `room-source-guards` to cover the file | the sitewide staleness mechanism's only subtle rule was untested inline; a hung request permanently froze the tab's sync loop |
| R31 | Resolver-chain parity guard: source test asserting `getInhouseState` and `syncInhouse` run the same resolver SET (orderings differ deliberately and are not compared) | a resolver added to one chain but not the other fails silently — the class that caused the documented `resolveAbandonedLobby` outage |
| R32 | `action-form-guards.test.ts` source guard pinning ActionForm's three load-bearing wirings (React-19 auto-reset opt-out, reset-only-on-success, rejected-promise→toast) | unrenderable under node-only vitest; pure extraction not viable — guard is the honest floor |
| R33 | Unit tests for untested pure modules: `match-time` (in R10), `form.ts`, `site-url.ts`, `share-metadata.ts`, `inhouse-box.ts` | small, pure, and load-bearing (form parsing feeds every action) |
| R34 | Integration test for `GET /api/admin/season-export` — the only production-reachable backup behind Delete season, currently exercised by nothing | untested recovery path, the exact class the betting post-mortem warns about |
| R35 | Session itest: exercise epoch rejection through the real JWT path (mint token at epoch N, bump, assert rejection), not just the Setting-row functions | the revocation feature was tested only up to the number in the table |

## Stage G — small bug fixes (each names its observable change)

| id | change | observable change |
|----|--------|-------------------|
| B1 | `/login` `?error=__proto__` prototype-key crash — add the `hasOwnProperty` guard `/me` already documents, + source-guard test | crafted URL renders generic copy instead of crashing to the error boundary |
| B2 | `/me` and the draft waiting room print `season.draftAt` without `passedLabel` (the exact failure `season-copy.ts` documents; found on a **fourth and fifth surface**) — add the prop, widen `dashboard-guards` to those files | amber "hasn't started" chip appears once draft night is >3h past, instead of a bare stale date |
| B3 | `testInhouseWebhook` gates on the board resolver but sends via the alert resolver | alert-only leagues can now send the test; toast names the right channel |
| B4 | Draft room COMPLETE view renders `disconnectedStrip` like every other branch | reconnecting strip appears on a finished draft when polling dies (undo can re-open a draft from COMPLETE — only the poll delivers that) |
| B5 | `maybeAnnounceUpcomingWeek` burns the week marker on `matches.length===0` without releasing it — release like the failed-send path, + seam test | a week whose sole fixture completed mid-call can announce later instead of being suppressed forever |
| B6 | `setWeekNight` cascade releases the reminder marker for **every** retimed week, not just the moved one, + itest | cascaded weeks re-announce with their new kickoff |
| B7 | `announceSeriesResultOnce` `!home\|\|!away` exit stamps `failed:` instead of burning the marker, + test | restores the file's own "never permanently eat an announcement" invariant on its one violating path |
| B8 | Log `recordResult` and `setWeekNight` to `AdminAction` (+ itest) — the activity card's copy already claims result changes are logged | two new activity rows; `setMatchTime` deliberately stays unlogged (frequent, low collateral) |
| B9 | `reinstateSignup` appends the over-ceiling medal advisory to its toast (never a gate — the operator's-call stance stands) | warning suffix when reinstating a flagged signup |
| B10 | `fetchLeagueMatchIds` signals unreachable as `null` (the `fetchRecentMatchIds` contract) and the league auto-sync rolls its burned throttle claim back, + tests | outage no longer costs one 180s interval per tick; admin toast blames OpenDota instead of implying zero games |

## Stage H — concurrency hardening (the repo's own doctrine, applied to its stragglers)

| id | change | notes |
|----|--------|-------|
| H1 | `saveFantasyRoster`: first-game lock re-counted **inside** the write transaction, outer check deleted (single enforcement point — the `saveRegistration` precedent), + deterministic SQLite itest (sabotage-verified) | new `community-actions.itest.ts` |
| H2 | `savePrediction`: lock carried in the WHERE of the write — `predictionOpenWhere` exported beside `predictionOpen` with an agreement sweep, guarded `updateMany` + re-checked create, + itests | the oracle-board post-information-pick window closes |
| H3 | Admin `withdrawSignup` gains the seat re-check and status-guarded claim `leaveLeague` already has (the asymmetry let a player rostered mid-removal end REMOVED-while-seated), + seam + tests | **new tracked claim** in `admin.ts` → requires the full `--discover` re-baseline (H4) |
| H4 | `claimQueuePingThrottle` delegates to `settings.claimThrottle` (byte-for-byte semantic duplicate) — **ships in the same commit as the full mutation re-baseline**, which also ratchets H3's new claim | the one GONE-producing change in the plan; protection moves to the already-tracked `settings.ts::claimThrottle` claim |

## Deferred (explicitly not in this pass)

- `nominatePlayer` claim pinning `nominatorTeamId` (undo-vs-nominate race): real
  but low-severity (a legal lot opens; only a toast's promise is overridden);
  costs a claim-id change + a Postgres-only seam. Do as its own change if ever.
- The `src/app` status-literal sweep (R29's second half).
- Per-account session revocation, admin-page/actions splits, lib subfolders —
  see the reject list.

## Rejected — decisions of record

Each was investigated and rejected for cause; do not re-propose without new
evidence:

1. **Split `src/app/actions/admin.ts` by domain** — it is thin wrappers over
   already-extracted services; a split moves 5 protected claims between files
   (full re-baseline), breaks `admin-copy-guard`'s haystack, and buys no
   behavior. Defer until it blocks real work.
2. **Split `src/app/admin/page.tsx` into card components** — already structured
   for its size (jump bar, anchors, disclosures — the 2026-07-29 audit's
   design); every moved string must chase the copy-guard's SOURCES list.
3. **Split `src/app/page.tsx` per phase** — `dashboard-guards` would need its
   haystack turned into a coordinated file list; `SeasonViewSkeleton` must
   mirror `SeasonView` band-for-band; only one phase's code runs per request.
4. **Split `getInhouseState`'s view assembly out of `inhouse-service.ts`** —
   no claims live in it (verified), but the assembly reads block-scoped state
   threaded through the resolver chain; extraction forces restructuring a
   450-line function for module-boundary aesthetics.
5. **Domain subfolders for `src/lib`** — pure path rename; claim ids embed
   file paths (11 of the 13 ratchet FILES are `src/lib` paths).
6. **Unify header/footer/dashboard `PHASE_LABEL` maps** — deliberately
   divergent per-surface copy; unifying changes visible UI strings.
7. **Unify `parseSlot` with `slotRound`/`slotIndex`** — divergent only on
   malformed slots, but unifying changes behavior on part of the input domain
   inside the claim-guarded playoff engine.
8. **`sendTo` tri-state return** — ~28 call sites of churn; the pre-read
   pattern is working and tested at each marker-managing caller.
9. **Merge admin `recordResult`'s announce flow into
   `announceSeriesResultOnce`** — divergence is deliberate: an explicit admin
   save must announce even when the marker exists (corrections); the once-only
   claim would swallow them. R20 single-sources the strings instead.
10. **First-user admin bootstrap TOCTOU / non-atomic `bumpSessionEpoch`** —
    accepted: both failure modes are harmless by their own contracts.
11. **`resolveCaptainVote` crash window** — disproven: the claim and captain
    installs share one transaction (the mapping observation was wrong).
12. **Pot-aggregate helper, `potFrom` in `getInhouseState`, inhouse mention
    literal, nav-config module, PlayerPool popstate, Playwright config dedup,
    schema-default/constants pairing, `/fantasy` lock-flag alignment,
    `InhouseCareerCard` caching (CLAUDE.md mandates the full-history scan),
    `pickSplit`/compare-page loads (fine at league scale), layout query
    consolidation beyond `cache()`, `schedule.ts` split** — each documented in
    the audit record with the verified reason.
