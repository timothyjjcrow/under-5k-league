import { beforeEach, describe, expect, it, vi } from "vitest";

// The small invite credit end to end through the real saveRegistration: a
// brand-new player who opened a signed-up player's link is announced as
// invited by them. The browser's tag arrives through takeInviteRef (the
// cookie), so the test hands it in there; auth, the medal fetch and the
// Discord send are stubbed as in registration.itest.ts.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  updateTag: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(),
  requireAdmin: vi.fn(),
  getSessionUser: vi.fn(async () => null),
}));
vi.mock("@/lib/dota", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dota")>()),
  fetchPlayerRankTier: vi.fn(async () => null),
}));
vi.mock("@/lib/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/discord")>()),
  sendDiscordMessage: vi.fn(async () => true),
}));
vi.mock("@/lib/invite-ref-cookie", () => ({
  takeInviteRef: vi.fn(async () => null),
}));

import { saveRegistration } from "@/app/actions/registration";
import { requireUser } from "@/lib/auth";
import { sendDiscordMessage } from "@/lib/discord";
import { takeInviteRef } from "@/lib/invite-ref-cookie";
import { prisma } from "@/lib/prisma";
import { makePlayer, makeSeason, makeUser, sessionFor } from "./factories";

function form(fields: Record<string, string | number>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, String(v));
  return fd;
}

const PLAYER_FORM = { type: "PLAYER", mmr: 3000, roles: "1" };

/** The one signup post this test's signup sent. */
function signupPost(): string {
  const calls = vi.mocked(sendDiscordMessage).mock.calls;
  expect(calls).toHaveLength(1);
  return String(calls[0][0]);
}

describe("invite credit on the signup post", () => {
  beforeEach(() => {
    vi.mocked(requireUser).mockReset();
    vi.mocked(sendDiscordMessage).mockReset();
    vi.mocked(sendDiscordMessage).mockResolvedValue(true);
    vi.mocked(takeInviteRef).mockReset();
    vi.mocked(takeInviteRef).mockResolvedValue(null);
  });

  async function signUp(newcomerName: string, ref: string | null) {
    const user = await makeUser(newcomerName);
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));
    vi.mocked(takeInviteRef).mockResolvedValue(ref);
    const result = await saveRegistration({}, form(PLAYER_FORM));
    expect(result?.error).toBeUndefined();
    return user;
  }

  it("names a signed-up inviter for a brand-new player, and consumes the tag", async () => {
    const season = await makeSeason({ status: "SIGNUPS" });
    const inviter = await makePlayer(season.id, "Borpo", 4000);
    await signUp("Zai", inviter.id);
    expect(signupPost()).toContain("**Zai** signed up (invited by Borpo) — ");
    expect(vi.mocked(takeInviteRef)).toHaveBeenCalledTimes(1);
  });

  it("names nobody without a tag", async () => {
    await makeSeason({ status: "SIGNUPS" });
    await signUp("Zai", null);
    expect(signupPost()).not.toContain("invited by");
  });

  it("never credits an inviter who isn't signed up this season", async () => {
    const season = await makeSeason({ status: "SIGNUPS" });
    const lapsed = await makePlayer(season.id, "Lapsed Inviter", 4000);
    await prisma.registration.updateMany({
      where: { seasonId: season.id, userId: lapsed.id },
      data: { status: "WITHDRAWN" },
    });
    await signUp("Zai", lapsed.id);
    expect(signupPost()).not.toContain("invited by");
  });

  it("never credits a returning player, who signed up in an earlier season", async () => {
    const older = await makeSeason({ status: "COMPLETE", isActive: false, name: "Season 1" });
    const season = await makeSeason({ status: "SIGNUPS", name: "Season 2" });
    const inviter = await makePlayer(season.id, "Borpo", 4000);
    const returning = await makeUser("Returning Zai");
    await prisma.registration.create({
      data: { seasonId: older.id, userId: returning.id, type: "PLAYER", status: "ACTIVE", mmr: 3000 },
    });
    vi.mocked(requireUser).mockResolvedValue(sessionFor(returning));
    vi.mocked(takeInviteRef).mockResolvedValue(inviter.id);
    expect((await saveRegistration({}, form(PLAYER_FORM)))?.error).toBeUndefined();
    expect(signupPost()).not.toContain("invited by");
  });

  it("never credits inviting yourself", async () => {
    await makeSeason({ status: "SIGNUPS" });
    const user = await makeUser("Self Inviter");
    vi.mocked(requireUser).mockResolvedValue(sessionFor(user));
    vi.mocked(takeInviteRef).mockResolvedValue(user.id);
    expect((await saveRegistration({}, form(PLAYER_FORM)))?.error).toBeUndefined();
    expect(signupPost()).not.toContain("invited by");
  });

  it("leaves the tag alone when a signup is only updated", async () => {
    const season = await makeSeason({ status: "SIGNUPS" });
    const inviter = await makePlayer(season.id, "Borpo", 4000);
    const player = await makePlayer(season.id, "Already In", 3000);
    vi.mocked(requireUser).mockResolvedValue(sessionFor(player));
    vi.mocked(takeInviteRef).mockResolvedValue(inviter.id);
    expect((await saveRegistration({}, form(PLAYER_FORM)))?.error).toBeUndefined();
    expect(vi.mocked(takeInviteRef)).not.toHaveBeenCalled();
    expect(vi.mocked(sendDiscordMessage)).not.toHaveBeenCalled();
  });
});
