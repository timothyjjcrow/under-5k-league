import { describe, expect, it } from "vitest";
import { sourceFile, sourceFiles } from "../../test/support/source-files";

// SOURCE GUARDS for the draft room's rule P (draft-room-version.ts): every
// commit the draft room shows is followed by publishDraftRoomChange() before
// any Discord call and before the response, and never inside a transaction.
// Each server instance serves its room snapshot only while the published
// version is unchanged, and a held tick wakes only on a publish, so a writer
// that forgets to publish shows viewers stale rows (a sold player still on
// the block) until their hold ends and the snapshot ages out, up to about
// 40s. The behaviour is tested in test/integration/draft-room-longpoll.itest.ts;
// these pin the sites no behavioural test can enumerate.

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
  const next = rest.search(/\n(export |async function |function |const |type |class )/);
  return next === -1 ? rest : rest.slice(0, next);
}

const PUBLISH = "publishDraftRoomChange(";
/** The tables loadDraftRoomRows reads (users aside: display only). */
const ROOM_TABLE_WRITE =
  /\.(draft|draftLot|draftRun|bid|team|teamMember|registration)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/;
/** The engine publishes its own commits (pinned below). */
const ENGINE = new Set(["src/lib/draft-service.ts", "src/lib/draft-history.ts"]);
/** Writers of those tables whose writes the room doesn't show, and why. */
const NOT_SHOWN: Record<string, string> = {
  "src/app/actions/admin-schedule-results.ts":
    "writes Team.groupKey at schedule generation; the room shows no groups",
  "src/lib/side-game-claims.ts":
    "a lifecycle lock that writes a Draft row's status to itself (SQLite only); nothing the room shows moves",
  "src/lib/season.ts":
    "reactivateSeason parks an archived season's draft; its only caller, reactivateSeasonAction, publishes",
};

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

/** The auction's writers: each publishes its own commit. */
const ENGINE_WRITERS = [
  "resolveExpiredNomination",
  "resolveStalledNomination",
  "pauseDraft",
  "resumeDraft",
  "voidCurrentLot",
  "undoLastSale",
  "abortDraft",
  "nominatePlayer",
  "placeBid",
];

