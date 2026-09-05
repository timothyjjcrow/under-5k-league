import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

export const STEAM_AUTH_FILE = "steam-auth.json";
const MAX_FILE_BYTES = 24 * 1024;
const SESSION_ERROR = "Steam bot session is invalid or expired. Run npm run login.";
const STORAGE_ERROR = "Cannot access the private Steam bot session file. Check the state directory permissions.";

function validSteamId(value) {
  return typeof value === "string" && /^\d{17}$/.test(value) &&
    BigInt(value) > 76561197960265728n && BigInt(value) <= 76561202255233023n;
}

function validate(auth) {
  try {
    if (!auth || typeof auth !== "object" || Array.isArray(auth) ||
        !validSteamId(auth.steamId) || typeof auth.refreshToken !== "string" ||
        auth.refreshToken.length > 16 * 1024 ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(auth.refreshToken))
      throw new Error();
    // This checks the token's shape and account binding. Steam verifies its
    // signature and revocation status when the worker actually logs on.
    const payload = JSON.parse(Buffer.from(auth.refreshToken.split(".")[1], "base64url").toString("utf8"));
    if (!payload || payload.iss !== "steam" || !Array.isArray(payload.aud) ||
        !payload.aud.includes("client") || payload.sub !== auth.steamId ||
        !Number.isSafeInteger(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000))
      throw new Error();
    if (auth.accountName !== undefined && (typeof auth.accountName !== "string" ||
        !auth.accountName.length || auth.accountName.length > 128 || /[\s\x00-\x1f\x7f]/.test(auth.accountName)))
      throw new Error();
    return {
      refreshToken: auth.refreshToken,
      steamId: auth.steamId,
      ...(auth.accountName === undefined ? {} : { accountName: auth.accountName }),
    };
  } catch {
    // Never attach the original error or include decoded claims in errors.
    throw new Error(SESSION_ERROR);
  }
}

function privateDirectory(stateDir, create) {
  if (create) mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const info = lstatSync(stateDir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error();
  chmodSync(stateDir, 0o700);
}

/** Returns null only when the session file or state directory does not exist. */
export function readSteamAuth(stateDir) {
  let descriptor;
  let raw;
  try {
    privateDirectory(stateDir, false);
    const file = resolve(stateDir, STEAM_AUTH_FILE);
    const entry = lstatSync(file);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error();
    descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_FILE_BYTES) throw new Error();
    fchmodSync(descriptor, 0o600);
    raw = readFileSync(descriptor, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(STORAGE_ERROR);
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch {}
    }
  }
  let auth;
  try {
    auth = JSON.parse(raw);
  } catch {
    throw new Error(SESSION_ERROR);
  }
  return validate(auth);
}

/** Validates and atomically replaces the session, retaining private permissions. */
export function writeSteamAuth(stateDir, auth) {
  const saved = validate(auth);
  let temporary;
  let descriptor;
  try {
    privateDirectory(stateDir, true);
    const destination = resolve(stateDir, STEAM_AUTH_FILE);
    try {
      const existing = lstatSync(destination);
      if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) throw new Error();
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    temporary = resolve(stateDir, `.${STEAM_AUTH_FILE}.${randomUUID()}.tmp`);
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(saved)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, destination);
    temporary = undefined;
  } catch {
    throw new Error(STORAGE_ERROR);
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch {}
    }
    if (temporary) {
      try { unlinkSync(temporary); } catch {}
    }
  }
  return saved;
}
