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
const WEB = join(here, "..", "GreenMD", "web") + "/";

// jsdom is test-only. It is declared in tests/package.json and nothing it pulls in
// ever ships -- the application itself has no JavaScript dependencies at all.
const candidates = [join(here, "package.json")];

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
  console.error("jsdom not found. Run: npm install --prefix tests");
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

for (const file of ["highlight.js", "zoom.js", "layout.js", "workspace.js", "find.js", "editor.js", "panels.js", "menu.js", "app.js"]) {
  try {
    window.eval(readFileSync(WEB + file, "utf8"));
  } catch (e) {
    errors.push(`${file} threw at load: ${e.message}`);
  }
}

if (errors.length) {
  console.log("LOAD ERRORS:");
  for (const e of errors) console.log("  " + e);
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
send("association", { registered: false, exe: "C:\\app\\GreenMD.exe" });
check("association offer shown when unregistered", $("#assocButton").hidden === false);
send("association", { registered: true, exe: "C:\\app\\GreenMD.exe" });
check("association offer hidden once registered", $("#assocButton").hidden === true);

// --- workspace tree ---
// Build paths from a char code so no backslash escaping survives to confuse the data.
const SEP = String.fromCharCode(92);
const ROOT = "C:" + SEP + "proj";
const API = ROOT + SEP + "api";

send("workspace", { workspaces: [{
  root: ROOT, name: "proj", truncated: false,
  entries: [
    { path: ROOT + SEP + "guide.md",  name: "guide.md",  parent: ROOT, dir: false },
    { path: API,                      name: "api",       parent: ROOT, dir: true  },
    { path: API + SEP + "config.md",  name: "config.md", parent: API,  dir: false },
    { path: API + SEP + "auth.md",    name: "auth.md",   parent: API,  dir: false }
  ]
}] });

check("sidebar shown when a workspace opens", $("#sidebar").hidden === false);
check("workspace name displayed", $(".ws-name")?.textContent === "proj");
check("root files listed", $$(".ws-section .tree-file").length >= 1, `${$$(".ws-section .tree-file").length}`);
check("subfolder listed", $$(".ws-section .tree-dir").length === 1);
check("subfolder auto-expanded", $$(".ws-section .tree-file").length === 3,
      `${$$(".ws-section .tree-file").length} files visible`);
check("nested files indented deeper",
      parseFloat($$(".ws-section .tree-file")[2].style.paddingLeft) > parseFloat($$(".ws-section .tree-file")[0].style.paddingLeft));

// collapsing a directory hides its children
$$(".ws-section .tree-dir")[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("collapsing a folder hides its files", $$(".ws-section .tree-file").length === 1,
      `${$$(".ws-section .tree-file").length} visible`);
$$(".ws-section .tree-dir")[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

// clicking a file asks the host to open it
const beforeOpen = posted.filter(m => m.type === "open-file").length;
$$(".ws-section .tree-file")[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
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
check("session records the open folders",
      Array.isArray(saved?.payload?.workspaces) && saved.payload.workspaces.includes(ROOT),
      JSON.stringify(saved?.payload?.workspaces));
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
send("workspace", { workspaces: [] });
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

check("editor hidden in view mode", $(".pane .editor-wrap")?.hidden === true);
check("mode button says Edit", $(".pane .mode-button")?.textContent === "Edit");

const beforeText = posted.filter(m => m.type === "get-text").length;
key("e", { ctrlKey: true });
check("Ctrl+E reveals the editor", $(".pane .editor-wrap")?.hidden === false);
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

// The regression that actually cost data. Everything above only ever exercised the
// conflict path by handing the UI a save-result that already said conflict:true. The
// case nobody tested was pressing Ctrl+S once the buffer had gone stale, and it used
// to post an ordinary unforced save. That is not harmless: the host decides conflicts
// by comparing the file against the hash it last read from disk, and the live reload
// had already refreshed that hash, so it compared disk against itself, found no
// conflict, and wrote straight over the external edit. Reproduced against the real
// running app -- text written by another program was destroyed with no warning. The UI
// is the side that still knows the buffer was based on older text, so it stops here.
const beforeStaleSave = posted.filter(m => m.type === "save-doc").length;
key("s", { ctrlKey: true });
const staleSaves = posted.filter(m => m.type === "save-doc").slice(beforeStaleSave);
check("Ctrl+S on a stale buffer sends no unforced save",
      staleSaves.every(m => m.payload && m.payload.force === true),
      JSON.stringify(staleSaves.map(m => m.payload && m.payload.force)));
check("Ctrl+S on a stale buffer still shows the conflict notice",
      $(".pane .pane-notice")?.hidden === false);
check("Ctrl+S on a stale buffer keeps the user's text",
      $(".pane .editor")?.value === SRC_MINE);

// Deliberate overwrite has to keep working, or the fix has just broken the escape
// hatch instead of the bug.
const beforeForced = posted.filter(m => m.type === "save-doc").length;
$$(".pane .pane-notice button").find(b => b.textContent === "Keep mine")?.click();
const forced = posted.filter(m => m.type === "save-doc").pop();
check("Keep mine still forces the save through",
      posted.filter(m => m.type === "save-doc").length === beforeForced + 1
      && forced?.payload?.force === true,
      JSON.stringify(forced?.payload && forced.payload.force));

send("save-result", { path: EDIT_PATH, saved: true, conflict: false });

key("e", { ctrlKey: true });
check("Ctrl+E returns to the rendered view", $(".pane .doc")?.hidden === false);

// --- closing a dirty tab must not lose work ---
// Its own path: EDIT_PATH's buffer was marked stale by the external-change test
// above, and that notice would mask the close prompt.
const CLOSE_PATH = "C:" + SEP + "docs" + SEP + "closeguard.md";
function closeDoc() {
  return {
    path: CLOSE_PATH, title: "closeguard.md", folder: "C:" + SEP + "docs",
    html: '<h1 id="c">Close guard</h1><p>body</p>',
    outline: [{ level: 1, text: "Close guard", id: "c" }],
    missing: false, loadedAt: new Date().toISOString()
  };
}

send("doc-opened", closeDoc());
key("e", { ctrlKey: true });
send("doc-text", { path: CLOSE_PATH, text: SRC_CLEAN });
$(".pane .editor").value = SRC_MINE;
$(".pane .editor").dispatchEvent(new window.Event("input", { bubbles: true }));
// Scoped to this tab: an earlier test deliberately leaves its own buffer dirty.
const closeTabEl = () => $(`.pane .tab[data-path="${window.CSS.escape(CLOSE_PATH)}"]`);
check("tab marked dirty before close attempt",
      closeTabEl()?.classList.contains("dirty") === true,
      closeTabEl()?.className);
check("header shows an unsaved badge", $(".dochead-unsaved")?.hidden === false);

const tabsBeforeClose = $$(".pane .tab").length;
$(".pane .tab.active .tab-close").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("closing a dirty tab is refused", $$(".pane .tab").length === tabsBeforeClose,
      `${tabsBeforeClose} -> ${$$(".pane .tab").length}`);
check("the refused tab is still present", !!closeTabEl());
check("close prompt offers save, discard and keep",
      $$(".pane .pane-notice button").length === 3,
      [...$$(".pane .pane-notice button")].map(b => b.textContent).join("/"));
check("edited text is still intact", $(".pane .editor")?.value === SRC_MINE);

// "Keep editing" dismisses without closing.
[...$$(".pane .pane-notice button")].find(b => b.textContent === "Keep editing")
  .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("keep editing dismisses the prompt", $(".pane .pane-notice")?.hidden === true);
check("keep editing does not close the tab", $$(".pane .tab").length === tabsBeforeClose);

// Discard closes and drops the buffer.
$(".pane .tab.active .tab-close").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
[...$$(".pane .pane-notice button")].find(b => b.textContent === "Discard and close")
  .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("discard closes the tab", $$(".pane .tab").length === tabsBeforeClose - 1,
      `${tabsBeforeClose} -> ${$$(".pane .tab").length}`);

// --- active file is marked in the tree ---
// The marker was being destroyed by every tree rebuild, so each of these asserts a
// path that previously cleared it.
const TROOT = "C:" + SEP + "wsmark";
const TSUB = TROOT + SEP + "deep";
const TFILE = TSUB + SEP + "nested.md";

send("doc-opened", {
  path: TFILE, title: "nested.md", folder: TSUB,
  html: '<h1 id="n">Nested</h1>', outline: [{ level: 1, text: "Nested", id: "n" }],
  missing: false, loadedAt: new Date().toISOString()
});

send("workspace", { workspaces: [{
  root: TROOT, name: "wsmark", truncated: false,
  entries: [
    { path: TROOT + SEP + "top.md", name: "top.md", parent: TROOT, dir: false },
    { path: TSUB, name: "deep", parent: TROOT, dir: true },
    { path: TFILE, name: "nested.md", parent: TSUB, dir: false }
  ]
}] });

const marked = () => $$(".ws-section .tree-file.current").map(r => r.dataset.path);

check("active file is marked when the tree loads",
      marked().length === 1 && marked()[0] === TFILE, marked().join(","));
check("its folder was expanded so the row is visible",
      !!$(`.ws-section .tree-file[data-path="${window.CSS.escape(TFILE)}"]`));

// Expanding or collapsing a folder rebuilds the tree.
$$(".ws-section .tree-dir")[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
$$(".ws-section .tree-dir")[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("marker survives a folder toggle",
      marked().length === 1 && marked()[0] === TFILE, marked().join(","));

// So does hiding and showing the panel.
window.eval("Workspace.setVisible(false)");
window.eval("Workspace.setVisible(true)");
check("marker survives hiding the panel",
      marked().length === 1 && marked()[0] === TFILE, marked().join(","));

// Switching to another document moves the marker off.
send("doc-opened", {
  path: TROOT + SEP + "top.md", title: "top.md", folder: TROOT,
  html: '<h1 id="t">Top</h1>', outline: [{ level: 1, text: "Top", id: "t" }],
  missing: false, loadedAt: new Date().toISOString()
});
check("marker follows the active document",
      marked().length === 1 && marked()[0] === TROOT + SEP + "top.md", marked().join(","));

send("workspace", { workspaces: [] });

// --- multiple folders ---
const R1 = "C:" + SEP + "alpha";
const R2 = "C:" + SEP + "beta";

send("workspace", { workspaces: [
  { root: R1, name: "alpha", truncated: false, entries: [
    { path: R1 + SEP + "a1.md", name: "a1.md", parent: R1, dir: false },
    { path: R1 + SEP + "a2.md", name: "a2.md", parent: R1, dir: false }
  ]},
  { root: R2, name: "beta", truncated: false, entries: [
    { path: R2 + SEP + "b1.md", name: "b1.md", parent: R2, dir: false }
  ]}
]});

check("one section per folder", $$(".ws-section").length === 2,
      `${$$(".ws-section").length} sections`);
check("a divider sits between them", $$(".ws-divider").length === 1);
check("sections are named", $$(".ws-name").map(n => n.textContent).join(",") === "alpha,beta",
      $$(".ws-name").map(n => n.textContent).join(","));
check("each section shows its file count",
      $$(".ws-count").map(c => c.textContent).join(",") === "2,1",
      $$(".ws-count").map(c => c.textContent).join(","));
check("files from both folders are listed", $$(".ws-section .tree-file").length === 3,
      `${$$(".ws-section .tree-file").length}`);
check("sections start with equal weight",
      $$(".ws-section").every(sec => sec.style.flex.startsWith("1 1")),
      $$(".ws-section").map(sec => sec.style.flex).join(" | "));

// Collapsing a section drops it to header height and gives up its share.
$$(".ws-header")[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("collapsing a section hides its tree",
      $$(".ws-section")[0].querySelector(".tree") === null);
check("a collapsed section claims no space",
      $$(".ws-section")[0].style.flex === "0 0 auto",
      $$(".ws-section")[0].style.flex);
check("the other folder still lists its files",
      $$(".ws-section .tree-file").length === 1);
$$(".ws-header")[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

// Quick open spans every folder and disambiguates by folder name.
window.eval("Workspace.openQuick()");
check("quick open spans both folders", $$("#quickList .quick-row").length === 3,
      `${$$("#quickList .quick-row").length}`);
$("#quickInput").value = "beta";
$("#quickInput").dispatchEvent(new window.Event("input", { bubbles: true }));
check("quick open can be narrowed to one folder",
      $("#quickList .quick-name")?.textContent === "b1.md",
      $("#quickList .quick-name")?.textContent);
window.eval("Workspace.closeQuick()");

// Closing one folder asks the host to drop just that root.
const beforeClose = posted.filter(m => m.type === "close-workspace").length;
$$(".ws-header")[1].querySelector("[data-close-root]")
  .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const closeMsg = posted.filter(m => m.type === "close-workspace").pop();
check("closing a section targets one folder",
      posted.filter(m => m.type === "close-workspace").length === beforeClose + 1
      && closeMsg?.payload === R2, JSON.stringify(closeMsg?.payload));

// Section weights and collapsed roots round-trip.
// Passed through a property rather than interpolated into a string: a Windows path
// inside eval'd source needs escaping, and that has gone wrong more than once here.
window.__testRoot = R1;
window.eval("Workspace.setSectionWeights({ [window.__testRoot]: 3 })");
await new Promise(r => setTimeout(r, 600));
const wsSave = posted.filter(m => m.type === "save-session").pop();
check("section weights are persisted",
      wsSave?.payload?.sectionWeights && Object.keys(wsSave.payload.sectionWeights).length > 0,
      JSON.stringify(wsSave?.payload?.sectionWeights));
check("open folders are persisted as a list",
      Array.isArray(wsSave?.payload?.workspaces),
      JSON.stringify(wsSave?.payload?.workspaces));

send("workspace", { workspaces: [] });
check("no sections when every folder is closed", $$(".ws-section").length === 0);

// --- side panel toggles ---
check("outline panel starts visible", $(".pane-outline").hidden === false);
$("#toggleOutline").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("outline toggle hides the panel", $(".pane-outline").hidden === true);
check("its divider hides with it", $("#outlineDivider").hidden === true);
check("outline toggle reflects the off state",
      $("#toggleOutline").classList.contains("on") === false);
key("O", { ctrlKey: true, shiftKey: true });
check("Ctrl+Shift+O brings it back", $(".pane-outline").hidden === false);

// --- menu bar: every shortcut must also be a button ---
check("menu bar rendered", $$(".menubar .menu").length >= 4,
      `${$$(".menubar .menu").length} menus`);

const menuCommands = new Set($$(".menu-item").map(i => i.dataset.command));
const bound = window.eval("KEY_BINDINGS.map(b => b.command)");
const unreachable = [...new Set(bound)].filter(c => !menuCommands.has(c));
check("every key binding has a menu entry", unreachable.length === 0,
      "missing: " + unreachable.join(", "));
check("menu items show their shortcut",
      $$(".menu-item .menu-keys").some(k => /Ctrl\+/.test(k.textContent)));

// Opening a menu and clicking an item runs the command.
$$(".menu-title")[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("clicking a menu title opens it", $$(".menu.open").length === 1);

const beforeMenuOpen = posted.filter(m => m.type === "pick-file").length;
$(".menu-item[data-command='openFile']").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("a menu item runs its command",
      posted.filter(m => m.type === "pick-file").length === beforeMenuOpen + 1);
check("choosing an item closes the menu", $$(".menu.open").length === 0);

// Availability. classList.toggle treats an undefined second argument as "no
// argument" and flips the class, so commands with no availability rule used to
// flicker between greyed and not on every refresh.
window.eval("Menu.refresh()");
window.eval("Menu.refresh()");
window.eval("Menu.refresh()");
const alwaysOn = ["openFile", "addFolder", "goToFile", "find", "swapPanels", "resetPaneWidths"];
const wronglyGreyed = alwaysOn.filter(id =>
  $(`.menu-item[data-command='${id}']`)?.classList.contains("unavailable"));
check("commands with no availability rule are never greyed",
      wronglyGreyed.length === 0, "greyed: " + wronglyGreyed.join(", "));

// And one that genuinely is unavailable still greys, with a reason.
const saveItem = $(".menu-item[data-command='save']");
check("save is greyed when there is nothing to save",
      saveItem?.classList.contains("unavailable") === true);
check("a greyed item explains itself", (saveItem?.title || "").length > 0, saveItem?.title);
check("a greyed item is marked disabled for assistive tech",
      saveItem?.getAttribute("aria-disabled") === "true");

// Clicking a greyed item must not run it, but must say why.
const beforeGreyClick = posted.length;
$$(".menu-title")[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
saveItem.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("clicking a greyed item does not run the command", posted.length === beforeGreyClick,
      `${posted.length - beforeGreyClick} messages posted`);
check("clicking a greyed item explains why in the status bar",
      ($("#statusText").textContent || "").length > 0, $("#statusText").textContent);

// Hovering away closes the menu after the grace period.
$$(".menu-title")[1].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("a menu is open before the hover test", $$(".menu.open").length === 1);

$$(".menu")[1].dispatchEvent(new window.MouseEvent("mouseleave", { bubbles: false }));
check("the menu stays open during the grace period", $$(".menu.open").length === 1);

await new Promise(r => setTimeout(r, window.eval("Menu.closeGraceMs") + 120));
check("hovering away closes the menu", $$(".menu.open").length === 0);

// Returning within the grace period keeps it open.
$$(".menu-title")[1].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
$$(".menu")[1].dispatchEvent(new window.MouseEvent("mouseleave", { bubbles: false }));
$$(".menu")[1].dispatchEvent(new window.MouseEvent("mouseenter", { bubbles: false }));
await new Promise(r => setTimeout(r, window.eval("Menu.closeGraceMs") + 120));
check("coming back within the grace period keeps it open", $$(".menu.open").length === 1);
window.eval("Menu.close()");

// --- panel widths and swapping ---
window.eval("Panels.resetWidths()");
const widthOf = name => $(".body").style.getPropertyValue("--" + name + "-width");
check("reset sets both panel widths", widthOf("sidebar") === "230px" && widthOf("outline") === "260px",
      widthOf("sidebar") + " / " + widthOf("outline"));

const orderBefore = [$("#sidebar").style.order, $("#panes").style.order, $(".pane-outline").style.order];
$("#swapPanels").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const orderAfter = [$("#sidebar").style.order, $("#panes").style.order, $(".pane-outline").style.order];
check("swapping reorders the panels", orderBefore.join(",") !== orderAfter.join(","),
      orderBefore.join(",") + " -> " + orderAfter.join(","));
check("the document pane stays in the middle", orderAfter[1] === "3", orderAfter[1]);
check("swap button reflects the state", $("#swapPanels").classList.contains("on"));

$("#swapPanels").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("swapping back restores the original order",
      [$("#sidebar").style.order, $("#panes").style.order, $(".pane-outline").style.order].join(",")
      === orderBefore.join(","));

// With no workspace bound there is nothing to show, so the button offers to pick one.
const beforePick = posted.filter(m => m.type === "pick-folder").length;
$("#toggleSidebar").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("files toggle asks for a folder when none is open",
      posted.filter(m => m.type === "pick-folder").length === beforePick + 1);

// Panel state must round-trip through the session.
$("#toggleOutline").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await new Promise(r => setTimeout(r, 600));
const panelSave = posted.filter(m => m.type === "save-session").pop();
check("panel state is persisted", panelSave?.payload?.panels?.outline === false,
      JSON.stringify(panelSave?.payload?.panels));

send("session", { ...panelSave.payload, panels: { sidebar: true, outline: true } });
check("restored panel state is applied, not just read",
      $(".pane-outline").hidden === false);

// --- opening a file that is already open ---
// Launching GreenMD with a file must join the restored session rather than replace
// it, and must jump to an existing tab rather than opening a second copy.
const OPEN_A = "C:" + SEP + "reopen" + SEP + "alpha.md";
const OPEN_B = "C:" + SEP + "reopen" + SEP + "beta.md";
function reopenDoc(path, title) {
  return {
    path, title, folder: "C:" + SEP + "reopen",
    html: '<h1 id="r">' + title + '</h1>',
    outline: [{ level: 1, text: title, id: "r" }],
    missing: false, loadedAt: new Date().toISOString()
  };
}

// A restored session with both files, then a split so they sit in different panes.
send("session", {
  panels: { sidebar: false, outline: true, swapped: false, sidebarWidth: 230, outlineWidth: 260 },
  layout: {
    type: "split", dir: "row", sizes: [0.5, 0.5],
    children: [
      { type: "pane", tabs: [OPEN_A], active: OPEN_A, zoom: 1, modes: {} },
      { type: "pane", tabs: [OPEN_B], active: OPEN_B, zoom: 1, modes: {} }
    ]
  }
});
send("doc-content", reopenDoc(OPEN_A, "Alpha"));
send("doc-content", reopenDoc(OPEN_B, "Beta"));

const tabCount = () => $$(".pane .tab").length;
check("restored session has one tab per pane", tabCount() === 2, `${tabCount()}`);

// Make the first pane active, then "open" the file that lives in the second.
window.eval("Layout.setActive(Layout.panes()[0].id)");
send("doc-opened", reopenDoc(OPEN_B, "Beta"));

check("opening an already-open file adds no duplicate tab", tabCount() === 2,
      `${tabCount()} tabs: ` + $$(".pane .tab").map(t => t.title.split(SEP).pop()).join(", "));
check("it focuses the pane that already had the file",
      window.eval("Layout.activePane().active") === OPEN_B,
      window.eval("Layout.activePane().active"));

// A genuinely new file still opens as a new tab, in the active pane.
const OPEN_C = "C:" + SEP + "reopen" + SEP + "gamma.md";
send("doc-opened", reopenDoc(OPEN_C, "Gamma"));
check("a new file still opens as a new tab", tabCount() === 3, `${tabCount()}`);

// --- closing the window with unsaved work ---
// Closing a tab already prompts; closing the window used to discard silently.
//
// Back to a single pane first: an earlier block leaves a split open, and
// $(".pane .editor") would then be the first pane's editor rather than the active
// one, so the typing would land in a different document.
window.eval("Layout.reset(); Layout.render();");

const EXIT_PATH = "C:" + SEP + "exit" + SEP + "draft.md";
send("doc-opened", {
  path: EXIT_PATH, title: "draft.md", folder: "C:" + SEP + "exit",
  html: '<h1 id="d">Draft</h1>', outline: [{ level: 1, text: "Draft", id: "d" }],
  missing: false, loadedAt: new Date().toISOString()
});

// Nothing dirty: the close goes straight through.
let approvals = posted.filter(m => m.type === "close-approved").length;
send("confirm-close", {});
check("a clean close is approved immediately",
      posted.filter(m => m.type === "close-approved").length === approvals + 1);
check("no prompt shown when nothing is dirty", $("#exitPrompt").hidden === true);

// Now make it dirty and try again.
key("e", { ctrlKey: true });
send("doc-text", { path: EXIT_PATH, text: SRC_CLEAN });
$(".pane .editor").value = SRC_MINE;
$(".pane .editor").dispatchEvent(new window.Event("input", { bubbles: true }));

approvals = posted.filter(m => m.type === "close-approved").length;
send("confirm-close", {});
check("a dirty close is not approved",
      posted.filter(m => m.type === "close-approved").length === approvals);
check("the unsaved prompt is shown", $("#exitPrompt").hidden === false);
check("the prompt names the file",
      ($("#exitList").textContent || "").includes("draft.md"), $("#exitList").textContent);

// Keep editing: no close, text intact.
$("#exitCancel").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("keep editing cancels the close",
      posted.filter(m => m.type === "close-approved").length === approvals);
check("keep editing keeps the text", $(".pane .editor")?.value === SRC_MINE);

// Save all: closes only once the write comes back.
send("confirm-close", {});
$("#exitSave").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("save all writes the document",
      posted.filter(m => m.type === "save-doc").pop()?.payload?.path === EXIT_PATH);
check("it does not close before the write lands",
      posted.filter(m => m.type === "close-approved").length === approvals);

send("save-result", { path: EXIT_PATH, saved: false, conflict: true });
check("a failed write abandons the close rather than losing the text",
      posted.filter(m => m.type === "close-approved").length === approvals);
check("the text survives a failed exit save", $(".pane .editor")?.value === SRC_MINE);

// A reported conflict leaves the buffer stale, and retrying "Save all" must not quietly
// write it anyway -- that used to be the escape hatch straight back into the overwrite.
// The conflict has to be resolved on its own terms first.
const beforeRetry = posted.filter(m => m.type === "save-doc").length;
send("confirm-close", {});
$("#exitSave").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("retrying save all after a conflict sends no unforced save",
      posted.filter(m => m.type === "save-doc").slice(beforeRetry)
        .every(m => m.payload && m.payload.force === true));
check("retrying save all after a conflict does not close",
      posted.filter(m => m.type === "close-approved").length === approvals);

// Resolve it the way the notice asks, then a clean save-all closes the window.
$$(".pane .pane-notice button").find(b => b.textContent === "Keep mine")?.click();
send("save-result", { path: EXIT_PATH, saved: true, conflict: false });
check("Keep mine clears the conflict", $$(".pane .tab.dirty").length === 0);

$(".pane .editor").value = SRC_EDITED;
$(".pane .editor").dispatchEvent(new window.Event("input", { bubbles: true }));
approvals = posted.filter(m => m.type === "close-approved").length;
send("confirm-close", {});
$("#exitSave").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
send("save-result", { path: EXIT_PATH, saved: true, conflict: false });
check("a successful write closes the window",
      posted.filter(m => m.type === "close-approved").length === approvals + 1);

// Save all is the second door to the same overwrite Ctrl+S had. It posts an unforced
// save for every dirty buffer, and the host cannot be relied on to refuse one whose
// file has moved -- so a window closed with "Save all" would write over an external
// edit and then exit, leaving nothing on screen to notice it by.
key("e", { ctrlKey: true });
send("doc-text", { path: EXIT_PATH, text: SRC_CLEAN });
$(".pane .editor").value = SRC_MINE;
$(".pane .editor").dispatchEvent(new window.Event("input", { bubbles: true }));
send("doc-updated", {
  path: EXIT_PATH, title: "draft.md", folder: "C:" + SEP + "exit",
  html: '<h1 id="d">Draft changed elsewhere</h1>',
  outline: [{ level: 1, text: "Draft changed elsewhere", id: "d" }],
  missing: false, loadedAt: new Date().toISOString()
});

approvals = posted.filter(m => m.type === "close-approved").length;
const beforeExitStale = posted.filter(m => m.type === "save-doc").length;
send("confirm-close", {});
$("#exitSave").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const exitStaleSaves = posted.filter(m => m.type === "save-doc").slice(beforeExitStale);
check("save all sends no unforced save for a stale buffer",
      exitStaleSaves.every(m => m.payload && m.payload.force === true),
      JSON.stringify(exitStaleSaves.map(m => m.payload && m.payload.force)));
check("save all does not close while a buffer is stale",
      posted.filter(m => m.type === "close-approved").length === approvals);
check("save all keeps the stale buffer's text", $(".pane .editor")?.value === SRC_MINE);

// Discard: closes immediately and drops the buffer.
$(".pane .editor").value = SRC_EDITED;
$(".pane .editor").dispatchEvent(new window.Event("input", { bubbles: true }));
approvals = posted.filter(m => m.type === "close-approved").length;
send("confirm-close", {});
$("#exitDiscard").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
check("discard closes the window",
      posted.filter(m => m.type === "close-approved").length === approvals + 1);

// --- scroll position is remembered across a restart ---
const savedLayout = window.eval("JSON.stringify(Layout.serialize())");
check("serialised layout carries scroll anchors", savedLayout.includes("anchors"),
      savedLayout.slice(0, 160));

// --- about ---
check("about is in the Help menu",
      !!$(".menu-item[data-command='about']"),
      $$(".menu-title").map(t => t.textContent).join(", "));

const beforeAbout = posted.filter(m => m.type === "get-about").length;
window.eval("Commands.run('about')");
check("about asks the host for build details",
      posted.filter(m => m.type === "get-about").length === beforeAbout + 1);
check("about stays hidden until the host answers", $("#aboutBox").hidden === true);

send("about", {
  version: "0.1.0", build: "abc1234", dotnet: "10.0.0", webView2: "131.0.0.0",
  selfContained: false,
  executable: "C:" + SEP + "app" + SEP + "GreenMD.exe",
  sessionFile: "C:" + SEP + "data" + SEP + "session.json",
  webViewData: "C:" + SEP + "data" + SEP + "WebView2",
  associationRegistered: true
});

check("about opens once answered", $("#aboutBox").hidden === false);
const aboutText = $("#aboutBox").textContent || "";
for (const expected of ["0.1.0", "abc1234", "10.0.0", "131.0.0.0", "session.json", "Markdig"]) {
  check("about shows " + expected, aboutText.includes(expected));
}
check("about reports the association state", aboutText.includes("registered"));

// The box went on claiming "No third-party JavaScript" for as long as mermaid had been
// vendored, which is the sort of stale boast a reader would reasonably rely on.
// vendor/README.md is the one source of truth for the version, so these read the
// expected value from there rather than repeating it -- bumping mermaid without
// updating the credit fails here rather than quietly shipping a wrong number.
const vendoredMermaid = readFileSync(join(WEB, "vendor", "README.md"), "utf8")
  .match(/^\|\s*Version\s*\|\s*([^|\s]+)\s*\|/m)?.[1];

check("vendor README records a mermaid version", !!vendoredMermaid, String(vendoredMermaid));
check("about credits mermaid", /mermaid/i.test(aboutText), aboutText);
check("about shows the vendored mermaid version",
      !!vendoredMermaid && aboutText.includes(vendoredMermaid), String(vendoredMermaid));
// Deliberately not a bare /MIT/ test: GreenMD is itself MIT and says so a few rows up,
// which would satisfy a loose match even if mermaid's credit were deleted outright.
check("about names the mermaid licence beside mermaid itself",
      /Mermaid\s+[\d.]+\s*\(MIT\)/.test(aboutText), aboutText);
check("about states GreenMD's own licence", /Licence/.test(aboutText));
check("about no longer claims zero third-party JavaScript",
      !/no third-party javascript/i.test(aboutText), aboutText);
check("about explains that mermaid is loaded on demand",
      /on demand|only when|first use/i.test(aboutText), aboutText);
check("copy details carry the mermaid version, for bug reports",
      !!vendoredMermaid && ($("#aboutBox").dataset.details || "").includes(vendoredMermaid),
      $("#aboutBox").dataset.details || "");

key("Escape");
check("Escape closes about", $("#aboutBox").hidden === true);

// --- mermaid ---
// jsdom cannot lay out an SVG, so mermaid itself is stubbed. What is worth pinning
// here is the wiring: that the right elements are found, that the diagram source is
// not polluted, and that a failure leaves the source readable.
window.mermaid = {
  initialize() {},
  async render(id, source) {
    if (source.includes("BROKEN")) throw new Error("Parse error on line 1");
    return { svg: '<svg data-src="' + source.trim() + '"><g/></svg>' };
  }
};

const MERMAID_PATH = "C:" + SEP + "diagrams" + SEP + "flow.md";
send("doc-opened", {
  path: MERMAID_PATH, title: "flow.md", folder: "C:" + SEP + "diagrams",
  // Markdig's Diagrams extension emits pre.mermaid, not a code block.
  html: '<h1 id="f">Flow</h1>' +
        '<pre class="mermaid">flowchart TB' + String.fromCharCode(10) + '  A --> B</pre>' +
        '<pre><code class="language-csharp">var x = 1;</code></pre>',
  outline: [{ level: 1, text: "Flow", id: "f" }],
  missing: false, loadedAt: new Date().toISOString()
});

check("a diagram source gets no copy button",
      $(".pane .doc pre.mermaid .copy") === null || $(".pane .doc pre.mermaid") === null);
check("an ordinary code block still gets one",
      $$(".pane .doc pre:not(.mermaid) .copy").length === 1);

await new Promise(r => setTimeout(r, 60));
check("the diagram is replaced by rendered output",
      $$(".pane .doc .mermaid-figure svg").length === 1,
      `${$$(".pane .doc .mermaid-figure svg").length} figures`);
check("the diagram source reached mermaid unpolluted",
      ($(".pane .doc .mermaid-figure svg")?.dataset.src || "").endsWith("A --> B"),
      $(".pane .doc .mermaid-figure svg")?.dataset.src);

// A diagram that will not parse keeps its source visible with the reason.
send("doc-updated", {
  path: MERMAID_PATH, title: "flow.md", folder: "C:" + SEP + "diagrams",
  html: '<h1 id="f">Flow</h1><pre class="mermaid">BROKEN</pre>',
  outline: [{ level: 1, text: "Flow", id: "f" }],
  missing: false, loadedAt: new Date().toISOString()
});
await new Promise(r => setTimeout(r, 60));
check("a failed diagram explains itself",
      ($(".pane .doc .mermaid-error")?.textContent || "").includes("Parse error"),
      $(".pane .doc .mermaid-error")?.textContent);
check("a failed diagram keeps its source readable",
      ($(".pane .doc pre.mermaid-failed")?.textContent || "").includes("BROKEN"));

// --- pane child order ---
// DOM order needs no layout, so unlike the geometry bugs this IS testable here.
// It broke because refreshPaneChrome appended rebuilt chrome and then moved the
// document, leaving the editor above the tab strip.
function childOrder() {
  return [...$(".pane").children].map(c => c.className.split(" ")[0]);
}

const EXPECTED = ["tabstrip", "dochead", "pane-notice", "doc", "editor-wrap", "drop-hint"];

send("doc-opened", editDoc("order check"));
check("pane children are in the documented order",
      childOrder().join(",") === EXPECTED.join(","), childOrder().join(","));

// refreshPaneChrome runs on this path; it must not reorder anything.
send("doc-content", editDoc("order after content"));
check("order survives a chrome rebuild",
      childOrder().join(",") === EXPECTED.join(","), childOrder().join(","));

key("e", { ctrlKey: true });
check("order survives entering edit mode",
      childOrder().join(",") === EXPECTED.join(","), childOrder().join(","));

send("doc-updated", editDoc("order after update"));
check("order survives a live reload while editing",
      childOrder().join(",") === EXPECTED.join(","), childOrder().join(","));

key("e", { ctrlKey: true });
check("order survives leaving edit mode",
      childOrder().join(",") === EXPECTED.join(","), childOrder().join(","));

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
