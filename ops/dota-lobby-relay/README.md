# Dota lobby relay

This Cloudflare Worker connects the website to the single in-house bot using an
outbound WebSocket from the bot. The bot host needs internet access, but no public
IP, open inbound port, Dota installation, or router configuration.

The named SQLite Durable Object is `inhouse`. It accepts one live bot process at
a time and uses Cloudflare's WebSocket hibernation API while idle. It does not
store requests, lobby passwords, Steam sessions, or the bot's lobby history.
The bot's own persistent state remains authoritative.

## Deployment

From this directory, use Node 22 or later:

```sh
npm ci
npm test
npm run check
npx wrangler secret put DOTA_LOBBY_BOT_SECRET
npx wrangler secret put DOTA_RELAY_WORKER_SECRET
npm run deploy
```

Create two different random secrets of at least 32 characters. Secret prompts
accept values without placing them in shell arguments. Do not commit secrets.
For an initial deployment, `npm run deploy -- --secrets-file /private/path/secrets.json`
can upload both secrets with the code in one operation. The file is a JSON
object containing only the two secret names above; create it with mode `0600`,
keep it outside the repository, and remove it after deployment. Later deployments
retain existing secrets. The `secret put` flow can also create a draft Worker
before the first deployment if needed.

| Setting | Where it belongs |
| --- | --- |
| `DOTA_LOBBY_BOT_SECRET` | Website server, relay secret, and bot's local control service |
| `DOTA_RELAY_WORKER_SECRET` | Relay secret and bot only |
| `DOTA_LOBBY_BOT_URL` | Website server; use the relay's HTTPS origin with no path |
| `DOTA_LOBBY_RELAY_URL` | Bot; use the relay's HTTPS origin with no path; the client derives `wss://.../connect` |

The worker configuration contains the initial `new_sqlite_classes` migration
required for SQLite Durable Objects, including on Cloudflare's free plan. No
paid plan is enabled by this project. Account-wide request/compute quotas still
apply.

For local development, put the two relay secrets in an ignored `.dev.vars` file
and run `npm run dev`. Keep the test credentials in the tests separate from all
real credentials.

## Sharing the existing relay between US and Europe

Both approved league sites can use this one relay and its existing site secret
to reach the same bot process. The relay retains one connected worker and
correlates each HTTP request with a fresh UUID; simultaneous requests return
only to their original caller. The worker retains one active lobby claim
across both leagues, so the second league receives `BUSY` until departure.

