# Pages, layout and the UI kit

How GGD2L's public pages are built: navigation, the home page per phase, the
player pool, the inhouse, admin and match page layouts, and the layout,
mobile, tap-target and accessibility rules every page follows. Main files:
`src/components/ui.tsx` (the kit), `src/lib/site-nav.ts`, `src/app/page.tsx`
plus `src/components/home/*`, `e2e-mid/helpers.ts` (layout probes),
`scripts/fixture-server.ts`.

## Navigation and info pages

- **Rosters list the captain first** (`rosterOrder`, `team-roster.ts`) on
  /teams, team pages, the champion moment, the season archive and the match
  preview: by price alone the $0 captain was listed last.
- **Every name is a link:** `<PlayerLink userId>` (`ui.tsx`) for players, a
  plain `Link` to `/teams/[id]` for teams.
- **Links never prefetch: import `Link` from `@/components/app-link`, never
  `next/link`** (`app-link.test.ts` fails on a direct import). Next prefetches
  each link that scrolls into view, and the root `loading.tsx` makes every
  dynamic page prefetchable: each visible link was a server render of the
  root layout, with its database reads, repeated on every navigation. On
  2026-10-11, on Vercel, one page view sent 15 to 27 of them, 114 of the US
  site's 125 page requests in an hour were prefetches, and the bursts started
  the cold instances behind most of a quiet day's CPU. On the box each one is
  a server render on the one vCPU both leagues share. A click now waits for
  the server's first streamed chunk (the loading skeleton). Pass
  `prefetch={null}` (Next's default) only for a link where an instant
  skeleton is worth a server render per view.
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
- **A sitting captain gets "Captains" right after My Team**
  (`seasonNav(state, myTeamId, captaining)`), and on phones the tab bar's team
  tab opens it while My Team moves to the sheet. The layout reads
  `captaining` from the roster row it already loads (its team's `captainId`
  and `withdrawn`), through `captainsPageOpen`: no extra query. See
  [Captains](#captains-captains).
- **The account menu has My account (`/me`) and My profile
  (`/players/<id>`)**, the public page captains scout; it used to be reachable
  only from the bottom of /me's Steam card. The layout passes the header
  display fields only (`id`, `name`, `avatar`, `role`), never the whole
  session user.
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
  built-in default, so it agrees with /me, Schedule and the admin hint; while
  a match-night poll is deciding it (`pollDecidesMatchNight`), "Match night:
  being decided in a player poll" and a link to the poll on Home, as Home
  and /me say ([match-night-poll](match-night-poll.md)).
  `resultsCopy(hasLeagueTicket)` lets only a ticketed season say results
  arrive by themselves; the ticketless copy reuses `NO_TICKET_RESULT_LEAD`
  (`match-hosting.ts`), the match page's wording. Its one button
  (`howItWorksAction`) reuses the header's join label and Home's "Register as
  a standin" (`standinSignupOpen`), so the three pages name one action one way.
  Its Questions card links to `/rules`.

### The rules page (`/rules`)

- **The rulebook is built, not written.** `leagueRules`
  (`src/lib/league-rules.ts`, pure, tested beside it) builds every section
  from the code's constants, the season's settings and `LEAGUE_CONFIG`; the
  page (`src/app/rules/page.tsx`, `force-dynamic`) only loads the season and
  renders one card per section. A source guard in `league-rules.test.ts`
  fails on any digit in the page's shown text, any number literal but
  `headingLevel`, and any import outside its short list, so a rule number can
  reach the page only through the builder.
- **The reschedule rules describe the ready check** (up to
  `MAX_RESCHEDULE_OPTIONS` times, everyone answers, it moves itself, either
  captain can lock a time the other said yes to, answers become check-ins;
  an admin move clears check-ins). The page kept the old propose /
  accept-or-decline flow after #27 because no test pinned it; one does now.
- **Which season:** the active one, else the latest (worded as how the league
  played it, and that the next season starts with the same settings); with no
  season at all, `carriedSeasonSettings(null)` under a "First-season defaults"
  badge. The night comes from `announcedMatchNight`, so Europe without one
  says it is to be announced, and while a match-night poll is deciding it
  (`pollDecidesMatchNight`, the `matchNightPoll` input) the section says
  "Match night: being decided in a player poll", Home's words; the poll
  service is on the page's import list for that one read. The team count
  ("the top N make the playoffs") and the league-ticket sentences need an
  active season. Only the current tiebreaker format is described
  (`TIEBREAKER_SUMMARY`, `TIEBREAKER_RULES`).
- **Every sentence is derived or left out.** Points come from probing
  `computeStandings`, the season format and who makes the playoffs from
  the format the season plays (`rulesSeasonFormat` over `resolveSeasonFormat`;
  `formatSteps`, `playoffSteps`, `describeSeasonFormat`), the
  bracket size from `playoffBracketSize`, round one from
  `playoffFirstRound` (crossed between groups in a group season), the withdrawal forfeit score from
  `withdrawalForfeitScore` (which the withdraw action uses too), the import
  window from `league-result-window.ts`, the reschedule limits from
  `schedule.ts`, the standin clash window and MMR allowance from the standin
  constants and
  the draft clocks from `DEFAULTS`. Sentences that only hold while a function
  decides them (`teamWithdrawalLockedReason`, `matchResultsOpen`) drop out
  when it changes. The literal copy (the tiebreak order, the draw refusals,
  standin and draft wording) is pinned by the "claims hold in the code" tests
  in the same file: change the behaviour and they go red.
- **Copy rules hold here too:** the soft MMR limit never blocks, signups are
  uncapped (`minTeams` is a target), the league id stays on the match page,
  and the page ends with exactly `RULES_CLOSING`, "Admins rule on anything
  not written here."
- **Links:** the League group of `site-nav.ts` (never the footer, which is
  capped), `/how-it-works`, and both How to host lines (`report-result.tsx`,
  `league-lobby-checklist.tsx`) to `/rules#hosting`, each source-guarded.
  Sections are `<Card id>` with `scroll-mt-24` under the `h-16` header.
  `e2e/rules.spec.ts` checks the sections, the jump links and no overflow at
  320, 390 and 768px.
- **Admin-ruled rules are written policy, not code.** Tim approved them on
  2026-10-25, adapted from the RD2L rulebook with its penalty ladders
  dropped: Being on time (`#match-day`: lateness forfeits, the forfeit-claim
  screenshot, the gap between games), Pauses and remakes (`#pauses`),
  Accounts and fair play (`#fair-play`) and Conduct and commitment
  (`#conduct`). Their numbers are `WRITTEN_RULES` in `league-rules.ts`,
  pinned by a test; nothing on the site enforces them, and an admin records
  any forfeit they lead to. A double no-show is "an admin rules on the
  series".
- **Rules nothing encodes yet, so the page doesn't state them** (Tim's to
  write; until then the closing line covers them): double-forfeit scoring
  (a 0–0 ruling counts as a draw, so both teams get a draw's points); a cap
  on standins per match or season (Tim chose none on 2026-10-25); side and
  first-pick choice; hero or patch bans; smurfing, disputes and appeals; a
  roster lock
  (admin signings stay open through the playoffs); reschedule notice and how
  many reschedules a team gets; prizes, lobby passwords and spectators; and
  the away captain as backup host, which only the ticketed checklist says.

## Link previews (Discord, X, Slack)

- **Preview text comes from `link-preview.ts`** (pure, tested), loaded by
  `link-preview-metadata.ts`; a result reads the same everywhere through
  `seriesResultText`.
- **The match, team, player and season pages draw their own picture,** and
  /inhouse draws the planned inhouse night's (`OgInhouseNightCard`, the
  league's picture with no night; its preview text follows the night too, so
  the night's invite link unfurls as the night): an
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
- **The queue's invite link (`/inhouse?join=1`) unfurls with the queue's
  picture,** drawn in `src/app/inhouse/queue/` (no page there) by
  `OgInhouseQueueCard`: N/10 in the queue, the first ten players' avatars
  in their slots (initials without one), the names, "Game live" while one
  is, and "As of" the time it was drawn on the league's clock, since a chat
  keeps a preview long after the queue moves. /inhouse's metadata names it
  for `?join=1` (`shareMetadata`'s `image`), which is what makes Next skip
  /inhouse's own picture. Its address carries the counts
  (`inhouseQueuePicturePath`, `?v=4-1`), so a new count is a new address
  for Discord's image cache; the route ignores the query and draws what it
  reads, kept five minutes under `/inhouse/queue`.
- **Leave the images out of those pages' metadata**
  (`shareMetadata(..., { pageImage: true })`): Next uses a folder's image files
  only where the page's metadata names no images at all, so the failure is
  silent. Every other page, and an account that only signed in, keeps the
  league's picture. `e2e-mid/boards.spec.ts` checks the rendered tags.
- **Draw per request and cache five minutes** (`force-dynamic`,
  `OG_CACHE_CONTROL`): a match's picture follows it from the kickoff to the
  live score to the result. `share-image-guards.test.ts` pins every route.
- **On the box, each process keeps a drawn picture five minutes**
  (`OG_CACHE_TTL_MS`, `src/lib/picture-cache.ts`, used by
  `og-share-images.tsx`). A drawing costs about a second of the one vCPU
  both leagues and Postgres share (measured 0.8 to 1.9 s), and Cloudflare
  caches no dynamic route ([DECISIONS](../DECISIONS.md#hosting)), so a
  burst of unfurls or a crawler would draw the same picture again and again.
  The key is the page's address with no query, so a page's
  `opengraph-image` and `twitter-image` share one entry; concurrent misses
  share one draw; it holds at most 100 pictures and 16 MB, dropping the
  least recently served; only a drawn PNG is kept (never a 404, the league's
  fallback, or a failed read or draw); and a kept picture is sent with an
  `Age` header, so a browser counts the box's time against the same five
  minutes. It lives on `globalThis`, so every route's bundle shares it, and
  only in production: in development every request draws, so a layout edit
  shows at once. Per process on purpose, outside Rule P
  ([concurrency-and-testing](concurrency-and-testing.md#per-instance-caches-the-inhouse-room-snapshot)):
  a preview up to five minutes stale is what the CDN served on Vercel, and
  the two processes of a release's overlap each draw their own.
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

## Static files and icons

Next serves `public/` with `Cache-Control: public, max-age=0`, so without a
rule here every page view asks the box, through the tunnel, whether each
image has changed. The rules are in `next.config.ts`, and
`src/lib/next-config.test.ts` matches paths with Next's own route builder.

- **The league's artwork keeps a day, then serves stale for a week**
  (`DAILY_CACHE`: `public, max-age=86400, stale-while-revalidate=604800`):
  `/brand/*`, the full-size medals (`/ranks/<file>`), and the US's files at
  the root (`/icon.svg`, `/apple-icon.png`, `/opengraph-image.png`,
  `/twitter-image.png`). The header logo is on every page, and its
  revalidations were the most requested path after `/api/sync`. The names
  are not versioned, so never `immutable`: an edited file shows within
  about a day (Cloudflare's default caching of image files may keep it at
  the edge that long too). **To show a changed file at once, give it a new
  name** and update its references (`LEAGUE_CONFIG.branding`), so no release
  has to purge anything. The test checks every file `LEAGUE_CONFIG.branding`
  names in both leagues, and that no page or API route gets the header.
- **`/hero-loop.mp4` and the 72px medals (`/ranks/72/*`) keep a year,
  immutable** (`LONG_CACHE`): they never change, and a changed clip gets a
  new name. `/ranks/:file` matches one segment only, so it never overrides
  the 72px copies.
- **`/favicon.ico` and `/apple-touch-icon.png` (and `-precomposed`)
  redirect (307) to the league's own icons** (`leagueIconRedirects`): the
  tab icon the layout links first (`LEAGUE_CONFIG.branding.icons[0]`: the US
  `/icon.svg`, Europe's 32px PNG) and the home-screen icon
  (`branding.appleIcon`). Browsers, unfurlers and crawlers ask for these
  without reading the page's links, and with no file there each rendered
  the whole not-found page through the layout (about 50 KB and a season
  read). The region is read at build time the way `LEAGUE_CONFIG` reads it,
  and the test pins both leagues' targets to `LEAGUE_CONFIG`. Temporary, so
  a renamed icon never leaves a browser holding a dead redirect. Never add a
  `public/favicon.ico` (one `public/` serves both leagues) or an
  `app/favicon.ico`.

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
  band under a page title); `PageTitle compact` with `nav` (one short row:
  the title, a `SectionNav bare` from md and the action on the title's rule,
  no subtitle, no margin; /inhouse, whose first screen is the queue), plus
  `slim` (below sm a 20px title in a 32px row, for /inhouse's phone first
  screen; sm and up unchanged); `RoleBadges pillClassName` (a 16px pill in a
  phone's "Who's playing" row, 14px in its queue slot rows). One deliberate exception: `TeamCrest`'s initials
  wear `crestInk` by default, not behind a prop, because an opt-in would leave
  white initials at about 2:1 on every yellow crest that didn't pass it. A
  contrast fix belongs at every call site.
- **The display face (`font-display`) is self-hosted Oswald**
  (`src/app/fonts/oswald.ts`, the files beside it; the licence is the link
  pictures' `src/lib/og-fonts/OFL.txt`, since the release classifier reads a
  second copy as a copied file and demands a maintenance release). Never
  import `next/font/google`: it downloads while compiling, and Turbopack's dev
  server failed to start in CI whenever Google answered with query-string
  font URLs. The five files are what Google serves for weights 500 to 700,
  one family per subset with Google's unicode range, so a browser fetches
  latin-ext or Cyrillic only for a name that uses it. `--font-oswald`
  (`globals.css`) chains them with latin LAST: latin alone is preloaded and
  carries the resized-Arial fallback, which would catch any script listed
  after it. `src/app/fonts/oswald.test.ts` pins the chain and the files.
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
  half of `/schedule`'s full-width card. From `@md` (28rem) the movement
  arrow sits beside the rank, from `@lg` (32rem) the desktop column widths
  and one-line rows, and Last 5 from `@xl` (36rem), so it hides on a phone. A
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
  phone; grid placement (`lg:col-start-*`, `lg:row-start-*`) fixes desktop:
  the lot and the teams on the left, Recent sales above the sticky pool on
  the right, both from the top
  ([draft](draft.md#the-draft-room-client)).
  Keep the `#player-pool` anchor and `NominateBar`'s link to it. Each
  Available row is one control (the pick or the scouting toggle) plus its ↗
  profile link, and a row's scouting card opens inline under it, never in a
  modal.

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

## Translated pages

- **Keep the translation guard first in `<body>`**
  (`src/lib/translation-dom-guard.ts`, inlined by the root layout). Browser
  page translation (Chrome's "Translate this page", Edge, Yandex) swaps text
  nodes for its own `<font>` elements. React's next update that removes or
  moves one threw `NotFoundError` ("Failed to execute 'removeChild' on
  'Node'"), and `error.tsx` replaced the page with no reference, because the
  error happened in the browser. A player reading the US league in Russian
  hit it the moment their signup saved (2026-10-06); nothing logged it
  server-side, and an untranslated browser never saw it. The guard (the
  standard workaround for facebook/react#11538) leaves a moved node alone
  and appends instead of inserting before one, so translated text can lag a
  moment instead of crashing.
- **Never answer this with `translate="no"`:** both leagues have players
  who read the site translated. `e2e/translated-signup.spec.ts` translates
  /me the way Chrome does and signs up, and `translation-dom-guard.test.ts`
  pins the layout. An error page with no `ref:` line came from the browser,
  not the server: look for translation and extensions before the logs.

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
  check-in, `<CheckinBanner variant="panel">`) with "Where you stand" under
  it in the regular season, or for someone with no team and no signup, the
  late standin signup plus the inhouse queue. A rostered player's team's
  booked scrim adds one "Scrim" line to its lobby setup from 12 hours before
  to 4 hours after its start, in every branch of `MyNextMatch`
  ([scrims](stats-and-side-games.md#scrims)).
- **"Where you stand" is said once, in the hero** (`MyStanding`, built in
  `seasonHero`): the team's place and record in words (`tablePlace`,
  `standingSummary`: "5th in Group A · 1 win, 3 losses · 3 pts", "Tied 4th"
  for rows only the team id could split, "No series played yet" before its
  first), then the status line and the Win/Draw/Loss paths of its next
  series, naming the opponent. The stakes wait for the first final series
  (`playoffOutlookShown`). It is Home's only copy of the viewer's paths:
  This week's rows carry one stake line a side, and the regular season has
  no "Your team" card (it showed on a bye week only, and repeated the slate
  on every other). `dashboard-guards.test.ts` pins it.
- **The regular-season hero says the state of the league** under the week
  bars (`PlayoffRaceLine`): "Playoff race 4 teams in · 8 chasing 4 places ·
  2 out" (`playoffRace`, `playoffRaceParts`; a team is in or out only when
  nothing left can change it, `playoffVerdict`), then the places rule and
  the playoffs' first date. Until a team is in or out it prints only the
  rule ("Top 4 of each group make the playoffs", `playoffPlacesPhrase`).
  The progress block lists only Live, Time TBC and Overdue counts: "6
  Scheduled" was the fixture list's ordinary state. COMPLETE: "Relive
  the season" and, under it, where the next season is announced (the league
  Discord, or League news without an invite); the champion banner below is the
  page's one champion block, so the hero names no team.
- **COMPLETE's meta line says what's next:** "Next season: signups open
  {date}" with a countdown once an admin sets the date on `/admin`'s Season
  handoff card (`setNextSeasonDate`), else "Next season: coming soon". The
  date is one Setting row (`NEXT_SEASON_PLAN`, parsed by `next-season.ts`)
  naming the season it was set during, so the handoff makes it lapse without
  a write. Display only: it opens nothing and posts nothing, and its
  countdown carries `passedLabel={NEXT_SEASON_PASSED_LABEL}` for a date that
  slips.
- **"Your match night" leads the main column for 72 hours after the
  viewer's series** (`MyMatchNightCard`, `my-match-night.tsx`; rules in
  `myMatchNight`, `src/lib/my-match-night.ts`; Tim's call, 2026-10-05): their
  line in each game (hero, K/D/A, impact points, Match MVP, win or loss), the
  night's impact total and MVPs, and any badge their career had never earned
  before, with links to the match page and their profile. Only a decided
  series (COMPLETED) counts, "latest" is by when a game ended (start plus
  duration), never an update time, and outside the window it renders nothing
  (streamed with a null fallback). It reads the viewer's own games
  (`getPlayerGameFacts`, as the profile does); no Discord, no schema. That
  read checks every stored game, so the card first reads the start and
  duration of the season's decided games (by the indexed match id) and stops
  unless one ended inside the window (`matchNightWindowOpen`, which can never
  be false when `myMatchNight` would show; tested): on most days of the week
  nothing can show and the read never runs.
- **The regular season is two columns from `xl`:** This week and the
  standings, then the honors line and the news under them; the rail holds the
  Coming up / Recent results band and the side games. The
  playoffs stay one column, because the two-sided bracket needs the full
  width. Below `xl` everything is one column in that order, rail before the
  honors and news.
- **`SeasonViewSkeleton` mirrors the season bands** (`playoffs` picks the
  one-column shape); change both together or the page rearranges after
  streaming.
- **A planned inhouse night leads the page** (`InhouseNightBar`, rules:
  [inhouse](inhouse.md#inhouse-night)): one thin bar above the hero in every
  phase, and inside the offseason view's column. It renders inline, never
  streamed, because a bar that drops in above an already painted hero shoves
  the whole page down; only its Discord headcount streams. It is one
  wrapping row of single items (title link, time, countdown, headcount, then
  a spacer and the button), so a phone packs it into two lines. The title
  links to the night's card (`/inhouse#inhouse-night`), which sits under the
  room, below /inhouse's first screen. "I'm in" is
  one toggle (`aria-pressed`, the kit's small button), pressed once you're
  in, the way Discord's Interested button works: a separate "can't make it"
  control took a third line on a phone. For a player without a linked
  Discord it is the account link under the same label, a plain anchor so
  nothing prefetches the route that starts it.
- **The inhouse queue is a side-game tile mid-season** (`InhouseStrip
  variant="tile"`, the live line), and ends the COMPLETE view's rail; the
  other phases keep the full-width strip after the view. The night itself
  is the bar's: the strip and the tile only turn their call to action into
  "Jump in" while it's on.
- **While anyone is queued, the queue line leads Home instead**
  (`inhouseQueueLeadsHome`, `src/lib/home-inhouse.ts`): the full-width strip
  right under the night's bar, above the hero, in every phase and in the
  offseason view's column, and its usual place (strip, tile or rail tile)
  stands down so it shows once. Players looking for a game is the one inhouse
  fact a visitor can act on now, and the usual place is below the news on a
  phone. While the night is on, the night's bar already prints the queue
  count and "Join the queue", so the line stays put. Home reads the line's
  counts with the season snapshot (`loadInhouseQueueLine`, request-cached, so
  the strip reuses them) and renders it inline, never streamed, for the
  night bar's reason. `src/app/home-inhouse-guards.test.ts` pins that every
  other strip on Home sits behind the flag.
- **The match-night poll card sits under the pinned notices in every phase**
  (and in the offseason view), streamed with a null fallback because it is
  usually absent. Its ballot and live count stack, never side by side: a
  voter's folded ballot is one short strip. Rules:
  [match-night-poll](match-night-poll.md).
- **Show a fixture once per job.** `focusSlate` (`schedule.ts`) is This week's
  slate; "Coming up" is the open matches minus that slate, so no match is in
  both.
- **This week is a list of compact rows** once the slate has two or more
  series (`this-week.tsx`): both sides, each with its standin-aware check-in
  count ("3/5 in", shared `matchNightRoster`, as on `/schedule`) and one
  stake line (`slateStakeLine`: "Win to qualify", "Eliminated"; nothing for
  the default "Playoff spot still open"), then the pick on one line
  (`PickemTray layout="inline"`). The viewer's own series is first and
  marked "Your match", a live one next (`orderSlate`), and a kickoff the
  whole slate shares prints once in the card's header (`sharedKickoff`); a
  moved series prints its own. A playoff or tiebreaker row names its round.
  Six full cards with a stacked pick tray each ran about 1,800px on a
  desktop and 3,300px on a phone, with the standings below them (the
  2026-11-09 audit). The rules are pure, in `src/lib/home-slate.ts`.
- **This week faces a lone fixture's sides off** (home left, away right,
  "vs" or the live score between), with the full `PlayoffOutlook` under each
  side, instead of stretching a row built for a third of the width across
  all of it.
- **A lone series on This week gets the big kickoff clock**
  (`<KickoffCountdown>`) in place of the header chip; when it is the grand
  final the card is titled "The grand final" and the clock wears gold.
- **A playoff or final card on This week carries the league stream** as a
  strip under the card's link (see the match page's watch link below).
- **The Your team card is the playoffs' only** (`PlayoffTeamCard`: the seed
  and where the team stands in the bracket), in the auto-fit band.
- **`WeeklyHonorsLine`** renders only official honors (the readiness rows
  Discord and `/leaders` use; `honorBestGame` picks the game), else nothing;
  the in-progress caveats live on `/leaders`.
- **Upsets on Home** (rules: `stats-and-side-games.md`). A Recent results row
  whose series was an upset carries an amber "Upset" chip (`UpsetChip`,
  `aria-hidden`, the reason on hover), and its spoken sentence opens
  "Upset:" yet still ends "won the series · Match details"
  (`recentResultSpoken`). `WeekHighlights` (`week-highlights.tsx`) is one
  line beside the honors line, never inside it: the latest week's biggest
  upset ("Week 5 upset · X beat Y 2–0, from 6 points behind going into the
  week"), else nothing. Both judge the matches Home already loaded and add
  no query; `week-highlights.test.ts` pins the wiring.
- **`CaptainStrip` (sitting captains only) sits under the hero, above
  `AdminStrip`:** "N things need you · Week 3 vs X first", "Nothing needs
  you right now", or before the auction "Your team: X", and "Manage your
  team" opens `/captains`. It counts what `loadCaptainTodoRows` finds, the
  same rule the page and the match page read. Database reads only, run for
  captains only.
- **`AdminStrip` (admins only) repeats `/admin`'s next step word for word**
  plus the Needs attention count (`adminHomeLine`). Feed `adminNextStep` and
  `matchAttention` the same inputs as `/admin` or they drift. Database reads
  only, never Discord.
- **PLAYOFFS shows a compact bracket; COMPLETE the gold champion banner and
  "How it was won".** `<ChampionMoment>` (`champion-moment.tsx`) is the
  crowned state only: crest and trophy, "{season} Champion", the final's score
  from `championFinalLine` (null for a legacy archive), the regular-season
  record and the roster chips, captain first. The "needs review" card stays in
  `complete-view.tsx`. The champion's own team page shows `<ChampionStrip>`
  under its header (season and final only: the header and the roster card
  already carry the rest). Keep the "{season} Champion" label and the one
  `/teams/` link siblings under one parent, and never link the beaten
  finalist there (the postseason e2e reads the champion that way).
  `<Bracket>` centres itself when its card is wider than it. Round grouping is
  pure `slotRound`/`groupPlayoffRounds` (`schedule.ts`), shared with
  `/schedule`.

### The SIGNUPS view

Signups never close on a count (`minTeams` is a goal), so most of signup week
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
  previews and custom domains copy themselves, tagged `?ref=` with the
  viewer's id (invite credit, players-and-registration.md). The hero's counts carry the ask
  (`needed`, then `toNextTeam`). On draft night the slot gives way to "Enter
  the draft room".
- **`phaseSubtitle` (`season-copy.ts`) takes `canDraft`,** so a full league is
  never told "the draft begins once enough players have joined".
- **One Discord CTA in `<main>` at a time.** `DiscordSetupPrompt` sequences
  the invite ("1. Join the server"), so the view's own Discord row renders
  only for viewers it cannot cover.
- **"Who's in" lists captains first and names its cap** ("Latest 12 of 30
  players") instead of silently hiding the rest.
- **"Who's in" carries the captain call** (`captainsWantedLine`): teams are
  captains (Start draft makes one team per captain), so it says "Captains
  wanted: 3 of 10 so far. Each team needs one." against the teams the season
  wants, counting designated captains as offered, and goes quiet once there
  are enough. A signed-up full player who hasn't offered gets "Offer to
  captain", which opens /me's saved signup (`#signup-details`), where the box
  is.
- **The match-night callout follows an open poll:** while a match-night poll
  is open it reads "Match night — being decided in a player poll" instead of
  the season's text (rules: [match-night-poll](match-night-poll.md)).

## Schedule (`/schedule`)

- **A group season shows one table per group** (`<SeasonStandings>` over
  `standingsSections`, `src/components/season-standings.tsx`): each titled,
  named "Group A standings" for screen readers, with the group's own cut
  line, places, seed names and movement. Home, the archive and the COMPLETE
  view use the same wrapper, and the head-to-head grid splits by group. A
  one-table season renders exactly the one table it always did.
- **The season plan folds to one line** (`SeasonPlanFold`,
  `src/components/season-plan.tsx`): "Season plan · Two groups of 6 ·
  playoffs from Sat, Dec 19", opening to every step (`seasonPlan`), dates on
  the viewer's clock. /schedule shows it in DRAFT (with fixtures) and the
  regular season, Home above the standings in the regular season.
- **The standings are one card with three tabs:** Table, Head-to-head and
  Playoff race (`ViewTabs`, `src/components/view-tabs.tsx`), the last two only
  when the phase shows them. The server renders every panel and hides the
  inactive ones, so the table shows before hydration. The Head-to-head and
  Playoff race tabs carry the old fold ids (`#head-to-head`,
  `#playoff-analysis`): a link to either selects it, and the jump bar's chips
  land on them (tabs select on focus, which the bar gives its target).
- **From `xl` the regular season leads with that card at full width,** above
  the weeks (`xl:order-first`; phones keep the weeks first, with the jump bar
  down to the table). Two groups' tables sit side by side once each has
  30rem (`SeasonStandings sideBySide`), and their grids once each fits whole
  (auto-fit tracks `seasonGridWidthRem` wide, from the larger group), so a
  group of six needs no scrolling. It replaced a 30rem sticky rail that
  scrolled on its own beside the page as soon as two groups' tables were
  taller than the screen, with the grid scrolling sideways inside it (Tim,
  2026-11-01: "There's two scroll bars"). Nothing on the page scrolls in its
  own box at 1280px (`e2e-mid/schedule.spec.ts`). The playoffs and COMPLETE
  keep one column (the bracket leads, the finished weeks fold away).
- **The head-to-head grid is compact** (`SeasonGrid`): rows carry the names
  (cut short on one line), columns only crest and rank with the name for
  screen readers and on hover, and an unplayed meeting reads "wk 5", never
  "W5", which read as a win. On phones a cell drops its W/L letter (the row
  team's score comes first, so the score says it) but keeps a forfeit's F,
  and a group of six fits a 390px screen. `SeasonGridKey` explains the
  colours under the grids.
- **A week's cards go two and three across by the week's own width**
  (`@container`, `@2xl`/`@5xl`), and `GridFillers` paints the empty cells of a
  part-filled last row the surface colour; the grid draws its hairlines as
  the gap colour, so an empty cell showed as a grey block.
- **The section title and the team filter share a row** (`ScheduleWeeks
  heading`); there is no dot legend.
- **The page opens on the whole league, never filtered to the reader's
  team.** A rostered reader's series lead each week (`viewerSeriesFirst`) and
  are marked "Your match", and their team is the filter's first option ("My
  team · …"). It used to open filtered, so the league's week sat behind a
  select and one card stretched across the page under the check-in banner
  that already named that match. Only "Add to calendar" still starts on the
  reader's own team.
- **A card says only what is not the default.** An ordinary upcoming fixture
  shows no status label ("Upcoming" stays in the card's accessible name): the
  label is for live, final, awaited, result needed and no time yet. A week's
  shared kickoff prints once in its header (`sharedKickoffTs`) and a card
  shows a time only when its own differs. The check-in counts show once
  somebody has answered or inside eight days of kickoff
  (`checkinCountsShown`). The card's one link is an arrow whose spoken name
  is "Match page: A vs B".
- **Weeks after the league's focus week start closed** (`weekStartsCollapsed`
  with `openThrough`), one line per series like a finished week, with the
  reader's line marked. Five open weeks of identical cards put the page at
  about 3,800px. A closed week's lines go two and three across with its
  cards' breakpoints.
- **A settled side reads as it does on Home:** "Qualified for playoffs" in
  green or "Eliminated" in grey (`fixtureStake`), in place of "Any result ·
  Qualify" in the amber of something still at stake.
- **The Playoff race tab lists the teams under In, In the hunt and Out**
  (`playoffRaceGroups`), the reader's team first in its list and marked. A
  settled team, and one nothing is decided for (`outlookStillOpen`), is its
  name and one line; the Win/Draw/Loss outlook is for a team whose next
  result changes something. The projected first round ("Playoff picture")
  follows. It draws into the standings card's panel, not a card of its own.
- **The season plan closes the page, and the subtitle is three facts** (the
  season, the week and series count, the match night); "Kickoffs are shown
  in your time zone" sits under the weeks. On a phone the first fixture was
  about 1,400px down.
- **The team filter holds a pick until the URL catches up.** The URL is the
  source of truth, but the router applies `pushState` in a transition and a
  controlled `<select>` snapped back to its old value meanwhile (the pick
  flickered to "All teams"; `e2e-mid/quality-of-life.spec.ts` reads it back
  at once).
- **The jump bar** (`SectionNav`, in page order) lists what the phase renders
  when there are three or more sections; the regular season hides it from
  `xl`, where the standings come first.
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
- **Before fixtures, the empty state's match-night callout follows an open
  poll:** during signups it reads "Match night — being decided in a player
  poll", with `MatchNightPollNote` (the poll on Home) in place of "Confirm
  this slot works before you sign up" (rules:
  [match-night-poll](match-night-poll.md)). The subtitle's "Match night …"
  prints only once fixtures have kickoffs, which a poll never overrides.

## Teams (`/teams`, `/teams/[id]`)

- **The index is three across from `xl`** (two from `md`), each card a
  compact header (56px crest, name, one summary line) over the roster chips.
- **The summary line ends with the roster's average MMR** ("3394 avg MMR"):
  `rosterAverageMmr` (`pool-stats.ts`), the members' known signup MMRs in the
  season, the same figure as the team page's "Avg MMR" tile. It is left out,
  never shown as 0, while no member's MMR is known. The fixtures' rosters have
  no signups, so `boards.spec.ts` gives one team signups to check it.
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
  rows are one 44px line instead of a name over an empty badge row. The
  signup MMR follows the rank badge ("3,400 MMR", left out while unknown): it
  is the number the standin rule measures cover against.
- **The team's own people get a "Match prep" card** under the next series
  (`match-prep.tsx` over `loadTeamWeek`, `team-week-service.ts`, and the pure
  `teamWeekNotes`, `team-week.ts`): the side's check-in count (named answers
  for the captain, through the check-in banner's own `loadCheckinSide`), then
  one line per thing waiting, each linking to the match-page card that deals
  with it: a player out with no cover, an open seat, the other captain's
  standin request, a ready check, the captain's own request waiting, and who
  is standing in. A captain gets the scoreboard's jumps (`captainJumps`); a
  player gets "Open the match to check in". It renders only for the team's
  captain and roster on an unfinished series of the active season, streamed
  in its own Suspense, so the public page pays nothing for it. The page used
  to show a date and "Open match" (audit, 2026-11-10).
  `src/app/teams/[id]/match-prep.test.ts` pins who gets it.
- **The next-series card shows the weekday and a countdown**
  (`ProfileMatchSpotlight`, shared with the profile: `LocalTime` "full" and
  `<Countdown>` while the state is "Next series").
- **"Edit team name and logo" is one quiet line under the header,** its form
  in a panel only when open: a once-a-season job was a full-width bar above
  everything the captain came for.

## The player pool (`/players`)

Rebuilt on 2026-11-12 (Tim: more compact, more players on a screen, more
filters, a useful right sidebar). `src/components/player-pool.tsx` draws it;
the filter rules are pure in `src/lib/player-pool.ts`
(`players-and-registration.md` has the scouting facts).

- **The layout:** the title's subtitle carries the pool's shape
  (`poolSubtitle`: "Season 7 · 37 players and 3 standins · average 2,580
  MMR"), then the toolbar (search, the position chips, the status chips),
  a line with the list's name, its count, "Scouting details" and the sort,
  then the list. From xl a **sticky filter sidebar** (19rem, `aside "More
  filters"`) sits beside all of it: the MMR range and its bands, the
  Players toggles and the Positions bars. Below xl the same element folds
  out under the toolbar from the **Filters** button, which counts the
  panel's active filters (`poolPanelFilterCount`); there is one copy of
  every control. The page grid is `xl:grid-rows-[auto_auto_1fr]` with the
  aside spanning all three rows, so a short list grows its own row (the
  `1fr`) to the aside's height instead of opening gaps between the toolbar
  and the list. The aside scrolls inside itself only when a short window
  can't hold it.
- **A row is one line from lg and two below it.** One template string
  (`poolColumns`) is set as `--pool-columns` on the list and read by the
  header and every row (`ROW_GRID`, `lg:[grid-template-columns:var(--pool-columns)]`):
  Tailwind can't see a class built at runtime, and two copies drift until
  the header lies about its columns. The Inhouse, Pubs and Favorites
  columns exist only when someone has that data. Below lg the avatar keeps
  the gutter, line one is the name, the MMR and the toggle, and line two
  (roles, the inhouse token, the Pubs cell, favorites from md, status)
  wraps under them; from lg that wrapper is `display: contents`, so the
  same cells are grid columns in the header's order. An empty cell hides
  below lg so it adds no gap. The status cell takes what line two has left
  from 8rem, so a long team name truncates beside the roles instead of
  wrapping under them (360px is the check).
- **The toggle sits beside the MMR below lg** (its own track), so line two
  has the whole width and nothing can push it to a third line.
- **A row opens the draft room's scouting card under it** (`DraftPlayerCard`
  `variant="pool"`, built by `draftScout` from the pool's facts, with the
  card's `actions` slot holding Full profile, Dotabuff and the Discord tag
  or "no Discord"), one card at a time. The chevron is the control
  (`aria-expanded`, "Scouting for {name}"); a pointer click anywhere on the
  row that is not a link, a button or a text selection opens it too.
  "Full scouting" is the reader's own (`usePersistedFlag
  "playerPoolScoutFull"`).
- **"Scouting details" sets row density, not a filter:** off (the default
  everywhere since 2026-11-12), a row is one line; on, a line across the
  row under the name carries the last season, the pub record, the scouting
  read and recent pub heroes, then one line of the player's own words.
  Neither line has a link: those are in the card. The choice persists on
  the reader's device (`usePersistedFlag "playerPoolDetails"`) and stays
  out of the URL and "Clear filters". It is an icon button beside the sort
  below sm.
- **The pool is the whole page:** standins are rows with a Standin badge;
  the Players and Standins chips (`?status=player`, `?status=standin`) split
  the pool by registration type, shown only while there are standins
  (Tim, 2026-10-30: "you can filter the stand-ins, but you can't just filter
  the players"). Drafted and Free agents are about full players: a standin
  is never a free agent. Rosters live on `/teams`. "Wants captain" shows
  only while `captainSelectionOpen`, on volunteers not yet picked. A
  rostered captain wears "(C)" in their team chip rather than a second
  badge, which wrapped the status cell.
- **Every chip counts what it would show, given every OTHER filter**
  (`poolFacetCounts`): "Standins 3", "Plays inhouses 12", the MMR bands and
  the Positions bars. The count is part of the chip's name.
- **The filters** (`PoolPageFilter`, `poolRowMatches`): the search matches
  names and, for a hero's name or alias, players with that hero among
  their favorites, recent pub heroes or most played (`heroesForPlayerSearch`
  in `heroes.ts`: an exact hero or alias, else a word that starts with
  three or more letters, never a substring inside a word, so "ant" is
  Anti-Mage and not Enchantress). A row kept for a hero says so under the
  name ("Lion: a favorite, 12 of their last 100 pubs"). Positions are
  any-of ("4 or 5"). The MMR range is inclusive with open ends, a reversed
  range means the span between, and an unknown MMR (0) is never inside one.
  The Players toggles are Returning / New to the league (an earlier league
  season on file or not), Plays inhouses, On Discord (offered only to a
  viewer allowed contact, `showContact`, since every handle is blank for
  anyone else) and Hide inactive, which hides only players whose fresh
  snapshot says they went quiet: no snapshot is unknown, and stays.
- **Filters live in the URL** (`q`, `pos=4,5`, `sort`, `cap=1`,
  `status=drafted|free|player|standin`, `mmr=3000-3500` or `3000-` or
  `-3300`, `history=returning|new`, `inhouse=1`, `discord=1`, `active=1`;
  defaults omitted, so an unfiltered pool is a bare `/players`). They seed
  once from `useSearchParams` on mount (hence the `<Suspense>` around
  `<PlayerPool>`) through `readPoolParams`, which drops anything with no
  control to show it (a stale `cap=1`, `status=standin` with no standins,
  `sort=inhouse` with no ladder, `discord=1` for a viewer without contact).
  They mirror back through `poolParamsQuery` with `history.replaceState`,
  never `router.replace` (that re-runs the page's server queries per tap),
  debounced 250ms (browsers rate-limit `replaceState`), flushed by
  `SAVE_LIST_CONTEXT_EVENT` before a click through to a profile. React is
  the source of truth. `sort` is not a filter: "Clear filters" keeps it.
  `e2e/pages.spec.ts` reopens the URL cold, because seeding from it is the
  half that rots.
- **The sorts:** MMR (default), Inhouse (with a ladder), Medal, Name and
  Newest (the signup's `createdAt`, sent as `signedUpAt`). `PoolSort`, the
  type the draft room shares, keeps only its three (`PoolPageSort` adds the
  page's two).
- **Tests:** `player-pool.test.ts` (filters, facets, sorts, the URL both
  ways), `heroes.test.ts`, `pub-scout.test.ts` (`pubColumn`) and
  `e2e/pages.spec.ts`: the chips, the URL round trip, the density toggle,
  the card, and a 390px pass with the Filters panel and a card open
  (overflow, tap targets, overlapping targets). The mid-season suite's
  pool is empty; see a full one with `npm run fixture:signups`.

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
  play" in the main column, and a 24rem rail with the pub scouting, hero
  pool, records, achievements and seasons. A phone reads them in that order.
  **With no league games the "Player profile" band (scouting, heroes,
  records) moves into the main column** (`profileInMain` in
  `profileSections`): the main column otherwise held one heading beside a
  full rail, the biggest hole on a new signup's page. Both columns
  are `@container`s: the overview's stats and spotlight split at `@2xl`, a
  series row puts its games beside the opponent at `@2xl`, and the hero pool
  (`columns="container"`) and achievements step with the rail's width.
- **The League records card also shows the record within reach**
  (`recordWatchFor`, rules in `stats-and-side-games.md`): one "Within reach"
  row under any held-record chips, stored marks only ("Most kills · Career
  best 18 kills · record 21, 3 short"). `profileSections` opens the card and
  its Records tab for a held record OR a within-reach line, and both come
  from the one cached book (`getRecordWatchBook`, mapped as `/records` maps
  it; stats-and-side-games.md), so they can never disagree with `/records`.
- **Compare is two columns from `lg`:** career numbers on the left, the
  head-to-head and both hero cards on the right, by grid placement, so the
  DOM and a phone keep head-to-head, numbers, heroes. The rows are
  `auto_1fr`, so a taller numbers card grows the heroes' row, never the
  head-to-head's. Player B's name heads the right-hand column of figures.

## The inhouse page (`/inhouse`)

- **Order is the product:** the title row (`PageTitle compact`: "Inhouse",
  the section nav from md, "Match history"; no tagline), the one top bar
  (only while it has something on it, streamed: the planned inhouse night's
  chip and Play later's soonest open times, three, or two beside the night,
  earliest first, a link leading with its own, a fade on a side with more
  off screen; [inhouse](inhouse.md#play-later)), the room, the
  Play later card (players' own times in full, with posting; always here, a
  time's link too, which only leads the bar with its time and outlines its
  row), the inhouse night's card (only while one is set: "I'm in", the
  headcount, who said they're in as profile chips, "Copy invite link", the
  Discord event and calendar links; opened from the invite link it says
  "I'm in" once), a phone's section nav (from md it sits in the title row),
  `SceneStats`, ladder, recent results, then the OpenDota guide. The ladder
  is why people return; the history sections are the costliest queries, so
  they stream in below the room.
- **The 1v1 mid card and leaderboard sit below the 5v5** ([inhouse-duels](inhouse-duels.md#the-card)):
  the room renders `DuelSection` (`<section aria-label="1v1 mid">`, h2 "1v1
  mid") after every 5v5 card, never above or inside the queue card, and the
  page streams the "1v1 mid leaderboard" (`duel-ladder-card.tsx`, section
  `inhouse-1v1`, "1v1" in the section nav) after the 5v5 ladder, whether or
  not any 5v5 has been played. Its controls never share a 5v5 control's name
  (the 5v5 specs find theirs by name).
- **The whole queue card fits the first screen** (Tim, 2026-10-10: "the
  entire queue on the screen when you go to the in-house page, you
  shouldn't have to scroll down", with the bar where you can opt into a
  time; his goal is a real browser window, not a full device screen; on
  2026-10-11, "yes do the phone pass": a phone in Safari with both
  toolbars showing). On a fresh load the queue card, from its status to
  every slot and the positions count, sits under the 64px header and,
  below 1024px, above the phone tab bar, from 390x844 to 1920x1080, at
  1366x768, on a 390 phone with Safari's toolbars showing (390x664: what
  an iPhone 12 to 15 shows on first load) and in a laptop's browser window
  (1280x690, 1366x657, a screen less its tabs, address bar and dock), in
  every state the spec writes: signed out, signed in with or without a
  signup's MMR, queued, 0 to 9 present, with and without the bar.
  `e2e-mid/zz-inhouse-queue-fit.spec.ts` measures it (and 375x667: required
  signed out, printed signed in), also prints 1440x790 without asserting
  it, and prints a table of every load's spare pixels (the visible bottom
  less the card's); read the latest run's table rather than a number here.
  The tightest required loads are 390x664 signed in (the filled card's two
  rows of controls) and 1366x657, for every viewer. Run it with
  `FIT_FONT=Verdana` too: CI's Linux runner draws DejaVu Sans, wider than
  a Mac's SF Pro, and Verdana is a close stand-in, so a Mac sees the wraps
  CI will. Its browsers run on a clock that reads 9 PM when it starts (a
  whole-hour zone picked from the runner's clock), and it writes the times
  and the night on that clock, so the bar's chips always carry their
  widest words ("Tomorrow, 12:45 AM", a night named by its date) and the
  spec checks them before measuring. Written from the runner's clock, the
  words followed the hour: on 2026-10-11 the night's chip fell off a
  laptop's bar in CI only on runs after 20:00 UTC.
  What makes it fit:
  - **Above the room:** the compact title row (`PageTitle compact slim`:
    on a phone a 20px title and a 32px row, "Match history" at its end);
    the bar, one button high (60px on a phone, 52 from 640), carrying the
    night as a chip instead of a card above the room; 8px between the
    title, the bar and the room on a phone, 12 from 640. The room's blocks
    sit 8px apart on a phone, 12 from 640 and 16 from md.
  - **From xl the night's chip never scrolls.** Every laptop's bar is the
    same 1216px, and beside the night the times' chips swipe in a row of
    their own (a nested `PlansRow`, with its own fade) between "Play
    later" and the link down, so the night's chip and its "I'm in" stay
    whole however wide the times' words get. Below xl the bar's whole row
    swipes, as on a phone. Capping the times at two beside the night was
    not enough: in CI's DejaVu Sans, "Tomorrow, 12:00 AM" and "Tomorrow,
    1:00 AM" pushed a signed-in viewer's night chip ("Link Discord", 440px
    wide) 17px past the bar's end at every laptop size.
  - **The room's header and its stage strip are ONE row** (the connection
    dot, the lobby badge, the stages, Sound; on a phone "Live room" and the
    Sound words are screen-reader text, "Reconnecting" always shows, and the
    badge takes a line of its own). Sound reads "Turn on sound" until the
    page has had a click ([inhouse](inhouse.md#the-room-client)); desktop
    alerts stay out of this row, in their own row under the card. While the queue card shows a queued
    player (no lobby of their own), a phone has no "You're queued" badge
    line: the card's context cell says it.
  - **Below md, a compact card on a four-column grid** (`PHONE_GRID` in
    `queue-view.tsx`): row 1 is a 40px ring, the title and the action at
    its end (Join, "Leave queue" or "Sign in to queue", 40px high); row 2
    is one 120px context cell beside the positions: the MMR box (its "MMR"
    label inside a 40px box, the input borderless, with no spinner), the
    signup's MMR ("4,350 MMR", "from your signup") or "You're queued" over
    "#N in line" (the room's status; " · listen for the ready check" is
    screen-reader text there, and the line under the card starts "Listen for
    the ready check ·" for a queued phone player). The positions
    (`RolePicker queueCard`) are 40px-high toggles sharing the row (34px wide
    at 390, 31 at 375, up to 40 on a wider phone; the picked ones keep a
    transparent border so a tap never shifts them), 8px apart,
    their label for screen readers, and one order line under them cut off
    with an ellipsis (the toggles' ranks and names carry the order; a
    phone says "Tap your favorite first" and "from your signup"). "How your
    MMR is set" sits right under the card on a phone (in it from md), then
    the queue tools panel (below). The
    slots are 32px rows (the name and MMR at 16px, then the slot, or "You"
    in your own, and 14px pills), and the positions count rides the
    "Who's playing" row. That row never wraps (a second line cost a phone
    its first screen in DejaVu): the heading and the counts keep their
    width, and the average sits in a one-line box that drops it whole when
    it doesn't fit, never cut to "4,4…". "N more · waits for a game"
    replaces the row's "Ready check when a game finishes" while every game
    slot is taken.
  - **The empty queue's card on a phone** is tighter: no eyebrow, a 20px
    title and a 12px blurb, the picker's short "Positions" label beside
    40px toggles (`RolePicker phoneRow`), a 24px "How your MMR is set", and
    16px padding below 640. On a phone the join control is 44px high with
    a narrower MMR box (the next-game card's too), so the box and Join
    share one line: stacked, they cost the empty card its first screen in
    DejaVu.
  - **md (768 to 1023):** two columns, the 128px ring centred over the title
    with the controls stacked under it, and 48px slot rows (they grow when a
    narrow slot wraps its positions, with height to spare at 768x1024).
  - **From lg:** the ring 128px beside the title, the controls centred
    under it with the picker's short label beside its toggles, 48px slot
    rows, and a 16px gutter around the slots.
  States outside the target add height and may scroll: "Also queued", the
  away line, "Result on the way", the last result's banner, "Save
  positions", a status line, and an opened "How your MMR is set".
- **Under the queue card, one panel; at the room's end, one admin panel**
  (Tim, 2026-10-21: the centred rows stacked under the card, each with its
  own button, and the admin rows right-aligned one by one with the bot's
  status loose below them, looked sloppy beside the card).
  - **Queue tools** (`QueueTools`, `src/components/inhouse/queue-tools.tsx`):
    tiles side by side from md, stacked on a phone, each an icon, a title, a
    one-line description and its control at the end: "Invite friends" ("Copy
    queue link"; [inhouse](inhouse.md#queue)) and, for a signed-in viewer on
    a desktop browser, "Desktop alerts" ("Turn on", or an "On" badge and
    "Turn off", or "Blocked"; [inhouse](inhouse.md#the-room-client)); the
    invite spans the panel without it. The footer says tab switching keeps
    your spot, led on a queued phone by "Listen for the ready check". It is
    under the card, so it costs the first screen nothing.
  - **Admin tools** (`InhouseAdminTools`,
    `src/components/inhouse/admin-tools.tsx`), for admins at the end of the
    room in every stage: an "Admin" header linking "Players' medal & MMR",
    then one row per tool: "Remove from the queue" while anyone is queued,
    "Void the last result" between games, and the lobby bot's status with
    "Check bot connection" (`DotaLobbyRecovery`, which the page mounts for
    admins and passes in as `botStatus`).
- **Two live games share the room** ([inhouse](inhouse.md#two-games-at-once)):
  a player sees their own game, with the other folded to one line under it; a
  spectator sees the next-game queue card, then each live game read-only,
  named "Game N" once two are live. Only one pinned clock bar ever shows.
- **Each stage after the queue is one compact card, side by side where the
  screen has room** (Tim, 2026-10-31; [inhouse](inhouse.md#the-room-client)
  has the words). The ready check: the question, its clock (beside the
  heading at every width) and the answer, with the ten as two columns of
  slim tiles beside them from lg. The vote: the banner with what it would
  decide now, then the three methods beside the nominations from lg (slim
  rows on a phone, the hint left to screen readers while a card shows its
  pair). The draft: the turn, its clock, the snake and the last pick in one
  banner, the pool first in the DOM, the teams beside it from lg. Set up: a
  short "Teams are set!" card, then the setup card beside the rosters from
  xl (its steps by its own width); the bot's panel leads with its status,
  the seat count and the buttons, then the seat board ([inhouse](inhouse.md#game-setup)).
  Play: one banner with "Game over" at its
  end and the result checks in one row, the rosters, then the lobby folded.
  Between games the viewer's last result is a card over the queue for ten
  minutes (both sides, Elo changes, the MVP).
  The player's own side's roster says "Your team".
- **A game marked over gets its own card** ([inhouse](inhouse.md#game-over-result-pending)):
  "Result on the way" above the queue between games, a slim strip (the
  checks in its row, the teams under "Who played"), folded to one line with
  no controls while the viewer is queued or in their next game, named by
  `#code`. The last result's banner puts the scoreline on its own line on a
  phone and the buttons under it. Positions show on every player row, in the player's order of
  preference (`RoleBadges ranked`, first choice ringed): `labelled` on queue,
  roster and matchup rows; the vote and draft-pool buttons, whose label
  replaces their contents, carry them (and "fills Pos N") as an
  `aria-describedby` description. The picker sits in the queue's join
  controls only, its unsaved choice held by the room like the typed MMR.
- **`SceneStats` uses the same memoised `loadBoardStats` as the Discord
  board,** so channel and site agree on counts, last result and MVP. Use
  `inhouseEndedAt`/`inhousePlayedAt` (`src/lib/inhouse-history.ts`) for game
  times, never the lobby's `updatedAt`.
- **Recent results are `<details>` summarised by the scoreline** (newest
  open), with the anchor id on the `<details>` so `#result-<id>` jumps land.
- **The OpenDota guide opens only for viewers with public match data off**
  (`User.fhUnavailable`); closed for everyone would hide it from its audience.

## The admin page layout (`/admin`)

- **Season-wide diagnostics are their own pages:** `/admin/data-quality` and
  `/admin/health`, linked side by side from Needs attention (a `flex-wrap`
  row with `gap-y-2`). League health is server-rendered `SectionTitle` and
  `StatStrip` bands with a note list under each; see
  [admin-and-operations](admin-and-operations.md#league-health-adminhealth).
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
  forward on scroll. `setupFirst` (SIGNUPS or DRAFT) puts the Phase, Season
  format (only while the schedule card is hidden), Captains & draft and
  Discord reach chips AND cards first; later phases put them after the
  working cards, and the season builder moves into Schedule & results. Chips and cards branch on the same flag, and
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
  record watch, scouting report, and the `/schedule` check-in banner. A COMPLETED match with
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
- **Record watch follows the tape, before the Matchup card**
  (`record-watch.tsx`, rules in `stats-and-side-games.md`): up to three of
  tonight's players (`matchNightRoster`: standins in, covered players out)
  whose career best is within reach of a league record, each a profile link
  and one line of stored marks. The card is props-only and stays out of the
  jump bar. The record book is read in `page.tsx`'s body
  (`loadRecordWatchBook`: the cached book the profile reads, mapped as
  `/records` maps it),
  only for an upcoming fixture of the active season, and passed down: inside
  a card's Suspense the cached read once hung the stream.
  `record-watch.test.ts` pins the order and the hand-off.
- **The season lobby bot's panel has two render sites, never both for one
  viewer** (off unless `DOTA_SEASON_LOBBY_BOT_ENABLED`): captains get it with
  Create/Start in Captain tools; other players, booked standins and admins get
  `lobby-panel.tsx` (`seesPlayerLobbyPanel`, `lobby-access.ts`, matching who
  `resolveDotaLobby` lets view it).
- **A captain's scoreboard carries jumps to their cards** (`<nav
  aria-label="Captain shortcuts">` over `captainJumps`,
  `src/lib/match-captain-jumps.ts`): "Find a standin", "Change the time" and
  "Set up & report" (or "Record next game", or "Captain tools" while results
  are closed). Captain tools sit below the preview and every box score, and
  the one button used to read "Set up & report" three days before kickoff, so
  nothing said the page could find cover or move the match (audit,
  2026-11-10). Days out, cover and the time lead and nothing is primary; from
  `MATCH_NIGHT_LEAD_MS` (3h) before kickoff, and once a game is in, lobby
  setup and reporting lead as the primary. Each jump shows only while its
  card would take the action (`captainCardsOpen`: the cards' own
  `standinAssignmentOpen` and `matchLogisticsOpen` gates). The team page's
  Match prep card reuses the same list.
- **The scoreboard's crests are the header's centrepiece:** each sits over
  its team's name at every width, about 110px on a phone, 140px from `sm`
  and 190px from `lg` (`TeamSide`; they were 64px, and from `lg` the row was
  name, crest, score, crest, name). Tim asked on 2026-11-01 for the logos to
  be a big part of the page. The crest is `fluid` (`TeamCrest` sized by its
  classes) inside a capped `w-full` frame, so on a phone narrower than 390px
  it shrinks with its column instead of pushing into the score.
  `team-crest.test.ts` pins it.
- **Before kickoff everyone gets the ticking clock** under the scoreboard
  (`<KickoffCountdown>` over `kickoffClock` in `countdown.ts`), not only the
  two teams' players: an unplayed fixture of the active season, gone once
  there is a score, a live game or "Awaiting result". The server renders
  empty boxes and the browser fills them (`getServerSnapshot` is null), so
  hydration never mismatches; its spoken name gives minutes, never seconds.
  `kickoff-countdown.test.ts` pins both render sites.
- **Playoff and final matches link the league stream** (`<WatchLink>` over
  `src/lib/broadcast.ts`) once an admin sets one on /admin's Match stream
  card: "Streamed on Twitch" before the window, "Live now · Watch on Twitch"
  from 15 minutes before kickoff until the series estimate ends
  (`seriesEstimateMinutes`, the calendar's event length), then nothing. Once
  a game is in (LIVE) the window is open from then on, whatever the listed
  kickoff (a series that started early read "Streamed on Twitch" while its
  scoreboard said LIVE), and runs a second estimate, so a series that
  started late keeps its link to the end. `matchWatchWindow` picks the
  matches (playoffs and the final of the active season, kickoff set, not
  decided, not a forfeit), and the browser picks the state
  (`getServerSnapshot` is null), so a parked tab crosses both edges. Three
  render sites, each reading `getLeagueStream()` only when a match
  qualifies: the scoreboard's footer, a strip under Home's This week card
  (outside the card's link, like the pick tray) and `/schedule` rows ("On
  Twitch" / "Watch live": a `textLink` with `my-0` on its 44px row, `relative
  z-10` above the stretched link). It links out in a new tab with
  `rel="noreferrer"`. One channel serves the league, so two semifinals at
  once both point at it; per-match links and replays need a `Match` column
  (DECISIONS.md).
- **While the stream is live, `<StreamPlayer>` plays it in place**, in
  Twitch's, YouTube's or Kick's own player (`streamEmbed` and
  `streamEmbedSrc` in `broadcast.ts`), under the scoreboard and under Home's
  This week card when that card holds one match (one stream can't play under
  two). The page ships only our button: the press creates the iframe, so a
  visitor who never plays it never contacts the streaming site. Twitch plays
  only inside the host its address names (`parent`), so the browser passes
  `location.hostname` and previews work too. Once playing it outlives the
  window, which is only an estimate, and the result: on the match page the
  player is drawn with `streamPlayerWindow`, a closed window once a playoff
  or final match is decided, so it stays mounted through the refresh the
  result triggers and a visitor keeps the post-game (it used to vanish at
  the trophy). A closed window starts nothing new. Home's player still
  goes with its card when the slate moves on. A link no player can show (a YouTube
  @handle, a site page) keeps just the link, and the save toast says so.
  `watch-link.test.ts` keeps the player the app's only `<iframe`, created
  only from that press; the postseason e2e stubs Twitch and presses play.
- **A box score line is `BoxScoreLine`** (`box-score-line.tsx`, the page's
  one client piece of a box score): the server renders every part and the
  line lays them out. Each side is an `@container`; from `@lg` a player is
  one line (hero, name, gpm, lh, net worth, KDA at a fixed width so the bars
  line up). The report chip sits on the hero line and is a button whose
  metrics open as a row under the whole line; a `<details>` kept chip and
  metrics in one box, so the chip needed a line of its own.
- **Each box score line ends with the player's items** (`ItemStrip` at 18px
  under the numbers, `pl-10` to clear the hero icon) when the game stored
  them; older games show none until the backfill reaches them.
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
- **The panel's seat list shows only while the bot reported seats, with the
  lobby ready or Dota starting the game (`lobbyListVisible`), and its invite
  copy and buttons only while it is ready, the invite and Start buttons only
  with no release pending** (`docs/DOTA-LOBBY-BOT.md#lobby-invites`;
  source guard `dota-lobby-controls.test.ts`). Otherwise, as from an older
  bot, the "Join through Dota → Play → Custom Lobbies" line stays. Its
  background reads never disable a button, and an action's failure toasts
  rather than showing inline, where the next read would clear it (the
  panel's rates and its action lock: [inhouse](inhouse.md#game-setup)). "Who's in
  the lobby" is a list of `lobbyPlayerRow` texts ("(you)" on the viewer's);
  "Re-invite missing players" and "Send me an invite" render only through
  `reinviteMissingOpen` and `selfInviteOpen`; invite results toast through
  `inviteResultToast`, and a lost answer through `inviteUnknownToast`. The
  browser sends only kind, id and action, never invite targets, and the
  panel shows the route's fixed messages, never a caught error's text. The
  list's names are plain text, an exception to "every name is a link": its
  row carries no user id.

## Stream overlay (`/overlay/[id]`)

- **What it is.** A caster adds `/overlay/<match id>` to OBS as a Browser
  source. It draws a matchup bar (crests in the team colours, the regular
  season record with the table place or a knockout seed, the last five
  series, the round and series length, the score, and a status line: a
  countdown over the last hour, "Game N · BoX" with a Live pill from kickoff,
  "Awaiting result" once long overdue, "Final"), a ticker under it (this
  season's earlier meetings, a run of series wins going in) and rotating
  player cards (tonight's players: medal, positions, season line, impact
  points, Match MVPs or KDA, most-played heroes, or pub heroes before a first
  league game, saying so). `?widget=matchup|players` draws one layout,
  `side=home|away` one team's cards, `seconds=` the card time (4 to 60),
  `notes=0` drops the ticker and `preview=1` adds a checkerboard for a normal
  browser. The match page lists the three layouts with the source size each
  is drawn at, folded at its foot (`stream-overlay-links.tsx`, active season
  only), each with Copy link and Preview.
- **It must cost the server next to nothing** (built for Vercel's Hobby
  plan, DECISIONS.md; the box shares one vCPU between both leagues).
  Twitch viewers never load it; only the caster's OBS does. The page route
  reads no database and carries a day-long edge lifetime. The data route
  (`/api/overlay/[id]/[rev]`) carries its version in
  the path: the result cursor `/api/sync` publishes and, until the series is
  decided, a 10-minute bucket (`overlayRevision`) that catches a late standin
  or a retimed kickoff, so each version could be cached once for everyone.
  On the box no edge caches them (the zone has no Cache Rules), and an open
  overlay's few requests are cheap. Because a version is whatever the caller
  types, one address gets 60 data reads a minute
  (`PUBLIC_GET_LIMITS.overlay`, `src/lib/public-get-limit.ts`; a 429 before
  any database work, which the page treats like any failed read: it keeps
  what it shows and asks again on its next poll). The data route keeps no
  memo: keyed by version, a made-up version walks past it, and keyed by
  match, it could hand a new version the answer from before the result that
  moved it. The page reads `/api/sync` every 30
  seconds, asks for data only when the version moves, and asks for nothing
  while OBS hides the source. Never add a per-poll database read, a cookie, or
  anything that differs by viewer to either route.
- **It sits outside the site's layout on purpose.** A route handler returns
  the whole page (`overlayPageHtml` in `stream-overlay-page.ts`): no header,
  footer, analytics or session read, a transparent background, Oswald's latin
  file embedded, and `src/app/overlay/overlay-client.js` and `overlay.css`
  inline, read by literal paths (`route.test.ts` checks they exist). They
  stay under `src/`, never `public/`: the release classifier reads a new
  `public/` HTML or JS file as an unknown path, a maintenance release.
- **Plain JavaScript for OBS's own Chromium**, which can trail Chrome by
  years: `overlay-client.js` is `// @ts-check` JavaScript (tsc checks it
  through its test) with nothing newer than Chromium 103, text set only
  through `textContent`, https images only (`safeImageUrl`) and one `fetch`
  with a timeout (`overlay-client.test.ts` pins all three). Every size is in
  rem off a root size that follows the source's viewport, so a source of the
  size in `OVERLAY_WIDGETS` (1620x250, 1020x400, 1620x650) fits its layout
  exactly; `stream-overlay-page.test.ts` reads `overlay.css` to keep them
  equal.
- **Public facts only, like a link picture:** no MMR, contact detail or
  check-in answer (`stream-overlay.test.ts` pins the player card's keys).
  Every rule is the site's own, in the pure `stream-overlay.ts`:
  `projectPlayoffField`, `seedsFromFirstRound`, `recentForm`,
  `seriesWinStreak`, `matchNightRoster` (who plays tonight; the overlay only
  orders them, a standin in the covered player's seat), `summarizePlayerGames`
  over complete box scores, `fantasyPoints` and `gameMvp`.
  `stream-overlay-service.ts` loads it, the season's games through
  `getSeasonGameLeaders`. The kickoff is on the league's clock with its zone
  named: a stream is watched from everywhere.
- **Tests:** the units above and both routes' `route.test.ts`,
  `test/integration/stream-overlay.itest.ts`, and
  `e2e-mid/stream-overlay.spec.ts` (the match page's links, both layouts, a
  see-through page inside OBS, and one status read plus one data read).

## Stats pages (`/leaders`, `/meta`, `/records`, `/hall-of-fame`, `/seasons/[id]`)

- **The season archive has a jump bar** (`SectionNav`: Standings, Playoffs,
  Tiebreakers, Awards, Results, Rosters, whichever exist, from three): it is
  the longest public page and had no way to reach a part of it on a phone.

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
- **Each hero links to its page** (`/meta/<hero>`, rules in
  `stats-and-side-games.md`): the table's hero names are `textLink`s, and a
  "Find a hero" box sits under the stats tab bar on /meta and every hero page.
  Its matches drop down over the page as plain links (no combobox), and it
  stays a form so Enter works before scripts load. A hero page is one column:
  the stat strip, "Most-built items" (two across on a phone, three from
  `lg`), the games (one `<li>` per game: result, player, matchup, week and
  date, then the item strip, K/D/A, GPM and length, and "Match"), then who
  plays it.
- **Item icons are `ItemIcon`** (`item-icon.tsx`): Valve's 88 × 64 art at any
  height, the neutral slot round, and an initials tile when the CDN fails or
  the catalogue doesn't know the item, like `HeroIcon`. A line's items are
  `ItemStrip` (empty slots as faint tiles so slots line up, backpack dimmed,
  neutral last), fed plain data from `itemStripData`: the match page's
  `BoxScoreLine` is a client component, and a server component element
  passed through its prop drew React key warnings.
- **Hero meta draws the shape of the meta:** from `sm`, picks (against the
  most-picked hero) and win % each get a thin bar beside the figure, with the
  figure at a fixed width so the bars share a column. Decorative
  (`aria-hidden`): the figure beside it is the value.
- **Hall of Fame boards use the Leaders shape:** the card header, then one
  ruled line per place. Its section links are the site's `SectionNav`, and a
  lone last champion card takes the whole row.

## Captains (`/captains`)

A captain asked for one place to run their team (2026-11-11), and Tim asked
for every captain control on it. The page draws the controls the site
already has, never copies of them, so each keeps its rule and its server
check (`src/lib/captains.test.ts` pins every one of them):

- **Who gets it is one rule, `captainsPageOpen`** (`src/lib/captains.ts`): a
  team whose `Team.captainId` is the viewer, not withdrawn, in the active
  season, from SIGNUPS through PLAYOFFS. The header link, the phone tab,
  Home's `CaptainStrip` and the page all read it. `Team.captainId` is the
  authority, never a roster row's `isCaptain`. Anyone else at `/captains`
  gets "This page is for team captains"; a signed-out visitor goes to
  `/login?next=/captains`.
- **Needs you** is `captainTodos` over every open match
  (`loadCaptainTodoRows`, `captains-service.ts`): an OUT player with no
  cover, the other captain's standin request, the other captain's ready
  check, a time to lock in. Each line opens that match's controls here
  (`captainsMatchHref`: `/captains?match=<id>#<card>`). The match page's
  "Waiting on you" list is the same function over one match, and both render
  through `<CaptainTodoItem>`. Before the auction is done it reads nothing
  and the page shows the draft card instead.
- **Your matches** (`match-desk.tsx`): chips pick one of the team's open
  fixtures (`?match=`, read with `singleSearchParam`; live first, then week
  and kickoff; a bad value falls back to the next fixture). For it the page
  draws the captain's own `<CheckinBanner>` (with the side's names), the
  Remind button (`<CheckinNudgeControl>`, shown by `loadCaptainNudge`, the
  match preview's rule), `<LiveSeriesCheckin>` while the series is live, the
  "moved by ready check" card, and the match page's whole `<CaptainTools>`:
  the ready check to move the match (propose, answer, lock in, withdraw),
  standins (book, ask, agree, decline, withdraw, remove) and lobby setup and
  reporting. Only one fixture's tools render at a time, so the match page's
  card ids stay unique.
- **Scrims** (`scrim-desk.tsx`) draws `/scrims`' own controls from
  `src/components/scrims/scrim-controls.tsx`: Post availability, Cancel on
  the team's open or booked scrims (not once live, as the scrim page), and
  Join on other teams' open times by `scrimJoinCheck`. The scrim actions
  revalidate `/captains` too (they revalidate only named paths).
- **Team** (`team-desk.tsx`): the team page's `<TeamIdentityForm>` under
  `canEditTeamIdentity`, where the team stands (Home's `standingSummary` and
  `playoffStatusLine`; the bracket line in the playoffs), the roster with
  Discord handles through `canViewLeagueContact`, and `<TeamCoachesCard>`
  (add or remove coaches). Signing and releasing players stay with admins.
- **Layout:** a jump bar (`SectionNav`), Needs you and the match controls at
  full width, then scrims and the team side by side from `xl`.
  `e2e-mid/captains.spec.ts` drives every control above through its form and
  checks 390px.
- **Not built:** a standin bench for the next match night, coach access to
  the page, and an admin "view as a team".

## Side games and account (`/scrims`, `/fantasy`, `/me`)

- **A signed-up player gets the invite ask on `/me` too** while signups are
  open ("Know anyone who'd fit?" with `<InviteLink>`), under the signup's next
  steps: it lived only in Home's hero panel, so a player who joined on /me
  with no steps left never saw it. The link unfurls into Home's preview,
  which during signups opens with the league pitch and its servers
  (`homePreview`), since it is often read by someone who has never heard of
  the league.
- **`/me` is two columns from `lg`:** the season (signup, away dates) on the
  left and a 24rem rail with the accounts it relies on (Discord, Steam and
  Dota). Phones keep the same order. Copy says "the Discord card", never
  "below", because it is below on a phone and beside on a desktop. Short
  inputs keep a short width (MMR `sm:max-w-sm`; the Discord handle grows
  beside Save up to `max-w-xs`).
- **Scrims says so when there are no teams yet:** a season before its draft
  gets one EmptyState ("Scrims open once teams exist") instead of a sign-in
  card and six empty lists; the season chips stay.
- **Scrims' captain controls are shared components**
  (`src/components/scrims/scrim-controls.tsx`: Post availability, Join,
  Cancel, the coaches card), which the Captains page draws too. Change them
  there, not in either page.
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
- **Every page streams before it runs.** The root `loading.tsx` sends the
  shell first, so `notFound()` answers 200 and a page's `redirect()` is a
  client redirect inside a 200 (a one-second meta refresh plus
  `NEXT_REDIRECT` in the stream). In e2e, assert the not-found page itself
  (the noindex meta and the "Page not found" heading, as
  `e2e-mid/quality-of-life.spec.ts` does), never a 404 status. Read a
  redirecting page's server answer with `page.request.get`
  (`e2e-mid/import-progress.spec.ts`): Chrome drops the document's body once
  the browser follows the redirect.
- **A fresh `next dev` can 404 a route that exists.** Its router matches
  against a table the file watcher fills in asynchronously, and overlapping
  rebuilds can leave a partial table in place, so a request gets the global
  404 page in about 0.1s with no compile (CI, 2026-10-06: `POST
  /api/test/cache` at startup, then `/seasons/[id]/weeks/[week]` minutes into
  a run). Every suite's global setup calls `expireFixtureCache`
  (`e2e/fixture-cache.ts`), which first runs `waitForDevRoutes`
  (`e2e/dev-routes.ts`): it requests every route handler and dynamic page
  under `src/app` once, retries a 404, touches a file that stays unrouted so
  the watcher rebuilds its table, and fails naming any route that never
  matches. It leaves static pages alone on purpose: every compiled page slows
  each later page load's HMR exchange, and compiling all of them up front
  made a spec lose a click under load. Its log line lists the routes that
  weren't routed at first. Give a new suite the same call; don't mask the
  race with Playwright retries (they stay 0) or per-spec 404 retries.
- **Run the browser suites locally with CI's environment:** blank
  `NEXT_PUBLIC_APP_NAME` and the lobby-bot keys (`DOTA_LOBBY_BOT_URL`,
  `DOTA_LOBBY_BOT_SECRET`, `DOTA_SEASON_LOBBY_BOT_ENABLED`) on the command
  line. A local `.env` or `.env.local` that sets them fails
  `e2e-mid/boards.spec.ts` (it refuses the old league name) and the inhouse
  specs (they see a configured bot).
