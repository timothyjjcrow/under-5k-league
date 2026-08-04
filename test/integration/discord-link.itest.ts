import { describe, it, expect, vi, beforeEach } from "vitest";

// The actions are request-scoped: stub revalidation + auth (rank-sync pattern)
// so we can drive them against the test DB.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
}));
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
import {
  _clearMembershipMemoForTests,
  memoGuildMembership,
} from "@/lib/discord-roles";
import { updateDiscordName, unlinkDiscord } from "@/app/actions/registration";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { makeUser, sessionFor } from "./factories";

const mockRequireUser = vi.mocked(requireUser);

const PROFILE = {
  discordId: "80351110224678912",
  discordName: "dendi_official",
};
const OAUTH_STATE = "s".repeat(43);
const OAUTH_VERIFIER = "v".repeat(43);

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
    stripPingRole: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function callbackInput(
  userId: string | null,
  extra: Record<string, unknown> = {},
) {
  const initiatingUserId = userId ?? "signed-out-initiator";
  return {
    userId,
    code: "auth-code",
    state: OAUTH_STATE,
    errorParam: null,
    cookie: packOauthCookie(OAUTH_STATE, OAUTH_VERIFIER, initiatingUserId),
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
    expect(await discordOf(second.id)).toEqual({
      discordId: null,
      discordName: "",
    });
  });

  it("re-linking a different Discord account overwrites the user's own link — and reports the replaced id", async () => {
    const user = await makeUser("Relinker");
    await linkDiscordAccount(prisma, user.id, PROFILE);
    const next = { discordId: "90000000000000001", discordName: "smurf_acct" };

    const res = await linkDiscordAccount(prisma, user.id, next);

    expect(res).toEqual({ ok: true, previousDiscordId: PROFILE.discordId });
    expect(await discordOf(user.id)).toEqual(next);
  });

  it("linking the same account again is a harmless no-op (name refresh)", async () => {
    const user = await makeUser("Idempotent");
    await linkDiscordAccount(prisma, user.id, PROFILE);
    const renamed = { ...PROFILE, discordName: "dendi_renamed" };

    const res = await linkDiscordAccount(prisma, user.id, renamed);

    // No previousDiscordId: nothing was replaced, so there is no stale
    // account for the callback to strip a role from.
    expect(res).toEqual({ ok: true, previousDiscordId: null });
    expect(await discordOf(user.id)).toEqual(renamed);
  });
});

describe("re-linking strips the ping role from the REPLACED account", () => {
  // The gap this closes: unlinkDiscord takes the role with it, but re-linking
  // a DIFFERENT account used to leave the role on the old one — pinged
  // forever, with the off switch rendered only for the new account.
  it("calls the strip with the old id exactly when the id changed", async () => {
    const user = await makeUser("RoleCarrier");
    await linkDiscordAccount(prisma, user.id, PROFILE);
    const strip = vi.fn().mockResolvedValue(undefined);
    const newId = { ...PROFILE, discordId: "90000000000000002" };
    const deps = happyDeps({
      fetchIdentity: vi.fn().mockResolvedValue(newId),
      stripPingRole: strip,
    });

    const { redirect } = await handleDiscordCallback(
      prisma,
      callbackInput(user.id),
      deps,
    );

    expect(redirect).toBe("/me?discord=linked");
    expect(strip).toHaveBeenCalledTimes(1);
    expect(strip).toHaveBeenCalledWith(PROFILE.discordId);
  });

  it("does NOT strip on a same-account re-link", async () => {
    const user = await makeUser("SameAgain");
    await linkDiscordAccount(prisma, user.id, PROFILE);
    const strip = vi.fn().mockResolvedValue(undefined);

    await handleDiscordCallback(
      prisma,
      callbackInput(user.id),
      happyDeps({ stripPingRole: strip }),
    );

    expect(strip).not.toHaveBeenCalled();
  });

  it("a failed strip NEVER fails the link — best-effort by contract", async () => {
    const user = await makeUser("StripFails");
    await linkDiscordAccount(prisma, user.id, PROFILE);
    const newId = { ...PROFILE, discordId: "90000000000000003" };

    const { redirect } = await handleDiscordCallback(
      prisma,
      callbackInput(user.id),
      happyDeps({
        fetchIdentity: vi.fn().mockResolvedValue(newId),
        stripPingRole: vi.fn().mockRejectedValue(new Error("discord down")),
      }),
    );

    expect(redirect).toBe("/me?discord=linked");
    expect(await discordOf(user.id)).toEqual(newId);
  });
});

