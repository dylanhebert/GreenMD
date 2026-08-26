"use strict";

/**
 * Per-scope text zoom.
 *
 * WebView2's own zoom is disabled by the host because it scales the whole shell,
 * chrome included. This scales `font-size` on one scope's content instead, which
 * matters: the text has to reflow so the reader genuinely gets more or fewer words
 * per line. A transform would magnify the same line breaks.
 *
 * Scopes are declared in markup with `data-zoom-scope="<name>"`, and the element
 * that actually scales carries `data-zoom-target`. Panes are created and destroyed
 * as the layout changes, so levels are keyed by name and survive re-rendering.
 */
window.Zoom = (() => {

  const MIN = 0.6;
  const MAX = 2.6;
  const STEP = 0.1;

  const levels = new Map();   // scope name -> factor
  const bases = new Map();    // scope name -> base font size in px
  let hovered = null;
  let hooks = {};

  /** Hooks let the caller hold a reader's place across a reflow. */
  function configure(next) {
    hooks = next || {};
  }

  function register(name, basePx, initial) {
    bases.set(name, basePx);
    if (typeof initial === "number") levels.set(name, initial);
    else if (!levels.has(name)) levels.set(name, 1);
  }

  function forget(name) {
    levels.delete(name);
    bases.delete(name);
  }

  function levelOf(name) {
    return levels.get(name) ?? 1;
  }

  function element(name) {
    return document.querySelector(`[data-zoom-scope="${CSS.escape(name)}"]`);
  }

  function apply(name) {
    const scope = element(name);
    if (!scope) return;

    const factor = levelOf(name);
    const base = bases.get(name) ?? 15;

    for (const target of scope.querySelectorAll("[data-zoom-target]")) {
      target.style.fontSize = (base * factor).toFixed(2) + "px";
    }

    const badge = scope.querySelector("[data-zoom-badge]");
    if (badge) {
      badge.textContent = Math.round(factor * 100) + "%";
      badge.classList.toggle("shown", Math.abs(factor - 1) > 0.001);
    }
  }

  function applyAll() {
    for (const name of bases.keys()) apply(name);
  }

  function set(name, factor) {
    if (!bases.has(name)) return;

    const clamped = Math.min(MAX, Math.max(MIN, Math.round(factor * 100) / 100));
    const token = hooks.before ? hooks.before(name) : null;

    levels.set(name, clamped);
    apply(name);

    if (hooks.after) hooks.after(name, token);
  }

  function nudge(name, direction) {
    set(name, levelOf(name) + direction * STEP);
  }

  /** The scope the pointer is currently over, so Ctrl+/-/0 act where the user is looking. */
  function hoveredScope() {
    return hovered;
  }

  document.addEventListener("mouseover", (event) => {
    const scope = event.target.closest("[data-zoom-scope]");
    if (scope) hovered = scope.dataset.zoomScope;
  });

  document.addEventListener("wheel", (event) => {
    if (!event.ctrlKey) return;

    const scope = event.target.closest("[data-zoom-scope]");
    if (!scope) return;

    event.preventDefault();
    nudge(scope.dataset.zoomScope, event.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  // Clicking the level resets it, same as a browser's zoom indicator.
  document.addEventListener("click", (event) => {
    const badge = event.target.closest("[data-zoom-badge]");
    if (!badge) return;

    const scope = badge.closest("[data-zoom-scope]");
    if (scope) set(scope.dataset.zoomScope, 1);
  });

  return { configure, register, forget, levelOf, apply, applyAll, set, nudge, hoveredScope };
})();
