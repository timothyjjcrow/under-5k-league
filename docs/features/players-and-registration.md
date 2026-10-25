# Players, registration and team identity

Joining a GGD2L season on `/me`, the Discord a signup needs, medal-checked
MMR, the uncapped pool and its `/players` scouting rows, the profile Seasons
card, `/players/compare`, and team names, logos, crest colours and jerseys.
Main files: `saveRegistration` (`src/app/actions/registration.ts`),
`src/lib/registration.ts`, `signup-discord.ts`, `rank.ts`, `capacity.ts`,
`player-pool.ts`, `pub-stats.ts`, `team-identity*.ts`.

## Who can sign up

- **The soft MMR limit never blocks.** `Season.maxMmr` (0 = none) is a review
  threshold; only `HARD_MMR_CEILING` refuses anyone (`registrationGate`). The
  review tool is the "over soft limit" flag (`signupFlags`,
  `signup-readiness.ts`), and no copy may say the limit refuses signups
  (`admin-copy-guard.test.ts`). Set with `setMaxMmr` (`admin-season.ts`); new
  seasons copy it (`carriedSeasonSettings`).
- **Signups are uncapped; `Season.minTeams` is a goal, not a gate.** `registrationGate`
  judges the ceiling, the medal and the phase, never a count (PLAYER signups
  open only in SIGNUPS, standins through the playoffs, COMPLETE freezes all).
  `startDraft` makes one team per captain, so the admin settles the count by
  naming captains: short pool = seats for standins, long pool = free agents.
  Because teams are captains, Home's "Who's in" says how many players have
  offered to captain against the teams the season wants, and the Discord
  signup post says "signed up and offered to captain" for a new volunteer.
  `seatFitSentence` (`draft-setup.ts`) says which before the click.
- **Nothing closes signups on a clock;** an admin does (Close signups or Start
  draft), sometimes days before draft night. Home and the draft-night
  reminder say so in one phrase, `PLAYER_SIGNUPS_OPEN_UNTIL`
  (`season-copy.ts`); never promise signups run until draft night.
