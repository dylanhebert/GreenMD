# Vendored third-party code

Everything here is committed rather than fetched at build time, so a clone builds
offline and what ships is exactly what was reviewed. Nothing here is ever loaded
from a network at runtime.

## mermaid.min.js

| | |
|---|---|
| Version | 11.4.1 |
| Source | https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js |
| Size | 2571900 bytes |
| SHA-256 | A43BC1AFD446F9C4CC66AC5DD45D02E8D65E26FC5344EC0EF787F88D6DDB6F9E |
| Licence | MIT |

The single-file bundle is used deliberately. Mermaid's ESM build code-splits its
diagram types into sibling chunks, which would mean vendoring a directory and
having some diagram types silently fail if one were missed. This build contains
everything and self-registers as `window.mermaid`.

Audited before vendoring: no `eval`, no `new Function`, no `fetch` or
`XMLHttpRequest`, no dynamic `import()`, and no remote URLs. It therefore runs
under the app's existing `script-src 'self'` policy with no loosening, and makes
no network requests. The one textual match for `fetch(` is a method on KaTeX's
parser, not the network API.

Run `node tests/verify-vendor.mjs` to check the file still matches the hash above.

## Why this is the only one

The app has no other third-party JavaScript. The syntax highlighter, layout engine,
editor and file search are written for this project. Mermaid is the exception
because rendering its diagrams correctly means implementing a graph layout engine,
which is not a reasonable thing to hand-roll.
