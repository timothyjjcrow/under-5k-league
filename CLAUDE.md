# CLAUDE.md — working rules for GGD2L

GGD2L is an amateur Dota 2 league site: one codebase and one commit serve a US
and a Europe league, each with its own database, Discord server and settings.

> **Releases:** every release starts at [docs/RELEASING.md](docs/RELEASING.md),
> which links the [README](README.md) Deployment section and
> [docs/PRODUCTION-OPERATIONS.md](docs/PRODUCTION-OPERATIONS.md). Those are the
> source of truth for builds, migrations, backups, the scheduler, rollback and
> approval. Nothing in this file or the feature notes overrides them.

[docs/DECISIONS.md](docs/DECISIONS.md) lists settled decisions and deferrals,
one line each: check it before proposing a change. Where it disagrees with this
file it is current, and Tim's product calls there bind.
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) maps routes, models and jobs.

## Feature notes

Each area has a note with its own rules and the reasons behind them. Read the
note before changing that area: it is required reading, not background.

| Note | Read it before touching |
| --- | --- |
| [concurrency-and-testing](docs/features/concurrency-and-testing.md) | any guarded write, race test, race-hook seam, or the mutation ratchet |
| [draft](docs/features/draft.md) | the auction engine, the draft admin controls, `/draft` or the draft room |
| [rosters-and-standins](docs/features/rosters-and-standins.md) | signings, releases, promotions, withdrawals, standin cover, check-ins, the week reminder |
| [results-and-opendota](docs/features/results-and-opendota.md) | OpenDota calls, game imports, the league feed, the automation worker, player data refreshes, report cards |
| [inhouse](docs/features/inhouse.md) | the inhouse queue, lobby engine, `/api/inhouse` or the inhouse room |
| [discord](docs/features/discord.md) | any Discord post or mention, webhooks, the ping role and bot, account linking, the queue board |
| [season-schedule-playoffs](docs/features/season-schedule-playoffs.md) | phases, fixtures and kickoff times, reschedules, standings and tiebreakers, playoffs and the bracket, the calendar feed, season history |
| [pages-and-ui](docs/features/pages-and-ui.md) | navigation, the UI kit, Home, `/players`, `/inhouse`, `/admin` or match page layout, the fixture servers |
| [players-and-registration](docs/features/players-and-registration.md) | signup and MMR rules, the player pool and scouting, profiles, compare, team names, logos and jerseys |
| [stats-and-side-games](docs/features/stats-and-side-games.md) | impact points, honors, Leaders, Hall of Fame, Record book, Hero meta, power rankings, scouting, fantasy, pick'em, scrims, news |
| [admin-and-operations](docs/features/admin-and-operations.md) | admin actions and the admin panel, destructive controls, caching and streaming, room connection handling, migrations and backups |

## Mental model

- **The drafted league hangs off a Season and its `status`:**
  `SIGNUPS → DRAFT → REGULAR_SEASON → PLAYOFFS → COMPLETE` (`SEASON_STATUS`);
  the active season is the at-most-one `isActive` row (`getActiveSeason`).
- **Between seasons the league rests in COMPLETE.** Zero active rows (the
  offseason) exists for cancelling a season and reactivating an older one.
- **Pages, navigation and Home render per phase** so unused features hide.
- **Inhouse is season-independent:** no `seasonId`, no phase gate. It shares
  identity, the latest `Registration.mmr`, Settings, Discord and OpenDota.
- **There are no websockets.** The rooms poll over HTTP; scheduled work runs in
  one authenticated worker once a minute.

## Where things live

- **Pure logic:** `src/lib/<name>.ts` with `<name>.test.ts` beside it. Put a
  new rule here first, then call it.
- **DB services:** `src/lib/<name>-service.ts`, transactions over pure
  decisions, tested in `test/integration/*.itest.ts`.
- **Server actions:** `src/app/actions/*.ts`: auth, parse, call a service, send
  Discord after the commit, revalidate, return `ActionResult`. Admin actions are
  split by job (`admin-season.ts`, `admin-captains-draft.ts`, `admin-roster.ts`,
  `admin-schedule-results.ts`, `admin-discord.ts`) over `admin-shared.ts`.
- **Route handlers:** `src/app/api/`: the polled rooms, sign-in, the worker
  (`cron/automation`), read-only status (`sync`, `health/*`) and exports.
