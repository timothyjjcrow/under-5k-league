# Historical participation

The application keeps three different facts separate:

1. **Roster membership:** `TeamMember` is today's roster. `RosterTenure` retains when a membership began and ended, along with acquisition facts known at that time.
2. **Confirmed plan:** `MatchLineup` and its immutable seats record a captain's selected players, optional planned positions, current-kickoff check-ins and observed ratings. A newer confirmation supersedes the old plan from that moment onward.
3. **Actual appearance:** imported `Game.players` remains the canonical box score. `GameParticipant` indexes its validated lines for player queries. A plan alone never awards an appearance or proves the position actually played.

Official team results and the current competition's scoring rules are unchanged. Individual series-win counts require a recorded appearance in that series. A “championship contribution” means the player appeared for the champion during that season; it is deliberately separate from an official individual title policy. Manual results without player evidence count for teams only.

## Captain workflow

Players check in on the match page for its current published kickoff. The captain selects exactly the season's configured team size, with distinct people and optional distinct positions. The server rechecks authority, eligibility, check-ins and schedule/logistics revisions in the write transaction.

A changed kickoff requires new check-ins and confirmations for both teams. Roster, cover and check-in changes supersede the affected team's plan. Earlier seats remain stored. A live series supports readiness and replacement plans for the remaining games; these cannot change an earlier game's lineup evidence. A completed match's historical plan is retained.

Older standin assignments do not prove an accepted offer. Their acceptance snapshot is explicitly unknown; the player's current check-in is a separate fact.

## Auction receipts

New draft starts freeze their rules, opening budgets and rating inputs in `DraftRun`. Each nomination has its own `DraftLot`, accepted bid receipts and outcome. Requests identify the current lot so a delayed bid cannot land on a later nomination of the same player. Undo and abort retain the earlier receipts and annotate the reversal. Moving or releasing a player does not rewrite their original purchase.

The teams page computes a fully tracked draft recap from those receipts, rather than today's memberships. Teams and season history also expose retained auction outcomes. Older drafts are explicitly labelled observations of surviving records; missing bids, opening ratings and nomination boundaries are not reconstructed.

## Existing data and corrections

After the additive migration, existing box scores still work through a safe fallback. In **Admin → Historical records**, an administrator can index up to 20 games or capture up to 50 surviving memberships per batch. Repeat until no work remains. Neither action contacts a game provider or sends an announcement.

The index records the exact source string and projection version. An old application writer that changes the canonical JSON makes its index ineligible immediately; reads fall back to the new source until it is rebuilt. Incomplete or malformed box scores remain stored and are excluded from trusted statistical aggregates. Repeated indexing does not fabricate missing identities.

A surviving membership can prove its stored start date and observed price. It cannot prove an original rating, captain status, acquisition method, or an already deleted membership. If an older writer removed a captured member without recording departure, reconciliation marks the end date unknown rather than substituting the repair time.

An administrator can correct player/team attribution under a game's box score. The form requires a reason and the original source digest. The source, participant index, before/after audit and statistics revision commit together. The action cannot change observed combat statistics, move a player to an unrelated side, create duplicate players, or overwrite a newer correction. Changing the mapped person clears the previous person's role/rating claims.

Season export format 5 includes roster intervals, draft runs/lots, participant indexes, confirmed lineups/seats and the identities referenced by those records. Preserve an export before deliberately deleting a season; a season deletion still removes its owned competition data.

Resetting playoffs or returning to the regular season records each removed fixture's canonical games, participant indexes, confirmed/superseded lineups and cover assignments in a required admin audit receipt before deletion. If that receipt cannot be saved, the reset rolls back. The existing compact game-ID recovery list remains available for reimport; the retained receipt records what was actually removed rather than treating a reimport as the original evidence.

## Release compatibility

This is an additive schema release for both regions. Follow `SHARED-LEAGUE-RELEASE.md` and `PRODUCTION-OPERATIONS.md`; promote the same commit to both projects through the paired release command. An application rollback can read its old tables. Historical readers explicitly detect older writes rather than trusting stale projections. Do not undo the additive schema as an application rollback.
