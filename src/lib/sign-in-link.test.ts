import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  STEAM_SIGN_IN_NOTICE,
  devLoginEnabled,
  steamSignInHref,
} from "./sign-in-link";

describe("steamSignInHref", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("goes straight to Steam when Steam is the only way to sign in", () => {
    expect(steamSignInHref("/me", false)).toBe("/api/auth/steam?next=/me");
    expect(steamSignInHref("/me?tab=signup", false)).toBe(
      "/api/auth/steam?next=/me%3Ftab%3Dsignup",
    );
  });

  it("goes to /login, where both ways live, when dev login is on", () => {
    expect(steamSignInHref("/me", true)).toBe("/login?next=/me");
  });

  it("drops a return path that isn't a same-site path", () => {
    for (const next of ["//evil.test", "https://evil.test", "/\\evil", "", "/"]) {
      expect(steamSignInHref(next, false)).toBe("/api/auth/steam");
    }
  });

  it("reads dev login from ALLOW_DEV_LOGIN, like /login and /api/auth/dev", () => {
    vi.stubEnv("ALLOW_DEV_LOGIN", "true");
    expect(devLoginEnabled()).toBe(true);
    expect(steamSignInHref("/me")).toBe("/login?next=/me");
    vi.stubEnv("ALLOW_DEV_LOGIN", "false");
    expect(devLoginEnabled()).toBe(false);
    expect(steamSignInHref("/me")).toBe("/api/auth/steam?next=/me");
    vi.stubEnv("ALLOW_DEV_LOGIN", "");
    expect(steamSignInHref("/me")).toBe("/api/auth/steam?next=/me");
  });
});

describe("STEAM_SIGN_IN_NOTICE", () => {
  it("says what becomes public and that the password stays with Steam", () => {
    for (const fact of ["Steam name", "avatar", "medal", "public matches", "OpenDota", "password"]) {
      expect(STEAM_SIGN_IN_NOTICE).toContain(fact);
    }
  });
});

describe("Steam sign-in links in the source", () => {
  const root = join(process.cwd(), "src");
  const files = (readdirSync(root, { recursive: true }) as string[])
    .filter((file) => file.endsWith(".tsx"))
    .map((file) => ({ file, text: readFileSync(join(root, file), "utf8") }));

  it("builds the Steam href only in the Steam button component", () => {
    const callers = files
      .filter(({ text }) => text.includes("steamSignInHref("))
      .map(({ file }) => file);
    expect(callers).toEqual([join("components", "steam-sign-in.tsx")]);
  });

  it("never points a prefetching next/link at a sign-in route", () => {
    for (const { file, text } of files) {
      expect(text, file).not.toMatch(/<Link\b[^>]*href=\{?[`"'][^`"']*\/api\/auth\//);
    }
  });
});
