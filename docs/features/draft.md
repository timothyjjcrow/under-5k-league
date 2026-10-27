# Draft and auction

The live auction (captains nominate and bid until rosters are full) and the
admin tools that start, pause, repair and abort it. Engine:
`src/lib/draft-service.ts` over pure rules in `draft.ts`. Client:
`src/components/draft-room.tsx` on `/draft`, polling `src/app/api/draft/*`.
Admin actions: `src/app/actions/admin-captains-draft.ts`. Helpers:
`draft-setup.ts`, `draft-budgets.ts`, `draft-admin.ts`, `draft-history.ts`
(run and lot receipts), `draft-feed.ts`, `draft-recap.ts`.

## How the auction advances

- **Clocks are server-authoritative and resolve lazily.**
  `resolveExpiredNomination` (bid clock out) and `resolveStalledNomination`
  (nominator's clock out) both run in `getDraftState`, `pauseDraft` and the
  worker's `syncDraftClocks` (`result-sync-service.ts`), so the auction moves
  with nobody watching. `nominatePlayer` and `placeBid` run only
  `resolveExpiredNomination`: a nominate or bid never settles a stalled
  nominator clock. A signed-in room tick resolves only when the room's copy
  shows the running clock run out (`draftRoomDue`), and then only the
  winner of the `draftRoomMaintenanceAt` 2s claim; anonymous ticks are
  read-only (the tick, below). Timers are `DEFAULTS` in `constants.ts`; a
  lot nobody can outbid gets the short clock (`bidClockSeconds`).
- **Phase is the outer gate.** Resolvers and draft mutations no-op unless the
  season is active and in DRAFT, so a live Draft row stranded outside DRAFT
  never auto-sells before an admin repairs it.
- **Auto-nominate only for a team that can pay.** The stall resolver opens the
  top-MMR player at `MIN_BID` only if pure `canNominate` (open seat AND
  `maxBid >= MIN_BID`) holds: it is the one nomination path with no
  affordability check, and it once drove a budget negative. Otherwise it
  advances the rotation; `nextNominatorIndex` skips broke teams too, so it
  can't cycle, and `-1` means complete. A healthy auction never hits this
  (`maxBid` keeps `budget >= need * MIN_BID`). Covered by `draft.itest.ts`'s
  broke-nominator and pool-dry cases.
- **A dry pool completes the draft.** With no undrafted ACTIVE PLAYER left,
  both resolvers mark it COMPLETE; short teams play with standins.
  `startDraft`'s toast warns when seats outnumber the pool.

## Every transition is a guarded claim

- **`resolveExpiredNomination` claims the exact lot before awarding it**
  (status, nominee, price, bidder, `bidEndsAt`, `currentLotId`): two pollers
  make one sale and one budget decrement.
- **Void, don't sell, a nominee who is no longer an ACTIVE PLAYER** (withdrawn
  or flipped to STANDIN mid-lot): no charge, no roster row, their Bid rows
  deleted, rotation advances. Both halves pinned in `draft.itest.ts`.
- **`resolveStalledNomination` claims the auto-nomination and both
  completion/advance branches** on `nominationEndsAt` (no duplicate opening
  Bid, no double completion post), and advances if the team on the clock is
  full.
- **`nominatePlayer` re-asserts the empty lot AND the turn it authorized**
  (`nominatorTeamId`, `nominationEndsAt`, `updatedAt`). Team id alone doesn't
  identify a turn; Undo can repoint the turn to the refunded buyer, and a
  stale nomination would steal it. Seam `draft.nominatePlayer.beforeClaim`
  (Postgres-only test in `draft.itest.ts`).
- **`placeBid` is an optimistic lock** on status, nominee, price, bidder,
  `bidEndsAt`, `updatedAt` and `currentLotId`. Keep status in the WHERE, or a
  bid landing just after a pause re-arms the clock. Bid-vs-bid is raced in
  `robustness.itest.ts`; no test races a bid against the expiry resolver.
- **Room requests carry what the captain saw** (`DraftTurnExpectation` /
  `DraftLotExpectation`, `draft-http.ts`) and are refused if it moved: the
  room stays open across aborts and restarts.

## Starting the draft

- **`startDraft` checks everything inside one Serializable transaction:** 2+
  captains and 1+ undrafted player (`draftSeatPlan`), captain-only teams,
  distinct draft orders, and no COMPLETED match or imported Game (seam
  `admin.startDraft.beforeTx`), so Start never opens an auction over a played
  league.
- **Start is a one-shot claimed at the write:** CREATE the Draft row (a rival
  loses on the unique, P2002) or, after an abort, `updateMany` re-asserting
  NOT_STARTED. Either loss throws `DraftAlreadyStartedError`, rolling back
  budgets and phase. Both doors raced in `admin-flow-audit.itest.ts`.
