# GGD2L product audit

Started 2026-08-03. This is the working map and iteration log for the
page-by-page UI, UX, functionality, and architecture audit. The implementation
map in `docs/ARCHITECTURE.md` remains the detailed source-level companion; this
document records product purpose, audit order, findings, and verification.

## Product and actors

GGD2L supports two related but independent products:

1. A phase-based amateur Dota 2 league: signup, captain selection, live auction
   draft, weekly round robin, playoffs, final, archive, and offseason.
2. A year-round inhouse queue with ready check, captain vote, player draft,
   game result detection, Elo, and play-money betting.

The primary actors are:

- **Visitor** — understands the league, follows teams/results, watches a draft,
  and decides whether to join.
- **Authenticated member** — owns a Steam-backed profile, may link Discord,
  and may refresh OpenDota metadata for the Dota identity derived from their
  verified Steam account. Arbitrary self-claimed Dota accounts are not
  accepted.
- **Registered player** — joins the player pool, confirms draft availability,
  is drafted or remains a free agent, checks in, and plays matches.
- **Standin** — offers match-night cover without joining the main draft pool.
- **Captain** — drafts a roster, manages availability/standins/reschedules, and
  can report match data.
- **Administrator** — creates and configures seasons, reviews eligibility,
  selects captains, controls phases/draft/schedule/results/playoffs, handles
  recovery, notifications, security, exports, and archives.

`User.role` only stores `USER | ADMIN`; captaincy is derived from
`Team.captainId` and `TeamMember.isCaptain`. Player and standin participation is
stored per season in `Registration`.

## State machines and lifecycle

### League

`SIGNUPS → DRAFT → REGULAR_SEASON → PLAYOFFS → COMPLETE → archive
(isActive=false) → OFFSEASON → new SIGNUPS`

- `Season.status` controls the chapter shown in navigation and on the home
  page. `Season.isActive` identifies the one current season.
- The DRAFT chapter contains its own auction state:
  `NOT_STARTED → IN_PROGRESS ↔ PAUSED → COMPLETE`.
- Match state is `SCHEDULED → LIVE → COMPLETED`; match phase is
  `REGULAR | PLAYOFF | FINAL`.
- Registration state is `ACTIVE | WITHDRAWN | REMOVED`; type is
  `PLAYER | STANDIN`.
- Phase changes are administrator actions. The auction and playoff services do
  not implicitly perform every chapter transition; UI copy must distinguish a
  league chapter from the state of its nested workflow.
- OFFSEASON is not a `Season.status`; it is the intentional absence of an
  active Season. Reactivating an archive restores its saved phase, while an
  unfinished cancellation preserves that phase and its data for review.

### Inhouse

`queue → READY_CHECK → CAPTAIN_VOTE → DRAFTING → READY → IN_PROGRESS →
COMPLETED | CANCELLED`

The inhouse lifecycle is season-independent and shares only the `User` table
with the main league.

## Page map

| Route              | Primary purpose                                                            | Main actors / gating                                                      |
| ------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `/`                | Phase-aware league dashboard and next action                               | Everyone; five league views plus offseason                                |
| `/login`           | Steam sign-in and local-only dev sign-in                                   | Signed-out visitors                                                       |
| `/me`              | Identity, account links, signup/withdrawal, readiness, personal match work | Signed-in users                                                           |
| `/players`         | Signup pool, filters, scouting, roster state                               | Everyone; especially captains/admins                                      |
| `/players/[id]`    | Public league and inhouse player profile                                   | Everyone                                                                  |
| `/players/compare` | Two-player career comparison                                               | Everyone                                                                  |
| `/teams`           | Team index, draft recap, form and power rankings                           | Nav from DRAFT                                                            |
| `/teams/[id]`      | Roster, spend, fixtures, scenarios, scouting                               | Everyone; archived teams supported                                        |
| `/draft`           | Live auction room and waiting/recovery states                              | Everyone watches; captains/admins act                                     |
| `/schedule`        | Fixtures, standings, check-ins, bracket, grid                              | Nav from DRAFT; phase-aware interaction                                   |
| `/matches/[id]`    | Preview, RSVP, cover/reschedule, reporting, box score                      | Everyone; player/captain/admin actions gated                              |
| `/leaders`         | League stat boards and weekly honors                                       | Nav from REGULAR_SEASON                                                   |
| `/meta`            | Hero pick/win meta                                                         | Nav from REGULAR_SEASON                                                   |
| `/fantasy`         | Fantasy-five entry, final fives, scoring, and standings                    | Everyone views; signed-in users pick after the auction until first import |
| `/pickem`          | Match predictions, locked/void-pick review, and oracle standings           | Everyone views; signed-in users pick after the auction until each lock    |
| `/records`         | All-time single-game records                                               | Everyone                                                                  |
| `/hall-of-fame`    | Cross-season careers and champions                                         | Everyone                                                                  |
| `/recap`           | Completed-season awards and superlatives                                   | Nav on COMPLETE; archived season query supported                          |
| `/seasons`         | Season history, export/reactivate/delete controls                          | Everyone; admin actions gated                                             |
| `/seasons/[id]`    | Archived standings, bracket, rosters, results                              | Everyone                                                                  |
| `/inhouse`         | Queue, room state machine, ladders, recent results                         | Everyone watches; signed-in users act                                     |
| `/inhouse/history` | Completed inhouse archive                                                  | Everyone                                                                  |
| `/news`            | Administrator announcements                                                | Everyone                                                                  |
| `/features`        | Static product/lifecycle tour                                              | Everyone                                                                  |
| `/admin`           | League operations and recovery console                                     | Admin only                                                                |

App-level states are `layout.tsx`, `loading.tsx`, `error.tsx`,
`global-error.tsx`, and `not-found.tsx`, plus metadata, manifest, robots, and
sitemap files.

## Mutation and API map

Server actions are grouped by workflow:

- `registration`, `availability`, `standins`, `reschedule`, and `match-report`
  cover the player/captain match lifecycle.
- `admin` covers seasons, phases, captains, draft configuration, schedules,
  results, playoffs, Discord, security, exports, and recovery.
- `fantasy`, `pickem`, and `news` cover engagement/content.
- `inhouse-admin` and `inhouse-bets` cover the independent inhouse product.

Route handlers:

- Steam, Discord, dev-login, and logout authentication routes.
- Draft polling/nomination/bidding/admin nomination routes.
- One inhouse action-dispatch route.
- Calendar feed, automatic sync heartbeat, and admin season export.

There is no websocket or cron worker. Draft/inhouse clocks and automatic result
work resolve lazily on reads. `ResultSyncPing` and optional external requests to
`GET /api/sync` provide the background heartbeat.

## Data map

The 25 Prisma models fall into these aggregates:

- Identity/content: `User`, `NewsPost`.
- Season/draft: `Season`, `Registration`, `Team`, `TeamMember`, `Draft`, `Bid`.
- Match night/results: `Match`, `Game`, `MatchAvailability`,
  `StandinAssignment`, `RescheduleRequest`.
- Engagement: `FantasyRoster`, `FantasyPick`, `Prediction`.
- Inhouse: `InhouseQueueEntry`, `InhouseLobby`, `InhouseLobbyPlayer`,
  `InhouseBet`, `InhouseCredit`, `InhouseCreditEntry`,
  `InhouseAnnouncement`.
- Operations: `Setting`, `AdminAction`.

SQLite is used locally and in the default test suites. Production changes the
Prisma provider to Postgres during deployment, so concurrency-sensitive writes
also require the Postgres integration suite and mutation guard when available.

## Shared UI and architecture

- Root shell: `SiteHeader`, `SiteFooter`, `Toaster`, `ResultSyncPing`.
- UI kit: buttons, cards, badges, avatars, team crests, player links, headings,
  loading skeletons, empty states, stats, progress, and link helpers in
  `src/components/ui.tsx`.
- Workflow leaves: draft room, inhouse room, player pool, check-in banner,
  schedule weeks, bracket, fantasy picker, match import controls, and shared
  action forms.
- Pure policy/math lives in `src/lib/*.ts` with sibling tests. Transactional DB
  work lives in `*-service.ts`. Server actions and API handlers are thin auth,
  parsing, delegation, feedback, notification, and revalidation layers.
- Standings, scenarios, awards, records, power rankings, hero meta, and Elo are
  derived from source rows. Expensive game scans use tagged cached queries.

## External systems

- **Steam OpenID / Steam Web API** — login and public profile identity.
- **OpenDota** — rank/public-match state, scouting data, league/inhouse game
  detection, and box scores.
- **Discord OAuth, bot API, and webhooks** — verified account link, guild/role
  setup, player/captain mentions, league announcements, and the inhouse board.
- **Vercel + Neon Postgres** — documented production deployment path.
- **External uptime monitor** — optional `/api/sync` heartbeat; operationally
  important when the Discord inhouse board is enabled.

## Controlled audit order

Each item is completed and reported before the next begins.

1. **Global shell and phase-aware dashboard** — navigation, orientation,
   offseason, all five league phases, loading/error/not-found states.
2. **Identity and onboarding** — login/logout/session expiry, Steam safety,
   `/me`, Dota/OpenDota and Discord linking, return paths.
3. **Season creation and signup** — admin setup, eligibility, questionnaire,
   player/standin states, pool discovery, capacity and readiness.
4. **Captain selection and draft readiness** — captain tools, budgets, draft
   night confirmation, safe start/abort/reverse paths.
5. **Live auction draft, teams, and roster maintenance** — spectator/captain/
   admin views, polling, clocks, bidding constraints, disconnect/race/recovery/
   mobile states, team pages, free agents, releases, handovers, promotion, and
   withdrawn teams.
6. **Regular-season match night** — schedule, calendar, RSVP, reminders,
   standins, reschedules, direct-access and permission states.
7. **Results and statistics source of truth** — captain/admin reporting,
   OpenDota imports, automatic/league sync, correction/reopen/forfeit paths.
8. **Standings, playoffs, final, and champion** — tiebreak visibility,
   scenarios, seeding, bracket advancement/reset, phase reversal, integrity.
9. **Engagement side games** — Fantasy and Pick'em entry, privacy, locking,
   scoring/grading, final boards, and archive behavior.
10. **Public statistics and content discovery** — leaders, meta, records,
    comparison, news, features, sharing/SEO.
11. **Completion, archive, and offseason** — recap, season history/export,
    reactivation/deletion, Hall of Fame, new-season handoff.
12. **Inhouse lifecycle** — queue through result, presence, recovery, Elo,
    Cred betting/settlement, history, Discord board.
13. **Cross-cutting operations** — final role/phase matrix, accessibility,
    responsive sweep, performance/caching, rate limits, security headers,
    audit logs, backup/restore and production-only Postgres risks.

## Iteration 1 — global shell and phase-aware dashboard

Status: complete on 2026-08-03. The audit stops here before beginning the next
section, as required by the controlled loop.

Purpose: give every actor an honest current-season overview and the next useful
action, while the root shell keeps location, phase, navigation, loading, and
failure recovery understandable on every route.

Confirmed findings before changes:

- The home page claimed “Captains are bidding” for every DRAFT-phase season,
  including an auction whose `Draft.status` was `NOT_STARTED`.
- Dashboard cards used `h3` immediately after the season `h1` in draft,
  regular-season, playoff, and complete views.
- `app/error.tsx` used the older `reset` recovery behavior even though this
  Next 16 version documents `unstable_retry` for re-fetching recovery; errors
  thrown by the root layout had no `global-error.tsx` fallback.
- The unexpected-error UI displayed `error.message`; expected user errors
  already have action/empty-state handling, so the boundary should not expose
  implementation details.
- The no-active-season copy promised a new season “shortly,” could call a new
  season the “first” despite archives, and did not link to the latest season.
- Internal pages required a footer scroll or the phone menu to recover current
  league phase context.
- Standalone phone header controls were smaller than the app's existing 44px
  mobile control convention; footer links lacked the shared focus treatment.
- A public engineering-metrics footnote (code lines/tests/commits) did not help
  visitors, players, captains, or administrators run or understand the league.

### Changes made

- The home snapshot now reads the nested `Draft.status`. A shared presentation
  helper gives `NOT_STARTED`, `IN_PROGRESS`, `PAUSED`, and `COMPLETE` distinct
  badges, explanations, actions, roster labels, and live-indicator behavior.
  A missing/unknown draft row safely renders as setup rather than live play.
- Dashboard card headings can opt into `h2`; every top-level dashboard section
  now does so while nested cards retain the UI kit's `h3` default.
- Offseason copy is non-promissory, distinguishes a first season from a league
  with history, links to the latest archived season, and gives administrators
  an accurate “Create a season” action.
- Internal desktop/tablet pages show a compact linked season-phase badge in the
  existing header. Phones retain that context in the menu without crowding the
  375px header. Header, menu, and footer controls gained consistent keyboard
  focus treatment, and standalone phone controls/menu rows meet 44px targets.
- Route loading is announced as a polite busy status; 404 recovery has a real
  `h1`. Route errors and root-layout errors use the Next 16 refetching retry
  contract, log the underlying exception, show only safe copy plus a digest,
  and provide a standalone `global-error.tsx` document for shell query failure.
- The public code/test/commit counter was removed because it did not help any
  league actor understand or run the competition. Its now-unused generator,
  tracked JSON, test, local build hook, and Vercel build hook were removed with
  it; the rest of the dashboard replaces that space with league content.

### Architecture improvements

- Auction-substate copy is centralized and unit-tested instead of being
  inferred from the broader season chapter in JSX.
- `CardHeader` gained an additive, typed `headingLevel` API so callers can
  preserve component reuse without sacrificing document hierarchy.
- Root-layout failure recovery is separated from route-level recovery, matching
  this repository's Next 16 file-convention documentation.
- The obsolete build-time project-metrics pipeline no longer adds production
  build I/O or maintains data with no runtime consumer.

### Tests and verification

Tests added or updated:

- Draft presentation unit coverage for all four auction states plus missing and
  unknown state fallback.
- Shell source guards for route/root retry behavior, safe error copy, loading
  announcements, and 404 hierarchy.
- Browser coverage for the internal phase link, 44px phone header controls,
  dashboard `h2` structure, and the pre-start DRAFT dashboard.

Commands and results:

- `npm test` — 81 files, 1,235 tests passed.
- `npm run test:integration` — 38 files, 741 passed and 11 skipped.
- `npm run test:e2e` — 22 of 22 passed, including the full signup-to-live-draft
  path and inhouse lifecycle.
- `npm run test:e2e:mid` — 29 passed; the Next dev server restarted for memory
  pressure immediately before the remaining admin-mobile navigation and that
  test timed out. The exact test was rerun alone and passed in 9.6 seconds.
- `npm run lint` — exited 0 with no errors; 60 existing warnings remain outside
  this section.
- `npx tsc --noEmit` — passed.
- `npm run build` — production build passed; all 36 static/dynamic app entries
  completed page-data generation.
- `npm run test:mutation` and `npm run test:pg` — not runnable because
  `PG_TEST_URL` is not configured. The mutation guard correctly refused SQLite.
- `git diff --check` — passed.

Manual browser verification used seeded signed-out, player, and administrator
states at 1280px and 375px. It covered signup, DRAFT-before-start, regular
season (including an RSVP update), playoffs, completed season, offseason,
internal navigation, mobile menu, 404, and a real missing-database root failure.
Measured document widths matched the viewport in every 375px state; visible
phone header/menu targets were 44px or taller. The root retry action was
exercised and remained available after the repeated database failure.

### Remaining concerns

- Phase visibility in the shell is fixed, but direct-URL interaction policy is
  feature-specific and remains deliberately deferred to the matching workflow
  iterations. No conclusion about every page's phase gate is implied here.
- The full midseason browser run exposed a development-server memory restart.
  The affected assertion passed alone; stabilizing long local browser runs is a
  cross-cutting test-infrastructure concern for iteration 13.
- The repository-wide lint baseline has 60 warnings. None are new findings from
  the changed dashboard/shell code, but they should be reduced in the section
  that owns each file rather than swept into this iteration.
- Postgres race behavior is unverified in this environment. It must remain a
  release gate whenever `PG_TEST_URL` is available, especially for draft,
  match, and phase mutations.

Recommended future improvement: add a compact phase/permission policy matrix
as each feature is audited, then consolidate it during the cross-cutting pass.

Next section: **identity and onboarding** — login/logout/session expiry, Steam
return-path safety, `/me`, and Dota/OpenDota and Discord linking.

## Iteration 2 — identity and onboarding

Status: complete on 2026-08-03. The audit stops here before beginning season
creation and signup.

Purpose: give a visitor one safe, understandable path into a persistent league
identity; let a member maintain the Steam, Dota/OpenDota, and Discord data the
league needs; and make authentication or external-service failures recoverable
without corrupting the profile.

Actors affected: signed-out visitors, authenticated members, registered
players and standins whose captains need to reach/scout them, captains who
depend on accurate contact/rank data, and administrators whose role is resolved
at login. Identity controls are available in every league phase. `/me` remains
signed-in-only on direct access; the signup controls inside it continue to use
their season-phase policy and are the subject of iteration 3.

Confirmed findings before changes:

- `/login` had no `h1`, described Steam only as a way to “join the season”
  even when signups were closed, duplicated the header's Sign in action, and
  presented Discord after an “or” divider even though Discord is community
  coordination rather than an alternative site login.
- Logout silently redirected home. A malformed/opaque `Origin` could throw in
  its same-origin check instead of safely rejecting the request.
- An abandoned Steam round-trip left its return cookie behind. A later login
  without `next` could land on that stale destination; the cookie also lacked
  the production `Secure` option. Steam callback errors discarded the intended
  destination and did not consume the one-shot cookie.
- With no admin allowlist, `user.count() === 0` and the first-user upsert were
  separate writes. Concurrent first logins could both decide they were admin.
- A Discord OAuth round-trip whose site session expired returned through login
  with no explanation. Other Discord and Steam failures exposed deployment
  details to players rather than giving an actionable recovery step.
- `/me` skipped from `h1` to top-level `h3` headings; danger feedback and error
  toasts used polite status semantics. Two OpenDota settings instructions named
  different menu paths.
- `/me` serialized independent season, user, registration, team, Discord, and
  role queries, adding avoidable latency before the page could render.
- Dota medal/private-data writes did not re-assert the account selected before
  an OpenDota request. A relink in another tab could receive the old account's
  rank. The login snapshot fill could also overwrite a newer same-account
  refresh, and changing accounts during an OpenDota outage left the previous
  account's medal/scouting data attached to the new link.
- The inhouse Discord ping-role action was the one profile mutation that let an
  expired session throw through the shared generic network-error fallback.

### Changes made

- `/login` now has a clear `h1`, destination-aware explanation, explicit Steam
  versus Discord roles, keyboard focus treatment, 44px mobile dev controls,
  and no redundant header Sign in button. Logout returns a visible signed-out
  confirmation.
- Logout remains POST-only and same-origin, but safely rejects cross-origin,
  opaque, and malformed origins with 403 instead of throwing.
- Steam login resets stale return intent, sets a secure production cookie, and
  consumes it on every callback exit. Failed and rate-limited callbacks put a
  validated destination on the retry URL so the next attempt still returns to
  the interrupted task.
- Discord session expiry now returns through login to a one-shot `/me` alert
  explaining that the player must retry. Player-facing Steam/Discord errors no
  longer mention secret environment configuration.
- `/me` top-level cards are real `h2` sections, the nested draft commitment is
  `h3`, blocking Dota/Discord notices and error toasts use alert semantics, and
  the public-match-data instructions consistently name the full Dota menu path.
- Dota account transitions are compare-and-set against the override read by
  the action. A changed effective account clears old medal/private/scouting
  data before fetching; an unchanged account preserves valid data through an
  outage. Every later rank and pub-stat write re-asserts the account, and stale
  same-account login fills cannot overwrite a newer snapshot.
- The inhouse ping toggle now returns “Sign in required” on session expiry,
  matching the other profile actions.

### Architecture improvements

- Zero-config admin bootstrap now uses one immutable, atomic
  `bootstrapAdminSteamId` Setting claim inside the user transaction. The
  configured `ADMIN_STEAM_IDS` allowlist remains authoritative, and dev login's
  explicit admin override remains isolated to its existing double gate.
- `/me` resolves independent season/user data together, then registration,
  roster, Discord membership, and role configuration together, followed by
  the two registration-dependent reads together. This removes two query
  waterfalls without changing state ownership or adding a broad refactor.
- The fast Vitest config now resolves the repository's `@/` alias, allowing
  route handlers to have direct unit coverage rather than only browser tests.
- Identity, return-cookie, Dota metadata, and phase behavior are documented in
  `docs/ARCHITECTURE.md` and `CLAUDE.md` beside their source-of-truth rules.

### Tests and verification

Tests added or updated:

- Steam kickoff/callback route tests for safe and unsafe destinations, cookie
  lifecycle and attributes, retry preservation, and rate-limit behavior.
- Logout route tests for 303 confirmation, cross-origin rejection, and opaque
  origin handling.
- Integration races for atomic first-admin selection, login rank writes,
  `/me` relink/refresh writes, newer pub snapshots, old-account metadata
  clearing, unchanged-account outage preservation, and expired ping-role
  sessions.
- Session tests now assert cookie protections and live database role lookup.
- Discord callback coverage pins the expired-session explanation return path.
- Browser coverage checks signed-out `/me`, login hierarchy/copy, absence of a
  duplicate header CTA, logout confirmation, `/me` heading structure, 375px
  bounds, and the Dota-link workflow.

Commands and results:

- `npm test` — 84 files, 1,244 tests passed.
- `npm run test:integration` — 38 files, 750 passed and 11 skipped.
- `npm run test:e2e` — 24 of 24 passed. The final Dota-link implementation was
  rerun directly afterward and passed.
- `npm run test:e2e:mid` — 29 passed; the dev server restarted for its known
  memory threshold immediately before the admin-mobile test, which timed out
  during navigation. That exact test was rerun alone and passed in 10 seconds.
- `npm run lint` — exited 0 with no errors; the same 60 existing warnings
  remain outside this iteration.
- `npx tsc --noEmit` — passed.
- `npm run build` — production build passed; all 36 static/dynamic app entries
  completed page-data generation.
- `npm run test:pg` and `npm run test:mutation` — correctly refused to run
  because `PG_TEST_URL` is not configured; Postgres contention remains
  unverified in this environment.
- `git diff --check` — passed.

