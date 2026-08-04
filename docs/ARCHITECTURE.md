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
season** (when a drafted league is running, it hangs off the at-most-one
`Season` row where `isActive = true`; its `status` walks
`SIGNUPS → DRAFT → REGULAR_SEASON → PLAYOFFS → COMPLETE` and gates which pages
and nav links exist; zero active rows is the real offseason), and **inhouses** — a
season-independent pick-up mode with its own queue, lobby state machine, Elo
ladder, and play-money betting, coupled to the league only through the shared
identity and opportunistic reuse of the latest trusted `Registration.mmr`; it
has no `seasonId` or league-phase gate. There is no websocket. Interactive
rooms still use HTTP polling; anonymous polls are side-effect-free, while
authenticated polls elect at most one database-backed maintenance winner per
room every two seconds. Sitewide background work runs once per minute through the bearer-authenticated
`GET /api/cron/automation` boundary. Public page traffic observes automation
state but does not serve as its clock.

## 2. The league lifecycle, end to end

**Discord join → account linking.** The league lives in a Discord server; the
site links accounts via OAuth2 (`/api/auth/discord` →
`src/lib/discord-oauth.ts` for PKCE/state, `src/lib/discord-link-service.ts`
for the callback core). Kickoff stores random state, a PKCE verifier, the
initiating site user id, and an optional safe return path in a ten-minute,
one-shot httpOnly v2 cookie. The callback requires exactly one `state` and
`code`, consumes the cookie, and rejects a replacement site session before any
identity can be linked. Linking stores only `User.discordId` + `discordName`
(tokens discarded) and, when a bot is configured, joins the player to the
guild in the same flow (`joinGuild` in `src/lib/discord-roles.ts`). A verified
`discordId` is what makes a player _pingable_ by every notification below; the
`DiscordSetupPrompt` (`src/components/discord-setup.tsx`) nags registered but
unlinked players on the dashboard until they link.

**Steam login.** Steam OpenID 2.0 is the only real login
(`src/app/api/auth/steam/*`, `src/lib/steam.ts`). Success upserts a `User`
keyed on `steamId` (`src/lib/users.ts` — role from the authoritative
`ADMIN_STEAM_IDS` allowlist; production validation requires at least one valid,
unique administrator before deployment, while the atomic
`bootstrapAdminSteamId` Setting claim is local-development fallback only),
best-effort backfills the OpenDota rank medal (`ensureRankTier`), and mints a stateless
jose HS256 JWT session cookie (`src/lib/auth.ts`, claims `{uid, ep}`, 30
days). Production session and one-shot OAuth cookies use browser-enforced
`__Host-` names (Secure, host-only, `Path=/`), preventing a sibling subdomain
from tossing a competing identity/state cookie. The first hardened deployment
therefore intentionally signs out sessions minted under the legacy name.
Production `getSessionUser` re-evaluates the allowlist on every
authenticated request, so removing an administrator revokes the existing
cookie's authority on the next request instead of waiting for another login.
There is no middleware: every page, action, and route calls
`getSessionUser`/`requireUser`/`requireAdmin` itself. Revocation is a global
session epoch in the `Setting` table (`src/lib/session-epoch.ts`), bumped by
the admin "revoke all sessions" action. A dev/mock login exists at
`/api/auth/dev`, double-gated on `ALLOW_DEV_LOGIN` and non-production. A
validated, ten-minute httpOnly return cookie carries same-origin
destinations through Steam. A separate 32-byte one-shot browser-state cookie
is pinned into the signed OpenID `return_to`; duplicate/canonical OpenID
assertions and the exact Steam verification response are checked before login.
Every callback exit consumes both cookies, while failures copy only the safe
path onto the retry URL.

**Signup.** Players register on `/me` (`src/app/me/page.tsx` →
`saveRegistration` in `src/app/actions/registration.ts`). Pure gates live in
`src/lib/registration.ts`: `registrationGate` judges the _raw_ claimed MMR
plus the OpenDota medal — the hard ceiling `HARD_MMR_CEILING` and a
Divine-3+/Immortal medal reject outright; `Season.maxMmr` is a **soft review
threshold that blocks nobody** (a recurring documentation trap — see
CLAUDE.md). Only gate-approved claims are then clamped to the medal's
plausibility window (`clampMmrToRank`, `src/lib/rank.ts`). Registrations carry
a questionnaire (roles via `src/lib/roles.ts`, favorite heroes, statement,
captain note) surfaced publicly in the pool/profile and again in the draft
room. `type` is `PLAYER` or
`STANDIN`; `status` is `ACTIVE`/`WITHDRAWN` (self-reversible) /`REMOVED`
(admin, sticky). Full-player admissions and captain volunteering close after
SIGNUPS; existing full players may edit through PLAYOFFS, standins may join and
edit through PLAYOFFS, and COMPLETE freezes all season-specific registration
data. New player signups announce to Discord exactly once even when duplicate
first submissions race. The final registration update/create re-reads the
active Season, Draft version, current rank, signup state, and any roster seat
inside a short Serializable transaction; `startDraft` and a late pool write
therefore cannot both commit. A conflict retries once for an idempotent double
submit, then returns reload guidance if the league lifecycle actually moved.
Signups are
**uncapped** — `minTeams` is a floor, and `src/lib/capacity.ts` is
display-only math, never a gate.

**Admin review.** The `/admin` Captains card supports MMR corrections
(`setRegistrationMmr`, never clamped), bulk medal sync (`syncPlayerRanks`,
which flags over-ceiling medals via `medalProvesIneligible` but never
auto-removes), `withdrawSignup`/`reinstateSignup`, and `setMaxMmr`. Review
writes re-check the active season and registration state in Serializable
transactions; they cannot reinsert or alter a full player during a live/paused
auction, and completed-season records are read-only.

**Captains and draft creation.** Captaincy is `Team.captainId` +
`TeamMember.isCaptain` (there is no CAPTAIN registration type). Admin actions
`addCaptain`/`removeCaptain`/`transferCaptaincy`/`randomizeDraftOrder`/
`setDraftSettings`/`setDraftNight` (all `src/app/actions/admin.ts`) configure
the field. `src/lib/draft-setup.ts` is the shared capability policy: setup is
open in SIGNUPS or DRAFT only while the Draft row is missing/NOT_STARTED;
captain handover is allowed after the auction but never live/paused or in a
completed season. Every setup action carries the active-season id rendered by
the form and re-reads the phase, Draft row, registrations, teams, and relevant
orders/roster state inside a Serializable transaction. Handover compare-and-
sets `Team.captainId`, then normalizes the denormalized member flags to exactly
one captain. Designation/handover notify the new captain through Discord when
possible; reschedules invalidate readiness by revision and explicitly ask
players to reconfirm, while schedule clearing is also announced.

`startDraft` claims the Draft row and moves the season to DRAFT in the same
snapshot used to verify unique order, exactly one active PLAYER captain per
team, a nonempty unrostered player pool, and captain-only pre-auction teams. It
then seeds per-team budgets via `mmrWeightedBudgets` (`src/lib/draft.ts` —
linear interpolation across captain MMRs, scaled by the actual gap, floored so
every team can fill a roster). Before Start, `src/lib/draft-budgets.ts` applies
that same projection to the waiting room and public team pages and labels it
projected; after Start, stored remaining `Team.budget` is authoritative.
Draft-time acknowledgement remains advisory, but it is available throughout
the whole setup capability, including DRAFT/NOT_STARTED.

**Live auction draft.** Pure auction math in `src/lib/draft.ts`
(`maxBid` reserve rule, `canNominate`/`canBid`, snake rotation); the
transactional engine in `src/lib/draft-service.ts` (`nominatePlayer`,
`placeBid`, `resolveExpiredNomination`, `resolveStalledNomination`,
`getDraftState`). Every state response is one Serializable snapshot containing
the season id/phase, mutable optimistic version token (`draftVersion`, derived
from `Draft.updatedAt`), lot expectation (`nominatedUserId`), bounded
bids/sales, rosters, budgets, and the
viewer's roster membership. Mutations carry those exact expectations through
the parsers in `src/lib/draft-http.ts`; stale tabs, replayed requests, a
replaced season, or a recovered lot fail closed instead of applying to the new
state.

Clocks (30s bid, 90s nomination — `DEFAULTS` in `src/lib/constants.ts`) are
server-authoritative and resolve **lazily**: `getDraftState` runs both
resolvers before every read, every route
(`/api/draft/tick|bid|nominate|admin-nominate`) funnels through it, and the
authenticated maintenance worker also calls the two resolvers after a cheap
due-clock preflight. A visible site tab discovers activity from the read-only
`GET /api/sync` snapshot on its up-to-300s idle poll, then stays on the 60s
watch cadence while an auction clock remains live; those browser reads refresh
the UI but never advance the clock themselves.
The client is `src/components/draft-room.tsx`, a ~1.2s poll loop whose cadence,
sequence ordering, expiry observation, outbid latch, feed recovery, and title
flags are extracted into tested pure modules (`src/lib/room-poll.ts`,
`room-sequence.ts`, `draft-feed.ts`, `draft.ts`). A lost response is presented
as indeterminate until an authoritative refresh; session expiry, stale season,
initial failure, delayed sync, paused, waiting, completed, and short-roster
completion each have distinct UI states.

The room directly offers `pauseDraft`/`resumeDraft`, `voidCurrentLot` (paused
active lot only), and `undoLastSale` (reverts the newest `price > 0` purchase),
plus a link to `/admin` for typed-confirmation Abort. Abort is one Serializable
pre-season reset: it preserves registrations, teams, authoritative
`Team.captainId` captains, draft settings/night/readiness; removes every other
roster row plus bids and unplayed downstream schedule/fantasy/reminder data;
normalizes retained captain price/flag and refunds every roster price; returns
the season to SIGNUPS; and refuses any started or game-bearing match. Every
admin correction is logged and announced best-effort; sales, completion, and
the recap (`src/lib/draft-recap.ts`) announce to Discord too.

