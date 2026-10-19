import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  signupDiscordStep,
  type SignupDiscordBlocker,
} from "@/lib/signup-discord";
import { SignupDiscordStepPanel } from "./signup-discord-step";

const render = (blocker: SignupDiscordBlocker) =>
  renderToStaticMarkup(
    createElement(SignupDiscordStepPanel, {
      step: signupDiscordStep(blocker, { oneClick: true, handle: "zai" }),
    }),
  );

describe("SignupDiscordStepPanel", () => {
  it("sends an unlinked player to the Discord card, never straight to Discord", () => {
    const html = render("link");
    expect(html).toContain('id="signup-discord-step"');
    expect(html).toMatch(/<h3[^>]*>Link your Discord to sign up<\/h3>/);
    expect(html).toContain('href="#profile-discord"');
    // The card's own button starts the link, beside its consent text.
    expect(html).not.toContain("/api/auth/discord");
  });

  it("reloads /me to check again once the player has joined", () => {
    const html = render("join");
    expect(html).toContain('href="#profile-discord"');
    expect(html).toContain('href="/me"');
    expect(html).toContain("@zai");
  });

  it("offers only the recheck while the server's rules are pending", () => {
    const html = render("rules");
    expect(html).not.toContain("#profile-discord");
    expect(html).toContain('href="/me"');
  });
});
