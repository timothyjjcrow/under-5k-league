# Dota bot hosting options

The bot runs on the league's own box (`ggd2l-1`, the DigitalOcean droplet that serves both sites) as `ggd2l-bot.service`, and connects to the sites through the Cloudflare relay as before. **Status: planned:** it moves there from this Mac after both leagues have moved to the box ([DOTA-LOBBY-BOT: On the box](DOTA-LOBBY-BOT.md#on-the-box)); until then it runs on the Mac. The box costs nothing extra for the bot, so no separate VM is needed.

One bot hosts the in-house games one Dota lobby at a time, until that game's postgame (Dota doesn't let it leave a running game, so a second game at the same time is hosted by hand; [DECISIONS 2026-10-18](DECISIONS.md)), with Captains Mode, US East and league ticket 20004. Valve runs the actual game server. The bot needs Node, a Steam session and a small persistent state directory; it does not need Dota installed, a GPU, or ChatGPT running.

The approved Europe plan can share this same worker and relay, with one lobby
at a time across both leagues. Set `DOTA_GAME_SERVER_REGIONS="2,3"` only after
deploying the namespace-aware relay and worker changes; Europe's requests then
use Europe West and its own ticket. Keep a single process and the existing
Steam state. See [shared setup and activation order](DOTA-LOBBY-BOT.md#sharing-the-existing-bot-between-us-and-europe).

## Options considered (September 2026)

Prices checked September 4, 2026, in USD before tax, optional backups and overages. The recommendation then was the Mac for the first sessions and a **$6/month DigitalOcean Basic VM with 1 GiB RAM** for dependable access; the move to the league's box (2026-10-15) gives the same dependability on the droplet the sites already use. Do not buy a second gaming computer for this bot.

| Host | Monthly cost | Practical tradeoff |
| --- | ---: | --- |
| This Mac | $0 hosting, plus electricity | Already configured. Must stay powered, awake and online. |
| DigitalOcean Basic | $6 | 1 vCPU, 1 GiB RAM, 25 GiB persistent SSD, 1 TB transfer. Predictable price; maintain Linux updates. |
| AWS Lightsail Linux with IPv4 | $7 | 1 GB RAM, 2 vCPUs, 40 GB persistent SSD, 2 TB transfer. Good if you already use AWS. |
| Railway Hobby | $5 minimum; approximately $5–8 estimated | Managed deployments; usage-based billing and a persistent volume required. |

Provider sources: [DigitalOcean Droplets](https://www.digitalocean.com/pricing/droplets), [AWS Lightsail](https://aws.amazon.com/lightsail/pricing/), [Railway pricing](https://docs.railway.com/pricing). The Railway range is a workload estimate, not a quoted fixed plan. Its $5 subscription includes $5 usage; RAM is $10/GB-month, CPU $20/vCPU-month, volumes $0.15/GB-month and outbound traffic $0.05/GB.

A $4 DigitalOcean 512 MiB VM exists, but 1 GiB provides installation, OS and update headroom. The current Mac worker used about 34 MiB RSS at idle during a short check; that is not a cloud benchmark or a peak-memory guarantee. Start with Linux x86; Linux ARM and Windows/WSL have not been validated.

The relay is small enough to be expected to fit Cloudflare's free tier: SQLite Durable Objects are included, with 100,000 requests/day and 13,000 GB-seconds/day. WebSocket hibernation avoids charging idle connection duration. These are shared account quotas and must be monitored; this setup does not require upgrading the account. The relay does not host the Steam connection itself. [Cloudflare pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).

## Running on this Mac

This is how the bot runs until it moves to the box. The LaunchAgent starts at user login and continues after ChatGPT closes. The installed keep-awake option prevents idle system sleep while the bot runs. Keep the Mac connected to power, online and open; screen lock/display-off is fine. Closing the lid, logging out or shutting down interrupts availability. Apple's [Mac sleep settings](https://support.apple.com/en-gb/guide/mac-help/mchle41a6ccd/mac) describe the power controls.

From `ops/dota-lobby-bot`:

```sh
node macos-service.mjs status
node macos-service.mjs stop
node macos-service.mjs start
```

`stop` and `uninstall` return only once launchd has finished unloading the bot, usually within a few seconds, so `start` can follow `stop` straight away. `launchctl bootout` returns before that teardown ends; on October 9, 2026 a `start` run in that window kickstarted the dying job and left the service unloaded. If `stop` reports that the service did not unload within 20 seconds, run `status` until it shows `Loaded: no` before `start`.

Stopping the bot does not disable the website's ordinary in-house queue or manual Dota hosting. Before changing hosts or Steam accounts, finish/release any bot lobby and stop the old worker. Admins can check the connection indicator on `/inhouse`.

## Moving to a cloud host

The move to the league's box follows [DOTA-LOBBY-BOT: On the box](DOTA-LOBBY-BOT.md#on-the-box). For any other host:

1. Provision a small x86 Linux VM with normal IPv4 connectivity, Node 22 and `util-linux`. On Railway, use a persistent service and volume, one replica, and disable sleeping/serverless mode.
2. Copy the worker source and install with `npm ci`. Keep credentials out of image builds and Git.
3. Finish/release the current Dota lobby and stop the Mac service. Start only one copy of this account.
4. Transfer the worker `.env` and private persistent state securely, excluding runtime lock files and old logs; alternatively sign in afresh on the new host. Retain `lobbies.json` and `steam-auth.json` so request history and the renewable session survive restarts. Use directory mode 0700 and secret-file mode 0600.
5. Set the new host's `DOTA_BOT_STATE_DIR` to its persistent directory. Keep the same relay URL and worker secret, and use the included systemd unit (adapt its paths and Node executable).
6. Verify the admin indicator returns online, then perform a private lobby create/release check. There is no reason to change the site URL or its bot settings for the move.

Persistent disks are included in the listed VM bundles. Optional backups cost extra. DigitalOcean bills powered-off VMs until they are destroyed; save private state before destruction. [DigitalOcean billing](https://docs.digitalocean.com/products/droplets/details/pricing/).

Lightsail's cheaper 1 GB $5 bundle is IPv6-only; use the $7 IPv4 bundle for the straightforward Steam setup. Railway supplies outbound IPv4, but fixed outbound IPs require Pro and are not needed by this relay design. [Railway networking](https://docs.railway.com/networking/outbound-networking), [Railway sleeping behavior](https://docs.railway.com/deployments/serverless).

Cloud hosting removes the dependency on home power, Wi-Fi and sleep settings. Steam/Dota outages, occasional Steam reauthentication and software updates still apply. A first sign-in from a datacenter IP may need Steam Guard again.
