"use strict";

/**
 * Find within the active pane's document.
 *
 * Wraps matches in <mark> and unwraps them again rather than re-rendering the
 * document, so the reader's scroll position is never disturbed by a search. Matches
 * that straddle an element boundary (half inside an <em>, say) are not found — that
 * would need a flattened text index, and it is not worth the complexity here.
 */
window.Find = (() => {

  const HIT = "find-hit";
  const CURRENT = "find-current";

  let container = null;
  let query = "";
  let hits = [];
  let current = 0;

  /** Puts the document back exactly as it was before the search. */
  function clear() {
    if (!container) return;

    for (const mark of [...container.querySelectorAll("mark." + HIT)]) {
      const parent = mark.parentNode;
      if (!parent) continue;
      parent.replaceChild(document.createTextNode(mark.textContent), mark);
      parent.normalize();
    }

    hits = [];
    current = 0;
  }

  function textNodesIn(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;

        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;

        // Never match inside chrome the app injected into the document.
        if (parent.closest(".copy")) return NodeFilter.FILTER_REJECT;

        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const nodes = [];
    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    return nodes;
  }

  function run(target, text) {
    clear();

    container = target;
    query = text || "";

    if (!container || query.length === 0) return 0;

    const needle = query.toLowerCase();

    for (const node of textNodesIn(container)) {
      const value = node.nodeValue;
      const lower = value.toLowerCase();

      const spans = [];
      let from = 0;
      let at;
      while ((at = lower.indexOf(needle, from)) >= 0) {
        spans.push([at, at + needle.length]);
        from = at + needle.length;
      }
      if (spans.length === 0) continue;

      const fragment = document.createDocumentFragment();
      let cursor = 0;

      for (const [start, end] of spans) {
        if (start > cursor) fragment.append(value.slice(cursor, start));

        const mark = document.createElement("mark");
        mark.className = HIT;
        mark.textContent = value.slice(start, end);
        fragment.append(mark);

        cursor = end;
      }

      if (cursor < value.length) fragment.append(value.slice(cursor));
      node.parentNode.replaceChild(fragment, node);
    }

    hits = [...container.querySelectorAll("mark." + HIT)];
    current = 0;
    focus(false);

    return hits.length;
  }

  function focus(scroll = true) {
    for (const mark of hits) mark.classList.remove(CURRENT);
    if (hits.length === 0) return;

    const mark = hits[current];
    mark.classList.add(CURRENT);
    if (scroll) mark.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function step(delta) {
    if (hits.length === 0) return;
    current = (current + delta + hits.length) % hits.length;
    focus();
  }

  /** Re-applies the current search after the document has been repainted. */
  function reapply(target) {
    if (!query) return 0;

    const position = current;
    const count = run(target, query);

    if (count > 0) {
      current = Math.min(position, count - 1);
      focus(false);
    }
    return count;
  }

  return {
    run,
    clear,
    reapply,
    next: () => step(1),
    previous: () => step(-1),
    get count() { return hits.length; },
    get position() { return hits.length ? current + 1 : 0; },
    get query() { return query; },
    get container() { return container; }
  };
})();
