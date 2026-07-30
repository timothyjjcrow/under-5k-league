# LD2L Architecture

A structural map of the codebase for developers adding features. This document
describes what exists and where; `CLAUDE.md` is the companion file of working
notes, concurrency doctrine, and hard-won gotchas — read both, but this one
first. Facts here are anchored to source paths; when this document and the code
disagree, the code wins and this file should be fixed.

---

## 1. What this is

LD2L ("GGD2L") is an amateur Dota 2 league site: players sign in with Steam,
register for a season, get bought onto teams in a live auction draft, and play
a weekly round-robin into single-elimination playoffs until a champion is
crowned. It is a Next.js 16 App Router app (React 19, TypeScript, Tailwind v4)
over Prisma 5 — SQLite in dev/test, Postgres in production via a build-time
provider swap. The app has **two independent modes**: the **drafted league
season** (everything hangs off the one `Season` row where `isActive = true`,
whose `status` walks `SIGNUPS → DRAFT → REGULAR_SEASON → PLAYOFFS → COMPLETE`
and gates which pages and nav links exist), and **inhouses** — a
season-independent pick-up mode with its own queue, lobby state machine, Elo
ladder, and play-money betting, coupled to the league only through the shared
`User` table. There is no cron and no websocket anywhere: all live behavior is
HTTP polling plus lazy resolvers that run on reads.

## 2. The league lifecycle, end to end

**Discord join → account linking.** The league lives in a Discord server; the
site links accounts via OAuth2 (`/api/auth/discord` →
`src/lib/discord-oauth.ts` for PKCE/state, `src/lib/discord-link-service.ts`
for the callback core). Linking stores only `User.discordId` + `discordName`
(tokens discarded) and, when a bot is configured, joins the player to the
guild in the same flow (`joinGuild` in `src/lib/discord-roles.ts`). A verified
`discordId` is what makes a player *pingable* by every notification below; the
`DiscordSetupPrompt` (`src/components/discord-setup.tsx`) nags registered but
unlinked players on the dashboard until they link.

**Steam login.** Steam OpenID 2.0 is the only real login
(`src/app/api/auth/steam/*`, `src/lib/steam.ts`). Success upserts a `User`
keyed on `steamId` (`src/lib/users.ts` — role from the authoritative
`ADMIN_STEAM_IDS` allowlist, else first-user-bootstraps-admin), best-effort
backfills the OpenDota rank medal (`ensureRankTier`), and mints a stateless
jose HS256 JWT session cookie (`src/lib/auth.ts`, claims `{uid, ep}`, 30
days). There is no middleware: every page, action, and route calls
`getSessionUser`/`requireUser`/`requireAdmin` itself. Revocation is a global
session epoch in the `Setting` table (`src/lib/session-epoch.ts`), bumped by
the admin "revoke all sessions" action. A dev/mock login exists at
`/api/auth/dev`, double-gated on `ALLOW_DEV_LOGIN` and non-production.

**Signup.** Players register on `/me` (`src/app/me/page.tsx` →
`saveRegistration` in `src/app/actions/registration.ts`). Pure gates live in
`src/lib/registration.ts`: `registrationGate` judges the *raw* claimed MMR
plus the OpenDota medal — the hard ceiling `HARD_MMR_CEILING` and a
Divine-3+/Immortal medal reject outright; `Season.maxMmr` is a **soft review
threshold that blocks nobody** (a recurring documentation trap — see
CLAUDE.md). Only gate-approved claims are then clamped to the medal's
plausibility window (`clampMmrToRank`, `src/lib/rank.ts`). Registrations carry
a questionnaire (roles via `src/lib/roles.ts`, favorite heroes, statement,
captain note) surfaced in the pool and draft room. `type` is `PLAYER` or
`STANDIN`; `status` is `ACTIVE`/`WITHDRAWN` (self-reversible) /`REMOVED`
(admin, sticky). New player signups announce to Discord. Signups are
**uncapped** — `minTeams` is a floor, and `src/lib/capacity.ts` is
display-only math, never a gate.

**Admin review.** The `/admin` Captains card supports MMR corrections
(`setRegistrationMmr`, never clamped), bulk medal sync (`syncPlayerRanks`,
which flags over-ceiling medals via `medalProvesIneligible` but never
auto-removes), `withdrawSignup`/`reinstateSignup`, and `setMaxMmr`.

**Captains and draft creation.** Captaincy is `Team.captainId` +
`TeamMember.isCaptain` (there is no CAPTAIN registration type). Admin actions
`addCaptain`/`removeCaptain`/`transferCaptaincy`/`randomizeDraftOrder`/
`setDraftSettings`/`setDraftNight` (all `src/app/actions/admin.ts`) configure
the field; `startDraft` then flips `SIGNUPS → DRAFT` in one transaction and
seeds per-team budgets via `mmrWeightedBudgets` (`src/lib/draft.ts` — linear
interpolation across captain MMRs, scaled by the actual gap, floored so every
team can fill a roster).

