/**
 * How the site reads the lobby bot's replies, the same way over the relay and
 * over loopback on the box.
 *
 * The relay used to make these checks on every reply (8 KiB cap, a status
 * whitelist); with the bot on 127.0.0.1 there is no relay, so the site makes
 * them itself. The bot is first-party code, so they are defence in depth: a
 * reply that breaks them is treated like a bot that couldn't be reached.
 */

/** The largest reply the site reads from the bot, in bytes (the relay's cap). */
export const MAX_BOT_REPLY_BYTES = 8 * 1024;

/** The statuses the bot's contract answers with: a reply, or an error code. */
const BOT_STATUSES = new Set([200, 400, 409]);

/** A reply that broke the contract: read as "the bot could not be reached". */
export class BotReplyUnreadableError extends Error {
  constructor() {
    super("unreadable lobby bot reply");
  }
}

/**
 * The bot's reply: its status (200, 400 or 409) and its JSON object body,
 * read at most `MAX_BOT_REPLY_BYTES` into memory. Throws
 * BotReplyUnreadableError for any other status, a declared or actual body
 * over the cap, or a body that isn't one JSON object.
 */
export async function readBotReply(
  response: Response,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const unreadable = async () => {
    await response.body?.cancel().catch(() => {});
    return new BotReplyUnreadableError();
  };
  if (!BOT_STATUSES.has(response.status)) throw await unreadable();
  const declared = response.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= MAX_BOT_REPLY_BYTES))
    throw await unreadable();
  const reader = response.body?.getReader();
  if (!reader) throw new BotReplyUnreadableError();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BOT_REPLY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new BotReplyUnreadableError();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new BotReplyUnreadableError();
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new BotReplyUnreadableError();
  return { status: response.status, body: body as Record<string, unknown> };
}

/**
 * Did the request fail because nothing was listening (ECONNREFUSED)? Then it
 * was never delivered: on the box that means the bot isn't running. Any other
 * failure (a timeout, a reset after sending) may have reached the bot and
 * stays unknown. Node's fetch puts the socket error in `cause`, or an
 * AggregateError of them there when it tried more than one address.
 */
export function connectionRefused(error: unknown): boolean {
  const cause = (error as { cause?: unknown } | null)?.cause as
    | { code?: unknown; errors?: unknown }
    | undefined;
  if (!cause || typeof cause !== "object") return false;
  if (cause.code === "ECONNREFUSED") return true;
  return (
    Array.isArray(cause.errors) &&
    cause.errors.length > 0 &&
    cause.errors.every(
      (e) => (e as { code?: unknown } | null)?.code === "ECONNREFUSED",
    )
  );
}
