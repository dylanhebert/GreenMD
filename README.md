# GreenMD

A dark-mode markdown viewer for Windows. Built for reading documents that change while
you have them open — the kind an AI assistant writes and rewrites as you work — and for
double-clicking any `.md` file and getting a decent rendered view without a browser.

## Install

Download the latest [release](../../releases) and unzip it anywhere.

- **`GreenMD-<version>-win-x64-standalone.zip`** — runs on a machine with no .NET
  installed. Larger, and the one to take home.
- **`GreenMD-<version>-win-x64-needs-dotnet.zip`** — a few MB, needs the
  [.NET Desktop Runtime](https://dotnet.microsoft.com/download/dotnet).

Then, from the unzipped folder:

```
GreenMD.exe --register
```

That registers GreenMD as a handler for `.md`, `.markdown`, `.mdown`, `.mkd` and
`.mdtext` under `HKEY_CURRENT_USER`, so it needs no administrator rights and touches
nothing machine-wide. `--unregister` undoes it.

Windows will not let an application claim a file type outright, so the first time you
double-click a `.md` file you will still get the "how do you want to open this" prompt.
Pick GreenMD and tick "always use this app". That is one click, not a bug.

## What it does

- **Live reload.** Edit a file in another editor and the view updates, keeping your
  place in the document rather than jumping to the top. If you were reading the bottom,
  it follows the bottom, so you can watch a file being written.
- **Tabs and splits.** Drag a tab to a pane's edge to split, or to its middle to move it.
  The same file can sit in two panes with two independent reading positions.
- **Folders in the sidebar.** Open as many as you like; each is a resizable section.
  New files appear on their own.
- **Ctrl+P** to jump to any file across every open folder, **Ctrl+F** to search the
  current document.
- **Task checkboxes actually work.** Ticking one rewrites the markdown and saves.
- **Ctrl+E** switches a pane to highlighted markdown source; **Ctrl+S** saves. There is
  no autosave, deliberately.
- Everything reachable by keyboard is also in the menu bar.

## Dependencies

Two NuGet packages, both with no transitive dependencies of their own:

| Package | Licence | Purpose |
|---|---|---|
| [Markdig](https://github.com/xoofx/markdig) | BSD-2-Clause | markdown to HTML |
| Microsoft.Web.WebView2 | Microsoft | the rendering surface, already present on Windows 11 |

**No third-party JavaScript.** The syntax highlighter, the layout engine, the editor and
the fuzzy file search are all written for this project. That is a deliberate constraint:
this runs on work machines, and a dependency that is small enough to read is worth more
than one that covers more cases.

`NuGet.config` pins restore to nuget.org, so a machine configured against a private feed
does not need credentials to build this.

jsdom appears in `tests/package.json`. It is test-only and nothing it pulls in ever
ships.

## Security posture

- Markdown may contain raw HTML. Script, style, iframe, object and embed tags are
  stripped, along with `on*=` handlers and `javascript:` URLs. The page's own
  `script-src 'self'` policy means inline script cannot execute even if that fails.
- Doc-local images are served through a single interception point with an explicit
  allowlist of readable folders, so a document cannot read outside the folder it lives
  in.
- Nothing is sent anywhere. The app makes no network requests; the only reason it
  contains a browser engine is to draw text.
- Links to the web open in your actual browser rather than inside the app.

## Building

```
dotnet build GreenMD.sln
npm install --prefix tests
node tests/lint-sources.mjs
node tests/ui-test.mjs
```

`tools/Publish.ps1 -Register` installs to `%LOCALAPPDATA%\Programs\GreenMD` and
registers the file association in one step.

## Diagnostics

Two flags exist because reasoning about a layout from a screenshot proved unreliable:

```
GreenMD.exe file.md --dump-layout=layout.json
GreenMD.exe file.md --dump-state=state.jsonl
```

The first measures the real window — computed styles, every box, and a verdict — then
exits. The second stays open and streams what the host is watching and what the UI
holds, so "the event never arrived" can be told apart from "the UI ignored it".

See [DESIGN.md](DESIGN.md) for how it is put together and why.