Manual browser verification at 375px covered signed-out `/me`, contextual
login, dev sign-in, all profile sections, invalid Dota input retention and
accessible error announcement, expired Discord-link feedback, mobile menu
logout, confirmation, and horizontal overflow. Real Steam and Discord consent
could not be completed without external credentials/account interaction; their
callback, state, collision, membership, and failure branches are covered by
unit/integration tests.

### Remaining concerns

- Production Postgres must run the bootstrap and metadata race tests before
  release; SQLite only verifies the sequential invariant.
- Steam/Discord callback rate limiting is per warm process, not distributed.
  A shared limiter remains a production hardening item for iteration 13.
- Session epoch revocation can take up to its documented 30-second warm-instance
  cache TTL to propagate.
- Manually entering a Dota account cannot prove ownership; the application can
  prevent duplicate league claims, but only a future Valve-backed proof flow
  could establish ownership.
- A configured live Discord membership lookup can still hold `/me` for the
  integration's bounded timeout. Query parallelization reduces the waterfall;
  streaming or a separately refreshed membership card is a future performance
  option if production traces show this is noticeable.
- The long midseason dev-browser suite still crosses Next's memory restart
  threshold. The isolated affected test passes; runner stabilization remains a
  cross-cutting test-infrastructure concern.

Recommended future improvements: add distributed unauthenticated rate limits,
production OAuth smoke checks in a credentialed staging environment, and
profile streaming only if measured Discord latency justifies the complexity.

Next section: **season creation and signup** — admin setup, eligibility,
questionnaire, player/standin states, pool discovery, capacity, and readiness.

## Iteration 3 — season creation and signup

Status: complete on 2026-08-03. The audit stops here before beginning captain
selection and draft operations.

Purpose: let an administrator open one well-defined active season; let eligible
members register as full players or standins with useful scouting and contact
context; let prospects and captains understand the pool; and let both players
and administrators safely correct or close a registration without corrupting
the auction or historical season record.

Actors affected: prospective and returning players, standins, captain
volunteers, captains/drafters scouting the pool, administrators creating and
reviewing the season, removed members who need a clear recovery path, and
visitors browsing `/players` or public profiles.

Lifecycle and data flow confirmed before changes:

- `/admin` creates the `Season`, archives the previous active season, and sets
  signup-facing values including the soft MMR review limit, roster size, team
  floor, draft budget/night, and match-night description.
- `/me` owns the `Registration` questionnaire and writes type, claimed MMR,
  roles, heroes, availability, statement, public captain note, and captain
  interest. It also shows draft-schedule acknowledgement keyed to
  `Season.draftRevision` and `draftAt`.
- `/players`, `/players/[id]`, the dashboard, and the draft state consume active
  registration data. New full-player admissions notify Discord. Admin review
  can correct MMR, remove/reinstate a row, and sync Steam/OpenDota metadata.
- The pool is intentionally uncapped: `minTeams` is an operational floor, not
  an admission limit. Full-player admission closes after SIGNUPS; standins
  remain useful through DRAFT, REGULAR_SEASON, and PLAYOFFS; COMPLETE is now a
  frozen historical record.

### Problems found

- A duplicated or stale Create season form could archive the season created by
  the first submission and create another active season. A blank name silently
  became “New Season,” hiding an operator mistake.
- COMPLETE still accepted new standins, registration edits, and self-withdrawal.
  Direct action calls therefore disagreed with the season being historical.
- A REMOVED member saw generic Join season actions on the dashboard and player
  pool even though the server correctly refused them. `/me` still rendered an
  editable form that could only fail.
- Concurrent first signup submissions converged to one row but both believed
  they created it, so both could announce the same player to Discord.
- The initial signup's OpenDota rank fetch could write an old account's medal
  after another tab relinked the user. This was the same stale-response class
  fixed for profile linking in iteration 2, but the signup path had its own
  writer.
- Standins stored an irrelevant captain-volunteer flag. Full players could
  silently change that flag after the volunteer window had closed.
- Admin reinstate and MMR correction used separate reads and writes. A changed
  registration could be overwritten, and a direct action call could inject or
  alter a full player while the auction was live or paused. Reinstate also
  remained available against a completed season.
- Draft-night and draft-settings actions hid controls after auction start but
  did not re-check that state atomically in the server mutation. A direct or
  stale submission could race the start.
- The soft MMR field accepted values above the league's hard 5,000 ceiling, and
  both that field and the public match-night description saved with no visible
  success confirmation.
- “Note for captains / drafters” was described as captain-only even though it
  is intentionally rendered on public profiles and in the public pool. That
  ambiguity could encourage a player to enter private contact information.

### Changes made

- Create season now requires a nonblank name and carries the active-season id
  seen by the form. One Serializable transaction re-checks that exact id,
  archives it, and creates the replacement; a replay, stale tab, or transaction
  conflict returns an explicit reload message instead of changing seasons.
- A shared completed-season gate freezes every registration type. The page and
  actions use the same policy; COMPLETE shows a read-only explanation and no
  edit/withdraw form.
- REMOVED is now a first-class profile state with a Removed badge, an admin
  contact explanation, and no impossible form. Dashboard and pool actions say
  “Signup removed — see details” and never invite that member to rejoin.
- First signup uses create-and-claim semantics. Only the transaction that
  actually creates the row sends the Discord announcement; a losing duplicate
  safely rereads/updates the single registration.
- The initial rank write compare-and-sets the exact Dota account read before
  the network call. A relink wins, and the stale medal is discarded.
- Captain interest is stored only for full players during SIGNUPS. Later edits
  preserve the prior answer, and standins always store false. `/me` explains
  both constraints at the control.
- Reinstate and admin MMR correction now re-read and claim the active season,
  row status/type, and draft state in Serializable transactions. Full-player
  writes are refused during IN_PROGRESS/PAUSED auctions; standin corrections
  remain available through playoffs; COMPLETE remains read-only.
- Draft-night and draft-settings writes now lock/re-check the pre-start draft
  state transactionally, closing the direct-action and start-race gaps.
- The soft MMR setting is capped at the hard 5,000 ceiling. It and the public
  match schedule now use the shared action/toast feedback contract.
- The captain note is explicitly labeled public and warns against private
  contact details. Its existing pool/profile/draft behavior was preserved
  because it supports scouting and draft preparation.

### Architecture improvements

- Phase policy is centralized in `registrationSeasonClosedError` and
  `registrationGate`, so rendered controls and replayed server actions share
  one COMPLETE/standin/full-player rule.
- Registration creation separates “created this row” from “successfully ended
  with this row,” making external notification exactly-once relative to the
  application's accepted database claim.
- Season replacement, registration review, and draft scheduling use typed
  conflict errors around Serializable transactions rather than read-then-write
  assumptions. Race seams make the critical rechecks deterministic in tests.
- Admin setting mutations now conform to the existing `ActionResult` /
  `ActionForm` contract instead of silently succeeding.
- `docs/ARCHITECTURE.md` now records public questionnaire visibility, exact
  signup phase policy, live-auction review locks, and stale-form season
  replacement semantics.

### Tests and verification

Tests added or updated:

- Pure registration-gate coverage for every COMPLETE creation/edit case.
- Integration coverage for duplicate first submissions and single Discord
  notification; Dota-relink/rank races; standin and late captain-preference
  normalization; COMPLETE create/edit/withdraw refusal; replayed and blank
  season creation; admin reinstate/MMR races and live-auction locks; draft-night
  post-start locking; soft-MMR clamping; and visible setting feedback.
- Existing browser coverage exercised signup, profile responsiveness, draft
  acknowledgement, administrator readiness visibility, and connected
  draft/regular-season pages. Manual browser scenarios added REMOVED,
  COMPLETE, stale two-tab season creation, and the updated feedback/copy.

Commands and results:

- `npx vitest run src/lib/registration.test.ts` — 38 passed.
- Targeted integration run (`registration`, `draft-readiness`,
  `season-delete`, `admin-flow-audit`) — 112 passed.
- `npm test` — 84 files, 1,245 tests passed.
- `npm run test:integration` — 38 files, 763 passed and 11 skipped.
- `npm run test:e2e` — 24 of 24 passed, including phone profile layout,
  signup, Dota linking, draft acknowledgement, permission redirects, and the
  complete browser auction lifecycle.
- `npm run test:e2e:mid` — 29 passed; after Next restarted at its known memory
  threshold, the admin-mobile navigation timed out before its assertion. The
  exact test was rerun alone on a fresh fixture and passed in 7.2 seconds.
- `npm run lint` — exited 0 with no errors; the existing 60-warning baseline
  remains.
- `npx tsc --noEmit` — passed.
- `npm run build` — production build passed; all 36 app entries completed
  page-data generation.
- `npm run test:mutation` — correctly refused SQLite because `PG_TEST_URL` is
  not configured; the Postgres mutation ratchet was not claimed as passing.
- `git diff --check` — passed.

Manual browser verification used a seeded signup fixture and real server
actions. It covered a new full-player signup; public pool discovery; admin
removal; the removed member's dashboard, pool, and `/me` states; a new member
against COMPLETE; draft-schedule confirmation; success feedback for soft MMR
and match schedule; and two already-rendered admin tabs replaying Create season.
The replay was refused and the database retained exactly one active replacement
season. Desktop layout was inspected directly; the automated suites verify
375/360px profile, player-pool, admin, dashboard, and schedule bounds because
the in-app browser's viewport capability did not reflect its requested width.

### Remaining concerns

- The active-season uniqueness invariant is application-enforced because the
  SQLite schema cannot express the needed partial unique index. Serializable
  replacement plus the expected id protects normal writes, but the Postgres
  tests and mutation ratchet remain release gates when `PG_TEST_URL` is
  available.
- Exactly-once here means one Discord attempt by the winning database creator;
  it does not provide a durable outbox. A process crash after commit and before
  delivery can still lose the notification, while an ambiguous external
  timeout can still make delivery unknowable. A transactional notification
  outbox is the durable future design if league operations require it.
- Real Steam, OpenDota, and Discord outages were not forced through live
  credentials in the browser. Network failures and stale responses are covered
  by mocked route/action and integration tests.
- An empty/very sparse questionnaire is still accepted by design. Roles and
  availability may eventually need a minimum completeness rule, but that
  should be based on captain/admin operating evidence rather than an arbitrary
  form requirement.
- Reversing broad league phases, Discord phase notifications, captain
  designation, budget generation, draft start/abort, and auction recovery are
  intentionally not claimed by this section.
- The long midseason development-browser suite still crosses Next's memory
  restart threshold. The isolated admin-mobile test passes; runner
  stabilization remains a cross-cutting test-infrastructure concern.

Recommended future improvements: add a durable Discord notification outbox if
missed announcements become operationally costly; add a Postgres partial unique
constraint for the active season if production migrations permit it; and use
real captain feedback to decide whether questionnaire completeness should be a
gate or only a review warning.

Next section: **captain selection and draft readiness** — captain designation
and transfer, team creation, draft order and weighted budgets, readiness
roll-up, start/abort safeguards, and the administrator's preflight view.

## Iteration 4 — captain selection and draft readiness

Status: complete on 2026-08-03. The audit stops here before beginning the live
auction room and its clock/bid/recovery loop.

Purpose: turn eligible full-player signups into an understandable captain field
and empty teams; communicate the scheduled draft night and collect advisory
player commitments; show the exact seat, order, reachability, and budget state
an administrator is about to lock; start one coherent auction snapshot; and
support safe post-draft captain handover without corrupting roster authority.

Actors affected: captain volunteers and designated captains, every registered
full player asked to acknowledge draft night, administrators selecting and
ordering captains, players and visitors scouting `/players` and `/teams`, and
spectators entering the pre-auction `/draft` waiting room.

Lifecycle and dependencies confirmed before changes:

- Captaincy is not a global role. `Team.captainId` is the operational authority
  and `TeamMember.isCaptain` is a denormalized roster flag; designation also
  creates the captain's empty `Team` and member row.
- Setup legitimately spans both SIGNUPS and DRAFT while `Draft.status` is
  missing/NOT_STARTED. Registration admission still closes at DRAFT, but an
  existing full player must be able to review/reconfirm a changed draft night.
- Readiness is tied to the exact `Season.draftRevision`, `draftAt`, active
  PLAYER registration, and active season. It is advisory rather than a Start
  gate.
- Starting reads `Season`, `Draft`, active PLAYER registrations, captain MMRs,
  teams, team members, order, results, and games; it creates/claims the Draft
  row, stores weighted starting budgets, selects the opening nominator, and
  moves the broad season chapter to DRAFT.
- Public waiting-room and team budget displays consume the same team/registration
  data, but before Start the stored `Team.budget` is still only the flat base.
- Discord is best-effort for schedule, designation, handover, and Start
  announcements. Admin actions are also appended to `AdminAction`.

### Problems found

- Add/remove/randomize/settings/night/Start relied on reads outside their
  transactions and did not share one phase rule. A stale or direct action could
  mutate REGULAR_SEASON, PLAYOFFS, or COMPLETE when no Draft row existed, and a
  setup mutation could cross Start's snapshot.
- Start had no expected-season token and calculated teams, settings, MMRs,
  order, pool, and budgets before its transaction. A replacement season or
  concurrent captain/settings/player write could therefore seed a mixed
  auction state.
- Two captain authorities could diverge. Concurrent handovers could leave
  multiple `isCaptain` flags, and release could delete a player who had just
  become `Team.captainId`.
- DRAFT/NOT_STARTED was a supported waiting room, but `/me` hid commitment and
  the action refused reconfirmation there. An admin could reschedule, make every
  prior acknowledgement stale, and leave players no recovery path.
- COMPLETE with no Draft row still rendered and accepted captain setup in the
  browser baseline. Live/paused screens rendered a handover control the action
  refused. Randomize remained actionable with fewer than two teams, while
  Start omitted the zero-pool blocker.
- A later-season roster could be mistaken for a fresh auction after an admin
  reversed the broad phase. Start would preserve those non-captain members in
  its snapshot, and Abort would later classify/remove them as draft purchases.
- `/players` inferred auction lifecycle from broad phase/team presence. The
  first designated captain prematurely created “Drafted / Free agents” filters;
  captain hopefuls persisted during live/completed DRAFT; completed auctions
  could still look like signup.
- Public prestart budget chips showed the stored flat budget while admin's
  projection and Start used MMR weighting.
- Dashboard “Ready to draft” and “Teams ready” labels described only player
  capacity, not captain/order/schedule/readiness. A signed-up player's stale or
  missing commitment was discoverable only on `/me`.
- The Discord reschedule message did not say confirmations expired or link the
  reconfirmation screen; clearing draft night sent nothing. A newly designated
  or replacement captain received no direct operational notice.
- COMPLETE still exposed signup/standin moderation controls inside the captain
  card, and direct `withdrawSignup` could remove a historical registration even
  though reinstate/MMR were already locked.
- The captain card's top-level and nested heading levels skipped parts of the
  document outline.

### Changes made

- Added a shared `draftSetupOpen` capability for SIGNUPS or DRAFT plus
  missing/NOT_STARTED Draft, a separate post-auction `captainTransferOpen`
  policy, phase-correct lock explanations, and shared seat-plan math.
- Captain designation/removal, order randomization, settings, draft night, and
  Start now carry the rendered active-season id and perform authoritative
  phase/Draft/team/registration/order reads inside Serializable transactions.
  Typed conflicts return a reload/retry explanation rather than a Prisma or
  network-looking failure.
- Start now validates at least two captains, a nonempty pool, unique draft
  order, exactly one captain member matching each `Team.captainId`, active
  PLAYER captain registrations, no prior results/games, and captain-only teams.
  It calculates weighted budgets, claims/creates the Draft row, writes budgets,
  and moves the phase from the same transaction snapshot. The admin preflight
  mirrors every blocker and separately labels advisory target size, seat fit,
  schedule, and commitments.
- Handover compare-and-sets the expected current `Team.captainId`, verifies the
  incoming member and registration, clears every old captain flag on that team,
  and promotes exactly one replacement atomically. `releasePlayer` now refuses
  both a captain flag and the authoritative Team captain id at its write.
- `/me` and the readiness action support DRAFT/NOT_STARTED, carry the expected
  season id, and keep revision/time/status claims atomic. Captain-specific
  Discord copy now speaks to the captain rather than telling them to contact
  “your captain.” The dashboard shows ready/awaiting/stale commitment with a
  direct review/reconfirm action.
- The admin card hides setup during live/paused/complete/later phases, hides
  handover live/paused and in COMPLETE, disables meaningless randomization,
  labels projected budgets, explains every unavailable Start, and presents
  COMPLETE as fully read-only. Historical signup removal is now refused in the
  action as well as hidden in the UI.
- `/players` now derives explicit captain-selection, live/paused auction,
  draft-complete, and season states from `Draft.status`. Captain hopefuls and
  “Wants captain” remain setup-only; auction filters appear only after the
  auction begins; pool titles, availability counts, and empty copy follow the
  real lifecycle.
- Added one shared budget-display policy that uses Start's exact MMR weighting
  before Start and stored remaining budget afterward. `/draft`, `/teams`, and
  `/teams/[id]` now agree and visibly mark prestart values “projected.”
- Capacity-only dashboard claims now say “Player minimum met” and “Full teams
  possible,” leaving operational readiness to the real admin preflight.
- Discord distinguishes initial scheduling, rescheduling, and cancellation.
  Reschedules explicitly expire prior confirmations and link `/me`; designation
  and handover ping the new captain when a verified Discord id is available.
- Captain/admin heading hierarchy now follows h1 → card h2 → subsection h3 →
  nested list h4. A dedicated phone test protects the full admin preflight from
  horizontal overflow.

### Architecture improvements

- `src/lib/draft-setup.ts` is the single capability boundary shared by server
  actions, `/admin`, and `/me`; broad phase and nested Draft state are no longer
  reinterpreted independently in each surface.
- `src/lib/draft-budgets.ts` centralizes prestart projection versus post-start
  stored-budget authority. The waiting room, team index/detail, and the Start
  mutation use the same floor and unknown-MMR semantics.
- `src/lib/player-directory-lifecycle.ts` turns a previously ad hoc page
  heuristic into a pure, tested presentation state machine.
- Setup actions use compare-and-set predicates plus Serializable snapshots;
  captain transfer normalizes its duplicated representation rather than
  trusting it. AdminAction coverage now includes designation/removal,
  handover, order, settings, schedule, and Start.
- Start explicitly rejects non-captain roster rows. This narrow guard prevents
  a broad phase reversal from reclassifying later-season roster data as an
  auction without attempting an unrelated redesign of phase administration.

### Tests and verification

Tests added or updated:

- Pure capability, seat-plan, budget-display, and player-directory lifecycle
  matrices across every season/Draft state, including MMR 0 and archived data.
- A 35-case captain/readiness integration suite covering eligibility,
  duplicates, missing/stale season tokens, phase locks, order, settings,
  preflight, duplicate captain order, weighted budget persistence, existing
  roster refusal, atomic handover, DRAFT/NOT_STARTED readiness, and COMPLETE
  historical signup protection.
- Existing readiness, abort, admin-flow, admin-log, and phase suites now carry
  the expected-season claims and assert the new lifecycle messages.
- Draft-schedule integration verifies no-op silence, reschedule
  reconfirmation messaging, and cancellation delivery.
- Browser coverage adds a 375×812 captain-preflight layout/overflow check.

Commands and results:

- `npm test` — 87 files, 1,265 tests passed.
- `npm run test:integration` — 39 files, 799 passed and 11 skipped.
- Focused captain/readiness integration — 35 of 35 passed; the six connected
  legacy/new suites passed 146 of 146 before the final notification assertion,
  which also passed in the subsequent focused run.
- `npx playwright test e2e/pages.spec.ts --grep "captain setup and draft preflight"`
  — passed at 375×812 with no horizontal overflow.
- `npx tsc --noEmit` — passed.
- `npm run lint` — exited 0 with 0 errors and 55 warnings; no rule or test was
  disabled or weakened.
- `npm run build` — production build passed; all 36 app entries completed page
  data generation.
- `git diff --check` — passed.
- `npm run test:pg` and `npm run test:mutation` — correctly refused because
  `PG_TEST_URL` is not configured. Postgres-only contention is not claimed.

Manual browser verification used the seeded 17-player/3-standin fixture and
real forms/actions. It covered four captain designations and random order; a
scheduled night; ready/awaiting/stale roll-up; actor-aware captain `/me` copy;
dashboard commitment; SIGNUPS → DRAFT/NOT_STARTED; reschedule and successful
reconfirmation during DRAFT; prestart `/players`, `/teams`, and `/draft`
projected state; COMPLETE with no Draft row; REGULAR_SEASON handover to a real
roster member followed by a database assertion that exactly one flag matched
`Team.captainId`; Start with weighted budgets; live and paused setup/handover
locks; Abort recovery; the existing-roster Start blocker; and final COMPLETE
read-only controls. Temporary fixture rows were removed and the fixture was
returned to SIGNUPS/NOT_STARTED. Browser tabs were finalized after the pass.

### Remaining concerns

- The most important release gap is Postgres contention. SQLite and deterministic
  race seams verify claims sequentially, but designation/order/settings/night/
  Start/handover races must run under `PG_TEST_URL` before production release.
- `(seasonId, draftOrder)` is not a database uniqueness constraint. The
  Serializable allocation and Start duplicate-order refusal protect application
  writes, but a future Postgres migration could add a deferrable/temporary-order
  strategy for stronger storage-level enforcement.
- `Team.captainId` and `TeamMember.isCaptain` remain duplicated because many
  consumers use both. Handover repairs one team's flags atomically and release
  checks both; a database-level invariant is still not expressible directly in
  the current schema.
- Readiness, scheduled time, and the configured `minTeams` value remain
  advisory by product policy. The preflight now says so and Start requires only
  two captains plus a player pool. League operators may later choose an explicit
  override/audit record for starting early, without a schedule, below target,
  or with unconfirmed captains.
- Designation now notifies a captain but still does not require their acceptance.
  A future captain-offer/acceptance state should be driven by league feedback,
  not silently inferred here.
- Discord delivery is best-effort with no durable outbox. A process crash after
  commit can lose designation, schedule, or Start announcements; ambiguous
  webhook timeouts are not exactly-once.
- Broad phase reversal remains intentionally flexible. Start now refuses an
  already-built roster, but the complete phase transition/data-collateral
  matrix belongs to the playoffs/archive and cross-cutting operations audits.
