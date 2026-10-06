# Stats pages, awards and side games

What GGD2L builds on imported box scores (impact points, MVPs, weekly honors,
Leaders, Hall of Fame, Record book, upsets, streaks and record watch, Hero
meta, power rankings, scouting), the side games (fantasy, pick'em), scrims and
league news. Rules are pure and tested in `src/lib/` (`fantasy.ts`,
`achievements.ts`, `honors*.ts`, `pickem.ts`, `hall-of-fame.ts`, `records.ts`,
`upsets.ts`, `hero-meta.ts`, `power-rankings.ts`, `scouting.ts`, `scrim-*.ts`,
`news*.ts`).

## Impact points, MVPs, achievements

- **One per-game score, "impact points" in public**: `fantasyScore`/
  `fantasyPoints` (`fantasy.ts`, weights in `FANTASY`). Kills, assists,
  deaths, a win bonus, plus the best ONE of three capped bonuses (economy,
  playmaking, pressure; `BONUS_CAP`) so farm and damage can't stack. Fantasy,
  match MVPs, Player of the Week, the season MVP (`awards.ts`) and the Hall of
  Fame all use it. Explain it with `impactPointsRule()`, which is built from
  the weights so copy can't quote stale numbers.
- **`gameMvp`** (`achievements.ts`): best impact line among mapped players,
  then kills, fewer deaths, user id. League box scores and every inhouse
  surface use it. **`achievementsFor`** is the profile trophy case over all
  seasons: Match MVP ×N, Deathless (5+ kills, 0 deaths), Killing spree (15+
  kills), Playmaker (20+ assists), Tycoon (600+ GPM), Veteran (10 games),
  Centurion (100 career kills).

## Weekly honors

- **`weeklyHonors`** (`honors.ts`): Player of the Week = most impact points;
  Team of the Week = most game wins, then points. Credit lines to their
  import-time `teamId`, never the live roster, so a release and re-sign can't
  move old weeks' points.
- **Publish only through `evaluateHonorWeeks`** (`honors-readiness.ts`, via
  `getSeasonHonorReadiness`). Regular season only. READY needs every fixture
  final; each played series backed by exactly its score in complete 5v5 games
  (forfeits may have fewer, never more); each game with ten unique attributed
  users whose teams match Radiant/Dire and whose winner matches the result.
  `/leaders`, Home and `honors-service.ts` share it, so an incomplete week
  waits for repair instead of crowning from partial data. **A league player
  imported with no `teamId`** (an unbooked fill-in from another roster, or a
  released but registered player: "attribution only" in
  results-and-opendota.md) **counts for the side they played on**, the credit
  a booked standin already gets; the stored box score is unchanged. Requiring
  a stored `teamId` held Season 1's week 5. A line with no league user, or
  credited to the other team, still holds the week (a player with no league
  account keeps Season 1's weeks 1 and 3 held), and /leaders names every held
  week, not only the newest.
- **/leaders reads the readiness through the public cache**
  (`getPublicSeasonHonorReadiness`, `cached-queries.ts`: the result revision
  and the "games" tag), so a view doesn't re-read the season's box scores
  beside the cached leaderboards. The worker and the announcement paths read
  it directly; so does Home's honors line, which sits in a nested Suspense
  where a cached wrapper has hung before (admin-and-operations.md).
- **The post says "167 impact points (best game on Dark Willow)":** the
  points are the week's total and the hero the best game; "on Dark Willow"
  read as one game's score.
- **`honorsAnnounced:<season>:<week>` is a retryable CAS state, not a sent
  bit.** Every path that changes a completed regular result calls
  `markWeekHonorsStale(tx, …)` inside its result transaction; the next ready
  slate posts a corrected award or withdrawal exactly once.
  `retryPendingHonorAnnouncements` (result sync) sweeps failed claims.
- **Keep `honorBestGame` out of `weeklyHonors`**: that result is hashed into
  the marker, so a new field reads as a changed award.
- **The Oracle of the Week rides the same post and marker**: `weekOracles`
  over the week's REGULAR matches, every tie listed, omitted if nobody called
  one. `weekOracleLine` is best-effort: a failure costs the line, never the
  award.

## Week wrap (`/seasons/[id]/weeks/[week]`)

- **One page per regular week tells its story from stored results** (Tim's
  call, 2026-10-05; pure parts in `week-wrap.ts`): the results with upset
  tags (`seriesUpset`, the same rule as Home), the week's honors through the
  public readiness cache (or why they are held), the pick'em oracle
  (`weekOracles`), the best single game (`bestGameOfWeek`: highest impact line
  by a league player, ties by kills, fewer deaths, user id), the table after
  the week with places moved (`weekWrapTable`: `regularTableBeforeWeek(week +
  1)` against `(week)`, no arrows until a week of results is behind it), and
  next week's fixtures. Under the season's own URL (`weekWrapPath`), so an old
  link opens its week after the handoff; an unknown week is a 404.
- **Linked from where a week ends:** each finished week on /schedule, the
  week label on /leaders' honors, Home's honors line, and the Discord honors
  post ("Week 4 wrap: …"), which used to link the leaderboards. The post's
  send-once marker is a digest of the honors, not the text, so the new link
  never re-posts a week. `e2e-mid/week-wrap.spec.ts` covers the page.

## Leaders

- **Rank what the player did** (Tim's decision). No total-wins, win-rate or
  "Winningest" board: they ranked the team's record. Kills and assists are
  per game with a flat `PER_GAME_MIN_GAMES` (3, `src/lib/player-stats.ts`,
  shared with the season awards) so volume can't win; other average boards
  cap their floor at the most-played count so they aren't empty early. Keep
  "Most games". `leaders-guards.test.ts` pins the constant and both boards.
  Details and nav: `pages-and-ui.md`.

## Season awards (the recap)

- **`computeSeasonAwards` (`awards.ts`, tested) ranks per game, never a
  count** (a count crowns whoever played most for the best team). MVP is
  impact points per game with a floor of half the most games anyone played
  (`ceil(maxGames / 2)`). Kill Leader and Playmaker use the one-decimal
  per-game average and the same flat `PER_GAME_MIN_GAMES` and tiebreaks
  (more games, then id) as the /leaders boards, and are skipped until someone
  qualifies, so the recap always crowns who those boards put first.

## Hall of Fame

- **It waits for a champion.** Until one season resolves a champion, the page
  is one note pointing at Leaders and the Record book. Every entry point
  (menus, `/seasons`, the Record book's "Career legends") uses
  `hasOfficialChampion` (`official-champion.ts`), never "a COMPLETE season has
  `championTeamId`", which says yes during an admin repair.
- **Careers come from recorded appearances, never today's roster**
  (`appearanceCareers`): title contributions (substitutes included) and series
  wins. Game boards (`careerGameCounts`, `pointsByPlayer`) appear only once
  trusted games span two seasons, since one season would repeat Leaders.
  "Pick'em calls" places by `pickemStandings` (row `rankValue`) and skips zero
  correct. Empty sections are left out. Its link says "Make a pick" only when
  /pickem can take one (active season, `postAuctionWorkOpen`), else "Open
  Pick'em": the board shows all year, pick'em is closed between seasons.
- **Equal scores share a place, and ties at the cutoff show** (`topPlaces`:
  1, 1, 3; top 5 by place, capped at 10 rows plus "+N more tied"). Decimal
  boards place on the shown precision (`placeKey`).

## Record book

- **`/records`**: all-time single-game records (Player, Match lists; season
  switcher once two seasons have games). Player records: kills, assists, net
  worth, GPM, XPM, last hits, denies, hero and tower damage, healing
  (`PLAYER_RECORDS`). Game records (`GAME_RECORDS`): longest, fastest,
  bloodiest, biggest stomp, closest (20+ kills), most kills in defeat.
- **Never add "Most deaths"**: the book doesn't name anyone for their worst
  game. **Unreported is not a record**: 0-0 or 0-duration games never qualify.
- **The first achiever keeps a tie**, so every reader orders games with
  `compareRecordChronology` (start time, unknown last, then id); the page says
  so.
- **Map games only through `analyzeRecordGames`/`toRecordGames`** (shared with
  profile chips): a malformed, partial or duplicated box drops the whole game;
  unsafe stored duration/scores become 0 and show in `StatsDataNotice`;
  missing economy fields are null, never 0.
- **A broken player record rides the series result post**: one line at most,
  inside `announceSeriesResultOnce`'s marker (no new send). Silent until
  `RECORD_ANNOUNCE_MIN_GAMES` (20) complete games exist outside the series;
  strictly greater only. `seriesRecordLine` is best-effort.

## Upsets, streaks and record watch

Reasons to open the site between match nights, each a pure rule with its
numbers in one named constant. Stored results only: no pace, averages or
predictions. Where each one shows: `pages-and-ui.md` (Home, the profile, the
match preview) and `season-schedule-playoffs.md` (the standings chip).

- **An upset is judged on points going into the week, never places**
  (`seriesUpset`, `upsets.ts`). Regular season: the winner had at least
  `UPSET_MIN_POINTS_GAP` (3, a full win) fewer points than the loser in
  `regularTableBeforeWeek` (`standings.ts`: completed REGULAR results from
  earlier weeks, so a postponed fixture is judged against its own week; the
  movement arrows use the same table). Places would invent upsets: teams
  level on points are split by tiebreaks and finally team id. Nothing is
  tagged until `UPSET_MIN_PRIOR_WEEKS` (2) earlier weeks have results (week 3
  at the soonest); after one night the table only says who won.
- **A series in hand raises the bar a full win.** Each series the loser had
  played more than the winner adds `UPSET_MIN_POINTS_GAP` again: a team
  with a bye or a postponed fixture trails on points without being worse.
- **The table is what was known at kickoff.** An earlier week's result
  counts only if it kicked off before the series being judged (untimed
  results always count), so a postponed result played later never flips a
  verdict after the fact (`upsetContext` builds one table per week and
  kickoff).
- **Playoffs judge the frozen seeds** (`seedsFromFirstRound` over PLAYOFF and
  FINAL rows only, because a tiebreaker's `TB1` slot parses as round 0). The
  higher seed number winning is the upset; a side without a seed gets no
  tag. **Draws, forfeits and TIEBREAKER series are never upsets.**
- **The upset of the week** (`biggestUpset`) comes from the latest week with
  a played series: the largest gap, then the lowest match id. When that
  week had none there is no line; an older week's never stands in. Forfeits
  don't make a week the latest: a withdrawal rules all of a team's later
  fixtures at once, and those weeks hold nothing anyone played yet.
- **A win streak is consecutive series wins in play order**
  (`seriesWinStreak` through `standingsForm`, `team-matches.ts`): week,
  kickoff (untimed last), then id, never a query's row order. A draw or a
  loss ends it and every phase counts, as in the Last 5 strip, which reads
  the same sorted list so the chip and the strip always agree. Shown from
  `WIN_STREAK_MIN` (2), wins only (no losing streaks), and only on a live
  table (`standingsStreaksShown`: the active season in REGULAR_SEASON or
  PLAYOFFS), never a finished or archived one.
- **Record watch is the league record minus a career best**
  (`recordWatchBook`, `recordWatchFor`, `recordWatchLines` in `records.ts`),
  both read through the record book's own mapping and metrics. Silent until
  `RECORD_WATCH_MIN_GAMES` (20) complete games; a line only within
  `RECORD_WATCH_WITHIN_PERCENT` (15, inclusive) of the record and never for
  a record the player holds; one line a player, their closest by share of
  the record (ties in book order); at most `RECORD_WATCH_PER_MATCH` (3) on a
  match preview. An equalled mark reads "level with the record" because the
  first achiever keeps a tie. `recordWatchText` states stored facts with
  exact numbers ("Career best 18 kills · record 21, 3 short"). Player
  records only: no game records, and deaths were never a record.
- **None of it posts to Discord.** An upset line in the result post or a
  record-watch line before match night would be a new message, so it waits
  for Tim's call.

## Hero meta

- **`/meta` is one season's report** (`?season=`): headline, one sortable
  table (`HeroMetaTable`, no URL state), never-picked heroes in one
  `<details>`. "Best win rate" needs `META_HEADLINE_MIN_PICKS` (8) picks,
  compared exactly (a 3-0 hero is not a headline).
- **Only trusted, complete 5v5 boxes count.** A game with any unknown hero is
  dropped whole (`allHeroesKnown`) so coverage can't pass 100%, with a
  catalogue-update notice. A deleted player shows as "Former player".

## Power rankings

- **Per-game Elo** (`power-rankings.ts`, K=32, start 1000; series expand into
  games, home wins first). REGULAR matches only; the lib skips forfeits
  (awarded games aren't performance). One completed week shows no movement.
- **Keep it, below the rosters** (Tim's decision): `PowerRankingsCard` on
  `/teams`, folded to one line, "Frozen" after the regular season.

## Scouting report

- **Public, two-sided, on the unplayed match preview**
  (`src/app/matches/[id]/scouting-report.tsx`), over all seasons' games.
  Folded on phones (`AutoOpenDetails` `match-scouting`, open from 64rem and
  by the Scouting jump). Role coverage reuses `roleCoverage` (`pool-stats.ts`).
- **Hide one-offs behind `SCOUT_MIN_GAMES` (2)**: at a few games per player
  one game is noise. `threatList` shows heroes won on (50%+ at `threatBoard`'s
  `max(2, ceil(picks / 25))` floor), else most picked; `comfortPicks` falls
  back to stored pub heroes, labelled "pubs".
- **Keep its read uncached** (`fetchGamesForScouting`): `unstable_cache` hung
  the preview's nested Suspense stream (`e2e-mid/match.spec.ts`).

## Fantasy and pick'em: shared rules

- **Open only after the auction is COMPLETE** (`postAuctionWorkOpen`); COMPLETE
  and archived seasons are read-only.
- **Gate the control, not its look.** Both save actions write to the ACTIVE
  season, so a control on an archived page would edit the current one.
  `/fantasy`'s `locked` folds in `readOnly` and alone renders the picker;
  `/pickem` forces `open` empty unless `canPlay`; Home and the match preview
  fold `season.isActive && postAuctionWorkOpen(…)` into `canPlay`. Pinned by
  `src/app/side-game-archive-guards.test.ts`.
- **Both pages take `?season=`** (`resolveSeasonScope`; unknown or repeated is
  a 404; `readOnly = !season.isActive`), so past winners stay visible.
  `/seasons/[id]` links both.
- **Re-validate in one Serializable transaction and claim what you read**:
  `claimSideGameSeason`/`claimSideGameDraft` (+ `claimOpenPredictionMatch`)
  in `side-game-claims.ts`. A Serializable read alone doesn't conflict with a
  child-row write. Postgres uses `FOR SHARE` (managers stay concurrent;
  import, phase, reschedule and archive writers are excluded); SQLite uses
  guarded no-op `updateMany`s. `retrySideGameTransaction` retries
  `isSerializationConflict` (P2034, or raw P2010 with SQLSTATE 40001). Seams
  `fantasy.save.afterLockRead`, `pickem.save.afterLockRead`.

## Fantasy

- **Discord says when fantasy is open:** the draft recap (it posts as the
  auction completes, when fantasy opens) and the regular-season start post,
  while `fantasyLockedAt` is unset, end with "🧙 Fantasy is open until the
  first game is imported" and a link, no mentions. Nothing on Discord said so
  before, and 3 of 95 users entered. This promotes it only in its pick
  window, as the 2026-09-27 "Fantasy stays for good" row allows.
- **Keep fantasy forever; promote it only in the pick window** (Tim's
  decision). `fantasyListed` (`site-nav.ts`) lists it from the completed
  auction until the lock, then only for viewers who entered; menus, Home's
  tile and `/seasons/[id]` use it. The URL always works.
- **MMR salary cap.** `fantasyCap` = average known rostered MMR × slots × 1.05,
  rounded to 50. `fantasyPrices` prices unknown MMR at the pool average (no
  free picks); an all-unrated pool runs uncapped. The form carries
  `expectedSeasonId` so a stale tab can't save into a new season.
- **`Season.fantasyLockedAt` is a one-way lock.** The first import stamps it in
  the game's transaction; `removeGame` backfills and never clears it (stats
  are public); only a pre-result `abortDraft` clears it. Readers treat "stamp
  OR any game" as locked.
- **Fives are private before the lock** (only the count shows). A released
  player's pick stays visible and removable, or it blocks a slot forever.
- **After the lock the page is the standings, never a dead end.** `#lineup`
  renders only while open or for your own five (`!locked || myRoster`); the
  subtitle says "New fives open after next season's draft." A season nobody
  entered gets a compact note where the standings go. Each standings row folds
  open to show that five and each pick's points.
- **The summary tiles follow the lock** (pure `fantasyWindowTiles`,
  `fantasy-tiles.ts`, tested). Open: draft pool and salary cap. Locked: Top
  player, then Your rank (else Leader, else Players scored). Never the pool or
  cap after the lock, when nobody can pick.
- **One sticky bar holds count, salary and the one Save button**
  (source-guarded), above the phone tab bar. On phones it reads "Save" or
  "Update"; its accessible name keeps "… fantasy five". The pool opens
  price-descending (`fantasy-picker.ts`). Format MMR with `formatFantasyMmr`
  (en-US), never `toLocaleString()`, or hydration shows "7.200" over "7,200".
- **The scoring card leads with impact points** and says a standin night
  earns nothing.

## Pick'em

- **Lock at kickoff, on LIVE, and on COMPLETED** (`predictionOpen`; LIVE so a
  mid-series reschedule can't reopen picks). `predictionOpenWhere` is the same
  rule as a WHERE: edit them together (a unit sweep pins it).
  `partitionPickemMatches` is exhaustive so locked picks never vanish.
- **ONE ranking: `pickemStandings`.** Most correct, then fewest misses; draws
  void picks; ties share a place. The oracle board, Hall of Fame and weekly
  Oracle use it and print `PICKEM_RANKING_NOTE`. Never re-sort it.
- **`PickemPickForm` is the only pick control and the only importer of
  `savePrediction`** (guarded). Other surfaces (Home's This-week cards, the
  match page) use `pickemControlFor` + `PickemTray` for a one-tap pick (open
  control, or your locked pick with ✓/✗/void; never the crowd split). Every
  mark carries screen-reader text ("right", "wrong", "your pick"). Signed out:
  nothing outside `/pickem`; on it, one "Sign in with Steam to pick" button
  (`signInHref`), never dead buttons. Sides are a container query
  (`@container/pick`, side by side from 26rem).
- **Order by deadline** (`groupOpenByWeek`); the crowd split stays hidden
  until lock. Closed picks are ONE newest-first "Your picks" list
  (`pickHistory`). A completed match shows "Your pick: X ✓ (2 of 3 called it)"
  (`calledItCount`, null over "0 of 0"). A save revalidates `/pickem`, `/` and
  the match page. `PickemDeadlineRefresh` re-renders at the next deadline; the
  server render stays the authority on what is open.

## Scrims

Captains post an OPEN time, another captain claims it (SCHEDULED), games
import by player IDs (LIVE, then COMPLETED); nothing touches league
standings. `scrim-service.ts` (post, claim, cancel, end, guests, coaches),
`scrim-result-service.ts` (imports); pure `scrim-view.ts`, `scrim-discord.ts`,
`scrim-schedule-conflict.ts`, `scrim-window.ts`. Keep scrims (Tim's decision).

- **League fixtures win.** Playoff builds call `yieldScrimsToOfficialFixture`:
  cancel booked scrims of those teams within four hours, keep LIVE ones but
  report them. A refusal would silently stop the automatic next round. Each
  clash pings its two captains, is logged ("League automation" if no admin)
  and joins the Start playoffs toast. The cancel is an equivalent claim.
- **Every refusal names the scrim** (`findConfirmedScrimConflict`,
  `describeScrimConflict`, `scrimConflictFix`): schedule tools, reschedules,
  tiebreakers, booking. Known gap: the automatic tiebreaker continuation
  (`advanceTiebreakerWeek`) is still blocked by a clash instead of yielding.
- **Booked page**: both captains, `<DiscordTag>` behind
  `canViewLeagueContact` (never public), and `scrimHostLine` (the poster
  hosts, on `LEAGUE_CONFIG.gameServerRegion`). The signed-out "Sign in to
  see the handles" prompt names who they are for (this season's signed-up
  players, active seasons only, or either team's captains and coaches):
  signing in alone unlocks nothing. **Open page**: a one-click Join
  or the reason from `scrimJoinCheck` (shared with `/scrims`; grace
  `SCRIM_PAST_GRACE_MS`, the service's own).
- **Ping only captains who must act** (`mentionUsers`, post-commit,
  best-effort): new time, other captains (throttled per team by
  `SCRIM_POST_PING_THROTTLE_SECONDS`); claim, the poster (who hosts, who to
  message, which of their open times it withdrew); cancel, whoever didn't
  cancel (both for an admin, nobody for your own unclaimed time). Names go
  through `escapeDiscordText`. `joinScrim` reads the offers its sweep
  withdraws with the SAME WHERE in the same snapshot; don't fold that into the
  sweep's WHERE (a protected claim).
- **"Not played" is display only**: SCHEDULED past the import window
  (`scrimNotPlayedCutoff`, the same `SCRIM_DETECT_WINDOW_AFTER_MS` the
  importer uses; `isScrimNotPlayed`), row unchanged so a late "Add game"
  works. Stats count COMPLETED only.
- **`endScrimSeries`** (captains or a verified admin, not coaches) ends a LIVE
  series at its score (the leader wins; level means no winner): one guarded
  `updateMany` on LIVE + both scores, spelled `hostScore: scrim.hostScore`
  because the ratchet can't see shorthand keys. Seam
  `scrim.endSeries.beforeClaim`.

## League news

- **News has no season**: the admin card (`src/app/actions/news.ts`) always
  renders; every change writes `logAdminAction`. Create is idempotent via a
  `newsPostRequest:<uuid>` Setting committed with the post (it survives
  deletion, so a replay can't resurrect a post). Pin and delete are
  conditional writes.
- **Revalidate on every outcome, not just a change.** Every news action calls
  `refreshNewsSurfaces()` (`/`, `/news`, `/admin`); `toggleNewsPin` and
  `deleteNewsPost` also call it for the no-op answers ("Already pinned",
  "Already deleted"), a missing post and the changed-under-you refusal, so a
  stale admin tab catches up instead of offering the same dead control again.
- **Home shows each post once**: pinned posts in `PinnedNotices` (max 3),
  newest 3 unpinned in `LeagueNews` (`src/components/home/news.tsx`). `/news`
  lists pinned first, 20 per page; each post is an `<article>` anchored by id,
  `?post=<id>` is a permalink, dates render via `<LocalTime>`. Media respects
  reduced motion (animated GIFs become opt-in links). Known gap: no alt text
  or transcript field for media.
- **Create season unpins the old season's news** (`unpinNewsBeforeFinal`,
  `news-rollover.ts`): only posts pinned before its authoritative final;
  none without one. Guarded claim on `pinned` (seam
  `news.unpinNewsBeforeFinal.beforeUnpin`); failure never fails the create.
  The toast names the unpinned posts, and they all stay on `/news`.
- **Discord copy is tracked.** "Also post to Discord" on by default, "Ping
  @everyone" off. `postNewsToDiscord` uses `?wait=true` (not the outbox, which
  can't return an id); `discordMessageId` lets Edit PATCH it (parse `[]`,
  never re-pings) and Delete remove it best-effort.
- **Every write to `discordMessageId` is a CAS on the value read.** A
  `posting:<ms>` mark covers an in-flight post (`newsDiscordCopy`), so nothing
  posts twice and a request that lost its mark deletes its own copy. A failed
  post frees the mark; Edit's "Also post to Discord" is the only retry, and
  every save of a tracked post re-PATCHes it. A mark past
  `NEWS_DISCORD_POST_STALE_MS` means "check the channel first".
