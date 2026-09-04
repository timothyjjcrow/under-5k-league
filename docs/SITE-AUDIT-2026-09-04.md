# GGD2L site audit — September 4, 2026

The highest-value improvement is to put the player's or administrator's next task ahead of the supporting analysis. The app already has rich data, useful recovery controls, and substantial lifecycle protections. Preserve those systems while improving information order, navigation, feedback, and the cost of reading data.

This report records the original audit and backlog before implementation. **The audit itself changed no application code, production configuration, production data, or current-season state.** The subsequently authorized fixes and their validation are documented in [Site improvements](SITE-IMPROVEMENTS-2026-09-04.md).

## Scope and evidence

- Inventoried all **27 page routes**, including Scrims and its detail page, plus the shared shell and recovery states.
- Completed **62 browser observations** at 1440px and 390px: every page route, extra comparison/match states, and a missing-page response. `/admin` and `/me` were viewed using a local test administrator. Additional focused checks covered a fixture captain, schedule filter persistence, admin anchor navigation, and invalid season selection.
- Browser observations used an isolated SQLite fixture at `prisma/e2e-fixture.db`, with six teams, 15 regular fixtures, 25 imported games, a live series, future fixtures, sample news, and a sample booked scrim. Added an empty archived season to inspect its recovery state.
- All 62 observations had no detected page-width overflow or Next error overlay. Public-route observations had no uncaught `pageerror` events. Admin/profile inspection also checked rendered content and overlays; this is not a full accessibility certification.
- **2,190 unit tests passed across 168 files. TypeScript checking passed.** All 43 midseason browser tests were covered successfully: 38 passed initially and the remaining five passed after correcting the local audit server's test-admin configuration.
- Inspected queries, shared form feedback, statistics computation, admin controls, integration status, and relevant mutation/lifecycle boundaries. Used the installed Next 16.3.0 documentation as the framework reference.

**Limits:** This was a local source-and-browser audit, not a production traffic benchmark. No live Steam/Discord OAuth journey, webhook delivery, production scheduler, Neon query plan, or production Core Web Vitals was exercised. Fixture-only warnings are not evidence of bad production data. Live draft and populated inhouse state-machine permutations were reviewed in source; the initial browser sweep sampled their current fixture states. An empty archive is not proof of a complete historical season. Production Postgres concurrency tests and deployment checks were not run.

Evidence: [browser observations](audit-2026-09-04/survey-results.json), [focused reproductions](audit-2026-09-04/focused-results.json).

## Recommended first release

| Order | Change | Benefit | Relative effort | Season risk |
| --- | --- | --- | --- | --- |
| 1 | Put current fixtures and personal actions first on Schedule/Home | Players reach the match they need quickly | Medium | Low: presentation only |
| 2 | Persist form errors next to the form | Users can understand and correct failed actions | Small–medium | Low: keep existing actions and validation |
| 3 | Fix admin jump offsets and enlarge phone controls | Admin tools are easier to find and tap | Small | Low: presentation only |
| 4 | Load only the game fields admin actually displays | Less database transfer and server allocation | Small | Low: read projection only |
| 5 | Preserve schedule team selection in the URL | Refresh, sharing, and return navigation retain context | Small | Low: client display state |
| 6 | Put an operational summary above admin settings | Results, cover, reschedules, and integration problems become easy to triage | Medium | Low if strictly read-only |

These are relative estimates, not calendar commitments. Each should be a small reviewable change, with its own relevant checks. No database migration is needed for this first release.

## UI and user-flow findings

### U1 — Fixtures are too far down the Schedule page

**Priority: high. Confirmed in browser and source.** At 390px, the team filter starts about **2,404px below the top**. Standings, playoff projections, run-in analysis, and the season grid precede the fixtures. There is already a “This week” link, but its `#fixtures` destination still precedes the grid. A player who opens Schedule to find tonight's match has to navigate around the analysis.

