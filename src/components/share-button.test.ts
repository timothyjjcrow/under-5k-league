import { describe, expect, it } from "vitest";
import {
  sourceFile,
  stripLineComments,
} from "../../test/support/source-files";

// The Share button's rules live in src/lib/share-link.ts (shareMethod,
// shareUrl, shareCancelled), tested there. These guards pin the component to
// them and to the three pages whose links unfurl into their own picture.
describe("ShareButton", () => {
  const source = stripLineComments(
    sourceFile("src/components/share-button.tsx").text,
  );

  it("chooses the sheet or a copy through the tested helpers", () => {
    expect(source).toContain("shareUrl(window.location.origin, path)");
    expect(source).toMatch(/const method = shareMethod\(\{/);
    expect(source).toMatch(/if \(method === "sheet"\) \{/);
    // Closing the sheet is not a failure: no copy, no toast.
    expect(source).toMatch(/if \(shareCancelled\(error\)\) return;/);
  });

  it("never claims a copy the clipboard refused", () => {
    const copy = source.slice(
      source.indexOf("async function copy("),
      source.indexOf("return (", source.indexOf("async function copy(")),
    );
    expect(copy).toMatch(
      /await navigator\.clipboard\.writeText\(url\);\s*setCopied\(true\);\s*pushToast\("success"/,
    );
    expect(copy).toMatch(/catch \{\s*[\s\S]*pushToast\("error", `Couldn't copy — the link is \$\{url\}`\);/);
  });

  it("is a kit text control, sized like the back link beside it", () => {
    expect(source).toContain('textLink("inline-flex items-center gap-1.5 text-sm")');
    expect(source).toContain('type="button"');
  });

  it("stands on the match, team and player pages, sharing each page itself", () => {
    const match = sourceFile("src/app/matches/[id]/page.tsx").text;
    expect(match).toMatch(/<ShareButton\s+path=\{`\/matches\/\$\{match\.id\}`\}/);
    const team = sourceFile("src/app/teams/[id]/page.tsx").text;
    expect(team).toMatch(/<ShareButton path=\{`\/teams\/\$\{team\.id\}`\}/);
    const profile = sourceFile("src/components/profile-header.tsx").text;
    expect(profile).toMatch(/<ShareButton path=\{`\/players\/\$\{user\.id\}`\}/);
  });
});
