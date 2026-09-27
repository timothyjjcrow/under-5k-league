import { describe, expect, it } from "vitest";
import {
  haystackOf,
  sourceFiles,
} from "../../../test/support/source-files";

// Audit rows are written from server actions and from the services they call.
// Both areas are globbed so an action split out of actions/admin.ts, or a new
// service that logs, stays under the guard.
const ACTION_FILES = sourceFiles("src/app/actions/**/*.ts", 10);
const actions = haystackOf(ACTION_FILES);
const AUDIT_WRITERS = [
  ...ACTION_FILES,
  ...sourceFiles("src/lib/**/*.ts", 150),
];

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
    "setPlayerRank",
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
    const summaries = AUDIT_WRITERS.flatMap((f) =>
      [...f.text.matchAll(/summary:\s*`([^`]+)`/g)].map((match) => ({
        file: f.path,
        summary: match[1],
      })),
    );
    // ~55 templated summaries today (44 in actions/admin.ts). Far fewer means
    // the extractor stopped matching and the check below reads nothing.
    expect(summaries.length).toBeGreaterThanOrEqual(40);
    const leaking = summaries
      .filter(({ summary }) => /WebhookUrl|webhookUrl|https:\/\//.test(summary))
      .map(({ file, summary }) => `${file}: ${summary}`);
    expect(leaking).toEqual([]);
  });
});
