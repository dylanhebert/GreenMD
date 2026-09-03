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
   * The rendered view's shape: one entry per top-level block, positioned by its real
   * offset so the map lines up with the document rather than with a line count.
   */
  function rectsFromDoc(scroller) {
    const blocks = [...scroller.children].filter(el => el.offsetHeight > 0);
    const total = scroller.scrollHeight || 1;

    return blocks.map(el => {
      const text = el.textContent || "";
      const heading = /^H[1-6]$/.test(el.tagName);

      return {
        top: el.offsetTop / total,
        height: el.offsetHeight / total,
        // Headings read as short, solid bars; body text as longer, lighter ones.
        weight: heading ? 1 : Math.min(1, text.length / 400),
        heading
      };
    });
  }

  /** Source mode has real lines, so this is a genuine minimap of the text. */
  function rectsFromSource(editor) {
    const newline = String.fromCharCode(10);
    const lines = editor.value.split(newline);
    const count = Math.max(1, lines.length);
    const longest = Math.max(20, ...lines.map(line => line.length));

    return lines.map((line, index) => {
      const indent = line.length - line.trimStart().length;

      return {
        top: index / count,
        height: 1 / count,
        weight: Math.min(1, (line.length - indent) / longest),
        indent: Math.min(0.5, indent / longest),
        heading: line.startsWith("#")
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
      const y = rect.top * height;
      const barHeight = Math.max(MIN_BAR_PX, rect.height * height - 1);
      const left = (rect.indent || 0) * cssWidth;
      const barWidth = Math.max(1, (rect.weight || 0) * (cssWidth - left));

      context.fillStyle = rect.heading ? "#8d8a82" : "#565349";
      context.fillRect(left, y, barWidth, barHeight);
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
