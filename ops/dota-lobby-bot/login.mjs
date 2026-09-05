import { unlinkSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { LoginSession, EAuthTokenPlatformType, EAuthSessionGuardType } from "steam-session";
import QRCode from "qrcode";
import { writeSteamAuth } from "./auth-store.mjs";
import { runWithProcessLock } from "./process-lock.mjs";

const passwordLogin = process.argv.includes("--password");
if (process.argv.includes("--help")) {
  console.log("npm run login             Sign in by scanning with Steam Guard\nnpm run login -- --password  Enter credentials privately in this terminal\nAdd --code to use a Steam Guard code instead of mobile approval.");
  process.exit(0);
}
if (passwordLogin && !process.stdin.isTTY) {
  console.error("Open a terminal to enter credentials. Do not pass passwords as command arguments.");
  process.exit(1);
}
const stateDir = resolve(process.env.DOTA_BOT_STATE_DIR ?? "./state");
try {
  await runWithProcessLock(stateDir);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const qrPath = resolve(stateDir, "steam-login.png");
const session = new LoginSession(EAuthTokenPlatformType.SteamClient, {
  machineFriendlyName: "GGD2L in-house lobby bot",
});
session.loginTimeout = 300_000;
const abort = new AbortController();
let finished = false;
let cleaned = false;
let settle;
const completed = new Promise((r) => { settle = r; });
function clean() {
  if (cleaned) return;
  cleaned = true;
  for (const path of [qrPath]) {
    try { unlinkSync(path); } catch {}
  }
}
function finish(ok, message) {
  if (finished) return;
  finished = true;
  abort.abort();
  session.cancelLoginAttempt();
  clean();
  if (ok) console.log(message);
  else console.error(message);
  process.exitCode = ok ? 0 : 1;
  settle();
}
process.on("exit", clean);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => finish(false, "Steam sign-in cancelled."));
session.on("timeout", () => finish(false, "Steam sign-in expired. Run npm run login to try again."));
session.on("error", () => finish(false, "Steam sign-in failed. Check your connection and account, then run npm run login again."));
session.on("remoteInteraction", () => {
  console.log("Steam Guard detected the scan. Approve the GGD2L in-house lobby bot login for your bot account.");
});
session.on("authenticated", () => {
  try {
    writeSteamAuth(stateDir, {
      refreshToken: session.refreshToken,
      steamId: session.steamID.getSteamID64(),
      accountName: session.accountName,
    });
    finish(true, `Steam bot signed in as ${session.accountName} (${session.steamID.getSteamID64()}). Session saved privately. Run npm start to connect to Dota.`);
  } catch {
    finish(false, "Steam approved the login, but the session could not be saved. Check state-directory permissions and try again.");
  }
});

async function ask(prompt, hidden = false) {
  // Readline controls terminal echo; discard its redraws while a secret is typed.
  const output = hidden ? new Writable({ write(_chunk, _encoding, callback) { callback(); } }) : process.stdout;
  const input = createInterface({ input: process.stdin, output, terminal: true });
  input.once("SIGINT", () => finish(false, "Steam sign-in cancelled."));
  try {
    if (hidden) process.stdout.write(prompt);
    return await input.question(hidden ? "" : prompt, { signal: abort.signal });
  } finally {
    input.close();
    if (hidden) process.stdout.write("\n");
  }
}

try {
  if (passwordLogin) {
    console.log("Use the dedicated lobby bot account. Your password is not saved.");
    const accountName = (await ask("Steam account name: ")).trim();
    const result = await session.startWithCredentials({ accountName, password: await ask("Steam password (hidden): ", true) });
    const actions = result.validActions ?? [];
    const confirmation = actions.some((a) => a.type === EAuthSessionGuardType.DeviceConfirmation || a.type === EAuthSessionGuardType.EmailConfirmation);
    const code = actions.some((a) => a.type === EAuthSessionGuardType.EmailCode || a.type === EAuthSessionGuardType.DeviceCode);
    if (result.actionRequired && confirmation && !process.argv.includes("--code")) {
      console.log("Approve this login in Steam Guard or the email Steam sent you. Waiting up to five minutes.");
    } else if (result.actionRequired && code) {
      let accepted = false;
      for (let attempt = 0; attempt < 3 && !finished; attempt++) {
        try {
          await session.submitSteamGuardCode((await ask("Steam Guard code (hidden): ", true)).trim());
          accepted = true;
          break;
        } catch {
          if (!finished) console.error("Steam did not accept that code. Check the latest code.");
        }
      }
      if (!accepted && !finished) finish(false, "Steam Guard could not be verified. Run npm run login to try again.");
    } else if (result.actionRequired) {
      finish(false, "This account requires an unsupported sign-in action. Complete its account prompts in Steam first.");
    }
  } else {
    const result = await session.startWithQR();
    if (!finished) {
      await QRCode.toFile(qrPath, result.qrChallengeUrl, { width: 480, margin: 4, errorCorrectionLevel: "M" });
      chmodSync(qrPath, 0o600);
      console.log(`Scan this QR image with Steam Guard while signed into the dedicated bot account:\n${qrPath}\nApprove “GGD2L in-house lobby bot”. Waiting up to five minutes.\nWithout mobile Steam Guard, cancel and run: npm run login -- --password`);
    }
  }
} catch {
  if (!finished) finish(false, "Steam sign-in could not start. Check your credentials/connection and try again.");
}
await completed;
