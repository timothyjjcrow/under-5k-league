import { describe, expect, it } from "vitest";
import { normalizeDiscordWebhookUrl } from "./discord-webhook.mjs";

const TOKEN = "Ab3dEf7_9-token.value";

describe("normalizeDiscordWebhookUrl", () => {
  it.each([
    `https://discord.com/api/webhooks/1379001234567890123/${TOKEN}`,
    `https://discord.com/api/v10/webhooks/1379001234567890123/${TOKEN}`,
    `https://discordapp.com/api/v9/webhooks/1379001234567890123/${TOKEN}`,
  ])("accepts one canonical Discord webhook URL (%s)", (value) => {
    expect(normalizeDiscordWebhookUrl(value)).toBe(value);
  });

  it.each([
    `http://discord.com/api/webhooks/1379001234567890123/${TOKEN}`,
    `https://evil.example/api/webhooks/1379001234567890123/${TOKEN}`,
    `https://discord.com.evil.example/api/webhooks/1379001234567890123/${TOKEN}`,
    `https://discord.com:444/api/webhooks/1379001234567890123/${TOKEN}`,
    `https://discord.com:443/api/webhooks/1379001234567890123/${TOKEN}`,
    `https://DISCORD.COM/api/webhooks/1379001234567890123/${TOKEN}`,
    `https://user:pass@discord.com/api/webhooks/1379001234567890123/${TOKEN}`,
    `https://discord.com/api/webhooks/1379001234567890123/${TOKEN}?wait=true`,
    `https://discord.com/api/webhooks/1379001234567890123/${TOKEN}#secret`,
    `https://discord.com/api/webhooks/not-numeric/${TOKEN}`,
    "https://discord.com/api/webhooks/1379001234567890123/short",
    ` https://discord.com/api/webhooks/1379001234567890123/${TOKEN}`,
    "x".repeat(513),
  ])("rejects an unsafe webhook target (%s)", (value) => {
    expect(normalizeDiscordWebhookUrl(value)).toBeNull();
  });
});
