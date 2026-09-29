import { describe, expect, it } from "vitest";
import {
  sourceFiles,
  stripLineComments,
} from "../../../test/support/source-files";

// Audit rows are written from server actions and from the services they call.
// Both areas are globbed so an action moved between the admin-*.ts action
// files, or a new service that logs, stays under the guard.
const ACTION_FILES = sourceFiles("src/app/actions/**/*.ts", 10);
const AUDIT_WRITERS = [
  ...ACTION_FILES,
  ...sourceFiles("src/lib/**/*.ts", 150),
];

/**
 * The body of the ONE exported action named `name`, wherever it lives. The
 * audit string has to be in that function, not merely somewhere in the
 * actions folder: a captain action that logs the same action name (a captain
 * rename, a captain standin booking) must not stand in for an admin path that
 * stopped logging. Top-level functions close with `}` at column 0.
 */
function actionBody(name: string): { file: string; body: string } {
  const definition = new RegExp(`^export async function ${name}\\b`, "m");
  const defining = ACTION_FILES.filter((f) => definition.test(f.text));
  expect(
    defining.map((f) => f.path),
    `exactly one action file should export ${name}`,
  ).toHaveLength(1);
  const [file] = defining;
  const start = file.text.search(definition);
  const rest = file.text.slice(start);
  const end = rest.search(/\n\}(?:\n|$)/);
  expect(end, `${name} in ${file.path} has no closing brace`).toBeGreaterThan(
    0,
  );
  return { file: file.path, body: stripLineComments(rest.slice(0, end + 2)) };
}

describe("security and league configuration audit trail", () => {
  it.each([
    "revokeAllSessions",
    "setMaxMmr",
    "setSeriesLengths",
    "setLeagueId",
    "setMatchSchedule",
    "setDiscordWebhook",
    "clearDiscordWebhook",
    "discardWaitingDiscordPosts",
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
      const { file, body } = actionBody(action);
      expect(body, `${action} in ${file}`).toContain(`action: "${action}"`);
    },
  );

  it("never interpolates a webhook URL into an audit summary", () => {
    const summaries = AUDIT_WRITERS.flatMap((f) =>
      [...f.text.matchAll(/summary:\s*`([^`]+)`/g)].map((match) => ({
        file: f.path,
        summary: match[1],
      })),
    );
    // ~55 templated summaries today (44 in the actions/admin-*.ts files). Far fewer means
    // the extractor stopped matching and the check below reads nothing.
    expect(summaries.length).toBeGreaterThanOrEqual(40);
    const leaking = summaries
      .filter(({ summary }) => /WebhookUrl|webhookUrl|https:\/\//.test(summary))
      .map(({ file, summary }) => `${file}: ${summary}`);
    expect(leaking).toEqual([]);
  });
});
