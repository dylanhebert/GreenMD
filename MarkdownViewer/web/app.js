"use strict";

const host = window.chrome && window.chrome.webview;

const panesEl = document.getElementById("panes");
const pulseEl = document.getElementById("pulse");
const statusTextEl = document.getElementById("statusText");
const statusRightEl = document.getElementById("statusRight");
const assocButtonEl = document.getElementById("assocButton");
const outlineEl = document.getElementById("outline");
const outlineTitleEl = document.getElementById("outlineTitle");
const openFolderEl = document.getElementById("openFolder");
const closeWorkspaceEl = document.getElementById("closeWorkspace");
const findBarEl = document.getElementById("findBar");
const findInputEl = document.getElementById("findInput");
const findCountEl = document.getElementById("findCount");
const findScopeEl = document.getElementById("findScope");

/** path -> { path, title, folder, html, outline, missing, loadedAt } */
const docs = new Map();

/** Set while a tab is being dragged; dataTransfer alone is awkward to read on dragover. */
let dragging = null;

let welcome = null;

/** Most-recently-opened paths, newest first. Persisted with the session. */
let recents = [];
const RECENT_LIMIT = 25;

function noteRecent(path) {
  recents = [path, ...recents.filter(p => p !== path)].slice(0, RECENT_LIMIT);
}

function post(type, payload) {
  host.postMessage({ type, payload: payload ?? null });
}

// ---------- helpers ----------

function shortFolder(folder) {
  if (!folder) return "";
  const parts = folder.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 3) return folder;
  return "…\\" + parts.slice(-3).join("\\");
}

function relativeTime(iso) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";

  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return seconds + "s ago";

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + "m ago";

  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + "h ago";

  return new Date(then).toLocaleDateString();
}

function modeOf(pane, path) {
  return pane.modes && pane.modes[path] === "edit" ? "edit" : "view";
}

function editorElementOf(pane) {
  return panesEl.querySelector(`[data-pane-id="${CSS.escape(pane.id)}"] .editor`);
}

function noticeElementOf(pane) {
  return panesEl.querySelector(`[data-pane-id="${CSS.escape(pane.id)}"] .pane-notice`);
}

function docElementOf(pane) {
  return panesEl.querySelector(`[data-pane-id="${CSS.escape(pane.id)}"] .doc`);
}

// ---------- scroll anchoring ----------

function captureAnchor(scroller) {
  if (!scroller) return null;

  const top = scroller.scrollTop;
  const atBottom = scroller.scrollHeight - top - scroller.clientHeight < 48;

  let id = null;
  let delta = top;

  for (const heading of scroller.querySelectorAll("h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]")) {
    if (heading.offsetTop > top + 8) break;
    id = heading.id;
    delta = top - heading.offsetTop;
  }

  return { id, delta, atBottom };
}

function restoreAnchor(scroller, anchor) {
  if (!scroller) return;
  if (!anchor) { scroller.scrollTop = 0; return; }

  // Follow mode: sitting at the bottom means watching the file grow.
  if (anchor.atBottom) { scroller.scrollTop = scroller.scrollHeight; return; }

  if (anchor.id) {
    const target = scroller.querySelector(`[id="${CSS.escape(anchor.id)}"]`);
    if (target) { scroller.scrollTop = Math.max(0, target.offsetTop + anchor.delta); return; }
  }

  scroller.scrollTop = anchor.delta;
}

function rememberAnchors() {
  for (const pane of Layout.panes()) {
    if (!pane.active) continue;
    const scroller = docElementOf(pane);
    if (scroller) pane.anchors[pane.active] = captureAnchor(scroller);
  }
}

// ---------- content painting ----------

function addCopyButtons(root) {
  for (const pre of root.querySelectorAll("pre")) {
    const button = document.createElement("button");
    button.className = "copy";
    button.type = "button";
    button.textContent = "Copy";
    button.addEventListener("click", async () => {
      const code = pre.querySelector("code");
      try {
        await navigator.clipboard.writeText(code ? code.textContent : pre.textContent);
        button.textContent = "Copied";
      } catch {
        button.textContent = "Failed";
      }
      setTimeout(() => { button.textContent = "Copy"; }, 1200);
    });
    pre.append(button);
  }
}