**Team formation and roster moves.** Auction purchases become `TeamMember`
rows with a `price`. Post-draft rosters are maintained by `signFreeAgent`
(adds a registered unrostered player at $0), `releasePlayer` (frees the seat,
refunds the price, cancels unstarted standin cover — three effects in one
transaction), and `promoteStandinToPlayer` (the mid-season refill path,
guarded by `promoteGateError`). Promotion is available in DRAFT before Start
and after auction completion, and during REGULAR_SEASON/PLAYOFFS; it is blocked
during a live/paused auction and after COMPLETE (during SIGNUPS the player can
switch type directly). Signing and release require the auction to be COMPLETE
when the season is in DRAFT, stay available through REGULAR_SEASON and
PLAYOFFS, and are never available in SIGNUPS, a live/unstarted auction, or
COMPLETE. `withdrawTeam`/`reinstateTeam` are REGULAR_SEASON-only rulings: the
former preserves rosters and played history while forfeiting remaining regular
fixtures, and the latter restores eligibility without silently reopening those
forfeits. Every path re-reads lifecycle and row authority in its Serializable
write so it cannot race Start/Abort, phase changes, standin cover, or another
roster command.

**Schedule generation.** `generateSchedule` (`src/app/actions/admin.ts`) runs
the pure circle-method round robin (`roundRobin` in `src/lib/schedule.ts`,
home/away fairness, rotating BYE, optional mirrored second leg) and stamps
kickoffs as pure arithmetic off `Season.firstMatchNight`
(`matchNightForWeek`: week N = first + (N−1)×7d). The rendered active-season
id is a required mutation claim. Active season, lifecycle/Draft, teams,
withdrawal flags, played rows, attached games, and replacement collateral are
read in the same Serializable transaction that deletes/recreates fixtures and
their reminder markers. Generation refuses stale authority, withdrawn teams,
landed results, and fewer than two teams. Replacement counts its dependent
RSVP/prediction/standin/proposal rows, and displaced standins are told after
commit. During SIGNUPS/DRAFT, `src/lib/league-lifecycle.ts` requires a
completed auction before schedule or fantasy work opens;
live/paused/not-started DRAFT remains locked even if a stale/direct action
reaches the server. Later playing phases intentionally tolerate a missing
legacy Draft row. Result imports require REGULAR_SEASON or PLAYOFFS inside
their write transaction, which makes them race safely with Abort.
`DRAFT → REGULAR_SEASON` has **no automatic writer** — the auction finishing
does not advance the phase; the admin uses the positive-policy
`setSeasonPhase` handoff. That control is not a generic state editor: it
permits safe adjacent moves and narrowly proven recovery shapes, while Start/
Abort draft, Start/Return playoffs, and crowning own transitions that also
change dependent data. `/api/calendar` serves every timed active-season fixture
(including completed rows) as an RFC 5545 feed (`src/lib/ics.ts`), with
persisted `Match.createdAt` DTSTAMP values and strict active-team filters.

**The regular-season loop.** Each week:

- _Check-ins_: `MatchAvailability` RSVPs via the shared `<CheckinBanner>`
  (`src/components/checkin-banner.tsx` → `setAvailability` in
  `src/app/actions/availability.ts`). `matchCheckinOpen` requires an active
  post-auction lifecycle, `SCHEDULED`, a real kickoff, and no more than the
  48-hour result-sync tail after kickoff; the action re-reads that gate and the
  standin-adjusted roster inside its Serializable write. Pure aggregation in
  `src/lib/availability.ts` (`matchNightRoster`/`teamAvailability`) shared by
  the dashboard, `/schedule`, and the Discord week reminder. A new OUT pings
  the affected captain (throttled via a Setting claim). Replaced seats cannot
  RSVP; the actual standin can.
- _Standins_: guards in `src/lib/standin-service.ts` (Serializable
  transactions forming a deliberate write-skew triad with the withdraw and
  sign-free-agent paths), the pure same-night conflict rule in
  `src/lib/standin.ts`. Captains self-serve on the match page
  (`src/app/actions/standins.ts`); admins get the any-team override. Assign
  and remove both Discord-mention the standin.
- _Reschedules_: `src/lib/reschedule-service.ts` (one PENDING proposal per
  match; current captain/season/Draft/match authority is re-read; acceptance
  compare-and-sets the kickoff, counts/wipes RSVPs, and releases exact reminder
  clusters in one Serializable transaction), thin actions in
  `src/app/actions/reschedule.ts`. Decline/withdraw remain cleanup-safe after a
  later phase lock. Admin `setWeekNight` uses the modal canonical kickoff for
  cascade delta; `setWeekNight` and `setMatchTime` only retime `SCHEDULED`
  rows, preserve no-ops, and atomically clear affected RSVPs, pending proposals,
  auto-sync claims, and reminder clusters.
- _Week reminder_: `src/lib/reminder-service.ts`, invoked by the authenticated
  maintenance pass, mentions exactly the players who haven't RSVP'd. Each
  exact `(season, week, kickoff)` cluster has its own claim, so a split week can
  announce both nights; exact-or-colon-delimited cleanup prevents week 1 from
  colliding with week 10.
- _Result import_: the single write funnel is `importGameForMatch`
  (`src/lib/match-import.ts`) — OpenDota fetch (`src/lib/dota.ts`), pure
  `classifyGame` roster classification, then one Serializable command that
  rechecks active season/phase/captain authority and writes the `Game`, the
  pure `deriveSeriesProjection` result onto `Match`, auto-sync backoff reset,
  and the `resultChangedAt` freshness cursor. Entry points: captain self-serve
  (`src/lib/match-report-service.ts` → `src/app/actions/match-report.ts`),
  admin import/auto-detect/`recordResult`/`removeGame`/`reopenMatch`, the
  Valve league feed (`syncLeagueGames` when `Season.dotaLeagueId` is set), and
  the automatic sync below. `Game` rows are authoritative; admin played scores
  cannot overwrite them, while an explicit ruling may add but cannot erase
  imported wins. Discord, playoff advancement, and weekly honors run as
  idempotent post-commit effects; the heartbeat retries bracket advancement.
  All result writes are locked outside their matching active league phase.
