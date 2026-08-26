/**
 * Loads the real index.html and every script into jsdom, drives the UI through the
 * same messages the C# host sends, and asserts on the resulting DOM.
 *
 * Catches the failure mode a process-liveness smoke test cannot: a JS exception that
 * leaves the window blank while the process happily keeps running.
 */
import { readFileSync, existsSync } from "fs";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const here = dirname(fileURLToPath(import.meta.url));
const WEB = join(here, "..", "MarkdownViewer", "web") + "/";

// jsdom is test-only and is deliberately not a dependency of this project -- nothing
// it pulls in ever ships. Reuse the copy the sibling ConfigEditor tooling
// already installed, and fall back to a local install if one is ever added here.
const candidates = [
  join(here, "package.json"),
  join(here, "..", "..", "ConfigEditor", "scripts", "package.json")
];

let JSDOM;
let VirtualConsole;

for (const candidate of candidates) {
  if (!existsSync(candidate)) continue;
  try {
    ({ JSDOM, VirtualConsole } = createRequire(candidate)("jsdom"));
    break;
  } catch { /* try the next candidate */ }
}

if (!JSDOM) {
  console.error("jsdom not found. Install it here, or in ConfigEditor/scripts.");
  process.exit(2);
}

const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on("jsdomError", e => errors.push("jsdomError: " + (e.stack || e.message)));
virtualConsole.on("error", (...a) => errors.push("console.error: " + a.join(" ")));

const html = readFileSync(WEB + "index.html", "utf8");

const posted = [];
const dom = new JSDOM(html, { runScripts: "outside-only", virtualConsole, pretendToBeVisual: true });
const { window } = dom;

// Stand in for the WebView2 bridge.
const listeners = [];
window.chrome = {
  webview: {
    postMessage: m => posted.push(m),
    addEventListener: (_, fn) => listeners.push(fn)
  }
};
window.CSS = window.CSS || {};
if (!window.CSS.escape) window.CSS.escape = s => String(s).replace(/[^\w-]/g, c => "\\" + c);
window.navigator.clipboard = { writeText: async () => {} };

// jsdom implements no layout, so these are absent. The app only uses them for effect.
window.Element.prototype.scrollIntoView = function () {};

for (const file of ["highlight.js", "zoom.js", "layout.js", "workspace.js", "find.js", "editor.js", "app.js"]) {
  try {
    window.eval(readFileSync(WEB + file, "utf8"));
  } catch (e) {
    errors.push(`${file} threw at load: ${e.message}`);
  }
}

function send(type, payload) {
  for (const fn of listeners) fn({ data: { type, payload } });
}

function doc(path, title, headings = []) {
  return {
    path, title,
    folder: path.substring(0, path.lastIndexOf("\\")),
    html: `<h1 id="top">${title}</h1><p>Body of ${title}.</p>` +
          headings.map(h => `<h2 id="${h}">${h}</h2><p>x</p>`).join("") +
          '<pre><code class="language-csharp">var x = "hi";</code></pre>',
    outline: [{ level: 1, text: title, id: "top" },
              ...headings.map(h => ({ level: 2, text: h, id: h }))],
    missing: false,
    loadedAt: new Date().toISOString()
  };
}

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, ok: !!condition, detail });
}

const $ = s => window.document.querySelector(s);
const $$ = s => [...window.document.querySelectorAll(s)];

// --- stylesheet invariants ---
// jsdom performs no layout, so geometry bugs are invisible here. These assert the
// specific shape that broke once: .shell was a grid with a three-row template, and
// hiding the find bar (display:none takes no grid cell) shifted .body into the auto
// row and handed the free space to the status bar.
const cssText = readFileSync(WEB + "styles.css", "utf8");
const shellRule = cssText.match(/\.shell\s*\{[^}]*\}/)?.[0] ?? "";
const bodyRule = cssText.match(/^\.body\s*\{[^}]*\}/m)?.[0] ?? "";

check("shell is a flex column, not a fixed grid row template",
      /display:\s*flex/.test(shellRule) && /flex-direction:\s*column/.test(shellRule),
      shellRule.replace(/\s+/g, " "));
check("shell does not use grid-template-rows",
      !/grid-template-rows/.test(shellRule));
check("body is the flexible child", /flex:\s*1 1 auto/.test(bodyRule),
      bodyRule.replace(/\s+/g, " "));

