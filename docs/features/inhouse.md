# Inhouse games

Casual pick-up games: a global queue, a ready check, a captain vote, a snake
draft and an OpenDota result feeding an Elo ladder. Rules: `src/lib/inhouse.ts`,
`inhouse-stats.ts`. Engine: `src/lib/inhouse-service.ts`. Endpoint:
`POST /api/inhouse`. Room: `src/components/inhouse-room.tsx` (shell) plus one
file per stage in `src/components/inhouse/`. Lifecycle overview:
`docs/ARCHITECTURE.md` section 3. Board and pings: `docs/features/discord.md`.

## Scope and where it runs

- **No `seasonId`, no phase gate.** Inhouse runs in every phase and the
  offseason, sharing identity, the latest `Registration.mmr`, Settings,
  `AdminAction`, Discord and OpenDota. The nav link is always visible.
- **Tim's calls bind** (`docs/DECISIONS.md`): keep every inhouse feature, the
  captain vote and the Discord board; never hide or de-promote the queue, even
  empty; don't gate Europe's inhouse on its ticket; no retire checkpoint or
  adoption features (plan-a-time, rally button) unless Tim asks.
- **Status flows `READY_CHECK → CAPTAIN_VOTE → DRAFTING → READY → IN_PROGRESS
  → COMPLETED | CANCELLED`, one active lobby** (`INHOUSE_ACTIVE_STATUSES`). A
  lobby is played from team lock: `INHOUSE_PLAYING_STATUSES` is READY and
  IN_PROGRESS, and Start is optional. Both IN_PROGRESS writers (`startGame`,
  the bot launch in `src/app/api/dota-lobby/route.ts`) are guarded on READY and
  stamp `startedAt`.
- **Two chains run the resolvers; keep them the same SET.** `getInhouseState`
  (room poll) and `syncInhouse` in `result-sync-service.ts` (the
  bearer-authenticated one-minute worker at `/api/cron/automation`, which
  reaches a lobby nobody watches). A resolver missing from one fails silently;
  `src/lib/inhouse-resolver-parity.test.ts` compares the sets. The order differs
  on purpose (the room runs the abandon sweep first so a freed slot re-forms on
  the same poll), so never make it compare order. `GET /api/sync` is read-only.
- **Only a signed-in poll that wins the fleet-wide throttle runs maintenance**
  (`inhouseRoomMaintenanceAt`, 2s `claimThrottle`). Anonymous polls get a
  side-effect-free snapshot, so spectators never advance a lobby, call OpenDota
  or edit Discord. Room polls pass `detectResults: false`: the worker owns the
  automatic scan.
- **Give every new lobby or queue clock a wake-up in
  `src/lib/automation-gate.ts`,** which schedules the worker for accept, vote
  and pick deadlines, the detect window, abandonment floors and queue
  idle/away transitions. Mutations call `invalidateAutomationGateBestEffort()`.
- **Never make a mutation wait on Discord.** Mutations answer with
  `getInhouseState(user, { runMaintenance: false, syncBoard: false })`. A poll
  repaints the board only when it wins the 2s `inhouseRoomMaintenanceAt`
  claim (`syncBoard: runMaintenance`, `src/app/api/inhouse/route.ts`), and
  signed-out polls never do; otherwise the claim's winner or the worker
  repaints. Don't make every poll sync the board to "fix" this.
- **API contract:** `state` plus `join`, `leave`, `accept`, `decline`, `vote`,
  `pick`, `start`, `record`, `detect`, `cancel`, `void`. The body must be a JSON
  object with a non-empty string `action`, else 400. `state` allows 1,200/min
  per IP; mutations 300/min per signed-in user (signed-out attempts are
  IP-limited, then 401), in a separate bucket so poll back-pressure never eats
  an action allowance.

## Guarded transitions

Every transition is a guarded claim; keep it that way (general rules:
`docs/features/concurrency-and-testing.md`).

