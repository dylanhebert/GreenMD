# GreenMD — design and scope

> Formerly MarkdownViewer, developed inside a shared repository before being split
> out here with its history intact.

A dark-mode desktop viewer for markdown files, built primarily for reading docs that
Claude generates and rewrites while you have them open. A viewer first: plain-text
source editing exists behind Ctrl+E, and stays deliberately plain.

## Why not an existing tool

Obsidian, VS Code, MarkText and Zettlr all render markdown in tabs. The gap none of
them fill cleanly is *double-click any `.md` anywhere on disk and get a good rendered
view*, with live reload that survives the way agent tooling actually writes files.
That is the whole reason this exists.

## Stack

- .NET 10 (`net10.0-windows`), WPF
- A single WebView2 filling the window — the entire UI is HTML/CSS/JS inside it
- [Markdig](https://github.com/xoofx/markdig) for markdown to HTML
- No Node, no Rust, no bundler. WebView2 ships with Windows 11.

`NuGet.config` in this folder pins restore to nuget.org, so a machine-wide config
pointing at a private feed cannot drag a token requirement into a build that needs
neither.

### Host / UI split

| C# host | Web UI |
|---|---|
| CLI args, single-instance, file association | Tab strips, split layout, workspace switcher |
| File read / watch / save, encoding | Folder tree, quick-open, outline, find-in-page |
| Markdig to HTML, outline extraction | Scroll anchoring, follow mode, shortcuts |
| Asset serving, session persistence | |

They talk over `PostWebMessageAsJson` / `WebMessageReceived` with a `{type, payload}`
envelope. No `AddHostObjectToScript` — plain messages are easier to reason about and keep
the JS side free of COM interop.

## Decisions

### Rendering happens in C#, not JS

Markdig with `UseAdvancedExtensions()` covers GFM tables, task lists, footnotes,
autolinks and auto heading IDs. Walking its AST also produces the outline, so the sidebar
never scrapes the DOM. One parse produces both.

### Raw HTML in documents is neutered

A doc cloned from some repo should not be able to reach the host bridge.
`MarkdownRenderer.Sanitize` strips script, style, iframe, object and embed tags, `on*=`
handler attributes, and `javascript:` hrefs. The CSP in `web/index.html` is the real
backstop: `script-src 'self'` means inline script cannot execute even if the sanitizer is
bypassed.

### Assets go through an interception handler

Doc-local images and relative links are served by a `WebResourceRequested` handler on a
`https://greenmd-asset.local/` virtual origin, with an allowlist of readable roots — not by
accumulating one `SetVirtualHostNameToFolderMapping` per open folder. One mechanism, one
place to enforce "do not serve outside the workspace root". App assets do use a static
mapping (`https://greenmd.app/` to `web/`), since that folder is fixed.

Relative links to other `.md` files are intercepted and opened as a tab instead of
navigating the WebView2 away from the app shell.

### External drops come through the page

`AllowExternalDrop = false` looked right: it routed Explorer drops to the WPF
handlers, which get real paths, where the page would only get pathless `File`
objects. In the WPF host it also silently suppresses the page's own HTML5 drags —
tab dragging never started, and no test could see it because jsdom cannot perform a
native drag. External drop stays enabled; the page accepts the drop and posts it back
with `postMessageWithAdditionalObjects`, whose `CoreWebView2File` objects carry the
real path the watcher needs. One path for drops, and tab dragging works.

### Dark only

No theme system. Four things this needs beyond CSS:

1. `DWMWA_USE_IMMERSIVE_DARK_MODE` (attribute 20, falling back to 19) on the window
   handle, or a white title bar sits above a dark app.
2. `WebView2.DefaultBackgroundColor` set **before** `EnsureCoreWebView2Async`, or every
   startup and navigation flashes white.
3. `Profile.PreferredColorScheme = Dark` plus `color-scheme: dark` in CSS, so scrollbars
   and form controls render dark.
4. One dark syntax-highlighting theme, no light variant.

## State model

The layout is a tree. Tabs belong to panes, not to the window.

```
Session   { workspaces[], activeWorkspaceId }
  Workspace { id, name, rootPath, layout, expandedDirs[] }
    LayoutNode = Split { dir, sizes[], children[] }
               | Pane  { id, tabs[], activeTabId }
      Tab { id, path, scrollAnchor, mode }
```

Documents live in a **separate map keyed by absolute path** — content, rendered HTML,
watcher registration, content hash, dirty flag. Tabs hold only a path reference. So the
same file open in two panes is one watcher and one cache entry, and a reload updates both
panes at once.

`Tab.mode` exists and is persisted from day one even though v1 only ever writes `"view"`.
That, plus keeping raw text in memory, is most of what makes the edit toggle cheap later.

## Workspaces are folders

Several folders can be open at once. Each becomes a stacked section in the sidebar with
its own scrolling tree, and the dividers between them redistribute vertical space.

Weights are relative rather than pixel heights, so a split survives a window resize.
Sections hold a 90px minimum, which means past a handful of folders the stack overflows
and the sidebar scrolls rather than squeezing every tree down to a sliver. A collapsed
section drops to `flex: 0 0 auto` so it claims no share at all.

The alternative worth recording: a single tree with each folder as a collapsible
top-level node, which is what VS Code does for multi-root and needs none of the divider
or weight machinery. It was rejected because collapsing roots does not let you pin a
small folder visible next to a large one, which is the case that motivated this.

Adding a folder already inside an open one is refused — it would list everything twice.
The entry cap is shared across all folders, because the thing worth bounding is the
total the UI has to render.

A workspace binds to a directory. Point it at a project folder and new `.md` files that
appear there show up on their own — the directory is already being watched for content
changes, so discovery is nearly free. That is what makes workspaces worth having; an
arbitrary named tab set would not be.

### Nested trees

Real folders are not flat. The case this was sized against is a documentation folder
of roughly 50 markdown files spread across 16 directories, nested 0 to 3 deep.

- The sidebar is a **collapsible tree**, not a flat list. Expanded directories persist
  per workspace.
- **Ctrl+P quick-open** fuzzy-filters the flattened path list. At that size this is the
  fastest way to reach a doc, and it is nearly free since the list already exists.
- Enumeration is lazy per directory and never reads file contents.
- Ignored during the walk: `.git`, `node_modules`, `bin`, `obj`, `.vs`, `dist`.

### Watching a nested workspace

**One recursive `FileSystemWatcher` at the workspace root** (`IncludeSubdirectories = true`),
not one per directory. Sixteen directories would otherwise mean sixteen watchers, and a
recursive watcher also catches directories created after the workspace opens.

Guards:

- `InternalBufferSize` raised to 64 KB. The buffer overflows under bursts and drops events.
- On the `Error` event (buffer overflow), fall back to a full rescan of the tree rather
  than silently missing changes.
- If the tree exceeds roughly 5,000 files, refuse the recursive watcher and fall back to
  per-open-file directory watching. A workspace rooted at `C:\` should not melt.

Files opened ad hoc outside any workspace get a non-recursive watcher on their own
directory. Both paths feed the same document cache.

## Live reload

The core feature, and the part most likely to be subtly wrong. A naive
`FileSystemWatcher` on a file path fails against agent-written files in four ways.

**Atomic replace.** Most write tooling writes a temp file and renames over the target.
That fires Deleted plus Created, not Changed, and invalidates the handle. Watch the
*containing directory* with a filename filter, treat Created/Changed/Renamed/Deleted as
"recheck this path", and never act on a Delete immediately — wait out the debounce,
because delete-then-create *is* the rename.

**Partial reads.** The watcher fires while the writer still holds the file. Debounce
200 ms of quiet, then read with a short retry loop on `IOException`.

**Duplicate events.** Watchers fire two or three times per real change. Hash the content
and skip the re-render when unchanged. Not an optimization — without it you re-render
several times per save.

**Scroll jump.** A naive reload throws you to the top of a doc you were reading. Before
re-rendering, capture the nearest heading ID above the viewport and its pixel offset, then
restore against that ID afterward. Survives edits elsewhere in the document in a way raw
`scrollTop` does not. Falls back to `scrollTop` when the doc has no headings.

Plus:

- **Follow mode** — if you are already scrolled to the bottom, stay pinned there on
  re-render, so you can watch a doc being written.
- **An updated signal** — a brief pulse on the tab and a status-bar timestamp, so a silent
  background change does not leave you wondering whether the view is stale.

### Change marks

A reload tells you the document changed; it does not tell you what. Every reload is
diffed block-by-block against the version the reader last **marked as seen** — not the
previous render — so marks accumulate across an agent's rewrites until dismissed with
the header chip or Ctrl+M. Rewritten blocks get an amber bar, new ones a green kept
distinct from the live-pulse teal, and removed ones a dashed seam. A rewritten list is
re-diffed item by item, so appending one entry to a 30-item plan marks that entry
rather than lighting the whole list.

The diff is an LCS over serialized top-level blocks, with the common prefix and suffix
trimmed first so the quadratic core stays small for the local edits agents actually
make. Runs of consecutive edits pair deletes against inserts to tell a rewrite from an
addition, and that pairing is what makes the second, item-level pass possible.

It lives in the UI rather than the host because the rendered HTML is what gets marked
and the UI already holds it. The reader's own saves and checkbox ticks rebaseline
silently — they are not news to the person who made them. A View-menu toggle hides the
paint without stopping the tracking underneath, and the choice persists with the
session.

### OneDrive

A OneDrive-synced folder is a normal place to keep documents, and every file in one
can be a Files On-Demand **reparse-point placeholder** (`Archive, ReparsePoint`) —
hydrated now, dehydrated whenever OneDrive decides. That needs three specific things:

1. **Exclude `NotifyFilters.Attributes` from the watcher.** Hydration and dehydration are
   attribute changes. Watching them means re-rendering on every OneDrive housekeeping
   pass. Watch `LastWrite | FileName | DirectoryName` only.
2. **Content hashing becomes essential rather than nice.** Sync can rewrite a file with
   byte-identical content; the hash check is what stops that reaching the UI.
3. **Detect cloud-only files before reading.** If a file carries `FileAttributes.Offline`
   or `RECALL_ON_DATA_ACCESS` (0x00400000), opening it triggers a network download that
   blocks. Read off the UI thread and show a "downloading from OneDrive" state instead of
   freezing. Directory enumeration does *not* hydrate, so building the tree is safe.

Long paths have not been a concern at these depths, so no `\\?\` prefixing is done.
A workspace rooted somewhere pathological would need it.

Watchers on network shares can also silently miss events. A `LastWriteTime` poll every few
seconds, for open documents only, is the backstop.

## Chrome

### Document header

Name, folder and last-updated sit in a sticky header above the document rather than in
the footer. That follows what editors do — identity and location at the top (VS Code's
breadcrumb bar), transient status at the bottom — and it puts the "updated 4s ago"
stamp where the reader is already looking when the file changes underneath them.

The folder is trimmed to its last three segments with the full path on hover. Truncating
in script beats CSS `direction: rtl`, which mangles the ends of paths.

### Per-pane text zoom

Ctrl+scroll zooms only the pane under the cursor. The document and the outline are
separate scopes, and any pane added later gets it by declaring `data-zoom-scope`.

Two decisions worth recording:

- **WebView2's own zoom is turned off** (`IsZoomControlEnabled = false`). It scales the
  entire shell, including chrome that should stay fixed. Disabling it leaves the wheel
  event intact for the UI to interpret.
- **Zoom changes `font-size`, not `transform: scale`.** The point is to fit more or
  fewer words per line, which requires the text to actually reflow. A transform would
  magnify the same line breaks. Everything inside a pane is sized in `em` so one
  declaration scales the whole thing, and the pane headers stay constant.

Each pane shows its level top-right, browser style, hidden at 100%. Clicking it resets
to 100%. Ctrl+0, Ctrl+plus and Ctrl+minus act on whichever pane the pointer is over.
The reader's scroll anchor is preserved across a zoom change, same as across a reload.

### Window placement

Position, size and maximized state persist to their own `window.json` and reapply
before the window shows. Not part of `session.json`, whose shape deliberately belongs
to the UI — geometry is the one piece of state only the host can know. A saved
rectangle that no longer overlaps the virtual desktop (a monitor since unplugged) is
ignored rather than stranding the window off-screen.

## Milestones

- **M0 — skeleton.** WPF + WebView2 + Markdig, dark chrome, render the file passed on the
  command line, outline sidebar. **Done.**
- **M1 — tabs and live reload.** Document cache, directory watchers, debounce,
  hash-compare, anchor-preserving re-render, follow mode, drag-and-drop, single-instance
  handoff over a named pipe, syntax highlighting, doc-local images, sticky document
  header, per-pane text zoom. **Done.**
- **M2 — splits.** Layout tree, flex rendering, draggable dividers, drag-tab-to-edge. **Done.**
- **M3 — workspaces.** Folder binding, collapsible tree, Ctrl+P quick-open, session persistence. **Done.**
- **M4 — outline and find.** Outline scroll-spy and Ctrl+F with match count and
  next/previous. **Done.**
- **M5 — polish.** `.md` association (HKCU, no admin) and a publish script. **Done.**
- **M6 — edit toggle.** Ctrl+E flips a pane between the rendered view and the source,
  Ctrl+S saves. **Done**, using a textarea rather than a vendored editor component.
- **M7 — standing on its own.** Menu bar, markdown highlighting in edit mode, panel
  controls, an app icon, mermaid diagrams, an unsaved-work guard on exit, reading
  position remembered across restarts, recent files in the File menu, and an About
  dialog. **Done.**
- **M8 — sitting beside an agent.** Tab context menu, tab reordering along the strip,
  change marks diffed against the version last marked as seen (item-level inside
  lists) with a View toggle, and the window reopening where it was closed. **Done.**

### Deferred deliberately

- **Multi-window.** Dragging tabs between windows is a lot of extra state-sync work for a
  single-user viewer.
- **Block-level DOM patching** on re-render, so only changed blocks swap instead of the
  whole document. Full replacement plus the scroll anchor is fine at a 200 ms debounce.
  Roughly 80 lines keyed on per-block hashes, worth doing only if streaming re-renders
  visibly flicker.
- **KaTeX and PDF export.** Not needed for the target use case.

## Testing

`node tests/ui-test.mjs` loads the real `index.html` and every script into jsdom, drives
the UI with the same messages the host sends, and asserts on the resulting DOM.

This exists because the obvious smoke test is useless here: a JavaScript exception
leaves the window blank while the process happily keeps running, so "the process is
alive" proves nothing. The suite covers tabs, splits, per-pane zoom, live updates,
the workspace tree, quick-open scoring, and session round-tripping.

jsdom is **test-only and deliberately not a dependency of the application** — nothing it
pulls in ever ships. It is a declared devDependency in `tests/package.json`, which is
what makes the suite runnable from a fresh clone.

## Installing

`tools\Publish.ps1 -Register` publishes to `%LOCALAPPDATA%\Programs\GreenMD`
and registers the association. Framework-dependent by default (~3 MB, needs the .NET
Desktop Runtime); `-SelfContained` produces a standalone copy for a machine with no
.NET installed.

Publishing to a stable location matters because the association records an absolute
path to the executable. Registering `bin\Debug` works until the folder is cleaned.
`IsRegistered()` compares the recorded command against the current executable, so a
moved or republished build correctly reports as unregistered rather than silently
pointing at a path that no longer exists.

`GreenMD.exe --register` and `--unregister` do the same thing without a window,
for scripted setup. In the app it lives in the File menu, greyed out with a reason once
it is done.

It used to be offered by a button in the status bar as well. Two controls for one
one-time action, and the status bar is meant for transient state — a permanent offer
parked in it reads as something being wrong. The menu entry already existed; the button
was the duplicate, so the button went.

### Find

Find wraps matches in `<mark>` and unwraps them again rather than re-rendering, so a
search never disturbs the reader's scroll position. A live reload replaces the DOM and
takes the highlights with it, so the search is re-applied afterwards and keeps its
place in the match list.

Matches that straddle an element boundary — half inside an `<em>` — are not found. A
flattened text index would fix that and is not worth the complexity here.

The bar sits above the status bar rather than floating over the active pane. With
splits, a floating widget needs to track the active pane's rectangle through every
layout change; a fixed bar naming the document it is searching is simpler and just as
clear.

### Editing

Ctrl+E flips a pane between the rendered document and its source; Ctrl+S saves. It is a
plain textarea, not a code editor. That is deliberate — a real editor component would be
the first third-party JavaScript in the app, and this covers what it is for: fixing a
line in something you are already reading.

Edit state is keyed by pane *and* path, so the same file can be source in one pane and
rendered in another. Saving repaints the rendered pane, which yields a side-by-side live
preview with no code written specifically for it.

Three rules protect the file:

- **A save is refused if the file changed on disk since it was loaded.** The pane shows
  a notice offering "discard mine" or "keep mine" rather than silently picking one.
- **An external change never overwrites an unsaved buffer.** Clean buffers take the new
  text; dirty ones are flagged instead.
- **Encoding and line endings are reproduced as loaded.** Rewriting a CRLF file as LF
  would show up in git as a change to every line. Writes go via a temp file and a
  rename so a crash cannot truncate the original.

The first rule is enforced **in the UI**, and that is not where it looks like it should
live. The host has a conflict check too, and it does not fire. It compares the file on
disk against `Document.Hash` — but that hash exists to deduplicate watcher events, so a
live reload refreshes it. Once the watcher has seen the external change the host is
comparing disk against itself, finds them equal, reports no conflict, and writes. Both
save paths in the UI therefore refuse to send an unforced save while the buffer is
flagged stale, and only "Keep mine" passes `force`.

This was found by driving the real app: edit a file, let another program write to it,
press Ctrl+S, and the other program's text was gone with no warning. jsdom could not
have caught it, because every existing conflict test began by handing the UI a
`save-result` that already said `conflict: true` — they tested the reporting of a
conflict and never the detecting of one. The regression tests now press Ctrl+S on a
stale buffer and assert no unforced save leaves the UI at all.

Fixing `Document.Hash` properly means separating the watcher-dedup hash from the
"what was this edit based on" hash. It is worth doing, and it is not done, because the
checkbox-toggle path saves from `RawText` and would start reporting false conflicts
against a stale baseline. There is no C# test project to catch that, which is the real
blocker.

### Saving is explicit

There is no autosave. Ctrl+S, or nothing happens — a viewer that writes to files on its
own is a viewer you cannot trust with a document you are only reading.

Unsaved state is therefore made loud rather than subtle: a bullet on the tab, an
"unsaved — Ctrl+S" badge in the header, and a refusal to close the tab. Closing a dirty
tab used to discard the edit silently, which is the one thing this must never do; it now
keeps the tab open and offers save, discard, or keep editing.

### Mermaid diagrams

Markdig's advanced extensions already include its Diagrams extension, which turns a
```mermaid fence into `<pre class="mermaid">` rather than an ordinary code block. The
renderer replaces those with drawn SVG. Two other forms are accepted as well, so this
keeps working if that extension is ever dropped from the pipeline.

Mermaid is loaded on first use rather than at startup: it is 2.5MB, and most documents
have no diagrams. A document without one never pays for it.

`securityLevel` is `antiscript` rather than `strict`. Strict strips the `<b>` and
`<br/>` that real diagrams use in node labels, which makes them worse to read; antiscript
keeps the formatting and removes script, and the page's own `script-src 'self'` policy
blocks inline handlers regardless.

A diagram that will not parse keeps its source visible with the error above it, rather
than leaving an empty box — a diagram that will not parse is usually a typo the reader
can see and fix.

Copy buttons are deliberately not added to diagram sources. They were, once, and the
button's own label was swept up by `textContent` and fed to the parser as part of the
diagram, which failed one diagram in every file with a baffling error.

### Vendoring and line endings

Mermaid is the one vendored third-party file, checked in rather than fetched, with its
SHA-256 recorded in `web/vendor/README.md` and verified by `tests/verify-vendor.mjs`.

Git's line-ending normalisation broke that check. With `* text=auto` applied to
everything, a fresh clone had the vendored file rewritten on checkout, so its hash no
longer matched and CI — which always checks out fresh — failed while every local
working copy passed. `.gitattributes` now exempts `web/vendor/**` with `-text`, and the
ordering matters: **later rules win**, so the catch-all `* text=auto` has to come
*before* the exception, not after. Getting that backwards looks identical to having no
exception at all.

### Menus

`classList.toggle(cls, force)` treats an `undefined` second argument as "no force
argument given" and flips the class instead. Menu availability is computed as
`command.available && !command.available()`, which yields `undefined` for any command
with no availability rule — so those items toggled greyed and un-greyed on every
refresh. The force argument is coerced to a real boolean at the call site.

### Task checkboxes

Ticking a checkbox in the rendered view edits the markdown. Markdig renders task
checkboxes disabled, so a custom renderer emits a live one carrying the marker's index,
and the source offset of every marker is recorded during the same parse.

The offsets were checked against Markdig rather than assumed: they point at the opening
bracket, they cover nested items, and they skip both `[a link](x.md)` and a `[ ]` inside
a code span. A toggle rewrites exactly one character.

### Scroll-spy

The outline marks the last heading at or above the top of the viewport. Driven by the
pane's own scroll event, throttled with `requestAnimationFrame` — scroll fires far more
often than the outline needs updating, and reusing the offset comparison already
written for scroll anchoring avoids a second mechanism doing the same job.

The spy's tolerance must exceed the headings' `scroll-margin-top`, or clicking an
outline entry lands its heading just past the threshold and the entry above stays
highlighted. A test pins the constant against the stylesheet so the two cannot drift
apart silently.

### Measuring the real window

`GreenMD.exe <file> --dump-layout=<out.json>` opens the window, measures itself
after two frames, writes the numbers to `out.json` and exits.

This exists because two layout fixes were shipped that did not work. jsdom performs no
layout, a hand-built probe page does not exercise the DOM the app actually builds, and
reasoning about CSS from a screenshot was simply wrong twice. The dump reports computed
styles, every box, and a verdict, from the running window.

The verdict matters as much as the measurements. The first version checked that the body
filled the viewport and the status bar sat on the bottom edge -- and passed while the
outline was positioned entirely off the right-hand edge. It now also checks that the
outline is on screen and that the panes and the outline tile the body exactly.

### Observing behaviour over time

`--dump-state=<path>` leaves the window open and appends a JSON line every two seconds
and on every state change: what the host is watching, what documents the UI holds, each
pane's header stamp as rendered, and a log of every message the UI received.

The layout dump answers "where are the boxes". This answers "did the event arrive at
all", which is the question behind most reports of something not refreshing. Having both
sides of the bridge in one stream is the point -- a stamp that did not update is either a
message the host never sent or a message the UI ignored, and guessing which has not
worked.

### Shell layout

The shell is a flex column, not a grid with a fixed row template. A row template couples
the layout to the number of children, and a `hidden` child takes no grid cell at all --
so adding the find bar and hiding it silently pushed `.body` into the `auto` row and
handed the free space to the status bar. The window then sized itself to its content
with the status bar floating in the middle of the empty space.

Flex removes the coupling: each child declares its own behaviour and nothing shifts when
one is hidden.

The same trap was present on the other axis and was missed the first time round. `.body`
used `grid-template-columns: auto minmax(0, 1fr) auto` for the sidebar, panes and
outline. With the sidebar hidden the columns resolved to `1226px 0px 0px` -- the panes
slid into the `auto` column and took everything, and the outline was left a zero-width
track and rendered at x=1226 on a 1226px viewport, i.e. exactly off the right edge. Both
axes are flex now, and every child sizes itself.

Every item inside the shell also carries `min-width: 0`. Grid and flex items default to
`min-width: auto`, which lets their min-content width override the track -- the outline
aside was measured at 285px inside a 250px column before this was fixed.

`tests/ui-test.mjs` asserts the shape of these rules directly. jsdom performs no layout,
so a geometry bug is invisible to it; checking that `.shell` is a flex column and `.body`
is the flexible child is crude, but it is the difference between this regressing silently
and regressing loudly.

## Keyboard

| | |
|---|---|
| `Ctrl+O` | open a file |
| `Ctrl+K` | add a folder to the sidebar |
| `Ctrl+P` | go to file (needs a workspace) |
| `Ctrl+F` | find in the active document |
| `Ctrl+E` | toggle source editing for the active pane |
| `Ctrl+B` | show or hide the file list |
| `Ctrl+Shift+O` | show or hide the outline |
| `Ctrl+S` | save |
| `Ctrl+W` | close the current tab |
| `Ctrl+Tab` | cycle tabs in the active pane |
| `Ctrl+\` | split the pane right (`Ctrl+Shift+\` splits down) |
| `Ctrl+scroll` | resize text in the pane under the pointer |
| `Ctrl+0` / `Ctrl+±` | reset or step that pane's text size |

## Notes

Windows 11 will not let the app silently claim the `.md` default. The HKCU registry writes
make it available and put it in "Open with"; the actual default still needs a one-time
click in Settings. That is expected, not a bug.

## Layout

```
GreenMD/
  ARCHITECTURE.md
  README.md
  NuGet.config                  restore scoped to nuget.org
  GreenMD.sln
  GreenMD/
    GreenMD.csproj
    App.xaml(.cs)               startup, CLI args, the two dump modes
    MainWindow.xaml(.cs)        WebView2 host, message router
    Assets/app.ico              generated by tools/New-AppIcon.ps1, committed
    Host/
      MarkdownRenderer.cs       Markdig pipeline, sanitizer, outline, task offsets
      DocumentStore.cs          content cache, hashing, encoding, atomic save
      FileWatchService.cs       directory watchers, debounce, overflow rescan
      WorkspaceService.cs       folder binding, lazy tree walk, entry cap
      AssetServer.cs            virtual-origin interception, readable-root allowlist
      SessionStore.cs           layout tree persistence
      SingleInstance.cs         named-pipe handoff
      FileAssociation.cs        HKCU .md registration
      Native.cs                 dark title bar interop
    web/
      index.html                CSP lives here
      styles.css
      app.js                    shell, message handling, render pipeline
      layout.js                 split tree, dividers, tab drag
      workspace.js              sidebar sections, tree, quick-open
      panels.js  menu.js  zoom.js  find.js  editor.js  highlight.js
      vendor/mermaid.min.js     the only third-party JS, SHA-256 pinned
  tests/
    ui-test.mjs                 jsdom UI assertions
    lint-sources.mjs            catches mangled escape sequences
    verify-vendor.mjs           checks the vendored mermaid hash
  tools/
    Publish.ps1                 publish + optional -Register
    New-AppIcon.ps1             regenerates Assets/app.ico
```

## Build and run

```
dotnet build GreenMD.sln
GreenMD\bin\Debug\net10.0-windows\GreenMD.exe path\to\file.md
```

Launching with no argument renders a built-in welcome document.
