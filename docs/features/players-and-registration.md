# Players, registration and team identity

Joining a GGD2L season on `/me`, medal-checked MMR, the uncapped pool and its
`/players` scouting rows, the profile Seasons card, `/players/compare`, and
team names, logos, crest colours and jerseys. Main files: `saveRegistration`
(`src/app/actions/registration.ts`), `src/lib/registration.ts`, `rank.ts`,
`capacity.ts`, `player-pool.ts`, `pub-stats.ts`, `team-identity*.ts`.

## Who can sign up

- **The soft MMR limit never blocks.** `Season.maxMmr` (0 = none) is a review
  threshold; only `HARD_MMR_CEILING` refuses anyone (`registrationGate`). The
  review tool is the "over soft limit" flag (`signupFlags`,
  `signup-readiness.ts`), and no copy may say the limit refuses signups
  (`admin-copy-guard.test.ts`). Set with `setMaxMmr` (`admin-season.ts`); new
  seasons copy it (`carriedSeasonSettings`).
- **Signups are uncapped; `Season.minTeams` is a floor.** `registrationGate`
  judges the ceiling, the medal and the phase, never a count (PLAYER signups
  open only in SIGNUPS, standins through the playoffs, COMPLETE freezes all).
  `startDraft` makes one team per captain, so the admin settles the count by
  naming captains: short pool = seats for standins, long pool = free agents.
  `seatFitSentence` (`draft-setup.ts`) says which before the click.
- **Nothing closes signups on a clock;** an admin does (Close signups or Start
  draft), sometimes days before draft night. Home and the draft-night
  reminder say so in one phrase, `PLAYER_SIGNUPS_OPEN_UNTIL`
  (`season-copy.ts`); never promise signups run until draft night.
- **`capacityInfo` is display only, never a gate.** Keep `extra`, `leftover`,
  `toNextTeam` and `nextTeamTarget` uncapped: past the minimum the SIGNUPS
  home card (`src/components/home/signups-view.tsx`) counts toward the next
  team, because "31 / 30" over a full bar reads as sold out to the person
  deciding whether to join. Scale that bar on `nextTeamTarget`, never
  `leftover / perTeam` (empty at an exact multiple). See it with
  `npm run fixture:signups`.

## Medal-checked MMR

- **Judge a claim against the medal's window** (`rank.ts`, pure).
  `mmrRangeForRankTier` is the exact star band (154/star, 770/medal to Ancient;
  Divine stars 200; Immortal from 5620) padded evenly to `MMR_WINDOW_MAX`.
  `clampMmrToRank` snaps any claim outside the window to its FLOOR: an
  over-claim drops to it, and an under-claim or a blank (0) rises to it. No
  medal, no clamp. `rankTierExactMinMmr` (unpadded) is for eligibility.
  `approxRankTierFromMmr` shares the constants, and `rank.test.ts` pins that
  the two never disagree.
- **Keep `saveRegistration`'s order:** fetch a brand-new signup's missing
  medal, then gate the RAW claim plus medal, then clamp and store. Never gate
  the clamped value: the clamp snaps under the ceiling, so any overstated
  claim would pass.
- **Judge the medal only at admission.** A medal whose exact floor clears the
  ceiling (Divine 3+/Immortal, `medalProvesIneligible`) refuses a new signup
  whatever is typed; an ACTIVE registrant is exempt (WITHDRAWN or REMOVED
  returning is a new admission). A later-synced medal is warn-only: re-judging
  it would lock an admitted player out of their own form. The typed MMR is
  checked every submit. Late medals show in the "Refresh player data now"
  toast and the "MMR ≠ medal" flag; nothing auto-removes anyone.
- **A stored registration MMR is league-approved.** Never re-clamp an unchanged
  resubmit, so an admin correction survives a role edit. `setRegistrationMmr`
  and `setPlayerRank` (`admin-roster.ts`) are the never-clamped escape hatch,
  adding only a "heads up"; a manual medal (`User.rankTierManual`) beats every
  automatic write. Inhouse `joinQueue` also trusts it as-is (`inhouse.md`).
- **Never rewrite a typed number silently.** `/me` shows the medal window
  (`mmrLeadLine`), a danger line when the medal rules the player out, and a
  display-only preview (`mmrPreviewLine`); the toast names any change. A
  running auction freezes a PLAYER's MMR (`draft.md`). Tests: `rank.test.ts`,
  `registration.test.ts`, `registration.itest.ts`, `inhouse.itest.ts`.

## Returning players

- **Prefill from the newest earlier signup** under a "Welcome back" note, but
  never pre-select Standin for a former standin. `isRegistered` and badges key
  off the active season only. The one-tap `ReturningJoinCard` posts to
  `saveRegistration`, so every rule runs; no card when the medal or last
  season's MMR is over the ceiling.

## Pool scouting (`/players`)

Grid, filter and URL rules: `pages-and-ui.md`.

- **Gate every token on data presence, never season phase.** No data renders
  the plain pool; a player with no data gets no token.
- **Keep `PoolPlayer` and `PoolSort` frozen** (the draft room shares them); add
  scouting to the parallel `PoolScoutInfo`. Phrase each fact once
  (`inhouseToken`, `pubToken`, `lastSeasonToken` and their `*Title` hovers in
  `player-pool.ts`). Pass the server `now` so SSR and hydration agree.
- **Inhouse record** comes from `loadInhouseLadder` (in-process memo, 60s TTL,
  dropped when the result cursor moves, `resetInhouseLadderCache` seam), not
  `unstable_cache`: inhouse games never bust `"games"`. A 5.5rem column at lg+
  only (a sixth md track truncates names), a meta-line token below.
  Provisionals are dimmed, unranked, `· Ng`; no games is an empty cell.