function paintDoc(pane) {
  const scroller = docElementOf(pane);
  if (!scroller) return;

  const doc = pane.active ? docs.get(pane.active) : null;

  if (!doc) {
    // Only the very first pane shows the welcome text; a new empty split stays blank.
    const isOnly = Layout.panes().length === 1;
    scroller.innerHTML = isOnly && welcome ? welcome.html : "";
    scroller.scrollTop = 0;
    return;
  }

  scroller.innerHTML = doc.html;
  HL.highlightAll(scroller);
  addCopyButtons(scroller);
  restoreAnchor(scroller, pane.anchors[pane.active]);

  // A live reload replaces the DOM and takes the highlights with it.
  if (!findBarEl.hidden && Layout.activeId === pane.id) {
    Find.reapply(scroller);
    updateFindCount();
  }
}

function buildTabstrip(pane, element) {
  const strip = document.createElement("div");
  strip.className = "tabstrip";

  for (const path of pane.tabs) {
    const doc = docs.get(path);
    const tab = document.createElement("div");
    tab.className = "tab"
      + (path === pane.active ? " active" : "")
      + (doc && doc.missing ? " missing" : "");
    tab.dataset.path = path;
    tab.draggable = true;
    tab.title = path;

    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = doc ? doc.title : path.split(/[\\/]/).pop();
    tab.append(label);

    const close = document.createElement("button");
    close.className = "tab-close";
    close.type = "button";
    close.textContent = "×";
    close.dataset.close = path;
    close.setAttribute("aria-label", "Close");
    tab.append(close);

    tab.addEventListener("dragstart", event => {
      dragging = { paneId: pane.id, path };
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", path);
      tab.classList.add("dragging");
    });
    tab.addEventListener("dragend", () => {
      dragging = null;
      tab.classList.remove("dragging");
      clearDropHints();
    });

    strip.append(tab);
  }

  const add = document.createElement("button");
  add.className = "tab-add";
  add.type = "button";
  add.textContent = "+";
  add.title = "Open a file (Ctrl+O)";
  add.addEventListener("click", () => { Layout.setActive(pane.id); post("pick-file"); });
  strip.append(add);

  element.append(strip);
}

function buildHeader(pane, element) {
  const doc = pane.active ? docs.get(pane.active) : null;

  const header = document.createElement("header");
  header.className = "dochead";

  const id = document.createElement("div");
  id.className = "dochead-id";

  const name = document.createElement("span");
  name.className = "dochead-name";
  name.textContent = doc ? doc.title : "";

  const folder = document.createElement("span");
  folder.className = "dochead-folder";
  if (doc) {
    folder.textContent = shortFolder(doc.folder);
    folder.title = doc.folder || "";
  }

  id.append(name, folder);

  const meta = document.createElement("div");
  meta.className = "dochead-meta";

  const updated = document.createElement("span");
  updated.className = "dochead-updated";
  updated.dataset.updated = doc ? doc.loadedAt : "";
  updated.textContent = doc && doc.loadedAt ? "updated " + relativeTime(doc.loadedAt) : "";

  const mode = document.createElement("button");
  mode.className = "mode-button";
  mode.type = "button";
  mode.textContent = "Edit";
  mode.title = "Toggle source editing (Ctrl+E)";
  mode.addEventListener("click", () => { Layout.setActive(pane.id); toggleMode(pane); });

  const badge = document.createElement("button");
  badge.className = "zoom-badge";
  badge.type = "button";
  badge.setAttribute("data-zoom-badge", "");
  badge.title = "Reset text size to 100%";

  meta.append(updated, mode, badge);
  header.append(id, meta);
  element.append(header);
}

/** Called by Layout for each pane after the skeleton is rebuilt. */
function renderPane(pane, element) {
  buildTabstrip(pane, element);
  buildHeader(pane, element);

  const notice = document.createElement("div");
  notice.className = "pane-notice";
  notice.hidden = true;
  element.append(notice);

  const scroller = document.createElement("main");
  scroller.className = "doc";
  scroller.tabIndex = -1;
  scroller.setAttribute("data-zoom-target", "");
  element.append(scroller);

  // rAF-throttled: scroll fires far more often than the outline needs updating.
  let scheduled = false;
  scroller.addEventListener("scroll", () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (Layout.activeId === pane.id) syncOutlineHighlight();
    });
  }, { passive: true });

  const editor = document.createElement("textarea");
  editor.className = "editor";
  editor.spellcheck = false;
  editor.hidden = true;
  editor.setAttribute("data-zoom-target", "");
  editor.addEventListener("input", () => {
    if (!pane.active) return;
    Editor.setText(pane.id, pane.active, editor.value);
    refreshDirtyMarks();
  });
  element.append(editor);

  const hint = document.createElement("div");
  hint.className = "drop-hint";
  element.append(hint);

  Zoom.register("pane:" + pane.id, 15, pane.zoom ?? 1);
  Zoom.apply("pane:" + pane.id);

  paintDoc(pane);
  applyMode(pane);
}

