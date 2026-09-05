import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSteamAuth, STEAM_AUTH_FILE, writeSteamAuth } from "./auth-store.mjs";

const steamId = "76561198000000099";
const secretMarker = "PRIVATE_TOKEN_MUST_NOT_APPEAR";
const token = (claims = {}) => [
  Buffer.from(JSON.stringify({ typ: "JWT", alg: "EdDSA" })).toString("base64url"),
  Buffer.from(JSON.stringify({ iss: "steam", sub: steamId, aud: ["client", "derive"], exp: Math.floor(Date.now() / 1000) + 3600, ...claims })).toString("base64url"),
  Buffer.from(secretMarker).toString("base64url"),
].join(".");
const auth = (overrides = {}) => ({ refreshToken: token(), steamId, accountName: "bot_account", ...overrides });

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "ld2l-auth-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, state: join(dir, "state") };
}

test("missing session returns null without creating state", (t) => {
  const { state } = setup(t);
  assert.equal(readSteamAuth(state), null);
  assert.equal(existsSync(state), false);
});

test("session writes are private, atomic replacements and discard unrelated data", (t) => {
  const { state } = setup(t);
  const first = auth();
  assert.deepEqual(writeSteamAuth(state, { ...first, password: "not stored" }), first);
  assert.deepEqual(readSteamAuth(state), first);
  assert.equal(readFileSync(join(state, STEAM_AUTH_FILE), "utf8").includes("not stored"), false);
  chmodSync(state, 0o755);
  chmodSync(join(state, STEAM_AUTH_FILE), 0o644);
  const renewed = auth({ refreshToken: token({ exp: Math.floor(Date.now() / 1000) + 7200 }) });
  writeSteamAuth(state, renewed);
  assert.deepEqual(readSteamAuth(state), renewed);
  assert.deepEqual(readdirSync(state), [STEAM_AUTH_FILE]);
  if (process.platform !== "win32") {
    assert.equal(statSync(state).mode & 0o777, 0o700);
    assert.equal(statSync(join(state, STEAM_AUTH_FILE)).mode & 0o777, 0o600);
  }
});

test("reading existing session tightens permissions", (t) => {
  const { state } = setup(t);
  writeSteamAuth(state, auth());
  chmodSync(state, 0o755);
  chmodSync(join(state, STEAM_AUTH_FILE), 0o644);
  readSteamAuth(state);
  if (process.platform !== "win32") {
    assert.equal(statSync(state).mode & 0o777, 0o700);
    assert.equal(statSync(join(state, STEAM_AUTH_FILE)).mode & 0o777, 0o600);
  }
});

test("expired, wrong-audience, mismatched and malformed tokens cannot replace a valid session", (t) => {
  const { state } = setup(t);
  const original = auth();
  writeSteamAuth(state, original);
  const invalid = [
    auth({ refreshToken: token({ exp: Math.floor(Date.now() / 1000) - 1 }) }),
    auth({ refreshToken: token({ exp: "9999999999" }) }),
    auth({ refreshToken: token({ aud: ["web"] }) }),
    auth({ refreshToken: token({ aud: "client" }) }),
    auth({ refreshToken: token({ iss: "other" }) }),
    auth({ refreshToken: token({ sub: "76561198000000098" }) }),
    auth({ steamId: "76561197960265728" }),
    auth({ steamId: "76561202255233024" }),
    auth({ refreshToken: secretMarker }),
    auth({ refreshToken: `e30.${Buffer.from(secretMarker).toString("base64url")}.c2ln` }),
    auth({ accountName: `bot\n${secretMarker}` }),
  ];
  for (const value of invalid) {
    assert.throws(() => writeSteamAuth(state, value), (error) => {
      assert.equal(error.message, "Steam bot session is invalid or expired. Run npm run login.");
      assert.equal(error.stack.includes(value.refreshToken), false);
      assert.equal(error.stack.includes(secretMarker), false);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.deepEqual(readSteamAuth(state), original);
  }
});

test("malformed or expired stored sessions fail with a fixed secret-free message", (t) => {
  const { state } = setup(t);
  writeSteamAuth(state, auth());
  for (const raw of [secretMarker, JSON.stringify(auth({ refreshToken: token({ exp: 1 }) })), JSON.stringify(auth({ steamId: "76561198000000098" }))]) {
    writeFileSync(join(state, STEAM_AUTH_FILE), raw);
    assert.throws(() => readSteamAuth(state), (error) => {
      assert.equal(error.message, "Steam bot session is invalid or expired. Run npm run login.");
      assert.equal(error.stack.includes(secretMarker), false);
      assert.equal(error.stack.includes(raw), false);
      return true;
    });
  }
});

test("symlink storage and filesystem errors do not expose paths or touch unrelated files", (t) => {
  const { dir, state } = setup(t);
  writeSteamAuth(state, auth());
  const target = join(dir, secretMarker);
  writeFileSync(target, "unrelated", { mode: 0o644 });
  rmSync(join(state, STEAM_AUTH_FILE));
  symlinkSync(target, join(state, STEAM_AUTH_FILE));
  for (const action of [() => readSteamAuth(state), () => writeSteamAuth(state, auth()), () => writeSteamAuth(target, auth())]) {
    assert.throws(action, (error) => {
      assert.equal(error.message, "Cannot access the private Steam bot session file. Check the state directory permissions.");
      assert.equal(error.stack.includes(secretMarker), false);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  assert.equal(readFileSync(target, "utf8"), "unrelated");
  if (process.platform !== "win32") assert.equal(statSync(target).mode & 0o777, 0o644);
});

test("Steam IDs at the full uint32 account boundary remain valid", (t) => {
  const { state } = setup(t);
  const id = "76561202255233023";
  const boundary = auth({ steamId: id, refreshToken: token({ sub: id }), accountName: undefined });
  writeSteamAuth(state, boundary);
  assert.equal(readSteamAuth(state).steamId, id);
});
