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
  stands down only fixtures whose forfeit claim won; `recordResult` only a forfeit
  with zero games (never someone who played a manually scored series);
  `abortDraft` deletes the fixtures and their bookings.
- **Return the announcement; let the action send it.** Services return
  `announcement` + `mentions` so a webhook failure can't touch the write. Assign
  and remove send from BOTH the captain action (`standins.ts`) and the admin
  action (`admin-roster.ts`); miss one and that path stops notifying.

## Permanent roster moves

- **`signFreeAgent` adds a player to a short team at $0** (pool-dry drafts, late
  signups). It needs the roster gate, a team that hasn't withdrawn, an ACTIVE
  PLAYER signup (promote standins first), no roster seat, no pending cover (one
  account in both import sets fails every `classifyGame`) and an open seat, all
  re-read in the transaction (else two signings into the last seat make six).
- **A signing reconciles empty-seat cover.** Filling the LAST seat cancels the
  team's `replacingUserId: null` bookings on unstarted fixtures ("no games" in the
  delete's WHERE) and stands them down; started series keep theirs, and the toast
  says so. A partial refill cancels nothing: it reports per match the bookings
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
- **Withdrawal goes through `withdrawGateError`.** `leaveLeague` passes
  `pendingAssignments` (`pendingCoverWhere`), captain, roster and
  `isOnTheBlock`. Admin `withdrawSignup` passes the same facts except the
  block, which it checks inline, at read and again in its transaction, so the
  gate's unit test does not cover the admin refusal
  (`admin-flow-audit.itest.ts` does). Both paths re-check in the transaction.
  `audience: "self"` (`leaveLeague`) speaks to the player and names only what they
  can do ("ask that team's captain or an admin"); the default is `"admin"`. Use it
  for any new player-facing surface.
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
  appends `reachabilityNote`. `playerReleasedMessage` mentions the released player.

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
- **Flag a big MMR gap; never block.** `standinMmrNote` flags a standin at least
  `STANDIN_MMR_FLAG_GAP` (500) above the replaced player; an empty seat compares
  with `Season.maxMmr` (0 = silent); unknown (0) MMR never flags. Toast and log
  only.
- **Tell the standin, and the captain when someone else acted.** Assign mentions
  the standin plus the covered captain if they didn't book it; an admin removal
  mentions both. Assign toasts append `reachabilityNote`. `standinAssignedMessage`
  and `playerOutMessage` link the match page. A reschedule ACCEPT mentions booked
  standins (`AcceptedReschedule.standinUserIds`): their ping quoted the old time.
- **Make the picker mirror the server.** `standinPickerBlock` lists standins booked
  here or that night last, disabled, with why; `coverChoices` puts uncovered OUT
  players first. Pinned by `src/app/matches/[id]/match-page-guards.test.ts`.
- **Show cover problems where the fixer looks.** The admin card recomputes
  double-bookings live (`standinClashes`; any retime can create one, and
  `clashesAfterRetime` reports it in that toast) and lists uncovered OUTs and
  booked standins who said OUT (`matchCoverIssues`). The captain's card opens with
  "✗ Out and uncovered" and shows roles and "no Discord" in the picker. /me shows
  bookings to any ACTIVE unrostered signup (the empty card only to STANDINs).
  Profiles credit "Stood in for N matches" from COMPLETED matches. /schedule lists
  standins.
- **Deliberately not built:** a mid-series swap tool (only if a real season needs
  it twice), an MMR advisory in the Discord post, auto-cancelling partial-refill
  surplus.

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