EU job keys carry `eu:` before the existing kind/id/game key; US keys remain
unchanged. Health and active responses accept either key form. The shared bot
must explicitly set `DOTA_GAME_SERVER_REGIONS="2,3"` and validates region 3
for EU keys and region 2 for US keys. Each app supplies its own league ticket.
Both apps' server-side controls restrict mutations and recovery to their own
keys. Deploy the updated existing relay with `npm run deploy`, then follow the
[worker activation order](../../docs/DOTA-LOBBY-BOT.md#sharing-the-existing-bot-between-us-and-europe).

## Independent Europe relay

As an alternative to sharing, the Europe configuration creates
`ggd2l-europe-dota-lobby-relay`. Its Durable
Object namespace and encrypted secrets belong to that separate Worker, even
though it uses the same source code and the same local object name `inhouse`.
Use these commands from this directory for Europe:

```sh
npm run check:europe
npx wrangler secret put DOTA_LOBBY_BOT_SECRET --config wrangler.europe.jsonc
npx wrangler secret put DOTA_RELAY_WORKER_SECRET --config wrangler.europe.jsonc
npm run deploy:europe
```

For an initial deployment with a private secrets file, use
`npm run deploy:europe -- --secrets-file /private/path/europe-secrets.json`.
The secret requirements and private-file handling above also apply. Use fresh
Europe secrets and the resulting Europe HTTPS origin in the Europe website
and worker only. The unqualified `deploy` and `check` scripts target the
existing US/shared relay. This alternative Europe worker requires its own Steam account and state;
see [Europe setup](../../docs/EUROPE-SETUP.md#dota-lobby-automation).

## Protocol

The website sends `POST /lobby` with `Content-Type: application/json` and
`Authorization: Bearer <DOTA_LOBBY_BOT_SECRET>`:

```json
{ "action": "status", "spec": { "key": "inhouse:example:1" } }
```

`create`, `start`, `release`, and `invite` use the bot's complete existing
lobby spec; `active` and `health` have no spec. `POST /health` also accepts
`{"action":"health"}` with the same authentication. There is no public status
endpoint. Requests must be at most 8 KiB.

`invite` asks the bot to send Dota lobby invites. The spec may name its targets
in `invite` (1–20 unique Steam64 IDs, each on that request's own `radiant` or
`dire`); without it the bot invites the whole roster. Any lobby action's spec
may also carry `withPlayers: true` to ask for the seat report below. The relay
checks only that `spec` is an object; the bot enforces the rest. It accepts an
invite only for its active job's ready lobby, with matching settings and the
bot as leader. It skips players already in the lobby, anyone invited in the
last 30 seconds, and anyone invited five times in this job. The bot also
invites the roster once by itself, when the lobby is first ready.

The bot connects to `GET /connect` with a WebSocket upgrade, an
`Authorization: Bearer <DOTA_RELAY_WORKER_SECRET>` header and an
`X-Bot-Instance` header containing a random UUID. The UUID stays constant across
reconnections within one process. A different live process is rejected with
HTTP 409 and `{"code":"BUSY"}`. A same-process replacement closes the older
socket and fails its outstanding requests without sending them again.

The bot sends the literal text `ping` every 30 seconds. Cloudflare automatically
answers `pong` without waking the Durable Object. On every dispatch or new
connection, a 90-second lease is checked against the latest automatic pong or
valid command response. A stale connection is closed before another is accepted.

For every control request, the relay sends:

```json
{
  "id": "a-unique-UUID",
  "expiresAt": 1800000000000,
  "request": { "action": "health" }
}
```

The bot must reject expired commands and send exactly one correlated response:

```json
{
  "id": "the-request-UUID",
  "status": 200,
  "body": {
    "online": true,
    "steamId": "76561198000000001",
    "activeKey": null,
    "lobbyId": null,
    "gameMode": null,
    "serverRegion": null,
    "leagueId": null
  }
}
```

Health reflects the bot's Steam/GC state, not merely whether its relay socket is
connected. `active` returns `{key: string|null}`. Lobby operations (`status`,
`create`, `start`, `release`, `invite`) return
`{state, lobbyId?, matchId?, players?}`, and `invite` adds `invited`, the
number of invites it sent (an integer from 0 to 20). Errors use status 400 or
409 and only `{code}`, where code is one of `AUTH`, `INVALID`, `OFFLINE`,
`BUSY`, `STATE`, `ROSTER`, or `SETTINGS`. Additional response fields are
rejected rather than passed through: an unknown key, or `invited` on any other
action, turns the reply into `409 {"code":"STATE"}`.

`players` is the seat report. The bot includes it only when the spec asked
with `withPlayers: true` and the job's lobby is set up (ready or starting). It
is an array of at most 20 entries, one per roster player, each with exactly
these keys:

```json
{ "id": "76561198000000001", "seat": "unassigned", "invite": "offline" }
```

| Key | Values |
| --- | --- |
| `id` | The player's 17-digit Steam64 ID, as a string |
| `seat` | `radiant`, `dire`, `unassigned` (in the lobby but on neither side), or `absent` |
| `invite` | `none`, `sent` (the Game Coordinator accepted it), `offline` (Dota was closed; the invite appears when the player opens Dota), or `failed` (the send threw because Steam dropped) |

`sent` doesn't prove the invite arrived. In a live test on 2026-10-10, a
player with Dota's "Block party invites from non-friends" setting ticked saw
nothing, but the Game Coordinator still reported the invite as created. The
lobby name and password remain the fallback.

Deploy this relay before the bot and the site that use `invite` or
`withPlayers`. An older relay rejects `invite` with `400 {"code":"INVALID"}`
and turns any reply carrying `players` or `invited` into
`409 {"code":"STATE"}`. Roll back in reverse (site, then bot, then relay):
never run an older relay while the new bot and the new site are both live.

Each request times out after 10 seconds. A timeout, disconnect, or replacement
returns `409 {"code":"OFFLINE"}`. At most 64 requests can be pending. No request
is retried, buffered for a later connection, or replayed after an isolate
restart. A timeout can occur after a command reached the bot, so clients must
check status before deciding what to do next. The bot's persisted command
claims prevent an ambiguous create/start operation from being repeated.

## Verification and maintenance

`npm test` uses Miniflare's actual Workers runtime with simulated bot sockets.
It verifies authentication, health/status/invite forwarding,
malformed/oversized input, response filtering (including every seat-report and
invite-count field), connection replacement and disconnect, concurrency limits,
and a real 10-second timeout. These tests never connect to Steam or modify a
Dota lobby. `npm run check` bundles the deployment without publishing it.

Wrangler and Miniflare are development dependencies only. The Undici override
keeps this pinned Wrangler version clear of known Undici advisories; recheck it
when updating Wrangler.

Sources:

- [Cloudflare WebSockets and hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Durable Object auto-response and timestamp APIs](https://developers.cloudflare.com/durable-objects/api/state/)
- [Cloudflare timing-safe secret comparison](https://developers.cloudflare.com/workers/examples/protect-against-timing-attacks/)
- [Durable Objects pricing and free-plan support](https://developers.cloudflare.com/durable-objects/platform/pricing/)