- **The claims:** `applyResult` on `status in INHOUSE_PLAYING_STATUSES` (a
  cancel racing the OpenDota fetch wins); `cancelLobby` inside its transaction
  (loses to a landed result and requeues nobody); `applyPick` on the turn and on
  the target row `{team: null}` (a double-click is one turn), auto-assigning
  the last pool player; `resolveCaptainVote` on `CAPTAIN_VOTE → DRAFTING`
  before installing captains; `startCaptainVote` on `READY_CHECK →
  CAPTAIN_VOTE`; `startGame` on READY; `resolveAbandonedLobby` on the exact
  status it read (a Start or a result landing after its read wins, and two
  chains tear a dead lobby down once). `maybeFormLobby` runs Serializable and
  treats P2034 or P2002 as the benign loser; Postgres's partial unique
  `InhouseLobby_one_active_idx` is the final one-active barrier. The queue ping
  throttle is `claimThrottle` on `inhouseQueuePingAt`.
- **`applyPick` must THROW, never return, after nulling `pickTeam`.** That null
  is the turn claim, and a return commits it: DRAFTING with `pickTeam = null`
  is a state nothing moves (`resolveStalledPick` filters `pickTeam: { not: null
  }`, `makePick` bails on `!lobby.pickTeam`). It throws `PickRaceError`, caught
  OUTSIDE the callback in `makePick` / `resolveStalledPick`. Also keep:
  `pickEndsAt` in the turn claim's WHERE (the snake repeats a team, so
  `pickTeam` alone doesn't identify a turn), and `expectTeam` from `makePick`
  (Postgres re-snapshots per statement, so the re-read can show the other
  captain's turn).
- **`restoreLostPickTurn` makes a frozen draft unreachable.** It runs first in
  `resolveStalledPick` and recomputes the turn from the rosters with
  `nextPickTeam`. It and `applyPick` are the only writers of `DRAFTING → READY`.
- **`resolveAbandonedLobby` frees a slot held by a dead READY or IN_PROGRESS
  lobby,** the only phases with no clock. Without it no game could form and the
  lobby's own ten were refused by `joinQueue`. Floors: `ABANDON_READY_HOURS` off
  formation, `ABANDON_IN_PROGRESS_HOURS` off `startedAt`, never `updatedAt`
  (each scan's `detectedAt` claim bumps it). Generous because results record
  from READY with no time gate. It requeues nobody: nobody has touched it for
  hours.
- **Every CANCELLED write sets `endReason` in the SAME claim `data`,** built by
  `src/lib/inhouse-end-reason.ts`. Admins read them in "Recent failed lobbies"
  on `/inhouse/history`; old rows fall back to `failedLobbyReason`. A new cancel
  path must set it.
- **Keep a claim's `data` a flat object literal;** hoist conditionals into a
  variable. `scripts/mutation-guard.mjs` parses these writes, and an inline
  ternary in `applyResult`'s `data` hid the claim from the ratchet.
- **Every successful admin cancel and void writes an `AdminAction`** after its
  claim, so a losing rival logs nothing. The void's summary carries the match
  id because the claim nulls it.

## Queue

- **Membership is not presence. Never delete an entry for a missing
  heartbeat:** browsers suspend hidden tabs for hours, and the queue holds a
  spot with the tab closed. An entry leaves only by a leave, formation, or the
  shared idle deadline.
- **One idle clock for the whole queue.** Every composition change (join,
  leave, formation, requeue) resets `idleExpiresAt` on EVERY row to now plus
  `QUEUE_IDLE_HOURS`; heartbeats never do, or an open tab keeps a static queue
  alive forever. `expireStaticQueue` clears the WHOLE queue once any row is
  past it, never a subset. A null deadline falls back to `joinedAt` plus the
  same hours.
- **Take the shared queue locks first:** every queue write calls
  `refreshQueueIdleDeadline` before touching the caller's own row, so
  concurrent joins and leaves serialize instead of deadlocking.
- **Presence is a throttled heartbeat.** `touchQueueHeartbeat` runs first in
  `getInhouseState` (at most once per `QUEUE_HEARTBEAT_SECONDS`). Unseen for
  `QUEUE_AWAY_SECONDS` means "away": still queued, but excluded from `needed`,
  the counts (room, home strip `src/components/home/inhouse-strip.tsx`, queue
  ping) and formation. Use `queuePresence` / `queuePresentCutoff` everywhere.
- **`joinQueue` guards and upserts at Serializable,** or a concurrent formation
  can roster the player in the live lobby AND queue them. It retries P2034/P2002
  up to `QUEUE_WRITE_RETRY_ATTEMPTS` with a jittered wait
  (`waitBeforeSerializableRetry`), then re-reads to tell "already in a live
  inhouse" from contention. Every join rewrites every row's idle deadline, so
  joins go one at a time; a fixed `2 ** attempt` ms delay retried the losers
  in step, one winner per round, and a ninth simultaneous join was refused
  ("The queue changed") in 19 of 20 local runs. Jittered, nine and ten
  simultaneous joins all land. A repeat join keeps position and idle deadline.
  Outsiders may queue during a live lobby (for the next game). The tenth join
  tries formation at once.
- **MMR trust chain:** latest `Registration.mmr` (used as-is, so an admin
  override survives) > the typed value clamped to the medal > the last lobby
  snapshot (clamped), so a blank "Run it back" join keeps a known MMR. Client
  MMR alone never decides captaincy for a registered player.
- **Keep the queue's "How your MMR is set" note after joining** (`mmrHint`,
  built in `src/app/inhouse/page.tsx`, shown by
  `src/components/inhouse/queue-view.tsx`). It renders only for a medal-holder
  with no signup MMR and explains why a typed value outside the medal's window
  is clamped. A registered player gets no MMR input at all, only "Joining at N
  MMR, from your league signup", which is what explains that override.
- **Order by exact keys, never row order.** Queue reads and formation sort
  `[joinedAt, userId]`; formation copies `joinedAt` to
  `InhouseLobbyPlayer.queuedAt`, and later sorts use `[queuedAt, userId]`.
  Never lobby-player `createdAt` (one `createMany`, all ten tie).
- **Requeues:** a failed ready check restores each player's exact `queuedAt`,
  so accepters outrank anyone who joined during the check. `cancelLobby`
  requeues all ten with a backdated heartbeat (`requeueLastSeenAt`): present
  players re-confirm on their next poll, ghosts can't instantly re-form it.
- **The ten slots hold PRESENT players only** (`queueSlots`), matching the
  counts and formation. Extra present players show as "Also queued"; away
  players get their own line under the slots.
- **Seeded demo entries are born away** (`prisma/seed.ts`), so they dress a
  fresh `/inhouse` but never join a real lobby.

## Ready check and captain vote

- **A full lobby opens in READY_CHECK** with `acceptEndsAt`
  (`ACCEPT_SECONDS`, 90: players may be in a pub game; the Discord ping shows
  the deadline).
- **`acceptMatch` is idempotent, guarded on `acceptedAt: null` AND `lobby: {
  status: READY_CHECK }`,** so an accept can't land on a lobby a decline or
  expiry just cancelled. Zero rows plus a gone lobby answers "The match was
  cancelled".
- **The last accept flips via `startCaptainVote`, then starts `voteEndsAt`.**
  `resolveReadyCheck`'s all-accepted branch (before the expiry check) catches
  two final accepts that each missed the flip. A decline fails the check now;
  expiry fails it in `resolveReadyCheck` in both chains.
- **`failReadyCheck` re-reads `acceptedAt` AFTER winning the CANCELLED
  claim,** so an accept committed mid-cancel counts. Accepters requeue live
  with priority; a decline's still-pending players requeue backdated; the
  decliner and no-shows are dropped. `endReason` names come from the pre-claim
  snapshot (display only, never membership).
- **Gate the "Match cancelled" toast on MEMBERSHIP (`!me.inLobby`), never a
  status list** (`readyCheckEndedToast`), and word it by `me.inQueue`. A status
  list told dropped players they were requeued and could report a cancel for a
  match that had moved on to DRAFTING between polls.
- **Captain methods:** `VOTE` (elect), `MMR` (top two), `RECORD` (players with
  at least one inhouse win by record, everyone else after in MMR order, so a
  0-3 player never outranks newcomers). `tallyMethod` ties go `VOTE > RECORD >
  MMR`; every method falls back to MMR then earliest queued. Index 0 is team 1.
- **A ballot re-asserts `CAPTAIN_VOTE` and `voteEndsAt > now` at the write.**
  The vote resolves when all ten vote or `VOTE_SECONDS` runs out.
- **The vote previews use `orderCaptains`, the function that installs
  captains,** with `VoteCandidate.joinedAt` and `userId` as the final key. A
  non-total order let the server (Prisma row order) and room (name-sorted)
  name different captains from the same inputs; ties are normal on a young
  ladder.
- **Records are frozen at formation.** `maybeFormLobby` scans history once and
  writes `wins/losses/games` onto each lobby player; views and RECORD read
  those, so polls never scan history (no result can land meanwhile).
- **Snake draft:** `nextPickTeam` gives `F O O F F O O F` so summed pick
  positions match; team 2 picks first (`FIRST_PICK_TEAM`). An expired
  `PICK_SECONDS` clock auto-picks; pool and auto-pick sort MMR desc, then
  `[queuedAt, userId]`.

## Game setup

- **`GameSetupCard` shows ONE path once teams lock.** If the lobby bot answers
  (`DotaLobbyControls` `onAvailability` is "on"), its panel is the path and
  the by-hand steps plus the optional "Start the game clock" fold under "Bot
  not working?". Players never see a bot panel that can't help; admins keep
  its status line. See `docs/DOTA-LOBBY-BOT.md`.
- **By-hand values are constants:** `INHOUSE.LOBBY_NAME` (`<league name>
  Inhouse`), password `ggd2l`, `INHOUSE.LOBBY_TICKET` (from
  `LEAGUE_CONFIG.inhouseLeagueName`; Europe shows a placeholder until
  `NEXT_PUBLIC_INHOUSE_LEAGUE_NAME` is set), and `VOICE_TEAM_1` / `_2` with the
  viewer's side highlighted. The host must be a ticket admin.
- **The ticket is required:** Valve won't publish an unticketed private game to
  OpenDota, so it can't be recorded. The card says so.
- **Formation sets team 1 as Radiant; the played game may rewrite
  `radiantTeam`.** Colours follow the stored mapping (`sideMeta`).
  `inhouseLobbyCode` is only the "#1234" label.

## Results

- **OpenDota only, no manual winner.** `buildResult` validates a match with
  the league's `classifyGame` and stores the box score (`InhouseBoxPlayer`)
  with winner, sides, duration, scores and `dotaMatchId`. It refuses a
  zero-length game. Players need "Expose Public Match Data" on.
- **The played game is the truth.** Nothing enforces sides in a hand-hosted
  lobby and `classifyGame` is a majority vote, so a 1-for-1 slot swap still
  classifies. `buildResult` emits `teamFixes`; `applyResult` writes them in the
  COMPLETED claim's transaction, before the Elo scan (after it, the wrong five
  get the Elo). `isCaptain` stays. Move players; rejecting would strand the
  lobby.
