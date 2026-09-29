# Pages, layout and the UI kit

How GGD2L's public pages are built: navigation, the home page per phase, the
player pool, the inhouse, admin and match page layouts, and the layout,
mobile, tap-target and accessibility rules every page follows. Main files:
`src/components/ui.tsx` (the kit), `src/lib/site-nav.ts`, `src/app/page.tsx`
plus `src/components/home/*`, `e2e-mid/helpers.ts` (layout probes),
`scripts/fixture-server.ts`.

## Navigation and info pages

- **Every name is a link:** `<PlayerLink userId>` (`ui.tsx`) for players, a
  plain `next/link` to `/teams/[id]` for teams.
- **`src/lib/site-nav.ts` is the one page list** behind the header, Explore,
  the phone tab bar and the footer: one label, one group, one visibility rule
  per page. It is pure so client, server and tests share it. Never add a second
  list in a component.
- **Offer a page only once it has something to show** (each `NAV_PAGES`
  entry's `visible`); hidden pages stay reachable by URL. Schedule and Pick'em
  wait for the COMPLETED auction (`afterAuction` reads the auction, not just
  the phase); the draft room shows from `DRAFT_ROOM_LEAD_HOURS` before draft
  night; stats pages wait for an imported game (Leaders and Hero meta also for
  REGULAR_SEASON: `seasonStatsListed`, which Home and the stats tab bar use
  too); the Hall of Fame waits for `hasOfficialChampion` (via
  `getPublicLeagueContent`), so no link opens onto an empty page. "Season
  recap" resolves to the finished season's own `/seasons/<id>`.
- **`isActive` (`site-header.tsx`) stops "Teams" and "My Team" both
  highlighting** on your own team page.
- **Page stats come from pure, tested helpers:** `summarizePlayerGames`
  (`player-stats.ts`, from each `Game`'s player JSON) for profiles,
  `recentForm`/`headToHead` (`team-matches.ts`) for team pages.
- **`/leaders` opens on Weekly honors, then `topBy` boards** (KDA, kills and
  assists per game with `PER_GAME_MIN_GAMES`, most games, GPM, net worth, kill
  involvement, sustain, report card). No wins or win-rate board (they rank the
  team's record) and no per-board search (`leader-board.tsx` pins the viewer's
  row).
- **`/how-it-works` is the one-screen explainer** (`/features` redirects
  there); its rules are pure in `src/lib/how-it-works.ts` (tested). It prints
  the night through `seasonMatchNightLabel` (`match-night.ts`), never a
  built-in default, so it agrees with /me, Schedule and the admin hint.
  `resultsCopy(hasLeagueTicket)` lets only a ticketed season say results
  arrive by themselves; the ticketless copy reuses `NO_TICKET_RESULT_LEAD`
  (`match-hosting.ts`), the match page's wording. Its one button
  (`howItWorksAction`) reuses the header's join label and Home's "Register as
  a standin" (`standinSignupOpen`), so the three pages name one action one way.

## The shared UI kit

- **Change the kit additively.** `Card`, `CardHeader`, `Stat`, `EmptyState`,
  `PageTitle` and `SectionTitle` have many call sites, so a new capability is an
  optional prop whose default renders exactly what shipped. Current options:
  `Card tone` (`feature` is the ONE card a viewer should act on; if two are
  `feature`, neither is; `quiet` recedes); `Stat size="md"` (text-xl, for a
  narrow column where text-3xl wraps a W-L-D record; never an inline
  override); `EmptyState compact` (a routinely empty section that is not the
  point of the page; two full dashed boxes make a full page look broken);
  `CheckinBanner variant` (`strip` on `/schedule` and the match page, `panel`
  stacked for a narrow column); `StatStrip`/`StatCell` (the one-line summary
  band under a page title).
- **Tokens:** `--color-surface-3` is an OPAQUE elevation step (translucent
  lets scrolled rows show through a table header); `--color-line-soft` is a
  rule inside a dense list (`--color-line` boxes every row).
- **Keep the global link reset inside `@layer base`.** An unlayered
  `a { color: inherit }` outranks every Tailwind utility, so every colour class
  on a link was ignored (near-white on the gold accent buttons).
  `src/app/link-color-layer.test.ts` fails on a bare `a` colour rule outside a
  layer. Blue means clickable: don't colour plain text `text-info`.
- **Use only colour tokens `globals.css` defines.** Tailwind v4 emits nothing
  for an undefined one, so `text-warning` rendered plain text with no error.
  Warnings and attention use `accent` (amber: the passed-date chip, the tied
  chip, "No reply", the rooms' delayed status line).
  `src/components/color-token-guards.test.ts` fails on a token-shaped colour
  class (`warning`, `surface-1`, `info-strong`) that `globals.css` lacks.
- **Small tinted text uses the soft tokens.** Red text on a red tint is
  `text-danger-soft` (plain danger there is about 4.3:1, under AA);
  `tint-contrast-guards.test.ts` fails on `bg-danger/5..20` with plain
  `text-danger` in one class string. Blue text on a blue badge is
  `text-info-soft`. A tint laid over a surface colour goes in a flat gradient
  (`bg-linear-to-b from-danger/[0.04] to-danger/[0.04]` on the live schedule
  card): `cn` is twMerge, which keeps only the last `bg-*` colour and so
  dropped the card's `bg-surface`.
- **`CardHeader` wraps instead of crushing:** `flex-wrap` + `basis-48` on the
  title keeps a link action inline and drops a whole form to its own line.
  Title and subtitle clamp (`min-w-0`, `[overflow-wrap:anywhere]`), so free
  text is safe there.
- **One `<h1>` per page; page sections are `<h2>`.** On Home the season name
  is the h1 and dashboard cards pass `headingLevel={2}` (nested cards default to
  h3), or heading navigation skips what the page is for.

## Grids and bands

- **A fixed two-column split sizes its row to the TALLER column,** leaving a
  hole under the shorter one that looks fine in review. Use one of:
- **Known card count: an explicit grid, and never a short card beside a tall
  one.** Home's standings take the full width. Where a short card must sit by a
  taller one (the COMPLETE view), use `items-start` so it does not stretch.
- **Unknown card count: auto-fit,**
  `grid gap-6 [grid-template-columns:repeat(auto-fit,minmax(min(16rem,100%),1fr))]`.
  Empty tracks collapse, so no conditional spans. Use it for odd or varying
  counts (This week, since a bye makes the count odd). Add `items-start` when
  heights differ.
- **Never add `grid-cols-1` to an auto-fit grid.** It sets the same property
  and wins, collapsing the band to one column at every width. The
  `min(16rem,100%)` already keeps the track inside the container.
- **Give every ORDINARY responsive grid a base column**
  (`grid grid-cols-1 gap-4 sm:grid-cols-2`). Otherwise the implicit `auto`
  track sizes to max-content and one long row scrolls the page sideways. Grid
  items need `min-w-0` for the same reason. Keep every page at zero horizontal
  overflow at 390px; wide pages carry an `expectNoHorizontalOverflow` e2e.

## Mobile rules

- **Put table column widths on `<col>`, not cells.** The standings table
  (`StandingsTableView`, `src/components/standings-table.tsx`) is
  `table-fixed` with a responsive `<colgroup>` so Team truncates. Fixed layout
  still gives a `hidden sm:table-cell` column a share of leftover width, so
  hidden columns get `w-0 sm:w-*` cols.
- **Every flex level between a container and a `truncate` span needs
  `min-w-0`,** and so do flex-wrap chips, or a long name widens the page.
- **`CheckinBanner`'s strip text has `min-w-[14rem]`** so RSVP buttons wrap
  below the copy instead of crushing it.
- **Put `overflow-hidden` on the card around an `overflow-x-auto` scroller**
  (`SeasonGrid`, every card wrapping `<Bracket>`, whose root scrolls a
  `min-w-max` row). Chrome otherwise pushes the inner width into the page.
- **The header is `h-16` (64px); move every offset under it together:** the
  compact clock bars' `top-16` (`draft-room.tsx`,
  `src/components/inhouse/*-view.tsx`), `useBannerOffscreen`'s
  `rootMargin: "-64px ..."` (`room-clock.tsx`), the `lg:top-16` sticky
  `SectionNav`/`AdminJump`, and anchor `scroll-mt-*` values (the draft pool's
  `scroll-mt-32` is header plus clock bar). A resize once clipped the clock bar.
  It was 80px until the 2026-09 overhaul, which gave the height back to
  content on every page.
  Section bars pin only from `lg` up: on a phone, header plus tab bar plus
  chips took a quarter of the screen.
- **The draft room puts the player pool FIRST in the DOM** for captains on a
  phone; `lg:order-*` restores desktop. Keep the `#player-pool` anchor and
  `NominateBar`'s link to it.

## Tap targets

- **Meet WCAG 2.5.8 (24px) by sizing the PRIMITIVES.** A bare text link is
  only its line-height (20px at `text-sm`). Use `TAP_SAFE` (`py-1 -my-1`: the
  padding grows the hit box, the negative margin gives the space back, nothing
  moves) and `textLink()`, `buttonClasses`' sibling for inline links, which
  also adds the focus ring. Never hand-roll `text-info hover:underline`.
  Put the arrow in `<LinkArrow />` on the same source line as the words.
- **`TAP_SAFE` is a pair that twMerge can split:** a caller's own `py-*` drops
  `py-1` but keeps `-my-1`, so the element reserves 8px less than it paints and
  wrapped rows overlap. A caller setting vertical padding also passes `my-0`
  and must clear 24px itself.
- **A Dota name can be one character.** `PlayerLink` carries `min-w-6`;
  callers that truncate pass `min-w-6`, never `min-w-0` (twMerge lets the
  caller's class replace the floor; `player-link-guards.test.ts`).
- **An ambiguous target is worse than a small one:** overlapping hit boxes
  send the tap wherever paint order decides. `TAP_SAFE` stays at 4px a side,
  and rows whose links carry it need at least 8px between them (the pool's
  meta line is `mt-2`, `gap-y-2`).
- **Don't chase 44px on dense links by shrinking gaps;** a uniform bump
  overlaps neighbours. 44px is free only for standalone controls:
  `buttonClasses` is mobile-first (`h-11 sm:h-10` md, `h-10 sm:h-8` sm) and the
  pool's filter row is `h-11 sm:h-9`.
- **`expectTapTargets` applies the spec's exceptions** (run on the dense
  pages in `e2e-mid/boards.spec.ts`): text inside a run of prose, and a target
  with no neighbour within 24px. It does NOT exempt a row's sole control, and
  has no length exemption: if an exemption is what makes a guard pass, the
  exemption is the bug. `expectNoOverlappingTargets` checks hit boxes never
  overlap.
- **A probe over rendered geometry needs three visibility checks** or it
  reports ghosts: skip `details:not([open])` (a closed `<details>` lays its
  contents out with real boxes but never paints or hit-tests them); skip
  elements failing `checkVisibility({contentVisibilityAuto, opacityProperty,
  visibilityProperty})`; and intersect the rect with every clipping ancestor,
  because `getBoundingClientRect()` ignores clipping (a row scrolled out of a
  `max-h-* overflow-y-auto` list reports on-page coordinates).
- **One control, one name.** Two controls with one accessible name are a UI
  wart and a strict-mode e2e flake. `/players` shows one "Clear filters": the
  count line yields to the empty state's button.

## Accessibility conventions

- **Build clickables from `buttonClasses`/`Button` or `textLink()`** for the
  `focus-visible:ring-2` focus ring (`baseBtn`).
- **Give visual-only indicators an accessible name:** `FormStrip` and the
  schedule `RsvpBadge` are `role="img"` + `aria-label` with glyphs
  `aria-hidden`; `RankMedal` has `aria-label`; `TeamCrest` is `aria-hidden`
  with the name beside it as text; `EmojiLead` hides a leading emoji.
- **Toggle chips use `aria-pressed`; unlabeled selects need `aria-label`;
  countdowns are `role="timer"` with a spoken label.**
- **`SeasonTimeline` is `<ol aria-label="Season progress">`** with
  `aria-current="step"` and sr-only "(done)"/"(current)"; its ticks are
  `aria-hidden`.

## Home page (`/`)

- **`src/app/page.tsx` loads data and picks the phase; the views live in
  `src/components/home/`:** `hero.tsx` (shared hero), one view per phase with
  a hero-slot builder (`signups-view`, `draft-view`, `season-view` for regular
  season and playoffs, `complete-view`), `offseason-view` (its own hero),
  `this-week.tsx`, `my-next-match.tsx`, `admin-strip.tsx`. Source guards read
  them all via `homePageSource()` (`test/support/source-files.ts`), so moving
  code between files never escapes a guard. `Home()` fetches matches once;
  `SeasonView` computes the scenario report once for every consumer.
- **The hero is identity plus ONE control slot.** Builders return
  `{ action, meta, aside }`; `aside` wins the slot, and with no control the
  identity column takes the full width. **Anything passed as `aside` must
  render something** (a present-but-empty aside leaves a 23rem hole), which is
  why `MyNextMatch` has a no-match branch and `SignupsAside` always renders. In
  the regular season, meta takes the right column and the aside the row below.
- **The slot addresses the viewer.** Mid-season: `MyNextMatch` (their next
  check-in, `<CheckinBanner variant="panel">`), or for someone with no team and
  no signup, the late standin signup plus the inhouse queue. COMPLETE: only
  "Relive the season"; the champion card below is the page's one champion
  block.
- **`SeasonViewSkeleton` mirrors the season bands;** change both together or
  the page rearranges after streaming.
- **Show a fixture once per job.** `focusSlate` (`schedule.ts`) is This week's
  slate; "Coming up" is the open matches minus that slate, so no match is in
  both.
- **This week** shows kickoffs, standin-aware check-in counts (shared
  `matchNightRoster`, as on `/schedule`) and a compact `PlayoffOutlook` for a
  side whose `nextMatchId` is that fixture.
- **The Your team card** shows only the stakes of the next series (the table
  already highlights rank and record), aligned to the engine's `nextMatchId`
  and naming the opponent. It sits in the auto-fit band under the standings
  and stands down when This week already prints that series.
  `dashboard-guards.test.ts` pins both.
- **`WeeklyHonorsLine`** renders only official honors (the readiness rows
  Discord and `/leaders` use; `honorBestGame` picks the game), else nothing;
  the in-progress caveats live on `/leaders`.
- **`AdminStrip` (admins only) repeats `/admin`'s next step word for word**
  plus the Needs attention count (`adminHomeLine`). Feed `adminNextStep` and
  `matchAttention` the same inputs as `/admin` or they drift. Database reads
  only, never Discord.
- **PLAYOFFS shows a compact bracket; COMPLETE a champion card and "How it was
  won".** Round grouping is pure `slotRound`/`groupPlayoffRounds`
  (`schedule.ts`), shared with `/schedule`.

### The SIGNUPS view

Signups never close on a count (`minTeams` is a floor), so most of signup week
the league is already draftable and many visitors have joined. Write for both.

- **A date the page prints must say when it has passed.** `countdownLabel` is
  null 3h after its target and the phase never advances itself, so a slipped
  draft night reads as a plan until an admin acts. Every draft-night
  `<Countdown>` carries `passedLabel={DRAFT_PASSED_LABEL}` (amber chip).
  `hasPassed` (`countdown.ts`) is the same boundary, swept by
  `countdown.test.ts`; `dashboard-guards.test.ts` scans every `.tsx` in `src`
  for a draft-night countdown missing `passedLabel`.
- **Decide "has passed" on the client** (as `<Countdown>` does): a parked tab
  crosses the boundary with no re-render.
- **A signed-up player gets `SignupsAside`, not the join buttons:** the
  draft-night confirmation they owe, else "You're in" with `<InviteLink>`,
  which copies `window.location.origin` at click time (never a server prop) so
  previews and custom domains copy themselves. The hero's counts carry the ask
  (`needed`, then `toNextTeam`). On draft night the slot gives way to "Enter
  the draft room".
- **`phaseSubtitle` (`season-copy.ts`) takes `canDraft`,** so a full league is
  never told "the draft begins once enough players have joined".
- **One Discord CTA in `<main>` at a time.** `DiscordSetupPrompt` sequences
  the invite ("1. Join the server"), so the view's own Discord row renders
  only for viewers it cannot cover.
- **"Who's in" lists captains first and names its cap** ("Latest 12 of 30
  players") instead of silently hiding the rest.

## The player pool (`/players`)

- **One grid string for header and rows:** `rowGrid(withInhouse)` in
  `player-pool.tsx`. Two copies drift and the header lies about its columns;
  never fork a literal. Scouting columns: `docs/features/players-and-registration.md`.
- **Below `md` there are no columns:** the avatar keeps the gutter and every
  other cell stacks in the second track (`CELL`), because `shrink-0` chips in a
  `justify-between` row cut names to "P…" at 390px.
- **The status chip spans both phone tracks** (an `auto` track sized by a long
  team chip starves the name). **Favorite heroes ride with the roles below
  `md`, hide between `md` and `xl`, and get their own track at `xl`**, where
  `xl:order-*` puts them before status.
- **The pool is the whole page:** standins are rows with a Standin badge
  (`?status=standin`); rosters live on `/teams`. "Wants captain" shows only
  while `captainSelectionOpen`, on volunteers not yet picked.
- **Filters live in the URL** (`q`, `pos`, `sort`, `cap=1`,
  `status=drafted|free|standin`, defaults omitted). They seed from
  `useSearchParams` on mount (hence the `<Suspense>` around `<PlayerPool>`); a
  stale `cap=1`/`status=standin` with nothing to match shows everyone. They
  mirror back with `history.replaceState`, never `router.replace` (that re-runs
  the page's server queries per tap), debounced 250ms (browsers rate-limit
  `replaceState`). React is the source of truth. `sort` is not a filter, so
  `resetFilters` and `filtersActive` ignore it. `e2e/pages.spec.ts` reopens the
  URL cold, because seeding from it is the half that rots.

## The inhouse page (`/inhouse`)

- **Order is the product:** room, `SceneStats`, ladder, recent results, then
  the OpenDota guide. The ladder is why people return; the history sections are
  the costliest queries, so they stream in below the room.
- **`SceneStats` uses the same memoised `loadBoardStats` as the Discord
  board,** so channel and site agree on counts, last result and MVP. Use
  `inhouseEndedAt`/`inhousePlayedAt` (`src/lib/inhouse-history.ts`) for game
  times, never the lobby's `updatedAt`.
- **Recent results are `<details>` summarised by the scoreline** (newest
  open), with the anchor id on the `<details>` so `#result-<id>` jumps land.
- **The OpenDota guide opens only for viewers with public match data off**
  (`User.fhUnavailable`); closed for everyone would hide it from its audience.

## The admin page layout (`/admin`)

- **Anchors plus disclosure.** `AdminJump` (a `SectionNav`, sticky from `lg`)
  jumps to `AdminAnchor` ids. Rarely touched cards (Discord, league id, news,
  security, historical records, database performance, season handoff and
  similar) are `AdminSection`: a `<details>` whose `<summary>` keeps the title
  as a visible heading.
- **The jump bar wraps from `lg`** (`SectionNav wrap`: a desktop mouse can't
  scroll sideways; chips drop to `lg:min-h-9`) and hugs its chips from `sm`
  (`sm:w-fit`). The wrapped sticky bar is up to ~135px tall, so every jump
  target carries `scroll-mt-40 lg:scroll-mt-56`. A new anchor needs both.
- **Chips follow the page's render order,** so the active chip only moves
  forward on scroll. `setupFirst` (SIGNUPS or DRAFT) puts the Phase, Captains &
  draft and Discord reach chips AND cards first; later phases put them after
  the working cards. Chips and cards branch on the same flag, and
  `admin-copy-guard.test.ts` ("the jump bar lists sections in the order the
  page renders them") fails if the two orders drift.
- **Never put a `<button>` in a `<summary>`:** it toggles instead of
  submitting.
- **The jump bar and cards share one visibility predicate**
  (`rosterMovesVisible` and friends), so no chip points at a missing card.

## The match page (`/matches/[id]`)

- **A loader plus one file per card** in `src/app/matches/[id]/`. `load.ts`
  loads the match (teams, games, bookings, season) once; `page.tsx` passes it
  and the viewer to each card; draft status, rosters and OUT check-ins are
  React `cache()` reads. No card re-reads match, season, draft or viewer.
  `match-page-guards.test.ts` pins this and reads the whole folder with
  `folderSourceFiles` (a glob cannot spell `[id]`).
- **Shared components on the page follow the same rule.** `AdminMatchTools`
  takes the season from the page's match and the draft status from the
  request-cached `getSeasonDraftStatus` (also guarded); only its /admin-shaped
  reads (rosters, standin pool, bookings, named OUTs, open reschedule) are its
  own. `GameIdentityEditor` gets the viewer from the `cache()`d
  `getSessionUser`.
- **`MatchPreview` renders while a match has no games and is not COMPLETED:**
  rosters, recent form, prior meetings, stakes banner, scouting report, and the
  `/schedule` check-in banner. A COMPLETED match with no games says it was a
  forfeit ruling or a manual score.
- **The season lobby bot's panel has two render sites, never both for one
  viewer** (off unless `DOTA_SEASON_LOBBY_BOT_ENABLED`): captains get it with
  Create/Start in Captain tools; other players, booked standins and admins get
  `lobby-panel.tsx` (`seesPlayerLobbyPanel`, `lobby-access.ts`, matching who
  `resolveDotaLobby` lets view it).
- **Both captains always get a "How to host" line built from data**
  (`src/lib/match-hosting.ts`, tested): the home captain hosts,
  `LEAGUE_CONFIG.gameServerRegion`, `LEAGUE_GAME_MODE` (the mode the lobby bot
  also sets) and the match's own `bestOf` (`seriesLobbyRule`). A ticketed
  season makes it the first line of the lobby checklist; a ticketless one
  adds `NO_TICKET_RESULT_NOTE`, pointing at Report your result, whose subtitle
  says to send an admin the score if nothing finds the game (never "no admin
  needed", never "public match history is enough"). Each step is said once.
- **`DotaLobbyControls` takes an `audience`.** "host" (default: inhouse
  players and season captains) always renders, so the people who make the
  lobby hear that the bot is missing or failing. "player" (`lobby-panel.tsx`)
  renders only once the bot answers with a lobby (`lobbyPanelVisible`): those
  viewers can't fix the bot or the ticket, and the manual steps are not on
  their page.

## Checking UI against a fixture

- **One command per league state,** each with its own port, database and
  build folder, all runnable beside `npm run dev`:
  `npm run fixture:signups` (:3111), `fixture:regular` (last week open,
  :3116), `fixture:playoffs` (TBD final, :3117), `fixture:complete` (:3118).
  `scripts/fixture-server.ts` pushes the schema into
  `prisma/<state>-fixture.db`, reseeds, and serves with
  `NEXT_DIST_DIR=.next-fixture-<state>` and dev login (`/api/auth/dev`,
  `?admin=1`). Flags: `-- --no-seed`, `-- --dry-run`. Knobs pass through
  (`PLAYERS`/`CAPTAINS`; `FIXTURE_TEAMS=5` shows byes). `.claude/launch.json`
  has matching `<state>-fixture` entries.
- **Parallel servers work** because Next 16 locks inside the build folder and
  `next.config.ts` reads `distDir` from `NEXT_DIST_DIR` (`.next` or
  `.next-<name>` only; unset in deploys). `.next-*` is git- and ESLint-ignored;
  `tsconfig.json` lists each fixture folder's two `types` globs. For a new
  folder, add them on purpose (Next appends them on start) or keep that change
  out of your commit. `next-env.d.ts` (gitignored) follows whichever server
  started last; that is harmless. One-off server:
  `NEXT_DIST_DIR=.next-<name> DATABASE_URL=file:$PWD/prisma/<name>.db npx next dev -p <port>`.
- **Seeders refuse other databases:** `seed-fixture.ts` accepts only the files
  in `src/lib/fixture-database.ts`; `seed-signups-fixture.ts` needs "fixture"
  in `DATABASE_URL`. The Prisma client's baked `.env` can point at `dev.db`, so
  always set the URL. Never reseed `dev.db`; it may be another session's.
- **Fixture data covers the edges:** modern box scores except two legacy-shaped
  games (to show degradation), league-night `scheduledAt` on every match (so
  `/api/calendar` has events), and games on completed playoff matches.
