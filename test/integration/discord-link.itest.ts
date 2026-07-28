import { describe, it, expect, vi, beforeEach } from "vitest";

// The actions are request-scoped: stub revalidation + auth (rank-sync pattern)
// so we can drive them against the test DB.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn(),
  requireUser: vi.fn(),
  getSessionUser: vi.fn(),
}));

import {
  handleDiscordCallback,
  linkDiscordAccount,
  unlinkDiscordAccount,
  type CallbackDeps,
} from "@/lib/discord-link-service";
import { packOauthCookie } from "@/lib/discord-oauth";
import { updateDiscordName, unlinkDiscord } from "@/app/actions/registration";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { makeUser, sessionFor } from "./factories";

const mockRequireUser = vi.mocked(requireUser);

const PROFILE = { discordId: "80351110224678912", discordName: "dendi_official" };

/**
 * Deps whose exchange/identity calls succeed unless overridden. joinGuild
 * defaults to null — "no bot configured", i.e. the identify-only league, so
 * every pre-existing expectation of `?discord=linked` still describes it.
 */
function happyDeps(overrides: Partial<CallbackDeps> = {}): CallbackDeps {
  return {
    exchange: vi.fn().mockResolvedValue("tok-123"),
    fetchIdentity: vi.fn().mockResolvedValue(PROFILE),
    joinGuild: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function callbackInput(userId: string | null, extra: Record<string, unknown> = {}) {
  return {
    userId,
    code: "auth-code",
    state: "the-state",
    errorParam: null,
    cookie: packOauthCookie("the-state", "the-verifier"),
    clientId: "cid",
    clientSecret: "csecret",
    redirectUri: "http://localhost:3000/api/auth/discord/callback",
    ...extra,
  };
}

async function discordOf(userId: string) {
  const u = await prisma.user.findUnique({ where: { id: userId } });
  return { discordId: u?.discordId ?? null, discordName: u?.discordName ?? "" };
}

describe("linkDiscordAccount", () => {
  it("persists the proven id + handle", async () => {
    const user = await makeUser("Linker");
    const res = await linkDiscordAccount(prisma, user.id, PROFILE);
    expect(res.ok).toBe(true);
    expect(await discordOf(user.id)).toEqual(PROFILE);
  });

  it("refuses a Discord account already linked to another player", async () => {
    const first = await makeUser("First");
    const second = await makeUser("Second");
    await linkDiscordAccount(prisma, first.id, PROFILE);

    const res = await linkDiscordAccount(prisma, second.id, PROFILE);

    expect(res).toEqual({ ok: false, error: "taken" });
    // Neither account was touched: first keeps the link, second stays clean.
    expect(await discordOf(first.id)).toEqual(PROFILE);
    expect(await discordOf(second.id)).toEqual({ discordId: null, discordName: "" });
  });

  it("re-linking a different Discord account overwrites the user's own link", async () => {
    const user = await makeUser("Relinker");
    await linkDiscordAccount(prisma, user.id, PROFILE);
    const next = { discordId: "90000000000000001", discordName: "smurf_acct" };

    const res = await linkDiscordAccount(prisma, user.id, next);

    expect(res.ok).toBe(true);
    expect(await discordOf(user.id)).toEqual(next);
  });

  it("linking the same account again is a harmless no-op (name refresh)", async () => {
    const user = await makeUser("Idempotent");
    await linkDiscordAccount(prisma, user.id, PROFILE);
    const renamed = { ...PROFILE, discordName: "dendi_renamed" };

    const res = await linkDiscordAccount(prisma, user.id, renamed);

    expect(res.ok).toBe(true);
    expect(await discordOf(user.id)).toEqual(renamed);
  });
});

describe("linkDiscordAccount — the P2002 unique race (the pre-check missed)", () => {
  // Two callbacks racing the same snowflake: the loser passes the findUnique
  // pre-check but hits the @unique constraint on write. Stubbed db because a
  // real interleaving can't be scheduled deterministically.
  function stubDb(updateError: Error) {
    return {
      user: {
        findUnique: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockRejectedValue(updateError),
      },
    } as unknown as Parameters<typeof linkDiscordAccount>[0];
  }

  it("maps a lost race to the friendly 'taken' result", async () => {
    const db = stubDb(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );
    await expect(linkDiscordAccount(db, "u1", PROFILE)).resolves.toEqual({
      ok: false,
      error: "taken",
    });
  });

  it("rethrows anything that isn't the unique violation", async () => {
    const db = stubDb(new Error("db down"));
    await expect(linkDiscordAccount(db, "u1", PROFILE)).rejects.toThrow(
      "db down",
    );
  });
});

describe("unlinkDiscordAccount", () => {
  it("clears both the id and the handle", async () => {
    const user = await makeUser("Unlinker");
    await linkDiscordAccount(prisma, user.id, PROFILE);

    await unlinkDiscordAccount(prisma, user.id);

    expect(await discordOf(user.id)).toEqual({ discordId: null, discordName: "" });
  });
});

describe("handleDiscordCallback — every branch lands on a fixed same-origin path", () => {
  it("signed-out session → back through login", async () => {
    const deps = happyDeps();
    const res = await handleDiscordCallback(prisma, callbackInput(null), deps);
    expect(res.redirect).toBe("/login?next=/me");
    expect(deps.exchange).not.toHaveBeenCalled();
  });

  it("user cancelled on Discord → denied, code never spent", async () => {
    const user = await makeUser("Canceller");
    const deps = happyDeps();
    const res = await handleDiscordCallback(
      prisma,
      callbackInput(user.id, { errorParam: "access_denied" }),
      deps,
    );
    expect(res.redirect).toBe("/me?discord=denied");
    expect(deps.exchange).not.toHaveBeenCalled();
  });

  it("missing cookie (expired / cross-browser) → state error before any exchange", async () => {
    const user = await makeUser("NoCookie");
    const deps = happyDeps();
    const res = await handleDiscordCallback(
      prisma,
      callbackInput(user.id, { cookie: null }),
      deps,
    );
    expect(res.redirect).toBe("/me?discord=state");
    expect(deps.exchange).not.toHaveBeenCalled();
  });

  it("state mismatch (CSRF) → rejected before any exchange", async () => {
    const user = await makeUser("Csrf");
    const deps = happyDeps();
    const res = await handleDiscordCallback(
      prisma,
      callbackInput(user.id, {
        cookie: packOauthCookie("browser-state", "v"),
        state: "attacker-state",
      }),
      deps,
    );
    expect(res.redirect).toBe("/me?discord=state");
    expect(deps.exchange).not.toHaveBeenCalled();
    expect(await discordOf(user.id)).toEqual({ discordId: null, discordName: "" });
  });

  it("missing code → error", async () => {
    const user = await makeUser("NoCode");
    const res = await handleDiscordCallback(
      prisma,
      callbackInput(user.id, { code: null }),
      happyDeps(),
    );
    expect(res.redirect).toBe("/me?discord=error");
  });

  it("token exchange failure → error, nothing persisted", async () => {
    const user = await makeUser("ExchangeFail");
    const res = await handleDiscordCallback(
      prisma,
      callbackInput(user.id),
      happyDeps({ exchange: vi.fn().mockResolvedValue(null) }),
    );
    expect(res.redirect).toBe("/me?discord=error");
    expect(await discordOf(user.id)).toEqual({ discordId: null, discordName: "" });
  });

  it("identity fetch failure → error, nothing persisted", async () => {
    const user = await makeUser("MeFail");
    const res = await handleDiscordCallback(
      prisma,
      callbackInput(user.id),
      happyDeps({ fetchIdentity: vi.fn().mockResolvedValue(null) }),
    );
    expect(res.redirect).toBe("/me?discord=error");
    expect(await discordOf(user.id)).toEqual({ discordId: null, discordName: "" });
  });

  it("success → linked, with the verifier fed to the exchange (PKCE)", async () => {
    const user = await makeUser("Winner");
    const deps = happyDeps();

    const res = await handleDiscordCallback(prisma, callbackInput(user.id), deps);

    expect(res.redirect).toBe("/me?discord=linked");
    expect(await discordOf(user.id)).toEqual(PROFILE);
    expect(deps.exchange).toHaveBeenCalledWith(
      expect.objectContaining({ codeVerifier: "the-verifier", code: "auth-code" }),
    );
  });

  it("Discord account already claimed → taken", async () => {
    const holder = await makeUser("Holder");
    await linkDiscordAccount(prisma, holder.id, PROFILE);
    const late = await makeUser("Late");

    const res = await handleDiscordCallback(
      prisma,
      callbackInput(late.id),
      happyDeps(),
    );

    expect(res.redirect).toBe("/me?discord=taken");
    expect(await discordOf(late.id)).toEqual({ discordId: null, discordName: "" });
  });
});

describe("handleDiscordCallback — the guilds.join half", () => {
  it("hands the JUST-EXCHANGED token to the join, not a stored one", async () => {
    const user = await makeUser("Joiner");
    const deps = happyDeps({ joinGuild: vi.fn().mockResolvedValue("joined") });

    const res = await handleDiscordCallback(prisma, callbackInput(user.id), deps);

    expect(res.redirect).toBe("/me?discord=joined");
    expect(deps.joinGuild).toHaveBeenCalledWith(PROFILE.discordId, "tok-123");
  });

  it("an existing member reads as a plain link, not a second welcome", async () => {
    const user = await makeUser("Already");
    const res = await handleDiscordCallback(
      prisma,
      callbackInput(user.id),
      happyDeps({ joinGuild: vi.fn().mockResolvedValue("already") }),
    );
    expect(res.redirect).toBe("/me?discord=linked");
  });

  it("membership screening is reported, never counted as done", async () => {
    const user = await makeUser("Pending");
    const res = await handleDiscordCallback(
      prisma,
      callbackInput(user.id),
      happyDeps({ joinGuild: vi.fn().mockResolvedValue("joined-pending") }),
    );
    expect(res.redirect).toBe("/me?discord=joined_pending");
  });

  // The link is already committed when the join runs. Every failure mode below
  // must leave it that way — losing a proven identity because a bot permission
  // is wrong would be a far worse bug than not auto-joining.
  it.each(["forbidden", "failed"] as const)(
    "a %s join still keeps the link",
    async (outcome) => {
      const user = await makeUser(`Join_${outcome}`);
      const res = await handleDiscordCallback(
        prisma,
        callbackInput(user.id),
        happyDeps({ joinGuild: vi.fn().mockResolvedValue(outcome) }),
      );
      expect(res.redirect).toBe("/me?discord=join_failed");
      expect(await discordOf(user.id)).toEqual(PROFILE);
    },
  );

  it("a THROWN join still keeps the link", async () => {
    const user = await makeUser("JoinThrew");
    const res = await handleDiscordCallback(
      prisma,
      callbackInput(user.id),
      happyDeps({ joinGuild: vi.fn().mockRejectedValue(new Error("boom")) }),
    );
    expect(res.redirect).toBe("/me?discord=join_failed");
    expect(await discordOf(user.id)).toEqual(PROFILE);
  });

  it("never attempts a join when the link itself was refused", async () => {
    const holder = await makeUser("JoinHolder");
    await linkDiscordAccount(prisma, holder.id, PROFILE);
    const late = await makeUser("JoinLate");
    const deps = happyDeps({ joinGuild: vi.fn().mockResolvedValue("joined") });

    const res = await handleDiscordCallback(prisma, callbackInput(late.id), deps);

    expect(res.redirect).toBe("/me?discord=taken");
    expect(deps.joinGuild).not.toHaveBeenCalled();
  });
});

describe("actions — manual handle vs the verified link", () => {
  beforeEach(() => mockRequireUser.mockReset());

  function formWith(name: string) {
    const fd = new FormData();
    fd.set("discordName", name);
    return fd;
  }

  it("updateDiscordName still works for unlinked users", async () => {
    const user = await makeUser("Manual");
    mockRequireUser.mockResolvedValue(sessionFor(user));

    const res = await updateDiscordName({}, formWith("typed_handle"));

    expect(res?.message).toMatch(/saved/);
    expect(await discordOf(user.id)).toEqual({
      discordId: null,
      discordName: "typed_handle",
    });
  });

  it("updateDiscordName refuses while linked — no silent desync of a verified handle", async () => {
    const user = await makeUser("LinkedManual");
    await linkDiscordAccount(prisma, user.id, PROFILE);
    mockRequireUser.mockResolvedValue(sessionFor(user));

    const res = await updateDiscordName({}, formWith("impostor"));

    expect(res?.error).toMatch(/unlink/i);
    expect(await discordOf(user.id)).toEqual(PROFILE);
  });

  it("unlinkDiscord clears the link and the handle", async () => {
    const user = await makeUser("ActionUnlink");
    await linkDiscordAccount(prisma, user.id, PROFILE);
    mockRequireUser.mockResolvedValue(sessionFor(user));

    const res = await unlinkDiscord({}, new FormData());

    expect(res?.message).toMatch(/unlinked/i);
    expect(await discordOf(user.id)).toEqual({ discordId: null, discordName: "" });
  });
});