- **One lookup, `lookUpLobbyGame`, for the worker scan and "Check now".** The
  bot's match id goes first, checked like a pasted id (never trusted alone);
  while OpenDota lacks it the history scan waits
  `DETECT_BOT_MATCH_WAIT_MINUTES`. `findInhouseGame` then needs a game in 4 of
  the ten recent-match lists and takes the newest started after formation.
- **Pasted and bot ids go through `checkMatchForLobby`:** the game must start
  after formation (yesterday's game can't replay) and needs 2 linked players
  per side, not the scan's 3 (the escape hatch when most data is private).
  `claimProviderCooldown` limits pasted ids per lobby.
- **Detection window** (`inhouseDetectWindow`, shared by service, gate and
  room): READY scans from `DETECT_READY_MIN_MINUTES` after formation,
  IN_PROGRESS from `DETECT_MIN_MINUTES` after `startedAt`, and the earlier
  opening wins so a late Start never closes an open window. Each scan claims
  `detectedAt`; `detectIntervalSeconds` stretches the gap with game age (180s
  to 1800s). A scan cut off by the worker deadline restores its own
  `detectedAt` stamp.
- **Throttle "Check now":** its `detectedAt` claim has a
  `DETECT_MANUAL_GAP_SECONDS` floor (a press is ~16 OpenDota calls; ten
  players could drain the budget league sync needs), and the button hides
  until the window opens (`inhouseScanStatus`).
