"use strict";

const host = window.chrome && window.chrome.webview;

const tabstripEl = document.getElementById("tabstrip");
const docEl = document.getElementById("doc");
const outlineEl = document.getElementById("outline");
const docNameEl = document.getElementById("docName");
const docFolderEl = document.getElementById("docFolder");
const docUpdatedEl = document.getElementById("docUpdated");
const pulseEl = document.getElementById("pulse");
const statusTextEl = document.getElementById("statusText");
const statusRightEl = document.getElementById("statusRight");

/** path -> { path, title, folder, html, outline, missing, loadedAt, anchor } */
const tabs = new Map();
let order = [];
let activePath = null;

function post(type, payload) {
  host.postMessage({ type, payload: payload ?? null });
}

// ---------- per-pane text zoom ----------
//
// WebView2's own zoom is disabled by the host. Scaling font-size rather than using a
// transform is deliberate: the text has to reflow so the reader actually gets more or
// fewer words per line, which a transform would not do.

const ZOOM_MIN = 0.6;
const ZOOM_MAX = 2.6;
const ZOOM_STEP = 0.1;
const ZOOM_BASE = { doc: 15, outline: 13 };

const zoomLevels = new Map();
let hoveredScope = null;

function scopeElement(name) {
  return document.querySelector(`[data-zoom-scope="${name}"]`);
}

function applyZoom(name) {
  const scope = scopeElement(name);
  if (!scope) return;

  const factor = zoomLevels.get(name) ?? 1;
  const target = scope.querySelector("[data-zoom-target]");
  if (target) target.style.fontSize = (ZOOM_BASE[name] * factor).toFixed(2) + "px";

  const badge = scope.querySelector("[data-zoom-badge]");
  if (badge) {
    badge.textContent = Math.round(factor * 100) + "%";
    badge.classList.toggle("shown", Math.abs(factor - 1) > 0.001);
  }
}

function setZoom(name, factor) {
  const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(factor * 100) / 100));

  // Reflowing moves the reader; hold their place across the change.
  const anchor = name === "doc" ? captureAnchor() : null;
  zoomLevels.set(name, clamped);
  applyZoom(name);
  if (anchor) restoreAnchor(anchor);
}

function nudgeZoom(name, direction) {
  setZoom(name, (zoomLevels.get(name) ?? 1) + direction * ZOOM_STEP);
}

document.addEventListener("mouseover", (event) => {
  const scope = event.target.closest("[data-zoom-scope]");
  if (scope) hoveredScope = scope.dataset.zoomScope;
});

document.addEventListener("wheel", (event) => {
  if (!event.ctrlKey) return;

  const scope = event.target.closest("[data-zoom-scope]");
  if (!scope) return;

  event.preventDefault();
  nudgeZoom(scope.dataset.zoomScope, event.deltaY < 0 ? 1 : -1);
}, { passive: false });

for (const badge of document.querySelectorAll("[data-zoom-badge]")) {
  badge.addEventListener("click", () => {
    const scope = badge.closest("[data-zoom-scope]");
    if (scope) setZoom(scope.dataset.zoomScope, 1);
  });
}

// ---------- scroll anchoring ----------

/**
 * Records where the reader is by nearest heading rather than raw scrollTop.
 * A rewrite above the viewport shifts every pixel offset, but the heading they
 * were sitting under is almost always still there.
 */
function captureAnchor() {
  const top = docEl.scrollTop;
  const atBottom = docEl.scrollHeight - top - docEl.clientHeight < 48;

  let id = null;
  let delta = top;

  for (const heading of docEl.querySelectorAll("h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]")) {
    if (heading.offsetTop > top + 8) break;
    id = heading.id;
    delta = top - heading.offsetTop;
  }

  return { id, delta, atBottom };
}

