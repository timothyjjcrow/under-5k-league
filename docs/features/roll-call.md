# Roll call

Before the season's first match night, every player signed up for the draft
taps "I'm in" on Home: they can play the season's match night every week for
the whole season, and will play for whichever team drafts them, from the
first match night. Home lists who is in and who hasn't answered, so the
admin can see who is paying attention before the draft (Tim's call,
2026-10-20). Main files: `src/lib/roll-call.ts` (pure: reading the night,
matching an answer to it, the card's view), `src/lib/roll-call-service.ts`
(who is expected, answers, the admin view), `src/app/actions/roll-call.ts`
("I'm in" and "Take it back"), `openRollCall` / `closeRollCall` in
`src/app/actions/admin-season.ts`, `src/components/home/roll-call.tsx` (the
Home card) and `src/components/admin/roll-call-controls.tsx` (the Roll call
section on `/admin`). Model: `RollCallAnswer`, plus
`Season.rollCallOpenedAt`.

## The model

- **An admin opens it, per season.** `Season.rollCallOpenedAt` is the switch
  (null is closed); per-season state lives on `Season`, not a `Setting`.
  Closing keeps every answer, and reopening shows them again.
- **It runs during signups and the draft only** (`rollCallPhase`). From the
  regular season on, the weekly match check-in asks each rostered player
  about each match instead, so Home stops showing the card even if it was
  left open.
- **It needs a settled night** (`rollCallLive`, `rollCallCannotOpen`): one
  announced (`announcedMatchNight`: the fixtures' night once any has a
  kickoff, else the Match night box, else the deployment default), and no
  match-night poll still deciding it (`pollDecidesMatchNight`). Opening is
  refused otherwise, and a roll call that is open when a poll opens hides
  itself until the poll is done.
- **The night is the season's own, read every time, never a copy.** Each
  answer stores the night as the card printed it (`matchNight`), and counts
  only while it is still the season's night (`sameMatchNight`): move the
  night and everyone is asked again ("Match night has changed since you
  answered"); reword it ("Saturdays at 2:00 PM Pacific time" to "Saturday
  2pm PT") and nobody is.
- **Who is on the list** (`rollCallRoster`): every ACTIVE full-player signup
  (the draft pool), plus captains and roster seats. Standins are not: nobody
  drafts them, so "for whichever team drafts me" isn't theirs to promise, the
  same reason only full players confirm the draft time
  (`owedDraftConfirmation`). An answer counts only while its player is on the
  list; the row is kept, so a player who withdraws and signs up again counts
  again.
- **Everyone sees the list.** Names are public on `/players` already; the
  card shows names and avatars only, never Discord handles. The admin
  section adds the stragglers as Discord mentions to paste into a channel
  (`waitingMentions`: `<@id>` for a linked account, else the typed handle,
  else the site name), admin-only.

## Time zones

- **The night shows on the viewer's own clock.** `parseMatchNight` reads the
  night's text as one weekday and minute on the league's clock, and the card
  reuses the match-night poll's clock (`PollClockProvider`, `YourTimeNote`):
  "That's Saturday at 5 PM in your local time (Eastern)." A player on the
  league's clock reads "That's your local time too."
- **Read strictly, or not at all.** The parser accepts the shape every page
  prints and the ways an admin types it ("Sat 2:00 p.m.", "Saturday 2pm PT",
  "Wednesdays 20:00"), and gives up on anything else: another zone ("2 PM
  EST" in a Pacific league), two times or two days, or a 12-hour time
  without AM or PM. A night it can't read prints as typed with no
  conversion, since a wrong conversion is worse than none, and the admin
  section says so and how to write it.
- **The clock is read at the first match night after the draft**
  (`firstNightAt`), so a daylight-saving change between now and the season
  is already allowed for.

## Concurrency

- **An answer is the player's own row, and nothing depends on it,** so the
  answer action's checks (open, same night, on the list) are read-time on
  purpose, and every read re-derives them. A close that lands first leaves
  one more true answer in a closed roll call; a night moved meanwhile leaves
  an answer naming the old night, which stops counting; a withdrawal
  meanwhile leaves a row that counts only after a new signup. Two taps meet
  at the primary key (`@@id([seasonId, userId])`), and the loser of the
  insert race retries as an update (`isUniqueViolation`).
- **Open and close go through `updateRenderedSeason`,** the season settings
  forms' stale-form claim (season id plus `updatedAt`), so a page rendered
  before another admin's change is refused. That claim is already in the
  mutation ratchet.
- **"Take it back" works whatever state the roll call is in:** cleanup stays
  legal.

## Admin

- **The Roll call section** (`#adm-roll-call`) follows the Discord reach
  card during signups and the draft: both are about whether players will
  show. It opens itself while the roll call is open and shows the night it
  asks about, "Open the roll call" or "Close the roll call" (both confirm,
  with real counts), who is in, who isn't, and the mention list.
- **No Discord post and no worker job.** Opening posts nothing; the admin
  shares the link (`/#roll-call`) or the mention list themselves. There is no
  deadline, so the roll call needs no `automation-gate.ts` wake-up.
