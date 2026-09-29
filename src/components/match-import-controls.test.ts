import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(join(__dirname, "match-import-controls.tsx"), "utf8");

describe("MatchImportControls source contract", () => {
  it("uses one guarded ActionForm for both import operations", () => {
    expect(SRC.match(/<ActionForm\b/g)).toHaveLength(1);
    expect(SRC).not.toMatch(/<form\b/);
    expect(SRC).not.toContain("useActionState");
    expect(SRC).toContain('name="intent"');
    expect(SRC).toContain('value="detect"');
    expect(SRC).toContain('value="import"');
    expect(SRC).toContain('if (intent === "detect") return detectAction');
    expect(SRC).toContain('if (intent === "import") return importAction');
  });

  it("requires a match reference only when Add game is submitted", () => {
    const detectButton = SRC.slice(
      SRC.indexOf('<SubmitButton\n        name="intent"'),
      SRC.indexOf("</SubmitButton>"),
    );
    const importButtonAt = SRC.lastIndexOf(
      '<SubmitButton\n            name="intent"',
    );
    const importButton = SRC.slice(
      importButtonAt,
      SRC.indexOf("</SubmitButton>", importButtonAt),
    );

    expect(SRC).toMatch(/name="dotaMatchRef"\s+required/);
    expect(detectButton).toContain("formNoValidate");
    expect(importButton).not.toContain("formNoValidate");
  });

  it("labels the match reference and associates its help text", () => {
    expect(SRC).toMatch(/<label\s+htmlFor=\{inputId\}/);
    expect(SRC).toContain("id={inputId}");
    expect(SRC).toContain("aria-describedby={helpId}");
    expect(SRC).toContain("<p id={helpId}");
  });

  it("never squeezes the field on narrow screens", () => {
    // One wrapping row: the field keeps a 10rem floor, so on a screen too
    // narrow for it and Add game side by side the button wraps under it
    // instead of crushing it. The label takes its own line below sm.
    expect(SRC).toContain("flex min-w-0 flex-wrap items-center");
    expect(SRC).toContain("min-w-0 flex-1 basis-40");
    expect(SRC).toContain("basis-full text-xs font-medium text-muted sm:shrink-0 sm:basis-auto");
    expect(SRC).toMatch(/value="import"[\s\S]*?className="shrink-0"/);
  });
});
