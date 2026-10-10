import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SIGN_IN_REQUIRED, signInHref } from "./sign-in";
import { SignInRequired } from "@/components/sign-in-required";

describe("signInHref", () => {
  it("returns to the page after sign-in", () => {
    expect(signInHref("/matches/abc123")).toBe("/login?next=%2Fmatches%2Fabc123");
    expect(signInHref("/me")).toBe("/login?next=%2Fme");
  });

  it("drops anything that isn't a safe local path", () => {
    expect(signInHref(null)).toBe("/login");
    expect(signInHref("")).toBe("/login");
    expect(signInHref("//evil.test/x")).toBe("/login");
    expect(signInHref("https://evil.test")).toBe("/login");
  });
});

describe("the signed-out form error", () => {
  it("renders a sign-in link instead of a bare 'Sign in required'", () => {
    const html = renderToStaticMarkup(createElement(SignInRequired));
    expect(html).toContain("You need to be signed in for that.");
    expect(html).toMatch(/<a [^>]*href="\/login[^"]*"[^>]*>Sign in<\/a>/);
    expect(html).toContain("you&#x27;ll come back to this page.");
  });

  it("is what ActionForm shows for the signed-out error", () => {
    const form = readFileSync(
      join(__dirname, "../components/action-form.tsx"),
      "utf8",
    );
    expect(form).toContain("shownError === SIGN_IN_REQUIRED ? (");
    expect(form).toContain("<SignInRequired />");
  });

  it("matches the exact words every server action answers with", () => {
    // ActionForm compares strings, so a reworded copy in one action would
    // silently lose its link. Every sign-in refusal must be the constant.
    const dir = join(__dirname, "../app/actions");
    const found: string[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".ts") || file.includes(".test.")) continue;
      const source = readFileSync(join(dir, file), "utf8");
      for (const m of source.matchAll(/"((?:please )?sign(?:ed)? in[^"]*)"/gi)) {
        if (/required|first|to continue|signed in/i.test(m[1])) found.push(`${file}: ${m[1]}`);
      }
    }
    expect(found.length).toBeGreaterThan(0);
    for (const hit of found) {
      expect(hit.split(": ")[1], hit).toBe(SIGN_IN_REQUIRED);
    }
  });
});

describe("signed-out visitors on a match that's open for check-in", () => {
  it("are told they can sign in to check in, and come back to the match", () => {
    const page = readFileSync(
      join(__dirname, "../app/matches/[id]/match-preview.tsx"),
      "utf8",
    ).replace(/\s+/g, " ");
    // Same gate as the player's own banner, minus the roster check that
    // needs a viewer.
    expect(page).toContain("!!viewer && checkinOpen && activeNightRoster.has(viewer.id)");
    expect(page).toContain(") : !viewer && checkinOpen ? (");
    expect(page).toContain("Playing in this match?");
    expect(page).toContain("href={signInHref(`/matches/${match.id}`)}");
    expect(page).toContain("Sign in to check in");
  });
});
