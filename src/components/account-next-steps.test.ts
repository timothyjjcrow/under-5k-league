import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { accountNextSteps, type AccountStepInput } from "@/lib/account-page";
import {
  AccountNextStepBanner,
  SignupNextSteps,
} from "./account-next-steps";

const facts: AccountStepInput = {
  signedUp: true,
  draftConfirmation: "needed",
  isCaptain: false,
  discordLinked: false,
  discordHandle: false,
  discordLinkable: true,
  membership: null,
  matchDataPrivate: false,
};

describe("SignupNextSteps", () => {
  it("renders nothing once nothing is left", () => {
    expect(
      renderToStaticMarkup(createElement(SignupNextSteps, { steps: [] })),
    ).toBe("");
  });

  it("lists each open step as one in-page link named by the task", () => {
    const html = renderToStaticMarkup(
      createElement(SignupNextSteps, { steps: accountNextSteps(facts) }),
    );
    expect(html).toContain("You&#x27;re signed up. Next:");
    expect(html).toContain('href="#draft-commitment"');
    expect(html).toContain("Confirm you can make draft night");
    expect(html).toContain('href="#profile-discord"');
    expect(html).toContain("Link your Discord so captains can reach you");
    // Arrows are decoration; the link's name is the task alone.
    expect(html).toContain('<span aria-hidden="true" class="shrink-0 text-muted">↑</span>');
    expect(html).toContain('<span aria-hidden="true" class="shrink-0 text-muted">↓</span>');
  });
});

describe("AccountNextStepBanner", () => {
  it("renders one line for the step, or nothing", () => {
    expect(
      renderToStaticMarkup(
        createElement(AccountNextStepBanner, { step: undefined }),
      ),
    ).toBe("");
    const [step] = accountNextSteps({
      ...facts,
      signedUp: false,
      matchDataPrivate: true,
    });
    const html = renderToStaticMarkup(
      createElement(AccountNextStepBanner, { step }),
    );
    expect(html).toContain('href="#profile-dota"');
    expect(html).toContain("Make your Dota match data public");
    expect(html).not.toContain("<h3");
  });
});