- Abort still needs its own live-auction iteration: readiness/schedule
  invalidation policy, fantasy/prediction/RSVP collateral, result-import races,
  durable discarded-auction history, and correcting the prior live Discord
  announcement are not claimed here.
- Direct `/draft` network-first error recovery and phase-correct behavior for a
  late-phase URL remain for the live auction section.

Recommended future improvements: make the Postgres race suite a release gate;
consider a durable notification outbox; decide whether captain acceptance or
explicit Start overrides are worth their operational cost; and revisit a
storage-level draft-order/captain invariant when the production migration path
can support it.

Next section: **live auction draft** — spectator, captain, and administrator
room states; initial/reconnect failures; nomination and bid permissions;
server clocks, polling order, disconnects, simultaneous actions, pause/resume,
undo/abort, completion, notifications, accessibility, and mobile operation.

## Iteration 5 — live auction draft

Status: complete on 2026-08-03. The audit stops here before beginning the
schedule and weekly regular-season operating loop.

Purpose: run one authoritative auction in which captains nominate and bid,
players and visitors can follow the room without needing private context, and
administrators can pause or correct a bad lot without corrupting budgets,
rosters, downstream league data, or the broad season phase. The room also
owns waiting, reconnecting, paused, completed, and direct-URL recovery states.

Actors affected: captains operating under a short clock; registered players
waiting to be nominated or learning their team; drafted players following
their roster; administrators supervising and recovering draft night; visitors
watching the league; and downstream schedule, fantasy, roster, match-import,
notification, and result-sync consumers.

Lifecycle and dependencies confirmed before changes:

- `/draft` is a server entry page over the active Season; the live client
  polls `POST /api/draft/tick`, while nominate, bid, and admin-nominate use
  separate Route Handlers. The service authority is `src/lib/draft-service.ts`
  over Season, Draft, Team, TeamMember, Registration, Bid, Setting, and
  AdminAction data.
- Season DRAFT is only the broad chapter. Draft NOT_STARTED is a waiting room;
  IN_PROGRESS allows clocks and captain actions; PAUSED parks both clocks and
  enables correction; COMPLETE is read-only for ordinary participants while an
  administrator can still Undo or Abort; later broad phases must never
  reactivate auction writes through a direct URL.
- The bid clock is 30 seconds and the nomination clock is 90 seconds. The
  server owns deadlines and lazy resolution; a client countdown is only a
  local observer and cannot commit a sale.
- Nomination permission depends on the exact current team turn, captain
  authority, an active full-player registration, and an available player.
  Bidding additionally depends on another team's lot, roster capacity, and
  the reserve-budget maximum.
- A sale atomically writes the roster row and price, debits the winning team,
  advances the turn, and may complete a short-roster auction when the pool or
  all legal bids are exhausted. Completion does not advance the broad season
  phase.
- Draft corrections affect more than the room: undo changes roster and budget;
  Abort can collide with schedule/fantasy/RSVP/result activity; phase changes
  can unlock roster and match actions; Discord messages are external
  best-effort effects.

### Problems found

- Tick responses were assembled across independent reads. A roster, bid, lot,
  phase, and viewer permission could therefore come from different moments.
  Mutating routes did not require the rendered season, turn, and lot claims,
  so a delayed tab or replay could apply an intended action to a replacement
  season or newly recovered lot.
- The service trusted broad DRAFT more than the nested Draft state in several
  recovery paths. Pause/resume/undo and phase advancement could race each
  other; a late phase change could make an undo reopen an auction over a live
  schedule.
- Clock resolution depended on somebody keeping `/draft` open. A room emptied
  at zero could remain stuck indefinitely even while the rest of the site had
  traffic. Anonymous and signed-in ticks also shared too coarse a request
  posture for a public event watched behind venue NAT.
- The browser countdown could reach zero while nomination and bid controls
  remained active until the next poll. A hung initial request looked like an
  endless load; 401, 404/season replacement, 409, 429, and lost mutation
  responses were flattened into generic connection behavior.
- The live feed was client-derived but treated as append-only truth. Undo and
  Abort could leave a voided sale in the feed, and manual testing found the
  same defect for a paused lot void. Reconnect seed history did not say when
  its bid list was bounded.
- Drafted non-captains lost persistent personal context because only captain
  team authority was surfaced. Completion implied full rosters even when the
  legal pool had run dry, and team links displaced the live room in the same
  tab.
- Administrators had to leave the live clock for basic pause/recovery. There
  was no distinct void-current-lot operation; Undo could not repair an active
  nomination; and transport-pending server actions looked completed.
- Abort's prior teardown contract was too narrow and its confirmation did not
  name the collateral. It could race match import or roster changes, leave
  unplayed schedule/fantasy/reminder artifacts behind, and did not provide a
  decisive correction to the public live announcement.
- Schedule generation and fantasy creation used broad phase heuristics rather
  than completed-auction authority. Result import and roster mutations did not
  all re-read lifecycle state inside the same write snapshot, leaving Abort
  races between their check and commit.
- The danger confirmation was not a modal dialog, did not trap focus, and did
  not restore focus on Escape. Phone bidding lacked an exact-amount path and
  the compact controls were not protected by a draft-specific overflow test.
- The waiting room showed an old scheduled date as `hasn't started yet`, and
  an expression boundary rendered the reserve rule as `$1for`.

### Changes made

- Added strict HTTP parsers for expected active season, turn version, and lot
  player. All four draft routes validate request shape and return consistent
  400/401/403/404/409 status classes. Nomination and bid compare-and-set the
  exact auction state; stale, duplicate, crossed, or replayed actions fail
  with a reload/retry explanation.
- `getDraftState` now builds one Serializable, bounded snapshot containing the
  broad/nested phase, draft version, nominated user, recent sales, the latest
  bid slice and truncation flag, rosters, budgets, phase capabilities, and the
  viewer's roster membership and purchase price.
- The room observes its local clock boundary, disables sensitive actions
  immediately, and kicks an authoritative poll while showing a settling
  status. Poll/action responses remain request-sequenced; lost responses are
  explicitly indeterminate until refresh. Initial failure has Retry, 429 is a
  delayed-sync state rather than false disconnect, expired identity offers
  sign-in again, and deactivated/replaced seasons are terminal instead of
  polling forever.
- The waiting room uses authoritative `draftAt`, handles no schedule and
  overdue schedule distinctly, automatically flips live, and offers actor-
  appropriate scouting/admin actions. Complete and later-phase states explain
  what happened and where the league goes next.
- Added a persistent Your team banner for captains and drafted players,
  including purchase price; truthful short-roster completion copy; new-tab
  live team scouting; explicit spectator/permission explanations; semantic
  feed headings and status; latest-eight labeling; and reduced-motion-aware
  feed scrolling.
- Added an exact bid input beside quick and maximum bids, a two-column phone
  layout, clearer remaining-budget math, immediate priced-out/full-roster
  reasons, and deliberate confirmation before committing a maximum bid.
- Added a room-level admin toolbar with phase-aware Pause, Resume, Void live
  lot, Undo last sale, and full-recovery access. Unavailable Undo remains
  visible and explains whether there is no sale, a live lot, or a phase lock.
  Void clears bids and preserves the same nominator turn.
- Feed invalidation now rebuilds from authoritative state after Undo, Abort,
  or a paused lot void, clearing flashes and outbid latches so a correction is
  never presented as live history.
- Abort is now one Serializable pre-season reset. It refuses any imported game
  or non-scheduled match; removes unplayed matches and dependent predictions,
  availability, reschedules, standin cover, fantasy, and reminder-marker state;
  removes every roster row that is not the authoritative current captain plus
  every bid; normalizes retained captains to a $0 captain row; refunds every
  roster price; preserves registrations, teams, draft settings/night/readiness;
  restores NOT_STARTED; and returns the exact active season to SIGNUPS. The
  confirmation enumerates that collateral, including reminder re-arming.
- Pause, resume, lot void, undo, and Abort now have truthful Discord correction
  copy plus admin logging. Sales and completion are announced (not admin-logged),
  and completion acknowledges open seats needing free agents or standins.
- During SIGNUPS/DRAFT, a shared post-auction capability locks schedule and
  fantasy until Draft COMPLETE; later playing phases deliberately tolerate a
  missing Draft row for imported/manual legacy seasons. Schedule, fantasy,
  roster changes, self/admin signup withdrawal, and match import re-read the
  relevant lifecycle inside Serializable writes. Phase advancement rechecks
  connected auction/schedule state and the rendered active-season claim at its
  decisive write.
- `DangerSubmit` is now an accessible, opaque dialog with description, initial
  focus, focus containment, Escape close, and trigger-focus restoration.
  ActionForm reports transport uncertainty rather than claiming success.
- Corrected the overdue waiting label and the rendered `$1 for` reserve rule.

### Architecture improvements

- `src/lib/draft-http.ts` is the route contract for parseable expectation
  tokens and error-to-status mapping; Route Handlers remain auth/parse/delegate
  leaves instead of independently interpreting auction state.
- Draft mutation routes carry exact compare-and-set claims. State reads and
  cross-table nomination/void/undo/Abort operations use Serializable snapshots;
  bid, clock, pause, and resume paths rely on narrower atomic predicates. The
  client receives one narrow DTO rather than assembling authority from several
  queries or inferring it from broad phase.
- `src/lib/league-lifecycle.ts` is the shared completed-auction boundary for
  post-draft work. Schedule and fantasy no longer invent subtly different
  DRAFT semantics.
- `src/lib/result-sync-service.ts` performs a cheap due-clock preflight and
  calls the authoritative expired-lot and stalled-turn resolvers from
  `/api/sync`. A visible root pinger may take its 300-second idle interval to
  discover the live clock, then uses the 60-second watch cadence.
- `src/lib/draft-feed.ts` defines explicit recovery invalidation, including
  lot-voided snapshots, so React owns rendering/side effects while pure tested
  logic owns semantic history.
- Abort has an explicit cross-aggregate boundary and typed contention result;
  match import participates in the same Season/Draft contention domain rather
  than relying on a pre-fetch phase check.

### Tests and verification

Tests added or updated:

- Thirteen Route Handler contract tests cover invalid JSON, missing/wrong season,
  missing turn/lot expectations, unauthorized admin nomination, stale state,
  cache headers, and anonymous tick behavior.
- Draft-feed tests cover reconnect seeding, Undo/Abort invalidation, and the
  manually discovered paused-lot void regression; integration coverage proves
  the newest-eight bid slice and its truncation flag.
- Lifecycle unit tests cover SIGNUPS, live/paused/complete DRAFT, and later
  phases for schedule/fantasy availability.
- Integration coverage adds pause/void/resume recovery, stale turn and lot
  refusal, full Abort collateral and preservation, refusal after played data,
  schedule/fantasy/result-import lifecycle gates, and a deterministic
  undo-versus-phase race. Connected result-sync, admin-flow/log, registration,
  match-report, and match-import fixtures assert the same boundaries.
- Draft Playwright coverage now exercises two real captain sessions, a
  spectator waiting room that flips live without refresh, availability of live
  admin recovery controls, exact bidding at 375×812 with no horizontal
  overflow, outbid/rebid behavior, sticky clock recovery, bid-trail presence,
  and post-start admin locks. Manual verification executes each recovery action.
- The Playwright web server now runs with an explicit 8 GiB Node heap ceiling;
  this prevents Next's development worker from restarting between long draft
  and stalled-request scenarios without changing, splitting, or weakening a
  test.

Commands and results:

- `npm test` — 90 files, 1,299 tests passed.
- `npm run test:integration` — 40 files, 823 passed and 11 intentional
  Postgres-only tests skipped.
- Focused invariant command (`abort-draft`, `registration`, `community-actions`,
  and `draft`) — 112 passed and one intentional Postgres-only case skipped.
- `npx tsc --noEmit` — passed.
- `npm run lint` — exited 0 with 0 errors and 45 existing warnings; no rule or
  test was disabled or weakened.
- `git diff --check` — passed.
- `npx playwright test e2e/zz-admin-draft.spec.ts` — 1 passed, including the
  two-captain flow and phone exact-bid assertion.
- `npm run test:e2e` — all 25 Chromium tests passed in 2.8 minutes, including
  the live draft, phone draft, stalled-poll recovery, and connected inhouse
  lifecycle suites.
- `npm run build` — production compilation, TypeScript, and all 36 generated
  app entries passed.
- `npm run test:pg` and `npm run test:mutation` — correctly refused because
  `PG_TEST_URL` is not configured; Postgres contention is not claimed.

Manual browser verification used 12 active PLAYER registrations, four of them
designated captains, through real pages, routes, server actions, and SQLite
writes. It covered
waiting, overdue schedule copy, projected teams, Start, automatic nomination,
captain bidding, spectator state, complete short rosters, persistent drafted-
player team context, Undo reopening the latest sale, Pause/Resume, pausing an
active lot, Void, feed correction, the Abort collateral dialog's focus and
Escape behavior, successful typed Abort, and the restored SIGNUPS waiting
room. The fixture finished with 12 player registrations, four captain-only
teams, no schedule, and Draft NOT_STARTED; browser tabs were finalized.

### Remaining concerns

- The heartbeat is traffic-driven, not a durable exact-time scheduler. A
  visible tab can take up to the 300-second idle interval to first discover a
  live clock, then watches every 60 seconds; hidden/no-user traffic still waits
  for the next request or external `/api/sync` monitor.
- Postgres contention was not exercised locally because `PG_TEST_URL` is not
  configured. Deterministic seams and SQLite claims pass, but bid/resolve/
  recovery/Abort races need the Postgres and mutation suites as a release gate.
- `Draft.updatedAt` is still the compatibility turn token; there is no
  immutable DraftRun/Lot/Event identity or append-only discarded-auction
  ledger. Abort intentionally removes Bid rows and non-authoritative roster
  rows, normalizes the retained captain price, and retains only admin/Discord
  correction evidence for the discarded auction.
- Discord remains synchronous best-effort after database commit. A process
  crash can lose a correction, and an ambiguous webhook timeout is not exactly
  once. A transactional notification outbox is the durable design.
- Per-process route limiting mitigates accidental polling load but is not a
  shared distributed rate limiter. Large watch parties behind one NAT and
  horizontally scaled deployments need production observation.
- Initial 500/429, expired-session, and lost-response behaviors have unit/
  manual coverage but not every one has an automated browser fault injection.
  Automated accessibility checking is also still absent.

Recommended future improvements: make Postgres plus the mutation ratchet a
release requirement; add durable scheduler and notification-outbox workers if
the league outgrows traffic-driven resolution; introduce immutable draft run/
lot/event ids when schema migration is available; and add Playwright fault
injection for session expiry, lost mutation response, and initial 429/500.

Next section: **schedule generation and the weekly regular-season schedule** —
generation/regeneration collateral, phase advancement, schedule navigation and
calendar export, match-night/time changes, player RSVP, captain availability
roll-up, reminders, standin gaps, empty/error/mobile states, and the first
connected match-detail workflow.

## Iteration 6 — schedule generation and weekly regular-season logistics

### Section audited

Schedule creation/replacement, publication and navigation, match-night timing,
calendar export, player check-in, captain availability visibility, captain
reschedule negotiation, admin retiming, week reminders, phase/direct-action
gates, and the pre-result portion of `/matches/[id]`.

### Current purpose

This section turns drafted teams into a fair round robin, tells every actor when
and whom they play, lets players commit to a concrete match night, gives
captains enough readiness information to arrange cover or agree a new time,
lets administrators correct the schedule safely, and carries the same truth to
Discord and calendar clients. It bridges the completed auction to weekly match
play; results, imports, playoff advancement, and the remainder of match detail
are deliberately the next iteration.

### Actors affected

- Visitors follow fixtures, standings, live/result debt, playoff projections,
  and completed-season history.
- Drafted players and booked standins see their real next match and answer one
  time-specific check-in question.
- Captains see both sides' readiness, arrange cover, and propose/respond to a
  kickoff change without bypassing league or match state.
- Administrators generate or replace the round robin, choose single/double
  round robin, set the initial night, move weeks or individual fixtures, and
  understand the state each operation invalidates.

### Problems found

- Schedule generation read mutable season/team/draft inputs before its decisive
  writes. A delayed tab or concurrent phase/team/result change could build from
  stale authority; withdrawn teams were still eligible to be silently
  scheduled.
- Week and individual kickoff edits lacked a complete phase/status boundary.
  They could retime live/final rows, and a no-op could still clear check-ins,
  proposals, and reminder state. Week cascades could use a captain-retimed
  outlier as the season-wide baseline and did not truthfully report collateral.
- RSVP and reschedule authorization used read-before-write checks. Archived,
  locked, untimed, stale, live, completed, replaced-seat, duplicate, and
  captain-authority changes were not all decided in the same snapshot as the
  mutation.
- Reschedule acceptance reset every RSVP without telling the responding
  captain how many. Spectators could not see an open proposal, while a phase
  change could strand a proposal without a safe decline/withdraw cleanup path.
- The dashboard and schedule could disagree about the next relevant fixture.
  An old unreported match could remain “this week” and keep asking for check-in;
  a player replaced by a standin could still be prompted. Zero-confirmed sides
  had no useful readiness denominator.
- Schedule navigation appeared only once regular season started, hiding the
  published post-draft fixture state. Empty, phase-locked, complete, untimed,
  and overdue states did not consistently explain what happens next.
- The calendar route omitted completed timed matches, generated a new DTSTAMP
  on every request, accepted invalid/non-active team ids as empty feeds, and
  called a download-style `.ics` endpoint a subscription.
- One marker covered an entire numbered week's Discord reminder. A single
  early rescheduled match could consume it and suppress the actual league
  night; naive week-prefix cleanup also made week 1 collide with week 10.
  Reminders depended only on dashboard/schedule traffic.
- Manual browser testing found a cross-cutting confirmation defect: accepting a
  reschedule committed successfully and removed its form during revalidation,
  but the unmounted form never ran the effect that emitted its success toast.

### Changes made

- Schedule generation now requires the rendered active-season claim and reads
  the active season, lifecycle, teams, played matches, games, and replacement
  collateral inside one Serializable transaction. It refuses withdrawn teams,
  a changed season/auction, landed results, and contention with actionable
  messages. Single and double round robin are both available in the UI.
- Generate versus Regenerate remain distinct. Replacement counts and discloses
  check-ins, pick'em picks, standin bookings, and open proposals; removes the
  fixtures and reminder markers atomically; and sends each displaced standin a
  best-effort stand-down after commit.
- Admin week and match retimes now require the active-season claim, an open
  post-auction lifecycle, and `SCHEDULED` status. They compare-and-set the old
  kickoff, leave no-op submissions untouched, reset auto-sync claims, clear
  only affected check-ins/proposals/reminder clusters in the same transaction,
  report exact counts, and warn about resulting standin double-bookings. Live
  and final kickoff controls are read-only with an explanation.
- RSVP uses the shared lifecycle/check-in gate inside a Serializable write. It
  requires an active timed scheduled fixture no more than 48 hours past
  kickoff, re-evaluates the match-night roster, rejects a replaced seat, and
  updates the unique response without duplicate inflation. A notification
  failure no longer makes a committed answer look unsuccessful.
- Captain reschedule proposal/response/cancellation re-read current captaincy,
  season/draft/match status, pending state, and proposed time transactionally.
  No-op/live/final/archived/locked changes are refused; an unscheduled fixture
  may receive its first agreed time. Accept retimes, clears and counts RSVPs,
  cancels stale reminder state, and warns about standin clashes atomically.
  Decline/withdraw remain available as cleanup after a later lock. Spectators
  get a read-only pending strip.
- Acceptance now explicitly confirms how many check-ins will be cleared. The
  shared ActionForm emits success/error feedback from the completed promise,
  so a server revalidation can remove the form without losing its message.
- `/schedule` now has phase-specific orientation and empty states, an untimed-
  fixture warning and admin route, semantic section hierarchy, `time TBD`,
  honest overdue-result debt, and a stable fixtures anchor. “This week” and
  personal next-match selection use live/fresh kickoff state and the actual
  standin-adjusted roster. Readiness always renders `confirmed/expected`,
  including 0/N and waiting/out information; phone rows preserve team-name and
  details tap space while the match page shows each player's answer.
- Schedule navigation is available during DRAFT so a completed auction's
  published fixture state is discoverable. Dashboard schedule links target the
  stable fixture list instead of an absent playoff/complete “this week” id.
- `/api/calendar` now returns every timed active-season fixture, including
  completed matches, with stable persisted DTSTAMP values, CRLF/folding,
  explicit cache/nosniff headers, safe filenames, and a 404 for an invalid or
  non-active team filter. Product copy calls it a calendar feed/download and
  no longer promises live subscription behavior.
- Week reminders are keyed per exact `(season, week, kickoff)` cluster. One
  split week can announce each distinct night without duplicates; cleanup uses
  an exact week base or colon-delimited suffix, so week 1 never deletes week 10. `/api/sync` now attempts the reminder after result sync, best-effort and
  isolated from heartbeat success.
- The mid-season fixture gives the check-in player and both captains stable
  identities, enabling a real mobile RSVP → readiness → propose → accept test.
  No working result, playoff, standin, or historical behavior was removed;
  writes were restricted only where lifecycle/status or stale authority made
  the previous behavior unsafe.

### Architecture improvements made

- `src/lib/league-lifecycle.ts` is the shared post-auction, match-logistics,
  and fresh-check-in capability boundary used by pages and mutations.
- Schedule replacement, week moves, individual retimes, RSVP, and captain
  reschedules now place authorization/state reads and connected writes in one
  Serializable aggregate boundary, with compare-and-set predicates and P2034
  retry guidance.
- `weekReminderKey` distinguishes the cleanup base from a kickoff-cluster
  marker; every retime path uses the same exact delimiter contract.
- Calendar serialization accepts a persisted event stamp, making repeated feed
  responses byte-stable instead of request-time dependent.
- The shared action form owns transport-result delivery before React state
  effects, separating global feedback lifetime from the submitting subtree.
- Schedule relevance and actual match-night roster calculations are shared
  pure helpers instead of subtly different page-specific heuristics.

### Tests added or updated

- Lifecycle, schedule-focus, ICS, calendar-route, sync-route, and ActionForm
  unit/contract tests cover phase/status/freshness gates, stale-result focus,
  stable feed output, filters/headers/folding, reminder failure isolation, and
  feedback that survives form replacement.
- Admin integration tests cover missing/stale season claims, withdrawn teams,
  landed-result and phase races, no-op preservation, scheduled-only retimes,
  exact collateral counts, canonical cascade behavior, anchor updates,
  marker cleanup without week-prefix collision, and activity logs.
