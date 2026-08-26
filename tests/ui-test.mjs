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

for (const file of ["highlight.js", "zoom.js", "layout.js", "workspace.js", "app.js"]) {
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
