import { beforeEach, describe, expect, it, vi } from "vitest";

const { after } = vi.hoisted(() => ({ after: vi.fn() }));
vi.mock("next/server", () => ({ after }));

import { runAfterResponse } from "./after-response";

beforeEach(() => {
  after.mockReset();
});

describe("runAfterResponse", () => {
  it("hands the task to after() and does not run it before the response", async () => {
    let scheduled: (() => Promise<void>) | null = null;
    after.mockImplementation((fn: () => Promise<void>) => {
      scheduled = fn;
    });
    const task = vi.fn(async () => {});

    await runAfterResponse(task);
    expect(after).toHaveBeenCalledTimes(1);
    expect(task).not.toHaveBeenCalled();

    await scheduled!();
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("runs the task inline outside a request scope", async () => {
    after.mockImplementation(() => {
      throw new Error("`after` was called outside a request scope.");
    });
    const task = vi.fn(async () => {});

    await runAfterResponse(task);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("never throws, inline or after the response", async () => {
    const failing = vi.fn(async () => {
      throw new Error("discord down");
    });
    after.mockImplementation(() => {
      throw new Error("outside a request scope");
    });
    await expect(runAfterResponse(failing)).resolves.toBeUndefined();

    let scheduled: (() => Promise<void>) | null = null;
    after.mockImplementation((fn: () => Promise<void>) => {
      scheduled = fn;
    });
    await runAfterResponse(failing);
    await expect(scheduled!()).resolves.toBeUndefined();
    expect(failing).toHaveBeenCalledTimes(2);
  });
});