- RSVP/reschedule integration tests cover invalid inputs, untimed/stale/live/
  final/archived/locked rows, replaced seats, duplicates, captain changes,
  accept/withdraw/result races, cleanup-only decline/withdraw, RSVP reset
  counts, reminder release, and week-1/week-10 isolation.
- Reminder integration tests cover kickoff clusters, exactly-once claims,
  concurrent/empty/send-failure recovery, standin-aware readiness, and mention
  behavior.
- Mid-season Playwright now completes a real player RSVP and duplicate attempt,
  verifies the desktop readiness roll-up, checks phone overflow, proposes as
  one captain, accepts as the opponent with collateral confirmation, verifies
  the success message, and keeps the broader dashboard/schedule/match/mobile
  suite intact.

### Commands run

- `npx vitest run src/lib/league-lifecycle.test.ts src/lib/schedule.test.ts src/lib/ics.test.ts src/app/api/calendar/route.test.ts src/app/api/sync/route.test.ts`
- Focused six-file schedule integration command covering admin, RSVP,
  reminders, and reschedules.
- `npm test`
- `npm run test:integration`
- `npx tsc --noEmit`
- `npm run lint` plus final focused ESLint
- `npm run test:e2e:mid`
- `npm run test:e2e`
- `npm run build`
- `git diff --check`

### Test results

- Focused unit/API: 5 files, 87 passed.
- Focused integration: 6 files, 145 passed.
- Full unit: 91 files, 1,321 passed.
- Full integration: 40 files, 862 passed and 11 intentional Postgres-only
  cases skipped.
- Mid-season Chromium: 31 passed, including the full RSVP/reschedule flow and
  phone accessibility/overflow checks.
- Primary Chromium: 25 passed across onboarding, admin, draft, inhouse, and
  shared ActionForm consumers.
- TypeScript and production build: passed; all 36 app entries generated.
- ESLint: 0 errors, 44 existing warnings; focused changed-file lint passed.
- Whitespace check: passed.
- The first primary Playwright invocation did not execute tests because a
  manual verification server already owned port 3212. After stopping that
  server, the managed-server rerun passed all 25; no product failure was
  discarded.

Manual browser verification covered signed-in player check-in and persisted
state, phase-complete read-only schedule behavior, readiness labels including
0/N, regular-season orientation, semantic headings, calendar labeling, and the
mobile captain negotiation. The automated browser then reproduced the full
write path with a clean fixture.

### Remaining concerns

- The schema has no season IANA timezone. `firstMatchNight` is an instant and
  later weeks are `+168h`; a daylight-saving boundary can therefore shift the
  displayed local wall-clock hour. This needs a product timezone policy and
  migration, not a page-only fix.
- `/api/sync` can trigger reminders, but there is still no durable scheduler in
  the repository. With no visible traffic and no external uptime/cron ping, a
  reminder waits. The external heartbeat must be configured and monitored.
- Discord sends occur after database commit without an outbox. Captain-agreed
  changes announce immediately, but admin direct/week retimes only re-arm the
  later reminder; a dedicated immediate admin-retime notification is still
  missing. A crash or ambiguous webhook timeout can also lose a message.
- `Match` has no general `updatedAt`, so the calendar cannot emit meaningful
  `LAST-MODIFIED`/`SEQUENCE` revisions. The endpoint is a downloadable feed,
  not a guaranteed push subscription; calendar-client refresh behavior varies.
- True Postgres contention was not run locally because `PG_TEST_URL` is not
  configured. Serializable/compare-and-set branches and deterministic seams
  pass on SQLite, but the Postgres race suite remains a release requirement.
- Network/database fault injection is covered at action/route boundaries but
  not for every browser step. Automated accessibility scanning remains absent;
  this iteration uses semantics, keyboard-capable controls, tap-target checks,
  and targeted responsive assertions.

### Recommended future improvements

Add a season timezone and DST-aware week calculation; configure a durable
scheduled `/api/sync` monitor; move Discord work to a transactional outbox and
announce admin retimes immediately; add match revision metadata to the calendar
feed; run the Postgres and mutation suites in CI; and add browser fault
injection for an ambiguous RSVP/reschedule response.

### Next section to audit

**Match detail and the result pipeline** — visitor/player/captain/admin match
states, captain report-by-Dota-id, admin manual/import/auto-detect controls,
OpenDota/Valve synchronization, game classification and series recomputation,
failed announcement retry, standings propagation, and the handoff from the
last regular result into playoff seeding.

## Iteration 7 — match detail, result entry, and playoff handoff

### Section audited

Result-facing states on `/matches/[id]`; captain report-by-Dota-id and roster
auto-detection; administrator manual scores, rulings, imports, reopen, and game
removal; OpenDota/Valve/heartbeat ingestion; `Game` → `Match` projection;
Discord/honors propagation; playoff seeding, advancement, reset, and champion
handoff integrity. Full standings and bracket presentation remain the next
section.

### Current purpose

Turn played Dota games or explicit administrator rulings into one trustworthy
league result, show every actor the same series state, safely propagate that
state into standings, statistics, and notifications, and hand completed regular
and postseason results into the correct bracket or champion state.

### Actors affected

- Visitors and players follow scheduled, live, result-pending, final, draw,
  ruled, and archived match states and box scores.
- Captains import their own fixture's games without administrator mediation and
  receive actionable locked, final, and correction guidance.
- Administrators adjudicate exceptional results, repair bad imports, reopen
  hand-entered finals, monitor automatic sync, and safely seed or reset
  playoffs.
- Standins are affected when a no-game ruling cancels their match assignment.
- Downstream consumers include standings, scenarios, fantasy, pick'em,
  statistics, weekly honors, Discord, playoff rounds, the champion state, and
  open tabs watching the result-freshness cursor.

### Problems found

- A `Game` insert or delete and its `Match` score/status projection were
  separate writes. A crash or concurrent import could leave a durable game
  attached to a stale `0–0 SCHEDULED` match that future deduplication skipped.
- Result authority was checked before OpenDota I/O but not always rechecked at
  commit. Captaincy, active season, phase, a rival import, or an administrator
  ruling could change during the fetch.
- Captain-entered IDs could claim an old scrim or the wrong scheduled rematch
  between the same teams.
- Manual played scores could contradict imported games or mark an unfinished
  series final. Rulings could erase imported wins, and a zero-game forfeit
  stood down cover without deleting the assignment.
- Result actions did not share one active-season and phase rule. Archived or
  off-phase direct actions could rewrite history or leave regular standings
  inconsistent with a seeded bracket.
- Reopen checked playoff descendants before its write and released announcement
  and freshness state afterward, leaving a race with bracket advancement.
- Playoff reset/seeding read mutable standings, games, cover, and archive state
  outside its teardown transaction. Champion crowning guarded only the Season
  row, so a corrected or reopened final could race a stale crown.
- A committed playoff result whose immediate post-commit advancement failed
  had no later reconciliation path.
- Result controls had split pending state, weak labeling and validation,
  misleading zero-game finals, and insufficient locked/final/correction
  guidance. A full-phone run also found that long team names widened `/admin`
  by seven pixels.

### Changes made

- Added `matchResultsOpen`, pairing the active league chapter with match phase:
  regular results write only during `REGULAR_SEASON`; playoff and final results
  write only during `PLAYOFFS`. Pages and decisive writes use the same policy.
- Added played-final validation: even series require every scheduled game; odd
  series require a clinching winner. Early endings remain explicit
  forfeit/ruling decisions.
- Imported games now commit the `Game`, pure `deriveSeriesProjection` result,
  `Match` score/status/winner, automatic-sync reset, and `resultChangedAt`
  cursor in one Serializable transaction. Phase and captain authority are
  rechecked after OpenDota returns.
- Captain direct-ID imports require a scheduled-fixture window and choose the
  closest meeting between repeated opponents. Untimed fixtures require an
  administrator. Locked requests fail before network work, and OpenDota outages
  are distinguished from a genuine empty scan.
- Administrator result entry refuses stale forms and preserves imported games
  as the source of truth. A ruling may add awarded wins but cannot erase played
  wins; no-game forfeits transactionally delete cover before best-effort
  stand-down notifications.
- Game removal transactionally recomputes the series, clears stale ruling and
  announcement state, advances the freshness cursor, and refuses corrections
  after a playoff descendant exists.
- Reopen now re-reads the season, match, imported-game count, and playoff
  descendants, then resets the Match, releases its result-announcement marker,
  and advances the freshness cursor in one Serializable command. A real
  Postgres write-conflict test verifies reopen cannot race a bracket child into
  an invalid state.
- `/matches/[id]` now identifies completed series, draws, overdue result debt,
  archived read-only history, manual finals, and forfeits distinctly. Captains
  see reporting, locked-phase, or correction guidance instead of a disappearing
  control.
- `/admin` renders off-phase and imported finals read-only, labels and bounds
  score inputs, distinguishes played finals from rulings, explains
  imported-game authority, confirms final-result consequences, and fits long
  team names in a three-column phone grid without page overflow.
- Match import controls now share one `ActionForm`, pending state, durable
  toast, accessible label/help text, responsive layout, and submitter-intent
  validation that allows Auto-fetch without requiring a pasted ID.
- Playoff creation/reset now re-reads the active season, completed regular
  slate, eligible teams, standings, doomed games and cover, and archive in one
  Serializable transaction. It preserves deleted Dota IDs and surfaces
  contention clearly.
- Final crowning revalidates the exact sole latest completed final and winner in
  the same Serializable snapshot as `PLAYOFFS → COMPLETE`.
- `/api/sync` now idempotently retries playoff advancement, repairing a
  committed result whose immediate post-commit bracket effect was interrupted.

No working result capability was removed. Previously writable off-phase or
archived paths now give restoration/reseed guidance because mutating them in
place could invalidate later league state; imported games remain editable only
through their explicit remove/recompute path.

### Architecture improvements made

- `matchResultsOpen` is the shared result capability boundary.
- `deriveSeriesProjection` makes `Game` rows the source of truth and the
  `Match` score, status, and winner a reproducible projection.
- Import, manual result, removal, reopen, playoff reset, and crown operations
  use explicit Serializable aggregate boundaries with P2034/reload guidance.
- Result freshness is updated with each decisive database mutation.
- Bracket advancement remains an idempotent post-commit effect, with heartbeat
  reconciliation as its recovery path.
- Captain reporting remains a tested service boundary; the server action owns
  authentication, feedback, revalidation, and presentation.
- Shared `ActionForm` submitter dispatch gives both import operations one
  feedback and pending lifecycle.
- The midseason browser server now receives the same test-only 8 GiB V8 heap
  ceiling as the primary suite, preventing Next's development worker from
  restarting between late-suite route compilations without changing production
  runtime limits or test order.

### Tests added or updated

- Lifecycle and standings units cover the phase/match matrix and played-final
  versus ruling score rules.
- Import units cover fixture ownership and closest-meeting attribution.
- Import/report integration covers atomic Game/Match/cursor visibility,
  captain-transfer races, off-phase preflight, rematches, invalid IDs,
  duplicates, missing/private data, and OpenDota outages.
- Administrator integration covers active/archive and phase boundaries, stale
  imports/corrections, imported-game authority, incomplete played finals,
  rulings, standin deletion, atomic removal projection, and every reopen
  success/refusal state.
- A Postgres-only test creates a real write conflict between playoff advancement
  and reopen; the resulting state is either safely reopened without a child or
  safely final with its child.
- Playoff integration covers inactive/unfinished seasons, authoritative reset
  snapshots, archive merge, contention, completed-season reset, corrected or
  undecided final races, and exactly-once advancement/crowning.
- Result-sync integration covers recovery of a committed playoff result whose
  next-round handoff did not run.
- Component/source guards cover the shared import form, pending behavior,
  submitter intent, field preservation, and Auto-fetch validation.
- Midseason Playwright covers captain open/final/invalid-import states at 360px
  and administrator rejection of an incomplete played final, a reversible
  no-game ruling, public forfeit rendering, UI-based reopen, and document-level
  phone overflow.

### Commands run

- Focused Vitest commands for lifecycle, standings, imports, result sync,
  schedule status, the sync route, `ActionForm`, and import controls.
- Focused integration commands for match import/report, administrator result
  flows, playoffs, result sync, season transitions, and standins.
- `npm test`
- `npm run test:integration`
- `npm run pg:up`
- A focused eight-file `vitest.pg.config.mts` Postgres integration run
- `npm run pg:down`
- `npx tsc --noEmit`
- `npm run lint` plus focused changed-file ESLint
- `npm run test:e2e:mid`
- `npm run test:e2e`
- `npm run build`
- `git diff --check`

### Test results

- Focused unit/contract: 9 files, 184 passed.
- Focused match-import/report integration: 2 files, 31 passed.
- Focused playoff integration: 23 passed.
- Focused administrator-result integration: 77 passed and one
  Postgres-only case skipped under SQLite.
- Full unit: 92 files, 1,345 passed.
- Full SQLite integration: 40 files, 896 passed and 12 intentional
  Postgres-only cases skipped.
- Focused real Postgres integration: 8 files, 212 passed, including the forced
  reopen-versus-bracket-advance write conflict.
- Primary Chromium: 25 passed across onboarding, administration, draft,
  inhouse, and shared `ActionForm` consumers.
- Midseason Chromium: 33 passed, including the complete captain and
  administrator result workflows and phone overflow checks.
- TypeScript: passed.
- ESLint: 0 errors and 43 existing warnings; final focused lint had no errors.
- Production build: passed; all 36 app entries generated.
- Whitespace check: passed.

Manual browser verification covered the 360px administrator result workflow,
including long opposing team names, score fields, ruling confirmation, import
controls, accessible labels, and zero document overflow. The first full
midseason run passed 31 tests and exposed the seven-pixel `/admin` overflow;
the only other failure was navigation during a Next development-worker memory
restart. Both fixes are retained as product/test reliability work. The clean
full rerun passed all 33 tests without overflow or a server restart.

### Remaining concerns

- There is no durable transactional outbox. A crash after a result commit but
  before creating or sending its Discord or honors marker can still lose that
  effect. Bracket advancement now reconciles; announcements and honors do not
  have equivalent commit-with-intent durability.
- The schema has no immutable result revision/provenance record. Manual result
  versus ruling is represented largely by `forfeit`, with no structured reason,
  actor, source, or correction history.
- Correcting a regular result after playoff seeding is intentionally not a
  one-click action. An administrator must restore the appropriate phase and
  reseed; interruption between those steps remains operationally awkward.
- Captain auto-detection can still spend a relatively long network budget, and
  roster/standin composition is not snapshotted as immutable match-night
  provenance.
- Weekly honors and other derived engagement artifacts do not yet have a
  general correction/retraction ledger.
- Automated accessibility scanning and browser fault injection for ambiguous
  import/result responses remain absent. The shared `EmptyState` title is also
  visually clear but still a paragraph rather than a semantic heading.
- Next still reports the existing smooth-scroll route-transition annotation
  warning during browser tests.

### Recommended future improvements

Add a transactional result/notification outbox; introduce immutable result
revision and provenance records; provide one guarded “correct regular result
and reseed playoffs” recovery workflow; make honors correction-aware; reduce or
queue long OpenDota roster scans; promote the Postgres race suite to required
CI; and add browser fault-injection and automated accessibility coverage.

### Next section to audit

**Standings, playoff bracket, final, and champion experience** — tiebreak
transparency, scenarios and clinch states, seeding visibility, bracket
navigation and mobile layout, round scheduling and byes,
reset/reseed/phase-reversal UX, final correction recovery, champion completion,
notifications, and archived postseason presentation.

## Iteration 8 — standings, playoffs, final, champion, and postseason history

### Section audited

Regular-season standings and their playoff projection on the dashboard,
schedule, team pages, and administrator console; tiebreak and qualification
communication; playoff seeding, round construction, scheduling, reset, and
phase recovery; bracket interaction on desktop and mobile; grand-final result
correction and champion propagation; completed-season dashboard/recap states;
and archived postseason presentation. The broader archive/offseason lifecycle
remains iteration 11.

### Current purpose

Turn one authoritative regular-season table into a transparent playoff field,
carry every decided series through a single-elimination bracket, crown exactly
one champion, make exceptional corrections safe, and preserve an honest public
record after completion. The workflow must keep the public table, bracket,
administrator controls, notifications, cached statistics, and active-season
phase synchronized.

### Actors affected

- Visitors follow the table, qualification line, bracket, final, champion,
  recap, and archived season without needing league-specific tribal knowledge.
- Players see whether they qualified, their projected seed, the path through
  the bracket, exact kickoff, and the authoritative outcome.
- Captains use the same standings and bracket truth while coordinating playoff
  matches and explaining tiebreak or schedule decisions to their teams.
- Administrators seed or reset the field, schedule rounds, adjudicate results,
  recover from a wrong final or phase, and understand the destructive scope of
  every correction before confirming it.
- Discord recipients and parked browser tabs depend on champion, bracket, and
  phase effects being retryable and observable after commit.

### Problems found

- Public and administrator surfaces independently selected standings slices,
  bracket sizes, and seed labels. A withdrawn team could remain above the cut
  in one place while the service silently excluded it in another.
- The final fallback tiebreak is a stable team id, but the UI printed strict
  ordinals without disclosing when qualification or seeding was effectively a
  coin flip. The first warning implementation also truncated a three-way tie
  at the cut and warned about irrelevant ties below it.
- Starting/resetting playoffs accepted stale, replayed forms and combined an
  old standings read with destructive cleanup. Reset cascades Games, RSVPs,
  pick'em picks, cover bookings, and reschedule requests; late-arriving rows
  could be erased without the operator seeing the changed scope.
- Generic phase controls could enter `PLAYOFFS` without creating a bracket,
  but the dedicated Start command could only run from `REGULAR_SEASON`. Generic
  backward moves could also expose mutable standings beneath a stale bracket
  or champion.
- Reset/recovery did not preserve even the imported Dota match ids it deleted,
  did not consistently stand down booked substitutes, and offered no explicit
  way to return to the regular table for a safe correction and reseed.
- Bracket advancement was idempotent but a process interruption after a result
  commit could strand the next round or champion. A heartbeat that lost the
  repair/import claim on its first request could then adopt the winner's new
  cursor as its baseline and leave its already-rendered page stale forever.
- A completed final with no champion was treated as crowned by administrator
  controls, exposing correction actions that the backend refused. Public and
  admin recovery copy also assumed a bracket existed even in a legacy
  `COMPLETE` season with none.
- Public dashboard, schedule, recap, team, archive, Hall of Fame, career,
  match-detail, and feature-count surfaces trusted any stored
  `championTeamId`. A losing finalist or unrelated stale id could therefore be
  awarded a title publicly even while the saved grand final disagreed.
- The administrator schedule card still advertised regeneration after results
  or imported games existed and schedule/night editing in locked phases, even
  though the mutations rejected those states. Earlier playoff rounds also
  advertised reopen/remove/import controls after downstream matches made a
  winner correction unsafe and server-rejected.
- A champion announcement configured after the crown had no retry trigger, and
  a failed send could become the one unannounced result that mattered most.
- The bracket required horizontal scrolling on phones but did not clearly
  teach that interaction. Repeated team occurrences could not be traced,
  keyboard scrolling ignored reduced-motion preference, and match/team
  controls had ambiguous accessible names and weak focus feedback.
- Qualification was primarily a row tint; the playoff cut was hidden from
  assistive technology. The teams index omitted withdrawn status, and archived
  team navigation called incomplete standings “Final”.
- A manually adjudicated season with zero imported Dota games lost its recap
  entirely even though its series, bracket, and champion were authoritative.
  Completed-season schedule and missing-champion copy also used contradictory
  “Playoffs” language.

### Changes made

- Added one `projectPlayoffField` projection and routed dashboard, schedule,
  administrator seeding, and scenarios through it. The public table retains
  every played result; withdrawn teams remain visible but cannot enter the
  bracket. Projected seeds and the qualification cut now come from the same
  map used by bracket creation.
- Standings now preserve unresolved mini-rank tie groups. The administrator is
  warned with every member of a dead heat that touches qualification or seed
  order, while ties wholly below the field stay quiet. Qualifying rows and the
  cut expose equivalent text to screen readers.
- Start and Reset are separate controls with explicit intent, active-season,
  expected-phase, and content-addressed revision claims. The revision includes
  season format/scheduling inputs, team eligibility, regular result fields
  including week and forfeit, bracket rows, imported ids, and all postseason
  child rows that teardown would delete.
- Bracket creation/reset now re-reads and validates its complete claim inside
  one Serializable command. A shared teardown archives removed Dota ids,
  clears bracket/champion/reminder/result markers, gathers substitute
  stand-downs, removes the postseason, and advances the global freshness
  cursor before a fresh field is created.
- Added an explicit Return to regular season command. It atomically removes
  the bracket and champion, preserves the import receipt, stands down affected
  cover, attempts to broadcast that the old bracket is void, and reopens the
  table for correction. Failed league/stand-down sends are now reported in the
  administrator result instead of being silently ignored. Generic phase
  control refuses a raw bracket-less transition into Playoffs and cannot move
  away from an existing postseason; legacy no-bracket recovery now points
  through Regular season and the dedicated Start control.
- Phase, Start/Reset, result, and kickoff controls now mirror the server's
  actual capabilities. Current/impossible phase buttons are disabled with the
  reason nearby; Complete remains derived from a crowned final; Playoffs starts
  only from a complete regular slate; schedule generation is hidden once
  competition has landed; match-night/kickoff controls respect phase and
  auction gates; and an earlier playoff series becomes explicitly read-only as
  soon as a later round exists.
- Final correction distinguishes an actual authoritative champion from a
  merely completed final. A stored champion who is the losing finalist can use
  the same safe targeted recovery instead of requiring a whole-bracket reset;
  a nonparticipant or non-authoritative final cannot. Removing a game or
  reopening that final retracts the title transactionally, then either leaves
  the series live or immediately re-crowns it when the remaining games still
  decide the winner.
- Heartbeat reconciliation reports its own round/crown mutation through
  `/api/sync`, and the client now starts from the cursor captured during its
  server render. Both the winning request and a losing first heartbeat refresh
  when a post-render result lands. Champion sends use the same retryable
  failed-marker contract as series results, including Discord configured after
  crowning, and revalidate the stored title against the saved final before any
  public announcement.