**Fix:** Make “My next match / This week” the first content section. Follow it with the team filter and fixture list. Keep Standings, Playoff picture, Run-in, and Season grid available through clearly labeled sections or tabs. Default a rostered player's filter to “My team” only when no explicit filter is present, and keep “All teams” obvious. During playoffs, emphasize the player's next bracket match and retain access to the full bracket.

**Preserve:** The same fixture IDs, kickoff times, RSVP rules, cover assignments, standings math, and bracket projection. A view change must not reschedule anything.

Source: [schedule composition](/Users/timothycrowley/LD2L2.0/src/app/schedule/page.tsx:653), [fixture section](/Users/timothycrowley/LD2L2.0/src/app/schedule/page.tsx:698). Evidence: [phone Schedule](audit-2026-09-04/390_schedule.png).

### U2 — Home's personal task should outrank general league content

**Priority: high. Design recommendation grounded in the rendered hierarchy.** The current-season hero and league news lead into the general weekly slate; the fixture captain's “Your team” card appears after standings. Existing check-in and team components are valuable and should be promoted rather than recreated.

**Fix:** Immediately below the compact season heading, show a role-aware “Your next action” panel: check in, review a reschedule, find cover, enter the draft room, or finish registration. Show the next match's local time and opponent in that panel. Put news and statistical discovery below it; keep important pinned announcements visible without letting ordinary news displace match-night work. Visitors should still get a clear explanation and suitable join/watch actions.

**Preserve:** Existing role/phase policies and distinctions between full players, standins, captains, and spectators. Fixture users without registrations exposed unusual combinations; do not infer a production registration defect from those fixture combinations.

Source: [home weekly slate and standings](/Users/timothycrowley/LD2L2.0/src/app/page.tsx:1976), [check-in presentation](/Users/timothycrowley/LD2L2.0/src/app/page.tsx:763).

### U3 — Form errors disappear before a user can finish correcting them

**Priority: high. Confirmed in shared implementation.** `ActionForm` reports action errors through the global toast. `Toaster` dismisses every message after five seconds; the form does not render its returned error inline. Long profile questionnaires and admin result forms retain their values after a validation failure, which is good, but the explanation can disappear while the user works.

**Fix:** Keep a persistent inline error summary associated with the submitted form. Where field-level errors are available, link them to their inputs and move focus to the first invalid field or summary. Retain success toasts. Keep the existing “action may have completed” language for uncertain network outcomes; do not automatically retry a mutation. For multiple similar admin forms, include the match/team identity in feedback.

**Acceptance:** Submit an invalid profile or result form; wait more than five seconds; the explanation and typed values remain. A successful reschedule still reports success if revalidation removes its form.

Source: [ActionForm](/Users/timothycrowley/LD2L2.0/src/components/action-form.tsx:53), [toast lifetime](/Users/timothycrowley/LD2L2.0/src/components/toaster.tsx:33).

### U4 — Phone controls and admin jump navigation need a second pass

**Priority: high for the obscured admin target; medium for larger touch targets. Confirmed in browser.** Schedule filter chips measure about 26px high, week toggle controls about 28px, and admin jump links about 30px. Clicking “Discord” in the admin jump bar leaves the section closed and places its top at roughly 96px, beneath the combined 80px site header and sticky admin navigation. The section title is visibly obscured.

**Fix:** Account for both sticky bars in the scroll offset. Opening a jump destination should reveal that section and put its heading in view, with keyboard focus handled appropriately. Give standalone phone controls a 44px target and retain a compact desktop treatment. Add active-section feedback and a visible indication that the jump list can scroll.

The 44px recommendation follows the [W3C enhanced target-size guidance](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html); these measured sizes alone do not establish an AA failure.

Source: [AdminSection and AdminJump](/Users/timothycrowley/LD2L2.0/src/app/admin/page.tsx:557), [schedule chips](/Users/timothycrowley/LD2L2.0/src/components/schedule-weeks.tsx:243). Evidence: [obscured Discord heading](audit-2026-09-04/admin-discord-jump.png).