- **Setup locks at Start.** `addCaptain`, `removeCaptain` (seam
  `admin.removeCaptain.beforeTx`), `randomizeDraftOrder` and
  `setDraftSettings` require `draftSetupOpen` and re-read season and draft in
  a Serializable transaction.
- **No unique index on draft order.** Serializable `addCaptain` plus
  `startDraft` refusing duplicates cover it; `@@unique([seasonId,
  draftOrder])` would break `randomizeDraftOrder`'s one-team-at-a-time
  rewrite (`docs/DECISIONS.md`).

## Budgets

- **Budgets are MMR-weighted per captain.** `mmrWeightedBudgets` gives the
  lowest-MMR captain `base * (1 + w)` and the highest `base * (1 - w)`,
  linearly between, with `w` = `Season.budgetMmrWeight` percent (0 = flat).
  It reaches full strength only at a `BUDGET_FULL_EFFECT_GAP` MMR gap, so
  near-equal captains get near-equal budgets. The floor is
  `(teamSize - 1) * MIN_BID`, so every team can fill.
- **Stored MMR 0 means unknown and gets the base budget.** Every caller maps
  `0` to `null`, or its projection disagrees with Start.
- **After Start, `Team.budget` is authoritative.** `draftBudgetsForDisplay`
  projects with Start's exact weighting while setup is open (the admin card
  says "projected") and never recomputes a started auction from registration
  MMRs. The weight is set with `setDraftSettings` until Start; new seasons
  carry it over. Seed medals follow signup MMR (`approxRankTierFromMmr` in
  `prisma/seed.ts`), so demo medals match demo budgets.
- **A captain's budget MMR is flagged when nothing backs it**
  (`classifyCaptainMmr`, `captain-mmr.ts`, tested): "unverified" when it is
  unknown (0), has no medal to check it against, or sits outside the medal's
  clamp window; otherwise "medal-backed". Typing low buys a bigger budget, and
  the signup clamp only checks players who have a medal. Warn and name, never
  block: the captain's row, the Start-draft confirm and `adminNextStep`
  (`unverifiedCaptainMmrNames`). Silent when `budgetMmrWeight` is 0, since MMR
  then moves no money. An admin clears a flag by saving a matching medal under
  "Manual correction" (`setPlayerRank`, `User.rankTierManual`); there is no
  separate "admin-approved" state without a schema change.

## Admin draft-night controls

In the Captains & draft card on `/admin` and inside the room
(`draftToolbarControls`; same actions, confirm text from `draft-admin.ts`).

- **Pause parks clocks; Resume re-arms them.** `pauseDraft` runs both
  resolvers first, so a pause just after zero settles the expired clock
  instead of earning a fresh one. Nothing sells while PAUSED (everything keys
  off IN_PROGRESS). `resumeDraft` claims on `updatedAt`.
- **Void live lot** (`voidCurrentLot`, PAUSED with a lot up) records no sale,
  deletes that player's Bid rows and keeps the same nominator. It is Undo's
  companion, since Undo can't touch a live lot.
- **Undo last sale reverts the newest AUCTION PURCHASE.** `undoLastSale`
  deletes the row, refunds it, deletes that player's Bid rows (the bid trail
  is keyed by draft and player, so old rows replay voided prices) and gives
  the buyer the next nomination. It works from COMPLETE (reopening the
  auction, which its `undoSaleConfirm` text says), keeps PAUSED paused
  (resuming silently was a bug), refuses while a lot is live, and runs only in
  the DRAFT phase.
- **Filter undo on `price > 0`; it is exact.** Non-captain rows come only from
  a sale (at least `MIN_BID`) or `signFreeAgent` ($0). Unfiltered, undo in a
  pool-dry season deleted a $0 signing instead of the disputed sale. Since it
  can skip newer signings, keep the toast naming the purchase (player, team,
  price). Tested in `abort-draft.itest.ts`.
- **Undo reverts only the sale its confirm named.** Both Undo forms post
  `expectedSaleMembershipId`, the roster row of the sale the confirm names,
  and `undoLastSale` refuses before any write unless that row is still the
  newest auction purchase ("A newer sale landed since this page loaded: …",
  or that the named sale can no longer be undone). /admin doesn't poll during
  the auction, so a confirm rendered at sale #5 used to revert sale #12. A
  form without the id (rendered by an older build; the action id survives a
  release) is refused with "reload", never undone blindly. Both surfaces pick
  the target with pure `undoSaleTarget` (`draft-admin.ts`, undoLastSale's
  rule over roster rows): /admin over its rosters, the room from the poll's
  `undoSale` (admins only, computed from the rosters `getDraftState` already
  reads). Never from `recentSales[0]`: a released player's lot stays SOLD in
  that history, and naming it reverted the sale before it. Undo renders only
  once something has sold. Tested in `draft-history.itest.ts` (staged, not
  raced: the id comparison inside the transaction is the only check, and a
  sale committing mid-undo is a P2034 on the Draft row); the forms are
  source-guarded in `draft-admin.test.ts`.
