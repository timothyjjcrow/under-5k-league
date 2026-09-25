import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));
vi.mock("@/lib/settings", () => ({ stampResultChange: vi.fn(async () => {}) }));

import { revalidatePath, revalidateTag } from "next/cache";
import { POST } from "./route";
import { stampResultChange } from "@/lib/settings";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(revalidatePath).mockReset();
  vi.mocked(revalidateTag).mockReset();
  vi.mocked(stampResultChange).mockClear();
});

describe("fixture cache reset route", () => {
  async function expectDenied() {
    expect((await POST()).status).toBe(404);
    expect(revalidateTag).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(stampResultChange).not.toHaveBeenCalled();
  }

  it("is absent in production even when every fixture flag is set", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_DEV_LOGIN", "true");
    vi.stubEnv("DATABASE_URL", "file:/tmp/e2e-fixture.db");
    await expectDenied();
  });

  it("is absent when development login is disabled", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("ALLOW_DEV_LOGIN", "false");
    vi.stubEnv("DATABASE_URL", "file:/tmp/e2e-fixture.db");
    await expectDenied();
  });

  it("is absent for a non-fixture database", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("ALLOW_DEV_LOGIN", "true");
    vi.stubEnv("DATABASE_URL", "file:/tmp/dev.db");
    await expectDenied();
  });

  it("expires game and layout caches for a fixture database", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("ALLOW_DEV_LOGIN", "true");
    vi.stubEnv("DATABASE_URL", "file:/tmp/e2e-fixture.db");
    expect((await POST()).status).toBe(200);
    expect(stampResultChange).toHaveBeenCalledTimes(1);
    expect(vi.mocked(stampResultChange).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(revalidateTag).mock.invocationCallOrder[0]);
    expect(revalidateTag).toHaveBeenCalledWith("games", { expire: 0 });
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });
});