- **`unreachable` is not "every fetch failed":** also true when failures leave
  too few lists to reach the 4-list threshold, but only if a fetch actually
  failed. Otherwise players get told to fix a privacy setting that is fine.
  Keep `fetchRecentMatchIds`' `null` (failed) distinct from `[]` (empty).

## Completion, Elo and publication

- **`applyResult` commits COMPLETED, `teamFixes`, `completedAt`, the result
  cursor and the durable RESULT outbox row in ONE transaction,** with no
  network call. The full-history Elo scan runs outside it.
- **`eloDeltas` needs a second claim on COMPLETED plus the exact
  `dotaMatchId`,** so a void that landed first wins. The post-game banner
  reads it; never re-derive the ladder on the poll path. After a crash between
  the two, `reconcileMissingInhouseResultAnnouncements` (worker, one-hour
  window so it never replays the archive) re-rates through that lobby only.
- **`completedAt` is the immutable result clock; `updatedAt` is not
  chronology** (the Elo stamp or a void moves it). The banner and the bare-form
  void key on `completedAt`; history and the board order by `[createdAt, id]`.
- **`matchStartTime` is Valve's start time,** so history, profiles and the
  board date a game by when it was played (`inhousePlayedAt`).
- **Publication is a durable outbox** (`inhouse-announcement-outbox.ts`, one
  row per `[lobbyId, kind]`). `inhouseResultMessage` (score, duration, `gameMvp`
  MVP, OpenDota link) goes to the inhouse ALERT webhook; a failed send stays
  PENDING for the worker.
