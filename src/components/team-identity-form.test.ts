import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TeamIdentityForm } from "./team-identity-form";
import type { ActionResult } from "@/lib/action-result";

const action = async (): Promise<ActionResult> => ({});

function render(props: Partial<Parameters<typeof TeamIdentityForm>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(TeamIdentityForm, {
      action,
      teamId: "team-1",
      name: "Radiant Raccoons",
      logoUrl: null,
      ...props,
    }),
  );
}

describe("TeamIdentityForm", () => {
  it("keeps the field names the admin spec and screen readers use", () => {
    const html = render({ hidden: { expectedActiveSeasonId: "season-1" } });
    expect(html).toContain('aria-label="Name for Radiant Raccoons"');
    expect(html).toContain('aria-label="Logo URL for Radiant Raccoons"');
    expect(html).toContain('name="teamId" value="team-1"');
    expect(html).toContain('name="expectedActiveSeasonId" value="season-1"');
    expect(html).toMatch(/<button[^>]*>Save team<\/button>/);
  });

  it("previews the initials crest when there is no logo", () => {
    const html = render();
    // The live preview is the same crest the site draws: initials underneath.
    expect(html).toContain(">RR<");
    expect(html).toContain("No logo, so the crest shows the team&#x27;s initials.");
  });

  it("previews a saved logo and describes the field with the preview line", () => {
    const html = render({ logoUrl: "https://cdn.example/raccoon.png" });
    expect(html).toContain('src="https://cdn.example/raccoon.png"');
    expect(html).toContain('aria-describedby="team-logo-note-team-1"');
    expect(html).toContain('id="team-logo-note-team-1"');
    expect(html).toContain("Loading the logo");
  });

  it("flags a stored Discord attachment logo before anyone presses Save", () => {
    const html = render({
      logoUrl: "https://cdn.discordapp.com/attachments/1/2/logo.png?ex=1",
    });
    expect(html).toContain("Discord image links stop working after about a day");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save team<\/button>/);
  });

  it("shows an optional note under the fields", () => {
    expect(render({ note: "Jerseys stay linked." })).toContain("Jerseys stay linked.");
  });
});
