import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sourceFile } from "../../test/support/source-files";

/**
 * RankMedal draws a medal at 24px from the 72px copies in public/ranks/72
 * (a tenth of the 256px masters' bytes), so every medallion and star ring
 * it can ask for must exist there, at 72px: a missing file fails quietly as
 * a blank medal.
 */
const DIR = path.join(process.cwd(), "public", "ranks", "72");

function pngSize(file: string): { width: number; height: number } {
  const bytes = readFileSync(file);
  // The IHDR chunk follows the 8-byte signature: width and height are the
  // first two big-endian 32-bit fields of its data.
  expect([...bytes.subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("small medal pictures", () => {
  it("has a 72px medallion for every medal and a 72px ring for every star count", () => {
    const files = [
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `rank_icon_${n}.png`),
      ...[1, 2, 3, 4, 5].map((n) => `rank_star_${n}.png`),
    ];
    for (const name of files) {
      expect(pngSize(path.join(DIR, name)), name).toEqual({ width: 72, height: 72 });
    }
  });

  it("are what RankMedal draws at its default size", () => {
    const ui = sourceFile("src/components/ui.tsx").text;
    const medal = ui.slice(ui.indexOf("export function RankMedal"));
    expect(medal).toContain('const dir = size <= 24 ? "/ranks/72" : "/ranks";');
    expect(medal).toContain("src={`${dir}/rank_icon_${tier}.png`}");
    expect(medal).toContain("src={`${dir}/rank_star_${stars}.png`}");
  });
});
