"use strict";

/**
 * The pane tree.
 *
 *   node = { type: "pane",  id, tabs: [path], active: path|null, anchors: {} }
 *        | { type: "split", dir: "row"|"col", sizes: [a, b], children: [node, node] }
 *
 * Splits always have exactly two children; splitting an already-split pane nests
 * rather than widening. That keeps divider maths trivial and the serialised form
 * unambiguous, at the cost of slightly deeper trees than VS Code produces.
 *
 * Panes hold paths, not documents. The document itself lives once in the app's
 * store, so the same file open in two panes is one watcher and one render.
 * Scroll anchors are per pane *and* per path, because two panes showing the same
 * file are two independent reading positions.
 */
window.Layout = (() => {

  let counter = 0;
  let root = null;
  let activeId = null;
  let hooks = {};

  function newPane(tabs = [], active = null) {
    counter += 1;
    return {
      type: "pane", id: "pane" + counter, tabs: [...tabs], active,
      anchors: {}, modes: {}, zoom: 1,
      // Paths pinned in this pane, in pin order. Kept as a plain array rather than a Set
      // so it survives the JSON round trip through the session untouched.
      pinned: []
    };
  }

  /**
   * Pinned tabs sort to the front of the strip.
   *
   * Enforced by reordering `tabs` itself rather than by keeping a second ordered list.
   * Everything downstream -- cycling, closing, dragging, the strip build -- already
   * reads `tabs` as the one true order, and a second order would be a second thing to
   * keep in step. Stable, so relative order inside each group survives.
   */
  function normalizePinned(pane) {
    if (!pane || !pane.pinned || pane.pinned.length === 0) return;

    const isPinned = path => pane.pinned.includes(path);
    const head = pane.tabs.filter(isPinned);
    const rest = pane.tabs.filter(path => !isPinned(path));
    pane.tabs = [...head, ...rest];
  }

  function setPinned(paneId, path, on) {
    const target = pane(paneId);
    if (!target || !target.tabs.includes(path)) return;

    target.pinned = target.pinned.filter(p => p !== path);
    if (on) target.pinned.push(path);

    normalizePinned(target);
  }

  function isPinned(paneId, path) {
    const target = pane(paneId);
    return !!target && Array.isArray(target.pinned) && target.pinned.includes(path);
  }

  function configure(next) { hooks = next || {}; }

  function reset() {
    root = newPane();
    activeId = root.id;
    return root;
  }

  // ---------- tree queries ----------

  function panes(node = root, out = []) {
    if (!node) return out;
    if (node.type === "pane") { out.push(node); return out; }
    for (const child of node.children) panes(child, out);
    return out;
  }

  function pane(id) {
    return panes().find(p => p.id === id) || null;
  }

  function activePane() {
    return pane(activeId) || panes()[0] || null;
  }

  function setActive(id) {
    if (pane(id)) activeId = id;
  }

  function parentOf(target, node = root) {
    if (!node || node.type === "pane") return null;
    if (node.children.includes(target)) return node;

    for (const child of node.children) {
      const found = parentOf(target, child);
      if (found) return found;
    }
    return null;
  }

  /** Every path open anywhere, so the host can drop watchers for the rest. */
  function openPaths() {
    const seen = new Set();
    for (const p of panes()) for (const path of p.tabs) seen.add(path);
    return [...seen];
  }

  function panesShowing(path) {
    return panes().filter(p => p.tabs.includes(path));
  }

  // ---------- mutation ----------

  function addTab(paneId, path, { activate = true, index = null } = {}) {
    const target = pane(paneId) || activePane();
    if (!target) return null;

    if (!target.tabs.includes(path)) {
      if (index === null) target.tabs.push(path);
      else target.tabs.splice(Math.max(0, Math.min(index, target.tabs.length)), 0, path);
    }
    if (activate) { target.active = path; activeId = target.id; }
    return target;
  }

  function closeTab(paneId, path) {
    const target = pane(paneId);
    if (!target) return;

    const index = target.tabs.indexOf(path);
    if (index < 0) return;

    target.tabs.splice(index, 1);
    delete target.anchors[path];
    delete target.modes[path];
    // A pin must not outlive its tab, or reopening the file would silently pin it.
    if (Array.isArray(target.pinned)) target.pinned = target.pinned.filter(p => p !== path);

    if (target.active === path) {
      target.active = target.tabs[Math.min(index, target.tabs.length - 1)] ?? null;
    }

    // An empty pane collapses, and its sibling takes over the space. The last
    // remaining pane stays put -- there must always be somewhere to open a file.
    if (target.tabs.length === 0 && panes().length > 1) removePane(target.id);
  }

  function removePane(paneId) {
    const target = pane(paneId);
    if (!target || target === root) return;

    const parent = parentOf(target);
    if (!parent) return;

    const sibling = parent.children.find(child => child !== target);
    const grandparent = parentOf(parent);

    if (!grandparent) {
      root = sibling;
    } else {
      grandparent.children[grandparent.children.indexOf(parent)] = sibling;
    }

    if (activeId === paneId) activeId = panes()[0]?.id ?? null;
  }

  /**
   * Replaces a pane with a split containing it and a new empty pane.
   * `dir` is the flex direction: "row" puts them side by side, "col" stacks them.
   */
  function split(paneId, dir, placeBefore = false) {
    const target = pane(paneId);
    if (!target) return null;

    const created = newPane();
    const parent = parentOf(target);

    const node = {
      type: "split",
      dir,
      sizes: [0.5, 0.5],
      children: placeBefore ? [created, target] : [target, created]
    };

    if (!parent) root = node;
    else parent.children[parent.children.indexOf(target)] = node;

    activeId = created.id;
    return created;
  }

  /**
   * Moves a tab between panes, collapsing the source if it empties. An insertion
   * index places the tab within the target strip; without one it goes to the end.
   */
  function moveTab(fromPaneId, path, toPaneId, index = null) {
    if (fromPaneId === toPaneId) {
      const target = pane(toPaneId);
      const oldIndex = target ? target.tabs.indexOf(path) : -1;

      if (oldIndex >= 0 && index !== null) {
        // Taking the tab out first shifts everything after its old slot left one.
        target.tabs.splice(oldIndex, 1);
        const at = Math.min(index > oldIndex ? index - 1 : index, target.tabs.length);
        target.tabs.splice(Math.max(0, at), 0, path);
      }
      // Dragging an unpinned tab into the pinned run, or the other way, would otherwise
      // leave the strip in an order the pin rule says is impossible.
      normalizePinned(target);
      addTab(toPaneId, path);
      return;
    }

    const from = pane(fromPaneId);
    const anchor = from ? from.anchors[path] : null;

    addTab(toPaneId, path, { index });

    const to = pane(toPaneId);
    if (to && anchor) to.anchors[path] = anchor;

    if (from) closeTab(fromPaneId, path);
  }

  // ---------- persistence ----------

  function serialize(node = root) {
    if (node.type === "pane") {
      // Zoom rides along with the pane rather than being keyed by pane id: ids are
      // regenerated on restore, so an external map would not line up again.
      return {
        type: "pane",
        tabs: [...node.tabs],
        active: node.active,
        modes: { ...node.modes },
        // Reading position per tab, so a restored session lands where it was left
        // rather than at the top of a long document.
        anchors: { ...node.anchors },
        zoom: node.zoom ?? 1,
        pinned: [...(node.pinned ?? [])]
      };
    }
    return {
      type: "split",
      dir: node.dir,
      sizes: [...node.sizes],
      children: node.children.map(serialize)
    };
  }

  function deserialize(data) {
    if (!data || data.type !== "split") {
      const restored = newPane(data?.tabs ?? [], data?.active ?? null);
      restored.zoom = typeof data?.zoom === "number" ? data.zoom : 1;
      restored.modes = data?.modes && typeof data.modes === "object" ? { ...data.modes } : {};
      restored.anchors = data?.anchors && typeof data.anchors === "object" ? { ...data.anchors } : {};
      // Only pins for tabs that actually came back, so a pin cannot outlive its tab.
      restored.pinned = Array.isArray(data?.pinned)
        ? data.pinned.filter(path => restored.tabs.includes(path))
        : [];
      normalizePinned(restored);
      return restored;
    }
    const node = {
      type: "split",
      dir: data.dir === "col" ? "col" : "row",
      sizes: Array.isArray(data.sizes) && data.sizes.length === 2 ? [...data.sizes] : [0.5, 0.5],
      children: data.children.map(deserialize)
    };
    return node;
  }

  function restore(data) {
    root = deserialize(data);
    activeId = panes()[0]?.id ?? null;
    return root;
  }

  // ---------- rendering ----------

  let container = null;

  function mount(element) { container = element; }

  function render() {
    if (!container) return;

    container.replaceChildren(build(root));

    for (const p of panes()) {
      const element = container.querySelector(`[data-pane-id="${CSS.escape(p.id)}"]`);
      if (element && hooks.renderPane) hooks.renderPane(p, element);
    }
  }

  function build(node) {
    if (node.type === "pane") return buildPane(node);

    const wrapper = document.createElement("div");
    wrapper.className = "split split-" + node.dir;

    const first = build(node.children[0]);
    first.style.flex = `${node.sizes[0]} 1 0px`;

    const divider = document.createElement("div");
    divider.className = "divider divider-" + node.dir;
    divider.addEventListener("mousedown", event => beginDrag(event, node, wrapper));

    const second = build(node.children[1]);
    second.style.flex = `${node.sizes[1]} 1 0px`;

    wrapper.append(first, divider, second);
    return wrapper;
  }

  function buildPane(node) {
    const element = document.createElement("section");
    element.className = "pane" + (node.id === activeId ? " pane-active" : "");
    element.dataset.paneId = node.id;
    element.dataset.zoomScope = "pane:" + node.id;

    element.addEventListener("mousedown", () => {
      if (activeId === node.id) return;
      activeId = node.id;
      if (hooks.onActivePaneChanged) hooks.onActivePaneChanged(node.id);
    });

    return element;
  }

  // ---------- divider dragging ----------

  function beginDrag(event, node, wrapper) {
    event.preventDefault();

    const horizontal = node.dir === "row";
    const rect = wrapper.getBoundingClientRect();
    const total = horizontal ? rect.width : rect.height;
    if (total <= 0) return;

    document.body.classList.add(horizontal ? "resizing-col" : "resizing-row");

    function onMove(moveEvent) {
      const offset = horizontal ? moveEvent.clientX - rect.left : moveEvent.clientY - rect.top;
      const ratio = Math.min(0.85, Math.max(0.15, offset / total));

      node.sizes = [ratio, 1 - ratio];

      const children = [...wrapper.children].filter(c => !c.classList.contains("divider"));
      if (children[0]) children[0].style.flex = `${node.sizes[0]} 1 0px`;
      if (children[1]) children[1].style.flex = `${node.sizes[1]} 1 0px`;
    }

    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.classList.remove("resizing-col", "resizing-row");
      if (hooks.onLayoutChanged) hooks.onLayoutChanged();
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  // ---------- drop zones ----------

  /** Which part of a pane the pointer is over: an edge splits, the middle moves. */
  function dropZone(element, event) {
    const rect = element.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;

    const edge = 0.25;
    const fromEdge = Math.min(x, 1 - x, y, 1 - y);
    if (fromEdge > edge) return "center";

    if (Math.min(x, 1 - x) < Math.min(y, 1 - y)) return x < 0.5 ? "left" : "right";
    return y < 0.5 ? "top" : "bottom";
  }

  /** Applies a drop: either move the tab into the pane, or split and place it. */
  function applyDrop(fromPaneId, path, toPaneId, zone) {
    if (zone === "center") {
      moveTab(fromPaneId, path, toPaneId);
      return;
    }

    const dir = zone === "left" || zone === "right" ? "row" : "col";
    const before = zone === "left" || zone === "top";

    const created = split(toPaneId, dir, before);
    if (!created) return;

    moveTab(fromPaneId, path, created.id);
  }

  reset();

  return {
    configure, mount, render, reset,
    panes, pane, activePane, setActive, openPaths, panesShowing,
    addTab, closeTab, removePane, split, moveTab,
    setPinned, isPinned,
    serialize, restore,
    dropZone, applyDrop,
    get root() { return root; },
    get activeId() { return activeId; }
  };
})();