describe("rule P (draft): who publishes the draft room's changes", () => {
  const src = sourceFiles("src/**/*.{ts,tsx}", 300).filter(
    (f) => !/\.test\.tsx?$/.test(f.path),
  );

  it("every writer of the room's tables outside the engine publishes, or is listed with its reason", () => {
    const writers = src.filter(
      (f) => !ENGINE.has(f.path) && ROOM_TABLE_WRITE.test(code(f.text)),
    );
    // Captains and the draft, the roster and signups, the season, the
    // signup save, team identity, and the listed exceptions.
    expect(writers.length).toBeGreaterThanOrEqual(8);
    for (const file of writers) {
      if (NOT_SHOWN[file.path]) continue;
      expect(code(file.text), `${file.path} writes the draft room's rows`).toContain(
        PUBLISH,
      );
    }
    // A listed exception that no longer writes hides nothing: drop it.
    for (const path of Object.keys(NOT_SHOWN)) {
      expect(writers.map((f) => f.path)).toContain(path);
    }
  });

  it("each engine writer publishes after its transaction, before Discord", () => {
    const service = code(sourceFile("src/lib/draft-service.ts").text);
    // Every exported function that opens a transaction is one of the
    // writers, or the room's own read: a new writer must be added here.
    const withTransactions = [
      ...service.matchAll(/\nexport async function (\w+)/g),
    ]
      .map((m) => m[1])
      .filter((name) => fn(service, name).includes("$transaction("));
    expect(withTransactions.sort()).toEqual(
      [...ENGINE_WRITERS, "loadDraftRoomRows"].sort(),
    );
    for (const name of ENGINE_WRITERS) {
      const body = fn(service, name);
      const ranges = transactionRanges(body);
      expect(ranges.length, `${name}'s transaction`).toBeGreaterThan(0);
      const txEnd = ranges[ranges.length - 1][1];
      expect(
        body.indexOf(PUBLISH, txEnd),
        `${name} publishes after its transaction`,
      ).toBeGreaterThan(txEnd);
    }
    // Only a commit publishes: each awaits the transaction's result first.
    for (const name of ENGINE_WRITERS.slice(2)) {
      expect(fn(service, name), name).toMatch(
        /if \(result\.ok\) await publishDraftRoomChange\(\);\s*return result;/,
      );
    }
    for (const name of ENGINE_WRITERS.slice(0, 2)) {
      ordered(
        fn(service, name),
        "if (resolved) await publishDraftRoomChange();",
        "announceDraftComplete(",
        "return resolved;",
      );
    }
    // The room's read never publishes.
    expect(fn(service, "loadDraftRoomRows")).not.toContain(PUBLISH);
    expect(fn(service, "buildDraftState")).not.toContain(PUBLISH);
  });

  it("never publishes inside a transaction", () => {
    const publishers = src.filter((f) => code(f.text).includes(PUBLISH));
    // The engine, the tick's state, the version module, the captain and
    // draft actions, the roster actions, the season actions, the signup
    // actions and team identity.
    expect(publishers.length).toBeGreaterThanOrEqual(8);
    let transactions = 0;
    for (const file of publishers) {
      const text = code(file.text);
      const ranges = transactionRanges(text);
      transactions += ranges.length;
      for (const m of text.matchAll(/publishDraftRoomChange\(/g)) {
        const inside = ranges.find(([a, b]) => m.index! > a && m.index! < b);
        expect(
          inside,
          `${file.path}: a publish inside a $transaction (at ${m.index})`,
        ).toBeUndefined();
      }
    }
    // The matcher saw the transactions it must look inside.
    expect(transactions).toBeGreaterThanOrEqual(25);
  });
});

describe("rule P (draft): the action sites, in order", () => {
  it.each([
    ["src/app/actions/admin-captains-draft.ts", "startDraft", ["started = await prisma.$transaction(", PUBLISH, "sendDiscordMessage("]],
    ["src/app/actions/admin-captains-draft.ts", "addCaptain", ["added = await prisma.$transaction(", PUBLISH, "sendDiscordMessage("]],
    ["src/app/actions/admin-captains-draft.ts", "removeCaptain", ["removed = await prisma.$transaction(", PUBLISH, "sendDiscordMessage("]],
    ["src/app/actions/admin-captains-draft.ts", "changeCaptain", ["changed = await prisma.$transaction(", PUBLISH, "sendDiscordMessage("]],
    ["src/app/actions/admin-captains-draft.ts", "transferCaptaincy", ["transferred = await prisma.$transaction(", PUBLISH, "sendDiscordMessage("]],
    ["src/app/actions/admin-captains-draft.ts", "randomizeDraftOrder", ["count = await prisma.$transaction(", PUBLISH, "refresh()"]],
    ["src/app/actions/admin-captains-draft.ts", "setDraftNight", ["await prisma.$transaction(", PUBLISH, "sendDiscordMessage("]],
    ["src/app/actions/admin-season.ts", "setSeasonPhase", ["await prisma.$transaction(", PUBLISH, "sendDiscordMessage("]],
    ["src/app/actions/admin-season.ts", "setDraftSettings", ["await prisma.$transaction(", PUBLISH, "refresh()"]],
    ["src/app/actions/admin-season.ts", "archiveIncompleteSeasonAction", ["await prisma.$transaction(", PUBLISH, "refresh()"]],
    ["src/app/actions/admin-season.ts", "reactivateSeasonAction", ["await reactivateSeason(", PUBLISH, "refresh()"]],
    ["src/app/actions/admin-roster.ts", "withdrawSignup", ["await prisma.$transaction(", PUBLISH, "refresh()"]],
    ["src/app/actions/registration.ts", "saveRegistration", ["createdNew = await prisma.$transaction(", PUBLISH, "sendDiscordMessage("]],
    ["src/app/actions/registration.ts", "leaveLeague", ["await prisma.$transaction(", PUBLISH, "refresh()"]],
    ["src/lib/team-identity-service.ts", "saveTeamIdentity", ["const saved = await prisma.$transaction(", PUBLISH, "return saved;"]],
  ] as const)("%s %s publishes after its commit", (path, name, marks) => {
    const body = code(fn(sourceFile(path).text, name));
    expect(body.length, `${name} not found in ${path}`).toBeGreaterThan(0);
    ordered(body, ...marks);
  });
});
