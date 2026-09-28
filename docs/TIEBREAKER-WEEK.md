# Playoff tiebreakers

Both leagues use these rules. They match `src/lib/tiebreakers.ts`,
`src/lib/single-elimination.ts` and the player-facing copy in
`src/lib/tiebreaker-format.ts`. Tiebreakers that were already published before
the 20 September 2026 change keep their original rules; see
[Tiebreakers published before 20 September 2026](#tiebreakers-published-before-20-september-2026).

## When a tiebreaker is needed

After every regular-season result is final, the site applies the normal
standings rules: points, overall game differential, series wins, then the tied
teams' head-to-head points and game differential.

If teams are still tied and their order affects playoff qualification or
seeding, they play a tiebreaker in an extra league week. Ties entirely outside
the playoff field need no extra matches. Withdrawn teams cannot take part.

## Competition rules

- Remaining ties use **best-of-one single elimination**. One loss ends a team's
  run, and no team plays more than three games.
- For a qualification tie there is one bracket per available place. Three wins
  can decide a place among at most eight teams: if more teams are tied, the
  published draw picks the first eight per place before any game is played, and
  the rest are eliminated without playing. Every bracket winner qualifies; no
  team plays a bracket that cannot earn a place. A seeding-only tie uses the
  fewest brackets needed for the same limit.
- All tied teams are drawn once. Smaller brackets fill first in draw order, and
  the first entrants in each bracket get any opening byes. A one-team
  qualifying bracket is an automatic qualification. For example, three teams
  for two places means one qualifying bye and one BO1 for the other place.
- Bracket winners rank first. Other teams rank by how close to their bracket's
  final they got; equal finishes use the original draw order. Teams outside an
  oversized field's draw cutoff rank last. There is no fourth game and no
  repeated round.
- Every opening game that is ready shares the league's next match-night
  kickoff. Each later game is created as soon as its own feeder games finish,
  in the same league week, with no scheduled break. Different branches run
  independently, so a team may wait for its next opponent but never for a whole
  round.
- A tiebreaker must have a winner, including an administrative forfeit ruling.
- Tiebreakers settle playoff order only. They never change regular-season
  points, records or regular-week honors. Their games count in season
  performance statistics like other league games.

## What players see

Home, Schedule, match pages and team pages use the same playoff projection.
Near the end of the regular season the tracker shows what a win, draw or loss in
a team's next series can mean once points, game differential, series wins and
head-to-head have been applied. Recorded live game scores remove outcomes that
can no longer happen.

The tracker separates direct qualification, a tiebreaker for a playoff place,
qualification with an unresolved seed, and elimination. Where several outcomes
are possible it counts score combinations; those counts are not predictions or
odds. Forecasts assume normally completed series, so administrative rulings or
score corrections can change them. Longer remaining schedules keep
conservative qualification guarantees instead of listing every score.

Once regular results and tiebreakers are final, the actual order replaces the
forecast. A team already sure of a place stays qualified while a seeding-only
tiebreaker is pending. The public schedule shows the full draw, byes and future
match slots under **Tiebreaker bracket**.

## Admin workflow

1. Finish and review every regular-season result.
2. In **Admin → Playoffs**, review the tied teams and the format, then select
   **Schedule tiebreaker week**. The season stays in Regular season. The draw
   and byes are saved and published at this point.
3. Opening games get the next configured league night as their kickoff. If the
   season has no league night, set the times in **Admin → Tiebreakers** or
   **Schedule & results**.
4. Import the games or enter decisive results with the normal match controls.
   Players find the extra week on Home, Schedule, team pages and calendars once
   kickoff times are set.
5. Each decisive result creates the next game in that bracket automatically.
   If that step is interrupted, the automation loop retries it; the
   **Create next tiebreaker match** button in the Playoffs card does the same
   by hand. **Start playoffs** stays unavailable until every relevant tie is
   settled.
6. Start playoffs. The bracket uses the resolved seeds and starts in the week
   after the tiebreaker week.

## Corrections

Once any tiebreaker exists, regular-season results and team withdrawal or
reinstatement are locked. An earlier tiebreaker result locks as soon as a game
that depends on it has been created. All tiebreaker results lock when the
playoffs are seeded.

Use **Reset tiebreaker week** in the Playoffs card to rebuild the extra
fixtures before playoffs. It removes every tiebreaker fixture and its games,
check-ins, standin bookings, pick'em picks and reschedule requests. The saved
draw is kept for the same regular-season results, so a reset cannot reroll the
byes. Imported OpenDota match IDs are kept in the admin recovery list for
re-import, and booked standins receive stand-down messages. Review the regular
results, then schedule again.

If playoffs already exist, use **Return to regular season** first. Removing or
resetting a playoff bracket keeps the tiebreaker results that came before it.

## Tiebreakers published before 20 September 2026

Before 20 September 2026 the league used different tiebreaker formats. A tie
whose fixtures were published under those rules keeps them, including for later
rounds of the same tie, and its results keep their meaning. The US league has
completed tiebreakers under these rules.

- Two tied teams played one **best-of-three** series.
- Three tied teams played a **best-of-one double-elimination bracket** of four
  or five games in one week. The opening matchup and one opening bye were drawn
  when the first game was created. Game 1 was A versus B; game 2 the game 1
  winner versus the bye team C; game 3 the two losers so far, where the loser
  finished third; game 4 the game 2 winner versus the game 3 winner; and a
  deciding game 5 only if the undefeated team lost game 4.
- Groups of four or more played a **best-of-three round robin**, ranked by
  series wins then game differential in that round. A subgroup still tied for a
  place or seed played again, which could need another week.

## Implementation and verification

`Match.phase = TIEBREAKER` uses the existing string column. Each fixture's
`bracketSlot` records its draw, bracket position and an immutable fingerprint
of the regular results and eligible teams (`TBS:` for single elimination; the
older formats use `TB:` and `TBD:`). Stale, missing, duplicate or inconsistent
tiebreaker fixtures block the playoff start.

Scheduling, reset and playoff seeding read their inputs inside serializable
transactions. Admin forms carry a revision of the data the admin reviewed, so
late results, new bookings or a duplicate submission cannot silently replace
it. A missed post-result step is retried by the existing automation loop; there
is no separate scheduler.

Coverage lives in `src/lib/tiebreakers.test.ts`,
`src/lib/single-elimination.test.ts`, the tiebreaker component tests,
`test/integration/tiebreakers.itest.ts` and the three
`test/integration/tiebreaker-*lifecycle.itest.ts` suites. The postseason
browser suite (`e2e-postseason/tiebreaker.spec.ts` and
`e2e-postseason/weekend-tiebreaker.spec.ts`) drives both the current knockout
and a published double-elimination bracket through to playoff creation.
