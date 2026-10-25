# Roster moves, standins and check-ins

Permanent roster changes (sign, release, promote, withdraw a signup), one-match
standin cover, and match-night check-ins. Main files:
`src/app/actions/admin-roster.ts`, `src/lib/standin-service.ts` + `standin.ts`,
`src/app/actions/standins.ts`, `src/lib/registration.ts`, `src/lib/availability.ts`
+ `availability-service.ts`, and the match-page cards in `src/app/matches/[id]/`.

## Rules for the whole area

- **Gate roster work on a finished auction.** `postAuctionWorkOpen`
  (`league-lifecycle.ts`) is shut in SIGNUPS and COMPLETE, and open in DRAFT only
  once the Draft row is COMPLETE; no Draft row means "not run" (else a $0 signing
  bypasses the auction). `standinAssignmentOpen` adds "match not COMPLETED",
  `matchCheckinOpen` a published kickoff. Check it up front and in the transaction.
- **Run each write Serializable and re-read the other side's table inside it.**
  These are write-skew pairs, and SSI sees the cycle only when both sides do this
  (`docs/features/concurrency-and-testing.md`): assign vs withdraw (`leaveLeague`,
  `withdrawSignup`), assign vs `releasePlayer`, assign vs `signFreeAgent`,
  `promoteStandinToPlayer` vs `startDraft`, `removeStandinGuarded` vs a game
  import; `setAvailability` too. After the first write throw a typed error
  (`StandinRaceError`; `releasePlayer`'s zero-count `deleteMany`, since a raw
  `delete` dies on P2025 when two releases race) and map `isSerializationConflict`
  to "just changed, reload". Raced coverage: `standins-raced.itest.ts` (same
  seat, one open seat, same night, assign vs `releasePlayer`, assign vs
  `leaveLeague`) and `roster-moves.itest.ts` (concurrent `signFreeAgent`s;
  promote vs Start through seams). SQLite runs them in sequence, so only
  `npm run test:pg` tests them. Assign vs admin `withdrawSignup` or
  `signFreeAgent`, and removal vs a game import, have no raced test.
- **Never leave stale cover; refuse or report when a person owns the choice.**
  `matchNightRoster` swaps "covered player out, standin in", so a booking whose
  player, seat or fixture is gone counts six in a 5v5 on /schedule, the home page,
  the week reminder and the import set. A withdrawal with pending cover is refused
  (the captain who arranged it must learn the seat reopened); a partial refill
  reports surplus. Only release (seat gone) and a last-seat signing cancel cover.
- **Stand the standin down on every path that kills a booking or its fixture.**
  Post-commit, best-effort: `standinRemovedMessage` with a `STAND_DOWN_REASON` and
  `mentionsOf([standin.discordId])`. `grep -rn "standinRemovedMessage(" src`
  lists the paths; one without it leaves an @-mentioned instruction for a dead
  fixture. Send only when the delete took every row it meant to. `withdrawTeam`
  stands down only fixtures whose forfeit claim won, and deletes the bookings on
  those with zero games in the same claim (a kept row credits "Stood in" for a
  series nobody played, and Reopen would revive it); `recordResult` only a forfeit
  with zero games (never someone who played a manually scored series);
  `abortDraft` deletes the fixtures and their bookings.
- **Return the announcement; let the action send it.** Services return
  `announcement` + `mentions` so a webhook failure can't touch the write. Assign,
  remove, and agreeing to or declining a standin request send from BOTH the
  captain action (`standins.ts`) and the admin action (`admin-roster.ts`); miss
  one and that path stops notifying.

## Permanent roster moves

- **`signFreeAgent` adds a player to a short team at $0** (pool-dry drafts, late
  signups). It needs the roster gate, a team that hasn't withdrawn, an ACTIVE
  PLAYER signup (promote standins first), no roster seat, no pending cover (one
  account in both import sets fails every `classifyGame`) and an open seat, all
  re-read in the transaction (else two signings into the last seat make six).
