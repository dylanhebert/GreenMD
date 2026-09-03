"use strict";

/**
 * The document map: a scroll affordance down the right-hand edge of a pane.
 *
 * Two styles. "full" draws the document's shape -- one bar per block in the rendered
 * view, one per line in source mode -- with markers painted over it. "ribbon" is a thin
 * strip carrying only the markers. Both show the viewport as a window you can drag, and
 * both replace the native scrollbar rather than sitting beside it.
 *
 * Why the shape is drawn rather than the text: a real minimap works in an editor because
 * code is monospace with meaningful indentation, and that profile stays recognisable at
 * three pixels a line. Rendered markdown is proportional text at five heading sizes, so
 * a faithful thumbnail is a grey smear. Bars sized by content length keep the part that
 * is actually legible at that scale -- headings read short and thick, paragraphs as
 * runs, tables as dense blocks -- for a fraction of the work of rendering type.
 *
 * The map overlays the scroller instead of sitting in a flex row beside it. That keeps
 * the pane's children as they were, and it matters for source mode: the editor is two
 * stacked layers whose caret alignment depends on both wrapping at the same column, so
 * the width the map occupies is reserved on the shared selector and never on one layer.
 */
window.DocMap = (() => {

  const WIDTH_FULL = 80;
  const WIDTH_RIBBON = 14;

  /** Bars thinner than this are invisible; taller documents just get denser. */
  const MIN_BAR_PX = 1;

  /**
   * How deep to draw headings as actual words, and at what size.
   *
   * Only the top two: an h1 is a landmark worth reading, an h2 usually is, and below
   * that the text is too small to help while the clutter is real. Everything deeper
   * stays a bar, which still says a heading is there.
   */
  const HEADING_TEXT_LEVELS = 2;
  const HEADING_TEXT_PX = { 1: 9, 2: 7 };

  /**
   * One colour per block kind, so a table, a diagram and a paragraph are distinguishable
   * without anything being legible. Muted on purpose: the markers painted over this are
   * the part meant to catch the eye, and they lose that if the backdrop competes.
   */
  const FILL = {
    heading: "#b4b0a6",
    prose:   "#565349",
    code:    "#4c6058",
    quote:   "#615943",
    list:    "#5f5c51",
    table:   "#5a5a63",
    diagram: "#4a5b68",
    image:   "#4a5b68",
    rule:    "#3f3d37"
  };

  let hooks = {};

  /** "full" | "ribbon" */
  let style = "full";
  let enabled = false;

  function configure(next) { hooks = next || {}; }

  function isEnabled() { return enabled; }
  function currentStyle() { return style; }

  function setEnabled(on) {
    enabled = !!on;
    if (hooks.onChanged) hooks.onChanged();
  }

  function setStyle(next) {
    style = next === "ribbon" ? "ribbon" : "full";
    if (hooks.onChanged) hooks.onChanged();
  }

  function width() {
    if (!enabled) return 0;
    return style === "ribbon" ? WIDTH_RIBBON : WIDTH_FULL;
  }

  // ---------- measuring the document ----------

  /**
   * A typical line's width, in characters. Used as the reference a bar's length is
   * measured against rather than the document's longest line: scaling to the longest
   * line pushes every ordinary line to full width, which is what made this read as
   * stacked slabs instead of text.
   */
  const REFERENCE_COLUMNS = 90;

  /**
   * The rendered view's shape, one bar per *rendered line* rather than per block.
   *
   * Per-block was the first attempt and it looked like a bar chart: a six-line
   * paragraph became one solid rectangle six lines tall. There are no line boxes to
   * read out of proportional text, so the count is derived from the block's height over
   * its line-height and the characters spread across them -- which is enough for the
   * last line of a paragraph to come out ragged, and raggedness is most of what makes a
   * minimap look like prose.
   */
  /**
   * What a block is, so the map can draw it as itself.
   *
   * Everything-as-prose-bars was uninformative: a table, a diagram and three paragraphs
   * all came out as the same grey texture, and the point of a map is telling them apart
   * at a glance.
   */
  function kindOf(el) {
    if (/^H[1-6]$/.test(el.tagName)) return "heading";
    if (el.classList.contains("mermaid-figure") || el.querySelector("svg")) return "diagram";
    if (el.tagName === "PRE" || el.classList.contains("mermaid")) return "code";
    if (el.tagName === "TABLE") return "table";
    if (el.tagName === "BLOCKQUOTE") return "quote";
    if (el.tagName === "UL" || el.tagName === "OL") return "list";
    if (el.tagName === "HR") return "rule";
    if (el.tagName === "IMG" || el.querySelector("img")) return "image";
    return "prose";
  }

  function rectsFromDoc(scroller) {
    const total = scroller.scrollHeight || 1;
    const rects = [];
    const at = (offset, height, extra) =>
      rects.push(Object.assign({ top: offset / total, height: height / total }, extra));

    for (const el of scroller.children) {
      if (el.offsetHeight <= 0) continue;

      const kind = kindOf(el);
      const text = (el.textContent || "").trim();
      const lineHeight = parseFloat(window.getComputedStyle(el).lineHeight) || 20;

      // A heading is a checkpoint you scan for, so it gets one solid bar with a floor on
      // its thickness rather than being averaged into the prose around it.
      if (kind === "heading") {
        const level = Number(el.tagName.slice(1)) || 1;
        at(el.offsetTop, Math.max(lineHeight * 0.9, el.offsetHeight * 0.55), {
          kind, level,
          // Carried so the top levels can be drawn as actual words. A heading is the
          // landmark you scan for, and a bar tells you one is there without telling you
          // which -- which is most of what you wanted to know.
          text,
          // Shallower headings read wider, so the structure is visible in the
          // silhouette even where the text is too small to draw.
          weight: Math.max(0.35, 1 - (level - 1) * 0.13)
        });
        continue;
      }

      // Solid shapes: there is no text to approximate, and their footprint is the
      // information.
      if (kind === "diagram" || kind === "image" || kind === "rule") {
        at(el.offsetTop, el.offsetHeight, { kind, weight: kind === "rule" ? 0.9 : 1 });
        continue;
      }

      // A grid, so a table looks like a table.
      if (kind === "table") {
        const rows = Math.max(1, el.querySelectorAll("tr").length);
        const rowHeight = el.offsetHeight / rows;
        for (let row = 0; row < rows; row++) {
          at(el.offsetTop + row * rowHeight, Math.max(1, rowHeight - 1),
             { kind, weight: 1, columns: 3 });
        }
        continue;
      }

      // One bar per item keeps a list's rhythm, which prose-lines would flatten.
      if (kind === "list") {
        for (const item of el.children) {
          if (item.offsetHeight <= 0) continue;
          const itemText = (item.textContent || "").trim();
          at(item.offsetTop, Math.max(1, item.offsetHeight - 1), {
            kind, indent: 0.12,
            weight: Math.max(0.2, Math.min(1, itemText.length / REFERENCE_COLUMNS))
          });
        }
        continue;
      }

      // Prose, code and quotes are all runs of lines; only their colour and indent
      // differ. The line count comes from the block's height over its line-height,
      // since proportional text has no line boxes to read out.
      const lines = Math.max(1, Math.round(el.offsetHeight / lineHeight));
      const perLine = el.offsetHeight / lines;
      const charsPerLine = Math.max(1, Math.ceil(text.length / lines));
      const indent = kind === "quote" ? 0.14 : 0;

      for (let index = 0; index < lines; index++) {
        // The tail of the block's text, so the final line stops where the words do.
        const remaining = text.length - index * charsPerLine;
        at(el.offsetTop + index * perLine, perLine, {
          kind, indent,
          weight: Math.max(0, Math.min(1, remaining / charsPerLine))
        });
      }
    }

    return rects;
  }

  /** Source mode has real lines, so this is a genuine minimap of the text. */
  function rectsFromSource(editor) {
    const newline = String.fromCharCode(10);
    const lines = editor.value.split(newline);
    const count = Math.max(1, lines.length);

    let inFence = false;

    return lines.map((line, index) => {
      const body = line.trimStart();
      const indent = line.length - body.length;

      // Fences toggle, so everything between them is drawn as code even when the lines
      // themselves look like prose or headings.
      if (body.startsWith("```")) inFence = !inFence;

      let kind = "prose";
      let level = 0;
      let heading = "";

      if (inFence || body.startsWith("```")) kind = "code";
      else if (body.startsWith("#")) {
        kind = "heading";
        const hashes = body.match(/^#+/);
        level = hashes ? hashes[0].length : 1;
        heading = body.slice(level).trim();
      }
      else if (body.startsWith(">")) kind = "quote";
      else if (/^([-*+]|\d+\.)\s/.test(body)) kind = "list";
      else if (/^(-{3,}|\*{3,}|_{3,})$/.test(body)) kind = "rule";

      return {
        top: index / count,
        height: 1 / count,
        kind, level, text: heading,
        // A blank line gets no bar at all, so paragraphs separate instead of merging
        // into one mass.
        weight: Math.min(1, Math.max(0, line.length - indent) / REFERENCE_COLUMNS),
        indent: Math.min(0.4, indent / REFERENCE_COLUMNS)
      };
    });
  }

  // ---------- drawing ----------

  function draw(canvas, rects, height) {
    const context = canvas.getContext("2d");
    if (!context) return;

    const ratio = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth;

    // Sized in device pixels and scaled, or the bars blur on a scaled display.
    canvas.width = Math.max(1, Math.round(cssWidth * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, cssWidth, height);

    for (const rect of rects) {
      // A blank line draws nothing. Clamping it up to a one-pixel stub instead is what
      // welded paragraphs together into one mass.
      if (!rect.weight || rect.weight <= 0) continue;

      const y = rect.top * height;
      // The gap is what separates one line from the next; without it consecutive
      // full-width lines merge and the whole thing reads as a slab.
      const barHeight = Math.max(MIN_BAR_PX, rect.height * height - 1);
      const left = (rect.indent || 0) * cssWidth;
      const span = Math.max(1, rect.weight * (cssWidth - left));

      context.fillStyle = FILL[rect.kind] || FILL.prose;

      // Top-level headings are drawn as words rather than a bar, so a glance tells you
      // *which* section you are looking at. Only where there is room: the ribbon is too
      // narrow for type at any size, and a long document scales headings below the point
      // of legibility -- in both cases it falls back to the bar, which still marks the
      // position.
      if (rect.text && rect.level <= HEADING_TEXT_LEVELS && cssWidth >= 40) {
        const size = Math.min(HEADING_TEXT_PX[rect.level] || 6, Math.max(5, barHeight + 2));

        if (size >= 5.5) {
          context.save();
          // Clipped rather than measured and truncated: a heading that overruns should
          // run off the edge like text does, not end in an ellipsis nobody can read.
          context.beginPath();
          context.rect(2, y - 1, cssWidth - 4, Math.max(size + 2, barHeight + 2));
          context.clip();

          context.font = "600 " + size.toFixed(1) + "px 'Segoe UI', system-ui, sans-serif";
          context.textBaseline = "top";
          context.fillText(rect.text, 2, y);
          context.restore();
          continue;
        }
      }

      // A table is drawn as columns with gaps, so it reads as a grid rather than a
      // block. Everything else is one bar.
      if (rect.columns) {
        const gap = 2;
        const cell = Math.max(1, (span - gap * (rect.columns - 1)) / rect.columns);
        for (let column = 0; column < rect.columns; column++) {
          context.fillRect(left + column * (cell + gap), y, cell, barHeight);
        }
        continue;
      }

      context.fillRect(left, y, span, barHeight);
    }
  }

  /**
   * Marker bands, drawn as elements rather than into the canvas so the ribbon style
   * needs no canvas at all and so their colours stay in the stylesheet.
   */
  function paintMarkers(layer, bands) {
    layer.replaceChildren();

    for (const band of bands) {
      const mark = document.createElement("div");
      mark.className = "docmap-mark docmap-mark-" + band.kind;
      mark.style.top = (band.top * 100) + "%";
      mark.style.height = Math.max(0.4, band.height * 100) + "%";
      layer.append(mark);
    }
  }

  // ---------- public rendering ----------

  /**
   * Repaints one pane's map.
   *
   * `scroller` is whichever element actually scrolls -- the rendered view or the
   * textarea -- so the map and the viewport window always describe the same thing.
   */
  function render(mapEl, { scroller, editor, editing, bands = [] }) {
    if (!mapEl) return;

    mapEl.hidden = !enabled;
    mapEl.dataset.style = style;
    // Recorded so which document the map is describing is observable rather than
    // inferred: the two modes draw from different sources and it has been wrong once.
    mapEl.dataset.mode = editing ? "edit" : "view";

    // Visibility is a style question, not a measurement, so it is settled before any
    // geometry is consulted. Gating it on a height meant a pane measured mid-layout at
    // zero kept whatever the canvas was showing last.
    const canvas = mapEl.querySelector(".docmap-canvas");
    if (canvas) canvas.hidden = style !== "full";

    if (!enabled || !scroller) return;

    paintMarkers(mapEl.querySelector(".docmap-marks"), bands);
    renderViewport(mapEl, scroller);

    // Only the drawing needs a real height. Nothing to draw into a zero-height box, and
    // the next render will catch it once the pane has been laid out.
    const height = mapEl.clientHeight;
    if (height <= 0 || style !== "full" || !canvas) return;

    const rects = editing && editor ? rectsFromSource(editor) : rectsFromDoc(scroller);
    draw(canvas, rects, height);
  }

  /** The window showing where you are. Moved on scroll without redrawing anything. */
  function renderViewport(mapEl, scroller) {
    const window_ = mapEl.querySelector(".docmap-viewport");
    if (!window_) return;

    const total = scroller.scrollHeight || 1;
    const visible = scroller.clientHeight / total;

    window_.style.top = ((scroller.scrollTop / total) * 100) + "%";
    window_.style.height = Math.min(100, visible * 100) + "%";
    // A document that fits has nothing to navigate.
    window_.hidden = visible >= 1;
  }

  /** Builds the element for a pane. Structure is fixed; only its contents change. */
  function build() {
    const mapEl = document.createElement("div");
    mapEl.className = "docmap";
    mapEl.hidden = !enabled;

    const canvas = document.createElement("canvas");
    canvas.className = "docmap-canvas";

    const marks = document.createElement("div");
    marks.className = "docmap-marks";

    const viewport = document.createElement("div");
    viewport.className = "docmap-viewport";

    mapEl.append(canvas, marks, viewport);
    return mapEl;
  }

  /**
   * Click or drag anywhere on the map to scroll there, centring the viewport on the
   * point rather than putting it at the top -- dragging feels like moving a window,
   * which is what the viewport indicator says it is.
   */
  function bindDrag(mapEl, getScroller) {
    function scrollTo(clientY) {
      const scroller = getScroller();
      if (!scroller) return;

      const box = mapEl.getBoundingClientRect();
      if (box.height <= 0) return;

      const fraction = Math.min(1, Math.max(0, (clientY - box.top) / box.height));
      const target = fraction * scroller.scrollHeight - scroller.clientHeight / 2;
      scroller.scrollTop = Math.max(0, target);
    }

    mapEl.addEventListener("mousedown", event => {
      event.preventDefault();
      scrollTo(event.clientY);

      function onMove(moveEvent) { scrollTo(moveEvent.clientY); }
      function onUp() {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.classList.remove("docmap-dragging");
      }

      document.body.classList.add("docmap-dragging");
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  return {
    configure, build, render, renderViewport, bindDrag,
    isEnabled, setEnabled, currentStyle, setStyle, width
  };
})();
