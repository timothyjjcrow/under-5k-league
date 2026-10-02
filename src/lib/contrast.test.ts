import { describe, expect, it } from "vitest";
import { contrastRatio, hexRgb, hslRgb } from "./contrast";

describe("hexRgb", () => {
  it("reads #rrggbb in either case", () => {
    expect(hexRgb("#0b0f17")).toEqual([11, 15, 23]);
    expect(hexRgb("#FFFFFF")).toEqual([255, 255, 255]);
  });

  it("refuses anything else rather than guessing", () => {
    for (const bad of ["#fff", "0b0f17", "#0b0f1", "rgb(0,0,0)", ""]) {
      expect(() => hexRgb(bad), bad).toThrow();
    }
  });
});

describe("hslRgb", () => {
  it("matches CSS for the primaries and greys", () => {
    const round = (rgb: readonly number[]) => rgb.map(Math.round);
    expect(round(hslRgb(0, 100, 50))).toEqual([255, 0, 0]);
    expect(round(hslRgb(120, 100, 50))).toEqual([0, 255, 0]);
    expect(round(hslRgb(240, 100, 50))).toEqual([0, 0, 255]);
    expect(round(hslRgb(60, 100, 50))).toEqual([255, 255, 0]);
    expect(round(hslRgb(200, 0, 50))).toEqual([128, 128, 128]);
    // 360 is the same hue as 0.
    expect(round(hslRgb(360, 62, 46))).toEqual(round(hslRgb(0, 62, 46)));
  });
});

describe("contrastRatio", () => {
  it("gives WCAG's reference values", () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrastRatio([255, 255, 255], [255, 255, 255])).toBe(1);
    // #767676 on white is the classic 4.54:1.
    expect(contrastRatio(hexRgb("#767676"), [255, 255, 255])).toBeCloseTo(
      4.54,
      2,
    );
  });

  it("doesn't care which colour is the text", () => {
    const a = hexRgb("#e8edf5");
    const b = hexRgb("#121a29");
    expect(contrastRatio(a, b)).toBe(contrastRatio(b, a));
  });
});