// The same trap bit twice: a display:none child takes no grid cell, so a fixed
// template silently shifts every sibling. Neither axis may use one.
check("body is a flex row, not a fixed column template",
      /display:\s*flex/.test(bodyRule) && !/grid-template-columns/.test(bodyRule),
      bodyRule.replace(/\s+/g, " "));

const sidebarRule = cssText.match(/^\.sidebar\s*\{[^}]*\}/m)?.[0] ?? "";
const outlineRule = cssText.match(/^\.pane-outline\s*\{[^}]*\}/m)?.[0] ?? "";
const panesRule = cssText.match(/^\.panes\s*\{[^}]*\}/m)?.[0] ?? "";

check("sidebar sizes itself", /flex:\s*0 0 /.test(sidebarRule), sidebarRule.replace(/\s+/g, " "));
check("outline sizes itself", /flex:\s*0 0 /.test(outlineRule), outlineRule.replace(/\s+/g, " "));
check("panes take the remaining width", /flex:\s*1 1 0/.test(panesRule), panesRule.replace(/\s+/g, " "));

// --- boot ---
check("ready posted on boot", posted.some(m => m.type === "ready"));
check("one pane exists at boot", $$(".pane").length === 1, `found ${$$(".pane").length}`);

// --- opening documents ---
send("doc-opened", doc("C:\\docs\\alpha.md", "Alpha", ["Section A"]));
send("doc-opened", doc("C:\\docs\\beta.md", "Beta"));

check("two tabs in the pane", $$(".pane .tab").length === 2, `found ${$$(".pane .tab").length}`);
check("second doc is active", $(".pane .tab.active .tab-label")?.textContent === "Beta",
      $(".pane .tab.active .tab-label")?.textContent);
check("document body rendered", $(".pane .doc h1")?.textContent === "Beta");
check("header shows name", $(".dochead-name")?.textContent === "Beta");
check("header shows folder", $(".dochead-folder")?.textContent === "C:\\docs");
check("header shows updated", /^updated /.test($(".dochead-updated")?.textContent || ""));
const tokens = $$('.pane .doc pre span[class^="hl-"]');
check("syntax highlighting applied", tokens.length > 0,
      `${tokens.length} tokens: ${tokens.map(t => t.className + "=" + t.textContent).join(", ")}`);
check("code block tagged with language", $(".pane .doc pre")?.dataset.lang === "csharp",
      $(".pane .doc pre")?.dataset.lang);
check("copy button added", $$(".pane .doc pre .copy").length === 1);
check("sync-open reports both", (posted.filter(m => m.type === "sync-open").pop()?.payload || []).length === 2);

// --- outline follows the active tab ---
send("doc-opened", doc("C:\\docs\\alpha.md", "Alpha", ["Section A"]));
check("outline lists headings", $$("#outline a").length === 2, `${$$("#outline a").length} entries`);

// --- splitting ---
const beforeSplit = $$(".pane").length;
Layout_split();
function Layout_split() {
  window.eval(`
    (function(){
      var pane = Layout.activePane();
      var created = Layout.split(pane.id, "row");
      if (created && pane.active) Layout.addTab(created.id, pane.active);
      Layout.render();
    })();
  `);
}
check("split created a second pane", $$(".pane").length === beforeSplit + 1,
      `${beforeSplit} -> ${$$(".pane").length}`);
check("divider rendered", $$(".divider").length === 1);
check("both panes render content", $$(".pane .doc h1").length === 2,
      `${$$(".pane .doc h1").length} rendered`);
check("each pane has its own zoom badge", $$(".pane [data-zoom-badge]").length === 2);

// --- live update reaches every pane showing the file ---
const updated = doc("C:\\docs\\alpha.md", "Alpha", ["Section A", "Section B"]);
updated.html = '<h1 id="top">Alpha</h1><p>REWRITTEN.</p>';
send("doc-updated", updated);
check("update repainted panes showing the file",
      $$(".pane .doc").filter(d => d.innerHTML.includes("REWRITTEN")).length >= 1,
      `${$$(".pane .doc").filter(d => d.innerHTML.includes("REWRITTEN")).length} panes`);

