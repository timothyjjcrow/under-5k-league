import { describe, expect, it } from "vitest";
import {
  CHIP_BAR_FADE_PX,
  aboveAllSections,
  chipBarEdges,
  chipBarMask,
  revealChipScrollLeft,
} from "./chip-bar";

describe("chipBarEdges", () => {
  it("reports no hidden chips when everything fits", () => {
    expect(
      chipBarEdges({ scrollLeft: 0, clientWidth: 600, scrollWidth: 600 }),
    ).toEqual({ start: false, end: false });
  });

  it("reports chips past the right edge at the start of a wide bar", () => {
    // The measured team page at 390px: 610px of chips in a 340px bar.
    expect(
      chipBarEdges({ scrollLeft: 0, clientWidth: 340, scrollWidth: 610 }),
    ).toEqual({ start: false, end: true });
  });

  it("reports both sides in the middle and only the start at the end", () => {
    expect(
      chipBarEdges({ scrollLeft: 100, clientWidth: 340, scrollWidth: 610 }),
    ).toEqual({ start: true, end: true });
    expect(
      chipBarEdges({ scrollLeft: 270, clientWidth: 340, scrollWidth: 610 }),
    ).toEqual({ start: true, end: false });
  });

  it("treats a fractional pixel short of either end as the end", () => {
    expect(
      chipBarEdges({ scrollLeft: 269.5, clientWidth: 340, scrollWidth: 610 }),
    ).toEqual({ start: true, end: false });
    expect(
      chipBarEdges({ scrollLeft: 0.5, clientWidth: 340, scrollWidth: 610 }),
    ).toEqual({ start: false, end: true });
  });
});

describe("chipBarMask", () => {
  it("fades only the sides that have more chips", () => {
    expect(chipBarMask({ start: false, end: false })).toBeUndefined();
    const end = chipBarMask({ start: false, end: true })!;
    expect(end).toContain(`calc(100% - ${CHIP_BAR_FADE_PX}px), transparent)`);
    expect(end.startsWith("linear-gradient(to right, black")).toBe(true);
    const start = chipBarMask({ start: true, end: false })!;
    expect(start).toBe(
      `linear-gradient(to right, transparent, black ${CHIP_BAR_FADE_PX}px)`,
    );
    const both = chipBarMask({ start: true, end: true })!;
    expect(both.startsWith("linear-gradient(to right, transparent,")).toBe(
      true,
    );
    expect(both.endsWith("transparent)")).toBe(true);
  });

  it("is wide enough to dim a chip's text, not just its padding", () => {
    // Chips carry 12px of side padding; the old 16px fade hid little else.
    expect(CHIP_BAR_FADE_PX).toBeGreaterThanOrEqual(32);
  });
});

describe("revealChipScrollLeft", () => {
  const bar = { left: 25, right: 365 };

  it("leaves a chip that is already clear of the fades", () => {
    expect(
      revealChipScrollLeft({
        bar,
        chip: { left: 100, right: 180 },
        scrollLeft: 0,
      }),
    ).toBeNull();
  });

  it("scrolls right to bring a chip past the right edge into view", () => {
    // "Playoff outlook" sits at 520-640 in page terms with the bar unscrolled.
    const next = revealChipScrollLeft({
      bar,
      chip: { left: 520, right: 640 },
      scrollLeft: 0,
    });
    expect(next).toBe(640 - (365 - CHIP_BAR_FADE_PX));
    // After that scroll the chip ends exactly at the inner edge of the fade.
    expect(640 - next!).toBe(bar.right - CHIP_BAR_FADE_PX);
  });

  it("scrolls left to bring a chip back from behind the left edge", () => {
    expect(
      revealChipScrollLeft({
        bar,
        chip: { left: -60, right: 20 },
        scrollLeft: 200,
      }),
    ).toBe(200 - (25 + CHIP_BAR_FADE_PX + 60));
  });

  it("never asks for a negative scroll position", () => {
    expect(
      revealChipScrollLeft({
        bar,
        chip: { left: 10, right: 90 },
        scrollLeft: 20,
      }),
    ).toBe(0);
    // Already at the start: nothing to do.
    expect(
      revealChipScrollLeft({
        bar,
        chip: { left: 33, right: 110 },
        scrollLeft: 0,
      }),
    ).toBeNull();
  });

  it("aligns the start of a chip wider than the space between the fades", () => {
    expect(
      revealChipScrollLeft({
        bar: { left: 0, right: 200 },
        chip: { left: 300, right: 460 },
        scrollLeft: 50,
      }),
    ).toBe(50 + 300 - CHIP_BAR_FADE_PX);
  });
});

describe("aboveAllSections", () => {
  it("clears the highlight back at the top, where the first section starts below the band", () => {
    // 844px phone: the band ends at 380px; the first section starts at 620px.
    expect(
      aboveAllSections({ anyInBand: false, sectionTops: [620, 1400, 2300], viewportHeight: 844 }),
    ).toBe(true);
  });

  it("keeps it while any section crosses the band", () => {
    expect(
      aboveAllSections({ anyInBand: true, sectionTops: [620, 1400], viewportHeight: 844 }),
    ).toBe(false);
  });

  it("keeps the last section lit below the final one, and with no sections at all", () => {
    // Scrolled past every section (a footer in the band): the first top is
    // far above the viewport, so this is not "above every section".
    expect(
      aboveAllSections({ anyInBand: false, sectionTops: [-3000, -1200], viewportHeight: 844 }),
    ).toBe(false);
    expect(aboveAllSections({ anyInBand: false, sectionTops: [], viewportHeight: 844 })).toBe(false);
  });
});
