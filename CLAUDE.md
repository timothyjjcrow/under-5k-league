# CLAUDE.md — working notes for LD2L

A Learn Dota 2 League site. Read the README for the product overview. This file
is orientation for future work in the codebase.

## Mental model

Everything hangs off a **Season** and its `status` (the state machine):
`SIGNUPS → DRAFT → REGULAR_SEASON → PLAYOFFS → COMPLETE`. The active season is
`Season` where `isActive = true` (see `getActiveSeason`). The UI (nav + dashboard)
renders per-phase so unused features stay hidden.

## Where things live

- **Pure, unit-tested logic** (no DB): `src/lib/draft.ts`, `standings.ts`,
  `schedule.ts`, `capacity.ts`. Prefer adding logic here + a `*.test.ts` beside it.
- **Draft engine (DB, transactional)**: `src/lib/draft-service.ts` —
  `nominatePlayer`, `placeBid`, `resolveExpiredNomination`, `getDraftState`.
  The auction clock is server-authoritative; expired nominations resolve lazily
  on the next poll/action (no cron/websocket).
- **Mutations**: server actions in `src/app/actions/*` (forms) and JSON route
  handlers in `src/app/api/draft/*` (the live draft).
- **Auth**: `src/lib/auth.ts` (jose-signed cookie session), `steam.ts` (OpenID
  2.0), `users.ts` (upsert + `resolveRole`). Dev/mock login: `/api/auth/dev`
  (gated by `ALLOW_DEV_LOGIN`). Admin: if `ADMIN_STEAM_IDS` is set it's
  authoritative (exactly those SteamID64s are admin; others demoted on login);
  otherwise the first-ever user bootstraps as admin. `npm run set-admins`
  reconciles existing accounts to the allowlist in one shot. Steam name/avatar
  come from `fetchSteamProfile`/`fetchSteamProfiles` (GetPlayerSummaries, needs
  `STEAM_API_KEY`) — set on login, bulk-refreshed via admin `syncSteamProfiles`,
  and per-user via profile `refreshSteamProfile`. `<Avatar>` falls back to
  initials when `avatar` is null.
- **UI kit**: `src/components/ui.tsx` (server-safe presentational components).
  `site-header.tsx` and `draft-room.tsx` are `"use client"`.

## Conventions / gotchas

- **Node ≥ 20.18, Prisma 5.** Prisma 6/7 requires Node ≥ 20.19; this machine's
  default Node is 20.18, so we pin Prisma 5. Node 22 is installed via nvm if a
  future upgrade is wanted.
- **SQLite has no enums** — statuses are strings; the source of truth for allowed
  values is `src/lib/constants.ts`.
- **Vitest config is `vitest.config.mts`** (`.mts`, not `.ts`) — the project is
  CommonJS and Vitest's config loader needs ESM.
- After a mutation, server actions call `revalidatePath("/", "layout")`.
- **MMR cap**: `Season.maxMmr` (0 = none). `saveRegistration` rejects
  `mmr > maxMmr`; admins set it in the create-season form or via `setMaxMmr`.
- **Feedback**: risky server actions return `ActionResult`
  (`src/lib/action-result.ts`) instead of throwing; the UI wraps them in
  `<ActionForm>` (`src/components/action-form.tsx`), which toasts the result via
  the global `<Toaster>`. Use `<SubmitButton confirm="…">` for destructive
  actions. Global `error.tsx` / `not-found.tsx` / `loading.tsx` exist.
  The live rooms (draft/inhouse) toast `act()` failures via `pushToast` too —
  never reintroduce inline top-of-room error banners there: race rejections
  ("Another bid just landed") arrive while the captain is scrolled deep in the
  pool where a banner is invisible, and the old banner persisted stale.
- Run `npx tsc --noEmit` for a fast type check; `npm test` for unit;
  `npm run test:e2e` for Playwright — fully isolated: it schema-pushes and
  reseeds a DEDICATED `prisma/e2e.db` and serves it on port 3210 (never
  dev.db/:3000, safe to run any time). Caveat: Next 16's project-dir lock
  means it can't start while another `next dev` runs from this repo.

## Roster moves (done)

- `signFreeAgent`: permanently adds a registered, unrostered player to a team
  with an open seat at $0 — how short rosters (pool-dry drafts, late signups)
  get topped up. Guards: post-draft phases only, team in season, ACTIVE
  registration, not already rostered, seat available.
- `releasePlayer`: removes a non-captain from their roster (registration stays
  ACTIVE → back in the free-agent pool; release + sign = replace/trade).
  Captains can't be released.
- Both announced in Discord; the admin "Roster moves" card shows whichever
  forms currently apply (sign needs a short team + free agent; release needs
  any non-captain rostered).
- `promoteStandinToPlayer`: flips an ACTIVE STANDIN registration to PLAYER —
  the mid-season refill path (late joiners can only register as standins once
  signups close, and `signFreeAgent` refuses standins). Guards in pure
  `promoteGateError` (`registration.ts`, tested): blocked during SIGNUPS
  (self-serve covers it), COMPLETE, a LIVE/PAUSED draft (would inject into
  the running auction pool — pre-start and post-draft are fine), and while
  the standin has assignments on unplayed matches (remove those first).
  Third row in the Roster moves card; flow is promote → sign via the
  free-agent form (which does the Discord announcement).

## Playoffs & standins (done)

- **Playoffs**: `src/lib/playoff-service.ts` — `createPlayoffBracket` seeds the
  top teams by standings; `advancePlayoffBracket` (called from `recordResult`
  when a match's phase isn't REGULAR) builds the next round from winners and
  crowns the champion when the final ends. Bracket slots are `R{round}M{match}`.
  Pure helpers live in `schedule.ts` (`pickBracketSize`, `nextRoundPairings`,
  `roundName`).
- **Standins**: `assignStandin` / `removeStandin` admin actions; the replaced
  player's roster infers which team the standin fills for. Shown on `/schedule`.

## Match data / OpenDota (done)

- `src/lib/dota.ts` — OpenDota client, SteamID64 ↔ `account_id` conversion,
  match-id/URL parsing, cached hero names. Optional `OPENDOTA_API_KEY`.