// ---------- edit mode ----------

/**
 * Shows either the rendered document or the source. Requesting the text lazily keeps
 * the source off the wire for the common read-only case.
 */
function applyMode(pane) {
  const scroller = docElementOf(pane);
  const editor = editorElementOf(pane);
  if (!scroller || !editor) return;

  const editing = pane.active ? modeOf(pane, pane.active) === "edit" : false;

  scroller.hidden = editing;
  editor.hidden = !editing;

  const button = panesEl.querySelector(`[data-pane-id="${CSS.escape(pane.id)}"] .mode-button`);
  if (button) {
    button.textContent = editing ? "Editing" : "Edit";
    button.classList.toggle("editing", editing);
  }

  if (!editing || !pane.active) { updateNotice(pane); return; }

  const text = Editor.textOf(pane.id, pane.active);
  if (text === null) {
    Editor.buffer(pane.id, pane.active);
    post("get-text", pane.active);
    editor.value = "";
    editor.placeholder = "Loading…";
  } else {
    editor.value = text;
  }

  updateNotice(pane);
}

function updateNotice(pane) {
  const notice = noticeElementOf(pane);
  if (!notice) return;

  const stale = pane.active && modeOf(pane, pane.active) === "edit"
                && Editor.isStale(pane.id, pane.active);

  if (!stale) { notice.hidden = true; notice.replaceChildren(); return; }

  notice.hidden = false;
  notice.replaceChildren();
  notice.append("This file changed on disk while you were editing.");

  const discard = document.createElement("button");
  discard.type = "button";
  discard.textContent = "Discard mine";
  discard.addEventListener("click", () => {
    Editor.forget(pane.id, pane.active);
    post("get-text", pane.active);
    applyMode(pane);
  });

  const overwrite = document.createElement("button");
  overwrite.type = "button";
  overwrite.textContent = "Keep mine";
  overwrite.addEventListener("click", () => saveActive(true));

  notice.append(discard, overwrite);
}

function toggleMode(pane) {
  if (!pane || !pane.active) return;

  pane.modes[pane.active] = modeOf(pane, pane.active) === "edit" ? "view" : "edit";
  applyMode(pane);
  refreshDirtyMarks();
  saveSession();

  const editor = editorElementOf(pane);
  if (editor && !editor.hidden) editor.focus();
}

function saveActive(force) {
  const pane = Layout.activePane();
  if (!pane || !pane.active) return;

  const text = Editor.textOf(pane.id, pane.active);
  if (text === null) return;

  post("save-doc", { path: pane.active, text, force: !!force });
}

/** Dirty state lives per buffer, but the marker belongs on the tab. */
function refreshDirtyMarks() {
  for (const pane of Layout.panes()) {
    for (const path of pane.tabs) {
      const tab = panesEl.querySelector(
        `[data-pane-id="${CSS.escape(pane.id)}"] [data-path="${CSS.escape(path)}"]`);
      if (tab) tab.classList.toggle("dirty", Editor.isDirty(pane.id, path));
    }
  }
}

function renderAll({ keepAnchors = true, save = true } = {}) {
  if (keepAnchors) rememberAnchors();
  Layout.render();
  refreshOutline();
  refreshStatus();

  const pane = Layout.activePane();
  Workspace.highlight(pane && pane.active ? pane.active : null);

  for (const p of Layout.panes()) applyMode(p);
  refreshDirtyMarks();

  reportTitle();

  const active = pane && pane.active ? docs.get(pane.active) : null;
  if (!findBarEl.hidden) {
    findScopeEl.textContent = active ? active.title : "";
    Find.run(findTarget(), findInputEl.value);
    updateFindCount();
  }

  if (save) saveSession();
}

// ---------- outline ----------

