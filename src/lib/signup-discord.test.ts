import { describe, expect, it } from "vitest";
import { sourceFile } from "../../test/support/source-files";
import {
  signupDiscordBlocker,
  signupDiscordJudged,
  signupDiscordRefusal,
  signupDiscordStep,
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

describe("signupDiscordStep", () => {
  const labels = (step: ReturnType<typeof signupDiscordStep>) =>
    step.ctas.map((cta) => `${cta.kind}:${cta.label}`);

  it("points an unlinked player at the Discord card, saying what one click does there", () => {
    const step = signupDiscordStep("link", { oneClick: true, handle: null });
    expect(step.title).toBe("Link your Discord to sign up");
    expect(step.body).toMatch(/links your account and adds it to the server in one click/);
    expect(labels(step)).toEqual(["card:Link your Discord"]);
    const twoTrips = signupDiscordStep("link", { oneClick: false, handle: null });
    expect(twoTrips.body).toMatch(/Link yours in the Discord card/);
    expect(labels(twoTrips)).toEqual(["card:Link your Discord"]);
  });

  it("names the linked account that isn't in the server, and offers a fresh look", () => {
    const step = signupDiscordStep("join", { oneClick: true, handle: "zai" });
    expect(step.body).toMatch(/^The Discord account you linked \(@zai\) isn't in the league's server yet/);
    expect(labels(step)).toEqual([
      "card:Get your linked account into the server",
      "recheck:Check again",
    ]);
    expect(signupDiscordStep("join", { oneClick: false, handle: null }).body).toMatch(
      /^The Discord account you linked isn't/,
    );
  });

  it("sends a pending member to the rules in Discord, then back", () => {
    expect(labels(signupDiscordStep("rules", { oneClick: true, handle: null }))).toEqual([
      "recheck:Check again",
    ]);
  });

  it("never names a control the way the Discord card names its buttons", () => {
    // The card's buttons (discordCardCtas): one name per control on /me.
    const cardButtons = new Set([
      "Link Discord & join the server",
      "Link Discord",
      "Join the server",
      "Use the invite instead",
      "Open Discord",
    ]);
    for (const blocker of ["link", "join", "rules"] as const) {
      for (const oneClick of [true, false]) {
        const names = signupDiscordStep(blocker, { oneClick, handle: null }).ctas.map(
          (cta) => cta.label,
        );
        expect(new Set(names).size).toBe(names.length);
        for (const name of names) expect(cardButtons.has(name)).toBe(false);
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
    // Exactly one form and one returning card, both inside.
    expect(page.split("<SavedSignupForm").length - 1).toBe(1);
    expect(page.split("<ReturningJoinCard").length - 1).toBe(1);
  });
});
