# League navigation, match center and profile UI

This pass connects the home/schedule visual redesign to the pages players open next. It keeps league rules, season transitions, scores, permissions, integrations and mutation handlers intact.

## Changes

- **Navigation:** a mobile dock links to Home, Matches (or Draft/Inhouse as the phase requires), My Team/Teams/Players, and Explore. Explore opens league tools directly. The existing menu, desktop navigation and account controls remain available. Safe-area spacing keeps content and toast feedback above the dock; menu height also fits landscape screens.
- **Return paths:** match and profile return links remember the originating public list's URL, filters and clicked position within the current tab. Open/collapsed schedule weeks are URL state, with separate regular-week and playoff-round parameters. Direct visits and unavailable browser storage retain normal links. Stored destinations are validated against the fallback list; archives cannot send readers into the active season accidentally.
- **Match center:** full team identities surround a single scoreboard. Recorded-game links, lineups/scouting navigation and a prominent captain action lead into the existing content. Captain reporting, rescheduling and standin tools stay together, with all existing forms and capability gates. Box scores retain every metric while giving names, KDA and actual recorded gold more room. Missing scores are labelled as unrecorded rather than proof that play never started.
- **Profiles:** team and player section navigation connects overview, matches, roster, performance, heroes and career sections. A shared scoreboard surfaces the live, next or latest relevant series using existing data. Team fixtures move before roster/scouting; team schedule links retain the team filter. Player match-history filtering retains its history-only scope.
- **Setup:** compact status tiles identify relevant next steps. Previously saved signup answers collapse behind Edit signup; new signup and first-save feedback stay open. Draft commitment, assignments and withdrawal remain directly available. Validation and returned errors reveal the relevant editor.
- **Statistics:** metric boards precede the long weekly-honors history. Sample counts and rate-board minimums are visible; existing metric anchors, full board toggles, scope selection and data-quality notices remain.
- **Keyboard access:** section jumps retain focus on their headings until the user moves away. The previous immediate removal of temporary tabindex blurred the target in Chromium.

## Preservation and implementation

No changes to Prisma schema, migrations, production data, scoring, import services, authentication, action handlers, season gates or external integrations. Existing queries supply the new profile scoreboards. Schedule disclosure updates use browser history without refetching the page. One small navigation listener stores return context; it does not add a provider or data request around each row.

No production deployment is included. Browser mutations use the repository's separate disposable signup, mid-season and postseason fixture databases, with outbound integration credentials disabled.

## Verification

- 2,232 unit tests passed across 173 files.
- 103 distinct browser workflows passed: 58 regular-season, 35 signup/draft/inhouse, and 10 postseason. Regular-season coverage includes targeted reruns after fixing heading focus and two test assumptions (waiting for route completion and staging a real directory entry).
- Build, TypeScript, full ESLint and whitespace checks passed.
- 27 production-build captures at 390px and 1440px cover home, schedule, match center, box scores, lineups, captain controls, team/player profiles, statistics, setup and Explore. No horizontal page overflow, uncaught client exceptions or hydration errors were detected.
- Final visual review aligned crests and gold totals across long team names, removed an empty grid cell for odd fixture counts, and tightened the Explore panel. Production-preview checks also exercise section focus and the compact Explore links.

The browser mutation suites run with development login enabled only on their isolated test servers. The production preview keeps that route disabled and uses locally signed fixture sessions for authenticated screenshots. Production credentials are not used.

Images and the error/overflow measurements live in [league-flow-2026-09-04](league-flow-2026-09-04/browser-review.json). Selected captures: [match center](league-flow-2026-09-04/match-center-390.png), [box score](league-flow-2026-09-04/box-score-390.png), [team overview](league-flow-2026-09-04/team-overview-1440.png), [player overview](league-flow-2026-09-04/player-overview-390.png), [Explore](league-flow-2026-09-04/explore-390.png), [saved signup](league-flow-2026-09-04/participation-390.png).