### U5 — Schedule filters are not durable or shareable

**Priority: medium. Reproduced.** Select Dire Straits on Schedule: `aria-pressed` becomes true, but the URL stays `/schedule`. Reload: it becomes false. Player-pool filters already preserve their state in the URL, so this is an inconsistency between related exploration tools.

**Fix:** Store selected team and optional week/view in validated query parameters. Preserve explicit selection when navigating back from a match. Clear invalid team IDs safely. Use the existing client-side history approach where possible so filtering does not introduce a database round trip. Test reload, copied URLs, Back, and switching seasons.

Source: [schedule local state](/Users/timothycrowley/LD2L2.0/src/components/schedule-weeks.tsx:81), [existing player-pool pattern](/Users/timothycrowley/LD2L2.0/src/components/player-pool.tsx:88).

### U6 — Statistics need a way to answer a specific question quickly

**Priority: medium. Confirmed presentation limits.** Leaders is about **6,213px tall on a 390px phone** even with top-five boards. Hero meta renders only the top 20 contested heroes and top 10 win-rate entries; it provides no full searchable catalogue of the calculated rows. A user looking for a specific hero or metric may not find it despite the data being available.

**Fix:** Add a metric selector or category jump navigation to Leaders, preserving the existing “You” pinning and full-board expansion. On Meta, provide hero search, sort, a clear minimum-games filter, and access to every analyzed hero. Show sample size beside percentages and retain existing qualification rules. On small screens, allow optional metrics to be revealed explicitly rather than making hidden columns permanently inaccessible.

**Preserve:** Existing tie ranking, trusted 5v5 validation, eligibility thresholds, and the distinction between scenario shares and predicted chances. No recalculation of scoring is needed.

Source: [Leaders](/Users/timothycrowley/LD2L2.0/src/app/leaders/page.tsx:1), [Meta truncation](/Users/timothycrowley/LD2L2.0/src/app/meta/page.tsx:353). Evidence: [phone Leaders](audit-2026-09-04/390_leaders.png).

### U7 — Profile setup should distinguish required work from optional scouting details

**Priority: medium. Design recommendation.** `/me` combines identity, Dota verification, Discord, registration, and public scouting questions into a long page. The newcomer/admin fixture measures about 3,759px on a phone. Public/private field labeling is already explicit and should be retained.

**Fix:** Start with a short setup checklist whose items link directly to the relevant field: Steam verified, Discord reachability, public match data, season participation. Separate required participation information from optional hero/role/goal details. Show a clear “Saved” versus “Unsaved changes” state and keep validation nearby. Keep the registration form usable when an optional provider is unavailable.

**Preserve:** Steam-derived identity, public-field privacy guidance, soft MMR review versus the hard ceiling, and registration/withdrawal gates. Do not turn optional profile completion into a new eligibility restriction.

Source: [profile page](/Users/timothycrowley/LD2L2.0/src/app/me/page.tsx:280). Evidence: [phone profile](audit-2026-09-04/390_me.png).

### U8 — Invalid Scrims season selection silently displays another season

**Priority: medium. Reproduced.** `/scrims?season=does-not-exist` retains that URL while displaying the active fixture season. The selection expression falls back to the active season when an explicit selection is not found. Leaders, Meta, Fantasy, and Pick'em instead reject invalid explicit season IDs.

**Fix:** Validate explicit season parameters, including repeated values, and show a not-found or “Season unavailable” state with a deliberate return-to-current-season link. Keep historical season context visible and preserve it across Scrims/Team links. This prevents an operator from mistaking the displayed season for the requested one.

**Preserve:** Defaulting to the active/latest season when no season was requested, and the complete separation of Scrim results from league competition.

Source: [Scrims season selection](/Users/timothycrowley/LD2L2.0/src/app/scrims/page.tsx:76).

