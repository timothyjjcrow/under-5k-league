# Match-night poll

An availability vote on the league's weekly match slot, shown on Home. An
admin opens a poll and its grid fills itself (every day, every hour from noon
to 6 PM on the league's clock, unless the admin narrows it); signed-up players
mark every start time they could play, and the time the most players can make
wins. Main files: `src/lib/match-night-poll.ts` (pure: the grid, labels, the
count, the viewer's-clock conversion, the page's view),
`src/lib/match-night-poll-service.ts` (storage and claims),
`src/app/actions/match-night-poll.ts` (voting),
`src/app/actions/admin-match-night-poll.ts` (admin),
`src/components/home/match-night-poll.tsx` (the Home card),
`src/components/match-night-poll/*` (the grid, the heatmap, the shared clock)
and `src/components/admin/match-night-poll-controls.tsx` (the Match night poll
section on `/admin`). Models: `MatchNightPoll`, `MatchNightBallot`.

## The model

- **Season-independent, like news.** A poll has no `seasonId` and no phase
  gate, because a league polls for next season's night between seasons as
  often as during one. Home shows it in every phase and in the offseason view.
- **A slot is a weekday plus a minute of the day on `LEAGUE_CONFIG.timeZone`,**
  never an instant, so "Sundays at 6 PM" survives daylight saving the way
  `matchNightForWeek` does. Slots are stored as JSON on the poll and keyed
  `"<day>@<minute>"` (`slotKey`); `slotLabel` prints them in the same shape
  `fixturesMatchNightLabel` prints a season's night.
- **The grid fills itself** (`gridSlots`): every ticked day (all seven by
  default), on the hour, from `POLL_DEFAULT_FROM_HOUR` (12) to
  `POLL_DEFAULT_TO_HOUR` (18) inclusive on the league's clock, so a default
  poll offers 49 start times. The admin form only adjusts days and hours;
  there is no per-slot entry. At most `POLL_MAX_SLOTS` (84).
- **Slots are fixed once the poll opens.** An edit would reinterpret every
  ballot already cast; the admin deletes the poll and opens a new one.
- **`closesAt` is the one deadline.** "Close voting now" moves it to now; the
  closing-time box extends, shortens or reopens. There is no status column and
  no worker job: open is `closesAt > now`, read at request time, so the poll
  needs no `automation-gate.ts` wake-up.
- **At most one poll is open,** and Home shows the open one, else the latest
  for `POLL_RESULT_DAYS` (7) after it closes. `/admin` always shows the newest.

## Voting

- **Only signed-up players vote** (Tim's call, 2026-10-04; `docs/DECISIONS.md`):
  an ACTIVE signup, player or standin, or a roster or captain seat, in the
  voting season, the way `hasActiveLeagueParticipation` counts it. The voting
  season is the active one, or in the offseason the most recent. Admins are
  not exempt. **A ballot counts only while its voter is still signed up**
  (`stillSignedUp` in `viewOf`, and in `closePollNow` so the admin's "Voting
  closed with N votes" agrees with Home): eligibility is checked when a
  ballot is cast, and without the recount a player who withdrew, or whom an
  admin removed, kept counting and could swing the result. The row is kept,
  so a player who signs up again counts again; while out, they see the card
  as any non-voter does. Everyone sees the card; a signed-in viewer who
  can't vote sees which times are on offer, who votes, and a link to My
  account while the season still takes a signup.
- **Mark every time you could start a match, as many as you like** (Tim's call,
  2026-10-04, replacing the first ranked-choice version). No cap: a cap makes a
  player drop times they could make, which is exactly the information that
  finds a night most people can play. An empty ballot ("None of these work for
  me") is a vote too: it counts in turnout and marks nothing.
- **The grid is the ballot** (`AvailabilityGrid`): tap a cell to toggle it,
  drag across cells to mark or clear a range (pointer events with
  `elementFromPoint`, since touch keeps sending events to the cell the finger
  went down on; cells are `touch-none` so a drag paints instead of scrolling),
  or tap a day or an hour header to fill or clear its column or row. Only a
  primary press paints: a right-click or a second finger (a pinch) marks
  nothing. Keyboard users toggle cells as buttons (`aria-pressed`). The whole set posts at once
  (`castMatchNightBallot`), so a half-marked grid never counts.
- **Ballots store the slots marked, in poll order,** in the `ranking` column
  (named for the ranked-choice first version; order carries no meaning now).
  Unknown slots and repeats are dropped and the toast says how many (never
  rewrite silently); a ballot of only unknown slots is refused rather than
  saved as "none".
- **The count is hidden from signed-in non-voters while voting is open**
  (`pollResultsVisible`): it is left out of the page payload, not just hidden,
  so people mark the times they can make instead of the ones already winning.
  Voters and admins see it live; everyone sees it once voting closes. Nothing
  anywhere says who marked what.

## Time zones

- **Every time shows on the viewer's own clock.** `PollClockProvider` reads the
  browser's zone after hydration (the server can't know it), so the first
  paint is the league's clock and the switch is the `useLocalTimeText` trick:
  never a hydration mismatch. All labels use `LEAGUE_LOCALE`, never the
  browser's locale, for the same reason.
- **The card says so in words:** `ClockNote` reads "Times are shown in your
  local time (Eastern time)" beside every grid and heatmap, including for a
  player whose local time is the league's, and "league time (Pacific time)"
  after the switch. It says "local" only once the browser's zone is known
  (`localZone`); the server's first paint names the league's zone instead.
- **The grid keeps the league's day columns;** each row header shows that
  start time on the viewer's clock (`slotOnClock`), with a "+1"/"−1" when it
  lands on another day (6 PM Pacific Saturday is 3 AM Sunday in Berlin). A
  viewer whose clock differs gets a "Your local time (Eastern) | League time
  (Pacific)" switch (`ClockToggle`); the grid and the heatmap share it. Lists
  that name the viewer's own weekday ("Sun 3 AM") carry no "+1": it would
  read as Monday.
- **One offset converts the whole poll, read in the season, not this week**
  (`pollClockAt`: a week after voting closes). Converting each slot at its own
  next occurrence put a daylight-saving change inside one grid row: in the
  week Europe has left summer time and the US hasn't, a Berlin row labelled
  "10 PM" held cells reading "11 PM". Reading the clocks in the season also
  gives each player the times they will actually play (Arizona, on one clock
  all year, is level with Pacific in October and an hour ahead in winter).
  When the viewer's gap to the league's clock differs between now
  (`PollView.viewedAt`) and then, `ClockNote` says so in one sentence.
  Discord's "next on" time is the slot's real next occurrence
  (`nextSlotOccurrence`).
- **Stored and announced times stay on the league's clock** ("Saturdays at
  2:00 PM Pacific time"). Discord posts add `<t:…>` timestamps so each reader
  sees their own time.

## The count (`tallyAvailability`)

- The best slot is the one the most players can make. A tie goes to the slot
  with more players free an hour either side on the same day (a late start or
  a long series still works), then to the earlier slot in the week.
  Deterministic.
- **Shown as a heatmap** (`AvailabilityHeatmap`): the same grid, each cell the
  number who can play, shaded by it, the leader outlined, the viewer's own
  times ringed, and the top three times listed above it.

## Concurrency

- **A ballot claims the poll row** (`castBallot`): its first write is
  `updateMany({ where: { id, closesAt: { gt: now } } })`, so a close that
  commits first refuses the ballot and one that commits second waits on the
  row lock. The deadline is enforced by that claim alone, never by a
  read-time check (a seam, `matchNightPoll.castBallot.afterRead`, closes the
  poll between the read and the write in the test). Eligibility is checked
  inside the same transaction after the claim, so a refusal rolls it back.
- **"Close voting now" re-asserts the poll is open** (`closePollNow`), so a
  second close is refused and keeps the recorded closing time.
- **"One open poll" is a write-skew pair:** `createPoll` and the reopen in
  `setPollClosesAt` each re-read the other open polls inside a Serializable
  transaction and retry on an SSI abort. Postgres-only seam tests
  (`createPoll.afterOpenCheck`, `setPollClosesAt.afterOpenCheck`) prove each
  side; downgrading either to READ COMMITTED fails them.
- Both claims are in the mutation ratchet (`FILES`, protected in
  `test/mutation-baseline.json`).

## Admin

- **The Match night poll section** (`#adm-poll`, between Activity and News)
  opens itself while a poll is open. It shows the heatmap, "Close voting now",
  the closing-time box, and once closed "Reopen voting", "Use as the season's
  match night" and "Announce the result on Discord".
- **"Use as the season's match night" reuses `setMatchSchedule`** and fills
  the Match night box under Season settings. It never moves fixtures; when
  fixtures already have kickoffs the card says pages show their night and
  points at Move a match night.
- **Delete is a `DangerSubmit`** whose token is the poll's question, checked
  again on the server (`deletePoll`).
- **Discord:** opening a poll can post it (`matchNightPollOpenedMessage`: the
  grid in words via `gridSummary`, the hours as `<t:…:t>` on each reader's
  clock, no pings, a link to `/#match-night-poll`); the result post
  (`matchNightPollResultMessage`: the winner, how many can play, the next
  occurrence as `<t:…:F>`, the runner-up) is once per closing time, claimed
  with a `matchNightPollResult:<pollId>:<closesAt>` Setting row that is
  released if the send fails. The post is a durable outbox row, so the action
  expires the automation gate (`refresh()`) and the worker delivers a post
  whose first attempt failed without waiting for the gate's next check. Both go through `sendDiscordMessage`, so
  previews never post.
