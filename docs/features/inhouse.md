# Inhouse games

Casual pick-up games: a global queue, a ready check, a captain vote, a snake
draft and an OpenDota result feeding an Elo ladder. Rules: `src/lib/inhouse.ts`,
`inhouse-stats.ts`. Engine: `src/lib/inhouse-service.ts`. Endpoint:
`POST /api/inhouse`. Room: `src/components/inhouse-room.tsx` (shell) plus one
file per stage in `src/components/inhouse/`. Lifecycle overview:
`docs/ARCHITECTURE.md` section 3. Board and pings: `docs/features/discord.md`.
The 1v1 mid queue and its duels (their own tables, card, bot lobbies,
worker steps and leaderboard on the same page and room) are
[inhouse-duels](inhouse-duels.md); the room's reply carries them as an
additive `duel` block after every 5v5 field.

## Scope and where it runs

- **No `seasonId`, no phase gate.** Inhouse runs in every phase and the
  offseason, sharing identity, the latest `Registration.mmr`, Settings,
  `AdminAction`, Discord and OpenDota. The nav link is always visible.
- **Tim's calls bind** (`docs/DECISIONS.md`): keep every inhouse feature, the
  captain vote and the Discord board; never hide or de-promote the queue, even
  empty; don't gate Europe's inhouse on its ticket; no retire checkpoint or
  rally button unless Tim asks. The planned-time features are the ones he
  asked for: the admin's inhouse night and the players' own Play later times.
- **Status flows `READY_CHECK → CAPTAIN_VOTE → DRAFTING → READY → IN_PROGRESS
  → (AWAITING_RESULT →) COMPLETED | CANCELLED`, with up to two live lobbies,
  one per game slot** (`INHOUSE_ACTIVE_STATUSES`, `INHOUSE.MAX_LIVE_GAMES`;
  see "Two games at once" below). A lobby is played from team lock:
  `INHOUSE_PLAYING_STATUSES` is READY and IN_PROGRESS, and Start is optional.
  Both IN_PROGRESS writers (`startGame`, and the bot launch
  `markInhouseGameStartedFromBot`, run by a lobby panel's read and by the
  worker's bot read) are guarded on READY and stamp `startedAt`. AWAITING_RESULT is a game marked over whose result is on the
  way: not live, not playing, but a result still lands on it
  (`INHOUSE_RESULT_STATUSES`; see "Game over" below).
- **Two chains run the resolvers; keep them the same SET.** `getInhouseState`
  (the room's maintenance pass) and `syncInhouse` in `result-sync-service.ts`
  (the bearer-authenticated one-minute worker at `/api/cron/automation`, which
  reaches a lobby nobody watches). A resolver missing from one fails silently;
  `src/lib/inhouse-resolver-parity.test.ts` compares the sets (the room's
  slice ends at `const rows = await loadInhouseRoomRows(`) and holds
  `REASON_RESOLVER` to the room's chain. The order differs on purpose (the
  room runs the abandon sweep first so a freed slot re-forms on the same
  poll), so never make it compare order. `GET /api/sync` is read-only.
- **A room poll runs maintenance only when something is due and it wins the
  fleet-wide 2s claim** (`pollInhouseState`, `src/lib/inhouse-room-state.ts`;
  the reply is the same `InhouseState`). The pure `inhouseRoomDue`
  (`src/lib/inhouse-room-due.ts`) mirrors each resolver's act condition at its
  exact boundary: the three abandon floors (strict lt), the 4h queue idle
  reset, formation (a free slot by `freeGameSlot` and `LOBBY_SIZE` present),
  all accepted, all voted, a lost pick turn, and the accept, vote and pick
  clocks (`<= now`); a null clock is never due. Where a resolver decides in JS
  both call one predicate (`inhouseAllAccepted`, `inhouseAllVoted`,
  `inhouseDraftPool`, `inhouseClockDue`); the claims' WHEREs stay the
  enforcement. With work due, the signed-in poll that wins `claimThrottle` on
  `inhouseRoomMaintenanceAt` runs `getInhouseState(viewer, { runMaintenance:
  true, detectResults: false, syncBoard: true })`; losers only read.
  - **Change a resolver's act condition and its due clause together.** A
    missing clause is a lobby only the worker moves, and dev and e2e have no
    worker. `pollInhouseState` never calls a resolver itself (source-guarded
    in `inhouse-room-state.test.ts`).
  - **Keep `getInhouseState`'s defaults** (maintenance, board and detection
    on; heartbeat first, then the chain, then fresh reads): its integration
    callers and `scripts/inhouse-night-check.ts` expect a full pass. Gate on
    due only in the opt-in poll path.
  - **Anonymous polls only read:** no heartbeat, claim, publish, board,
    resolver, Discord or OpenDota, so spectators never advance a lobby. Room
    polls never scan OpenDota: the worker owns the automatic scan.
- **Each server instance serves the room from one snapshot, checked against
  the room version on every poll** (`src/lib/inhouse-room-cache.ts`). On the
  box one process serves each league, but two do for the 90 seconds of every
  release's overlap (and Vercel ran many), so every rule here holds. The
  snapshot is `loadInhouseRoomRows`: the queue, live games, games marked over,
  the last `LAST_RESULT_WINDOW_MS` of results with their `eloDeltas`, and the
  signup-roles batch. Its label is the `inhouseRoomVersion` Setting
  (`src/lib/inhouse-room-version.ts`), an opaque randomUUID compared only for
  equality.
  - **The route reads the version beside `getSessionUser()`, and the label is
    read BEFORE the rows.** A poll serves the stored copy only when its label
    equals the version just read, this instance has not published since the
    load began, and it is younger than `ROOM_SNAPSHOT_MAX_AGE_MS` (15s). So
    every change published before the poll is in its reply, on any instance,
    and the room's request-start ordering holds with no client field. A TTL
    cache or a client freshness floor would break it (a drafted player back in
    the pool, the pick chime again).
  - **One pure builder serves both paths:** `buildInhouseState(viewer, rows,
    extras, nowMs)`, with `now` stamped per reply. `loadViewerExtras` reads
    nothing when the rows hold the viewer. A hit for a queued or playing
    viewer costs two statements (the session and the version).
  - **No version row means uncached:** every poll reads fresh and nothing is
    stored. Polls never create the row, so anonymous polls stay write-free.
  - **Loads are single-flight** per version and local generation. An older
    load never replaces a newer one, a rejected load is never kept, and rows
    are deep-frozen outside production. `resetInhouseRoomCacheForTests()` runs
    in `test/integration/setup.ts`.
  - **The rows hold every ballot: server memory only,** never serialized,
    returned or logged. Ballots leave only as the viewer's `myVote` and the
    tallies; `isAdmin` and the role come from the session on every request.
