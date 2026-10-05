# GGD2L docs

Start with the repository [README](../README.md) for the product overview,
setup and deployment. To release, start at [RELEASING.md](RELEASING.md).
[CLAUDE.md](../CLAUDE.md) holds the working rules for changing the code; each
area's own rules are in a feature note below.

## League rules and records

- [TIEBREAKER-WEEK.md](TIEBREAKER-WEEK.md) — playoff tiebreaker rules, what
  players see, and the admin workflow.
- [HISTORICAL-PARTICIPATION.md](HISTORICAL-PARTICIPATION.md) — how rosters,
  auction receipts and actual appearances are kept separately over time.

## Code

- [DECISIONS.md](DECISIONS.md) — settled decisions and deliberate deferrals,
  one line each; check it before proposing a change.
- [ARCHITECTURE.md](ARCHITECTURE.md) — map of the codebase: routes, services,
  database models and background work.
- [REFACTORING-2026-07.md](REFACTORING-2026-07.md) — the July 2026 refactor, with
  the changes it deliberately deferred or rejected.

## Feature notes

Read the note for an area before changing it.

- [concurrency-and-testing.md](features/concurrency-and-testing.md) — guarded
  writes, race tests and seams, and the mutation ratchet.
- [draft.md](features/draft.md) — the live auction, its room and the admin
  tools that start, pause, repair and abort it.
- [rosters-and-standins.md](features/rosters-and-standins.md) — signings,
  releases, promotions, withdrawals, standin cover and match-night check-ins.
- [results-and-opendota.md](features/results-and-opendota.md) — the OpenDota
  client, the import funnel, the league feed, the automation worker and player
  data refreshes.
- [inhouse.md](features/inhouse.md) — the inhouse queue, ready check, captain
  vote, draft, results and Elo ladder.
- [discord.md](features/discord.md) — announcements and the outbox, inhouse
  alerts and the queue board, the ping role bot and account linking.
- [season-schedule-playoffs.md](features/season-schedule-playoffs.md) — phases,
  fixtures and kickoff times, reschedules, standings and tiebreakers, playoffs
  and season history.
- [pages-and-ui.md](features/pages-and-ui.md) — navigation, the UI kit, page
  layouts, mobile and tap-target rules, and the fixture servers.
- [players-and-registration.md](features/players-and-registration.md) —
  signup and MMR rules, the player pool and scouting, profiles, compare and
  team identity.
- [stats-and-side-games.md](features/stats-and-side-games.md) — impact points,
  honors and the stats pages, fantasy, pick'em, scrims and news.
- [match-night-poll.md](features/match-night-poll.md) — the match-night
  availability poll on Home: the self-filling grid, ballots, the count, time
  zones and its admin section.
- [admin-and-operations.md](features/admin-and-operations.md) — admin actions
  and the panel's safety rails, caching and streaming, room connection handling,
  migrations and backups.

## Releases and operations

- [RELEASING.md](RELEASING.md) — start here to release: the routine release of
  one commit to both the US and Europe sites, then the database, scheduler and
  incident procedures.
- [PRODUCTION-OPERATIONS.md](PRODUCTION-OPERATIONS.md) — production release
  evidence, the scheduler runbook, rollback, recovery, and data correction.
- [PRODUCTION-READINESS-2026-08.md](PRODUCTION-READINESS-2026-08.md) — the
  August 2026 launch readiness audit (history).

## Europe, bots and assets

- [EUROPE-SETUP.md](EUROPE-SETUP.md) — how the Europe league is set up and run
  alongside the US one.
- [EUROPE-BRANDING.md](EUROPE-BRANDING.md) — the Europe logo and the image sizes
  each region serves.
- [DOTA-LOBBY-BOT.md](DOTA-LOBBY-BOT.md) — the Steam/Dota lobby bot: setup and
  operation.
- [DOTA-BOT-HOSTING.md](DOTA-BOT-HOSTING.md) — hosting options and prices for
  the lobby bot.
- [JERSEY-PREVIEW-ASSETS.md](JERSEY-PREVIEW-ASSETS.md) — the team jersey preview
  images and how a team gets its jersey.

## Archive

- [archive/](archive/README.md) — dated audits, redesign notes and release
  records, kept for history and no longer updated.
