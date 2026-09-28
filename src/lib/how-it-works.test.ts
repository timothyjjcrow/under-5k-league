import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";
import { readFileSync } from "node:fs";
import { REGISTRATION_STATUS, SEASON_STATUS } from "./constants";
import {
  eligibilityText,
  howItWorksAction,
  resultsCopy,
  standinSignupOpen,
} from "./how-it-works";
import { NO_TICKET_RESULT_LEAD } from "./match-hosting";

describe("eligibilityText", () => {
  it("states the hard ceiling and the medal rule", () => {
    expect(eligibilityText(0)).toBe(
      "Players up to 5,000 MMR can join; Divine 3 and higher medals and Immortal players can't.",
    );
  });

  it("adds the season's soft limit as a review, not a refusal", () => {
    expect(eligibilityText(4500)).toMatch(
      /Above 4,500 MMR, an admin looks over your signup before the draft\.$/,
    );
  });
});

describe("resultsCopy", () => {
  it("promises self-importing results only on a ticketed season", () => {
    const { step, faq } = resultsCopy(true);
    expect(step).toMatch(/by themselves/);
    expect(faq).toMatch(/Expose Public Match Data/);
    expect(faq).toMatch(/add it by match ID/);
  });

  // Europe runs without a ticket: its match page says the result may not
  // appear on its own and falls back to an admin (match-hosting.ts). This
  // page must not tell the same players otherwise.
  it("says what the match page says when the season has no ticket", () => {
    const { step, faq } = resultsCopy(false);
    for (const copy of [step, faq]) {
      expect(copy).not.toMatch(/by themselves|by itself/);
      expect(copy).not.toMatch(/Expose Public Match Data/);
    }
    expect(step).toMatch(/no league ticket/);
    expect(faq).toContain(NO_TICKET_RESULT_LEAD);
    expect(faq).toMatch(/match ID/);
    expect(faq).toMatch(/sends an admin the score/);
  });

  it("doesn't promise either way between seasons", () => {
    const { step, faq } = resultsCopy(null);
    expect(step).not.toMatch(/by themselves|no league ticket/);
    expect(faq).toMatch(/When the season has a Dota league ticket/);
    expect(faq).toMatch(/sends an admin the score/);
  });

  it("is chosen from the active season's league ticket", () => {
    const page = readFileSync("src/app/how-it-works/page.tsx", "utf8");
    expect(page).toContain(
      "resultsCopy(season ? !!season.dotaLeagueId : null)",
    );
    expect(page).not.toMatch(/Results come in from Dota by themselves/);
  });
});

describe("standinSignupOpen", () => {
  it("opens from the draft through the playoffs", () => {
    for (const phase of [
      SEASON_STATUS.DRAFT,
      SEASON_STATUS.REGULAR_SEASON,
      SEASON_STATUS.PLAYOFFS,
    ]) {
      expect(standinSignupOpen({ phase, registrationStatus: null })).toBe(true);
    }
    for (const phase of [null, SEASON_STATUS.SIGNUPS, SEASON_STATUS.COMPLETE]) {
      expect(standinSignupOpen({ phase, registrationStatus: null })).toBe(
        false,
      );
    }
  });

  it("skips anyone already signed up or removed by an admin", () => {
    const phase = SEASON_STATUS.REGULAR_SEASON;
    expect(
      standinSignupOpen({ phase, registrationStatus: REGISTRATION_STATUS.ACTIVE }),
    ).toBe(false);
    expect(
      standinSignupOpen({ phase, registrationStatus: REGISTRATION_STATUS.REMOVED }),
    ).toBe(false);
    expect(
      standinSignupOpen({
        phase,
        registrationStatus: REGISTRATION_STATUS.WITHDRAWN,
      }),
    ).toBe(true);
  });
});

describe("howItWorksAction", () => {
  const base = {
    phase: SEASON_STATUS.SIGNUPS as string | null,
    seasonName: "Season 1" as string | null,
    signedIn: false,
    registrationStatus: null as string | null,
    onRoster: false,
    hasDiscord: true,
  };

  it("asks newcomers to join during signups, through sign-in when needed", () => {
    expect(howItWorksAction(base)).toEqual({
      kind: "sign-in",
      next: "/me",
      label: "Join Season 1",
    });
    expect(howItWorksAction({ ...base, signedIn: true })).toEqual({
      kind: "link",
      href: "/me",
      label: "Join Season 1",
    });
  });

  it("sends a player who already joined to the Discord", () => {
    expect(
      howItWorksAction({
        ...base,
        signedIn: true,
        registrationStatus: REGISTRATION_STATUS.ACTIVE,
      }),
    ).toEqual({ kind: "discord" });
  });

  it("asks for standins from the draft through the playoffs", () => {
    for (const phase of [
      SEASON_STATUS.DRAFT,
      SEASON_STATUS.REGULAR_SEASON,
      SEASON_STATUS.PLAYOFFS,
    ]) {
      expect(howItWorksAction({ ...base, phase })).toEqual({
        kind: "sign-in",
        next: "/me",
        label: "Sign up as a standin",
      });
      expect(
        howItWorksAction({ ...base, phase, signedIn: true }),
      ).toMatchObject({ href: "/me", label: "Sign up as a standin" });
      // Someone already playing or covering has nothing to sign up for.
      expect(
        howItWorksAction({
          ...base,
          phase,
          signedIn: true,
          registrationStatus: REGISTRATION_STATUS.ACTIVE,
          onRoster: true,
        }),
      ).toEqual({ kind: "discord" });
    }
  });

  it("points to the Discord once the season is over or between seasons", () => {
    for (const phase of [SEASON_STATUS.COMPLETE, null]) {
      expect(
        howItWorksAction({
          ...base,
          phase,
          seasonName: phase ? "Season 1" : null,
        }),
      ).toEqual({ kind: "discord" });
    }
  });

  it("falls back to League news where the region has no Discord invite", () => {
    expect(
      howItWorksAction({
        ...base,
        phase: SEASON_STATUS.COMPLETE,
        hasDiscord: false,
      }),
    ).toEqual({ kind: "news" });
  });
});

describe("the old feature tour address", () => {
  it("redirects permanently to How it works", async () => {
    expect(typeof nextConfig.redirects).toBe("function");
    expect(await nextConfig.redirects!()).toContainEqual({
      source: "/features",
      destination: "/how-it-works",
      permanent: true,
    });
  });
});