- The bracket gained named regions/rounds, a mobile scroll instruction and
  edge affordance, keyboard horizontal navigation, reduced-motion-aware
  movement, persistent click/keyboard team-path tracing across rounds,
  match-specific link names, explicit team-toggle labels, and visible focus
  treatment. The trace is explanatory only and never changes bracket state.
- One `resolveChampionPresentation` boundary now governs every public title,
  trophy, badge, career/Hall-of-Fame count, archive card, match crown, and
  feature metric. A saved postseason must contain one completed latest FINAL
  whose participant/winner matches the stored id; champion-only legacy archives
  remain compatible. Schedule and global navigation use phase-specific
  Playoffs/Season results language; missing/inconsistent recovery branches on
  whether a bracket exists; withdrawn teams are labeled; and archived team
  links distinguish final standings from standings at archive.
- Recap now separates completed series from imported games. A zero-import
  season retains its bracket, champion, official result count, and an honest
  explanation that player-stat awards cannot be calculated; archived recap
  and season detail both retain the playoff bracket.

No working league capability was removed. The generic phase button no longer
starts Playoffs because that path could not atomically seed the bracket; the
dedicated Start control is its tested replacement. Postseason reset still
exists, but now names and validates every destructive consequence.

### Architecture improvements made

- `projectPlayoffField` is the single regular table → eligibility → cut → seed
  → pairing boundary.
- `resolveChampionPresentation` is the single stored season/final → public
  title boundary, reused by live, archive, career, metric, and notification
  consumers; the bracket repeats the final invariant defensively.
- `hasLaterBracketRound` is shared by result mutations and the administrator
  capability projection, so downstream bracket state has one correction lock.
- `playoffSetupRevision` is a deterministic, order-independent command claim;
  required query inputs prevent the administrator preview and service command
  from silently hashing different aggregates.
- Start/reset and Return share one postseason teardown rather than maintaining
  parallel cascade, marker, archive, and stand-down behavior.
- `buildBracketRounds` and first-round seed recovery are pure presentation
  boundaries reused by active schedule, completed dashboard, recap, and season
  archive.
- Bracket advancement returns whether it committed a round/crown, making lazy
  reconciliation observable without conflating it with a newly imported game.
- Result/champion freshness remains one monotonic cursor, stamped in the same
  transactions as bracket creation, teardown, round creation, and crowning;
  `<ResultSyncPing>` receives the server-render value as its causality baseline.
- Postseason Chromium has its own deterministic fixture database, port, config,
  npm command, and required sequential CI step.

### Tests added or updated

- Projection/standings units cover withdrawn eligibility, no-field states,
  field sizes/pairings, stable ordering, forfeits, two- and three-team dead
  heats crossing the cut, and irrelevant ties below it.
- Command units use 36 one-leaf mutations to cover every serialized season,
  team, match, game, availability, cover, prediction, and reschedule field,
  plus order independence.
- Bracket-view/component guards cover progressive rounds, recovered seeds,
  semantic regions, trace state, keyboard scrolling, reduced motion,
  accessible control names, and focus styling.
- Administrator/phase integration covers replay/stale claims, incomplete or
  empty slates, reset collateral and Dota-id archive merge, Return to regular,
  its league-wide correction notice, raw Playoffs refusal, existing-bracket
  recovery, missing-champion states, unauthorized and stale active-season
  access, and final correction.
- Playoff/result-sync/retry integration covers round and crown idempotency,
  reset/advance/correction races, a real-Postgres Game inserted after teardown's
  dependent-row snapshot, winning and losing first-heartbeat refresh,
  champion marker failure/no-webhook recovery, notification-failure visibility,
  wrong-finalist title recovery, and a still-decided 3–1 → 3–0 correction that
  re-crowns exactly once.
- Postseason Playwright covers live/completed desktop and 360px brackets,
  every repeated trace occurrence, keyboard horizontal movement, exact recap
  series/game counters with and without imported games, locked administrator
  generation/earlier-round controls, a conflicting stored champion that is
  withheld across public pages, missing-state copy, and bracket retention on
  archived season detail and recap.

### Commands run

- Focused Vitest unit/contract commands for standings, playoff projection,
  command revision, bracket presentation, phase guidance, public copy, and the
  sync route.
- Focused SQLite integration commands for playoff service, postseason admin,
  phase/admin flow, result sync, and champion retry.
- `npm test`
- `npm run test:integration`
- `npm run pg:up`
- The complete `vitest.pg.config.mts` integration suite
- `npm run pg:down`
- `npx tsc --noEmit`
- `npm run lint`
- `npm run test:e2e`
- `npm run test:e2e:mid`
- `npm run test:e2e:postseason`
- `npm run build`
- `git diff --check`

### Test results

- Final focused postseason unit/contract gate: 6 files, 144 passed.
- Final focused postseason/service SQLite integration gate: 4 files, 71 passed
  and one intentional Postgres-only case skipped.
- Full unit: 98 files, 1,437 passed.
- Full SQLite integration: 41 files, 918 passed and 13 intentional
  Postgres-only cases skipped.
- Full real-Postgres integration: 41 files, 931 passed, including the
  after-snapshot teardown insertion, phase/bracket build, crown/correction,
  announcement, and stale-child-row claims.
- Chromium: primary 25 passed; regular-season 33 passed; postseason 8 passed
  across active/completed/archived and consistent/inconsistent title states,
  desktop and 360px interaction, exact recap values, and mobile administrator
  capability visibility.
- TypeScript: passed.
- ESLint: 0 errors and 40 existing warnings.
- Production build: passed; all 36 app entries generated.
- Whitespace check: passed.

Manual browser verification covered the active-playoff dashboard and schedule,
desktop and 360px bracket scrolling/tracing, the completed champion dashboard,
and recap. The final browser run additionally exercised signed-in
administrator phase/Reset/Return capability visibility at 360px and confirmed
zero document-level horizontal overflow.

### Remaining concerns

- The field is still the largest power of two that fits; the league cannot
  configure bracket size or award explicit byes. With six eligible teams, for
  example, only four qualify.
- A fully unresolved cut can be disclosed and explicitly accepted, but there
  is no administrator tiebreak override, play-in fixture, or stored league
  ruling. The deterministic id fallback is not a sporting tiebreak.
- First-round Match rows preserve the realized seeds, but there is no immutable
  bracket snapshot recording the source standings, rule version, or operator
  acceptance of a dead heat.
- Reset preserves removed Dota ids for re-import, not a reversible snapshot of
  deleted Games, RSVPs, cover, predictions, reschedules, or notification state.
  It remains intentionally destructive after confirmation.
- Round scheduling inherits weekly arithmetic from the first match night. It
  does not model venue/timezone constraints, per-round deadlines, best-of-day
  capacity, or a finals event distinct from an ordinary match night.
- Champion/result notifications still lack a transactional outbox. Retryable
  markers recover known failed/missing sends, but a process crash between a DB
  commit and creation of notification intent remains a gap. Return-to-Regular
  and standin stand-down sends are best-effort and now visibly warn the
  administrator on failure, but have no durable automatic retry marker.
- Completed legacy imports with a stored champion and no saved postseason are
  intentionally trusted for compatibility. There is no bracket evidence with
  which to validate those historical titles.
- Automated axe-style browser scanning is still absent; this pass added
  semantic and keyboard regression contracts for the bracket/standings only.
- Archive reactivation/deletion and the new season/offseason handoff are
  intentionally deferred to iteration 11; title presentation and Hall of Fame
  counts are covered here.

### Recommended future improvements

Add configurable fields and byes; introduce a stored tiebreak ruling/play-in
workflow and immutable bracket snapshot; offer export-backed restoration for a
reset; model round deadlines and league timezone explicitly; move champion and
phase-change/stand-down notifications onto a transactional outbox; decide how
legacy champion-only imports should carry provenance; and add automated browser
accessibility scanning.

### Next section to audit

**Engagement and public discovery** — leaders, hero meta, fantasy, pick'em,
records, player comparison, news, product tour, sharing metadata, and the
phase/permission behavior of each direct URL.

## Iteration 9 — Fantasy and Pick'em side games

Status: complete on 2026-08-03. This iteration deliberately stops before the
remaining public statistics and content-discovery pages.

### Section audited

The complete Fantasy and Pick'em workflows: discovery, phase availability,
signed-out and signed-in states, entry privacy, salary/deadline validation,
concurrent result locks, live scoring/grading, mobile presentation, completed
season behavior, and archived direct URLs.

### Current purpose

Give every community member two understandable season-long side games.
Fantasy asks signed-in managers to choose a salary-capped five before any real
performance is known, then scores those players from imported league games.
Pick'em asks users to call each fixture before kickoff and ranks decided
predictions on the oracle board. Both remain useful to signed-out visitors and
after season completion without leaking information that would advantage a
late entrant.

### Actors affected

- Visitors discover both games, understand when entry opens or locks, and can
  follow live/final standings without signing in.
- Signed-in community members can manage Fantasy fives and Pick'em calls even
  when they are not registered league players.
- Players are Fantasy scoring subjects and can also participate as managers
  and oracles.
- Captains have no privileged side-game capability; they use the same rules
  and deadlines as every other participant.
- Administrators indirectly control availability through auction completion,
  scheduling/rescheduling, result import/correction, Draft Abort, phase
  changes, and season archival.

### Problems found

- Header/footer discovery began only in REGULAR_SEASON even though scheduling
  and side-game entry can open during DRAFT once the auction is complete.
- COMPLETE hid the Fantasy final board, while completed and archived pages
  could show sign-in or submission calls to action for games that were closed.
- Fantasy exposed exact competing fives and ownership before lock, omitted
  final-roster breakdowns on mobile, and used final-entry copy while active
  standings were still changing.
- Missing registration MMR made a drafted player a zero-cost selection and a
  wholly unrated pool presented a meaningless `0 / 0 MMR` cap.
- The Fantasy lock was inferred only from existing Game rows. Removing the
  last mistaken import reopened entry after performance was public, a roster
  save could race the first import, and a restored stale tab could target a
  later active season.
- The first concurrency repair used exclusive no-op writes on global
  Season/Draft/Match rows. It closed the race but turned legitimate deadline
  bursts into avoidable participant-versus-participant conflicts.
- Pick'em lacked an action-level phase guard and its first insert could race a
  match becoming LIVE or a kickoff/reschedule transition.
- Open fixtures revealed the community split. Submitted picks disappeared
  between kickoff and grading, completed draws/no-contests disappeared
  entirely, and an all-void board incorrectly claimed nobody entered.
- Week number outranked the next actual deadline, so a rescheduled later-week
  fixture could be buried. At kickoff only the choice button changed; the
  parent card, split, and locked-pick section stayed stale until navigation.
- Separate forms let opposite Pick'em choices diverge while one save was
  pending; Fantasy choices likewise remained editable after FormData capture.
- Selection groups, board heading levels, scoring help, graded mobile rows,
  route-specific metadata, and sitemap discovery were incomplete.

### Changes made

- Made both side games discoverable from the header, footer, and feature tour
  throughout DRAFT. Direct pages explain the auction lock until
  `postAuctionWorkOpen` confirms completion.
- Separated active interaction from final/archive presentation. COMPLETE and
  `?season=` render read-only boards and honest empty states without dead
  sign-in or submission controls.
- Kept Fantasy competitors private before lock, showing only entry count.
  Locked boards reveal final fives with expandable mobile breakdowns, distinct
  live/final language, and useful scoring/no-entry explanations.
- Impute missing Fantasy ratings from the rounded known drafted-pool average,
  visibly label estimates, and explicitly run uncapped only when the entire
  pool is unrated. The picker announces slot/cap changes and disables the full
  choice group while a save is pending.
- Added durable `Season.fantasyLockedAt`. The first imported Game stamps it in
  the result transaction; removing a legacy last Game backfills and preserves
  it; only a safe pre-result Draft Abort clears it alongside obsolete fantasy
  rosters. The homepage uses the same marker as the Fantasy page.
- Added `expectedSeasonId` and transaction-time lifecycle, lock, drafted-pool,
  price, and selection validation to Fantasy saves.
- Added Pick'em transaction-time active-season, Draft, matchup, side, status,
  and deadline validation. One form now owns both choices so pending state is
  shared.
- Added an exhaustive open/locked/graded/void fixture partition. The page
  retains locked and void viewer picks, reveals the community split only after
  lock, distinguishes no entries from no graded results, orders groups by the
  next actual kickoff, and labels every open deadline.
- Added a deadline-aware submit leaf and page refresh leaf. They disable an
  already-rendered choice at kickoff, reset correctly after a reschedule, and
  refresh the server-rendered card into its locked state; the server remains
  authoritative.
- Added semantic `fieldset`/`legend` groups, corrected board heading levels,
  scoring rules beside the Fantasy picker, wrapping graded rows, route
  metadata, and both public routes in the sitemap.

No working side-game capability was removed. The newly unavailable actions
were already competitively invalid: before auction completion, after season
completion/archive, after Fantasy's information lock, or after a fixture's
Pick'em lock.

### Architecture improvements made

- `postAuctionWorkOpen` is the common page/action lifecycle boundary for both
  games.
- `fantasyPrices` is the pure conversion from incomplete roster ratings to the
  same fair salary values used by presentation and server validation.
- `Season.fantasyLockedAt` records historical exposure of competitive
  information instead of inferring it from mutable Game rows.
- `side-game-claims.ts` centralizes provider-specific command claims and
  transient retry classification. PostgreSQL uses compatible `FOR SHARE`
  Season/Draft/Match locks so managers remain concurrent while import, phase,
  archive, reschedule, and result writers are exclusive; SQLite uses guarded
  no-op claims under its single-writer model.
- `partitionPickemMatches` is the exhaustive fixture-state presentation
  boundary, and `groupOpenByWeek` derives urgency from real deadlines.
- `PickemSubmitButton` and `PickemDeadlineRefresh` isolate time-driven client
  feedback; phase, fixture state, and deadline authority stay on the server.
- Side-game race seams have real-Postgres proofs, including concurrent normal
  participants and competing result/phase transitions.

### Tests added or updated

- Fantasy units cover known-pool MMR imputation and the wholly unrated,
  explicitly uncapped case.
- Pick'em units cover exhaustive open/locked/graded/void partitioning and
  deadline-first week/match ordering.
- Source guards pin structurally read-only archive/closed branches, durable
  homepage locking, the expected-season claim, one form per fixture, and
  deadline/void presentation.
- Community-action integration covers pre-auction and COMPLETE refusal,
  DRAFT/completed-auction availability, stale-season rejection, durable
  Fantasy lock retention, normal updates, invalid sides, concurrent managers,
  and first-result/phase/reschedule races.
- Match-import and administrator-flow integration cover atomic lock stamping,
  last-Game-removal backfill, and safe Abort clearing.
- The postseason fixture now contains a deterministic side-game viewer,
  populated Fantasy five, graded and void predictions, and a durable lock.
  Chromium asserts final/archive data rather than merely the absence of forms.
- Midseason Chromium saves and reloads a Pick'em selection and checks populated
  Fantasy/Pick'em layouts at 360px. Primary and postseason coverage retain the
  signed-out, COMPLETE, archive, and mobile states.

### Commands run

- `npx prisma generate` and fixture-specific `npx prisma db push` commands.
- `npx vitest run src/lib/fantasy.test.ts src/lib/pickem.test.ts src/app/side-game-archive-guards.test.ts`
- `npx vitest run --config vitest.integration.config.mts test/integration/community-actions.itest.ts test/integration/match-import.itest.ts test/integration/admin-flow-audit.itest.ts`
- `npm run pg:up`
- The same focused integration files under `vitest.pg.config.mts`.
- `npm run test:pg`
- `npm run pg:down`
- `npm test`
- `npm run test:integration`
- `npx tsc --noEmit`
- `npm run lint`
- `npm run test:e2e`
- `npm run test:e2e:mid` plus isolated reruns of newly failing/flaky cases.
- `npm run test:e2e:postseason`
- `npm run build`
- `git diff --check`

### Test results

- Focused side-game unit/source gate: 3 files, 35 passed.
- Focused SQLite integration: 3 files, 114 passed and 7 intentional
  Postgres-only cases skipped.
- Focused real-Postgres integration: 3 files, 121 passed.
- Full unit: 98 files, 1,446 passed.
- Full SQLite integration: 41 files, 925 passed and 19 intentional
  Postgres-only cases skipped.
- Full real-Postgres integration: 41 files, 944 passed.
- Chromium: primary 25 passed; regular-season 34 passed; postseason 8 passed.
- TypeScript: passed.
- ESLint: 0 errors and 40 existing warnings.
- Production build: passed; all 36 app entries generated.
- Whitespace check: passed.

Manual browser verification covered signed-out and signed-in Pick'em, saving a
choice, signed-out locked Fantasy, desktop and 360px Fantasy/Pick'em layouts,
the COMPLETE final boards, and archived direct URLs. It confirmed final data
remains visible with no controls and no document-level horizontal overflow.

### Remaining concerns

- Fantasy prices derive from mutable registration MMR rather than a stored
  salary/rules snapshot. Changes before lock intentionally alter the pool and
  cap; historical pages cannot prove the exact entry-time values.
- A wholly unrated pool is intentionally uncapped. Administrators should still
  supply ratings when salary balance matters.
- Exact ties fall back to stable user ids, but the UI does not explain that
  policy or show shared placement.
- A fixture with no scheduled kickoff stays Pick'em-open until LIVE/COMPLETED;
  there is no explicit per-match administrator close override.
- Opening, lock, weekly deadlines, and winners have no notification workflow.
- Both boards derive season-wide aggregates in memory and will need database
  aggregation or pagination if participation grows substantially.
- Fantasy scoring uses the shared tagged game cache, so points may briefly
  trail a committed import even though the competitive lock is authoritative.
- The deadline transition has pure/source coverage and browser coverage for
  before/after states, but no time-warp browser test crosses a real kickoff in
  one mounted page.
- Automated axe-style browser scanning remains absent.
- Leaders, hero meta, records, comparison, news, the broader feature tour, and
  remaining sharing/SEO coverage were deliberately not changed here.

### Recommended future improvements

Persist a Fantasy salary/rules snapshot at lock; define and display shared-rank
or contest-specific tiebreak rules; require kickoff data or add an explicit
Pick'em close control; add opt-in deadline and winner notifications; introduce
precomputed engagement aggregates when scale warrants it; add a mounted-page
fake-clock deadline test; and add automated accessibility scanning.

### Next section to audit

**Public statistics and content discovery** — `/leaders`, `/meta`, `/records`,
`/players/compare`, `/news`, `/features`, and the remaining sharing metadata,
sitemap, responsive, accessibility, empty/error, and scaling behavior.

## Iteration 10 — Public statistics and content discovery

Status: complete and verified.
This iteration deliberately stops before season completion, archival, and the
offseason handoff.

### Section audited

The public discovery and statistics surfaces at `/leaders`, `/meta`,
`/records`, `/players/compare`, `/news`, and `/features`; the homepage League
Pulse; weekly-honors publication; public navigation; route metadata and social
previews; the sitemap; game-stat cache invalidation; and fixture/database
boundaries used to verify these states.

### Current purpose

These surfaces let visitors and league participants understand who is
performing, which heroes shape the season, what records have been set, how two
careers compare, what the league has announced, and which league experiences
are available in the current phase. Together they are the public record and
discovery layer around the competitive workflows audited in earlier
iterations.

### Actors affected

- Visitors follow the league without needing an account.
- Players review careers, recognition, meta, records, news, and next actions.
- Captains use the same data for scouting and team preparation.
- Teams share results, honors, record performances, and announcements.
- Administrators publish news, correct imports/results, move league phases,
  and need public caches and honors to reflect committed state accurately.
- Maintainers own the import contract, denormalized game data, caches,
  fixtures, route metadata, and external Discord notification boundary.

### Problems found

- Partial, duplicated, malformed, or numerically unsafe stored player data
  could silently influence public totals, averages, comparisons, and records.
- Weekly honors could appear before every scheduled result and played game was
  final and attributable, then remain apparently current after a result was
  reopened or removed.
- All-forfeit weeks could make an older player/team award look like the latest
  week's result.
- Rankings could disagree with the precision users could see; minimum samples,
  ties, former-player labels, and economy-stat sample counts were inconsistent.
- Hero meta ordering and signature ties were unstable. Games with unknown hero
  ids could distort the known-pool denominator, and empty/error recovery copy
  did not distinguish a broken import from an out-of-date hero catalogue.
- The record book depended on caller ordering without clearly explaining the
  first-achiever policy. Invalid game-level duration/score values and
  untrusted player evidence could still create records.
- Compare accepted invalid, repeated, same-player, or no-history parameters,
  listed site accounts rather than real league careers, and allowed metadata
  to disagree with the rendered body.
- Statistics and evergreen league pages were hard to discover on desktop and
  did not share a clear local information hierarchy.
- Feature-tour destinations did not consistently reflect signup, post-auction,
  regular-season, playoff, complete, or illustrative-only availability.
- News replay/no-op paths did not always refresh already-open pages. Ordering,
  card semantics, deep links, target names, reduced-motion behavior, and media
  failure fallback were incomplete.
- Canonical URLs, Open Graph data, configured origin validation, and sitemap
  coverage were incomplete.
- Several committed game/team mutations used delayed revalidation even though
  the affected public statistics should change immediately.
- Removing a game from an already decided final could claim that the champion
  was re-crowned merely because bracket advancement returned, even when the
  advance failed or authoritative season state still lacked that champion.
- Browser fixtures used partial rosters and could target an unintended test
  database, making successful checks weaker than the real application contract.
- The mutation runner could confuse infrastructure failures with killed
  mutants, allow live claims to drift from their reviewed baseline, and did not
  deterministically protect six account/rank compare-and-set branches.

### Changes made

- Added a shared Statistics sub-navigation and a keyboard-dismissible desktop
  Explore disclosure; mobile navigation now exposes the same evergreen pages.
- Added explicit phase-aware feature gates and lock explanations. Fantasy and
  Pick'em become discoverable after the auction and remain readable when the
  season is complete; illustrative previews no longer masquerade as live data,
  and Discord copy no longer promises infallible delivery from a best-effort
  integration.
- Hardened Leaders with minimum samples based on the metric's actual reported
  games, deterministic visible-precision ties, stable ranks, accessible
  show-all relationships, former-player fallbacks, and honest weekly-honor
  pending, no-performance, and current states. Corrected/withdrawn labeling is
  handled by the external publication workflow.