- **Undo re-asserts "no live lot" at its last write and THROWS if it lost.**
  A stall resolver can open a lot during undo's intermediate writes; a blind
  write left a live lot and a nomination clock at once, and the next expiry
  sold the player to a team that never nominated them. `UndoRaceError` is
  caught outside the callback (a return would commit the refund). Raced in
  `abort-draft.itest.ts`; only `npm run test:pg` exercises it. Its first
  write, the roster delete, is `deleteMany` plus a count, so a second Undo or
  an Abort gets a refusal instead of crashing on P2025. It runs Serializable,
  pairing with `setSeasonPhase`'s Draft read.
- **Abort draft is the way back from a premature Start.** Nothing else resets
  `Draft.status` to NOT_STARTED, and setup stays locked until it does. In one
  Serializable transaction `abortDraft` claims the draft, returns every row
  that isn't the team's `Team.captainId` to the pool, zeroes kept captain
  rows, credits each team all its rows cost (a price paid for a player later
  made captain included), clears Bid rows, deletes unplayed fixtures (their
  check-ins, picks, cover and reschedules cascade), fantasy rosters, sent
  week-reminder markers and every team's group (`Team.groupKey`, drawn from
  the rosters the abort dissolves, so the next generate draws afresh), and
  drops the season to SIGNUPS so captains can be
  fixed and late players register. Draft time and readiness acknowledgements
  stay. Losses throw `AbortRaceError`; raced by `raceN(4)` in `draft.itest.ts`.
- **Abort keeps captains and teams and stops at the first result.** It refuses
  once any match is COMPLETED or not SCHEDULED, or any Game exists (rosters
  then carry standings and brackets); the button hides on the same results
  check. It is not phase-gated on purpose: recovering a season whose phase
  moved is the point. It is a type-to-confirm `DangerSubmit`, and the action
  stands down cancelled standin bookings after commit. Its toast says whether
  the "auction stopped" post went out (`sendDiscordMessage`'s boolean, worded
  like `setSeasonPhase`'s), never "Discord was notified" by default.
- **Admin auto-nominate shows only while IN_PROGRESS** (`adminNominationTeam`)
  and confirms, since it spends another team's turn; Max bid confirms too.
  `setDraftNight` doesn't re-announce an unchanged timestamp.

## Phase and signup locks

- **Leaving DRAFT is refused while the auction is IN_PROGRESS or PAUSED**
  (paused is not finished). Pure `seasonPhasePolicy`
  (`season-phase-policy.ts`), tested in `season-phase.itest.ts`.
- **A phase button never moves back into DRAFT** except to restore a
  stranded IN_PROGRESS/PAUSED auction; a redo goes through Abort. Undo needs
  only `season.status === DRAFT`, so re-entering would re-arm the auction
  against a live league and the stall resolver would auto-sell a signup
  mid-season.
- **Nobody can withdraw the player on the block**, or rooms show a headless
  lot that still charges a team. Admin `withdrawSignup` (`admin-roster.ts`)
  checks at read and in its transaction (tested in
  `admin-flow-audit.itest.ts`); `leaveLeague` uses
  `withdrawGateError({ isOnTheBlock })`.
- **`saveRegistration` locks three doors while the auction is live or
  paused:** type flips are refused; a WITHDRAWN player can't re-activate by a
  replayed POST (a REMOVED one falls to the write-time claim, whose message is
  true); a PLAYER's MMR is FROZEN with a toast note, not refused, because every
  poll re-reads it for the pool sort and auto-pick. Tested in
  `registration.itest.ts`. The admin "Edit medal & MMR"
  (`AdminPlayerRankEditor`) stays visible until COMPLETE but locks a PLAYER's
  MMR for the same window (`mmrLocked`, re-checked in `setPlayerRank`, which
  throws `DraftAlreadyStartedError`); medal corrections stay open, and the
  admin editor never locks a standin's MMR. A player's own edits lock for
  everyone once the auction is done (`mmrSelfEditLocked`,
  `players-and-registration.md`).

## The /draft page and routes

- **`/draft` never gates on the phases the room moves through.** In SIGNUPS or
  DRAFT it renders any auction status (a static gate never learns the admin
  pressed Start). Later phases redirect to `/teams`, except while the auction
  is IN_PROGRESS or PAUSED: that stranded state must stay visible, so don't
  widen the redirect. No active season shows the empty state.
- **Polls and mutations use separate rate-limit buckets:** tick has a per-IP
  and a per-user bucket; bid, nominate and admin-nominate share one per-user
  mutation bucket. Limits are in each `route.ts` (`rateLimit` keys `draft:*`).

## The tick: one shared copy of the room, and the long-poll

`POST /api/draft/tick` (`src/app/api/draft/tick/route.ts`) over
`src/lib/draft-room-state.ts`, with the mechanism shared with the inhouse
room (`room-wait.ts`, `room-version.ts`, `inhouse-room-cache.ts`'s
`createRoomCache`) and the draft's own bindings (`draft-room-wait.ts`,
`draft-room-version.ts`, the pure `draft-room-wake.ts`).

