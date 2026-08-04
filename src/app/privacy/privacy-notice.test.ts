import { readFileSync } from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import PrivacyPage from "./page";
import TermsPage from "../terms/page";

afterEach(() => vi.unstubAllEnvs());

describe("public privacy and terms notices", () => {
  it("renders the configured request route and storage locations", () => {
    vi.stubEnv("PRIVACY_CONTACT_EMAIL", "privacy@ggd2l.org");
    vi.stubEnv("PRIVACY_DATA_LOCATIONS", "United States, Germany");

    const html = renderToStaticMarkup(React.createElement(PrivacyPage));
    expect(html).toContain("Privacy &amp; data use");
    expect(html).toContain('href="mailto:privacy@ggd2l.org"');
    expect(html).toContain("United States, Germany");
    expect(html).toContain("This first release does not offer");
    expect(html).toContain("does not remove you from the Discord server");
    expect(html).toContain("public signup field");
  });

  it("fails visibly rather than inventing contact or geography in development", () => {
    vi.stubEnv("PRIVACY_CONTACT_EMAIL", "");
    vi.stubEnv("PRIVACY_DATA_LOCATIONS", "");

    const html = renderToStaticMarkup(React.createElement(PrivacyPage));
    expect(html).toContain("Privacy contact is not configured");
    expect(html).toContain("Data storage locations are not configured");
    expect(html).not.toContain("mailto:");
  });

  it("publishes the external-service and play-money terms", () => {
    vi.stubEnv("PRIVACY_CONTACT_EMAIL", "privacy@ggd2l.org");
    const html = renderToStaticMarkup(React.createElement(TermsPage));
    expect(html).toContain("League terms");
    expect(html).toContain("not affiliated");
    expect(html).toContain("with all faults");
    expect(html).toContain("no cash value");
    expect(html).toContain('href="/privacy"');
  });
});

describe("privacy disclosure wiring", () => {
  const source = (relative: string) =>
    readFileSync(path.resolve(process.cwd(), relative), "utf8");
  const me = source("src/app/me/page.tsx");
  const steam = source("src/components/ui.tsx");
  const discord = source("src/components/discord-setup.tsx");
  const footer = source("src/components/site-footer.tsx");
  const profile = source("src/app/players/[id]/page.tsx");

  it("links collection surfaces and the global footer to the notices", () => {
    expect(steam).toContain('href="/privacy"');
    expect(me).toContain('href="/privacy"');
    expect(me).toContain('href="/terms"');
    expect(footer).toContain('{ href: "/privacy"');
    expect(footer).toContain('{ href: "/terms"');
  });

  it("pins every public signup category and rejects the old misleading copy", () => {
    for (const field of [
      "participation type",
      "MMR",
      "preferred roles",
      "favorite heroes",
      "captain",
      "goals",
      "captain note",
    ]) {
      expect(me).toContain(field);
    }
    expect(`${steam}\n${me}\n${discord}`).not.toContain(
      "Only to get your name and profile",
    );
    expect(`${me}\n${discord}`).not.toContain("only ever read your username");
    expect(me).not.toContain("captains see these");
    expect(me).not.toContain(
      'placeholder="Why you\'re here, your goals, availability',
    );
    expect(profile).not.toContain(
      "Signup details, availability, and recent activity",
    );
  });
});
