# Playoff tiebreaker week

After every regular-season result is final, the site applies the existing
standings rules: points, overall game differential, series wins, then the
head-to-head mini-table (points and game differential).

If teams remain tied and their order affects playoff qualification or seeding,
they must play an extra tiebreaker week. Ties entirely outside the playoff field
do not need extra matches. Withdrawn teams cannot participate.

## Competition rules

- Two tied teams play one **best-of-three** series.
- Three tied teams play a **best-of-one double-elimination bracket** with
  **four or five games total**, all assigned to the same tiebreaker week.
  The opening matchup and one opening bye are randomly drawn when the first
  fixture is created. The saved draw appears in the admin and public notices.
- The three-team bracket progresses as follows. Call the opening teams A and B,
  and the team with the bye C:
  1. A versus B.
  2. Game 1 winner versus C.
  3. Game 1 loser versus game 2 loser. The loser finishes third.
  4. Game 2 winner versus game 3 winner. If the undefeated team wins, the
     bracket is complete.
  5. Only if the undefeated team loses game 4, the finalists play a deciding
     BO1. Its winner finishes first and the other finalist finishes second.
- Every team must lose twice to be eliminated. The random draw chooses the
  opening bye, never the final order. The bracket gives a definite first,
  second and third place without circular ties or another week of matches.
- Groups of four or more, and previously scheduled BO3 round robins, retain
  **best-of-three round-robin** rules: rank by series wins, then game
  differential in that round. A subgroup still tied for a playoff place or
  seed plays again. This larger-group format can require another week.
- A tiebreaker must have a winner, including an administrative forfeit ruling.
- Tiebreaker games settle playoff order without changing regular-season points,
  records, or regular-week honors. They appear in season performance statistics
  like other league games.

## Player-facing playoff tracker

Home, Schedule, match pages and team pages use the same playoff projection.
Near the end of the regular season, the tracker shows what a win, draw or loss
in the team's next series can mean after points, game differential, series wins
and head-to-head rules have been applied. Recorded live game scores remove
outcomes that can no longer happen.

The tracker distinguishes direct qualification, a tiebreaker for a playoff
place, qualification with an unresolved seed, and elimination. Multiple possible
outcomes are counts of feasible score combinations, not predictions or odds.
Detailed forecasts assume normally completed series; administrative rulings or
score corrections can change them. Larger remaining schedules retain conservative
qualification guarantees instead of enumerating an unbounded set of scores.

Once regular results and tiebreakers are final, the actual resolved order replaces
the forecast. A team already guaranteed a place keeps its qualified status while
a seeding-only tiebreaker is pending. Both league deployments use these same rules.

## Admin workflow

1. Finish and review all regular-season results.
2. In **Admin → Playoffs**, review the tied teams and format, then select
   **Schedule tiebreaker week**. The season stays in Regular season.
3. Two-team groups use the next configured league night when available.
   For three-team brackets, reserve enough time during the extra week for
   up to five games. When a league night is configured, games receive planned
   90-minute slots from the opening kickoff, with a short break if a result
   arrives late. Review or edit these times in **Schedule & results**; without
   a configured night, set the times there. New matchups appear after the
   preceding result is final.
   Round-robin groups also require individual kickoff times.
4. Import the games or enter decisive results using the normal match controls.
   Players can find the extra week on Home, Schedule, team pages, and calendars
   once kickoff times are set.
5. For a three-team bracket, each decisive result automatically creates the
   next match in the same week. The result-sync retry can recover interrupted
   progression; the admin **Create next tiebreaker match** control also allows
   recovery. If a round robin leaves another relevant tie, schedule that
   next round after all current matches finish. **Start playoffs** stays
   unavailable until every relevant tie is settled.
6. Start playoffs. The bracket uses the resolved seeds and starts in the week
   after the final tiebreaker week.

## Corrections

Once tiebreakers exist, regular results and team withdrawal/reinstatement are
locked. Earlier tiebreaker games lock when a dependent bracket game or a later
round is created, including games in the same week. All
tiebreaker results lock when playoffs are seeded.

Use **Reset tiebreaker week** to rebuild the extra fixtures before playoffs.
This removes all tiebreaker fixtures and their games, check-ins, standin
bookings, picks and reschedule requests. The original three-team draw is kept
for the same regular-season results, so reset cannot reroll the bye.
Imported OpenDota game IDs are
preserved in the admin recovery list for re-import, and booked standins receive
stand-down notifications. Review the regular results, then schedule again.

If playoffs already exist, use **Return to regular season** first. Removing or
resetting a playoff bracket preserves its preceding tiebreaker results.

## Implementation and verification

`Match.phase = TIEBREAKER` uses the existing string column, so no database schema
migration is needed. Each fixture's `bracketSlot` identifies its round and an
immutable fingerprint of regular results/team eligibility; three-team bracket
slots also identify their game number. Stale, missing,
duplicate or inconsistent tiebreaker fixtures block playoff start.

Scheduling, reset and playoff seeding read their authoritative inputs inside
serializable transactions. Admin forms carry a revision of the reviewed data;
late results, new bookings or duplicate submissions cannot silently replace it.

Coverage lives in `src/lib/tiebreakers.test.ts`, the tiebreaker action/notice
tests, and `test/integration/tiebreakers.itest.ts` plus the lifecycle suite.
The isolated postseason browser suite covers two-team BO3 qualification and
three-team BO1 brackets both with and without the fifth-game reset, through
playoff creation.