- **"Sort: Inhouse" stays component-local** (`PoolSortEx`), or the draft room
  gets a phantom control. `sortByInhouseRecord` orders by ladder rank, which
  carries the full tiebreak (rating alone shows #5 above #4).
- **Pub snapshot:** `User.pubStats` (JSON; read only via `parsePubStats`) +
  `pubStatsAt`. `fetchPubStats` needs both `/wl?limit=100` and `/heroes`, with
  the `fetchRankTier` ok:false contract (unreachable is not "no games").
- **Name the window and the snapshot age** ("Pubs 54% in last 100 · checked 3d
  ago"; the window is what OpenDota could see). Never show a lifetime games
  figure. An empty window renders nothing, never "0% of 0". Measure "last
  played" at snapshot time and only while fresh (`pubLastPlayed`); quiet past
  `PUB_QUIET_DAYS`. Profiles reuse the token, and their heroes card shows the
  top-5 pub heroes even with no league games.
- **Keep pub heroes apart from favorite heroes.** Pool rows show the top 3
  most-played pub heroes from OpenDota's `/heroes` (`poolPubRecord` slices
  `topHeroes`; `PubHeroStrip` in `player-pool.tsx`); the self-typed favorite
  heroes keep their own column. One is what a player plays, the other what
  they claim, so never merge or substitute them. On a phone both icon strips
  share one row, so keep the visible "Most played (pubs)" label: it is the only
  thing that tells them apart.
- **Last league season** (`loadPoolLastSeasons`): team, record, price, title
  from seasons created before the active one, from the Seasons card's facts.
- **Show "no Discord" only to viewers allowed contact:** handles are blanked
  for others, so the row can't tell hidden from missing. Pool: `showContact`
  from `canViewLeagueDirectoryContact`; profile: `canViewLeagueContact`
  (`src/lib/visibility.ts`).
- **Capture pub stats where medals are captured:** login (`ensurePubStats`,
  missing-only so login never pays a recurring call), `/me` link and refresh,
  and the player data refreshes (`results-and-opendota.md`). Never overwrite on
  a failed fetch. Every write re-asserts both Dota-link columns
  (`dotaAccountLinkSnapshot`), the login fill also `pubStatsAt: null`. Raced in
  `rank-sync.itest.ts`.
- **Cap pub fetches per manual run:** a snapshot is 2 OpenDota calls on top of
  the medal's 1 against ~60/min, so an uncapped sweep hits 429s and can fake an
  outage. The manual refresh does every signup's medal but only the stalest
  `PUB_SYNC_MAX_PER_RUN` snapshots; the hourly pass takes the rest.
- **Coverage limit:** no test renders the scouting cells; check them at
  390/768/1024/1440 with `npm run fixture:signups`.

## Profile Seasons card (`/players/[id]`)

- **Build it from three separate records, never today's roster**
  (`profileSeasonRows`, `docs/HISTORICAL-PARTICIPATION.md`): appearances
  (`appearanceCareers`), roster tenures (`getRosterHistory`), and cover on
  COMPLETED matches. One row per season and team; the record counts only
  series the player appeared in. Voided tenures (`DRAFT_UNDO`, `DRAFT_ABORT`,
  `PRE_DRAFT_TEAM_REMOVED`) never make a row. The trophy needs the resolved
  champion (`resolveChampionPresentation`) and a real part in it.

## Player comparison (`/players/compare`)

- **A plain GET form** (`?a=&b=`): `meetings` and `sharedSeries`
  (`compare.ts`), and `summarizePlayerGames` over every season (fewer deaths is
  better, games never judged, no edge without games).
- **Only players with a trusted imported 5v5 line are selectable;** the
  profile's "Compare vs…" link shows only for them. `compareDefaults` fills an
  empty slot with the viewer, never a slot the URL named. Read `?a`/`?b` with
  `singleSearchParam`, so a repeated key is "unavailable", not a Prisma array.

## Team identity

- **One service for both doors:** `saveTeamIdentity`
  (`team-identity-service.ts`, Serializable, seam `teamIdentity.save.beforeTx`,
  `team-identity.itest.ts`) behind the captain's `editTeamIdentity`
  (`src/app/actions/teams.ts`) and admin `renameTeam` (`admin-roster.ts`).
  Captains edit in the active season until COMPLETE; `canEditTeamIdentity` is
  the render rule the service also enforces.
- **Authorize in the WHERE:** the captain's `updateMany` re-asserts
  `captainId`, so a captain who lost the armband mid-edit can't rename. The
  admin write is a separate `updateMany` so the ratchet can gate the captain's.
- **Names are unique by how they read** (`teamNameKey` ignores case,
  invisibles, accents and look-alike letters). Logos must be permanent images
  (`normalizeTeamLogoUrl` refuses expiring Discord attachments and `/api`).
- **Log every change and post every rename;** expire `"games"` and stamp the
  result cursor (record matchups embed names). Only a captain's logo-only
  change is throttled (`TEAM_IDENTITY_PING_THROTTLE_SECONDS`), and says so.
- **Crest colours** (`team-hues.ts`) split each season's wheel evenly in
  creation order, published as one layout stylesheet keyed by team id
  (`getTeamHueStyleSheet`), so no caller passes a hue. A failure or a newer
  team falls back to the hash hue.
- **Jerseys follow the team id, never the name** (`getTeamJersey`), since
  renames are open all season. Fixtures fall back to `JERSEY_ROSTER_MATCH_MIN`
  of the set's five players by Steam name (a majority, so no two teams match).
  US league only.
