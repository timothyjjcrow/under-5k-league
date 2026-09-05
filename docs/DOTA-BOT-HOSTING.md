# Dota bot hosting options

Prices checked September 4, 2026, in USD before tax, optional backups and overages.

The current setup runs one bot on this Mac and connects it to the site through the Cloudflare relay. It hosts the current active in-house game, with Captains Mode, US East and league ticket 20004. Valve runs the actual game server. The bot needs Node, a Steam session and a small persistent state directory; it does not need Dota installed, a GPU, or ChatGPT running.

## Recommendation

Use the Mac for the first sessions. For dependable access when this Mac is asleep, traveling, or offline, move the same worker to a **$6/month DigitalOcean Basic VM with 1 GiB RAM**. The website and relay configuration can stay the same. Do not buy a second gaming computer for this bot.

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

The LaunchAgent starts at user login and continues after ChatGPT closes. The installed keep-awake option prevents idle system sleep while the bot runs. Keep the Mac connected to power, online and open; screen lock/display-off is fine. Closing the lid, logging out or shutting down interrupts availability. Apple's [Mac sleep settings](https://support.apple.com/en-gb/guide/mac-help/mchle41a6ccd/mac) describe the power controls.

From `ops/dota-lobby-bot`:

```sh
node macos-service.mjs status
node macos-service.mjs stop
node macos-service.mjs start
```

Stopping the bot does not disable the website's ordinary in-house queue or manual Dota hosting. Before changing hosts or Steam accounts, finish/release any bot lobby and stop the old worker. Admins can check the connection indicator on `/inhouse`.

## Moving to a cloud host

1. Provision a small x86 Linux VM with normal IPv4 connectivity, Node 22 and `util-linux`. On Railway, use a persistent service and volume, one replica, and disable sleeping/serverless mode.
2. Copy the worker source and install with `npm ci`. Keep credentials out of image builds and Git.
3. Finish/release the current Dota lobby and stop the Mac service. Start only one copy of this account.
4. Transfer the worker `.env` and private persistent state securely, excluding runtime lock files and old logs; alternatively sign in afresh on the new host. Retain `lobbies.json` and `steam-auth.json` so request history and the renewable session survive restarts. Use directory mode 0700 and secret-file mode 0600.
5. Set the new host's `DOTA_BOT_STATE_DIR` to its persistent directory. Keep the same relay URL and worker secret, and use the included systemd unit (adapt its paths and Node executable).
6. Verify the admin indicator returns online, then perform a private lobby create/release check. There is no reason to change the site URL or its bot settings for the move.

Persistent disks are included in the listed VM bundles. Optional backups cost extra. DigitalOcean bills powered-off VMs until they are destroyed; save private state before destruction. [DigitalOcean billing](https://docs.digitalocean.com/products/droplets/details/pricing/).

Lightsail's cheaper 1 GB $5 bundle is IPv6-only; use the $7 IPv4 bundle for the straightforward Steam setup. Railway supplies outbound IPv4, but fixed outbound IPs require Pro and are not needed by this relay design. [Railway networking](https://docs.railway.com/networking/outbound-networking), [Railway sleeping behavior](https://docs.railway.com/deployments/serverless).

Cloud hosting removes the dependency on home power, Wi-Fi and sleep settings. Steam/Dota outages, occasional Steam reauthentication and software updates still apply. Buying a cloud plan has not been done as part of the Mac rollout.