/** The last heading at or above the top of the viewport -- what the reader is under. */
function currentHeadingId(scroller) {
  if (!scroller) return null;

  const top = scroller.scrollTop;
  let id = null;

  for (const heading of scroller.querySelectorAll("h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]")) {
    if (heading.offsetTop > top + 12) break;
    id = heading.id;
  }
  return id;
}

function syncOutlineHighlight() {
  const pane = Layout.activePane();
  const id = pane ? currentHeadingId(docElementOf(pane)) : null;

  for (const link of outlineEl.querySelectorAll("a")) {
    link.classList.toggle("current", decodeURIComponent(link.hash.slice(1)) === id);
  }
}

function refreshOutline() {
  const pane = Layout.activePane();
  const doc = pane && pane.active ? docs.get(pane.active) : null;

  outlineTitleEl.textContent = doc ? "Outline" : "Outline";
  outlineEl.replaceChildren();

  for (const heading of (doc ? doc.outline : []) || []) {
    if (heading.level > 4) continue;
    const link = document.createElement("a");
    link.href = "#" + heading.id;
    link.dataset.level = String(heading.level);
    link.textContent = heading.text;
    link.title = heading.text;
    outlineEl.append(link);
  }

  syncOutlineHighlight();
}

outlineEl.addEventListener("click", (event) => {
  const link = event.target.closest("a");
  if (!link) return;
  event.preventDefault();

  const pane = Layout.activePane();
  const scroller = pane ? docElementOf(pane) : null;
  if (!scroller) return;

  const target = scroller.querySelector(`[id="${CSS.escape(decodeURIComponent(link.hash.slice(1)))}"]`);
  if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
});

// ---------- status ----------

function refreshStatus(flash) {
  const pane = Layout.activePane();
  const doc = pane && pane.active ? docs.get(pane.active) : null;

  statusTextEl.textContent = doc
    ? (doc.missing ? "File is missing from disk" : doc.path)
    : "No document open";

  const paneCount = Layout.panes().length;
  statusRightEl.textContent = paneCount > 1 ? `${paneCount} panes` : "";

  if (!flash) return;

  pulseEl.classList.remove("live");
  void pulseEl.offsetWidth;
  pulseEl.classList.add("live");
}

/** Ticks the "updated 4s ago" stamps without rebuilding any panes. */
setInterval(() => {
  for (const element of panesEl.querySelectorAll(".dochead-updated")) {
    const iso = element.dataset.updated;
    element.textContent = iso ? "updated " + relativeTime(iso) : "";
  }
}, 5000);

// ---------- drag and drop between panes ----------

function clearDropHints() {
  for (const pane of panesEl.querySelectorAll(".pane")) {
    pane.classList.remove("drop-center", "drop-left", "drop-right", "drop-top", "drop-bottom");
  }
}

panesEl.addEventListener("dragover", (event) => {
  if (!dragging) return;

  const paneEl = event.target.closest(".pane");
  if (!paneEl) return;

  event.preventDefault();
  event.dataTransfer.dropEffect = "move";

  const zone = Layout.dropZone(paneEl, event);
  clearDropHints();
  paneEl.classList.add("drop-" + zone);
});

panesEl.addEventListener("dragleave", (event) => {
  if (!event.relatedTarget || !panesEl.contains(event.relatedTarget)) clearDropHints();
});

panesEl.addEventListener("drop", (event) => {
  if (!dragging) return;

  const paneEl = event.target.closest(".pane");
  if (!paneEl) return;

  event.preventDefault();

  const zone = Layout.dropZone(paneEl, event);
  const { paneId, path } = dragging;
  dragging = null;
  clearDropHints();

  // Dropping a pane's only tab back onto itself is a no-op, not a split.
  if (paneId === paneEl.dataset.paneId && zone === "center") return;

  rememberAnchors();
  Layout.applyDrop(paneId, path, paneEl.dataset.paneId, zone);
  renderAll({ keepAnchors: false });
  syncOpenPaths();
});

// ---------- clicks inside panes ----------

panesEl.addEventListener("change", (event) => {
  const box = event.target.closest("input.task[data-task]");
  if (!box) return;

  const paneEl = box.closest(".pane");
  const pane = paneEl ? Layout.pane(paneEl.dataset.paneId) : null;
  if (!pane || !pane.active) return;

  post("toggle-task", {
    path: pane.active,
    index: Number(box.dataset.task),
    checked: box.checked
  });
});

