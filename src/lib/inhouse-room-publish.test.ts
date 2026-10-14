import { describe, expect, it } from "vitest";
import { sourceFile, sourceFiles } from "../../test/support/source-files";

// SOURCE GUARDS for rule P (inhouse-room-version.ts): every commit the
// inhouse room shows is followed by publishInhouseRoomChange() before any
// Discord or OpenDota call and before the response, and never inside a
// transaction. Each server instance serves its room snapshot only while the
// published version is unchanged, so a writer that forgets to publish shows
// players stale rows (a drafted player back in the pool, the pick chime
// again) for up to the snapshot's max age. The behaviour is tested in
// test/integration/inhouse-room-cache.itest.ts; these pin the sites no
// behavioural test can enumerate.

/** Lines with code only: comments may quote what the code must not do. */
const code = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

/**
 * One top-level function's text, from its declaration to the next one. The
 * LAST declaration, so an overloaded function gives its implementation.
 */
function fn(src: string, name: string): string {
  const all = [
    ...src.matchAll(new RegExp(`\\n(export )?(async )?function ${name}\\b`, "g")),
  ];
  if (all.length === 0) return "";
  const start = all[all.length - 1].index!;
  const rest = src.slice(start + 1);
  const next = rest.search(/\n(export |async function |function |const |type )/);
  return next === -1 ? rest : rest.slice(0, next);
}

const PUBLISH = "publishInhouseRoomChange(";
const ROOM_TABLE_WRITE =
  /\.(inhouseQueueEntry|inhouseLobby|inhouseLobbyPlayer)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/;

/** `before` occurs, and the first `after` following it comes later still. */
function ordered(body: string, ...marks: string[]) {
  let at = -1;
  for (const mark of marks) {
    const next = body.indexOf(mark, at + 1);
    expect(next, `"${mark}" after "${marks.join('" → "')}"`).toBeGreaterThan(at);
    at = next;
  }
}

/**
 * The [start, end) text ranges of every `$transaction(` call's argument
 * list, by paren matching outside string literals. Comments are already
 * stripped by `code`.
 */