- **Keep result recovery above the worker's idle early return.** `syncInhouse`
  (`result-sync-service.ts`) runs `reconcileMissingInhouseResultAnnouncements`
  before its `!active && queued === 0` return, and that return path still
  drains one inhouse announcement before repainting the board; only the phase
  resolvers are skipped. A finished game with nobody queued or polling is the
  usual state these repair, so below the return they would leave results
  unrated and unposted.
- **A void is ordered against its result.** `voidLastResult` flips COMPLETED to
  CANCELLED (ladder and history filter on COMPLETED, so Elo recomputes),
  cancels a PENDING RESULT, and queues a sequence-2 correction behind one
  SENDING or SENT. Every void posts a correction.
- **Both admin Voids name their lobby:** the room's banner sends
  `lastResult.lobbyId` and `/inhouse/history` sends its row
  (`voidInhouseResult`), so a result finishing between look and click can't
  redirect the void. The bare form (no `lobbyId`, newest by `completedAt`)
  survives only for API callers.
- **Keep the per-row Void on `/inhouse/history`.** The room's Void shows only to
  an admin who PLAYED that game, within 10 minutes of it ending (`lastResult`
  in `getInhouseState`), so the history row is the only control when players
  report a wrong auto-import to an admin who wasn't one of the ten.

## Ladder

- **Elo is derive-don't-store:** `summarizeInhouse`, start 1000, K=32, delta
  from side averages, in formation order. Always fetch ALL completed lobbies
  (no `take`). That recompute is what makes a void safe.
- **Only established accounts rank.** `rankInhouse` gives medals and "#N" to
  players with `PROVISIONAL_GAMES` or more; provisionals list after, dimmed.
  The `/inhouse` ladder and `InhouseCareerCard` both use it.
