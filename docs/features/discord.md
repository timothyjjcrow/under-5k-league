# Discord integration

League announcements (webhook plus a durable outbox), inhouse alerts and the
pinned inhouse queue board, the small bot behind the ping role and membership
checks, and Discord account linking. Main files: `src/lib/discord.ts`
(formatters, transport), `league-announcement-outbox.ts` + `league-delivery.ts`,
`discord-payload.ts`, `discord-escape.ts`, `discord-mentions.ts`,
`inhouse-board.ts` + `inhouse-board-service.ts`, `discord-roles.ts` (bot),
`discord-reach.ts`, `discord-oauth.ts` + `discord-link-service.ts`. Admin
actions: `src/app/actions/admin-discord.ts`.

## Rules for the whole area

- **Never send a Discord credential to the browser, a log or an admin page.**
  Webhook URLs, the bot token and the client secret are bearer credentials.
  The admin card shows a boolean plus `maskWebhookUrl`'s fingerprint; webhook
  inputs start empty (no `defaultValue`), so a blank submit is a no-op and
  turning one off is the explicit Remove action (`clearDiscordWebhook` etc.).
  An env-only webhook shows a note and hides Remove (clearing the DB key can't
  touch env). Bot token and guild are env only (`DISCORD_BOT_TOKEN`,
  `DISCORD_GUILD_ID`) so no page can read a token back.
- **Put every Discord write behind `discordMutationsAllowed()`**
  (`discord-mutation-policy.ts`). Vercel previews may carry production
  credentials, so posts, edits, deletes, role changes, joins and outbox
  enqueues refuse there; reads still work.
- **Branch on `res.ok`, and on the body's `code` where a status is
  ambiguous.** Discord errors are valid JSON, so a parsed body proves nothing.
  `GET /guilds/{g}/members/@me` is not a route (400 "not snowflake"): a bot
  reads its roles via `GET /users/@me`, then `GET /guilds/{g}/members/{id}`.
- **Render unknown as unknown, never as a negative.** A null membership or role
  answer means Discord didn't say; show what the page shows without the check.
  A hiccup must never tell a player they left or an admin that ten are missing.
- **Read Discord state live; never mirror it into a column** (it drifts the
  moment someone changes it in Discord). Memo hot reads instead. Don't mirror
  rosters into per-team roles: mentioning who owes an answer does the same
  targeting with no reconcile debt.
- **Return the announcement; let the action send it after commit.** Services
  return `announcement` + `mentions` (or `notifyUserId`). Sends return a boolean
  and never throw, so a webhook failure can't touch the write.
- **Build `BigInt` from strings:** `permissions` is a string bitfield, so
  `BigInt("268435456")`, never `1n << 28n` (tsconfig targets ES2017).

## Webhooks and delivery

- **Three webhooks.** League: `discordWebhookUrl` / `DISCORD_WEBHOOK_URL`
  (`getWebhookUrl`). Board: `inhouseWebhookUrl` / `DISCORD_INHOUSE_WEBHOOK_URL`
  (`getInhouseWebhookUrl`, falls back to league). Inhouse alerts (queue ping,
  match found, results, voids): `inhouseAlertWebhookUrl` /
  `DISCORD_INHOUSE_ALERT_WEBHOOK_URL` (`getInhouseAlertWebhookUrl`, falls back
  to board, then league). The board is read from the bottom of its channel and
  one alert under it pushes it out of view; changing the alert webhook never
  touches the board.
- **League posts go through the durable outbox.** `sendDiscordMessage` queues
  the row, returns true, and makes one attempt; the worker's
  `deliverPendingLeagueAnnouncements` drains in order. `discordRefusalKind`
  (`league-delivery.ts`): 400/413 drops that post; 401/403/404 and a
  forum-channel 400 (codes 220001-220004) mean the webhook refused, so the queue
  pauses until an admin saves a working webhook or a test post succeeds (both
  call `resumeLeagueAnnouncements`); anything else backs off.
- **Drop stale posts instead of sending them late.** `expiresAt` for deadlines
  (week reminders); `expiryGroup` for event-bound posts (the live draft's
  `draftLiveAnnouncementGroup`, expired by `expireLeagueAnnouncementGroup` when
  the draft ends). On hot paths pass `afterResponse: true` so the request never
  waits on Discord. The Discord card and Needs attention
  (`leagueDeliveryAttention`) show queue health; Discard drops only posts up to
  the newest one the admin saw.
