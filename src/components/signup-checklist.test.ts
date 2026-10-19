import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { signupChecklist, type SignupChecklistDiscord } from "@/lib/signup-discord";
import { DISCORD_INVITE_URL } from "@/lib/constants";
import { SignupChecklist } from "./signup-checklist";

const render = (
  discord: SignupChecklistDiscord,
  extra: { note?: { tone: "success" | "danger" | "muted"; text: string } } = {},
) =>
  renderToStaticMarkup(
    createElement(SignupChecklist, {
      steps: signupChecklist({
        steamName: "Zai",
        discord,
        oneClick: true,
        hasInvite: !!DISCORD_INVITE_URL,
        handle: "zai",
        callback: null,
      }),
      note: extra.note ?? null,
    }),
  );

describe("SignupChecklist", () => {
  it("lists the three steps in order, saying where each stands for screen readers", () => {
    const html = render({ status: "blocked", blocker: "link" });
    expect(html).toMatch(/^<ol id="signup-checklist" aria-label="Steps to join the season"/);
    const labels = [...html.matchAll(/<span class="sr-only">([^<]+)<\/span>([^<]+)<\/p>/g)].map(
      (m) => `${m[1]}${m[2]}`,
    );
    expect(labels).toEqual(["Done: Steam", "To do now: Discord", "Not yet: Your signup"]);
    expect(html).toContain('id="signup-discord-step" data-state="current"');
  });

  it("carries the real link button in the Discord step, with one plain sentence on why", () => {
    const html = render({ status: "blocked", blocker: "link" });
    expect(html).toMatch(/<a href="\/api\/auth\/discord"[^>]*>Link Discord &amp; join the server<\/a>/);
    expect(html).toContain("so teams and admins can contact you about the league");
    expect(html).not.toContain("account ID");
  });

  it("reloads /me to check again once the player has joined", () => {
    const html = render({ status: "blocked", blocker: "join" });
    expect(html).toMatch(/<a href="\/api\/auth\/discord"[^>]*>Join the server<\/a>/);
    expect(html).toMatch(/<a href="\/me"[^>]*>Check again<\/a>/);
    expect(html).toContain("(@zai)");
  });

  it("marks Discord done and opens the signup, with no buttons left", () => {
    const html = render({ status: "done", inServer: true });
    expect(html).toContain('id="signup-discord-step" data-state="done"');
    expect(html).toContain("Linked as @zai, and in the league&#x27;s server.");
    expect(html).not.toContain("/api/auth/discord");
    expect(html).toContain('data-state="current"');
  });

  it("shows the callback's note on the Discord step, as an alert when it went wrong", () => {
    const html = render(
      { status: "blocked", blocker: "link" },
      { note: { tone: "danger", text: "That Discord account is already linked to another player." } },
    );
    expect(html).toMatch(/<p role="alert"[^>]*>That Discord account is already linked to another player\.<\/p>/);
  });
});
