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

## Protocol

The website sends `POST /lobby` with `Content-Type: application/json` and
`Authorization: Bearer <DOTA_LOBBY_BOT_SECRET>`:

```json
{ "action": "status", "spec": { "key": "inhouse:example:1" } }
```

`create`, `start`, and `release` use the bot's complete existing lobby spec;
`active` and `health` have no spec. `POST /health` also accepts
`{"action":"health"}` with the same authentication. There is no public status
endpoint. Requests must be at most 8 KiB.

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
connected. `active` returns `{key: string|null}`. Lobby operations return
`{state, lobbyId?, matchId?}`. Errors use status 400 or 409 and only `{code}`,
where code is one of `AUTH`, `INVALID`, `OFFLINE`, `BUSY`, `STATE`, `ROSTER`, or
`SETTINGS`. Additional response fields are rejected rather than passed through.

Each request times out after 10 seconds. A timeout, disconnect, or replacement
returns `409 {"code":"OFFLINE"}`. At most 64 requests can be pending. No request
is retried, buffered for a later connection, or replayed after an isolate
restart. A timeout can occur after a command reached the bot, so clients must
check status before deciding what to do next. The bot's persisted command
claims prevent an ambiguous create/start operation from being repeated.

## Verification and maintenance

`npm test` uses Miniflare's actual Workers runtime with simulated bot sockets.
It verifies authentication, health/status forwarding, malformed/oversized input,
response filtering, connection replacement and disconnect, concurrency limits,
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
