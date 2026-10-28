# 1v1 mid inhouse ("duels")

A quick 1v1 Solo Mid beside the 5v5 inhouse (Tim's call, 2026-10-27): a
separate "1v1 mid" card on `/inhouse` under every 5v5 card, its own queue,
its own Elo on a "1v1 mid leaderboard" after the 5v5 ladder, and the lobby
bot hosting every game. The code name is "duel"; copy always says "1v1 mid"
(the game mode is "1v1 Solo Mid"). Main files: `src/lib/inhouse-duel.ts`
(pure: pairing, clocks, the match check, the ladder, the room's `duel`
block and the card's rules), `src/lib/inhouse-duel-service.ts` (the engine:
every guarded write, the result scan, the worker steps, the ladder memo),
`src/lib/inhouse-duel-room.ts` (the room's 1v1 rows),
`src/lib/inhouse-duel-bot.ts` (the bot's side), `src/components/inhouse/duel-*.tsx`
(the card) and `src/app/inhouse/duel-ladder-card.tsx` (the leaderboard).
Models: `InhouseDuelQueueEntry`, `InhouseDuel` (migration
`20261028120000_inhouse_duel`). Everything else about the inhouse (the room's
long-poll, rule P, the worker) is [inhouse](inhouse.md); the bot's protocol is
[DOTA-LOBBY-BOT](../DOTA-LOBBY-BOT.md#1v1-mid-duels).

## Rules

- **Join 1v1 pairs at once, or waits.** The joiner pairs with the oldest
  waiter who is present (their room heartbeat at most `PRESENT_SECONDS`, 180,
  old), in no live 5v5 lobby and in no live 1v1 (`pickDuelOpponent`). Sides
  are random (`assignDuelSides`). With nobody to pair, the
  joiner waits; a queue row expires `QUEUE_MINUTES` (30) after the join, and a
  repeat join refreshes it. The worker's sweep (`pairDuelQueue`) pairs two
  present waiters a join couldn't (one was away, or in a 5v5).
- **Both accept before the bot is asked** (Tim's call, 2026-10-28). A new
  pair is ACCEPTING for `ACCEPT_SECONDS` (60) from its pairing
  (`duelAcceptEndsAtMs`). Each player presses **Accept 1v1** (`acceptDuel`:
  a claim on ACCEPTING, their own side's empty stamp and the deadline,
  `duelAcceptOpenAfter`); the accept that completes the pair makes it READY
  (`promoteAcceptedDuel`) and only then asks the bot for the lobby. **Decline
  1v1** (`declineDuel`) cancels it at once. Whoever didn't accept (the decliner, or
  a player the time ran out on) leaves the 1v1 queue; whoever did, and on a
  decline the other player, goes back to its front (`requeueAtFront`:
  `joinedAt` is the ended pairing, `lastSeenAt` their accept or the pairing,
  so a player who never answered isn't counted present longer than they
  were; `duelRequeueAfterAccept`). The worker's `settleDuelAccepts` closes a
  duel out of time and makes READY one both accepted whose promote never ran.
  An admin cancel of an ACCEPTING duel puts nobody back.
- **The accept is the two players' alone.** The duel block is per viewer, so
  only the two paired players get the prompt, the room's bell and the desktop
  alert ("1v1 found — accept now"; the alert `duel-found`, from the snapshot's
  `duelAcceptId`). The 5v5's ready check, vote, draft, alerts and toasts read
  nothing of it, and a 5v5 moment the player must act on wins the one desktop
  alert a poll shows (`inhouseDesktopAlert`).
- **Only where the lobby bot can host 1v1s** (`inhouseLobbyBotConfigured`:
  a connection and the in-house ticket; Europe has no ticket today). 1v1s
  are bot only, so without it a pair could never play: the card shows
  `DUEL_NO_BOT_NOTE` ("1v1s start once the lobby bot can host here.") in
  Join's place (and in sign-in's), and `joinDuelQueue` refuses with the same
  words. A 1v1 whose bot panel answers that the bot can't host (`off`) shows
  `DUEL_BOT_OFF_NOTE`, and its setup clock calls it off.
- **Signed in only, the 5v5's MMR cap** (`duelMmrRefusal`, the 5v5's
  `inhouseJoinRefusalBeforeTyping`; a 1v1 takes no typed MMR). Refused while
  in a live 5v5 lobby (`INHOUSE_ACTIVE_STATUSES`) or a live 1v1. A 5v5 join
  does not refuse a player in a 1v1 (open question; the 5v5 is unchanged).
- **No cap on how many 1v1s exist.** The one bot hosts one lobby at a time,
  so 1v1s wait their turn for it.
- **Statuses** (`INHOUSE_DUEL_STATUS`): ACCEPTING (paired) → READY (both
  accepted) → PLAYING (the bot read the launch) → AWAITING_RESULT (the bot
  read Dota's end, or a player pressed "1v1 over") → COMPLETED | CANCELLED.
  Live (holding its players) is ACCEPTING, READY and PLAYING
  (`INHOUSE_DUEL_LIVE_STATUSES`); the bot's reads cover READY and PLAYING
  only (`INHOUSE_DUEL_BOT_STATUSES`: an ACCEPTING duel has no lobby); a
  result can land on READY, PLAYING and AWAITING_RESULT
  (`INHOUSE_DUEL_RESULT_STATUSES`); open is ACCEPTING plus those
  (`INHOUSE_DUEL_OPEN_STATUSES`: the room shows it, an admin can cancel it). AWAITING_RESULT frees the
  two: they may join the 1v1 queue again while the result is on its way.
- **Bot only, never by hand** (Tim's amendment). There is no "host it
  yourselves" path and no "We're playing" press: PLAYING comes only from the
  bot's started read. "1v1 over" stays as the fallback for a bot game whose
  end the bot missed (PLAYING only).
- **Call it off** (either player): a READY 1v1 whose game never started is
  CANCELLED. **Admin**: cancel any open 1v1, void a
  COMPLETED one (the ladder recomputes without it), and take a player out of
  the 1v1 queue. All logged (`logAdminAction`; the void's `AdminAction`
  commits with its claim).
- **Every close lets the bot go.** Call off, admin cancel, both give-ups, a
  failed launch, "1v1 over", the bot's own end read and a recorded result
  all call `releaseDuelBotAfterClose` (fire-and-forget, after the commit).
- **No Discord** in v1: no pings, posts or board line. Home is unchanged.
- **Europe runs the same code.** With no ticket the bot can't host, so the
  card offers no Join until the ticket is set.

## Data

- `InhouseDuelQueueEntry {userId @unique, joinedAt, lastSeenAt, expiresAt}`.
- `InhouseDuel {status, radiantUserId, direUserId, createdAt,
  radiantAcceptedAt, direAcceptedAt (migration
  `20261029120000_inhouse_duel_accept`), startedAt,
  finishedAt, completedAt (the closing clock: when a result, a cancel, a
  give-up or a void closed it), checkedAt (the scan's
  claim), botMatchId, dotaMatchId @unique, winnerTeam (1 Radiant won, 2 Dire),
  durationSecs, radiantHeroId, direHeroId, matchStartTime, endReason}`.
  No player table: a result rewrites the two user columns to the sides the
  match actually had, so `winnerTeam` and the heroes line up.
- New tables, never a mode column on the 5v5 tables: about 150 5v5 readers
  filter by status alone.

## Guarded writes

Every transition is an `updateMany` on the exact state judged, with its
count checked, and every committed write publishes the room
(`publishInhouseRoomChange`, rule P) outside any transaction and before any
provider call. Join and the sweep run Serializable (`waitBeforeSerializableRetry`),
reading the 1v1 queue, the live 1v1s and the live 5v5 players; the pair claim
deletes both queue rows with `count === n` or throws (`DuelPairRaceError`,
caught outside and retried). The claims are in the mutation ratchet
(`scripts/mutation-guard.mjs` FILES, killers in `test/mutation-baseline.json`);
`src/lib/inhouse-room-publish.test.ts` holds every 1v1 writer to rule P.

## The lobby bot

- **Auto-create.** The accept that completes a pair asks the bot for its
  lobby after the response (`promoteAcceptedDuel`'s
  `runAfterResponse(createDuelBotLobby)`, after the commit and the publish;
  never inside a transaction or a room poll). An ACCEPTING duel never reaches
  the bot. A busy bot, or one
  saved for a 5v5, is retried by the worker once a pass for the oldest READY
  1v1 with no bot lobby (`retryDuelBotCreate`), until the bot is free or the
  1v1 leaves READY.
- **The 5v5 comes first.** A 1v1 create is refused while any 5v5 lobby of
  this league is in READY_CHECK, CAPTAIN_VOTE, DRAFTING, or READY with no
  started game (`duelBotSavedFor5v5`, "The bot is saved for the 5v5 being set
  up").
- **The panel is the 5v5's** `DotaLobbyControls`, kind `duel`: either player
  or an admin can Create (a manual retry), Start, re-invite or Release, as 5v5
  captains do. The card shows it once the bot answers with a lobby (or names
  the game it is busy with); otherwise `DUEL_BOT_WAITING_NOTE` ("Waiting for
  the lobby bot — it makes your lobby as soon as it's free."), never by-hand
  steps.
- **Status reads drive the 1v1** (`applyDuelBotStatus`, from the worker and
  the panel's route): started (also a game the bot has `left`) → PLAYING with
  the bot's match id; Dota's end (`over`) → AWAITING_RESULT and the bot
  released; a job `released` after its game started (a failed launch, not
  scored; `duelBotEndedWithoutGame`, `duelHadGame`) → CANCELLED. A left game
  the bot later reads as not scored reads `released` too. A READY 1v1 whose
  game never started is never cancelled by a `released` read: that read is as
  likely transient (the Game Coordinator dropped the Create, the lobby was
  gone after a reconnect, a player's Release before the start, the idle
  release), so it reads like `idle`: the panel stays playable (Create makes a
  fresh lobby), the worker's retry asks for one (`duelBotLobbyMissing`), and
  `SETUP_MINUTES` still bounds the wait. To end one, "Call it off".
- **Early leave ships off.** The bot can leave a running game early to be
  free for the next (`DOTA_BOT_EARLY_LEAVE`, a comma list of kinds; unset is
  today's behaviour exactly). Until a kind is listed after its live test, a
  1v1 holds the bot to its postgame. The site already handles `left` (game
  running, bot free).
- **The BUSY self-heal knows 1v1 keys:** a create that finds the bot holding
  a closed 1v1's key (COMPLETED, CANCELLED, AWAITING_RESULT) releases it. A
  5v5's Create (in-house or season, `freeBotFromClosedInhouseGame(kind)`)
  also releases a READY 1v1's lobby whose game hasn't started: the 5v5 comes
  first. Its panel reads that hold as one Create frees (`botBusyElsewhere`:
  closed, `unstarted`; "The bot is holding a 1v1 lobby that hasn't
  started"), so its card never latches to hand hosting. The 1v1 stays READY;
  the worker's retry makes its lobby again once no 5v5 is being set up. A
  1v1's own Create never takes another 1v1's bot. Season matches aren't in
  `duelBotSavedFor5v5`, so a season Create could in principle race the
  worker's retry; the season bot is opt-in and off in production.

## Results

OpenDota only, as the 5v5's:

1. The bot's reported match id for this 1v1 (`botMatchId`), checked like a
   pasted id. While OpenDota doesn't have it yet, the scan reads only that
   match (not two histories, which can't hold an unpublished game either)
   until `BOT_MATCH_WAIT_MINUTES` (120) after the game started
   (`duelBotMatchWaitOver`, the 5v5's DETECT_BOT_MATCH_WAIT_MINUTES).
2. Else both players' recent matches (`fetchRecentMatches`): a match in BOTH
   lists in 1v1 Solo Mid (game mode 21) that started at most
   `START_GRACE_SECONDS` (120) before the pairing and before any later 1v1
   of either player was paired (`sharedDuelMatchIds`, oldest first), fetched
   and checked.

`validateDuelMatch` wants exactly two players, game mode 21, both linked
accounts on opposite sides, a start no earlier than the floor and before the
next 1v1's pairing (the ceiling, `duelResultCeilingSeconds`: players freed by
"1v1 over" run it back at once, and the rematch's match must never land on
the earlier 1v1; the 5v5's `inhouseResultCeilingSeconds`), a duration and a
winner. `dotaMatchId` is unique, so one Dota match records one 1v1. The scan
runs only in the worker, only for a 1v1 whose game started (PLAYING or
AWAITING_RESULT: a READY 1v1 has no game): from `SCAN_AFTER_MINUTES` (5)
after pairing, each 1v1 at most once per its interval
(`duelScanIntervalSeconds`: `SCAN_EVERY_SECONDS`, 180, growing with the
game's age to `SCAN_MAX_SECONDS`, 1800, like the 5v5's
`detectIntervalSeconds`), at most `SCAN_PER_PASS` (3) per pass, stalest
`checkedAt` first, claiming `checkedAt` (`duelScanCutoffFor`). OpenDota
unreachable stops the pass. A player (or an admin)
can paste the match id ("Record the 1v1 by match ID", `duelRecord`) under the
5v5's `claimProviderCooldown`.

## Clocks

- **Not accepted:** an ACCEPTING 1v1 `ACCEPT_SECONDS` (60) after pairing,
  without both accepts, is CANCELLED by the worker's next pass
  (`settleDuelAccepts`, run before the pairing sweep so a player put back can
  pair again in the same pass). A live duel wakes the worker every pass, and
  the held long-poll wakes at the deadline (canAccept turns false).
- **Never played:** a READY 1v1 with no started game `SETUP_MINUTES` (30)
  after pairing is CANCELLED (this includes waiting too long for a busy bot).
  Where a bot can host 1v1s, only on the bot's read taken in the same worker
  pass showing no game starting (`neverPlayedMayClose`): a game launched near
  minute 30 whose read the pass didn't get (its deadline, an unreachable bot)
  waits for the next pass. `GIVE_UP_HOURS` after pairing it closes
  regardless.
- **Result never showed:** PLAYING or AWAITING_RESULT with no result
  `GIVE_UP_HOURS` (3) after pairing is CANCELLED.
- **The scan never runs forever:** only PLAYING and AWAITING_RESULT 1v1s
  are scanned, and the give-ups close them.
- **The worker wakes** (`automation-gate.ts`, `duelWorkerWakeAtMs`, gate v15):
  every pass while a 1v1 is live (the bot's reads and the create retry) or two
  present waiters could pair; otherwise at the earliest queue expiry and each
  open 1v1's next scan, setup call-off or give-up (`duelNextClockMs`). 1v1s
  never enter `activeLobbies` or its slot-count invariant.
- **The room's held long-poll wakes** (`inhouseRoomWakeAt`, `duelRoomClocks`)
  at the moments the 1v1 block reads differently with no write: a queue row's
  expiry, a waiter turning away, a result or a cancel leaving its 10-minute
  window.

## Where it runs

- **The room.** `loadInhouseRoomRows` reads the 1v1 rows after the 5v5's
  (`loadDuelRoomRows`, its own module so `inhouse-service.ts` and the engine
  never import each other in a cycle), and `buildInhouseState` adds an
  additive `duel` block (`buildDuelState`) after every 5v5 field, which stay
  as they were. The block's MMR-cap refusal is the page's `joinRefusal` prop
  (the same rule), so a poll reads nothing more for it. The poll heartbeats
  the viewer's 1v1 queue row as the 5v5's (`duelHeartbeatAction`,
  `touchDuelQueueHeartbeat`, seam `inhouse.pollInhouseState.beforeDuelHeartbeat`),
  publishing and expiring the gate only when it turned them present. No 1v1
  resolver ever runs in a poll; a 1v1 queue row or open 1v1 is a stake that
  keeps a hidden tab polling (`duelStake`).
- **The route.** `POST /api/inhouse` actions `duelJoin`, `duelLeave`,
  `duelOver`, `duelCallOff`, `duelRecord` (`matchId`; a scan action with the
  long timeout), `duelCancel` (admin), `duelRemove` (admin, `userId`) and
  `duelVoid` (admin), each with the `duelId` the room showed. Refusals answer
  400 with their words; the route's publish, its finally and its gate expiry
  cover them as every 5v5 action.
- **The worker.** `syncInhouse` (`result-sync-service.ts`) runs the 5v5 half
  (`syncInhouseLobbies`), then `syncInhouseDuels`: one cheap probe
  (`duelWorkPending`), then `runDuelWorkerSteps` (expire the queue, the
  pairing sweep, the bot's reads, the create retry, the scan, the give-ups),
  each step in its own try/catch, all of it in one more. The 5v5's idle early
  return no longer ends the inhouse pass, and a 1v1 failure never fails the
  5v5 work. The steps are worker-only, pinned by
  `src/lib/inhouse-resolver-parity.test.ts` (`WORKER_ONLY`) without loosening
  the 5v5 parity.

## The card

`DuelSection` (`src/components/inhouse/duel-section.tsx`), rendered by the room
shell below every 5v5 card and before the admin panel, as
`<section aria-label="1v1 mid">` with the h2 "1v1 mid". Its rules are pure
helpers in `inhouse-duel.ts` (`duelJoinRow`, `duelResultLine`,
`duelStageLabel`, `duelResultLanded`), pinned by source guards in
`inhouse-duel.test.ts`.

- The intro, `DUEL_CARD_INTRO`, for everyone; Sign in to play 1v1 (back to
  the card itself, `DUEL_SIGN_IN_RETURN` = `/inhouse#inhouse-1v1-room`;
  never the 5v5 invite path `/inhouse?join=1`, which would join the 5v5
  queue), Join 1v1, or Leave 1v1 with `DUEL_WAITING_NOTE` ("…plays you while
  this page is open.") and the queue's expiry (`LocalTime`); a refusal, or
  `DUEL_NO_BOT_NOTE`, in Join's place.
- The viewer's 1v1 (`DuelGameCard`): "1v1 found" while ACCEPTING, with the
  accept panel (`DuelAcceptPanel`: **Accept 1v1** and **Decline 1v1** with
  the time left, then "You accepted. Waiting for X to accept."); the opponent
  with their medal, each side, the bot's panel or the waiting note, the setup countdown
  (`role="timer"`), "Call it off" while it hasn't started, "1v1 over" in
  PLAYING, the give-up time, and "Record the 1v1 by match ID".
- The viewer's last result for 10 minutes ("You beat X" / "X won"), or,
  when newer, their last 1v1 that ended without one (`lastCancelled`,
  `duelCancelLine`: "Your 1v1 was called off.", "No game started within 30
  minutes, so the 1v1 was cancelled.", "The game didn't start, so the 1v1
  was cancelled.", "No result showed on OpenDota, so the 1v1 was
  cancelled.", "An admin voided your 1v1 result."), so a 1v1 never just
  vanishes; the waiters; the other live 1v1s one line each; an admin's rows
  (`DuelAdminTools`: "Remove from the 1v1 queue", "Admin: cancel 1v1",
  "Admin: void 1v1 result", each confirmed; nothing at all while there is
  nothing to act on, `duelAdminToolsVisible`).
- **No control shares a 5v5 name** ("Join queue", "Leave queue", "ACCEPT
  MATCH", "Decline", "Game over — queue again", "Get into the Dota lobby", "Your side",
  "Record by match ID", an input labelled MMR): the 5v5 e2e specs find their
  controls by those names.
- The card itself never rings: the accept's bell and desktop alert come from
  the room's one ring (`inhouseAlerts`' `duel-found`; the room pins exactly
  two `playChime()` calls).
- A new result refreshes the page, so the server-rendered leaderboard shows it.

## Leaderboard

Derive-don't-store, like the 5v5 ladder: `duelLadder` runs `summarizeInhouse`
and `rankInhouse` over every COMPLETED 1v1 in `[createdAt, id]` order with
sides of one (plain one-on-one Elo, start 1000, K 32; unit-tested).
`loadDuelLadder` memoizes per instance on the completed count and the latest
`completedAt` (a result moves the latest, a void the count).
`DuelLadderCard` (`src/app/inhouse/duel-ladder-card.tsx`) streams in its own
Suspense after the 5v5 ladder, section `inhouse-1v1` ("1v1 mid leaderboard",
"1v1" in the section nav): #, player, rating, W, L; provisional players
(under `PROVISIONAL_GAMES`) after, unranked; `overflow-hidden` with `<col>`
widths; empty, "No 1v1s recorded yet. Win one to top this board." It shows
whether or not any 5v5 has been played. Nothing new sits above the 5v5 queue
card, so its first-screen fit (`e2e-mid/zz-inhouse-queue-fit.spec.ts`) is
unchanged.

## Tests

- Pure: `src/lib/inhouse-duel.test.ts` (pairing, clocks, the match check,
  the ladder, the room block, the heartbeat, the wakes, the card's rules and
  source guards).
- Engine: `test/integration/inhouse-duel.itest.ts` (raced joins, leave,
  results, voids, the scan, give-ups; raced for real only under
  `npm run test:pg`).
- Bot: `test/integration/dota-lobby.itest.ts` ("1v1 bot jobs (kind duel)").
- Room, worker, gate: `inhouse-room-poll.itest.ts` ("the 1v1 queue
  heartbeat"), `result-sync.itest.ts` ("the 1v1 duels run after the 5v5
  work"), `automation-gate.test.ts` / `automation-gate.itest.ts`,
  `inhouse-room-wake.test.ts`, `src/app/api/inhouse/route.test.ts`.
- Guards: `inhouse-room-publish.test.ts`, `inhouse-room-state.test.ts`,
  `inhouse-resolver-parity.test.ts`.
- Browser: `e2e/zz4g-inhouse-1v1.spec.ts` (the e2e server has no lobby bot:
  no Join and the API refuses; a 1v1 written to the database shows with the
  bot's "can't host" line, is called off and says so; a recorded 1v1 tops
  the board, at 390px). Pairing itself is covered by the itests.
- Postgres only: the pair claim's staged interleaving (a waiter leaving
  between the pairing read and the claim, seam
  `inhouseDuel.joinDuelQueue.beforePairClaim`).
- Live test (Tim's OK, not run by builders): the checklist in
  [DOTA-LOBBY-BOT](../DOTA-LOBBY-BOT.md#early-leave-live-test).