- Omitted incomplete boxes and whole games containing unknown heroes from hero
  meta, made ordering/signatures deterministic, calculated pool coverage only
  against the known catalogue, and supplied distinct re-import versus catalogue
  recovery guidance.
- Made record input chronology explicit and deterministic, documented that a
  tie stays with the first achiever, neutralized unsafe duration/kill-score
  metrics, omitted whole games whose 5v5 evidence is untrusted, preserved
  former-player and unknown-hero labels, and exposed data-health diagnostics.
- Restricted Compare to users with trusted imported league history. Missing,
  repeated, invalid, no-history, and same-player parameters now render safe,
  useful states; selections, canonical URLs, Open Graph data, table captions,
  and page content stay synchronized.
- Added a shared single-value query decoder so array-valued search parameters
  cannot leak into database filters or metadata.
- Added shared weekly-honors readiness evaluation. Regular-season honors now
  require the full slate to be final, non-forfeit score/game counts to match,
  no excess forfeit games, and every played game to have an attributable
  winning side and trusted 5v5 box. Reopening/removing results marks publication
  stale, while guarded compare-and-set retry logic distinguishes initial,
  corrected, withdrawn, already-sent, and retryable announcements.
- Made news creation idempotent, awaited its Discord boundary, refreshed on
  no-op/replay outcomes, and stabilized pinned/time/id ordering. News entries
  are semantic articles with title-specific permalinks; animated media respects
  reduced motion and broken hotlinks degrade to the original source URL.
- Added route-specific canonical and Open Graph metadata, a validated http(s)
  site origin with safe fallback, and complete public sitemap entries.
- Switched game-affecting action/route paths to immediate tagged invalidation,
  including team rename and committed game removal. Result-removal follow-ups
  are best-effort after the transaction so a notification failure cannot make
  a successfully removed game look like a failed mutation.
- Made final-result removal verify fresh, authoritative season status and
  champion identity before saying a corrected final re-crowned anyone. A
  concurrent caller that already established the same champion is recognized
  as success; stale or failed advancement produces an honest saved-removal
  warning instead.
- Rebuilt the regular-season browser fixture around six real five-player teams,
  including a staged matchup with complete ten-line boxes, and added exact
  destructive-writer database/stage guards.
- Hardened the mutation gate with a live-manifest/baseline drift check,
  infrastructure-failure classification, restricted and validated `--only`
  probes, reconfirmation before promoting discovery kills, and deterministic
  tests for the six previously uncovered account/rank compare-and-set branches.
- Improved 360px layouts, touch targets, headings, table names, empty states,
  unavailable explanations, data warnings, and brand-danger contrast.

No valid league capability was removed. The deliberate behavior change is that
corrupt or partial stored evidence no longer contributes a plausible-looking
fraction of a public aggregate. The match detail remains the inspection surface;
administrators repair the source by removing and re-importing the affected game.

#### Trusted 5v5 statistics contract

Previously, any parseable player row could contribute to career, hero,
comparison, record, recap, scouting, team-pool, Fantasy, Hall of Fame, and
homepage calculations. A partial roster, duplicate line, 6–4 side split,
unsafe counter, or malformed optional value could therefore produce a public
number without a trustworthy game behind it.

A game now contributes to general performance roll-ups only when decoding
produces ten structurally safe rows, exactly five per side, no duplicate hero,
and no duplicate among supplied account or user identities. Required counters
are bounded safe integers; invalid optional economy/report-card values become
missing rather than fabricated zeroes. Hero-meta consumers additionally omit
the whole game until every hero exists in the bundled catalogue. Honors adds a
stricter league-specific check: every player must map to a unique user and to
the correct team; team ids must agree with the match sides, and the recorded
winner must agree with the player sides.

This affects every statistics viewer and administrators correcting imports. It
replaces misleading partial calculation with explicit omission and recovery
guidance. The behavior is covered at decoder, aggregate, page, integration, and
browser levels. A match detail intentionally keeps individually valid lines
visible so an administrator can diagnose a bad stored box.

### Architecture improvements made

- `decodeGamePlayers` is the single public-statistics read decoder for the
  denormalized `Game.players` boundary, and `trustedGamePlayers` is the common
  aggregate admission rule. The legacy enrichment writer intentionally parses
  raw rows separately so it can preserve their existing attribution.
- `analyzeRecordGames` parses the record scan once and returns both eligible
  inputs and page diagnostics; profile record chips reuse its mapping contract.
- Honors readiness is separated into a pure evaluator and database service;
  publication state and external delivery are guarded independently.
- Shared lifecycle gates, statistics navigation, metadata generation, site URL
  normalization, and single-value query parsing replace page-local variants.
- Public game data has one tagged cache boundary with explicit immediate
  invalidation after relevant commits and cache-reset access limited to tests.
- The mutation manifest now has an auditable three-way result: 59 protected
  claims, 38 reviewed equivalents, and zero unprotected claims across all 97
  live mutations. Equivalent annotations cannot silently excuse a changed live
  claim.
- Destructive fixture database writers use exact URL/path identity and explicit
  stage guards rather than substring guesses; the non-database cache-reset
  route remains a test-only, environment-gated endpoint.

### Tests added or updated

- Runtime-decoder tests cover malformed/non-array JSON, invalid members,
  partial rosters, duplicate users/accounts/heroes, a 6–4 split, unsafe
  required counters, optional-value normalization, and real 32-bit account ids.
- Leaders tests cover displayed-precision ties, deterministic ordering, economy
  samples, floors, former-user presentation, and weekly-honor state.
- Meta/record tests cover deterministic ties, unknown heroes, known-pool
  denominators, chronology, first-achiever ties, invalid game metrics, and
  whole-game trusted filtering.
- Compare browser coverage exercises valid, missing-side, same-player, invalid,
  repeated, and no-history URLs plus table/canonical/Open Graph semantics.
- Honors unit/integration/PostgreSQL coverage proves completeness, forfeits,
  score/game reconciliation, attribution, stale correction, compare-and-set
  retries, withdrawal, and announcement failure behavior.
- News unit/integration/browser coverage proves idempotency, deterministic
  ordering, stale-tab refresh, pinned-first display, deep links, 44px named
  permalinks, reduced-motion handling, and broken-media fallback.
- Metadata, sitemap, configured-origin, cache invalidation, and fixture database
  boundary tests were added or strengthened.
- Postseason administration coverage proves game removal persists across an
  advancement exception, rejects a stale COMPLETE/null-champion state, accepts
  a concurrent correct crown, and never emits an unverified re-crown claim.
- Registration/rank-sync integration now kills the bulk account-rank sync,
  duplicate-signup retry, initial account link, public-stat refresh, account
  metadata clear, and single-user rank refresh compare-and-set mutations.
- Signup, regular-season, and postseason Chromium suites cover phase gates,
  empty/final states, public page discovery, phone overflow, and homepage pulse.

### Commands run

- Focused Vitest unit and SQLite/PostgreSQL integration commands for public
  statistics, honors, news, cache behavior, account/rank compare-and-set paths,
  final-result removal, and administration flows.
- `npm test`
- `npm run test:integration`
- `npm run pg:up`
- `npm run test:pg`
- `npm run test:mutation`
- `npm run pg:down`
- `npx tsc --noEmit`
- `npm run lint`
- `npm run build`
- `npm run test:e2e`
- `npm run test:e2e:mid`, a focused rerun of the three corrected fixture/spec
  cases, then the complete midseason suite again.
- `npm run test:e2e:postseason`
- Fixture-specific `prisma db push`, `tsx scripts/seed-fixture.ts`, and
  `tsx e2e-mid/stage.ts` commands against the dedicated midseason SQLite file.
- Targeted Prettier checks and `git diff --check`.

### Test results

- Full unit: 105 files, 1,505 passed.
- Full SQLite integration: 42 files, 946 passed and 19 intentional
  PostgreSQL-only cases skipped.
- Full real-PostgreSQL integration: 42 files, 965 passed. The Prisma provider
  and generated client were restored to SQLite afterward, and the temporary
  `ld2l_pgtest` database was dropped.
- Mutation gate: 97 live claims accounted for — 59 protected, 38 reviewed
  equivalents, zero unprotected.
- Chromium: signup 27/27 passed; regular season 40/40 passed; postseason 9/9
  passed.
- The first final regular-season run exposed three stale browser assumptions:
  check-in still expected a three-player roster, match preview selected the
  newly staged LIVE row instead of a scheduled fixture, and result entry looked
  for final-score controls on a row with an imported game. The fixture/specs
  were corrected to the real five-player and ruling contracts; the focused
  rerun passed 3/3 and the complete rerun passed 40/40.
- TypeScript passed. ESLint reported 0 errors and 40 existing warnings. The
  production build passed on Next.js 16.2.12 and generated 36 static pages.
- Targeted formatting and `git diff --check` passed.

### Manual browser verification

- Audited the homepage and all six section routes at 1440x900 and 360x812 in a
  clean regular-season fixture. Desktop Explore and the mobile menu expose the
  evergreen destinations; Escape closes Explore and restores trigger focus.
- Leaders, Meta, Records, and Compare showed the shared hierarchy, trusted-data
  warnings, pending weekly honors, deterministic records, real career choices,
  synchronized canonical/Open Graph data, and useful malformed, missing,
  same-player, and no-history comparison states.
- News kept the pinned item first, resolved title-specific permalinks to their
  targets, and degraded an unavailable animation to its original source link.
  Features marked all sample panels illustrative, exposed regular-season
  destinations, and explained the locked playoff preview.
- Invalid and repeated archive-season parameters completed as the documented
  noindex not-found UI. Because the root loading boundary has already streamed,
  the browser contract remains the automated 200 soft-404 result described
  below.
- Every route remained within the 360px document width; data tables used local
  horizontal scrolling where necessary. Hard reloads of the homepage, four
  statistics routes, News, and Features all completed without a stuck loading
  shell. No browser console errors were recorded.
- The first manual Compare load inherited an old empty `all-game-scores` entry
  from `.next/dev`; the database itself contained 25 trusted games and 30 mapped
  careers. Calling the environment-gated `POST /api/test/cache` boundary and
  reloading immediately exposed all 30 careers. Every automated fixture setup
  already performs this post-start reset, confirming the intended isolation
  path rather than a Compare eligibility defect.

### Remaining concerns

- News stores no administrator-authored media description. Generated attachment
  text prevents a nameless control but is not a meaningful text alternative for
  informative imagery or animation and does not fully satisfy WCAG 1.1.1.
- Discord and other external notifications still need a transactional outbox
  with durable intent, retry scheduling, deduplication, and administrator-visible
  failures beyond the guarded honors marker.
- News has no pagination, archive navigation, editing, or season/category
  filters; the unbounded page will become slower and harder to browse.
- A streamed invalid archived-season lookup renders the right not-found UI and
  injects `noindex`, but Next.js returns HTTP 200 after the root loading boundary.
  This soft 404 may affect crawlers and analytics.
- Public statistics still scan and decode JSON game blobs in application
  memory. Larger leagues will need normalized `GamePlayer` rows or materialized
  aggregates, along with pagination or searchable controls for long player,
  comparison, record, and news lists.
- Recovery guidance does not yet name the exact offending game or roster rule;
  administrators still diagnose and re-import manually.
- The mutation runner temporarily edits source files in place. It restores them
  during normal completion, but a hard kill or concurrent developer edit could
  leave or overwrite a mutation; isolated worktrees or atomic patch sandboxes
  would make the gate safer.
- A manual fixture server must call the fixture-only cache reset after startup,
  even when the database was seeded first, because Next's `.next/dev` data cache
  survives process restarts. Browser-suite setup does this automatically, but a
  dedicated manual launcher would make the rule harder to miss.
- Automated axe-style browser scanning remains absent.

### Recommended future improvements

Add authored news media descriptions and transcripts; introduce a durable
notification outbox; add cursor-based news pagination and editing/filtering;
evaluate a non-database route boundary if true archived-season 404 status codes
become an SEO requirement; normalize or materialize aggregate game statistics
at scale; build an administrator data-health view with exact game ids and guided
re-import; isolate mutation execution, add a fixture-server launcher that
performs cache expiry, and add automated browser accessibility scanning.

### Next section to audit

**League completion, archival, and offseason** — finals completion, champion
presentation, award finalization, immutable historical preservation, season
locking/reactivation, offseason visibility, safe phase reversal, and preparation
for the next season.

## Iteration 11 — league completion, archival, and offseason

Status: complete and verified.
This iteration deliberately stops before the independent inhouse lifecycle.

### Section audited

The transition from a decided grand final through COMPLETE, champion
presentation, season recap, archival, a real no-active-season offseason,
opening the next season, historical reactivation, and permanent deletion. The
audit covered `/`, `/admin`, `/players`, `/teams`, `/recap`, `/seasons`,
`/seasons/[id]`, `/hall-of-fame`, the champion Discord message, season export,
cross-season consumers, lifecycle server actions/services, Draft deadline
resolvers, playoff advancement, scoped Settings, authorization, stale-form and
duplicate-submit behavior, and cancellation races.

### Current purpose

Completion turns the final result into a durable champion and public season
record. Archival closes that completed league without destroying its teams,
matches, games, standings, bracket, registrations, side games, or operational
history. Offseason gives organizers an intentional pause with no active
season. From there they can open fresh signups, or reactivate one archived
season for a deliberate correction without silently displacing another live
league. Export and typed deletion are the final safety boundary around
historical data.

### Actors affected

- Visitors need an authoritative champion, useful recap and archive, and clear
  offseason navigation even when no active season exists.
- Players and standins need their season, roster, awards, predictions, fantasy
  results, and careers to remain understandable after completion.
- Captains and teams need the final bracket and roster record preserved, and
  must not have an archived auction silently resume or resolve.
- Administrators need distinct normal handoff, offseason, cancellation,
  reactivation, audit export, correction, and permanent-delete commands with
  honest consequences, stale-state protection, and production backup evidence.
- Maintainers own the no-active-season representation, champion proof,
  transactional lifecycle invariants, relationless Settings cleanup, archive
  query contract, and best-effort notification boundary.

### Problems found

- `createSeason` conflated three materially different operations: closing a
  completed league, cancelling an unfinished league, and opening signups. One
  ordinary-looking button could hide an unfinished season while appearing to
  perform a normal handoff.
- The product described an offseason but did not have a first-class way to
  remain there. Several pages assumed an active Season and became empty or
  directionless when there was none.
- COMPLETE alone was not enough proof for archive/handoff. A missing,
  inconsistent, cross-season, or non-final champion could be preserved as if
  it were authoritative.
- A lone completed PLAYOFF row could be mistaken for the final and crown a
  champion even though the public presentation contract required FINAL.
- Reactivation was a second implicit cancellation path: it could archive
  whichever season happened to be active. It did not claim the archived
  target revision and could revive legacy auction clocks that expired while
  the season was parked.
- Cancelling a DRAFT season did not atomically park a live lot. An already-open
  deadline resolver, Resume request, or playoff advancement could commit work
  after the Season became inactive.
- Season-setting forms read one active Season but could write after another
  admin archived, replaced, edited, or switched that Season.
- Repeated or array-valued `?season=` parameters reached Prisma filters on
  recap, Fantasy, Pick'em, and profile/archive paths, producing inconsistent
  metadata or server errors instead of one canonical request contract.
- Recap combined legacy and modern kill sources inconsistently and admitted
  partial/untrusted player blobs into awards. A completed manual-results season
  with no imported games also looked like a broken page despite still having
  an official bracket and champion.
- The champion Discord link used the active recap route rather than a permanent
  season-qualified URL, so it could point at a later season after handoff.
- Players and Teams offered no useful offseason route into history. Completion
  and cancellation terminology, empty archive sections, table semantics,
  focus targets, mobile controls, and destructive explanations were uneven.
- The export omitted referenced identities and relationless operational/audit
  state, had no format version or integrity digest, and was not read as one
  transactional snapshot. Permanent deletion could leave season-scoped
  Settings behind and relied too heavily on client-side confirmation state.
- Lifecycle and external notification ordering remains best effort; a database
  commit and Discord failure do not yet form one durable delivery workflow.

### Changes made

- Added `completedSeasonArchiveReadiness` as the shared normal-handoff gate.
  A season must be COMPLETE, resolve to an authoritative champion, and name a
  team from that same season. When postseason rows exist, the latest completed
  FINAL and stored champion must agree; champion-only legacy imports remain
  supported.
- Made the commands explicit in Admin. A valid completed season can be closed
  into offseason or closed and replaced with the next SIGNUPS season. An
  unfinished season has a separate typed **Cancel season and enter offseason**
  action that explains preservation and auction impact. Normal Create season
  refuses incomplete or inconsistent completion.
- Established zero active Seasons as the real offseason. The dashboard,
  Players, Teams, history, and admin handoff render dedicated states and next
  actions instead of inventing a fake phase or failing on a missing row.
- Made reactivation offseason-only. It refuses to replace an active season,
  compare-and-sets the selected archive's rendered revision, restores its exact
  saved phase, detects multiple-active corruption, and tells admins whether a
  legacy auction remains paused for review.
- Cancellation and reactivation now park only IN_PROGRESS/PAUSED Draft rows,
  clear both clocks, and preserve nomination, bidder, bid, bids, turn, budgets,
  rosters, and phase. Touching an already-paused row invalidates a stale Resume.
  NOT_STARTED and COMPLETE Draft rows remain unchanged.
- Draft deadline resolvers and playoff advancement now require an active
  season in the appropriate phase. Final crowning requires an actual FINAL and
  compare-and-sets active PLAYOFFS inside the same Serializable snapshot that
  revalidates the winner.
- Added active-season id plus `updatedAt` claims to rendered season-settings
  forms and a shared guarded write helper. A stale Season A form cannot copy
  its values into Season B or overwrite A after it was archived.
- Normalized season query parameters through the shared single-value decoder,
  with canonical/noindex metadata synchronized to the rendered result.
- Added a trusted recap summarizer using the same complete-5v5 decoder as the
  public statistics. Kill totals choose header or player-line data per game,
  mixed legacy/current imports no longer double count, and untrusted boxes are
  omitted with explicit recovery guidance. Official series, bracket, and
  champion presentation remain available with zero trusted Dota games.
- Made champion Discord links permanent with `?season=<id>` and kept champion
  delivery behind authoritative presentation validation.
- Improved archive/history cards, empty states, table labels/captions, focus
  behavior, restricted-state explanations, destructive copy, and 360px layouts.
  Active-season history visibly locks reactivation and links to the handoff;
  offseason enables phase-specific restore language.
- Upgraded the season audit export to format v2: one Serializable snapshot, relation
  closure for referenced users, Fantasy picks, predictions, availability,
  standins, reschedules, scoped Settings and admin events, privacy-limited user
  fields, row counts, and a SHA-256 digest. Concurrent archive changes return a
  retryable conflict instead of a mixed snapshot.
- Hardened permanent deletion with exact-name server validation, a rendered
  revision claim, active-season refusal at the destructive write, complete
  season-scoped Settings cleanup, and immediate all-time game-cache expiry.

No working league record or correction capability was removed. The behavior
change is separation: incomplete cancellation is now named and typed;
reactivation requires offseason; and completed closure requires authoritative
champion evidence. Existing archives keep their saved phase and can still be
restored deliberately.

### Architecture improvements made

- Completion proof is a pure policy plus a transactional service, shared by
  completed closure and next-season handoff rather than duplicated in UI code.
- Lifecycle writes use Serializable transactions, rendered identity/revision
  claims, compare-and-set updates, one result-change stamp, and explicit
  multiple-active detection. The schema still lacks a database uniqueness
  constraint, but application commands now preserve the invariant under tested
  contention.
- Draft parking is a single invariant shared by cancellation and legacy
  reactivation; deadline resolution and Resume have independent active/phase
  defenses.
- `summarizeRecapGames`, `singleSearchParam`,
  `seasonSettingScopeWhere`, and `updateRenderedSeason` centralize trusted
  aggregation, request decoding, relationless setting scope, and stale-form
  writes.
- The audit export now has an explicit versioned boundary and content digest,
  while delete uses the same setting-scope definition so archive scope and
  cleanup cannot silently drift apart. It is not a recovery artifact; the
  cross-cutting production audit adds a separate full-backup receipt gate.
- The mutation inventory was re-audited after the new lifecycle claims. Dead
  equivalent ids were removed, new same-row Serializable equivalents received
  reasons, and both behavioral Draft-status predicates plus the rendered
  settings revision predicate are protected by deterministic tests.

### Tests added or updated

- Completion/handoff integration covers authoritative same-season champions,
  missing/inconsistent champions, normal close-to-offseason, next-season
  creation, blank/replayed/stale forms, and concurrent handoffs with exactly
  one new active season.
- Cancellation coverage spans every unfinished phase, live auction
  preservation, expired lots, no budget/roster sale, NOT_STARTED/COMPLETE Draft
  preservation, multiple-active and stale revisions, and deterministic
  PostgreSQL cancellation-versus-Resume behavior.
- Reactivation coverage proves active-season refusal, real-offseason restore,
  exact phase/cursor preservation, stale/invalid revisions, multiple-active
  corruption, legacy live-auction parking plus fresh Resume clocks, non-live
  Draft preservation, and concurrent restore/create one-winner behavior.
- Draft and playoff suites prove inactive expired lots/nominations cannot
  resolve, cancellation during round construction creates no new round, and
  cancellation during crowning creates no champion.
- Settings integration uses a mutation seam to switch seasons after the form's
  pre-read and proves no old values land on either archive or replacement.
- Recap, champion presentation, query decoding, metadata, archive pages,
  export relation closure/digest/privacy, scoped cleanup, and destructive form
  confirmation received unit, route, guard, or integration coverage.
- Postseason Chromium coverage verifies completed handoff lock/error states,
  cancellation, real offseason, Players/Teams/history/archive states,
  reactivation-for-corrections, next-season creation, active reactivation lock,
  and 360px overflow. Baseline and regular-season suites were rerun for
  connected-workflow regression coverage.

### Commands run

- Focused Vitest unit and SQLite/PostgreSQL integration commands for season
  completion, cancellation, reactivation, Draft, playoffs, recap, query
  handling, export, and settings claims.
- `npm test -- --run`
- `npm run test:integration`
- `npm run pg:up`
- `npm run test:pg`
- Two focused `npm run test:mutation:discover -- --only ...` probes.
- `npm run test:mutation:discover`
- `npm run test:mutation`
- `npm run pg:down`
- `npx tsc --noEmit`
- `npm run lint`
- `npm run build`
- `npm run test:e2e`
- `npm run test:e2e:mid`
- `npm run test:e2e:postseason`
- Manual fixture seed/dev-server commands and in-app browser inspection.
- `git diff --check`

