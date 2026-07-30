// Stand-in Discord API for browser-verifying the guild-membership surfaces
// against the `discord-fixture` launch entry (which points DISCORD_API_BASE
// here). Run it, seed signups-fixture.db, link users with
// scripts/link-fixture-discord.ts, then log in via /api/auth/dev.
//
// Member answers key off the discordId SUFFIX, so the linking script and this
// file agree without sharing state:
//   ...02 -> full member          ...03 -> pending (Membership Screening)
//   ...04 -> 404 Unknown Member   ...05 -> 500 (Discord having a bad day)
//
//   node scripts/discord-standin.mjs
import { createServer } from "node:http";

const BOT_ID = "900000000000000042";

createServer((req, res) => {
  const url = req.url ?? "";
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  console.log(req.method, url);

  if (url === "/users/@me") {
    return send(200, { id: BOT_ID, username: "standin-bot" });
  }
  if (url.endsWith(`/members/${BOT_ID}`)) {
    return send(200, { roles: ["botrole"] });
  }
  if (url.endsWith("/roles") && req.method === "GET") {
    return send(200, [
      { id: "900000000000000001", name: "@everyone", position: 0, permissions: "268435457" },
      { id: "botrole", name: "standin-bot", position: 5, permissions: "268435457" },
    ]);
  }
  const member = url.match(/\/guilds\/[^/]+\/members\/(\d+)$/);
  if (member && req.method === "GET") {
    const id = member[1];
    if (id.endsWith("02")) return send(200, { pending: false, roles: [] });
    if (id.endsWith("03")) return send(200, { pending: true, roles: [] });
    if (id.endsWith("04")) return send(404, { code: 10007, message: "Unknown Member" });
    if (id.endsWith("05")) return send(500, { message: "boom" });
    return send(200, { pending: false, roles: [] });
  }
  return send(404, { code: 0, message: "no such stand-in route" });
}).listen(4310, "127.0.0.1", () => console.log("stand-in Discord on :4310"));