panesEl.addEventListener("click", (event) => {
  const paneEl = event.target.closest(".pane");
  if (!paneEl) return;
  const paneId = paneEl.dataset.paneId;

  const close = event.target.closest("[data-close]");
  if (close) {
    event.stopPropagation();
    rememberAnchors();
    Layout.closeTab(paneId, close.dataset.close);
    renderAll({ keepAnchors: false });
    syncOpenPaths();
    return;
  }

  const tab = event.target.closest("[data-path]");
  if (tab) {
    rememberAnchors();
    const pane = Layout.pane(paneId);
    if (pane) { pane.active = tab.dataset.path; Layout.setActive(paneId); }
    renderAll({ keepAnchors: false });
    return;
  }

  const link = event.target.closest(".doc a[href]");
  if (!link) return;

  const href = link.getAttribute("href");

  if (href.startsWith("#")) {
    event.preventDefault();
    const scroller = paneEl.querySelector(".doc");
    const target = scroller?.querySelector(`[id="${CSS.escape(decodeURIComponent(href.slice(1)))}"]`);
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }

  if (href.startsWith("https://mdopen.local/")) {
    event.preventDefault();
    Layout.setActive(paneId);
    post("open-file", decodeURIComponent(href.slice("https://mdopen.local/".length).split("#")[0]));
    return;
  }

  if (href.startsWith("http://") || href.startsWith("https://")) {
    event.preventDefault();
    post("open-external", href);
  }
});

panesEl.addEventListener("auxclick", (event) => {
  if (event.button !== 1) return;
  const tab = event.target.closest("[data-path]");
  const paneEl = event.target.closest(".pane");
  if (!tab || !paneEl) return;

  event.preventDefault();
  rememberAnchors();
  Layout.closeTab(paneEl.dataset.paneId, tab.dataset.path);
  renderAll({ keepAnchors: false });
  syncOpenPaths();
});

// ---------- host messages ----------

/** The host cannot know which pane is active, so the UI owns the window title. */
function reportTitle() {
  const pane = Layout.activePane();
  const active = pane && pane.active ? docs.get(pane.active) : null;
  post("set-title", active ? active.title : null);
}

function syncOpenPaths() {
  post("sync-open", Layout.openPaths());
}

/** Rebuilds one pane's tab strip and header without touching its scroll position. */
function refreshPaneChrome(pane) {
  const element = panesEl.querySelector(`[data-pane-id="${CSS.escape(pane.id)}"]`);
  if (!element) return;

  element.querySelector(".tabstrip")?.remove();
  element.querySelector(".dochead")?.remove();

  const scroller = element.querySelector(".doc");
  buildTabstrip(pane, element);
  buildHeader(pane, element);

  // Both were appended at the end; put them back above the document.
  if (scroller) element.insertBefore(scroller, null);
  Zoom.apply("pane:" + pane.id);
}

function restoreSession(state) {
  if (!state) return;

  if (Array.isArray(state.recents)) recents = state.recents.slice(0, RECENT_LIMIT);
  if (Array.isArray(state.expanded)) Workspace.setExpanded(state.expanded);
  if (state.layout) Layout.restore(state.layout);

  renderAll({ keepAnchors: false, save: false });

  const paths = Layout.openPaths();
  if (paths.length) post("load-docs", paths);
}

let sessionTimer = null;

/** Debounced -- a burst of tab operations should not be a burst of messages. */
function saveSession() {
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    post("save-session", {
      workspace: Workspace.root(),
      expanded: Workspace.expandedPaths(),
      recents,
      layout: Layout.serialize()
    });
  }, 400);
}