- `src/lib/match-import.ts` — `classifyGame` (pure, unit-tested) decides whether
  a fetched game is between our two teams and who won; `importGameForMatch`
  records a `Game` + `recomputeSeries`; `autoDetectGamesForMatch` scans rosters'
  recent games. Standins assigned to a match count for their team. Uses
  `Game.dotaMatchId` unique to dedupe.
- Admin: `MatchImportControls` (client, `useActionState` for inline errors) →
  `importGameAction` / `autoDetectAction`. Box score lives at `/matches/[id]`.
- **Captain result reporting**: the two captains can import their own finished
  games on `/matches/[id]` ("Report your result" card, shown while the match
  isn't COMPLETED) — guards in `src/lib/match-report-service.ts`
  (reschedule-service pattern, integration-tested in
  `test/integration/match-report.itest.ts`), thin actions in
  `src/app/actions/match-report.ts` (auth + "games" tag bust + toasts).
  `MatchImportControls` now takes the two server actions as props (admin panel
  passes the admin ones). Import-only — manual score entry stays admin-only.
- Games roll up into `Match.homeScore/awayScore`; playoff game imports call
  `advancePlayoffBracket`. Note: `tsconfig` target is ES2017, so use
  `BigInt("…")` not `123n` literals.
- **Ranked medals**: `src/lib/rank.ts` decodes OpenDota `rank_tier` (pure,
  tested) → `<RankBadge>`. `fetchPlayerRankTier` fills `User.rankTier` on profile
  link/refresh (`updateDotaAccount`/`refreshRank`) and in bulk via admin
  `syncPlayerRanks`. Medals render on players/teams/draft (a captain resource).
- **In-client league sync**: `Season.dotaLeagueId` + `syncLeagueGames` (fetch
  `/leagues/{id}/matches`, `classifyGame` each vs. scheduled matches, import).
  Admin `setLeagueId` / `syncLeagueAction`. League registration is done at
  dota2.com/league; games are tagged by hosting private lobbies with the id.
- **Discord contact**: `User.discordName` (empty string = unset; persists
  across seasons). Pure `normalizeDiscordName` (`src/lib/discord-name.ts`,
  tested — modern lowercase handles + legacy Name#1234, strips @, "" clears),
  `updateDiscordName` action, edit card on `/me`. Rendered as the copyable
  `<DiscordTag>` chip (`src/components/discord-tag.tsx`, clipboard + toast)
  on the signup pool, team rosters, player profiles, and the draft room's
  nominated panel — ALWAYS gated to signed-in viewers (contact info is for
  members, not the public internet; keep that rule on new surfaces).
- **Player questionnaire**: `Registration.roles` (comma-sep position keys,
  helpers + tests in `src/lib/roles.ts`), `favoriteHeroes`, `statement`,
  `captainNote` — captured on `/me`, surfaced in the player pool and draft room
  (`getDraftState` carries roles/heroes/note for the nominated player).

## Player-facing navigation & info pages (done)

Purely additive UX layer — no league logic changed. Every player/team name in
the app is a link (`<PlayerLink userId>` in `ui.tsx` for players; plain
`next/link` to `/teams/[id]` for teams).

- **Player profiles** `/players/[id]` — season registration (roles, heroes,
  goals, captain note), team + draft price, career record/KDA, most-played
  heroes, and match history. Career stats roll up from each `Game`'s stored
  player JSON via pure `summarizePlayerGames` (`src/lib/player-stats.ts`, tested).
- **Teams index** `/teams` — phase-aware: budgets/rosters during DRAFT, then
  re-sorts by standings with W–L(–D), points, and diff. Team detail
  (`/teams/[id]`) adds recent-form chips + head-to-head (pure `recentForm` /
  `headToHead` in `src/lib/team-matches.ts`, tested) and a draft-spend summary.
- **Leaders** `/leaders` — six leaderboards (wins, KDA, win rate, kills,
  assists, games) via pure `topBy` (`player-stats.ts`); rate boards use an
  adaptive min-games floor.
- **Dashboard** (`src/app/page.tsx`) shows a compact playoff bracket during
  PLAYOFFS and a champion/final-standings recap on COMPLETE. Bracket
  round-grouping is pure `slotRound` / `groupPlayoffRounds` (`schedule.ts`,
  tested), shared with `/schedule`.
- **Nav** (`site-header.tsx`) gates links by phase: Teams appears from DRAFT on;
  Schedule + Leaders from REGULAR_SEASON on. `isActive` keeps "Teams" and
  "My Team" from both highlighting on your own team page.

## Inhouse (done)

A casual pick-up mode, **entirely separate from the league** (no `Season`
coupling — touches only `User`). Mirrors the draft engine's architecture:
server-authoritative, resolves lazily on poll (no cron/websocket).

- **Models** (`schema.prisma`): `InhouseQueueEntry` (one global rolling queue,
  `userId` unique), `InhouseLobby` (the game + its state machine:
  `CAPTAIN_VOTE → DRAFTING → READY → IN_PROGRESS → COMPLETED`/`CANCELLED`),
  `InhouseLobbyPlayer` (`team` 1/2, `isCaptain`, `pickIndex`, `mmr` snapshot,
  `votedMethod`/`votedNomineeId` for the captain vote). One active lobby at a
  time (`INHOUSE_ACTIVE_STATUSES`).
- **Captain-selection vote**: when a lobby fills it opens in `CAPTAIN_VOTE` — the
  10 players vote how captains are chosen so it isn't always the same top-2 MMR
  pair: `VOTE` (elect specific players), `MMR` (highest 2), or `RECORD` (best 2
  inhouse records). Resolves when everyone votes or the timer expires, then
  installs the top two and drops into `DRAFTING`.
- **Pure, tested logic**: `src/lib/inhouse.ts` — `tallyMethod` (winning method,
  ties lean `VOTE > RECORD > MMR`), `orderCaptains(method, candidates)` (ranks
  captains per method, always MMR/join fallback), `nextPickTeam` (strict
  back-and-forth; team 2 — the lower seed — picks first via
  `INHOUSE.FIRST_PICK_TEAM`), `isDraftComplete`, `playersNeeded`.
  `src/lib/inhouse-stats.ts` — `summarizeInhouse` ladder
  (wins/losses/win%/streak + personal team-Elo `rating`/`peak`: start 1000,
  K=32, delta from side-average ratings, ranked by rating; `<5` games =
  provisional, dimmed in the UI; also feeds the RECORD method — `orderCaptains`
  re-sorts by wins itself, so ladder order doesn't drive captaincy). The
  ladder query must fetch ALL completed lobbies (no `take` window — Elo
  accumulates over full history). Tunables in
  `constants.ts` (`INHOUSE`: LOBBY_SIZE 10, TEAM_SIZE 5, VOTE_SECONDS 25,
  PICK_SECONDS 60; `CAPTAIN_METHOD` labels).
- **Service (DB, transactional)**: `src/lib/inhouse-service.ts` —
  `getInhouseState` (calls `maybeFormLobby` + `resolveCaptainVote` +
  `resolveStalledPick` + `maybeAutoDetectResult` on every read, like the league
  draft), `joinQueue`/`leaveQueue`, `castVote`, `makePick`, `startGame`,
  `autoDetectResult`, `recordMatch`, `cancelLobby` (admin). Queue hits 10 →
  lobby forms on the next poll; the vote, a stalled pick clock, and the result
  scan all auto-resolve lazily on poll.
- **Results (OpenDota only — no manual winner)**: a result is recorded solely
  from a real Dota match. `buildResult` fetches an OpenDota match, validates it
  with the league's pure `classifyGame` (rosters on opposite sides → winner +
  which side was Radiant), and stores the full per-player **box score** (hero,
  KDA, net worth) as `InhouseLobby.boxScore` JSON + `winnerTeam`/`radiantTeam`/
  `durationSecs`/`radiantScore`/`direScore`/`dotaMatchId`. Two entry points:
  `recordMatch` (paste a match ID) and `autoDetectResult` — `findInhouseGame`
  scans the 10 players' recent matches in parallel, finds the shared game, and
  takes the most recent one that started after the lobby formed. Auto-detect also
  runs on poll (`maybeAutoDetectResult`, gated by `DETECT_MIN_MINUTES`, throttled
  via an atomic `detectedAt` claim — one active lobby, so API usage is bounded).
  Needs players' "Expose Public Match Data" on. The page renders the box score as
  a `GameResultCard` (hero icons via `heroById`/`HeroIcon`, names, KDA, winner).
- **API**: one dispatch endpoint `POST /api/inhouse` (`{ action, ... }`; actions:
  `state`/`join`/`leave`/`vote`/`pick`/`start`/`detect`/`record`/`cancel`),
  always returns fresh viewer-tailored state. Polled by `src/components/inhouse-room.tsx`
  (`"use client"`, one view per phase incl. `VoteView`; syncs the vote/pick clocks
  via server `now` offset like `draft-room.tsx`; `router.refresh()` on lobby end
  to update the server-rendered leaderboard + results). Page: `src/app/inhouse/page.tsx`.
  Nav link is always visible (season-independent).
- **Radiant = team 1 (green), Dire = team 2 (red)**. Seed enqueues 6 demo
  players so `/inhouse` isn't empty on a fresh DB (they prune ~3 min after
  seeding once someone polls /inhouse — expected, see queue presence).
- **Queue presence (heartbeat)**: `InhouseQueueEntry.lastSeenAt`, refreshed
  (throttled, `QUEUE_HEARTBEAT_SECONDS`) by the viewer's own polls at the top
  of `getInhouseState` — a spot is held by keeping /inhouse open. Entries seen
  more than `QUEUE_AWAY_SECONDS` ago are "away" (listed dimmed with an away
  chip, excluded from `needed`, the headline count, the dashboard strip count,
  and lobby formation); past `QUEUE_DROP_SECONDS` they're pruned inside
  `maybeFormLobby` (runs on every poll, before the active-lobby early return).
  `cancelLobby` re-queues its players with a BACKDATED heartbeat
  (`requeueLastSeenAt`) so present players re-confirm on their next poll and
  ghosts drop out instead of instantly re-forming the lobby. Pure helpers
  (`queuePresence`/`queuePresentCutoff`/`queueDropCutoff`/`requeueLastSeenAt`)
  in `inhouse.ts`, tested; window invariants asserted in `inhouse.test.ts`.
- **Balance meter**: pure `mmrBalance` (`inhouse.ts`, tested — MMR 0 =
  unknown, excluded) drives per-team "avg N" chips on the drafting columns
  and a "⚖️ X ahead by N avg MMR" line in the on-the-clock banner (sm+).

## Draft edge cases (done)

- Nomination auto-skip: `resolveStalledNomination` nominates the top available
  player at min bid when the nominator's clock runs out.
- Pool-dry completion: if signups run out mid-draft, both resolvers mark the
  draft COMPLETE (short teams play with standins) instead of stalling forever.
  `startDraft` warns in its success toast when seats outnumber the pool.
- `recordResult` validates scores against the match's `bestOf` via pure
  `seriesScoreError` (`standings.ts`); partial results/forfeits are allowed.
- Cancelling an inhouse lobby re-queues its 10 players with a backdated
  presence heartbeat — a fresh captain vote forms once the players still on
  the page have re-confirmed via their own polls (ghosts drop out instead).

## Discord notifications (done)

- `src/lib/discord.ts` — pure message formatters (unit-tested) +
  `sendDiscordMessage` (best-effort POST to an incoming webhook, 5s timeout,
  never throws). Webhook URL: `Setting` table key `discordWebhookUrl`
  (`src/lib/settings.ts`, admin panel card with save/validate/test) with
  `DISCORD_WEBHOOK_URL` env as fallback.
- **The webhook URL is a bearer credential (anyone holding it can post to the
  channel — prime phishing bait) and is NEVER sent to the client.** The admin
  card renders only a boolean + a masked fingerprint from pure `maskWebhookUrl`
  (`discord.ts`, tested — hides the secret token, keeps a short id hint); the
  input starts EMPTY (no `defaultValue`). Because the field is blank on purpose,
  `setDiscordWebhook` treats a blank submit as a no-op (never a wipe); turning
  announcements off is the explicit `clearDiscordWebhook` action + Remove
  button. Env-managed webhooks (`DISCORD_WEBHOOK_URL` only, no DB row) show a
  note and hide Remove (clearing the DB key can't touch env). Regression guard:
  don't reintroduce any client render of the raw URL.
- Announces: new player signups (with countdown to the draft threshold), draft
  started (`startDraft`), every auction sale (`resolveExpiredNomination`,
  captured in-tx and sent post-commit — one message per sale, idempotent),
  draft complete (both draft-service resolvers), match results
  (`recordResult`), playoff bracket (`startPlayoffs`), the champion
  (`advancePlayoffBracket`), and inhouse moments: lobby formed
  (`maybeFormLobby`, captured in-tx/sent post-commit) plus a "queue is two
  short" ping (`joinQueue` — fires only on an upward crossing of
  `LOBBY_SIZE-2` present players, never on the lobby-forming join, throttled
  via the `inhouseQueuePingAt` Setting to one per `QUEUE_PING_MIN_MINUTES`).
  The inhouse room also flips `document.title` ("(!) Your pick…") while the
  viewer's attention is needed — works without the sound toggle/audio unlock.

## Match-night check-in (done)

- `MatchAvailability` model (matchId+userId unique, status IN|OUT). Pure
  summary math in `src/lib/availability.ts` (`teamAvailability`, tested).
- Players RSVP via the shared `<CheckinBanner>`
  (`src/components/checkin-banner.tsx`) rendered on the dashboard
  (`MyNextMatch` in `page.tsx`), `/schedule`, and unplayed `/matches/[id]`
  pages (`setAvailability` action — rostered players and assigned standins
  only, no completed matches). Schedule match rows show per-team ✓/✗ counts
  while a match is unplayed.
- Admin standin card flags players who declared OUT and aren't covered by an
  assignment yet, right above the assign form.
- **Match-night Discord reminder**: `src/lib/reminder-service.ts`
  (`maybeAnnounceUpcomingWeek`) — lazy, fired by the invisible
  `<WeekReminderPing>` server component (own `<Suspense fallback={null}>`) on
  the dashboard and /schedule. Announces the next week's unplayed fixtures
  once kickoff is within `WEEK_REMINDER.AHEAD_HOURS` (24h ahead, up to 3h
  after) with `<t:epoch:R>` kickoffs and standin-aware check-in counts (same
  `matchNightRoster`/`teamAvailability` as /schedule). Idempotent via an
  ATOMIC `weekReminder:<season>:<week>` Setting CREATE (P2002 ⇒ already sent
  — deliberately stronger than honors' read-then-upsert, the trigger is
  concurrent page loads). The send is awaited (serverless kills orphans).
  Integration-tested in `test/integration/reminders.itest.ts`.

## Returning-player prefill (done)

- `/me`: when a player has no registration for the active season but does
  have one from a past season, the signup form defaults (MMR, roles, heroes,
  statement, captain note, type, wants-captain) come from the most recent
  prior registration, with a "Welcome back — prefilled from Season N" hint.
  Registration state (`isRegistered`, badges) still keys off the active
  season only.

## Player career history (done)

- `/players/[id]` has a "Seasons" card: every rostered season (newest first)
  with team, captain badge / draft price, team W–L(–D) via `resultFor`, 🏆 on
  championship seasons, and a titles count in the subtitle. Links to
  `/seasons/[id]` and `/teams/[id]`.

## Season history (done)

- `/seasons` — every season newest-first (phase badge / Current, champion,
  team/signup/match counts). `/seasons/[id]` — champion banner, final
  standings, playoff rounds, weekly results, full rosters. Reuses
  `computeStandings`, `groupPlayoffRounds`, and `StandingsTable`; archived
  `/teams/[id]` pages already work since they query by id, not active season.
- Admins can **permanently delete an archived season** (test runs/misfires)
  via a confirm-guarded button on `/seasons` → `deleteSeason` (never the
  active season; deletes matches first since Match→Team is RESTRICT, then
  the season — everything else cascades).
- Nav "History" + footer "Past seasons" links appear only once an archived
  (`isActive: false`) season exists — layout passes `hasHistory` down.

## Match previews (done)

- `/matches/[id]` renders a `MatchPreview` while a match has no games and
  isn't COMPLETED: side-by-side rosters (rank, roles, RSVP status, standins),
  recent-form strips, prior-meetings line (leader-phrased head-to-head), and
  the same check-in banner as `/schedule` for participants. Completed matches
  without imports keep the "no games recorded" empty state.

## MMR-weighted draft budgets (done)

- `mmrWeightedBudgets` (`src/lib/draft.ts`, tested): linear min–max
  interpolation across the captain pool — lowest-MMR captain gets
  `base × (1+w)`, highest gets `base × (1−w)`, `Season.budgetMmrWeight`
  (percent, default 20, 0 = flat) is the knob, floored at
  `(teamSize−1) × MIN_BID` so every team can fill. Unknown MMR → base.
  The weight scales with the captain gap (`BUDGET_FULL_EFFECT_GAP` =
  1000 MMR): full spread only at a 1000+ MMR gap, proportionally less
  below it, so near-equal captains get near-equal budgets.
- Seed medals derive from signup MMR via `approxRankTierFromMmr`
  (`src/lib/rank.ts`, tested) so demo profiles look consistent.
- Applied in `startDraft` (replaces the uniform `season.draftBudget`);
  create-season form has the weighting field; the admin captains card shows
  projected (pre-start) / actual (post-start) budgets per captain.
- Gotcha: after `prisma db push` regenerates the client, restart the dev
  server or new Season fields read as `undefined` in the running process.

## Draft room QoL (done)

- Draft-night alerts: the room chimes (shared `src/components/chime.ts`, also
  used by inhouse; persisted `draftSound` toggle, gesture unlock in `act()`)
  on your-turn-to-nominate and on being outbid; an OUTBID flash (with one-tap
  re-bid via `quickBid`) latches until the poll sees it stale, and the tab
  title flips "⏰ Your pick — "/"💸 Outbid — ". The outbid predicate is pure
  `wasOutbid` (`draft.ts`, tested) — its same-player guard prevents a false
  flash when a winning bid resolves into a fresh nomination within one poll.
- The auction's "Available" list has search, position-filter chips, and
  MMR/rank/name sorting (`AvailableList` in `draft-room.tsx`).
  `filterAndSortPlayers` (`player-pool.ts`) is generic over
  `FilterablePlayer` so the signup pool page and the live draft share the
  same tested filter logic.

## Auto match times (done)

- `Season.firstMatchNight` + pure `matchNightForWeek` (`schedule.ts`, tested):
  the admin picks week 1's datetime in the Generate-schedule form; every
  regular week and each playoff round (both `createPlayoffBracket` and
  `advancePlayoffBracket`) gets `scheduledAt = first + (week−1)×7d`.
  Empty input = no times (old behavior); per-match "Set time" still overrides.

## Calendar feed (done)

- `src/lib/ics.ts` — pure RFC 5545 builder (escaping, UTC dates, CRLF;
  tested). `GET /api/calendar` serves the active season's scheduled,
  unplayed matches (`?team=<id>` filters); duration is `bestOf × 60 + 30`
  minutes. Linked from `/schedule` ("📅 Calendar (.ics)") and team pages
  (during REGULAR_SEASON/PLAYOFFS).

## Draft recap card (done)

- `draftRecap` (`src/lib/draft-recap.ts`, tested): biggest single spend, best
  MMR-per-dollar steal, top-spending and least-spending teams, total spent —
  captains ($0) excluded. Rendered as a "Draft night" card on `/teams`
  whenever any purchases exist (live during DRAFT, historical after).

## Accessibility conventions (done — keep following these)

- Buttons get focus rings from `baseBtn` (`focus-visible:ring-2`) — use
  `buttonClasses`/`Button` for anything clickable.
- Purely visual indicators carry an accessible name: `FormStrip` and the
  schedule `RsvpBadge` are `role="img"` + `aria-label` with inner glyphs
  `aria-hidden`; `RankMedal` has `aria-label`; `TeamCrest` is decorative
  (`aria-hidden`, name always adjacent as text).
- Toggle chips (draft-room role filter/sort) use `aria-pressed`; selects
  without visible labels need `aria-label`; countdown clocks are
  `role="timer"` with a spoken label.

## Mobile layout rules (done — keep following these)

- Card grids must use `grid-cols-1` explicitly (`grid grid-cols-1 gap-4
  sm:grid-cols-2`) — without it the implicit track is `auto` and a long team
  name widens the whole page. Same trap: grid *items* need `min-w-0` (see the
  dashboard's two column divs).
- `StandingsTable` is `table-fixed` with column widths on a responsive
  `<colgroup>` so the Team column truncates instead of stretching. Widths must
  live on `<col>`, NOT on `hidden sm:table-cell` th/td — fixed layout still
  hands display:none columns an equal share of the leftover width, starving
  Team on phones. Responsive-hidden columns get `w-0 sm:w-*` cols.
- `CardHeader` clamps its title/subtitle (`min-w-0` + overflow-wrap) — free-
  text names are safe there. In custom flex headers, every level between the
  container and a `truncate` span needs `min-w-0`.
- `CheckinBanner` text has `min-w-[14rem]` so the RSVP buttons wrap below the
  copy on phones instead of crushing it.
- **The site header is `h-20` (80px)** — anything pinned beneath it must use
  the same offset and be updated TOGETHER: the draft room's fixed compact
  clock bar (`top-20`) and its IntersectionObserver (`rootMargin -80px`),
  anchor targets (`scroll-mt-20`, pool anchor `scroll-mt-32` = header + bar).
  A past header resize (h-16→h-20) silently clipped the clock bar.
- Draft room on phones: the player-pool column comes FIRST in DOM (captains
  on the clock need it now; `lg:order-*` restores teams-left/feed-above-pool
  on desktop). Keep the `#player-pool` anchor + NominateBar's ↓ link working.

## Fantasy league (done, branch: bigger-features)

- Anyone signed in picks a **fantasy five** from the drafted rosters under an
  MMR salary cap (`fantasyCap` = league-avg rostered MMR × 5 × 1.05); points
  score per imported game via `fantasyPoints` (kills/assists/deaths/economy/
  win bonus — weights in `FANTASY` constants). All pure + tested in
  `src/lib/fantasy.ts`.
- Models `FantasyRoster`+`FantasyPick`; `saveFantasyRoster` action validates
  picks server-side and **locks league-wide once the first game is imported**.
- `/fantasy`: live-budget picker (client `FantasyPicker`, checkboxes named
  `picks`), standings with per-pick breakdowns, locked-roster chips. Nav from
  REGULAR_SEASON on.

## MVPs & achievements (done, branch: bigger-features)

- Pure `src/lib/achievements.ts` (tested): `gameMvp(players, radiantWin)` =
  best fantasy line among mapped players (win bonus favors winners; kills →
  fewer deaths → id tiebreaks); `achievementsFor(lines)` = badge catalog
  (Match MVP ×N, Deathless, Killing spree 15+, Playmaker 20+ assists,
  Tycoon 600+ GPM, Veteran 10 games, Centurion 100 kills).
- Match box scores show an MVP chip on the crowned line; player profiles get
  an "Achievements" trophy case computed career-wide (all seasons' games).

## Hall of Fame (done, branch: bigger-features)

- `/hall-of-fame`: cross-season career boards — 🏆 titles and ⚔️ series wins
  via pure `careerCounts` (`src/lib/hall-of-fame.ts`, tested; team cuids are
  globally unique so cross-season membership just works), 🎯 career fantasy
  points (`pointsByPlayer` over all games ever), 🔮 all-time oracle record
  (`pickemStandings` over all predictions, min 3 graded). Linked from
  `/seasons` and the footer.

## Power rankings (done, branch: bigger-features)

- Pure Elo in `src/lib/power-rankings.ts` (tested): K=32, start 1000,
  per-GAME (each series expands into its game results, week order; home wins
  applied first inside a series). `powerRankings` returns rating + rank +
  prevRank (before the latest completed week) + weekly delta. Regular-season
  matches only feed it.
- `/teams` shows the card with ▲/▼ movement arrows and rating deltas whenever
  a completed match exists.

## Weekly honors (done, branch: bigger-features)

- Pure `weeklyHonors` (`src/lib/honors.ts`, tested): Player of the Week =
  best fantasy points that week (same `fantasyPoints` identity as the
  fantasy league); Team of the Week = most game wins, points tiebreak.
- `honors-service.ts`: `maybeAnnounceWeekHonors(seasonId, week)` fires once
  a regular week's matches are all COMPLETED — idempotent via a
  `honorsAnnounced:<season>:<week>` Setting marker (claimed before sending).
  Hooked in `recomputeSeries` (all import paths) and manual `recordResult`.
- `/leaders` shows a "Weekly honors" card (newest week first, hero name via
  `getHeroNames`).

## Pick'em (done, branch: bigger-features)

- `Prediction` model (matchId+userId unique). Pure `src/lib/pickem.ts`
  (tested): `predictionOpen` (locks at `scheduledAt` or completion),
  `pickemStandings` (correct desc, accuracy tiebreak; draws void picks),
  `pickSplit` (community percentages).
- `savePrediction` action re-validates the lock + that the pick is one of the
  two teams. `/pickem`: oracle-board leaderboard, open matches as two
  team-buttons with live pick splits, "your graded picks" review. Nav from
  REGULAR_SEASON on.

## Interactive bracket (done)

- `src/components/bracket.tsx` (`"use client"`) draws the classic CENTERED
  tournament shape: two wings converge on a grand final with the 🏆 floating
  above it (greyed until a champion is crowned, then glowing). Pure
  `mirrorLayout` (`bracket-view.ts`, tested) splits the linear rounds into
  left/right wings + center — round i's first-half slots go left, second half
  right, matching the R{r}M{m} feed-forward. Connector lines are pure CSS
  (flex-1 wrappers so pair midpoints land on the next card's center); wing
  direction flips the stub/vertical edges; the inner wing column is always a
  single slot whose center meets the final's. Seed numbers, dashed TBD slots,
  tap/hover run tracing, 🏆 on the final's winner all still apply. Pure
  `bracketSkeleton`/`slotIndex` (`schedule.ts`, tested) build the round
  structure; `src/lib/bracket-view.ts` serializes matches + `seedMap`.
  Rendered on `/schedule`, the dashboard, and `/seasons/[id]` — wide by
  design, always inside its own `overflow-x-auto`.

## Season grid (done)

- "Who's played who": `crossTable` (`src/lib/cross-table.ts`, tested) maps
  teams × REGULAR matches into per-meeting cells from the row team's
  perspective (W/L/D + score, `wk N` link when unplayed, list per pair for
  double round robins). Rendered as `SeasonGrid` on `/schedule` (standings
  order, crest+rank column headers, sticky row-header column, result-toned
  chips linking to match pages) whenever regular matches exist. Scrolls
  inside its own container on phones.

## Hero meta page (done)

- `/meta`: league-wide hero report from imported box scores — pick/win rates,
  most-contested table, best-win-rate board (adaptive `metaMinPicks` floor),
  signature player per hero, untouched-pool card. Pure `heroMeta`/
  `bestWinRates` in `src/lib/hero-meta.ts` (tested); unknown hero ids render a
  "Hero #N" fallback. Nav "Meta" + footer link from REGULAR_SEASON on.

## Record book (done)

- `/records`: all-time single-game records across every season — player
  records (kills, assists, net worth, GPM, last hits, deaths) and game
  records (longest/fastest by `durationSecs`, bloodiest/biggest stomp by kill
  score; 0–0 or 0-duration games never qualify — unreported ≠ record). Pure
  `leagueRecords` in `src/lib/records.ts` (tested): first achiever keeps a
  tie, so feed games chronologically. Linked from the footer + Hall of Fame.

## Hero report cards (done, branch: ambitious-features)

- Import now stores the extended per-player OpenDota fields on each
  `Game.players` line: `xpm/denies/level/heroDamage/towerDamage/heroHealing`
  + `benchmarks` (per-metric `{raw, pct}` percentiles vs the world on that
  hero — present on plain `/matches/{id}` payloads, no replay parse needed).
  `sanitizeBenchmarks` (exported, tested) keeps only finite pcts, clamped
  0..1, and stores `null` when none — the `"benchmarks"` JSON key doubles as
  the "already enriched" marker. Legacy lines simply lack the fields.
- Pure `src/lib/benchmarks.ts` (tested): 7-metric catalog, `gradeFor`
  (S/A/B/C/D), `gameReportCard`, `careerReportCard` (per-metric averages +
  focus/best callouts with an observation floor), `percentLabel` ordinals.
- Surfaces: grade-chip strip under every box-score line (`/matches/[id]`),
  "Report card" percentile bars + strength/work-on callouts on
  `/players/[id]`, "Best report card" board on `/leaders`.
- Admin backfill: `enrichStoredGames` (integration-tested) re-fetches games
  missing the marker by `dotaMatchId` in bounded batches, merging new fields
  WITHOUT touching userId/teamId attribution; button lives in the Dota
  league integration card.

## Opponent scouting report (done, branch: ambitious-features)

- Pure `src/lib/scouting.ts` (tested): `playerHeroPool` (per-hero W-L/KDA),
  `threatBoard` (team-wide ban list, adaptive `max(2, ceil(picks/25))`
  floor; `contested` = most-picked fallback), `paceProfile` (win/loss avg
  minutes; 0-duration games excluded — unreported ≠ data), `dossierEmpty`.
  Role coverage reuses `pool-stats.roleCoverage`.
- Rendered as a two-sided "Scouting report" card in the `/matches/[id]`
  preview (both dossiers public), over ALL seasons' stored box scores.

## Playoff scenario engine (done, branch: ambitious-features)

- Pure `src/lib/scenarios.ts` (tested, incl. a seeded property test that
  re-derives every leaf via `computeStandings`): `scenarioReport` enumerates
  every remaining REGULAR outcome under a 200k-leaf cap and refines the
  conservative `clinchStatuses` — ties always counted against a clinch and
  for a survival, so exactness only turns null into CLINCHED/ELIMINATED,
  never contradicts. EVERY match branches win/loss/DRAW regardless of bestOf
  parity — `recordResult` accepts drawn scores (1-1 Bo3, 0-0) for regular
  matches, and "exact" must survive anything recordable. Layer-1 bounds
  (always): `magicNumber`, `eliminationLosses`, focal-match-conditioned
  `winAndIn`/`loseAndOut`, rank ranges. Over the cap it degrades to
  `clinchStatuses` + bounds. `TeamScenario.nextMatchId` names the match the
  winAndIn family is about; `matchStakes(matchId, …)` suppresses those labels
  on any other match page. `stakesHeadline` picks the banner line.
- `src/lib/stakes.ts` (tested) adapts prisma rows → engine inputs and the
  report → the standings `clinch` prop (cut from `pickBracketSize`, same as
  `createPlayoffBracket`; null when everyone makes the bracket).
- Surfaces: refined ✓/✗ marks on the dashboard + `/schedule` standings,
  "The race" notes in the Playoff picture card, "Tonight's stakes" banner on
  regular-season match previews (silent until a night decides something),
  "What we need" card on `/teams/[id]`.

## League news (done)

- `NewsPost` model (title/body/pinned/author). Pure `sortNews` (pinned first,
  newest first) + `newsPostError` validation in `src/lib/news.ts` (tested).
- Admin "League news" card (create/pin/delete, always rendered — news is
  season-independent) → `src/app/actions/news.ts`; new posts announce to
  Discord via `newsMessage` (tested formatter, best-effort send).
- Surfaced on the dashboard (`LeagueNews` card, top 3, pinned first) and the
  full `/news` archive (footer link). Post dates render via `<LocalTime>`.
- Header nav collapses to the menu below **xl** (was lg), omits "Home" inline
  (the logo is the home link), and the link strip scrolls (hidden scrollbar)
  instead of overlapping the account cluster — with Admin + name + Logout the
  inline nav couldn't fit inside `max-w-6xl` at lg.

## Player comparison (done)

- `/players/compare?a=&b=` — GET-form page (plain selects, no client JS):
  head-to-head card (pure `meetings` in `src/lib/compare.ts`, tested — rivals
  record + games-as-teammates), career table over ALL seasons' games (reuses
  `summarizePlayerGames`; better side highlighted, deaths lower-is-better,
  games count never judged), top-5 hero lists per player. Linked from
  `/players` (action) and each profile ("Compare vs… →" prefills `?a=`).

## Dashboard (done)

- `src/app/page.tsx` renders per phase. Matches are fetched ONCE in `Home()`
  (mid-season+ phases) and passed down; the scenario report is computed once
  in `SeasonView` and shared by the standings clinch marks, the This-week
  stakes chips, and the your-team one-liner.
- Hero meta per phase: signups progress, "Week X of Y + teams + games on
  record" (regular), "N teams still alive + <round> underway" (playoffs),
  champion crest + Relive CTA (complete).
- **This week strip**: the current week's (or open playoff round's) matches
  with kickoff times, standin-aware ✓ check-in counts (shared
  `matchNightRoster` in `availability.ts` — /schedule uses the same helper),
  and a stakes chip via `matchStakes`/`stakesHeadline` (the long
  everything-on-the-line label gets a short chip form).
- **Your team** card: rank/record/points tiles (Record rendered a size down —
  W–L–D wraps at Stat's text-3xl in the narrow column), form strip, stake
  one-liner, next-up tile aligned to the ENGINE's nextMatchId so the "next
  series" guarantee and the tile never point at different matches.
- **League pulse**: latest week's honors + most-picked hero (unknown hero ids
  render the "Hero #N" fallback per /meta's convention).
- COMPLETE: champion card + "How it was won" bracket + archive links.

## Standings & schedule UX (done)

- **StandingsTable** is now a thin server adapter (`page.tsx`) over the
  sortable client `src/components/standings-table.tsx`: clickable
  W/D/L/Diff/Pts headers (`aria-sort`), real league rank kept in the # column,
  viewer's team row highlighted with a You chip, weekly ▲/▼ movement
  (`standingsMovement`), ✓/✗ clinch marks (`clinchStatuses` — conservative
  points-only math, suppressed when everyone makes the bracket). Cut line +
  shading + arrows only render in league order.
- **/schedule** during REGULAR_SEASON: "Playoff picture" (projected first
  round via `playoffFirstRound` over live standings) and "Run-in"
  (`remainingSchedule` — rank-tagged remaining-opponent chips, in-cut
  opponents accented).
- **ScheduleWeeks** (`src/components/schedule-weeks.tsx`, client): team filter
  chips, fully-played past weeks collapsed to a header line, current week
  gets `id="this-week"` (dashboard deep-links `/schedule#this-week`), byes
  shown per week (`byeTeamsByWeek`) and kept visible under a team filter.
- **Leaders**: `src/components/leader-board.tsx` — full ranked rows, top-5 +
  show-all toggle, viewer's row highlighted and pinned with real rank when
  outside the top 5.
- **Times are viewer-local**: `<LocalTime>` (`useSyncExternalStore`; server
  string as the hydration snapshot, browser TZ after) + shared
  `formatMatchTime` (`src/lib/match-time.ts`). Server-side `toLocaleString`
  alone is WRONG in prod (UTC host) — always pair a preformatted `initial`
  with the epoch `ts`. `<Countdown>` (`countdownLabel`, tested) ticks
  "in 2d 4h" → "happening now" on the check-in banner.

## Datetime inputs (rule)

- NEVER parse a raw `datetime-local` string server-side (`new Date(raw)` uses
  the SERVER's zone — UTC in prod). Use `<LocalDatetimeField>` (submits a
  browser-computed epoch; prefill via `defaultTs`, never a server-formatted
  string) + `localDate(fd, raw, ts)` in the action. Discord messages carry
  times as `<t:epoch:F>` (reader-local), never formatted strings.
- KNOWN LIMITATION: week math is fixed-ms (`matchNightForWeek`, cascade
  deltas) — seasons spanning a DST transition drift the league night by an
  hour after the switch; per-match Set time corrects it.

## Rescheduling (done)

- **Both demand-a-response events announce to Discord**: a NEW "OUT" RSVP
  (`setAvailability` — reads the prior row first so IN↔OUT flapping can't
  spam; `playerOutMessage`) and a fresh reschedule proposal
  (`proposeReschedule` service now returns `ProposedReschedule` announcement
  data, action sends `rescheduleProposedMessage`). The dashboard's
  `MyNextMatch` also shows a "⏳ … Respond →" strip to the opposing captain
  while a proposal is pending.
- **Admin week mover**: `setWeekNight` action — retimes a week's unplayed
  matches from one input; optional cascade shifts later scheduled weeks by
  the same delta. Form lives in the admin Schedule & results card.
- **Captain flow**: `RescheduleRequest` model (PENDING/ACCEPTED/DECLINED/
  CANCELLED, one open per match — newer proposals supersede). Guards live in
  `src/lib/reschedule-service.ts` (draft-service pattern, integration-tested
  in `test/integration/reschedule.itest.ts`); `src/app/actions/reschedule.ts`
  is a thin wrapper that adds auth, toasts, and the best-effort Discord
  `rescheduleMessage` on acceptance. Match page shows the Reschedule card to
  the two captains only; `/schedule` rows show a ⏳ chip (links to the match
  page) while a proposal is open; the admin card lists open proposals with a
  Clear button.

## Verifying UI against a fixture (workflow note)

- `scripts/seed-fixture.ts` seeds a throwaway DB into a demo state:
  `FIXTURE_MODE=regular` (last week open — clinch marks, run-in, byes with
  `FIXTURE_TEAMS=5`), `complete` (champion crowned), default (mid-playoffs
  bracket with a TBD final). It REFUSES any `DATABASE_URL` without "fixture"
  in it — always pass one explicitly; the generated Prisma client's baked
  .env can silently point at dev.db.
- Fixture box scores carry the full modern line shape (durations, kill
  scores, benchmarks for report cards — the first two games ever stay
  legacy-shaped to verify degradation), every match gets its league-night
  `scheduledAt` (so `/api/calendar` has VEVENTs), and completed playoff
  matches get games too.
- The dev server locks its project dir (Next 16) and dev.db may belong to
  another session — never reseed it. To run a second server: copy the repo
  elsewhere (`rsync` minus node_modules/.next/dev.db, then
  `cp -Rc node_modules` — APFS clonefile; a symlink breaks Turbopack), point
  its `.env` at an absolute fixture `DATABASE_URL`, and `next dev -p 3111`
  from the copy.

## Performance (done — keep following these)

- **In-page streaming**: the dashboard (`page.tsx`) and the match preview wrap
  their slower async sub-sections in `<Suspense fallback={<CardSkeleton/>}>` so
  the hero/shell paints before the heavy queries resolve. When adding a new
  async card, wrap it too; use `CardSkeleton`/`Skeleton` (`ui.tsx`) for a
  fixed-height fallback (no CLS). The root `loading.tsx` still covers navigation.
- **Cached stat scans**: player attribution lives in each `Game.players` JSON,
  so the leaders/meta/records/hall-of-fame/profile roll-ups must scan the whole
  table. Those scans go through `src/lib/cached-queries.ts` (`unstable_cache`,
  60s TTL, tagged `"games"`) — viewer-independent, shared across requests. Add
  new all-games roll-ups there, not as inline `prisma.game.findMany`. The
  game-import admin actions call `refreshGames()` (`revalidateTag("games")` +
  path revalidate) so stats reflect a new import immediately; the 60s TTL is
  just the backstop. `revalidatePath` alone does NOT clear unstable_cache tags —
  bust the tag from a request scope (an action/route), never from the lib (it
  throws outside a request, breaking the integration tests that call it directly).
- **Live-room clocks**: the draft/inhouse countdowns tick inside leaf
  components via `useSecondsLeft`/`useElapsedMs` (`src/components/room-clock.tsx`)
  so only the clock text re-renders each 250ms — NOT the room + player pool.
  Don't reintroduce a room-level `forceTick`; keep new countdowns in a leaf.
- **Poll health**: both rooms wire `usePollHealth` (`room-clock.tsx`) into
  their poll loops — failures counted in refs, one `disconnected` boolean
  flips at ≥3 consecutive failures (never a per-poll re-render). While
  disconnected: aria-live danger strip, ALL actions disabled (each room
  derives `pending = reqPending || disconnected`), draft clock banner dimmed
  + "reconnecting" in the sticky bar. A 404 from `/api/draft/tick` is
  terminal ("no active season" card), not a retry loop. Never swallow poll
  failures silently — that's how captains watched a frozen auction sell
  their player.
- **DB indexes**: hot filter/join columns are indexed (`Match.seasonId`/home/
  away, `Game.matchId`, `Registration(seasonId,status,type)`, `TeamMember`
  team/user, `Bid.draftId`, `StandinAssignment.matchId`, `Prediction.userId`).
  Add an `@@index` when a new query filters a non-indexed column; skip it when
  an existing `@@unique` already has that column leftmost.
- **Payload trimming**: queries whose rows serialize into the client (the
  `getSeasonSnapshot` rosters, dashboard signup chips) `select` only the display
  fields (`id/name/avatar/rankTier`) instead of `include: { user: true }`.
  Don't re-add full user rows to snapshot/roster queries — the derived
  `SeasonSnapshot` type makes tsc enforce the narrowed shape.

## Good next steps

- Production deploy config (swap SQLite → Postgres, real Steam key).
- Optional: sync from a Valve `leagueid` (field exists on `Season`) if the
  league ever gets ticketed — `/leagues/{id}/matches` + `classifyGame`.
