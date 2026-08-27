import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyEntries,
  classifyRelease,
  isStaticClassNameOnlyDiff,
  parseNameStatus,
  parseRawDiff,
} from "../../scripts/classify-release.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    if (
      path.dirname(directory) !== tmpdir() ||
      !path.basename(directory).startsWith("ld2l-release-classifier-")
    ) {
      throw new Error(`Refusing to clean unexpected test path: ${directory}`);
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createRepository() {
  const cwd = mkdtempSync(path.join(tmpdir(), "ld2l-release-classifier-"));
  temporaryDirectories.push(cwd);
  git(cwd, "init", "--quiet");
  git(cwd, "config", "user.name", "Release Classifier Test");
  git(cwd, "config", "user.email", "release-classifier@example.invalid");
  return cwd;
}

function commitAll(cwd: string, message: string) {
  git(cwd, "add", "--all");
  git(cwd, "commit", "--quiet", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

function write(cwd: string, file: string, contents: string) {
  const absolute = path.join(cwd, file);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

describe("release classifier parsers", () => {
  it("parses NUL-delimited name-status entries including renames", () => {
    expect(parseNameStatus("M\0a file.tsx\0R100\0old.tsx\0new.tsx\0")).toEqual([
      { status: "M", code: "M", oldPath: null, path: "a file.tsx" },
      {
        status: "R100",
        code: "R",
        oldPath: "old.tsx",
        path: "new.tsx",
      },
    ]);
  });

  it("parses raw modes without losing paths", () => {
    const zeros = "0".repeat(40);
    const ones = "1".repeat(40);
    expect(
      parseRawDiff(`:000000 100644 ${zeros} ${ones} A\0public/logo.png\0`),
    ).toEqual([
      {
        status: "A",
        code: "A",
        oldMode: "000000",
        newMode: "100644",
        oldPath: null,
        path: "public/logo.png",
      },
    ]);
  });
});

describe("release classifier policy", () => {
  const modified = (
    file: string,
    extra: Record<string, string | boolean> = {},
  ) => ({
    status: "M",
    code: "M",
    oldPath: null,
    path: file,
    oldMode: "100644",
    newMode: "100644",
    ...extra,
  });

  it("allows only a narrow UI change with neutral documentation", () => {
    const result = classifyEntries([
      modified("src/components/site-footer.tsx", { presentationSafe: true }),
      modified("docs/footer.md"),
    ]);
    expect(result).toMatchObject({
      lane: "ui-only",
      needs_postgres: false,
      needs_mutation: false,
      needs_e2e: true,
      needs_db_release: false,
      needs_scheduler_pause: false,
    });
  });

  it("does not trust an allowlisted component path without diff evidence", () => {
    expect(
      classifyEntries([modified("src/components/site-footer.tsx")]),
    ).toMatchObject({
      lane: "app",
      needs_postgres: true,
      needs_mutation: true,
    });
  });

  it("routes ordinary pages and components to the app lane", () => {
    expect(
      classifyEntries([modified("src/app/players/page.tsx")]),
    ).toMatchObject({
      lane: "app",
      needs_postgres: true,
      needs_mutation: true,
      needs_db_release: false,
      needs_scheduler_pause: false,
    });
  });

  it("allows static public assets but not executable public files", () => {
    expect(classifyEntries([modified("public/footer-mark.svg")]).lane).toBe(
      "ui-only",
    );
    expect(classifyEntries([modified("public/service-worker.js")]).lane).toBe(
      "strict",
    );
  });

  it.each([
    "prisma/schema.prisma",
    "prisma/migrations/20990101000000_example/migration.sql",
  ])("requires DB release controls for Prisma/schema path %s", (file) => {
    expect(classifyEntries([modified(file)])).toMatchObject({
      lane: "strict",
      needs_postgres: true,
      needs_mutation: true,
      needs_db_release: true,
      needs_scheduler_pause: true,
    });
  });

  it.each([
    "src/app/api/cron/automation/route.ts",
    "src/app/api/health/automation/route.ts",
    "src/lib/automation-service.ts",
    "src/lib/cron-auth.ts",
    "ops/cloudflare-automation-worker/wrangler.jsonc",
  ])(
    "requires only scheduler controls for runtime scheduler path %s",
    (file) => {
      expect(classifyEntries([modified(file)])).toMatchObject({
        lane: "strict",
        needs_postgres: true,
        needs_mutation: true,
        needs_db_release: false,
        needs_scheduler_pause: true,
      });
    },
  );

  it.each([
    ".github/workflows/ci.yml",
    "CLAUDE.md",
    "README.md",
    "docs/ARCHITECTURE.md",
    "docs/PRODUCTION-OPERATIONS.md",
    ".env.example",
    "next.config.ts",
    "package-lock.json",
    "package.json",
    "vercel.json",
    "scripts/build-db.mjs",
    "scripts/classify-release.mjs",
    "scripts/release-migrations.mjs",
    "scripts/vercel-build.mjs",
    "src/app/actions/admin.ts",
    "src/lib/release-classification.test.ts",
    "src/lib/automation-service.test.ts",
  ])("keeps strict review without DB or scheduler controls for %s", (file) => {
    expect(classifyEntries([modified(file)])).toMatchObject({
      lane: "strict",
      needs_postgres: true,
      needs_mutation: true,
      needs_db_release: false,
      needs_scheduler_pause: false,
    });
  });

  it("fails closed for an unknown path", () => {
    expect(classifyEntries([modified("unknown.txt")])).toMatchObject({
      lane: "strict",
      needs_db_release: true,
      needs_scheduler_pause: true,
    });
  });

  it("does not let documentation-only changes establish a fast lane", () => {
    expect(classifyEntries([modified("docs/release.md")])).toMatchObject({
      lane: "strict",
      needs_db_release: false,
      needs_scheduler_pause: false,
    });
  });

  it("keeps ordinary docs neutral companions but core policy docs strict", () => {
    const footer = modified("src/components/site-footer.tsx", {
      presentationSafe: true,
    });
    expect(
      classifyEntries([footer, modified("docs/footer-notes.md")]).lane,
    ).toBe("ui-only");
    expect(
      classifyEntries([
        footer,
        modified("docs/PRODUCTION-OPERATIONS.md"),
      ]).lane,
    ).toBe("strict");
  });

  it.each([
    { status: "D", code: "D", oldMode: "100644", newMode: "000000" },
    { status: "R100", code: "R", oldMode: "100644", newMode: "100644" },
    { status: "T", code: "T", oldMode: "100644", newMode: "120000" },
    { status: "M", code: "M", oldMode: "100644", newMode: "100755" },
  ])("fails closed for status or mode $status", (entry) => {
    expect(
      classifyEntries([
        {
          ...entry,
          oldPath: entry.code === "R" ? "old-footer.tsx" : null,
          path: "src/components/site-footer.tsx",
        },
      ]),
    ).toMatchObject({
      lane: "strict",
      needs_db_release: true,
      needs_scheduler_pause: true,
    });
  });
});

describe("release classifier presentation diff guard", () => {
  const patch = (
    oldLine: string,
    newLine: string,
  ) => `diff --git a/src/components/site-footer.tsx b/src/components/site-footer.tsx
index 1111111..2222222 100644
--- a/src/components/site-footer.tsx
+++ b/src/components/site-footer.tsx
@@ -10 +10 @@
-${oldLine}
+${newLine}
`;

  it("accepts a static className string as the sole one-line change", () => {
    expect(
      isStaticClassNameOnlyDiff(
        patch(
          '  <div className="mt-10 border-t border-line/60 pt-5">',
          '  <div className="mt-10 pt-5">',
        ),
      ),
    ).toBe(true);
  });

  it.each([
    [
      "logic on the JSX line",
      '  <div className="before">',
      '  <div onClick={() => mutate()} className="after">',
    ],
    [
      "a className expression",
      '  <div className="before">',
      "  <div className={await loadClasses()}>",
    ],
    [
      "rendered text",
      '  <span className="before">Support</span>',
      '  <span className="after">Run code</span>',
    ],
    [
      "a multiline attribute fragment",
      '    className="before"',
      '    className="after"',
    ],
  ])("rejects %s", (_label, oldLine, newLine) => {
    expect(isStaticClassNameOnlyDiff(patch(oldLine, newLine))).toBe(false);
  });

  it("rejects a patch containing an import even with a className change", () => {
    const unsafePatch = `${patch(
      '  <div className="before">',
      '  <div className="after">',
    )}@@ -1,0 +1 @@
+import { prisma } from "@/lib/prisma";
`;
    expect(isStaticClassNameOnlyDiff(unsafePatch)).toBe(false);
  });
});

describe("release classifier git integration", () => {
  it("allows a static className-only modification in the existing footer", () => {
    const cwd = createRepository();
    write(
      cwd,
      "src/components/site-footer.tsx",
      `export function Footer() {
  return (
    <footer className="border-t border-line/60">Footer</footer>
  );
}
`,
    );
    const base = commitAll(cwd, "base");
    write(
      cwd,
      "src/components/site-footer.tsx",
      `export function Footer() {
  return (
    <footer className="border-line/60">Footer</footer>
  );
}
`,
    );
    const head = commitAll(cwd, "footer");

    expect(classifyRelease({ base, head, cwd })).toMatchObject({
      baseSha: base,
      headSha: head,
      lane: "ui-only",
      changedFiles: ["src/components/site-footer.tsx"],
    });
  });

  it.each([
    {
      label: "an import",
      contents: `import { prisma } from "@/lib/prisma";

export function Footer() {
  return <footer className="after">Footer</footer>;
}
`,
    },
    {
      label: "an event handler",
      contents: `export function Footer() {
  return <footer onClick={() => mutate()} className="after">Footer</footer>;
}
`,
    },
    {
      label: "rendered content",
      contents: `export function Footer() {
  return <footer className="after">Different footer</footer>;
}
`,
    },
  ])(
    "routes $label in an allowlisted component to the app lane",
    ({ contents }) => {
      const cwd = createRepository();
      write(
        cwd,
        "src/components/site-footer.tsx",
        `export function Footer() {
  return <footer className="before">Footer</footer>;
}
`,
      );
      const base = commitAll(cwd, "base");
      write(cwd, "src/components/site-footer.tsx", contents);
      const head = commitAll(cwd, "unsafe footer change");

      expect(classifyRelease({ base, head, cwd })).toMatchObject({
        lane: "app",
        needs_postgres: true,
        needs_mutation: true,
      });
    },
  );

  it("rejects a non-ancestor base and an empty diff", () => {
    const cwd = createRepository();
    write(cwd, "README.md", "base\n");
    const base = commitAll(cwd, "base");
    git(cwd, "checkout", "--quiet", "-b", "other");
    write(cwd, "README.md", "other\n");
    const other = commitAll(cwd, "other");
    git(cwd, "checkout", "--quiet", "--detach", base);
    write(cwd, "README.md", "detached\n");
    const head = commitAll(cwd, "detached");

    expect(() => classifyRelease({ base: other, head, cwd })).toThrow(
      /not an ancestor/i,
    );
    expect(() => classifyRelease({ base, head: base, cwd })).toThrow(
      /no changed files/i,
    );
  });

  it("rejects symlinks even inside public", () => {
    const cwd = createRepository();
    write(cwd, "README.md", "base\n");
    const base = commitAll(cwd, "base");
    symlinkSync("../README.md", path.join(cwd, "public-link"));
    mkdirSync(path.join(cwd, "public"), { recursive: true });
    renameSync(path.join(cwd, "public-link"), path.join(cwd, "public", "link"));
    const head = commitAll(cwd, "symlink");

    const result = classifyRelease({ base, head, cwd });
    expect(result.lane).toBe("strict");
    expect(result.reasons.join(" ")).toMatch(/file type or mode/i);
  });

  it("detects copied public files and refuses the UI fast lane", () => {
    const cwd = createRepository();
    write(cwd, "public/original.svg", "<svg><!-- unique fixture --></svg>\n");
    const base = commitAll(cwd, "base");
    write(
      cwd,
      "public/copied.svg",
      readFileSync(path.join(cwd, "public", "original.svg"), "utf8"),
    );
    const head = commitAll(cwd, "copy");

    const result = classifyRelease({ base, head, cwd });
    expect(result.lane).toBe("strict");
    expect(result.reasons.join(" ")).toMatch(/only additions\/modifications/i);
  });

  it("requires full lowercase SHAs", () => {
    const cwd = createRepository();
    write(
      cwd,
      "README.md",
      readFileSync(new URL("../../README.md", import.meta.url), "utf8"),
    );
    const head = commitAll(cwd, "base");
    expect(() =>
      classifyRelease({ base: head.slice(0, 12), head, cwd }),
    ).toThrow(/full lowercase 40-character SHA/i);
  });
});
