"use strict";

const host = window.chrome && window.chrome.webview;

const panesEl = document.getElementById("panes");
const pulseEl = document.getElementById("pulse");
const statusTextEl = document.getElementById("statusText");
const statusRightEl = document.getElementById("statusRight");
const outlineEl = document.getElementById("outline");
const outlineTitleEl = document.getElementById("outlineTitle");
const openFolderEl = document.getElementById("openFolder");
const findBarEl = document.getElementById("findBar");
const findInputEl = document.getElementById("findInput");
const findCountEl = document.getElementById("findCount");
const findScopeEl = document.getElementById("findScope");
const toggleSidebarEl = document.getElementById("toggleSidebar");
const toggleOutlineEl = document.getElementById("toggleOutline");

/** path -> { path, title, folder, html, outline, missing, loadedAt } */
const docs = new Map();

/** Set while a tab is being dragged; dataTransfer alone is awkward to read on dragover. */
let dragging = null;

let welcome = null;

/** Whether the host reports this build as the registered .md handler. */
let associationRegistered = false;

/** Bumped per image refresh, so every asset-updated forces a refetch. */
let assetVersion = 0;

/** Most-recently-opened paths, newest first. Persisted with the session. */
let recents = [];
const RECENT_LIMIT = 25;

function noteRecent(path) {
  recents = [path, ...recents.filter(p => p !== path)].slice(0, RECENT_LIMIT);

  // The File menu lists these, so it has to be rebuilt whenever the order moves.
  // Guarded because a document can be recorded before the menu bar is configured.
  if (window.Menu) Menu.refresh();
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

/** Every path in source mode in any pane, for marking the tree and the tabs. */
function editingPaths() {
  const editing = new Set();
  for (const pane of Layout.panes()) {
    for (const path of pane.tabs) {
      if (modeOf(pane, path) === "edit") editing.add(path);
    }
  }
  return [...editing];
}

function modeOf(pane, path) {
  return pane.modes && pane.modes[path] === "edit" ? "edit" : "view";
}

function editorElementOf(pane) {
  return panesEl.querySelector(`[data-pane-id="${CSS.escape(pane.id)}"] .editor`);
}

function editorWrapOf(pane) {
  return panesEl.querySelector(`[data-pane-id="${CSS.escape(pane.id)}"] .editor-wrap`);
}

/** Repaints the highlighted layer from the textarea's current text. */
function paintHighlight(wrap) {
  const editor = wrap.querySelector(".editor");
  const code = wrap.querySelector(".editor-highlight code");
  if (!editor || !code) return;

  // A trailing newline collapses in a <pre>, so the last line would sit under the
  // caret without one. The extra space keeps the two layers aligned.
  const newline = String.fromCharCode(10);
  const text = editor.value.endsWith(newline) ? editor.value + " " : editor.value;
  code.innerHTML = HL.highlight(text, "markdown");
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
  // Not on diagram sources. The button's own label would otherwise be swept up by
  // textContent and fed to the parser as part of the diagram.
  for (const pre of root.querySelectorAll("pre:not(.mermaid)")) {
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

// ---------- mermaid ----------
//
// Loaded on first use rather than at startup: it is 2.5MB, and most documents have
// no diagrams in them. Vendored and served from the app's own origin, so it runs
// under script-src 'self' and reaches no network.

// The About box credits this, so it cannot be read off window.mermaid -- that object
// does not exist until a document with a diagram forces the load. vendor/README.md
// holds the authoritative version and tests/verify-vendor.mjs fails if the two drift,
// so this copy cannot go stale unnoticed.
const MERMAID_VERSION = "11.4.1";
const MERMAID_LICENCE = "MIT";

let mermaidLoading = null;

function ensureMermaid() {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  if (mermaidLoading) return mermaidLoading;

  mermaidLoading = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/vendor/mermaid.min.js";
    script.addEventListener("load", () => {
      if (!window.mermaid) { reject(new Error("mermaid did not register")); return; }

      window.mermaid.initialize({
        startOnLoad: false,
        theme: "dark",
        // Document content, so never fully trusted: antiscript keeps the <b> and
        // <br/> that real diagrams use for labels while stripping script. The page's
        // own script-src 'self' policy blocks inline handlers regardless.
        securityLevel: "antiscript",
        darkMode: true,
        fontFamily: '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif',
        themeVariables: {
          background: "#1e1e1c",
          primaryColor: "#23312c",
          primaryTextColor: "#e8e6e0",
          primaryBorderColor: "#01a982",
          lineColor: "#6f6d67",
          secondaryColor: "#23231f",
          tertiaryColor: "#1a1a18"
        }
      });
      resolve(window.mermaid);
    });
    script.addEventListener("error", () => reject(new Error("could not load mermaid")));
    document.head.append(script);
  });

  return mermaidLoading;
}

let mermaidSequence = 0;

/**
 * Replaces mermaid fences with rendered diagrams. Failures leave the source
 * visible with the reason attached rather than an empty box -- a diagram that
 * will not parse is usually a typo the reader can see and fix.
 */
async function renderMermaid(scroller) {
  // Markdig's advanced extensions include its Diagrams extension, which turns a
  // ```mermaid fence into <pre class="mermaid">source</pre> rather than an ordinary
  // code block. The div and code-block forms are accepted too, so this keeps working
  // if that extension is ever dropped from the pipeline.
  const blocks = [
    ...scroller.querySelectorAll("pre.mermaid:not([data-drawn]), div.mermaid:not([data-drawn])"),
    ...scroller.querySelectorAll("pre > code.language-mermaid")
  ];
  if (blocks.length === 0) return;

  let mermaid;
  try {
    mermaid = await ensureMermaid();
  } catch (error) {
    for (const block of blocks) markMermaidError(block.parentElement, error.message);
    return;
  }

  for (const block of blocks) {
    // A code-block fence replaces its <pre>; a Markdig diagram div replaces itself.
    const host = block.tagName === "CODE" ? block.parentElement : block;
    if (!host || !host.isConnected) continue;

    const source = block.textContent || "";
    if (!source.trim()) continue;

    mermaidSequence += 1;

    try {
      const { svg } = await mermaid.render("greenmd-mermaid-" + mermaidSequence, source);

      const figure = document.createElement("div");
      figure.className = "mermaid-figure";
      figure.dataset.drawn = "1";
      figure.innerHTML = svg;
      host.replaceWith(figure);
    } catch (error) {
      markMermaidError(host, error && error.message ? error.message : String(error));
    }
  }
}

function markMermaidError(host, message) {
  if (!host || !host.isConnected) return;

  // Keep the source readable rather than leaving an empty box: a diagram that will
  // not parse is usually a typo the reader can see.
  if (host.tagName === "DIV") {
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = host.textContent || "";
    pre.append(code);
    host.replaceWith(pre);
    host = pre;
  }

  host.classList.add("mermaid-failed");
  host.dataset.drawn = "1";

  const note = document.createElement("div");
  note.className = "mermaid-error";
  note.textContent = "Diagram could not be drawn: " + message;
  host.parentElement?.insertBefore(note, host);
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
  applyChangeMarks(scroller, pane.active);
  renderMermaid(scroller);
  restoreAnchor(scroller, pane.anchors[pane.active]);

  // A live reload replaces the DOM and takes the highlights with it.
  if (!findBarEl.hidden && Layout.activeId === pane.id) {
    Find.reapply(scroller);
    updateFindCount();
  }
}

/**
 * One tab indicator. The glyph is a literal character rather than a CSS escape: an
 * escape sequence in these files has been mangled by tooling before, and the changed
 * dot is drawn in CSS anyway so it carries no glyph at all.
 */
function tabMark(kind, glyph, on) {
  const mark = document.createElement("span");
  mark.className = "tab-mark tab-mark-" + kind;
  mark.dataset.mark = kind;
  mark.textContent = glyph;
  mark.hidden = !on;
  mark.setAttribute("aria-hidden", "true");
  return mark;
}

/** Shows or hides one indicator on an already-built tab. */
function setTabMark(tab, kind, on) {
  const mark = tab.querySelector('[data-mark="' + kind + '"]');
  if (mark) mark.hidden = !on;
}

function buildTabstrip(pane) {
  const strip = document.createElement("div");
  strip.className = "tabstrip";

  for (const path of pane.tabs) {
    const doc = docs.get(path);
    const tab = document.createElement("div");
    tab.className = "tab"
      + (path === pane.active ? " active" : "")
      + (doc && doc.missing ? " missing" : "")
      + (modeOf(pane, path) === "edit" ? " editing" : "")
      + (changeMarksVisible && changeMarks.has(path) ? " changed" : "");
    tab.dataset.path = path;
    tab.draggable = true;
    tab.title = path;

    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = doc ? doc.title : path.split(/[\\/]/).pop();

    // Indicators are siblings of the label, never painted onto it. The label is the box
    // that truncates, so anything at its trailing edge is cut off by exactly the long
    // filename that makes the indicator worth showing -- and a single ::after cannot
    // carry two states, so `changed` and `editing` used to silently overwrite each
    // other. Kept in the DOM and hidden rather than added and removed, so the two
    // places that toggle these states after a build only have to flip a flag.
    tab.append(
      tabMark("dirty", "●", Editor.isDirty(pane.id, path)),
      label,
      tabMark("changed", "", changeMarksVisible && changeMarks.has(path)),
      tabMark("editing", "✎", modeOf(pane, path) === "edit")
    );

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

  // A vertical wheel over the strip scrolls it sideways -- with many tabs open the
  // overflow is otherwise only reachable by dragging a 5px scrollbar.
  strip.addEventListener("wheel", (event) => {
    if (event.ctrlKey) return;                       // Ctrl+wheel is zoom
    if (strip.scrollWidth <= strip.clientWidth) return;
    event.preventDefault();
    strip.scrollLeft += event.deltaY !== 0 ? event.deltaY : event.deltaX;
  }, { passive: false });

  return strip;
}

function buildHeader(pane) {
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

  const unsaved = document.createElement("span");
  unsaved.className = "dochead-unsaved";
  unsaved.textContent = "unsaved — Ctrl+S";
  unsaved.hidden = !(pane.active && Editor.isDirty(pane.id, pane.active));

  const changes = document.createElement("button");
  changes.className = "dochead-changes";
  changes.type = "button";
  changes.title = "Changed since you last marked this document seen. Click to mark seen (Ctrl+M).";
  changes.addEventListener("click", () => { if (pane.active) dismissChangeMarks(pane.active); });
  const marks = changeMarksVisible && pane.active ? changeMarks.get(pane.active) : null;
  changes.hidden = !marks;
  if (marks) changes.textContent = changeChipText(marks);

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

  meta.append(unsaved, changes, updated, mode, badge);
  header.append(id, meta);
  return header;
}

/**
 * Called by Layout for each pane after the skeleton is rebuilt.
 * The child order here is the contract: tab strip, header, notice, then the two
 * content views. refreshPaneChrome must preserve it.
 */
function renderPane(pane, element) {
  element.append(buildTabstrip(pane), buildHeader(pane));

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
  let settle = null;

  scroller.addEventListener("scroll", () => {
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        if (Layout.activeId === pane.id) syncOutlineHighlight();
      });
    }

    // Reading position is only worth writing once scrolling has stopped.
    clearTimeout(settle);
    settle = setTimeout(() => {
      if (!pane.active) return;
      pane.anchors[pane.active] = captureAnchor(scroller);
      saveSession();
    }, 500);
  }, { passive: true });

  // A textarea cannot style its own text, so a highlighted layer sits behind a
  // transparent one. Both must share every metric that affects wrapping, which is
  // why the padding, font and white-space rules live on a shared selector.
  const wrap = document.createElement("div");
  wrap.className = "editor-wrap";
  wrap.hidden = true;
  wrap.setAttribute("data-zoom-target", "");

  const highlight = document.createElement("pre");
  highlight.className = "editor-highlight";
  highlight.setAttribute("aria-hidden", "true");
  highlight.append(document.createElement("code"));

  const editor = document.createElement("textarea");
  editor.className = "editor";
  editor.spellcheck = false;

  editor.addEventListener("input", () => {
    if (!pane.active) return;
    Editor.setText(pane.id, pane.active, editor.value);
    paintHighlight(wrap);
    refreshDirtyMarks();
  });

  // The highlight layer does not scroll itself; it follows the textarea.
  editor.addEventListener("scroll", () => {
    highlight.scrollTop = editor.scrollTop;
    highlight.scrollLeft = editor.scrollLeft;
  }, { passive: true });

  wrap.append(highlight, editor);
  element.append(wrap);

  const hint = document.createElement("div");
  hint.className = "drop-hint";
  element.append(hint);

  const activeTab = element.querySelector(".tab.active");
  if (activeTab) {
    const strip = element.querySelector(".tabstrip");
    if (strip && strip.scrollWidth > strip.clientWidth) {
      // Instant, not smooth: this runs during a render, not as a user gesture.
      const left = activeTab.offsetLeft - (strip.clientWidth - activeTab.offsetWidth) / 2;
      strip.scrollTo({ left: Math.max(0, left), behavior: "instant" });
    }
  }

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
  const wrap = editorWrapOf(pane);
  const editor = editorElementOf(pane);
  if (!scroller || !wrap || !editor) return;

  const editing = pane.active ? modeOf(pane, pane.active) === "edit" : false;

  scroller.hidden = editing;
  wrap.hidden = !editing;

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

  paintHighlight(wrap);
  updateNotice(pane);
}