- **Rule P: after any commit the room shows, call
  `publishInhouseRoomChange()` before any Discord or OpenDota call and before
  the response. Never inside a transaction:** the hot Setting row would add
  P2034s to the Serializable `joinQueue` and `formOneLobby`, and
  `formOneLobby` takes those as "someone else formed", so formation would
  silently slip. It bumps the process's generation first, then runs one
  `INSERT … ON CONFLICT` (`claimThrottle`'s shape), retries once, logs only
  the error code and never throws. After the statement, landed or not, it
  wakes the requests held in this process (the long-poll, below).
  - **The sites are a closed set.** The route publishes right after the
    dispatch (ok and refusal), before its follow-up read: that read is
    several round trips, and a poll the client sent during the action must
    not find the old version all that time. It publishes again in its outer
    finally (the follow-up read's heartbeat, or an action that threw), before
    the gate expiry. `getInhouseState`'s maintenance block: one unconditional
    publish in a finally around the chain, so a resolver that throws still
    announces what the ones before it committed, and before the reads and the
    board edit (`formOneLobby`'s queue reset returns false and
    `resolveStalledPick` drops `restoreLostPickTurn`'s result, so
    per-resolver bumps would miss writes). `syncInhouse` after `resolveStalledPick`, plus a try/finally
    around its call. `formOneLobby` before its ping (which goes after the
    response, below) when it formed or `expireStaticQueue` deleted rows.
    `joinQueue` before forming. The
    auto-detect claims and their deadline rollback. `applyResult` and
    `voidLastResult` before delivery (the admin `voidInhouseResult` too;
    `voidLastResult` after its result-cursor stamp, so a board check that
    sees the new version reads the post-void stats). The
    bot's IN_PROGRESS write when it lands. The outbox reconcile when it
    committed (its `eloDeltas` show in `lastResult`). `/api/test/cache`. The
    login upsert, the Steam refresh and the signup save. An admin's inhouse
    MMR and medal (`saveInhouseRating`, after its commit).
  - **`src/lib/inhouse-room-publish.test.ts` guards them.** Every src file
    outside the engine that writes the room's tables publishes. Every importer
    of an engine writer publishes or imports only self-publishing ones. No
    publish sits in a `$transaction`, and each listed site comes before its
    provider call.
  - **Writers that never publish show within the 15s max age, and wake no
    held request:** a long-polling viewer sees them when something else
    publishes, or else within about 40s: a hold that ends by itself (25s)
    may still be served a snapshot up to 15s old, and the next hold is
    another 25s. They are admin display edits, the
    worker's rank refresh and profile writes outside the room's flows, such
    as a relinked Dota account's medal (`docs/DECISIONS.md`). So does a lost
    publish. During a release's overlap the old slot's writes reach a held
    request through the 2s watch. A new writer the room waits on publishes.
- **The room long-polls on the version (Tim's call, 2026-10-18; still plain
  HTTP, no websockets).** A `state` reply carries `roomVersion`
  (`inhouseRoomVersionToken`: the version, or `"none"` with no row yet),
  read BEFORE the reply's rows, so the rows are at least that new; never
  put a later read's version on a reply, or a client holds on a change it
  never saw. A request that sends it back as `since` (and the `holdMs` it
  can wait, clamped to `LONG_POLL_HOLD_MS`, 25s, by `parseInhouseHold`) is
  held when the version the route just read is still `since`: anything
  else answers at once through the unchanged `pollInhouseState`. After the
  hold the route reads the session and the version again and polls exactly
  as an unheld request would (heartbeat, due gate, 2s claim). Signed-out
  requests hold too and still only read. A client that went away gets a 204
  and no poll (`req.signal`).
  - **The hold (`holdInhouseRoomPoll`, `src/lib/inhouse-room-state.ts`)
    reads only this instance's snapshot and board memo, and writes
    nothing.** It ends at the earliest of: the version moving, the room's
    next clock (`inhouseRoomWakeAt`, `src/lib/inhouse-room-wake.ts`: accept,
    vote and pick deadlines, the result window opening, the abandon floors,
    the queue's idle reset and each player turning away, the viewer's
    post-game banner ending, `LAST_RESULT_WINDOW_MS` after the game, and for
    a signed-in viewer a throttled board edit's retry, all plus
    `LONG_POLL_CLOCK_GRACE_MS`), the hold, the process stopping, or the
    abort. A signed-in viewer who finds work already due (another poll holds
    the 2s claim) is held at most `LONG_POLL_DUE_RETRY_MS` (2.25s), so work
    nobody finished is retried at a fast poll's pace. A new clock the room's
    reply or a resolver flips on gets a clause there as well as in the
    automation gate.
  - **Clocks count from the reply the client shows, not from the hold.**
    The request sends that reply's `now` as `sinceNow` (`parseInhouseHold`
    clamps it to the last two holds, and to now); a clock that ran out
    after it answers at once, since that reply is already stale. That is a
    tab back from a hide, a request after a 429's back-off or a resumed
    tab, whose reply predates a deadline or a result window. Each such
    clock answers once: the next request sends the newer reply's `now`.
  - **A stopping process answers every hold at once.** `next start` handles
    SIGTERM by closing the server and waiting for every request in flight,
    so a slot stopped while it holds viewers (a rollback right after a
    promote, a restart of the live slot) would wait out a hold, up to 25s.
    The first hold in a process installs one SIGTERM listener beside Next's
    own, never at module load (a SIGTERM listener turns off Node's default
    exit; where nothing else listens it hands the signal back, so a script
    or a test worker still exits). It settles every waiter as a deadline,
    so each answers through the ordinary poll, and a new hold answers at
    once from then on, reported unheld (`held: false`) so the tab backs off
    to its ladder. A slot Caddy no longer routes to (a rollback or retire
    after a promote) then drains in one poll. One Caddy still routes to (a
    restart of the live slot) keeps getting requests on its open
    connections until it exits, at the ladder's rate, within
    `TimeoutStopSec`.
  - **The waiter registry is one per process, on `globalThis`**
    (`src/lib/inhouse-room-wait.ts`, a leaf: the inhouse binding of the
    mechanism in `room-wait.ts`, which the draft room's long-poll shares
    under its own key; the version publish is `room-version.ts` the same
    way), with the snapshot's publish
    count: a `next start` process loads `src/lib` twice (route handlers in
    one module instance, pages and server actions in another), so a
    module-scope registry would never hear the signup save or the admin
    void. A held request takes no database connection. A publish here
    re-checks the version once, `LONG_POLL_COALESCE_MS` (100ms) after its
    statement (a mutation publishes twice), and wakes the requests it moved
    past, each after up to `LONG_POLL_JITTER_MS` (150ms) more at random
    (Prisma's pool is four). While anything is held one timer re-reads the
    version every `LONG_POLL_WATCH_MS` (2s): the other slot's publishes
    during a release's overlap, and writes outside the process.
  - **A publish racing the route's version read re-checks the hold at
    once.** A publish counts itself twice, when its statement starts
    (`generation`, the snapshot's fence) and when it has run (`landed`, in
    its wake). The route reads both (`inhouseRoomHoldMark()`) before the
    version, and a hold that finds the mark moved by the time it registers
    re-checks after `LONG_POLL_COALESCE_MS` rather than trust that read. That
    covers a publish that started before the read and whose wake ran before
    the hold registered, when nothing was held to wake. Only a publish in
    another process waits for the 2s watch.
  - **A release's overlap is safe both ways.** A new slot's held requests
    see the old slot's publishes through the watch, and the old slot answers
    its own within a hold (25s, inside the 90s overlap). An old slot answers
    `since` at once with no `roomVersion`, and the room falls back to its
    ladder (below), never a hot loop.
  - **Tests:** `src/lib/inhouse-room-wait.test.ts` (the registry: publish,
    coalescing, the watch, abort, deadlines, the jitter's bounds and its
    wait, the mark's two counts, two module instances sharing it and a
    per-module copy missing it, the stop: every hold and every new one
    answered, one listener per process from the first hold, and a child
    process stopped beside a server's own handler and without one, and the
    `sinceNow` clamp), `inhouse-room-version.test.ts` (the publish
    wakes held requests only after its statement, and a publish already
    running at the route's read still wakes promptly; deleting the wake call
    or the `landed` count fails them),
    `inhouse-room-wake.test.ts` (each clock against `inhouseRoomDue`, the
    shown reply's clock, the banner and the board retry),
    `src/app/api/inhouse/route.test.ts` (hold, re-read, abort, `held`, the
    `sinceNow` clamp) and
    `test/integration/inhouse-room-longpoll.itest.ts` (through the real
    route: a join, a server action in another module instance and a version
    moved elsewhere each answering a held request well under a second, the
    clock and the claim retry, a signed-out hold that never retries due
    work, a clock run out since the shown reply, the board retry, `held`, an
    abort, and about one request per change plus one per hold).
    A second PROCESS in an itest is a module graph loaded through
    `loadAsAnotherProcessForTests` (`inhouse-room-wait.ts`); a plain
    `vi.resetModules()` graph shares this process's registry and publish
    count, as a `next start` process's two module instances do.
- **Give every new lobby or queue clock a wake-up in
  `src/lib/automation-gate.ts`,** which schedules the worker for accept, vote
  and pick deadlines, the detect window, abandonment floors and queue
  idle/away transitions. Mutations call `invalidateAutomationGateBestEffort()`.
  So do a poll that won maintenance, flipped its viewer back to present or
  edited the board, and the bot's IN_PROGRESS write when it lands.
- **Never make a mutation wait on Discord.** Mutations answer with
  `getInhouseState(user, { runMaintenance: false, syncBoard: false })`. Only a
  claim winner or the worker repaints the board. That is the maintenance
  winner, or, with nothing due, a signed-in poll whose board check is due
  (`boardCheckDue`) and that wins the same 2s claim.
  - **The pings go out after the response** (`runAfterResponse`, Next's
    `after`): the match-found ping (`maybeFormLobby`) and the queue's
    milestone ping (`joinQueue`, whose throttle claim still decides in the
    request). A Discord post can take 5s, and the tenth joiner's POST, a
    "Game over" press or a room poll that won maintenance would otherwise
    hold it, with the joiner's controls locked. They stay after the publish
    (rule P). The worker alone sends the match-found ping at once
    (`maybeFormLobby({ pingAfterResponse: false })`): its response comes
    after a pass of up to 45s, which would eat the 90s accept window, and
    nobody waits on it. Outside a request (scripts, tests) the ping is sent
    inline. Tests: `test/integration/inhouse-pings.itest.ts`, and the call
    sites in `inhouse-room-publish.test.ts`.
  - **The check is due on a new key, 60s (`BOARD_RECHECK_MS`) after the last
    check, or after a `throttled` or `failed` outcome.** The key is this
    instance's: the room version (a digest of the board input while none
    exists) plus the present ids and the away count, so a presence flip no
    write made still repaints.
  - **A throttled edit wakes the signed-in holds when it can get through**
    (`boardRetryAtMs`: `BOARD_MIN_SECONDS` after the check, never inside a
    lost claim's back-off; at most one wake per 10s per viewer until it
    lands), as the ladder's next poll used to retry it. A `failed` edit
    waits for the hold's end: its own back-off is 20s and up.
  - **A lost claim backs this instance off for `BOARD_CLAIM_BACKOFF_MS`
    (2s).** Signed-out polls never check. Don't make every poll sync the
    board to "fix" this.
- **API contract:** `state` plus `join`, `leave`, `accept`, `decline`, `vote`,
  `pick`, `start`, `finish`, `roles`, `record`, `detect`, `cancel`, `giveup`,
  `void`, `remove`. The body must be a JSON
  object with a non-empty string `action`, else 400. Lobby actions carry the
  `lobbyId` the room showed. `state` takes an optional `since` (a reply's
  `roomVersion`, at most 64 characters), `holdMs` and `sinceNow` (the shown
  reply's `now`), and its replies carry `roomVersion` and `held` (whether
  this request was held); mutation replies carry neither. `state` allows 1,200/min
  per IP (a held request counts once); mutations 300/min per signed-in user
  (signed-out attempts are IP-limited, then 401), in a separate bucket so
  poll back-pressure never eats an action allowance.

## Two games at once

Twenty queued players play two games side by side (Tim's call, 2026-10-09).
`INHOUSE.MAX_LIVE_GAMES` is 2; anyone past that waits for a game to finish or
be marked over.

- **Every live lobby holds a game slot** (`InhouseLobby.slot`, 1 or 2).
  `maybeFormLobby` loops `formOneLobby`, which takes the lowest free slot
  (`freeGameSlot`) and the first ten present players, so a lone game is
  always game 1. A cancelled or finished game's slot is the next game's.
  The migration preflight (`scripts/migration-preflight.mjs`) refuses two
  live lobbies in one slot, not two live games, so a release can run during
  an inhouse night.
- **Nobody is in two live lobbies.** `joinQueue` refuses anyone in a live
  lobby and formation deletes the ten's queue rows, both Serializable, so the
  two LIVE games' players never overlap. A game marked over is not live, so
  its ten can be in the next game while its result is on the way: the Elo
  stamp, the result window and the per-player action lookup are written for
  that (see "Game over"), and the frozen records may be one game behind.
- **Every action names its game.** The room sends the `lobbyId` it showed;
  `chooseActionLobby` judges that lobby, and each action re-reads it with its
  own phase filter, so a stale click never lands on the other game. Without
  an id (a page from before two games, an API caller) it falls back to the
  caller's own lobby, then the one lobby in that phase, and refuses with
  "Two games are live" rather than pick one. An admin cancel names its game.
- **Resolvers walk every lobby in their phase** (`lobbyIdsIn`), one
  transaction each, so a game waiting on its clock never holds up the other.
  The result scan goes stalest `detectedAt` first, so a pass that runs out of
  time on one game leaves the other first in line. The automation gate wakes
  for the earliest clock of every live game, and for formation only while a
  slot is free.
- **The room shows the viewer's own game; every `me` flag is about it.**
  The room payload (`buildInhouseState`) has `lobby` (the viewer's, or null),
  `otherLobbies` (read-only, game order), `liveGames` and `maxLiveGames`. The
  room renders
  other games with `otherGameFlags` (an admin keeps start, record, pick and
  cancel, each naming the game); beside the viewer's own game they fold to
  one line. Only the viewer's game (or the one game a spectator watches) pins
  a clock bar. The poll rate follows `pollingLobby`, and the page below
  refreshes when a game ends (`liveGameEnded`). A lone game 1 reads exactly
  as one game always did; a game is named ("Game 1") once two are live, and
  game 2 always, since its channels and lobby name differ (`showGameLabel`).
- **Elo stays correct with overlap.** `summarizeInhouse` rates in formation
  order (id breaks a tie), and since the two games' players are disjoint, a
  later-formed game finishing first never changes the other's deltas.
- **One bot sets up one lobby at a time, and leaves each game once it is
  under way** (docs/DOTA-LOBBY-BOT.md#early-leave; DECISIONS 2026-10-28,
  `DOTA_BOT_EARLY_LEAVE=duel,inhouse`). Once every player has loaded and the
  hero draft is on (DECISIONS 2026-10-30) the bot sends AbandonCurrentGame
  and a Leave; once Dota confirms it, the bot is free for
  the other game's lobby, so two 5v5s, or a 5v5 and a 1v1, play side by
  side. A leave Dota doesn't confirm (tried twice) leaves the bot in the
  game to its postgame, as before 2026-10-28 (DECISIONS 2026-10-18): the
  other game's Create answers BUSY meanwhile, and its card says the bot is
  free again once it leaves that game, "usually a few minutes after it
  starts (or when it ends)", with the by-hand steps for starting sooner. A
  game the bot has `left` reads "Game running — the bot has left it": the game stays IN_PROGRESS,
  its result still records itself by the bot's match id, "Game over — queue
  again" still frees its ten, it never counts as a failed launch or as over,
  and `botBusyElsewhere` never names it. A 1v1 mid lobby holds the bot like
  any game once its game has started
  ([inhouse-duels](inhouse-duels.md#the-lobby-bot)). Before that the 5v5
  comes first: no 1v1 lobby is created while a 5v5 is being set up, and a
  1v1 lobby made before the 5v5 formed (its game not started) reads to the
  5v5's panel as one Create frees (`botBusyElsewhere` says closed and
  `unstarted`, never the hand-hosting latch): the 5v5's Create answers BUSY,
  releases that 1v1 lobby (`freeBotFromClosedInhouseGame(kind)`) and asks
  for a second press. The 1v1 stays READY and gets a fresh lobby later. A
  1v1 that has started holds the bot until it leaves, and a 5v5 then is
  hosted by hand, as with any running game, until the bot leaves it.

## Game over (result pending)

Tim asked on 2026-10-09: a game ends in Dota 10 to 30 minutes before
OpenDota publishes it, and the queue used to refuse its ten (and hold its
slot) until then. That night's game (2026-10-10 UTC) ended about 00:50 and
recorded at 01:11, and the night stalled. OpenDota can't be hurried: its
match page needs Valve's sequence-number feed (`GET /matches` is empty until
then, and `POST /request` only queues a replay parse). A player's press was
the only signal until 2026-10-18; since then a bot-hosted game also ends by
itself when the bot sees Dota's postgame (below).

- **"Game over — queue again" (`finishGame`, action `finish`)** moves a game
  being played (READY or IN_PROGRESS) to AWAITING_RESULT and stamps the
  immutable `finishedAt`. Not in `INHOUSE_ACTIVE_STATUSES`, so the slot, the
  index, `joinQueue` and formation treat it as over at once. A player's press
  also queues them (`requeue`, their own join after the claim); an admin
  watching sees "Admin: mark game over". The room toasts the other nine
  (`gameMarkedOverToast`, keyed on their game turning up in
  `pendingResults`, so an admin cancel stays silent).
- **One predicate says when:** `inhouseGameOverOpen` (playing status and the
  result scan's window open), in the room and in `finishGame` alike, the
  moment "Check OpenDota now" appears. A press frees the slot's voice
  channels and hand-hosted lobby name, so it is the floor against a press
  during set-up. Unlike `inhouseScanStatus` an unknown window is closed.
- **Refused while the bot holds an unlaunched lobby** for that game and is
  online (creating, ready or starting: `botHoldsUnlaunchedLobby` over the
  bounded `inhouseBotGameStatus` read; unknown never blocks). A pending
  release (`releasing`) doesn't hold it: the bot is already leaving, and its
  Start and invites refuse while Release is hidden. The refusal
  (`botGameOverRefusal`) names "Start game with bot" and "Release bot…" only
  for a ready lobby, where both show; while the bot creates or starts the
  lobby it says to try again in a minute. Once the game
  left the room nobody but an admin could release it, and it answers BUSY to
  every other game. "Blocked" doesn't hold it back: an offline bot reports
  it too, when its Release can't work either. Bot recovery
  (`recoverableInhouseBotLobby`) and Create's BUSY self-heal treat
  AWAITING_RESULT as closed (one lookup, `closedInhouseLobbyForBotKey`), so
  the bot is released later. A launch that fails (someone can't load, the server never
  starts, Dota calls it not scored) releases the bot itself, so the bot never
  holds the press back, and the captains can instead press "Create Dota
  lobby" to try again
  ([DOTA-LOBBY-BOT: Failed launches](../DOTA-LOBBY-BOT.md#failed-launches)).
- **The claim:** `updateMany({ id, status in PLAYING })` behind the seam
  `inhouse.finishGame.beforeClaim`; it loses to a result, a cancel or the
  abandon sweep. Lost to a result or another press, the presser still
  queues; lost to a cancel, they were already requeued.
- **The bot's postgame ends a bot-hosted game (Tim's call, 2026-10-18).**
  When the bot reports `over` for a game being played (it saw Dota's
  postgame, played and not "not scored"), `endInhouseGameFromBot` makes
  finishGame's claim with no requeue: AWAITING_RESULT and `finishedAt`, its
  ten and its slot free at once. Then the follow-ups finishGame's press
  gets: publish the room (its next signed-in poll repaints the board), wake
  the automation gate, release the bot, and `maybeFormLobby` for the freed
  slot. Two callers: `/api/dota-lobby`, when a panel's read shows `over` for
  a playable game (seconds after the end; the reply then says the game is
  no longer playable), and the result scan's own bot read in
  `lookUpLobbyGame` (the backstop when no tab is open; it also marks a READY
  game IN_PROGRESS when the bot saw it running, `markInhouseGameStartedFromBot`).
  Both callers catch and log a failure there (the claim, or the formation
  and ping after it), so it never costs the panel its answer, or the scan
  that game's OpenDota lookup and the rest of its pass.
  The claim loses cleanly to a result, a cancel, the abandon sweep or a
  press that landed first (seam `inhouse.endInhouseGameFromBot.beforeClaim`,
  plus raced tests, in `test/integration/inhouse-bot-lifecycle.itest.ts`),
  and then changes nothing. The press stays as the fallback and still
  requeues its presser. Its data is a flat literal for the mutation ratchet.
- **Every close releases the bot, after its commit and without waiting on
  it** (`releaseInhouseBotAfterClose` in `dota-lobby-service.ts`): Game
  over, the bot's game over, `cancelLobby`, `giveUpOnResult`,
  `voidLastResult` (the room's banner and the history page's form alike) and
  a recorded result (`applyResult`, so the scan, "Check now" and a pasted
  id). It reads the game's spec and sends `release` in the background, a
  no-op before any read when no bot is configured, never inside a
  transaction; a Game over or a cancel answers at once. A cancelled READY
  game's ready lobby, which players still sit in, would otherwise hold the
  bot until its idle clock ran out. `src/lib/dota-lobby-service.test.ts`
  pins the call sites; integration tests settle the releases with
  `settleInhouseBotReleases()` before they unstub fetch.
- **A result must have started before its players' next game formed**
  (`nextGameCeilingSeconds` over `inhouseResultCeilingSeconds`, in
  `findInhouseGame` and `checkMatchForLobby`, so the scan, the bot's id and a
  pasted id alike). The same ten often run it back, and the scan takes the
  newest shared game, so without the ceiling the old game would record the new
  one and the new one would then fail as "duplicate". The next game is the
  earliest later lobby sharing a player that passed its ready check (one that
  failed it never played). Not the press itself: a press made during set-up
  would then refuse the real game that started after it, and one mis-tap by
  any of the ten would leave the game unrecordable. A pasted id past it says
  "started after these players' next game formed".
- **A second press** (the game already over, a result in) answers like a
  lost claim: ok, and the presser is queued if they asked. So does a claim
  lost to a cancel or the abandon sweep (which requeues nobody): a presser
  who asked to queue again does.
- **Scanning carries on:** `inhouseDetectWindow` gives AWAITING_RESULT the
  game's own `clockMs` (so the bot-match wait never restarts), a window open
  by the press, and `intervalFromMs` = `finishedAt` (the backoff restarts).
  The worker's idle return (`syncInhouse`) counts it as work, the gate wakes
  for it (`awaitingResultLobbies`, kept out of `activeLobbies` and its
  slot-count invariant), and `inhouseWatchedLobbyWhere` keeps pages on the
  watch cadence for `AWAITING_RESULT_WATCH_MINUTES`.
- **Given up on** `ABANDON_AWAITING_RESULT_HOURS` after the press, by
  `resolveAbandonedLobby`'s exact-status claim, requeueing nobody. An admin
  can give up sooner from the room's card ("Admin: give up on #1234's
  result"): its own action, `giveup` (`giveUpOnResult`, always naming its
  game), with its own claim on AWAITING_RESULT (seam
  `inhouse.giveUpOnResult.beforeClaim`), which requeues NOBODY (its ten may
  be queued or in another live game) and logs an `AdminAction`.
  `cancelLobby` reaches live games only: a cancel that finds its game marked
  over (a confirm dialog left open across a press, or the race at its claim)
  refuses and names the give-up control, so a "requeue everyone" click can
  never become an irreversible give-up on a result about to land.
- **The room's card** (`PendingResultsView`, `state.pendingResults`: the
  viewer's own games marked over, every one for an admin, named by `#code`
  since the slot may be the next game's) carries "Check OpenDota now",
  "Record by match ID" and the admin give-up, each naming its lobby. Out of
  the queue and between games it sits above the queue; while the viewer is
  queued or in their next game it folds to one line with no controls,
  because a 45-second OpenDota check shares the room's one action lock with
  ACCEPT (a ready check can open any second while queued) and the pick.
- **The result landing** refreshes the page below for every viewer: the
  refresh key covers live ids and `pendingResultIds` (every game marked over,
  ids only, sent to anyone), so "Game over" itself does not. Between games it is
  the usual banner and bell; mid-way through the next game the bell would
  read as "match found", so it is a toast instead (`resultLandedToast`, and
  `inhouseAlerts` rings `game-ended` only while the viewer has no live game).
- **Elo is stamped through that game** (`inhouseEloDeltasFor`, formation
  order, exact on `[createdAt, id]`), in `applyResult` and the reconciler
  alike. A later-formed game sharing players can complete first, and the
  global ladder's `lastChange` would then be ITS swing. That later game keeps
  the stamp it got without this one: accepted drift, like a void (the career
  ladder is always re-derived).
- **"Last game" figures** (the board's empty state, `SceneStats`) pick the
  latest result to land (`completedAt`), so a game marked over whose result
  lands after a later game's can show as the last one for a while. Accepted:
  cosmetic, and it rights itself with the next result.
- **Rollback:** an older binary ignores AWAITING_RESULT rows (no scan,
  give-up or cancel). They block nothing; roll forward, or close them by
  hand with an `endReason`.

## Positions

Tim asked on 2026-10-09: players pick the positions they play (1 to 5) before
queueing, so captains can draft a full team, as many as they like and in the
order they want to play them (his follow-up the same day). The stored form is
the order itself, most wanted first (`parseRoleOrder` in `src/lib/roles.ts`,
"2,3,1" = Mid, then Offlane, then Carry). League signups stay an unordered set
(`parseRoles` sorts it), so a signup's roles standing in are never shown as a
preference: every payload carries `rolesRanked` (true only for the player's
own inhouse choice).

- **Stored on the user** (`User.inhouseRoles`, in order): null = never
  chosen, so the latest league signup's roles (non-empty, `[createdAt desc,
  id desc]`) stand in; "" = deliberately none, never refilled from the
  signup. The player's
  own inhouse choice wins (`effectiveInhouseRoles`): unlike MMR, both are
  their own word, and this one is newer.
- **Read with the room's rows** (`loadInhouseRoomRows` selects them with each
  user, and `loadViewerExtras` for a viewer the rows don't hold), with one
  batched `Registration` read for players who never chose (none once everyone
  shown has). No copy on queue or lobby rows: it would need four copy sites
  and write rows the Serializable join and formation contend on. A change
  shows on the next poll, mid-draft too: `roles` and `join` are route actions,
  and the signup save publishes (rule P above).
- **Saved by** action `roles` (`setInhouseRoles`, strict `parseRoleKeys`:
  the order is kept, junk is refused, never dropped) or with `join` (the
  picker's unsaved choice, saved before the join). Auto-join, "Run it back" and API joins
  send none and keep the stored choice.
- **The picker** (`RolePicker` in the queue's join controls; from lg the
  filled queue card's `queueCard` puts a short "Positions" label beside the
  toggles, the full one kept for screen readers; below md it sits beside the
  card's MMR box or "You're queued" cell with its label for screen readers
  only, and the empty card's `phoneRow` puts the short label beside the
  toggles): five toggles named "Pos N ·
  Role" ("…, choice 2" once ranked); the order tapped is the order of
  preference, each pressed toggle shows its rank, and taking one out keeps the
  others' order. A line spells it out ("Mid first, then Offlane"; one line
  cut off with an ellipsis in the filled card on a phone), "from your
  league signup" while that is the source (unranked until edited; "from your
  signup" on a phone), and "Save
  positions" while edited. It lives only in the
  queue view, never in a timed stage, since every save takes the room's
  action lock.
- **Shown** on queue slots, a "Positions queued" count line (on a phone the
  count sits in the "Who's playing" row, to keep the queue on the first
  screen), vote candidates,
  draft pool and roster rows, and the matchup grid, in the player's order with
  the first choice ringed (`RoleBadges ranked`, spoken "Pos 2 Mid first, then
  Pos 3 Offlane"). Each side gets
  `TeamRoleNeeds` ("Needs Pos 4 (Soft Support)", or every position covered,
  plus how many haven't set positions: unknown never reads as a gap), and
  pool rows say "fills Pos 4" for the team on the clock (`fillsRoleNeed`).
- **Auto-pick is unchanged** (MMR, then queue order). A role-aware auto-pick
  is Tim's call. The turn it judged already reaches `applyPick`, so a choice
  made for one team can't land on another turn (see "Guarded transitions").

## Guarded transitions

Every transition is a guarded claim; keep it that way (general rules:
`docs/features/concurrency-and-testing.md`).

- **The claims:** `applyResult` on `status in INHOUSE_RESULT_STATUSES` (a
  cancel racing the OpenDota fetch wins); `finishGame` on PLAYING and
  `giveUpOnResult` on AWAITING_RESULT (see "Game over"); `endInhouseGameFromBot`
  on PLAYING (the bot saw Dota's postgame; the same claim as `finishGame`,
  requeuing nobody); `markInhouseGameStartedFromBot` on READY; `cancelLobby` inside its transaction
  (loses to a landed result and requeues nobody); `applyPick` on the turn and on
  the target row `{team: null}` (a double-click is one turn), auto-assigning
  the last pool player; `resolveCaptainVote` on `CAPTAIN_VOTE → DRAFTING`
  before installing captains; `startCaptainVote` on `READY_CHECK →
  CAPTAIN_VOTE`; `startGame` on READY; `resolveAbandonedLobby` on the exact
  status it read (a Start or a result landing after its read wins, and two
  chains tear a dead lobby down once). `maybeFormLobby` forms each game Serializable and
  treats P2034 or P2002 as the benign loser; Postgres's partial unique
  `InhouseLobby_live_slot_idx` is the final one-lobby-per-slot barrier. The queue ping
  throttle is `claimThrottle` on `inhouseQueuePingAt`.
- **`applyPick` must THROW, never return, after nulling `pickTeam`.** That null
  is the turn claim, and a return commits it: DRAFTING with `pickTeam = null`
  is a state nothing moves (`resolveStalledPick` filters `pickTeam: { not: null
  }`, `makePick` bails on `!lobby.pickTeam`). It throws `PickRaceError`, caught
  OUTSIDE the callback in `makePick` / `resolveStalledPick`. Also keep:
  `pickEndsAt` in the turn claim's WHERE (the snake repeats a team, so
  `pickTeam` alone doesn't identify a turn), `expectTeam` from `makePick`
  (Postgres re-snapshots per statement, so the re-read can show the other
  captain's turn), and the turn `resolveStalledPick` judged expired, passed
  as `expectTeam` plus `expectEndsAt` and claimed on that deadline. A
  captain's pick landing before `applyPick`'s re-read shows the next turn
  with a full clock (the same team's at a snake pair), and claiming the
  re-read's deadline auto-picked for a captain whose clock never ran out
  (seam `inhouse.resolveStalledPick.beforeApply`).
- **`restoreLostPickTurn` makes a frozen draft unreachable.** It runs first in
  `resolveStalledPick` and recomputes the turn from the rosters with
  `nextPickTeam`. It and `applyPick` are the only writers of `DRAFTING → READY`.
- **`resolveAbandonedLobby` frees a slot held by a dead READY or IN_PROGRESS
  lobby,** the only phases with no clock (and gives up on a game marked over
  `ABANDON_AWAITING_RESULT_HOURS` after its `finishedAt`; see "Game over"). Without it no game could form and the
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
  spot with the tab closed. An entry leaves only by a leave, formation, the
  shared idle deadline, or an admin's removal.
- **An admin can take one player out of the queue (Tim, 2026-10-12):**
  `removeFromQueue`, action `remove` with the player's `userId`. It is the
  leave the player could make, made for them: the shared locks and idle
  deadline first, then `deleteMany` and its count, so a second admin's click,
  the player's own leave or the formation that took them into a game gets
  "not in the queue any more" instead of a crash (raced tests in
  `inhouse.itest.ts`). An `AdminAction` is written only when it removed
  someone. Not a ban: they can join again, and the MMR cap still judges them.
  The room shows admins one picker in its admin panel, in every stage
  (`AdminQueueRemoval` in `InhouseAdminTools`, below), since a slot's button would miss the players no slot
  shows (away, "Also queued") and the whole queue while the admin is in a
  game: everyone queued in queue order, each with away, medal and MMR
  (`queueRemovalChoices`), and a confirm.
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
- **The room poll skips only a heartbeat that would write nothing.**
  `touchQueueHeartbeat`'s strict `lastSeenAt < now - 30s` WHERE stays the one
  enforcement point. `roomHeartbeatAction` skips a viewer who isn't queued or
  was seen inside `QUEUE_HEARTBEAT_SECONDS`, judged on the row and on the
  snapshot's `seenAt` memo of heartbeats this instance wrote (recorded when
  the write lands). The seam `inhouse.pollInhouseState.beforeHeartbeat` sits
  between the decision and the write.
  - **An away viewer's own poll writes, publishes, expires the gate and
    re-reads the rows.** The reply then shows them present, `needed` counts
    them, and they can be the tenth that forms a lobby on that same poll (a
    backdated requeue, a tab back after four hours).
  - **Never skip on "this instance wrote recently" without the snapshot's
    version:** a player who polled just before a cancel or decline backdated
    them would never re-confirm. Never raise `QUEUE_HEARTBEAT_SECONDS` to save
    writes either; it moves when "away" appears, which players see.
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
- **MMR trust chain:** an admin's inhouse MMR (`User.inhouseMmr`, used
  as-is; see "An admin's inhouse MMR and medal" below) > latest
  `Registration.mmr` (used as-is, so an admin override survives) > the typed
  value clamped to the medal > the last lobby snapshot (clamped), so a blank
  "Run it back" join keeps a known MMR. The first two are the fixed MMR
  (`inhouseFixedMmr`, `src/lib/inhouse-mmr-cap.ts`), which nothing typed
  changes. Client MMR alone never decides captaincy for a registered or
  admin-rated player. The admin MMR, the signup MMR and the medal are read by
  `loadInhouseJoinFacts`, for the join and the page.
- **The MMR cap (Tim, 2026-10-11).** `joinQueue` refuses a Divine 3 or higher
  medal whatever is typed, and an MMR over `HARD_MMR_CEILING` (5,000, the
  line league signups enforce): `inhouseJoinRefusal` in
  `src/lib/inhouse-mmr-cap.ts`. It judges the number the chain resolved as it
  came (a typed number before the clamp, which only lowers it), before
  anything is written, the positions too. No medal is no opinion: the typed
  number stands (Tim's call), so an account OpenDota shows unranked can still
  get in by typing low. Unlike `registrationGate`, an ACTIVE league signup is
  no medal exemption (Tim's call too): every join is judged. A medal is
  corrected through `setPlayerRank` (on a signup) or `/admin/inhouse-players`
  (anyone's, below). It is judged at the join only: a
  medal that changes while a player is queued or in a game removes nobody,
  and the requeues (`cancelLobby`, a failed ready check) only put back
  players who were in a game. "Game over — queue again" ends the game and
  then gets the join's refusal.
- **Offer no join the cap refuses.** `/inhouse` reads the same facts and rule
  (`inhouseJoinRefusalBeforeTyping`: the medal, or a fixed MMR over the
  line) and the room shows the reason, in the accent colour, where Join, the
  MMR box and the positions would be, and drops "Run it back"; a queued
  player keeps Leave. A typed number is judged when sent, and the MMR box
  stops at the cap (`max`). `?join=1` still asks the server and toasts the
  refusal. A source guard in `inhouse-mmr-cap.test.ts` pins every call site.
- **Keep the queue's "How your MMR is set" note after joining** (`mmrHint`,
  built in `src/app/inhouse/page.tsx`, shown by
  `src/components/inhouse/queue-view.tsx`; on a phone right under the filled
  card, to keep the card on the first screen). It renders only for a medal-holder
  with no fixed MMR who is under the cap, and explains why a typed value
  outside the medal's window is clamped and that nothing over the cap joins
  (the window shown stops at it). A player with a fixed MMR gets no MMR input
  at all, only "Joining at N MMR, from your league signup" (or "set by an
  admin"), which is what explains that override (on a phone's filled queue
  card it reads "N MMR" over "from your signup" or "set by an admin" beside
  the positions, with "Joining at" kept for screen readers).
- **An admin's inhouse MMR and medal (Tim, 2026-10-17): any player, signed
  up for the league or not,** on `/admin/inhouse-players`, linked from the
  room's admin controls ("Admin: players' medal & MMR") and /admin's
  "Inhouse players". It lists the queue, the latest players and anyone else
  already rated, and finds a player by name (any case), Steam ID, or a
  Steam, OpenDota or Dotabuff link. `setInhouseRating` (`inhouse-admin.ts`)
  over `saveInhouseRating` (`src/lib/inhouse-rating-service.ts`); the form's
  rules and words are `src/lib/inhouse-rating.ts`.
  - **The MMR is for inhouse only and beats everything else there:** a
    league signup's and anything typed. It never touches a signup; blank
    clears it, and the join falls back to the chain. Over the cap is allowed
    on purpose (an admin marking a player too strong): the join refuses it
    in the cap's words ("an admin set your inhouse MMR to 6,000").
  - **The medal is the site-wide one,** `rankTier` and `rankTierManual` as
    `setPlayerRank` writes them, so a manual medal shows on every page and
    outlives OpenDota refreshes. Going back to OpenDota fetches the medal
    before the transaction, or changes nothing.
  - **The claim is the stored rating the editor showed,** plus the Dota
    account link (`saveInhouseRating::inhouseMmr+rankTier+rankTierManual`):
    a second admin's save, the worker's medal refresh or a relink landing
    first refuses the save (seam `inhouseRating.saveInhouseRating.beforeClaim`).
  - **A set MMR rewrites the player's queue spot in the same transaction;
    a cleared one leaves it** until their next join (what they typed is
    gone). `joinQueue` re-reads `inhouseMmr` inside its Serializable
    transaction (seam `inhouse.joinQueue.beforeWrite`) and the save runs
    Serializable too, so a first join still on its way in, whose row the
    rewrite can't find, still lands at the admin's number. The requeues
    (`cancelLobby`, a failed ready check) put a player back at an admin's
    number saved during the game, else at the game's snapshot. A live game
    keeps its snapshot.
  - **Judged at the join, like the cap:** a save that puts a queued player
    over it removes nobody, and its toast says to remove them from the room.
    Tests: `test/integration/inhouse-rating.itest.ts`, `inhouse-rating.test.ts`,
    `e2e/admin-inhouse-rating.spec.ts`.
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
- **The queue's invite link (Tim, 2026-10-19) is `/inhouse?join=1`**
  (`INHOUSE_QUEUE_INVITE_PATH`, `src/lib/inhouse-queue-invite.ts`): one link
  anyone pastes in Discord or anywhere else, and opening it joins the queue
  in one tap (the room's auto-join, under "The room" and in
  [discord](discord.md)). It is the link the Discord pings and the night's
  "Join the queue" already carried.
  - **"Copy queue link" sits under the queue card** (the "Invite friends"
    tile of `QueueTools`, `src/components/inhouse/queue-tools.tsx`) for
    anyone, signed in or not: under the queue, and under a queued player's next-game queue
    beside a live game. It is below the card so the card keeps a phone's
    first screen. It copies the address on the viewer's own origin and
    says "Copied" only when the clipboard took it; otherwise the toast
    shows the link to copy by hand. Its name is its own: /inhouse also has
    the night's "Copy invite link" and Play later's "Copy link".
  - **Signing in comes back to it:** the queue's "Sign in to queue" (and
    "Sign in for next game") is `signInHref(INHOUSE_QUEUE_INVITE_PATH)`, so
    a friend who opens the invite signed out still ends up queued, and the
    button does what it says.
  - **It unfurls as the queue:** `/inhouse`'s metadata answers `?join=1`
    with `inhouseQueuePreviewText` (how full the queue is, a live game,
    what the link does) and names the queue's own picture
    (`/inhouse/queue/opengraph-image`, `OgInhouseQueueCard`: N/10, the
    players' avatars in the ten slots, "Game live", and the time it was
    drawn), in place of /inhouse's own (the night's). Rules for the picture:
    [pages-and-ui](pages-and-ui.md#link-previews-discord-x-slack).

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
  those, so polls never scan history. A player's previous game can still be
  marked over and waiting on OpenDota then, so its result may land after the
  snapshot: one game behind, display only.
- **Snake draft:** `nextPickTeam` gives `F O O F F O O F` so summed pick
  positions match; team 2 picks first (`FIRST_PICK_TEAM`). An expired
  `PICK_SECONDS` clock auto-picks; pool and auto-pick sort MMR desc, then
  `[queuedAt, userId]`.

## Game setup

- **`GameSetupCard` shows ONE path once teams lock.** If the lobby bot answers
  (`DotaLobbyControls` `onAvailability` is "on"), its panel is the path and
  the by-hand steps plus the optional "Start the game clock" fold under "Bot
  not working?". Players never see a bot panel that can't help; admins keep
  its status line. See `docs/DOTA-LOBBY-BOT.md`. While the one bot is
  hosting ANOTHER game still being played (one bot, one game at a time: the
  route's `busyElsewhere`, from one shared health read), availability is
  "busy": the panel says which game (`#1234`), hides the bot's lobby name and
  Create, and the card unfolds the by-hand steps, and keeps them unfolded for
  that game even once the bot frees up, so its ten never get a second lobby
  name midway. A closed game's hold keeps Create, which frees the bot first.
- **No in-house ticket id, no bot panel for players.** The bot hosts no
  in-house game without `DOTA_INHOUSE_LEAGUE_ID` (`inhouseLobbyTicketId`;
  Europe's is unset until Valve grants its ticket), so `/api/dota-lobby`
  answers a player's read (and any action) for an in-house game like a bot
  that isn't set up (`{ enabled: false }`: the card shows the by-hand steps
  and no panel), and an admin's with `INHOUSE_TICKET_MISSING_ADMIN_NOTE`,
  which names the setting (`dota-lobby.itest.ts`). /inhouse's "Make your
  games auto-detect" guide follows the same facts (`inhouseTicketGuideStep`
  in `src/lib/inhouse.ts`, source-guarded in `inhouse.test.ts`): with no
  ticket (`INHOUSE.LOBBY_TICKET_CONFIGURED`, as the card's ticket step
  decides it) its step 3 says the admins will provide the European ticket
  before tracked games begin, never a placeholder as a ticket to pick, and
  it promises the bot only when `inhouseLobbyBotConfigured` (a connection
  AND the ticket's id).
- **The bot invites the ten once its lobby is ready** (Tim's call,
  2026-10-10; `docs/DOTA-LOBBY-BOT.md#lobby-invites`), once per game.
  Accepting joins without the password but lands the player on neither side,
  so they take their own slot: Dota lets nobody seat another player. Since
  2026-10-18 the bot corrects the sides instead (see "Getting the ten on
  their sides" below). While the
  lobby is ready the panel lists "Who's in the lobby" (each player's seat and
  invite, no Steam IDs) and offers "Re-invite missing players" to the captains
  and admins and "Send me an invite" to the other players, each only while
  someone (or the viewer) is missing: `reinviteMissingOpen` and
  `selfInviteOpen` over `lobbyInviteScope`, which `/api/dota-lobby` accepts an
  invite by. The bot holds a resend back for 30 seconds and stops at five per
  player. The name and password stay on the panel as the fallback, and the
  copy tells a player with no popup to untick "Block party invites from
  non-friends": a blocked invite looks sent to the bot. A bot without invites
  reports no seats, so the panel shows no list and keeps the Custom Lobbies
  line. The list also shows while Dota is starting the game
  (`lobbyListVisible`: ready and starting, the two states the bot reports
  seats in), with its own line instead of the invite copy.
- **Getting the ten on their sides** (Tim's call, 2026-10-18, in-house only:
  the DECISIONS row of that date in `docs/DECISIONS.md#product-decisions`,
  superseding the 2026-10-10 invites row's "never kicks a stranger or seats
  anyone"; the bot's half is `docs/DOTA-LOBBY-BOT.md#seat-help`). "Right"
  means the right SIDE: inhouse assigns no positions, so any slot on it will
  do. The lobby password and visibility are unchanged.
  - **Release order: the bot first, then the site, to both leagues.** The
    site's copy below says the bot moves players and may post in lobby chat,
    and the site can't tell which bot answers it (seat help adds no reply
    field), so under an older bot that copy would be false. The names alone
    could ship in either order; the copy can't. Roll back the other way: the
    site first, then the bot.
  - **Each player's own side, first.** `GameSetupCard` puts one line straight
    under its heading (`role="status"`, named "Your side"), on a phone's first
    screen of the Set up stage: "You're Radiant — take any Radiant slot."
    (`inhouseViewerSideLine` in `src/lib/inhouse.ts`, source-guarded in
    `game-setup-card.test.ts`). It is for a player on this game's roster only
    (`me.myTeam`; a spectator or an admin watching gets none), from the
    stored side mapping, while the game is READY, or IN_PROGRESS while the
    bot still reports seats ("Start the game clock" pressed early). The panel
    reports the viewer's own row from the seat list it shows
    (`onViewerSeat`, `viewerLobbySeat`; no new bot field), so the line then
    says "you're in a Radiant slot", or, for a player in the lobby on no side
    or the wrong one, says so plainly and that the bot moves anyone on the
    wrong side back to unassigned. A hand-hosted game gets the plain line.
  - **"All ten seated".** Right above the panel's buttons,
    `lobbySeatSummary` counts the roster on its own side ("6 of 10 on their
    side.") while the lobby is ready with no release pending, and once all
    ten are, says "All ten seated — press “Start game with bot”." and rings
    that button for a viewer who has it (`startOpen`), or "All ten seated —
    waiting for a captain to start the game." for everyone else: nobody else
    gets a Start prompt. No seat list (an older bot, a reply that didn't
    parse) shows no count, never "0 of 10". Start still shows without one,
    and the bot still refuses it (`ROSTER`) until the sides are right.
  - **The panel's copy** says the bot moves anyone on the wrong side, and
    anyone not in this game, back to unassigned, and may post in lobby chat
    who goes where (`INHOUSE_SEAT_RULE_NOTE`, in a ready in-house lobby
    only); so does /inhouse's "Make your games auto-detect" step 3 when the
    bot can host (`inhouseTicketGuideStep`). The by-hand steps don't: a lobby
    made by hand has no bot in it.
  - **Names for the lobby chat.** The in-house spec carries `radiantNames`
    and `direNames`, name i for Steam id i of `radiant` and `dire`, from the
    same roster pass (`inhouseLobbyPlan`), so the browser's controls, the
    worker's status read and every release send the same spec. Each is the
    display name the room shows, through `lobbyChatName` (control and bidi
    characters dropped, whitespace folded, at most 32 code points, "Player"
    when empty): names only, never contact info, never returned to the
    browser (`dota-lobby.itest.ts` pins the spec's keys and the browser's
    view). A season spec has none. The relay passes a spec through as an
    opaque record (`validControlRequest` checks only that it is one), and
    ten capped names keep the body far under its 8 KiB cap (both pinned in
    `ops/dota-lobby-relay/test/relay.test.mjs`); an older bot ignores the
    keys, since its `validSpec` reads only the keys it knows. The cleaner
    spells its bidi characters as `\u` escapes, never literally ("Trojan
    Source": an editor or GitHub would show the line reordered), and
    `src/lib/bidi-source-guard.test.ts` fails on a literal one anywhere in
    the code, tests and ops included.
- **The panel's rates (DECISIONS 2026-10-18, superseding the 2026-10-12
  row for the panel):** `lobbyPanelPollMs` in `src/lib/dota-lobby.ts`,
  source-guarded in the panel. Every 3s (`LOBBY_PANEL_POLL_MS`) while the bot
  sets a lobby up, and while a playable game has no bot lobby (idle or
  released: any captain or admin can press Create, and every other panel must
  see it); every 15s (`LOBBY_PANEL_STARTED_POLL_MS`) once Dota reports the
  game "started"; not at all once the bot says `over`. A tab coming back
  reads at once, and a panel whose first read failed (a bot restarting
  refuses connections for half a minute) retries every 15s by itself
  (`lobbyPanelPollMs`'s `unanswered`). The idle rate lasts a whole
  hand-hosted game (DECISIONS counts it). `/api/dota-lobby` allows 60 reads a
  minute per player (three visible panels), and the admin's bot line
  (`DotaLobbyRecovery`) checks every 15s (`LOBBY_RECOVERY_POLL_MS`) without
  holding its "Check bot connection" button (a press wins over a background
  check); `/api/dota-lobby/recovery` allows 30 checks a minute per admin.
  - **One bot read per game, not per panel.** A browser status read goes
    through a per-process single-flight cache
    (`src/lib/lobby-bot-status-cache.ts`, 2s TTL, keyed by bot, job key and
    seat report, held on `globalThis` because one `next start` process loads
    lib modules more than once). Writes always ask the bot and store their
    reply, so the next read shows what the action did, and an older read in
    flight never overwrites it. Per-viewer fields (`self`, the invite scope)
    are computed after the cache. The worker's bounded read
    (`inhouseBotGameStatus`) never uses it.
  - **Polls never hold the action lock.** The panel's `read` (background
    polls, the first read, "Refresh bot status") skips while an action or
    another read is in flight; `act` (Create, Start, an invite, Release)
    holds the lock that disables the buttons and cancels a read in flight,
    and a read sent before an action never lands after it. A poll used to
    share the lock, so a read in flight disabled the buttons and dropped a
    click. An action's failure is toasted (`pushToast`), never set inline:
    the next 3s read would clear the line, and with it what the failure
    asked the presser to do. Only a read's failure shows inline.
  - **Requests are bounded by `requestSignal`** (`src/lib/request-signal.ts`:
    a timer and the cancels on one AbortController, unhooked by `done()`
    once the body is read). Never `AbortSignal.any`: Safari before 17.4 has
    none, and calling it there failed every read of the panel.
  - The first "started" answer stamps the lobby IN_PROGRESS
    (`markInhouseGameStartedFromBot`, guarded on READY); the result scan's
    own bot read does the same, so it needs no open tab.
- **The bot's lifecycle flags.** Every request carries `withLifecycle: true`,
  and the reply's `releasing` and `over` are read strictly (only `true`
  counts; anything else is unknown, so absent) and passed to the panel.
  `releasing` reads "Leaving the Dota lobby…" with no second "Release bot…"
  (`releaseOpen`), and no "Start game with bot" or invite button
  (`startOpen`, `reinviteMissingOpen`, `selfInviteOpen`: the bot refuses
  both on a lobby it is leaving); `over` reads "Game over in Dota — the result records
  itself from OpenDota", and the site marks the game over (see "Game over").
  The status line comes from `lobbyStatusLabel`.
- **BUSY says why, and frees a bot left on a closed game.** BUSY's copy says
  the bot hosts one game at a time and is free again when that game ends.
  When Create answers BUSY, the route reads the bot's health once; if its
  active job is this league's in-house game and the database shows it closed
  (COMPLETED, CANCELLED or AWAITING_RESULT, the lookup admin recovery uses),
  it sends that job's release and says what the release did
  (`freeBotFromClosedInhouseGame`, `freeingBotMessage`): "Freeing the bot
  from finished game #1234. Press “Create Dota lobby” again in a few
  seconds." when the bot is leaving now; "Asked the bot to leave finished
  game #1234. It leaves as soon as Dota lets it…" when that game still runs
  in Dota (`started`: an early "Game over" press, an admin cancel) or the
  release's answer was lost. A release the bot refuses (it can't leave yet,
  isn't running, or a player's Dota account is gone) changed nothing, so the
  BUSY answer stands.
- **How the site reaches the bot** (`lobbyBotConnection`, DECISIONS
  2026-10-18): https to any host (the relay), or in production plain http
  only to exactly `http://127.0.0.1:<port>` or `http://[::1]:<port>`, the bot
  on the box (5s timeout instead of 15s). A refused connection is "the bot
  isn't running" (nothing was sent, so an invite is a failure, not unknown);
  a timeout or reset after sending stays unknown. Every reply goes through
  `readBotReply` (`src/lib/lobby-bot-transport.ts`: 8 KiB cap, only 200, 400
  and 409), and lobby and match ids that aren't digits are dropped. Through
  the relay an invite's OFFLINE stays unknown (the relay says it for a lost
  answer); on loopback it is the bot's own word. `resolveDotaLobby` and the
  release select only the spec's fields, never whole user rows.
- **By-hand values are per game:** `inhouseHandLobbyName(slot)`
  (`<league name> Inhouse`, `... Inhouse 2` for game 2, so two games never
  share a name in Dota's lobby list), password `ggd2l`, `INHOUSE.LOBBY_TICKET`
  (from `LEAGUE_CONFIG.inhouseLeagueName`; Europe shows a placeholder until
  `NEXT_PUBLIC_INHOUSE_LEAGUE_NAME` is set), and the game's voice channels
  (`inhouseVoiceChannel(slot, team)` over `INHOUSE.VOICE_CHANNELS`) with the
  viewer's side highlighted. The Discord server needs every slot's channels. The host must be a ticket admin.
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
- **One Dota match is one lobby's result.** `InhouseLobby.dotaMatchId` is
  unique, so a game played by a mix of both live lobbies' players can't be
  recorded on both: the second `applyResult` gets P2002, rolls back whole and
  reports "duplicate" ("already recorded for the other inhouse game").
- **Pasted and bot ids go through `checkMatchForLobby`:** the game must start
  after formation (yesterday's game can't replay), and for a game marked over
  before its players' next game formed (see "Game over"), and needs 2 linked
  players per side, not the scan's 3 (the escape hatch when most data is
  private).
  `claimProviderCooldown` limits pasted ids per lobby.
- **Detection window** (`inhouseDetectWindow`, shared by service, gate and
  room): READY scans from `DETECT_READY_MIN_MINUTES` after formation,
  IN_PROGRESS from `DETECT_MIN_MINUTES` after `startedAt`, and the earlier
  opening wins so a late Start never closes an open window. A game marked
  over keeps its game's window, open by its press at the latest, with the
  backoff restarted from `finishedAt` (`intervalFromMs`). Each scan claims
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
  in `buildInhouseState`), so the history row is the only control when players
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

- **The room long-polls; cadence comes only from pure `inhouseLongPoll`,
  `inhousePollDelay` and `inhousePollCadence`** (`src/lib/room-poll.ts`,
  sharing `roomPollCadence` with the draft room; the long-poll's back-off
  and refocus rules are `inhouseUnheldStreak`, `inhouseLongPollGapMs` and
  `inhouseRefocusResync` there too). A source guard fails if an
  `INHOUSE.POLL_*` rate or an `INHOUSE.LONG_POLL_*` value reappears in the
  room, and pins the wiring below.
  - **Every request is CPU on the one box both leagues share,** with the
    session and room-version reads behind it, on one vCPU beside Postgres
    and the lobby bot: about 15-25 ms of box CPU each across Node, Postgres,
    Caddy and the tunnel (2026-10-18), not the 1.6-1.9 ms Node-only figure in
    the 2026-10-12 row. So the room asks once per change, not once per tick:
    polling everyone every 1-2s would cost roughly 9-33% of the vCPU through
    an evening, against about 1.6-2.7% for a real evening's room requests,
    both at 15-25 ms (`docs/DECISIONS.md`).
  - **The long-poll:** each request sends back the `roomVersion` of the last
    poll reply `apply()` took (`since`), with the hold it can wait:
    `LONG_POLL_TIMED_HOLD_MS` (10s) for a member in their own game's clocked
    stages (ready check, vote, draft), else `LONG_POLL_HOLD_MS` (25s). Its
    fetch deadline is the hold plus `ROOM_POLL_TIMEOUT_MS`. The next request
    leaves straight from the reply's continuation (`reissue()`, no timer for
    a hidden tab to clamp, so a hidden queued tab's chime and title arrive
    with the change), never sooner than `LONG_POLL_MIN_GAP_MS` (1s) after
    the previous one started, so a moving version can't hot-loop. It also
    sends the shown reply's `now` (`sinceNow`).
  - **A version that never stops moving backs the gap off.** Every publish
    wakes every held tab, refused and no-op mutations included, so one
    account's churn would hold every visible tab at one request a second.
    From the second reply in a row that comes back unheld (`held: false`,
    counted by `inhouseUnheldStreak`) the gap doubles per reply up to the
    ladder rate of the phase (`inhouseLongPollGapMs`), and a held reply puts
    it back to 1s; a member's own clocked stage keeps 1s. That bounds churn
    faster than the 1s gap. A writer paced just slower (a no-op every
    1-2s) gets every request held and woken, so tabs stay at about one
    request a second, bounded only by `LONG_POLL_MIN_GAP_MS`: no more than
    one client could cost by polling directly within the per-IP state limit,
    so it is accepted (DECISIONS 2026-10-18) rather than given a server-side
    wake floor that would slow every real change.
  - **A dead connection shows later while held (accepted, 2026-10-18).**
    `usePollHealth` locks the room and says "Connection lost" at
    `ROOM_POLL_FAIL_THRESHOLD` (3) failures in a row, and a request that
    hangs fails only at its deadline. So the worst case is about 43s in a
    clocked stage and 58s elsewhere (the held request's hold plus 10s, then
    two unheld retries at 1.5s plus 10s each), against about 34.5s and
    36-43s on the ladder. The shorter clocked hold starts the fast retries
    15s sooner where a clock runs, and a refocus after a long hide asks
    afresh (below). Neither path is inside the 25s vote; a
    click on a dead connection locks the room on its own once the action
    times out (`ROOM_ACTION_TIMEOUT_MS`, 15s: "checking", never "failed").
    `room-poll.test.ts` states the numbers; change them only with the
    DECISIONS row.
  - **A request answers at once instead** (no `since`, on the ladder below)
    when the last reply carried no version (the first request, or an old
    slot during a release), after a failure, and while something waits on
    it (`urgent`): a resync after going offline, an action in flight
    (`actionsInFlightRef`) or awaiting reconciliation, whose controls stay
    locked until a reply lands, or a refocus after a long hide
    (`refocusPending`).
  - **An action, an offline/online change and a refocus after a long hide
    release a held request** (`releaseHold`: its controller, linked to the
    `AbortSignal.timeout` by `withDeadline` in `room-poll.ts`;
    `AbortSignal.any` is missing on older Safari). After an action,
    request-start ordering drops that request's reply only if the action's
    reply lands first; a held reply woken by the action's own publish can
    land first and is applied, which is harmless (it was read after the
    commit). A release is not a failure; the rerun latch polls next.
  - **Cleaning up the loop releases the request in flight, held or not**
    (`releaseInFlight`: an unmount, or React's development double mount,
    which runs the effect twice), **and a cleaned-up loop never applies a
    reply.** Request-start ordering assumes one poll in flight per loop: of
    two at once the server may read the later-started one first, and the
    gate would then keep the older room. The first mount's unheld request
    used to keep running, so every development load sent two, and zz4d once
    saw an accept count of 1, then 0 (2026-10-20). Production mounts once,
    but nothing else may leave a second poll running either.
  - **A tab back from a hide of `ROOM_POLL_TIMEOUT_MS` (10s) or more asks
    afresh, unheld, once** (`inhouseRefocusResync`): a held request may
    have died silently with its connection while the device slept, and its
    own deadline is up to its hold plus 10s away. The room releases it, and
    `refocusPending` keeps the next request unheld until a reply is
    applied. A quick alt-tab costs nothing.
- **The fallback ladder** (`inhousePollCadence`; rates retuned for the box on
  2026-10-18, before them the Vercel Hobby rates): fast (`pollMs`, 1500)
  only for the clocked stages: ready check, vote and draft. Game setup
  (READY until the scan window opens, `inhouseReadyInPlay`, after which a
  hand-hosted game polls like IN_PROGRESS and drops "(!) Teams locked") has
  no clock: it polls at `POLL_SETUP_MS` (2.5s).
  - Otherwise `POLL_QUEUE_MS` (3s) when queued, `POLL_GAME_MS` (5s) in your
    own game, `POLL_IDLE_MS` (10s) spectating. The room passes `inLobby`
    (source-guarded): `pollingLobby` shows a queued player someone else's
    game, and that player is waiting for their own lobby, so they poll by the
    queue (or fast while the other game drafts), never at the game rate.
  - Hidden with a stake: in your own game's timed stage `POLL_KEEPALIVE_MS`
    (10s), which must stay shorter than the vote window; in your own game
    `POLL_GAME_KEEPALIVE_MS` (30s); queued `POLL_QUEUE_KEEPALIVE_MS` (10s),
    which must leave at least 60s of the accept window (`room-poll.test.ts`;
    the vote can't open before a queued player has seen the check and
    accepted). Hidden with no stake: no fetch, held or not. `isColdStart`
    gives a tab hidden at load a few bounded attempts, since stake is
    learned from a payload.
  - A warm-room 429 eases to `POLL_RECOVERY_MS` (10s) and is not a failure; on
    a cold page 429s count toward the retry state (else "Loading" forever). A
    disconnected room's backoff starts from the same 10s, never faster than
    idling. Offline sends nothing.
  - Reschedule from live visibility (refocus mid-fetch snaps back);
    `visibilitychange → visible` polls at once (a held request in flight
    after a short hide stays: it is current while its connection lives); a
    successful `act()` nudges the loop (`bumpPollRef`) so the action's
    outcome lands within ~250ms.
  - **e2e:** `e2e/zz4e-inhouse-long-poll.spec.ts` (a change in every tab
    within about a second, signed in or out; an idle tab at about one
    request per hold; offline releasing the hold; an action's outcome at
    once, whichever of the held reply and the action's reply lands first; a
    reply with no version on the ladder, never a loop). The poll-resilience specs
    (`e2e/zz3-room-poll-resilience.spec.ts`) that hold a short poll run on
    the ladder by stripping `roomVersion`, as an old slot answers;
    `e2e/zz4d-inhouse-room-snapshot.spec.ts` publishes through
    `/api/test/cache` to make every tab poll, and checks that no tab ever
    has two polls in flight (each leaves after the one before it landed).
- **Sequence-order every response** (`issueSequence` / `acceptSequence`) for
  poll AND `act()`: a late pre-pick poll put the drafted player back in the
  pool. Mint the sequence BEFORE the `await` and keep `apply()` the only
  writer of room state; `src/components/room-source-guards.test.ts` checks
  both, reading the shell and the stage folder as one room. `apply()` also
  folds the payload's server `now` into the clock offset (`nextClockOffset`,
  1s hysteresis), so vote and pick clocks run on server time. The server's
  room snapshot keeps this contract only because every poll checks the room
  version (see "Scope and where it runs"); never cache `now`.
- **Every room fetch has an `AbortSignal.timeout`** (`ROOM_POLL_TIMEOUT_MS`,
  plus the hold for a held request; actions `ROOM_ACTION_TIMEOUT_MS`, or
  `INHOUSE_SCAN_ACTION_TIMEOUT_MS` for `INHOUSE_SCAN_ACTIONS`). A timed-out, 5xx or unreadable action may have
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
  - **Browsers hold a page's audio until a click, tap or key press on it,
    after every load.** `armAudioUnlock` (`chime.ts`) unlocks on the first
    pointerup, touchend, click or keydown anywhere on the page, until the
    context runs, and at once on a page that already had a click where the
    browser allows it. A `?join=1` arrival, a reload and a restored tab have
    clicked nothing, and players on another tab missed "match found" that way
    (2026-10-20): the poll brought it, the bell rang into a held context.
    So until audio runs Sound reads "Turn on sound" in the accent colour
    (`soundButtonState`, `src/lib/room-sound.ts`), a tap turns the bell on
    and never mutes it (`soundToggleNext`, shared with the draft room), and
    the one-tap join's toast says to click once (`autoJoinedToast`).
- **Desktop alerts: the browser's own notification for a player away from
  the tab** (Tim, 2026-10-20; rules in `src/lib/inhouse-desktop-alert.ts`,
  the browser side in `src/components/desktop-alerts.ts`). A notification
  permission, once given, lasts for the site, so unlike the bell it needs no
  click after a load: the one-tap joiner who goes straight back to Dota gets
  it.
  - Opt-in and off by default, from the "Desktop alerts" tile of
    `QueueTools` under the queue card (signed-in viewers; under the card, so
    the card keeps the first screen).
    The browser asks once, on that click, and a first alert ("Desktop alerts
    are on") shows what one looks like. The switch is `inhouseDesktopAlerts`
    in localStorage. When the browser refuses the site, the tile says
    "Blocked", names its site settings and offers no button.
  - Desktop browsers only (`desktopAlertsSupported`): Android's Chrome throws
    on `new Notification()` and iPhone and iPad Safari show only a Home
    Screen app's, both through a service worker, so a phone gets no row.
  - The room takes it from the SAME `inhouseAlerts` list as the bell, one per
    poll: `inhouseDesktopAlert` picks the one to act on first and names the
    stage the game is in now (a hidden tab can first see its game past the
    ready check), and `desktopAlertToShow` shows it only while the viewer is
    away (the tab hidden or its window unfocused). Accept, vote and pick stay
    up until the player acts (`requireInteraction`); coming back to the tab
    closes it (`armDesktopAlertDismiss`), and one tag means a newer alert
    replaces the last. Only `desktop-alerts.ts` calls `new Notification(`
    (`room-source-guards.test.ts`).
  - It costs the box nothing: the room shows it from the poll it already
    runs. A tab the browser has put to sleep (a phone's, or one Chrome
    unloaded to save memory) gets neither alert nor bell; the Discord
    match-found ping covers that. Web Push would reach it, but needs keys on
    the box, a subscription table and a service worker (DECISIONS
    2026-10-20).
  - `e2e/zz4f-inhouse-desktop-alerts.spec.ts` fakes the browser's
    notifications and an away tab: the locked toggle, turning alerts on, the
    match-found alert while away, its close on return, and none on the tab.
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
  themselves), so the site keeps its own list. Any signed-in player with a
  linked Discord account can say so while the night is ahead
  (`inhouseNightRsvpOpen`). **The link is required** wherever accounts can be
  linked (`inhouseNightRsvpNeedsDiscord` over `discordLinkingConfigured`, the
  same test `/api/auth/discord` makes; Tim's call, 2026-10-09, after players
  on both lists were counted twice): a player without one gets "I'm in" as
  the account link (`INHOUSE_NIGHT_LINK_DISCORD_PATH`, "Link Discord to say
  you're in" on the card), which comes back to the invite link once Discord
  says yes, and the server refuses the form
  (`INHOUSE_NIGHT_LINK_DISCORD_FIRST`). A failed link lands on My account,
  which says why. Taking it back never needs one, and a player in from
  before the rule stays in, with a "Link Discord" nudge on the card: the
  control (`inhouseNightRsvpControlKind`) is the pressed toggle for anyone
  already in, linked or not. Once it's on, the
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
- **The invite link** (`INHOUSE_NIGHT_INVITE_PATH`, `/inhouse?imin=1`; Tim's
  call, 2026-10-08) is what an admin pastes in Discord: /inhouse's preview
  follows the night (`inhouseNightPreviewText`: the time on the league's
  clock, the note, the headcount, what the link does) with the night's own
  picture (`OgInhouseNightCard`, `inhouse/opengraph-image.tsx`; the league's
  picture with no night). Opening it does what `inhouseNightInviteAction`
  (pure, tested) says: "I'm in" once for a signed-in player not yet on the
  list (`InhouseNightInviteRsvp`, which scrubs `imin` first so a refresh never
  repeats it, and treats a lost answer as unknown), "already in" for one who
  is, a note for one without a linked Discord to press Link Discord (the
  bar's chip, first on screen, says "Link Discord" and the card "Link
  Discord to say you're in": a button they press, never a bounce to Discord
  on load, which jars and repeats on a reload; it comes back to the invite,
  which then says it), the card's sign-in for a signed-out visitor, and once the night is on,
  `/inhouse?join=1` (a server redirect). Every signed-out "I'm in" signs in
  back to the invite, so a new player's first click ends with them in. "Copy
  invite link" sits on /admin's night card and /inhouse's card; the planned
  Discord post carries the link too.
- **The headcount adds the two lists** (`inhouseNightHeadcount`, loaded by
  `inhouseNightHeadcountFor` for every surface): the site's
  "I'm in"s plus the Discord event's Interested members
  (`guildEventInterested`, the member list paged 100 at a time up to
  `GUILD_EVENT_INTEREST_MAX_PAGES`, reused for two minutes, null when
  unknown, bots left out), a player on both counted once when their linked
  Discord id is among them. Every "I'm in" since 2026-10-09 has one, so only
  a player in from before can count twice. "12 coming" once Discord's list is read; "5 said I'm in" when
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
  Its title links to the night's card on /inhouse (`/inhouse#inhouse-night`).
  /inhouse puts the night in its one top bar above the room, as a chip
  (`InhouseNightChip`, region "Inhouse night"; Tim, 2026-10-10: the whole
  queue on the first screen): a link down to the card, the start on the
  viewer's clock ("Today, 8:00 PM", "Tomorrow, …", else with its date, "Fri,
  Oct 23, 8:00 PM": `inhouseChipWhenText` `dated`, since a night can be
  weeks off and a weekday alone read as this week's), the headcount and
  "I'm in" (a refusal stays in its toast; "Link Discord" for a player who
  must link first, the words the invite link's note tells them to press),
  or once it's on "Join ↓" to the room; no countdown, no faces, no note. The
  card (region "Inhouse night details", `#inhouse-night`) sits under the
  Play later card with the note, "I'm in", the headcount with its sources,
  who said they're in on the site, the Discord event link, Google Calendar
  and an `.ics` download (`/api/calendar/inhouse-night`, one event whose UID
  and SEQUENCE are the night's id and revision; never memoized, so a night
  an admin just moved downloads as moved, and in the calendar feed's per-IP
  bucket with the Play later file,
  [season-schedule-playoffs](season-schedule-playoffs.md#calendar-feed)),
  and answers the invite
  link. The chip and the card share one request-cached read
  (`loadInhouseNightView`). The Discord
  half of the headcount streams, so a slow Discord never holds a page; the
  bar itself renders inline, so it never drops in above a painted hero.

## Play later

Players' own short-notice times on /inhouse ("I can play at 8, who's
in?"; DECISIONS.md, 2026-10-10). Kept apart from the inhouse night on
purpose: no Discord post, no ping, no admin. Rules: `src/lib/inhouse-times.ts`
(pure); storage: `inhouse-times-service.ts`; the action:
`src/app/actions/inhouse-times.ts`; the card and the banner:
`src/components/inhouse-times.tsx`, with the time box, "Copy link" and the
banner's "Today, 8:00 PM" in `inhouse-times-client.tsx`; the calendar
file: `/api/calendar/inhouse-time?at=`. Tests: `inhouse-times.test.ts`,
`test/integration/inhouse-times.itest.ts`, `e2e-mid/zz-inhouse-times.spec.ts`.

- **A time is just its "I'm in" rows.** One `InhouseTimeRsvp` row per player
  per time, keyed by the start and the player, with no parent table. Posting
  a time is being first in on it, two players posting 8:00 PM share one, and
  a time is gone once its last player takes it back, so there is no owner,
  nothing to move or cancel, and nobody's plan is left hanging when its
  poster drops out. Rows of times that are over are pruned after the next
  "I'm in" (best-effort; no read shows them).
- **Any signed-in player, the next day, the quarter hour.** The box takes a
  clock time on the player's own clock and means the next time it comes
  round, today or tomorrow (`nextInhouseTimeAt`, worked out in the browser,
  which alone knows the zone); the line under it names the exact time that
  will post, a rounding included, and says when it's already up. The server
  takes only a quarter-hour start ahead and at most 25 hours off
  (`inhouseTimeProblem`; a day is 25 hours when the clocks go back). No
  linked Discord is needed: nothing is counted against Discord or pinged.
- **At most `INHOUSE_TIME_MAX_PER_PLAYER` (3) upcoming times per player,**
  which also caps what one account can keep on the list. The cap, the
  "posted" versus "in" answer and the double tap are all judged in one
  Serializable transaction with `retrySerializable` (six tries: three ran out
  inside one slow commit); the raced tests in the itest fail without either.
- **The night comes first.** A new time inside a planned inhouse night's
  window is refused with a pointer to the night (its card below the form,
  its chip in the bar at the top: `INHOUSE_TIME_DURING_NIGHT`); a time posted before
  the night was planned stays and can still be joined. The night is read
  before the transaction, so a night planned in that gap leaves at worst the
  same thing as one planned just after.
- **It runs on read time.** A time is upcoming, on for `INHOUSE_TIME_ON_MS`
  (an hour) after its start, then over; nothing is scheduled, so there is no
  automation-gate wake-up and no worker step. Once it's on, its row says
  "Join the queue" (a jump to the room on the same page) and "I'm in" is
  closed, though anyone in keeps the pressed toggle to take it back. Nobody
  is queued for a time: an absent player would sink the ready check.
- **Each row decides its controls by one rule** (`inhouseTimeControls`):
  "I'm in" (a sign-in back to the time's link when signed out, held back at
  the cap), "Join the queue" once it's on, and calendar links (Google and an
  `.ics`) only for a player in on it and waiting, which are the reminder the
  site gives in place of a ping. Every row's "I'm in" is described by its
  time (`aria-describedby`), since they share a label.
- **Its link is the one Discord touch.** "Copy link" copies
  `inhouseTimeLinkPath` (`/inhouse?at=2026-10-11T00:00Z`, the one shape
  `parseInhouseTimeParam` takes). /inhouse's preview then follows that time
  (`inhouseTimePreviewText`: the start on the league's clock, the count, what
  the link does) with the league's own picture, since the page's picture is
  the night's. Opening it never signs anyone up and never moves anything
  (Tim, 2026-10-10: the card jumping above the queue made a link look like
  another page): the banner leads with that time, picked out, and the card
  under the room outlines its row; for a time that's over, one everyone took
  back, or a link naming none, the banner says "The time in that link is
  over, or everyone on it dropped out. See Play later below." in its place,
  once (the card doesn't repeat it). A refused "I'm in" in the banner stays in
  its toast (`ActionForm` `inlineError={false}`), so the row never grows.
- **Open times lead the page as a thin banner; the card stays under the
  room** (Tim, 2026-10-10: a sliver with the time and "I'm in", so nobody
  scrolls past the queue to find a time, and posting stays below as it is).
  While any time is on or ahead, the times (region "Play later times") ride
  /inhouse's one top bar (`InhouseTimesStrip`), between the title row and
  the live room, beside the inhouse night's chip when one is planned (the
  bar shows for the night alone too): the earliest leads, a time's link
  leads with its time and the night's invite with the night
  (`inhousePlansNightFirst`), a hairline between them. One row, one button
  high (64px at most: 60 on a phone, 52 from 640; the e2e measures the whole
  bar, `#inhouse-plans`), a 🕗 and "Play later" (the clock alone on a
  phone), then each of the soonest `INHOUSE_TIMES_STRIP_SHOWN` (3) as a
  chip, or `INHOUSE_TIMES_STRIP_SHOWN_BESIDE_NIGHT` (2, a link's own
  included) beside the night's chip, which is wide: behind three times its
  "I'm in" was cut off at a laptop's right edge. A chip says its start
  ("Today, 8:00 PM" on the viewer's clock, `inhouseChipWhenText`; the server
  writes the same words on the league's clock, zone named), "6 in", and the same
  controls as its row in the card by the same rule (`viewOf`): "I'm in", a
  sign-in back to the time's link when signed out, and once it's on "Join ↓"
  (named "Join the queue", a jump to the room) beside the pressed toggle of a
  player in on it. No faces, no countdown, no subtitle: those are the
  card's. The chips swipe in one row inside the banner's `overflow-hidden`
  card when they don't fit (a phone shows about one), so it never grows a
  second row, and a fade marks each side with more off screen (`PlansRow`,
  SectionNav's `chipBarEdges`/`chipBarMask`). From xl only the times' chips
  swipe, in a row of their own between "Play later" and the link down, so
  a laptop shows the night's chip whole however wide the times' words get
  (on 2026-10-11, "Tomorrow, 12:00 AM" and "Tomorrow, 1:00 AM" in CI's
  DejaVu Sans pushed it 17px past the bar). A link down to the card ends
  the times: "N more", else "Post a time", else "All times" at the cap
  (`inhouseTimesStripLinkText`).
  `inhouseTimesStrip` alone decides which times show, a time's link
  included (`inhouseTimeLinked` reads `?at=`): none while no time is open
  and no link needs answering, and the bar is nothing at all while there's
  neither that nor a night (no empty box). Both read through one request-cached
  `loadPlayLater`, so they show the same times from one query; the banner
  streams in its own `<Suspense fallback={null}>`, never holding up the room.
  Each chip's button is described by the chip's own time id
  (`inhouse-time-next-<ms>`), since the card's row shows the same time. The
  card keeps posting, the links, the countdowns and everyone's names, and the
  section nav's Play later points at it.

## Testing

- **Extract room rules into pure tested functions plus a source guard** that
  the room calls them (vitest is `environment: "node"`; the room can't render
  in a unit test). Fallback: a Playwright spec
  (`e2e/zz3-room-poll-resilience.spec.ts` interception pattern). jsdom last.
- **e2e:** `e2e/zz4-inhouse.spec.ts` (join/leave with a phone overflow check,
  then accept to in-progress with nine API players, zero page errors; the
  setup card's "Your side" line for the player, whole above the tab bar on
  a fresh 390x664 load, none for a watching admin or once the game is under
  way);
  `e2e/zz4c-inhouse-game-over.spec.ts` (positions in the picker and the draft,
  "Game over — queue again", a player from that game joining at once, the
  admin give-up); `e2e/zz4f-inhouse-desktop-alerts.spec.ts` (the held
  bell's "Turn on sound", and desktop alerts: the match-found alert while
  away, closed on return, none on the tab);
  `e2e/zz5-inhouse-history.spec.ts` (history and admin void).
  The bot-driven transitions are covered in
  `test/integration/inhouse-bot-lifecycle.itest.ts`: the auto-end at the
  bot's postgame by its seam tests (`inhouse.endInhouseGameFromBot.beforeClaim`)
  plus raced tests against a cancel, a Game over press and the abandon sweep;
  releases on close and BUSY's self-heal by ordinary integration tests. The
  IN_PROGRESS stamp is covered in `dota-lobby.itest.ts`, including a game
  closed while the bot's reply is in flight (an in-fetch interleave, its
  mutation-ratchet killer), and the "busy elsewhere" read there too.
  `e2e/zz4-inhouse.spec.ts` also checks the room's one header row in every
  stage at 375 and 1280 (one stage strip on the right step, Sound on its
  line, no sideways scroll).
- **The first screen:** `e2e-mid/zz-inhouse-queue-fit.spec.ts` loads
  /inhouse fresh at every required size (390x844 to 1920x1080, 1366x768, a
  phone with Safari's toolbars showing at 390x664, the laptop windows
  1280x690 and 1366x657, and 375x667 signed out) signed out,
  signed in with and without a signup's MMR, and queued, with 0, 1, 6 and 9
  present, with and without a Play later time and a planned night (and
  three times beside a night), and fails if the queue card leaves the
  visible viewport (under the header, above the phone tab bar), the bar is
  taller than 64px or off screen, the leading chip's "I'm in" isn't whole on
  screen, more than two times sit beside the night or a laptop cuts the
  night's chip off, a row in the bar is cut off with no fade, the "Who's
  playing" row wraps or spills, a slot row spills, or the page scrolls
  sideways. "Whole" counts the rows that clip a chip, not just the screen
  (`getBoundingClientRect` ignores clipping). It prints the measured table,
  with 1440x790 and 375x667 signed in as report-only rows.
  `FIT_FONT=Verdana` forces the body font to a DejaVu stand-in, so a Mac
  run sees CI's wider type. Its browsers run on a clock that reads 9 PM
  when it starts, with the times and the night written on it, so every run
  measures the chips' widest words ("Tomorrow, 12:45 AM", "Tomorrow, 10:45
  AM", a night named by its date) whatever the hour, and checks them before
  measuring: times written from the runner's clock read wider in the
  evening, and the night's chip fell off a laptop's bar only on evening CI
  runs.
- **Game over and positions:** `test/integration/inhouse-game-over.itest.ts`
  (the claim and its seams, the result window, the Elo stamp with
  overlapping players, the give-up paths, pending results, positions).
- **SQLite hides every race here.** `test/integration/inhouse*.itest.ts` stage
  races by hand; `npm run test:pg` runs them on Postgres. Run it after touching
  any claim. Seams are `inhouse.<function>.<point>`.
- **The room poll and its snapshot:** `src/lib/inhouse-room-due.test.ts` (one
  row per due reason at its exact boundary, the heartbeat and board rules),
  `inhouse-room-cache.test.ts` (hits, single flight, the local fence, no
  cached rejection, and the max age staying under the away cutoff),
  `inhouse-room-publish.test.ts` (rule P's sites) and
  `inhouse-service.test.ts` (`buildInhouseState` over a viewer matrix).
  Integration: `inhouse-room-rows.itest.ts` (the rows against the old
  per-viewer queries), `inhouse-room-poll.itest.ts` (due against what the
  resolvers do, heartbeat, board) and `inhouse-room-cache.itest.ts` (output
  parity on a warm snapshot, every writer through its production entry point,
  two module instances, the provider window, and the raced and seamed cases
  on Postgres). `e2e/zz4d-inhouse-room-snapshot.spec.ts` drives two captains
  and a queued watcher.
- **Fence a direct database write in an e2e spec with `POST /api/test/cache`,**
  which publishes: the dev server's snapshot otherwise serves the old rows
  for up to 15s (zz4c, zz5 and the mid queue-fit spec do).

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
