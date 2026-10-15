#!/usr/bin/env node
// Install one league's partial env on the box (design §1.4, §6 P4/W9/E6):
//
//   GGD2L_REPO=/Users/timothycrowley/LD2L2.0 node ops/selfhost/cutover/env-partial.mjs us staging
//
// then, on the box, `sudo bash compose-env.sh us`.
//
// "Partial" means everything except what the box makes itself: the database
// URLs (provision-league-db.sh's fragment) and the generated secrets
// (compose-env.sh). Secrets come only from the Mac's local files and leave
// only through ssh's stdin: nothing is printed but key names, no value goes in
// argv, and errors name keys or files, never values.
//
// Staging leaves out every Discord credential and the lobby bot, as the env
// contract demands. Production adds them; the US bot token is Tim's file
// ~/ggd2l-secrets/us-discord-bot-token (Vercel stores the old one as a
// Sensitive value nobody can read back).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const US_DISCORD_GUILD_ID = "1524287040508657725";
const EU_DISCORD_CLIENT_ID = "1545719497472741466";
const DEFAULT_ADMIN_STEAM_IDS = "76561198016829831";
const EU_WEBHOOK_KEYS = ["DISCORD_WEBHOOK_URL", "DISCORD_INHOUSE_WEBHOOK_URL", "DISCORD_INHOUSE_ALERT_WEBHOOK_URL"];

export function parseEnvFile(text) {
  const env = {};
  for (const line of text.split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    env[match[1]] = value;
  }
  return env;
}

function loadEnv(file, read, exists) {
  if (!exists(file)) throw new Error(`missing input file ${file}`);
  return parseEnvFile(read(file, "utf8"));
}

