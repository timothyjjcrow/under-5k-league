import { describe, expect, it } from "vitest";
import NextLink from "next/link";
import Link from "./app-link";
import { sourceFiles } from "../../test/support/source-files";

// Prefetching is production-only, so no browser suite (they run `next dev`)
// can see it. These checks are what keep a visible link from costing a server
// render on every page view again.

describe("Link", () => {
  it("renders next/link with prefetching off unless the call site asks", () => {
    const plain = Link({ href: "/players", children: "Players" });
    expect(plain.type).toBe(NextLink);
    expect(plain.props).toMatchObject({ href: "/players", prefetch: false });
    expect(Link({ href: "/x", children: "x", prefetch: null }).props.prefetch).toBeNull();
    expect(Link({ href: "/x", children: "x", prefetch: true }).props.prefetch).toBe(true);
  });

  it("is the only module that imports next/link", () => {
    const files = sourceFiles("src/**/*.{ts,tsx}", 500);
    const direct = files.filter(
      (f) =>
        f.path !== "src/components/app-link.tsx" &&
        /from\s+["']next\/link["']|import\(\s*["']next\/link["']\s*\)/.test(f.text),
    );
    expect(direct.map((f) => f.path)).toEqual([]);
    // The guard means something only while the site's links go through it.
    const users = files.filter((f) => f.text.includes('from "@/components/app-link"'));
    expect(users.length).toBeGreaterThanOrEqual(90);
  });
});
