// List exports under src/lib that no production code imports.
//
//   npm run lint:unused-exports             # report; always exits 0
//   npm run lint:unused-exports -- --all    # also list exports only their own file uses
//   npm run lint:unused-exports -- --json   # machine-readable
//   node --test scripts/unused-exports.test.mjs   # the script's own tests
//
// Why: a pure lib function that the site stopped calling keeps its unit tests,
// so the suite goes on vouching for code the site never runs. The next person
// edits the tested copy, sees green, and nothing on the site changes. This is
// ADVISORY, not a CI gate: some finds are deliberate (a helper exported only
// so a test can reach it), and a person decides.
//
// How: parse every TS/JS file in the repo with the TypeScript compiler (already
// a dependency), resolve each import specifier ("@/…" and relative paths) to a
// file, and record which exported names each file imports. A file counts as a
// TEST when it is a *.test / *.itest / *.spec file, lives under test/ or an
// e2e* folder, or is a playwright/vitest config. Everything else (src, scripts,
// prisma, root configs) is production. Categories:
//   unused      no importer anywhere and not used in its own file
//   test-only   imported only by tests and not used in its own file
//   local-only  (--all) no importer outside its own file, but used there, so
//               the `export` keyword may be unnecessary
// Re-exports count as a use of the original by the re-exporting file; the
// re-exported name is then checked on its own. Word matches in comments or
// strings never count as a use.
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const SOURCE_EXT = /\.(?:[cm]?[jt]s|tsx|jsx)$/;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "coverage",
  "playwright-report",
  "test-results",
  "blob-report",
  "backups",
  "output",
  "build",
  "out",
]);
const RESOLVE_SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  ".mts",
  ".d.ts",
  ".js",
  ".mjs",
  "/index.ts",
  "/index.tsx",
];

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // Every .next* folder is Next build output (one per fixture server).
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".next")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && SOURCE_EXT.test(entry.name)) out.push(full);
  }
  return out;
}

/** Test code keeps an export alive only for its own sake. */
export function isTestFile(rel) {
  const posix = rel.split(path.sep).join("/");
  return (
    /\.(?:test|itest|spec)\.[cm]?[jt]sx?$/.test(posix) ||
    /^(?:test|e2e[^/]*)\//.test(posix) ||
    /^(?:playwright|vitest)\.[^/]*$/.test(posix)
  );
}

