import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPartial, parseEnvFile, pushPartial } from "./env-partial.mjs";

const SECRET = "s3cret-value-that-must-never-print-0123456789";
const FILES = {
  "/repo/.env": `STEAM_API_KEY="${SECRET}-steam"\nDISCORD_CLIENT_ID=1529175015260684408\nDISCORD_CLIENT_SECRET=${SECRET}-oauth\n`,
  "/repo/.env.local": "DOTA_INHOUSE_LEAGUE_ID=20004\nDOTA_SEASON_LOBBY_BOT_ENABLED=false\n",
  "/repo/ops/dota-lobby-bot/.env": `DOTA_LOBBY_RELAY_URL=https://relay.example/\nDOTA_LOBBY_BOT_SECRET=${SECRET}-relay\n`,
  "/home/ggd2l-secrets/us-discord-bot-token": `${SECRET}-bot\n`,
  "/repo/.env.europe.discord.local": `DISCORD_CLIENT_SECRET=${SECRET}-eu-oauth\nDISCORD_BOT_TOKEN=${SECRET}-eu-bot\n`,
  "/home/.config/ggd2l-europe/europe-production.env": [
    "NEXT_PUBLIC_SITE_URL=https://ggd2l-europe.vercel.app", "NEXT_PUBLIC_LEAGUE_REGION=eu",
    "NEXT_PUBLIC_APP_NAME=GGD2L Europe", "ADMIN_STEAM_IDS=76561198016829831", `STEAM_API_KEY=${SECRET}-steam`,
    "DISCORD_GUILD_ID=1", "DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/1/x",
    "DOTA_LOBBY_BOT_URL=https://relay.example/", `DOTA_LOBBY_BOT_SECRET=${SECRET}-relay`,
    `DATABASE_URL=postgresql://u:${SECRET}@neon/db`, `AUTH_SECRET=${SECRET}-auth`,
  ].join("\n"),
};
const io = { repo: "/repo", home: "/home", env: {}, exists: (file) => file in FILES };
const fakeFs = (files) => (file) => {
  if (!(file in files)) throw new Error("unexpected read");
  return files[file];
};
const keys = (text) => parseEnvFile(text);

test("staging carries no Discord credential, webhook or lobby bot", () => {
  for (const lg of ["us", "eu"]) {
    const env = keys(buildPartial(lg, "staging", { ...io, read: fakeFs(FILES) }));
    assert.equal(env.LEAGUE_DEPLOY_ENV, "staging");
    assert.equal(env.APP_URL, `https://${lg}.ggd2l.com`);
    assert.equal(env.NEXT_PUBLIC_SITE_URL, env.APP_URL);
    for (const forbidden of ["DISCORD_BOT_TOKEN", "DISCORD_CLIENT_SECRET", "DISCORD_WEBHOOK_URL", "DOTA_LOBBY_BOT_URL", "DOTA_LOBBY_BOT_SECRET"])
      assert.equal(env[forbidden], undefined, `${lg} staging must not carry ${forbidden}`);
    for (const owned of ["DATABASE_URL", "AUTH_SECRET", "CRON_SECRET", "BACKUP_RECEIPT_SECRET"])
      assert.equal(env[owned], undefined, `${owned} is the box's, never the partial's`);
  }
});

test("production carries the credentials and never the old origin", () => {
  const us = keys(buildPartial("us", "production", { ...io, read: fakeFs(FILES) }));
  assert.equal(us.DISCORD_BOT_TOKEN, `${SECRET}-bot`);
  assert.equal(us.DISCORD_GUILD_ID, "1524287040508657725");
  // Both leagues reach the bot on the box over loopback, with the bot's secret.
  assert.equal(us.DOTA_LOBBY_BOT_URL, "http://127.0.0.1:8090");
  assert.equal(us.DOTA_LOBBY_BOT_SECRET, `${SECRET}-relay`);
  const eu = keys(buildPartial("eu", "production", { ...io, read: fakeFs(FILES) }));
  assert.equal(eu.DOTA_LOBBY_BOT_URL, "http://127.0.0.1:8090");
  assert.equal(eu.NEXT_PUBLIC_SITE_URL, "https://eu.ggd2l.com");
  assert.equal(eu.DISCORD_WEBHOOK_URL, undefined, "webhooks only with --webhooks");
  assert.equal(keys(buildPartial("eu", "production", { ...io, read: fakeFs(FILES), webhooks: true })).DISCORD_WEBHOOK_URL,
    "https://discord.com/api/webhooks/1/x");
});

test("--bot-via-relay keeps the relay's URL until the bot moves onto the box", () => {
  for (const lg of ["us", "eu"]) {
    const env = keys(buildPartial(lg, "production", { ...io, read: fakeFs(FILES), botViaRelay: true }));
    assert.equal(env.DOTA_LOBBY_BOT_URL, "https://relay.example/", lg);
  }
});

test("errors name keys or files, never values", () => {
  const files = { ...FILES, "/repo/.env": `DISCORD_CLIENT_ID=1\nDISCORD_CLIENT_SECRET=${SECRET}\n` };
  assert.throws(() => buildPartial("us", "staging", { ...io, read: fakeFs(files), exists: (file) => file in files }), (error) => {
    assert.match(error.message, /STEAM_API_KEY/);
    assert.ok(!error.message.includes(SECRET));
    return true;
  });
});

test("the push sends values on stdin only", () => {
  const calls = [];
  const spawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { status: 0 }; };
  pushPartial("us", `STEAM_API_KEY=${SECRET}\n`, { host: "box", spawn });
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].args.join(" ").includes(SECRET), "no value in argv");
  assert.equal(calls[0].opts.input, `STEAM_API_KEY=${SECRET}\n`);
  assert.deepEqual(calls[0].opts.stdio.slice(1), ["ignore", "ignore"]);
  assert.throws(() => pushPartial("us", "X=1\n", { host: "box", spawn: () => ({ status: 255 }) }), /could not install/);
});

test("--without-bot leaves the US bot token and guild out of the first production pass", () => {
  const files = { ...FILES };
  delete files["/home/ggd2l-secrets/us-discord-bot-token"];
  const env = keys(buildPartial("us", "production", { ...io, read: fakeFs(files), exists: (file) => file in files, withoutBot: true }));
  assert.equal(env.DISCORD_BOT_TOKEN, undefined);
  assert.equal(env.DISCORD_GUILD_ID, undefined);
  assert.equal(env.DISCORD_CLIENT_SECRET, `${SECRET}-oauth`);
  assert.throws(() => buildPartial("us", "production", { ...io, read: fakeFs(files), exists: (file) => file in files }), /us-discord-bot-token/);
});
