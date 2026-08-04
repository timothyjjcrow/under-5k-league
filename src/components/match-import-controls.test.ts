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

  it("stacks the field and actions on narrow screens", () => {
    expect(SRC).toContain("flex min-w-0 flex-col");
    expect(SRC).toContain("sm:flex-row");
    expect(SRC).toContain("w-full min-w-0");
    expect(SRC).toContain("w-full shrink-0 sm:w-auto");
  });
});
