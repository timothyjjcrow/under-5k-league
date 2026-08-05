const WEBHOOK_PATH =
  /^\/api\/(?:v(?:9|10)\/)?webhooks\/(\d{5,25})\/([A-Za-z0-9._-]{16,256})$/;

/**
 * Validate one Discord incoming-webhook bearer URL without ever returning a
 * partially trusted value. Webhook credentials may only target Discord over
 * HTTPS; credentials, ports, query strings, fragments, Unicode lookalikes,
 * extra path segments, and oversized values are rejected.
 *
 * @param {unknown} input
 * @returns {string | null}
 */
export function normalizeDiscordWebhookUrl(input) {
  if (typeof input !== "string" || input.length === 0 || input.length > 512) {
    return null;
  }
  if (input !== input.trim()) return null;
  // Parse only after pinning the literal authority. URL normalizes an explicit
  // default `:443` port away and lowercases hostnames; accepting those would
  // contradict the canonical no-port credential format enforced everywhere
  // else and make configuration comparison less predictable.
  if (!/^https:\/\/(?:discord\.com|discordapp\.com)\//.test(input)) return null;

  let url;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    (url.hostname !== "discord.com" &&
      url.hostname !== "discordapp.com") ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !WEBHOOK_PATH.test(url.pathname)
  ) {
    return null;
  }
  return input;
}