function resolveSpecifier(root, fromFile, spec) {
  let base;
  if (spec.startsWith("@/")) base = path.join(root, "src", spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
  else return null;
  // TS ESM style: "./x.js" names ./x.ts on disk.
  const bases = /\.[cm]?js$/.test(base)
    ? [base, base.replace(/\.([cm]?)js$/, ".$1ts")]
    : [base];
  for (const b of bases) {
    for (const suffix of RESOLVE_SUFFIXES) {
      const candidate = b + suffix;
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
  }
  return null;
}

function hasExportModifier(node) {
  return (ts.getModifiers?.(node) ?? node.modifiers ?? []).some(
    (m) => m.kind === ts.SyntaxKind.ExportKeyword,
  );
}

function hasDefaultModifier(node) {
  return (ts.getModifiers?.(node) ?? node.modifiers ?? []).some(
    (m) => m.kind === ts.SyntaxKind.DefaultKeyword,
  );
}

function bindingNames(name, out) {
  if (ts.isIdentifier(name)) out.push(name);
  else for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(el.name, out);
  return out;
}

/** Identifiers that are a property/member NAME, not a reference to a binding. */
function isMemberName(id) {
  const p = id.parent;
  if (!p) return false;
  if (ts.isPropertyAccessExpression(p) || ts.isQualifiedName(p)) return p.name === id || p.right === id;
  return (
    (ts.isPropertyAssignment(p) ||
      ts.isPropertySignature(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isMethodSignature(p) ||
      ts.isEnumMember(p) ||
      ts.isGetAccessor(p) ||
      ts.isSetAccessor(p)) &&
    p.name === id
  );
}

/**
 * Scan one file: the names it exports (with their declaring identifiers) and,
 * per resolved target file, the names it imports ("*" = all of them).
 */
function scanFile(root, file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const exports = new Map(); // name -> { line, declIds: Set<Node> }
  const uses = new Map(); // target -> Set<name | "*">
  const refs = new Map(); // identifier text -> Identifier[] (non-member refs)

  // declIds: the identifiers that declare/re-export the name (not uses).
  // localDecls: how many more declarations of it live elsewhere in the file
  // (`function a() {}` … `export { a }` declares `a` once more).
  const addExport = (name, node, declIds, localDecls = 0) => {
    if (exports.has(name)) return;
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    exports.set(name, { line, declIds: new Set(declIds), localDecls, local: null });
  };
  const recordUse = (spec, names) => {
    const target = resolveSpecifier(root, file, spec);
    if (!target) return;
    const set = uses.get(target) ?? new Set();
    for (const n of names) set.add(n);
    uses.set(target, set);
  };

  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st)) {
      const spec = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)
        ? st.moduleSpecifier.text
        : null;
      if (!st.exportClause) {
        if (spec) recordUse(spec, ["*"]);
        continue;
      }
      if (ts.isNamespaceExport(st.exportClause)) {
        addExport(st.exportClause.name.text, st, []);
        if (spec) recordUse(spec, ["*"]);
        continue;
      }
      for (const el of st.exportClause.elements) {
        const local = el.propertyName ?? el.name;
        addExport(el.name.text, el, [el.name, local], spec ? 0 : 1);
        if (spec) recordUse(spec, [local.text]);
        else exports.get(el.name.text).local = local.text;
      }
      continue;
    }
    if (ts.isExportAssignment(st)) {
      addExport("default", st, []);
      continue;
    }
    if (!hasExportModifier(st)) continue;
    if (hasDefaultModifier(st)) {
      addExport("default", st, st.name ? [st.name] : []);
      continue;
    }
    if (ts.isVariableStatement(st)) {
      for (const decl of st.declarationList.declarations) {
        for (const id of bindingNames(decl.name, [])) addExport(id.text, decl, [id]);
      }
    } else if (st.name && ts.isIdentifier(st.name)) {
      addExport(st.name.text, st, [st.name]);
    }
  }

  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const names = [];
      if (clause?.name) names.push("default");
      const nb = clause?.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) names.push("*");
      else if (nb) for (const el of nb.elements) names.push((el.propertyName ?? el.name).text);
      recordUse(node.moduleSpecifier.text, names);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      // `const { a, b } = await import("x")` names what it takes; any other
      // shape might touch anything, so it counts as using every export.
      const holder = ts.isAwaitExpression(node.parent) ? node.parent.parent : node.parent;
      const names =
        holder && ts.isVariableDeclaration(holder) && ts.isObjectBindingPattern(holder.name)
          ? holder.name.elements.map((el) =>
              el.propertyName && ts.isIdentifier(el.propertyName)
                ? el.propertyName.text
                : ts.isIdentifier(el.name)
                  ? el.name.text
                  : "*",
            )
          : ["*"];
      recordUse(node.arguments[0].text, names);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      let q = node.qualifier;
      while (q && ts.isQualifiedName(q)) q = q.left;
      recordUse(node.argument.literal.text, [q ? q.text : "*"]);
    } else if (ts.isIdentifier(node) && !isMemberName(node)) {
      const list = refs.get(node.text) ?? [];
      list.push(node);
      refs.set(node.text, list);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  for (const [name, info] of exports) {
    const others = (refs.get(info.local ?? name) ?? []).filter(
      (id) => !info.declIds.has(id),
    );
    info.selfUse = others.length - info.localDecls > 0;
    delete info.declIds;
  }
  return { exports, uses };
}

/** Every src/lib export with no production importer, by category. */
export function findUnusedExports({ root, includeLocal = false } = {}) {
  const files = walk(root, []);
  const scans = new Map();
  for (const file of files) scans.set(file, scanFile(root, file, readFileSync(file, "utf8")));

  const libDir = path.join(root, "src", "lib") + path.sep;
  const results = [];
  for (const [file, { exports }] of scans) {
    const rel = path.relative(root, file);
    // Declaration files (*.d.ts, *.d.mts) only describe a sibling module.
    if (!file.startsWith(libDir) || isTestFile(rel) || /\.d\.[cm]?ts$/.test(file)) continue;
    for (const [name, info] of exports) {
      let prod = false;
      let test = false;
      for (const [other, { uses }] of scans) {
        if (other === file) continue;
        const names = uses.get(file);
        if (!names || !(names.has(name) || names.has("*"))) continue;
        if (isTestFile(path.relative(root, other))) test = true;
        else prod = true;
      }
      if (prod) continue;
      const category = info.selfUse ? "local-only" : test ? "test-only" : "unused";
      if (category === "local-only" && !includeLocal) continue;
      results.push({ file: rel.split(path.sep).join("/"), line: info.line, name, category });
    }
  }
  results.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return results;
}

const LABELS = {
  unused: "Exported, but nothing imports it and its own file doesn't use it",
  "test-only": "Only tests import it (the site never runs it)",
  "local-only": "Only its own file uses it (the export may be unnecessary)",
};

function main(argv) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const results = findUnusedExports({ root, includeLocal: argv.includes("--all") });
  if (argv.includes("--json")) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  for (const category of ["unused", "test-only", "local-only"]) {
    const rows = results.filter((r) => r.category === category);
    if (rows.length === 0) continue;
    console.log(`\n${LABELS[category]} (${rows.length}):`);
    for (const r of rows) console.log(`  ${r.file}:${r.line}  ${r.name}`);
  }
  console.log(
    results.length === 0
      ? "Every src/lib export has a production importer."
      : "\nAdvisory only: delete dead code with its tests, or keep it on purpose.",
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) main(process.argv.slice(2));