host.addEventListener("message", (event) => {
  const { type, payload } = event.data;

  switch (type) {
    case "welcome":
      welcome = payload;
      renderAll();
      break;

    case "workspace":
      Workspace.set(payload);
      refreshStatus();
      saveSession();
      break;

    case "session":
      restoreSession(payload);
      break;

    case "doc-content": {
      // Content for a restored tab: fill it in without creating a new tab.
      docs.set(payload.path, payload);
      for (const pane of Layout.panesShowing(payload.path)) {
        if (pane.active === payload.path) paintDoc(pane);
        refreshPaneChrome(pane);
        applyMode(pane);
      }
      refreshOutline();
      refreshStatus();
      for (const p of Layout.panes()) applyMode(p);
  refreshDirtyMarks();

  reportTitle();
      break;
    }

    case "doc-text":
      Editor.receiveText(payload.path, payload.text);
      for (const pane of Layout.panesShowing(payload.path)) applyMode(pane);
      refreshDirtyMarks();
      break;

    case "save-result":
      if (payload.saved) {
        Editor.markSaved(payload.path);
        refreshDirtyMarks();
        for (const pane of Layout.panesShowing(payload.path)) updateNotice(pane);
        statusTextEl.textContent = "Saved " + payload.path.split(/[\/]/).pop();
      } else if (payload.conflict) {
        statusTextEl.textContent = "Not saved — the file changed on disk. Use “Keep mine” to overwrite.";
        for (const pane of Layout.panesShowing(payload.path)) {
          if (pane.active === payload.path) Editor.buffer(pane.id, payload.path).staleOnDisk = true;
          updateNotice(pane);
        }
      } else {
        statusTextEl.textContent = "Could not save " + payload.path.split(/[\/]/).pop();
      }
      break;

    case "association":
      assocButtonEl.hidden = payload.registered;
      assocButtonEl.title = payload.exe;
      break;

    case "downloading":
      statusTextEl.textContent = "Downloading " + payload.title + " from OneDrive…";
      break;

    case "error":
      statusTextEl.textContent = payload.message;
      break;

    case "doc-opened": {
      docs.set(payload.path, payload);
      noteRecent(payload.path);
      rememberAnchors();
      Layout.addTab(Layout.activeId, payload.path);
      renderAll({ keepAnchors: false });
      syncOpenPaths();
      break;
    }

    case "doc-updated": {
      docs.set(payload.path, payload);

      // Repaint only the panes showing this file, so an update in one pane never
      // disturbs the reader's position in another.
      for (const pane of Layout.panesShowing(payload.path)) {
        if (pane.active !== payload.path) continue;

        const scroller = docElementOf(pane);
        if (scroller) pane.anchors[payload.path] = captureAnchor(scroller);
        paintDoc(pane);

        const paneEl = panesEl.querySelector(`[data-pane-id="${CSS.escape(pane.id)}"]`);
        const updated = paneEl?.querySelector(".dochead-updated");
        if (updated) {
          updated.dataset.updated = payload.loadedAt;
          updated.textContent = "updated " + relativeTime(payload.loadedAt);
          updated.classList.add("flash");
          setTimeout(() => updated.classList.remove("flash"), 1600);
        }
      }

      // Tabs that are not the active one just get a dot.
      for (const pane of Layout.panesShowing(payload.path)) {
        if (pane.active === payload.path) continue;
        const tab = panesEl.querySelector(
          `[data-pane-id="${CSS.escape(pane.id)}"] [data-path="${CSS.escape(payload.path)}"]`);
        if (tab) {
          tab.classList.add("changed");
          setTimeout(() => tab.classList.remove("changed"), 2500);
        }
      }

      if (Editor.noteExternalChange(payload.path)) post("get-text", payload.path);
      for (const pane of Layout.panesShowing(payload.path)) updateNotice(pane);

      refreshOutline();
      refreshStatus(true);
      break;
    }
  }
});

// ---------- keyboard ----------

document.addEventListener("keydown", (event) => {
  // The overlay handles its own keys; Escape closes it from anywhere.
  if (Workspace.isQuickOpen()) {
    if (event.key === "Escape") Workspace.closeQuick();
    return;
  }

  if (event.key === "Escape" && !findBarEl.hidden) {
    event.preventDefault();
    closeFind();
    return;
  }

  if (!event.ctrlKey && !event.metaKey) return;

  const scope = Zoom.hoveredScope() || ("pane:" + Layout.activeId);
  const pane = Layout.activePane();

  switch (event.key) {
    case "o":
      event.preventDefault();
      post("pick-file");
      return;

    case "e":
      event.preventDefault();
      toggleMode(Layout.activePane());
      return;

    case "s":
      event.preventDefault();
      saveActive(false);
      return;

    case "f":
      event.preventDefault();
      openFind();
      return;

    case "k":
      event.preventDefault();
      post("pick-folder");
      return;

    case "p":
      event.preventDefault();
      Workspace.openQuick(recents);
      return;

    case "w":
      event.preventDefault();
      if (pane && pane.active) {
        rememberAnchors();
        Layout.closeTab(pane.id, pane.active);
        renderAll({ keepAnchors: false });
        syncOpenPaths();
      }
      return;

    case "0": event.preventDefault(); Zoom.set(scope, 1); return;
    case "+":
    case "=": event.preventDefault(); Zoom.nudge(scope, 1); return;
    case "-": event.preventDefault(); Zoom.nudge(scope, -1); return;

    case "\\":
      event.preventDefault();
      if (pane) {
        rememberAnchors();
        const created = Layout.split(pane.id, event.shiftKey ? "col" : "row");
        // Carry the current document into the new pane so the split is useful at once.
        if (created && pane.active) Layout.addTab(created.id, pane.active);
        renderAll({ keepAnchors: false });
      }
      return;
  }

  if (event.key === "Tab" && pane && pane.tabs.length > 1) {
    event.preventDefault();
    const index = pane.tabs.indexOf(pane.active);
    const next = event.shiftKey
      ? (index - 1 + pane.tabs.length) % pane.tabs.length
      : (index + 1) % pane.tabs.length;

    rememberAnchors();
    pane.active = pane.tabs[next];
    renderAll({ keepAnchors: false });
  }
});

