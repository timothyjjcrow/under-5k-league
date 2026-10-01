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

## Link previews (Discord, X, Slack)

- **Preview text comes from `link-preview.ts`** (pure, tested), loaded by
  `link-preview-metadata.ts`; a result reads the same everywhere through
  `seriesResultText`.
- **The match, team, player and season pages draw their own picture:** an
  `opengraph-image.tsx` and a `twitter-image.tsx` beside each page, one line
  each over `src/components/og-share-images.tsx`. The layouts are
  `src/components/og-card.tsx` (Satori: an element with more than one child
  needs `display: flex`, colours are plain hex); the facts come from
  `link-preview-images.ts` over the rules the pages use (standings, seeds,
  `playoffStatusChip`, `resolveChampionPresentation`, the season's crest hues).
  A kickoff is on the league's clock with its zone named: a picture can't
  adapt to the viewer.
- **A player's picture is their profile's season card** (`OgPlayerCard`, from
  `playerCardFacts` through `playerPictureText`; rules in
  `players-and-registration.md`): the season line as its kicker, avatar, name,
  that season's team, then chips: one title and "+N more titles", the medal
  drawn from `public/ranks` (`loadRankMedal`), the grade, heroes and honors.
  No MMR: a picture travels without its date. `fitPictureFacts` drops chips
  from the end (honors, then pub heroes, league heroes, the grade) until they
  fit the frame beside a long name. The link's text keeps its own highlights
  (`loadPlayerPreviewFacts`).
- **Write no emoji or "×" in a picture:** next/og downloads any glyph its
  bundled fonts lack while it draws (Twemoji for an emoji).
  `share-image-guards.test.ts` checks the picture files and the card rules
  they borrow words from.
- **Leave the images out of those pages' metadata**
  (`shareMetadata(..., { pageImage: true })`): Next uses a folder's image files
  only where the page's metadata names no images at all, so the failure is
  silent. Every other page, and an account that only signed in, keeps the
  league's picture. `e2e-mid/boards.spec.ts` checks the rendered tags.
- **Draw per request and cache five minutes** (`force-dynamic`,
  `OG_CACHE_CONTROL`): a match's picture follows it from the kickoff to the
  live score to the result. `share-image-guards.test.ts` pins every route.
- **The server fetches a crest or avatar only through `fetchOgImage`:** HTTPS
  on Imgur or Steam's avatar hosts (`ogImageUrlAllowed`), no redirects, a
  2.5-second timeout, a 1.5 MB cap and PNG or JPEG bytes. Anything else draws
  the team's initials on its hue. A picture that fails to draw redirects to
  the league's own image; a missing page's picture is a 404.
- **The font is Oswald** (SIL Open Font License, `src/lib/og-fonts/`), read
  at request time; without it next/og falls back to its built-in font, so
  `share-image-guards.test.ts` checks the paths `og-assets.ts` reads exist
  (the fonts, the league emblems and the medal files). Spell each path as a
  literal `join(process.cwd(), ...)`: that is what the build's file tracing
  bundles and what the guard reads.
  Keep files like these under `src/`: the release classifier
  (`scripts/classify-release.mjs`) treats a new top-level folder, or a
  `public/` file that isn't an image, video or web font, as an unknown path,
  which turns a routine release into a maintenance one.
- **Match, team and player pages carry a Share control** on the back link's
  row, so it costs no height (`share-button.tsx` over `share-link.ts`). A
  phone opens its share sheet; a mouse copies the link, since a desktop sheet
  rarely offers Discord. It shares the page's own address on the viewer's
  host, with no query or hash, and closing the sheet is not an error. Only a
  copy the clipboard accepted says "Link copied".

## The shared UI kit

- **Change the kit additively.** `Card`, `CardHeader`, `Stat`, `EmptyState`,
  `PageTitle` and `SectionTitle` have many call sites, so a new capability is an
  optional prop whose default renders exactly what shipped. Current options:
  `Card tone` (`feature` is the ONE card a viewer should act on; if two are
  `feature`, neither is; `quiet` recedes); `Stat size="md"` (text-xl, for a
  narrow column where text-3xl wraps a W-L-D record; never an inline
  override); `EmptyState compact` (a routinely empty section that is not the
  point of the page; two full dashed boxes make a full page look broken);
  `EmptyState inline` (one left-aligned line, about 56px, for an empty list
  inside a card whose header already names it; wins over `compact`);
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

## Team colours

- **A team's colour is its crest hue, never a stored colour.**
  `seasonTeamHues` spaces each season's teams round the wheel, and the root
  layout publishes each team's `--team-hue` and crest ink `--team-ink`
  (`teamHueStyleSheet`, a 60-second snapshot). A team the stylesheet doesn't
  know yet falls back to its hash hue (`teamHueVar`, `teamInkVar`).
- **Every element painted with a hue carries its own `data-team-hue`,** naming
  the team its style reads. Custom properties reach an element only through
  that attribute or inheritance, so without it an element shows the fallback,
  or another team's hue inherited from an ancestor. `team-crest.test.ts`
  parses every file under `src/` and fails on a hue read outside an element's
  props, or on an element whose `data-team-hue` names another team. Build a new
  paint with `src/lib/team-tint.ts`: its helpers return the attribute with the
  style.
- **A wash (`teamTint`) is an empty `pointer-events-none absolute` layer**
  inside a `relative overflow-hidden` host: the team page header, each half of
  the scoreboard (fading out before the score) and the player season card. It
  is a layer of its own so the host keeps its gradient, and empty so its hue
  can't reach a nested crest of another team. `TEAM_TINT_ALPHA` (the crest's
  middle colour at 7%) keeps text, muted text, links and every Badge tone at
  4.5:1 on every hue over the page, a card surface and the hero banners'
  lightest corner (`team-tint.test.ts`). On `surface-2` the success and danger
  Badges have no headroom left, so the same test reads each wash's host and
  refuses any other background.