- **Auth:** `src/lib/auth.ts` over `session-token.ts` (a jose-signed cookie).
  **Authorize on every request, never in the token or the proxy.**
  `getSessionUser` re-checks the session epoch and re-resolves the role from
  `ADMIN_STEAM_IDS` (`resolveSessionRole`) on every call, so removing an admin
  revokes their cookie at once. `src/proxy.ts` only re-issues an ageing cookie
  with the same uid, epoch and sign-in time (180-day cap); keep
  `session-token.ts` free of the database and `next/headers`: the proxy
  imports it. Bumping `session-epoch.ts` signs everyone out, `npm run
  set-admins` reconciles stored roles, `/api/auth/dev` needs `ALLOW_DEV_LOGIN`,
  and `bootstrapAdminSteamId` is a local-development fallback only.
- **UI:** the kit is `src/components/ui.tsx` (server-safe). Home is
  `src/app/page.tsx` plus `src/components/home/` (the shared hero and one view
  per phase). The match page is the folder `src/app/matches/[id]/`: `load.ts`
  loads once, then one file per card (`lobby-panel.tsx` and `lobby-access.ts`
  for the lobby bot).
- **Engines:** the draft is `draft-service.ts` (`/api/draft/*`,
  `draft-room.tsx`, receipts in `draft-history.ts`); inhouse is
  `inhouse-service.ts` (`POST /api/inhouse`, `inhouse-room.tsx`); scrims are
  `scrim-service.ts` and `scrim-result-service.ts`.
- **Results and history:** every import ends in `importGameForMatch`
  (`match-import.ts`); feed work and admin removals persist as `ImportCandidate`
  and `ImportSuppression` rows. `Game.players` is the canonical box score and
  roster seats are `RosterTenure` rows
  ([docs/HISTORICAL-PARTICIPATION.md](docs/HISTORICAL-PARTICIPATION.md)).
- **Two leagues:** `LEAGUE_CONFIG` (`src/lib/league-config.ts`, set by
  `NEXT_PUBLIC_LEAGUE_REGION`) supplies the regional name, time zone, match
  night and invite ([docs/EUROPE-SETUP.md](docs/EUROPE-SETUP.md)).
- **Automation:** `GET /api/cron/automation` checks `Bearer <CRON_SECRET>`, then
  `runAutomation` (`automation-service.ts`) runs `runResultSync` under a lease.
  Its only clock is the Cloudflare Worker in `ops/cloudflare-automation-worker`.
- **Discord:** transport in `discord.ts`, the outbox in
  `league-announcement-outbox.ts`, the queue board in
  `inhouse-board-service.ts`, bot-token calls only in `discord-roles.ts`.
- **Lobby bot:** `ops/dota-lobby-bot` behind `ops/dota-lobby-relay`, driven by
  `dota-lobby-service.ts` ([docs/DOTA-LOBBY-BOT.md](docs/DOTA-LOBBY-BOT.md)).
- **Tests:** unit tests beside the file (`vitest.config.mts`, which is `.mts`
  because the project is CommonJS; no jsdom), integration tests in
  `test/integration/`, Playwright in `e2e/`, `e2e-mid/` and `e2e-postseason/`.

## Concurrency: the two rules

Production is **Postgres** (`npm run build:vercel` switches the provider with
`scripts/switch-db-provider.mjs`); local dev, integration tests and e2e are
**SQLite**, which serializes writers and therefore HIDES every race below. Two
rules, both non-negotiable:

1. **A read-time precondition is not a guard: re-assert it in the WHERE of the
   write.** Postgres READ COMMITTED re-snapshots per statement, so anything
   checked before a write can be false by the time the write lands. Turn
   `update({ where: { id } })` into
   `updateMany({ where: { id, ...what you checked } })` and handle
   `count === 0`. Where the precondition lives in another table (a write-skew
   pair), re-read it INSIDE a `Serializable` transaction on BOTH sides: SSI
   only spots the cycle when each side has the other's table in its read set,
   so one-sided fixes do nothing.
2. **Past the first write, failure must THROW, never return.** A resolved Prisma
   interactive-transaction callback COMMITS. Every `return { ok: false }` after
   a write persists the half-done state it was trying to prevent. Throw a typed
   error and catch it OUTSIDE the callback (catching inside re-resolves it, and
   on Postgres a query error poisons the transaction anyway).

