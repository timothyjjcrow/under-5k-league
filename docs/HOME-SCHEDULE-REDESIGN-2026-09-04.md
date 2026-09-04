# Home and schedule: league clarity redesign

## Findings and resulting experience

The pages gave nearly equal prominence to fixtures, standings, playoff projections, scenario percentages, form symbols, and the head-to-head grid. That required players to interpret the league instead of quickly reading its current state.

| Problem | Change |
| --- | --- |
| Unfinished future fixtures appeared in the “Results outstanding” warning | Warnings now use only overdue, non-live results under the existing freshness policy. Live, scheduled, untimed, and overdue series have distinct progress labels. |
| Home's week counter could identify an older missing result while the match list focused on a newer week | Both pages use the same presentation summary and freshness policy for their regular-season focus. These labels never advance a season or change result eligibility. |
| Standings assumed familiarity with W/D/L, Diff, form symbols, and tiny qualification icons | Simple standings show full team names, written series records, points, and playoff status. “Detailed statistics” retains sorting, form, movement, tiebreak explanations, seed announcements, and every existing field. Home shows the whole field rather than silently slicing it. |
| Team filters needed sideways scrolling and still showed whole-week completion totals | A labeled team selector retains URL state, reload/back behavior, personal defaults, and byes. Filtered week totals describe the selected team's series; the page explains that standings remain league-wide. |
| Match-level stakes badges did not say which team they described | Home attaches qualification consequences to the relevant team and only to the scenario engine's identified next match. |
| Recent results squeezed both names and an unexplained score onto one line | Home separates team names and their scores, spells out the round/week and result, and distinguishes forfeits. Match links remain. |
| Projected matchups, “Run-in,” and percentage-heavy race notes were hard to decode | Projections have full team names and labeled seeds. “Remaining opponents” includes the week and current rank. Additional wins needed are spelled out. Equal-weight scenario shares remain available in a result-combination disclosure with their limitations. |
| The head-to-head grid relied on crests and rank numbers as column labels | Columns now include team names; the disclosure explains how to read across a row. The complete grid and all match links remain scrollable within the page. |
| Deep statistics competed with the main match-night tasks | Schedule puts projections and the historical grid behind named disclosures. Home puts player/hero highlights behind a discovery section while preserving its content and links. |
| Personal team records and form required decoding | Rank and points have explicit labels; series records are written as wins/draws/losses. Recent form retains its symbols with a legend under an expandable control. |

The home hero uses a real, labeled completion bar with a fixed denominator of published regular-season series. Its figures do not count up through incorrect intermediate values. Existing signup, draft, postseason, champion, Steam/Discord, check-in, and side-game paths remain.

## Scope and safety

Only presentation components, presentation helpers, and browser assertions changed. No database schema, scoring algorithm, match mutation, permissions, import logic, phase transition, or production data was changed. The official playoff bracket remains distinct from projections. No new dependency or database request was added.

## Verification

Browser review at 390px and 1440px found no horizontal page overflow or uncaught client errors on either page, including expanded analysis. A signed-in fixture view was also checked. Validation used disposable fixture databases with external Discord/Steam/OpenDota credentials disabled.

- Unit tests: 2,216 passed, including freshness boundaries, partitioned counts, and empty/completed/stale-only states.
- Browser tests: 97 unique workflows covered — 52 mid-season, 35 signup/draft/inhouse, 10 postseason. The initial mid-season run passed 51 checks; the captain-flow test still used the old team-chip selector. It was updated to select a team through the new control and passed its focused rerun.
- Production build, TypeScript, ESLint, and whitespace checks passed. The built application was also opened locally to confirm the final home/schedule presentation and absence of page overflow or framework error overlays.
- No production deployment was performed.

## Screenshots

- [Home on desktop](league-pages-2026-09-04/home-desktop.png)
- [Schedule on mobile](league-pages-2026-09-04/schedule-mobile.png)
- [Simple standings on mobile](league-pages-2026-09-04/standings-mobile.png)
- [Expanded playoff analysis](league-pages-2026-09-04/playoff-analysis-mobile.png)