describe("the return path — where a link lands", () => {
  // Linking is a full-page round-trip that used to always dump the player on
  // /me — wrong for everyone who clicked from the dashboard join nag. Only a
  // FULL success honors it: every other outcome carries a ?discord= code
  // that only /me can render and scrub.
  const withNext = (userId: string, next: string) =>
    callbackInput(userId, {
      cookie: packOauthCookie(OAUTH_STATE, OAUTH_VERIFIER, userId, next),
    });

  it("a full success lands back where the player clicked", async () => {
    const user = await makeUser("Dashboarder");
    const { redirect } = await handleDiscordCallback(
      prisma,
      withNext(user.id, "/"),
      happyDeps({ joinGuild: vi.fn().mockResolvedValue("joined") }),
    );
    expect(redirect).toBe("/");
  });

  it("identify-only success (no bot) honors it too", async () => {
    const user = await makeUser("NoBotLeague");
    const { redirect } = await handleDiscordCallback(
      prisma,
      withNext(user.id, "/"),
      happyDeps(), // joinGuild → null = no bot configured
    );
    expect(redirect).toBe("/");
  });

  it("anything that needs the /me note overrides the return path", async () => {
    const user = await makeUser("JoinFailed");
    const { redirect } = await handleDiscordCallback(
      prisma,
      withNext(user.id, "/"),
      happyDeps({ joinGuild: vi.fn().mockResolvedValue("forbidden") }),
    );
    // join_failed's copy and CTA render only on /me — landing it on the
    // dashboard would strand an unexplained query param.
    expect(redirect).toBe("/me?discord=join_failed");
  });

  it("a success bound for /me anyway keeps its confirmation code", async () => {
    const user = await makeUser("MeBound");
    const { redirect } = await handleDiscordCallback(
      prisma,
      withNext(user.id, "/me"),
      happyDeps({ joinGuild: vi.fn().mockResolvedValue("joined") }),
    );
    expect(redirect).toBe("/me?discord=joined");
  });

  it("a successful join PRIMES the membership memo — the landing page must not re-nag", async () => {
    // A dashboard-bound success re-renders DiscordSetupPrompt immediately;
    // without the prime it would serve a memoised "not-member" for up to a
    // recheck-TTL and show the join nag to a player who JUST joined.
    const user = await makeUser("FreshJoiner");
    _clearMembershipMemoForTests();
    await handleDiscordCallback(
      prisma,
      withNext(user.id, "/"),
      happyDeps({ joinGuild: vi.fn().mockResolvedValue("joined") }),
    );
    // The unreachable apiBase proves this answer comes from the memo, not a
    // lookup: a miss would try the network and resolve null.
    expect(
      await memoGuildMembership(PROFILE.discordId, {
        token: "t",
        guildId: "g",
        apiBase: "http://127.0.0.1:1",
      }),
    ).toBe("member");
  });

  it("a screening-gated join primes 'pending', so the rules nag shows instead", async () => {
    const user = await makeUser("PendingJoiner");
    _clearMembershipMemoForTests();
    await handleDiscordCallback(
      prisma,
      callbackInput(user.id),
      happyDeps({ joinGuild: vi.fn().mockResolvedValue("joined-pending") }),
    );
    expect(
      await memoGuildMembership(PROFILE.discordId, {
        token: "t",
        guildId: "g",
        apiBase: "http://127.0.0.1:1",
      }),
    ).toBe("pending");
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

    expect(await discordOf(user.id)).toEqual({
      discordId: null,
      discordName: "",
    });
  });
});

