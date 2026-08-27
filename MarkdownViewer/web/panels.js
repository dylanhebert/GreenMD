"use strict";

/**
 * The two side panels: their widths, their order, and whether they are shown.
 *
 * Width lives in a CSS custom property rather than an inline style so the divider
 * drag, the reset command and the session restore all go through one place. Order is
 * a flex `order` value rather than moving DOM nodes, so swapping sides cannot disturb
 * anything inside either panel.
 */
window.Panels = (() => {

  const DEFAULT_SIDEBAR = 230;
  const DEFAULT_OUTLINE = 260;
  const MIN_WIDTH = 140;
  const MAX_FRACTION = 0.45;   // neither panel may take more than this of the window

  const state = {
    sidebar: true,
    outline: true,
    swapped: false,
    sidebarWidth: DEFAULT_SIDEBAR,
    outlineWidth: DEFAULT_OUTLINE
  };

  let hooks = {};
  let bodyEl = null;
  let sidebarEl = null;
  let outlineEl = null;
  let sidebarDividerEl = null;
  let outlineDividerEl = null;

  function configure(next) {
    hooks = next || {};

    bodyEl = document.querySelector(".body");
    sidebarEl = document.getElementById("sidebar");
    outlineEl = document.querySelector(".pane-outline");
    sidebarDividerEl = document.getElementById("sidebarDivider");
    outlineDividerEl = document.getElementById("outlineDivider");

    sidebarDividerEl.addEventListener("mousedown", event => beginDrag(event, "sidebar"));
    outlineDividerEl.addEventListener("mousedown", event => beginDrag(event, "outline"));

    apply();
  }

  function snapshot() { return { ...state }; }

  function restore(saved) {
    if (!saved || typeof saved !== "object") return;

    if (typeof saved.sidebar === "boolean") state.sidebar = saved.sidebar;
    if (typeof saved.outline === "boolean") state.outline = saved.outline;
    if (typeof saved.swapped === "boolean") state.swapped = saved.swapped;
    if (Number.isFinite(saved.sidebarWidth)) state.sidebarWidth = clampWidth(saved.sidebarWidth);
    if (Number.isFinite(saved.outlineWidth)) state.outlineWidth = clampWidth(saved.outlineWidth);

    apply();
  }

  function clampWidth(value) {
    const ceiling = bodyEl ? Math.max(MIN_WIDTH, bodyEl.clientWidth * MAX_FRACTION) : 600;
    return Math.round(Math.min(ceiling, Math.max(MIN_WIDTH, value)));
  }

  function isShown(which) { return state[which]; }
  function isSwapped() { return state.swapped; }

  /**
   * The sidebar is only shown when a folder is actually open; that is asked of the
   * caller rather than assumed here, so this module owns no workspace knowledge.
   */
  function apply() {
    if (!bodyEl) return;

    const sidebarUsable = state.sidebar && (!hooks.sidebarHasContent || hooks.sidebarHasContent());

    bodyEl.style.setProperty("--sidebar-width", state.sidebarWidth + "px");
    bodyEl.style.setProperty("--outline-width", state.outlineWidth + "px");

    sidebarEl.hidden = !sidebarUsable;
    outlineEl.hidden = !state.outline;

    // A divider is only meaningful next to a visible panel.
    sidebarDividerEl.hidden = !sidebarUsable;
    outlineDividerEl.hidden = !state.outline;

    // Order rather than DOM moves: the panel keeps its divider on the side facing
    // the document, whichever side of the window it is on.
    const order = state.swapped
      ? { outline: 1, outlineDivider: 2, panes: 3, sidebarDivider: 4, sidebar: 5 }
      : { sidebar: 1, sidebarDivider: 2, panes: 3, outlineDivider: 4, outline: 5 };

    sidebarEl.style.order = order.sidebar;
    sidebarDividerEl.style.order = order.sidebarDivider;
    document.getElementById("panes").style.order = order.panes;
    outlineDividerEl.style.order = order.outlineDivider;
    outlineEl.style.order = order.outline;

    if (hooks.onChanged) hooks.onChanged();
  }

  function toggle(which) {
    state[which] = !state[which];
    apply();
    if (hooks.onPersist) hooks.onPersist();
  }

  function swap() {
    state.swapped = !state.swapped;
    apply();
    if (hooks.onPersist) hooks.onPersist();
  }

  function resetWidths() {
    state.sidebarWidth = DEFAULT_SIDEBAR;
    state.outlineWidth = DEFAULT_OUTLINE;
    apply();
    if (hooks.onPersist) hooks.onPersist();
  }

  function beginDrag(event, which) {
    event.preventDefault();

    const startX = event.clientX;
    const startWidth = state[which + "Width"];

    // Dragging away from the document edge grows the panel, so the sign depends on
    // which side of the window the panel is currently sitting on.
    const onLeft = which === "sidebar" ? !state.swapped : state.swapped;
    const sign = onLeft ? 1 : -1;

    document.body.classList.add("resizing-col");

    function onMove(moveEvent) {
      state[which + "Width"] = clampWidth(startWidth + sign * (moveEvent.clientX - startX));
      bodyEl.style.setProperty("--" + which + "-width", state[which + "Width"] + "px");
    }

    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.classList.remove("resizing-col");
      if (hooks.onPersist) hooks.onPersist();
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  return { configure, apply, snapshot, restore, toggle, swap, resetWidths, isShown, isSwapped };
})();
