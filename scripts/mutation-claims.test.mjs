// node --test scripts/mutation-claims.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverClaims, resolveRenames } from "./mutation-claims.mjs";

const ids = (src, file = "src/lib/x.ts") =>
  discoverClaims(file, src).map((claim) => claim.id);

const claim = (predicate = 'status: "OPEN"') =>
  `await prisma.row.updateMany({ where: { id, ${predicate} }, data: {} });`;

test("comment prose never becomes an anchor", () => {
  const src = [
    "export async function claimBoardRow(id: string) {",
    "  // Taking it over is exactly what this function exists to prevent,",
    "  /* the ONE write in this function that is not a claim */",
    `  ${claim("value: current")}`,
    "}",
  ].join("\n");
  assert.deepEqual(ids(src), ["src/lib/x.ts::claimBoardRow::value#1"]);
});

test("rewording a comment leaves every id unchanged", () => {
  const body = (comment) =>
    [
      "export async function a(id: string) {",
      `  // ${comment}`,
      `  ${claim()}`,
      `  ${claim()}`,
      "}",
      "export async function b(id: string) {",
      `  ${claim()}`,
      "}",
    ].join("\n");
  const before = ids(body("plain words"));
  assert.deepEqual(before, [
    "src/lib/x.ts::a::status#1",
    "src/lib/x.ts::a::status#2",
    "src/lib/x.ts::b::status#1",
  ]);
  assert.deepEqual(ids(body("see function that, const other = (x) => x")), before);
});

test("inner helpers anchor to the enclosing top-level function", () => {
  const src = [
    "export async function setPlayerRank(id: string) {",
    "  const integer = (key: string): number => Number(key);",
    `  ${claim("mmr: 1")}`,
    "  async function inner() {",
    `    ${claim("rankTier: 2")}`,
    "  }",
    "  const finish = async () => {",
    `    ${claim("mmr: 1")}`,
    "  };",
    "  const also = async function named() {",
    `    ${claim("mmr: 1")}`,
    "  };",
    "  await inner(); await finish(); await also(); return integer('1');",
    "}",
  ].join("\n");
  assert.deepEqual(ids(src), [
    "src/lib/x.ts::setPlayerRank::mmr#1",
    "src/lib/x.ts::setPlayerRank::rankTier#1",
    "src/lib/x.ts::setPlayerRank::mmr#2",
    "src/lib/x.ts::setPlayerRank::mmr#3",
  ]);
});

test("strings that look like declarations are ignored", () => {
  const src = [
    "export async function real(id: string) {",
    '  const note = "function fake() {} const alsoFake = (";',
    "  const tpl = `async function templated(`;",
    `  ${claim()}`,
    "  return [note, tpl];",
    "}",
  ].join("\n");
  assert.deepEqual(ids(src), ["src/lib/x.ts::real::status#1"]);
});

test("top-level consts anchor by name, whatever the initializer", () => {
  const src = [
    "export const POST = async (req: Request) => {",
    `  ${claim()}`,
    "};",
    "export const handler = withAuth(async (id: string) => {",
    `  ${claim()}`,
    "});",
    "const first = 1, second = async () => {",
    `  ${claim()}`,
    "};",
  ].join("\n");
  assert.deepEqual(ids(src), [
    "src/lib/x.ts::POST::status#1",
    "src/lib/x.ts::handler::status#1",
    "src/lib/x.ts::second::status#1",
  ]);
});

test("overloads anchor to the implementation's name", () => {
  const src = [
    "export function detect(): Promise<boolean>;",
    "export function detect(o: object): Promise<object>;",
    "export async function detect(o?: object) {",
    "  const finish = (v: boolean) => v;",
    `  ${claim()}`,
    "  return finish(!!o);",
    "}",
  ].join("\n");
  assert.deepEqual(ids(src), ["src/lib/x.ts::detect::status#1"]);
});

test("TSX files parse as TSX", () => {
  const src = [
    "export async function action(id: string) {",
    "  const view = <div className=\"x\">{id}</div>;",
    `  ${claim()}`,
    "  return view;",
    "}",
  ].join("\n");
  assert.deepEqual(ids(src, "src/app/x.tsx"), [
    "src/app/x.tsx::action::status#1",
  ]);
});

test("identity keys alone are not a claim, and removing a claim never re-binds another function's id", () => {
  const withBoth = [
    "export async function a(id: string) {",
    `  ${claim()}`,
    "}",
    "export async function b(id: string) {",
    "  await prisma.row.updateMany({ where: { id, seasonId }, data: {} });",
    `  ${claim()}`,
    "}",
  ].join("\n");
  assert.deepEqual(ids(withBoth), [
    "src/lib/x.ts::a::status#1",
    "src/lib/x.ts::b::status#1",
  ]);
  const withoutA = withBoth.replace(claim(), "");
  assert.deepEqual(ids(withoutA), ["src/lib/x.ts::b::status#1"]);
});

const LIVE = ["f.ts::moved::status#1", "f.ts::kept::status#1", "f.ts::eq::status#1"];
const baseline = (renames) => ({
  protected: ["f.ts::kept::status#1", "old.ts::moved::status#1"],
  equivalent: ["old.ts::eq::status#1"],
  ...(renames === undefined ? {} : { renames }),
});

test("no renames leaves both lists as they are", () => {
  const out = resolveRenames(baseline(), LIVE);
  assert.deepEqual(out.problems, []);
  assert.deepEqual(out.protected, baseline().protected);
  assert.deepEqual(out.equivalent, baseline().equivalent);
});

test("a rename carries each classification to the moved id", () => {
  const out = resolveRenames(
    baseline({
      "old.ts::moved::status#1": "f.ts::moved::status#1",
      "old.ts::eq::status#1": "f.ts::eq::status#1",
    }),
    LIVE,
  );
  assert.deepEqual(out.problems, []);
  assert.deepEqual(out.protected, [
    "f.ts::kept::status#1",
    "f.ts::moved::status#1",
  ]);
  assert.deepEqual(out.equivalent, ["f.ts::eq::status#1"]);
});

test("a rename must be an actual move", () => {
  const problems = (renames) => resolveRenames(baseline(renames), LIVE).problems;
  assert.deepEqual(problems({ "unknown::x::status#1": "f.ts::moved::status#1" }), [
    "rename source is neither protected nor equivalent: unknown::x::status#1",
  ]);
  assert.deepEqual(problems({ "f.ts::kept::status#1": "f.ts::moved::status#1" }), [
    "rename source is still a live claim, so nothing moved: f.ts::kept::status#1",
  ]);
  assert.deepEqual(problems({ "old.ts::moved::status#1": "gone.ts::x::status#1" }), [
    "rename target is not a live claim: gone.ts::x::status#1",
  ]);
  assert.deepEqual(problems({ "old.ts::moved::status#1": "f.ts::kept::status#1" }), [
    "rename target is already classified: f.ts::kept::status#1",
  ]);
  assert.deepEqual(
    problems({
      "old.ts::moved::status#1": "f.ts::moved::status#1",
      "old.ts::eq::status#1": "f.ts::moved::status#1",
    }),
    ["more than one rename targets the same claim: f.ts::moved::status#1"],
  );
});

test("a malformed renames value is refused", () => {
  const message = "renames must be an object mapping each old claim id to its new id";
  for (const renames of [null, [], "x", { "old.ts::moved::status#1": 1 }]) {
    const out = resolveRenames(baseline(renames), LIVE);
    assert.deepEqual(out.problems, [message]);
    assert.deepEqual(out.protected, baseline().protected);
  }
});