describe("handleDiscordCallback — every branch lands on a fixed same-origin path", () => {
  it("signed-out session → back through login", async () => {
    const deps = happyDeps();
    const res = await handleDiscordCallback(prisma, callbackInput(null), deps);
    expect(res.redirect).toBe("/login?next=%2Fme%3Fdiscord%3Dsession");
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

  it("forged cancellation state cannot cancel the browser's active flow", async () => {
    const user = await makeUser("ForgedCanceller");
    const deps = happyDeps();
    const res = await handleDiscordCallback(
      prisma,
      callbackInput(user.id, {
        errorParam: "access_denied",
        state: "a".repeat(43),
      }),
      deps,
    );
    expect(res.redirect).toBe("/me?discord=state");
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
        cookie: packOauthCookie("b".repeat(43), "p".repeat(43), user.id),
        state: "a".repeat(43),
      }),
      deps,
    );
    expect(res.redirect).toBe("/me?discord=state");
    expect(deps.exchange).not.toHaveBeenCalled();
    expect(await discordOf(user.id)).toEqual({
      discordId: null,
      discordName: "",
    });
  });

  it("session changed mid-round-trip → rejects before linking to the replacement user", async () => {
    const initiator = await makeUser("OAuthInitiator");
    const replacement = await makeUser("ReplacementSession");
    const deps = happyDeps();
    const res = await handleDiscordCallback(
      prisma,
      callbackInput(replacement.id, {
        cookie: packOauthCookie(OAUTH_STATE, OAUTH_VERIFIER, initiator.id),
      }),
      deps,
    );

    expect(res.redirect).toBe("/me?discord=state");
    expect(deps.exchange).not.toHaveBeenCalled();
    expect(await discordOf(initiator.id)).toEqual({
      discordId: null,
      discordName: "",
    });
    expect(await discordOf(replacement.id)).toEqual({
      discordId: null,
      discordName: "",
    });
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
    expect(await discordOf(user.id)).toEqual({
      discordId: null,
      discordName: "",
    });
  });

  it("identity fetch failure → error, nothing persisted", async () => {
    const user = await makeUser("MeFail");
    const res = await handleDiscordCallback(
      prisma,
      callbackInput(user.id),
      happyDeps({ fetchIdentity: vi.fn().mockResolvedValue(null) }),
    );
    expect(res.redirect).toBe("/me?discord=error");
    expect(await discordOf(user.id)).toEqual({
      discordId: null,
      discordName: "",
    });
  });

  it("success → linked, with the verifier fed to the exchange (PKCE)", async () => {
    const user = await makeUser("Winner");
    const deps = happyDeps();

    const res = await handleDiscordCallback(
      prisma,
      callbackInput(user.id),
      deps,
    );

    expect(res.redirect).toBe("/me?discord=linked");
    expect(await discordOf(user.id)).toEqual(PROFILE);
    expect(deps.exchange).toHaveBeenCalledWith(
      expect.objectContaining({
        codeVerifier: OAUTH_VERIFIER,
        code: "auth-code",
      }),
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
    expect(await discordOf(late.id)).toEqual({
      discordId: null,
      discordName: "",
    });
  });
});

describe("handleDiscordCallback — the guilds.join half", () => {
  it("hands the JUST-EXCHANGED token to the join, not a stored one", async () => {
    const user = await makeUser("Joiner");
    const deps = happyDeps({ joinGuild: vi.fn().mockResolvedValue("joined") });

    const res = await handleDiscordCallback(
      prisma,
      callbackInput(user.id),
      deps,
    );

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

    const res = await handleDiscordCallback(
      prisma,
      callbackInput(late.id),
      deps,
    );

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
    expect(await discordOf(user.id)).toEqual({
      discordId: null,
      discordName: "",
    });
  });
});