**Live auction draft.** Pure auction math in `src/lib/draft.ts`
(`maxBid` reserve rule, `canNominate`/`canBid`, snake rotation); the
transactional engine in `src/lib/draft-service.ts` (`nominatePlayer`,
`placeBid`, `resolveExpiredNomination`, `resolveStalledNomination`,
`getDraftState`). Clocks (30s bid, 90s nomination — `DEFAULTS` in
`src/lib/constants.ts`) are server-authoritative and resolve **lazily**:
`getDraftState` runs both resolvers before every read, and every route
(`/api/draft/tick|bid|nominate|admin-nominate`) funnels through it. The client
is `src/components/draft-room.tsx`, a ~1.2s poll loop whose cadence, sequence
ordering, outbid latch, feed diff, and title flags are all extracted into
tested pure modules (`src/lib/room-poll.ts`, `room-sequence.ts`,
`draft-feed.ts`, `draft.ts`). Night-of admin controls: `pauseDraft`/
`resumeDraft`, `undoLastSale` (reverts the newest `price > 0` purchase), and
`abortDraft` (full teardown back to SIGNUPS, refused once results exist).
Sales, completion, and a recap (`src/lib/draft-recap.ts`) announce to Discord.

**Team formation and roster moves.** Auction purchases become `TeamMember`
rows with a `price`. Post-draft rosters are maintained by `signFreeAgent`
(adds a registered unrostered player at $0), `releasePlayer` (frees the seat,
refunds the price, cancels unstarted standin cover — three effects in one
transaction), and `promoteStandinToPlayer` (the mid-season refill path,
guarded by `promoteGateError`).

**Schedule generation.** `generateSchedule` (`src/app/actions/admin.ts`) runs
the pure circle-method round robin (`roundRobin` in `src/lib/schedule.ts`,
home/away fairness, rotating BYE) and stamps kickoffs as pure arithmetic off
`Season.firstMatchNight` (`matchNightForWeek`: week N = first + (N−1)×7d).
`DRAFT → REGULAR_SEASON` has **no automatic writer** — the auction finishing
does not advance the phase; the admin uses the guarded `setSeasonPhase`
override. `/api/calendar` serves the fixtures as an RFC 5545 feed
(`src/lib/ics.ts`).

**The regular-season loop.** Each week:

- *Check-ins*: `MatchAvailability` RSVPs via the shared `<CheckinBanner>`
  (`src/components/checkin-banner.tsx` → `setAvailability` in
  `src/app/actions/availability.ts`); pure aggregation in
  `src/lib/availability.ts` (`matchNightRoster`/`teamAvailability`) shared by
  the dashboard, `/schedule`, and the Discord week reminder. A new OUT pings
  the affected captain (throttled via a Setting claim).
- *Standins*: guards in `src/lib/standin-service.ts` (Serializable
  transactions forming a deliberate write-skew triad with the withdraw and
  sign-free-agent paths), the pure same-night conflict rule in
  `src/lib/standin.ts`. Captains self-serve on the match page
  (`src/app/actions/standins.ts`); admins get the any-team override. Assign
  and remove both Discord-mention the standin.
- *Reschedules*: `src/lib/reschedule-service.ts` (one PENDING proposal per
  match; acceptance retimes the match, wipes RSVPs, and releases the week
  reminder marker in one transaction), thin actions in
  `src/app/actions/reschedule.ts`. The admin week mover is `setWeekNight`
  (canonical-night cascade retime).
- *Week reminder*: `src/lib/reminder-service.ts`, fired lazily by the
  invisible `<WeekReminderPing>` on the dashboard and `/schedule`, mentions
  exactly the players who haven't RSVP'd.
- *Result import*: the single write funnel is `importGameForMatch`
  (`src/lib/match-import.ts`) — OpenDota fetch (`src/lib/dota.ts`), pure
  `classifyGame` roster classification, Serializable re-checked create, then
  `recomputeSeries`. Entry points: captain self-serve
  (`src/lib/match-report-service.ts` → `src/app/actions/match-report.ts`),
  admin import/auto-detect/`recordResult`/`removeGame`/`reopenMatch`, the
  Valve league feed (`syncLeagueGames` when `Season.dotaLeagueId` is set), and
  the automatic sync below. `recomputeSeries` is the propagation hub: it
  derives series scores from `Game` rows, announces each decided series to
  Discord exactly once, advances playoff brackets, and fires weekly honors.
- *Automatic sync*: see §7. Results flow in with no button press.
- *Standings and stats*: everything is derived at read time.
  `computeStandings` (`src/lib/standings.ts`, 3/1/0 points, tiebreak chain
  ending in head-to-head mini-tables), the playoff scenario engine
  (`src/lib/scenarios.ts` + `src/lib/stakes.ts` — clinch marks, "win and in"
  banners), and the engagement layer (§ fantasy/pick'em/leaders/meta/records,
  see `src/lib/cached-queries.ts` for the shared 60s `"games"`-tagged scans).

**Playoffs.** `startPlayoffs` gates on `regularSeasonStatus`
(`src/lib/schedule-status.ts`) then calls `createPlayoffBracket`
(`src/lib/playoff-service.ts`) — a Serializable clear-and-reseed that seeds
the top `pickBracketSize(teams)` by standings into `R{round}M{match}` slots.
`advancePlayoffBracket` runs after *every* playoff result (admin entry or any
import path via `recomputeSeries`): it builds the next round behind an atomic
`playoffRoundBuilt:` Setting claim, and when the final is decided crowns the
champion via a guarded `PLAYOFFS → COMPLETE` claim — only the claim winner
sends `championMessage`. "Reset playoffs" is the same action re-run behind a
type-the-name confirm; deleted playoff games' Dota ids are archived
(merge-only) for re-import.

