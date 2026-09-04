# League visual redesign

This pass replaces the text-heavy presentation from the earlier home/schedule clarity pass. It keeps the same league data and controls, with visual comparisons carrying more of the explanation.

## What changed

- **Home:** compact season hero with a segmented completion ring; larger team crests and live scoreboards; points bars and a playoff cut line; a clickable week-by-week result map alongside recent scores. Personal check-in, team status, stakes, signup and side-game actions remain.
- **Schedule:** visual completion for each week, responsive scoreboard cards, concise live/final/untimed/overdue states, and the existing URL-backed team filter. Projected seed cards and the head-to-head results grid are easier to scan. Calendar downloads, byes, standins, check-ins and reschedules remain available.
- **Standings:** real points bars, W/D/L record bars, form, movement and concise qualification badges. Detailed statistics retain every sortable column and the full tiebreak explanation. Withdrawn teams and unresolved ties remain explicit.
- **Teams:** actual weekly Elo changes on a shared, zero-centered scale; stronger roster cards with points, series records, crests, complete names and draft budget states. Draft recap follows the current rosters.
- **Leaderboards:** readable player and team names, prominent metrics and proportional comparison bars. Percentiles and win rates use their full fixed scale, so a 55th-percentile league leader fills about 55% rather than 100%. Tied ranks, the pinned viewer, profile availability and show-all controls are preserved.
- **Season archives and completed home:** the same standings and result-map treatment, with every historical series, roster, championship state and official bracket retained.

## Data and runtime boundaries

No database schema, query, scoring rule, permission, mutation, draft budget calculation, playoff seeding, phase transition or integration changed. The new graphics use existing data. The weekly map shows unfinished fixtures as open, without assuming they are future matches. Forfeits retain their marker. Playoff projections remain explicitly separate from the official bracket, and scenario percentages still disclose their equal-weight interpretation.

The result map and progress visualization render on the server. No chart package or additional data query was introduced. Result tiles disable automatic prefetch so a chart does not eagerly load every match page. Fixture results are indexed once for the weekly map; very large schedules use aggregated progress arcs instead of an SVG element for every series.

## Verification

Validation uses disposable SQLite fixtures with external integrations disabled. Production data and deployment are unchanged.

- 2,216 unit tests passed.
- 98 browser workflows passed: 53 mid-season, 35 signup/draft/inhouse and 10 postseason.
- The new weekly-map browser check confirms that every published series appears for both teams, final counts agree with season progress, and a result opens the underlying match.
- The leaderboard browser check also verifies that percentile bar length agrees with the displayed percentile, independently of who leads the league.
- The scouting-report browser selector now selects an explicitly upcoming scoreboard. Live scoreboards also show their kickoff time, so the former time-element selector no longer distinguished the two states.
- Production build, TypeScript, full ESLint and whitespace checks passed.
- The built app was reviewed at 390px and 1440px on home, schedule, teams, leaders and a season archive, including expanded playoff analysis and archive series. All 22 reviewed views had zero horizontal page overflow and no uncaught or hydration errors. Result navigation was rechecked after disabling prefetch.

## Preview gallery

These screenshots use isolated fixture data.

- [Home](league-visuals-2026-09-04/home-1440.png)
- [Points race and standings](league-visuals-2026-09-04/standings-1440.png)
- [Weekly results and recent scores](league-visuals-2026-09-04/weekly-results-1440.png)
- [Mobile schedule](league-visuals-2026-09-04/schedule-390.png)
- [Mobile scoreboards](league-visuals-2026-09-04/scoreboards-390.png)
- [Team power rankings](league-visuals-2026-09-04/teams-1440.png)
- [Mobile rosters](league-visuals-2026-09-04/rosters-390.png)
- [Mobile leaderboard](league-visuals-2026-09-04/leaders-390.png)
- [Archived series](league-visuals-2026-09-04/archive-series-390.png)
- [Browser review results](league-visuals-2026-09-04/browser-review.json)