- **"This month" is a form ladder** (`/inhouse?ladder=month`,
  `summarizeInhouseMonth` in `inhouse-stats.ts`, tested): wins, then win rate,
  then games, then user id (a total order). A lobby counts by its immutable
  `completedAt` inside `leagueMonthWindow` (the league's clock), never
  `createdAt` or `updatedAt`. Players under `MONTH_MIN_GAMES` (3) are listed
  after the ranked block, unranked. `loadInhouseMonthLadder` keys its memo on
  the result cursor AND the month window, so a new month never serves the old.
- **The monthly board sums stored `eloDeltas`;** a player's net Elo is null if
  any of their games has no stamp. A later void of an earlier game recomputes
  the career ladder but not those stamps.

## The room (client)

- **Cadence comes only from pure `inhousePollCadence`** (`src/lib/room-poll.ts`,
  sharing `roomPollCadence` with the draft room). A source guard fails if
  `INHOUSE.POLL_IDLE_MS` or `POLL_KEEPALIVE_MS` reappear in the room.
  - Fast (`pollMs`, 1500) only for timed stages: ready check, vote, draft, and
    READY until the scan window opens (`inhouseReadyInPlay`, after which a
    hand-hosted game polls like IN_PROGRESS and drops "(!) Teams locked").
  - Otherwise `POLL_QUEUE_MS` when queued, `POLL_GAME_MS` in a game,
    `POLL_IDLE_MS` spectating.
  - Hidden with a stake (queued or in a lobby): `POLL_KEEPALIVE_MS`, which must
    stay shorter than the accept and vote windows (`room-poll.test.ts`).
    Hidden with no stake: no fetch. `isColdStart` gives a tab hidden at load a
    few bounded attempts, since stake is learned from a payload.
  - A warm-room 429 eases to the idle rate and is not a failure; on a cold
    page 429s count toward the retry state (else "Loading" forever). Offline
    sends nothing.
  - Reschedule from live visibility (refocus mid-fetch snaps back);
    `visibilitychange → visible` polls at once; a successful `act()` nudges the
    loop (`bumpPollRef`) so a join goes fast within ~250ms.
- **Sequence-order every response** (`issueSequence` / `acceptSequence`) for
  poll AND `act()`: a late pre-pick poll put the drafted player back in the
  pool. Mint the sequence BEFORE the `await` and keep `apply()` the only
  writer of room state; `src/components/room-source-guards.test.ts` checks
  both, reading the shell and the stage folder as one room. `apply()` also
  folds the payload's server `now` into the clock offset (`nextClockOffset`,
  1s hysteresis), so vote and pick clocks run on server time.
- **Every room fetch has an `AbortSignal.timeout`** (`ROOM_POLL_TIMEOUT_MS`;
  actions `ROOM_ACTION_TIMEOUT_MS`, or `INHOUSE_SCAN_ACTION_TIMEOUT_MS` for
  `INHOUSE_SCAN_ACTIONS`). A timed-out, 5xx or unreadable action may have
  committed: say it is checking, keep controls locked until a poll that
  STARTED after the action lands, and never say it failed. A poll that started
  before an offline/online change is stale.
- **Bell and title are pure** (`inhouseAlerts`, `inhouseTitleFlag`), fed by one
  previous-poll snapshot ref that also drives the cancelled toast.
  - `prev === null` never rings, so a mid-lobby reload is silent.
  - All alerts OR into ONE `playChime()` (two double-strike the AudioContext).
  - `lobby-formed` keys on the lobby appearing (a hidden tab may first see
    CAPTAIN_VOTE); `vote-opened` needs previous status exactly READY_CHECK so
    that case rings once.
  - `game-ended` keys on `lastResult.lobbyId`: the active-lobby query drops
    COMPLETED and CANCELLED alike, so an admin cancel would ring a win.
  - The title is state-derived, ungated by the sound toggle, and each nag stops
    once the player accepted or voted.
  - Prime audio on the first `pointerdown`: `?join=1` arrivals and reloads
    haven't clicked yet.
- **`avgKnownMmr` is the ONLY team-average MMR:** 0 is unknown and excluded.
  `mmrBalance` wraps it for the drafting chips and "X ahead by N avg MMR". A
  copy dividing by the whole roster flipped a side's strength when the last
  pick landed.
