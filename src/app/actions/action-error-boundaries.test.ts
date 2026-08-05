import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  transaction: vi.fn(),
  reportImportGame: vi.fn(),
  reportAutoDetect: vi.fn(),
  proposeReschedule: vi.fn(),
  respondReschedule: vi.fn(),
  cancelReschedule: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: mocks.transaction },
}));
vi.mock("@/lib/match-report-service", () => ({
  reportImportGame: mocks.reportImportGame,
  reportAutoDetect: mocks.reportAutoDetect,
}));
vi.mock("@/lib/reschedule-service", () => ({
  proposeReschedule: mocks.proposeReschedule,
  respondReschedule: mocks.respondReschedule,
  cancelReschedule: mocks.cancelReschedule,
}));
vi.mock("@/lib/discord", () => ({
  playerOutMessage: vi.fn(() => "player out"),
  rescheduleDeclinedMessage: vi.fn(() => "declined"),
  rescheduleMessage: vi.fn(() => "accepted"),
  rescheduleProposedMessage: vi.fn(() => "proposed"),
  sendDiscordMessage: vi.fn(async () => true),
}));
vi.mock("@/lib/discord-mentions", () => ({
  mentionUsers: vi.fn(async () => []),
}));
vi.mock("@/lib/settings", () => ({ claimThrottle: vi.fn() }));

import { setAvailability } from "./availability";
import { captainAutoDetect, captainImportGame } from "./match-report";
import {
  cancelReschedule,
  proposeReschedule,
  respondReschedule,
} from "./reschedule";
import { UserFacingError } from "@/lib/user-facing-error";

const SECRET = "postgresql://league:super-secret@db.internal/league";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const availabilityForm = () => form({ matchId: "match-1", status: "IN" });
const importForm = () =>
  form({ matchId: "match-1", dotaMatchRef: "123456789" });
const detectForm = () => form({ matchId: "match-1" });
const proposeForm = () =>
  form({
    matchId: "match-1",
    proposedTs: String(Date.now() + 60_000),
  });
const responseForm = () =>
  form({ requestId: "request-1", response: "accept" });
const cancelForm = () => form({ requestId: "request-1" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue({
    id: "user-1",
    steamId: "76561198000000001",
    name: "Captain",
    avatar: null,
    role: "USER",
  });
});

describe("Server Action error boundaries", () => {
  it.each([
    {
      name: "availability database failure",
      reject: (error: Error) => mocks.transaction.mockRejectedValueOnce(error),
      invoke: () => setAvailability({}, availabilityForm()),
      fallback: "Could not save that RSVP — reload and try again",
      eventCode: "availability.set",
    },
    {
      name: "specific match import failure",
      reject: (error: Error) =>
        mocks.reportImportGame.mockRejectedValueOnce(error),
      invoke: () => captainImportGame({}, importForm()),
      fallback: "Couldn't report the result — try again",
      eventCode: "match-report.import",
    },
    {
      name: "match auto-detection failure",
      reject: (error: Error) =>
        mocks.reportAutoDetect.mockRejectedValueOnce(error),
      invoke: () => captainAutoDetect({}, detectForm()),
      fallback: "Couldn't report the result — try again",
      eventCode: "match-report.auto-detect",
    },
    {
      name: "reschedule proposal failure",
      reject: (error: Error) =>
        mocks.proposeReschedule.mockRejectedValueOnce(error),
      invoke: () => proposeReschedule({}, proposeForm()),
      fallback: "Couldn't propose — try again",
      eventCode: "reschedule.propose",
    },
    {
      name: "reschedule response failure",
      reject: (error: Error) =>
        mocks.respondReschedule.mockRejectedValueOnce(error),
      invoke: () => respondReschedule({}, responseForm()),
      fallback: "Couldn't respond — try again",
      eventCode: "reschedule.respond",
    },
    {
      name: "reschedule withdrawal failure",
      reject: (error: Error) =>
        mocks.cancelReschedule.mockRejectedValueOnce(error),
      invoke: () => cancelReschedule({}, cancelForm()),
      fallback: "Couldn't withdraw — try again",
      eventCode: "reschedule.cancel",
    },
  ])("does not disclose $name contents", async (testCase) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    testCase.reject(new Error(SECRET));

    const result = await testCase.invoke();

    expect(result).toEqual({ error: testCase.fallback });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(log).toHaveBeenCalledExactlyOnceWith(
      `[server-action:${testCase.eventCode}] unexpected failure`,
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(SECRET);

    log.mockRestore();
  });

  it("preserves an intentional typed domain message", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.reportImportGame.mockRejectedValueOnce(
      new UserFacingError("Only the two captains can report this match"),
    );

    await expect(captainImportGame({}, importForm())).resolves.toEqual({
      error: "Only the two captains can report this match",
    });
    expect(log).not.toHaveBeenCalled();

    log.mockRestore();
  });
});
