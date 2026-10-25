import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MmrField } from "./mmr-field";

describe("MmrField", () => {
  it("renders the form's mmr box with the number it will be listed at", () => {
    const html = renderToStaticMarkup(
      createElement(MmrField, {
        defaultValue: "",
        rankTier: 53,
        storedMmr: null,
        frozen: false,
        describedBy: "mmr-lead",
      }),
    );
    expect(html).toMatch(/<input[^>]*id="mmr"[^>]*name="mmr"/);
    expect(html).toContain('aria-describedby="mmr-lead mmr-preview"');
    expect(html).toContain(
      "Left blank, you&#x27;ll be listed at 2965 MMR, your medal&#x27;s low end.",
    );
  });

  it("starts from a saved number and keeps it during the auction", () => {
    const html = renderToStaticMarkup(
      createElement(MmrField, {
        defaultValue: "4400",
        rankTier: 53,
        storedMmr: 4400,
        frozen: true,
      }),
    );
    expect(html).toContain('value="4400"');
    expect(html).toContain("you stay listed at 4400 MMR until it ends");
    expect(html).not.toMatch(/<input[^>]*\sdisabled=""/);
  });

  it("renders the saved number disabled after the draft, with who can change it", () => {
    const html = renderToStaticMarkup(
      createElement(MmrField, {
        defaultValue: "4200",
        rankTier: 53,
        storedMmr: 4200,
        frozen: false,
        locked: true,
      }),
    );
    expect(html).toMatch(/<input[^>]*\sdisabled=""[^>]*name="mmr"/);
    expect(html).toContain('value="4200"');
    expect(html).toContain(
      "Locked after the draft — ask a league admin to change it.",
    );
    // The typing preview is replaced, not shown beside the hint.
    expect(html).not.toContain("listed at");
    expect(html).toContain('aria-describedby="mmr-preview"');
  });

  it("stays editable without the lock, as every existing caller renders it", () => {
    const html = renderToStaticMarkup(
      createElement(MmrField, {
        defaultValue: "3000",
        rankTier: null,
        storedMmr: 3000,
        frozen: false,
      }),
    );
    expect(html).not.toMatch(/<input[^>]*\sdisabled=""/);
    expect(html).not.toContain("Locked after the draft");
  });
});
