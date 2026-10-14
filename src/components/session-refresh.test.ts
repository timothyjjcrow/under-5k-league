import { describe, expect, it } from "vitest";
import {
  sourceFile,
  sourceFiles,
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

  it("asks once, by POST, under a timeout, and ignores the answer", () => {
    expect(component).toMatch(
      /fetch\("\/api\/auth\/refresh", \{ method: "POST", signal: controller\.signal \}\)\s*\.catch\(\(\) => \{\}\)/,
    );
    expect(component).toMatch(
      /const timer = setTimeout\(\(\) => controller\.abort\(\), REFRESH_TIMEOUT_MS\);/,
    );
    expect(component).toMatch(/useEffect\(\(\) => \{[^]*\}, \[\]\);/);
    expect(component.match(/fetch\(/g)).toHaveLength(1);
  });

  // Log out is a form post: a refresh answered after it must not set the
  // cookie the logout just cleared, so a submit aborts the call first.
  it("aborts the call when any form is submitted, before the post leaves", () => {
    expect(component).toMatch(/const stop = \(\) => controller\.abort\(\);/);
    expect(component).toMatch(/document\.addEventListener\("submit", stop, true\);/);
    expect(component.match(/document\.removeEventListener\("submit", stop, true\);/g)).toHaveLength(2);
  });

  // Next finds ^(proxy|middleware)\.<page extension>$ at the root or in src/;
  // any of them is a function on every matched request.
  it("leaves the app with no Next proxy or middleware", () => {
    const found = sourceFiles(
      ["{,src/}{proxy,middleware}.{ts,tsx,js,jsx,mjs,cjs,mts,cts}"],
      0,
    ).map((f) => f.path);
    expect(found).toEqual([]);
  });
});
