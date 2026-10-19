import { describe, expect, it } from "vitest";
import { sourceFile } from "../../test/support/source-files";
import {
  signupDiscordBlocker,
  signupDiscordJudged,
  signupDiscordRefusal,
  signupChecklist,
  signupStepDetail,
  type SignupDiscordBlocker,
  type SignupDiscordPolicy,
} from "./signup-discord";

const FULL: SignupDiscordPolicy = { linkRequired: true, membershipCheckable: true };
const LINK_ONLY: SignupDiscordPolicy = { linkRequired: true, membershipCheckable: false };
const OFF: SignupDiscordPolicy = { linkRequired: false, membershipCheckable: true };

describe("signupDiscordJudged", () => {
  it("judges an admission: no signup yet, or a withdrawn one coming back", () => {
    expect(signupDiscordJudged(null)).toBe(true);
    expect(signupDiscordJudged(undefined)).toBe(true);
    expect(signupDiscordJudged("WITHDRAWN")).toBe(true);
  });

  it("leaves an admitted signup alone, and a removed one to the write's own refusal", () => {
    expect(signupDiscordJudged("ACTIVE")).toBe(false);
    expect(signupDiscordJudged("REMOVED")).toBe(false);
  });
});

describe("signupDiscordBlocker", () => {
  it("asks for the link first, whatever the server says", () => {
    expect(signupDiscordBlocker({ policy: FULL, linked: false, membership: null })).toBe("link");
    expect(signupDiscordBlocker({ policy: LINK_ONLY, linked: false, membership: null })).toBe("link");
  });

  it("needs the linked account in the server, past its rules", () => {
    expect(signupDiscordBlocker({ policy: FULL, linked: true, membership: "not-member" })).toBe("join");
    expect(signupDiscordBlocker({ policy: FULL, linked: true, membership: "pending" })).toBe("rules");
    expect(signupDiscordBlocker({ policy: FULL, linked: true, membership: "member" })).toBeNull();
  });

  it("never blocks on an unknown answer", () => {
    // Discord down, slow, or the bot gone from the server: the link still
    // counts, and signups stay open.
    expect(signupDiscordBlocker({ policy: FULL, linked: true, membership: null })).toBeNull();
  });

  it("asks only for what this deployment can check", () => {
    // No bot: the link is all there is to require.
    expect(signupDiscordBlocker({ policy: LINK_ONLY, linked: true, membership: "not-member" })).toBeNull();
    // No linking: nothing a player could do, so nothing is required.
    expect(signupDiscordBlocker({ policy: OFF, linked: false, membership: "not-member" })).toBeNull();
  });
});

