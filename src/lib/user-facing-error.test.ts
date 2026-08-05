import { describe, expect, it, vi } from "vitest";
import {
  actionErrorMessage,
  UserFacingError,
} from "./user-facing-error";

describe("actionErrorMessage", () => {
  it("returns fixed domain messages without logging an expected failure", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(
      actionErrorMessage(
        new UserFacingError("That proposal is no longer open"),
        "Try again",
        "reschedule.respond",
      ),
    ).toBe("That proposal is no longer open");
    expect(log).not.toHaveBeenCalled();

    log.mockRestore();
  });

  it("replaces and does not log unexpected exception contents", () => {
    const secret = "postgresql://league:super-secret@db.internal/league";
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(
      actionErrorMessage(
        new Error(secret),
        "The action failed — try again",
        "availability.set",
      ),
    ).toBe("The action failed — try again");
    expect(log).toHaveBeenCalledExactlyOnceWith(
      "[server-action:availability.set] unexpected failure",
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);

    log.mockRestore();
  });
});
