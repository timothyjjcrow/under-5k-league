import { describe, expect, it } from "vitest";
import { publicPageView } from "./site-analytics";

describe("public traffic reporting", () => {
  it("keeps the public page while removing query values and fragments", () => {
    const event = {
      type: "pageview" as const,
      url: "https://ggd2l.vercel.app/inhouse?join=1&code=private#room",
    };
    expect(publicPageView(event)).toEqual({
      type: "pageview",
      url: "https://ggd2l.vercel.app/inhouse",
    });
    expect(event.url).toContain("code=private");
  });

  it.each(["/admin", "/admin/activity", "/api/auth/steam", "/login", "/logout", "/me", "/me/settings"])(
    "excludes %s from audience figures",
    (path) => {
      expect(publicPageView({ type: "pageview", url: `https://ggd2l.vercel.app${path}` })).toBeNull();
    },
  );

  it.each(["/", "/inhouse/history", "/players/player-123", "/meta", "/news"])(
    "retains public traffic to %s",
    (path) => {
      const event = { type: "pageview" as const, url: `https://ggd2l.vercel.app${path}` };
      expect(publicPageView(event)).toEqual(event);
    },
  );

  it("does not send custom events", () => {
    expect(publicPageView({ type: "event", url: "https://ggd2l.vercel.app/" })).toBeNull();
  });
});