describe("signupDiscordRefusal", () => {
  it("says a different thing for each blocker, and names the fix", () => {
    const blockers: SignupDiscordBlocker[] = ["link", "join", "rules"];
    const texts = blockers.map(signupDiscordRefusal);
    expect(new Set(texts).size).toBe(3);
    expect(texts[0]).toMatch(/^Link your Discord first/);
    expect(texts[1]).toMatch(/Join the server, then sign up\.$/);
    expect(texts[2]).toMatch(/^Accept the rules in the league's Discord server, then sign up/);
  });
});

describe("signupChecklist", () => {
  const base = {
    steamName: "Zai",
    oneClick: true,
    hasInvite: true,
    handle: null as string | null,
    callback: null as string | null,
  };
  const step = (
    steps: ReturnType<typeof signupChecklist>,
    key: "steam" | "discord" | "signup",
  ) => steps.find((s) => s.key === key)!;
  const ctas = (s: ReturnType<typeof step>) =>
    s.ctas.map((cta) => `${cta.kind}:${cta.label}`);

  it("is Steam, Discord, then the signup, with Steam already done", () => {
    const steps = signupChecklist({ ...base, discord: { status: "blocked", blocker: "link" } });
    expect(steps.map((s) => s.key)).toEqual(["steam", "discord", "signup"]);
    expect(step(steps, "steam")).toMatchObject({ state: "done", detail: "Signed in as Zai." });
  });

  it("puts the one-click link right in the Discord step, with one plain sentence on why", () => {
    const steps = signupChecklist({ ...base, discord: { status: "blocked", blocker: "link" } });
    const discord = step(steps, "discord");
    expect(discord.state).toBe("current");
    expect(discord.detail).toBe(
      "Link your Discord so teams and admins can contact you about the league. Complete this step to finish signing up.",
    );
    // No invite: joining with it never links the account.
    expect(ctas(discord)).toEqual(["oauth:Link Discord & join the server"]);
    expect(step(steps, "signup")).toMatchObject({
      state: "locked",
      detail: "Opens here once your Discord is done.",
    });
  });

  it("links, with the invite beside it, where joining is a separate trip", () => {
    const discord = step(
      signupChecklist({ ...base, oneClick: false, discord: { status: "blocked", blocker: "link" } }),
      "discord",
    );
    expect(ctas(discord)).toEqual(["oauth:Link Discord", "invite:Join the server"]);
    expect(discord.detail).toMatch(/^Link your Discord and join the league's server so teams and admins/);
    expect(
      ctas(step(signupChecklist({ ...base, oneClick: false, hasInvite: false, discord: { status: "blocked", blocker: "link" } }), "discord")),
    ).toEqual(["oauth:Link Discord"]);
  });

  it("names the linked account that isn't in the server, and offers a fresh look", () => {
    const discord = step(
      signupChecklist({ ...base, handle: "zai", discord: { status: "blocked", blocker: "join" } }),
      "discord",
    );
    expect(discord.detail).toBe(
      "Your Discord (@zai) is linked but isn't in the league's server yet. Join it so teams and admins can contact you, then finish signing up.",
    );
    expect(ctas(discord)).toEqual([
      "oauth:Join the server",
      "invite:Use the invite instead",
      "recheck:Check again",
    ]);
    expect(
      ctas(step(signupChecklist({ ...base, oneClick: false, discord: { status: "blocked", blocker: "join" } }), "discord")),
    ).toEqual(["invite:Join the server", "recheck:Check again"]);
  });

  it("sends a pending member to the rules in Discord, then back", () => {
    const discord = step(
      signupChecklist({ ...base, discord: { status: "blocked", blocker: "rules" } }),
      "discord",
    );
    expect(discord.detail).toMatch(/haven't accepted its rules/);
    expect(ctas(discord)).toEqual(["invite:Open Discord", "recheck:Check again"]);
    expect(
      ctas(step(signupChecklist({ ...base, hasInvite: false, discord: { status: "blocked", blocker: "rules" } }), "discord")),
    ).toEqual(["recheck:Check again"]);
  });

  it("opens the signup once Discord is done, and claims the server only when Discord said so", () => {
    const inServer = signupChecklist({ ...base, handle: "zai", discord: { status: "done", inServer: true } });
    expect(step(inServer, "discord")).toMatchObject({
      state: "done",
      detail: "Linked as @zai, and in the league's server.",
      ctas: [],
    });
    expect(step(inServer, "signup")).toMatchObject({ state: "current", detail: "Fill in the form below." });
    const unknown = signupChecklist({ ...base, handle: "zai", discord: { status: "done", inServer: false } });
    expect(step(unknown, "discord").detail).toBe("Linked as @zai.");
    expect(step(unknown, "signup").state).toBe("current");
  });

  it("keeps the invite after a join the callback couldn't finish, while Discord isn't answering", () => {
    // The note above it says "join it with the button below".
    expect(
      ctas(step(signupChecklist({ ...base, callback: "join_failed", discord: { status: "done", inServer: false } }), "discord")),
    ).toEqual(["invite:Join the server"]);
    expect(
      ctas(step(signupChecklist({ ...base, callback: "joined_pending", discord: { status: "done", inServer: false } }), "discord")),
    ).toEqual(["invite:Open Discord"]);
    expect(
      ctas(step(signupChecklist({ ...base, callback: "join_failed", discord: { status: "done", inServer: true } }), "discord")),
    ).toEqual([]);
  });

  it("shows Discord still checking, and the signup locked, until the lookup answers", () => {
    const steps = signupChecklist({ ...base, discord: { status: "checking" } });
    expect(step(steps, "discord")).toMatchObject({ state: "checking", ctas: [] });
    expect(step(steps, "signup").state).toBe("locked");
  });

  it("keeps the Discord step to plain words: nothing about ids, tokens or scopes", () => {
    const states = [
      { status: "blocked", blocker: "link" },
      { status: "blocked", blocker: "join" },
      { status: "blocked", blocker: "rules" },
      { status: "checking" },
      { status: "done", inServer: true },
      { status: "done", inServer: false },
    ] as const;
    for (const discord of states) {
      for (const oneClick of [true, false]) {
        for (const s of signupChecklist({ ...base, oneClick, discord })) {
          expect(s.detail, JSON.stringify(discord)).not.toMatch(/account ID|OAuth|token|scope|email/i);
        }
      }
    }
  });

  it("keeps every control's name distinct within a state", () => {
    const states = [
      { status: "blocked", blocker: "link" },
      { status: "blocked", blocker: "join" },
      { status: "blocked", blocker: "rules" },
    ] as const;
    for (const discord of states) {
      for (const oneClick of [true, false]) {
        const names = step(signupChecklist({ ...base, oneClick, discord }), "discord").ctas.map(
          (cta) => cta.label,
        );
        expect(new Set(names).size).toBe(names.length);
      }
    }
  });
});

describe("signupStepDetail", () => {
  it("names the Discord a signup needs here", () => {
    expect(signupStepDetail(FULL)).toMatch(/^Sign in with Steam, link your Discord and join the league's server, then add/);
    expect(signupStepDetail(LINK_ONLY)).toMatch(/^Sign in with Steam, link your Discord, then add/);
    expect(signupStepDetail(OFF)).toMatch(/^Sign in with Steam and add your roles/);
  });
});

describe("source guards: the action and /me share the rule", () => {
  it("judges Discord before the OpenDota fetch and re-checks the account in the write", () => {
    const text = sourceFile("src/app/actions/registration.ts").text;
    const action = text.slice(text.indexOf("export async function saveRegistration("));
    const early = action.indexOf("if (earlyGateError) return");
    const judged = action.indexOf("signupDiscordJudged(existing?.status)");
    const standing = action.indexOf("await signupDiscordStanding(");
    const openDota = action.indexOf('claimProviderCooldown("open-dota-profile"');
    const transaction = action.indexOf("prisma.$transaction(");
    const recheck = action.indexOf("currentUser.discordId !== judgedDiscordId");
    const write = action.indexOf("tx.registration.updateMany(");
    for (const at of [early, judged, standing, openDota, transaction, recheck, write]) {
      expect(at).toBeGreaterThan(-1);
    }
    expect(early).toBeLessThan(judged);
    expect(judged).toBeLessThan(standing);
    expect(standing).toBeLessThan(openDota);
    expect(transaction).toBeLessThan(recheck);
    expect(recheck).toBeLessThan(write);
  });

  it("puts the returning card and the form behind the gate, from the action's facts", () => {
    const page = sourceFile("src/app/me/page.tsx").text;
    expect(page).toMatch(/signupDiscordJudged\(reg\?\.status\)/);
    expect(page).toMatch(/signupDiscordPolicy\(\)/);
    const open = page.indexOf("<SignupDiscordGate");
    const returning = page.indexOf("<ReturningJoinCard");
    const form = page.indexOf("<SavedSignupForm");
    const close = page.indexOf("</SignupDiscordGate>");
    expect(open).toBeGreaterThan(-1);
    expect(open).toBeLessThan(returning);
    expect(returning).toBeLessThan(form);
    expect(form).toBeLessThan(close);
    // The Discord card leaves its buttons to the steps whenever they show.
    expect(page).toMatch(/signupOwnsDiscord=\{signupGate !== "none"\}/);
    // The form keeps one slot in every state: a first signup turns the steps
    // off, and a form that moved in the tree would remount with its open
    // editor and "Saved" collapsed (the e2e has no bot, so it can't see the
    // membership case).
    const gate = page.slice(
      page.indexOf("function SignupDiscordGate("),
      page.indexOf("function SignupChecklistSlot("),
    );
    expect(gate.length).toBeGreaterThan(0);
    expect(gate.match(/return \(/g)).toHaveLength(1);
    expect(gate).not.toMatch(/\{children\}\s*<\/>/);
    expect(gate).toMatch(/<Suspense fallback=\{null\}>\s*<SignupFormSlot/);
    // Exactly one form and one returning card, both inside.
    expect(page.split("<SavedSignupForm").length - 1).toBe(1);
    expect(page.split("<ReturningJoinCard").length - 1).toBe(1);
  });
});