- **Each server instance builds every viewer's reply from one copy of the
  room, checked against the draft room version on every tick.** The copy is
  `loadDraftRoomRows`: the same Serializable snapshot `getDraftState` reads
  (season, auction, rosters, pool, lot, sales, the nominee's profile and
  contact, the active registrants' ids) plus the captains' last-seen times.
  `buildDraftState(viewer, rows, nowMs)` is pure and the only place the gated
  fields (the nominee's Discord, the admin's Undo target) become a reply;
  `getDraftState` is now the resolvers plus a fresh load plus the same
  builder, for the action routes, the claim winner, scripts and tests.
  Fifty viewers asking about one change cost one read per instance, not
  fifty. `draft-room-longpoll.itest.ts` pins that every kind of viewer gets
  exactly the fresh read's reply from the copy (sabotage-verified on the
  contact gating).
  - **The copy serves only while its label equals the version just read**
    (`DRAFT_ROOM_VERSION`, an opaque UUID like the inhouse room's), this
    instance has not published since the load began, and it is younger than
    `ROOM_SNAPSHOT_MAX_AGE_MS` (15s). No version row means uncached: every
    tick reads fresh and nothing is stored. One active season, one copy.
  - **"In the room" is judged per reply** from the stored last-seen times,
    so a captain who left reads away 90s later without a write. A captain's
    tick writes their heartbeat (`recordCaptainPresence`, at most every 20s)
    and, when the copy showed them away and the write landed, publishes, so
    every tab shows them back at once.
- **Rule P (draft): after any commit the draft room shows, call
  `publishDraftRoomChange()` before any Discord call and before the
  response, never inside a transaction** (`draft-room-version.ts`). The
  engine's writers publish their own commits, and only commits: the two
  resolvers when they resolved (before the completion posts), and pause,
  resume, void, undo, abort, nominate and bid on `ok`. Every other writer of
  the room's tables publishes after its commit: the captain and draft
  actions (add, remove, change, transfer, order, Start, the draft night,
  refreshed player data), the roster actions (withdraw, reinstate, MMR,
  medal, sign, release, promote), the season actions (create, archive,
  cancel, delete, reactivate, phase, rename, draft settings), the signup
  save and withdrawal, and a changed team name or logo
  (`saveTeamIdentity`). `src/lib/draft-room-publish.test.ts` finds every
  writer of the room's tables, requires the publish (or a listed reason the
  room doesn't show the write), pins the engine's order and that no publish
  sits in a `$transaction`. Writers of display-only fields (a refreshed name
  or avatar) don't publish and show within the copy's max age; a player's
  own Discord handle and Dota link do (`updateDiscordName`, `unlinkDiscord`,
  `updateDotaAccount`), since the lot card shows them.
  - **Release outside a live auction** (the draft-night rule already). A
    slot built before 2026-10-23 writes without publishing, so during the
    first release's 90s overlap (or a rollback past it) the new slot's copy
    can lag a bid on the old slot by up to the copy's 15s.
- **The hold (`holdDraftRoomPoll`) reads only this instance's copy and
  writes nothing.** A tick whose `since` is the version the route just read
  (`parseDraftHold`, clamped to `LONG_POLL_HOLD_MS`) waits, with no database
  connection, until the version moves (a publish in this process, rechecked
  after `LONG_POLL_COALESCE_MS` and woken with up to `LONG_POLL_JITTER_MS` of
  jitter, or the 2s watch for the other release slot), the auction's clock
  as it wakes this viewer, its hold, the process stopping, or the client
  leaving (204, no tick). Then the route re-reads the session, the active
  season (a season archived or opened during the hold answers 404 or 409,
  never the old room) and the version, and ticks as an unheld request would.
  A signed-out hold never wakes on a clock, so it loads no copy. Every reply
  carries `held` and `roomVersion`, the version its rows were read under
  (read BEFORE them): the one read beside the session, or the copy's after
  the tick's own publish (a captain back in the room, a settled clock), so
  that client holds next instead of asking again.
- **Who wakes at a clock decides how many tabs ask at once**
  (`draftRoomWakeAt`). A captain's or an admin's held tick wakes
  `LONG_POLL_CLOCK_GRACE_MS` after the running clock (the lot's bid clock,
  or the nominator's clock) and settles it under the 2s claim; that settle's
  publish wakes everyone else. Any other signed-in viewer wakes only at the
  clock plus `LONG_POLL_DUE_RETRY_MS` (2.25s), so with no captain or admin
  in the room a pool player's tick settles the lot, as the old 5s poll did.
  A signed-out tick never wakes on a clock and never settles. A clock that
  ran out after the reply the client shows (`sinceNow`) answers at once; one
  the client has already seen at zero with the version unchanged is retried
  at the due retry. `draftRoomDue` mirrors both resolvers' act conditions,
  source-guarded against their early returns.
- **The registry is one per process per room, on `globalThis`**
  (`ggd2l.draftRoomWait.v1`): a `next start` process loads `src/lib` twice,
  and the admin's pause (a server action) must wake the route's held ticks.
  A draft publish never wakes an inhouse hold, nor the reverse. A stopping
  process answers every hold at once and reports new ones unheld.
- **Tests:** `draft-room-wake.test.ts` (the clocks), `room-poll.test.ts`
  (the client's rules), `src/app/api/draft/routes.test.ts` (hold, re-read,
  abort, `held`, the season checks, a stopping process),
  `draft-room-publish.test.ts` (rule P) and
  `test/integration/draft-room-longpoll.itest.ts` (through the real route: a
  bid, a server action in another module instance and a version moved
  elsewhere each answering a held tick; the captain's settle at zero and
  everyone woken by it; a pool player's fallback settle; a signed-out tick
  that never settles; a clock run out since the shown reply; a captain's
  return; the copy's parity per viewer; an abort; and about one request per
  change plus one per hold).

## The draft room client

- **The room long-polls (Tim's call, 2026-10-23; still plain HTTP, no
  websockets, as the inhouse room since 2026-10-18).** Each tick sends back
  the `roomVersion` of the last reply it applied as `since` (with `sinceNow`,
  that reply's `now`, and the `holdMs` it can wait), the server holds it
  until the room changes, and the next tick leaves from the reply's own
  continuation, so a bid reaches a captain's or an admin's tab in well under
  a second, and a watcher's within its gap (below), at no more than about
  one request per change, plus one per hold. The rules are pure in
  `room-poll.ts` (`draftLongPoll`, `draftLongPollGapMs`, `draftPollDelay`,
  with `roomUnheldStreak` and `roomRefocusResync` shared with the inhouse
  room) and `room-source-guards.test.ts` pins how the room calls them.
  - **Captains and admins hold 10s while the auction is live or paused
    (`LONG_POLL_ACTOR_HOLD_MS`), everyone else 25s.** A held tick's deadline
    is its hold plus `ROOM_POLL_TIMEOUT_MS`, and the room locks bidding after
    `ROOM_POLL_FAIL_THRESHOLD` failures in a row, so a captain's dead
    connection shows about 15s sooner than at the full hold.
  - **A tick that must answer at once is never held** (`urgent`): the first
    of each run of the loop (a `pollKick` from an action error, a clock at
    zero or Retry re-runs it, and its cleanup releases the tick in flight),
    a resync after going offline, an action whose outcome is unknown, a
    retry, and a refocus after a hide of `ROOM_POLL_TIMEOUT_MS` or more,
    which releases the held tick (it may have died with the connection).
  - **A reply with no version (an old slot during a release) falls back to
    the ladder,** never a hot loop. The cadence of the ladder comes only from
    `draftPollCadence` (`src/lib/room-poll.ts`): whether it is fast keys on
    the AUCTION (IN_PROGRESS or PAUSED; PAUSED counts as live so a resume
    shows at once); how fast keys on the VIEWER (`canAct`: a captain or an
    admin). Those who act poll at the room's `pollMs` (2s, source-guarded);
    everyone else (spectators, players in the pool, drafted players) at
    `DRAFT_ROOM.POLL_WATCH_MS` (5s) live and `POLL_WATCH_IDLE_MS` in the
    waiting room. A bid resets a 30s clock, so even on the ladder a captain
    sees it with most of the clock left (`room-poll.test.ts` keeps the watch
    rate inside the clock).
  - **Two ticks never start closer than the gap** (`draftLongPollGapMs`): 1s
    (`LONG_POLL_MIN_GAP_MS`) for a captain or an admin, and outside the
    auction; 3s (`LONG_POLL_WATCH_GAP_MS`) for everyone else while it is live
    or paused. Every publish wakes every held tab, and in a bidding war fifty
    watchers asking once a second cost the box more than the auction needs
    (Tim's call, 2026-10-23: viewers who can't bid may update slower). A bid
    still reaches a watcher at once when the room was quiet, and within 3s as
    a war starts. A version that keeps moving comes back unheld: from the
    second unheld reply in a row a watcher's gap doubles up to the ladder
    rate (5s, the old poll's), while a captain or an admin in a live auction
    keeps 1s. A 15-captain bot rehearsal (2026-10-23; bots bid faster than
    people) measured bids reaching captains at a median of 0.23s (p90 0.66s,
    at most 1s) and watchers at 0.4s (p90 3.4s, at most 5s).
  - **A hidden tab** long-polls only for `draftViewerStake` (captains,
    admins and players still in the pool: the chime and the tab title arrive
    with the change); anyone else's hidden tab doesn't fetch. A failed tick
    in a live auction retries at the viewer's live rate, never the
    waiting-room rate, so `disconnected` trips promptly.
  - **At a clock's zero only a captain's or an admin's tab asks at once**
    (`draftPollsAtClockZero`, which re-runs the loop), and on the server only
    their held ticks wake at the clock (below): they have controls waiting
    on the settled lot. Every other tab sees the sale when the settle
    publishes. When every signed-in tab polled at zero, a full US room sent
    about 63 polls at once per sale, about 2.2 s of the box's one vCPU each
    time (measured 2026-10-17).
- **The poll reads only what the room shows:** the pool's display fields,
  the nominee's profile and contact in one extra read, the run's id and
  provenance, and the last 8 sales while the auction runs (`readDraftSales`
  with `take`, never the accepted-bids log; the finished room's recap reads
  them all). It used to read every player's free text and every sold lot's
  bid log on every poll. Player scouting stays out of it ("Scouting comes
  from the page render, never the poll", below).
  `room-source-guards.test.ts` fails if `DRAFT_ROOM.POLL_*` rates reappear in
  `draft-room.tsx`. A 429 is back-pressure, not a failure (see
  `docs/features/admin-and-operations.md`).
- **Responses are sequence-ordered** (`issueSequence` / `acceptSequence`), so
  a slow tick can't clobber a fresher bid.
- **A cleaned-up poll loop aborts its tick in flight and never applies a
  reply** (`releaseInFlight`). The poll effect re-runs on every `pollKick`
  (a bid, a clock at zero, Retry), a season change and React's development
  double mount, and it used to leave its tick running beside the next
  loop's first one. Request-start ordering assumes one tick in flight: of
  two at once the server may read the later-started one first, and the
  room would keep the older lot. Same rule as the inhouse room
  ([inhouse](inhouse.md)); `room-source-guards.test.ts` keeps the shape,
  and `e2e/zz-admin-draft.spec.ts` checks each captain's room has one tick
  in flight at a time (`recordRoomPolls`, on the page's own clock).
- **Refresh the layout's render once per phase move, a watcher's after a
  random wait.** The header's status
  chip and the phase nav come from the root layout, which a poll never
  repeats: a captain who parked on `/draft` before Start read "Signups open"
  through the whole auction. The room remembers the season and auction
  status its render shows (seeded from the page's `renderedPhase`, then each
  poll's) and calls `router.refresh()` only when `draftRoomNeedsRefresh`
  (`draft-room-refresh.ts`) says either moved: start, pause, resume,
  completion, abort, a phase move. Never on every poll; each refresh
  re-renders the layout and page on the shared box (one render per open tab
  per transition: about 175 for 35 tabs and five transitions, against the
  tens of thousands of polls of an auction). An admin's own action
  already re-rendered their page, so their tab may refresh twice. Once the
  season leaves the Draft phase with the auction finished, the refresh lands
  on `/teams`, as any load of `/draft` would.
  A viewer who can't act refreshes after a random 0-5s
  (`draftRoomRefreshDelayMs`): the long-poll tells every tab of a Start, a
  pause or a resume within a second, and fifty renders landing together
  would queue the captains' bids behind them on the box.
  `room-source-guards.test.ts` pins the one call site;
  `e2e/zz-admin-draft.spec.ts` checks a tab parked before Start shows "Draft
  live" in its header without a reload.
- **The outbid latch is pure.** `wasOutbid` raises it (its same-player guard
  stops a flash when a sale resolves into a new nomination within one poll);
  `outbidLatchAfter` decides set, clear or keep and takes no budget input on
  purpose: a priced-out captain most needs to see they lost the player.
- **The tab title uses `draftTitleFlag`** ("your pick" outranks "outbid").
  Strip it only with `stripDraftTitleFlag`, which reads the same
  `DRAFT_TITLE_PREFIXES`; a hand-copied list that drifts stacks prefixes
  forever. A round-trip test pins it.
- **Feed content comes only from `draftFeedDiff` / `seedDraftFeed`** (a
  source guard stops the room authoring lines). The room lists SALE lines as
  "Recent sales"; nomination and bid lines go to a screen-reader status line.
  Each rule below has a silent draft-night failure:
  - Build the previous-rosters set INCLUDING captains, or a captain demoted
    by `transferCaptaincy` (legal while the room polls) reads as a signing.
  - Emit a bid line only while the lot is unchanged; two bids in one poll
    collapse to the higher (`lotBids` is the audit trail).
  - Return lines NEWEST FIRST: the room prepends them whole, and one poll
    often holds a sale plus the nomination it resolved into.
  - Label clock-opened lots "auto-picked". Reset the feed on
    `draftFeedResetReason` (abort, reopen, void, retracted sale).
  - Live ids count up from 0, seeded ids down from -1; a collision breaks
    React keys mid-draft.
  - The SOLD! flash takes the last sale in PAYLOAD order, not the newest (no
    timestamp reaches the client).
- **Ring once per transition.** The alerts (your turn, on the block, sold) and
  the outbid latch fold into one `playChime()`; two calls double-strike the
  AudioContext. `room-source-guards.test.ts` asserts EXACTLY two call sites
  per room (the ring and the toggle's confirmation) and that the ring reads
  the alerts, since a silent room is otherwise invisible. The persisted
  `draftSound` toggle shows only to viewers the room can ring for
  (`draftAlertsReachViewer`), in the waiting room too. Audio unlocks in
  `act()` and through `armAudioUnlock` (`chime.ts`), which listens for
  pointerup, touchend, click and keydown until the context actually runs: a
  one-time `pointerdown` is not an activation gesture, so on phones it never
  unlocked and a pool player never heard "you're on the block". Until audio
  runs the toggle reads "Tap to turn on alerts", and that tap turns the bell
  on rather than muting it (`soundToggleNext`, `src/lib/room-sound.ts`,
  shared with the inhouse room).
- **Phone order follows the viewer:** a captain or admin gets the pool
  first; everyone else gets Recent sales, then the rosters, then the pool (DOM
  order, so screen readers match). Desktop is fixed by grid placement. "next:
  Team" shows at every size.
- **The admin's Auto-nominate panel names an absent captain** ("X isn't in
  the room — nominate for … or auto-nominate"), from the presence the poll
  already carries.
- **Clear a selected player who gets drafted or withdraws**, or the sticky bar
  offers a nameless Nominate.
- **Track a late-mounting element with a callback ref held in state.**
  `useBannerOffscreen` (`room-clock.tsx`) does; with `useRef`, tabs parked on
  `/draft` before Start never got the compact clock bar. Pinned in
  `e2e/zz-admin-draft.spec.ts`, which also drives nominate, outbid and re-bid
  across two captains' browsers. The bar has no aria-label on purpose (its
  content is its name); target it by title, "Back to the auction clock".
- **Bid controls:** `bidAllowanceLine` omits the current price on purpose
  (its changing length moved the buttons). Quick-bid buttons show the
  absolute amount; after an outbid, +$1 becomes "Re-bid". The lot shows its
  last 8 `lotBids`, a "next: team" preview and a paused chip.
- **Scouting comes from the page render, never the poll.** Tim asked on
  2026-10-24 for "a lot of information" about a player to show when they
  are nominated, for each player up for draft or on the block, so captains
  can see who they are drafting ([DECISIONS](../DECISIONS.md)). `/draft` builds one map for the season's ACTIVE
  PLAYER signups minus captains (`loadDraftScoutInfo`,
  `draft-scout-service.ts`): last league season, inhouse record, the pub
  snapshot, favorite heroes and the about text clipped to 300 characters,
  the facts `/players` shows any visitor, so one copy serves every viewer.
  It holds no contact or account id. A 60s per-season memo, so the Start
  refresh of a full room builds it once per process; loaded only while the
  auction is IN_PROGRESS or PAUSED (`draftScoutWanted`), so a tab parked in
  the waiting room gets it from the `router.refresh()` at Start. Drafted
  players stay in: Undo puts a sold player back without a status move. A
  failed read logs a fixed code and returns null, and the room then shows
  what it showed before. The full map is about 106 KB for 60 players
  (`draft-scout.test.ts` caps it). The tick carries only one new field,
  `nominatedPlayer.showContact` (`canViewLeagueContact`), so the lot card
  can say "no Discord" without a blank handle reading as missing.
  - What a card shows is `draftCardView`'s call (`src/lib/draft-scout.ts`):
    the record line (`lastSeasonToken`, `inhouseToken`, `pubToken`, "last
    played" once quiet), the profile's pub tiles (`scoutingTiles`, through
    the shared `ScoutTileGrid`), "Recent pubs" beside "Favorite heroes"
    (never merged), the about text, "Nothing on file yet…" for an entry with
    no record, and every finding in full under "More scouting", the only way
    to read a tile's finding on a phone. MMR, medal and roles come from the
    live tick row, the nominee's favorites and about text from the tick
    too; the map's copy is as old as the tab's render plus 60s.
  - **Compact until the viewer asks for more** (Tim, 2026-10-27: the full
    card "takes up a ton of room"). Compact: the record line, the `/players`
    row's pub line (`scoutingRowParts`, its hover `scoutingTitle`), one line
    of the about text and one row of 18px hero icons (recent pubs, then
    favorites; counts and win rates in each icon's hover). "Full scouting"
    (`aria-expanded`) swaps in the tiles, the hero counts, more about text
    and "More scouting"; it shows only when the full card has more
    (`hasMore`: a caption, or an about text past
    `DRAFT_ABOUT_COMPACT_CHARS`). One choice per viewer for both cards,
    kept in their browser (`usePersistedFlag("draftScoutFull", false)`),
    owned by the room, so the card stays presentational. Measured as a
    captain at 390x844: the lot card 90px compact (473px full), the pool's
    header on the first screen at 784px (1,167px with the full card).
  - **On the block** the card (`DraftPlayerCard`, presentational) sits under
    the bid controls, outside the action zone, then the Discord, Profile and
    Dotabuff links, then the bid trail last, since it grows through a lot.
    Keyed by the nominee, so a new lot opens with "More" shut (the
    compact-or-full choice is the room's, so it carries over).
  - **In the pool** one card opens under its row at a time. A captain lining
    up a pick sees the lined-up player's (`poolPanelOpenId`); everyone else
    taps a row (`aria-expanded`, a second tap closes it). Their card closes
    when that player goes on the block, and every opened card closes when
    the viewer starts or stops lining up picks, or the one opened before an
    admin's or captain's turn would pop back open after it
    (`inspectedAfterChange`). A watcher's open row is separate state from
    `selected`, so it never feeds NominateBar. Rows stay inert until the map
    has their entry. A tapped row is scrolled back into view when a card
    above it closes; its 8rem scroll margin (clearing the sticky header and
    clock bar) applies only where the page scrolls, never inside the desktop
    pool's own scroll box, where it moved a visible row. NominateBar's
    lined-up chip shows the medal and MMR.
  - The tiles are the profile's (`ScoutTileGrid compact`): an odd last tile
    spans the row only while they sit two across, below 26.5rem for the
    compact tiles. The caption names the window whenever the card shows
    anything read from it, recent heroes included.
  - `draft-player-card.test.ts` pins where both cards render, that the card
    has no state, request, bell, contact or link, that `/draft` loads the
    map behind `draftScoutWanted`, and that `draft-service.ts` never reads
    `pubStats`. `draft-scout.itest.ts` covers the loader.
    `e2e/zz-admin-draft.spec.ts` opens the cards through the real room: the
    lined-up pick's card arriving compact with the Start refresh, "Full
    scouting" opening it and holding for the lot card after Nominate, a
    non-picker's toggle, another captain's compact card, and no horizontal
    overflow at 375px; `zz2-draft-mobile.spec.ts` opens one on a phone and
    checks it stays under 260px. Both assert zero client
    errors. Their pub snapshots come from `e2e/seed-draft-scouting.ts`,
    which `e2e/global-setup.ts` runs after the seed (a change under
    `prisma/` would force a database release).
- **The Available list shares `filterAndSortPlayers` with `/players`**
  (`player-pool.ts`: search, role chips, MMR/rank/name sort). It must never
  learn about standins, which the room never lists; `/players` narrows by
  type first in `filterPoolRows`.

## Recap and Discord

- **`draftRecap`** (tested) finds the biggest spend, best MMR-per-dollar
  steal, top- and least-spending teams and total spent, captains excluded.
- **The `/teams` "Draft night" card reads sale receipts** (`readDraftSales` on
  the active COMMAND run). A season drafted before receipts has no card:
  roster prices stop matching the auction once moves and refunds land. Its
  title says "so far" only while the auction is live or paused
  (`draftRecapTitle`, keyed on the auction, not the phase: the season stays in
  Draft after the last sale until the Regular season starts).
- **Completion posts once per run.** Sales post nothing; completion posts the
  teams then `draftRecapMessage`; a repeat completion after Undo posts plain
  names and no recap (see the Discord notes).
- **The draft-night reminder posts once per draft time**
  (`maybeAnnounceDraftNight`, `reminder-service.ts`, run by the automation
  worker). `draftReminderDue` (`draft-setup.ts`) is its one window, shared
  with the automation gate: setup still open and `draftAt` within
  `DRAFT_REMINDER.AHEAD_HOURS` (24) and still ahead, with no allowance after
  it. The marker is `draftReminderKey(season, draftRevision)` on the week
  reminder's claim machinery; after its claim the service re-reads the season,
  draft and pool and releases the claim if any of them moved.
  `setDraftNight` invalidates the older revisions' in-flight markers, so a
  moved draft re-arms under its new key, except when a reminder was delivered
  for the time being replaced, while that time is still ahead, and the new
  time is inside the window: then it records the new revision as covered
  (`recordAnnouncementCovered`) and the "draft rescheduled" post carries the
  change. Only the replaced revision's own marker counts, so a same-day chain
  of tweaks stays quiet, but a reminder for a night that slipped past, or one
  followed by a move out of the window or a clear, never silences the real
  draft night's reminder (`draft-reminder.itest.ts`). `startDraft` invalidates
  any pending reminder; deleting a season sweeps `draftReminderPrefix`.