**Champion → archive → Hall of Fame.** `COMPLETE` renders the champion
dashboard and `/recap` (pure `src/lib/awards.ts`). `/seasons` and
`/seasons/[id]` recompute archived standings and brackets from stored rows;
`/hall-of-fame` rolls up cross-season careers (`src/lib/hall-of-fame.ts`,
career fantasy points, all-time oracle). `/seasons` also hosts the JSON season
export (`/api/admin/season-export` — the only production-reachable backup) and
`deleteSeason` behind the strongest confirm tier.

**Offseason.** `createSeason` archives the current season and activates the
new one in a Serializable transaction (the "exactly one active season"
invariant has no DB constraint); `reactivateSeason` (`src/lib/season.ts`) is
the undo. When the new season opens, `/me` prefills the signup form from the
player's most recent prior registration ("Welcome back" hint).

## 3. The inhouse lifecycle

State machine on `InhouseLobby.status`: `READY_CHECK → CAPTAIN_VOTE →
DRAFTING → READY → IN_PROGRESS → COMPLETED | CANCELLED`, one active lobby at a
time. Pure rules in `src/lib/inhouse.ts`, the engine in
`src/lib/inhouse-service.ts` (2,400 lines — queue, all phases, results, admin
recovery, and the viewer payload builder `getInhouseState`), the client in
`src/components/inhouse-room.tsx`, one dispatch endpoint `POST /api/inhouse`.

