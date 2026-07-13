import { getSetting, SETTING_KEYS } from "./settings";
import { resolveSiteUrl } from "./site-url";

// Push league moments to the community's Discord via an incoming webhook.
// The webhook URL lives in the Setting table (admin panel) with the
// DISCORD_WEBHOOK_URL env var as a fallback. Sending is best-effort: a dead
// webhook must never break a signup or a draft, so failures are swallowed
// (logged in dev) and the caller never sees them.

// ---------------------------------------------------------------------------
// Pure message formatters (unit-tested). Discord markdown: **bold**, [link](url).
// ---------------------------------------------------------------------------

export function signupMessage(
  playerName: string,
  signedUp: number,
  neededToStart: number,
): string {
  const remaining = Math.max(0, neededToStart - signedUp);
  const tail =
    remaining === 0
      ? "that's enough to start the draft! 🎉"
      : `${remaining} more to start the draft.`;
  return `📝 **${playerName}** signed up — ${signedUp} player${signedUp === 1 ? "" : "s"} in, ${tail}`;
}

export function draftStartedMessage(seasonName: string): string {
  return `🔨 **The ${seasonName} draft is LIVE!** Captains are on the clock — watch the auction at ${resolveSiteUrl()}/draft`;
}

export function draftCompleteMessage(seasonName: string): string {
  return `✅ **The ${seasonName} draft is complete!** Rosters are locked — see the teams at ${resolveSiteUrl()}/teams`;
}

export function playerSoldMessage(
  playerName: string,
  teamName: string,
  price: number,
): string {
  const tag =
    price >= 50 ? " 💸 big spender!" : price <= 1 ? " — a steal!" : "";
  return `💰 **${playerName}** → **${teamName}** for **$${price}**${tag}`;
}

export function matchResultMessage(m: {
  homeName: string;
  awayName: string;
  homeScore: number;
  awayScore: number;
  week: number;
  isPlayoff: boolean;
}): string {
  const label = m.isPlayoff ? "Playoffs" : `Week ${m.week}`;
  const winner =
    m.homeScore > m.awayScore
      ? m.homeName
      : m.awayScore > m.homeScore
        ? m.awayName
        : null;
  const line = `⚔️ **${label}:** ${m.homeName} ${m.homeScore}–${m.awayScore} ${m.awayName}`;
  return winner ? `${line} — **${winner}** take the series!` : `${line} — a draw!`;
}

export function playoffsStartedMessage(
  seasonName: string,
  pairings: { home: string; away: string }[],
): string {
  const lines = pairings.map((p) => `• ${p.home} vs ${p.away}`).join("\n");
  return `🏁 **${seasonName} playoffs are set!**\n${lines}\nBracket: ${resolveSiteUrl()}/schedule`;
}

export function championMessage(
  seasonName: string,
  teamName: string,
): string {
  return `👑 **${teamName}** are the **${seasonName}** champions! GG everyone — recap at ${resolveSiteUrl()}/recap`;
}

export function freeAgentSignedMessage(
  playerName: string,
  teamName: string,
): string {
  return `🖊️ **${playerName}** signs with **${teamName}** as a free agent — roster updated: ${resolveSiteUrl()}/teams`;
}

export function playerReleasedMessage(
  playerName: string,
  teamName: string,
): string {
  return `📤 **${playerName}** released from **${teamName}** — they're a free agent again.`;
}

export function weeklyHonorsMessage(honors: {
  week: number;
  playerName: string | null;
  playerPoints: number;
  heroName: string | null;
  teamName: string | null;
  teamGameWins: number;
}): string {
  const lines = [`🏅 **Week ${honors.week} honors are in!**`];
  if (honors.playerName) {
    lines.push(
      `⭐ Player of the Week: **${honors.playerName}** — ${honors.playerPoints} fantasy pts${honors.heroName ? ` on ${honors.heroName}` : ""}`,
    );
  }
  if (honors.teamName) {
    lines.push(
      `🛡️ Team of the Week: **${honors.teamName}** (${honors.teamGameWins} game win${honors.teamGameWins === 1 ? "" : "s"})`,
    );
  }
  lines.push(`Full leaderboards: ${resolveSiteUrl()}/leaders`);
  return lines.join("\n");
}

/** A captain-agreed reschedule — the new time is pre-formatted by the caller. */
export function rescheduleMessage(m: {
  homeName: string;
  awayName: string;
  week: number;
  isPlayoff: boolean;
  /** Epoch ms of the agreed time — rendered via Discord's native timestamp
   *  markup so every reader sees it in their own timezone (a server-formatted
   *  string would be UTC wall-time in prod, wrong hour and often wrong day). */
  whenMs: number;
}): string {
  const label = m.isPlayoff ? "Playoffs" : `Week ${m.week}`;
  const t = `<t:${Math.floor(m.whenMs / 1000)}:F>`;
  return `🗓️ **Rescheduled** — ${label}: **${m.homeName}** vs **${m.awayName}** now plays ${t} (both captains agreed).`;
}

export function testMessage(): string {
  return `👋 Webhook test from **${process.env.NEXT_PUBLIC_APP_NAME || "the league site"}** — notifications are wired up.`;
}

/**
 * League news post → announcement with a body snippet and a link to /news.
 * Given the post id, the link deep-links to that specific post (/news#id).
 */
export function newsMessage(title: string, body: string, id?: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  const snippet = flat.length > 200 ? `${flat.slice(0, 199).trimEnd()}…` : flat;
  const link = `${resolveSiteUrl()}/news${id ? `#${id}` : ""}`;
  return `📣 **${title}**\n${snippet}\nMore: ${link}`;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export async function getWebhookUrl(): Promise<string | null> {
  const fromDb = await getSetting(SETTING_KEYS.DISCORD_WEBHOOK_URL);
  return fromDb || process.env.DISCORD_WEBHOOK_URL || null;
}

/**
 * A safe, display-only fingerprint of a webhook URL. The full URL is a bearer
 * credential (anyone holding it can post to the channel — prime phishing bait),
 * so it must NEVER be sent to the browser. This keeps a short piece of the id
 * (a Discord webhook is `…/webhooks/<id>/<secret-token>`) and hides the token
 * entirely — enough for an admin to confirm one is set, useless to an attacker.
 * Pure so it can be unit-tested.
 */
export function maskWebhookUrl(url: string | null | undefined): string {
  if (!url) return "";
  const m = url.match(/\/webhooks\/(\d+)\/(.+)$/);
  if (!m) return "configured";
  const id = m[1];
  const idHint = id.length > 6 ? `${id.slice(0, 4)}…${id.slice(-2)}` : id;
  return `discord.com/api/webhooks/${idHint}/••••••••`;
}

/**
 * POST a message to the configured webhook. Best-effort: resolves false on
 * any failure (no webhook configured, network error, non-2xx) and never throws.
 */
export async function sendDiscordMessage(content: string): Promise<boolean> {
  const url = await getWebhookUrl();
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // allowed_mentions: parse:[] means NO mention ever resolves — a player
      // whose Steam persona is "@everyone" (or a team/news title with @here,
      // <@id>, <@&role>) can't turn an announcement into a mass ping.
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[discord] webhook send failed:", err);
    }
    return false;
  }
}