- **Other surfaces:** a compact fixed clock bar in the ready check and vote
  (`useBannerOffscreen`, `top-16`); "Run it back →" with its dismissal in
  localStorage (`e2e/inhouse-storage.spec.ts` covers blocked storage);
  `router.refresh()` when a lobby ends or after a void; `shouldFocusStage`
  scrolls a member's stage into view once per stage. `/inhouse/history` shows
  `INHOUSE_HISTORY_PAGE_SIZE` games a page. `/inhouse` page order is in
  `docs/features/pages-and-ui.md`.

## Inhouse night

One evening an admin sets aside for inhouses, so players know when to show
up, and say they're coming (DECISIONS.md, 2026-10-08). Rules:
`src/lib/inhouse-night.ts` (pure); storage and Discord:
`inhouse-night-service.ts`; players' "I'm in": `inhouse-night-rsvp-service.ts`
and `src/app/actions/inhouse-night-rsvp.ts`; admin:
`src/app/actions/admin-inhouse-night.ts` and
`src/components/admin/inhouse-night-controls.tsx` (the Inhouse night card);
site: `src/components/inhouse-night.tsx`. Tests: `inhouse-night.test.ts`,
`test/integration/inhouse-night.itest.ts`, `e2e-mid/zz-inhouse-night.spec.ts`.

