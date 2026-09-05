# Inhouse audit and rework — 2026-09-04

This change addresses queue retention, the live room, history, database reads,
result detection, and the Discord board/result integration. The focus is a
clearer player journey with fewer unnecessary requests while preserving the
existing season, authorization, draft, rating, and Cred settlement rules.

Implementation, production build, and automated/browser verification are
complete. Deployment has not been performed for this change. This is an audit of the implemented paths
and their tests, not a claim that every integration failure has been eliminated.

## Queue retention: confirmed cause and revised behavior

The former queue policy coupled membership to browser polling. A player became
"away" after 90 seconds without a heartbeat, then a maintenance pass could
delete their queue entry after 180 seconds. Background tabs can be throttled or
fully suspended, so changing tabs or entering the Dota client could appear to
the server like abandoning the queue. Another visitor or scheduled maintenance
could perform the deletion before the original player returned.

The rework removes the three-minute heartbeat deletion. The existing shared
`idleExpiresAt` clock now owns waiting-queue cleanup:

- Switching tabs, suspending a tab, or a failed poll does not remove queue
  membership.
- A join, leave, lobby formation, or requeue refreshes the shared four-hour
  deadline for everyone still waiting. Presence heartbeats do not extend it.
- Once that shared deadline expires, maintenance clears the whole waiting
  queue. An otherwise unchanged queue does not survive indefinitely because
  one tab is still polling.
- Players remain eligible for lobby formation through four hours without a
  heartbeat. If other membership activity has extended the queue beyond that,
  an unseen player can retain their place but must return before being counted
  for a new ready check.
- Requeued players whose presence must be reconfirmed remain backdated beyond
  the availability window. This preserves the protection against immediately
  recreating a cancelled lobby around the same absent players.
- The existing 45-second ready check is intentionally unchanged. Players who
  miss that explicit acceptance window are still dropped; players who accepted
  retain their existing requeue priority when the check fails. Browser
  suspension can still prevent an immediate notification, even though tab
  switching itself no longer deletes membership.

The shared idle reset affects waiting entries. It does not delete active match
participants or replace the separate active-lobby lifecycle rules. The
SERIALIZABLE join/reset ordering and existing write-time claims remain in place.
The automation gate was versioned and updated so an already-away entry does not
keep every scheduled pass immediately due.

Relevant code: `src/lib/inhouse-service.ts`, `src/lib/inhouse.ts`,
`src/lib/constants.ts`, and `src/lib/automation-gate.ts`.

## Live room and history

The room now presents the queue, ready check, captain selection, draft, setup,
and game as visible stages. Queue progress, player slots, the viewer's position,
and the next-game queue have a clearer hierarchy. Timed phases keep prominent
actions and clocks; help and MMR explanations sit in disclosures instead of
competing with the current action.

The page includes section navigation for the live room, ladder, results, and
setup help. The ladder adds established-player leader cards while preserving
the provisional-games threshold, full records, recent form, and separate Cred
profit ranking. The room and archive share a box-score component with team
comparisons, player lines, and a recorded-roster fallback when detailed stats
are unavailable.

History keeps its existing pagination and completed-game summaries, but loads
the selected game's roster and avatars on demand. A `?game=` link can open a
completed game even after it moves beyond the current archive page. OpenDota
links, player links, and the authorized admin void action remain available.
Per-row detail links disable speculative prefetch, so scrolling through the
archive does not fetch every expanded roster. Narrow box scores place player
identity above the stat line to keep names readable without dropping metrics.

Client resilience also improves:

- Poll cadence and membership use the latest accepted snapshot. Failed or
  stale responses do not erase the client's knowledge that the viewer is
  queued or in a match.
- Optional preference storage cannot prevent the room from loading. Muting
  and result-banner dismissal still work for the current page visit when
  browser storage is blocked or full.
- A successful admin void in the live room refreshes the server-rendered
  ladder and recent results, including when there is no active lobby before
  or after the action. Phase views reset their local inputs for a new lobby.
- Queue and history controls expose accessible names and state; the existing
  action, notification, spectator, and next-game paths are retained.

Relevant code: `src/components/inhouse-room.tsx`,
`src/components/inhouse-box-score.tsx`, `src/components/room-clock.tsx`,
`src/app/inhouse/page.tsx`, and `src/app/inhouse/history/page.tsx`.

## Database and request efficiency

Healthy foreground participants now poll every five seconds while waiting and
every ten seconds during a game after betting closes, instead of using the
1.5-second action cadence throughout. Ready checks, captain votes, draft picks,
and setup/betting retain the fast cadence. Starting a game early does not slow
updates until the original 45-second betting window closes, including for
players who already placed their bet. Hidden participants retain the ten-second notification
keepalive, subject to browser scheduling; hidden spectators can remain paused.
These are configured cadence changes, not measured load-test throughput gains.

Automatic OpenDota detection is removed from the ordinary room HTTP state path.
The authenticated maintenance worker continues to own automatic scans, and the
manual detection action remains available. A worker first reads only the live
lobby's identity and detection clocks. Fresh games and cooldowns exit before
loading player records; only the guarded claim winner loads the required
roster and Dota identity fields. The established minimum game age, cooldowns,
provider budget, match identity fallbacks, and result claims remain intact.

The completed-result banner now selects only the fields and participant row
needed by the viewer, avoiding unrelated player rows and large stored result
payloads.

`loadInhouseLadderSummary` provides the full-history records, ranked/provisional
split, and completed-game count to the page, player lists, and Discord stats.
Concurrent cold readers share one history scan, and the redundant standalone
completed-lobby count query is removed. Elo still includes the complete career
history; it is not truncated to a recent-game window.

