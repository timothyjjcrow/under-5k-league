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
  old), in no live 5v5 lobby and in no live 1v1 (`pickDuelOpponent`). No
  accept step; sides are random (`assignDuelSides`). With nobody to pair, the
  joiner waits; a queue row expires `QUEUE_MINUTES` (30) after the join, and a
  repeat join refreshes it. The worker's sweep (`pairDuelQueue`) pairs two
  present waiters a join couldn't (one was away, or in a 5v5).
- **Signed in only, the 5v5's MMR cap** (`duelMmrRefusal`, the 5v5's
  `inhouseJoinRefusalBeforeTyping`; a 1v1 takes no typed MMR). Refused while
  in a live 5v5 lobby (`INHOUSE_ACTIVE_STATUSES`) or a live 1v1. A 5v5 join
  does not refuse a player in a 1v1 (open question; the 5v5 is unchanged).
- **No cap on how many 1v1s exist.** The one bot hosts one lobby at a time,
  so 1v1s wait their turn for it.
- **Statuses** (`INHOUSE_DUEL_STATUS`): READY (paired) → PLAYING (the bot read
  the launch) → AWAITING_RESULT (the bot read Dota's end, or a player pressed
  "1v1 over") → COMPLETED | CANCELLED. Live is READY and PLAYING
  (`INHOUSE_DUEL_LIVE_STATUSES`); a result can land on READY, PLAYING and
  AWAITING_RESULT (`INHOUSE_DUEL_RESULT_STATUSES`). AWAITING_RESULT frees the
  two: they may join the 1v1 queue again while the result is on its way.
- **Bot only, never by hand** (Tim's amendment). There is no "host it
  yourselves" path and no "We're playing" press: PLAYING comes only from the
  bot's started read. "1v1 over" stays as the fallback for a bot game whose
  end the bot missed (PLAYING only).
- **Call it off** (either player): a READY 1v1 whose game never started is
  CANCELLED. **Admin**: cancel any 1v1 a result can still land on, void a
  COMPLETED one (the ladder recomputes without it), and take a player out of
  the 1v1 queue. All logged (`logAdminAction`; the void's `AdminAction`
  commits with its claim).
- **Every close lets the bot go.** Call off, admin cancel, both give-ups, a
  failed launch, "1v1 over", the bot's own end read and a recorded result
  all call `releaseDuelBotAfterClose` (fire-and-forget, after the commit).
- **No Discord** in v1: no pings, posts or board line. Home is unchanged.
- **Europe runs the same code.** With no ticket the bot can't host, so the
  card waits on it.

## Data

- `InhouseDuelQueueEntry {userId @unique, joinedAt, lastSeenAt, expiresAt}`.
- `InhouseDuel {status, radiantUserId, direUserId, createdAt, startedAt,
  finishedAt, completedAt (the immutable result clock), checkedAt (the scan's
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

- **Auto-create.** A pair formed by a join asks the bot for its lobby after
  the response (`runAfterResponse(createDuelBotLobby)`, after the commit and
  the publish; never inside a transaction or a room poll). A busy bot, or one
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
  released; a job `released` with no game (failed launch, not scored, idled
  out, released before a launch) → CANCELLED. A left game the bot later reads
  as not scored reads `released` too.
- **Early leave ships off.** The bot can leave a running game early to be
  free for the next (`DOTA_BOT_EARLY_LEAVE`, a comma list of kinds; unset is
  today's behaviour exactly). Until a kind is listed after its live test, a
  1v1 holds the bot to its postgame. The site already handles `left` (game
  running, bot free).
- **The BUSY self-heal knows 1v1 keys:** a create that finds the bot holding
  a closed 1v1's key (COMPLETED, CANCELLED, AWAITING_RESULT) releases it.

## Results

OpenDota only, as the 5v5's:

1. The bot's reported match id for this 1v1 (`botMatchId`), checked like a
   pasted id.
2. Else both players' recent matches (`fetchRecentMatches`): a match in BOTH
   lists in 1v1 Solo Mid (game mode 21) that started at most
   `START_GRACE_SECONDS` (120) before the pairing (`sharedDuelMatchIds`),
   fetched and checked.

`validateDuelMatch` wants exactly two players, game mode 21, both linked
accounts on opposite sides, a start no earlier than the floor, a duration and
a winner. `dotaMatchId` is unique, so one Dota match records one 1v1. The scan
runs only in the worker: from `SCAN_AFTER_MINUTES` (5) after pairing, each 1v1
at most once per `SCAN_EVERY_SECONDS` (180), at most `SCAN_PER_PASS` (3) per
pass, stalest `checkedAt` first, claiming `checkedAt`. A player (or an admin)
can paste the match id ("Record the 1v1 by match ID", `duelRecord`) under the
5v5's `claimProviderCooldown`.

## Clocks

- **Never played:** a READY 1v1 with no started game `SETUP_MINUTES` (30)
  after pairing is CANCELLED (this includes waiting too long for a busy bot).
- **Result never showed:** PLAYING or AWAITING_RESULT with no result
  `GIVE_UP_HOURS` (3) after pairing is CANCELLED.
- **The scan never runs forever:** only READY, PLAYING and AWAITING_RESULT
  1v1s are scanned, and the give-ups close them.
- **The worker wakes** (`automation-gate.ts`, `duelWorkerWakeAtMs`, gate v14):
  every pass while a 1v1 is live (the bot's reads and the create retry) or two
  present waiters could pair; otherwise at the earliest queue expiry and each
  open 1v1's next scan, setup call-off or give-up (`duelNextClockMs`). 1v1s
  never enter `activeLobbies` or its slot-count invariant.
- **The room's held long-poll wakes** (`inhouseRoomWakeAt`, `duelRoomClocks`)
  at the moments the 1v1 block reads differently with no write: a queue row's
  expiry, a waiter turning away, a result leaving its 10-minute window.

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

- The intro, `DUEL_CARD_INTRO`, for everyone; Sign in to play 1v1, Join 1v1,
  or Leave 1v1 with the queue's expiry (`LocalTime`); a refusal in Join's
  place.
- The viewer's 1v1 (`DuelGameCard`): the opponent with their medal, each
  side, the bot's panel or the waiting note, the setup countdown
  (`role="timer"`), "Call it off" while it hasn't started, "1v1 over" in
  PLAYING, the give-up time, and "Record the 1v1 by match ID".
- The viewer's last result for 10 minutes ("You beat X" / "X won"); the
  waiters; the other live 1v1s one line each; an admin's rows
  (`DuelAdminTools`: "Remove from the 1v1 queue", "Admin: cancel 1v1",
  "Admin: void 1v1 result", each confirmed).
- **No control shares a 5v5 name** ("Join queue", "Leave queue", "ACCEPT
  MATCH", "Game over — queue again", "Get into the Dota lobby", "Your side",
  "Record by match ID", an input labelled MMR): the 5v5 e2e specs find their
  controls by those names.
- No sound or desktop alert (the room pins exactly two `playChime()` calls).
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
- Browser: `e2e/zz4g-inhouse-1v1.spec.ts` (two players pair, one calls it
  off, a recorded 1v1 tops the board, at 390px).
- Live test (Tim's OK, not run by builders): the checklist in
  [DOTA-LOBBY-BOT](../DOTA-LOBBY-BOT.md#early-leave-live-test).