## Admin and integration findings

### A1 — Admin should open on operational work, with configuration behind it

**Priority: high. Confirmed layout; proposed organization.** The admin page measures about **6,798px on desktop and 11,184px on phone** in the regular-season fixture. Phase settings and captain/draft controls precede weekly results. Collapsing secondary sections and adding anchors has helped, but normal match-night work still competes with rarely used settings.

**Fix:** Keep a compact active-season identity strip and add a read-only “Needs attention” overview: overdue unresolved matches, missing kickoffs, pending reschedules, uncovered absences, unavailable imports, and degraded automation. Link each item to its exact match or existing control. Group the console into Match night, Rosters, Season setup, Integrations, and History/recovery. Use phase-aware defaults; a current-season admin should land on operational work.

This extends the existing `adminNextStep` and health cards rather than introducing a second set of league rules. Future scheduled matches must not be classified as overdue just because they lack results.

**Preserve:** Every existing action, phase guard, typed destructive confirmation, collateral warning, archive safety check, and direct link. Moving a control must not change its authority or server-side preconditions.

Source: [admin composition](/Users/timothycrowley/LD2L2.0/src/app/admin/page.tsx:260), [existing next-step policy](/Users/timothycrowley/LD2L2.0/src/lib/admin-next-step.ts:79). Evidence: [phone admin top](audit-2026-09-04/admin-mobile-top.png).

### A2 — Connect integration health to a specific recovery task

**Priority: medium. Confirmed fragmented surfaces; proposed workflow.** Automation, automatic result sync, league ticket setup, and Discord health already provide useful detail. Statistics warnings can say stored data needs attention without identifying the affected match in that warning. For example, the fixture's Meta page reported unknown hero IDs while Leaders and Meta used different game counts; that is valid filtering, but the user has to infer why.

**Fix:** Present a compact integration overview: last successful work, next eligible attempt, pending items, and a link to the relevant existing recovery control. Add a data-quality list with affected match IDs and reasons. Public pages should explain “19 of 25 games eligible for this analysis” when applicable; admins should be able to inspect the excluded games. Unknown catalogue IDs should point to catalogue maintenance, not removal of otherwise valid games.

**Preserve:** Current retry leases, backoff, outbox ownership, deduplication, and explicit actions. No retry-on-page-view or automatic destructive reimport. Copying a diagnostic summary must omit tokens, webhook URLs, and unnecessary personal information.

Source: [AutoSyncHealth](/Users/timothycrowley/LD2L2.0/src/app/admin/page.tsx:3971), [DiscordSection](/Users/timothycrowley/LD2L2.0/src/app/admin/page.tsx:5016), [statistics warning](/Users/timothycrowley/LD2L2.0/src/components/stats-nav.tsx:54).

### A3 — Make the existing audit trail searchable

**Priority: medium. Confirmed.** Admin displays only the most recent 40 activity entries, with no paging or season/action filter. Older records remain in storage but are not reachable from this UI. This makes “who changed this match last week?” harder to answer as activity grows.

**Fix:** Add cursor pagination and filters for season, action, actor, and date, with links to surviving entities. Start with existing fields and summaries; add structured before/after metadata only as a later additive change where useful. Surface logging failures operationally without making an already committed league mutation fail.

**Preserve:** Denormalized historical actor names and best-effort logging semantics. Do not claim the current log is a complete transactional audit trail.

Source: [activity display](/Users/timothycrowley/LD2L2.0/src/app/admin/page.tsx:5910), [log storage/query](/Users/timothycrowley/LD2L2.0/src/lib/admin-log.ts:33).

## Efficiency findings

### E1 — Narrow admin's game query and separate operational reads from setup reads

**Priority: high. Confirmed in source and fixture measurement.** `loadSeasonAdminData` includes `games: true` for every season match. The admin list uses game ID, Dota match ID, winner, and duration; it does not display each game's full `players` JSON. In the 25-game fixture, the raw players strings alone total **139,338 characters**, about 83% of the serialized game-row representation measured locally. This is a server query/allocation observation, not a measured browser-transfer saving.

