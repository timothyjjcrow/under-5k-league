import ts from "typescript";

/**
 * claimThrottle moved its timestamp guard from updateMany into one atomic
 * SQL statement. Keep the existing ratchet ID: deleting BOTH representations
 * of that value guard is the same blind-write mutant as before. This narrow
 * recognizer deliberately fails discovery if either predicate disappears or
 * changes shape, so the baseline cannot silently lose its protection.
 */
export function discoverThrottleSqlClaims(file, src) {
  if (file !== "src/lib/settings.ts") return [];
  const source = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const found = [];
  const visit = (node) => {
    if (
      ts.isTaggedTemplateExpression(node) &&
      node.tag.getText(source) === "prisma.$executeRaw"
    ) {
      let owner = node.parent;
      while (owner && !ts.isFunctionDeclaration(owner)) owner = owner.parent;
      if (owner?.name?.text === "claimThrottle") {
        const sql = node.template.getText(source);
        const fresh = /WHERE NOT EXISTS\s*\(\s*SELECT 1 FROM "Setting"\s*WHERE "key" = \$\{key\} AND "value" >= \$\{staleBefore\}\s*\)/.exec(sql);
        const stale = /WHERE "Setting"\."value" < \$\{staleBefore\}/.exec(sql);
        if (fresh && stale) {
          const start = node.template.getStart(source);
          found.push({
            id: `${file}::claimThrottle::value#1`,
            file,
            line: source.getLineAndCharacterOfPosition(start).line + 1,
            drop: [fresh, stale].map((match) => [
              start + match.index,
              start + match.index + match[0].length,
            ]),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