Worked examples and the damage each prevents: `applyPick` (a frozen inhouse
draft), `undoLastSale` (a live lot and a nomination clock at once),
`advancePlayoffBracket` (a round built twice: no champion, ever),
`recomputeSeries` (a stale caller reverts a completed series), `recordResult` (a
manual score over an auto-import), `assignStandinGuarded` (a double-covered
seat), `deleteSeason`, `generateSchedule` (destructive work past a stale check).

**Testing them: a race test must be RACED, not staged.** Staging the conflicting
row before the call is caught by the function's own read-time check, so the test
passes against the broken code. Race the competing calls with `raceAll` or
`raceN` (`test/integration/factories.ts`), loop when the losing order is rare,
and assert the invariant. Only `npm run test:pg` runs them concurrently.

**When racing isn't enough, use a seam.** For one exact interleaving (the caller
reads, a rival commits, the caller writes), the service awaits
`raceHook("area.function.point")` (`src/lib/race-hook.ts`, test-only) and the
test installs `setRaceHook(onceAt(label, rival))`. Keep the rival off rows the
open transaction wrote (it hangs on the lock), keep in-transaction seams
Postgres-only (`describe.skipIf(!ON_POSTGRES)`), and assert a `fired` flag so a
drifted label can't pass while measuring nothing.

More rules for guarded writes:

- **Claim the exact state you judged.** A turn is its team AND its deadline
  (`nominatePlayer`, inhouse `applyPick`); a rotation can repeat a team.
- **Remove or change a row a rival may touch with `deleteMany` or `updateMany`
  plus a count check,** never by unique, or the loser crashes on P2025. A zero
  count on the transaction's first write may return a refusal; later, throw.
- **Don't repeat a guarded claim as a read-time `if`.** Every test stops at the
  `if` and passes with the WHERE deleted. Let the claim be the one enforcement
  point, or put a seam between the check and the write.
- **Never hold a transaction open across an OpenDota or Discord call.** Fetch
  first, then re-check every precondition in one short transaction.
- **"Something upstream serializes this" only covers rivals from the SAME
  path.** List the rivals from other paths before calling a guard untestable.
- **Order by exact stored keys with an id as the last tiebreak,** never by
  Prisma row order or a `createdAt` that one `createMany` makes identical.
- **Never use `updatedAt` as chronology;** any later write moves it. Use an
  immutable timestamp such as `InhouseLobby.completedAt`.