- **Three sends skip the league outbox.** `durable: false` (the webhook test
  must report this attempt); news (`postNewsToDiscord` needs the message id to
  edit or delete; it pings @everyone only when the admin ticks the box, and
  edits never re-ping); inhouse alerts (`sendInhouseDiscordMessage`, direct and
  best-effort). Inhouse results and voids have their own outbox
  (`inhouse-announcement-outbox.ts`, see `docs/features/inhouse.md`).
- **Pin API v10** (`webhookApiUrl`); unversioned routes ride deprecated v6.
  **Validate URLs with `normalizeDiscordWebhookUrl`**; `runtimeWebhookUrl`'s
  loopback exception is test-only, never widen it.

## Writing messages

- **Escape every player and team name with `escapeDiscordText`**
  (`discord-escape.ts`, `name` in `discord.ts`). Webhook messages render
  markdown and do NOT suppress masked links, so a persona of
  `[free mmr](https://evil.test)` becomes a league-looking link. It strips
  newlines first (they would forge rows in one-per-line lists), escapes `<>`
  (no fake `<t:...>` or `<@id>`) and breaks bare URLs with a zero-width space.
  Don't escape admin-authored text (news, season names) or `<@id>` markup.
  `discord.test.ts` sweeps the formatters for `](`.
- **Wrap site links in `<angle brackets>`** to stop a huge unfurl card; only
  `newsMessage`'s media URL stays bare, so the GIF embeds.
- **Write times as `<t:epoch:F|R|T>`**, never formatted strings, and keep
  content within 2,000 characters (`isValidDiscordContent` checks the exact
  rendered text).

## Mentions

- **Send `allowed_mentions: { parse: [] }` always; ping only server-chosen
  ids** through `MentionAllowlist` (`{ roles?, users? }`, `discord-payload.ts`),
  so a persona of "@everyone" stays inert. Ids are normalized to snowflakes
  (max 100), and `materializeAllowedMentions` prepends any listed id missing
  from the text (Discord honours only tokens present). Never put "roles" or
  "users" in `parse` beside the arrays; Discord rejects that.
- **Mention the person who must act, and nobody else** (a ping people can't act
  on gets the channel muted). OUT or "can make it after all": their captain,
  never about their own answer. Standin booked or removed: the standin, plus
  the covered captain when someone else acted. Reschedule proposed: the other
  captain; accepted: the proposer and booked standins (their ping quoted the old
  time); declined: the proposer. Week reminder: unanswered players only
  (`unansweredUserIds`). Free-agent signing or release: that player. Draft
  started (`draftStartedAnnouncement`, sent by `startDraft`): the linked
  captains only, in draft order, unlinked captains named in plain text; a
  captain who misses the start loses turns to auto-nomination, while everyone
  else only needs the link.
- **Use `mentionsOf` / `mentionUsers`, never hand-rolled lists.** `mentionsOf`
  drops nulls and returns `undefined` when empty, so an unlinked league sends
  the same text as before (`{ users: [undefined] }` fails silently).
  `mentionUsers` costs a query: mutation paths only. Only the OAuth-proven
  `discordId` is mentionable, never the typed `discordName`.
- **Send standin assign/remove posts from all four sites:** `standins.ts` and
  `admin-roster.ts`, twice each. Stand-down paths:
  `docs/features/rosters-and-standins.md`.
- **Throttle the OUT ping.** `setAvailability` also claims
  `outPingThrottleKey` (`claimThrottle`, `RSVP_OUT_PING_THROTTLE_SECONDS`)
  because the prior-status check misses OUT, IN, OUT; "I'm away" shares the
  key. An IN after an announced OUT posts `playerBackInMessage` via
  `claimThrottleAnswer`, which deletes the OUT row (a later OUT is news again)
  and claims `outBackPingThrottleKey`: at most three buzzes per window
  (`availability.itest.ts`).

## Announcements that post once

- **Find senders:** `grep -rn "sendDiscordMessage(\|sendInhouseDiscordMessage(" src`.
- **Claim a marker first.** `claimAnnouncementMarker` (`announcement-marker.ts`)
  leases the Setting row; a failed send stamps `failed:v2:` and the throttled
  `retryFailedAnnouncements` sweep (`result-sync-service.ts`) re-claims only
  those (series results, champion, playoff rounds), since nothing else would
  re-trigger them. Marker values and keys are stored in production: change a
  format only with a migration, and build keys only via `settings.ts` helpers.
