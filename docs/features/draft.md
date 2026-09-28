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
  (nominator's clock out) run in `getDraftState`, before each nominate/bid,
  and in the worker's `syncDraftClocks` (`result-sync-service.ts`), so the
  auction moves with nobody watching. Signed-in polls resolve at most once per
  `draftRoomMaintenanceAt` window; anonymous polls are read-only. Timers are
  `DEFAULTS` in `constants.ts`; a lot nobody can outbid gets the short clock
  (`bidClockSeconds`).
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
  check-ins, picks, cover and reschedules cascade), fantasy rosters and sent
  week-reminder markers, and drops the season to SIGNUPS so captains can be
  fixed and late players register. Draft time and readiness acknowledgements
  stay. Losses throw `AbortRaceError`; raced by `raceN(4)` in `draft.itest.ts`.
- **Abort keeps captains and teams and stops at the first result.** It refuses
  once any match is COMPLETED or not SCHEDULED, or any Game exists (rosters
  then carry standings and brackets); the button hides on the same results
  check. It is not phase-gated on purpose: recovering a season whose phase
  moved is the point. It is a type-to-confirm `DangerSubmit`, and the action
  stands down cancelled standin bookings after commit.
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
  true); MMR is FROZEN with a toast note, not refused, because every poll
  re-reads it for the pool sort and auto-pick and the admin MMR edit is hidden
  once the draft starts. Tested in `registration.itest.ts`.

## The /draft page and routes

- **`/draft` never gates on the phases the room moves through.** In SIGNUPS or
  DRAFT it renders any auction status (a static gate never learns the admin
  pressed Start). Later phases redirect to `/teams`, except while the auction
  is IN_PROGRESS or PAUSED: that stranded state must stay visible, so don't
  widen the redirect. No active season shows the empty state.
- **Polls and mutations use separate rate-limit buckets:** tick has a per-IP
  and a per-user bucket; bid, nominate and admin-nominate share one per-user
  mutation bucket. Limits are in each `route.ts` (`rateLimit` keys `draft:*`).

## The draft room client

- **Responses are sequence-ordered** (`issueSequence` / `acceptSequence`), so
  a slow tick can't clobber a fresher bid.
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
  (`draftAlertsReachViewer`); audio unlocks in `act()` and on the first
  `pointerdown`.
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
- **The Available list shares `filterAndSortPlayers` with `/players`**
  (`player-pool.ts`: search, role chips, MMR/rank/name sort). It must never
  learn about standins, which the room never lists; `/players` narrows by
  type first in `filterPoolRows`.

## Recap and Discord

- **`draftRecap`** (tested) finds the biggest spend, best MMR-per-dollar
  steal, top- and least-spending teams and total spent, captains excluded.
- **The `/teams` "Draft night" card reads sale receipts** (`readDraftSales` on
  the active COMMAND run). A season drafted before receipts has no card:
  roster prices stop matching the auction once moves and refunds land.
- **Completion posts once per run.** Sales post nothing; completion posts the
  teams then `draftRecapMessage`; a repeat completion after Undo posts plain
  names and no recap (see the Discord notes).
