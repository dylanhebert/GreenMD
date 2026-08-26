"use strict";

/**
 * The workspace sidebar and quick-open.
 *
 * A workspace is a folder. The host sends a flat list of entries with parent
 * references and this builds the tree from it — flat is easier to diff and to
 * serialise than a nested structure, and the tree is rebuilt from scratch on every
 * change anyway (53 files rebuild in well under a frame).
 */
window.Workspace = (() => {

  let data = null;
  let expanded = new Set();
  let hooks = {};

  let treeEl = null;
  let nameEl = null;
  let sidebarEl = null;
  let quickEl = null;
  let quickInputEl = null;
  let quickListEl = null;

  let quickMatches = [];
  let quickIndex = 0;

  function configure(next) {
    hooks = next || {};

    sidebarEl = document.getElementById("sidebar");
    treeEl = document.getElementById("tree");
    nameEl = document.getElementById("workspaceName");
    quickEl = document.getElementById("quickOpen");
    quickInputEl = document.getElementById("quickInput");
    quickListEl = document.getElementById("quickList");

    treeEl.addEventListener("click", onTreeClick);
    quickInputEl.addEventListener("input", () => { quickIndex = 0; renderQuick(); });
    quickInputEl.addEventListener("keydown", onQuickKey);
    quickListEl.addEventListener("click", onQuickClick);
    quickEl.addEventListener("mousedown", event => { if (event.target === quickEl) closeQuick(); });
  }

  // ---------- state ----------

  function set(next) {
    data = next && !next.closed ? next : null;

    if (data) {
      // Expand the root's immediate children by default so the sidebar is not a
      // single collapsed row on first open.
      if (expanded.size === 0) {
        for (const entry of data.entries) {
          if (entry.dir && entry.parent === data.root) expanded.add(entry.path);
        }
      }
    } else {
      expanded = new Set();
    }

    render();
  }

  function root() { return data ? data.root : null; }

  function expandedPaths() { return [...expanded]; }

  function setExpanded(paths) {
    expanded = new Set(paths || []);
  }

  function files() {
    return data ? data.entries.filter(e => !e.dir) : [];
  }

  // ---------- tree ----------

  function childrenOf(parent) {
    return data ? data.entries.filter(e => e.parent === parent) : [];
  }

  function render() {
    if (!sidebarEl) return;

    sidebarEl.hidden = !data;
    if (!data) { treeEl.replaceChildren(); return; }

    nameEl.textContent = data.name;
    nameEl.title = data.root;

    treeEl.replaceChildren();
    build(data.root, 0, treeEl);

    if (data.truncated) {
      const note = document.createElement("div");
      note.className = "tree-note";
      note.textContent = "List truncated — folder is very large";
      treeEl.append(note);
    }

    if (!treeEl.childElementCount) {
      const note = document.createElement("div");
      note.className = "tree-note";
      note.textContent = "No markdown files here";
      treeEl.append(note);
    }
  }

  function build(parent, depth, container) {
    for (const entry of childrenOf(parent)) {
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
      label.textContent = entry.name;
      row.append(label);

      container.append(row);

      if (entry.dir && expanded.has(entry.path)) build(entry.path, depth + 1, container);
    }
  }

  function onTreeClick(event) {
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

  /** Marks which file the active pane is showing, so the tree tracks the reader. */
  function highlight(path) {
    if (!treeEl) return;
    for (const row of treeEl.querySelectorAll(".tree-file")) {
      row.classList.toggle("current", row.dataset.path === path);
    }
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

  function openQuick() {
    if (!data) { if (hooks.onNoWorkspace) hooks.onNoWorkspace(); return; }

    quickEl.hidden = false;
    quickInputEl.value = "";
    quickIndex = 0;
    renderQuick();
    quickInputEl.focus();
  }

  function closeQuick() {
    quickEl.hidden = true;
  }

  function isQuickOpen() {
    return quickEl && !quickEl.hidden;
  }

  function renderQuick() {
    const query = quickInputEl.value.trim();
    const rootLength = data.root.length + 1;

    quickMatches = files()
      .map(entry => ({ entry, relative: entry.path.slice(rootLength) }))
      .map(item => ({ ...item, rank: query ? score(item.relative, query) : 0 }))
      .filter(item => item.rank >= 0)
      .sort((a, b) => b.rank - a.rank || a.relative.localeCompare(b.relative))
      .slice(0, 40);

    quickListEl.replaceChildren();

    for (const [index, item] of quickMatches.entries()) {
      const row = document.createElement("div");
      row.className = "quick-row" + (index === quickIndex ? " selected" : "");
      row.dataset.path = item.entry.path;

      const name = document.createElement("span");
      name.className = "quick-name";
      name.textContent = item.entry.name;

      const where = document.createElement("span");
      where.className = "quick-path";
      const folder = item.relative.slice(0, Math.max(0, item.relative.length - item.entry.name.length - 1));
      where.textContent = folder;

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
    if (path && hooks.onOpenFile) hooks.onOpenFile(path);
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
    configure, set, render, root, files,
    expandedPaths, setExpanded, highlight,
    openQuick, closeQuick, isQuickOpen
  };
})();
