import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import {
  INDEPENDENT_OPS_PREFIXES,
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
      needs_mutation: false,
    });
  });

  it("routes ordinary pages and components to the app lane", () => {
    expect(
      classifyEntries([modified("src/app/players/page.tsx")]),
    ).toMatchObject({
      lane: "app",
      needs_postgres: true,
      needs_mutation: false,
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
    "ops/cloudflare-automation-worker/src/index.ts",
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

  // ops/ is scheduler plumbing by default; only the named independent
  // services are exempt. A second scheduler folder (a per-region worker) or
  // any new ops/ service must not silently skip the scheduler pause.
  it.each([
    ["M", "ops/cloudflare-automation-worker-europe/src/index.ts"],
    ["A", "ops/scheduler-backup/cron.mjs"],
    ["M", "ops/new-service/wrangler.jsonc"],
  ])(
    "requires scheduler controls for an unlisted ops/ path (%s %s)",
    (code, file) => {
      const entry =
        code === "A"
          ? { ...modified(file), status: "A", code: "A", oldMode: "000000" }
          : modified(file);
      expect(classifyEntries([entry])).toMatchObject({
        lane: "strict",
        needs_postgres: true,
        needs_mutation: true,
        needs_db_release: false,
        needs_scheduler_pause: true,
      });
    },
  );

  it("exempts from scheduler controls only ops/ services .vercelignore keeps out of the upload", () => {
    const ignored = readFileSync(
      path.resolve(process.cwd(), ".vercelignore"),
      "utf8",
    )
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("ops/"));
    expect(INDEPENDENT_OPS_PREFIXES.length).toBeGreaterThan(0);
    for (const prefix of INDEPENDENT_OPS_PREFIXES) {
      expect(prefix).toMatch(/^ops\/[^/]+\/$/);
      expect(ignored).toContain(prefix);
    }
  });

  it.each([
    [".github/workflows/ci.yml", true],
    // Policy documents stay strict for review but cannot move the ratchet.
    ["CLAUDE.md", false],
    ["README.md", false],
    ["docs/ARCHITECTURE.md", false],
    ["docs/PRODUCTION-OPERATIONS.md", false],
    [".env.example", true],
    ["next.config.ts", true],
    ["package-lock.json", true],
    ["package.json", true],
    ["vercel.json", true],
    ["scripts/build-db.mjs", true],
    ["scripts/classify-release.mjs", true],
    ["scripts/release-migrations.mjs", true],
    ["scripts/vercel-build.mjs", true],
    ["src/app/actions/admin.ts", true],
    ["src/lib/release-classification.test.ts", true],
    ["src/lib/automation-service.test.ts", true],
    // The lobby bot and relay are hosted independently of the website and
    // its scheduler (.vercelignore excludes them from the upload).
    ["ops/dota-lobby-bot/server.mjs", true],
    ["ops/dota-lobby-relay/src/index.mjs", true],
    ["ops/dota-lobby-relay/wrangler.jsonc", true],
  ])(
    "keeps strict review without DB or scheduler controls for %s",
    (file, needsMutation) => {
      expect(classifyEntries([modified(file)])).toMatchObject({
        lane: "strict",
        needs_postgres: true,
        needs_mutation: needsMutation,
        needs_db_release: false,
        needs_scheduler_pause: false,
      });
    },
  );

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
    // The release runbook and the decisions register are policy too:
    // editing either beside a UI change must not ride the ui-only lane.
    for (const file of ["docs/RELEASING.md", "docs/DECISIONS.md"]) {
      expect(classifyEntries([footer, modified(file)])).toMatchObject({
        lane: "strict",
        needs_postgres: true,
        needs_db_release: false,
        needs_scheduler_pause: false,
      });
    }
  });

  it.each([
    { status: "R100", code: "R", oldMode: "100644", newMode: "100644" },
    { status: "C100", code: "C", oldMode: "100644", newMode: "100644" },
    { status: "T", code: "T", oldMode: "100644", newMode: "120000" },
    { status: "M", code: "M", oldMode: "100644", newMode: "100755" },
    // A deleted symlink, executable or submodule is not a plain deletion.
    { status: "D", code: "D", oldMode: "120000", newMode: "000000" },
    { status: "D", code: "D", oldMode: "100755", newMode: "000000" },
    { status: "D", code: "D", oldMode: "160000", newMode: "000000" },
    { status: "D", code: "D", oldMode: "100644", newMode: "100644" },
  ])("fails closed for status or mode $status $oldMode", (entry) => {
    expect(
      classifyEntries([
        {
          ...entry,
          oldPath:
            entry.code === "R" || entry.code === "C" ? "old-footer.tsx" : null,
          path: "src/components/site-footer.tsx",
        },
      ]),
    ).toMatchObject({
      lane: "strict",
      needs_mutation: true,
      needs_db_release: true,
      needs_scheduler_pause: true,
    });
  });
});