**Fix first:** Select only the fields used by the game list and any shared helper consuming those rows. Keep the existence/count and score information required by safety checks.

**Fix next:** Load match-night operations independently from captain setup, historical games, and news editing. Closed HTML `<details>` still has server-rendered children and does not defer its queries. Route-based admin sections or genuinely requested detail panels can reduce work. Parallelize independent reads currently sequenced after other queries only after their dependencies are checked.

**Acceptance:** The same result/ruling/import controls and warning counts render before and after. Measure query count, bytes, and response time with a large synthetic season; retain source-of-truth checks inside mutations.

Source: [admin query](/Users/timothycrowley/LD2L2.0/src/app/admin/page.tsx:722), [displayed game fields](/Users/timothycrowley/LD2L2.0/src/app/admin/page.tsx:2983).

### E2 — Discord membership lookup blocks the whole profile

**Priority: medium. Confirmed dependency; production latency not measured.** `/me` awaits `fetchGuildMember` in the main page's data batch before returning the page. A slow Discord response can delay identity and registration content that do not require that response. Admin already streams Discord separately.

**Fix:** Isolate Discord membership/ping status behind its own server component and loading/error state. Render profile and participation data immediately. Show unknown status honestly if the provider fails; preserve the existing callback-versus-current-membership reconciliation.

