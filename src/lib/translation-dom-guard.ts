// Browser page translation (Chrome's "Translate this page", Edge, Yandex)
// replaces the page's text nodes with its own <font> elements, behind React's
// back. The next time React removes or moves one of those text nodes, after
// any update such as the re-render a signup or a saved form triggers, the
// browser throws "Failed to execute 'removeChild' on 'Node': The node to be
// removed is not a child of this node" and the route's error page replaces
// the screen. A player reading the US league in Russian hit exactly that the
// moment their signup saved (2026-10-06).
//
// React has no fix for this (facebook/react#11538); this guard is the
// standard workaround. When the node React names is no longer where React put
// it, removeChild leaves it alone and insertBefore appends, instead of
// throwing. The cost is cosmetic: translated text can lag React's for a
// moment (the translator re-translates new text), which beats an error page.
// It is a string because it must run in the page before React does: the root
// layout inlines it as the first thing in <body>. Plain ES5, idempotent.
export const TRANSLATION_DOM_GUARD = `(function () {
  if (typeof Node !== "function" || !Node.prototype || Node.prototype.__translationDomGuard) return;
  var proto = Node.prototype;
  var removeChild = proto.removeChild;
  var insertBefore = proto.insertBefore;
  proto.removeChild = function (child) {
    if (child && child.parentNode !== this) return child;
    return removeChild.apply(this, arguments);
  };
  proto.insertBefore = function (node, reference) {
    if (reference && reference.parentNode !== this) return insertBefore.call(this, node, null);
    return insertBefore.apply(this, arguments);
  };
  proto.__translationDomGuard = true;
})();`;