// ---------- find ----------

function findTarget() {
  const pane = Layout.activePane();
  return pane ? docElementOf(pane) : null;
}

function updateFindCount() {
  findCountEl.textContent = Find.query
    ? (Find.count ? `${Find.position} of ${Find.count}` : "no results")
    : "";
}

function openFind() {
  const pane = Layout.activePane();
  const doc = pane && pane.active ? docs.get(pane.active) : null;

  findBarEl.hidden = false;
  findScopeEl.textContent = doc ? doc.title : "";
  findInputEl.focus();
  findInputEl.select();

  if (findInputEl.value) runFind();
}

function closeFind() {
  Find.clear();
  findBarEl.hidden = true;
  findCountEl.textContent = "";
}

function runFind() {
  Find.run(findTarget(), findInputEl.value);
  updateFindCount();
}

findInputEl.addEventListener("input", runFind);

findInputEl.addEventListener("keydown", (event) => {
  if (event.key === "Escape") { event.preventDefault(); closeFind(); return; }
  if (event.key !== "Enter") return;

  event.preventDefault();
  if (event.shiftKey) Find.previous(); else Find.next();
  updateFindCount();
});

document.getElementById("findNext").addEventListener("click", () => { Find.next(); updateFindCount(); });
document.getElementById("findPrev").addEventListener("click", () => { Find.previous(); updateFindCount(); });
document.getElementById("findClose").addEventListener("click", closeFind);

openFolderEl.addEventListener("click", () => post("pick-folder"));

closeWorkspaceEl.addEventListener("click", () => {
  post("close-workspace");
  Workspace.set(null);
  saveSession();
});

assocButtonEl.addEventListener("click", () => {
  post("register-association");
  statusTextEl.textContent =
    "Registered. Windows will ask you to confirm the default the next time you open a .md file.";
});

// ---------- boot ----------

Zoom.configure({
  before(name) {
    const id = name.startsWith("pane:") ? name.slice(5) : null;
    const pane = id ? Layout.pane(id) : null;
    return pane ? { pane, anchor: captureAnchor(docElementOf(pane)) } : null;
  },
  after(name, token) {
    if (token) {
      token.pane.zoom = Zoom.levelOf(name);
      restoreAnchor(docElementOf(token.pane), token.anchor);
    }
    saveSession();
  }
});

Workspace.configure({
  onOpenFile(path) { post("open-file", path); },
  onChanged() { saveSession(); },
  onNoWorkspace() { statusTextEl.textContent = "Nothing recent yet — open a folder with Ctrl+K"; }
});

Zoom.register("outline", 13);
Zoom.register("tree", 13);

Layout.configure({
  renderPane,
  onActivePaneChanged() { refreshOutline(); refreshStatus(); highlightActivePane(); },
  onLayoutChanged() { /* sizes already applied inline */ }
});

function highlightActivePane() {
  for (const element of panesEl.querySelectorAll(".pane")) {
    element.classList.toggle("pane-active", element.dataset.paneId === Layout.activeId);
  }
}

Layout.mount(panesEl);
Zoom.applyAll();
renderAll({ keepAnchors: false });
post("ready");

// ---------- layout diagnostic ----------
//
// Reasoning about this layout from screenshots has not worked. This reports what the
// real window actually measured, including which stylesheet rules are live, so a
// stale cached asset is distinguishable from a bad rule.