- **One night at a time, in one Setting row** (`SETTING_KEYS.INHOUSE_NIGHT`:
  id, start, note, revision, the Discord event's id). No migration. A save
  moves an upcoming night (same id, revision + 1) or, once the last night has
  started or is over, plans the next (new id). A note-only save rewords the
  event and posts nothing.
- **Every write is a compare-and-swap on the exact stored value.** The admin
  form carries the night it showed (`expectedNightId`, `expectedNightRevision`)
  and a save from a stale page is refused. `swapInhouseNight` and
  `attachInhouseNightEvent` are ratchet claims (seams
  `inhouseNight.save.beforeSwap`, `inhouseNight.clear.beforeSwap`).
- **Discord runs after the save, best-effort** (`publishInhouseNight`,
  `withdrawInhouseNight`). A new night creates the server event (an EXTERNAL
  event at `/inhouse`, three hours long, which Discord starts and ends by
  itself), stores its id by swap (an event made for a night that changed
  meanwhile is deleted again), then posts in the inhouse alert channel
  pinging the inhouse role, with the event's link bare so it unfurls with its
  Interested button. A move patches the event (or makes a new one if it was
  deleted in Discord) and posts without a ping. Cancelling an upcoming night
  deletes its event and posts that it's off; a started night is left to end.
  The toast says what happened on Discord; nothing there undoes the save.
- **The start post pings once** (`announceInhouseNightStart`, a worker step in
  `runResultSync`): from the start until `INHOUSE_NIGHT_START_POST_WINDOW_MS`
  after, behind the marker `inhouseNightStartKey(id, start)`, so a moved night
  posts again at its new time and a late worker never pings hours after. It
  re-reads the night after its claim and releases the claim if it moved
  (seam `inhouseNight.start.afterClaim`). With nowhere to post (no webhook, or
  a preview) it records the marker as covered. The automation gate wakes the
  worker at the start and follows the marker through the window. Besides the
  role it pings each player who said "I'm in" on the site with a linked
  Discord account, first to say so first (`inhouseNightStartMessage`): the
  nudge Discord gives its own Interested members. Only mentions that fit the
  2,000-character post (at most `INHOUSE_NIGHT_START_PINGS_MAX`) are
  allowlisted; the rest, and players with no linked account, are counted.
- **Players say "I'm in" on the site** (`setInhouseNightRsvp`, one
  `InhouseNightRsvp` row per player keyed by the night's id, which isn't a
  foreign key: the night is a Setting row). Discord has no way for a bot or a
  site to mark someone Interested on its event (members mark only
  themselves), so the site keeps its own list. Any signed-in player can say
  so while the night is ahead (`inhouseNightRsvpOpen`); once it's on, the
  queue is the way in. "I'm in" is one toggle on the bar and the card
  (`InhouseNightRsvpControl`, pressed once you're in), and pressing it again
  takes you off; it stays for someone in after the start, so taking it back
  is never hidden, and works even for a night that changed. The form names the night its page showed, and a night that changed
  or ended meanwhile is refused. A move keeps the list (Discord keeps its
  Interested members through a move too); planning the next night prunes
  every other night's rows and a cancel prunes that night's, never all rows,
  so a late prune can't take a newer night's list. The pruning is
  best-effort after the save. **The race is left open on purpose:** a save
  or cancel landing between a player's check and their insert leaves at
  worst a row for a night that's gone, which every read (filtered by the
  current night's id) ignores and the next prune removes; a player's two
  taps meet at the primary key and the second reads as already in.
- **The headcount adds the two lists** (`inhouseNightHeadcount`): the site's
  "I'm in"s plus the Discord event's Interested members
  (`guildEventInterested`, the member list paged 100 at a time up to
  `GUILD_EVENT_INTEREST_MAX_PAGES`, reused for two minutes, null when
  unknown), a player on both counted once when their linked Discord id is
  among them. "12 coming" once Discord's list is read; "5 said I'm in" when
  it couldn't be, so an outage never reads as fewer people coming. Linked ids
  stay on the server (`readInhouseNightRsvps` returns display fields to the
  page and the ids beside them only for the count), and the page names only
  the site's "I'm in"s, never who is Interested on Discord.
- **On the site it shows until the night is over** (`currentInhouseNight`:
  the start plus `INHOUSE_NIGHT_LENGTH_MS`, the countdown's live window).
  A thin bar leads Home in every phase, the offseason too (`InhouseNightBar`):
  the time on the viewer's clock, the countdown, the headcount and "I'm in"
  (a sign-in link back to Home when signed out), or, once the night is on,
  the queue count and "Join the queue" (`/inhouse?join=1`). Home's inhouse
  strip no longer repeats the night; it says "Jump in" while it's on.
  /inhouse puts a card above the room with the note, "I'm in", the headcount
  with its sources, who said they're in on the site, the Discord event link,
  Google Calendar and an `.ics` download (`/api/calendar/inhouse-night`, one
  event whose UID and SEQUENCE are the night's id and revision). The Discord
  half of the headcount streams, so a slow Discord never holds a page; the
  bar itself renders inline, so it never drops in above a painted hero.

## Testing

- **Extract room rules into pure tested functions plus a source guard** that
  the room calls them (vitest is `environment: "node"`; the room can't render
  in a unit test). Fallback: a Playwright spec
  (`e2e/zz3-room-poll-resilience.spec.ts` interception pattern). jsdom last.
- **e2e:** `e2e/zz4-inhouse.spec.ts` (join/leave with a phone overflow check,
  then accept to in-progress with nine API players, zero page errors);
  `e2e/zz5-inhouse-history.spec.ts` (history and admin void).
- **SQLite hides every race here.** `test/integration/inhouse*.itest.ts` stage
  races by hand; `npm run test:pg` runs them on Postgres. Run it after touching
  any claim. Seams are `inhouse.<function>.<point>`.

## Cred betting (removed)

- **Cred is gone; nothing in `src` reads or writes it.** Reviving wagering
  needs a fresh design from `docs/archive/inhouse-betting-design.md` (its
  "rejected outright" list still holds), not a revert.
- **Its tables stay as history:** `InhouseBet`, `InhouseCredit`,
  `InhouseCreditEntry`, and `InhouseLobby.betsCloseAt`, `betSettlement` (and
  its index), `betDeltas`. Don't drop them without a destructive migration Tim
  approves. Their schema comments describe the removed feature.
- **`InhouseLobby.matchStartTime` is live,** despite sitting under the schema's
  betting comment.
- **Name `InhouseCreditEntry` in every database reset.** It has no foreign key,
  so deleting users leaves it; `prisma/seed.ts`,
  `scripts/seed-signups-fixture.ts` and `scripts/inhouse-night-check.ts` delete
  it explicitly.
- **Keep `deliverableInhouseContent` in the outbox.** Unsent rows retry with no
  age cutoff, and one written before the removal still carries the pot line or
  a Cred void wording; it strips or re-renders them.