**The mutation ratchet** (`scripts/mutation-guard.mjs`, baseline
`test/mutation-baseline.json`, four CI shards) deletes each protected guard and
requires the Postgres suite to fail. It models ONE guard shape: state
predicates in an `updateMany({ where })` (plus `claimThrottle`'s SQL). An early
return, a count-then-throw, a `deleteMany` claim or a unique constraint is
invisible to it, so cover those with a hand-written, sabotage-verified test.

- **Classify every new guarded `updateMany` before it lands:** killed by a test,
  or listed in `EQUIVALENT` with a checkable reason. Its file must be in
  `FILES`, and a moved or renamed guarded function needs a `renames` entry.
- **Write claims the parser can read.** Keep a claim's `data` a flat object
  literal (hoist conditionals into a variable) and spell WHERE predicates in
  full (`hostScore: scrim.hostScore`, never shorthand), or CI can't see them.

**Local Postgres:** `npm run pg:up`, then `npm run test:pg` with `PG_TEST_URL`
on the local `ld2l_pgtest` database only (never a shared or production URL),
then ALWAYS `npm run pg:down` to switch back to SQLite. Commands, ratchet and
seams: [concurrency-and-testing](docs/features/concurrency-and-testing.md).

## Conventions and gotchas

- **Node 22.x, Prisma 5, Next.js 16.** `nvm use` reads `.nvmrc`. Next 16 has
  breaking changes: read the guide in `node_modules/next/dist/docs/` before
  writing Next code (`AGENTS.md`).
- **Statuses are strings** (no SQLite enums); see `src/lib/constants.ts`.
- **Write `BigInt("…")`, never a `123n` literal:** `tsconfig` targets ES2017.
- **Restart the dev server after `npm run db:push`,** or the running process
  reads new columns as undefined. `db:push` refuses all but a local SQLite file.
- **Return `ActionResult` from risky actions and let `<ActionForm>` toast it.**
  The live rooms toast `act()` failures with `pushToast`; never add an inline
  top-of-room error banner (a captain deep in the pool never sees it).
- **Never show a user a caught error or provider text.** Throw
  `UserFacingError` for an expected refusal and pass everything else through
  `actionErrorMessage` (`src/lib/user-facing-error.ts`).
- **Revalidate after a mutation:** `revalidatePath("/", "layout")` (admin
  actions via `refresh()`); a change to games calls `refreshGames()`.
- **Quote copy that follows a JSX expression onto a new line** (`{" text"}`):
  JSX trims the plain leading space and renders "(@gone4)isn't".
- **Format numbers in hydrated client components with a fixed locale**
  (`new Intl.NumberFormat("en-US")`), never bare `toLocaleString()`, or a
  non-English browser hydrates "7.200" over the server's "7,200".
- **Name the league GGD2L in anything user-facing, never LD2L.** Old `ld2l`
  names survive in database names and ids; leave them. Read regional times,
  zones and names from `LEAGUE_CONFIG`, never hardcode US ones.
- **The soft MMR limit never blocks, and signups are uncapped** (`minTeams` is
  a floor; `capacityInfo` is display only).
- **Delete dead exports with their tests.** `npm run lint:unused-exports` lists
  unimported `src/lib` exports; it is advisory (test hooks stay test-only).

### Checks to run

- **Types and lint:** `npx tsc --noEmit`; `npm run lint -- --max-warnings=0`.
- **Unit and integration:** `npm test`; `npm run test:integration`, or one file
  with `npx vitest run --config vitest.integration.config.mts <file>`.
- **Postgres and the ratchet:** `npm run test:pg` after touching any claim;
  `node scripts/mutation-guard.mjs --static` after touching a file in `FILES`.
- **Scripts:** `npm run test:scripts` after touching `scripts/`
  (`test:release` and `test:provisioning` for the release and Europe scripts).
- **Browser:** `npm run test:e2e` (signup, draft, inhouse), `test:e2e:mid` (a
  regular season), `test:e2e:postseason` (playoffs, finished seasons). Each
  seeds its own database but builds into `.next` like `npm run dev`, and Next
  16 allows one dev server per build folder: run one at a time. CI runs both
  leagues (`NEXT_PUBLIC_LEAGUE_REGION=us` and `eu`); run both for shared
  behaviour. **Make every new spec assert zero uncaught client errors** with
  `trackPageErrors` (`e2e-mid/helpers.ts`); raw-HTML checks miss client crashes.

## Cross-cutting UI rules

Details and reasons are in [pages-and-ui](docs/features/pages-and-ui.md).

### Mobile layout

- **Keep every page at zero horizontal overflow at 390px.** Wide pages carry an
  `expectNoHorizontalOverflow` e2e.
- **Give every ordinary responsive grid a base column**
  (`grid grid-cols-1 gap-4 sm:grid-cols-2`) and its items `min-w-0`; an
  implicit `auto` track sizes to its content and one long name scrolls the page.
- **Use auto-fit for a band whose card count varies**
  (`[grid-template-columns:repeat(auto-fit,minmax(min(16rem,100%),1fr))]`), and
  never add `grid-cols-1` to it: it sets the same property and wins.
- **Never put a short card beside a tall one in a fixed split;** the row sizes
  to the taller column and leaves a hole. Use `items-start` when it must.
- **Put `overflow-hidden` on the card around an `overflow-x-auto` scroller**
  (`<Bracket>`, `SeasonGrid`), or Chrome pushes the inner width into the page.
- **Give every flex level between a container and a `truncate` span `min-w-0`.**
  Table column widths go on `<col>`, never on responsive-hidden cells.
- **The site header is `h-20` (80px): move every offset under it together**
  (`top-20` clock bars, the `-80px` rootMargin in `useBannerOffscreen`,
  `lg:top-20` section bars, `scroll-mt-*` anchors).

### Tap targets and accessibility

- **Size tap targets through the kit, never per call site:** `textLink()` for
  inline links, `buttonClasses`/`Button` for controls (both carry the focus
  ring), `TAP_SAFE` on link rows. Never hand-roll `text-info hover:underline`.
- **Keep at least 8px between rows of `TAP_SAFE` links.** An overlapping target
  is worse than a small one: the tap goes wherever paint order decides.
- **Give visual-only indicators an accessible name** (`role="img"` +
  `aria-label`, glyphs `aria-hidden`). Toggles use `aria-pressed`, unlabeled
  selects `aria-label`, countdowns `role="timer"`.
- **Use one `<h1>` per page and one accessible name per control.**
- **Use only colour tokens `globals.css` defines;** Tailwind emits nothing for
  others. Warnings are `accent`; red text on a red tint is `text-danger-soft`.

### Components and copy

- **Change `src/components/ui.tsx` additively:** a new capability is an optional
  prop whose default renders exactly what shipped.
- **Track an element that can mount later with a callback ref held in state,**
  never `useRef`, or the effect runs once against null and never re-attaches.
- **Add a page to navigation only through `src/lib/site-nav.ts`,** once it has
  something to show. Hidden pages stay reachable by URL.
- **Render a control only where its action would accept, and keep cleanup
  visible.** Drive both from one pure predicate (`seasonPhasePolicy`,
  `standinAssignmentOpen`), but never hide remove or undo for existing rows.
- **Make copy name controls that exist, by their real names**
  (`src/app/admin/admin-copy-guard.test.ts` checks the admin panel).
- **Never silently rewrite what a player typed.** When the server adjusts a
  value (an MMR clamp, a draft-night freeze), the toast says what was stored.
- **Read query values with `singleSearchParam`** (`src/lib/search-params.ts`): a
  repeated key is "unavailable", never an array handed to Prisma.
- **Make writes unreachable on an archived season.** Pages take `?season=`
  (`resolveSeasonScope`) but actions write to the ACTIVE season, so player and
  captain writes refuse archived seasons. Cleanup (decline, remove) stays legal.

### Personal data and times

- **Show contact info only through `src/lib/visibility.ts`.** Discord handles
  and the "no Discord" marker are for the subject, admins and active registrants
  (`canViewLeagueContact`, `canViewLeagueDirectoryContact`), never merely a
  signed-in viewer. A payload that blanks handles must also say whether the
  viewer may see them, or an absence leaks.
- **Keep every `/api` GET harmless when a browser loads it as an image:**
  user-supplied image URLs render with the viewer's cookies.
- **Never parse a raw `datetime-local` string on the server** (`new Date(raw)`
  uses the server's zone, UTC in production). Use `<LocalDatetimeField>`
  (prefill with `defaultTs`) and `localDate(fd, raw, ts)` in the action. Admin
  boxes pass `timeZone={LEAGUE_CONFIG.timeZone}` (source-guarded).
- **Show times in the viewer's zone** with `<LocalTime>`, passing a
  `formatMatchTime` `initial` and the epoch `ts`. Discord times are
  `<t:epoch:F>`, never formatted strings.
- **Do week math on the league's clock** (`LEAGUE_CONFIG.timeZone`) through
  `matchNightForWeek`, `shiftMatchNight` and `upcomingMatchNight`, so "Sundays
  6 PM" survives daylight saving. `null` gives fixed intervals, for tests only.

## Cross-cutting server rules

### Automation and caching

- **Only the bearer-authenticated worker runs scheduled work.** Public pages and
  anonymous polls never advance state, call OpenDota or edit Discord; a
  signed-in room poll runs maintenance only when it wins a `claimThrottle`.
  `GET /api/sync` is a read-only snapshot, never a scheduler or health signal.
- **Give every new server-side clock or deadline a wake-up in
  `src/lib/automation-gate.ts`,** and after a mutation that creates or moves
  automated work, expire `AUTOMATION_GATE_TAG` (`updateTag` in an action,
  `invalidateAutomationGateBestEffort()` elsewhere).
- **Pin two resolver chains to one set.** When a room poll and the worker both
  run resolvers, a source parity test keeps them equal
  (`src/lib/inhouse-resolver-parity.test.ts`).
- **Call `stampResultChange(tx)` inside the transaction** of every write that
  changes results, games or the names shown on them.
- **Route all-games roll-ups through `src/lib/cached-queries.ts`.** Bust
  `"games"` from request scope, never from lib: `refreshGames()` in actions,
  `revalidateTag("games", { expire: 0 })` in route handlers. `revalidatePath`
  alone does not clear the tag.
- **Stream slow sections** in `<Suspense fallback={<CardSkeleton/>}>`, and never
  await Discord or another network call in `/admin`'s blocking render.
- **Select only display fields for client payloads,** never
  `include: { user: true }`.

### Third-party calls

- **Never overwrite stored data with a failed fetch.** Keep "unreachable"
  (`ok: false` or `null`) distinct from "nothing there" (`[]`).
- **Render unknown as unknown, never as a negative.** Unknown gets its own
  count and never blocks a player.
- **Branch on `res.ok` and the error body's code,** not just the status: an
  error body that parses proves nothing.
- **Give every `fetch` in a `"use client"` file
  `signal: AbortSignal.timeout(...)`** (`room-source-guards.test.ts` enforces
  it). A request that never answers otherwise latches whatever waits on it.
- **Treat a lost or timed-out mutation response as unknown, never failed.** It
  may have committed: keep controls locked and let the next state read answer.

### Discord safety

- **Never send a credential to the browser, a log or an admin page,** or put
  one in argv, a commit, an issue, a screenshot or chat. Webhook URLs, the bot
  token and the OAuth secret show only as a boolean plus a masked fingerprint
  (`maskWebhookUrl`); credential inputs start empty.
- **Gate every Discord write behind `discordMutationsAllowed()`,** so Vercel
  previews never post, edit or grant roles.
- **Escape every player-chosen name with `escapeDiscordText`:** webhook messages
  render markdown and live masked links.
- **Ping only ids the server chose.** Every send keeps
  `allowed_mentions: { parse: [] }` and passes a `MentionAllowlist` from
  `mentionsOf` or `mentionUsers`. Mention only the person who must act.
- **Return announcements from services and send them from the action,** after
  the commit, best-effort. Change every send site of a message together.

### Admin actions and data

- **Open every admin action with `adminOrError()`, in an `admin-*.ts` file:**
  `admin-auth.itest.ts` globs only those (seven older modules escape it). Never
  mark `admin-shared.ts` `"use server"`: every export would become an endpoint.
- **Assume the guard you need is missing.** The engines are hardened; the thin
  actions calling them are where untested defects hid.
- **Put no-undo actions behind `<DangerSubmit>`** (type the real season or team
  name, never a magic word) and reversible ones behind
  `<SubmitButton confirm>`. Confirms state real counts read from the database.
- **Refuse or report; auto-cancel only what is unambiguous.** When a change
  would orphan something a person arranged, refuse and name the fix, or do it
  and list what was left in the toast. Every path that kills a booking or its
  fixture stands the standin down (`grep -rn "standinRemovedMessage(" src`).
- **Log admin work with `logAdminAction`** (after the commit, best-effort); a
  consequential correction writes its `AdminAction` inside its transaction.
- **Ship schema changes as committed migrations,** additive and compatible with
  the binary already serving, pinned in `MIGRATION_SHA256`
  (`scripts/migration-safety.mjs`). Never edit an applied migration, never
  `db push` production, and keep build code free of side effects.

## Working practices

- **Grep before you cite.** Check that a test, call site or count exists before
  writing it into docs or a comment, and write the grep or the source of truth
  (`test/mutation-baseline.json`) instead of a number that goes stale.
- **Sabotage-verify a guard's test:** delete the guard, watch the test go red,
  restore it. A test that can't fail proves nothing.
- **Extract client rules into pure, tested functions in `src/lib`,** plus a
  source guard that the component calls them; Playwright next, jsdom last.
- **Point a source guard at an area, not a file list,** through
  `test/support/source-files.ts`: `sourceFiles` with a minimum count,
  `homePageSource()` for Home, `folderSourceFiles` for `[id]` folders.
- **See the UI in a league state with a fixture server**
  (`npm run fixture:signups`, `fixture:regular`, `fixture:playoffs`,
  `fixture:complete`). Never reseed `dev.db`; it may be another session's.
- **Keep the notes current.** When you change a rule, update its feature note in
  the same commit, and its `docs/DECISIONS.md` row if it has one.
