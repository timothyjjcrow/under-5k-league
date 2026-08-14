import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { shouldRenderTeamLogo } from "./team-logo-image";
import { TeamCrest } from "./ui";

describe("TeamCrest", () => {
  it("renders a configured logo as a decorative, privacy-safe image", () => {
    const html = renderToStaticMarkup(
      createElement(TeamCrest, {
        name: "Ancient Defenders",
        seed: "team-1",
        logoUrl: " https://cdn.example.com/logo.png ",
        size: 48,
      }),
    );

    expect(html).toContain("<img");
    expect(html).toContain('src="https://cdn.example.com/logo.png"');
    expect(html).toContain('alt=""');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toMatch(/referrer[Pp]olicy="no-referrer"/);
    expect(html).toContain('width="48"');
    expect(html).toContain('height="48"');
    expect(html).toContain('style="width:48px;height:48px');
    expect(html).toContain('style="width:100%;height:100%"');
    expect(html).toContain("object-contain");
    // The monogram stays mounted underneath so an errored image can reveal it.
    expect(html).toContain("AD");
  });

  it("can crop a configured logo to fill its crest", () => {
    const html = renderToStaticMarkup(
      createElement(TeamCrest, {
        name: "Ancient Defenders",
        seed: "team-1",
        logoUrl: "https://cdn.example.com/wide-logo.png",
        size: 64,
        imageFit: "cover",
      }),
    );

    expect(html).toContain("object-cover");
    expect(html).not.toContain("object-contain");
  });

  it("keeps the generated monogram when no usable logo URL exists", () => {
    const html = renderToStaticMarkup(
      createElement(TeamCrest, {
        name: "Ancient Defenders",
        seed: "team-1",
        logoUrl: "   ",
      }),
    );

    expect(html).not.toContain("<img");
    expect(html).toContain("AD");
  });

  it("hides only the image URL that failed so the monogram can show", () => {
    expect(shouldRenderTeamLogo("https://cdn.example/logo.png", null)).toBe(
      true,
    );
    expect(
      shouldRenderTeamLogo(
        "https://cdn.example/logo.png",
        "https://cdn.example/logo.png",
      ),
    ).toBe(false);
    expect(
      shouldRenderTeamLogo(
        "https://cdn.example/new-logo.png",
        "https://cdn.example/logo.png",
      ),
    ).toBe(true);

    // Node component tests have no DOM image loader, so pin the event wiring
    // that connects a browser load failure to the tested visibility rule.
    const source = readFileSync(
      join(__dirname, "team-logo-image.tsx"),
      "utf8",
    );
    expect(source).toContain("onError={() => setFailedSrc(src)}");
    expect(source).toContain(
      "if (!shouldRenderTeamLogo(src, failedSrc)) return null",
    );

    const crestSource = readFileSync(join(__dirname, "ui.tsx"), "utf8");
    expect(crestSource).toContain(
      "<TeamLogoImage key={src} src={src} size={size} fit={imageFit} />",
    );
  });

  it("uses larger, crop-filled crests for the primary team views", () => {
    const crestWithName = (source: string, nameProp: string) =>
      (source.match(/<TeamCrest[\s\S]*?\/>/g) ?? []).find((crest) =>
        crest.includes(nameProp),
      );

    const teamsPage = readFileSync(
      join(__dirname, "../app/teams/page.tsx"),
      "utf8",
    );
    const cardCrest = crestWithName(teamsPage, "name={t.name}");
    expect(cardCrest).toContain("size={64}");
    expect(cardCrest).toContain('imageFit="cover"');
    expect(teamsPage).toContain("md:grid-cols-2");

    const teamPage = readFileSync(
      join(__dirname, "../app/teams/[id]/page.tsx"),
      "utf8",
    );
    const heroCrest = crestWithName(teamPage, "name={team.name}");
    expect(heroCrest).toContain("size={112}");
    expect(heroCrest).toContain('imageFit="cover"');
  });
});