- **Check the webhook before you claim a marker.** With no league webhook, the
  week and draft reminders (`reminder-service.ts`), `announceChampionOnce`,
  `announceSignupsOpenOnce`, `announcePlayoffRoundOnce` and the result nudge
  return before `claimAnnouncementMarker`, so nothing is burned and a league
  that adds Discord later still gets the post. Series results are the
  deliberate exception (below). Pick one of the two on purpose for any new
  claim-then-send post.
- **Every decided series goes through `announceSeriesResultOnce`**
  (`match-import.ts`, marker `resultAnnounced:<matchId>`), admin
  `recordResult` included; it deletes the old marker in its result transaction
  so a corrected score is a new event. With no league webhook the marker is
  stamped `suppressed:no-webhook:`, so adding Discord later never replays old
  scores.
- **Draft completion posts once per run:** a teams post mentioning linked
  players, then the recap (`afterResponse`); single sales post nothing. A repeat
  completion after Undo posts plain names and no recap, gated by a Setting
  CREATE on `draftTeamsPingKey(season, runId)`, released if nothing was queued.
- **The queue ping fires only on an upward crossing** of
  `INHOUSE.QUEUE_PING_AT` present players, never on the lobby-forming join, at
  most once per `QUEUE_PING_MIN_MINUTES` (Setting `inhouseQueuePingAt`). It is
  low on purpose (the first queuers are invisible to anyone off the site); raise
  it if it cries wolf. It links `joinLink()` (`/inhouse?join=1`).
- **Lobby formed mentions all ten** (`maybeFormLobby`, after commit):
  `<@discordId>` if linked, escaped name otherwise, plus the accept deadline.
  Queueing is the consent; don't add an opt-out. One tabbed-away player burns
  the league's scarcest event on a short `INHOUSE.ACCEPT_SECONDS` clock.
- **Only the two interrupting posts carry the ping role** (queue filling, match
  found), never results or the board. `SETTING_KEYS.INHOUSE_PING_ROLE_ID` (env
  fallback `DISCORD_INHOUSE_ROLE_ID`; the admin field takes an id or `<@&id>`).
  Unset pings nobody. It must be self-assignable: an un-opt-out-able ping gets
  the channel muted.
- **`?join=1` auto-joins once per page load** (behind a ref), scrubs the param
  with `history.replaceState`, and defers `act()` a tick (state set inside an
  effect cascades a render). `autoJoinDecision` (`inhouse.ts`, tested): nothing
  signed out, "already in" if queued or in the lobby; a live lobby doesn't
  refuse, since the join is for the next game.

## The ping role and the bot

- **Keep the bot tiny.** `discord-roles.ts` is the only bot-token user: REST
  only, no gateway, process or slash commands. Discord has no self-assign
  toggle, so /me's `setInhousePingOptIn` calls `setPingRole` (PUT/DELETE
  `/guilds/{g}/members/{u}/roles/{r}`) on an OAuth-proven `discordId`. Missing
  token, guild or role hides the opt-in (`pingOptInAvailable`), never
  half-works.
- **`hasPingRole` returns `boolean | null`;** null is unknown (an unticked box
  for an opted-in player invites a click that changes nothing). **`forbidden`
  (403) is its own outcome:** the bot's role sits below the ping role, retrying
  never helps, so say that instead of blaming the click.
