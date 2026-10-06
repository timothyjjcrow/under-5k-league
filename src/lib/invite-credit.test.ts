import { describe, expect, it } from "vitest";
import {
  cookieValue,
  inviteCreditApplies,
  inviteRefFromSearch,
  inviteUrl,
  isInviteRef,
  searchWithoutRef,
  shouldRememberInviteRef,
} from "./invite-credit";

const BORPO = "cmrcj7iv100002hhdsm77szdy";
const ZAI = "cmut14xdc000210rw59ybwj96";

describe("invite tags", () => {
  it("reads one well-formed tag from a query string", () => {
    expect(inviteRefFromSearch(`?ref=${BORPO}`)).toBe(BORPO);
    expect(inviteRefFromSearch(`?season=x&ref=${BORPO}`)).toBe(BORPO);
    expect(inviteRefFromSearch("?ref=f1457d1a-823d-43d1-b87e-496fec2056ad")).toBe(
      "f1457d1a-823d-43d1-b87e-496fec2056ad",
    );
  });

  it("reads no tag from a repeated, missing or malformed ref", () => {
    expect(inviteRefFromSearch(`?ref=${BORPO}&ref=${ZAI}`)).toBeNull();
    expect(inviteRefFromSearch("")).toBeNull();
    expect(inviteRefFromSearch("?ref=")).toBeNull();
    expect(inviteRefFromSearch("?ref=short")).toBeNull();
    expect(inviteRefFromSearch("?ref=%3Cscript%3E1234")).toBeNull();
    expect(isInviteRef(null)).toBe(false);
  });

  it("takes the tag out of the address and keeps everything else", () => {
    expect(searchWithoutRef(`?ref=${BORPO}`)).toBe("");
    expect(searchWithoutRef(`?season=s1&ref=${BORPO}`)).toBe("?season=s1");
    expect(searchWithoutRef("?season=s1")).toBe("?season=s1");
    expect(searchWithoutRef("")).toBe("");
  });

  it("lets the first link win", () => {
    expect(shouldRememberInviteRef(null, BORPO)).toBe(true);
    expect(shouldRememberInviteRef(BORPO, ZAI)).toBe(false);
    // A remembered value that isn't a tag (tampered, or an old format) is
    // as good as none.
    expect(shouldRememberInviteRef("junk", ZAI)).toBe(true);
    expect(shouldRememberInviteRef(null, null)).toBe(false);
  });

  it("finds one cookie in a document.cookie string", () => {
    expect(cookieValue(`theme=dark; ggd2l_ref=${BORPO}; other=1`, "ggd2l_ref")).toBe(BORPO);
    expect(cookieValue("theme=dark", "ggd2l_ref")).toBeNull();
    expect(cookieValue("", "ggd2l_ref")).toBeNull();
    expect(cookieValue("xggd2l_ref=1", "ggd2l_ref")).toBeNull();
  });

  it("tags the copied link only for a player with an id", () => {
    expect(inviteUrl("https://ggd2l.vercel.app", BORPO)).toBe(
      `https://ggd2l.vercel.app/?ref=${BORPO}`,
    );
    expect(inviteUrl("https://ggd2l.vercel.app", null)).toBe("https://ggd2l.vercel.app");
    expect(inviteUrl("http://localhost:3000")).toBe("http://localhost:3000");
  });
});

describe("inviteCreditApplies", () => {
  const credit = (patch: Partial<Parameters<typeof inviteCreditApplies>[0]> = {}) =>
    inviteCreditApplies({
      ref: BORPO,
      newUserId: ZAI,
      inviterSignedUp: true,
      newUserSignedUpBefore: false,
      ...patch,
    });

  it("credits a signed-up inviter for a brand-new player", () => {
    expect(credit()).toBe(true);
  });

  it("never credits inviting yourself, an inviter who isn't signed up, a returning player or no tag", () => {
    expect(credit({ ref: ZAI })).toBe(false);
    expect(credit({ inviterSignedUp: false })).toBe(false);
    expect(credit({ newUserSignedUpBefore: true })).toBe(false);
    expect(credit({ ref: null })).toBe(false);
  });
});