1. **Queue** — `joinQueue` (MMR trust chain: league registration > clamped
   typed value > last lobby snapshot) into the userId-unique
   `InhouseQueueEntry`. Presence is heartbeat-based (`lastSeenAt`, refreshed
   by the player's own polls); stale entries dim to "away" and are pruned.
   A queue crossing 4 present players fires a throttled Discord ping.
2. **Formation** — `maybeFormLobby` (Serializable; the one-active-lobby
   invariant lives here) takes 10 present players, snapshots their W/L
   records, and Discord-mentions all ten by `<@discordId>`.
3. **Ready check** — 45s; all ten must `acceptMatch` (claim guarded on both
   `acceptedAt: null` and the lobby still being in READY_CHECK). Decline or
   expiry fails the check: accepters requeue with priority, no-shows drop.
4. **Captain vote** — 25s; the ten vote how captains are chosen
   (`VOTE`/`MMR`/`RECORD`, tallied by pure `tallyMethod`/`orderCaptains` —
   the same functions the room uses for its previews).
5. **Snake draft** — 60s per pick, order `F O O F F O O F` via `nextPickTeam`;
   `applyPick` is the most heavily guarded transition in the repo (turn claim,
   player claim, advance claim, `PickRaceError` thrown past the first write).
6. **Betting window** — the `DRAFTING → READY` transition stamps
   `betsCloseAt` (+45s) via one shared `readyTransitionData` at both write
   sites. Players bet Cred **only on their own team, once, immutably**
   (`src/lib/inhouse-bets.ts` pure matched-pool math,
   `src/lib/inhouse-bet-service.ts` for every money write). Pressing Start
   never closes the window.
7. **Game setup** — READY/IN_PROGRESS render lobby name/password derived
   client-side from the lobby id (`inhouseLobbyCode`) plus team voice
   channels.
8. **Result detection** — OpenDota only, no manual winner: background scan
   (`maybeAutoDetectResult`), the detect button, or a pasted match id all
   converge on `buildResult` (league `classifyGame` reuse; emits `teamFixes`
   when players sat on the opposite side they were drafted to — the played
   game is the truth) and `applyResult`: one transaction for the
   `IN_PROGRESS → COMPLETED` claim + teamFixes, then bet settlement, then the
   full-history Elo scan stamping `eloDeltas`, then the Discord result.
9. **Settlement and ladders** — Elo is derive-don't-store
   (`summarizeInhouse`, K=32, recomputed from all COMPLETED lobbies on every
   read — which is what makes `voidLastResult` safe); Cred settlement rides
   single-winner claims, with ONE lazy sweeper (`resolveUnsettledBets`)
   handling every dead-lobby refund/reversal path. `/inhouse` shows the twin
   Elo + Cred-profit ladders; `/inhouse/history` is the archive.
10. **The board** — a single pinned, self-editing Discord message
    (`src/lib/inhouse-board.ts` render / `inhouse-board-service.ts` service)
    showing the live queue; digest-gated so a motionless queue costs zero
    API requests. Repainted from both resolver chains.

Lazy resolution mirrors the draft: `getInhouseState` runs the full resolver
chain (abandoned-lobby sweep, bet sweep, formation, ready check, vote, stalled
pick, auto-detect) before every read, and `/api/sync` runs the same chain
sitewide so a lobby nobody is watching still resolves.

## 4. Architecture: the layering rules

**Five layers, with naming conventions that tell you where you are:**

| Layer | Convention | Examples |
| --- | --- | --- |
| Pure logic (no DB, no IO) | `src/lib/<name>.ts` + sibling `<name>.test.ts` | `draft.ts`, `standings.ts`, `schedule.ts`, `inhouse.ts`, `inhouse-bets.ts`, `rank.ts`, `scenarios.ts` |
| DB services (transactional) | `src/lib/<name>-service.ts`, covered by `test/integration/*.itest.ts` | `draft-service.ts`, `inhouse-service.ts`, `playoff-service.ts`, `standin-service.ts`, `reschedule-service.ts`, `result-sync-service.ts` |
| Thin mutations | `src/app/actions/*.ts` (server actions: auth + parse + delegate + toast + Discord send + revalidate) and `src/app/api/*` route handlers for the polled rooms | `actions/admin.ts`, `actions/registration.ts`, `api/draft/*`, `api/inhouse` |
| Server pages | `src/app/**/page.tsx` — query Prisma directly (no read API), run pure libs, serialize plain props | `page.tsx` (dashboard), `schedule/page.tsx` |
| Client leaves | `src/components/*.tsx` `"use client"` — polling rooms, forms, clocks, toasts | `draft-room.tsx`, `inhouse-room.tsx`, `action-form.tsx`, `local-time.tsx` |

Rules that follow from the layering:

- **Prefer adding logic to a pure lib with a test beside it.** Services should
  be thin transactions over pure decisions; the room components have had every
  behavioral rule extracted into pure modules precisely because there is no
  jsdom (`vitest.config.mts` is `environment: "node"`).
- **Lazy resolution, no cron.** Expired clocks and pending work resolve on the
  next read: `getDraftState` and `getInhouseState` run resolvers before every
  read, and `POST/GET /api/sync` — pinged by the invisible `<ResultSyncPing>`
  in the root layout on every page view — is the de-facto global cron. One
  sync run can import league results, advance a bracket, crown a champion,
  resolve an inhouse lobby, settle bets, retry failed announcements, and
  repaint the Discord board. An external uptime monitor on `GET /api/sync`
  bounds the nobody-on-site window (README).
- **Concurrency doctrine** (two sentences; the full treatment with worked
  examples is CLAUDE.md's "Concurrency: the two rules"): a read-time
  precondition is not a guard — re-assert it in the WHERE of the write
  (`updateMany` claims, Serializable transactions for cross-table write-skew
  pairs); and past the first write, failure must THROW a typed error caught
  *outside* the transaction callback, never return. SQLite serializes writers
  and hides every violation; only `npm run test:pg` and the mutation ratchet
  exercise these guards for real.
- **Derive, don't store.** Standings, scenarios, leaders, records, meta,
  power rankings, Elo, awards, MVPs are all recomputed from `Game`/lobby rows
  at read time (through `src/lib/cached-queries.ts` for the whole-table
  scans — `unstable_cache`, 60s TTL, tag `"games"`, busted by every import
  path). Deliberate exceptions, each with a stated reason:
  `InhouseLobby.eloDeltas`/`betDeltas` (stamped once at completion so the
  1.5s poll path never scans history), `InhouseLobbyPlayer.wins/losses/games`
  (record snapshots frozen at formation), and `InhouseCredit.balance` (a
  mutable column because the affordability check must be re-assertable in the
  WHERE of the debit — the append-only `InhouseCreditEntry` ledger is the
  provenance).
- **Feedback contract.** Mutations return `ActionResult`
  (`src/lib/action-result.ts`), rendered through `<ActionForm>` /
  `<SubmitButton>` (`src/components/action-form.tsx`) into the global
  `<Toaster>`. The live rooms bypass forms but reuse `pushToast`.

## 5. Page inventory

25 pages. "Nav from X" = the link appears from that phase onward
(`src/components/site-header.tsx`); most pages still render if visited
directly.

| Route | Purpose | Gating | Notable data sources |
| --- | --- | --- | --- |
| `/` | Phase-aware dashboard (5 views, ~20 streamed sub-components) | Always | `getSeasonSnapshot`, `computeStandings`, `scenarioReport`, `focusSlate`, cached leaders scan |
| `/login` | Steam login + dev quick-login | Always | — |
| `/me` | Profile: signup form, Dota/Discord linking, withdraw, prefill | Signed in | Registration, prior-season prefill, rank/medal hint |
| `/players` | Signup pool (URL-mirrored filters) + rosters | Always | 4 inline queries → client `PlayerPool` |
| `/players/[id]` | Player profile: career stats, report card, achievements, seasons, inhouse card | Always | Cached `getAllGameLines` two-pass scan |
| `/players/compare` | GET-form two-player comparison | Always | `getAllGameScores`, `meetings` |
| `/teams` | Teams index + power rankings + draft recap | Nav from DRAFT | Standings order post-results; `powerRankings` |
| `/teams/[id]` | Team detail: scenario card, roster, hero pool, H2H | Always (archived works) | `seasonScenarioReport`, cached season scan |
| `/draft` | Live auction room | Gates only on "no active season" | Polls `/api/draft/tick` |
| `/schedule` | Standings, weeks, bracket, season grid, playoff picture | Nav from REGULAR_SEASON | `computeStandings`, `crossTable`, `buildBracketRounds` |
| `/matches/[id]` | Box scores or pre-match preview (scouting, stakes, RSVP, standins, reschedule, captain report) | Always | Game JSON, `scouting.ts`, `matchStakes` |
| `/leaders` | 8 stat boards + weekly honors + report cards | Nav from REGULAR_SEASON | `getSeasonGameLeaders`, `topBy` |
| `/meta` | Hero meta report | Nav from REGULAR_SEASON | `getSeasonGameScores`, `heroMeta` |
| `/fantasy` | Fantasy-five picker + standings | Nav from REGULAR_SEASON | `fantasyPoints`, lock on first import |
| `/pickem` | Predictions + oracle board | Nav from REGULAR_SEASON | `predictionOpen`, `pickemStandings` |
| `/records` | All-time single-game record book | Footer link | `getAllGamesForRecords` (chronological) |
| `/hall-of-fame` | Cross-season career boards | Footer link | `careerCounts`, all-seasons scans |
| `/recap` | Season awards page | Nav on COMPLETE; `?season=` | `computeSeasonAwards` |
| `/seasons` | Season history index + admin reactivate/export/delete | Nav once an archived season exists | — |
| `/seasons/[id]` | Season archive: standings, bracket, rosters | Same | Recomputed from archived rows |
| `/inhouse` | Inhouse room + scene stats + Elo/Cred ladder + results | Always (season-independent) | Polls `/api/inhouse`; `summarizeInhouse`, `credProfitBoard` |
| `/inhouse/history` | Completed-lobby archive | Always | Latest 100 lobbies |
| `/news` | News archive | Footer link | `sortNews` |
| `/features` | Static feature tour | Always | Live counts + phase-gated links |
| `/admin` | The control panel (§8) | Admin only | `loadSeasonAdminData` |

API routes (14): `/api/auth/steam` + `/callback`, `/api/auth/discord` +
`/callback`, `/api/auth/dev`, `/api/auth/logout` — auth (§2);
`/api/draft/tick|bid|nominate|admin-nominate` — the auction (tick is the
300/min-per-IP poll; bid/nominate are deliberately unlimited);
`/api/inhouse` — single POST dispatch (`{action: state|join|leave|accept|
decline|vote|pick|start|detect|record|bet|cancel|void}`, 300/min);
`/api/sync` — the lazy sync trigger (POST from `<ResultSyncPing>`, GET for
uptime monitors, 30/min); `/api/calendar` — the .ics feed;
`/api/admin/season-export` — the season JSON backup. Rate limiting
(`src/lib/rate-limit.ts`) is an in-memory per-instance speed bump, not a
distributed limit. App-level files: `layout.tsx` (session + season + nav
gating fetched per request), `error/loading/not-found.tsx`, `sitemap.ts`,
`robots.ts`, `manifest.ts`.

## 6. Database models

24 models in `prisma/schema.prisma`, committed on the sqlite provider
(`scripts/switch-db-provider.mjs` swaps to postgresql at build). SQLite has no
enums, so every status column is a string whose allowed values live in
`src/lib/constants.ts`. Uniques double as concurrency guards throughout.

**Identity & content**

- `User` — Steam-keyed identity (steamId @unique); role, rank medal
  (`rankTier`), `fhUnavailable` (public-match-data flag), Discord link
  (`discordId` @unique = the OAuth-proof collision guard, `discordName` the
  unverified fallback).
- `NewsPost` — admin announcements; author `SetNull` so posts outlive users.

**Season core**

- `Season` — the root aggregate and state machine; `isActive` marks "the"
  season (no DB constraint — held by Serializable archive-then-activate);
  carries `draftBudget`, `budgetMmrWeight`, `maxMmr` (soft), series lengths,
  `firstMatchNight`, `draftAt`, `dotaLeagueId`, `championTeamId`.
- `Registration` — `@@unique([seasonId, userId])`; type PLAYER/STANDIN,
  status ACTIVE/WITHDRAWN/REMOVED, MMR + questionnaire.
- `Team` / `TeamMember` — rosters; `TeamMember @@unique([seasonId, userId])`
  stops double-drafting; `price > 0` is the exact auction-vs-free-agent
  discriminator `undoLastSale` relies on.
- `Draft` — one row per season: the whole auction state (status, rotation,
  live lot, both clocks). Every transition is a guarded `updateMany` claim on
  this row.
- `Bid` — per-lot audit trail (swept by undo/abort; `AdminAction` is the
  surviving record).

**Fixtures & results**

- `Match` — fixture + series score + `bracketSlot` (`R{r}M{m}` — no unique;
  round exactly-once rests on Setting claims) + auto-sync bookkeeping
  (`autoSyncedAt` = the per-match scan claim column, `autoSyncAttempts` =
  backoff counter). `Match→Team` is RESTRICT, which dictates delete order.
- `RescheduleRequest` — one PENDING per match (enforced by the service's
  Serializable cancel-then-create).
- `MatchAvailability` — RSVPs, `@@unique([matchId, userId])`.
- `StandinAssignment` — cover rows; null `replacingUserId` = filling an empty
  seat.
- `Game` — an imported Dota game; `dotaMatchId` @unique is the import dedupe;
  per-player stats live in the `players` JSON column (hence the whole-table
  scans in `cached-queries.ts`).

**Engagement**

- `FantasyRoster`/`FantasyPick` — `@@unique([seasonId, userId])` /
  `[rosterId, userId]`.
- `Prediction` — pick'em, `@@unique([matchId, userId])`.

**Inhouse**

- `InhouseQueueEntry` — userId-unique rolling queue with `lastSeenAt`
  presence heartbeat.
- `InhouseLobby` — the game + state machine + result columns (`boxScore`
  JSON, `winnerTeam`, `eloDeltas`, `betDeltas`, `betsCloseAt`,
  `matchStartTime`, `betSettlement` — indexed, the bet sweeper's probe).
- `InhouseLobbyPlayer` — `@@unique([lobbyId, userId])`; team, captaincy,
  pick order, MMR + record snapshots, vote, ready-check `acceptedAt`.
- `InhouseBet` — `@@unique([lobbyId, userId])` **is** the double-spend guard;
  team frozen at placement for lineup-void grading.
- `InhouseCredit` — the mutable balance column (deliberate exception, §4).
- `InhouseCreditEntry` — append-only ledger; `@@unique([reason, refId])` is
  the idempotence key (wager legs, the once-per-day floor, the one-time
  grant). **No FK on purpose.**

**Infrastructure**

- `AdminAction` — append-only audit log; deliberately no FKs (records outlive
  what they describe; every table wipe must name it explicitly).
- `Setting` — a two-column key/value table serving **four distinct
  patterns**: (1) plain config via `getSetting`/`setSetting`
  (`src/lib/settings.ts`; empty value *deletes* the row) — the three Discord
  webhooks, ping role id, `sessionEpoch`; (2) atomic global throttles via
  `claimThrottle` (conditional `updateMany` on an ISO-string value, then
  create-with-P2002-catch) — `leagueAutoSyncAt`, `rosterAutoSyncAt`,
  `announceRetryAt`, `inhouseBoardAt`, `outPing:<matchId>:<userId>`;
  (3) exactly-once markers claimed by raw `setting.create` (P2002 = already
  done) — `resultAnnounced:<matchId>` (re-claimable when stamped
  `failed:<iso>`), `weekReminder:<season>:<week>`,
  `honorsAnnounced:<season>:<week>`, `playoffRoundBuilt:<season>:<round>`;
  (4) JSON state blobs written by compare-and-swap — `inhouseBoard` (row
  existence = the board's on/off switch), `importSkip:<seasonId>`,
  `leagueSyncSkip:<seasonId>`, `playoffGamesArchive:<seasonId>` (merge-only).
  The dynamic keyspace is invisible to `SETTING_KEYS` — consumers rely on
  prefix conventions, so key-format changes have cross-file blast radius.

## 7. Background/automatic processes

All lazy — each runs inside some request. Triggers, throttles, and homes:

| Process | What it does | Trigger | Throttle / idempotency |
| --- | --- | --- | --- |
| Result sync, roster-scan path (`src/lib/result-sync-service.ts` `syncDueMatches`) | Claims ONE due match (in the 25min–48h post-kickoff window, stalest first) and roster-scans OpenDota via `autoDetectGamesForMatch` | `<ResultSyncPing>` POSTs `/api/sync` on page view + heartbeat (60s while `watch`, 300s idle); GET for uptime monitors | Global `rosterAutoSyncAt` claim (45s); per-match atomic claim on `Match.autoSyncedAt` re-asserting not-COMPLETED; exponential empty-scan backoff on `autoSyncAttempts` (cap ≈4.3h), rolled back when OpenDota was unreachable |
| Result sync, league-feed path (`syncLeagueGames({auto:true})`) | With `Season.dotaLeagueId`, one feed fetch covers everything | Same run, preferred over roster scans | `leagueAutoSyncAt` claim (180s); ≤25 unknown match fetches/run; per-season `leagueSyncSkip:` memory (admin's manual button bypasses both) |
| Inhouse resolver chain (`syncInhouse` + `getInhouseState`) | Abandoned-lobby sweep, bet sweep, formation, ready check, vote, stalled pick, auto-detect, board repaint | Every `/api/inhouse` state read AND every `/api/sync` run (so parked lobbies resolve) | Each resolver is its own guarded claim; auto-detect throttled by `detectedAt` with an age-grown interval |
| Bet sweeper (`resolveUnsettledBets`, `src/lib/inhouse-bet-service.ts`) | Settle / refund / reverse stranded pots | Both resolver chains, above the empty-queue early return, try/catch-isolated | Three claim-guarded branches on the indexed `betSettlement` column; one lobby per run |
| Announce retry (`retryFailedAnnouncements`) | Re-sends series results whose Discord send failed | Every `/api/sync` run | `announceRetryAt` claim; re-claims only `failed:`-stamped `resultAnnounced:` markers, ≤3/run; prunes orphans |
| Week reminder (`maybeAnnounceUpcomingWeek`, `src/lib/reminder-service.ts`) | Announces next week's fixtures + un-RSVP'd mentions, 24h ahead | `<WeekReminderPing>` on dashboard + `/schedule` | Atomic `weekReminder:` marker create; deleted on failed send and by every retime path so it re-fires with the new time |
| Weekly honors (`maybeAnnounceWeekHonors`, `src/lib/honors-service.ts`) | Player/Team of the Week once a regular week fully completes | `recomputeSeries` (all import paths) + admin `recordResult` | Atomic `honorsAnnounced:` marker; released on failed send; never burned when nothing imported or no webhook |
| Board repaint (`syncInhouseBoard`, `src/lib/inhouse-board-service.ts`) | PATCHes the pinned Discord queue board when its semantic digest changed | Poll-path `getInhouseState` and both `syncInhouse` paths (never on mutations — `syncBoard:false`) | Digest gate (unchanged = zero requests); `inhouseBoardAt` claim (10s); CAS write-back; 404/401/403 = permanent "gone" |
| Session epoch (`src/lib/session-epoch.ts`) | Global token invalidation counter checked on every `getSessionUser` | Admin `revokeAllSessions` bumps it | 30s in-process cache; tokens carry the epoch they were minted under |

## 8. Admin tools

`/admin` (`src/app/admin/page.tsx`) is 14 anchored cards behind a sticky jump
bar, with the set-once cards collapsed as `<details>` and the three slow cards
Suspense-streamed. An `adminNextStep` banner (`src/lib/admin-next-step.ts`,
pure, tested) says what to do next per phase — it exists because several
transitions are silent (notably DRAFT→REGULAR_SEASON). Confirmation tiers:
**plain** form, **confirm** (`<SubmitButton confirm>` → `window.confirm`), and
**DangerSubmit** (`src/components/danger-submit.tsx`, type the exact
season/team name) — reserved for exactly the five actions with no in-app undo.

| Card | Key controls (action → tier) |
| --- | --- |
| Season controls | `setSeasonPhase` (confirm, heavily guarded), `renameSeason`/`setMaxMmr`/`setSeriesLengths`/`setMatchSchedule` (plain), `setDraftSettings` |
| Captains & draft | `addCaptain` (confirm), **`removeCaptain` (DangerSubmit)**, `transferCaptaincy`, `randomizeDraftOrder`, `startDraft` (confirm names the seat math), `pauseDraft`/`resumeDraft`, `undoLastSale` (confirm), **`abortDraft` (DangerSubmit)**, `setDraftNight`, `setRegistrationMmr`, `withdrawSignup`/`reinstateSignup`, `syncPlayerRanks`, `syncSteamProfiles` |
| Schedule & results | Generate (confirm, only when empty) vs **Regenerate (DangerSubmit, names collateral)** as separate controls; `setWeekNight` (confirm), per match: `recordResult` (confirm), `reopenMatch`, `setMatchTime`, `removeGame`, import/auto-detect; pending-reschedule Clear |
| Playoffs | Start (confirm) vs **Reset (DangerSubmit)** — same `startPlayoffs` action, split controls; playoff-games archive listing |
| Roster moves | `signFreeAgent`, `promoteStandinToPlayer`, `releasePlayer` (confirm — names refund + cover effects) |
| Standins | `assignStandin` (incl. empty-seat `seat:<teamId>` form), `removeStandin` (confirm) |
| Auto-sync health | Read-only: per-match scan state, league throttle, cursor, skip memory |
| Dota league integration | `setLeagueId`, `syncLeagueAction`, `enrichGamesAction`, `syncAllRanks` |
| Discord (streamed) | Webhook set/clear ×3 (league / inhouse board / inhouse alerts — board torn down first on channel moves), ping role, test sends, board post/remove, ping-health checklist + reach count |
| Inhouse betting (streamed) | Zero-sum + ledger drift alarms, stranded pots, negative balances, `adjustCredAction` (confirm — deliberately not DangerSubmit; reversible) |
| Admin activity (streamed) | `recentAdminActions(40)` — the append-only `AdminAction` log (coverage is partial; see the log's call sites) |
| League news | create/pin/delete (`src/app/actions/news.ts`) |
| Security | `revokeAllSessions` (confirm) |
| Create a new season | `createSeason` (confirm; archives the current season) |

Off-page on `/seasons` (archived seasons only): `reactivateSeasonAction`
(confirm), the season-export JSON download, and **`deleteSeason`
(DangerSubmit)** — the app's only unrecoverable action, with the export
offered directly above it.

## 9. External integrations

**Steam** (`src/lib/steam.ts`): OpenID 2.0 login (check_authentication
round-trip, return-to pinning, 8s timeouts) and GetPlayerSummaries for
name/avatar (needs `STEAM_API_KEY`). Failure rule: never overwrite a stored
profile with a placeholder — fetch failures return null and the upsert leaves
existing fields untouched.

**OpenDota** (`src/lib/dota.ts`): match fetches (`/matches/{id}`, 12s cap),
per-player recent-match lists (8s; returns `null` for unreachable vs `[]` for
genuinely empty — callers use the distinction to blame the right thing),
league feeds (`/leagues/{id}/matches`), and rank medals (`rank_tier` +
`fh_unavailable`). Optional `OPENDOTA_API_KEY`. Budgets: one roster scan ≈ 10
recent-match lookups + ≤12 match fetches under a 25s deadline; the league feed
fetches ≤25 unknown ids per auto run; inhouse detection needs 4 of 10 lists to
agree on a candidate. Hero names are never fetched — `src/lib/heroes.ts` is a
static table, so no hero label depends on OpenDota being up. Rank/medal writes
follow never-overwrite-on-failure.

**Discord** — three mechanisms, all outbound only (no gateway, no slash
commands):

1. *Webhooks* (`src/lib/discord.ts`): ~24 pure, tested message formatters +
   the transport (`sendTo`, 5s timeout, resolves false and never throws —
   which is why services return announcement payloads and the action layer
   sends *after* the write commits). Three webhooks form a fallback chain:
   league (`discordWebhookUrl`) ← inhouse board channel ← inhouse alerts
   channel, so an alert can never scroll the pinned board out of view. Every
   send pins API v10 and `allowed_mentions: {parse: []}` — mentions happen
   only through an explicit server-chosen `MentionAllowlist`; untrusted names
   pass through `escapeDiscordText` (`src/lib/discord-escape.ts`). Webhook
   URLs are bearer credentials: never rendered to the client (masked
   fingerprints only), blank submit = no-op, clearing is an explicit action.
2. *Bot token* (`src/lib/discord-roles.ts`, env `DISCORD_BOT_TOKEN` +
   `DISCORD_GUILD_ID`): the self-serve inhouse ping-role toggle
   (`setPingRole`), the OAuth `guilds.join`, and the `getPingHealth`
   diagnostic (hierarchy + permission math). Missing any config piece makes
   the feature invisible, never half-working.
3. *OAuth linking* (§2): identify scope (+ conditional guilds.join), tokens
   discarded, a failed join never fails the link.

The overarching failure-tolerance rule: **a Discord failure can never fail or
roll back a database write.** Announcements needing exactly-once semantics use
Setting markers with a documented recovery shape (delete-marker-on-failure for
reminder/honors, `failed:`-stamp-and-sweep for series results); everything
else is fire-and-forget.

## 10. Testing model

Five layers (depth and the doctrine behind each in CLAUDE.md):

1. **Unit** — `npm test` (`vitest.config.mts`, node environment, no jsdom):
   `src/**/*.test.ts` beside every pure lib. Because components can't render,
   four **source-guard suites** parse component/page/action *source text* to
   pin wiring: `src/components/room-source-guards.test.ts` (both rooms route
   through the extracted pure modules, every fetch carries `signal:`,
   sequences minted before the await, exactly two chime call sites),
   `src/app/admin/admin-copy-guard.test.ts` (copy must name real controls;
   bans historically wrong claims), `src/app/dashboard-guards.test.ts`
   (draft-night countdowns carry `passedLabel`), and
   `src/components/danger-submit.test.ts` (the five no-undo actions stay
   behind type-to-confirm). Script tests (`build-db`, `backup-db`, etc.) live
   under `src/lib/` because of the include glob.
2. **Integration on SQLite** — `npm run test:integration`
   (`vitest.integration.config.mts`, dedicated `prisma/test.db`, schema pushed
   once, every table wiped per test): 30 `.itest.ts` files exercising the
   services with `@/lib/dota` and `@/lib/discord` sends mocked (formatters
   real) — except the two real-HTTP suites that run the actual Discord
   transport against in-process `node:http` stand-ins.
3. **The same suite on Postgres** — `npm run pg:up`, export `PG_TEST_URL`,
   `npm run test:pg`, `npm run pg:down` (do not skip pg:down — it restores
   the sqlite provider). SQLite serializes writers, so raced tests
   (`factories.raceAll`) run concurrently *only* here, and the deterministic
   race-hook seam tests (`src/lib/race-hook.ts` — a test-only fault injector
   with 12 labeled seams across five services) are Postgres-only. This is the
   only run where the concurrency guards are exercised for real.
4. **The mutation ratchet** — `npm run test:mutation` (verify) /
   `test:mutation:discover` (extend), `scripts/mutation-guard.mjs` + committed
   `test/mutation-baseline.json`: deletes each guarded `updateMany` WHERE
   predicate and requires the pg suite to fail. Currently 59 claims — 54
   protected, 5 documented equivalent mutants (each with its justification;
   one is pinned honest by a `FOR UPDATE NOWAIT` equivalence test). CI runs it
   as a 4-shard matrix. Caveat: it models exactly one guard shape — early
   returns and count-check-then-throw guards are invisible to it and covered
   by hand-written tests instead.
5. **Two Playwright suites**, each on its own DB and port, so they never touch
   dev.db: `npm run test:e2e` (`e2e/`, `prisma/e2e.db`, :3210 — signups/draft
   phase: two-context live bidding, poll-resilience via hung endpoints, the
   full inhouse lifecycle) and `npm run test:e2e:mid` (`e2e-mid/`,
   `prisma/e2e-fixture.db`, :3212 — mid-season fixture: every read surface,
   zero-pageerror tracking, and the geometry tripwires in `e2e-mid/helpers.ts`
   for overflow/truncation/tap-target regressions). They can't run
   simultaneously (one Next dev server per repo dir).

CI (`.github/workflows/ci.yml`) runs: types + unit + SQLite integration; the
integration suite on a Postgres service container; the 4-shard mutation
matrix; and both Playwright suites sequentially. Deploy (`vercel.json`) swaps
the provider to postgresql and runs `scripts/build-db.mjs`, which pushes the
schema **only** on `VERCEL_ENV=production` — previews just `prisma generate`.
Destructive local commands are gated by `scripts/assert-local-db.mjs` and
per-script URL-shape guards ("fixture", "pgtest", "e2e"); `npm run db:backup`
plus the season-export route are the backup story.