export function buildPartial(lg, mode, {
  repo = process.env.GGD2L_REPO || path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../.."),
  home = homedir(),
  env = process.env,
  read = readFileSync,
  exists = existsSync,
  webhooks = false,
} = {}) {
  if (!/^(us|eu)$/.test(lg)) throw new Error("league must be us or eu");
  if (!/^(staging|production)$/.test(mode)) throw new Error("mode must be staging or production");
  const out = new Map();
  const set = (key, value) => {
    const text = value === undefined || value === null ? "" : String(value).trim();
    if (text === "") throw new Error(`${key}: no value in the input files`);
    if (/[\r\n]/.test(text)) throw new Error(`${key}: value spans lines`);
    out.set(key, text);
  };
  const origin = `https://${lg}.ggd2l.com`;
  set("NEXT_PUBLIC_LEAGUE_REGION", lg);
  set("APP_URL", origin);
  set("NEXT_PUBLIC_SITE_URL", origin);
  set("LEAGUE_DEPLOY_ENV", mode);
  set("CLIENT_IP_HEADER", "cf-connecting-ip");

  if (lg === "us") {
    const dotenv = loadEnv(path.join(repo, ".env"), read, exists);
    const local = loadEnv(path.join(repo, ".env.local"), read, exists);
    set("ADMIN_STEAM_IDS", env.GGD2L_ADMIN_STEAM_IDS || DEFAULT_ADMIN_STEAM_IDS);
    set("STEAM_API_KEY", dotenv.STEAM_API_KEY);
    set("DOTA_INHOUSE_LEAGUE_ID", local.DOTA_INHOUSE_LEAGUE_ID);
    if (mode === "production") {
      const bot = loadEnv(path.join(repo, "ops/dota-lobby-bot/.env"), read, exists);
      const tokenFile = path.join(home, "ggd2l-secrets/us-discord-bot-token");
      if (!exists(tokenFile)) throw new Error(`missing input file ${tokenFile}`);
      set("DISCORD_CLIENT_ID", dotenv.DISCORD_CLIENT_ID);
      set("DISCORD_CLIENT_SECRET", dotenv.DISCORD_CLIENT_SECRET);
      set("DISCORD_GUILD_ID", US_DISCORD_GUILD_ID);
      set("DISCORD_BOT_TOKEN", read(tokenFile, "utf8"));
      set("DOTA_LOBBY_BOT_URL", bot.DOTA_LOBBY_RELAY_URL);
      set("DOTA_LOBBY_BOT_SECRET", bot.DOTA_LOBBY_BOT_SECRET);
      set("DOTA_SEASON_LOBBY_BOT_ENABLED", env.GGD2L_SEASON_LOBBY_BOT || local.DOTA_SEASON_LOBBY_BOT_ENABLED || "false");
    }
  } else {
    const prod = loadEnv(path.join(home, ".config/ggd2l-europe/europe-production.env"), read, exists);
    for (const [key, value] of Object.entries(prod))
      if (key.startsWith("NEXT_PUBLIC_") && key !== "NEXT_PUBLIC_SITE_URL" && key !== "NEXT_PUBLIC_LEAGUE_REGION") set(key, value);
    set("ADMIN_STEAM_IDS", prod.ADMIN_STEAM_IDS);
    set("STEAM_API_KEY", prod.STEAM_API_KEY);
    if (mode === "production") {
      const discord = loadEnv(path.join(repo, ".env.europe.discord.local"), read, exists);
      set("DISCORD_CLIENT_ID", prod.DISCORD_CLIENT_ID || EU_DISCORD_CLIENT_ID);
      set("DISCORD_CLIENT_SECRET", discord.DISCORD_CLIENT_SECRET);
      set("DISCORD_BOT_TOKEN", discord.DISCORD_BOT_TOKEN);
      set("DISCORD_GUILD_ID", prod.DISCORD_GUILD_ID);
      if (prod.DISCORD_INHOUSE_ROLE_ID) set("DISCORD_INHOUSE_ROLE_ID", prod.DISCORD_INHOUSE_ROLE_ID);
      // The database's Setting rows win over these; carry them only when the
      // restored database turned out not to have the rows (design §6.2 E6).
      if (webhooks) for (const key of EU_WEBHOOK_KEYS) if (prod[key]) set(key, prod[key]);
      set("DOTA_LOBBY_BOT_URL", prod.DOTA_LOBBY_BOT_URL);
      set("DOTA_LOBBY_BOT_SECRET", prod.DOTA_LOBBY_BOT_SECRET);
      set("DOTA_SEASON_LOBBY_BOT_ENABLED", prod.DOTA_SEASON_LOBBY_BOT_ENABLED || "false");
    }
  }
  return [...out].map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
}

// The CLI never writes a value to stdout (an agent's captured stdout is not a
// terminal, so a TTY check would not protect it): it hands the partial to
// ssh's stdin, which root on the box installs as a 0600 file.
export function pushPartial(lg, text, { host = process.env.GGD2L_BOX_SSH || "ggd2l-1", spawn = spawnSync } = {}) {
  const target = `/etc/ggd2l/inputs/${lg}.partial`;
  const result = spawn("ssh", ["-o", "BatchMode=yes", host,
    `sudo install -d -m 0700 -o root -g root /etc/ggd2l/inputs && sudo install -m 0600 -o root -g root /dev/stdin ${target}`],
  { input: text, stdio: ["pipe", "ignore", "ignore"], timeout: 60_000 });
  if (result.status !== 0) throw new Error(`could not install ${target} on ${host}`);
  return target;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [lg, mode, ...flags] = process.argv.slice(2);
  try {
    const text = buildPartial(lg, mode, { webhooks: flags.includes("--webhooks") });
    const keys = text.trim().split("\n").map((line) => line.split("=")[0]);
    const target = pushPartial(lg, text);
    console.log(`env-partial: ${target} installed with ${keys.length} keys: ${keys.join(", ")}`);
  } catch (error) {
    console.error(`env-partial: ${error instanceof Error ? error.message : "failed"}`);
    process.exit(1);
  }
}
