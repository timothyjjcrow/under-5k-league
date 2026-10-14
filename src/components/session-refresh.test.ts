import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  sourceFile,
  stripLineComments,
} from "../../test/support/source-files";

// SOURCE GUARDS (vitest runs without jsdom). The weekly session re-issue is
// one POST from a page whose server render found the cookie due; the Next
// proxy it replaced was a separate Vercel function that ran, and often cold
// started, on every signed-in page load (the Hobby plan's CPU budget).
describe("session refresh wiring (source)", () => {
  const layout = stripLineComments(sourceFile("src/app/layout.tsx").text);
  const component = stripLineComments(
    sourceFile("src/components/session-refresh.tsx").text,
  );

  it("mounts the refresh only for a signed-in session the server found due", () => {
    expect(layout).toMatch(/user \? getSessionRefreshDue\(\) : false,/);
    expect(layout).toMatch(/\{sessionRefreshDue \? <SessionRefresh \/> : null\}/);
    expect(layout.match(/<SessionRefresh/g)).toHaveLength(1);
  });

  it("asks once, by POST, with a timeout, and ignores the answer", () => {
    expect(component).toMatch(/fetch\("\/api\/auth\/refresh", \{\s*method: "POST",\s*signal: AbortSignal\.timeout\(REFRESH_TIMEOUT_MS\),\s*\}\)\.catch\(\(\) => \{\}\);/);
    expect(component).toMatch(/useEffect\(\(\) => \{[^]*\}, \[\]\);/);
    expect(component.match(/fetch\(/g)).toHaveLength(1);
  });

  it("leaves the app with no Next proxy or middleware", () => {
    for (const file of ["src/proxy.ts", "src/middleware.ts", "proxy.ts", "middleware.ts"]) {
      expect(existsSync(join(process.cwd(), file)), file).toBe(false);
    }
  });
});