// --- zoom is per pane ---
window.eval('Zoom.set("pane:" + Layout.panes()[0].id, 1.5)');
const sizes = $$(".pane .doc").map(d => d.style.fontSize);
check("zoom applied to one pane only", sizes[0] !== sizes[1], sizes.join(" vs "));
check("zoom badge shows level", $(".pane [data-zoom-badge]")?.textContent === "150%",
      $(".pane [data-zoom-badge]")?.textContent);
check("outline zoom independent of pane zoom",
      $("#outline").style.fontSize !== sizes[0], `outline=${$("#outline").style.fontSize}`);

// --- closing collapses an emptied pane ---
window.eval(`
  (function(){
    var panes = Layout.panes();
    var last = panes[panes.length - 1];
    last.tabs.slice().forEach(function(t){ Layout.closeTab(last.id, t); });
    Layout.render();
  })();
`);
check("emptied pane collapsed", $$(".pane").length === 1, `${$$(".pane").length} panes remain`);

// --- association button ---
send("association", { registered: false, exe: "C:\\app\\MarkdownViewer.exe" });
check("association offer shown when unregistered", $("#assocButton").hidden === false);
send("association", { registered: true, exe: "C:\\app\\MarkdownViewer.exe" });
check("association offer hidden once registered", $("#assocButton").hidden === true);

// --- workspace tree ---
// Build paths from a char code so no backslash escaping survives to confuse the data.
const SEP = String.fromCharCode(92);
const ROOT = "C:" + SEP + "proj";
const API = ROOT + SEP + "api";

send("workspace", {
  root: ROOT, name: "proj", truncated: false,
  entries: [
    { path: ROOT + SEP + "guide.md",  name: "guide.md",  parent: ROOT, dir: false },
    { path: API,                      name: "api",       parent: ROOT, dir: true  },
    { path: API + SEP + "config.md",  name: "config.md", parent: API,  dir: false },
    { path: API + SEP + "auth.md",    name: "auth.md",   parent: API,  dir: false }
  ]
});

check("sidebar shown when a workspace opens", $("#sidebar").hidden === false);
check("workspace name displayed", $("#workspaceName")?.textContent === "proj");
check("root files listed", $$("#tree .tree-file").length >= 1, `${$$("#tree .tree-file").length}`);
check("subfolder listed", $$("#tree .tree-dir").length === 1);
check("subfolder auto-expanded", $$("#tree .tree-file").length === 3,
      `${$$("#tree .tree-file").length} files visible`);
check("nested files indented deeper",
      parseFloat($$("#tree .tree-file")[2].style.paddingLeft) > parseFloat($$("#tree .tree-file")[0].style.paddingLeft));

