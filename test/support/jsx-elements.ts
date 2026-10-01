import path from "node:path";
import ts from "typescript";
import type { SourceFile } from "./source-files";

/**
 * Parsed JSX for SOURCE GUARDS whose rule is about an element and its own
 * props ("an element painted with a team's hue carries `data-team-hue`"). A
 * regex over the text can't tell which element a prop belongs to once props
 * span lines, spread, or nest; the TypeScript parser can. Pair it with
 * `sourceFiles` so the guard still covers an area, not a file list.
 */

/** A source file parsed as TS or TSX by its extension. */
export function parseSource(file: SourceFile): ts.SourceFile {
  return ts.createSourceFile(
    file.path,
    file.text,
    ts.ScriptTarget.Latest,
    true,
    path.extname(file.path) === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

export type JsxElementInfo = {
  /** `path:line` of the element's opening tag, for failure messages. */
  at: string;
  /** The tag as written: `div`, `Card`, `TeamCrest`. */
  tag: string;
  /** Each named prop's value as written (`"…"` or `{…}`), `""` when bare. */
  attributes: Map<string, string>;
  /** The expressions spread into the props (`{...x}` gives `x`). */
  spreads: string[];
  /** `<x />`: an element with no children. */
  selfClosing: boolean;
  /** The JSX element this one sits inside, if any. */
  parent: JsxElementInfo | null;
  node: ts.JsxOpeningLikeElement;
};

/**
 * Every JSX element in the file, outermost first. Pass the file's parsed
 * `source` when the guard walks it too, so `node` is the same object.
 */
export function jsxElements(
  file: SourceFile,
  source: ts.SourceFile = parseSource(file),
): JsxElementInfo[] {
  const found: JsxElementInfo[] = [];
  const visit = (node: ts.Node, parent: JsxElementInfo | null) => {
    let next = parent;
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      next = describeElement(opening, file, source, parent);
      found.push(next);
    }
    ts.forEachChild(node, (child) => visit(child, next));
  };
  visit(source, null);
  return found;
}

function describeElement(
  opening: ts.JsxOpeningLikeElement,
  file: SourceFile,
  source: ts.SourceFile,
  parent: JsxElementInfo | null,
): JsxElementInfo {
  const attributes = new Map<string, string>();
  const spreads: string[] = [];
  for (const prop of opening.attributes.properties) {
    if (ts.isJsxSpreadAttribute(prop)) {
      spreads.push(prop.expression.getText(source));
    } else {
      attributes.set(
        prop.name.getText(source),
        prop.initializer ? prop.initializer.getText(source) : "",
      );
    }
  }
  const line =
    source.getLineAndCharacterOfPosition(opening.getStart(source)).line + 1;
  return {
    at: `${file.path}:${line}`,
    tag: opening.tagName.getText(source),
    attributes,
    spreads,
    selfClosing: ts.isJsxSelfClosingElement(opening),
    parent,
    node: opening,
  };
}

/**
 * The JSX element whose props contain `node` (a call inside `style={…}` or a
 * spread), or null when `node` isn't inside any element's props.
 */
export function propsOwner(node: ts.Node): ts.JsxOpeningLikeElement | null {
  for (let at: ts.Node | undefined = node; at; at = at.parent) {
    if (ts.isJsxAttributes(at)) {
      const owner = at.parent;
      return ts.isJsxOpeningElement(owner) || ts.isJsxSelfClosingElement(owner)
        ? owner
        : null;
    }
    // Props never reach past the element's own tag.
    if (ts.isJsxElement(at) || ts.isJsxFragment(at)) return null;
  }
  return null;
}

/** A prop's value without its braces or quotes: `{team.id}` → `team.id`. */
export function propValue(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const braced = /^\{([\s\S]*)\}$/.exec(raw.trim());
  if (braced) return braced[1].trim();
  const quoted = /^"([\s\S]*)"$/.exec(raw.trim());
  return quoted ? quoted[1] : raw.trim();
}
