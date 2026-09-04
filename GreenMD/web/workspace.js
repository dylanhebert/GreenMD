"use strict";

/**
 * The workspace sidebar and quick-open.
 *
 * A workspace is a folder, and several can be open at once. Each becomes a stacked
 * section with its own scrolling tree, and the dividers between them redistribute
 * vertical space. Sections keep a minimum height, so with enough folders open the
 * sidebar itself scrolls rather than squeezing every tree down to nothing.
 *
 * The host sends a flat entry list per folder and this builds the trees from it: flat
 * is easier to diff and to serialise than a nested structure, and the trees are
 * rebuilt from scratch on every change anyway.
 */
window.Workspace = (() => {

  const MIN_SECTION_PX = 90;

  /** [{ root, name, truncated, entries }] */
  let workspaces = [];

  /** Absolute paths of expanded folders, across every workspace. */
  let expanded = new Set();

  /** Roots whose whole section is collapsed to its header. */
  let collapsed = new Set();

  /** root -> flex weight. Relative, so a split survives a window resize. */
  let weights = new Map();

  /**
   * Elsewhere's height in pixels, or null for "as tall as its contents".
   *
   * Pixels rather than a share of the panel like the folder sections use. It has no
   * root to key a weight by, it disappears entirely when nothing is open from outside
   * a folder, and it is usually three rows -- a proportion of the panel is the wrong
   * unit for something whose natural size is "small and specific".
   */
  let elsewhereHeight = null;

  let visible = true;

  /** The file the active pane is showing. Owned here so a rebuild cannot lose it. */
  let currentPath = null;

  /** Paths open in any tab, those in source mode, and those pinned in any pane. */
  let openPaths = new Set();
  let editingPaths = new Set();
  let pinnedFiles = new Set();

  /** Unsaved edits, and changes not yet marked as seen. Mirrors what the tabs show. */
  let dirtyFiles = new Set();
  let changedFiles = new Set();
  let createdFiles = new Set();

  let hooks = {};

  let sidebarEl = null;
  let sectionsEl = null;
  let quickEl = null;
  let quickInputEl = null;
  let quickListEl = null;

  let quickMatches = [];
  let quickIndex = 0;
  let quickSource = null;   // null = the open workspaces; otherwise an explicit list

  function configure(next) {
    hooks = next || {};

    sidebarEl = document.getElementById("sidebar");
    sectionsEl = document.getElementById("workspaceSections");
    quickEl = document.getElementById("quickOpen");
    quickInputEl = document.getElementById("quickInput");
    quickListEl = document.getElementById("quickList");

    sectionsEl.addEventListener("click", onSectionClick);

    // Double-click commits the file rather than peeking it. The single clicks that
    // precede this have already opened it, so this only upgrades its standing -- which
    // is why it needs no guard against the click handler having run.
    sectionsEl.addEventListener("dblclick", event => {
      const row = event.target.closest("[data-path]");
      if (!row || row.dataset.dir) return;
      if (hooks.onOpenFilePermanent) hooks.onOpenFilePermanent(row.dataset.path);
    });

    // Right-clicking a folder's header offers to clear every dot under it. Sweeping a
    // whole folder is the gesture that suits coming back to one after a week away, and
    // doing it file by file would not.
    sectionsEl.addEventListener("contextmenu", event => {
      const header = event.target.closest("[data-toggle-root]");
      if (!header) return;

      event.preventDefault();
      if (hooks.onFolderMenu) hooks.onFolderMenu(event, header.dataset.toggleRoot);
    });
    quickInputEl.addEventListener("input", () => { quickIndex = 0; renderQuick(); });
    quickInputEl.addEventListener("keydown", onQuickKey);
    quickListEl.addEventListener("click", onQuickClick);
    quickEl.addEventListener("mousedown", event => { if (event.target === quickEl) closeQuick(); });
  }

  // ---------- state ----------

  function set(payload) {
    workspaces = payload && Array.isArray(payload.workspaces) ? payload.workspaces : [];

    const open = new Set(workspaces.map(w => w.root));

    // Forget state for folders that are no longer open.
    for (const root of [...collapsed]) if (!open.has(root)) collapsed.delete(root);
    for (const root of [...weights.keys()]) if (!open.has(root)) weights.delete(root);

    for (const workspace of workspaces) {
      if (!weights.has(workspace.root)) weights.set(workspace.root, 1);

      // Expand a newly opened folder's immediate children so it is not a single row.
      const alreadyKnown = workspace.entries.some(e => e.dir && expanded.has(e.path));
      if (!alreadyKnown) {
        for (const entry of workspace.entries) {
          if (entry.dir && entry.parent === workspace.root) expanded.add(entry.path);
        }
      }
    }

    render();
  }

  function roots() { return workspaces.map(w => w.root); }
  function hasWorkspace() { return workspaces.length > 0; }
  function setVisible(next) { visible = !!next; render(); }
  function isVisible() { return visible; }

  function expandedPaths() { return [...expanded]; }
  function setExpanded(paths) { expanded = new Set(paths || []); }

  function collapsedRoots() { return [...collapsed]; }
  function setCollapsedRoots(list) { collapsed = new Set(list || []); }

  function elsewhereSize() { return elsewhereHeight; }
  function setElsewhereSize(px) {
    elsewhereHeight = typeof px === "number" && px > 0 ? px : null;
  }

  function sectionWeights() { return Object.fromEntries(weights); }
  function setSectionWeights(map) {
    weights = new Map();
    for (const [root, weight] of Object.entries(map || {})) {
      if (typeof weight === "number" && weight > 0) weights.set(root, weight);
    }
  }

  /** Every markdown file across every open folder. */
  function files() {
    return workspaces.flatMap(w => w.entries.filter(e => !e.dir).map(e => ({ ...e, root: w.root })));
  }

  // ---------- documents outside every open folder ----------
  //
  // A doc opened from Explorer, or from a folder that was never added, appeared nowhere
  // in this panel at all -- it existed only as a tab and in the recent list. These list
  // them, grouped by the folder they actually live in, because that grouping is also the
  // answer to "which folder should I add?": each group offers to become one.

  const BACKSLASH = String.fromCharCode(92);

  /** The same trailing-.md rule the tabs and the recent list apply. */
  function stripMd(name) {
    return /\.md$/i.test(name) ? name.slice(0, -3) : name;
  }

  /** One marker element on a tree row, hidden until its state is live. */
  function rowMark(kind, glyph) {
    const mark = document.createElement("span");
    mark.className = "tree-mark tree-mark-" + kind;
    mark.dataset.mark = kind;
    mark.textContent = glyph;
    mark.hidden = true;
    mark.setAttribute("aria-hidden", "true");
    return mark;
  }

  function setRowMark(row, kind, on) {
    const mark = row.querySelector('[data-mark="' + kind + '"]');
    if (mark) mark.hidden = !on;
  }

  function lastSeparator(path) {
    return Math.max(path.lastIndexOf("/"), path.lastIndexOf(BACKSLASH));
  }

  function parentOf(path) {
    const cut = lastSeparator(path);
    return cut > 0 ? path.slice(0, cut) : "";
  }

  function baseNameOf(path) {
    const cut = lastSeparator(path);
    return cut >= 0 ? path.slice(cut + 1) : path;
  }

  /** Trailing separators stripped, so a root stored with one still matches. */
  function underRoot(path, root) {
    let stem = root.toLowerCase();
    while (stem.length > 1 && (stem.endsWith("/") || stem.endsWith(BACKSLASH))) {
      stem = stem.slice(0, -1);
    }

    const candidate = path.toLowerCase();
    // The separator check matters: without it C:\docs2 counts as inside C:\docs.
    return candidate === stem
      || candidate.startsWith(stem + "/")
      || candidate.startsWith(stem + BACKSLASH);
  }

  function isElsewhere(path) {
    // An untitled note has no folder to be outside of yet.
    if (!path || path.startsWith("untitled:")) return false;
    return !workspaces.some(workspace => underRoot(path, workspace.root));
  }

  /** parent folder -> the open documents in it that no workspace covers. */
  function elsewhereGroups() {
    const groups = new Map();

    for (const path of [...openPaths].sort()) {
      if (!isElsewhere(path)) continue;

      const parent = parentOf(path) || path;
      if (!groups.has(parent)) groups.set(parent, []);
      groups.get(parent).push(path);
    }

    return groups;
  }

  /** Cheap identity for the orphan set, so a render only happens when it moves. */
  function elsewhereKey() {
    return [...openPaths].filter(isElsewhere).sort().join("|");
  }

  function buildElsewhere(groups) {
    const section = document.createElement("section");
    // No data-root: applyWeights walks the workspaces, so this one keeps its natural
    // height instead of competing for a share of the panel.
    section.className = "ws-section elsewhere";

    const header = document.createElement("header");
    header.className = "ws-header";
    header.title = "Open documents that are not inside any folder you have added";

    const name = document.createElement("span");
    name.className = "ws-name";
    name.textContent = "Elsewhere";

    const count = document.createElement("span");
    count.className = "ws-count";
    count.textContent = String([...groups.values()].reduce((n, list) => n + list.length, 0));

    header.append(name, count);
    section.append(header);

    const tree = document.createElement("div");
    tree.className = "tree";
    tree.setAttribute("data-zoom-target", "");

    for (const [parent, paths] of groups) {
      const group = document.createElement("div");
      group.className = "elsewhere-group";
      group.title = parent;

      const label = document.createElement("span");
      label.className = "elsewhere-group-name";
      label.textContent = baseNameOf(parent) || parent;

      const adopt = document.createElement("button");
      adopt.className = "icon-button";
      adopt.type = "button";
      adopt.dataset.adoptRoot = parent;
      adopt.textContent = "+";
      adopt.title = "Add this folder to the sidebar";
      adopt.setAttribute("aria-label", "Add " + parent + " to the sidebar");

      group.append(label, adopt);
      tree.append(group);

      for (const path of paths) {
        const row = document.createElement("div");
        row.className = "tree-file";
        row.dataset.path = path;
        row.dataset.dir = "";
        row.style.paddingLeft = "21px";
        row.title = path;

        const rowLabel = document.createElement("span");
        rowLabel.className = "tree-label";
        rowLabel.textContent = stripMd(baseNameOf(path));
        row.append(rowLabel, rowMark("dirty", "●"), rowMark("changed", ""), rowMark("created", ""), rowMark("editing", "✎"), rowMark("pinned", "◆"));

        tree.append(row);
      }
    }

    section.append(tree);
    return section;
  }

  // ---------- rendering ----------

  function render() {
    if (!sidebarEl) return;

    const groups = elsewhereGroups();
    const empty = workspaces.length === 0 && groups.size === 0;

    // The panel now earns its place with no folder open at all, as long as something
    // is open from somewhere.
    sidebarEl.hidden = empty || !visible;
    sectionsEl.replaceChildren();
    if (empty) return;

    workspaces.forEach((workspace, index) => {
      if (index > 0) sectionsEl.append(buildDivider(workspaces[index - 1], workspace));
      sectionsEl.append(buildSection(workspace));
    });

    if (groups.size > 0) {
      // Only draggable when there is something above to take the space from.
      if (workspaces.length > 0) sectionsEl.append(buildElsewhereDivider());
      sectionsEl.append(buildElsewhere(groups));
    }

    applyWeights();
    applyElsewhereHeight();

    // render() replaces every row, so the marker is reapplied here rather than only
    // when the active document changes.
    applyCurrent();
  }

  function buildSection(workspace) {
    const isCollapsed = collapsed.has(workspace.root);

    const section = document.createElement("section");
    section.className = "ws-section" + (isCollapsed ? " collapsed" : "");
    section.dataset.root = workspace.root;

    const header = document.createElement("header");
    header.className = "ws-header";
    header.dataset.toggleRoot = workspace.root;
    header.title = workspace.root;

    const caret = document.createElement("span");
    caret.className = "tree-caret";
    caret.textContent = isCollapsed ? "▸" : "▾";

    const name = document.createElement("span");
    name.className = "ws-name";
    name.textContent = workspace.name;

    const count = document.createElement("span");
    count.className = "ws-count";
    count.textContent = String(workspace.entries.filter(e => !e.dir).length);

    const close = document.createElement("button");
    close.className = "icon-button";
    close.type = "button";
    close.dataset.closeRoot = workspace.root;
    close.textContent = "×";
    close.title = "Close this folder";
    close.setAttribute("aria-label", "Close " + workspace.name);

    header.append(caret, name, count, close);
    section.append(header);

    if (isCollapsed) return section;

    const tree = document.createElement("div");
    tree.className = "tree";
    tree.setAttribute("data-zoom-target", "");
    build(workspace, workspace.root, 0, tree);

    if (workspace.truncated) {
      const note = document.createElement("div");
      note.className = "tree-note";
      note.textContent = "List truncated — folder is very large";
      tree.append(note);
    }

    if (!tree.childElementCount) {
      const note = document.createElement("div");
      note.className = "tree-note";
      note.textContent = "No markdown files here";
      tree.append(note);
    }

    section.append(tree);
    return section;
  }

  function build(workspace, parent, depth, container) {
    for (const entry of workspace.entries.filter(e => e.parent === parent)) {
      const row = document.createElement("div");
      row.className = entry.dir ? "tree-dir" : "tree-file";
      row.dataset.path = entry.path;
      row.dataset.dir = entry.dir ? "1" : "";
      row.style.paddingLeft = (8 + depth * 13) + "px";
      row.title = entry.path;

      if (entry.dir) {
        const caret = document.createElement("span");
        caret.className = "tree-caret";
        caret.textContent = expanded.has(entry.path) ? "▾" : "▸";
        row.append(caret);
      }

      const label = document.createElement("span");
      label.className = "tree-label";
      label.textContent = entry.dir ? entry.name : stripMd(entry.name);
      row.append(label);

      if (!entry.dir) row.append(rowMark("dirty", "●"), rowMark("changed", ""), rowMark("created", ""), rowMark("editing", "✎"), rowMark("pinned", "◆"));

      container.append(row);

      if (entry.dir && expanded.has(entry.path)) build(workspace, entry.path, depth + 1, container);
    }
  }

  function elsewhereElement() {
    return sectionsEl ? sectionsEl.querySelector(".ws-section.elsewhere") : null;
  }

  function applyElsewhereHeight() {
    const section = elsewhereElement();
    if (!section) return;

    section.style.flex = elsewhereHeight === null
      ? "0 0 auto"
      : "0 0 " + Math.round(elsewhereHeight) + "px";
  }

  function buildElsewhereDivider() {
    const divider = document.createElement("div");
    divider.className = "ws-divider";
    divider.title = "Drag to resize, double-click to fit the contents";
    divider.addEventListener("mousedown", beginElsewhereDrag);

    // An explicit way back to auto: once dragged, there is otherwise no gesture that
    // returns it to "just as tall as it needs to be".
    divider.addEventListener("dblclick", () => {
      elsewhereHeight = null;
      applyElsewhereHeight();
      if (hooks.onChanged) hooks.onChanged();
    });

    return divider;
  }

  /** Dragging up grows Elsewhere, since it sits below the divider. */
  function beginElsewhereDrag(event) {
    event.preventDefault();

    const section = elsewhereElement();
    if (!section) return;

    const startY = event.clientY;
    const startHeight = section.getBoundingClientRect().height;
    const panel = sectionsEl.getBoundingClientRect().height;

    document.body.classList.add("resizing-row");

    function onMove(moveEvent) {
      const wanted = startHeight - (moveEvent.clientY - startY);
      // Leaves at least one folder section's minimum above it, so a drag to the top
      // cannot squeeze the trees out of existence.
      const ceiling = Math.max(MIN_SECTION_PX, panel - MIN_SECTION_PX);
      elsewhereHeight = Math.min(ceiling, Math.max(MIN_SECTION_PX, wanted));
      applyElsewhereHeight();
    }

    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.classList.remove("resizing-row");
      if (hooks.onChanged) hooks.onChanged();
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  function buildDivider(above, below) {
    const divider = document.createElement("div");
    divider.className = "ws-divider";
    divider.addEventListener("mousedown", event => beginDrag(event, above.root, below.root));
    return divider;
  }

  function sectionElement(root) {
    return sectionsEl.querySelector(`.ws-section[data-root="${CSS.escape(root)}"]`);
  }

  function applyWeights() {
    for (const workspace of workspaces) {
      const section = sectionElement(workspace.root);
      if (!section) continue;

      // A collapsed section is only its header, so it must not claim a share.
      section.style.flex = collapsed.has(workspace.root)
        ? "0 0 auto"
        : `${weights.get(workspace.root) ?? 1} 1 0`;
    }
  }

  // ---------- resizing ----------

  function beginDrag(event, aboveRoot, belowRoot) {
    event.preventDefault();

    const above = sectionElement(aboveRoot);
    const below = sectionElement(belowRoot);
    if (!above || !below) return;

    const startY = event.clientY;
    const aboveHeight = above.getBoundingClientRect().height;
    const total = aboveHeight + below.getBoundingClientRect().height;
    if (total <= 0) return;

    // Weights are relative, so the pair's existing share is redistributed between
    // them rather than pixels being assigned -- that keeps the split on resize.
    const share = (weights.get(aboveRoot) ?? 1) + (weights.get(belowRoot) ?? 1);

    document.body.classList.add("resizing-row");

    function onMove(moveEvent) {
      const wanted = aboveHeight + (moveEvent.clientY - startY);
      const clamped = Math.min(total - MIN_SECTION_PX, Math.max(MIN_SECTION_PX, wanted));

      weights.set(aboveRoot, share * (clamped / total));
      weights.set(belowRoot, share * ((total - clamped) / total));
      applyWeights();
    }

    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.classList.remove("resizing-row");
      if (hooks.onChanged) hooks.onChanged();
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  // ---------- interaction ----------

  function onSectionClick(event) {
    const adopt = event.target.closest("[data-adopt-root]");
    if (adopt) {
      event.stopPropagation();
      if (hooks.onAdoptFolder) hooks.onAdoptFolder(adopt.dataset.adoptRoot);
      return;
    }

    const close = event.target.closest("[data-close-root]");
    if (close) {
      event.stopPropagation();
      if (hooks.onCloseFolder) hooks.onCloseFolder(close.dataset.closeRoot);
      return;
    }

    const header = event.target.closest("[data-toggle-root]");
    if (header) {
      const root = header.dataset.toggleRoot;
      if (collapsed.has(root)) collapsed.delete(root); else collapsed.add(root);
      render();
      if (hooks.onChanged) hooks.onChanged();
      return;
    }

    const row = event.target.closest("[data-path]");
    if (!row) return;

    if (row.dataset.dir) {
      if (expanded.has(row.dataset.path)) expanded.delete(row.dataset.path);
      else expanded.add(row.dataset.path);
      render();
      if (hooks.onChanged) hooks.onChanged();
      return;
    }

    if (hooks.onOpenFile) hooks.onOpenFile(row.dataset.path);
  }

  // ---------- active file marker ----------

  function applyCurrent() {
    if (!sectionsEl) return;

    for (const row of sectionsEl.querySelectorAll(".tree-file")) {
      const path = row.dataset.path;
      row.classList.toggle("current", path === currentPath);
      row.classList.toggle("open", path !== currentPath && openPaths.has(path));
      row.classList.toggle("editing", editingPaths.has(path));
      row.classList.toggle("pinned", pinnedFiles.has(path));
      row.classList.toggle("dirty", dirtyFiles.has(path));
      row.classList.toggle("changed", changedFiles.has(path));
      row.classList.toggle("created", createdFiles.has(path));

      // Marks are real elements for the same reason the tab strip's are: .tree-label
      // truncates, so a marker painted at its trailing edge is clipped by exactly the
      // long filename that makes it worth showing -- and one ::after cannot carry four
      // states, so they would have overwritten each other.
      setRowMark(row, "dirty", dirtyFiles.has(path));
      setRowMark(row, "changed", changedFiles.has(path));
      setRowMark(row, "created", createdFiles.has(path));
      setRowMark(row, "editing", editingPaths.has(path));
      setRowMark(row, "pinned", pinnedFiles.has(path));
    }
  }

  /**
   * Every per-file state the panel paints, in one object.
   *
   * Taken as named fields rather than positional arguments because there are now five
   * of them and a sixth is coming with workspace-wide change tracking. A call reading
   * setOpenFiles(a, b, c, d, e) tells you nothing about which list is which.
   */
  function setOpenFiles(states) {
    const next = states || {};
    const before = elsewhereKey();

    openPaths = new Set(next.open || []);
    editingPaths = new Set(next.editing || []);
    pinnedFiles = new Set(next.pinned || []);
    dirtyFiles = new Set(next.dirty || []);
    changedFiles = new Set(next.changed || []);
    createdFiles = new Set(next.created || []);

    // The Elsewhere section is built from the open set, so it has to be rebuilt when
    // that set moves -- but only then. A render replaces every row in the panel, and
    // doing it on every tab switch would be wasteful and would fight the tree's own
    // scroll position.
    if (elsewhereKey() !== before) render(); else applyCurrent();
  }

  /** Expands whatever is hiding a path: its section, and its parent folders. */
  function revealAncestors(path) {
    if (!path) return false;

    const workspace = workspaces.find(w => w.entries.some(e => e.path === path));
    if (!workspace) return false;

    let changed = collapsed.delete(workspace.root);

    let entry = workspace.entries.find(e => e.path === path);
    while (entry && entry.parent && entry.parent !== workspace.root) {
      if (!expanded.has(entry.parent)) { expanded.add(entry.parent); changed = true; }
      entry = workspace.entries.find(e => e.path === entry.parent);
    }

    return changed;
  }

  /**
   * Marks which file the active pane is showing. Only reveals and scrolls when the
   * path actually changes, so collapsing the folder of the open file is not
   * immediately undone on the next render.
   */
  function highlight(path) {
    const moved = path !== currentPath;
    currentPath = path || null;

    if (moved && revealAncestors(currentPath)) {
      render();
      if (hooks.onChanged) hooks.onChanged();
    } else {
      applyCurrent();
    }

    if (!moved || !currentPath || !sectionsEl) return;

    const row = sectionsEl.querySelector(`.tree-file[data-path="${CSS.escape(currentPath)}"]`);
    if (row) row.scrollIntoView({ block: "nearest" });
  }

  // ---------- quick open ----------

  /**
   * Subsequence match, scored so that consecutive hits and matches right after a
   * path separator rank highest. Good enough at this scale and needs no index.
   */
  function score(text, query) {
    if (!query) return 0;

    const lower = text.toLowerCase();
    let index = 0;
    let total = 0;
    let previous = -2;

    for (const character of query.toLowerCase()) {
      const found = lower.indexOf(character, index);
      if (found < 0) return -1;

      total += found === previous + 1 ? 6 : 1;
      if (found === 0 || "\\/-_. ".includes(lower[found - 1])) total += 4;

      previous = found;
      index = found + 1;
    }

    // Prefer shorter paths when the score ties, so a top-level file beats a nested one.
    return total - text.length * 0.01;
  }

  /**
   * Opens the picker over every open folder, or over `fallback` (recent files) when no
   * folder is bound. Ctrl+P is worth having before anything is opened.
   */
  function openQuick(fallback) {
    quickSource = hasWorkspace() ? null : (fallback && fallback.length ? fallback : null);

    if (!hasWorkspace() && !quickSource) {
      if (hooks.onNoWorkspace) hooks.onNoWorkspace();
      return;
    }

    quickInputEl.placeholder = hasWorkspace() ? "Go to file" : "Recent files";
    quickEl.hidden = false;
    quickInputEl.value = "";
    quickIndex = 0;
    renderQuick();
    quickInputEl.focus();
  }

  function closeQuick() { quickEl.hidden = true; }
  function isQuickOpen() { return quickEl && !quickEl.hidden; }

  /** With several folders open a bare relative path is ambiguous, so it is prefixed. */
  function describe(entry) {
    if (!entry.root) {
      const name = entry.path.split(/[\\/]/).pop();
      return { name, where: entry.path, match: entry.path };
    }

    const workspace = workspaces.find(w => w.root === entry.root);
    const relative = entry.path.slice(entry.root.length + 1);
    const folder = relative.slice(0, Math.max(0, relative.length - entry.name.length - 1));
    const prefix = workspaces.length > 1 && workspace ? workspace.name + "\\" : "";

    return { name: entry.name, where: prefix + folder, match: prefix + relative };
  }

  function renderQuick() {
    const query = quickInputEl.value.trim();

    const entries = quickSource
      ? quickSource.map(path => ({ path, name: path.split(/[\\/]/).pop(), root: null }))
      : files();

    quickMatches = entries
      .map(entry => ({ entry, ...describe(entry) }))
      .map(item => ({ ...item, rank: query ? score(item.match, query) : 0 }))
      .filter(item => item.rank >= 0)
      .sort((a, b) => b.rank - a.rank || a.match.localeCompare(b.match))
      .slice(0, 40);

    quickListEl.replaceChildren();

    for (const [index, item] of quickMatches.entries()) {
      const row = document.createElement("div");
      row.className = "quick-row" + (index === quickIndex ? " selected" : "");
      row.dataset.path = item.entry.path;

      const name = document.createElement("span");
      name.className = "quick-name";
      name.textContent = item.name;

      const where = document.createElement("span");
      where.className = "quick-path";
      where.textContent = item.where;

      row.append(name, where);
      quickListEl.append(row);
    }

    if (!quickMatches.length) {
      const empty = document.createElement("div");
      empty.className = "quick-empty";
      empty.textContent = "No matching file";
      quickListEl.append(empty);
    }
  }

  function moveQuick(delta) {
    if (!quickMatches.length) return;
    quickIndex = (quickIndex + delta + quickMatches.length) % quickMatches.length;
    renderQuick();

    const selected = quickListEl.querySelector(".selected");
    if (selected) selected.scrollIntoView({ block: "nearest" });
  }

  function chooseQuick(path) {
    closeQuick();
    if (!path) return;

    // Permanent, not a peek. Typing a name to find one document is deliberate; it is
    // the opposite of clicking down a folder to see what is in it.
    if (hooks.onOpenFilePermanent) hooks.onOpenFilePermanent(path);
    else if (hooks.onOpenFile) hooks.onOpenFile(path);
  }

  function onQuickKey(event) {
    switch (event.key) {
      case "Escape": event.preventDefault(); closeQuick(); return;
      case "ArrowDown": event.preventDefault(); moveQuick(1); return;
      case "ArrowUp": event.preventDefault(); moveQuick(-1); return;
      case "Enter":
        event.preventDefault();
        chooseQuick(quickMatches[quickIndex]?.entry.path);
        return;
    }
  }

  function onQuickClick(event) {
    const row = event.target.closest("[data-path]");
    if (row) chooseQuick(row.dataset.path);
  }

  return {
    configure, set, render, files,
    roots, hasWorkspace, setVisible, isVisible,
    expandedPaths, setExpanded,
    collapsedRoots, setCollapsedRoots,
    sectionWeights, setSectionWeights,
    elsewhereSize, setElsewhereSize,
    highlight, setOpenFiles, currentFile: () => currentPath,
    openQuick, closeQuick, isQuickOpen
  };
})();