function measureLayout() {
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };

  const shell = document.querySelector(".shell");
  const body = document.querySelector(".body");
  const panes = document.querySelector(".panes");
  const aside = document.querySelector(".pane-outline");
  const status = document.querySelector(".status");
  const pane = document.querySelector(".pane");
  const doc = document.querySelector(".pane .doc");
  const links = [...document.querySelectorAll("#outline a")];

  const shellStyle = shell ? getComputedStyle(shell) : null;
  const bodyStyle = body ? getComputedStyle(body) : null;

  return {
    viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
    computed: {
      shellDisplay: shellStyle?.display,
      shellFlexDirection: shellStyle?.flexDirection,
      shellGridRows: shellStyle?.gridTemplateRows,
      shellHeight: shellStyle?.height,
      bodyDisplay: bodyStyle?.display,
      bodyFlex: bodyStyle?.flex,
      bodyGridColumns: bodyStyle?.gridTemplateColumns,
      htmlHeight: getComputedStyle(document.documentElement).height,
      bodyElHeight: getComputedStyle(document.body).height
    },
    boxes: {
      shell: box(shell), body: box(body), panes: box(panes),
      outlineAside: box(aside), status: box(status), pane: box(pane), doc: box(doc)
    },
    verdict: {
      bodyFillsWidth: body ? Math.abs(box(body).w - window.innerWidth) <= 1 : null,
      bodyFillsHeight: body && status
        ? Math.abs(box(body).h - (window.innerHeight - box(status).h)) <= 2 : null,
      statusOnBottomEdge: status
        ? Math.abs((box(status).y + box(status).h) - window.innerHeight) <= 2 : null,
      outlineFullHeight: aside && body ? Math.abs(box(aside).h - box(body).h) <= 2 : null,
      // The checks that were missing: the previous verdict passed while the outline
      // sat entirely off the right-hand edge.
      outlineOnScreen: aside ? box(aside).x + box(aside).w <= window.innerWidth + 1 : null,
      childrenTileBody: (panes && aside && body)
        ? Math.abs((box(panes).w + box(aside).w) - box(body).w) <= 2 : null
    },
    outline: {
      count: links.length,
      firstWidth: links[0] ? Math.round(links[0].getBoundingClientRect().width) : null,
      anyTruncating: links.some(a => a.scrollWidth > a.clientWidth)
    },
    shellChildren: shell ? [...shell.children].map(c => ({
      tag: c.tagName.toLowerCase(),
      cls: c.className,
      hidden: c.hidden,
      display: getComputedStyle(c).display,
      box: box(c)
    })) : []
  };
}

host.addEventListener("message", (event) => {
  if (event.data.type !== "dump-layout") return;
  // Two frames so layout and any pending paint have settled.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    post("layout-dump", measureLayout());
  }));
});

// ---------- state diagnostic ----------
//
// Streams what the UI actually holds, so "the stamp did not update" can be traced to
// either a missing host message or a UI that received one and did nothing with it.

let stateDumping = false;
const messageLog = [];

function snapshotState() {
  const panes = Layout.panes().map(pane => ({
    id: pane.id,
    active: pane.active,
    tabs: pane.tabs.length,
    headerStamp: (() => {
      const el = panesEl.querySelector(`[data-pane-id="${CSS.escape(pane.id)}"] .dochead-updated`);
      return el ? { text: el.textContent, dataset: el.dataset.updated } : null;
    })()
  }));

  return {
    now: new Date().toISOString(),
    panes,
    docs: [...docs.values()].map(d => ({ path: d.path, loadedAt: d.loadedAt })),
    recentMessages: messageLog.slice(-25)
  };
}

// Record every inbound message type before anything else handles it.
host.addEventListener("message", (event) => {
  messageLog.push({
    t: new Date().toISOString().slice(11, 23),
    type: event.data.type,
    path: event.data.payload && event.data.payload.path ? String(event.data.payload.path).split(/[\/]/).pop() : undefined,
    loadedAt: event.data.payload && event.data.payload.loadedAt
  });
  if (messageLog.length > 200) messageLog.shift();

  if (event.data.type !== "dump-state") return;
  if (stateDumping) return;

  stateDumping = true;
  post("state-dump", snapshotState());
  setInterval(() => post("state-dump", snapshotState()), 2000);
});
