import { describe, expect, it } from "vitest";
import { sourceFile } from "../../test/support/source-files";
import { TRANSLATION_DOM_GUARD } from "./translation-dom-guard";

/**
 * A minimal stand-in for the DOM's Node, strict the way browsers are: it
 * throws a NotFoundError when asked to remove, or insert before, a node that
 * isn't its child. That is the exception a translated page raised.
 */
function strictNodeClass() {
  class FakeNode {
    parentNode: FakeNode | null = null;
    childNodes: FakeNode[] = [];
    constructor(public label = "") {}
    appendChild(child: FakeNode) {
      return this.insertBefore(child, null);
    }
    removeChild(child: FakeNode) {
      const at = this.childNodes.indexOf(child);
      if (at < 0) throw new Error("NotFoundError: The node to be removed is not a child of this node.");
      this.childNodes.splice(at, 1);
      child.parentNode = null;
      return child;
    }
    insertBefore(node: FakeNode, reference: FakeNode | null) {
      if (reference && !this.childNodes.includes(reference)) {
        throw new Error("NotFoundError: The node before which the new node is to be inserted is not a child of this node.");
      }
      if (node.parentNode) node.parentNode.removeChild(node);
      const at = reference ? this.childNodes.indexOf(reference) : this.childNodes.length;
      this.childNodes.splice(at, 0, node);
      node.parentNode = this;
      return node;
    }
  }
  return FakeNode;
}

function guarded() {
  const FakeNode = strictNodeClass();
  new Function("Node", TRANSLATION_DOM_GUARD)(FakeNode);
  return FakeNode;
}

describe("translation DOM guard", () => {
  it("leaves a node a translator already moved, instead of throwing", () => {
    const Node = guarded();
    const parent = new Node("p");
    const text = new Node("Join the season");
    parent.appendChild(text);
    // The translator swaps the text for its own <font>.
    const font = new Node("font");
    parent.insertBefore(font, text);
    parent.removeChild(text);
    expect(() => parent.removeChild(text)).not.toThrow();
    expect(parent.childNodes).toEqual([font]);
  });

  it("appends when the node to insert before was moved away", () => {
    const Node = guarded();
    const parent = new Node("p");
    const moved = new Node("moved");
    const added = new Node("Update signup");
    expect(() => parent.insertBefore(added, moved)).not.toThrow();
    expect(parent.childNodes).toEqual([added]);
  });

  it("changes nothing for ordinary removes and inserts, and installs once", () => {
    const Node = guarded();
    new Function("Node", TRANSLATION_DOM_GUARD)(Node);
    const parent = new Node("ul");
    const a = new Node("a");
    const b = new Node("b");
    parent.appendChild(b);
    parent.insertBefore(a, b);
    expect(parent.childNodes).toEqual([a, b]);
    parent.removeChild(a);
    expect(parent.childNodes).toEqual([b]);
  });

  it("is what the unguarded browser would have thrown", () => {
    const Node = strictNodeClass();
    const parent = new Node("p");
    expect(() => parent.removeChild(new Node("orphan"))).toThrow(/NotFoundError/);
  });
});

describe("the root layout", () => {
  it("inlines the guard as the first thing in <body>, before any React code runs", () => {
    const layout = sourceFile("src/app/layout.tsx").text;
    const body = layout.indexOf("<body");
    expect(body).toBeGreaterThan(0);
    const firstElement = layout.slice(body).replace(/\{\/\*[\s\S]*?\*\/\}/g, "").match(/>\s*(<[a-zA-Z]+[^>]*>)/);
    expect(firstElement?.[1]).toContain("dangerouslySetInnerHTML={{ __html: TRANSLATION_DOM_GUARD }}");
  });
});
