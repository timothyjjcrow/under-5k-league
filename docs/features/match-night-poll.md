# Match-night poll

A ranked-choice vote on the league's weekly match slot, shown on Home. An
admin offers 2 to 10 slots (a weekday and a time on the league's clock),
players rank the ones they can make, and the count is instant runoff. Main
files: `src/lib/match-night-poll.ts` (pure: slots, labels, the count, the
page's view), `src/lib/match-night-poll-service.ts` (storage and claims),
`src/app/actions/match-night-poll.ts` (voting),
`src/app/actions/admin-match-night-poll.ts` (admin),
`src/components/home/match-night-poll.tsx` (the Home card),
`src/components/match-night-poll/*` (ballot, count, slot face) and
`src/components/admin/match-night-poll-controls.tsx` (the Match night poll
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
  not exempt. Everyone sees the card; a signed-in viewer who can't vote sees
  the slots, who votes, and a link to My account while the season still takes
  a signup. One ballot per voter per poll, recast freely until voting closes.
- **Eligibility is checked inside the ballot's transaction, after the
  claim,** so a refusal throws and rolls the claim back. It is not locked: a
  signup withdrawn mid-transaction can let that one ballot through, which ends
  where voting a moment earlier and withdrawing after would (a withdrawal
  doesn't remove an earlier ballot).
- **A ballot is the slots the voter can make, best first.** A slot left off
  means "I can't play then". An empty ranking ("None of these work for me")
  is a vote too: it counts in turnout and is exhausted from round one.
- **The ballot posts the whole ranking at once** (`castMatchNightBallot`), so
  a half-built ranking never counts. Unknown slots and repeats are dropped
  and the toast says how many (never rewrite silently); a ranking of only
  unknown slots is refused rather than saved as "none".
- **The count is hidden from signed-in non-voters while voting is open**
  (`pollResultsVisible`): the tally is left out of the page payload, not just
  hidden, so people rank what they can make instead of piling onto the
  leader. Voters and admins see it live; everyone sees it once voting closes.
  Nothing anywhere says who ranked what.

## The count (`instantRunoff`)

- Each round every ballot counts for its highest-ranked slot still standing.
  More than half of the ballots still in play wins; otherwise the fewest-vote
  slot drops and its ballots move on. Exhausted ballots stop counting, so the
  majority is of ballots in play.
- **Zero-vote slots drop together** (they carry no ballots, so it lands where
  one-at-a-time would).
- **Ties for fewest are deterministic:** fewer votes in the latest earlier
  round that separates them, then fewer ballots ranking the slot at all
  (`reach`), then poll order (the later slot drops). The round records which
  rule decided and `roundStory` says it in words.
- **Show it as a race:** `PollRunoff` keeps rows in finishing order
  (`runoffPlacement`) so nothing jumps, draws each bar as a share of the
  ballots in play against a dashed majority line, and steps or replays the
  rounds with a one-sentence caption per round. "N of M can make it" under
  each slot is `reach`, the approval signal an admin also wants.

## Concurrency

- **A ballot claims the poll row** (`castBallot`): its first write is
  `updateMany({ where: { id, closesAt: { gt: now } } })`, so a close that
  commits first refuses the ballot and one that commits second waits on the
  row lock. The deadline is enforced by that claim alone, never by a
  read-time check (a seam, `matchNightPoll.castBallot.afterRead`, closes the
  poll between the read and the write in the test).
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
  opens itself while a poll is open. It shows the live count, "Close voting
  now", the closing-time box, and once closed "Reopen voting", "Use as the
  season's match night" and "Announce the result on Discord".
- **"Use as the season's match night" reuses `setMatchSchedule`** and fills
  the Match night box under Season settings. It never moves fixtures; when
  fixtures already have kickoffs the card says pages show their night and
  points at Move a match night.
- **Delete is a `DangerSubmit`** whose token is the poll's question, checked
  again on the server (`deletePoll`).
- **Discord:** opening a poll can post it (`matchNightPollOpenedMessage`, no
  pings, links to `/#match-night-poll`); the result post
  (`matchNightPollResultMessage`) is once per closing time, claimed with a
  `matchNightPollResult:<pollId>:<closesAt>` Setting row that is released if
  the send fails. Both go through `sendDiscordMessage`, so previews never
  post.