- **A stripe (`teamStripe`) marks a box that belongs to one team:** the
  Matchup and Scouting side boxes, and a box-score side when the game recorded
  which team played it (`radiantTeamId`/`direTeamId`; an unknown side stays
  plain Radiant or Dire, and keeps its win tint and the net-worth bar). It is
  decorative: the team's name in the box says whose it is. It is an inset
  shadow, so it sits inside the border and moves nothing.
- **A generated crest's initials wear `crestInk(hue)`:** white, or the page's
  near-black on the yellows through the cyans, where white fell to about 2:1.
  The worst hue is now 3.8:1. The link pictures' `OgCrest` uses the same rule.
- **Not built:** nudging two near-identical neighbouring hues apart, a
  captain-chosen colour, and a colour taken from the logo (each needs new
  data or an image decoder).

## Grids and bands

- **A fixed two-column split sizes its row to the TALLER column,** leaving a
  hole under the shorter one that looks fine in review. Use one of:
- **Known card count: an explicit grid, and never a short card beside a tall
  one.** Where a short card must sit by a taller one (the COMPLETE view), use
  `items-start` so it does not stretch.
- **A page column plus a rail** (Home from `xl`:
  `xl:grid-cols-[minmax(0,1fr)_21rem]`) is two STACKS, not two cards: each
  column is a `space-y-*` list, the grid is `items-start`, and a block that
  must follow the first column on desktop but the rail on a phone uses
  `xl:grid-rows-[auto_1fr]` with the rail `xl:row-span-2`, so a tall rail's
  extra height lands under the last block instead of between two.
- **Let a list card size its own columns with a container query** (`@container`
  on the card, `@xl:grid-cols-2` on the list) when the same card sits in a
  21rem rail and a full-width band: one column in the rail, two when wide.
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
  still gives a `hidden @xl:table-cell` column a share of leftover width, so
  hidden columns get `w-0 @xl:w-*` cols.
- **The standings table breaks on its OWN width** (an `@container` wrapper),
  not the viewport's: the same table fills a phone, Home's main column and
  `/schedule`'s 30rem rail. From `@md` (28rem) the movement arrow sits beside
  the rank, from `@lg` (32rem) the desktop column widths and one-line rows,
  and Last 5 from `@xl` (36rem), so it hides in the rail as on a phone. A
  row's status chips wrap beside the name (flex-wrap, so they drop under it
  only when both don't fit).
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
  the regular season the aside takes the right half and the progress (meta)
  rides under the title; with no aside, meta takes the right half.
- **The slot addresses the viewer.** Mid-season: `MyNextMatch` (their next
  check-in, `<CheckinBanner variant="panel">`), or for someone with no team and
  no signup, the late standin signup plus the inhouse queue. COMPLETE: only
  "Relive the season"; the champion card below is the page's one champion
  block.
- **The regular season is two columns from `xl`:** This week and the
  standings, then the honors line and the news under them; the rail holds the
  Your team / Coming up / Recent results band and the side games. The
  playoffs stay one column, because the two-sided bracket needs the full
  width. Below `xl` everything is one column in that order, rail before the
  honors and news.
- **`SeasonViewSkeleton` mirrors the season bands** (`playoffs` picks the
  one-column shape); change both together or the page rearranges after
  streaming.
