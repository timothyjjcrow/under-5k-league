import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { shouldRenderTeamLogo, teamLogoBackingShown } from "./team-logo-image";
import { TeamCrest } from "./ui";
import { hashHue } from "@/lib/team-hues";

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

  it("wears its season hue, with the hash hue as the fallback", () => {
    const html = renderToStaticMarkup(
      createElement(TeamCrest, { name: "Radiant Rush", seed: "cmteam1" }),
    );

    // The root layout's stylesheet sets --team-hue on this attribute.
    expect(html).toContain('data-team-hue="cmteam1"');
    expect(html).toContain(
      `hsl(var(--team-hue, ${hashHue("cmteam1")}) 62% 46%)`,
    );
  });

  it("skips small words so a season's crests don't share letters", () => {
    const monogram = (name: string) =>
      renderToStaticMarkup(
        createElement(TeamCrest, { name, seed: "t" }),
      ).replace(/<[^>]+>/g, "");

    expect(monogram("Sisters of the Veil")).toBe("SV");
    expect(monogram("The Radiant Rush")).toBe("RR");
    expect(monogram("Tim's Team")).toBe("TI");
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

  it("shows the monogram until the logo has loaded", () => {
    // The logo's dark backing used to paint from the first frame, so a lazy
    // logo read as an empty box in the bracket and results until it arrived.
    const html = renderToStaticMarkup(
      createElement(TeamCrest, {
        name: "Vegan Squadron",
        seed: "team-vs",
        logoUrl: "https://i.imgur.com/logo.png",
      }),
    );
    expect(html).toContain("<img");
    expect(html).not.toContain("bg-surface-2");
    expect(html).toContain("VS");

    const src = "https://i.imgur.com/logo.png";
    expect(teamLogoBackingShown(src, null)).toBe(false);
    expect(teamLogoBackingShown(src, src)).toBe(true);
    // A new URL starts over: its own load decides.
    expect(teamLogoBackingShown("https://i.imgur.com/new.png", src)).toBe(false);

    // No DOM image loader here: pin the wiring from the browser's load events
    // (and a logo that settled before hydration) to the tested rule.
    const source = readFileSync(
      join(__dirname, "team-logo-image.tsx"),
      "utf8",
    );
    expect(source).toContain("onLoad={() => setLoadedSrc(src)}");
    expect(source).toContain("ref={readSettled}");
    expect(source).toContain(
      'teamLogoBackingShown(src, loadedSrc) ? "bg-surface-2" : ""',
    );
    expect(source).toMatch(
      /if \(img\.naturalWidth > 0\) setLoadedSrc\(src\);\s*else setFailedSrc\(src\);/,
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
    // The index cards went three across on a desktop with a 56px crest.
    const cardCrest = crestWithName(teamsPage, "name={t.name}");
    expect(cardCrest).toContain("size={56}");
    expect(cardCrest).toContain('imageFit="cover"');
    expect(teamsPage).toContain("md:grid-cols-2");

    const teamPage = readFileSync(
      join(__dirname, "../app/teams/[id]/page.tsx"),
      "utf8",
    );
    // Phones get a 64px crest so the names beside it have room; tablets and
    // up get a 96px one. Both fill with the logo.
    const heroCrests = (teamPage.match(/<TeamCrest[\s\S]*?\/>/g) ?? []).filter(
      (crest) => crest.includes("name={team.name}"),
    );
    expect(heroCrests).toHaveLength(2);
    const [phoneCrest, heroCrest] = heroCrests;
    expect(phoneCrest).toContain("size={64}");
    expect(phoneCrest).toContain("sm:hidden");
    expect(heroCrest).toContain("size={96}");
    expect(heroCrest).toMatch(/className="hidden [^"]*sm:grid/);
    for (const crest of heroCrests) expect(crest).toContain('imageFit="cover"');
  });

  it("gets its season hues from a stylesheet every page carries", () => {
    // Without it every crest silently falls back to its hash hue, and the
    // look-alike greens come back with nothing failing.
    const layout = readFileSync(join(__dirname, "../app/layout.tsx"), "utf8");
    expect(layout).toContain("getTeamHueStyleSheet().catch(");
    expect(layout).toContain(
      "<style dangerouslySetInnerHTML={{ __html: teamHueCss }} />",
    );

    // A team-tinted glow must name its team, or it can't pick the hue up.
    const glowPages = [
      "../app/teams/[id]/page.tsx",
      "../app/matches/[id]/scoreboard.tsx",
    ];
    for (const page of glowPages) {
      const source = readFileSync(join(__dirname, page), "utf8");
      const glows =
        source.match(/<div[^>]*?animate-hero-glow[\s\S]*?\/>/g) ?? [];
      const tinted = glows.filter((glow) => glow.includes("hsl(${"));
      expect(tinted.length).toBeGreaterThan(0);
      for (const glow of tinted) expect(glow).toContain("data-team-hue={");
    }
  });
});