/** Paths whose close was blocked because they had unsaved changes. */
const closeBlocked = new Map();

/** Closes a tab unconditionally. Callers go through requestCloseTab, not this. */
function closeTab(paneId, path) {
  rememberAnchors();
  Editor.forget(paneId, path);
  closeBlocked.delete(paneId);
  Layout.closeTab(paneId, path);
  renderAll({ keepAnchors: false });
  syncOpenPaths();
}

/**
 * Refuses to close a tab with unsaved changes and explains why. Silently discarding
 * an edit because a tab was closed is the one thing a viewer must never do.
 */
function requestCloseTab(paneId, path) {
  if (!Editor.isDirty(paneId, path)) { closeTab(paneId, path); return; }

  closeBlocked.set(paneId, path);
  const pane = Layout.pane(paneId);
  if (pane) {
    pane.active = path;
    Layout.setActive(paneId);
    renderAll({ keepAnchors: false });
  }
  statusTextEl.textContent = "Unsaved changes — save with Ctrl+S, or choose Discard.";
}

function updateNotice(pane) {
  const notice = noticeElementOf(pane);
  if (!notice) return;

  const blocked = closeBlocked.get(pane.id);
  if (blocked && pane.active === blocked && Editor.isDirty(pane.id, blocked)) {
    notice.hidden = false;
    notice.replaceChildren();
    notice.append("This tab has unsaved changes.");

    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "Save and close";
    save.addEventListener("click", () => { closeBlocked.set(pane.id, blocked); saveActive(false); });

    const discard = document.createElement("button");
    discard.type = "button";
    discard.textContent = "Discard and close";
    discard.addEventListener("click", () => {
      Editor.forget(pane.id, blocked);
      closeBlocked.delete(pane.id);
      closeTab(pane.id, blocked);
    });

    const keep = document.createElement("button");
    keep.type = "button";
    keep.textContent = "Keep editing";
    keep.addEventListener("click", () => {
      closeBlocked.delete(pane.id);
      updateNotice(pane);
    });

    notice.append(save, discard, keep);
    return;
  }

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
  refreshPaneChrome(pane);
  refreshDirtyMarks();
  Workspace.setOpenFiles(Layout.openPaths(), editingPaths());
  saveSession();

  const editor = editorElementOf(pane);
  if (editor && !editor.hidden) editor.focus();
}

// ---------- new files ----------

/** Untitled documents exist only in memory until their first save names them. */
const UNTITLED_PREFIX = "untitled:";
let untitledCounter = 0;

const isUntitled = path => typeof path === "string" && path.startsWith(UNTITLED_PREFIX);

function untitledDoc(path) {
  return { path, title: "Untitled", folder: "", html: "", outline: [],
           missing: false, loadedAt: new Date().toISOString() };
}

function newFile() {
  const pane = Layout.activePane();
  if (!pane) return;

  const path = UNTITLED_PREFIX + (++untitledCounter);
  docs.set(path, untitledDoc(path));

  rememberAnchors();
  Layout.addTab(pane.id, path);
  // Straight into edit mode with an empty, already-loaded buffer -- there is no
  // host round trip to make for a file that does not exist yet.
  Editor.setText(pane.id, path, "");
  pane.modes[path] = "edit";
  renderAll({ keepAnchors: false });
  syncOpenPaths();

  const editor = editorElementOf(pane);
  if (editor) editor.focus();
}