describe("release classifier deletions", () => {
  const deleted = (file: string) => ({
    status: "D",
    code: "D",
    oldPath: null,
    path: file,
    oldMode: "100644",
    newMode: "000000",
  });
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

  it.each([
    "src/components/match-lineups.tsx",
    "src/app/matches/[id]/lineups.tsx",
    // Deleting the allowlisted footer is never a presentation-only change.
    "src/components/site-footer.tsx",
  ])("routes a deleted UI file %s to the app lane", (file) => {
    expect(classifyEntries([deleted(file)])).toMatchObject({
      lane: "app",
      needs_postgres: true,
      needs_mutation: false,
      needs_db_release: false,
      needs_scheduler_pause: false,
    });
  });

  it("treats a deleted static public asset like any asset change", () => {
    expect(classifyEntries([deleted("public/old-banner.png")])).toMatchObject({
      lane: "ui-only",
      needs_db_release: false,
      needs_scheduler_pause: false,
    });
    expect(
      classifyEntries([deleted("public/service-worker.js")]),
    ).toMatchObject({
      lane: "strict",
      needs_db_release: true,
      needs_scheduler_pause: true,
    });
  });

  it("classifies the removal of a server action and its component without maintenance", () => {
    expect(
      classifyEntries([
        deleted("src/app/actions/match-lineups.ts"),
        deleted("src/components/match-lineups.tsx"),
      ]),
    ).toMatchObject({
      lane: "strict",
      needs_postgres: true,
      needs_mutation: true,
      needs_db_release: false,
      needs_scheduler_pause: false,
    });
  });

  it("treats deleted documentation as a neutral companion", () => {
    expect(
      classifyEntries([deleted("docs/TIEBREAKER-WEEK.md")]),
    ).toMatchObject({
      lane: "strict",
      needs_db_release: false,
      needs_scheduler_pause: false,
    });
    expect(
      classifyEntries([
        modified("src/components/site-footer.tsx", { presentationSafe: true }),
        deleted("docs/footer-notes.md"),
      ]),
    ).toMatchObject({ lane: "ui-only", needs_postgres: false });
    expect(
      classifyEntries([
        modified("src/app/players/page.tsx"),
        deleted("docs/old-players.md"),
        deleted("test/integration/old-players.itest.ts"),
      ]),
    ).toMatchObject({ lane: "app", needs_db_release: false });
  });

  it.each([
    ["README.md", false],
    ["docs/PRODUCTION-OPERATIONS.md", false],
    ["scripts/old-helper.mjs", true],
    ["src/lib/old-service.ts", true],
    [".github/workflows/old.yml", true],
    ["ops/dota-lobby-bot/server.mjs", true],
    ["ops/dota-lobby-relay/src/index.mjs", true],
  ])(
    "keeps strict review without maintenance for deleted %s",
    (file, needsMutation) => {
      expect(classifyEntries([deleted(file)])).toMatchObject({
        lane: "strict",
        needs_postgres: true,
        needs_mutation: needsMutation,
        needs_db_release: false,
        needs_scheduler_pause: false,
      });
    },
  );

  it.each([
    "prisma/schema.prisma",
    "prisma/migrations/20990101000000_example/migration.sql",
    "prisma/seed.ts",
    "ops/cloudflare-automation-worker/src/index.ts",
    "ops/cloudflare-automation-worker/wrangler.paused.jsonc",
    "src/app/api/cron/automation/route.ts",
    "src/app/api/health/automation/route.ts",
    "src/lib/automation-service.ts",
    "src/lib/automation-service.test.ts",
    "src/lib/cron-auth.ts",
    "src/lib/external-automation-scheduler.ts",
  ])("fails closed for a deleted schema or scheduler file %s", (file) => {
    const result = classifyEntries([deleted(file)]);
    expect(result).toMatchObject({
      lane: "strict",
      needs_postgres: true,
      needs_mutation: true,
      needs_db_release: true,
      needs_scheduler_pause: true,
    });
    expect(result.reasons.join(" ")).toMatch(/schema or scheduler file/);
  });

  it.each([
    "ops/cloudflare-automation-worker-europe/wrangler.jsonc",
    "ops/scheduler-backup/cron.mjs",
  ])(
    "fails closed for a deleted file in an unlisted ops/ folder %s",
    (file) => {
      const result = classifyEntries([deleted(file)]);
      expect(result).toMatchObject({
        lane: "strict",
        needs_db_release: true,
        needs_scheduler_pause: true,
      });
      expect(result.reasons.join(" ")).toMatch(/schema or scheduler file/);
    },
  );

  it("fails closed for a deleted unknown path", () => {
    expect(classifyEntries([deleted("unknown.txt")])).toMatchObject({
      lane: "strict",
      needs_db_release: true,
      needs_scheduler_pause: true,
    });
  });

  it("lets one protected deletion select controls for the whole release", () => {
    expect(
      classifyEntries([
        deleted("docs/old.md"),
        deleted("src/components/old.tsx"),
        deleted("prisma/migrations/20990101000000_example/migration.sql"),
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
        needs_mutation: false,
      });
    },
  );

  it("classifies a real plain deletion like a change to that path", () => {
    const cwd = createRepository();
    write(cwd, "src/components/old-widget.tsx", "export const Old = 1;\n");
    write(cwd, "docs/old-notes.md", "# Old notes\n");
    write(cwd, "src/app/page.tsx", "export default function Page() {}\n");
    const base = commitAll(cwd, "base");
    rmSync(path.join(cwd, "src/components/old-widget.tsx"));
    rmSync(path.join(cwd, "docs/old-notes.md"));
    const head = commitAll(cwd, "delete stale files");

    expect(classifyRelease({ base, head, cwd })).toMatchObject({
      lane: "app",
      changedFiles: ["docs/old-notes.md", "src/components/old-widget.tsx"],
      needs_db_release: false,
      needs_scheduler_pause: false,
    });
  });

  it("keeps real deletions of migrations and symlinks fail-closed", () => {
    const cwd = createRepository();
    write(
      cwd,
      "prisma/migrations/20990101000000_example/migration.sql",
      "SELECT 1;\n",
    );
    write(cwd, "README.md", "base\n");
    mkdirSync(path.join(cwd, "docs"), { recursive: true });
    symlinkSync("../README.md", path.join(cwd, "docs", "link"));
    const base = commitAll(cwd, "base");

    rmSync(path.join(cwd, "docs", "link"));
    const symlinkHead = commitAll(cwd, "delete symlink");
    const symlinkResult = classifyRelease({ base, head: symlinkHead, cwd });
    expect(symlinkResult).toMatchObject({
      lane: "strict",
      needs_db_release: true,
      needs_scheduler_pause: true,
    });
    expect(symlinkResult.reasons.join(" ")).toMatch(/file type or mode/i);

    rmSync(path.join(cwd, "prisma"), { recursive: true });
    const migrationHead = commitAll(cwd, "delete migration");
    const migrationResult = classifyRelease({
      base: symlinkHead,
      head: migrationHead,
      cwd,
    });
    expect(migrationResult).toMatchObject({
      lane: "strict",
      needs_db_release: true,
      needs_scheduler_pause: true,
    });
    expect(migrationResult.reasons.join(" ")).toMatch(
      /schema or scheduler file/,
    );
  });

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

describe("release classifier mutation ratchet", () => {
  const entry = (file: string, code = "M") => ({
    status: code,
    code,
    oldPath: null,
    path: file,
    oldMode: code === "A" ? "000000" : "100644",
    newMode: code === "D" ? "000000" : "100644",
  });
  const needsMutation = (...files: string[]) =>
    classifyEntries(files.map((file) => entry(file))).needs_mutation;

  it.each([
    "src/app/schedule/page.tsx",
    "src/app/players/player-pool.tsx",
    "src/app/admin/admin-copy-guard.test.ts",
    "src/app/globals.css",
    "src/components/player-pool.tsx",
    "src/components/room-source-guards.test.ts",
    "public/logo.png",
    "docs/notes.md",
    "AGENTS.md",
    "CLAUDE.md",
    "README.md",
    "e2e/zz-admin-draft.spec.ts",
    "e2e/helpers.ts",
    "e2e-mid/boards.spec.ts",
  ])("skips the ratchet for %s, which the PostgreSQL suite never loads", (file) => {
    const result = classifyEntries([entry(file)]);
    expect(result.needs_mutation).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/mutation ratchet not needed/);
  });

  it("skips the ratchet for a page added or deleted with its docs and tests", () => {
    expect(
      classifyEntries([
        entry("src/app/schedule/week-strip.tsx", "A"),
        entry("src/components/old-strip.tsx", "D"),
        entry("docs/schedule.md"),
        entry("e2e-mid/schedule.spec.ts"),
      ]),
    ).toMatchObject({ lane: "app", needs_postgres: true, needs_mutation: false });
  });

  it.each([
    "src/lib/draft-service.ts",
    "src/lib/draft.test.ts",
    "src/app/actions/admin.ts",
    "src/app/api/draft/tick/route.ts",
    "src/app/api/dota-lobby/route.ts",
    "src/app/recap/route.ts",
    "src/app/calendar.ics/route.ts",
    "test/integration/draft.itest.ts",
    "test/integration/factories.ts",
    "test/fixtures/legacy-tiebreaker.ts",
    "test/mutation-baseline.json",
    "prisma/schema.prisma",
    "prisma/migrations/20990101000000_example/migration.sql",
    "scripts/mutation-guard.mjs",
    "scripts/mutation-claims.mjs",
    "scripts/test-db-safety.mjs",
    "vitest.config.mts",
    "vitest.integration.config.mts",
    "vitest.pg.config.mts",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "next.config.ts",
    ".github/workflows/ci.yml",
    ".github/workflows/mutation-nightly.yml",
    "ops/dota-lobby-bot/server.mjs",
    "e2e-mid/helpers.ts",
    "unknown.txt",
  ])("runs the ratchet for %s", (file) => {
    expect(needsMutation(file)).toBe(true);
    expect(classifyEntries([entry(file, "D")]).needs_mutation).toBe(true);
  });

  it("runs the ratchet when any one changed file needs it", () => {
    expect(
      needsMutation("src/app/schedule/page.tsx", "src/lib/schedule.ts"),
    ).toBe(true);
    // A presentation change keeps its lane but not a pass for the ratchet
    // when an integration test changes beside it.
    expect(
      classifyEntries([
        { ...entry("src/components/site-footer.tsx"), presentationSafe: true },
        entry("test/integration/draft.itest.ts"),
      ]),
    ).toMatchObject({
      lane: "ui-only",
      needs_postgres: false,
      needs_mutation: true,
    });
  });

  it("runs the ratchet for renames, copies and mode changes, even of a page", () => {
    for (const change of [
      { status: "R100", code: "R", oldPath: "src/app/old/page.tsx" },
      { status: "C100", code: "C", oldPath: "src/app/old/page.tsx" },
      { status: "M", code: "M", oldPath: null, newMode: "100755" },
    ]) {
      expect(
        classifyEntries([{ ...entry("src/app/new/page.tsx"), ...change }])
          .needs_mutation,
      ).toBe(true);
    }
  });

  // The classifier cannot import the guard (it runs as a lone file extracted
  // from the trusted commit), so these two walks are what keep its rule and
  // the ratchet's real inputs from drifting apart.
  const ROOT = process.cwd();
  const RESOLVE_SUFFIXES = [
    "",
    ".ts",
    ".tsx",
    ".mts",
    ".mjs",
    ".js",
    "/index.ts",
    "/index.tsx",
  ];
  const isFile = (file: string) =>
    existsSync(path.join(ROOT, file)) && statSync(path.join(ROOT, file)).isFile();

  function listFiles(dir: string): string[] {
    return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap(
      (item) => {
        const file = `${dir}/${item.name}`;
        return item.isDirectory() ? listFiles(file) : [file];
      },
    );
  }

  function resolveLocal(from: string, specifier: string) {
    let base: string;
    if (specifier.startsWith("@/")) base = `src/${specifier.slice(2)}`;
    else if (specifier.startsWith(".")) {
      base = path.posix.normalize(
        path.posix.join(path.posix.dirname(from), specifier),
      );
    } else return null; // a package
    const found = RESOLVE_SUFFIXES.map((suffix) => `${base}${suffix}`).find(
      isFile,
    );
    if (!found) throw new Error(`${from} imports unresolvable ${specifier}`);
    return found;
  }

  /** Every repo file the PostgreSQL suite or the guard script can load. */
  function ratchetSources() {
    const seen = new Set<string>();
    const queue = [
      ...listFiles("test/integration"),
      "vitest.pg.config.mts",
      "scripts/mutation-guard.mjs",
    ];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
      const { importedFiles } = ts.preProcessFile(
        readFileSync(path.join(ROOT, file), "utf8"),
        true,
        true,
      );
      for (const { fileName } of importedFiles) {
        const resolved = resolveLocal(file, fileName);
        if (resolved) queue.push(resolved);
      }
    }
    return [...seen].sort();
  }

  it("runs the ratchet for every file the PostgreSQL suite or the guard loads", () => {
    const sources = ratchetSources();
    // Sanity: the walk reached past the suite into the code it exercises.
    expect(sources).toEqual(
      expect.arrayContaining([
        "scripts/mutation-claims.mjs",
        "src/app/actions/admin.ts",
        "src/app/recap/route.ts",
        "src/lib/draft-service.ts",
        "test/fixtures/legacy-tiebreaker.ts",
      ]),
    );
    const neutral = [
      ...sources,
      "test/mutation-baseline.json",
      "vitest.config.mts",
      "vitest.integration.config.mts",
      "package.json",
      "package-lock.json",
      ".github/workflows/ci.yml",
      ".github/workflows/mutation-nightly.yml",
    ].filter((file) => !needsMutation(file));
    expect(neutral).toEqual([]);
  });

  it("runs the ratchet for every file the guard mutates", () => {
    const guard = readFileSync(
      path.join(ROOT, "scripts/mutation-guard.mjs"),
      "utf8",
    );
    const list = /\nconst FILES = \[([^\]]*)\];/.exec(guard);
    expect(list).not.toBeNull();
    const files = [...list![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(files.length).toBeGreaterThan(10);
    expect(files.filter((file) => !isFile(file))).toEqual([]);
    expect(files.filter((file) => !needsMutation(file))).toEqual([]);
  });
});