### Test results

- Full unit: 108 files, 1,517 passed.
- Full SQLite integration: 42 files, 973 passed and 20 intentional
  PostgreSQL-only cases skipped.
- Full real-PostgreSQL integration: 42 files, 989 passed. The disposable
  `ld2l_pgtest` database was dropped and the Prisma provider/client restored to
  SQLite afterward.
- Mutation discovery and ordinary verification: 102 live claims accounted for
  — 62 protected, 40 reviewed equivalents, zero unprotected. Both new Draft
  status protections were confirmed twice during discovery.
- Chromium: signup 27/27 passed; regular season 40/40 passed; postseason 10/10
  passed.
- TypeScript passed with no diagnostics. ESLint passed with 0 errors and 40
  existing warnings. The production build passed on Next.js 16.2.12 and
  generated all 36 static pages.
- `git diff --check` passed.

### Manual browser verification

- Inspected completion handoff, explicit cancellation, true no-active
  offseason, Players, Teams, season history, season archive, reactivation,
  and next-season creation in the in-app browser at desktop and 360px widths.
- Confirmed the completed-season handoff stays locked without authoritative
  evidence, cancellation uses its own consequence copy, offseason pages point
  into history, reactivation is available only with no active season, and
  opening a replacement immediately changes that control to a visible lock.
- Verified archive/history empty states and tables, permanent recap links,
  focusable controls, and no horizontal document overflow at 360px.
- Hard reloads completed without a stuck loading state. No browser console
  warnings or errors were recorded during the manual lifecycle pass.

### Remaining concerns

- Export v2 is an audit/reference artifact, not a backup or restore feature.
  There is no validated JSON import, dry run, id remapping, or digest
  verification UI; whole-database backup and rehearsed restoration are the
  recovery path.
- Historical registrations and games still point at mutable `User` identity,
  medal, and profile data. Some delete/cascade relationships can change what a
  historical page can present; the database is not an immutable event ledger.
- The database still lacks an enforceable partial uniqueness rule for one
  active Season, a lifecycle revision, and explicit `completedAt`/`archivedAt`
  timestamps. Serializable application commands carry those invariants today.
- Discord work remains best effort after database commits. There is no durable
  outbox/lease, ordered delivery, admin-visible pending/failure queue,
  correction retraction, or dedicated captain notification for season
  cancellation/offseason.
- `championTeamId` and several historical operational keys are bare ids rather
  than fully constrained season relations, leaving legacy/corrupt cross-season
  data dependent on application validation.
- Recap, archive, Hall of Fame, and export queries are unpaginated and perform
  application-memory aggregation; longer multi-year leagues will need
  pagination and/or materialized historical summaries.
- Opening, closing, reactivating, and cancelling seasons do not yet have a
  unified participant notification policy or public timeline of lifecycle
  changes.

### Recommended future improvements

If JSON portability becomes a product need, build a versioned importer with
dry-run validation and digest verification; rehearse whole-database recovery;
add database-backed lifecycle revision/timestamps and an
enforceable active-season invariant where the production database permits it;
snapshot historical display identity deliberately; introduce a transactional
notification outbox with ordered retries, failure visibility, cancellation
messaging, and correction retractions; constrain or migrate legacy bare ids;
and paginate or materialize growing recap/archive/career queries.

### Next section to audit

**Inhouse lifecycle** — queue entry and presence, ready check, captain vote,
player draft, lobby readiness and launch, result detection and manual recovery,
Elo, Cred betting and settlement, Discord board synchronization, completed
history, empty/error/reconnect/mobile/accessibility states, and
season-independent operation during the league offseason.

## Iteration 12 — inhouse lifecycle

Status: complete and verified.

### Section audited

The complete season-independent inhouse workflow: public discovery, queue
entry and presence, next-game waiting, ready checks, captain selection votes,
captain recovery, snake draft, lobby launch, automatic and manual result
recording, Elo and career summaries, Cred betting and settlement, cancellation
and void correction, Discord queue-board synchronization, completed-game
history, admin recovery controls, and offseason availability.

### Current purpose

Inhouse is the league's year-round pick-up-game mode. A player can join a
ten-person queue, accept a ready check, choose how captains are selected, draft
two sides, launch a private Dota lobby, and have the result recorded without
requiring an active season. Visitors can understand the workflow and inspect
the ladder and completed history. Administrators can recover interrupted
captain selection, results, settlements, and Discord-board state.

The feature is intentionally available during signups, draft, regular season,
playoffs, finals, and true offseason. League phase does not gate participation;
authentication, lobby membership, captain status, and administrator role gate
individual actions instead.

### Actors affected

- Visitors and signed-out players discovering the mode, ladder, and history.
- Queued players, accepted players, captains, active-game participants, and
  people waiting for the next game.
- Administrators correcting an interrupted draft, result, bet settlement, or
  Discord board.
- League operators and maintainers responsible for Discord, OpenDota,
  persistence, permissions, and recovery behavior.

### Problems found

- A cold-load API failure could leave the page looking like it was still
  loading forever, and a cold-start 429 had no usable retry path.
- Once a lobby existed, spectators and players not in that lobby could not
  enter a clearly separate next-game queue. A backend captain-recovery action
  also had no reachable admin interface.
- Hidden-tab presence updates were too infrequent for a time-sensitive captain
  vote. Pending Cred settlement was not visible to players.
- Read and mutation traffic shared an IP bucket, which penalized shared
  households and venues. Missing or malformed actions were weakly handled and
  truthy values could trigger a forced cancellation.
- Captain votes could be accepted after their deadline under contention.
  Queue time was not snapshotted into a lobby, so creation timestamps and
  retry activity could change draft order, automatic picks, and ready-check
  requeue order.
- Career calculations silently stopped at 500 games. Result, Elo, Discord, and
  void operations could race; a void with no bets could leave a stale result
  post, and only forced cancellations were consistently audited.
- Cancellation or voiding could return before its own settlement completed.
  The global sweeper could process a different lobby first, and one poison row
  could block all later work.
- Generic `updatedAt` retry writes could make an old game appear to be the
  newest result or board activity. The archive silently showed only the latest
  100 games, used formation time rather than played time, and trusted malformed
  imported box scores too readily.
- Discord board creation had no pre-send reservation. Ambiguous webhook
  responses, late sends, concurrent post/remove operations, and expired leases
  could create duplicates, orphan a message, or overwrite newer state.
- The dashboard and Discord administration treated inhouse as season-bound,
  making a year-round feature harder to discover and operate in offseason.
  Product and architecture documentation had drifted from the implementation.

### Changes made

- Added an explicit accessible cold-start error state and retry action. A 429
  now leaves loading, successful-but-unreadable mutations enter an honest
  reconciliation state, and loading/progress/force-cancel dialog semantics now
  expose their state to assistive technology.
- Added a live next-game queue for guests and authenticated nonparticipants
  while another lobby is active, plus an admin captain-recovery picker. The
  force-cancel dialog now traps and restores focus, locks background scrolling,
  and explains the consequence. The manual match-id control now fits mobile.
- Reduced hidden-tab presence keepalive to ten seconds and surfaced pending
  Cred settlement in the lobby. Queue order is now an immutable `queuedAt`
  snapshot with user id as the deterministic tie-breaker; formation, state,
  captain candidates, automatic picks, and ready-check requeue all use it.
- Hardened the API boundary with object/action validation, authentication for
  every mutation, literal `force: true`, a 1,200/minute public read bucket, and
  a separate 300/minute authenticated-user mutation bucket with signed-out IP
  fallback.
- Made captain voting deadline-aware inside the atomic write. Career/Elo
  snapshots now use the full completed history instead of a 500-game window.
- Serialized exact result finalization against voiding, awaited result Discord
  delivery within a bounded transaction, audited every cancellation, and sent
  a correction for every void including betless games. Cancel and void settle
  their own canonical row before returning.
- Reworked the settlement sweeper into oldest-first batches of 25 with per-row
  isolation and retry rotation. Added immutable lobby `completedAt`; public
  chronology, last-result selection, board state, and void targeting no longer
  treat settlement retry writes as game completion.
- Added one shared chronology policy and defensive box-score parser. History
  now paginates every completed game at 100 per page, clamps invalid page
  input, links exact rows for admin voiding, labels tables, uses true played
  time, and offers stable newer/older navigation.
- Added a pre-POST Discord board reservation with a 30-second lease,
  compare-and-set tracking/removal, late-post cleanup, and explicit
  `posting`/`postingStuck` admin states. Ambiguous message ids remain visibly
  reserved for operator inspection and cannot silently trigger a duplicate
  retry.
- Restored offseason dashboard discovery and evergreen inhouse Discord
  controls. Updated the README, contributor guidance, and architecture
  reference to match the tested queue, chronology, settlement, rate-limit, and
  board-reservation behavior.

No working league or inhouse capability was removed. The intentional behavior
changes make next-game waiting explicit, preserve true queue chronology, and
prefer visible operator recovery over guessing after an ambiguous external
Discord write.

### Architecture improvements made

- Separated immutable domain timestamps (`queuedAt` and `completedAt`) from
  persistence/retry timestamps so ordering does not depend on maintenance
  activity.
- Centralized chronology, history-page policy, and untrusted box-score parsing
  for the board, landing page, profile links, and archive.
- Split exact-target settlement from bounded global recovery and made the
  latter fair under row-specific failure.
- Modeled Discord board publication as a leased, compare-and-set reservation
  rather than an unguarded external side effect.
- Consolidated route validation, authorization, action dispatch, and
  read-versus-mutation limiting at the API boundary.
- Extended integration seams around result/void ordering, queue snapshots,
  Discord ambiguity, and settlement retries without introducing unrelated
  refactors.

### Tests added or updated

- Route tests cover malformed bodies, missing/unknown actions, signed-out
  mutation refusal, independent rate buckets, literal force semantics, and
  post-mutation state reconciliation.
- UI unit and Chromium tests cover cold-load errors, 429 recovery, unreadable
  mutation responses, hidden-tab presence, mobile match-id entry, next-game
  queues for visitors and members, captain recovery, pending settlement, and
  force-cancel dialog keyboard/focus behavior.
- SQLite and real-PostgreSQL integration tests cover deadline vote races,
  deterministic queue order, ready-check requeue, full-history career values,
  exact result-versus-void ordering, betless correction posts, cancellation
  audit, target-first settlement, poison-row rotation, immutable chronology,
  malformed boxes, paging, board reservation expiry, ambiguous webhook
  responses, and post/remove interleavings.
- Mutation coverage was refreshed after the new compare-and-set and lifecycle
  predicates; all live claims are either behaviorally protected or documented
  as reviewed equivalents.

### Commands run

- Focused Vitest unit, SQLite integration, real-PostgreSQL integration, and
  Chromium commands for API, queue, board, chronology, result, void, Cred, and
  responsive behavior.
- `npx prisma format`
- `npx prisma generate`
- `npm test -- --run`
- `npm run test:integration`
- `npm run pg:up`
- `PG_TEST_URL=... npm run test:pg`
- `npm run test:mutation:discover`
- `npm run test:mutation`
- `npm run pg:down`
- `npx tsc --noEmit --pretty false`
- `npm run lint`
- `npm run build`
- `npm run test:e2e`
- `npm run test:e2e:mid`
- `npm run test:e2e:postseason`
- Manual fixture/dev-server and in-app browser inspection.
- `git diff --check`

### Test results

- Full unit: 110 files, 1,543 passed.
- Full SQLite integration: 42 files, 994 passed and 24 intentional
  PostgreSQL-only cases skipped (1,018 total).
- Full real-PostgreSQL integration: 42 files, 1,018 passed. The disposable
  database was stopped and the Prisma provider/client restored to SQLite.
- Mutation discovery and ordinary verification: 105 live claims accounted for
  — 65 protected, 40 reviewed equivalents, zero unprotected. Every protected
  claim remained protected in the ordinary verification run.
- Chromium: signup 29/29 passed; regular season 40/40 passed; postseason 10/10
  passed. The focused inhouse browser run passed 7/7.
- TypeScript passed with no diagnostics. ESLint passed with 0 errors and 39
  existing warnings. The production build passed on Next.js 16.2.12 and
  generated all 36 static pages.

### Manual browser verification

- Inspected the signed-out inhouse landing page on desktop and at 360x800, the
  mobile completed-history empty state, the authenticated queue form, and the
  inhouse Discord administration section.
- Confirmed headings and progress semantics, clear signed-out and authenticated
  next actions, the labeled 0–12,000 MMR control, role-aware disabled admin
  controls with explanatory copy, and no horizontal overflow at 360px.
- Verified the year-round/offseason wording, empty ladder/history guidance,
  OpenDota setup disclosure, queue slots, and Discord board status remain
  understandable without fixture data.
- Hard navigation completed without a stuck loading state. The browser console
  contained no warnings or errors during the final pass.

### Remaining concerns

- Discord result, correction, queue-alert, and board effects still lack a
  durable outbox. Result delivery can hold a database row lock for up to five
  seconds, and a process crash can still split database and webhook state.
- Automatic result recovery requires two recognizable players per side.
  Voiding cancels a record, but there is no dedicated reopen/correct/re-record
  workflow for a wrongly matched game.
- Elo, career, and formation record snapshots scan completed history; growth
  will eventually require materialized aggregates or incremental snapshots.
- Rate limiting is in-process and per application instance, not distributed.
- There is no inhouse-specific ban, suspension, or moderation workflow.
- Cred ledger rows are append-oriented but the special `FLOOR` cleanup path can
  delete rows; strict audit immutability is not enforced by the database.
- Lazy timeout/settlement resolvers and board synchronization still depend on
  application traffic and uptime. There is no operator health monitor.
- One active inhouse lobby is an application-level invariant without a
  database partial-uniqueness constraint.
- The 25-row sweeper rotates row-specific poison work, but a database-wide
  outage necessarily prevents the entire batch.
- Hidden-tab browser timer throttling remains platform-dependent even with the
  shorter keepalive.

### Recommended future improvements

Introduce a durable notification outbox with idempotency and operator-visible
retries; add an explicit result correction/reopen state; materialize Elo,
career, and captain records; add inhouse moderation controls; move rate limits
to shared storage for multi-instance deployment; redesign the Cred floor rule
around an immutable day-keyed ledger; add settlement/board/timeout health
monitoring; and enforce the single-active-lobby invariant in the production
database where supported.

### Next section to audit