function transactionRanges(src: string): [number, number][] {
  const ranges: [number, number][] = [];
  const opener = /\$transaction\(/g;
  for (let m = opener.exec(src); m; m = opener.exec(src)) {
    let depth = 0;
    let quote: string | null = null;
    for (let i = m.index + "$transaction".length; i < src.length; i += 1) {
      const c = src[i];
      if (quote) {
        if (c === "\\") i += 1;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "(") depth += 1;
      else if (c === ")" && --depth === 0) {
        ranges.push([m.index, i + 1]);
        break;
      }
    }
  }
  return ranges;
}

describe("rule P: who publishes the inhouse room's changes", () => {
  const src = sourceFiles("src/**/*.{ts,tsx}", 300);

  it("every writer of the room's tables outside the engine publishes", () => {
    const writers = src.filter(
      (f) =>
        f.path !== "src/lib/inhouse-service.ts" &&
        ROOM_TABLE_WRITE.test(code(f.text)),
    );
    // Today: the lobby bot's start (dota-lobby) and the result outbox.
    expect(writers.map((f) => f.path).length).toBeGreaterThanOrEqual(2);
    for (const file of writers) {
      expect(code(file.text), `${file.path} writes the room's rows`).toContain(
        PUBLISH,
      );
    }
  });

  it("every importer of the engine's writers publishes, or imports only self-publishing ones", () => {
    // Reads, pure helpers and writers that publish their own commits.
    const SAFE = new Set([
      "loadInhouseJoinFacts",
      "loadInhouseRoomRows",
      "loadViewerExtras",
      "buildInhouseState",
      "boardInputFrom",
      "voidLastResult",
      "maybeFormLobby",
      "maybeAutoDetectResult",
    ]);
    // Callers that publish around what they call, and why.
    const PUBLISHING_CALLERS: Record<string, string> = {
      "src/app/api/inhouse/route.ts":
        "every dispatched mutation publishes in the route's outer finally",
      "src/lib/inhouse-room-state.ts":
        "maintenance goes through getInhouseState, which publishes; a present viewer's heartbeat moves only lastSeenAt, which the seenAt memo tracks",
      "src/lib/result-sync-service.ts":
        "syncInhouse publishes after its resolvers and in the settle wrapper",
    };
    const importers = src.filter((f) =>
      /import\s*\{[^}]*\}\s*from\s*["'](?:@\/lib|\.)\/inhouse-service["']/.test(
        f.text,
      ),
    );
    expect(importers.length).toBeGreaterThanOrEqual(4);
    for (const file of importers) {
      const names = [
        ...file.text.matchAll(
          /import\s*\{([^}]*)\}\s*from\s*["'](?:@\/lib|\.)\/inhouse-service["']/g,
        ),
      ]
        .flatMap((m) => m[1].split(","))
        .map((n) => n.trim())
        .filter((n) => n && !n.startsWith("type "));
      const unsafe = names.filter((n) => !SAFE.has(n));
      if (unsafe.length === 0) continue;
      expect(
        PUBLISHING_CALLERS[file.path],
        `${file.path} imports ${unsafe.join(", ")}: publish after them or list it here with the reason`,
      ).toBeTruthy();
      expect(code(file.text), file.path).toContain(PUBLISH);
    }
  });

  it("never publishes inside a transaction", () => {
    const publishers = src.filter((f) => code(f.text).includes(PUBLISH));
    // The engine, the route, the poll, the worker, the bot route, the
    // outbox, the fixture route and the three profile writers' files.
    expect(publishers.length).toBeGreaterThanOrEqual(9);
    let transactions = 0;
    for (const file of publishers) {
      const text = code(file.text);
      const ranges = transactionRanges(text);
      transactions += ranges.length;
      for (const m of text.matchAll(/publishInhouseRoomChange\(/g)) {
        const inside = ranges.find(([a, b]) => m.index! > a && m.index! < b);
        expect(
          inside,
          `${file.path}: a publish inside a $transaction (at ${m.index})`,
        ).toBeUndefined();
      }
    }
    // The matcher saw the transactions it must look inside.
    expect(transactions).toBeGreaterThanOrEqual(20);
  });
});

describe("rule P: the publish sites, in order", () => {
  const service = code(sourceFile("src/lib/inhouse-service.ts").text);

  it("getInhouseState's maintenance block publishes after the chain, before its reads and board", () => {
    const body = fn(service, "getInhouseState");
    const block = body.slice(
      body.indexOf("if (runMaintenance) {"),
      body.indexOf("const rows = await loadInhouseRoomRows("),
    );
    expect(block.length).toBeGreaterThan(0);
    ordered(block, "await resolveStalledPick()", "maybeAutoDetectResult()", PUBLISH);
    ordered(body, PUBLISH, "loadInhouseRoomRows(", "syncInhouseBoard(");
  });

  it("syncInhouse publishes after the resolvers and before the OpenDota scan, and its caller in a finally", () => {
    const sync = sourceFile("src/lib/result-sync-service.ts");
    const body = code(fn(sync.text, "syncInhouse"));
    ordered(body, "await resolveStalledPick()", PUBLISH, "maybeAutoDetectResult(");
    expect(code(sync.text)).toMatch(
      /settle\(async \(\) => \{\s*try \{\s*return await syncInhouse\(options\);\s*\} finally \{\s*await publishInhouseRoomChange\(\);/,
    );
  });

  it.each([
    ["formOneLobby", [PUBLISH, "sendInhouseDiscordMessage("]],
    ["joinQueue", [PUBLISH, "maybeFormLobby()", "sendInhouseDiscordMessage("]],
    ["applyResult", ["eloDeltas: JSON.stringify(deltas)", PUBLISH, "deliverInhouseAnnouncements("]],
    ["voidLastResult", ["status: INHOUSE_STATUS.CANCELLED", PUBLISH, "deliverInhouseAnnouncements("]],
    ["autoDetectResult", ["data: { detectedAt: new Date() }", PUBLISH, "lookUpLobbyGame("]],
    [
      "maybeAutoDetectResult",
      ["data: { detectedAt: new Date(now) }", PUBLISH, "lookUpLobbyGame(", "data: { detectedAt: lobby.detectedAt }", PUBLISH],
    ],
  ] as const)("%s publishes after its commit, before its provider call", (name, marks) => {
    const body = fn(service, name);
    expect(body.length, `${name} not found`).toBeGreaterThan(0);
    ordered(body, ...marks);
  });

  it.each([
    ["src/app/api/dota-lobby/route.ts", /if \(started\.count > 0\) \{\s*await publishInhouseRoomChange\(\);/],
    ["src/lib/inhouse-announcement-outbox.ts", /if \(outcome !== "skipped"\) await publishInhouseRoomChange\(\);/],
    ["src/app/api/test/cache/route.ts", /await publishInhouseRoomChange\(\);/],
    ["src/lib/users.ts", /\}\);\s*await publishInhouseRoomChange\(\);\s*return user;/],
  ] as const)("%s publishes", (path, pattern) => {
    expect(code(sourceFile(path).text)).toMatch(pattern);
  });

  it("the player's own signup and Steam refresh publish before Discord and the reply", () => {
    const actions = sourceFile("src/app/actions/registration.ts");
    ordered(code(fn(actions.text, "saveRegistration")), "saved = true", PUBLISH, "sendDiscordMessage(");
    ordered(code(fn(actions.text, "refreshSteamProfileFor")), "prisma.user.update(", PUBLISH, "refresh()");
  });
});