- **The inhouse queue is a side-game tile mid-season** (`InhouseStrip
  variant="tile"`, the live line), and ends the COMPLETE view's rail; the
  other phases keep the full-width strip after the view.
- **Show a fixture once per job.** `focusSlate` (`schedule.ts`) is This week's
  slate; "Coming up" is the open matches minus that slate, so no match is in
  both.
- **This week** shows kickoffs, standin-aware check-in counts (shared
  `matchNightRoster`, as on `/schedule`) and a compact `PlayoffOutlook` for a
  side whose `nextMatchId` is that fixture.
- **This week faces a lone fixture's sides off** (home left, away right,
  "vs" or the live score between) instead of stretching one card built for a
  third of the width across all of it.
- **A lone series on This week gets the big kickoff clock**
  (`<KickoffCountdown>`) in place of the header chip; when it is the grand
  final the card is titled "The grand final" and the clock wears gold.
- **The Your team card** shows only the stakes of the next series (the table
  already highlights rank and record), aligned to the engine's `nextMatchId`
  and naming the opponent. It sits in the auto-fit band (the rail from `xl`)
  and stands down when This week already prints that series.
  `dashboard-guards.test.ts` pins both.
- **`WeeklyHonorsLine`** renders only official honors (the readiness rows
  Discord and `/leaders` use; `honorBestGame` picks the game), else nothing;
  the in-progress caveats live on `/leaders`.
- **`AdminStrip` (admins only) repeats `/admin`'s next step word for word**
  plus the Needs attention count (`adminHomeLine`). Feed `adminNextStep` and
  `matchAttention` the same inputs as `/admin` or they drift. Database reads
  only, never Discord.
- **PLAYOFFS shows a compact bracket; COMPLETE a champion banner (crest beside
  the story) and "How it was won".** `<Bracket>` centres itself when its card
  is wider than it. Round grouping is pure `slotRound`/`groupPlayoffRounds`
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

## Schedule (`/schedule`)

- **The regular season is two columns from `xl`:** the weeks, and a 30rem
  rail with the standings and the analysis folds. The rail stretches to the
  weeks' height and its inner block is `xl:sticky xl:top-20` with a
  viewport-high `max-h` and its own scroll, so the table stays in view down
  the weeks and an opened fold never hides its end below the screen. The
  playoffs and COMPLETE keep one column (the bracket leads, the finished
  weeks fold away).
- **A week's cards go two and three across by the week's own width**
  (`@container`, `@2xl`/`@5xl`), and `GridFillers` paints the empty cells of a
  part-filled last row the surface colour; the grid draws its hairlines as
  the gap colour, so an empty cell showed as a grey block.
- **The section title and the team filter share a row** (`ScheduleWeeks
  heading`); each card names its status in words, so there is no dot legend.
- **The team filter holds a pick until the URL catches up.** The URL is the
  source of truth, but the router applies `pushState` in a transition and a
  controlled `<select>` snapped back to its old value meanwhile (the pick
  flickered to "All teams"; `e2e-mid/quality-of-life.spec.ts` reads it back
  at once).
- **The jump bar** (`SectionNav`, in page order) lists what the phase renders
  when there are three or more sections; the regular season hides it from
  `xl`, where the rail shows the standings.
- **The jump bar leaves the hash to the page** (`followHash={false}`,
  `openNested="marked"`): the browser scrolls to `#fixtures` or
  `#tiebreakers` and `ScheduleFold` opens itself, as before the bar existed.
  A bar that also followed the hash re-scrolled the page after load and
  fonts, and a re-scroll between the press and release of a click swallowed
  it (the tiebreaker folds stayed shut in `e2e-postseason/tiebreaker.spec.ts`).
  A chip opens only its own section, never a card's inner disclosures.
  `schedule-jump-bar.test.ts` pins both props.
- **A side's playoff stakes flow as one wrapping line of outcome pairs**
  (Win, Draw, Loss, each with its result), not a row per outcome.

## Teams (`/teams`, `/teams/[id]`)

- **The index is three across from `xl`** (two from `md`), each card a
  compact header (56px crest, name, one summary line) over the roster chips.
- **A team page is two columns from `lg` when it has a rail:** the main
  column is the next series, the roster and every fixture; the rail (22rem,
  24rem from `xl`) holds the hero pool, rematches and the playoff outlook.
  A phone reads them in that order, so the overview, roster and matches
  still lead. With nothing for the rail the page stays one column. The
  jersey keeps the full width below.
