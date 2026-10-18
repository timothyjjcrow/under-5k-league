import { describe, expect, it } from "vitest";
import { sourceFile } from "../../test/support/source-files";

// SOURCE GUARDS for the lobby bot's website side. The behaviour is tested in
// test/integration/inhouse-bot-lifecycle.itest.ts and dota-lobby.itest.ts;
// these pin the call sites no behavioural test can enumerate.

/** Lines with code only: comments may quote what the code must not do. */
const code = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

/** One top-level function's text, from its declaration to the next one. */
function fn(src: string, name: string): string {
  const start = src.search(new RegExp(`\\n(export )?(async )?function ${name}\\b`));
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const rest = src.slice(start + 1);
  const next = rest.search(/\n(export |async function |function |const |type )/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe("the bot panel's reads load only what they show", () => {
  const service = code(sourceFile("src/lib/dota-lobby-service.ts").text);

  it("resolveDotaLobby and the release select fields, never whole user rows", () => {
    expect(service).not.toMatch(/include:\s*\{/);
    expect(fn(service, "resolveDotaLobby")).toMatch(/select: INHOUSE_SPEC_SELECT/);
    expect(fn(service, "releaseInhouseBotLobby")).toMatch(/select: INHOUSE_SPEC_SELECT/);
    expect(service).toMatch(
      /const BOT_IDENTITY_SELECT = \{\s*name: true,\s*steamId: true,\s*dotaAccountIdV2: true,\s*legacyDotaAccountId: true,\s*\} as const;/,
    );
  });

  it("asks for the lifecycle flags on every request and reads every reply through the bounded reader", () => {
    expect(fn(service, "askLobbyBot")).toMatch(/withLifecycle: true/);
    expect(service.match(/await response\.json\(\)/g)).toBeNull();
    expect(service.match(/readBotReply\(/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe("every close releases the bot, after its commit and never awaited", () => {
  const service = code(sourceFile("src/lib/inhouse-service.ts").text);

  it.each([
    // [function, the commit the release follows]
    ["finishGame", "data: { status: INHOUSE_STATUS.AWAITING_RESULT, finishedAt }"],
    ["endInhouseGameFromBot", "data: { status: INHOUSE_STATUS.AWAITING_RESULT, finishedAt }"],
    ["cancelLobby", "if (!cancelled) {"],
    ["giveUpOnResult", "data: { status: INHOUSE_STATUS.CANCELLED, endReason }"],
    ["voidLastResult", "if (!voided) {"],
    ["applyResult", "data: { eloDeltas: JSON.stringify(deltas) }"],
  ])("%s", (name, commit) => {
    const body = fn(service, name);
    const release = body.indexOf("releaseInhouseBotAfterClose(");
    expect(release, `${name} releases the bot`).toBeGreaterThan(-1);
    expect(body.indexOf(commit), `${name}'s commit`).toBeGreaterThan(-1);
    expect(release).toBeGreaterThan(body.indexOf(commit));
    // Fire and forget: the close answers at once.
    expect(body).not.toMatch(/await releaseInhouseBotAfterClose\(/);
  });
});