function restoreAnchor(anchor) {
  if (!anchor) { docEl.scrollTop = 0; return; }

  // Follow mode: sitting at the bottom edge means watching the file grow.
  if (anchor.atBottom) { docEl.scrollTop = docEl.scrollHeight; return; }

  if (anchor.id) {
    const target = docEl.querySelector(`[id="${CSS.escape(anchor.id)}"]`);
    if (target) { docEl.scrollTop = Math.max(0, target.offsetTop + anchor.delta); return; }
  }

  docEl.scrollTop = anchor.delta;
}

// ---------- rendering ----------

function renderOutline(headings) {
  outlineEl.replaceChildren();
  for (const heading of headings || []) {
    if (heading.level > 4) continue;
    const link = document.createElement("a");
    link.href = "#" + heading.id;
    link.dataset.level = String(heading.level);
    link.textContent = heading.text;
    link.title = heading.text;
    outlineEl.append(link);
  }
}

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

function paint(html, outline, anchor) {
  docEl.innerHTML = html;
  HL.highlightAll(docEl);
  addCopyButtons(docEl);
  renderOutline(outline);
  restoreAnchor(anchor);
}

/** Shows the tail of a path -- the deepest folders are the ones that identify it. */
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

function updateHeader() {
  const tab = activePath ? tabs.get(activePath) : null;

  if (!tab) {
    docNameEl.textContent = "";
    docFolderEl.textContent = "";
    docFolderEl.removeAttribute("title");
    docUpdatedEl.textContent = "";
    return;
  }

  docNameEl.textContent = tab.title;
  docFolderEl.textContent = shortFolder(tab.folder);
  docFolderEl.title = tab.folder || "";
  docUpdatedEl.textContent = tab.loadedAt ? "updated " + relativeTime(tab.loadedAt) : "";
}

setInterval(updateHeader, 5000);

function setStatus(text, right, flash) {
  statusTextEl.textContent = text || "";
  statusRightEl.textContent = right || "";

  if (!flash) return;

  pulseEl.classList.remove("live");
  void pulseEl.offsetWidth;                 // restart the animation
  pulseEl.classList.add("live");

  docUpdatedEl.classList.add("flash");
  setTimeout(() => docUpdatedEl.classList.remove("flash"), 1600);
}

function renderTabs() {
  tabstripEl.replaceChildren();

  for (const path of order) {
    const tab = tabs.get(path);
    if (!tab) continue;

    const element = document.createElement("div");
    element.className = "tab" + (path === activePath ? " active" : "") + (tab.missing ? " missing" : "");
    element.dataset.path = path;
    element.setAttribute("role", "tab");
    element.title = path;

    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = tab.title;
    element.append(label);

    const close = document.createElement("button");
    close.className = "tab-close";
    close.type = "button";
    close.textContent = "×";
    close.dataset.close = path;
    close.setAttribute("aria-label", "Close " + tab.title);
    element.append(close);

    tabstripEl.append(element);
  }

  const add = document.createElement("button");
  add.className = "tab-add";
  add.type = "button";
  add.textContent = "+";
  add.title = "Open a file (Ctrl+O)";
  add.addEventListener("click", () => post("pick-file"));
  tabstripEl.append(add);

  tabstripEl.style.display = order.length ? "flex" : "none";
}

function activate(path) {
  if (activePath && activePath !== path && tabs.has(activePath)) {
    tabs.get(activePath).anchor = captureAnchor();
  }

  const tab = tabs.get(path);
  if (!tab) return;

  activePath = path;
  document.title = tab.title;
  paint(tab.html, tab.outline, tab.anchor);
  renderTabs();
  updateHeader();
  setStatus(tab.missing ? "File is missing from disk" : tab.path, "", false);
}

function closeTab(path) {
  if (!tabs.has(path)) return;

  const index = order.indexOf(path);
  tabs.delete(path);
  order = order.filter(p => p !== path);
  post("close-doc", path);

  if (activePath !== path) { renderTabs(); return; }

  if (order.length === 0) {
    activePath = null;
    document.title = "MarkdownViewer";
    paint("", [], null);
    renderTabs();
    updateHeader();
    setStatus("No document open", "Ctrl+O to open", false);
    return;
  }

  activate(order[Math.min(index, order.length - 1)]);
}

// ---------- messages from the host ----------

