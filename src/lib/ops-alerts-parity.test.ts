// The Discord alerts outside the app keep copies of three things: the alert
// rules (the scheduler Worker's alerts.ts and the box's discord-alert.mjs), the
// webhook validator (src/lib/discord-webhook.mjs) and the markdown escape
// (src/lib/discord-escape.ts). Neither bundles app code, so this pins the
// copies to each other and to the originals.
import { describe, expect, it } from "vitest";
import { escapeDiscordText } from "./discord-escape";
import { normalizeDiscordWebhookUrl } from "./discord-webhook.mjs";
import * as worker from "../../ops/cloudflare-automation-worker/src/alerts";
import * as box from "../../ops/selfhost/backup/discord-alert.mjs";

const TEXTS = [
  "plain",
  "[free mmr](https://evil.test) **bold** __u__ ~~s~~ `code` ||spoiler|| <@123> <t:1:F> #channel @everyone - list",
  "line one\nline two\r\n\tthree",
  "visit www.evil.test or http://x.test/a_b",
  "x".repeat(300),
  "  padded  ",
  "back\\slash (parens) [brackets]",
];

const URLS = [
  "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz0123456789",
  "https://discordapp.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz",
  "https://discord.com/api/v10/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz",
  "https://discord.com:443/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz",
  "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz?wait=true",
  "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz#x",
  "https://user:pw@discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz",
  "http://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz",
  "https://evil.test/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz",
  "https://DISCORD.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz",
  "https://discord.com/api/webhooks/123/abcdefghijklmnopqrstuvwxyz",
  "https://discord.com/api/webhooks/123456789012345678/short",
  "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz/extra",
  " https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz",
  "",
  `https://discord.com/api/webhooks/123456789012345678/${"a".repeat(600)}`,
];

// A small deterministic generator, so every run walks the same sequences.
function lcg(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

describe("ops alert copies", () => {
  it("escape Discord markdown exactly as the app does", () => {
    for (const text of TEXTS) {
      for (const max of [undefined, 20, 160]) {
        expect(worker.escapeDiscordText(text, max)).toBe(escapeDiscordText(text, max));
        expect(box.escapeDiscordText(text, max)).toBe(escapeDiscordText(text, max));
      }
    }
  });

  it("accept exactly the webhooks the app accepts", () => {
    for (const url of [...URLS, undefined, null, 42]) {
      expect(worker.normalizeDiscordWebhookUrl(url)).toBe(normalizeDiscordWebhookUrl(url));
      expect(box.normalizeDiscordWebhookUrl(url)).toBe(normalizeDiscordWebhookUrl(url));
    }
  });

  it("build the same payload and accept the same ping ids", () => {
    for (const id of ["112233445566778899", "1122", "@everyone", "112233445566778899 ", undefined]) {
      expect(box.pingUserId(id)).toBe(worker.pingUserId(id));
      const ping = worker.pingUserId(id);
      expect(box.discordPayload("hi", ping)).toEqual(worker.discordPayload("hi", ping));
    }
  });

  it("run the same alert rules over the same events", () => {
    const random = lcg(20261018);
    const rules = [
      { after: 1, recoverAfter: 1, remindMs: 3_600_000 },
      { after: 3, recoverAfter: 2, remindMs: 86_400_000 },
      { after: 10, recoverAfter: 2, remindMs: 600_000 },
    ];
    expect(box.EMPTY_ALERT_STATE).toEqual(worker.EMPTY_ALERT_STATE);
    expect(box.REMIND_AFTER_MS).toBe(worker.REMIND_AFTER_MS);
    for (const rule of rules) {
      for (let run = 0; run < 40; run += 1) {
        let a = worker.EMPTY_ALERT_STATE;
        let b = box.EMPTY_ALERT_STATE;
        let at = Date.UTC(2026, 9, 18);
        for (let i = 0; i < 60; i += 1) {
          at += Math.floor(random() * 4 * 3_600_000);
          const event = { ok: random() < 0.45, at, detail: random() < 0.5 ? "HTTP 530" : null };
          const left = worker.nextAlertStep(a, event, rule);
          const right = box.nextAlertStep(b, event, rule);
          expect(right).toEqual(left);
          // Follow a failed post now and then, as a real run would.
          const delivered = random() < 0.8;
          a = delivered ? left.state : left.ifPostFails;
          b = delivered ? right.state : right.ifPostFails;
          expect(box.sameAlertState(a, b)).toBe(true);
          expect(worker.sameAlertState(a, b)).toBe(true);
        }
      }
    }
  });

  it("read stored states the same way", () => {
    const samples: unknown[] = [
      null,
      "x",
      { ...worker.EMPTY_ALERT_STATE },
      { failing: 3, passing: 0, alerted: true, since: 1, postedAt: 2, detail: "HTTP 530" },
      { failing: -1, passing: 0, alerted: true, since: 1, postedAt: 2, detail: null },
      { failing: 1, passing: 0, alerted: "yes", since: 1, postedAt: 2, detail: null },
      { failing: 1, passing: 0, alerted: false, since: 1.5, postedAt: null, detail: null },
      { failing: 1, passing: 0, alerted: false, since: 1, postedAt: null, detail: "x".repeat(201) },
      { failing: 1, passing: 0, alerted: false, since: 1, postedAt: null, detail: null, extra: true },
    ];
    for (const sample of samples) expect(box.readAlertState(sample)).toEqual(worker.readAlertState(sample));
  });
});
