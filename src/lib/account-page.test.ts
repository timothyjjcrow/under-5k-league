import { describe, expect, it } from "vitest";
import {
  accountNextSteps,
  signupSummary,
  type AccountStepInput,
} from "./account-page";

const base: AccountStepInput = {
  signedUp: true,
  draftConfirmation: "none",
  isCaptain: false,
  discordLinked: true,
  discordHandle: true,
  discordLinkable: true,
  membership: "member",
  matchDataPrivate: false,
};
const keys = (input: Partial<AccountStepInput>) =>
  accountNextSteps({ ...base, ...input }).map((s) => s.key);

describe("accountNextSteps", () => {
  it("is empty for a signed-up player who is linked, in the server and public", () => {
    expect(keys({})).toEqual([]);
  });

  it("asks to link Discord until an OAuth link exists", () => {
    expect(keys({ discordLinked: false, membership: null })).toEqual([
      "link-discord",
    ]);
  });

  it("does not let a typed handle stand in for a link", () => {
    expect(
      keys({ discordLinked: false, discordHandle: true, membership: null }),
    ).toEqual(["link-discord"]);
  });

  it("accepts a typed handle where the league can't link Discord", () => {
    expect(
      keys({
        discordLinked: false,
        discordHandle: true,
        discordLinkable: false,
        membership: null,
      }),
    ).toEqual([]);
    const [step] = accountNextSteps({
      ...base,
      discordLinked: false,
      discordHandle: false,
      discordLinkable: false,
      membership: null,
    });
    expect(step.label).toBe("Add your Discord so captains can reach you");
  });

  it("counts a linked account as done only once it is in the server", () => {
    expect(keys({ membership: "not-member" })).toEqual(["join-server"]);
    expect(keys({ membership: "pending" })).toEqual(["accept-rules"]);
    expect(keys({ membership: "member" })).toEqual([]);
  });

  it("never flags a linked account whose membership is unknown", () => {
    expect(keys({ membership: null })).toEqual([]);
  });

  it("puts the draft confirmation first and points up to it", () => {
    const steps = accountNextSteps({
      ...base,
      draftConfirmation: "needed",
      discordLinked: false,
      matchDataPrivate: true,
    });
    expect(steps.map((s) => s.key)).toEqual([
      "confirm-draft",
      "link-discord",
      "match-data",
    ]);
    expect(steps[0]).toMatchObject({ href: "#draft-commitment", arrow: "up" });
    expect(steps[1]).toMatchObject({ href: "#profile-discord", arrow: "down" });
    expect(steps[2]).toMatchObject({ href: "#profile-dota", arrow: "down" });
  });

  it("says when the draft time changed after a confirmation", () => {
    const [step] = accountNextSteps({ ...base, draftConfirmation: "changed" });
    expect(step.label).toMatch(/draft time changed/);
  });

  it("addresses a captain's team rather than a captain", () => {
    const [player] = accountNextSteps({ ...base, discordLinked: false });
    const [captain] = accountNextSteps({
      ...base,
      discordLinked: false,
      isCaptain: true,
    });
    expect(player.label).toMatch(/captains can reach you/);
    expect(captain.label).toMatch(/your team can reach you/);
  });

  it("leaves Discord alone before someone signs up, but still flags private match data", () => {
    expect(
      keys({ signedUp: false, discordLinked: false, membership: null }),
    ).toEqual([]);
    expect(
      keys({
        signedUp: false,
        draftConfirmation: "needed",
        discordLinked: false,
        matchDataPrivate: true,
      }),
    ).toEqual(["match-data"]);
  });

  it("gives every step a distinct label, so no two controls share a name", () => {
    const all = [
      ...accountNextSteps({
        ...base,
        draftConfirmation: "needed",
        discordLinked: false,
        matchDataPrivate: true,
      }),
      ...accountNextSteps({ ...base, membership: "not-member" }),
      ...accountNextSteps({ ...base, membership: "pending" }),
    ].map((s) => s.label);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("signupSummary", () => {
  it("summarises a full signup", () => {
    expect(
      signupSummary({
        type: "PLAYER",
        mmr: 3200,
        roles: "2,3",
        favoriteHeroes: "Pudge, Lion, Sniper",
        wantsCaptain: true,
      }),
    ).toBe("Full player · 3200 MMR · Mid, Offlane · 3 heroes · Captain volunteer");
  });

  it("leaves out empty answers and an unknown MMR", () => {
    expect(
      signupSummary({
        type: "PLAYER",
        mmr: 0,
        roles: "",
        favoriteHeroes: "",
        wantsCaptain: false,
      }),
    ).toBe("Full player");
  });

  it("says 'Any position' when every role is ticked and counts one hero", () => {
    expect(
      signupSummary({
        type: "STANDIN",
        mmr: 2100,
        roles: "1,2,3,4,5",
        favoriteHeroes: "Axe",
        wantsCaptain: false,
      }),
    ).toBe("Standin · 2100 MMR · Any position · 1 hero");
  });

  it("never calls a standin a captain volunteer", () => {
    expect(
      signupSummary({
        type: "STANDIN",
        mmr: 0,
        roles: null,
        favoriteHeroes: null,
        wantsCaptain: true,
      }),
    ).toBe("Standin");
  });

  it("counts hero names it doesn't recognise too", () => {
    expect(
      signupSummary({
        type: "PLAYER",
        mmr: 0,
        roles: "1",
        favoriteHeroes: "Pudge, Not A Hero",
        wantsCaptain: false,
      }),
    ).toBe("Full player · Carry · 2 heroes");
  });
});