- _Automatic sync_: see §7. Results flow in with no button press.
- _Standings and stats_: everything is derived at read time.
  `computeStandings` (`src/lib/standings.ts`, 3/1/0 points, tiebreak chain
  ending in head-to-head mini-tables) is the public table. The shared
  `projectPlayoffField` projection computes that complete table first and only
  then removes withdrawn teams from eligibility, preserving every survivor's
  played/ruled results while producing the cut, one-indexed seed map, and
  first-round pairings used by every page and the write service. The playoff
  scenario engine (`src/lib/scenarios.ts` + `src/lib/stakes.ts`) enumerates
  equal-weight result combinations for clinch and “win and in” guidance; the
  UI explicitly does not present those combinations as predictive odds. The
  engagement layer (§ fantasy/pick'em/leaders/meta/records) uses the shared 60s
  `"games"`-tagged scans in `src/lib/cached-queries.ts`. All aggregate consumers
  pass `Game.players` through `decodeGamePlayers` and
  `trustedGamePlayers`: only a complete ten-line, five-per-side box with unique
  heroes and no duplicate among supplied account/user ids enters public totals.
  Detail/repair surfaces may inspect
  individually valid lines, but partial evidence never becomes a leaderboard,
  record, Fantasy score, award, profile career, or scouting result. Server
  Actions invalidate with `updateTag` for immediate read-after-write; Route
  Handlers use `revalidateTag(..., { expire: 0 })`.
- _Fantasy_: `/fantasy` opens when `postAuctionWorkOpen` confirms the auction
  is complete, including the DRAFT handoff before an administrator advances
  the season. Any signed-in community member can save five drafted players
  under the computed MMR cap. `fantasyPrices` replaces a missing rating with
  the rounded known-pool average; a wholly unrated pool is explicitly
  uncapped. Exact competing fives and ownership stay private while entry is
  open. The first imported `Game` stamps `Season.fantasyLockedAt` in the same
  Serializable transaction; correction preserves or backfills that one-way
  information lock, while a true pre-result Draft Abort clears it with the
  discarded fantasy rosters. The action carries `expectedSeasonId`, rechecks
  lifecycle, lock, roster membership, prices, and picks in its write
  transaction, then takes PostgreSQL shared Season/Draft locks. Managers can
  save concurrently, while import, phase, and archive writers remain
  exclusive; transient serialization conflicts retry from a fresh snapshot.
  COMPLETE and `?season=` archive views show read-only standings and roster
  breakdowns.
- _Pick'em_: `/pickem` uses the same post-auction lifecycle boundary. Each
  prediction locks at scheduled kickoff or as soon as the fixture is LIVE or
  COMPLETED. `savePrediction` re-reads the active Season, optional Draft,
  matchup, eligible sides, status, and deadline in the Serializable command
  that performs the upsert. Shared PostgreSQL Season/Draft/Match locks keep a
  deadline rush concurrent while excluding phase, archive, reschedule, and
  result writers; SQLite uses guarded no-op claims and both providers retry
  transient conflicts. The page exhaustively partitions open, locked, graded,
  and void fixtures, orders open groups by the next real deadline, hides the
  community split before lock, and preserves the viewer's locked or void pick.
  A deadline refresh moves the whole card into its authoritative locked state.
  COMPLETE and archive views are structurally read-only.

**Playoffs.** `startPlayoffs` calls `createPlayoffBracket`
(`src/lib/playoff-service.ts`). The rendered Start, Reset, and Return-to-regular
controls carry an explicit intent, expected phase, and content-addressed
`playoffSetupRevision` over every season/team/match/game input that can alter
seeding or teardown, including postseason availability, cover, prediction, and
reschedule rows that a Match cascade would delete. The Serializable command
recomputes that revision and the canonical `projectPlayoffField` before
writing, so a replayed form or a late result, withdrawal, import, phase/config
change, participant action, or prior bracket change is refused rather than
silently deleting or replacing newer state. Start and Reset share
`removePostseason`, which merge-archives deleted Dota ids, releases
round/result/champion/reminder markers, returns standin stand-down receipts,
then seeds the projected field into `R{round}M{match}` slots and advances the
freshness cursor. The after-snapshot/before-delete seam has a real-Postgres
race proof: a late child write either fails or survives an aborted teardown;
it is never silently cascade-deleted. `returnToRegularSeason` is the only
supported backward path once a bracket exists; it runs the same teardown and
clears the champion in the same transaction as
`PLAYOFFS|COMPLETE → REGULAR_SEASON`, then attempts the bracket-void and
stand-down notices. Failed sends are surfaced to the administrator for manual
follow-up, but are not durably retried.

`advancePlayoffBracket` runs after every playoff result and on every result-sync
heartbeat. It builds the next round behind an atomic `playoffRoundBuilt:`
Setting claim and rereads the source winners plus current playoff/final series
lengths and first-match night inside the transaction. Crowning rereads the
exact sole latest completed final and its still-valid winner in the same
Serializable snapshot as the guarded `PLAYOFFS → COMPLETE` write, clears no
history, and advances `resultChangedAt`; only the claim winner sends
`championMessage`. Reconciliation reports a committed round/crown as an
`updated` sync response. The root layout supplies `<ResultSyncPing>` with the
cursor captured during that server render, so both the winning request and a
losing first heartbeat detect any post-render change. Generic phase controls
cannot manufacture Complete, enter Playoffs without a seeded bracket, or
retract a crowned/bracket-backed season.

**Champion → archive → Hall of Fame.** `COMPLETE` is derived only from a
decided authoritative grand final. `resolveChampionPresentation`
(`src/lib/champion-presentation.ts`) is the shared public boundary: when saved
postseason rows exist it requires one latest completed FINAL whose participant
and winner match the stored id; champion-only legacy archives remain trusted.
Dashboard, schedule, teams, match detail, recap, archive, player careers, Hall
of Fame, feature metrics, bracket trophies, and Discord champion sends all use
that proof. A hand-entered final can be reopened and an imported final game can
be removed through dedicated correction commands even when the stored title
incorrectly names the losing finalist: both atomically clear the
champion/announcement marker, return to PLAYOFFS, preserve earlier rounds, and
recrown if the recomputed series is still decided. Earlier rounds are locked by
the shared `hasLaterBracketRound` rule. `/recap` keeps the champion, bracket,
and completed series even when there are zero imported Dota games; only
player-stat awards become unavailable. `/seasons` and `/seasons/[id]` recompute
archived standings and brackets from stored rows; `/hall-of-fame` rolls up
cross-season careers (`src/lib/hall-of-fame.ts`, career fantasy points,
all-time oracle). `/seasons` also hosts a non-restorable JSON audit archive
(`/api/admin/season-export`) and `deleteSeason` behind the strongest confirm
tier plus a recent full-database backup receipt in production.

**Completion, archive, and offseason.** Offseason is represented by **zero**
active Season rows; archived seasons retain their exact phase and data. A
normal handoff first passes `completedSeasonArchiveReadiness`
(`src/lib/season.ts`): COMPLETE, an authoritative same-season champion, and a
stored final that agrees whenever postseason rows exist. From there an admin
can either `archiveCompletedSeason` and deliberately stop in offseason, or
`createSeason` can close that same completed season and open the next SIGNUPS
season in one Serializable transaction. `createSeason` cannot conceal an
unfinished league cancellation.

`archiveIncompleteSeasonAction` (`src/app/actions/admin.ts`) is the separate,
explicit and reversible cancellation path. It deactivates the claimed
unfinished Season without deleting or changing its phase; in the same
transaction it parks an IN_PROGRESS/PAUSED auction, clears only its clocks,
and preserves its lot, bids, turn, budgets, and rosters. Deadline resolvers and
playoff advancement independently require an active season, so stale pollers
cannot sell a lot, build a round, or crown a champion after cancellation.

Opening a season from offseason is either `createSeason` with no active id or
the offseason-only `reactivateSeason` (`src/lib/season.ts`). Reactivation
compare-and-sets the archived target's rendered `updatedAt`, restores its exact
phase, and parks legacy live auction clocks before activation; it never
silently archives a different active season. Every season-settings form also
claims the rendered active id and revision. These lifecycle commands run at
Serializable isolation because "at most one active season" has no database
constraint. `resultChangedAt` invalidates dependent reads after each committed
transition. When the next season opens, `/me` prefills signup from the player's
most recent prior registration ("Welcome back" hint).

The public dashboard, Players, and Teams have dedicated no-active-season
states with links into history rather than dead ends. `/seasons` keeps export,
reactivation, and permanent deletion separate: audit-archive format v2 captures
a transaction-consistent, relation-closed JSON snapshot with a SHA-256 digest
and explicit `restorable: false` warning. It has no importer and is not a
database backup. Delete requires the exact season name and rendered revision;
in production it also requires a signed, same-database full-backup receipt less
than 24 hours old. It removes the season's relationless operational Settings as
well as relational data.

## 3. The inhouse lifecycle

State machine on `InhouseLobby.status`: `READY_CHECK → CAPTAIN_VOTE →
DRAFTING → READY → IN_PROGRESS → COMPLETED | CANCELLED`, one active lobby at a
time. Pure rules in `src/lib/inhouse.ts`, the engine in
`src/lib/inhouse-service.ts` (queue, all phases, results, admin recovery, and
the viewer payload builder `getInhouseState`), the client in
`src/components/inhouse-room.tsx`, one dispatch endpoint `POST /api/inhouse`.
The mode remains available through signup, draft, season play, playoffs,
completion, and the real no-active-season offseason.

1. **Queue** — `joinQueue` (MMR trust chain: league registration > clamped
   typed value > last lobby snapshot) into the userId-unique
   `InhouseQueueEntry`. Presence is heartbeat-based (`lastSeenAt`, refreshed
   by the player's own polls); stale entries dim to "away" and are pruned.
   Outsiders may queue for the next game while a lobby is active. A queue
   crossing 4 present players fires a throttled Discord ping.
2. **Formation** — `maybeFormLobby` (Serializable; the one-active-lobby
   invariant lives here) takes 10 present players in exact
   `[joinedAt, userId]` order, snapshots `joinedAt` as each player's immutable
   `queuedAt` plus their W/L record, and Discord-mentions all ten by
   `<@discordId>`. The state payload uses the same total queue order.
3. **Ready check** — 45s; all ten must `acceptMatch` (claim guarded on both
   `acceptedAt: null` and the lobby still being in READY_CHECK). Decline or
   expiry fails the check. A decline drops the decliner, keeps accepters at the
   front, and backdates still-pending players so they must reconfirm; expiry
   keeps accepters and drops no-shows. Requeued players sort by
   `[queuedAt, userId]` and restore that exact timestamp to queue `joinedAt`, so
   overflow players cannot steal their promised positions.
4. **Captain vote** — 25s; the ten vote how captains are chosen
   (`VOTE`/`MMR`/`RECORD`, tallied by pure `tallyMethod`/`orderCaptains` —
   the same functions the room uses for its previews). Ballots atomically
   reassert both phase and `voteEndsAt > now`; tied rankings use the real
   snapshotted queue order.
5. **Snake draft** — 60s per pick, order `F O O F F O O F` via `nextPickTeam`;
   `applyPick` is the most heavily guarded transition in the repo (turn claim,
   player claim, advance claim, `PickRaceError` thrown past the first write).
   Captains act normally; timed auto-pick and the displayed pool both rank MMR
   descending, then exact `[queuedAt, userId]`. An admin has an explicitly
   labelled recovery pick without receiving captain-only title/chime attention.
6. **Betting window** — the `DRAFTING → READY` transition stamps
   `betsCloseAt` (+45s) via one shared `readyTransitionData` at both write
   sites. Players bet Cred **only on their own team, once, immutably**
   (`src/lib/inhouse-bets.ts` pure matched-pool math,
   `src/lib/inhouse-bet-service.ts` for every money write). Pressing Start
   never closes the window.
7. **Game setup** — READY/IN_PROGRESS render lobby name/password derived
   client-side from the lobby id (`inhouseLobbyCode`) plus team voice
   channels.
8. **Result detection and publication** — OpenDota only, no manual winner:
   background scan
   (`maybeAutoDetectResult`), the detect button, or a pasted match id all
   converge on `buildResult` (league `classifyGame` reuse; emits `teamFixes`
   when players sat on the opposite side they were drafted to — the played game
   is the truth). `applyResult` first commits the guarded
   `IN_PROGRESS → COMPLETED` claim plus side fixes and immutable `completedAt`,
   tries the canonical bet settlement, computes full-history Elo, then claims
   that exact completed match again to store `eloDeltas` and the exact durable
   RESULT payload in one transaction. A leased outbox worker sends only after
   commit and outside every transaction. A racing void cancels the RESULT only
   while it is still PENDING; if it is already SENDING or SENT, the durable
   sequence-2 correction waits behind or follows it. `updatedAt` is not result
   chronology; it remains mutable operational state.
9. **Corrections and settlement** — every successful admin cancel is audited;
   every successful void is audited and posts a correction even with no bets.
   Cancel and void contain no bespoke money math, but each explicitly invokes
   the same single-winner `resolveUnsettledBets` with its own lobby id before
   returning. That targeted call prevents an older stranded pot from consuming
   the action's immediate consistency attempt. Global state reads select up to
   25 eligible rows oldest-first by `[updatedAt, id]`; each row is isolated so
   later rows still run after a failure, and a failed row is best-effort touched
   to rotate it behind the backlog. `completedAt` remains immutable throughout.
   A bettor sees an explicit pending settlement instead of a silently missing
   Cred delta.
10. **Ladders and history** — Elo is derive-don't-store
    (`summarizeInhouse`, K=32, recomputed from all COMPLETED lobbies on ladder
    and stat reads); the live room reads the stored per-game delta. `/inhouse`
    shows Elo plus the zero-sum Cred-profit ladder. `/inhouse/history` includes
    every completed lobby, 100 per page, displays
    `matchStartTime ?? startedAt ?? createdAt`, and gives admins an exact-row
    void. Cancelled/voided lobbies are excluded. The shared site/Discord
    proof-of-life loader chooses the newest formed completed lobby by
    `[createdAt desc, id desc]` and reports played start plus duration, falling
    back to `completedAt`; it never uses settlement cursor `updatedAt`.
11. **The board** — a single pinned, self-editing Discord message
    (`src/lib/inhouse-board.ts` render / `inhouse-board-service.ts` service)
    showing the live queue; digest-gated so a motionless queue costs zero
    Discord requests. A pre-POST compare-and-swap reservation prevents duplicate
    boards. Its 30s lease distinguishes an active post from an interrupted,
    possibly orphaned one; stale reservations are never auto-reposted and get
    an explicit admin clear/review path. A null POST response or response with
    no usable message id immediately converts the retained reservation to the
    stuck state, blocking every repost until an admin checks Discord and clears
    it. Repainted from both resolver chains.

Lazy resolution mirrors the draft. A state read runs heartbeat → abandoned-
lobby sweep → bet sweep → formation → ready check → captain vote → stalled
pick → auto-detect → board repaint; the tenth join also attempts formation
synchronously. The authenticated maintenance worker runs the equivalent chain
sitewide so an unwatched lobby still resolves. Inhouse result and void Discord messages use the durable
`InhouseAnnouncement` outbox: the exact payload commits with the state change,
then a leased/tokened worker sends outside the transaction and retries with
backoff even when the room is idle. The webhook API has no idempotency key, so
delivery is at-least-once across a crash after Discord accepts a message but
before `sentAt` commits. Routine queue/cancel notifications remain best-effort.

## 4. Architecture: the layering rules

**Five layers, with naming conventions that tell you where you are:**

| Layer                       | Convention                                                                                                                                                   | Examples                                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Pure logic (no DB, no IO)   | `src/lib/<name>.ts` + sibling `<name>.test.ts`                                                                                                               | `draft.ts`, `standings.ts`, `schedule.ts`, `inhouse.ts`, `inhouse-bets.ts`, `rank.ts`, `scenarios.ts`                                   |
| DB services (transactional) | `src/lib/<name>-service.ts`, covered by `test/integration/*.itest.ts`                                                                                        | `draft-service.ts`, `inhouse-service.ts`, `playoff-service.ts`, `standin-service.ts`, `reschedule-service.ts`, `result-sync-service.ts` |
| Thin mutations              | `src/app/actions/*.ts` (server actions: auth + parse + delegate + toast + Discord send + revalidate) and `src/app/api/*` route handlers for the polled rooms | `actions/admin.ts`, `actions/registration.ts`, `api/draft/*`, `api/inhouse`                                                             |
| Server pages                | `src/app/**/page.tsx` — query Prisma directly (no read API), run pure libs, serialize plain props                                                            | `page.tsx` (dashboard), `schedule/page.tsx`                                                                                             |
| Client leaves               | `src/components/*.tsx` `"use client"` — polling rooms, forms, clocks, toasts                                                                                 | `draft-room.tsx`, `inhouse-room.tsx`, `action-form.tsx`, `local-time.tsx`                                                               |

Rules that follow from the layering:

- **Prefer adding logic to a pure lib with a test beside it.** Services should
  be thin transactions over pure decisions; the room components have had every
  behavioral rule extracted into pure modules precisely because there is no
  jsdom (`vitest.config.mts` is `environment: "node"`).
- **One authenticated worker, public observation only.** `getDraftState` and
  `getInhouseState` retain guarded resolvers so a fleet-throttled authenticated
  room poll can respond immediately without multiplying writes or provider
  calls across every tab. Anonymous room snapshots never run them. Sitewide
  work is different: a one-minute scheduler calls
  `GET /api/cron/automation` with `Authorization: Bearer <CRON_SECRET>`.
  `runAutomation` elects one runner across all instances with a tokened,
  database-global 90-second lease, fences finalization with the same token,
  and gives `runResultSync` a 45-second deadline/abort budget. The persisted
  `AutomationRunState` records safe status, cadence, duration, source, failure
  streak, and bounded machine-code summary. Browser `<ResultSyncPing>` calls
  **read-only GET** `/api/sync` to learn `watch` and the result cursor; there is
  no POST handler and no page-render notification component. Thus visitors can
  refresh after committed changes without importing results, advancing a
  phase, calling OpenDota/Discord, or multiplying worker executions.
- **Concurrency doctrine** (two sentences; the full treatment with worked
  examples is CLAUDE.md's "Concurrency: the two rules"): a read-time
  precondition is not a guard — re-assert it in the WHERE of the write
  (`updateMany` claims, Serializable transactions for cross-table write-skew
  pairs); and past the first write, failure must THROW a typed error caught
  _outside_ the transaction callback, never return. SQLite serializes writers
  and hides every violation; only `npm run test:pg` and the mutation ratchet
  exercise these guards for real.
- **Derive, don't store.** Standings, scenarios, leaders, records, meta,
  power rankings, Elo, awards, MVPs are all recomputed from `Game`/lobby rows
  at read time (through `src/lib/cached-queries.ts` for the whole-table
  scans — `unstable_cache`, 60s TTL, tag `"games"`, busted by every import
  path). Deliberate exceptions, each with a stated reason:
  `InhouseLobby.eloDeltas`/`betDeltas` (stamped once at completion so the
  1.5s poll path never scans history), immutable `InhouseLobby.completedAt`
  (stable result recency while retryable work mutates `updatedAt`),
  `InhouseLobbyPlayer.wins/losses/games` plus `queuedAt` (record/queue snapshots
  frozen at formation), and
  `InhouseCredit.balance` (a
  mutable column because the affordability check must be re-assertable in the
  WHERE of the debit — `InhouseCreditEntry` is the provenance ledger). The
  ledger has one deliberate non-append exception: reversing a voided game's
  FLOOR top-up deletes that FLOOR receipt so its once-per-UTC-day key is
  released and the admin's correction does not consume the player's safety net.
- **Feedback contract.** Mutations return `ActionResult`
  (`src/lib/action-result.ts`), rendered through `<ActionForm>` /
  `<SubmitButton>` (`src/components/action-form.tsx`) into the global
  `<Toaster>`. The live rooms bypass forms but reuse `pushToast`.
- **Personal-data visibility.** `src/lib/visibility.ts` is the shared read
  policy: league contact details are visible only to the subject, an admin, or
  a current active participant; named RSVP lists are for the two captains and
  admins (each player still sees their own response); aggregate readiness is
  for active participants and admins. Public pages blank these DTO fields and
  skip the underlying contact/availability queries for outsiders.
- **Privacy publication boundary.** `/privacy` and `/terms` are public server
  pages linked from the login, profile, and footer surfaces. They do not query
  the database: `src/lib/privacy-contact.mjs` normalizes the server-only
  `PRIVACY_CONTACT_EMAIL` and `PRIVACY_DATA_LOCATIONS` values that they publish.
  A non-production build with either value absent renders an explicit setup
  notice; the production environment gate refuses the build. The locations
  value is operator attestation, not application discovery: it must cover the
  verified hosting, database, backup, and application-log storage countries. The notice
  describes the split between intentionally public competition history and the
  restricted contact/availability policy above, and exposes a reviewed manual
  access/correction/deletion-request path without promising that shared match
  history, Discord messages, or backup snapshots can be erased in place.
- **Accessibility baseline.** The UI kit supplies labeled progress, visible
  field focus, opaque high-contrast error/brand surfaces, and non-blocking
  avatar loading. `globals.css` has a catch-all reduced-motion rule for
  animation and transition duration in addition to component-specific motion
  alternatives, so a newly added spinner/pulse does not silently bypass the
  user preference.
- **HTTP security boundary.** `next.config.ts` applies `DENY` framing,
  `nosniff`, strict-origin referrers, HSTS, a restrictive Permissions Policy,
  and the hydration-safe CSP baseline `base-uri 'self'; form-action 'self';
  frame-ancestors 'none'; object-src 'none'` to every response. Script/style
  CSP directives are deliberately not claimed: Next hydration still uses
  inline assets and there is not yet a nonce pipeline.

## 5. Page inventory

27 pages. "Nav from X" = the link appears from that phase onward
(`src/components/site-header.tsx`); most pages still render if visited
directly.

| Route              | Purpose                                                                                        | Gating                                                                                             | Notable data sources                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `/`                | Phase/offseason-aware dashboard (five league phases plus offseason)                            | Always                                                                                             | `getSeasonSnapshot`, `computeStandings`, `scenarioReport`, `focusSlate`, cached leaders scan                  |
| `/login`           | Steam login + dev quick-login, return-path/error/logout feedback                               | Signed out; available in every phase                                                               | —                                                                                                             |
| `/me`              | Profile: signup, Steam-derived Dota metadata refresh, Discord linking, withdraw, prefill       | Signed in; identity controls available in every phase, signup interaction follows season phase     | Registration, prior-season prefill, live Discord membership, rank/medal hint (independent reads parallelized) |
| `/players`         | Signup pool (URL-mirrored filters) + rosters                                                   | Always                                                                                             | 4 inline queries → client `PlayerPool`                                                                        |
| `/players/[id]`    | Player profile: career stats, report card, achievements, seasons, inhouse card                 | Always                                                                                             | Cached `getAllGameLines` two-pass scan                                                                        |
| `/players/compare` | GET-form two-player career comparison with invalid/missing/same-player states                  | Always                                                                                             | Trusted `getAllGameScores`, `meetings`; metadata uses the same career eligibility                             |
| `/teams`           | Teams index + power rankings + draft recap                                                     | Nav from DRAFT                                                                                     | Standings order post-results; `powerRankings`                                                                 |
| `/teams/[id]`      | Team detail: scenario card, roster, hero pool, H2H                                             | Always (archived works)                                                                            | `seasonScenarioReport`, cached season scan                                                                    |
| `/draft`           | Live auction room                                                                              | Gates only on "no active season"                                                                   | Polls `/api/draft/tick`                                                                                       |
| `/schedule`        | Standings, weeks, bracket, season grid, playoff picture                                        | Nav from DRAFT; phase-specific published/locked/read-only states                                   | `computeStandings`, `crossTable`, `buildBracketRounds`, `matchCheckinOpen`                                    |
| `/matches/[id]`    | Box scores or pre-match preview (scouting, stakes, RSVP, standins, reschedule, captain report) | Always                                                                                             | Game JSON, `scouting.ts`, `matchStakes`                                                                       |
| `/leaders`         | 8 stat boards + report-card board + evidence-gated weekly honors                               | Nav from REGULAR_SEASON; direct/archive reads always work                                          | Trusted `getSeasonGameLeaders`, `topBy`, `getSeasonHonorReadiness`                                            |
| `/meta`            | Trusted hero meta report with known-pool coverage and signature owners                         | Nav from REGULAR_SEASON; direct/archive reads always work                                          | `getSeasonGameScores`, `heroMeta`, bundled hero catalogue                                                     |
| `/fantasy`         | Fantasy-five picker, final fives, scoring, and standings                                       | Nav from DRAFT; interaction after completed auction until first import; COMPLETE/archive read-only | `fantasyPrices`, `fantasyPoints`, durable `Season.fantasyLockedAt`                                            |
| `/pickem`          | Match predictions, locked/void-pick review, and oracle board                                   | Nav from DRAFT; interaction after completed auction until each kickoff; COMPLETE/archive read-only | `partitionPickemMatches`, `predictionOpen`, `pickemStandings`                                                 |
| `/records`         | All-time trusted single-game record book with first-achiever tie policy                        | Evergreen: Statistics nav, Explore, footer                                                         | `getAllGamesForRecords` (deterministic chronology), `leagueRecords`                                           |
| `/hall-of-fame`    | Cross-season career boards                                                                     | Footer link                                                                                        | `careerCounts`, all-seasons scans                                                                             |
| `/recap`           | Season awards page                                                                             | Nav on COMPLETE; `?season=`                                                                        | `computeSeasonAwards`                                                                                         |
| `/seasons`         | Season history + audit archive/delete; offseason-only reactivation                              | Nav once an archive exists; reactivation disabled while a season is active                         | —                                                                                                             |
| `/seasons/[id]`    | Season archive: standings, bracket, rosters                                                    | Same                                                                                               | Recomputed from archived rows                                                                                 |
| `/inhouse`         | Inhouse room + scene stats + Elo/Cred ladder + results                                         | Always (season-independent)                                                                        | Polls `/api/inhouse`; `summarizeInhouse`, `credProfitBoard`                                                   |
| `/inhouse/history` | Complete completed-lobby archive, 100 rows per `?page=N`, exact-row admin void                 | Always                                                                                             | Stable formation ordering; authoritative played-time fallback                                                 |
| `/news`            | Pinned-first administrator announcement archive with deep links/media fallback                 | Evergreen: Explore, mobile menu, footer                                                            | `NewsPost`; create request receipts; `NewsMedia`                                                              |
| `/features`        | Phase-aware feature tour with honest live/locked destinations                                  | Always                                                                                             | `featureAvailability`, live counts, viewer-aware closing CTA                                                  |
| `/privacy`         | Public data map, visibility/retention choices, processors, locations, and request contact      | Always; intentionally public and linked from login/profile/footer                                  | Server-only `PRIVACY_CONTACT_EMAIL` + `PRIVACY_DATA_LOCATIONS`; no DB read                                    |
| `/terms`           | Participation, public-record, conduct, external-service, and play-money terms                   | Always; intentionally public and linked from login/profile/footer                                  | Server-only `PRIVACY_CONTACT_EMAIL`; no DB read                                                               |
| `/admin`           | The control panel (§8)                                                                         | Admin only                                                                                         | `loadSeasonAdminData`                                                                                         |

API routes (19): `/api/auth/steam` + `/callback`, `/api/auth/discord` +
`/callback`, `/api/auth/dev`, `/api/auth/logout` — auth (§2);
`/api/draft/tick|bid|nominate|admin-nominate` — the auction. Every draft POST
requires an `application/json` media type and canonical same-origin `Origin`;
tick takes a 1,200/min/IP preflight before session or database work, then a
signed-in user also takes a 300/min/user allowance. Bid, nominate, and
admin-nominate share one 120/min-per-user mutation bucket;
`/api/inhouse` — single POST dispatch (`{action: state|join|leave|accept|
decline|vote|pick|start|detect|record|bet|cancel|void}`); valid JSON object and
explicit action required. Every call requires the JSON media type. Public state
reads remain origin-independent and allow 1,200/min/IP; every mutation requires
canonical same-origin proof and allows 300/min/signed-in user (signed-out
attempts fall back to IP);
`/api/sync` — public, read-only GET snapshot for `<ResultSyncPing>` (`watch` +
result cursor; no POST/mutation path); `/api/cron/automation` — the
`CRON_SECRET` bearer-authenticated one-minute worker route (Node runtime,
60-second route ceiling); `/api/health/live` — dependency-free process
liveness; `/api/health/ready` — database readiness (`SELECT 1`, 503 on
failure); `/api/health/automation` — public, read-only dead-man probe with only
a bounded status enum (200 for fresh clean success, 503 otherwise);
`/api/calendar` — the .ics feed;
`/api/admin/season-export` — the non-restorable season JSON audit archive. It
serializes one complete snapshot, measures the result in UTF-8 bytes, and
returns an admin-only 413 with backup/out-of-band-export guidance above the
4,000,000-byte hosted-response ceiling instead of letting the platform fail an
oversized response; `/api/test/cache` — fixture-only cache expiry, gated behind non-production + dev login + an
e2e/fixture database URL and otherwise 404. Rate limiting
(`src/lib/rate-limit.ts`) is an in-memory per-instance speed bump, not a
distributed limit; production therefore requires reviewed pre-function edge
rules and direct Vercel ingress (or an explicitly trusted upstream proxy).
`x-vercel-forwarded-for` wins over spoofable fallback headers and an invalid
provider-owned value collapses into the shared `unknown` bucket.
Attacker-controlled key growth is bounded to 5,000 live
buckets with expiry pruning and oldest-window eviction. App-level files:
`layout.tsx` (session + season + nav
gating fetched per request), `error/global-error/loading/not-found.tsx`, `sitemap.ts`,
`robots.ts`, `manifest.ts`.

All five JSON mutation routes stream at most 8,192 UTF-8 bytes, reject a lying
or absent `Content-Length` by the measured body, require one JSON object, and
fail before authentication/database work on malformed input. Scalar-only
Server Actions have a 64 KB raw multipart ceiling; the app has no file upload.
`/api/sync` and
calendar are viewer-independent and use short Vercel-only microcaches while
browsers must revalidate; room state remains personalized and `no-store`.

## 6. Database models

27 models in `prisma/schema.prisma`, committed on the sqlite provider
(`scripts/switch-db-provider.mjs` swaps to postgresql at build). SQLite has no
enums, so every status column is a string whose allowed values live in
`src/lib/constants.ts`. Uniques double as concurrency guards throughout.

**Identity & content**

- `User` — Steam-keyed identity (steamId @unique); role, rank medal
  (`rankTier`), `fhUnavailable` (public-match-data flag), Discord link
  (`discordId` @unique = the OAuth-proof collision guard, `discordName` the
  unverified fallback), and OpenDota scouting snapshot. Steam OpenID is the
  Dota-account ownership proof: normal identity is derived from `steamId`, new
  arbitrary manual overrides are refused, and verified-owner login retires a
  conflicting legacy override. During the rollback window the old physical
  signed-`Int` column is exposed as `legacyDotaAccountId`, while current writes
  use `dotaAccountIdV2 Float?`; all readers prefer v2, then legacy, then the
  Steam-derived identity. Dota metadata writes compare-and-set both stored
  columns, so a relink or rollback-column cleanup drops stale in-flight
  responses. The v2 `Float` is deliberate: JavaScript/PostgreSQL double
  precision represents every positive unsigned 32-bit account id exactly,
  while Prisma's signed 32-bit `Int` cannot represent the full Dota range.
- `NewsPost` — admin announcements; author `SetNull` so posts outlive users.
  Creation request UUIDs are durable `Setting` receipts, making browser replay
  idempotent across the post and audit log. League Discord delivery persists in
  `LeagueAnnouncement`; a temporary transport failure cannot discard it.

**Season core**

- `Season` — the root aggregate and state machine; `isActive` marks "the"
  season, while zero active rows means offseason. Serializable lifecycle
  commands provide coherent handoffs and the PostgreSQL-native partial unique
  `Season_one_active_idx` is the final storage barrier against two active rows.
  Reads still fetch at most two rows and `singleActiveSeason` fails closed for
  pre-migration or manually corrupted data rather than silently choosing one;
  carries `draftBudget`, `budgetMmrWeight`, `maxMmr` (soft), series lengths,
  `firstMatchNight`, `draftAt`, `dotaLeagueId`, `championTeamId`, and the
  one-way `fantasyLockedAt` competitive-information marker.
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

- `FantasyRoster`/`FantasyPick` — one manager roster per season and one row per
  selected player: `@@unique([seasonId, userId])` / `[rosterId, userId]`.
  Rosters survive archival and are removed only with the season or a safe
  pre-result Draft Abort.
- `Prediction` — one pick'em selection per user and fixture,
  `@@unique([matchId, userId])`; rows follow Match archival/deletion.

**Inhouse**

- `InhouseQueueEntry` — userId-unique rolling queue with `lastSeenAt`
  presence heartbeat.
- `InhouseLobby` — the game + state machine + result columns (`boxScore`
  JSON, `winnerTeam`, `eloDeltas`, `betDeltas`, `betsCloseAt`,
  `matchStartTime`, immutable result clock `completedAt`, `betSettlement` —
  indexed, the bet sweeper's probe). Its mutable `updatedAt` orders oldest-first
  settlement retries and is never result chronology.
- `InhouseLobbyPlayer` — `@@unique([lobbyId, userId])`; team, captaincy,
  pick order, MMR + record + exact original `queuedAt` snapshot, vote,
  ready-check `acceptedAt`.
- `InhouseAnnouncement` — durable RESULT/RESULT_VOIDED Discord outbox;
  `@@unique([lobbyId, kind])` deduplicates events, sequence preserves
  result-before-correction order, and a 30-second claim lease makes failed or
  interrupted sends retryable without holding a database transaction open.
- `InhouseBet` — `@@unique([lobbyId, userId])` **is** the double-spend guard;
  team frozen at placement for lineup-void grading.
- `InhouseCredit` — the mutable balance column (deliberate exception, §4).
- `InhouseCreditEntry` — provenance ledger; `@@unique([reason, refId])` is the
  idempotence key (wager legs, the once-per-day floor, the one-time grant).
  Result reversal preserves wager history with REVERSAL rows but deletes that
  lobby's FLOOR receipt to release the daily key. **No FK on purpose.**

**Infrastructure**

- `AutomationRunState` — singleton operational record for the unattended
  worker. `leaseToken` + `leaseOwner` + `leaseExpiresAt` form the 90-second
  database-global election/fencing boundary. Attempts, starts, finishes,
  success/failure timestamps, source, duration, failure streak, safe error
  code, and a bounded non-identifying summary drive operator health without
  exposing the token or secret.
- `LeagueAnnouncement` — globally ordered durable league-channel outbox. A
  nullable unique `dedupeKey` binds marker-backed events to one row; ordinary
  events remain distinct. PENDING/SENDING/SENT/CANCELLED state, a tokened
  30-second delivery claim, bounded drain, and exponential backoff keep work
  recoverable. Earlier non-terminal rows block later rows so related messages
  cannot intentionally overtake one another. Discord has no idempotency key,
  so a crash after webhook acceptance but before `SENT` commits retains the
  unavoidable at-least-once duplicate gap.
- `AdminAction` — append-only audit log; deliberately no FKs (records outlive
  what they describe; every table wipe must name it explicitly). Coverage
  includes phase/draft/playoff recovery, session revocation, league and Discord
  settings, registration moderation, captain/roster/team changes, schedule
  retiming, result rulings, and manual import/detection. Routine automatic
  sync and maintenance work is intentionally not represented as exhaustive
  human-operator history.
- `Setting` — a two-column key/value table serving **five distinct
  patterns**: (1) plain config via `getSetting`/`setSetting`
  (`src/lib/settings.ts`; empty value _deletes_ the row) — the three Discord
  webhooks, ping role id, `sessionEpoch`; (2) atomic global throttles via
  `claimThrottle` (conditional `updateMany` on an ISO-string value, then
  create-with-P2002-catch) — `leagueAutoSyncAt`, `rosterAutoSyncAt`,
  `announceRetryAt`, `inhouseBoardAt`, `outPing:<matchId>:<userId>`;
  (3) once-only domain markers — series, champion, and reminder markers use
  tokened 90-second `claim:v2:` leases and preserve an event generation across
  stale/failed recovery; that generation becomes the `LeagueAnnouncement`
  dedupe key, closing the claim/enqueue/finalize crash gaps. Honors use the
  equivalent generation-preserving CAS state machine for initial, stale,
  corrected, and failed awards. `playoffRoundBuilt:<season>:<round>` remains a
  transactionally revalidated round-build marker;
  (4) JSON state blobs written by compare-and-swap — `inhouseBoard` (a live
  message state or leased pre-POST reservation; a row means on or posting),
  `importSkip:<seasonId>`,
  `leagueSyncSkip:<seasonId>`, `playoffGamesArchive:<seasonId>` (merge-only).
  (5) the monotonic `resultChangedAt` freshness cursor, written in the same
  command as result imports/corrections, bracket start/reset/removal, round
  creation, crowning, and generic phase changes. Each open tab compares it to
  the cursor captured during its own server render, preserving render-to-first-
  heartbeat causality.
  The dynamic keyspace is invisible to `SETTING_KEYS` — consumers rely on
  prefix conventions, so key-format changes have cross-file blast radius.

## 7. Background/automatic processes

The production clock is explicit. `vercel.json` schedules
`GET /api/cron/automation` once per minute; a trusted external scheduler may
call the same route. `src/lib/cron-auth.ts` accepts only a header bearer token
matching a non-placeholder `CRON_SECRET` and compares fixed-length digests in
constant time. Query strings and browser cookies are not credential sources.
The route returns 401 before worker work on bad auth, 202 when another owner
holds the lease, 200 only for a healthy completed pass, and non-2xx for a
degraded, failed, or unavailable pass.

`src/lib/automation-service.ts` wraps every scheduled and admin-requested pass
in the same database-global 90-second owner/token lease. Work gets a 45-second
deadline and abort signal inside the route's 60-second maximum. Finalization is
fenced by owner + token, so an expired process cannot clear or overwrite its
replacement. `AutomationRunState` persists RUNNING/SUCCEEDED/DEGRADED/FAILED,
attempt/start/finish/success/failure times, source, duration, consecutive
failures, a safe code, and a bounded summary. A replacement counts and reports
an expired RUNNING lease before taking ownership.

| Process | What it does | Trigger | Bound / recovery contract |
| ------- | ------------ | ------- | ------------------------- |
| Scheduled maintenance (`runAutomation` → `runResultSync`) | Owns unattended league, draft, inhouse, reminder, playoff, Discord, and cursor work | Authenticated cron every minute; Admin → Automation → **Run maintenance now** uses the same election path | One global 90s tokened lease; 45s work budget; independent steps report stable issue/deferred codes instead of suppressing unrelated work |
| Draft clock resolver (`resolveExpiredNomination` / `resolveStalledNomination`) | Resolves an expired nomination or bid clock when no draft-room client remains open | Every maintenance pass; draft-room reads also resolve immediately | Cheap due-time preflight plus phase/turn/lot write claims; duplicate room/worker attempts are harmless |
| Result sync, roster scan (`syncDueMatches` → `autoDetectGamesForMatch`) | Claims one due fixture and roster-scans OpenDota | Every pass in REGULAR_SEASON/PLAYOFFS when the match throttle permits | Global `rosterAutoSyncAt`, per-match compare-and-set, exponential empty-scan backoff; recent-list and match calls receive the worker deadline/abort signal, and an unreachable/deadline scan releases its throttle for recovery |
| Result sync, league feed (`syncLeagueGames({auto:true})`) | Uses one Valve league feed to discover all league games when `Season.dotaLeagueId` exists | Preferred result path in the same phase-bound pass | `leagueAutoSyncAt` (180s), ≤25 unknown ids, per-season skip memory, and the same deadline/abort propagation; manual admin sync remains a bounded override |
| Playoff reconciliation (`advancePlayoffBracket`) | Repairs a committed result whose immediate round-build/crown handoff was interrupted | Every maintenance pass while PLAYOFFS | Round claims plus Serializable revalidation of current source winners/final; committed work is idempotently rediscovered |
| Inhouse resolver chain (`syncInhouse` + `getInhouseState`) | Abandoned-lobby sweep, bet sweep, formation, ready check, vote, stalled pick, auto-detect, board repaint | Every maintenance pass; `/api/inhouse` state reads retain immediate interactive resolution | Each transition has its own claim; auto-detect is throttled and deadline-aware; parked lobbies no longer depend on a visitor |
| Bet sweeper (`resolveUnsettledBets`) | Settles, refunds, or reverses stranded pots | Maintenance/inhouse resolver chains; cancel/void also target their own lobby immediately | Global calls attempt ≤25 oldest-first, isolate failures per row, and rotate a failed row; immutable `completedAt` remains result chronology |
| League marker reconciliation | Recovers series, champion, reminder, and honor announcement generations | Immediate domain path plus bounded maintenance retry sweep | 90s marker leases recover pre-enqueue death; stable generation/dedupe keys reuse the same `LeagueAnnouncement` after enqueue-before-finalize death; exact-value finalization cannot overwrite a newer claim |
| League outbox (`deliverLeagueAnnouncements`) | Sends all league-channel webhook work in global creation order | One immediate bounded attempt after enqueue; maintenance drains existing work before creating/retrying later marker events | PENDING/SENDING/SENT/CANCELLED, tokened 30s claims, bounded batches, exponential backoff; an earlier non-terminal row blocks later rows. Discord accept-before-`SENT` death can still duplicate once on recovery (at-least-once) |
| Inhouse result recovery/outbox (`reconcileMissingInhouseResultAnnouncements` / `deliverInhouseAnnouncements`) | Reconstructs missing completion-derived Elo/result work, then sends RESULT/RESULT_VOIDED in per-lobby order | Maintenance/inhouse reconciliation plus an immediate post-commit delivery attempt | Source completion and `dotaMatchId` are revalidated; unique `(lobbyId, kind)`, sequence, tokened 30s claims, cancellation of invalidated unsent results, and backoff. The same unavoidable Discord accept/commit duplicate gap applies |
| Week reminder (`maybeAnnounceUpcomingWeek`) | Announces each kickoff cluster in the 24-hour window and mentions only linked players who still owe an RSVP | Maintenance pass only | Exact `(season, week, kickoff)` key, 90s recoverable marker lease, stable outbox dedupe generation, and exact-delimiter cleanup on retime |
| Weekly honors (`maybeAnnounceWeekHonors`) | Announces Player/Team of the Week only from publication-ready attributed 5v5 evidence | Result recomputation/correction plus maintenance retry | Generation-preserving CAS supports initial, stale, corrected, failed, and expired-claim recovery; reopen/remove marks previous awards stale |
| Board repaint (`syncInhouseBoard`) | PATCHes the pinned Discord queue board when its semantic digest changes | Inhouse state reads and scheduled `syncInhouse` | Pre-POST CAS reservation + 30s lease; ambiguous/no-id POST requires explicit admin recovery; digest gate; `inhouseBoardAt` (10s); permanent gone handling |
| Session epoch (`src/lib/session-epoch.ts`) | Invalidates all signed sessions | Admin `revokeAllSessions` | 30s in-process cache; tokens carry the epoch minted into them |

`GET /api/sync` is intentionally absent from this table: it only reads
`watch`/cursor state for browser refresh cadence. It cannot invoke any process
above, and POST is not implemented.

## 8. Admin tools

`/admin` (`src/app/admin/page.tsx`) is a set of anchored cards behind a sticky jump
bar, with the set-once cards collapsed as `<details>` and the three slow cards
Suspense-streamed. An `adminNextStep` banner (`src/lib/admin-next-step.ts`,
pure, tested) says what to do next per phase — it exists because several
transitions are silent (notably DRAFT→REGULAR_SEASON). Confirmation tiers:
**plain** form, **confirm** (`<SubmitButton confirm>` → `window.confirm`), and
**DangerSubmit** (`src/components/danger-submit.tsx`, type the exact
season/team name) — reserved for exactly the five actions with no in-app undo.

| Card                       | Key controls (action → tier)                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Season controls            | `setSeasonPhase` (confirm, positive policy-approved handoff/recovery), `renameSeason`/`setMaxMmr`/`setSeriesLengths`/`setMatchSchedule` (plain), `setDraftSettings`                                                                                                                                                                                                                                                                                                                   |
| Captains & draft           | `addCaptain` (confirm), **`removeCaptain` (DangerSubmit)**, `transferCaptaincy`, `randomizeDraftOrder`, `startDraft` (confirm names the seat math), `pauseDraft`/`resumeDraft`, `voidCurrentLot` (confirm, paused lot), `undoLastSale` (confirm), **`abortDraft` (DangerSubmit, enumerates roster/schedule/fantasy/reminder collateral)**, `setDraftNight`, `setRegistrationMmr`, `withdrawSignup`/`reinstateSignup`, `syncPlayerRanks`, `syncSteamProfiles`                           |
| Schedule & results         | Generate (confirm, only when empty) vs **Regenerate (DangerSubmit, names collateral)** as separate controls; `setWeekNight` (confirm); per match: phase-aware `recordResult`/ruling, `reopenMatch`, `setMatchTime`, `removeGame`, import/auto-detect, and pending-reschedule Clear. Imported scores and off-phase fixtures are read-only; archive corrections require reactivation/phase restoration (and regular corrections require playoff reseeding).                              |
| Playoffs                   | Start (confirm) vs **Reset (DangerSubmit)** with explicit intent + revision claims; **Return to regular season (DangerSubmit)** removes the bracket/champion through the shared teardown; postseason-game archive listing. The result card separately supports grand-final-only reopen/import correction without discarding earlier rounds.                                                                                                                                            |
| Roster moves               | `signFreeAgent`, `promoteStandinToPlayer`, `releasePlayer` (confirm — names refund + cover effects), REGULAR-only `withdrawTeam`/`reinstateTeam`                                                                                                                                                                                                                                                                                                                                   |
| Standins                   | `assignStandin` (incl. empty-seat `seat:<teamId>` form), `removeStandin` (confirm)                                                                                                                                                                                                                                                                                                                                                                                                     |
| Automation runner (evergreen) | Persisted last attempt/success/source/duration, failure streak, safe issue/deferred codes, active/expired lease signal, and expected one-minute/four-minute-stale cadence. **Run maintenance now** is admin-only and uses the same lease as cron: it can recover an expired owner but is visibly disabled and cannot force or overlap an active run. This card remains available in every phase and offseason. |
| Auto-sync health           | Read-only: per-match scan state, league throttle, cursor, skip memory                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Dota league integration    | `setLeagueId`, `syncLeagueAction`, `enrichGamesAction`, `syncAllRanks`                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Discord (streamed)         | Webhook set/clear ×3 (league / inhouse board / inhouse alerts; board-webhook moves attempt teardown, alert moves never touch it), ping role, test sends, board post/remove/interrupted-post recovery, ping-health checklist + reach count                                                                                                                                                                                                                                              |
| Inhouse betting (streamed) | Zero-sum + ledger drift alarms, stranded pots, negative balances, `adjustCredAction` (confirm — deliberately not DangerSubmit; reversible)                                                                                                                                                                                                                                                                                                                                             |
| Admin activity (streamed)  | `recentAdminActions(40)` — the append-only `AdminAction` log (coverage is partial; see the log's call sites)                                                                                                                                                                                                                                                                                                                                                                           |
| League news                | create/pin/delete (`src/app/actions/news.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Security                   | `revokeAllSessions` (confirm)                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Season handoff             | A completed authoritative season can be **closed into offseason** with `archiveCompletedSeasonAction`, or closed and replaced by `createSeason`; both use the shared completion/champion gate. From offseason, `createSeason` opens fresh SIGNUPS. An unfinished season uses the separate **Cancel season and enter offseason** `DangerSubmit`, which preserves saved data and parks any live auction. All controls carry rendered lifecycle claims; stale/replayed forms are refused. |

Off-page on `/seasons` (archived seasons only): the audit-only season JSON
download; offseason-only `reactivateSeasonAction` (confirm, rendered target
revision, exact phase restored, legacy live auction parked); and
**`deleteSeason` (DangerSubmit)** — the app's only unrecoverable action. The
adjacent JSON is explicitly not recovery; production deletion additionally
requires a recent signed full-database backup receipt. While another season is active,
reactivation is visibly locked and points the admin to the handoff controls.

## 9. External integrations

**Steam** (`src/lib/steam.ts`): OpenID 2.0 login (one-shot browser state,
exact return-to and signed-field pinning, duplicate assertion rejection,
canonical Steam identity, check_authentication round-trip, 8s timeouts) and GetPlayerSummaries for
public persona name/avatar/profile URL (needs `STEAM_API_KEY`). OpenID returns
the SteamID64; the app never receives the Steam password. It stores the ID and
selected profile fields, which `/privacy` names along with the operator-verified
storage/processing countries. Failure rule: never overwrite a stored profile with
a placeholder — fetch failures return null and the upsert leaves existing fields
untouched. Login destinations are limited to validated same-origin relative
paths; the short-lived return cookie is secure in production, reset at each
kickoff, and consumed on success or failure. `/terms` carries the independent,
not-endorsed and as-is/as-available boundary required for external data.
The authenticated manual profile refresh has a durable 60-second
per-user/Steam-id claim, so duplicate tabs and function instances elect one
provider call and an outage cannot become a retry storm.

**OpenDota** (`src/lib/dota.ts`): match fetches (`/matches/{id}`, 12s cap),
per-player recent-match lists (8s; returns `null` for unreachable vs `[]` for
genuinely empty — callers use the distinction to blame the right thing),
league feeds (`/leagues/{id}/matches`), and rank medals (`rank_tier` +
`fh_unavailable`), scouting (`/players/{id}/wl` + `/heroes`), and player
profiles. These server-side requests send the relevant Dota account, match, or
league id; there is no OpenDota login. Selected rank/privacy/scouting fields and
imported match records persist locally as described on `/privacy`. Optional
`OPENDOTA_API_KEY`. Budgets: one roster scan ≈ 10
recent-match lookups + ≤12 match fetches under a 25s deadline; the league feed
fetches ≤25 unknown ids per auto run; inhouse detection needs 4 of 10 lists to
agree on a candidate. Hero names are never fetched — `src/lib/heroes.ts` is a
static table, so no hero label depends on OpenDota being up. Rank/medal writes
follow never-overwrite-on-failure for an unchanged account. Changing the
effective account first clears the old medal/private-data/scouting snapshot;
every asynchronous write re-asserts the account it fetched, so another tab's
newer link or snapshot wins.
Manual medal/account refreshes share one durable 60-second per-user/account
claim. Captain auto-detection claims a 180-second per-captain/match allowance
only after rechecking the active phase, fixture, result state, and captain
permission; duplicate instances cannot multiply the roster fan-out.

**Discord** — three mechanisms (no gateway, no slash commands):

1. _Webhooks_ (`src/lib/discord.ts`): ~24 pure, tested message formatters +
   the transport (`sendTo`, 5s timeout, resolves false and never throws).
   Every runtime/admin/environment value passes one exact URL parser: HTTPS,
   `discord.com` or `discordapp.com`, canonical webhook path, and no port,
   query, fragment, or embedded credentials. Invalid values are never fetched.
   `sendDiscordMessage` validates and persists league-channel work before a
   bounded immediate transport attempt; returning true means durable queue
   acceptance, not proof that Discord already rendered it. Three webhooks form
   a fallback chain:
   league (`discordWebhookUrl`) ← inhouse board channel ← inhouse alerts
   channel, so an alert can never scroll the pinned board out of view. Every
   send pins API v10 and `allowed_mentions: {parse: []}` — mentions happen
   only through an explicit server-chosen `MentionAllowlist`; untrusted names
   pass through `escapeDiscordText` (`src/lib/discord-escape.ts`). Webhook
   URLs are bearer credentials: never rendered to the client (masked
   fingerprints only), blank submit = no-op, clearing is an explicit action.
2. _Bot token_ (`src/lib/discord-roles.ts`, env `DISCORD_BOT_TOKEN` +
   `DISCORD_GUILD_ID`): the self-serve inhouse ping-role toggle
   (`setPingRole`), the OAuth `guilds.join`, and the `getPingHealth`
   diagnostic (hierarchy + permission math). Role assignment needs **Manage
   Roles** with the bot role above the target; automatic joining needs **Create
   Invite**, and the bot token must belong to the OAuth application's client id.
   Administrator is neither needed nor recommended. Missing any config piece
   makes the feature invisible, never half-working.
3. _OAuth linking_ (§2): `identify` (+ conditional `guilds.join`) receives the
   basic Discord user response; the app persists only `discordId` and
   `discordName`, does not request email, and discards the temporary access
   token after the callback/join attempt. The bot subsequently reads membership
   and role ids for linked accounts. A failed join never fails the link. A
   versioned one-shot cookie binds state, PKCE verifier, and the initiating site
   user; duplicate callback parameters and a session swap are rejected before
   token exchange. `/privacy` also discloses that configured webhook messages
   send public player/team/schedule/result data and explicit user mentions to
   Discord, and that unlinking cannot erase messages already delivered there.

The overarching failure-tolerance rule: **a Discord failure can never fail or
roll back a database write.** League-channel work uses the globally ordered
`LeagueAnnouncement` outbox; inhouse result/correction work uses the
per-lobby-ordered `InhouseAnnouncement` outbox. Both retry with tokened leases
and backoff and both are at-least-once across the unavoidable Discord
accept/our-commit gap. Series, champion, reminder, and honor markers add
90-second recoverable claims plus stable generation dedupe, closing death
before enqueue and between enqueue/finalization. Inhouse completion
reconciliation similarly rebuilds a missing RESULT event/Elo snapshot from the
committed lobby source.

Ordinary low-collateral league actions enqueue immediately after their domain
transaction rather than in that same transaction. Once enqueued they are
durable and ordered, but a process death in the narrow domain-commit-before-
enqueue call gap can still omit one of those non-marker-backed notices. Queue
alerts and the live board use their separate best-effort/reservation contracts;
they must not be described as outbox-exact.

## 10. Testing model

Five layers (depth and the doctrine behind each in CLAUDE.md):

1. **Unit** — `npm test` (`vitest.config.mts`, node environment, no jsdom):
   `src/**/*.test.ts` beside every pure lib. Because components can't render,
   focused **source-guard suites** parse component/page/action _source text_ to
   pin wiring, including `src/components/room-source-guards.test.ts` (both rooms route
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
   once, every table wiped per test): 44 `.itest.ts` files exercising the
   services with `@/lib/dota` and `@/lib/discord` sends mocked (formatters
   real) — except the two real-HTTP suites that run the actual Discord
   transport against in-process `node:http` stand-ins.
3. **The same suite on Postgres** — `npm run pg:up`, point `PG_TEST_URL` at the
   local `ld2l_pgtest` database, `npm run test:pg`, `npm run pg:down` (do not
   skip pg:down — it restores the SQLite provider), then unset the URL. The
   suite truncates every league table: `assertPostgresTestUrl` accepts only the
   exact scratch names `ld2l_test`/`ld2l_pgtest`, and the management commands
   additionally refuse non-local hosts. Never use a production/shared URL.
   SQLite serializes writers, so raced tests
   (`factories.raceAll`) run concurrently _only_ here, and the deterministic
   race-hook seam tests (`src/lib/race-hook.ts` — a test-only fault injector
   with 56 labeled production seams across 12 modules) provide exact
   interleavings. Pre-transaction seams can also run on SQLite; lock-sensitive
   in-transaction races require Postgres. This is the only run where the
   concurrency guards are exercised for real.
4. **The mutation ratchet** — `npm run test:mutation` (verify) /
   `test:mutation:discover` (extend), `scripts/mutation-guard.mjs` + committed
   `test/mutation-baseline.json`: recursively rejects omitted claim-bearing
   source files, deletes each guarded `updateMany` WHERE predicate, and requires
   a real pg test failure rather than a transform/runner failure. Currently 115
   live claims — 73 protected and 42 documented equivalent mutants, each with a
   reviewable justification; zero claims are unclassified. CI runs it as a
   4-shard matrix. Caveat: it models exactly one
   guard shape — early
   returns and count-check-then-throw guards are invisible to it and covered
   by hand-written tests instead.
5. **Three Playwright suites**, each on its own DB and port, so they never
   touch dev.db: `npm run test:e2e` (`e2e/`, `prisma/e2e.db`, :3210 —
   signups/draft phase: two-context live bidding, poll-resilience via hung
   endpoints, the full inhouse lifecycle); `npm run test:e2e:mid` (`e2e-mid/`,
   `prisma/e2e-fixture.db`, :3212 — mid-season reads plus player/captain/admin
   match-night writes and geometry tripwires); and
   `npm run test:e2e:postseason` (`e2e-postseason/`,
   `prisma/postseason-e2e-fixture.db`, :3214 — live and completed brackets,
   desktop/mobile tracing and keyboard scroll, zero-import recap, locked admin
   capabilities, inconsistent-title suppression, and archived champion
   discovery). They run sequentially because Next permits one dev server per
   repo directory.

CI (`.github/workflows/ci.yml`) runs: types + unit + SQLite integration; the
integration suite on a Postgres service container; the 4-shard mutation
matrix; and all three Playwright suites sequentially. Destructive local
commands (including `db:push`) are gated by `scripts/assert-local-db.mjs` and
per-script URL guards; refusal output redacts credentials, path, and parameters;
the fixture/e2e databases and guarded Postgres databases are deliberately
separate. CI's ordinary SQLite job uses `file:./ci.db`, while Playwright's base
job starts from its dedicated `prisma/e2e.db`; neither can inherit or target a
remote connection, and the browser fixture never touches `dev.db`.

## 11. Production deployment and recovery

**Environment gate.** `scripts/validate-prod-env.mjs` runs first for a
production Vercel build. It requires PostgreSQL `DATABASE_URL` and `DIRECT_URL`
that name the same logical database, schema, username (and, for recognized managed
providers, the same project). The initial release intentionally does not claim
to provision or attest grants for a separate runtime role. It rejects a
custom-provider pair unless hostname and effective port also match; only the
reviewed Neon and Supabase forms normalize distinct pool/direct endpoints. It
rejects a pooler as `DIRECT_URL`, a known direct endpoint as `DATABASE_URL`,
and the obsolete `PRISMA_ACCEPT_DATA_LOSS` escape hatch. It also requires
distinct, non-placeholder `AUTH_SECRET`, `BACKUP_RECEIPT_SECRET`, and
`CRON_SECRET` values of at least 32 characters (the cron credential is capped
at 512 characters and may not contain whitespace); a configured non-placeholder
`STEAM_API_KEY`; complete-or-absent Discord OAuth and bot/guild pairs; no
production `DISCORD_API_BASE`; at least one valid, unique individual SteamID64 in
`ADMIN_STEAM_IDS`; identical canonical HTTPS origins in `APP_URL` and
`NEXT_PUBLIC_SITE_URL`; one normalized, non-placeholder public mailbox in
`PRIVACY_CONTACT_EMAIL`; non-empty operator-verified storage/processing countries
in `PRIVACY_DATA_LOCATIONS`; and dev login unset or exactly `false`.
The two privacy values remain server-side but are rendered by `/privacy` (and
the contact is also rendered by `/terms`); they are public operational facts,
not secrets. Validation proves their shape and presence, not that the mailbox
is monitored or the claimed provider storage countries are true — those remain promotion
checks for the operator.
`BUILD_DB_DRY_RUN` is reserved for unit tests running with `NODE_ENV=test` and
is rejected in production. `PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK` is also
rejected so concurrent migration commands retain Prisma's database lock.
Errors identify fields without echoing their values. Production has no
first-user bootstrap path. Secrets belong in Vercel
or another secret manager and a private process environment, never literal
command arguments, source, logs, or chat.

**Build and schema order.** `build:vercel` is deliberately linear: validate the
environment → switch the Prisma provider to PostgreSQL → validate the
committed migration history and schema → run the read-only data/schema
preflight → apply `prisma migrate deploy` → run the read-only schema postflight
→ generate the client → run the Next production build. Postflight compares all
Prisma-supported objects to an isolated PostgreSQL copy of the datamodel,
requires the exact completed migration inventory and checksums, and verifies
the definitions of the release-native CHECK constraints, partial indexes,
functions, and triggers. Migrations therefore use only the direct connection,
land before new code is promoted, and must remain backward-compatible with the
currently serving release. Preview, development, and local builds do not run
the deployment step. Production has no data-loss override and never uses
`prisma db push`.

**Migration history and existing databases.** The first committed migration is
an immutable baseline of the last production schema managed with `db push`;
the second is the additive release-readiness change, and the third adds
`AutomationRunState` plus the league announcement outbox. A fresh database
applies all three in order. An existing untracked database must first pass
`db:migrate:baseline-check`: its semantic Prisma schema and every relevant
public-schema object must exactly match the pinned baseline, and the current
data must pass the release preflight. Only then may an operator run the guarded
`db:migrate:baseline-resolve`, which records the baseline as applied before
`migrate deploy` adds the later migrations. A database with an existing,
partial, failed, or unexpected migration history is rejected instead of being
silently adopted. The release migration preserves the legacy Dota column and
old-writer compatibility triggers for one rollback window; rollback means
promoting the previous application build, not attempting a destructive SQL
down migration. The automation/outbox tables are additive and safe for that
older binary to ignore.

**Scheduler and health launch gate.** The repository's `vercel.json` registers
`/api/cron/automation` on `* * * * *`. This requires Vercel Pro/Enterprise;
Hobby's once-daily, broad-window cron cannot meet the application's lifecycle
or recovery contract. A trusted external one-minute scheduler is compatible
with the route if it sends the same Authorization bearer, but a Hobby
deployment must omit the unsupported Vercel cron registration through an
explicitly reviewed deployment configuration. `CRON_SECRET` is a machine
boundary, never a browser credential: Vercel injects it as a bearer header and
external schedulers must do the same. The route returns non-2xx for degraded or
failed work because Vercel does not retry a failed cron request; the next
minute's invocation and persisted recovery primitives own retry, while
observability owns alerting.

Before promotion, a production-like candidate on a non-production database must prove: `/api/health/live` returns 200
without dependency work; `/api/health/ready` returns 200 with the target
database and 503 when that probe fails; unauthenticated/incorrect-auth cron is
401; POST `/api/sync` is 405; GET `/api/sync` is a read-only
`updated`/`watch`/`cursor` response; and a manual Admin run or reviewed external
staging invocation can complete. Vercel Cron does not target preview
deployments. Immediately after a controlled production promotion, exactly one
authoritative scheduler must produce two consecutive authenticated one-minute
200/SUCCEEDED invocations, and `/api/health/automation` must return 200. The evergreen Admin →
Automation card must show those attempts and successes, Source = Scheduled
cron, cleared leases, and zero consecutive failures. The manual control must
complete under Source = Admin manual run while idle and refuse to overlap an
active scheduled lease. Alert on live/ready failure, cron non-2xx, or four
minutes without a completed pass. The pinned-commit promotion, launch evidence,
traffic freeze, rollback, PITR recovery, and secret-rotation contract lives in
`docs/PRODUCTION-OPERATIONS.md`.

**Application rollback sequencing.** Vercel rollback does not reliably update
cron configuration, so pause/remove the schedule first and confirm invocations
have stopped. Wait at least the 90-second lease duration and verify the admin
health card shows no active owner; never delete or overwrite a live lease.
Promote the previous tested application build while leaving the additive
migrations/tables intact, then verify Steam login, the current schedule, and a
known database-backed read. Verify live/ready only if that release exposes
those probes. Never use `/api/sync` as a rollback health check: an older build
may still mutate state on GET. Keep scheduling disabled if that build predates
the authenticated route and point platform probes at endpoints that exist in
the rollback release. After the forward repair is deployed, re-enable the
one-minute bearer-authenticated schedule and repeat the two-consecutive-success
gate. A data incident follows the rehearsed restore path below, never an
improvised SQL down migration.

**Database backups.** `npm run db:backup` prefers `DIRECT_URL`, translates the
connection into dedicated libpq environment fields rather than passing a URI
or password in argv, and produces a non-empty dump under a random temporary
name. The backup directory is forced to `0700`; backup, SHA-256, and sanitized
database-identity metadata files are `0600`. They are renamed from
same-directory temporaries only after checksum creation, and every
partial/published piece is removed if any step fails. SQLite uses its online
backup API and verifies the resulting snapshot with `PRAGMA integrity_check`
instead of byte-copying a potentially live WAL database; it requires the
`sqlite3` CLI and fails rather than falling back to an inconsistent copy.
`npm run db:backup:verify -- backups/<file>` checks the sidecar
filename/digest and artifact modes. With `BACKUP_RECEIPT_SECRET` configured it
also signs a portable receipt naming the artifact digest, kind, creation and
verification times, and credential-free logical database identity. Production
`deleteSeason` accepts only a same-database PostgreSQL full-dump receipt whose
backup and verification are both less than 24 hours old. Unknown-provider
identity includes hostname and effective port so a receipt cannot cross between
clusters listening on different ports; reviewed Neon/Supabase pool/direct forms
normalize to their managed project identity. The season JSON is an
audit archive with no restore path and cannot satisfy that gate.

**Recovery proof.** A checksum proves byte integrity, not that SQL is parsable,
complete, or compatible. `npm run db:backup:rehearse -- <backup.sql>` accepts
only the exact guarded local `ld2l_restore_test` target, verifies the digest
and private file modes (plus signed metadata when a receipt secret is
configured), recreates the database from `template0`, restores with
`psql -X`, `ON_ERROR_STOP`, and one transaction, then requires exactly one
application schema and runs the same full schema/migration/native-object
postflight against that discovered schema. CI also asserts that known legacy
User and Season fixture rows survived the round trip. A launch still requires
the same restore drill against a disposable database on the actual hosting
provider, with the result recorded before the backup is trusted for recovery.