Source: [profile blocking batch](/Users/timothycrowley/LD2L2.0/src/app/me/page.tsx:155). The approach follows [Next's guidance on streaming independent data sections](https://nextjs.org/docs/app/getting-started/fetching-data), with the installed 16.3.0 docs governing implementation.

### E3 — Shared derived statistics can reduce repeated history work

**Priority: medium; requires careful invalidation. Confirmed architecture, not a measured production bottleneck.** Existing caches already share several raw game scans. Their consumers still parse JSON and derive statistics per request; player comparison also scans participants during metadata generation. Match scouting deliberately performs an uncached full-history read because an earlier cache boundary caused a rendering regression. The Inhouse page independently scans completed lobbies even though a memoized full ladder exists for other consumers.

**Fix:** Profile these paths with a large fixture, then share validated derived summaries at the right scope: season, player, or full career. Deduplicate identical work within a render. Use separate league and inhouse invalidation contracts, and explicitly refresh after imports, removals, enrichment, identity changes, and result corrections. Verify scouting actually streams before restoring any cache around it.

**Preserve:** Full-history Elo, deterministic order/ties, trusted attribution, and current correction behavior. Never improve speed by truncating the source history or caching private viewer-specific data globally. Do not adopt new Cache Components across the whole application as part of a UI cleanup.

Source: [existing query cache](/Users/timothycrowley/LD2L2.0/src/lib/cached-queries.ts:1), [uncached scouting](/Users/timothycrowley/LD2L2.0/src/app/matches/[id]/page.tsx:834), [Inhouse ladder query](/Users/timothycrowley/LD2L2.0/src/app/inhouse/page.tsx:421), [existing ladder cache](/Users/timothycrowley/LD2L2.0/src/lib/inhouse-ladder.ts:24).

### E4 — News and Scrim history grow without a page boundary

**Priority: medium. Confirmed.** Public News and admin news editing load every post. Scrims loads its season's non-cancelled bookings/history plus all completed game lines before constructing both the availability UI and statistics. More activity increases work even when a user only wants the next available practice slot.

**Fix:** Keep pinned/latest news visible, paginate older posts with stable ordering, and maintain direct permalink access. Separate upcoming Scrims from paginated history; stream/cache the practice statistics independently. Preserve all history and never mix practice aggregates with league aggregates.

Source: [news query](/Users/timothycrowley/LD2L2.0/src/app/news/page.tsx:20), [admin news query](/Users/timothycrowley/LD2L2.0/src/app/admin/page.tsx:247), [Scrims query batch](/Users/timothycrowley/LD2L2.0/src/app/scrims/page.tsx:113).

## Complete page inventory and recommended direction

Every route below was browser-rendered at desktop and phone widths. Dynamic routes were sampled with fixture IDs; this does not mean every entity or lifecycle permutation was exercised.

| Route | What to retain | Improvement direction |
| --- | --- | --- |
| `/` | Phase-aware hero, next-match/check-in logic, standings, news, engagement links | Promote personal work and current fixtures (U2); compact general league context |
| `/login` | Steam-only production login, safe return path, clear account explanation | Keep one primary sign-in action; review real-provider error/return states in staging |
| `/me` | Verified identity, Discord guidance, saved signup answers, public-field labels | Setup checklist, durable errors, independent Discord loading (U3/U7/E2) |
| `/players` | Search, role/status filters, URL persistence, scouting, roster/standin separation | Show available cover clearly during the season; retain full scouting through expandable detail |
| `/players/[id]` | Career data, season history selector, comparison links, visibility rules | Add compact section navigation and show current team/role before detailed career analysis; optimize derived history (E3) |
| `/players/compare` | Shareable two-player selection and honest minimum-data states | Searchable selection, swap players, metric explanations; retain comparison and career totals |
| `/teams` | Rosters, team form, draft recap, rankings | Emphasize current record/next opponent during the season; keep draft economics under a secondary section |
| `/teams/[id]` | Roster, captain context, fixtures, scenarios, Scrims access | Put next-match actions first; preserve archive context when opening practice/history |
| `/draft` | Server-authoritative clocks, status-aware room, recovery actions | Keep the active lot/turn and reconnect status dominant; avoid risky poll/auction changes in this release |
| `/schedule` | All fixtures, check-ins, standings, bracket, grid, calendar feed | Fixtures-first, durable filters, larger phone controls (U1/U4/U5) |
| `/matches/[id]` | Scheduled/live/final distinction, logistics, imports, box scores | Group Overview / Availability / Games / Scouting; persistent result feedback; show full team names on narrow screens |
| `/leaders` | Weekly award readiness, top-five expansion, viewer pinning, tie rules | Metric/category navigation and common data-scope explanation (U6/A2) |
| `/meta` | Validated games, sample thresholds, signature players | Search/all-heroes view, sortable metrics, included-game denominator (U6/A2) |
| `/fantasy` | Cap, lock state, stored rosters, standings and archive support | Add candidate search and a persistent selection/budget summary in the unlocked picker; keep scoring and locks unchanged |
| `/pickem` | Hidden pre-lock splits, deadlines, saved-choice state, archive support | Make “picks remaining” and next deadline prominent; preserve server-side locking and selection persistence |
| `/records` | All-time scope and source-match links | Add category navigation and explanatory metric labels; retain record chronology and ties |
| `/hall-of-fame` | Career/champion distinction and history links | Add a player lookup and more direct career comparison; optimize shared career rollups (E3) |
| `/recap` | Champion integrity, award provenance, archive links | Clearly separate in-progress awards from final recap; provide compact award navigation |
| `/seasons` | Public history with admin-only export/reactivate/delete controls | Show current/archived status prominently; preserve all reactivation and deletion safeguards |
| `/seasons/[id]` | Season-scoped statistics, bracket, results, rosters, fallback states | Add section navigation and collapsible weeks; never make historical actions look current |
| `/inhouse` | Independent queue, room state, Elo/Cred distinction, recovery/status handling | Keep immediate queue/room work first and explanatory detail expandable; consolidate full-history reads (E3) |
| `/inhouse/history` | Existing bounded/paginated archive | Add player/date filtering if usage warrants it; preserve deterministic pagination |
| `/news` | Pinned posts, timestamps, permalink, media fallbacks | Paginate older content and preserve direct post links (E4) |
| `/features` | Feature tour and lifecycle explanations | Add a short task-based quick start above the tour; measured phone page is about 9,599px tall |
| `/scrims` | Practice separation, captain booking, coach limitations, season selector | Reject invalid scope; put availability ahead of history/stats; add paging (U8/E4) |
| `/scrims/[id]` | Guest roster, import controls, booked/live/final state | Make lineup readiness and who must act clear; use persistent form feedback and keep guest changes outside league registration |
| `/admin` | Existing guarded actions, status checks, recovery and logs | Operational overview, navigable sections, query reduction, integration triage (A1–A3/E1/U4) |

Shared shell/recovery: the skip link, phase-aware nav, Explore menu, global loading state, error boundaries, and missing-page recovery already exist. Add route-specific skeletons only where measurements show a meaningful wait; do not replace working live-room recovery with a generic spinner.

## How to protect the current season during implementation

1. **Start with presentation and reads.** Do not change season IDs/status, rosters, auction rules, score math, lock deadlines, scheduling, result ownership, or schema in the first release.
2. **Reuse authoritative policies.** UI summaries must call the same lifecycle/readiness helpers as existing controls. Keep authorization and write-time guards on the server. A disabled button is not a mutation guard.
3. **Keep fixtures isolated.** Continue using dedicated SQLite browser databases. Never seed, reset, or point destructive test helpers at the running season. Test Discord delivery only in an isolated server/channel with explicit authorization.
4. **Verify each affected user flow.** Cover spectator, member, captain, and admin; at least 360px and desktop; successful and failed form submission; return navigation; and a page held open while data changes.
5. **Use targeted regression gates.** For display/query changes: typecheck, relevant unit tests, midseason browser tests, and result/caching equivalence checks. For any future lifecycle/concurrency change: add the appropriate Postgres raced integration tests and mutation guard checks. SQLite passing does not prove Postgres race safety.
6. **Keep changes independently reversible.** Ship small application changes with a known previous deployment. Query reductions and layout changes should need no data rollback. A later migration requires the repository's existing guarded release/backup procedure.
7. **Measure before promising speed gains.** Compare production-like builds and large fixtures for time-to-main-content, query count/volume, JavaScript cost, and interaction latency. Development compilation timings are not production performance measurements.

## Verification record

| Check | Result |
| --- | --- |
| Route inventory | 27 page routes |
| Desktop/phone observations | 62 completed; no detected body overflow or error overlay |
| Schedule filter reload | Reproduced loss of team selection |
| Admin Discord jump | Reproduced closed section and obscured heading |
| Invalid Scrims season | Reproduced silent fallback to current season |
| Unit tests | 168 files / 2,190 tests passed |
| TypeScript | `npx tsc --noEmit --incremental false` passed |
| Midseason Playwright suite | 38 passed initially; all five initially blocked admin tests passed on the configuration-corrected rerun |
| Production/provider delivery/Postgres race validation | Not run; no production writes or deployment |

The initial admin failures were a test-environment mismatch: the audit server had an explicit single-account administrator allowlist, while the browser suite creates different local administrator accounts. Those accounts correctly received “Admin access required.” Restarting only the isolated local server with the suite's intended development admin configuration resolved all five checks. No application authorization code was changed. The successful rerun covered typed confirmation, Enter-key protection, cancellation/reopening of confirmation dialogs, 360px admin layout, and partial-score rejection followed by a reversible no-game ruling.

Regression evidence: [initial midseason run](audit-2026-09-04/midseason-tests.log), [corrected admin rerun](audit-2026-09-04/midseason-rerun.log), [unit-test summary](audit-2026-09-04/unit-test-summary.txt).

Suggested sequence after the first release: statistics exploration and integration triage, then paginated history and measured cache work. Structural extraction of the large admin/home/profile files should follow stable user-facing changes, with the existing action/service interfaces preserved.