A cheap `resultChangedAt` lookup invalidates cached summaries immediately after
normal result and void writers. The 60-second TTL bounds changes made outside
those writers, such as a changed display name. The scheduler explicitly bypasses
warm or older in-flight work before deciding that the Discord board is current.
Cache generations and summary identities prevent a completed older read from
being reused as the current summary. Rejected reads do not poison later retries.

Relevant code: `src/lib/room-poll.ts`, `src/app/api/inhouse/route.ts`,
`src/lib/inhouse-service.ts`, `src/lib/inhouse-ladder.ts`, and
`src/lib/inhouse-board-service.ts`.

## Discord integration

The board remains one tracked message edited in place. Its digest now includes
previously omitted visible changes: corrected scores and end time, MVP details,
ladder rating, pending player names, player counts, and canonical site links.
A render version refreshes static copy after rollout even when the queue is
quiet. Wall-clock passage remains excluded from the digest, so elapsed time
alone does not generate repeated edits.

Transient PATCH failures back off from 20 seconds to a five-minute maximum and
return to the normal ten-second floor after success. The existing admin failure
count and last successful edit remain truthful. Queue copy is shorter and now
describes tab-safe retention and the four-hour idle reset.

The inhouse result outbox now checks the preview Discord policy before taking
leases or advancing retry bookkeeping. A blocked preview reports pending work
without rewriting copied attempts, claim tokens, or retry timestamps. The
existing durable result/void ordering, current-result checks, lease claims, and
compare-and-set completion guards remain intact.

Existing safety behavior is preserved: ambiguous initial board POSTs retain an
interrupted reservation for manual recovery; a failed delete does not silently
forget a reachable board; in-flight edits cannot resurrect or overwrite a board
an admin removed or replaced. No real webhook or guild mutations were used in
this audit.

## Verification

| Check | Recorded result |
| --- | --- |
| Full unit suite | 2,251 passed across 173 files |
| Targeted SQLite inhouse integration | 241 passed; 15 PostgreSQL-only cases skipped |
| Full PostgreSQL integration | 1,227 passed; 3 skipped across 52 files |
| ESLint | Passed |
| TypeScript | Passed |
| Production build | Passed: compilation, TypeScript, prerendering, and optimization |
| Browser workflows | 12 scenarios passed across the targeted runs |
| Desktop/mobile visual review | Queue, ready check, captain vote, draft, setup, active game, ladder, and expanded history reviewed; 375px and 1440px captures |

The added coverage includes background-tab retention, shared idle expiry and
requeue semantics, phase-aware polling, bounded detection reads, board digest
corrections and retry recovery, concurrent stats reads, result/void cache
invalidation, and preview outbox isolation. Browser specifications also cover
storage failures, archive expansion/deep links, and the room lifecycle. Seven
existing network/reconnect scenarios passed. The final five-scenario run passed
both storage faults, queue join/leave, the full lifecycle (including live pot
polling after Start and destructive admin recovery), and a 102-game archive
fixture covering pagination, an off-page shared link, legacy roster fallback,
and both admin void paths. The archive test verifies that season rows stay
unchanged. Runtime page errors and horizontal overflow are checked by the
browser scenarios.

Local evidence logs are `/tmp/ld2l-inhouse-unit-final.log`,
`/tmp/ld2l-inhouse-integration.log`, `/tmp/ld2l-inhouse-pg.log`,
`/tmp/ld2l-inhouse-browser.log`, `/tmp/ld2l-inhouse-browser-final.log`, and
`/tmp/ld2l-inhouse-build.log`. The earlier browser log includes two test-fixture
GET/POST errors; those requests were corrected and both tests pass in the final
run. Review captures are in `/tmp/ld2l-inhouse-ui/`.

Integration tests used disposable local SQLite/PostgreSQL databases and mocked
external senders. The development seed now uses the canonical backdated
presence helper so demonstration players cannot accidentally fill a real test
lobby after the availability window increased. That is a fixture adjustment,
not a change to production players or league data.

## Remaining pain points and release limits

- Queue-filling and match-found alerts remain best-effort. A failed queue ping
  can retain its throttle, and a process failure after lobby formation can lose
  the match-found alert. Durable retries would need event expiry and mention
  preservation, particularly for the 45-second acceptance window; replaying a
  stale alert would be misleading.
- Durable result delivery still has an unavoidable network/commit gap: if
  Discord accepts a webhook POST and the process dies before recording success,
  lease recovery can publish it again. Existing claim guards prevent ordinary
  concurrent duplicates but cannot promise exactly-once external delivery.
- An ambiguous board POST still requires an admin to inspect Discord and clear
  the interrupted reservation. This is deliberate protection against orphaned
  duplicate boards, not automatic recovery from every possible transport loss.
- An admin can void a bad historical result, but there is no complete correction
  workflow to replace/reimport that historical result after voiding it. Such a
  workflow must address match ownership, Elo replay, Cred reversal, and durable
  correction announcements together.

This working change adds no Prisma schema migration and makes no current-season
configuration or data changes. It does not change authorization, betting rules,
or result ownership. No live database writes, external announcements, or
deployment were performed as part of this audit. Normal release checks remain
necessary before deployment. The release classifier treats any `prisma/` change
as a database release, including this seed-only fixture edit; the schemas and
migrations themselves are unchanged. Follow that release process when publishing
instead of inferring that a local build authorizes a production rollout.
