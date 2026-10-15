import { describe, expect, it } from "vitest";
import { leagueDeployEnv } from "./deploy-env";

describe("leagueDeployEnv", () => {
  it("is undeclared when the key is absent, as on Vercel, dev and tests", () => {
    expect(leagueDeployEnv({})).toBeNull();
    expect(leagueDeployEnv({ VERCEL_ENV: "production" })).toBeNull();
  });

  it("accepts exactly the two declared values", () => {
    expect(leagueDeployEnv({ LEAGUE_DEPLOY_ENV: "production" })).toBe("production");
    expect(leagueDeployEnv({ LEAGUE_DEPLOY_ENV: "staging" })).toBe("staging");
  });

  it("marks any other declared value invalid so callers fail closed", () => {
    for (const value of ["", "prod", "Production", "STAGING", " production", "preview"]) {
      expect(leagueDeployEnv({ LEAGUE_DEPLOY_ENV: value })).toBe("invalid");
    }
  });
});