host.addEventListener("message", (event) => {
  const { type, payload } = event.data;

  if (type === "welcome") {
    paint(payload.html, payload.outline, null);
    renderTabs();
    updateHeader();
    setStatus("No document open", "Ctrl+O to open", false);
    return;
  }

  if (type === "downloading") {
    setStatus("Downloading " + payload.title + " from OneDrive…", "", false);
    return;
  }

  if (type === "error") {
    setStatus(payload.message, "", false);
    return;
  }

  if (type === "doc-opened") {
    const existing = tabs.get(payload.path);
    tabs.set(payload.path, { ...payload, anchor: existing ? existing.anchor : null });
    if (!order.includes(payload.path)) order.push(payload.path);
    activate(payload.path);
    return;
  }

  if (type === "doc-updated") {
    const existing = tabs.get(payload.path);
    if (!existing) return;

    tabs.set(payload.path, { ...payload, anchor: existing.anchor });

    if (payload.path !== activePath) {
      renderTabs();
      const tab = tabstripEl.querySelector(`[data-path="${CSS.escape(payload.path)}"]`);
      if (tab) {
        tab.classList.add("changed");
        setTimeout(() => tab.classList.remove("changed"), 2500);
      }
      return;
    }

    const anchor = captureAnchor();
    paint(payload.html, payload.outline, anchor);
    tabs.get(payload.path).anchor = anchor;
    updateHeader();
    setStatus(payload.missing ? "File is missing from disk" : payload.path, "", true);
  }
});

// ---------- input ----------

tabstripEl.addEventListener("click", (event) => {
  const close = event.target.closest("[data-close]");
  if (close) { event.stopPropagation(); closeTab(close.dataset.close); return; }

  const tab = event.target.closest("[data-path]");
  if (tab) activate(tab.dataset.path);
});

// Middle-click closes, same as a browser.
tabstripEl.addEventListener("auxclick", (event) => {
  if (event.button !== 1) return;
  const tab = event.target.closest("[data-path]");
  if (tab) { event.preventDefault(); closeTab(tab.dataset.path); }
});

docEl.addEventListener("click", (event) => {
  const link = event.target.closest("a[href]");
  if (!link) return;

  const href = link.getAttribute("href");

  if (href.startsWith("#")) {
    event.preventDefault();
    const target = docEl.querySelector(`[id="${CSS.escape(decodeURIComponent(href.slice(1)))}"]`);
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }

  // Links to other local files become tabs rather than navigating the shell away.
  if (href.startsWith("https://mdopen.local/")) {
    event.preventDefault();
    const encoded = href.slice("https://mdopen.local/".length).split("#")[0];
    post("open-file", decodeURIComponent(encoded));
    return;
  }

  if (href.startsWith("http://") || href.startsWith("https://")) {
    event.preventDefault();
    post("open-external", href);
  }
});

outlineEl.addEventListener("click", (event) => {
  const link = event.target.closest("a");
  if (!link) return;
  event.preventDefault();
  const target = docEl.querySelector(`[id="${CSS.escape(decodeURIComponent(link.hash.slice(1)))}"]`);
  if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
});

document.addEventListener("keydown", (event) => {
  if (!event.ctrlKey && !event.metaKey) return;

  const scope = hoveredScope || "doc";

  switch (event.key) {
    case "o": event.preventDefault(); post("pick-file"); return;
    case "w": event.preventDefault(); if (activePath) closeTab(activePath); return;
    case "0": event.preventDefault(); setZoom(scope, 1); return;
    case "+":
    case "=": event.preventDefault(); nudgeZoom(scope, 1); return;
    case "-": event.preventDefault(); nudgeZoom(scope, -1); return;
  }

  if (event.key === "Tab" && order.length > 1) {
    event.preventDefault();
    const index = order.indexOf(activePath);
    const next = event.shiftKey
      ? (index - 1 + order.length) % order.length
      : (index + 1) % order.length;
    activate(order[next]);
  }
});

applyZoom("doc");
applyZoom("outline");
post("ready");
