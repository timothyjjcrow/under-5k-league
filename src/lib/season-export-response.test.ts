import { describe, expect, it } from "vitest";
import {
  SEASON_EXPORT_MAX_RESPONSE_BYTES,
  serializeSeasonExport,
} from "./season-export-response";

describe("season export response sizing", () => {
  it("uses a conservative ceiling below the host's 4.5 MB payload limit", () => {
    expect(SEASON_EXPORT_MAX_RESPONSE_BYTES).toBe(4_000_000);
    expect(SEASON_EXPORT_MAX_RESPONSE_BYTES).toBeLessThan(4_500_000);
  });

  it("accepts a serialized archive at the exact byte boundary", () => {
    const payload = { season: "Alpha", rows: [1, 2, 3] };
    const expectedBody = JSON.stringify(payload, null, 2);
    const exactBytes = Buffer.byteLength(expectedBody, "utf8");

    expect(serializeSeasonExport(payload, exactBytes)).toEqual({
      ok: true,
      body: expectedBody,
      byteLength: exactBytes,
    });
  });

  it("rejects a serialized archive one byte over the boundary", () => {
    const payload = { season: "Alpha", rows: [1, 2, 3] };
    const expectedBody = JSON.stringify(payload, null, 2);
    const exactBytes = Buffer.byteLength(expectedBody, "utf8");

    expect(serializeSeasonExport(payload, exactBytes - 1)).toEqual({
      ok: false,
      byteLength: exactBytes,
    });
  });

  it("counts multibyte content by UTF-8 bytes rather than JavaScript length", () => {
    const payload = { season: "🔥リーグ" };
    const expectedBody = JSON.stringify(payload, null, 2);
    const utf8Bytes = Buffer.byteLength(expectedBody, "utf8");

    expect(utf8Bytes).toBeGreaterThan(expectedBody.length);
    expect(serializeSeasonExport(payload, expectedBody.length)).toEqual({
      ok: false,
      byteLength: utf8Bytes,
    });
    expect(serializeSeasonExport(payload, utf8Bytes)).toEqual({
      ok: true,
      body: expectedBody,
      byteLength: utf8Bytes,
    });
  });
});
