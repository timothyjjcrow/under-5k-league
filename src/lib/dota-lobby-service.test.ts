import { describe, expect, it } from "vitest";
import { sourceFile, sourceFiles } from "../../test/support/source-files";

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

describe("a 1v1's bot job (kind duel)", () => {
  const service = code(sourceFile("src/lib/dota-lobby-service.ts").text);
  const duels = code(sourceFile("src/lib/inhouse-duel-service.ts").text);

  it("reads only the spec's fields for the panel and the release", () => {
    expect(fn(service, "resolveDotaLobby")).toMatch(/select: DUEL_SPEC_SELECT/);
    expect(fn(service, "releaseDuelBotLobby")).toMatch(/select: DUEL_SPEC_SELECT/);
  });

  it.each([
    // [function, the commit the release follows]
    ["finishDuel", "data: { status: INHOUSE_DUEL_STATUS.AWAITING_RESULT, finishedAt }"],
    ["callOffDuel", "data: { status: INHOUSE_DUEL_STATUS.CANCELLED, endReason, completedAt }"],
    ["cancelDuel", "updateMany("],
    ["endDuelFromBot", "data: { status: INHOUSE_DUEL_STATUS.AWAITING_RESULT, finishedAt }"],
    ["cancelDuelFromBot", "data: { status: INHOUSE_DUEL_STATUS.CANCELLED, endReason, completedAt }"],
    ["applyDuelResult", "updateMany("],
    ["giveUpOnDuels", "updateMany("],
  ])("%s releases the bot after its commit, never awaited", (name, commit) => {
    const body = fn(duels, name);
    const release = body.indexOf("releaseDuelBotAfterClose(");
    expect(release, `${name} releases the bot`).toBeGreaterThan(-1);
    expect(body.indexOf(commit), `${name}'s commit`).toBeGreaterThan(-1);
    expect(release).toBeGreaterThan(body.indexOf(commit));
    expect(body).not.toMatch(/await releaseDuelBotAfterClose\(/);
  });

  // Tim's call (2026-10-27): a pair's lobby is asked for at once, after the
  // commit and the room's publish, and after the response; never inside a
  // transaction or a room poll. The worker's retry is the only other caller.
  it("asks for a pair's lobby only after the join's commit, publish and response", () => {
    const join = fn(duels, "joinDuelQueue");
    const create = join.indexOf("runAfterResponse(() => createDuelBotLobby(");
    expect(create).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(join.lastIndexOf("$transaction("));
    expect(create).toBeGreaterThan(join.indexOf("await publishInhouseRoomChange()"));
    const callers = sourceFiles("src/**/*.{ts,tsx}", 50)
      .filter((f) => !/\.test\.tsx?$/.test(f.path))
      .filter((f) => /createDuelBotLobby\(|retryDuelBotCreate\(/.test(code(f.text)))
      .map((f) => f.path)
      .sort();
    expect(callers).toEqual([
      "src/lib/inhouse-duel-bot.ts",
      "src/lib/inhouse-duel-service.ts",
    ]);
    expect(fn(duels, "runDuelWorkerSteps")).toMatch(/retryDuelBotCreate\(read/);
  });
});
