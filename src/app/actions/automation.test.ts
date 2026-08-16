import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  runAutomation: vi.fn(),
  logAdminAction: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  updateTag: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/automation-service", () => ({
  runAutomation: mocks.runAutomation,
}));
vi.mock("@/lib/admin-log", () => ({
  logAdminAction: mocks.logAdminAction,
}));

import { revalidatePath, updateTag } from "next/cache";
import { runMaintenanceNow } from "./automation";

const ADMIN = {
  id: "admin-1",
  steamId: "123",
  name: "League admin",
  avatar: null,
  role: "ADMIN",
};

function completed(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind: "completed",
    status: "SUCCEEDED",
    durationMs: 250,
    recoveredExpiredLease: false,
    errorCode: null,
    summary: "{}",
    imported: 0,
    ...overrides,
  };
}

describe("runMaintenanceNow", () => {
  beforeEach(() => {
    mocks.requireAdmin.mockReset().mockResolvedValue(ADMIN);
    mocks.runAutomation.mockReset().mockResolvedValue(completed());
    mocks.logAdminAction.mockReset().mockResolvedValue(undefined);
    vi.mocked(revalidatePath).mockReset();
    vi.mocked(updateTag).mockReset();
  });

  it("fails closed before touching automation for a non-admin", async () => {
    mocks.requireAdmin.mockRejectedValue(new Error("FORBIDDEN"));

    const result = await runMaintenanceNow(null, new FormData());

    expect(result).toEqual({ error: "Not authorized" });
    expect(mocks.runAutomation).not.toHaveBeenCalled();
    expect(mocks.logAdminAction).not.toHaveBeenCalled();
  });

  it("runs through the shared ADMIN lease and logs a successful pass", async () => {
    const result = await runMaintenanceNow(null, new FormData());

    expect(mocks.runAutomation).toHaveBeenCalledWith({ source: "ADMIN" });
    expect(mocks.logAdminAction).toHaveBeenCalledWith({
      action: "runMaintenanceNow",
      summary: expect.stringContaining("completed: SUCCEEDED"),
      actor: ADMIN,
    });
    expect(revalidatePath).toHaveBeenCalledWith("/admin");
    expect(updateTag).toHaveBeenCalledOnce();
    expect(updateTag).toHaveBeenCalledWith("automation-gate:v3");
    expect(result).toEqual({
      message: "Maintenance finished successfully — no new games were found.",
    });
  });

  it("invalidates game data and the application shell when imports commit", async () => {
    mocks.runAutomation.mockResolvedValue(completed({ imported: 2 }));

    const result = await runMaintenanceNow(null, new FormData());

    expect(updateTag).toHaveBeenCalledWith("games");
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
    expect(revalidatePath).toHaveBeenCalledWith("/admin");
    expect(result).toEqual({
      message: "Maintenance finished successfully — 2 games imported.",
    });
  });

  it("does not bypass or invalidate game data for a held lease", async () => {
    mocks.runAutomation.mockResolvedValue({
      kind: "lease-held",
      status: "RUNNING",
      leaseExpiresAt: new Date(),
      retryAfterSeconds: 42,
    });

    const result = await runMaintenanceNow(null, new FormData());

    expect(result?.error).toContain("already running");
    expect(result?.error).toContain("never overrides");
    expect(updateTag).toHaveBeenCalledWith("automation-gate:v3");
    expect(updateTag).not.toHaveBeenCalledWith("games");
    expect(mocks.logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "runMaintenanceNow",
        summary: expect.stringContaining("another runner held the lease"),
      }),
    );
  });

  it.each(["DEGRADED", "FAILED"])(
    "returns clear feedback and logs a %s completion",
    async (status) => {
      mocks.runAutomation.mockResolvedValue(completed({
        status,
        errorCode: "AUTOMATION_FAILED",
      }));

      const result = await runMaintenanceNow(null, new FormData());

      expect(result?.error).toMatch(
        status === "FAILED" ? /failed/i : /incomplete|deferred/i,
      );
      expect(mocks.logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({ summary: expect.stringContaining(status) }),
      );
    },
  );

  it("refreshes committed imports but warns when finalization is fenced", async () => {
    mocks.runAutomation.mockResolvedValue(
      completed({ kind: "fenced", imported: 1 }),
    );

    const result = await runMaintenanceNow(null, new FormData());

    expect(updateTag).toHaveBeenCalledWith("games");
    expect(result?.error).toContain("newer runner");
    expect(mocks.logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ summary: expect.stringContaining("fenced") }),
    );
  });

  it("returns and logs a generic unavailable result without leaking exceptions", async () => {
    mocks.runAutomation.mockRejectedValue(
      new Error("postgres://user:db-password@internal.example"),
    );

    const result = await runMaintenanceNow(null, new FormData());

    expect(result?.error).toContain("database readiness");
    expect(JSON.stringify(result)).not.toContain("db-password");
    expect(mocks.logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        summary:
          "Manual maintenance could not start because runner state was unavailable",
      }),
    );
  });
});
