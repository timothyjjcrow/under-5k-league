import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { heroSearchDestination } from "@/lib/heroes";
import { GET } from "./route";

afterEach(() => vi.unstubAllEnvs());

describe("/meta/find redirect", () => {
  const juggernaut = heroSearchDestination("jugg");

  it("sends a match to its hero page on the request's origin", () => {
    expect(juggernaut).toMatch(/^\/meta\/[a-z-]+$/);
    const res = GET(new NextRequest("https://league.example/meta/find?q=jugg"));

    expect(res.headers.get("location")).toBe(
      `https://league.example${juggernaut}`,
    );
  });

  it("redirects on the canonical origin when the deployment is declared", () => {
    vi.stubEnv("LEAGUE_DEPLOY_ENV", "production");
    vi.stubEnv("APP_URL", "https://eu.ggd2l.com");

    // Next hands the handler the 127.0.0.1 bind address behind Caddy.
    const hit = GET(new NextRequest("https://127.0.0.1:3011/meta/find?q=jugg"));
    expect(hit.headers.get("location")).toBe(
      `https://eu.ggd2l.com${juggernaut}`,
    );

    const miss = GET(
      new NextRequest("https://127.0.0.1:3011/meta/find?q=zzzz&season=s-1"),
    );
    expect(miss.headers.get("location")).toBe(
      "https://eu.ggd2l.com/meta?season=s-1",
    );
  });
});