- **A signing is held to the standin MMR rule** (Tim's call, 2026-10-25). The
  free agent is judged at read time against the player they replace: the newest
  player released from that team this season whose seat no later free-agent
  signing has refilled (`unrefilledDeparture`, `free-agent-rule.ts`; paired
  last in, first out). Only releases count as departures and only free-agent
  signings as refills, since both happen only after the draft: an auction
  Undo, an abort or a pre-draft captain change is no departure, so a team
  short from the draft uses its lowest MMR. Its MMR is the tenure's
  `acquisitionMmr`, else that player's signup MMR; with nothing waiting to be
  refilled, the team's lowest signup MMR (the empty-seat yardstick). Over
  `STANDIN_MMR_ALLOWANCE`, or with an MMR unknown on either side
  (`freeAgentOverRule`), the action refuses unless the form's "Sign over the
  100-MMR rule" box (`overMmrRule`) is ticked; the refusal names both MMRs, the
  gap and the box. A ticked signing over the rule says so with both MMRs in the
  toast, the admin log and the Discord post (`freeAgentOverRuleNote`). The sign
  form labels each short team with its yardstick ("· replaces Bob, 2,000 MMR",
  `freeAgentSeatLabel`, loaded by `loadFreeAgentBaselines` for short teams only).
- **A signing reconciles empty-seat cover.** Filling the LAST seat cancels the
  team's `replacingUserId: null` bookings on unstarted fixtures ("no games" in the
  delete's WHERE) and stands them down; started series keep theirs, and the toast
  says so. A partial refill cancels no booking (it closes only the waiting
  open-seat requests past the seats left, newest first; see the standin MMR
  rule): it reports per match the bookings
  that exceed the open seats (bookings live on matches, seats on the roster).
- **`releasePlayer` is three things in one transaction; keep it that way.** Free
  the seat, refund `member.price`, and cancel cover naming the player on unstarted
  series. The refund keeps the auction invariant `budget >= need * MIN_BID` (a
  spent-out team otherwise sits at need 1, budget $0). Captains can't be
  released; the claim re-asserts `team.captainId` so a stale Release loses to a
  transfer. The signup stays ACTIVE (release plus sign is a trade), and the toast
  says to remove it too if the player left the league.
- **Never cancel cover on a started series.** `gatherTeamAccounts` re-reads
  bookings on every import, so deleting one mid-Bo3 drops the standin for games
  2-3: null `teamId` lines, and the side can fall under `classifyGame`'s
  recognizable-account floor and stop importing. Keep the row and say "the
  remaining games record whoever actually plays".
- **`promoteStandinToPlayer` is the mid-season refill.** Late joiners can only
  register as standins and `signFreeAgent` refuses standins, so: promote, then
  sign (the signing announces). `promoteGateError` refuses SIGNUPS (self-serve),
  COMPLETE, a live or paused auction (pre-start and post-draft are fine) and
  pending cover. Its `updateMany` re-asserts ACTIVE + STANDIN in a transaction
  that also reads Season and Draft, so a racing `startDraft` wins. Seams
  `admin.promoteStandin.beforeTx` and `.afterGate` (Postgres only) in
  `test/integration/roster-moves.itest.ts`.
- **Withdrawal goes through `withdrawGateError`.** Both withdrawal paths also
  close the leaving standin's pending requests (see the standin MMR rule).
  `leaveLeague` passes `pendingAssignments` (`pendingCoverWhere`), captain, roster and
  `isOnTheBlock`. Admin `withdrawSignup` passes the same facts except the
  block, which it checks inline, at read and again in its transaction, so the
  gate's unit test does not cover the admin refusal
  (`admin-flow-audit.itest.ts` does). Both paths re-check in the transaction.
  `audience: "self"` (`leaveLeague`) speaks to the player and names only what they
  can do ("ask that team's captain or an admin"); the default is `"admin"`. Use it
  for any new player-facing surface. The admin signup lists render "remove" only
  where the gate can pass: `signupRemovalBlockers` (`registration.ts`, tested)
  mirrors its roster and pending-cover refusals from the page's own data, and
  those rows show "on <team>" or "covering a match" instead. Mid-season that is
  every drafted player; the server gate stays authoritative.
- **Record roster tenure in the winning transaction:** `captureRosterTenure` on a
  signing, `closeRosterTenure` on a release (`src/lib/roster-history.ts`).
- **The admin Roster moves card shows only forms that would work**
  (`rosterMovesVisible`, `RosterMoves` in `src/app/admin/page.tsx`): sign needs a
  short team and a free agent, release a rostered non-captain, promote an
  unrostered STANDIN. DRAFT before the auction shows only Promote; a live auction
  hides the card. `shortTeams` (`admin-attention.ts`) skips withdrawn teams,
  whose "short" is permanent; their players stay releasable, and the
  `withdrawTeam` toast points there.
- **Mention the player a move happens to.** `freeAgentSignedMessage` mentions
  them and ends with their next move (check in, `/schedule` link), and the toast
  appends `reachabilityNote` (through `withReachabilityNote`).
  `playerReleasedMessage` mentions the released player.

## Standin cover

- **Any ACTIVE, unrostered signup can cover, whatever its type.** A rostered
  player never can: they would be in both teams' import sets. Don't relax this
  for a withdrawn team's players (`reinstateTeam` would make them both); release
  them instead.
- **Captains cover their own team; admins any team.** Guards live in
  `assignStandinGuarded` / `removeStandinGuarded`
  (`test/integration/standins.itest.ts`).
  Captain actions pass `actingCaptainId`, which must captain the covered team
  (admins get the override); admin actions pass `null`. The replaced player's
  roster decides the team.
- **One seat, one standin; one booking per standin per match.** More inflates the
  side and double-counts box scores, and `StandinAssignment` has no unique
  constraint, so the in-transaction re-reads are the only guard. An empty seat is
  `replacingUserId: null` plus a `teamId` (forms send `seat:<teamId>`, built and
  parsed by `seatValue` / `parseSeatTarget`); the seat must be open, one standin
  per open seat.
- **A standin can't cover two matches the same night.** `standinConflict`: kickoffs
  within `STANDIN_CONFLICT_HOURS` (4) clash, or the same week when a time is unset.
  Every team plays on one night, so this is the normal case. Checked up front and
  in the transaction, ignoring completed matches; the error names the fixture.
- **Assignment is phase-gated; removal is not.** Assign refuses an archived
  season's match, a completed match, then SIGNUPS, DRAFT before the auction
  completes, and COMPLETE, most specific first. DRAFT after the auction stays open
  for week-1 cover. Removal is legal in every phase and on archived seasons: it
  is cleanup, and a stale booking blocks its standin's own withdrawal. Both assign
  forms hide on the same gate but keep the booking list and Remove.
- **Removal refuses once a series has started** (COMPLETED or games imported),
  re-asserted in the delete's WHERE under Serializable. A mid-series swap is
  impossible by design; the seat-taken error says so rather than pointing at a
  Remove that refuses. Re-assigning the same standin stays legal.
- **`matchNightRoster` drops cover naming someone off the roster** and keeps a
  null `replacingUserId` (an empty-seat fill). Feed it, never the raw roster, into
  check-in counts.
- **Tell the standin, and the captain when someone else acted.** Assign mentions
  the standin plus the covered captain if they didn't book it; an admin removal
  mentions both. Assign toasts append `reachabilityNote` through
  `withReachabilityNote` (its own sentence). `standinAssignedMessage`
  and `playerOutMessage` link the match page. A reschedule that moves the match
  mentions booked standins (`AcceptedReschedule.standinUserIds`): their ping
  quoted the old time. Standins answer the ready check for the seat they cover;
  the player they cover doesn't.
- **Make the picker mirror the server.** `standinPickerBlock` lists standins booked
  here or that night, or with a request waiting in this match, last, disabled,
  with why; `coverChoices` puts uncovered OUT players first, and a seat with a
  waiting request leaves the Covers list. Pinned by
  `src/app/matches/[id]/match-page-guards.test.ts`.
- **Show cover problems where the fixer looks.** The admin card recomputes
  double-bookings live (`standinClashes`; any retime can create one, and
  `clashesAfterRetime` reports it in that toast) and lists uncovered OUTs and
  booked standins who said OUT (`matchCoverIssues`). The captain's card opens with
  "✗ Out and uncovered" and shows roles and "no Discord" in the picker. /me shows
  bookings to any ACTIVE unrostered signup (the empty card only to STANDINs).
  Profiles credit "Stood in for N matches" from COMPLETED matches. /schedule lists
  standins.
- **Deliberately not built:** a mid-series swap tool (only if a real season needs
  it twice), auto-cancelling partial-refill surplus bookings (surplus waiting
  requests are closed: a request is not cover, so nobody was told to show up).

## The standin MMR rule

Tim's rule (2026-10-21, loopholes closed 2026-10-25,
[DECISIONS](../DECISIONS.md#product-decisions)): a standin more than
`STANDIN_MMR_ALLOWANCE` (100) above the seat needs the other captain's OK. Pure
rules in `standin.ts` (`coverBaselineMmr`, `namedCoverBaseline`,
`standinNeedsApproval`, `standinApprovalReason`), the flow in
`standin-service.ts` (`assignStandinGuarded`, `approveStandinRequest`,
`declineStandinRequest`, `cancelStandinRequest`, `cancelPendingStandinRequests`),
the rows in `StandinRequest`.

- **Measure by signup MMR against the seat.** Named cover compares with the
  covered player's `Registration.mmr`; an empty seat counts as covering the
  team's lowest known MMR. Exactly the allowance above is fine. An unknown (0)
  standin MMR, or an unknown seat, needs the OK too: an unknown must not pass as
  "close enough".
- **Measure a named cover against the lowest absentee too.** The baseline is
  min(the covered player's MMR, the lowest KNOWN MMR among teammates who checked
  in OUT for the match's current `scheduleRevision` and have no booking in it)
  (`namedCoverBaseline`, fed by `coverBaseline`). A waiting request doesn't
  count as their cover: asking for one, booking against the stronger player,
  then withdrawing the ask would step round the rule.
  Unknown MMRs never lower it, and an unknown named player stays unknown.
  Otherwise a captain names their strongest player as "covered" while the
  standin really takes a weaker absentee's seat. The request stores that
  teammate (`StandinRequest.baselineUserId`, relation `baselinePlayer`), so the
  toast, the post, the Standins card and the admin row say "… above <player>
  (2,000), who said they can't make it" (`standinApprovalReason`'s
  `lowerOutName`); the Covers list shows "counts as N MMR" for a player judged
  lower.
- **Signup MMR is fixed once the auction is done** (`mmrSelfEditLocked`,
  `registration.ts`: DRAFT with the auction COMPLETE, then REGULAR_SEASON,
  PLAYOFFS and COMPLETE). `saveRegistration` keeps the stored number on an
  existing signup of any type and the toast says so (`mmrLockedAfterDraftNote`);
  a new signup (a late standin) still sets its own; /me renders the box disabled
  (`MmrField` `locked`, source-guarded in `registration.test.ts`). Admins correct
  it with `setPlayerRank` or `setRegistrationMmr`. Otherwise a standin lowered
  theirs, or a covered player raised theirs, to step round the other captain.
- **A request is not cover.** Past the allowance a captain's booking files a
  `StandinRequest` (PENDING) instead of a `StandinAssignment`, so nothing that
  reads cover (`matchNightRoster`, imports, check-ins, reminders, withdrawals)
  sees it. Agreeing creates the assignment in the same Serializable transaction
  that marks the request APPROVED. Don't add a status to `StandinAssignment`
  instead: every reader would have to learn to skip it.
- **A waiting request holds its seat and its standin in that match,** like a
  booking: `judgeCover` and `recheckCover` count PENDING requests (an empty
  seat's budget too), and the error says the request has to be answered or
  withdrawn first. A request elsewhere the same night doesn't block; agreeing
  re-checks the night.
- **Who decides.** Only the match's OTHER captain agrees or declines (never the
  asking side; the seat's own captain withdraws). `overLimit: "ask"` is the
  captain's card, always, even when its captain is an admin; `"book"` is the
  admin panel's ruling, which books over the rule and says so in the toast and
  the log. Admins agree, decline or withdraw in a captain's place from the
  standin block on /admin and in the match page's Admin tools (logged;
  `withdrawStandinRequestAsAdmin` posts nothing). Agree shows only while booking
  is open, and never to an admin who captains the asking team or filed the
  request (`adminMayAgreeToRequest`, `admin-sections.ts`; /admin and the match
  page pass the viewer as `viewerId`); decline and withdraw always show.
- **No captain agrees to their own side's request.** `approveStandinRequest`
  refuses an actor who captains the asking team (read inside the transaction,
  so a captaincy handed over since is judged) or who filed the request, and
  the admin tools hide "agree" for that viewer. Admin callers must pass
  `actingUserId` (typed). The admin panel's "book" stays the admin's own
  ruling over the rule, logged as such.
- **A no stands for the match.** On the captain path every booking or ask of
  a standin already DECLINED for that team in this match is refused, inside
  the Serializable transaction ("<S> was already declined for <team> in this
  match — pick someone else, or ask an admin"). A withdrawn request doesn't
  count, and the admin panel's "book" is unaffected. The picker greys them out
  (`loadDeclinedStandinIds` → `standinPickerBlock` `declinedBy`).
- **Agreeing re-runs every booking check.** `approveStandinRequest` runs
  `judgeCover` again (phase, completed match, signup, roster, seat, night), then
  in one Serializable transaction re-reads the other team's captain, claims the
  request (`updateMany` on PENDING), runs `recheckCover` and books. Past the
  claim a failure throws, so a standin who withdrew in the gap leaves the
  request PENDING, not APPROVED with nobody booked. `recheckCover` re-reads the
  match in the transaction too, so a ruling or a retime in the gap is judged
  (a played or deleted match refuses; the same-night clash uses the fresh
  kickoff). Seam `standin.assign.afterJudge` sits between the read-time checks
  and a booking's or an ask's transaction. Seam
  `standin.approveRequest.beforeTx` sits between the read-time status check and
  the claim. A failed check speaks to the approver, at read time or in the
  transaction (`agreeTooLateError`): "This can't be agreed to any more: <reason>
  — decline it so <team> can line up someone else".
- **Decline and withdraw read no status before their claim;** the WHERE is the
  one refusal, worded from the row afterwards. Decline pings the asking captain;
  withdraw posts nothing.
- **Tell only who must act.** The request post mentions the other captain only
  (`standinApprovalRequestedMessage`); the standin hears nothing until the
  usual assignment post, which says who agreed (`agreedBy`) and mentions the
  standin and the asking captain. Decline mentions the asking captain
  (`standinRequestDeclinedMessage`). `reachUserId` tells the action whose
  Discord reach to report in the toast.
- **Show it where the answer happens.** The Standins card lists requests:
  Withdraw for the asking captain; Agree (only while booking is open) and
  Decline for the other. Captain to-dos tells the other captain an answer is
  waiting, and an OUT player whose cover is waiting isn't listed as uncovered.
  The form's note states the rule and links `/rules#rosters`, and the Covers
  list shows each player's MMR. The admin cover banner still counts that player
  as uncovered (a request is not cover) but reads "<P> — waiting on the <other
  team> captain's OK for <S> (agree, decline or withdraw below)", dropping
  "agree" wherever the row hides it (`uncoveredByRequest`'s `canAgree`).
- **Close a request the moment nobody can agree to it.** Inside the change's
  own Serializable transaction, `cancelPendingStandinRequests` reads the
  PENDING rows and claims exactly those to CANCELLED. Every caller is
  Serializable, so a rival answer aborts one side (P2034) before any short
  count; the count check (`StandinRequestsChangedError`) is defense in depth.
  Who closes what:
  - `releasePlayer`: requests to cover that player on unfinished matches;
  - `signFreeAgent`: requests naming the signed player as the standin, and the
    open-seat requests the smaller seat budget can no longer hold (all of them
    when the last seat fills; the newest beyond the budget on a partial
    refill);
  - `leaveLeague` and admin `withdrawSignup`: the leaving standin's requests
    (bookings still refuse a withdrawal);
  - `withdrawTeam`: each fixture whose forfeit claim won;
  - `recordResult`'s no-game forfeit, and `reopenMatch` (a request a manual
    score left waiting), so Reopen never hands the other captain an Agree for a
    decided fixture.

  Only the first three need the asking captain to line up someone else, so only
  they post (a standin signed onto the very team that asked for them posts
  nothing: they fill that seat) (`standinRequestCancellations`: `PLAYER_RELEASED`, `STANDIN_SIGNED`,
  `STANDIN_LEFT`, mentioning that team's captain alone, after the commit). The
  rest report the count in the toast and the admin log. Fixture teardowns
  (`replaceRegularSchedule`, `removePostseason`, `clearTiebreakerWeek`,
  `abortDraft`) cascade the rows away with the match and count the PENDING ones
  in their toast and log; none posts.
- **Tests:** `standins.itest.ts` ("standin MMR rule", including the seam and
  the three claims; "a lower teammate who's out", "a declined standin can't be
  asked for again", "an admin can't agree to their own side's request"),
  `standins-raced.itest.ts` (agree vs withdraw, agree vs decline, two requests
  for one seat; Postgres only), `standin-request-cleanup.itest.ts` (release,
  admin Withdraw), `standin-request-teardown.itest.ts` (forfeit, Reopen,
  teardowns), `registration-standin-mmr.itest.ts` (the MMR lock, a leaving
  standin) and the request tests in `team-withdraw.itest.ts` and
  `roster-moves.itest.ts`. The rules page pins its sentences to these functions
  (`league-rules.test.ts`).

## Match-night check-in

- **An answer is for one kickoff, counted out of the side size.**
  `MatchAvailability` (unique matchId + userId, IN or OUT) stores
  `scheduleRevision`; counts read only the current revision, and retimes delete
  the rows. `expectedSideSize` is `max(teamSize, rosterSize)`, so a short side
  reads "4/5", never "4/4". `teamAvailability.unansweredUserIds` counts anything
  but IN or OUT as no answer, so the list matches the count.
- **`loadSidePlayerIds` decides who answers for a side**: the roster minus covered
  seats, plus standins whose signup is ACTIVE (or absent) and who hold no seat.
  `setAvailability`, the "I'm away" range (`markAwayDates`), the captain reminder
  and `src/app/matches/[id]/live-series-checkin.tsx` all use it. Refusals come
  from `resolveCheckinSeat` / `checkinClosedReason`, worded once in
  `CHECKIN_REFUSAL_MESSAGE`.
- **"I'm away" marks a date range OUT in one go** (/me; `markAwayDates` calls
  `markAwayRange`, `availability-service.ts`): one Serializable transaction
  (20s timeout for a long range) that judges every fixture before the first
  write, so a refusal throws with nothing written. It writes only fixtures
  whose `scheduleRevision` still matches what the page listed (`seen`), never
  a kickoff the player didn't see, and leaves already-OUT answers alone, so a
  second save is a no-op. Pure `away-range.ts`: `inAwayRange` (shared with the
  card's preview), `localDayStartMs` (call it in the BROWSER; the date-only
  form of the datetime rule) and `AWAY_RANGE_MAX_DAYS` (90).
- **Players answer through `<CheckinBanner>`** on the home page
  (`src/components/home/my-next-match.tsx`), /schedule and unplayed match pages.
  It needs a published kickoff and closes when the match finishes or its result
  window passes. Named answers go only to the captains and admins
  (`canViewNamedMatchAvailability`).
- **The captain's reminder is one press, no confirm.** The
  `remindUnansweredCheckins` action calls `sendCheckinNudge`
  (`checkin-nudge-service.ts`, `checkin-nudge.itest.ts`) from under the captain's
  own side in the Matchup card. One post names and mentions only that team's
  unanswered players, never the captain or the other side. Throttle:
  `claimThrottle` on `checkinNudge:<match>:<team>:<scheduleRevision>` for
  `CHECKIN_NUDGE_THROTTLE_SECONDS` (a retime gets a fresh window). Claim after
  every other check (webhook included); release only if the post was not queued
  (once queued it is durable, so an outage keeps the window). A queued reminder
  is dropped at kickoff (`checkinNudgeExpiresAt`; one sent after kickoff gets an
  hour) and as soon as the kickoff moves or a result or forfeit lands: those
  transactions call `invalidateMatchNudges`, which expires the match's
  `checkinNudgeAnnouncementGroup`. Render the button only when the action would
  accept; once used, it says when the next is allowed.
- **Playing lineups are retired.** Nothing writes `MatchLineup`, `MatchLineupSeat`
  or `Match.logisticsRevision`; only the season export and the postseason reset
  receipt copy old rows. Don't build on them; dropping them is not decided
  (`docs/DECISIONS.md`).
- **The week reminder** (`maybeAnnounceUpcomingWeek`, `reminder-service.ts`,
  `reminders.itest.ts`) runs from the authenticated automation worker, from
  `WEEK_REMINDER.AHEAD_HOURS` before kickoff to `BEHIND_HOURS` after, with
  `<t:epoch:R>` times, the same standin-aware counts as /schedule, and mentions of
  unanswered players only. One claim per kickoff cluster
  (`claimAnnouncementMarker` on `weekReminderKey(season, week, kickoffMs)`), so an
  early fixture can't burn the week; a failed send stays retryable. Await the send.
  A kickoff goes out in as many posts as Discord's limits need
  (`weekReminderAnnouncements`, `discord.ts`): whole fixtures in input order,
  each post within 2,000 characters and 100 mentions, numbered ("2/3") and
  carrying the heading and the kickoff, with the bye line and the RSVP ask on
  the last. Every unanswered player is named, with no cap: it is the week's
  first nudge, when a whole side may not have answered (Tim's call, 2026-10-23;
  a 15-team night is seven fixtures and up to seventy players). The linked ones
  are mentioned only where the kickoff is news to their side, by
  `kickoffIsRoutine` (`kickoff-routine.ts`): the side's first regular fixture
  (`firstFixtureBySide`: its earliest kickoff that isn't a no-game forfeit, so
  a week-1 bye, a moved week 1 or a forfeited week 1 still hears about its
  first game), a retimed fixture (`scheduleRevision` above 0), a tiebreaker or a
  playoff round. Every other regular kickoff is the weekly slot they already
  know, so its waiters are named without a ping (Tim's call, 2026-10-24). A
  regenerated schedule starts over at its own first fixture, which pings; "Move
  a match night" bumps the revision of every fixture it moves, so those keep
  pinging all season. A forfeit brought back with "Reopen for import" keeps its
  revision and reads as routine. Each part is its own outbox row under the cluster's claim:
  part 1 keeps the claim's dedupe key and later parts add `:2`, `:3`, so a
  retry under the same event id adds only the parts that never queued
  (`week-reminder-posts.itest.ts`).
  Retiming one fixture releases only its old kickoff's marker, once nothing
  else kicks off there (`releaseRetimedReminderMarker`), so the fixtures that
  didn't move are never reminded, and pinged, twice
  ([retime contract](season-schedule-playoffs.md#schedule-and-kickoff-times)).
