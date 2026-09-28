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
  });
});
