import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { heroById } from "@/lib/heroes";
import { HeroIcon, HeroIconFallback, heroInitials } from "./hero-icon";

const antiMage = heroById(1)!;

describe("hero icon", () => {
  it("server-renders the same plain <img> it always did", () => {
    expect(renderToStaticMarkup(createElement(HeroIcon, { hero: antiMage }))).toBe(
      '<img src="https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react/heroes/icons/antimage.png" alt="Anti-Mage" title="Anti-Mage" width="26" height="26" loading="lazy" style="width:26px;height:26px" class="shrink-0 rounded-md border border-line/70 bg-surface-2 object-cover"/>',
    );
  });

  it("falls back to a same-size tile of initials named for the hero", () => {
    const html = renderToStaticMarkup(
      createElement(HeroIconFallback, {
        hero: antiMage,
        size: 20,
        className: "rounded",
        title: "Anti-Mage · 3 games",
      }),
    );
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Anti-Mage"');
    expect(html).toContain('title="Anti-Mage · 3 games"');
    expect(html).toContain("width:20px;height:20px;font-size:10px");
    // The caller's className still wins, as it does on the <img>.
    expect(html).toMatch(/class="[^"]*\brounded\b[^"]*"/);
    expect(html).not.toMatch(/class="[^"]*\brounded-md\b/);
    expect(html).toContain('<span aria-hidden="true">AM</span>');
  });

  it("takes up to two initials from the hero's name", () => {
    expect(heroInitials("Anti-Mage")).toBe("AM");
    expect(heroInitials("Axe")).toBe("A");
    expect(heroInitials("Keeper of the Light")).toBe("KO");
    expect(heroInitials("Nature's Prophet")).toBe("NP");
  });
});