- **`capacityInfo` is display only, never a gate,** and `minTeams` is the
  season's team GOAL, never a minimum: Start draft needs only two captains.
  So players read "N more to reach the 10-team goal" (Home's hero),
  "{n}-team goal met" once it is, and the Discord signup post says "enough
  for 6 teams; 19 more reaches the 10-team goal" (`signupMessage`). "N more to
  reach the player minimum" and "N more to start the draft" promised a block
  the draft doesn't have. Past the goal, Home counts toward the next team
  (`toNextTeam`, kept uncapped). See it with `npm run fixture:signups`.
- **A soft MMR limit at or above the hard ceiling is no soft limit**
  (`effectiveSoftMmrLimit`): it flags nobody, so How it works, /rules, /me's
  MMR line and Home's signup card don't print it. Season 2's limit sat at
  5,000, and How it works said 5,000 MMR players can join and that above
  5,000 an admin reviews them. The admin hint says it flags nobody.

## Discord before a signup

- **A new signup needs a linked Discord account in the league's server**
  (Tim's call, 2026-10-19: players signed up whom nobody could reach).
  `signupDiscordBlocker` (`src/lib/signup-discord.ts`, pure) is the rule: the
  link wherever accounts can be linked (`discordLinkingConfigured`), and
  "member" wherever the bot can look the account up (`getGuildConfig`).
  Pending (Membership Screening) is not enough: nothing can reach a pending
  member. `signupDiscordPolicy` (`discord-roles.ts`) reads the deployment for
  both the action and /me, so the page never shows a form the action refuses.
- **Judge it at admission only** (`signupDiscordJudged`): no signup yet, or a
  WITHDRAWN one coming back, standins included. An ACTIVE signup keeps
  editing (admitted before the rule, or unlinked since: /me's next-steps list
  asks for the link again, and nothing removes them), and a REMOVED one gets
  the write's own refusal. Admin reinstatements never pass through it.
- **Unknown never blocks.** A Discord that doesn't answer, or a bot gone from
  the server (Unknown Guild), lets a linked player through, so an outage or a
  kicked bot can't close signups; the admin reach card counts who couldn't be
  checked.
- **Read it live in the action, before the OpenDota fetch**
  (`signupDiscordStanding`: one member GET, primed into the memo), so a player
  who just joined with the invite isn't refused by a memo's 30-second
  "not-member", and a refused submit spends nothing. The account it judged is
  re-read inside the write's transaction (`RegistrationDiscordChangedError`),
  so an unlink or a re-link mid-submit can't admit an account nobody checked.
  A refusal revalidates /me, so a stale page turns into the step.
- **/me shows the steps to join: Steam, Discord, then the signup**
  (`signupChecklist`, `<SignupChecklist>`; Tim's call, 2026-10-19). Steam is
  done (they're signed in). The Discord step carries the real buttons ("Link
  Discord & join the server", or the join and invite buttons, with "Check
  again" after an invite join or accepting the rules), one plain sentence
  on why ("so teams and admins can contact you about the league"; Tim's
  call: no ids, tokens or scopes here, since the button says it joins the
  server and Discord's own screen says the rest) and the callback's
  `?discord=` note.
  The signup step opens the form, and the returning one-tap card, under it
  once Discord is done, never beside an unfinished step: linking is a
  full-page round trip, so a half-filled form would be lost. A first version
  only pointed at the Discord card ("Link your Discord ↓"), which made new
  players click twice in two places. Now the Discord card leaves its buttons,
  note and typed-handle fallback to the steps and points to step 2
  (`signupOwnsDiscord`), so each action has one button on the page. Unlinked,
  and linked with no bot to ask, are known at render; a linked player's
  Discord step shows "checking" behind `<Suspense>` until the page's one
  member lookup answers, never the form (a form swapped out mid-typing loses
  its answers), and an unknown answer counts as done without claiming the
  server. **Keep the steps and the form in two fixed slots in every state**
  (`SignupDiscordGate` in `src/app/me/page.tsx`, source-guarded): a first
  signup turns the steps off, and a form that moved in the tree remounted
  with its open editor and "Saved" collapsed (#90 shipped that for a player
  the bot checked). How it works' first step says what a signup needs here
  (`signupStepDetail`).
- **Tests:** `signup-discord.test.ts` (the rule, the copy, and source guards on
  the action's order and the /me wrap), `signup-checklist.test.ts` (the
  steps' controls and states), `account-discord-card.test.ts` (the card's
  `signupOwnsDiscord` mode), `test/integration/signup-discord.itest.ts`
  (the real action over HTTP to a stand-in member route, with the seams), and
  the mid-season e2e, which links accounts (`signed-in.spec.ts`,
  `quality-of-life.spec.ts`).

## Medal-checked MMR

- **Judge a claim against the medal's window** (`rank.ts`, pure).
  `mmrRangeForRankTier` is the exact star band (154/star, 770/medal to Ancient;
  Divine stars 200; Immortal from 5620) padded evenly to `MMR_WINDOW_MAX`.
  `clampMmrToRank` snaps any claim outside the window to its FLOOR: an
  over-claim drops to it, and an under-claim or a blank (0) rises to it. No
  medal, no clamp. `rankTierExactMinMmr` (unpadded) is for eligibility.
  `approxRankTierFromMmr` shares the constants, and `rank.test.ts` pins that
  the two never disagree.
- **Keep `saveRegistration`'s order:** gate what no medal could change (the
  ceiling, closed player signups) with the medal on file, then an admission's
  Discord ([above](#discord-before-a-signup)), fetch a brand-new signup's
  missing medal, then gate the RAW claim plus medal, then clamp and store. Never gate the clamped value: the clamp snaps under the ceiling, so
  any overstated claim would pass. The early gate comes before the fetch
  because a refused submit stores nothing: every retry used to call OpenDota
  again. The fetch also takes the player's `open-dota-profile` cooldown (the
  one Refresh my Steam & Dota info uses); inside it the signup saves without
  a medal and the hourly player data refresh fills it in.
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
  automatic write. Inhouse `joinQueue` also trusts it as-is, up to the
  ceiling, and judges the medal on every join, a signup's included
  (`inhouse.md`, "The MMR cap"). An admin's inhouse MMR beats it at the
  queue, and `/admin/inhouse-players` sets the same manual medal for anyone,
  a player with no signup or any player once the season is over, when
  `setPlayerRank` refuses (`inhouse.md`, "An admin's inhouse MMR and
  medal").
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

## Invite credit

- **The small version (Tim's pick, 2026-10-06; `src/lib/invite-credit.ts`):**
  a signed-up player's "Copy invite link" (`<InviteLink refId>`, on Home's
  "You're in" panel and on /me) copies `/?ref=<their user id>`.
  `InviteRefCapture`, in the root layout, remembers the tag in the
  `ggd2l_ref` cookie for 30 days, keeps the first link (a later tag never
  replaces it), and takes `ref` out of the address bar. It writes the cookie
  in the page on purpose: a GET that set it would also run for an `<img>`,
  so any picture URL could claim credit for its viewers
  (`invite-credit-guards.test.ts`).
- **A new signup consumes the tag** (`takeInviteRef`, after the commit),
  credited or not. A new full player's Discord signup post then reads "📝
  **Zai** signed up (invited by Borpo) — …" (`inviterForSignup`): only when
  the new player has no signup in any other season, the inviter holds an
  ACTIVE signup in this season, and they aren't the same person. The lookup
  is best-effort and never fails the signup. The inviter's name is escaped
  and never mentioned; nothing is stored, so there are no counts anywhere.
  `test/integration/invite-credit.itest.ts` drives the real action.

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
  `pubStatsAt`. `fetchPubStats` needs all three of `/wl?limit=100`, `/heroes`
  and `/matches?limit=100&significant=0` (projected to the six fields
  `PUB_MATCH_FIELDS` reads), with the `fetchRankTier` ok:false contract
  (unreachable is not "no games").
- **The pub scouting report is stored as counts, never rows** (`scout`,
  `src/lib/pub-scout.ts`; Tim asked on 2026-10-21 for something captains can
  read, then for it to say more and say it plainly): their last 100 games of
  every mode (`significant=0`, or Turbo never shows) with the fields in
  `PUB_MATCH_FIELDS`, folded by `summarizePubMatches` into one versioned
  object (`v`). Each read needs `PUB_READ_MIN_GAMES` games (positions
  `PUB_POSITION_MIN_GAMES`) or shows nothing.
  - **Say it as findings, not numbers** (`scoutingFacts`): each line is a
    label, a plain lead ("Core in 79 of 92 games"), what it rests on or is
    set against, and a tone: `good` agrees with the signup, `warn` is worth
    a second look (tinted, never a verdict), `info` is context.
  - **Role** is last hits a minute in ranked or normal matchmaking games of
    10+ minutes: 3.5+ core, under 2.5 support, between is neither. It is set
    beside the signup's side (`claimedRoleLean`, `roleClaimDiffers`).
    **Lanes** name positions where OpenDota parsed the game (about a fifth of
    pubs): a core's lane is 1, 2 or 3, a support's partner lane 5 or 4.
  - **"Plays at" is the mean of each game's average medal,** ranked games
    only once there are ten (unranked games with friends drag it down by
    up to a medal), shown with its medal and set against the signup MMR
    (`LOBBY_GAP_MMR`) and the medal (a full medal below the games: "may be
    out of date"). Never show OpenDota's own `computed_mmr`: across 13
    league players it sat at 3,850–4,350 whatever the medal (3,915 for a
    Guardian 1, 4,051 for a Herald 5, 4,038 for a Divine 1).
  - **Habits:** modes (Turbo a third or more warns: the rest rests on few
    real games), solo or party, main server (outside the league's home
    regions warns: ask about ping; `regionForCluster` maps Valve's cluster
    through its tens), form (last 20 and a last-10 strip), activity as a
    pace ("About 2 games a day", never a total) and early leaves (two or
    more warns).
  - **Recent heroes and how they play:** the top heroes of the window with
    W–L and KDA (`pubHeroRows`), and per-role averages (last hits a minute,
    GPM, K/D/A) for a role with five or more games.
  - **A snapshot without the current version is due at once**
    (`pubStatsDue`: no `PUB_SCOUT_MARKER` in the blob, which carries the
    version), in the hourly pass's SQL and the admin button, so the next
    passes upgrade signups first. `parsePubScout` reads an older version as
    unknown, so nothing half-shaped renders meanwhile.
  - **Shown where the W/L token is,** for an ACTIVE signup only: the pool
    row's line (`scoutingRowParts`: "plays Pos 3 · in Ancient 5 games ·
    solo · US East", warnings tinted, each fact unbreakable, every finding
    in the hover) with "Recent pubs" heroes from the window in place of the
    all-time strip, and the profile's "Pub scouting" card
    (`profile-pub-scouting.tsx`), first in the "Player profile" band. The
    hero pool's all-time list says "all time".
  - **Keep the card small** (Tim, 2026-10-21: the first report's list of
    rows took too much space). It is a grid of tiles (`scoutingTiles`: a
    label, a few-word lead, a one-line note, the full finding as the hover),
    `auto-fit` so it is two across in the rail and on a phone and one row
    across a new player's main column; an odd last tile takes its row in a
    narrow column. Recent heroes are one strip of icons with games and win
    rate; the role averages and how it is read sit behind "More". Notes wrap
    rather than truncate: a phone has no hover. A Turbo-only account has an
    empty W/L window but still a scouting line (`poolPubRecord`;
    `pubHasWindow` gates the W/L token).
- **Name the window and the snapshot age** ("Pubs 54% in last 100 · checked 3d
  ago"; the window is what OpenDota could see). Never show a lifetime games
  figure. An empty window renders nothing, never "0% of 0". Measure "last
  played" at snapshot time and only while fresh (`pubLastPlayed`); quiet past
  `PUB_QUIET_DAYS`. Profiles reuse the token, and their heroes card shows the
  top-5 pub heroes even with no league games.
- **Keep pub heroes apart from favorite heroes.** Pool rows show the top 3
  heroes of their last 100 games ("Recent pubs", from the scouting report),
  or the all-time most-played from OpenDota's `/heroes` until the snapshot
  has a report (`poolPubRecord` slices `topHeroes`; `PubHeroStrip` in
  `player-pool.tsx`); the self-typed favorite
  heroes keep their own column. One is what a player plays, the other what
  they claim, so never merge or substitute them. On a phone both icon strips
  share one row, so keep the visible "Recent pubs" (or "Most played (pubs)")
  label: it is the only thing that tells them apart.
- **Last league season** (`loadPoolLastSeasons`): team, record, price, title
  from seasons created before the active one, from the Seasons card's facts.
  The appearances come from the Hall of Fame's cached career facts
  (`getCareerFacts`), so a pool view decodes no box score; results and
  champions are its own reads.
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
- **The draft room shows the same facts** for the player on the block and
  for any pool row tapped open, phrased by the same helpers through
  `draftCardView` (`src/lib/draft-scout.ts`), from a map the `/draft` render
  builds: the profile's tiles (`ScoutTileGrid`), "Recent pubs" kept apart
  from "Favorite heroes", and every finding in full under "More scouting"
  ([draft](draft.md#the-draft-room-client)).
- **Coverage limit:** no test renders the scouting cells; check them at
  390/768/1024/1440 with `npm run fixture:signups`.

## Profile Seasons card (`/players/[id]`)

- **Build it from three separate records, never today's roster**
  (`profileSeasonRows`, `docs/HISTORICAL-PARTICIPATION.md`): appearances
  (`appearanceCareers`), roster tenures (`getRosterHistory`), and cover on
  COMPLETED matches. One row per season and team; the record counts only
  series the player appeared in. Voided tenures (`DRAFT_UNDO`, `DRAFT_ABORT`,
  `PRE_DRAFT_TEAM_REMOVED`, `PRE_DRAFT_CAPTAIN_CHANGED`) never make a row and
  never decide a row's role, so a captain swapped out before the draft shows
  no Captain badge for that team. Add any new end reason that means "never
  really on this team" to `VOID_TENURE_ENDS`. The trophy needs the resolved
  champion (`resolveChampionPresentation`) and a real part in it.
- **Load the rows through `loadProfileSeasonRows`**
  (`profile-season-history.ts`): the profile and its link picture both call
  it, so the Seasons card, the season card and the picture can't disagree.

## Player season card (`/players/[id]` header and link picture)

- **One pure rule draws the card and the picture:** `playerCardFacts`
  (`src/lib/player-card.ts`). The profile computes it once and hands it to
  `ProfileHeader`, which renders `PlayerSeasonCard`; the picture's
  `loadPlayerCardFacts` (`link-preview-metadata.ts`) makes the same reads. Both
  fold their games through `profileGameRows` and `profileGameFolds`
  (`profile-games.ts`), so badges, report card and heroes are counted once.
  `player-season-card.test.ts` and `profile-games.test.ts` guard the wiring.
- **The season is the active one while they are in it** (an ACTIVE signup or
  a roster spot), else their latest Seasons-card row, a title first within that
  season. A past season's team comes from those rows, never today's roster.
  Today's roster decides Captain (a handover moves the armband); the tenure
  decides how they joined ("Drafted for $X", "Signed as a free agent"). A
  season spent only standing in says "Stood in for X" and wears no crest or
  colour: it was never their team.
- **MMR shows only from an ACTIVE signup in the active season,** the header's
  rule before the card. The medal shows only when known; unknown is left out,
  never "Unranked".
- **Heroes are what they play, never what they claim:** up to three, league
  most-played first, then pub heroes marked "pubs". None until they have a
  league game, so a card with no games shows its medal and MMR only.
- **The grade is the career report card's overall grade** through
  `reportVerdicts(report, false)` (as a visitor sees it, so no "Work on"),
  only once it has enough graded games. "Strength:" names the best metric.
- **Say "Career" on what spans every season:** the card is headed with one
  season's name, so its grade and heroes read "Career grade" and "Career
  heroes", and the picture's chip "Career grade A".
- **Honors are Match MVPs and league records held.** Titles are the
  picture's gold chips: the newest, then "+N more titles".
- **Titles are badges beside the name on the profile:** "Season N champion",
  newest first, three and then "+N more" (the rest named for screen readers).
  The card doesn't repeat them.
- **Say each fact once.** The card owns the medal and MMR; the role line drops
  a live Captain or Standin the name row already badges
  (`profileCardRoleText`); the season name under the player's name shows only
  when the card names no season.
- **No contact detail of any kind, not even whether one exists:** the picture
  is public and travels wherever the link is pasted. `player-card.test.ts`
  pins the facts' exact keys.

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
- **A stale form can't revert a newer edit.** The form posts the whole
  identity, so `TeamIdentityForm` also sends the name and logo it was rendered
  with (`expectedName`, `expectedLogoUrl`), and `saveTeamIdentity` refuses
  ("changed since you opened this form") when they no longer match the row it
  reads and then writes in the same Serializable transaction. Both doors send
  them; a post without both (a tab from before the fields) is unchecked.
- **Names are unique by how they read** (`teamNameKey` ignores case,
  invisibles, accents and look-alike letters). Logos must be permanent images
  (`normalizeTeamLogoUrl` refuses expiring Discord attachments and `/api`).
- **A captain's new logo must be on Imgur or the site** (`isCaptainLogoHost`,
  checked in `saveTeamIdentity` after the captain claim). Every visitor's
  browser loads the crest, so a captain's own server would see their IPs and
  could swap the image with no save to log. Only a CHANGED logo is checked (the
  form re-posts the current one, which an admin may have set elsewhere), and
  admins may use any HTTPS host. No CSP `img-src`: it would block admin logos,
  news media, Steam avatars and hero art.
- **Log every change and post every rename;** expire `"games"` and stamp the
  result cursor (record matchups embed names). Only a captain's logo-only
  change is throttled (`TEAM_IDENTITY_PING_THROTTLE_SECONDS`), and says so.
- **Limit how often a captain renames, not which renames post:** a captain's
  rename first claims `teamRename:<team>` (`TEAM_RENAME_THROTTLE_SECONDS`,
  2 minutes, `claimThrottle`) and is refused with a plain error inside it.
  Every rename that saves still posts; without the limit, one captain flipping
  names queues a post per submit ahead of every result and reminder in the
  ordered league outbox. Only the team's own captain claims (anyone else is
  refused by the service anyway), the claim is given back (value-scoped) when
  no rename happens, and logo-only edits and admins never take it.
- **Crest colours** (`team-hues.ts`) split each season's wheel evenly in
  creation order, published as one layout stylesheet keyed by team id
  (`getTeamHueStyleSheet`), so no caller passes a hue. A failure or a newer
  team falls back to the hash hue.
- **Jerseys follow the team id, never the name** (`getTeamJersey`), since
  renames are open all season. Fixtures fall back to `JERSEY_ROSTER_MATCH_MIN`
  of the set's five players by Steam name (a majority, so no two teams match).
  US league only.