- **Both columns are `@container`s:** the roster goes two across and the
  draft-phase overview splits at `@2xl` of the main column, and the hero
  pool (`HeroPool columns="container"`) steps two, three, four across with
  the rail's width, so it is two in the rail and wider on a tablet.
- **A roster row keeps its chips on the name's line** (flex-wrap), so most
  rows are one 44px line instead of a name over an empty badge row.

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
- **"Scouting details" sets row density, not a filter:** on, each row carries
  the scouting line (last season, pubs, Dotabuff, Discord) and the player's
  own words; off, a row is one line. The default is `poolDetailsByDefault`
  (on until the auction ends, when the pool turns into "who is where"), and
  the viewer's choice persists on their device (`usePersistedFlag
  "playerPoolDetails"`). It stays out of the URL and "Clear filters".

## Player profile and compare (`/players/[id]`, `/players/compare`)

- **The season card sits in the header's right slot from `lg`** (20rem beside
  the name) and takes its own line below it. The line break is a `basis-full`
  wrapper: the name column is `min-w-0`, so the row never overflows and
  `flex-wrap` never fires on its own; the name would shrink to a letter a
  line. The card's `max-w-md` sits inside the wrapper, because a max-width on
  the flex item clamps the full basis the row wraps on.
- **"Edit your signup" shows on a player's own profile** while they are in
  the current season, or have no season yet; never under a past season's
  card.
- **Title badges wrap inside themselves** (`max-w-full
  [overflow-wrap:anywhere]`), so a long season name never widens the name
  row.
- **A profile is two columns from `xl`:** form, match history and "How they
  play" in the main column, and a 24rem rail with the hero pool, records,
  achievements and seasons. A phone reads them in that order. Both columns
  are `@container`s: the overview's stats and spotlight split at `@2xl`, a
  series row puts its games beside the opponent at `@2xl`, and the hero pool
  (`columns="container"`) and achievements step with the rail's width.
- **Compare is two columns from `lg`:** career numbers on the left, the
  head-to-head and both hero cards on the right, by grid placement, so the
  DOM and a phone keep head-to-head, numbers, heroes. The rows are
  `auto_1fr`, so a taller numbers card grows the heroes' row, never the
  head-to-head's. Player B's name heads the right-hand column of figures.

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
- **Density:** cards sit 20px apart, and a folded `AdminSection` summary is
  set like `CardHeader` (`px-4 py-3`, same title and subtitle sizes), so a
  folded section and an open card share one left edge. The phase card's
  counts and the phase stepper share one `StatStrip` band.
- **A row's disclosures share a line, and the opened one takes the width**
  (`flex flex-wrap` plus `[&>details[open]]:basis-full`): a captain's Edit
  team and Hand over captaincy, and a signup's chips beside Edit medal & MMR.
  Stacked, each summary cost the row a line.
- **Result rows put each label on its field's line** (Kickoff time; Dota
  match ID or URL from `sm`), and a phone keeps the match id field beside
  Add game. `MatchResultRow` and `MatchImportControls` are shared with the
  match page, which gets the same rows.

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
  rosters, recent form, prior meetings, stakes banner, tale of the tape,
  scouting report, and the `/schedule` check-in banner. A COMPLETED match with
  no games says it was a forfeit ruling or a manual score.
- **The tale of the tape** (`tale-of-the-tape.tsx` over the pure
  `src/lib/tale-of-the-tape.ts`) compares the two teams' season: the regular
  season's record with the table place (a playoff seed from
  `seedsFromFirstRound` in the knockouts), games won across every completed
  series, roster MMR, and kills, KDA, GPM and game length from the box scores
  of each team's own side (`radiantTeamId`/`direTeamId`, complete box scores
  only). A row shows only when both sides have its number, and the card only
  with two rows or a road, so week one goes straight to the rosters. Bars
  grow outwards from the label column in each team's hue; the leader's is
  solid. A knockout series adds each side's road (`playoffRoad`): the series
  it won in the rounds before this one, each linking to its match. It never
  shows the community pick'em split (`pickemControlFor`'s rule).
- **The season lobby bot's panel has two render sites, never both for one
  viewer** (off unless `DOTA_SEASON_LOBBY_BOT_ENABLED`): captains get it with
  Create/Start in Captain tools; other players, booked standins and admins get
  `lobby-panel.tsx` (`seesPlayerLobbyPanel`, `lobby-access.ts`, matching who
  `resolveDotaLobby` lets view it).
- **The scoreboard is one row from `lg`:** name, crest, score, crest, name
  (`TeamSide side`, the crest beside the score). Below `lg` each crest sits
  over its name, as long names need the width.
- **Before kickoff everyone gets the ticking clock** under the scoreboard
  (`<KickoffCountdown>` over `kickoffClock` in `countdown.ts`), not only the
  two teams' players: an unplayed fixture of the active season, gone once
  there is a score, a live game or "Awaiting result". The server renders
  empty boxes and the browser fills them (`getServerSnapshot` is null), so
  hydration never mismatches; its spoken name gives minutes, never seconds.
  `kickoff-countdown.test.ts` pins both render sites.
- **A box score line is `BoxScoreLine`** (`box-score-line.tsx`, the page's
  one client piece of a box score): the server renders every part and the
  line lays them out. Each side is an `@container`; from `@lg` a player is
  one line (hero, name, gpm, lh, net worth, KDA at a fixed width so the bars
  line up). The report chip sits on the hero line and is a button whose
  metrics open as a row under the whole line; a `<details>` kept chip and
  metrics in one box, so the chip needed a line of its own.
- **The recorded net-worth bar sits between the two totals from `sm`** (grid
  placement, so the reading order stays Radiant, bar, Dire); a phone stacks
  the totals over a full-width bar.
- **The preview's Matchup and Scouting report stay full width, one above the
  other.** Each is split home | away inside, and their heights follow the
  data (check-ins, comfort picks), so side by side from `xl` left a hole
  under whichever was shorter. A team header lets its form strip wrap under
  a long name.
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

## Stats pages (`/leaders`, `/meta`, `/records`, `/hall-of-fame`, `/seasons/[id]`)

- **The stats tab bar is one row at every width** (`stats-nav.tsx`): the tabs
  share it as equal tracks (`grid-flow-col auto-cols-fr`) and a long label
  takes two short lines on a phone. A 2x2 grid spent a second 44px row on the
  same four links.
- **A leader row is one grid** (`leader-board.tsx`): rank, avatar, the name
  over "team · hint", the value on the right and the bar under the name (about
  64px; it was 118). "Team · hint" is split into one part per "·" segment;
  each part carries its dot in its own left padding and the line is pulled
  left by that width and clipped, so a line never ends in "·" and a part too
  long for one line wraps without losing its first letters under the clip.
- **Boards side by side line up.** A `LeaderBoard` card is a two-row subgrid
  (`row-span-2 grid-rows-subgrid gap-0`): boards in one grid row share a
  header height, and "Show all" sits at the foot (`mt-auto`). Outside a grid
  it is an ordinary two-row grid (Fantasy).
- **`/leaders` boards go two across from `lg` and three from `xl`.**
  `BOARD_GRID` has six tracks from `xl` and a board takes two; a last row of
  one or two boards stretches to fill it, so the data-dependent count (Team
  sustain) never leaves an empty cell. `leaders-guards.test.ts` pins it.
- **The season recap packs its long lists.** Award cards fill their rows
  (`flex-wrap`, each `flex-[1_1_16rem]`): however many awards a season
  produced, the last row has no empty cell. Rosters go four across from `xl`,
  one player per 36px line (a 24px avatar, so each name's 28px tap box keeps
  8px from the next), and the header names the captain only when they are not
  in the list. The head-to-head grid's chips are one line ("W 2–0").
- **Hero meta draws the shape of the meta:** from `sm`, picks (against the
  most-picked hero) and win % each get a thin bar beside the figure, with the
  figure at a fixed width so the bars share a column. Decorative
  (`aria-hidden`): the figure beside it is the value.
- **Hall of Fame boards use the Leaders shape:** the card header, then one
  ruled line per place. Its section links are the site's `SectionNav`, and a
  lone last champion card takes the whole row.

## Side games and account (`/scrims`, `/fantasy`, `/me`)

- **`/me` is two columns from `lg`:** the season (signup, away dates) on the
  left and a 24rem rail with the accounts it relies on (Discord, Steam and
  Dota). Phones keep the same order. Copy says "the Discord card", never
  "below", because it is below on a phone and beside on a desktop. Short
  inputs keep a short width (MMR `sm:max-w-sm`; the Discord handle grows
  beside Save up to `max-w-xs`).
- **Scrims pairs its lists.** Open and booked sit side by side from `lg`;
  history, team records and leaders go three across from `xl` as two-row
  subgrids, so the three lists start on one line whatever their subtitles
  wrap to. Empty lists are `EmptyState inline`.
- **A label around `LocalDatetimeField` is a flex column (`gap`), never
  `space-y`:** the field's hidden twin is the last child, so `space-y` put a
  margin under the visible box and lifted it off the row's baseline.
- **The fantasy scoring guide is one divided box** (rows on phones, three
  columns from `md`), not three padded cards.

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