- **`canGrant` needs hierarchy AND permission:** the bot's highest role
  strictly above the target (equal is refused) and MANAGE_ROLES or
  ADMINISTRATOR (which doesn't bypass hierarchy); managed roles never.
- **`getPingHealth` names the first broken step, in fix order.** Missing env is
  reported without calling Discord. Bot checks need only token and guild, so
  they run without a ping role (supported; the checklist then explains an
  all-unknown funnel). It checks `canInvite` (CREATE_INSTANT_INVITE, for the
  join) and `appMatchesOauth` (a bot's user id is its app id; compared with
  `DISCORD_CLIENT_ID`). Print the raw role positions beside the verdict.
- **Strip the role when a link goes away.** `unlinkDiscord` reads the snowflake
  before clearing it, then best-effort `setPingRole(..., false)`, saying so in
  the toast if that failed (the off toggle shows only to linked players).
  Re-linking a DIFFERENT account: `linkDiscordAccount` returns
  `previousDiscordId`, and the callback's `stripPingRole` dep strips it after
  the link commits. Same-account re-links strip nothing.

## Account linking (OAuth)

- **Show contact info only through `src/lib/visibility.ts`.** `discordName` is
  the typed handle ("" = unset; `normalizeDiscordName`, `updateDiscordName`).
  The `<DiscordTag>` chip (pool, rosters, profiles, draft room) is for the
  subject, admins and active registrants (`canViewLeagueContact`), never merely
  a signed-in viewer.
- **Only the OAuth callback sets `User.discordId`.** It proves ownership;
  `<DiscordTag verified>` means ownership, never membership.
  `updateDiscordName` refuses while linked via an atomic
  `updateMany({ where: { id, discordId: null } })` (a read-then-write loses to
  the callback and puts a typed handle under the check mark). `unlinkDiscord`
  clears both fields.
- **Flow:** `/api/auth/discord` (session required; linking, not login), then
  `/api/auth/discord/callback`, a thin shell over `handleDiscordCallback`
  (`discord-link-service.ts`, `discord-link.itest.ts`). Pure helpers:
  `discord-oauth.ts` (RFC 7636 vector). The Link button needs
  `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET`.
- **Bind the flow to the user who started it.** The one-shot httpOnly cookie
  (`packOauthCookie`: `v2.<state>.<verifier>.<userId>[.<next>]`, 10 minutes,
  path `/` for `__Host-`) is checked for state AND session user before the code
  is spent (else `?discord=state`), so a sign-in swap in another tab can't take
  the identity. Older cookie shapes are refused.
- **Keep only id and username.** Tokens are exchanged server-side and dropped.
  The `@unique` on `discordId` is the collision guard (P2002 caught):
  `?discord=taken`.
- **Ask for the smallest scope:** `identify`, plus `guilds.join` only when a bot
  and guild are configured (`buildDiscordAuthUrl({ withGuildJoin })`); never
  email or the guild list. `discord-oauth.test.ts` pins both directions.
  `getGuildConfig` (token + guild) stays separate from `getRoleConfig`
  (+ role) so the join works on a server with no ping role.
- **`joinGuild` needs the bot token in the header AND the user's token in the
  body,** so it runs only inside the callback. `204` = already a member
  (success); `201` + `pending: true` = Membership Screening (`joined_pending`,
  not success); 403 = no CREATE_INSTANT_INVITE, or a token from a different
  app. Tested over real HTTP in `discord-roles.itest.ts` (the stand-in buffers
  the body); a mock can't catch a counter-intuitive status.
- **A failed join never fails the link.** The link commits first; join errors
  land on `?discord=join_failed`. The callback primes the membership memo with
  the join's answer.
- **Honour `?next=` only on full success.** `safeReturnPath` checks it at pack
  and unpack (the cookie is client-held). `oauthLandingPath` uses it only for
  `joined`/`linked`; every other code goes to `/me?discord=<code>`, the only
  page that renders and scrubs it. Dashboard cards pass `next="/"`. A
  half-filled signup form is still lost to the redirect.
- **Map only known `?discord=` codes** (`discordLinkNote`, `hasOwnProperty`, so
  `__proto__` gets the generic note); `<StripQueryParam param="discord">`
  scrubs it after render. The live membership answer beats the code.

## Guild membership and reach

- **Linking proves ownership; only membership makes a player reachable.**
  `fetchGuildMember` makes ONE GET for membership (member, pending, not-member)
  and roles; `guildMembership` and `hasPingRole` wrap it. Only 404 body codes
  10007/10013 mean not a member: 10004 (unknown guild, i.e. bot missing or
  wrong id) would otherwise nag the whole league. Anything else is null.
- **Memo hot reads with `memoGuildMembership`:** "member" for 5 minutes, the
  rest for 30 s (a non-member is mid-fix). It shares in-flight promises, never
  overwrites a fresher entry, and `primeMembershipMemo` ignores null. /me primes
  it after its live read so the dashboard agrees.
- **Pace the member route.** Read `X-RateLimit-Remaining`/`Reset-After` and
  wait out an empty bucket; on 429 honour `retry_after` with ONE retry; cap
  waits at `RATE_WAIT_MAX_MS` (longer = unknown now). The stand-in enforces a
  bucket, so the request COUNT proves pacing.
- **`sweepGuildMemberships` goes per id,** four at a time, under
  `SWEEP_DEADLINE_MS` (per-call timeouts compound); late ids come back null.
  The bulk member list would need the GUILD_MEMBERS privileged intent, one more
  way to be half-configured.
- **Warn and name; never block** signup or `startDraft` on Discord.
- **/me has one card** (`account-discord-card.tsx`). Pure `discordCardCtas`
  gives one primary button per state, and the callback's join button only when
  membership is unknown, so CTAs never stack. The typed handle hides behind
  "Can't link? Type your handle" unless linking isn't configured.
- **On /me, ask for Discord through the next-steps list, not the Home
  prompt.** The season card comes first, and its derived "Next" list (pure
  `accountNextSteps`, `src/lib/account-page.ts`, tested in
  `account-page.test.ts` and `src/components/account-next-steps.test.ts`)
  points at the Discord card (`#profile-discord`). Its Discord steps appear
  only once the viewer has signed up (before that the season card is the ask).
  Discord counts as done only when the linked account is in the server, and
  unknown membership adds no step.
- **The dashboard prompt is derived, never dismissible.** `DiscordSetupPrompt`
  (`discord-setup.tsx`, rendered by `src/app/page.tsx`) shows only to ACTIVE
  registrations, in every phase: unlinked gets `DiscordSetupCard` (copy branches
  on `autoJoins`); not-member or pending gets `DiscordJoinCard`; unknown gets
  nothing.
- **Name each join CTA distinctly and keep an invite beside one-click.** "Join
  the server" (re-OAuth), "Use the invite instead"; pending gets "Open the
  server" (dashboard) or "Open Discord" (/me). Re-OAuth alone loops a player
  whose join 403s. `account-discord-card.test.ts` pins it; no invite link
  (`hasInvite` false) means no invite button.
- **"Missing" is about the LINKED account.** A player who linked an alt reads
  not-member while in the server, so show the linked handle (`ReachPlayer`) and
  the fix (join on it, or re-link; OAuth Join re-links the browser's account).
- **Admin reach card** (`getDiscordReachFunnel`): the linked count is DB-only;
  guild counts come from the sweep when a bot exists. Unknown is its own count,
  never "missing"; the headline counts only players we could check, and if
  none, only the couldn't-check line shows. Below 50% linked it says chase
  links first. Data lists are uncapped; the card shows 12. Never promise
  "reload fixes it" for unknowns (the memo window, or a kicked bot forever).
- **Start draft warns without slowing /admin:** `discordReachWarning` (names
  only) via the Suspense-wrapped `StartDraftControl`
  (`admin-start-draft.tsx`), whose fallback is the same working button.
  `adminNextStep`'s two Start-draft steps take `unlinkedDiscordCount`, counted
  over all ACTIVE registrations in `loadSeasonAdminData` so banner and card
  agree.
- **The chase post** (`discordChaseMessage` + `<ChaseCopy>`) names everyone
  (invite for missing, rules nudge for pending, profile link for unlinked, who
  are told being in the server isn't enough), with the origin read at click
  time and names through `pasteSafeName` (zero-width splices, not
  backslashes). The builders live in client-safe `discord-reach.ts`
  (`discord-roles.ts` re-exports them).
- **`reachabilityNote(userId)`** rides the assign-standin (captain and admin)
  and free-agent toasts when the post can't reach the player: silent on
  unknown, raced against 2.5 s, never throws.
- **Quote copy that follows a JSX expression onto a new line** (`{" text"}`);
  JSX trims the plain space ("(@gone4)isn't").
- **Coverage limit:** the dashboard join card has no render test. Check it with
  the `discord-fixture` launch entry (port 3115): `node
  scripts/discord-standin.mjs` (stand-in API on :4310; discordId suffix ...02
  member, ...03 pending, ...04 404-10007, ...05 500), seed
  `signups-fixture.db`, run `scripts/link-fixture-discord.ts`, sign in via
  `/api/auth/dev`.

## The inhouse queue board

One pinned message shows the live queue, rewritten in place; keep it (Tim's
call). Render: `inhouse-board.ts` (pure). Service: `inhouse-board-service.ts`
(`inhouse-board.itest.ts`). Transport: `postWebhookMessage`,
`patchWebhookMessage`, `deleteWebhookMessage`
(`discord-webhook-transport.itest.ts`). It rides the board webhook; no bot.

- **The `inhouseBoard` Setting row is the on/off switch.** Live:
  `{ webhookId, messageId, digest, lastOkAt?, failures? }`; posting:
  `{ webhookId, messageId: "", digest, reservedAt }`. No row = off (one PK
  read). No separate toggle; only `inhouse-board-service.ts` writes it.
- **Claim before posting; never auto-take a reservation.** `claimBoardRow`
  creates it (P2002 loser stands down). Lease `INHOUSE_BOARD_POST_LEASE_MS`:
  fresh reports "posting" and refuses a second post or removal; expired,
  malformed or untimed reports `postingStuck`. Discord may have accepted the
  POST before a crash, so nothing reposts automatically: the admin checks
  Discord and clears it (reported `orphaned`). A POST with no readable id is
  ambiguous: CAS `reservedAt: null` at once. Take over only a settled board in
  another channel, by CAS (seam `inhouseBoard.claimBoardRow.beforeTakeover`).
  If the live swap loses after posting, delete with the same credential.
- **Write back only by CAS on the exact previous value** (`swapState`,
  `clearStateIf`): a blind write after the 2.5 s round trip would resurrect a
  removed board.
- **POST with `?wait=true`** (else 204, no id, never editable). **Repeat
  `allowed_mentions: { parse: [] }` on every PATCH:** Discord rebuilds mentions
  per edit with defaults, and an "@everyone" persona would mass-ping from a
  pinned message.
- **Keep the clock out of the digest.** Semantic state only; elapsed time is
  `<t:...:R>`. A time-varying digest costs a PATCH every throttle window,
  forever. Both builders (`loadBoardSnapshot`, `getInhouseState`) go through
  `lobbyView`; if they disagreed they would repaint each other in a loop.
- **Throttle:** `claimThrottle` on `inhouseBoardAt`, `BOARD_MIN_SECONDS`
  doubling per failure up to 300 s. A lost claim is fine: the digest still
  differs.
- **PATCH 404/401/403 is `gone`:** clear the row (guarded), never re-post;
  deleting in Discord is the off switch. **429/5xx is `failed`:** keep the old
  digest, bump `failures`.
- **Tear down before the board's webhook changes.** A board whose webhook id no
  longer matches is forgotten, never written to the new channel.
  `setDiscordWebhook` (when it carries the board), `clearDiscordWebhook`,
  `setInhouseWebhook` and `clearInhouseWebhook` call
  `removeInhouseBoard({ force: true })` first. A regenerated token keeps its id
  (`webhookIdOf`) and survives.
- **Report removal honestly;** an orphan (row gone, message pinned forever) is
  the worst end state. Confirmed: ok. Refused: keep the row, admin retries.
  `force`: clear and report `orphaned` ("delete it by hand"). A stranded board
  never goes through `deleteWebhookMessage` (webhook-scoped: a 404 reads as
  success).
- **Health must not flatter:** last edit is `lastOkAt` (Discord accepted),
  never the throttle stamp. The card also shows `boardStateLabel`, `inSync`,
  failures, stranded and posting/stuck.
- **Who repaints:** the one-minute worker (`syncInhouse`, then
  `syncInhouseBoard`), including its early return with no lobby and an empty
  queue (a game just ended, the last player left), pinned by the
  `runResultSync` tests. The gate (`inhouseBoardNeedsSync`,
  `automation-gate.ts`) wakes on digest drift and at each entry's away
  moment; `watch` includes a present queue. Polls repaint only for the
  room-maintenance winner, mutations never (`syncBoard: false`). Never use
  `/api/sync` as a heartbeat.
- **The board informs; it does not convert.** Edits notify nobody; the pings
  reach phones.
- **Design "Find Match":** Dota's own state names (Find Match, Searching,
  Match Found, Preparing, live); `▰` taken, `▱` open; the trailing `▱ open`
  rows are the call to action; one player per row, capped by
  `escapeMarkdown` (`escapeDiscordText` plus 32 characters).
- **No emoji** on a permanently visible message (it becomes wallpaper). The
  4 px colour bar carries state; LIVE red means broadcast, never Dire (sides
  aren't known until import).
- **The empty state is the product** (most views; a bare 0/10 reads as a dead
  league). `BoardStats` (last result and MVP, all-time lobbies, established
  ladder leader) comes from `loadBoardStats` (60 s memo on the ladder
  summary). **Load it only for the empty board:** `resolveSnapshot` calls it
  and `pingOptInAvailable` only with no lobby and no present player, so a busy
  queue, when the board syncs most, never pays for the full-history Elo scan;
  keep that condition when you add to the empty state. Last game: newest
  formed COMPLETED lobby by `[createdAt desc, id desc]`, ended at
  `inhouseEndedAt`; never `updatedAt`.
  Monotonic figures only, never a trailing window ("this week" rots in a quiet
  stretch); omit what's missing; no "updated <t:R>" line ("3 days ago").
- **Keep `public/brand/banner.png` off the board:** its "Under 4.5K, sub-4500
  MMR" gate doesn't apply to inhouses.
