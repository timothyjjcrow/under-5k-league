import { describe, expect, it } from "vitest";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SavedSignupForm } from "./saved-signup-form";

type Props = Omit<ComponentProps<typeof SavedSignupForm>, "children">;

const render = (props: Props) =>
  renderToStaticMarkup(
    createElement(
      SavedSignupForm,
      props as ComponentProps<typeof SavedSignupForm>,
      createElement("form"),
    ),
  );

describe("SavedSignupForm", () => {
  it("shows what was submitted on the collapsed row", () => {
    const html = render({
      saved: true,
      summary: "Full player · 3200 MMR · Mid, Offlane · 3 heroes",
    });
    expect(html).toContain("Edit signup");
    expect(html).toContain("Full player · 3200 MMR · Mid, Offlane · 3 heroes");
    // Saved answers start collapsed.
    expect(html).not.toMatch(/<details[^>]*\sopen/);
  });

  it("keeps the row plain without a summary, and hidden for a new signup", () => {
    expect(render({ saved: true })).not.toContain("text-xs font-normal");
    const fresh = render({ saved: false, summary: "Full player" });
    expect(fresh).toMatch(/<summary class="hidden"/);
    expect(fresh).toMatch(/<details[^>]*\sopen/);
  });
});
