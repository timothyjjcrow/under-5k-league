import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import QRCode from "qrcode";

// login.mjs talks to Steam as soon as it runs, so its QR path is checked here
// by source, and the installed renderer by use.
test("the QR sign-in draws its code in the terminal as well as the image, and only to a terminal", async () => {
  const source = readFileSync(new URL("./login.mjs", import.meta.url), "utf8");
  assert.match(source, /QRCode\.toFile\(qrPath, result\.qrChallengeUrl/);
  assert.match(
    source,
    /process\.stdout\.isTTY\s*\?\s*await QRCode\.toString\(result\.qrChallengeUrl, \{ type: "terminal", small: true/,
  );
  const art = await QRCode.toString("https://s.team/q/1/1234567890", { type: "terminal", small: true, errorCorrectionLevel: "M" });
  assert.ok(art.trim().split("\n").length >= 10);
  assert.match(art, /[▀▄█]/);
});
