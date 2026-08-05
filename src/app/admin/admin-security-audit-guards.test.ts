import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const actions = readFileSync(
  path.resolve(process.cwd(), "src/app/actions/admin.ts"),
  "utf8",
);

describe("security and league configuration audit trail", () => {
  it.each([
    "revokeAllSessions",
    "setMaxMmr",
    "setSeriesLengths",
    "setLeagueId",
    "setMatchSchedule",
    "setDiscordWebhook",
    "clearDiscordWebhook",
    "setInhouseWebhook",
    "clearInhouseWebhook",
    "setInhouseAlertWebhook",
    "clearInhouseAlertWebhook",
    "setInhousePingRole",
    "renameTeam",
    "withdrawSignup",
    "reinstateSignup",
    "setRegistrationMmr",
    "assignStandin",
    "removeStandin",
    "setMatchTime",
    "importGameAction",
    "autoDetectAction",
  ])(
    "records %s without writing webhook secrets into the summary",
    (action) => {
      expect(actions).toContain(`action: "${action}"`);
    },
  );

  it("never interpolates a webhook URL into an audit summary", () => {
    const summaries = [...actions.matchAll(/summary:\s*`([^`]+)`/g)].map(
      (match) => match[1],
    );
    expect(summaries.join("\n")).not.toMatch(
      /WebhookUrl|webhookUrl|https:\/\//,
    );
  });
});