// collapsing a directory hides its children
$$("#tree .tree-dir")[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("collapsing a folder hides its files", $$("#tree .tree-file").length === 1,
      `${$$("#tree .tree-file").length} visible`);
$$("#tree .tree-dir")[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

// clicking a file asks the host to open it
const beforeOpen = posted.filter(m => m.type === "open-file").length;
$$("#tree .tree-file")[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("clicking a tree file requests open",
      posted.filter(m => m.type === "open-file").length === beforeOpen + 1);

// --- quick open ---
window.eval("Workspace.openQuick()");
check("quick open appears", $("#quickOpen").hidden === false);
check("quick open lists every file", $$("#quickList .quick-row").length === 3,
      `${$$("#quickList .quick-row").length} rows`);

$("#quickInput").value = "auth";
$("#quickInput").dispatchEvent(new window.Event("input", { bubbles: true }));
check("quick open filters", $$("#quickList .quick-row").length === 1,
      `${$$("#quickList .quick-row").length} rows`);
check("quick open matched the right file",
      $("#quickList .quick-name")?.textContent === "auth.md",
      $("#quickList .quick-name")?.textContent);

$("#quickInput").value = "apcfg";
$("#quickInput").dispatchEvent(new window.Event("input", { bubbles: true }));
check("fuzzy subsequence matching works",
      $("#quickList .quick-name")?.textContent === "config.md",
      "rows=[" + $$("#quickList .quick-row").map(r => r.textContent).join(" | ") + "]");

$("#quickInput").value = "zzzznope";
$("#quickInput").dispatchEvent(new window.Event("input", { bubbles: true }));
check("no-match state shown", $$("#quickList .quick-empty").length === 1);

window.eval("Workspace.closeQuick()");
check("quick open closes", $("#quickOpen").hidden === true);

// --- session persistence ---
await new Promise(r => setTimeout(r, 600));
const saved = posted.filter(m => m.type === "save-session").pop();
check("session was saved", !!saved);
check("session records the workspace", saved?.payload?.workspace === ROOT, saved?.payload?.workspace);
check("session records the layout", !!saved?.payload?.layout);
check("session records expanded folders", Array.isArray(saved?.payload?.expanded));

// restore into a fresh layout
send("doc-opened", doc("C:\docs\gamma.md", "Gamma"));
window.eval(`
  (function(){
    var p = Layout.activePane();
    var c = Layout.split(p.id, "col");
    Layout.addTab(c.id, p.active);
    Layout.render();
  })();
`);
await new Promise(r => setTimeout(r, 600));
const snapshot = posted.filter(m => m.type === "save-session").pop().payload;
check("saved layout is a split", snapshot.layout.type === "split", snapshot.layout.type);

const beforeLoad = posted.filter(m => m.type === "load-docs").length;
send("session", snapshot);
check("restore rebuilt the split", $$(".pane").length === 2, `${$$(".pane").length} panes`);
check("restore requested document content",
      posted.filter(m => m.type === "load-docs").length === beforeLoad + 1);

// content arriving for a restored tab fills it without adding a tab
const tabsBefore = $$(".pane .tab").length;
send("doc-content", doc("C:\docs\gamma.md", "Gamma"));
check("doc-content did not add a tab", $$(".pane .tab").length === tabsBefore,
      `${tabsBefore} -> ${$$(".pane .tab").length}`);
check("doc-content painted the restored pane",
      $$(".pane .doc h1").some(h => h.textContent === "Gamma"));

// --- recent files feed quick-open when there is no workspace ---
send("workspace", { closed: true });
check("sidebar hides when the workspace closes", $("#sidebar").hidden === true);

window.eval("Workspace.openQuick(['C:" + SEP + SEP + "docs" + SEP + SEP + "alpha.md'])");
check("quick open falls back to recents", $("#quickOpen").hidden === false);
check("recent entry shows its file name",
      $("#quickList .quick-name")?.textContent === "alpha.md",
      $("#quickList .quick-name")?.textContent);
window.eval("Workspace.closeQuick()");

// --- find in page ---
function key(k, options = {}) {
  window.document.dispatchEvent(new window.KeyboardEvent("keydown",
    { key: k, bubbles: true, cancelable: true, ...options }));
}

// Collapse to a single pane with one known document first.
send("doc-opened", {
  path: "C:" + SEP + "docs" + SEP + "find.md",
  title: "find.md",
  folder: "C:" + SEP + "docs",
  html: "<h1 id=\"one\">Alpha heading</h1><p>alpha beta alpha</p>" +
        "<h2 id=\"two\">Beta heading</h2><p>gamma ALPHA delta</p>",
  outline: [{ level: 1, text: "Alpha heading", id: "one" },
            { level: 2, text: "Beta heading", id: "two" }],
  missing: false,
  loadedAt: new Date().toISOString()
});

check("find bar hidden by default", $("#findBar").hidden === true);

key("f", { ctrlKey: true });
check("Ctrl+F opens the find bar", $("#findBar").hidden === false);
check("find bar names the document it searches", $("#findScope")?.textContent === "find.md",
      $("#findScope")?.textContent);

$("#findInput").value = "alpha";
$("#findInput").dispatchEvent(new window.Event("input", { bubbles: true }));

const marks = $$(".pane .doc mark.find-hit");
check("find highlights every match, case-insensitively", marks.length === 4,
      `${marks.length} marks: ${marks.map(m => m.textContent).join(",")}`);
check("match count reported", $("#findCount")?.textContent === "1 of 4", $("#findCount")?.textContent);
check("first match is current", $$(".pane .doc mark.find-current").length === 1);

$("#findInput").dispatchEvent(new window.KeyboardEvent("keydown",
  { key: "Enter", bubbles: true, cancelable: true }));
check("Enter advances the match", $("#findCount")?.textContent === "2 of 4", $("#findCount")?.textContent);

$("#findInput").dispatchEvent(new window.KeyboardEvent("keydown",
  { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
check("Shift+Enter goes back", $("#findCount")?.textContent === "1 of 4", $("#findCount")?.textContent);

$("#findInput").value = "zzzznope";
$("#findInput").dispatchEvent(new window.Event("input", { bubbles: true }));
check("no-results state", $("#findCount")?.textContent === "no results", $("#findCount")?.textContent);
check("no marks left when nothing matches", $$(".pane .doc mark.find-hit").length === 0);

// A live reload must not lose the highlights.
$("#findInput").value = "alpha";
$("#findInput").dispatchEvent(new window.Event("input", { bubbles: true }));
send("doc-updated", {
  path: "C:" + SEP + "docs" + SEP + "find.md",
  title: "find.md",
  folder: "C:" + SEP + "docs",
  html: "<h1 id=\"one\">Alpha heading</h1><p>alpha beta alpha rewritten</p>",
  outline: [{ level: 1, text: "Alpha heading", id: "one" }],
  missing: false,
  loadedAt: new Date().toISOString()
});
check("search survives a live reload", $$(".pane .doc mark.find-hit").length === 3,
      `${$$(".pane .doc mark.find-hit").length} marks after reload`);

const textBefore = $(".pane .doc").textContent;
key("Escape");
check("Escape closes find", $("#findBar").hidden === true);
check("closing find removes every mark", $$(".pane .doc mark.find-hit").length === 0);
check("closing find leaves the text unchanged", $(".pane .doc").textContent === textBefore);

// --- outline scroll-spy ---
// jsdom performs no layout, so offsets are stubbed to simulate a scrolled document.
const scroller = $(".pane .doc");
send("doc-opened", {
  path: "C:" + SEP + "docs" + SEP + "spy.md",
  title: "spy.md",
  folder: "C:" + SEP + "docs",
  html: "<h1 id=\"h1\">First</h1><p>x</p><h2 id=\"h2\">Second</h2><p>y</p><h2 id=\"h3\">Third</h2>",
  outline: [{ level: 1, text: "First", id: "h1" },
            { level: 2, text: "Second", id: "h2" },
            { level: 2, text: "Third", id: "h3" }],
  missing: false,
  loadedAt: new Date().toISOString()
});

const live = $(".pane .doc");
const offsets = { h1: 0, h2: 500, h3: 1000 };
for (const [id, top] of Object.entries(offsets)) {
  Object.defineProperty(live.querySelector("#" + id), "offsetTop", { value: top, configurable: true });
}

function spyAt(scrollTop) {
  Object.defineProperty(live, "scrollTop", { value: scrollTop, configurable: true, writable: true });
  live.dispatchEvent(new window.Event("scroll"));
  return new Promise(r => setTimeout(r, 20));
}

await spyAt(600);
const currentLinks = $$("#outline a.current");
check("scroll-spy marks exactly one heading", currentLinks.length === 1,
      `${currentLinks.length} marked`);
check("scroll-spy marks the heading the reader is under",
      currentLinks[0]?.textContent === "Second", currentLinks[0]?.textContent);

await spyAt(1200);
check("scroll-spy follows further scrolling",
      $("#outline a.current")?.textContent === "Third", $("#outline a.current")?.textContent);

// --- task list checkboxes write back to the file ---
send("doc-opened", {
  path: "C:" + SEP + "docs" + SEP + "todo.md",
  title: "todo.md",
  folder: "C:" + SEP + "docs",
  html: '<ul><li><input class="task" type="checkbox" data-task="0" />first</li>' +
        '<li><input class="task" type="checkbox" data-task="1" checked="checked" />second</li></ul>',
  outline: [],
  missing: false,
  loadedAt: new Date().toISOString()
});

const boxes = $$(".pane .doc input.task");
check("checkboxes render enabled", boxes.length === 2 && !boxes[0].disabled,
      `${boxes.length} boxes, disabled=${boxes[0]?.disabled}`);

const beforeToggle = posted.filter(m => m.type === "toggle-task").length;
boxes[0].checked = true;
boxes[0].dispatchEvent(new window.Event("change", { bubbles: true }));

const toggle = posted.filter(m => m.type === "toggle-task").pop();
check("ticking a box asks the host to edit the file",
      posted.filter(m => m.type === "toggle-task").length === beforeToggle + 1);
check("toggle carries the index and state",
      toggle?.payload?.index === 0 && toggle?.payload?.checked === true,
      JSON.stringify(toggle?.payload));
check("toggle targets the right document",
      toggle?.payload?.path?.endsWith("todo.md"), toggle?.payload?.path);

// --- edit mode ---
// NL avoids backslash escapes entirely; they have been mangled by tooling before.
const NL = String.fromCharCode(10);
const SRC_CLEAN = "# Title" + NL + NL + "body" + NL;
const SRC_EDITED = "# Title" + NL + NL + "edited" + NL;
const SRC_MINE = "# Title" + NL + NL + "mine" + NL;

const EDIT_PATH = "C:" + SEP + "docs" + SEP + "edit.md";
function editDoc(bodyHtml) {
  return {
    path: EDIT_PATH, title: "edit.md", folder: "C:" + SEP + "docs",
    html: '<h1 id="t">Title</h1><p>' + bodyHtml + '</p>',
    outline: [{ level: 1, text: "Title", id: "t" }],
    missing: false, loadedAt: new Date().toISOString()
  };
}

send("doc-opened", editDoc("body"));

check("editor hidden in view mode", $(".pane .editor")?.hidden === true);
check("mode button says Edit", $(".pane .mode-button")?.textContent === "Edit");

const beforeText = posted.filter(m => m.type === "get-text").length;
key("e", { ctrlKey: true });
check("Ctrl+E reveals the editor", $(".pane .editor")?.hidden === false);
check("rendered view hides while editing", $(".pane .doc")?.hidden === true);
check("entering edit mode requests the source",
      posted.filter(m => m.type === "get-text").length === beforeText + 1);

send("doc-text", { path: EDIT_PATH, text: SRC_CLEAN });
check("editor receives the source", $(".pane .editor")?.value === SRC_CLEAN,
      JSON.stringify($(".pane .editor")?.value));
check("clean buffer is not marked dirty", $$(".pane .tab.dirty").length === 0);

$(".pane .editor").value = SRC_EDITED;
$(".pane .editor").dispatchEvent(new window.Event("input", { bubbles: true }));
check("typing marks the tab dirty", $$(".pane .tab.dirty").length === 1);

const beforeSave = posted.filter(m => m.type === "save-doc").length;
key("s", { ctrlKey: true });
const save = posted.filter(m => m.type === "save-doc").pop();
check("Ctrl+S sends a save", posted.filter(m => m.type === "save-doc").length === beforeSave + 1);
check("save carries the edited text", save?.payload?.text === SRC_EDITED,
      JSON.stringify(save?.payload?.text));
check("save is not forced by default", save?.payload?.force === false);

send("save-result", { path: EDIT_PATH, saved: true, conflict: false });
check("successful save clears the dirty mark", $$(".pane .tab.dirty").length === 0);

// A conflicting save must warn rather than overwrite.
$(".pane .editor").value = SRC_MINE;
$(".pane .editor").dispatchEvent(new window.Event("input", { bubbles: true }));
send("save-result", { path: EDIT_PATH, saved: false, conflict: true });
check("conflict shows a notice", $(".pane .pane-notice")?.hidden === false);
check("conflict offers both choices", $$(".pane .pane-notice button").length === 2,
      `${$$(".pane .pane-notice button").length} buttons`);
check("conflict keeps the user's text", $(".pane .editor")?.value === SRC_MINE);

// An external change must not clobber an unsaved buffer.
send("doc-updated", editDoc("from disk"));
check("external change does not overwrite unsaved text",
      $(".pane .editor")?.value === SRC_MINE,
      JSON.stringify($(".pane .editor")?.value));

key("e", { ctrlKey: true });
check("Ctrl+E returns to the rendered view", $(".pane .doc")?.hidden === false);

// --- report ---
console.log("");
for (const r of results) {
  console.log(`${r.ok ? "  ok  " : "  FAIL"}  ${r.name}${r.detail && !r.ok ? "   [" + r.detail + "]" : ""}`);
}
const failed = results.filter(r => !r.ok).length;
console.log("");
if (errors.length) {
  console.log("JS ERRORS:");
  for (const e of errors) console.log("   " + e);
}
console.log(`${results.length - failed}/${results.length} passed, ${errors.length} JS errors`);
process.exit(failed || errors.length ? 1 : 0);