**Cross-cutting final audit** — reconcile the role/permission and league-phase
matrix across every audited workflow, then verify global accessibility,
responsive consistency, performance, security boundaries, operational
monitoring, backups/restoration, and production-PostgreSQL readiness. It is
completed in [Iteration 13](#iteration-13--cross-cutting-final-audit).

## Iteration 13 — cross-cutting final audit

Status: complete and verified on 2026-08-04.

### Section audited

The final audit reconciled every previously audited page and workflow across
roles, league phases, direct-URL access, responsive and accessible behavior,
security boundaries, external identity, rate limiting, auditability,
notification durability, database concurrency, production configuration,
backup verification, restoration, CI, and release validation.

This pass also closes the scope gap left by Iteration 5. That iteration fully
audited the live auction but did not separately report the connected team and
roster-maintenance workflow promised by the original audit order. The
retrospective below records its purpose, actors, data dependencies, phase
policy, UI states, races, and tests without rewriting the historical Iteration
5 report.

The controlled audit loop is now complete:

| Iteration | Section | Status |
| --------- | ------- | ------ |
| 1 | Global shell and phase-aware dashboard | Complete |
| 2 | Identity and onboarding | Complete |
| 3 | Season creation and signup | Complete |
| 4 | Captain selection and draft readiness | Complete |
| 5 | Live auction draft | Complete |
| 6 | Schedule generation and weekly logistics | Complete |
| 7 | Match detail, results, and playoff handoff | Complete |
| 8 | Standings, playoffs, final, and champion | Complete |
| 9 | Fantasy and Pick'em | Complete |
| 10 | Public statistics and content discovery | Complete |
| 11 | Completion, archive, and offseason | Complete |
| 12 | Inhouse lifecycle | Complete |
| 13 | Cross-cutting roles, phases, security, accessibility, and operations | Complete |

### Current purpose

The application has two related products: a phase-driven amateur league and a
year-round inhouse room. The cross-cutting layer must make both products feel
like one trustworthy service. It gives each actor the right information and
next action, prevents a stale or unauthorized client from writing through a
hidden control, preserves one authoritative lifecycle across UI and database
commands, and gives operators evidence that the deployed database can be
protected and recovered.

The purpose is not to make every feature available everywhere. It is to make
availability deliberate: the UI and direct mutation agree, locked actions say
why, recovery commands own their collateral, and public views never expose
private league contact or attendance data merely because a visitor found the
URL.

### Actors affected

- Visitors following the league, draft, schedule, statistics, archives, and
  public inhouse state without receiving participant-only contact or RSVP
  data.
- Authenticated members maintaining a Steam-backed identity, linking Discord,
  joining a season or inhouse, and playing Fantasy or Pick'em when open.
- Active players and standins editing their own commitments, checking in,
  understanding locks, and receiving accurate roster or match-night state.
- Captains drafting, reading operational attendance, arranging standins and
  reschedules, maintaining teams, and reporting Dota results.
- Administrators advancing phases, correcting rosters/results, withdrawing a
  team, configuring integrations, reviewing logs, revoking sessions, and
  recovering or deleting season data.
- League operators and maintainers responsible for PostgreSQL, Vercel,
  backups, Discord/OpenDota/Steam integration, monitoring, CI, and incident
  recovery.

#### Consolidated role matrix

| Actor | Public/read access | Ordinary interaction | Private/operational access |
| ----- | ------------------ | -------------------- | -------------------------- |
| Visitor | Public dashboard, teams, schedule, draft spectator state, statistics, news, archives, and inhouse state/history | No league or inhouse mutations until sign-in | No Discord directory, named RSVP, or readiness details |
| Authenticated member | Visitor access plus their own profile, own contact, own RSVP, and side-game state | Steam-derived Dota metadata refresh, Discord link, eligible signup, Fantasy/Pick'em, and inhouse participation | No other-player contact or league-wide attendance unless they become an active participant |
| Active registrant/player | Member access plus participant navigation and draft commitment | Edit an existing active signup until COMPLETE subject to auction/roster locks; confirm draft readiness and RSVP when on the current match-night roster | League contact directory and aggregate readiness, but not named opponent attendance |
| Standin | Participant access while the standin signup is active | Join/edit through PLAYOFFS; an assigned standin replaces the covered seat for RSVP and import authority | Own assignment/RSVP plus the same active-participant directory and readiness summary |
| Captain | Player access plus team authority | Nominate/bid, manage own-team cover, negotiate reschedules, hand over captaincy where allowed, and import/report the team's result | Named RSVP for both teams in the fixture and captain-only scouting/operations needed to arrange the match |
| Administrator | All public and protected reads | Policy-approved lifecycle, draft, roster, schedule, result, playoff, integration, security, archive, and recovery commands | Full directory/readiness and the streamed AdminAction/health/configuration views; production authority comes from the live Steam allowlist |

No role is trusted from a hidden button. Pages may omit a control for clarity,
but every Server Action and Route Handler independently resolves the current
session, role, expected season/row state, and phase before writing.

#### Consolidated phase matrix

Identity, public history, news/statistics, and the season-independent inhouse
mode remain available in every row below. The table describes the drafted
league workflow.

| League state | Player/captain interaction | Roster, schedule, and result policy | Administrator transition/recovery |
| ------------ | -------------------------- | ----------------------------------- | ---------------------------------- |
| Offseason (no active Season) | Identity and history only; no season signup | Archives are read-only | Create new SIGNUPS or deliberately reactivate one archive; never silently replace an active season |
| SIGNUPS | New full-player and standin admission; existing signup edits; captain volunteering and draft commitment | Captain/team setup is open; no post-draft signing, release, schedule, or results | Configure season/captains/draft, or open DRAFT; cancellation enters offseason without deleting data |
| DRAFT / NOT_STARTED | Existing players may edit non-auction-sensitive profile data; standins may join/edit; captains prepare | Admin may promote an active unassigned standin before Start so they enter the pool; sign/release remain locked; schedule/Fantasy wait for auction COMPLETE | Start is the only command that opens the auction; safe return to SIGNUPS is allowed only before competitive artifacts exist |
| DRAFT / IN_PROGRESS or PAUSED | Captains nominate/bid when live; ordinary roster/type/revival/MMR writes that would change the auction are locked | Promotion, sign, release, schedule, and match results are locked; PAUSED exposes the narrow recovery tools | Pause/resume/void lot/undo/Abort own auction collateral; a generic phase button cannot strand a live auction |
| DRAFT / COMPLETE | Auction is read-only; existing signup profile edits and standin participation remain available | Promotion plus sign/release are open; schedule and Fantasy may open before the broad phase handoff | Advance to REGULAR_SEASON after revalidation; Abort remains the deliberate pre-result reset rather than a phase flip |
| REGULAR_SEASON | RSVP, standin cover, reschedule, Fantasy/Pick'em locks, and captain result reporting follow each fixture's own authority/deadline | Promotion and sign/release remain open; team withdraw/reinstate is available only here; regular results/imports are writable, postseason results are not | Start playoffs through the seeding command; safe recovery can reopen an existing proven bracket, but unsafe jumps are refused |
| PLAYOFFS | Assigned match-night actions remain available where the playoff fixture permits them; standins may still join/edit | Promotion and sign/release remain open; team withdrawal is locked because seeding already exists; only playoff/final results write | Bracket advancement/crowning is automatic from authoritative results; Reset/Return/correction controls own bracket collateral |
| COMPLETE | Season-specific signup, roster, side-game, and match interactions are read-only | No promotion, sign, release, withdrawal, or ordinary result mutation; archived queries remain available | Dedicated grand-final/playoff correction, archive/handoff, export, reactivation, or receipt-gated deletion only |

Competitive side rules fit inside that matrix: Fantasy opens after auction
completion and locks on the first imported game; each Pick'em selection locks
at its fixture deadline; regular results write only in REGULAR_SEASON and
playoff/final results only in PLAYOFFS; direct URLs apply the same gates.

### Problems found

- Phase controls were broader than the workflows they represented. A generic
  phase editor could skip the command that must also start/abort an auction,
  seed/remove a bracket, or crown/retract a champion. Several write paths also
  selected the newest active season instead of failing closed if bad data
  produced two active rows.
- Roster maintenance lacked a consolidated lifecycle contract. Promotion,
  signing, release, team withdrawal, reinstatement, Start, Abort, standin
  cover, and result import could be individually sensible but still race into
  a mixed roster or stale fixture state.
- `saveRegistration` could pass its signup-phase reads while `startDraft`
  snapshotted the pool, then commit a player/type change into the now-running
  auction. The UI lock did not close that write-skew window.
- RSVP presentation could drift from write authority. A rostered-but-replaced
  player, an assigned standin, an archived/untimed/late fixture, or a phase
  change could leave a visible check-in control that the action correctly
  refused. Signed-in outsiders could also receive more named attendance or
  contact data than they needed.
- Production administrator authority was reconciled mainly at login. Removing
  a compromised Steam id from the allowlist should revoke an already-issued
  cookie's admin authority on the next request, not at the next login.
- Steam's return cookie did not provide a separate browser-state nonce strong
  enough to bind one exact OpenID round trip. Duplicate OpenID fields and
  insufficiently pinned verification fields widened the callback surface.
- Discord OAuth state did not bind the initiating site user. A person could
  change site accounts in another tab during consent; the callback needed
  PKCE, one-shot state, duplicate-parameter rejection, and a session-swap
  refusal before external token work.
- The profile still allowed an arbitrary Dota account id. That could not prove
  ownership, could collide with the verified owner, and made every OpenDota
  rank/scouting write depend on an untrusted link.
- JSON Route Handler mutations did not share one content-type and canonical
  same-origin policy. The anonymous draft tick could also reach session and
  database work before taking an IP allowance, and attacker-controlled limiter
  keys could grow the per-instance Map without a hard bound.
- Contact details, named RSVP answers, and readiness summaries did not have one
  reusable policy. Some pages equated any authenticated account with an active
  participant and fetched private rows even when they were later hidden.
- Global motion reduction, progress semantics, focus treatment, error/brand
  contrast, and lazy avatars depended too much on individual components.
  Team/player chips could overlap adjacent tap targets on narrow screens; seven
  overlapping pairs were measured in the phone team roster before correction.
- The administrator activity stream omitted important security, configuration,
  roster, team, registration, schedule, and manual result/import mutations.
- Development bootstrap and Setting throttle claims caught `P2002` inside an
  interactive transaction. Under real PostgreSQL contention, the unique
  violation can poison the transaction instead of behaving like a harmless
  lost claim.
- Production pooled/direct URI validation did not prove both URLs represented
  the same logical database, and `--accept-data-loss` could be enabled by a
  stale broad acknowledgement. Backups lacked one private atomic format,
  credential-free identity metadata, a signed recent-verification receipt, and
  a hard-delete gate tied to the current database.
- SQLite backup-by-copy could capture a live WAL inconsistently. A checksum
  alone proved bytes, not that PostgreSQL SQL could restore into a coherent
  scratch database.
- Inhouse RESULT and RESULT_VOIDED Discord messages were ordinary post-commit
  effects. A process failure could lose the post; sending under a row-holding
  transaction made webhook latency part of database contention; a void racing
  an in-flight result needed durable ordering.
- Security headers were implicit, reduced to framework defaults, and not
  pinned by tests. Production still had a vulnerable Next.js patch level and
  CI did not exercise every SQLite, PostgreSQL, mutation, browser, build, and
  database-safety gate with isolated URLs.

### Changes made

- Added `seasonPhasePolicy`, shared by UI and mutation. It permits only the
  positive non-destructive handoffs and proven recovery shapes; unsafe jumps
  point to the dedicated auction, bracket, champion, or archive command. Phase
  writes now re-read Season, Draft, results, games, and postseason rows in a
  Serializable transaction and compare-and-set the expected active season and
  phase.
- Replaced active-season `findFirst` assumptions with `singleActiveSeason`.
  Reads fetch at most two active rows and throw a data-integrity error rather
  than serving a random current league. Lifecycle writers remain Serializable
  because neither supported schema has a portable partial-unique constraint.
- Closed the `saveRegistration` versus `startDraft` write-skew. Signup
  creation, revival, type/MMR-sensitive changes, and Start now participate in
  one contention domain; a deterministic real-PostgreSQL interleaving proves
  that either the saved player enters the pool before its snapshot or the
  stale registration write is refused after Start.
- Made RSVP rendering consume the same lifecycle gate and standin-adjusted
  match-night roster as `setAvailability`. Replaced players no longer receive
  a misleading action, assigned standins do, and archived/locked/untimed or
  stale fixtures remain read-only. Named attendance queries now return both
  teams only to their captains/admins, while other signed-in users receive at
  most their own answer.
- Made `ADMIN_STEAM_IDS` a live authorization policy. Production resolves it
  on every authenticated request, so removal revokes an existing admin cookie
  on the next request. Production has no first-user bootstrap; the immutable
  bootstrap claim remains local-development-only.
- Hardened Steam OpenID with a 32-byte one-shot browser state bound into the
  signed return URL, exact canonical return/identity/signed-field validation,
  duplicate parameter rejection, exact `is_valid:true` verification, and
  cookie consumption on every callback exit.
- Upgraded Discord linking to a versioned ten-minute one-shot cookie that binds
  random state, the PKCE verifier, initiating site user, and safe return path.
  The callback rejects duplicate state/code, stale cookies, and a replacement
  site session before shared-IP rate limiting or token exchange.
- Removed arbitrary self-service Dota claims. Normal Dota identity is derived
  from the Steam identity that OpenID proved. A legacy override may be retained
  or cleared but cannot be changed to an arbitrary account; a verified-owner
  login atomically retires another user's conflicting legacy override and its
  medal/private/scouting metadata. Cross-roster classification fails closed if
  one effective account appears on both teams.
- Added the shared JSON boundary: draft JSON routes require
  `application/json` and canonical same-origin proof; the inhouse public state
  read requires JSON content type but remains origin-independent; every
  inhouse mutation also requires same-origin proof. Draft tick takes a generous
  IP preflight before session/database work and then its per-user allowance.
  The in-memory limiter now prunes/evicts to a maximum of 5,000 live keys.
- Centralized visibility. Contact details are self/admin/active-participant;
  named RSVP is captain/admin (with a player still seeing their own answer);
  aggregate readiness is active-participant/admin. Players, profiles, teams,
  draft payloads, schedule, dashboard, match detail, and standin cards use the
  same policy and avoid private queries for outsiders.
- Added a global reduced-motion catch-all, accessible Progress semantics,
  motion-safe spinner/ping behavior, visible field focus, opaque AA error/brand
  colors, and lazy asynchronous avatars. Fixed the shared chip/action spacing
  that caused narrow team cards to overlap, and removed the browser test's
  overlap exceptions so future hit-box collisions fail directly.
- Added hydration-safe response headers on every route: CSP
  `base-uri`/`form-action`/`frame-ancestors`/`object-src`, frame denial,
  `nosniff`, strict-origin referrers, HSTS, and a restrictive Permissions
  Policy.
- Expanded AdminAction coverage to session revocation, season/settings and
  Discord configuration, registration moderation, captain/roster/team actions,
  promotion, team rename/withdraw/reinstate, schedule/week/match retiming,
  result rulings, and manual import/detection. Automated routine sync remains
  outside the human activity stream.
- Replaced conflict-catching bootstrap/throttle claims with database-native
  `INSERT ... ON CONFLICT DO NOTHING`, followed by an authoritative read where
  a winner identity is needed. Concurrent first-user development login and
  first-throttle races now lose as an ordinary zero-row claim instead of
  poisoning a PostgreSQL transaction.
- Added strict production environment validation for separate auth/backup
  secrets, canonical HTTPS origins, admin Steam ids, and logically matching
  pooled/direct PostgreSQL identities, including normalized Neon and common
  Supabase poolers. Production builds run schema push only after a successful
  compile; `--accept-data-loss` requires the exact phrase plus the current
  40-character Vercel commit SHA.
- Made backups private and atomic. PostgreSQL passes its URI through
  `PGDATABASE`, writes a full dump plus checksum and credential-free database
  identity metadata, and uses a separate HMAC receipt secret. SQLite uses its
  online `.backup` API and `PRAGMA integrity_check`. Verification can mint a
  signed receipt only for intact metadata-bearing artifacts; a production hard
  delete accepts only a same-database PostgreSQL full-dump receipt created and
  verified within 24 hours. Season JSON is explicitly audit/reference-only.
- Restored a PostgreSQL dump into a new disposable database with
  `ON_ERROR_STOP`, checked representative marker and league rows, and queried
  the restored schema successfully before destroying the scratch database.
- Added durable `InhouseAnnouncement` RESULT/RESULT_VOIDED rows. The exact
  result payload commits with Elo finalization; webhook work runs outside the
  transaction under a tokened 30-second lease with backoff. Void cancels only
  an unsent PENDING result; a SENDING/SENT result is followed by sequence 2.
  The sitewide heartbeat drains the outbox even when the room and queue are
  empty.
- Upgraded to Next.js 16.3.0, corrected isolated CI database URLs, added the
  PostgreSQL and four-shard mutation gates plus all three browser suites, and
  hardened destructive test/database commands to exact local scratch names.

Historical note: Iteration 2's manual-Dota ownership concern and Iteration
12's statement that result/correction delivery had no outbox accurately
described those iterations at the time. They are superseded by the verified
Steam-derived identity and durable inhouse RESULT/RESULT_VOIDED outbox above.
Other low-collateral Discord notifications remain best-effort unless their own
documented Setting/reservation workflow says otherwise.

#### Iteration 5 roster-maintenance retrospective

The roster workflow exists to turn auction output into a maintainable amateur
team through inevitable late joins, departures, standin conversions, and full
team withdrawals without rewriting played history or corrupting the auction.
It affects administrators, captains, drafted/released players, promoted
standins, teams awaiting cover, and every schedule/import/playoff consumer.

Its authoritative data is Season, Draft, Registration, Team, TeamMember,
StandinAssignment, Match, Game, RescheduleRequest, reminder/announcement
Settings, and AdminAction. `signFreeAgent` fills an open seat with an active
full player at $0. `releasePlayer` atomically removes a non-captain seat,
refunds its auction price, and cancels only cover on an unstarted series.
`promoteStandinToPlayer` changes one active, unassigned standin into a full
player. `withdrawTeam` keeps roster and played history but awards each remaining
regular fixture to the opponent and cancels dependent open logistics;
`reinstateTeam` restores eligibility while leaving each forfeit as an explicit
result that an admin may reopen individually.

The final policy is explicit:

- During SIGNUPS a person switches Standin/Player on their own profile.
- In DRAFT, promotion is allowed before Start and after COMPLETE, never while
  the auction is IN_PROGRESS or PAUSED.
- Promotion remains available in REGULAR_SEASON and PLAYOFFS, never after the
  season is COMPLETE, and refuses an active unplayed standin assignment.
- Sign and release open at DRAFT COMPLETE and stay open through PLAYOFFS. They
  are locked during SIGNUPS, a missing/unstarted/live/paused auction, and
  COMPLETE.
- Team withdraw/reinstate is REGULAR_SEASON-only. Before play, captain/team
  teardown owns the problem; after playoff seeding, the bracket result owns it;
  after completion, withdrawal is historical.

The administrator UI keeps locked controls visible with the phase-specific
reason and the correct alternative. Every action carries the expected active
season or row id and rechecks lifecycle in its Serializable transaction. The
promotion-versus-Start and withdrawal-versus-phase/result races now pick one
winner; sign/release also serialize against standin assignment so a covered
seat cannot become a phantom sixth account. `roster-moves.itest.ts`,
`standins-raced.itest.ts`, `team-withdraw.itest.ts`, and
`admin-flow-audit.itest.ts` cover phase gates, refunds/cover collateral,
duplicate actions, direct calls, and the real-PostgreSQL interleavings.

### Architecture improvements made

- The positive season phase policy, registration policy, roster gates,
  availability policy, personal-data visibility, JSON mutation boundary, and
  backup identity rules now live in small shared modules instead of JSX or
  one-off action prechecks.
- Active-season reads fail closed; lifecycle writes claim the expected season
  in Serializable transactions. Storage-level uniqueness remains a documented
  production limitation instead of being simulated with an arbitrary newest
  row.
- Steam OpenID is the Dota ownership proof. `User.dotaAccountId` remains a
  unique nullable `Float` deliberately: every unsigned 32-bit Dota account id
  is exact in double precision, while Prisma/PostgreSQL signed `Int` cannot
  represent the full range.
- OAuth callbacks separate cheap local identity/state checks from shared-IP
  limiting and external network work. JSON route mutations share one
  canonical-origin implementation rather than relying on CORS assumptions.
- PostgreSQL conflict-skipping claims replace caught unique errors inside
  interactive transactions for bootstrap and throttling. Deterministic race
  seams protect the new signup/Start, promotion/Start, team withdrawal, phase,
  and outbox predicates.
- Inhouse Discord result publication is a durable ordered outbox rather than a
  network call under a database lock. The remaining Discord exactly-once
  markers/reservations keep their narrower existing ownership.
- Backup creation, verification, authorization, and restoration are separate
  steps: checksum proves bytes, HMAC receipt proves recent verification and
  logical identity, and the scratch drill proves practical restorability.
- Admin logging is broad enough to reconstruct consequential human operations
  while remaining honest that automatic maintenance is not an exhaustive event
  ledger.
- Global accessibility and response-security baselines protect future pages by
  default; components still add feature-specific semantics where needed.
- CI now treats SQLite behavior, real PostgreSQL contention, mutation strength,
  all league chapters in Chromium, build integrity, dependency advisories, and
  provider restoration as release gates rather than optional local checks.

### Tests added or updated

- Season phase-policy and source-guard tests cover every allowed/refused
  transition, current-state explanation, duplicate-active-season failure, and
  direct mutation revalidation.
- Registration, rank-sync, and authentication integration tests cover live
  admin allowlist changes, development bootstrap contention, verified Dota
  collision cleanup, legacy override retention/clear, duplicate first signup,
  admin-removal races, COMPLETE freezes, and the deterministic
  `saveRegistration` versus `startDraft` interleaving.
- Steam and Discord Route Handler/unit tests cover one-shot state, PKCE,
  duplicate parameters, signed-field/canonical identity pinning, session swap,
  callback rate order, safe return paths, and consumed cookies.
- Draft/inhouse route tests cover media type, missing/null/foreign/noncanonical
  Origin, public-state exception, signed-out attempts, preflight limiter order,
  bucket independence, and the 5,000-key memory bound.
- Visibility/source tests cover contacts on Players/profile/team/draft,
  self-only versus captain-named RSVP, participant readiness summaries, and
  query omission for outsiders. Availability integration tests cover rostered,
  replaced, assigned-standin, archived, phase-locked, untimed, duplicate, and
  stale-tab behavior.
- Roster tests cover the retrospective matrix above, including promotion versus
  Start and team withdrawal versus phase/result contention on PostgreSQL.
- Inhouse integration tests cover durable payload creation, failed-send retry,
  lease exclusivity/recovery, pending cancellation, result-before-correction
  sequence, and a deterministic void while RESULT is held SENDING. Mutation
  coverage proves the `kind + status` cancellation predicate is load-bearing.
- Backup/build/environment tests cover pooled/direct identity normalization,
  credential-free command arguments, private modes, atomic partial cleanup,
  SQLite online snapshot integrity, receipt expiry/kind/database mismatch,
  commit-bound data-loss acknowledgement, and production-only schema writes.
- Security-header and UI source tests pin the CSP/header baseline, Progress,
  reduced motion, contrast/focus classes, lazy avatars, and card action spacing.
- Browser coverage removed overlap exemptions and exercises the team roster,
  private directory/RSVP states, every primary role, phase locks, direct URLs,
  and destructive backup-receipt copy at desktop and phone widths.

### Commands run

- Focused Vitest unit and SQLite/PostgreSQL integration commands for phase,
  registration, auth/OAuth, roster, privacy, inhouse outbox, rate limiting,
  admin logs, security headers, backup, and build scripts.
- `npx prisma format`
- `npx prisma generate`
- `npm test -- --run`
- `npm run test:integration`
- `npm run pg:up`
- `PG_TEST_URL=... npm run test:pg`
- `PG_TEST_URL=... npm run test:mutation:discover`
- `PG_TEST_URL=... npm run test:mutation`
- PostgreSQL `db:backup`, `db:backup:verify`, `createdb`,
  `psql --set ON_ERROR_STOP=on --file ...`, representative restored-data
  queries, and exact scratch-database teardown.
- `npm run pg:down`
- `npx tsc --noEmit --pretty false`
- `npm run lint -- --max-warnings=0`
- `npm audit --audit-level=low`
- `npm audit --omit=dev --audit-level=low`
- `sqlite3 /tmp/ld2l-ci-build-final-20260804.db "PRAGMA user_version = 0;"`
- `DATABASE_URL=file:/tmp/ld2l-ci-build-final-20260804.db npx prisma db push --skip-generate`
- `DATABASE_URL=file:/tmp/ld2l-ci-build-final-20260804.db npm run build`
- `npm run test:e2e`
- `npm run test:e2e:mid`
- `npm run test:e2e:postseason`
- Manual fixture/dev-server and in-app browser inspection at 390px and 1280px.
- `git diff --check`

### Test results

- Full unit: 124 files, 1,704 passed.
- Full SQLite integration: 43 files, 1,023 passed and 28 intentional
  PostgreSQL-only cases skipped (1,051 total).
- Full real-PostgreSQL integration: 43 files, 1,051 passed. The disposable
  database was dropped and the schema/client restored to SQLite afterward.
- The iteration's original hard-coded mutation manifest accounted for the
  pre-final 107-claim tree and then reported 106 live claims after registration
  cleanup. The production-readiness re-audit found that this was not a complete
  repository inventory: five claim-bearing source files and 14 live claims were
  absent from that manifest. Discovery now recursively rejects such omissions.
  A fresh full PostgreSQL sweep accounts for 120 live claims: 78 protected, 42
  reviewed equivalents, and zero unclassified or unprotected. Infrastructure,
  transform, and malformed-mutant failures no longer count as behavioral kills;
  every newly protected claim was confirmed twice before the baseline changed.
- Chromium: signup 29/29, regular season 40/40, and postseason 10/10; 79/79
  passed across the three isolated suites.
- TypeScript passed with no diagnostics. ESLint passed with zero warnings under
  `--max-warnings=0`.
- Both dependency audits reported zero vulnerabilities.
- The production build passed on Next.js 16.3.0 and generated all 36/36 static
  pages.
- The PostgreSQL full dump verified and restored successfully into a disposable
  database. Representative marker and league queries succeeded before the
  exact scratch database was destroyed.
- Manual in-app browser verification covered public visitor, authenticated
  outsider, active participant, captain, and administrator states at 390px and
  1280px. Navigation, locked explanations, privacy boundaries, roster geometry,
  and destructive/recovery copy were coherent; no browser console errors were
  recorded.

### Remaining concerns

- Production still uses `prisma db push`, not reviewed versioned migrations,
  and has no automatic schema rollback. The database also lacks partial-unique
  constraints for one active Season and one active inhouse lobby; application
  Serializable claims and fail-closed reads remain the enforcement.
- Rate limits are bounded but in-memory and per application instance. They are
  a speed bump, not a distributed abuse-control system.
- The CSP is a hydration-safe baseline without `script-src`/`style-src` nonces.
  Inline-injection containment is therefore incomplete until Next assets can
  use a deliberate nonce/hash pipeline.
- Discord webhooks expose no idempotency key. The inhouse outbox is durable and
  ordered, but a crash after Discord accepts a POST and before `SENT` commits
  can cause one duplicate on lease recovery.
- This repository does not schedule encrypted off-host backups, retention, or
  provider point-in-time recovery. Operators must configure and monitor them
  outside the application.
- Steam, Discord, and OpenDota failure contracts are automated, but no final
  staging smoke used real production credentials and provider consent/account
  interaction.
- There is no automated axe scan, Lighthouse gate, synthetic Web Vitals
  budget, or comprehensive browser fault-injection matrix.
- Elo, Hall of Fame, records, recap, profiles, and other historical reports
  still scan and aggregate growing histories in application memory. A long
  multi-year league will need pagination, incremental summaries, or materialized
  views.
- AdminAction coverage is intentionally partial. Routine sync, retry, and
  maintenance processes are not a complete immutable operational event log.
- Auction clocks, result import, bracket reconciliation, inhouse outbox
  delivery, settlements, reminders, and the Discord board still depend on
  traffic or an external `/api/sync` heartbeat; there is no durable scheduled
  worker or operator queue dashboard.
- Schedule arithmetic uses stored timestamps and seven-day increments, but
  league-local timezone and daylight-saving transitions still need explicit
  product policy and real DST-boundary tests.
- Rosters, names, avatars, and some scouting/stat presentation are read from
  mutable current identities. Historical match-night roster and display
  provenance is not fully snapshotted.
- Several service/action/page modules remain large. Their behavior is tested,
  but smaller command/query boundaries would reduce review and change risk.
- CI runs Node 20.18 while this final local validation used Node 22.23.1. The
  repository documents a minimum but has no single runtime pin shared by local,
  CI, and Vercel.
- The successful restore drill used a disposable local PostgreSQL database. It
  does not replace the production prerequisite: create and verify a fresh
  same-database full backup, confirm off-site retention/PITR, and retain the
  receipt before a destructive production schema change or hard season delete.

### Recommended future improvements

Adopt committed PostgreSQL migrations with `prisma migrate deploy` and rehearse
rollback; add database-enforced partial uniqueness where the production engine
permits it; move rate limiting and scheduled work to shared durable services;
add nonce/hash CSP coverage; configure encrypted off-site backups, retention,
PITR, alerting, and regular restore drills; run credentialed provider smoke
tests in an isolated staging environment; add axe, Lighthouse, Web Vitals, and
fault-injection release gates; materialize growing historical aggregates;
expand the audit log only where operators need durable human or automated
provenance; define league timezone/DST behavior; snapshot match-night identity
and roster provenance deliberately; split the largest command/page modules;
and pin one supported Node runtime across developer machines, CI, and Vercel.

### Next section to audit

There is no next planned section: Iterations 1–13 cover the mapped application
and both complete league lifecycles. Future audit work should be opened as a
new controlled iteration against the prioritized residuals above, with the same
understand, test, change, verify, and report loop.