function saveActive(force) {
  const pane = Layout.activePane();
  if (!pane || !pane.active) return;

  const text = Editor.textOf(pane.id, pane.active);
  if (text === null) return;

  // An untitled buffer has nowhere to go yet: the host asks where, writes, and
  // answers saved-as, which swaps this tab over to the real file in place.
  if (isUntitled(pane.active)) {
    post("save-as", { from: pane.active, text });
    return;
  }

  // Do not let an unforced save leave here once the file has moved on disk. The host
  // decides conflicts by comparing the file against the hash it last read, and a live
  // reload refreshes that hash -- so after the watcher has seen an external change the
  // host compares disk against itself, reports no conflict, and the write lands on top
  // of somebody else's edit. This side still knows the buffer was based on older text,
  // so the choice goes to the reader instead. "Keep mine" passes force and overwrites
  // deliberately, which is the only way that should ever happen.
  if (!force && Editor.isStale(pane.id, pane.active)) {
    statusTextEl.textContent =
      "Not saved — the file changed on disk. Use “Keep mine” to overwrite, or “Discard mine”.";
    for (const showing of Layout.panesShowing(pane.active)) updateNotice(showing);
    return;
  }

  post("save-doc", { path: pane.active, text, force: !!force });
}

/** Dirty state lives per buffer, but the marker belongs on the tab. */
function refreshDirtyMarks() {
  for (const pane of Layout.panes()) {
    const badge = panesEl.querySelector(
      `[data-pane-id="${CSS.escape(pane.id)}"] .dochead-unsaved`);
    if (badge) badge.hidden = !(pane.active && Editor.isDirty(pane.id, pane.active));

    for (const path of pane.tabs) {
      const tab = panesEl.querySelector(
        `[data-pane-id="${CSS.escape(pane.id)}"] [data-path="${CSS.escape(path)}"]`);
      if (!tab) continue;

      const dirty = Editor.isDirty(pane.id, path);
      tab.classList.toggle("dirty", dirty);
      setTabMark(tab, "dirty", dirty);
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
  Workspace.setOpenFiles(Layout.openPaths(), editingPaths());

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
  Menu.refresh();
}

// ---------- change marks ----------
//
// Built for watching an agent rewrite a document: every reload is diffed against
// the version the reader last marked as seen -- not the previous render -- so marks
// accumulate until they are dismissed on purpose. Nothing fades on its own.

/** path -> the rendered html the reader last marked as seen. */
const changeBaselines = new Map();

/** path -> { changed: Set<blockIndex>, removedBefore: Set<blockIndex>, count } */
const changeMarks = new Map();

/** Paths whose next update is this app's own write (save, checkbox), not news. */
const selfChanged = new Set();

/**
 * Display toggle, persisted with the session. Tracking continues while hidden, so
 * turning marks back on shows everything accumulated since the last dismissal.
 */
let changeMarksVisible = true;

function setChangeMarksVisible(visible) {
  if (changeMarksVisible === visible) return;
  changeMarksVisible = visible;
  rememberAnchors();
  renderAll({ keepAnchors: false });
  statusTextEl.textContent = visible
    ? "Change marks shown."
    : "Change marks hidden — tracking continues in the background.";
}

function blocksOf(html) {
  const holder = document.createElement("template");
  holder.innerHTML = html;
  return [...holder.content.children].map(el => el.outerHTML);
}

/** Block-level diff, in new-side indexes: rewritten blocks, added blocks, removal points. */
function diffBlocks(oldBlocks, newBlocks) {
  // Edits are usually local; trimming the common ends keeps the quadratic core small.
  let start = 0;
  while (start < oldBlocks.length && start < newBlocks.length
         && oldBlocks[start] === newBlocks[start]) start++;

  let oldEnd = oldBlocks.length, newEnd = newBlocks.length;
  while (oldEnd > start && newEnd > start
         && oldBlocks[oldEnd - 1] === newBlocks[newEnd - 1]) { oldEnd--; newEnd--; }

  const rows = oldEnd - start, cols = newEnd - start;
  const lcs = Array.from({ length: rows + 1 }, () => new Array(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      lcs[i][j] = oldBlocks[start + i] === newBlocks[start + j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  // Consecutive edits form a run. Within one, inserts pair off against deletes as
  // rewrites, the surplus inserts are additions, and surplus deletes leave one
  // removal seam at the top of the run. `pairs` records which old block each
  // rewrite replaced, so a rewritten list can be diffed again at item level.
  const modified = new Set(), added = new Set(), removedBefore = new Set();
  const pairs = new Map();
  let runStart = null;
  const runInserts = [], runDeletes = [];

  const closeRun = () => {
    if (runStart === null) return;
    const pairCount = Math.min(runDeletes.length, runInserts.length);
    runInserts.forEach((index, n) => {
      if (n < pairCount) { modified.add(index); pairs.set(index, runDeletes[n]); }
      else added.add(index);
    });
    if (runDeletes.length > pairCount) removedBefore.add(runStart);
    runStart = null; runInserts.length = 0; runDeletes.length = 0;
  };

  let i = 0, j = 0;
  while (i < rows && j < cols) {
    if (oldBlocks[start + i] === newBlocks[start + j]) { closeRun(); i++; j++; continue; }
    if (runStart === null) runStart = start + j;
    if (lcs[i + 1][j] >= lcs[i][j + 1]) { runDeletes.push(start + i); i++; }
    else { runInserts.push(start + j); j++; }
  }
  while (j < cols) { if (runStart === null) runStart = start + j; runInserts.push(start + j); j++; }
  while (i < rows) { if (runStart === null) runStart = start + j; runDeletes.push(start + i); i++; }
  closeRun();

  return { modified, added, removedBefore, pairs,
           count: modified.size + added.size + removedBefore.size };
}

function elementOf(html) {
  const holder = document.createElement("template");
  holder.innerHTML = html;
  return holder.content.firstElementChild;
}

/**
 * The full diff: blocks first, then one level deeper for lists. A rewritten list
 * is re-diffed item by item, so appending one entry to a 30-item plan marks that
 * entry rather than lighting the whole list.
 */
function diffDocument(oldHtml, newHtml) {
  const oldBlocks = blocksOf(oldHtml), newBlocks = blocksOf(newHtml);
  const marks = diffBlocks(oldBlocks, newBlocks);
  marks.lists = new Map();

  for (const [newIndex, oldIndex] of marks.pairs) {
    const oldEl = elementOf(oldBlocks[oldIndex]);
    const newEl = elementOf(newBlocks[newIndex]);
    if (!oldEl || !newEl || oldEl.tagName !== newEl.tagName) continue;
    if (newEl.tagName !== "UL" && newEl.tagName !== "OL") continue;

    const itemDiff = diffBlocks(
      [...oldEl.children].map(li => li.outerHTML),
      [...newEl.children].map(li => li.outerHTML));
    if (itemDiff.count === 0) continue;   // the list element itself changed, not its items

    marks.lists.set(newIndex, itemDiff);
    marks.modified.delete(newIndex);
    marks.count += itemDiff.count - 1;
  }
  return marks;
}

function noteDocChanged(path, html) {
  if (selfChanged.delete(path)) {
    // The reader's own save or checkbox tick is not news to them.
    changeBaselines.set(path, html);
    changeMarks.delete(path);
    return;
  }

  const baseline = changeBaselines.get(path);
  if (baseline === undefined) { changeBaselines.set(path, html); return; }
  if (baseline === html) { changeMarks.delete(path); return; }

  changeMarks.set(path, diffDocument(baseline, html));
}

function dismissChangeMarks(path) {
  const doc = docs.get(path);
  if (!doc) return;

  changeBaselines.set(path, doc.html);
  changeMarks.delete(path);

  for (const pane of Layout.panesShowing(path)) {
    if (pane.active !== path) continue;
    const scroller = docElementOf(pane);
    if (scroller) pane.anchors[path] = captureAnchor(scroller);
    paintDoc(pane);
  }
  refreshChangeChips();
  refreshChangedDots();
  Menu.refresh();
}

/** Paints the marks onto a freshly rendered document. Called from paintDoc. */
function applyChangeMarks(scroller, path) {
  if (!changeMarksVisible) return;
  const marks = changeMarks.get(path);
  if (!marks) return;

  const blocks = [...scroller.children];
  for (const index of marks.modified) blocks[index]?.classList.add("changed-block");
  for (const index of marks.added) blocks[index]?.classList.add("added-block");

  for (const [blockIndex, itemDiff] of marks.lists ?? []) {
    const list = blocks[blockIndex];
    if (!list) continue;

    const items = [...list.children];
    for (const index of itemDiff.modified) items[index]?.classList.add("changed-item");
    for (const index of itemDiff.added) items[index]?.classList.add("added-item");

    for (const index of itemDiff.removedBefore) {
      const seam = document.createElement("li");
      seam.className = "removed-mark-item";
      seam.title = "List items that were here have been removed";
      if (index < items.length) list.insertBefore(seam, items[index]);
      else list.append(seam);
    }
  }

  for (const index of marks.removedBefore) {
    const seam = document.createElement("div");
    seam.className = "removed-mark";
    seam.title = "Content that was here has been removed";
    if (index < blocks.length) scroller.insertBefore(seam, blocks[index]);
    else scroller.append(seam);
  }
}

function changeChipText(marks) {
  return marks.count === 1 ? "1 change — mark seen" : marks.count + " changes — mark seen";
}

/**
 * The tab dot mirrors uncleared change marks: it appears when a file changes,
 * survives opening the tab and every re-render, and goes away only when the marks
 * are dismissed -- a reminder that there are changes not yet marked as seen.
 */
function refreshChangedDots() {
  for (const pane of Layout.panes()) {
    for (const path of pane.tabs) {
      const tab = panesEl.querySelector(
        `[data-pane-id="${CSS.escape(pane.id)}"] [data-path="${CSS.escape(path)}"]`);
      if (!tab) continue;

      const changed = changeMarksVisible && changeMarks.has(path);
      tab.classList.toggle("changed", changed);
      setTabMark(tab, "changed", changed);
    }
  }
}

/** Updates every pane's chip in place, so a reload does not rebuild the header. */
function refreshChangeChips() {
  for (const pane of Layout.panes()) {
    const chip = panesEl.querySelector(
      `[data-pane-id="${CSS.escape(pane.id)}"] .dochead-changes`);
    if (!chip) continue;

    const marks = changeMarksVisible && pane.active ? changeMarks.get(pane.active) : null;
    chip.hidden = !marks;
    if (marks) chip.textContent = changeChipText(marks);
  }
}

// ---------- outline ----------

// A clicked outline entry lands its heading scroll-margin-top (styles.css) below
// the pane top, so the spy must count a heading that far down as already reached --
// with less slack than the margin, the heading above the clicked one stays lit.
const SPY_SLACK = 24;

/** The last heading at or above the top of the viewport -- what the reader is under. */
function currentHeadingId(scroller) {
  if (!scroller) return null;

  const top = scroller.scrollTop;
  let id = null;

  for (const heading of scroller.querySelectorAll("h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]")) {
    if (heading.offsetTop > top + SPY_SLACK) break;
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
  for (const marked of panesEl.querySelectorAll(".drop-before, .drop-after")) {
    marked.classList.remove("drop-before", "drop-after");
  }
}

/** Where along a strip the drag would land: the first tab whose midpoint is past it. */
function stripInsertionIndex(strip, event) {
  const tabs = [...strip.querySelectorAll(".tab")];
  for (let i = 0; i < tabs.length; i++) {
    const rect = tabs[i].getBoundingClientRect();
    if (event.clientX < rect.left + rect.width / 2) return i;
  }
  return tabs.length;
}

function markStripInsertion(strip, index) {
  const tabs = [...strip.querySelectorAll(".tab")];
  if (tabs.length === 0) return;
  if (index < tabs.length) tabs[index].classList.add("drop-before");
  else tabs[tabs.length - 1].classList.add("drop-after");
}

panesEl.addEventListener("dragover", (event) => {
  if (!dragging) return;

  const paneEl = event.target.closest(".pane");
  if (!paneEl) return;

  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  clearDropHints();

  // Over the strip the drag is an insertion, not a pane split or move.
  const strip = event.target.closest(".tabstrip");
  if (strip) {
    markStripInsertion(strip, stripInsertionIndex(strip, event));
    return;
  }

  paneEl.classList.add("drop-" + Layout.dropZone(paneEl, event));
});

panesEl.addEventListener("dragleave", (event) => {
  if (!event.relatedTarget || !panesEl.contains(event.relatedTarget)) clearDropHints();
});

panesEl.addEventListener("drop", (event) => {
  if (!dragging) return;

  const paneEl = event.target.closest(".pane");
  if (!paneEl) return;

  event.preventDefault();

  const { paneId, path } = dragging;
  dragging = null;

  const strip = event.target.closest(".tabstrip");
  if (strip) {
    const index = stripInsertionIndex(strip, event);
    clearDropHints();
    rememberAnchors();
    Layout.moveTab(paneId, path, paneEl.dataset.paneId, index);
    renderAll({ keepAnchors: false });
    syncOpenPaths();
    return;
  }

  const zone = Layout.dropZone(paneEl, event);
  clearDropHints();

  // Dropping a pane's only tab back onto itself is a no-op, not a split.
  if (paneId === paneEl.dataset.paneId && zone === "center") return;

  rememberAnchors();
  Layout.applyDrop(paneId, path, paneEl.dataset.paneId, zone);
  renderAll({ keepAnchors: false });
  syncOpenPaths();
});

// ---------- drops from outside the app ----------

// Explorer drops are accepted by the page, not by WPF: routing them through WPF
// (AllowExternalDrop=false) also suppressed the page's own tab drags in the WPF
// host. postMessageWithAdditionalObjects hands the host each file's real path.
document.addEventListener("dragover", (event) => {
  if (dragging || !event.dataTransfer?.types?.includes("Files")) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
});

document.addEventListener("drop", (event) => {
  if (dragging || !event.dataTransfer?.types?.includes("Files")) return;
  event.preventDefault();
  host.postMessageWithAdditionalObjects({ type: "dropped-files", payload: null }, [...event.dataTransfer.files]);
});

// ---------- clicks inside panes ----------

panesEl.addEventListener("change", (event) => {
  const box = event.target.closest("input.task[data-task]");
  if (!box) return;

  const paneEl = box.closest(".pane");
  const pane = paneEl ? Layout.pane(paneEl.dataset.paneId) : null;
  if (!pane || !pane.active) return;

  selfChanged.add(pane.active);
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
    requestCloseTab(paneId, close.dataset.close);
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

  // A bare image opens the lightbox; one wrapped in a link stays a link.
  const image = event.target.closest(".doc img");
  if (image && !event.target.closest("a[href]")) {
    openLightbox(image.currentSrc || image.src);
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

  if (href.startsWith("https://greenmd-open.local/")) {
    event.preventDefault();
    Layout.setActive(paneId);
    post("open-file", decodeURIComponent(href.slice("https://greenmd-open.local/".length).split("#")[0]));
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
  requestCloseTab(paneEl.dataset.paneId, tab.dataset.path);
});

// ---------- pasting screenshots ----------

// A clipboard image pasted into the editor becomes a file next to the doc plus a
// markdown link, instead of nothing. The host reads the clipboard itself -- the
// bytes never cross the bridge -- and answers with image-pasted once written.
panesEl.addEventListener("paste", (event) => {
  const editor = event.target.closest("textarea.editor");
  if (!editor) return;

  const hasImage = [...(event.clipboardData?.items || [])]
    .some(item => item.type.startsWith("image/"));
  if (!hasImage) return;

  const paneEl = editor.closest(".pane");
  const pane = paneEl ? Layout.pane(paneEl.dataset.paneId) : null;
  if (!pane || !pane.active) return;

  event.preventDefault();

  // An unsaved note has no folder for the image to land in yet.
  if (isUntitled(pane.active)) {
    statusTextEl.textContent = "Save the note first (Ctrl+S) — a pasted image needs a folder to land in.";
    return;
  }

  post("paste-image", { path: pane.active, paneId: pane.id });
});

// ---------- tab context menu ----------

let contextMenuEl = null;
let contextMenuCloseTimer = null;

function cancelContextMenuClose() {
  if (contextMenuCloseTimer === null) return;
  clearTimeout(contextMenuCloseTimer);
  contextMenuCloseTimer = null;
}

function closeTabContextMenu() {
  cancelContextMenuClose();
  if (!contextMenuEl) return;
  contextMenuEl.remove();
  contextMenuEl = null;
}

function contextItem(label, { unavailable = null, run }) {
  const item = document.createElement("button");
  item.className = "menu-item" + (unavailable ? " unavailable" : "");
  item.type = "button";
  item.setAttribute("aria-disabled", String(!!unavailable));
  if (unavailable) item.title = unavailable;

  const text = document.createElement("span");
  text.textContent = label;
  item.append(text);

  // Same contract as the menu bar: a greyed item explains itself instead of
  // silently doing nothing.
  item.addEventListener("click", () => {
    closeTabContextMenu();
    if (unavailable) { statusTextEl.textContent = unavailable; return; }
    run();
  });
  return item;
}

function openTabContextMenu(event, paneId, path) {
  closeTabContextMenu();

  const pane = Layout.pane(paneId);
  if (!pane) return;

  const others = pane.tabs.filter(p => p !== path);

  const menu = document.createElement("div");
  menu.className = "context-menu";

  // Every close funnels through requestCloseTab, so a dirty tab keeps its guard:
  // clean tabs go, dirty ones stay open with the unsaved-changes notice.
  menu.append(
    contextItem("Close", { run: () => requestCloseTab(paneId, path) }),
    contextItem("Close others", {
      unavailable: others.length ? null : "No other tabs in this pane.",
      run: () => { for (const other of others) requestCloseTab(paneId, other); }
    }),
    contextItem("Close all", {
      run: () => { for (const open of [...pane.tabs]) requestCloseTab(paneId, open); }
    })
  );

  // Same grace period as the menu bar: leaving for a frame and coming back must
  // not snap the menu shut.
  menu.addEventListener("mouseleave", () => {
    cancelContextMenuClose();
    contextMenuCloseTimer = setTimeout(() => {
      contextMenuCloseTimer = null;
      closeTabContextMenu();
    }, Menu.closeGraceMs);
  });
  menu.addEventListener("mouseenter", cancelContextMenuClose);

  document.body.append(menu);

  // At the pointer, pulled back inside the window when it would poke out.
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.max(0, Math.min(event.clientX, window.innerWidth - rect.width - 4)) + "px";
  menu.style.top = Math.max(0, Math.min(event.clientY, window.innerHeight - rect.height - 4)) + "px";

  contextMenuEl = menu;
}

panesEl.addEventListener("contextmenu", (event) => {
  const tab = event.target.closest("[data-path]");
  const paneEl = event.target.closest(".pane");
  if (!tab || !paneEl) return;

  event.preventDefault();
  openTabContextMenu(event, paneEl.dataset.paneId, tab.dataset.path);
});

document.addEventListener("mousedown", (event) => {
  if (contextMenuEl && !contextMenuEl.contains(event.target)) closeTabContextMenu();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && contextMenuEl) { closeTabContextMenu(); event.stopPropagation(); }
});

// ---------- image lightbox ----------

const lightboxEl = document.getElementById("lightbox");
const lightboxImageEl = document.getElementById("lightboxImage");
const lightboxState = { scale: 1, x: 0, y: 0 };
let lightboxPan = null;

function applyLightboxTransform() {
  lightboxImageEl.style.transform =
    `translate(${lightboxState.x}px, ${lightboxState.y}px) scale(${lightboxState.scale})`;
}

function resetLightboxView() {
  lightboxState.scale = 1;
  lightboxState.x = 0;
  lightboxState.y = 0;
  applyLightboxTransform();
}

function openLightbox(src) {
  resetLightboxView();
  lightboxImageEl.src = src;
  lightboxEl.hidden = false;
}

function closeLightbox() {
  lightboxEl.hidden = true;
  lightboxImageEl.removeAttribute("src");
}

lightboxEl.addEventListener("wheel", (event) => {
  event.preventDefault();

  const factor = event.deltaY < 0 ? 1.2 : 1 / 1.2;
  const next = Math.min(12, Math.max(0.25, lightboxState.scale * factor));
  if (next === lightboxState.scale) return;

  // The point under the cursor stays put while the image scales around it.
  const dx = event.clientX - window.innerWidth / 2;
  const dy = event.clientY - window.innerHeight / 2;
  const ratio = next / lightboxState.scale;
  lightboxState.x = dx - ratio * (dx - lightboxState.x);
  lightboxState.y = dy - ratio * (dy - lightboxState.y);
  lightboxState.scale = next;
  applyLightboxTransform();
}, { passive: false });

lightboxImageEl.addEventListener("mousedown", (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  lightboxPan = { fromX: event.clientX - lightboxState.x, fromY: event.clientY - lightboxState.y };
  lightboxEl.classList.add("panning");
});

document.addEventListener("mousemove", (event) => {
  if (!lightboxPan) return;
  lightboxState.x = event.clientX - lightboxPan.fromX;
  lightboxState.y = event.clientY - lightboxPan.fromY;
  applyLightboxTransform();
});

document.addEventListener("mouseup", () => {
  if (!lightboxPan) return;
  lightboxPan = null;
  lightboxEl.classList.remove("panning");
});

lightboxImageEl.addEventListener("dblclick", resetLightboxView);

lightboxEl.addEventListener("click", (event) => {
  if (event.target === lightboxEl) closeLightbox();
});

// ---------- host messages ----------

/** The host cannot know which pane is active, so the UI owns the window title. */
function reportTitle() {
  const pane = Layout.activePane();
  const active = pane && pane.active ? docs.get(pane.active) : null;
  post("set-title", active ? active.title : null);
}

function syncOpenPaths() {
  // Untitled tabs are not the host's business until they have a file behind them.
  post("sync-open", Layout.openPaths().filter(path => !isUntitled(path)));
}

/**
 * Rebuilds one pane's tab strip and header in place, without touching the document
 * or its scroll position. Replacing each node where it already sits is the only way
 * to keep the child order intact -- appending and then moving things around is what
 * previously left the editor above the tab strip and the header in the middle.
 */
function refreshPaneChrome(pane) {
  const element = panesEl.querySelector(`[data-pane-id="${CSS.escape(pane.id)}"]`);
  if (!element) return;

  element.querySelector(".tabstrip")?.replaceWith(buildTabstrip(pane));
  element.querySelector(".dochead")?.replaceWith(buildHeader(pane));

  Zoom.apply("pane:" + pane.id);
}

function restoreSession(state) {
  if (!state) return;

  if (state.panels) Panels.restore(state.panels);
  if (Array.isArray(state.recents)) recents = state.recents.slice(0, RECENT_LIMIT);
  if (typeof state.changeMarksVisible === "boolean") changeMarksVisible = state.changeMarksVisible;
  if (Array.isArray(state.expanded)) Workspace.setExpanded(state.expanded);
  if (Array.isArray(state.collapsedRoots)) Workspace.setCollapsedRoots(state.collapsedRoots);
  if (state.sectionWeights) Workspace.setSectionWeights(state.sectionWeights);

  if (state.layout) Layout.restore(state.layout);

  // A restored untitled tab gets an empty in-memory document again; its unsaved
  // text did not survive the restart, but the dirty-close guard makes that rare.
  for (const path of Layout.openPaths()) {
    if (!isUntitled(path)) continue;
    docs.set(path, untitledDoc(path));
    const n = Number(path.slice(UNTITLED_PREFIX.length));
    if (Number.isFinite(n)) untitledCounter = Math.max(untitledCounter, n);
  }

  renderAll({ keepAnchors: false, save: false });

  const paths = Layout.openPaths().filter(path => !isUntitled(path));
  if (paths.length) post("load-docs", paths);
}

let sessionTimer = null;

/** Debounced -- a burst of tab operations should not be a burst of messages. */
function saveSession() {
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    post("save-session", {
      workspaces: Workspace.roots(),
      expanded: Workspace.expandedPaths(),
      collapsedRoots: Workspace.collapsedRoots(),
      sectionWeights: Workspace.sectionWeights(),
      panels: Panels.snapshot(),
      recents,
      changeMarksVisible,
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

    case "workspace": {
      Workspace.set(payload);
      Panels.apply();

      // The tree usually loads after the document, so the marker has to be set
      // here too rather than only when the active document changes.
      const active = Layout.activePane();
      Workspace.highlight(active && active.active ? active.active : null);
      refreshStatus();
      saveSession();
      break;
    }

    case "session":
      restoreSession(payload);
      break;

    case "doc-content": {
      // Content for a restored tab: fill it in without creating a new tab.
      docs.set(payload.path, payload);
      noteDocChanged(payload.path, payload.html);
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
      noteExitSave(payload.path, payload.saved);

      if (payload.saved) {
        selfChanged.add(payload.path);
        Editor.markSaved(payload.path);
        refreshDirtyMarks();

        // A save requested from the close prompt finishes the close.
        for (const [paneId, blockedPath] of [...closeBlocked]) {
          if (blockedPath !== payload.path) continue;
          closeBlocked.delete(paneId);
          closeTab(paneId, blockedPath);
        }

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

    case "about":
      showAbout(payload);
      break;

    case "association":
      associationRegistered = !!payload.registered;
      // The File menu is the only place this is offered, and refresh is what greys the
      // entry once it is done.
      Menu.refresh();
      break;

    case "downloading":
      statusTextEl.textContent = "Downloading " + payload.title + " from OneDrive…";
      break;

    case "error":
      statusTextEl.textContent = payload.message;
      break;

    case "saved-as": {
      // An untitled tab becomes the real file in place: same panes, same mode,
      // same buffer -- now clean, since its text just hit the disk.
      const from = payload.from;
      const to = payload.path;
      docs.delete(from);

      for (const pane of Layout.panesShowing(from)) {
        const index = pane.tabs.indexOf(from);
        if (index >= 0) pane.tabs[index] = to;
        if (pane.active === from) pane.active = to;
        if (pane.modes[from] !== undefined) { pane.modes[to] = pane.modes[from]; delete pane.modes[from]; }
        if (pane.anchors[from] !== undefined) { pane.anchors[to] = pane.anchors[from]; delete pane.anchors[from]; }

        const text = Editor.textOf(pane.id, from);
        Editor.forget(pane.id, from);
        if (text !== null) {
          Editor.setText(pane.id, to, text);
          Editor.buffer(pane.id, to).base = text;
        }
      }
      break;
    }

    case "doc-opened": {
      docs.set(payload.path, payload);
      noteDocChanged(payload.path, payload.html);
      noteRecent(payload.path);
      rememberAnchors();

      // Launching with a file, or double-clicking one while the app is running,
      // should join the session rather than duplicate it: if the file is already
      // open somewhere, go to that tab instead of opening a second copy of it.
      const showing = Layout.panesShowing(payload.path);
      const target = showing.find(pane => pane.id === Layout.activeId) ?? showing[0];

      if (target) {
        target.active = payload.path;
        Layout.setActive(target.id);
      } else {
        Layout.addTab(Layout.activeId, payload.path);
      }

      renderAll({ keepAnchors: false });
      syncOpenPaths();
      break;
    }

    case "image-pasted": {
      const pane = Layout.pane(payload.paneId);
      if (!pane || pane.active !== payload.path) break;

      const editor = panesEl.querySelector(
        `[data-pane-id="${CSS.escape(pane.id)}"] textarea.editor`);
      if (!editor) break;

      editor.focus();
      const inserted = payload.markdown + "\n";

      // execCommand keeps the textarea's native undo stack intact; jsdom and any
      // future engine without it fall back to a direct splice.
      const usedCommand = typeof document.execCommand === "function"
        && document.execCommand("insertText", false, inserted);
      if (!usedCommand) {
        editor.setRangeText(inserted, editor.selectionStart, editor.selectionEnd, "end");
        editor.dispatchEvent(new Event("input", { bubbles: true }));
      }
      break;
    }

    case "asset-updated": {
      // An image an open document references changed on disk. Same bytes-fresh
      // guarantee as text: bump a version query so the browser refetches, leaving
      // the document itself untouched.
      const changedAsset = payload.path.toLowerCase();
      for (const img of panesEl.querySelectorAll(".doc img")) {
        const src = img.getAttribute("src") || "";
        if (!src.startsWith("https://greenmd-asset.local/")) continue;

        let decoded;
        try {
          decoded = decodeURIComponent(
            src.slice("https://greenmd-asset.local/".length).split("?")[0]);
        } catch { continue; }

        if (decoded.toLowerCase() !== changedAsset) continue;
        img.src = src.split("?")[0] + "?v=" + (++assetVersion);
      }
      break;
    }

    case "doc-updated": {
      docs.set(payload.path, payload);
      noteDocChanged(payload.path, payload.html);

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

      refreshChangedDots();

      if (Editor.noteExternalChange(payload.path)) post("get-text", payload.path);
      for (const pane of Layout.panesShowing(payload.path)) updateNotice(pane);

      refreshChangeChips();
      Menu.refresh();
      refreshOutline();
      refreshStatus(true);
      break;
    }
  }
});

// ---------- keyboard ----------


// ---------- commands ----------
//
// One list, used by both the menu bar and the keyboard. A command cannot gain a
// shortcut without also appearing in a menu, because there is nowhere else to define
// one.

window.Commands = (() => {
  const map = new Map();

  const define = (id, label, keys, run, available, reason) =>
    map.set(id, { id, label, keys, run, available, reason });

  define("newFile", "New file", "Ctrl+N", newFile);
  define("openFile", "Open file...", "Ctrl+O", () => post("pick-file"));
  define("addFolder", "Add folder to sidebar...", "Ctrl+K", () => post("pick-folder"));
  define("goToFile", "Go to file...", "Ctrl+P", () => Workspace.openQuick(recents));
  define("find", "Find in document", "Ctrl+F", openFind);

  define("save", "Save", "Ctrl+S", () => saveActive(false),
    () => {
      const p = Layout.activePane();
      // An untitled tab is always saveable: its first save is what names it.
      return !!(p && p.active && (isUntitled(p.active) || Editor.isDirty(p.id, p.active)));
    },
    "Nothing to save — this document has no unsaved changes.");

  define("closeTab", "Close tab", "Ctrl+W", () => {
    const pane = Layout.activePane();
    if (pane && pane.active) requestCloseTab(pane.id, pane.active);
  }, () => { const p = Layout.activePane(); return !!(p && p.active); },
    "No document is open in this pane.");

  define("closeFolders", "Close all folders", "", () => post("close-workspace"),
    () => Workspace.hasWorkspace(),
    "No folders are open. Add one with Ctrl+K.");

  define("about", "About GreenMD", "", () => post("get-about"));

  define("registerAssociation", "Set as default .md viewer", "",
    () => {
      post("register-association");
      // Said here rather than on a button's click handler, so running it from the menu
      // reports back too -- the menu path used to do it silently.
      statusTextEl.textContent =
        "Registered. Windows will ask you to confirm the default the next time you open a .md file.";
    },
    () => !associationRegistered,
    "GreenMD is already registered as a markdown handler.");

  define("clearChangeMarks", "Mark changes as seen", "Ctrl+M", () => {
    const p = Layout.activePane();
    // Guarded against hidden marks: dismissing what cannot be seen would silently
    // discard everything accumulated while the display was off.
    if (changeMarksVisible && p && p.active) dismissChangeMarks(p.active);
  }, () => {
    const p = Layout.activePane();
    return changeMarksVisible && !!(p && p.active && changeMarks.has(p.active));
  }, "No change marks to clear — nothing has changed since you last looked, or marks are hidden (View menu).");

  define("toggleSource", "Toggle source editing", "Ctrl+E",
    () => toggleMode(Layout.activePane()),
    () => { const p = Layout.activePane(); return !!(p && p.active); },
    "Open a document first.");

  define("toggleFiles", "Show or hide file list", "Ctrl+B", () => {
    if (!Workspace.hasWorkspace()) { post("pick-folder"); return; }
    Panels.toggle("sidebar");
  });

  define("toggleOutline", "Show or hide outline", "Ctrl+Shift+O", () => Panels.toggle("outline"));
  define("toggleChangeMarks", "Show or hide change marks", "",
    () => setChangeMarksVisible(!changeMarksVisible));
  define("swapPanels", "Swap left and right panels", "", () => Panels.swap());
  define("resetPaneWidths", "Reset panel widths", "", () => Panels.resetWidths());

  const zoomScope = () => Zoom.hoveredScope() || ("pane:" + Layout.activeId);
  define("zoomIn", "Larger text", "Ctrl+=", () => Zoom.nudge(zoomScope(), 1));
  define("zoomOut", "Smaller text", "Ctrl+-", () => Zoom.nudge(zoomScope(), -1));
  define("zoomReset", "Reset text size", "Ctrl+0", () => Zoom.set(zoomScope(), 1));

  define("splitRight", "Split pane right", "Ctrl+\\", () => splitActive("row"));
  define("splitDown", "Split pane down", "Ctrl+Shift+\\", () => splitActive("col"));

  define("nextTab", "Next tab", "Ctrl+Tab", () => cycleTab(1),
    () => { const p = Layout.activePane(); return !!p && p.tabs.length > 1; },
    "Only one tab is open in this pane.");
  define("prevTab", "Previous tab", "Ctrl+Shift+Tab", () => cycleTab(-1),
    () => { const p = Layout.activePane(); return !!p && p.tabs.length > 1; },
    "Only one tab is open in this pane.");

  return { get: id => map.get(id), run: id => map.get(id)?.run() };
})();

function splitActive(direction) {
  const pane = Layout.activePane();
  if (!pane) return;

  rememberAnchors();
  const created = Layout.split(pane.id, direction);
  // Carry the current document into the new pane so the split is useful at once.
  if (created && pane.active) Layout.addTab(created.id, pane.active);
  renderAll({ keepAnchors: false });
}

function cycleTab(delta) {
  const pane = Layout.activePane();
  if (!pane || pane.tabs.length < 2) return;

  const index = pane.tabs.indexOf(pane.active);
  const next = (index + delta + pane.tabs.length) % pane.tabs.length;

  rememberAnchors();
  pane.active = pane.tabs[next];
  renderAll({ keepAnchors: false });
}

/** Key combinations, resolved against the same registry the menu renders from. */
window.KEY_BINDINGS = [
  { key: "n", command: "newFile" },
  { key: "o", command: "openFile" },
  { key: "k", command: "addFolder" },
  { key: "p", command: "goToFile" },
  { key: "f", command: "find" },
  { key: "s", command: "save" },
  { key: "w", command: "closeTab" },
  { key: "e", command: "toggleSource" },
  { key: "m", command: "clearChangeMarks" },
  { key: "b", command: "toggleFiles" },
  { key: "o", shift: true, command: "toggleOutline" },
  { key: "0", command: "zoomReset" },
  { key: "=", command: "zoomIn" },
  { key: "+", command: "zoomIn" },
  { key: "-", command: "zoomOut" },
  { key: "Tab", command: "nextTab" },
  { key: "Tab", shift: true, command: "prevTab" }
];

document.addEventListener("keydown", (event) => {
  // Topmost overlay first: the lightbox sits above everything else.
  if (event.key === "Escape" && !lightboxEl.hidden) {
    event.preventDefault();
    closeLightbox();
    return;
  }

  // The overlay handles its own keys; Escape closes it from anywhere.
  if (Workspace.isQuickOpen()) {
    if (event.key === "Escape") Workspace.closeQuick();
    return;
  }

  if (event.key === "Escape" && !aboutBoxEl.hidden) {
    event.preventDefault();
    aboutBoxEl.hidden = true;
    return;
  }

  if (event.key === "Escape" && !findBarEl.hidden) {
    event.preventDefault();
    closeFind();
    return;
  }

  if (!event.ctrlKey && !event.metaKey) return;

  // Ctrl+Shift+backslash arrives as "|" on a US layout, so both are accepted.
  const isBackslash = event.key === "\\" || event.key === "|";
  if (isBackslash) {
    event.preventDefault();
    Commands.run(event.shiftKey ? "splitDown" : "splitRight");
    return;
  }

  const binding = KEY_BINDINGS.find(b =>
    b.key.toLowerCase() === event.key.toLowerCase() && !!b.shift === event.shiftKey);

  if (!binding) return;

  event.preventDefault();
  Commands.run(binding.command);
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

toggleSidebarEl.addEventListener("click", () => Commands.run("toggleFiles"));
toggleOutlineEl.addEventListener("click", () => Commands.run("toggleOutline"));
document.getElementById("swapPanels").addEventListener("click", () => Commands.run("swapPanels"));

openFolderEl.addEventListener("click", () => Commands.run("addFolder"));

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
  onCloseFolder(root) { post("close-workspace", root); },
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

Panels.configure({
  sidebarHasContent: () => Workspace.hasWorkspace(),
  onChanged() {
    toggleSidebarEl.classList.toggle("on", Panels.isShown("sidebar") && Workspace.hasWorkspace());
    toggleOutlineEl.classList.toggle("on", Panels.isShown("outline"));
    document.getElementById("swapPanels").classList.toggle("on", Panels.isSwapped());
    Workspace.setVisible(Panels.isShown("sidebar"));
    if (window.Menu) Menu.refresh();
  },
  onPersist() { saveSession(); }
});

Menu.configure(Commands, {
  onUnavailable(command) {
    statusTextEl.textContent = command.reason || (command.label + " is not available right now.");
  },
  // The whole stored list, not the ten the menu shows -- the menu decides its own depth,
  // and Ctrl+P uses the same list and wants all of it.
  recentFiles: () => recents,
  onOpenRecent(path) { post("open-file", path); }
});

Layout.mount(panesEl);
Zoom.applyAll();
renderAll({ keepAnchors: false });
post("ready");

// ---------- about ----------

const aboutBoxEl = document.getElementById("aboutBox");

function showAbout(info) {
  const facts = document.getElementById("aboutFacts");
  facts.replaceChildren();

  const row = (label, value, isPath) => {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    if (isPath) dd.className = "path";
    facts.append(dt, dd);
  };

  row("Version", info.version + (info.build ? "  (" + info.build + ")" : ""));
  row("Runtime", ".NET " + info.dotnet + (info.selfContained ? " (bundled)" : " (installed separately)"));
  row("WebView2", info.webView2);
  row("Diagrams", "Mermaid " + MERMAID_VERSION + " (" + MERMAID_LICENCE + "), loaded on demand");
  row("Licence", "MIT");
  row("Markdown files", info.associationRegistered
    ? "GreenMD is registered as a handler"
    : "not registered — File > Set as default .md viewer");
  row("Installed at", info.executable, true);
  row("Session", info.sessionFile, true);
  row("Browser data", info.webViewData, true);

  const deps = document.getElementById("aboutDeps");
  deps.replaceChildren();
  deps.append(
    Object.assign(document.createElement("div"), {
      textContent: "Two dependencies, neither with any of its own: Markdig (BSD-2-Clause) turns markdown into HTML, and Microsoft's WebView2 draws it."
    }),
    Object.assign(document.createElement("div"), {
      textContent: "One third-party JavaScript file: Mermaid " + MERMAID_VERSION + " (" + MERMAID_LICENCE + "), committed to the repository rather than fetched, and loaded only when a document actually contains a diagram. The highlighter, layout, editor and file search are written for this project. Nothing is sent anywhere — the app makes no network requests."
    })
  );

  aboutBoxEl.dataset.details = [
    "GreenMD " + info.version + (info.build ? " (" + info.build + ")" : ""),
    ".NET " + info.dotnet,
    "WebView2 " + info.webView2,
    "Mermaid " + MERMAID_VERSION,
    info.executable
  ].join(String.fromCharCode(10));

  aboutBoxEl.hidden = false;
  document.getElementById("aboutClose").focus();
}

document.getElementById("aboutClose").addEventListener("click", () => { aboutBoxEl.hidden = true; });
aboutBoxEl.addEventListener("mousedown", event => { if (event.target === aboutBoxEl) aboutBoxEl.hidden = true; });

document.getElementById("aboutCopy").addEventListener("click", async () => {
  const button = document.getElementById("aboutCopy");
  try {
    await navigator.clipboard.writeText(aboutBoxEl.dataset.details || "");
    button.textContent = "Copied";
  } catch {
    button.textContent = "Failed";
  }
  setTimeout(() => { button.textContent = "Copy details"; }, 1200);
});

// ---------- closing with unsaved work ----------

const exitPromptEl = document.getElementById("exitPrompt");
const exitListEl = document.getElementById("exitList");

/** Every dirty buffer, as { paneId, path }. */
function dirtyBuffers() {
  const dirty = [];
  for (const pane of Layout.panes()) {
    for (const path of pane.tabs) {
      if (Editor.isDirty(pane.id, path)) dirty.push({ paneId: pane.id, path });
    }
  }
  return dirty;
}

function approveClose() {
  exitPromptEl.hidden = true;
  post("close-approved");
}

function showExitPrompt(dirty) {
  exitListEl.replaceChildren();

  const intro = document.createElement("div");
  intro.textContent = dirty.length === 1
    ? "One document has changes that have not been written to disk:"
    : `${dirty.length} documents have changes that have not been written to disk:`;
  exitListEl.append(intro);

  // Deduplicated: the same file open in two panes is still one file on disk.
  for (const path of [...new Set(dirty.map(d => d.path))]) {
    const row = document.createElement("div");
    row.className = "exit-file";
    row.textContent = path;
    exitListEl.append(row);
  }

  exitPromptEl.hidden = false;
  document.getElementById("exitCancel").focus();
}

host.addEventListener("message", (event) => {
  if (event.data.type !== "confirm-close") return;

  const dirty = dirtyBuffers();
  if (dirty.length === 0) { approveClose(); return; }

  showExitPrompt(dirty);
});

document.getElementById("exitCancel").addEventListener("click", () => {
  exitPromptEl.hidden = true;
  statusTextEl.textContent = "Close cancelled — save with Ctrl+S, or close again and discard.";
});

document.getElementById("exitDiscard").addEventListener("click", () => {
  for (const { paneId, path } of dirtyBuffers()) Editor.forget(paneId, path);
  approveClose();
});

document.getElementById("exitSave").addEventListener("click", () => {
  const dirty = dirtyBuffers();
  if (dirty.length === 0) { approveClose(); return; }

  // Same reasoning as saveActive, and worse here: this writes every dirty buffer and
  // then closes the window, so an overwrite would take the evidence with it. A buffer
  // whose file has moved on disk is not written, and the close is abandoned rather than
  // saving the others and exiting -- the open window is the only place the conflict can
  // still be resolved.
  const stale = dirty.filter(d => Editor.isStale(d.paneId, d.path));
  if (stale.length > 0) {
    exitPromptEl.hidden = true;
    statusTextEl.textContent =
      "Not saved — a file changed on disk while you were editing. Resolve it with "
      + "“Keep mine” or “Discard mine”, then close again.";
    for (const { path } of stale) {
      for (const showing of Layout.panesShowing(path)) updateNotice(showing);
    }
    return;
  }

  // Close once every save has come back, so nothing is lost to a failed write.
  pendingExitSaves = new Set(dirty.map(d => d.path));
  for (const { paneId, path } of dirty) {
    if (isUntitled(path)) post("save-as", { from: path, text: Editor.textOf(paneId, path) });
    else post("save-doc", { path, text: Editor.textOf(paneId, path), force: false });
  }
});

/** Paths still being written before the window may close. Null when not exiting. */
let pendingExitSaves = null;

/** Called from the save-result handler once each write lands. */
function noteExitSave(path, saved) {
  if (!pendingExitSaves) return;

  if (!saved) {
    // A failed or conflicting write must abandon the close, not lose the text.
    pendingExitSaves = null;
    exitPromptEl.hidden = true;
    statusTextEl.textContent = "Could not save " + path.split(/[\/]/).pop() + " — close cancelled.";
    return;
  }

  pendingExitSaves.delete(path);
  if (pendingExitSaves.size === 0) { pendingExitSaves = null; approveClose(); }
}

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
      shell: box(shell), body: box(body), sidebar: box(sidebar), panes: box(panes),
      outlineAside: box(aside), status: box(status), pane: box(pane), doc: box(doc)
    },
    verdict: {
      bodyFillsWidth: body ? Math.abs(box(body).w - window.innerWidth) <= 1 : null,
      // Sums every visible sibling rather than assuming which ones exist. Hardcoding
      // "viewport minus the status bar" went stale the moment a menu bar was added,
      // and that is now the third assertion to fail that way rather than catch a bug.
      shellChildrenTileHeight: shell
        ? Math.abs([...shell.children]
            .filter(c => !c.hidden)
            .reduce((sum, c) => sum + box(c).h, 0) - box(shell).h) <= 2
        : null,
      statusOnBottomEdge: status
        ? Math.abs((box(status).y + box(status).h) - window.innerHeight) <= 2 : null,
      outlineFullHeight: aside && body ? Math.abs(box(aside).h - box(body).h) <= 2 : null,
      // The checks that were missing: the previous verdict passed while the outline
      // sat entirely off the right-hand edge.
      outlineOnScreen: aside ? box(aside).x + box(aside).w <= window.innerWidth + 1 : null,
      // Sums every visible child rather than a hardcoded pair; this assertion was
      // written before the sidebar existed and quietly stopped covering the truth.
      bodyOnScreen: body ? box(body).y + box(body).h <= window.innerHeight + 1 : null,
      childrenTileBody: body
        ? Math.abs([...body.children]
            .filter(c => !c.hidden)
            .reduce((sum, c) => sum + box(c).w, 0) - box(body).w) <= 2
        : null,
      // Null when nothing is being edited, so this cannot pass by vacuously being true.
      // Width first: it is the one that actually broke, and equal heights with unequal
      // widths is luck rather than agreement -- it only holds until a line is long
      // enough to wrap in the narrower layer.
      editorLayersAgree: (() => {
        const open = [...document.querySelectorAll(".editor-wrap")].filter(w => !w.hidden);
        if (open.length === 0) return null;

        return open.every(w => {
          const e = w.querySelector(".editor");
          const p = w.querySelector(".editor-highlight");
          if (!e || !p) return false;
          return Math.abs(e.clientWidth - p.clientWidth) <= 1
                 && Math.abs(e.scrollHeight - p.scrollHeight) <= 2;
        });
      })()
    },
    mermaid: {
      rendered: document.querySelectorAll(".mermaid-figure svg").length,
      failed: document.querySelectorAll(".mermaid-failed").length,
      unprocessed: document.querySelectorAll(
        "pre.mermaid:not([data-drawn]), div.mermaid:not([data-drawn]), pre > code.language-mermaid").length,
      loaded: !!window.mermaid,
      errors: [...document.querySelectorAll(".mermaid-error")].map(e => e.textContent)
    },
    outline: {
      count: links.length,
      firstWidth: links[0] ? Math.round(links[0].getBoundingClientRect().width) : null,
      anyTruncating: links.some(a => a.scrollWidth > a.clientWidth)
    },
    // The level that actually broke: a pane's own children and their order.
    paneChildren: pane ? [...pane.children].map(c => ({
      cls: c.className.split(" ")[0],
      hidden: c.hidden,
      display: getComputedStyle(c).display,
      box: box(c)
    })) : [],
    shellChildren: shell ? [...shell.children].map(c => ({
      tag: c.tagName.toLowerCase(),
      cls: c.className,
      hidden: c.hidden,
      display: getComputedStyle(c).display,
      box: box(c)
    })) : [],
    // The editor is two stacked layers and only works while they agree on per-line
    // metrics. line-height is a unitless ratio over a zoomed font-size, so it resolves
    // to a fraction -- 15px x 1.65 = 24.75px -- and if the textarea rounds per line
    // where the <pre> does not, the caret drifts further from the glyphs the further
    // down the document you go. Reported per layer so the disagreement is visible
    // rather than inferred.
    editors: [...document.querySelectorAll(".editor-wrap")].map(wrap => {
      const editor = wrap.querySelector(".editor");
      const pre = wrap.querySelector(".editor-highlight");
      const code = wrap.querySelector(".editor-highlight code");
      if (!editor || !pre || !code) return null;

      const es = getComputedStyle(editor);
      const ps = getComputedStyle(pre);
      const newline = String.fromCharCode(10);

      return {
        hidden: wrap.hidden,
        lineHeight: { editor: es.lineHeight, highlight: ps.lineHeight },
        fontSize: { editor: es.fontSize, highlight: ps.fontSize },
        padTop: { editor: es.paddingTop, highlight: ps.paddingTop },
        padBottom: { editor: es.paddingBottom, highlight: ps.paddingBottom },
        lines: {
          value: editor.value.split(newline).length,
          highlighted: code.textContent.split(newline).length
        },
        scrollHeight: { editor: editor.scrollHeight, highlight: pre.scrollHeight },
        clientHeight: { editor: editor.clientHeight, highlight: pre.clientHeight },
        scrollTop: { editor: editor.scrollTop, highlight: pre.scrollTop },
        // Same text in the same box, so any content-height difference is the two
        // layers disagreeing about a line. The caret drift at the bottom is this.
        contentHeightDelta: editor.scrollHeight - pre.scrollHeight,
        caretLine: editor.value.slice(0, editor.selectionStart).split(newline).length,
        endsWithNewline: editor.value.endsWith(newline)
      };
    }).filter(Boolean)
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
    childOrder: [...(panesEl.querySelector(`[data-pane-id="${CSS.escape(pane.id)}"]`)?.children ?? [])]
      .map(c => c.className.split(" ")[0] + (c.hidden ? "(hidden)" : "")),
    headerStamp: (() => {
      const el = panesEl.querySelector(`[data-pane-id="${CSS.escape(pane.id)}"] .dochead-updated`);
      return el ? { text: el.textContent, dataset: el.dataset.updated } : null;
    })()
  }));

  // Editor geometry belongs in the streaming dump rather than the one-shot layout dump:
  // the source arrives from the host a round trip after edit mode opens, so a snapshot
  // taken two frames in measures an empty textarea. This also makes before/after
  // visible across a keystroke, which is the only way to see a caret drift appear.
  const editors = [...document.querySelectorAll(".editor-wrap")]
    .filter(wrap => !wrap.hidden)
    .map(wrap => {
      const editor = wrap.querySelector(".editor");
      const pre = wrap.querySelector(".editor-highlight");
      const code = wrap.querySelector(".editor-highlight code");
      if (!editor || !pre || !code) return null;

      const newline = String.fromCharCode(10);
      const style = getComputedStyle(editor);

      return {
        lineHeight: style.lineHeight,
        lines: {
          value: editor.value.split(newline).length,
          highlighted: code.textContent.split(newline).length
        },
        scrollHeight: { editor: editor.scrollHeight, highlight: pre.scrollHeight },
        clientHeight: editor.clientHeight,
        // The textarea grows a scrollbar and the <pre> does not, so their usable text
        // widths can differ -- and different widths mean the two layers wrap at
        // different columns, which no amount of matching font rules will fix.
        clientWidth: { editor: editor.clientWidth, highlight: pre.clientWidth },
        widthDelta: editor.clientWidth - pre.clientWidth,
        scrollTop: { editor: editor.scrollTop, highlight: pre.scrollTop },
        contentHeightDelta: editor.scrollHeight - pre.scrollHeight,
        scrollTopDelta: editor.scrollTop - pre.scrollTop,
        caretLine: editor.value.slice(0, editor.selectionStart).split(newline).length,
        endsWithNewline: editor.value.endsWith(newline)
      };
    })
    .filter(Boolean);

  return {
    now: new Date().toISOString(),
    panes,
    editors,
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
