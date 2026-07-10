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
- Run `npx tsc --noEmit` for a fast type check; `npm test` for unit;
  `npm run test:e2e` for Playwright (reseeds the DB first).

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
  `src/lib/inhouse-stats.ts` — `summarizeInhouse` leaderboard
  (wins/losses/win%/streak; also feeds the RECORD method). Tunables in
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
  players so `/inhouse` isn't empty on a fresh DB.

## Draft edge cases (done)

- Nomination auto-skip: `resolveStalledNomination` nominates the top available
  player at min bid when the nominator's clock runs out.
- Pool-dry completion: if signups run out mid-draft, both resolvers mark the
  draft COMPLETE (short teams play with standins) instead of stalling forever.
  `startDraft` warns in its success toast when seats outnumber the pool.
- `recordResult` validates scores against the match's `bestOf` via pure
  `seriesScoreError` (`standings.ts`); partial results/forfeits are allowed.
- Cancelling an inhouse lobby re-queues its 10 players (fresh captain vote on
  the next poll).

## Discord notifications (done)

- `src/lib/discord.ts` — pure message formatters (unit-tested) +
  `sendDiscordMessage` (best-effort POST to an incoming webhook, 5s timeout,
  never throws). Webhook URL: `Setting` table key `discordWebhookUrl`
  (`src/lib/settings.ts`, admin panel card with save/validate/test) with
  `DISCORD_WEBHOOK_URL` env as fallback.
- Announces: new player signups (with countdown to the draft threshold), draft
  started (`startDraft`), draft complete (both draft-service resolvers, flagged
  inside the tx and sent after commit), match results (`recordResult`), playoff
  bracket (`startPlayoffs`), and the champion (`advancePlayoffBracket`).

## Match-night check-in (done)

- `MatchAvailability` model (matchId+userId unique, status IN|OUT). Pure
  summary math in `src/lib/availability.ts` (`teamAvailability`, tested).
- Players RSVP from a "Your next match" banner on `/schedule`
  (`setAvailability` action in `src/app/actions/availability.ts` — rostered
  players and assigned standins only, no completed matches). Match rows show
  per-team ✓/✗ counts while a match is unplayed.
- Admin standin card flags players who declared OUT and aren't covered by an
  assignment yet, right above the assign form.

## Season history (done)

- `/seasons` — every season newest-first (phase badge / Current, champion,
  team/signup/match counts). `/seasons/[id]` — champion banner, final
  standings, playoff rounds, weekly results, full rosters. Reuses
  `computeStandings`, `groupPlayoffRounds`, and `StandingsTable`; archived
  `/teams/[id]` pages already work since they query by id, not active season.
- Nav "History" + footer "Past seasons" links appear only once an archived
  (`isActive: false`) season exists — layout passes `hasHistory` down.

## Match previews (done)

- `/matches/[id]` renders a `MatchPreview` while a match has no games and
  isn't COMPLETED: side-by-side rosters (rank, roles, RSVP status, standins),
  recent-form strips, prior-meetings line (leader-phrased head-to-head), and
  the same check-in banner as `/schedule` for participants. Completed matches
  without imports keep the "no games recorded" empty state.

## Good next steps

- Production deploy config (swap SQLite → Postgres, real Steam key).
- Optional: sync from a Valve `leagueid` (field exists on `Season`) if the
  league ever gets ticketed — `/leagues/{id}/matches` + `classifyGame`.
